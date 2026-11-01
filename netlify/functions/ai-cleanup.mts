import type { Config } from "@netlify/functions";
import { JOB_TTL_MS, jobCreatedAt, jobStore, rateStore } from "../lib/jobs.mts";

// Hourly sweep of anything the browser never collected, plus old rate-limit buckets.
export default async () => {
  const now = Date.now();
  const jobs = jobStore();
  const { blobs } = await jobs.list();
  await Promise.all(
    blobs
      .filter((b) => now - jobCreatedAt(b.key.split("/").pop() || "") > JOB_TTL_MS)
      .map((b) => jobs.delete(b.key))
  );

  const currentHour = Math.floor(now / 3_600_000);
  const rates = rateStore();
  const { blobs: buckets } = await rates.list();
  await Promise.all(
    buckets.filter((b) => Number(b.key.split("/")[0]) < currentHour - 1).map((b) => rates.delete(b.key))
  );
};

export const config: Config = {
  schedule: "@hourly",
};
