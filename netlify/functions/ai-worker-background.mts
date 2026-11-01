import { describeAIError, runAnalysis, runTranscription } from "../lib/ai.mts";
import { isValidJobId, jobStore, type JobRecord } from "../lib/jobs.mts";

// Background function: runs the model call, which can take longer than the synchronous limit.
export default async (req: Request) => {
  const { id, token } = await req.json().catch(() => ({}));
  if (typeof id !== "string" || !isValidJobId(id)) return;

  const store = jobStore();
  const job = (await store.get(`job/${id}`, { type: "json" })) as JobRecord | null;
  // Only jobs created by the public endpoint (matching one-time token) are processed, and only once.
  if (!job || job.status !== "queued" || !token || job.token !== token) return;

  const input = await store.get(`input/${id}`, { type: "json" });
  await store.delete(`input/${id}`);
  await store.setJSON(`job/${id}`, { status: "running", type: job.type, createdAt: job.createdAt } satisfies JobRecord);
  if (!input) {
    await store.setJSON(`job/${id}`, { status: "error", type: job.type, createdAt: job.createdAt, error: "The job input expired. Please try again.", errorStatus: 410 } satisfies JobRecord);
    return;
  }

  try {
    const result = job.type === "transcription" ? await runTranscription(input) : await runAnalysis(input);
    await store.setJSON(`job/${id}`, { status: "done", type: job.type, createdAt: job.createdAt, result } satisfies JobRecord);
  } catch (err) {
    const { message, status } = describeAIError(err);
    // Log only non-sensitive metadata: no transcript content, no credentials.
    console.error("AI job failed", { type: job.type, status: (err as any)?.status, code: (err as any)?.code });
    await store.setJSON(`job/${id}`, { status: "error", type: job.type, createdAt: job.createdAt, error: message, errorStatus: status } satisfies JobRecord);
  }
};

