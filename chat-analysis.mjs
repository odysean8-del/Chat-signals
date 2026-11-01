export default async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const key = process.env.OPENAI_API_KEY;
  const expectedCode = process.env.CHAT_SIGNALS_ACCESS_CODE;
  if (!expectedCode) return Response.json({ error: "AI access protection is not configured. Add CHAT_SIGNALS_ACCESS_CODE in Netlify, then redeploy." }, { status: 503 });
  if (!key) return Response.json({ error: "AI is not configured yet. Add OPENAI_API_KEY in Netlify environment variables, then redeploy." }, { status: 503 });
  try {
    const body = await request.json();
    if (!body.accessCode || body.accessCode !== expectedCode) return Response.json({ error: "Incorrect AI access code." }, { status: 401 });
    const transcript = Array.isArray(body.messages) ? body.messages : [];
    if (transcript.length < 2) return Response.json({ error: "Please provide at least two reviewed messages." }, { status: 400 });
    if (transcript.length > 500) return Response.json({ error: "Please analyse up to 500 messages at a time." }, { status: 413 });
    const clean = transcript.map((m, i) => `${i + 1}. ${String(m.sender || "Unknown").slice(0,60)}: ${String(m.text || "").slice(0,1200)}`).join("\n").slice(0, 24000);
    const prompt = `You are Chat Signals, a careful relationship communication analyst. Analyse only the transcript evidence below. Do not diagnose either person or claim to know hidden feelings, attraction, love, cheating, personality, attachment style, intent, or truthfulness. Do not treat message count as proof of investment. Separate direct observations from plausible interpretations and unknowns. Account for missing context, sarcasm, cultural/language differences, OCR errors, selected-chat bias, and the fact that a screen-recording transcript may omit messages. Do not infer reply speed or chronology beyond the listed order. Give a balanced view of BOTH participants, including strengths and friction points. Quote only short snippets from the provided transcript. If evidence is too thin, say so. End with practical, non-manipulative communication suggestions and 3 useful questions the user could ask themselves. Format with clear headings: Overall read; What each person contributes; Positive patterns; Tensions or gaps; What cannot be concluded; Suggested next steps; Confidence and evidence.\n\nTranscript (user-reviewed OCR; may contain errors):\n${clean}`;
    const upstream = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-5.5", input: prompt, max_output_tokens: 1600 })
    });
    const data = await upstream.json();
    if (!upstream.ok) return Response.json({ error: data?.error?.message || "AI service request failed." }, { status: upstream.status });
    const output = data.output?.flatMap(item => item.content || []).filter(part => part.type === "output_text").map(part => part.text).join("\n") || data.output_text || "No text returned by AI.";
    return Response.json({ analysis: output });
  } catch (err) {
    return Response.json({ error: "Could not analyse this transcript. Check the transcript and try again." }, { status: 500 });
  }
};
