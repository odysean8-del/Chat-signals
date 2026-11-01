import { getStore } from "@netlify/blobs";

// Short-lived AI job records. Inputs are deleted as soon as the worker reads them,
// results are deleted as soon as the browser collects them, and a scheduled
// cleanup removes anything older than JOB_TTL_MS.
export const JOB_TTL_MS = 60 * 60 * 1000;

export const jobStore = () => getStore({ name: "ai-jobs", consistency: "strong" });
export const rateStore = () => getStore({ name: "ai-rate-limits", consistency: "strong" });

export type JobType = "analysis" | "transcription";
export type JobRecord = {
  status: "queued" | "running" | "done" | "error";
  type: JobType;
  token?: string;
  createdAt: number;
  result?: unknown;
  error?: string;
  errorStatus?: number;
};

// Job IDs start with a base-36 creation time so cleanup can expire them without reading each record.
export const newJobId = () => `${Date.now().toString(36)}-${crypto.randomUUID()}`;
export const jobCreatedAt = (id: string) => parseInt(id.split("-")[0], 36) || 0;
export const isValidJobId = (id: string) => /^[0-9a-z]{6,12}-[0-9a-f-]{36}$/.test(id);

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Coarse per-visitor hourly limit. Stores only a hash of the IP, never the IP itself.
export async function checkRateLimit(ip: string, cost = 1) {
  const limit = Number(process.env.AI_HOURLY_LIMIT) || 30;
  const hour = Math.floor(Date.now() / 3_600_000);
  const key = `${hour}/${(await sha256(`chat-signals:${ip}`)).slice(0, 32)}`;
  const store = rateStore();
  const used = Number((await store.get(key, { type: "json" })) ?? 0);
  if (used + cost > limit) return false;
  await store.setJSON(key, used + cost);
  return true;
}
