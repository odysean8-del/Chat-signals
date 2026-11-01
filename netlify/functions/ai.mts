import type { Config, Context } from "@netlify/functions";
import { LIMITS, UserFacingError, describeAIError, modelName, validateAnalysisPayload, validateTranscriptionPayload } from "../lib/ai.mts";
import { checkRateLimit, isValidJobId, jobCreatedAt, jobStore, newJobId, JOB_TTL_MS, type JobRecord } from "../lib/jobs.mts";

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const accessCode = () => (process.env.CHAT_SIGNALS_ACCESS_CODE || "").trim();

// Constant-time comparison so the access code can't be guessed by timing.
function codesMatch(given: string, expected: string) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

async function status() {
  return json({
    available: Boolean(process.env.OPENAI_API_KEY),
    accessCodeRequired: Boolean(accessCode()),
    model: modelName(),
    limits: { maxMessages: LIMITS.maxMessages, maxImages: LIMITS.maxImages },
  });
}

async function createJob(req: Request, context: Context) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "The request was not valid JSON." }, 400);
  }

  const expected = accessCode();
  if (expected && !codesMatch(String(body?.accessCode ?? ""), expected)) {
    return json({ error: body?.accessCode ? "Incorrect AI access code." : "This site requires an AI access code. Add it in ⋮ → AI settings." }, 401);
  }
  if (!process.env.OPENAI_API_KEY) {
    return json({ error: "AI is not configured on this site yet. The site owner needs to add OPENAI_API_KEY in Netlify and redeploy." }, 503);
  }

  const type = body?.type === "transcription" ? "transcription" : "analysis";
  let input;
  try {
    input = type === "transcription" ? validateTranscriptionPayload(body.payload) : validateAnalysisPayload(body.payload);
  } catch (err) {
    const { message, status } = describeAIError(err);
    return json({ error: message }, status);
  }

  if (!(await checkRateLimit(context.ip || "unknown"))) {
    return json({ error: "You've reached the hourly AI limit for this site. Please try again later." }, 429);
  }

  const id = newJobId();
  const token = crypto.randomUUID();
  const store = jobStore();
  await store.setJSON(`input/${id}`, input);
  await store.setJSON(`job/${id}`, { status: "queued", type, token, createdAt: Date.now() } satisfies JobRecord);

  const worker = await fetch(new URL("/.netlify/functions/ai-worker-background", req.url), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, token }),
  }).catch(() => null);
  if (!worker || worker.status >= 400) {
    await Promise.all([store.delete(`input/${id}`), store.delete(`job/${id}`)]);
    return json({ error: "The AI worker could not be started. Please try again." }, 502);
  }
  return json({ id }, 202);
}

async function readJob(id: string) {
  if (!isValidJobId(id)) return json({ error: "Unknown job." }, 404);
  const store = jobStore();
  const job = (await store.get(`job/${id}`, { type: "json" })) as JobRecord | null;
  if (!job || Date.now() - jobCreatedAt(id) > JOB_TTL_MS) return json({ error: "This AI job has expired or was not found." }, 404);
  if (job.status === "done" || job.status === "error") {
    // Results are handed over once, then removed from the server.
    await store.delete(`job/${id}`);
    return job.status === "done"
      ? json({ status: "done", result: job.result })
      : json({ status: "error", error: job.error, errorStatus: job.errorStatus });
  }
  return json({ status: job.status });
}

export default async (req: Request, context: Context) => {
  try {
    const route = context.params?.route;
    if (route === "status" && req.method === "GET") return status();
    if (route === "jobs" && req.method === "POST") return createJob(req, context);
    if (route === "jobs" && req.method === "GET" && context.params?.id) return readJob(context.params.id);
    return json({ error: "Not found." }, 404);
  } catch (err) {
    console.error("ai endpoint error", err instanceof UserFacingError ? err.message : (err as any)?.name);
    return json({ error: "Something went wrong on the server. Please try again." }, 500);
  }
};

export const config: Config = {
  path: ["/api/ai/:route", "/api/ai/:route/:id"],
};
