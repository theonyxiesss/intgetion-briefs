import { sql } from "drizzle-orm";
import { getDb } from "@intgetion/kit";
import { logger } from "@intgetion/kit";
import { messagesFor } from "../../../i18n/messages";
import { toAppLocale } from "@intgetion/kit";
import {
  BRIEF_SLOT_IDS,
  dueSlotDate,
  employerBriefTimeZone,
  slotForTimeZone,
  type BriefSlot,
  type BriefSlotId,
} from "../lib/briefs";
import { briefsPorts } from "../../../ports";
import {
  briefEmployer,
  loadCompanyCandidates,
  readEmployerRecipients,
  type EmployerCandidateLoader,
} from "./employer-briefs";
import type { EmployerMatchRow } from "../lib/employer-briefs";
import { writeBriefIntro, type BriefIntroWriter } from "./brief-intro";
import {
  loadFeedJobs,
  pickDigestJobs,
  type DigestCandidateJob,
  type DigestJobLoader,
} from "./digest";

export type BriefRunResult = {
  slotId: BriefSlotId;
  slotDate: string;
  dryRun: boolean;
  checked: number;
  /** Employers among `checked` (D369). */
  checkedEmployers: number;
  sent: number;
  empty: number;
  failed: number;
};

type SlotRow = {
  id: string;
  timezone: string;
  local_time: string;
  enabled: boolean;
};

type CandidateRow = {
  user_id: string;
  timezone: string | null;
  locale: string;
  last_digest_at: string | Date | null;
};

function chatEvent(locale: string, count: number): string {
  const template = messagesFor(locale).digest.chatEvent;
  return template.replace("{count}", String(count));
}

function isSlotId(id: string): id is BriefSlotId {
  return (BRIEF_SLOT_IDS as readonly string[]).includes(id);
}

async function readSlots(): Promise<BriefSlot[]> {
  const rows = await getDb().execute<SlotRow>(sql`
    select id, timezone, local_time, enabled from public.brief_slots
  `);
  return rows
    .filter((row) => isSlotId(row.id))
    .map((row) => ({
      id: row.id as BriefSlotId,
      timezone: row.timezone,
      localTime: row.local_time,
      enabled: row.enabled,
    }));
}

async function isPaused(): Promise<boolean> {
  const [row] = await getDb().execute<{ paused: boolean }>(sql`
    select paused from public.brief_settings where id
  `);
  return row?.paused ?? false;
}

/**
 * Every 15 minutes (D340): each slot whose morning has come runs once per
 * local day. The cron only decides who gets what and writes the
 * notification; the Telegram dispatcher (D237) and the email queue (9A)
 * deliver it by the person's preferences.
 */
export async function runMorningBriefsCron(input?: {
  now?: Date;
  /** Test seam: the feed source; matching itself is covered by 6B tests. */
  loadJobs?: DigestJobLoader;
  /** Test seam: a company's matched candidates (D368). */
  loadCandidates?: EmployerCandidateLoader;
  /** Test seam: the intro writer (D370). */
  writeIntro?: BriefIntroWriter;
}): Promise<{ paused: boolean; runs: BriefRunResult[] }> {
  const now = input?.now ?? new Date();
  if (await isPaused()) return { paused: true, runs: [] };
  const runs: BriefRunResult[] = [];
  for (const slot of await readSlots()) {
    const slotDate = dueSlotDate(slot, now);
    if (!slotDate) continue;
    const run = await runSlot({
      slotId: slot.id,
      slotDate,
      now,
      dryRun: false,
      loadJobs: input?.loadJobs,
      loadCandidates: input?.loadCandidates,
      writeIntro: input?.writeIntro,
    });
    if (run) runs.push(run);
  }
  return { paused: false, runs };
}

/**
 * One slot day. A live run claims the day first, so a parallel or repeated
 * cron returns null instead of sending again. A dry run counts who would
 * get a brief and writes nothing but its own log row.
 */
