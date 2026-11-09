/**
 * The admin side of the morning briefs (D369, spec 20 §7): slots, global
 * pause, run now, the 30-day log and subscription counts. Routes check the
 * admin right and write the audit row; this file only reads and writes data.
 */
import { sql } from "drizzle-orm";
import { getDb } from "@intgetion/kit";
import { HttpError, notFound, validationError } from "@intgetion/kit";
import {
  BRIEF_SLOT_IDS,
  nextSlotStart,
  slotForTimeZone,
  slotStart,
  type BriefSlot,
  type BriefSlotId,
} from "../lib/briefs";
import { runSlot, type BriefRunResult } from "./morning-briefs";

/** HH:MM on a 15-minute step, the same rule as the table check. */
export const BRIEF_TIME_PATTERN = /^([01][0-9]|2[0-3]):(00|15|30|45)$/;
/** The log shows this many days back. */
export const BRIEF_LOG_DAYS = 30;

export function isBriefSlotId(value: string): value is BriefSlotId {
  return (BRIEF_SLOT_IDS as readonly string[]).includes(value);
}

/** A real IANA zone, as Intl knows it. */
export function isIanaTimeZone(value: string): boolean {
  if (!value || !value.includes("/")) return value === "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type AdminSlotView = BriefSlot & {
  /** ISO time of the next run, UTC. */
  nextRunUtc: string;
  /** The same moment as the slot's local wall clock, "YYYY-MM-DD HH:MM". */
  nextRunLocal: string;
};

/** The admin row of a slot: next run in UTC and on the slot's own clock. */
export function slotView(slot: BriefSlot, now: Date): AdminSlotView {
  const next = nextSlotStart(slot, now);
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: slot.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(next);
  return { ...slot, nextRunUtc: next.toISOString(), nextRunLocal: local };
}

export type AdminRunRow = {
  id: string;
  slotId: string;
  slotDate: string;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string | null;
  checkedCandidates: number;
  checkedEmployers: number;
  sent: number;
  empty: number;
  failed: number;
  error: string | null;
};

export type SlotSubscriptions = {
  agent: number;
  telegram: number;
  email: number;
};

export type BriefsAdminView = {
  paused: boolean;
  slots: AdminSlotView[];
  runs: AdminRunRow[];
  subscriptions: Record<BriefSlotId, SlotSubscriptions>;
};

async function readSlots(): Promise<BriefSlot[]> {
  const rows = await getDb().execute<{
    id: string;
    timezone: string;
    local_time: string;
    enabled: boolean;
  }>(sql`select id, timezone, local_time, enabled from public.brief_slots`);
  return BRIEF_SLOT_IDS.flatMap((id) => {
    const row = rows.find((item) => item.id === id);
    return row
      ? [
          {
            id,
            timezone: row.timezone,
            localTime: row.local_time,
            enabled: row.enabled,
          },
        ]
      : [];
  });
}

async function readSlot(id: BriefSlotId): Promise<BriefSlot> {
  const slot = (await readSlots()).find((item) => item.id === id);
  if (!slot) throw notFound();
  return slot;
}

async function readRuns(now: Date): Promise<AdminRunRow[]> {
  const since = new Date(+now - BRIEF_LOG_DAYS * 24 * 60 * 60 * 1000);
  const rows = await getDb().execute<{
    id: string;
    slot_id: string;
    slot_date: string;
    dry_run: boolean;
    started_at: string | Date;
    finished_at: string | Date | null;
    checked: number;
    checked_employers: number;
    sent: number;
    empty: number;
    failed: number;
    error: string | null;
  }>(sql`
    select id, slot_id, slot_date::text as slot_date, dry_run, started_at,
      finished_at, checked, checked_employers, sent, empty, failed, error
    from public.brief_runs
    where started_at >= ${since.toISOString()}::timestamptz
    order by started_at desc
    limit 500
  `);
  return rows.map((row) => ({
    id: row.id,
    slotId: row.slot_id,
    slotDate: row.slot_date,
    dryRun: row.dry_run,
    startedAt: new Date(row.started_at).toISOString(),
    finishedAt: row.finished_at
      ? new Date(row.finished_at).toISOString()
      : null,
    checkedCandidates: row.checked - row.checked_employers,
    checkedEmployers: row.checked_employers,
    sent: row.sent,
    empty: row.empty,
    failed: row.failed,
    error: row.error,
  }));
}

/**
 * People with the agent on, per slot, and how many of them the Telegram
 * and email channels would reach (a linked Telegram; the channel not
 * turned off for their brief type). Employers have no time zone, so they
 * count in the default slot, as the cron sends them (D368).
 */
