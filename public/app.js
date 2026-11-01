const $=id=>document.getElementById(id);
let videoURL=null, messages=[], worker=null, deferredPrompt=null;
const file=$("videoFile"), video=$("preview"), extract=$("extractBtn"), analyse=$("analyseBtn");
function status(s,p){$("status").textContent=s;if(p!==undefined)$("progress").style.width=p+"%";}
file.addEventListener("change",()=>{const f=file.files[0];if(!f)return;if(videoURL)URL.revokeObjectURL(videoURL);videoURL=URL.createObjectURL(f);video.src=videoURL;video.hidden=false;extract.disabled=false;status("Video ready. Tap Extract messages.");});
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBtn").hidden=false;});
$("installBtn").onclick=async()=>{if(deferredPrompt){deferredPrompt.prompt();deferredPrompt=null;}};
if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("./sw.js").catch(()=>{}));
function dedupe(list){const out=[];for(const m of list){const prev=out[out.length-1];if(prev&&prev.side===m.side&&prev.text.toLowerCase()===m.text.toLowerCase()&&m.t-prev.t<9)continue;out.push(m);}return out;}
extract.onclick=async()=>{
 const f=file.files[0];if(!f)return;extract.disabled=true;messages=[];
 try{
  status("Loading OCR engine…",2);
  worker=await Tesseract.createWorker("eng",1,{logger:m=>{if(m.status==="recognizing text")status("Reading frame… "+Math.round((m.progress||0)*100)+"%",Math.min(95,Math.round((m.progress||0)*100)));}});
  const dur=video.duration||0, step=Number($("interval").value), canvas=$("frameCanvas"),ctx=canvas.getContext("2d");
  if(!dur)throw Error("Could not read video duration.");
  const count=Math.ceil(dur/step);let last=[];
  for(let t=0;t<dur;t+=step){
    await new Promise(resolve=>{video.currentTime=t;video.onseeked=()=>resolve();});
    const vw=video.videoWidth,vh=video.videoHeight;if(!vw||!vh)continue;
    canvas.width=vw;canvas.height=vh;ctx.drawImage(video,0,0,vw,vh);
    // OCR the visible frame; image is held only in memory.
    const {data}=await worker.recognize(canvas);
    const lines=(data.lines||[]).map(l=>({text:l.text.trim(),x:l.bbox.x0,y:l.bbox.y0,w:l.bbox.x1-l.bbox.x0,conf:l.confidence||0}))
      .filter(l=>l.text.length>2&&l.conf>38&&!/^(instagram|message|active now|seen)$/i.test(l.text));
    for(const l of lines){
      const side=l.x+l.w/2>vw*.52?"right":"left";
      messages.push({t:Number(t.toFixed(1)),side,text:l.text,confidence:Math.round(l.conf)});
    }
    status(`Processed ${Math.min(t+step,dur).toFixed(1)} / ${dur.toFixed(1)} seconds`,Math.round((t/dur)*100));
  }
  messages=dedupe(messages);await worker.terminate();worker=null;
  renderTranscript();analyse.disabled=!messages.length;$("csvBtn").disabled=!messages.length;
  status(`Found ${messages.length} candidate text lines. Review and correct them below.`,100);
 }catch(e){status("Error: "+e.message);if(worker){await worker.terminate();worker=null;}}
 finally{extract.disabled=false;}
};
function renderTranscript(){
 const host=$("transcript");host.innerHTML="";
 if(!messages.length){host.textContent="No readable text found.";return;}
 messages.forEach((m,i)=>{
  const div=document.createElement("div");div.className="msg";
  const top=document.createElement("div");top.className="row";
  const side=document.createElement("select");side.innerHTML='<option value="left">Left bubble</option><option value="right">Right bubble</option>';side.value=m.side;side.onchange=()=>m.side=side.value;
  const time=document.createElement("span");time.className="tag";time.textContent=`Video ${m.t}s · OCR ${m.confidence}%`;
  const del=document.createElement("button");del.className="secondary";del.textContent="Remove";del.onclick=()=>{messages.splice(i,1);renderTranscript();analyse.disabled=!messages.length;$("csvBtn").disabled=!messages.length;};
  top.append(side,time,del);
  const edit=document.createElement("textarea");edit.rows=2;edit.value=m.text;edit.setAttribute("aria-label","Edit recognised message");edit.oninput=()=>m.text=edit.value;
  div.append(top,edit);host.append(div);
 });
}
analyse.onclick=()=>{
 const a=$("leftName").value.trim()||"Person A",b=$("rightName").value.trim()||"Person B";if(a===b){alert("Choose two different participant names.");return;}
 const rows=messages.filter(m=>m.text.trim()).map(m=>({...m,sender:m.side==="left"?a:b}));
 const counts={[a]:0,[b]:0},words={[a]:0,[b]:0},starts={[a]:0,[b]:0},positive={[a]:0,[b]:0},negative={[a]:0,[b]:0},care={[a]:0,[b]:0},affection={[a]:0,[b]:0},questions={[a]:0,[b]:0};
 const pos=/\b(love|miss|cute|beautiful|sweet|thank|happy|proud|care|support|haha|lol)\b|❤️|😍|🥰|😘|💕|💖/ig;
 const neg=/\b(hate|angry|annoyed|upset|hurt|ignore|ignored|stop|boring|stupid|idiot|jealous|fight|argue)\b|😭|😡|💔/ig;
 const careRe=/\b(okay|safe|home|eat|sleep|rest|help|support|care|proud)\b/ig;
 for(const m of rows){const s=m.sender;counts[s]++;words[s]+=(m.text.match(/[\p{L}\p{N}']+/gu)||[]).length;if(m.text.includes("?"))questions[s]++;if((m.text.match(pos)||[]).length)positive[s]++;if((m.text.match(neg)||[]).length)negative[s]++;if(careRe.test(m.text)){care[s]++;careRe.lastIndex=0;}if(/\b(love|miss|cute|beautiful)\b|❤️|😍|🥰|😘|💕|💖/i.test(m.text))affection[s]++;}
 // A session begins after a gap > 8h in sampled video timeline; this is a clip segmentation heuristic only.
 rows.forEach((m,i)=>{if(i===0||m.t-rows[i-1].t>28800)starts[m.sender]++;});
 const total=rows.length,share=p=>total?100*counts[p]/total:0;
 const metric=(label,value)=>`<div class="metric"><small>${label}</small><b>${value}</b></div>`;
 $("metrics").innerHTML=metric("Visible messages",total)+metric(a+" share",share(a).toFixed(1)+"%")+metric(b+" share",share(b).toFixed(1)+"%")+metric("Conversation starts",starts[a]+starts[b]);
 $("balance").innerHTML=[a,b].map(p=>`<p>${p}: ${counts[p]} messages · ${words[p]} words · ${starts[p]} session starts</p><div class="bar"><i style="width:${share(p)}%"></i></div>`).join("");
 const observations=[
 `${a} contributes ${share(a).toFixed(1)}% of the visible extracted messages; ${b} contributes ${share(b).toFixed(1)}%. This measures volume, not emotional investment.`,
 `Affection-related keyword messages: ${a} ${affection[a]}; ${b} ${affection[b]}. These terms can be jokes, quotations or context-dependent.`,
 `Question-mark messages: ${a} ${questions[a]}; ${b} ${questions[b]}. Questions may indicate curiosity, but punctuation alone is weak evidence.`,
 `Care-related keyword messages: ${a} ${care[a]}; ${b} ${care[b]}. Review the original context before drawing conclusions.`,
 `Potential negative-language matches: ${a} ${negative[a]}; ${b} ${negative[b]}. A keyword match does not prove conflict.`
 ];
 $("observations").innerHTML=observations.map(x=>`<p class="msg">${escapeHTML(x)}</p>`).join("");
 $("results").hidden=false;$("results").scrollIntoView({behavior:"smooth"});
};
function escapeHTML(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
$("csvBtn").onclick=()=>{const a=$("leftName").value,b=$("rightName").value;const lines=[["video_time_seconds","sender","text","ocr_confidence"],...messages.map(m=>[m.t,m.side==="left"?a:b,m.text,m.confidence])];const csv=lines.map(r=>r.map(x=>'"'+String(x??"").replace(/"/g,'""')+'"').join(",")).join("\n");const url=URL.createObjectURL(new Blob([csv],{type:"text/csv"}));const link=document.createElement("a");link.href=url;link.download="chat-signals-transcript.csv";link.click();URL.revokeObjectURL(url);};

// V4 controls: visible overflow menu, stronger caveats, and optional server-side AI.
const menuBtn = $("menuBtn"), menuPanel = $("menuPanel");
menuBtn.addEventListener("click", () => {
  const open = menuPanel.hidden;
  menuPanel.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".menu-wrap")) { menuPanel.hidden = true; menuBtn.setAttribute("aria-expanded", "false"); }
});
$("menuHelp").onclick = () => { alert("Choose a screen recording, extract the visible text, then carefully correct every message and sender. The basic report counts transcript features; AI offers a more contextual interpretation. Neither can establish someone's hidden feelings or intentions."); menuPanel.hidden = true; };
$("menuExport").onclick = () => { if (messages.length) $("csvBtn").click(); else alert("There is no transcript to export yet."); menuPanel.hidden = true; };
$("menuClear").onclick = () => {
  if (!confirm("Clear the current transcript and report from this browser session?")) return;
  messages = []; $("transcript").textContent = "No messages extracted yet."; $("results").hidden = true; $("aiReport").hidden = true;
  analyse.disabled = true; $("csvBtn").disabled = true; $("aiBtn").disabled = true; $("aiStatus").textContent = "First extract and review messages.";
  status("Session cleared. Your video and transcript were not uploaded."); menuPanel.hidden = true;
};

// The local report deliberately reports measurable transcript facts, not psychological labels.
const basicAnalyse = analyse.onclick;
analyse.onclick = () => {
  basicAnalyse();
  if (!messages.length) return;
  const left = $("leftName").value.trim() || "Person A", right = $("rightName").value.trim() || "Person B";
  const clean = messages.filter(m => m.text.trim());
  const totalWords = clean.reduce((n,m) => n + (m.text.match(/[\p{L}\p{N}']+/gu)||[]).length, 0);
  const avg = name => { const own=clean.filter(m => (m.side === "left" ? left : right) === name); return own.length ? (own.reduce((n,m)=>n+(m.text.match(/[\p{L}\p{N}']+/gu)||[]).length,0)/own.length).toFixed(1) : "0.0"; };
  const extra = document.createElement("div"); extra.className="msg";
  extra.innerHTML = `<strong>Additional measurable context</strong><p>${totalWords} words across ${clean.length} reviewed text lines. Average words per line: ${escapeHTML(left)} ${avg(left)}, ${escapeHTML(right)} ${avg(right)}.</p><p>These are transcript-level counts only. A line may be part of a longer bubble, OCR may split one message into several lines, and omitted content can distort comparisons.</p>`;
  $("observations").append(extra);
  $("aiBtn").disabled = clean.length < 2;
};

$("aiBtn").onclick = async () => {
  const a = $("leftName").value.trim() || "Person A", b = $("rightName").value.trim() || "Person B";
  const reviewed = messages.filter(m => m.text.trim()).map(m => ({ sender: m.side === "left" ? a : b, text: m.text.trim() }));
  if (reviewed.length < 2) return;
  const button = $("aiBtn"), label = button.textContent;
  button.disabled = true; button.textContent = "AI is analysing…"; $("aiStatus").textContent = "Sending only the reviewed text transcript securely to the configured AI service. The video itself is not sent.";
  $("aiReport").hidden = true;
  try {
    const response = await fetch("/.netlify/functions/chat-analysis", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: reviewed, accessCode: $("aiAccessCode").value }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `AI request failed (${response.status}).`);
    $("aiReport").textContent = result.analysis; $("aiReport").hidden = false; $("aiStatus").textContent = "AI interpretation complete. Read it as a cautious second opinion, not a verdict.";
  } catch (error) {
    $("aiStatus").textContent = error.message.includes("Failed to fetch") ? "AI endpoint unavailable. This updated package must be deployed with Netlify Functions and an OPENAI_API_KEY setting." : error.message;
  } finally { button.disabled = false; button.textContent = label; }
};
