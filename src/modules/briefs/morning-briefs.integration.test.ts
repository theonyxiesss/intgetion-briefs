import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@intgetion/kit";
import { chatNotes, users, useInProcessPorts } from "../../test-support";
import { runMorningBriefsCron, runSlot, type DigestJobLoader } from "./service";

const userId = randomUUID();
const quietUserId = randomUUID();
// 08:00 in Moscow (UTC+3): the "cis" slot, far from any other test's clock.
const morning = new Date("2031-03-03T05:00:00Z");
const jobIds = [randomUUID(), randomUUID(), randomUUID()];

// Only our candidate has a feed; every other profile in the database gets
// an empty one, so the run sends nothing to anybody else.
const loadJobs: DigestJobLoader = async (id) =>
  id === userId
    ? [
        {
          jobId: jobIds[0]!,
          title: "Rust engineer",
          companyName: "Acme",
          score: 0.91,
          publishedAt: "2031-03-02T12:00:00Z",
        },
        {
          jobId: jobIds[1]!,
          title: "Go engineer",
          companyName: "Beta",
          score: 0.7,
          publishedAt: "2031-03-02T13:00:00Z",
        },
        {
          jobId: jobIds[2]!,
          title: "Weak match",
          companyName: "Gamma",
          score: 0.6,
          publishedAt: "2031-03-02T14:00:00Z",
        },
      ]
    : [];

useInProcessPorts();

beforeAll(async () => {
  const db = getDb();
  for (const [id, locale] of [
    [userId, "ru"],
    [quietUserId, "en"],
  ] as const) {
    await db.insert(users).values({
      id,
      authUid: randomUUID(),
      termsAcceptedAt: new Date("2031-01-01T00:00:00Z"),
      termsVersion: "2026-10-03",
      locale,
    });
    await db.execute(sql`
      insert into public.candidate_profiles (user_id) values (${id})
    `);
    // The time zone lives in the shared profile (D509).
    await db.execute(sql`
      insert into public.user_profiles (user_id, timezone)
      values (${id}, 'Europe/Moscow')
    `);
  }
});

afterAll(async () => {
  await getDb()
    .delete(users)
    .where(inArray(users.id, [userId, quietUserId]));
});

async function lastDigestAt(id: string): Promise<Date | null> {
  const [row] = await getDb().execute<{ last_digest_at: string | null }>(sql`
    select last_digest_at from public.candidate_profiles where user_id = ${id}
  `);
  return row?.last_digest_at ? new Date(row.last_digest_at) : null;
}

async function digestCount(): Promise<number> {
  const [row] = await getDb().execute<{ count: number }>(sql`
    select count(*)::int as count from public.notifications
    where user_id = ${userId} and type = 'matches.digest'
  `);
  return row?.count ?? 0;
}

describe("morning briefs cron against the database (D340)", () => {
  it("sends one digest: in-app, a queued email and a chat note", async () => {
    await runMorningBriefsCron({ now: morning, loadJobs });

    const notifications = await getDb().execute<{
      payload: {
        matchCount: number;
        sampleJobIds: string[];
        sampleJobs: { jobId: string; title: string; companyName: string }[];
      };
    }>(sql`
      select payload from public.notifications
      where user_id = ${userId} and type = 'matches.digest'
    `);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.payload.matchCount).toBe(2);
    expect(notifications[0]!.payload.sampleJobIds).toEqual([
      jobIds[0],
      jobIds[1],
    ]);
    expect(notifications[0]!.payload.sampleJobs).toEqual([
      { jobId: jobIds[0], title: "Rust engineer", companyName: "Acme" },
      { jobId: jobIds[1], title: "Go engineer", companyName: "Beta" },
    ]);

    const emails = await getDb().execute<{
      locale: string;
      status: string;
      payload: { jobs: { jobTitle: string }[] };
    }>(sql`
      select locale, status, payload from public.notification_emails
      where user_id = ${userId} and type = 'matches.digest'
    `);
    expect(emails).toHaveLength(1);
    expect(emails[0]!.locale).toBe("ru");
    expect(emails[0]!.status).toBe("pending");
    expect(emails[0]!.payload.jobs.map((job) => job.jobTitle)).toEqual([
      "Rust engineer — Acme",
      "Go engineer — Beta",
    ]);

    const notes = chatNotes.filter((note) => note.userId === userId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.text).toContain("2");

    expect(await lastDigestAt(userId)).toEqual(morning);
    // No new matches: nothing sent and the slot stays free.
    expect(await lastDigestAt(quietUserId)).toBeNull();
  });

  it("never sends a second digest for the same morning", async () => {
    const later = new Date(+morning + 30 * 60 * 1000);
    await runMorningBriefsCron({ now: later, loadJobs });
    await Promise.all([
      runMorningBriefsCron({ now: later, loadJobs }),
      runMorningBriefsCron({ now: later, loadJobs }),
    ]);
    expect(await digestCount()).toBe(1);
  });

  it("skips the next morning when nothing new was published", async () => {
    const nextMorning = new Date(+morning + 24 * 60 * 60 * 1000);
    await runMorningBriefsCron({ now: nextMorning, loadJobs });
    expect(await digestCount()).toBe(1);
    expect(await lastDigestAt(userId)).toEqual(morning);
  });

  it("logs one live run per slot day and none outside the window", async () => {
    const runs = await getDb().execute<{ slot_id: string; sent: number }>(sql`
      select slot_id, sent from public.brief_runs
      where slot_date = '2031-03-03' and not dry_run
    `);
    expect(runs).toEqual([{ slot_id: "cis", sent: 1 }]);
    const tooLate = new Date(+morning + 3 * 60 * 60 * 1000);
    const result = await runMorningBriefsCron({ now: tooLate, loadJobs });
    expect(result.runs.filter((run) => run.slotId === "cis")).toEqual([]);
  });

  it("does nothing while paused", async () => {
    const db = getDb();
    await db.execute(sql`update public.brief_settings set paused = true`);
    try {
      const day = new Date(+morning + 7 * 24 * 60 * 60 * 1000);
      expect(await runMorningBriefsCron({ now: day, loadJobs })).toEqual({
        paused: true,
        runs: [],
      });
    } finally {
      await db.execute(sql`update public.brief_settings set paused = false`);
    }
  });

  it("skips candidates who turned the agent off", async () => {
    const db = getDb();
    await db.execute(sql`
      update public.candidate_profiles
      set agent_briefs_enabled = false, last_digest_at = null
      where user_id = ${userId}
    `);
    const before = await digestCount();
    const dry = await runSlot({
      slotId: "cis",
      slotDate: "2031-03-20",
      now: new Date("2031-03-20T05:00:00Z"),
      dryRun: true,
      loadJobs,
    });
    expect(dry?.sent).toBe(0);
    const live = await runSlot({
      slotId: "cis",
      slotDate: "2031-03-21",
      now: new Date("2031-03-21T05:00:00Z"),
      dryRun: false,
      loadJobs,
    });
    expect(live?.sent).toBe(0);
    expect(await digestCount()).toBe(before);
  });

  it("counts in a dry run and sends nothing", async () => {
    await getDb().execute(sql`
      update public.candidate_profiles
      set agent_briefs_enabled = true, last_digest_at = null
      where user_id = ${userId}
    `);
    const before = await digestCount();
    const run = await runSlot({
      slotId: "cis",
      slotDate: "2031-03-04",
      now: new Date("2031-03-04T05:00:00Z"),
      dryRun: true,
      loadJobs,
    });
    expect(run?.sent).toBe(1);
    expect(await digestCount()).toBe(before);
  });
});
