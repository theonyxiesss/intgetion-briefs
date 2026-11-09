/**
 * Morning brief slots (D340, docs/tz/20-morning-briefs.md): three regional
 * mornings instead of one per personal time zone. Pure functions; the cron
 * in service/morning-briefs.ts reads the slots from the database.
 */
import { localToUtc, timeZoneOffsetMinutes } from "@intgetion/kit";

export const BRIEF_SLOT_IDS = ["americas", "europe", "cis"] as const;
export type BriefSlotId = (typeof BRIEF_SLOT_IDS)[number];

/** A person without a time zone falls into Europe (D340). */
export const DEFAULT_BRIEF_SLOT: BriefSlotId = "europe";

/** A slot missed by the cron is still sent within this window. */
export const BRIEF_CATCH_UP_MS = 2 * 60 * 60 * 1000;

export type BriefSlot = {
  id: BriefSlotId;
  timezone: string;
  /** "HH:MM", quarter hours. */
  localTime: string;
  enabled: boolean;
};

/**
 * Americas up to UTC−2:30, Europe from −2 to +2, the CIS (and everything
 * further east) from +2:30. By the offset right now, so DST moves people
 * together with their own clock.
 */
export function slotForOffset(offsetMinutes: number): BriefSlotId {
  if (offsetMinutes <= -150) return "americas";
  if (offsetMinutes >= 150) return "cis";
  return "europe";
}

export function slotForTimeZone(
  timeZone: string | null,
  now: Date,
): BriefSlotId {
  if (!timeZone) return DEFAULT_BRIEF_SLOT;
  try {
    return slotForOffset(timeZoneOffsetMinutes(now, timeZone));
  } catch {
    return DEFAULT_BRIEF_SLOT;
  }
}

/** The slot's local calendar day as YYYY-MM-DD, and its midnight in UTC. */
function localDay(timeZone: string, now: Date): { date: string; start: Date } {
  const local = new Date(+now + timeZoneOffsetMinutes(now, timeZone) * 60000);
  const start = new Date(
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()),
  );
  return { date: start.toISOString().slice(0, 10), start };
}

/** When the slot fires today, local day included. */
export function slotStart(
  slot: Pick<BriefSlot, "timezone" | "localTime">,
  now: Date,
): { slotDate: string; startsAt: Date } {
  const day = localDay(slot.timezone, now);
  return {
    slotDate: day.date,
    startsAt: localToUtc(day.start, slot.localTime, slot.timezone),
  };
}

/**
 * The slot day to run now, or null: the slot is on, its local time has come
 * and the catch-up window has not passed. "Already ran today" is the
 * database's job (brief_runs unique index).
 */
export function dueSlotDate(slot: BriefSlot, now: Date): string | null {
  if (!slot.enabled) return null;
  const { slotDate, startsAt } = slotStart(slot, now);
  const elapsed = +now - +startsAt;
  return elapsed >= 0 && elapsed < BRIEF_CATCH_UP_MS ? slotDate : null;
}

/** The next time the slot fires, for the admin page (step D). */
export function nextSlotStart(slot: BriefSlot, now: Date): Date {
  const today = slotStart(slot, now).startsAt;
  if (+today > +now) return today;
  return slotStart(slot, new Date(+now + 24 * 60 * 60 * 1000)).startsAt;
}

/**
 * The zone of an employer's brief: the companies' zone when all of them
 * store the same valid IANA zone, otherwise null (the default slot,
 * docs/tz/20-morning-briefs.md §10.3).
 */
export function employerBriefTimeZone(
  zones: readonly (string | null)[],
  now: Date,
): string | null {
  const unique = new Set(zones);
  if (unique.size !== 1) return null;
  const [zone] = unique;
  if (!zone) return null;
  try {
    timeZoneOffsetMinutes(now, zone);
    return zone;
  } catch {
    return null;
  }
}