async function readSubscriptions(
  now: Date,
): Promise<Record<BriefSlotId, SlotSubscriptions>> {
  const rows = await getDb().execute<{
    timezone: string | null;
    telegram: boolean;
    email: boolean;
  }>(sql`
    with people as (
      select cp.user_id, up.timezone,
        'matches.digest' as type
      from public.candidate_profiles cp
      join public.users u on u.id = cp.user_id and u.status = 'active'
      left join public.user_profiles up on up.user_id = cp.user_id
      where cp.agent_briefs_enabled
      union
      select distinct cm.user_id, null::text, 'company.candidates_digest'
      from public.company_members cm
      join public.companies c on c.id = cm.company_id
      join public.users u on u.id = cm.user_id and u.status = 'active'
      where c.agent_briefs_enabled
        and c.status not in ('suspended', 'rejected')
        and cm.role in ('owner', 'admin', 'recruiter')
    )
    select p.timezone,
      exists (select 1 from public.telegram_accounts ta where ta.user_id = p.user_id)
        and coalesce((
          select np.enabled from public.notification_preferences np
          where np.user_id = p.user_id and np.type = p.type and np.channel = 'telegram'
        ), true) as telegram,
      coalesce((
        select np.enabled from public.notification_preferences np
        where np.user_id = p.user_id and np.type = p.type and np.channel = 'email'
      ), true) as email
    from people p
  `);
  const counts = Object.fromEntries(
    BRIEF_SLOT_IDS.map((id) => [id, { agent: 0, telegram: 0, email: 0 }]),
  ) as Record<BriefSlotId, SlotSubscriptions>;
  for (const row of rows) {
    const slot = counts[slotForTimeZone(row.timezone, now)];
    slot.agent += 1;
    if (row.telegram) slot.telegram += 1;
    if (row.email) slot.email += 1;
  }
  return counts;
}

export async function readBriefsAdmin(
  now = new Date(),
): Promise<BriefsAdminView> {
  const [settings] = await getDb().execute<{ paused: boolean }>(sql`
    select paused from public.brief_settings where id
  `);
  const [slots, runs, subscriptions] = await Promise.all([
    readSlots(),
    readRuns(now),
    readSubscriptions(now),
  ]);
  return {
    paused: settings?.paused ?? false,
    slots: slots.map((slot) => slotView(slot, now)),
    runs,
    subscriptions,
  };
}

/** Moves or pauses one slot; returns the old and the new row for the audit. */
export async function updateBriefSlot(
  adminId: string,
  id: string,
  input: { timezone: string; localTime: string; enabled: boolean },
): Promise<{ before: BriefSlot; after: BriefSlot }> {
  if (!isBriefSlotId(id)) throw notFound();
  if (!isIanaTimeZone(input.timezone)) {
    throw validationError({ timezone: "not an IANA zone" });
  }
  if (!BRIEF_TIME_PATTERN.test(input.localTime)) {
    throw validationError({ localTime: "HH:MM, 15-minute step" });
  }
  const before = await readSlot(id);
  await getDb().execute(sql`
    update public.brief_slots
    set timezone = ${input.timezone}, local_time = ${input.localTime},
        enabled = ${input.enabled}, updated_by = ${adminId}, updated_at = now()
    where id = ${id}
  `);
  return { before, after: { id, ...input } };
}

export async function setBriefsPaused(
  adminId: string,
  paused: boolean,
): Promise<{ before: boolean; after: boolean }> {
  const [row] = await getDb().execute<{ paused: boolean }>(sql`
    select paused from public.brief_settings where id
  `);
  await getDb().execute(sql`
    insert into public.brief_settings (id, paused, updated_by, updated_at)
    values (true, ${paused}, ${adminId}, now())
    on conflict (id) do update
    set paused = excluded.paused, updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
  `);
  return { before: row?.paused ?? false, after: paused };
}

/**
 * "Run now" for today's slot day on the slot's own clock. A dry run counts
 * and sends nothing. A live run for a day that already had one is refused:
 * the unique live row in brief_runs makes `runSlot` return null.
 */
export async function runBriefSlotNow(
  id: string,
  dryRun: boolean,
  now = new Date(),
  seams: Pick<
    Parameters<typeof runSlot>[0],
    "loadJobs" | "loadCandidates" | "writeIntro"
  > = {},
): Promise<BriefRunResult> {
  if (!isBriefSlotId(id)) throw notFound();
  const slot = await readSlot(id);
  const { slotDate } = slotStart(slot, now);
  const result = await runSlot({
    slotId: id,
    slotDate,
    now,
    dryRun,
    ...seams,
  });
  if (!result)
    throw new HttpError(
      409,
      "BRIEF_ALREADY_RAN",
      "A live run for this slot day already happened",
    );
  return result;
}
