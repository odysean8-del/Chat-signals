import OpenAI from "openai";

// Default model; override with the OPENAI_MODEL environment variable.
export const DEFAULT_MODEL = "gpt-5.5";
export const modelName = () => (process.env.OPENAI_MODEL || DEFAULT_MODEL).trim();

export const LIMITS = {
  maxMessages: 1000,
  maxTranscriptChars: 90_000,
  maxContextChars: 1500,
  maxImages: 6,
  maxImageChars: 1_600_000,
};

export class UserFacingError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

/* ---------- Structured output schemas (strict JSON schema) ---------- */

const evidence = {
  type: "array",
  description: "Short supporting quotes copied exactly from the numbered transcript.",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["message", "quote"],
    properties: {
      message: { type: "integer", description: "Transcript message number." },
      quote: { type: "string", description: "Exact short excerpt (max ~20 words) from that message." },
    },
  },
};

const point = {
  type: "object",
  additionalProperties: false,
  required: ["text", "evidence"],
  properties: { text: { type: "string" }, evidence },
};

const section = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "observations", "interpretations", "uncertainties"],
  properties: {
    summary: { type: "string" },
    observations: { type: "array", description: "Directly visible facts in the transcript.", items: point },
    interpretations: { type: "array", description: "Plausible readings, phrased tentatively, each with evidence.", items: point },
    uncertainties: { type: "array", description: "What cannot be concluded or needs more context.", items: { type: "string" } },
  },
};

export const SECTION_KEYS = [
  ["overall", "Overall communication summary"],
  ["positive_signals", "Positive communication signals"],
  ["concerning_signals", "Negative or concerning signals"],
  ["emotional_patterns", "Emotional communication patterns"],
  ["balance", "Conversation balance"],
  ["misunderstandings", "Possible misunderstandings"],
  ["changes_over_time", "Changes over time"],
  ["compatibility", "Communication compatibility"],
  ["conflict_areas", "Potential areas of conflict"],
] as const;

export const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "evidence_level",
    "evidence_level_reason",
    ...SECTION_KEYS.map(([k]) => k),
    "suggestions",
    "reflection_questions",
    "limitations",
  ],
  properties: {
    evidence_level: { type: "string", enum: ["insufficient", "limited", "moderate", "substantial"] },
    evidence_level_reason: { type: "string" },
    ...Object.fromEntries(SECTION_KEYS.map(([k]) => [k, section])),
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["suggestion", "why", "example_phrasing", "evidence"],
        properties: {
          suggestion: { type: "string" },
          why: { type: "string" },
          example_phrasing: { type: "string", description: "A respectful, non-manipulative example sentence, or empty string." },
          evidence,
        },
      },
    },
    reflection_questions: { type: "array", items: { type: "string" } },
    limitations: { type: "array", items: { type: "string" } },
  },
};

export const transcriptionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["images", "notes"],
  properties: {
    images: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["image", "items"],
        properties: {
          image: { type: "integer", description: "1-based image number in the order provided." },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["kind", "side", "text", "uncertain"],
              properties: {
                kind: { type: "string", enum: ["message", "time"] },
                side: { type: "string", enum: ["left", "right", "unclear"] },
                text: { type: "string" },
                uncertain: { type: "boolean", description: "True if the text or sender is hard to read." },
              },
            },
          },
        },
      },
    },
    notes: { type: "string" },
  },
};

/* ---------- Prompts ---------- */

const ANALYSIS_INSTRUCTIONS = `You are Chat Signals, a careful, balanced relationship-communication analyst.
You analyse ONLY the numbered transcript you are given. It was extracted from screenshots, a screen recording, or a chat export and then reviewed by the user, but it may still contain OCR errors, missing messages, or wrong sender labels.

Hard rules:
- Never claim to know anyone's true feelings, romantic interest, intentions, loyalty, honesty, personality, attachment style, or mental health. Never diagnose. Never label someone (e.g. "narcissist", "toxic", "avoidant attachment").
- Do not treat message counts, message length, short replies, emoji use, or reply delays as proof of interest or disinterest. People differ in texting style, schedules, and culture.
- Only discuss reply timing if explicit timestamps are present. If times are missing or approximate, say timing cannot be assessed.
- Distinguish clearly: "observations" = directly visible in the text; "interpretations" = tentative possible readings (use words like "may", "could", "one possible reading"), ideally offering more than one; "uncertainties" = what cannot be known from this transcript.
- Support every observation and interpretation with evidence: the message number and an EXACT short quote copied from that message. Never invent or paraphrase quotes. If you cannot find evidence, leave the point out.
- Be balanced across participants: note strengths and friction on both sides. Do not take the user's side by default.
- Consider sarcasm, jokes, inside references, language/cultural differences, and that the selection of messages may be unrepresentative.
- If evidence is thin, say so plainly, set evidence_level accordingly, and keep sections short rather than speculating. Empty arrays are acceptable.
- If the transcript suggests someone may be in danger, being threatened, or experiencing abuse, note this gently in concerning_signals and suggest reaching out to trusted people or local support services, without dramatising.
- Suggestions must be practical, respectful, and non-manipulative (no "games", jealousy tactics, or testing the other person).
- Write in plain, warm, non-judgmental English. Refer to participants by the names given.`;