export async function runSlot(input: {
  slotId: BriefSlotId;
  slotDate: string;
  now: Date;
  dryRun: boolean;
  loadJobs?: DigestJobLoader;
  loadCandidates?: EmployerCandidateLoader;
  writeIntro?: BriefIntroWriter;
}): Promise<BriefRunResult | null> {
  const { slotId, slotDate, now, dryRun } = input;
  const loadJobs = input.loadJobs ?? loadFeedJobs;
  const writeIntro = input.writeIntro ?? writeBriefIntro;
  const db = getDb();
  const [claimed] = await db.execute<{ id: string }>(sql`
    insert into public.brief_runs (slot_id, slot_date, dry_run, started_at)
    values (${slotId}, ${slotDate}::date, ${dryRun}, ${now.toISOString()}::timestamptz)
    on conflict (slot_id, slot_date) where not dry_run do nothing
    returning id
  `);
  if (!claimed) return null;

  const result: BriefRunResult = {
    slotId,
    slotDate,
    dryRun,
    checked: 0,
    checkedEmployers: 0,
    sent: 0,
    empty: 0,
    failed: 0,
  };
  let error: string | null = null;
  try {
    const candidates = await db.execute<CandidateRow>(sql`
      select cp.user_id, up.timezone,
        u.locale, cp.last_digest_at
      from public.candidate_profiles cp
      join public.users u on u.id = cp.user_id
      left join public.user_profiles up on up.user_id = cp.user_id
      where u.status = 'active' and cp.agent_briefs_enabled
        and not exists (
          select 1 from public.brief_deliveries d
          where d.user_id = cp.user_id and d.audience = 'candidate'
            and d.slot_date = ${slotDate}::date
        )
    `);
    for (const row of candidates) {
      if (slotForTimeZone(row.timezone, now) !== slotId) continue;
      result.checked += 1;
      try {
        const outcome = await briefCandidate(row, {
          slotId,
          slotDate,
          now,
          dryRun,
          loadJobs,
          writeIntro,
        });
        if (outcome === "sent") result.sent += 1;
        else result.empty += 1;
      } catch (err) {
        result.failed += 1;
        logger.error({ err, userId: row.user_id, slotId }, "brief failed");
      }
    }
    // Employers (D368) share the same counters. The slot follows the
    // companies' time zone; mixed or empty zones keep the default slot
    // (20-morning-briefs §10.3).
    {
      const cache = new Map<string, Promise<EmployerMatchRow[]>>();
      for (const recipient of await readEmployerRecipients(slotDate)) {
        const zone = employerBriefTimeZone(recipient.companyTimeZones, now);
        if (slotForTimeZone(zone, now) !== slotId) continue;
        if (!zone) {
          logger.info(
            {
              slotId,
              userId: recipient.userId,
              reason: "no_employer_time_zone",
            },
            "employer brief uses the default slot",
          );
        }
        result.checked += 1;
        result.checkedEmployers += 1;
        try {
          const outcome = await briefEmployer(recipient, {
            slotId,
            slotDate,
            now,
            dryRun,
            loadCandidates: input.loadCandidates ?? loadCompanyCandidates,
            writeIntro,
            cache,
          });
          if (outcome === "sent") result.sent += 1;
          else result.empty += 1;
        } catch (err) {
          result.failed += 1;
          logger.error(
            { err, userId: recipient.userId, slotId },
            "employer brief failed",
          );
        }
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ err, slotId, slotDate }, "brief run failed");
  }
  await db.execute(sql`
    update public.brief_runs
    set finished_at = now(), checked = ${result.checked},
        checked_employers = ${result.checkedEmployers}, sent = ${result.sent},
        empty = ${result.empty}, failed = ${result.failed}, error = ${error}
    where id = ${claimed.id}
  `);
  return result;
}

async function briefCandidate(
  row: CandidateRow,
  ctx: {
    slotId: BriefSlotId;
    slotDate: string;
    now: Date;
    dryRun: boolean;
    loadJobs: DigestJobLoader;
    writeIntro: BriefIntroWriter;
  },
): Promise<"sent" | "empty"> {
  const locale = toAppLocale(row.locale);
  const lastDigestAt = row.last_digest_at ? new Date(row.last_digest_at) : null;
  const jobs = pickDigestJobs(
    await ctx.loadJobs(row.user_id, locale, ctx.now),
    lastDigestAt,
    ctx.now,
  );
  if (jobs.length === 0) return "empty";
  if (ctx.dryRun) return "sent";

  // Outside the transaction: a slow LLM must not hold a lock (D370).
  const intro = await ctx.writeIntro({
    locale,
    audience: "candidate",
    cards: jobs.map((job) => ({
      id: job.jobId,
      lines: [`${job.title} — ${job.companyName}`],
    })),
  });

  const delivered = await getDb().transaction(async (tx) => {
    // The delivery row is the claim: a second run for this day finds it.
    const claimed = await tx.execute<{ user_id: string }>(sql`
      insert into public.brief_deliveries (user_id, audience, slot_date, slot_id, item_ids)
      values (${row.user_id}, 'candidate', ${ctx.slotDate}::date, ${ctx.slotId},
              ${toTextArray(jobs.map((job) => job.jobId))}::text[])
      on conflict do nothing
      returning user_id
    `);
    if (claimed.length === 0) return false;
    await briefsPorts().deliver(
      {
      userId: row.user_id,
      type: "matches.digest",
      locale,
      payload: {
        matchCount: jobs.length,
        sampleJobIds: jobs.map((job) => job.jobId),
        sampleJobs: jobs.map((job) => ({
          jobId: job.jobId,
          title: job.title,
          companyName: job.companyName,
        })),
        intro: intro.text,
      },
      emailPayload: { jobs: jobs.map(emailCard) },
      now: ctx.now,
    },
      tx,
    );
    // "New since the last brief" (D187) keeps counting from here.
    await tx.execute(sql`
      update public.candidate_profiles
      set last_digest_at = ${ctx.now.toISOString()}::timestamptz
      where user_id = ${row.user_id}
    `);
    return true;
  });
  if (!delivered) return "empty";

  try {
    await briefsPorts().postSystemEvent(
      row.user_id,
      `${intro.text}\n\n${chatEvent(locale, jobs.length)}`,
    );
  } catch (err) {
    // The brief already went out; the chat note is a convenience.
    logger.warn({ err, userId: row.user_id }, "brief chat note failed");
  }
  return "sent";
}

function emailCard(job: DigestCandidateJob) {
  return job.email ?? { jobTitle: `${job.title} — ${job.companyName}` };
}

/** A Postgres array literal; ids are uuids, so no quoting is needed. */
function toTextArray(ids: readonly string[]): string {
  return `{${ids.join(",")}}`;
}
