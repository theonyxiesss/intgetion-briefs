import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@intgetion/kit";
import { users, useInProcessPorts } from "../../test-support";
import type { BriefLlm as LLMProvider } from "../../ports";
import {
  runSlot,
  writeBriefIntro,
  type BriefIntroWriter,
  type DigestJobLoader,
} from "./service";

const userId = randomUUID();
// 12:00 in Moscow: the "cis" slot, on a day no other test uses.
const now = new Date("2034-06-06T09:00:00Z");
const loadJobs: DigestJobLoader = async (id) =>
  id === userId
    ? [
        {
          jobId: randomUUID(),
          title: "Rust engineer",
          companyName: "Acme",
          score: 0.9,
          publishedAt: "2034-06-05T12:00:00Z",
        },
      ]
    : [];
const broken: LLMProvider = {
  complete: async () => {
    throw new Error("provider down");
  },
};
const writeIntro: BriefIntroWriter = (input) =>
  writeBriefIntro(input, { provider: broken, model: "m" });

useInProcessPorts();

beforeAll(async () => {
  const db = getDb();
  await db.insert(users).values({
    id: userId,
    authUid: randomUUID(),
    termsAcceptedAt: new Date("2034-01-01T00:00:00Z"),
    termsVersion: "2026-10-03",
    locale: "es",
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

describe("brief intro against the database (D370)", () => {
  it("an LLM error still sends the brief with the template intro", async () => {
    const run = await runSlot({
      slotId: "cis",
      slotDate: "2034-06-06",
      now,
      dryRun: false,
      loadJobs,
      loadCandidates: async () => [],
      writeIntro,
    });
    expect(run?.sent).toBeGreaterThanOrEqual(1);
    const rows = await getDb().execute<{ payload: { intro?: string } }>(sql`
      select payload from public.notifications
      where user_id = ${userId} and type = 'matches.digest'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload.intro).toBe(
      "¡Buenos días! Hoy encontré 1 vacante que encaja contigo.",
    );
  });
});