export function buildAnalysisInput(payload: any) {
  const participants: string[] = payload.participants;
  const lines = payload.messages
    .map((m: any) => (m.break ? `--- break${m.text ? `: ${m.text}` : ""} ---` : `${m.n}. ${m.time ? `[${m.time}] ` : ""}${m.sender}: ${m.text}`))
    .join("\n");
  const timing = payload.hasTimestamps
    ? "Some or all messages include timestamps. Treat approximate time labels with caution."
    : "No reliable timestamps are available. Do not draw conclusions about reply speed or timing.";
  const context = payload.context ? `\nContext supplied by the user (their perspective, not verified):\n${payload.context}\n` : "";
  const depth =
    payload.depth === "detailed"
      ? "Be thorough: up to 6 observations and 4 interpretations per section where evidence supports it."
      : "Be concise: up to 3 observations and 3 interpretations per section.";
  return `Participants: ${participants.join(", ")}
Source: ${payload.source || "unknown"}. ${timing}
Conversation breaks: lines starting with "--- break ---" mark visible time separators or gaps.
${depth}
${context}
Transcript:
${lines}`;
}

const TRANSCRIPTION_INSTRUCTIONS = `You transcribe chat screenshots (for example Instagram DMs, WhatsApp, iMessage, Messenger) into structured data.
For each image, list the chat items from top to bottom:
- kind "message": a chat bubble's text exactly as written (keep emoji, spelling, and slang; join wrapped lines of one bubble with spaces). Use side "left" for bubbles aligned left (usually the other person) and "right" for bubbles aligned right (usually the phone owner). Use "unclear" if alignment is ambiguous.
- kind "time": a centred date/time separator such as "Yesterday 9:41 PM". side must be "unclear".
Ignore app interface text: status bar, header name, "Active now", "Seen", "Delivered", typing indicators, reaction counts, the message input box, buttons, and keyboard.
For photos, stickers, voice notes or shared posts, write a short placeholder like "[photo]", "[voice message]", or "[shared post]".
If a bubble is cut off at the top or bottom edge, transcribe the visible part and set uncertain true.
Never guess unreadable words; write "[unreadable]" for them and set uncertain true.`;

/* ---------- Model calls ---------- */

function reasoningFor(model: string, depth: string) {
  return /^(gpt-5|gpt-6|o\d)/.test(model) ? { reasoning: { effort: depth === "detailed" ? "medium" : "low" } } : {};
}

function client() {
  // The default constructor reads OPENAI_API_KEY (and OPENAI_BASE_URL when set) from the environment.
  return new OpenAI({ timeout: 8 * 60 * 1000, maxRetries: 2 });
}

function parseStructured(response: any) {
  if (response.status === "incomplete") {
    throw new UserFacingError("The AI response was cut off before it finished. Try a shorter transcript or Standard depth.", 502);
  }
  const refusal = response.output
    ?.flatMap((o: any) => o.content || [])
    .find((c: any) => c.type === "refusal");
  if (refusal) throw new UserFacingError("The AI declined to analyse this content.", 422);
  const text = response.output_text;
  if (!text) throw new UserFacingError("The AI service returned an empty response.", 502);
  try {
    return JSON.parse(text);
  } catch {
    throw new UserFacingError("The AI service returned a malformed response. Please try again.", 502);
  }
}

export async function runAnalysis(payload: any) {
  const model = modelName();
  const response = await client().responses.create({
    model,
    instructions: ANALYSIS_INSTRUCTIONS,
    input: buildAnalysisInput(payload),
    max_output_tokens: payload.depth === "detailed" ? 16000 : 10000,
    text: { format: { type: "json_schema", name: "chat_signals_analysis", schema: analysisSchema, strict: true } },
    ...reasoningFor(model, payload.depth),
  } as any);
  return { model, report: parseStructured(response) };
}

