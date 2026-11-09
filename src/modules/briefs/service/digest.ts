import { briefsPorts } from "../../../ports";
import type { AppLocale } from "@intgetion/kit";
import { toEmailJob, type EmailJobPayload } from "@intgetion/notifications";
import { DIGEST_MIN_SCORE } from "@intgetion/notifications";

/** At most this many jobs in one digest (D186). */
export const DIGEST_MAX_JOBS = 5;
/** The first digest looks back this far for new jobs (D187). */
export const DIGEST_FIRST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export type DigestCandidateJob = {
  jobId: string;
  title: string;
  companyName: string;
  score: number;
  publishedAt: string | null;
  /** The card the email shows (D330); absent in older test seams. */
  email?: EmailJobPayload;
};

/**
 * New since the last digest (or the last week for the first one), score at
 * least 0.65, best first, at most five (D186, D187).
 */
export function pickDigestJobs(
  jobs: readonly DigestCandidateJob[],
  lastDigestAt: Date | null,
  now: Date,
): DigestCandidateJob[] {
  const since = lastDigestAt ? +lastDigestAt : +now - DIGEST_FIRST_LOOKBACK_MS;
  return jobs
    .filter(
      (job) =>
        job.score >= DIGEST_MIN_SCORE &&
        job.publishedAt !== null &&
        Date.parse(job.publishedAt) > since,
    )
    .sort((a, b) => b.score - a.score || a.jobId.localeCompare(b.jobId))
    .slice(0, DIGEST_MAX_JOBS);
}

/** Where a candidate's matching jobs come from; a seam for tests. */
export type DigestJobLoader = (
  userId: string,
  locale: AppLocale,
  now: Date,
) => Promise<DigestCandidateJob[]>;

/** The candidate's current feed from 6B, as the "Matches" page shows it. */
export const loadFeedJobs: DigestJobLoader = async (userId, locale, now) => {
  void now;
  const items = await briefsPorts().matchScreen(userId, { limit: 50, locale });
  return items.map((item) => ({
    jobId: item.job.id,
    title: item.job.title,
    companyName: item.job.company.name,
    score: item.score,
    publishedAt: item.job.publishedAt,
    email: toEmailJob(item.job, locale),
  }));
};
