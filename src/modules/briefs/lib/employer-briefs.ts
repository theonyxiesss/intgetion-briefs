/**
 * The employer side of the morning brief (D368) as pure rules: which
 * matched candidates go into one brief and what the anonymous card holds.
 * The database read lives in service/employer-briefs.ts.
 */
import { DIGEST_MIN_SCORE } from "@intgetion/notifications";

/** At most this many candidates in one brief, over all jobs together. */
export const EMPLOYER_BRIEF_MAX = 5;
/** The first brief looks back this far, like the candidate side (D187). */
export const EMPLOYER_FIRST_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

export const BRIEF_REASONS = [
  "skills",
  "role",
  "salary",
  "tzOverlap",
  "experience",
  "languages",
] as const;
export type BriefReason = (typeof BRIEF_REASONS)[number];

/** One stored match of a company job; no contact field exists here at all. */
export type EmployerMatchRow = {
  candidateId: string;
  jobId: string;
  jobTitle: string;
  score: number;
  /** When the profile appeared or last changed. */
  profileChangedAt: string;
  role: string | null;
  experienceYears: number | null;
  skills: string[];
  reasons: BriefReason[];
};

/** The card that goes into the payload: role, experience, skills, why. */
export type EmployerBriefCard = {
  jobId: string;
  jobTitle: string;
  role: string | null;
  experienceYears: number | null;
  skills: string[];
  reasons: BriefReason[];
};

/**
 * Candidates new or updated since the last brief (or the last week), score
 * at least 0.65, one row per candidate (their best job), best first, at
 * most five over all the company's jobs.
 */
export function pickEmployerCandidates(
  rows: readonly EmployerMatchRow[],
  lastBriefAt: Date | null,
  now: Date,
): EmployerMatchRow[] {
  const since = lastBriefAt ? +lastBriefAt : +now - EMPLOYER_FIRST_LOOKBACK_MS;
  const best = new Map<string, EmployerMatchRow>();
  for (const row of rows) {
    if (row.score < DIGEST_MIN_SCORE) continue;
    if (!(Date.parse(row.profileChangedAt) > since)) continue;
    const seen = best.get(row.candidateId);
    if (!seen || byScore(row, seen) < 0) best.set(row.candidateId, row);
  }
  return [...best.values()].sort(byScore).slice(0, EMPLOYER_BRIEF_MAX);
}

function byScore(a: EmployerMatchRow, b: EmployerMatchRow): number {
  return (
    b.score - a.score ||
    a.jobId.localeCompare(b.jobId) ||
    a.candidateId.localeCompare(b.candidateId)
  );
}

/** Drops the candidate id and the score: the card is anonymous. */
export function toBriefCard(row: EmployerMatchRow): EmployerBriefCard {
  return {
    jobId: row.jobId,
    jobTitle: row.jobTitle.slice(0, 200),
    role: row.role ? row.role.slice(0, 160) : null,
    experienceYears: row.experienceYears,
    skills: row.skills.slice(0, 5).map((skill) => skill.slice(0, 80)),
    reasons: row.reasons.slice(0, BRIEF_REASONS.length),
  };
}

/** Matched explain criteria, in the fixed order above. */
export function reasonsFromExplain(explain: unknown): BriefReason[] {
  if (!Array.isArray(explain)) return [];
  const matched = new Set(
    explain.flatMap((entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as { verdict?: unknown }).verdict === "matched"
        ? [(entry as { criterion?: unknown }).criterion]
        : [],
    ),
  );
  return BRIEF_REASONS.filter((reason) => matched.has(reason));
}
