import { sql } from "drizzle-orm";
import { getDb } from "@intgetion/kit";
import { messagesFor } from "../../../i18n/messages";
import { toAppLocale } from "@intgetion/kit";
import type { AppLocale } from "@intgetion/kit";
import { logger } from "@intgetion/kit";
import { NOTIFICATION_PAYLOAD_SCHEMAS } from "@intgetion/notifications";
import { DIGEST_MIN_SCORE } from "@intgetion/notifications";
import {
  pickEmployerCandidates,
  reasonsFromExplain,
  toBriefCard,
  type EmployerBriefCard,
  type EmployerMatchRow,
} from "../lib/employer-briefs";
import type { BriefSlotId } from "../lib/briefs";
import { briefsPorts } from "../../../ports";
import type { BriefIntroWriter } from "./brief-intro";

/** Matched candidates of one company's live jobs; a seam for tests. */
export type EmployerCandidateLoader = (
  companyId: string,
  locale: AppLocale,
  now: Date,
) => Promise<EmployerMatchRow[]>;

export type EmployerRecipient = {
  userId: string;
  locale: string;
  companyIds: string[];
  /** `companies.timezone` per company, in the order of `companyIds`. */
  companyTimeZones: (string | null)[];
};

/**
 * Recruiters and above of companies whose agent flag is on (D368), one row
 * per person, without a brief for this slot day yet. The slot comes from
 * the companies' time zones (0040); the cron picks it.
 */
export async function readEmployerRecipients(
  slotDate: string,
): Promise<EmployerRecipient[]> {
  const rows = await getDb().execute<{
    user_id: string;
    locale: string;
    company_ids: string[];
    company_time_zones: (string | null)[];
  }>(sql`
    select cm.user_id, u.locale, array_agg(cm.company_id::text order by cm.company_id) as company_ids,
      array_agg(c.timezone order by cm.company_id) as company_time_zones
    from public.company_members cm
    join public.companies c on c.id = cm.company_id
    join public.users u on u.id = cm.user_id
    where c.agent_briefs_enabled
      and c.status not in ('suspended', 'rejected')
      and cm.role in ('owner', 'admin', 'recruiter')
      and u.status = 'active'
      and not exists (
        select 1 from public.brief_deliveries d
        where d.user_id = cm.user_id and d.audience = 'employer'
          and d.slot_date = ${slotDate}::date
      )
    group by cm.user_id, u.locale
  `);
  return rows.map((row) => ({
    userId: row.user_id,
    locale: row.locale,
    companyIds: row.company_ids,
    companyTimeZones: row.company_time_zones,
  }));
}

type StoredMatchRow = {
  candidate_id: string;
  job_id: string;
  job_title: string;
  score: string | number;
  explain: unknown;
  profile_changed_at: string | Date;
  role: string | null;
  experience_years: number | null;
  skills: string[] | null;
};

/**
 * Stored matches of the given jobs at 0.65 or more (10.1). Hidden profiles
 * (`is_hidden`), candidates who are not looking (`job_search_status`, 0041)
 * and candidates who already applied to the company never come back. Only role, experience, skills and the explain are read: no
 * name, email, phone or link column.
 */
async function readStoredJobMatches(
  jobIds: readonly string[],
  locale: AppLocale,
): Promise<EmployerMatchRow[]> {
  if (jobIds.length === 0) return [];
  const skillName = locale === "ru" ? sql`s.name_ru` : sql`s.name_en`;
  const rows = await getDb().execute<StoredMatchRow>(sql`
    select mr.user_id as candidate_id, mr.job_id, j.title as job_title,
      mr.score, mr.explain,
      greatest(cp.created_at, cp.updated_at) as profile_changed_at,
      coalesce(cp.desired_titles[1], cp.headline) as role,
      cp.experience_years,
      array(
        select ${skillName}
        from public.candidate_skills cs
        join public.skills s on s.id = cs.skill_id
        where cs.candidate_id = cp.user_id
        order by cs.level desc, cs.years desc nulls last, s.slug
        limit 5
      ) as skills
    from public.matching_results mr
    join public.jobs j on j.id = mr.job_id
    join public.candidate_profiles cp on cp.user_id = mr.user_id
    join public.users u on u.id = mr.user_id
    where mr.job_id in (${sql.join(
      jobIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})
      and mr.score >= ${DIGEST_MIN_SCORE}
      and not cp.is_hidden
      and cp.job_search_status in ('active', 'passive')
      and u.status = 'active'
      and not exists (
        select 1 from public.applications a
        join public.jobs aj on aj.id = a.job_id
        where a.candidate_id = mr.user_id and aj.company_id = j.company_id
      )
  `);
  return rows.map((row) => ({
    candidateId: row.candidate_id,
    jobId: row.job_id,
    jobTitle: row.job_title,
    score: Number(row.score),
    profileChangedAt: new Date(row.profile_changed_at).toISOString(),
    role: row.role,
    experienceYears: row.experience_years,
    skills: row.skills ?? [],
    reasons: reasonsFromExplain(row.explain),
  }));
}

