import { randomUUID } from "node:crypto";
import { inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "@intgetion/kit";
import { users, useInProcessPorts } from "../../test-support";
import {
  readCompanyMatches,
  runSlot,
  type DigestJobLoader,
  type EmployerCandidateLoader,
} from "./service";

const ownerId = randomUUID();
const companyId = randomUUID();
const jobId = randomUUID();
const visible = Array.from({ length: 6 }, () => randomUUID());
const hiddenId = randomUUID();
const appliedId = randomUUID();
const candidates = [...visible, hiddenId, appliedId];
const allUsers = [ownerId, ...candidates];

// 08:00 in Berlin (UTC+1 in March): the "europe" slot, where employers go.
const day = (n: number) => `2032-03-${String(n).padStart(2, "0")}`;
const at = (n: number) => new Date(`${day(n)}T07:00:00Z`);

// Candidates get nothing; employers only see our company's stored matches,
// read by the real SQL (hidden, applied, threshold), without a recompute.
const noJobs: DigestJobLoader = async () => [];
const loadCandidates: EmployerCandidateLoader = async (id, locale) =>
  id === companyId ? readCompanyMatches(id, locale) : [];

const description =
  "A remote role for the employer brief integration test, long enough.";

useInProcessPorts();

beforeAll(async () => {
  const db = getDb();
  for (const id of allUsers) {
    await db.insert(users).values({
      id,
      authUid: randomUUID(),
      termsAcceptedAt: new Date("2032-01-01T00:00:00Z"),
      termsVersion: "2026-10-03",
      locale: "en",
    });
  }
  await db.execute(sql`
    insert into public.companies (id, name, slug, status, created_by)
    values (${companyId}, 'Brief Integration Co', ${`brief-${companyId.slice(0, 8)}`},
            'verified', ${ownerId})
  `);
  await db.execute(sql`
    insert into public.company_members (company_id, user_id, role)
    values (${companyId}, ${ownerId}, 'owner')
  `);
  await db.execute(sql`
    insert into public.jobs (
      id, company_id, created_by, title, description, category,
      employment_type, application_method, source, status, published_at
    ) values (
      ${jobId}, ${companyId}, ${ownerId}, 'Brief integration role',
      ${description}, 'engineering', 'full_time', 'internal', 'internal',
      'published', now()
    )
  `);
  for (const [index, id] of candidates.entries()) {
    await db.execute(sql`
      insert into public.candidate_profiles
        (user_id, desired_titles, experience_years,
         is_hidden, agent_briefs_enabled, created_at, updated_at)
      values (${id}, array['Backend engineer'], 5, ${id === hiddenId}, false,
              '2032-03-01T00:00:00Z', '2032-03-01T00:00:00Z')
    `);
    // Name and time zone live in the shared profile (D509).
    await db.execute(sql`
      insert into public.user_profiles (user_id, display_name, timezone)
      values (${id}, ${`Secret Name ${index}`}, 'Asia/Tokyo')
    `);
    await db.execute(sql`
      insert into public.matching_results
        (user_id, job_id, score, breakdown, explain, algo_version, computed_at)
      values (${id}, ${jobId}, ${(0.95 - index / 100).toFixed(4)}, '{}'::jsonb,
              '[{"criterion":"skills","verdict":"matched"}]'::jsonb, 1, now())
    `);
  }
  await db.execute(sql`
    insert into public.applications (job_id, candidate_id, status)
    values (${jobId}, ${appliedId}, 'applied')
  `);
});

afterAll(async () => {
  const db = getDb();
  await db.execute(sql`delete from public.companies where id = ${companyId}`);
  await db.delete(users).where(inArray(users.id, allUsers));
});

async function briefs() {
  return getDb().execute<{ payload: Record<string, unknown> }>(sql`
    select payload from public.notifications
    where user_id = ${ownerId} and type = 'company.candidates_digest'
  `);
}

async function run(n: number) {
  return runSlot({
    slotId: "europe",
    slotDate: day(n),
    now: at(n),
    dryRun: false,
    loadJobs: noJobs,
    loadCandidates,
  });
}

describe("employer morning brief against the database (D368)", () => {
  it("sends nothing while the company flag is off", async () => {
    await run(2);
    expect(await briefs()).toHaveLength(0);
  });

  it("sends five anonymous cards: no hidden, no applied, no contacts", async () => {
    await getDb().execute(sql`
      update public.companies set agent_briefs_enabled = true
      where id = ${companyId}
    `);
    await run(3);
    const rows = await briefs();
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as {
      matchCount: number;
      sampleCandidates: Record<string, unknown>[];
    };
    expect(payload.matchCount).toBe(5);
    expect(payload.sampleCandidates).toHaveLength(5);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("Secret Name");
    for (const id of candidates) expect(text).not.toContain(id);
    expect(payload.sampleCandidates[0]).toEqual({
      jobId,
      jobTitle: "Brief integration role",
      role: "Backend engineer",
      experienceYears: 5,
      skills: [],
      reasons: ["skills"],
    });

    const [delivery] = await getDb().execute<{ item_ids: string[] }>(sql`
      select item_ids from public.brief_deliveries
      where user_id = ${ownerId} and audience = 'employer'
    `);
    expect(delivery!.item_ids).toEqual(visible.slice(0, 5));
    expect(delivery!.item_ids).not.toContain(hiddenId);
    expect(delivery!.item_ids).not.toContain(appliedId);
  });

  it("never sends a second brief for the same slot day", async () => {
    await getDb().execute(sql`
      delete from public.brief_runs where slot_id = 'europe' and slot_date = ${day(3)}::date
    `);
    await run(3);
    expect(await briefs()).toHaveLength(1);
  });

  it("stays quiet the next morning when no profile changed", async () => {
    await run(4);
    expect(await briefs()).toHaveLength(1);
  });
});
