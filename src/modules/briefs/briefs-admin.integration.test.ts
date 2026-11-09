import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@intgetion/kit";
import { users, useInProcessPorts } from "../../test-support";
import { HttpError } from "@intgetion/kit";
import {
  runBriefSlotNow,
  type DigestJobLoader,
  type EmployerCandidateLoader,
} from "./service";

const userId = randomUUID();
// A Moscow candidate in the "cis" slot, on a day no other test uses.
const now = new Date("2033-05-05T09:00:00Z");
const loadJobs: DigestJobLoader = async (id) =>
  id === userId
    ? [
        {
          jobId: randomUUID(),
          title: "Rust engineer",
          companyName: "Acme",
          score: 0.9,
          publishedAt: "2033-05-04T12:00:00Z",
        },
      ]
    : [];
const loadCandidates: EmployerCandidateLoader = async () => [];

useInProcessPorts();

beforeAll(async () => {
  const db = getDb();
  await db.insert(users).values({
    id: userId,
    authUid: randomUUID(),
    termsAcceptedAt: new Date("2033-01-01T00:00:00Z"),
    termsVersion: "2026-10-03",
    locale: "en",
  });
  await db.execute(sql`
    insert into public.candidate_profiles (user_id) values (${userId})
  `);
  // The time zone lives in the shared profile (D509).
  await getDb().execute(sql`
    insert into public.user_profiles (user_id, timezone)
    values (${userId}, 'Europe/Moscow')
  `);
});

afterAll(async () => {
  await getDb()
    .delete(users)
    .where(inArray(users.id, [userId]));
});

async function count(table: "brief_deliveries" | "notifications") {
  const [row] = await getDb().execute<{ count: number }>(
    table === "brief_deliveries"
      ? sql`select count(*)::int as count from public.brief_deliveries where user_id = ${userId}`
      : sql`select count(*)::int as count from public.notifications where user_id = ${userId}`,
  );
  return row?.count ?? 0;
}

describe("briefs admin run now (D369)", () => {
  it("a dry run counts but writes no delivery and no notification", async () => {
    const run = await runBriefSlotNow("cis", true, now, {
      loadJobs,
      loadCandidates,
    });
    expect(run.dryRun).toBe(true);
    expect(run.sent).toBeGreaterThanOrEqual(1);
    expect(await count("brief_deliveries")).toBe(0);
    expect(await count("notifications")).toBe(0);
  });

  it("a second live run for the same slot day is refused", async () => {
    const first = await runBriefSlotNow("cis", false, now, {
      loadJobs,
      loadCandidates,
    });
    expect(first.dryRun).toBe(false);
    expect(await count("brief_deliveries")).toBe(1);
    const again = runBriefSlotNow("cis", false, now, {
      loadJobs,
      loadCandidates,
    });
    await expect(again).rejects.toBeInstanceOf(HttpError);
    await expect(again).rejects.toMatchObject({ status: 409 });
    expect(await count("brief_deliveries")).toBe(1);
  });
});