export async function runTranscription(payload: any) {
  const model = modelName();
  const content: any[] = [
    { type: "input_text", text: `There are ${payload.images.length} images, in order. Transcribe each one.` },
    ...payload.images.map((url: string) => ({ type: "input_image", image_url: url, detail: "high" })),
  ];
  const response = await client().responses.create({
    model,
    instructions: TRANSCRIPTION_INSTRUCTIONS,
    input: [{ role: "user", content }],
    max_output_tokens: 12000,
    text: { format: { type: "json_schema", name: "chat_transcription", schema: transcriptionSchema, strict: true } },
    ...reasoningFor(model, "standard"),
  } as any);
  return { model, transcription: parseStructured(response) };
}

/* ---------- Validation ---------- */

const str = (v: unknown, max: number) => String(v ?? "").replace(/\u0000/g, "").slice(0, max);

export function validateAnalysisPayload(p: any) {
  if (!p || !Array.isArray(p.messages)) throw new UserFacingError("No transcript was provided.");
  if (p.messages.filter((m: any) => m?.kind !== "break").length < 2) throw new UserFacingError("Please provide at least two reviewed messages.");
  if (p.messages.length > LIMITS.maxMessages)
    throw new UserFacingError(`Please analyse up to ${LIMITS.maxMessages} messages at a time.`, 413);
  const messages = p.messages.map((m: any, i: number) =>
    m?.kind === "break"
      ? { break: true, n: 0, sender: "", text: str(m.text, 80), time: "" }
      : {
          n: Number.isInteger(m?.n) ? m.n : i + 1,
          sender: str(m?.sender, 60) || "Unknown",
          text: str(m?.text, 2000).replace(/\s+/g, " ").trim(),
          time: str(m?.time, 40),
        }
  );
  const chars = messages.reduce((n: number, m: any) => n + m.text.length + m.sender.length + 8, 0);
  if (chars > LIMITS.maxTranscriptChars)
    throw new UserFacingError("This transcript is too long for one AI analysis. Remove older messages and try again.", 413);
  const participants = Array.isArray(p.participants) ? p.participants.map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 12) : [];
  return {
    messages,
    participants: participants.length ? participants : [...new Set<string>(messages.filter((m: any) => !m.break).map((m: any) => m.sender))],
    context: str(p.context, LIMITS.maxContextChars).trim(),
    depth: p.depth === "detailed" ? "detailed" : "standard",
    hasTimestamps: Boolean(p.hasTimestamps),
    source: str(p.source, 40),
  };
}

export function validateTranscriptionPayload(p: any) {
  const images = Array.isArray(p?.images) ? p.images : [];
  if (!images.length) throw new UserFacingError("No images were provided.");
  if (images.length > LIMITS.maxImages) throw new UserFacingError(`Send up to ${LIMITS.maxImages} images per batch.`, 413);
  for (const img of images) {
    if (typeof img !== "string" || !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(img))
      throw new UserFacingError("One of the images is not a supported JPEG, PNG or WebP image.");
    if (img.length > LIMITS.maxImageChars) throw new UserFacingError("One of the images is too large.", 413);
  }
  return { images };
}

/* ---------- Error mapping (never exposes credentials) ---------- */

export function describeAIError(err: any): { message: string; status: number } {
  if (err instanceof UserFacingError) return { message: err.message, status: err.status };
  const status = Number(err?.status) || 0;
  const code = String(err?.code || err?.error?.code || "");
  if (status === 401 || status === 403)
    return { status: 503, message: "The AI service rejected this site's credentials. The site owner needs to check OPENAI_API_KEY in Netlify." };
  if (status === 429 && code === "insufficient_quota")
    return { status: 503, message: "The AI account has run out of credits. The site owner needs to check OpenAI billing." };
  if (status === 429) return { status: 429, message: "The AI service is busy (rate limit reached). Wait a minute and try again." };
  if (status === 404 || code === "model_not_found")
    return { status: 503, message: `The AI model "${modelName()}" is not available for this account. The site owner can set OPENAI_MODEL in Netlify.` };
  if (status === 400) return { status: 400, message: "The AI service could not process this request. Try a shorter transcript." };
  if (status >= 500) return { status: 502, message: "The AI service is temporarily unavailable. Please try again shortly." };
  if (err?.name === "APIConnectionTimeoutError" || /timeout/i.test(String(err?.message)))
    return { status: 504, message: "The AI service took too long to respond. Try Standard depth or a shorter transcript." };
  if (/api key/i.test(String(err?.message)))
    return { status: 503, message: "AI is not configured. The site owner needs to add OPENAI_API_KEY in Netlify and redeploy." };
  return { status: 500, message: "AI analysis failed unexpectedly. Please try again." };
}