async function publishedJobIds(companyId: string): Promise<string[]> {
  const jobs = await getDb().execute<{ id: string }>(sql`
    select id from public.jobs
    where company_id = ${companyId} and status = 'published'
  `);
  return jobs.map((job) => job.id);
}

/** Stored matches of the company's published jobs, without a recompute. */
export async function readCompanyMatches(
  companyId: string,
  locale: AppLocale,
): Promise<EmployerMatchRow[]> {
  return readStoredJobMatches(await publishedJobIds(companyId), locale);
}

/**
 * The company's published jobs, freshly matched by the existing 10.1
 * matching (`computeMatchesForJob`), then read from its stored results.
 */
export const loadCompanyCandidates: EmployerCandidateLoader = async (
  companyId,
  locale,
  now,
) => {
  for (const jobId of await publishedJobIds(companyId)) {
    await briefsPorts().computeMatchesForJob(jobId);
  }
  return readCompanyMatches(companyId, locale);
};

/**
 * The anonymous list on /employer/jobs/{id} (D368): stored matches only,
 * no recompute while the page renders. The caller checks membership.
 */
export async function listJobCandidateCards(
  jobId: string,
  locale: AppLocale,
): Promise<EmployerBriefCard[]> {
  const rows = await readStoredJobMatches([jobId], locale);
  return rows
    .sort(
      (a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId),
    )
    .slice(0, 20)
    .map(toBriefCard);
}

function chatEvent(locale: AppLocale, count: number): string {
  return messagesFor(locale).notifications.employerBrief.chatEvent.replace(
    "{count}",
    String(count),
  );
}

/** The anonymous `company.candidates_digest` payload; strict, so no extras. */
export function employerBriefPayload(
  cards: readonly EmployerBriefCard[],
  intro?: string,
) {
  return NOTIFICATION_PAYLOAD_SCHEMAS.companyCandidatesDigest.parse({
    matchCount: cards.length,
    sampleCandidates: cards,
    ...(intro ? { intro } : {}),
  });
}

/** One employer brief: pick, then claim + notify in one transaction. */
export async function briefEmployer(
  recipient: EmployerRecipient,
  ctx: {
    slotId: BriefSlotId;
    slotDate: string;
    now: Date;
    dryRun: boolean;
    loadCandidates: EmployerCandidateLoader;
    writeIntro: BriefIntroWriter;
    cache: Map<string, Promise<EmployerMatchRow[]>>;
  },
): Promise<"sent" | "empty"> {
  const locale = toAppLocale(recipient.locale);
  const db = getDb();
  const [last] = await db.execute<{ at: string | Date | null }>(sql`
    select max(created_at) as at from public.brief_deliveries
    where user_id = ${recipient.userId} and audience = 'employer'
  `);
  const lastBriefAt = last?.at ? new Date(last.at) : null;
  const rows: EmployerMatchRow[] = [];
  for (const companyId of recipient.companyIds) {
    const key = `${companyId}:${locale}`;
    let pending = ctx.cache.get(key);
    if (!pending) {
      pending = ctx.loadCandidates(companyId, locale, ctx.now);
      ctx.cache.set(key, pending);
    }
    rows.push(...(await pending));
  }
  const picked = pickEmployerCandidates(rows, lastBriefAt, ctx.now);
  if (picked.length === 0) return "empty";
  if (ctx.dryRun) return "sent";

  const cards = picked.map(toBriefCard);
  // The LLM sees only the finished anonymous cards, never ids or contacts.
  const intro = await ctx.writeIntro({
    locale,
    audience: "employer",
    cards: cards.map((card) => ({
      id: card.jobId,
      lines: [
        `${card.role ?? "-"} — ${card.jobTitle}`,
        card.experienceYears === null ? "" : `${card.experienceYears}y`,
        card.skills.join(", "),
      ].filter(Boolean),
    })),
  });
  const payload = employerBriefPayload(cards, intro.text);
  const delivered = await db.transaction(async (tx) => {
    // The delivery row is the claim: a second run for this day finds it.
    const claimed = await tx.execute<{ user_id: string }>(sql`
      insert into public.brief_deliveries
        (user_id, audience, slot_date, slot_id, item_ids, created_at)
      values (${recipient.userId}, 'employer', ${ctx.slotDate}::date, ${ctx.slotId},
              ${`{${picked.map((row) => row.candidateId).join(",")}}`}::text[],
              ${ctx.now.toISOString()}::timestamptz)
      on conflict do nothing
      returning user_id
    `);
    if (claimed.length === 0) return false;
    await briefsPorts().deliver(
      {
      userId: recipient.userId,
      type: "company.candidates_digest",
      locale,
      payload,
      emailPayload: {
        jobs: cards.map((card) => ({
          jobTitle: `${card.role ?? card.jobTitle} — ${card.jobTitle}`,
        })),
      },
      now: ctx.now,
    },
      tx,
    );
    return true;
  });
  if (!delivered) return "empty";

  try {
    await briefsPorts().postSystemEvent(
      recipient.userId,
      `${intro.text}\n\n${chatEvent(locale, cards.length)}`,
    );
  } catch (err) {
    // The brief already went out; the chat note is a convenience.
    logger.warn({ err, userId: recipient.userId }, "brief chat note failed");
  }
  return "sent";
}
