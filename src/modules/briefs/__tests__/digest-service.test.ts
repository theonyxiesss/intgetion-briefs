import { describe, expect, it } from "vitest";
import {
  DIGEST_MAX_JOBS,
  pickDigestJobs,
  type DigestCandidateJob,
} from "../service/digest";

const at = (iso: string) => new Date(iso);

describe("pickDigestJobs (D186, D187)", () => {
  const now = at("2026-10-05T05:00:00Z");
  const job = (
    id: number,
    score: number,
    publishedAt: string | null,
  ): DigestCandidateJob => ({
    jobId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
    title: `Job ${id}`,
    companyName: "Co",
    score,
    publishedAt,
  });

  it("keeps strong matches only, best first, at most five", () => {
    const jobs = [
      job(1, 0.64, "2026-10-04T10:00:00Z"),
      ...[0.7, 0.9, 0.8, 0.66, 0.75, 0.95].map((score, index) =>
        job(index + 2, score, "2026-10-04T10:00:00Z"),
      ),
    ];
    const picked = pickDigestJobs(jobs, null, now);
    expect(picked).toHaveLength(DIGEST_MAX_JOBS);
    expect(picked.map((item) => item.score)).toEqual([
      0.95, 0.9, 0.8, 0.75, 0.7,
    ]);
  });

  it("takes only jobs published after the previous digest", () => {
    const picked = pickDigestJobs(
      [
        job(1, 0.9, "2026-10-04T04:00:00Z"),
        job(2, 0.9, "2026-10-04T06:00:00Z"),
        job(3, 0.9, null),
      ],
      at("2026-10-04T05:00:00Z"),
      now,
    );
    expect(picked.map((item) => item.title)).toEqual(["Job 2"]);
  });

  it("looks back one week for the first digest", () => {
    const picked = pickDigestJobs(
      [
        job(1, 0.9, "2026-09-27T04:00:00Z"),
        job(2, 0.9, "2026-09-29T04:00:00Z"),
      ],
      null,
      now,
    );
    expect(picked.map((item) => item.title)).toEqual(["Job 2"]);
  });
});
