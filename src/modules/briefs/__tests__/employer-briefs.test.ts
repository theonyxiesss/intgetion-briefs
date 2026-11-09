import { describe, expect, it } from "vitest";
import { NOTIFICATION_PAYLOAD_SCHEMAS } from "@intgetion/notifications";
import {
  EMPLOYER_BRIEF_MAX,
  pickEmployerCandidates,
  reasonsFromExplain,
  toBriefCard,
  type EmployerMatchRow,
} from "../lib/employer-briefs";
import { telegramText } from "@intgetion/notifications";

const now = new Date("2031-03-03T07:00:00Z");

function row(overrides: Partial<EmployerMatchRow> = {}): EmployerMatchRow {
  return {
    candidateId: "c-1",
    jobId: "j-1",
    jobTitle: "Rust engineer",
    score: 0.8,
    profileChangedAt: "2031-03-02T10:00:00Z",
    role: "Backend engineer",
    experienceYears: 6,
    skills: ["Rust", "PostgreSQL"],
    reasons: ["skills", "role"],
    ...overrides,
  };
}

describe("employer morning brief rules (D368)", () => {
  it("keeps at most five candidates over all jobs, best first", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      row({
        candidateId: `c-${index}`,
        jobId: index % 2 ? "j-1" : "j-2",
        score: 0.66 + index / 100,
      }),
    );
    const picked = pickEmployerCandidates(rows, null, now);
    expect(picked).toHaveLength(EMPLOYER_BRIEF_MAX);
    expect(picked.map((item) => item.candidateId)).toEqual([
      "c-7",
      "c-6",
      "c-5",
      "c-4",
      "c-3",
    ]);
  });

  it("drops scores under 0.65 and profiles not changed since the last brief", () => {
    const last = new Date("2031-03-02T00:00:00Z");
    const picked = pickEmployerCandidates(
      [
        row({ candidateId: "low", score: 0.64 }),
        row({ candidateId: "old", profileChangedAt: "2031-03-01T00:00:00Z" }),
        row({ candidateId: "new" }),
      ],
      last,
      now,
    );
    expect(picked.map((item) => item.candidateId)).toEqual(["new"]);
  });

  it("lists a candidate once, under their best job", () => {
    const picked = pickEmployerCandidates(
      [row({ jobId: "j-1", score: 0.7 }), row({ jobId: "j-2", score: 0.9 })],
      null,
      now,
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]!.jobId).toBe("j-2");
  });

  it("returns nothing when there is nothing new: no brief", () => {
    expect(pickEmployerCandidates([], null, now)).toEqual([]);
  });

  it("reads matched criteria from the explain", () => {
    expect(
      reasonsFromExplain([
        { criterion: "role", verdict: "matched" },
        { criterion: "salary", verdict: "failed" },
        { criterion: "skills", verdict: "matched" },
      ]),
    ).toEqual(["skills", "role"]);
    expect(reasonsFromExplain(null)).toEqual([]);
  });
});

describe("employer brief privacy (D368)", () => {
  it("the card carries no candidate id, score or contact", () => {
    const card = toBriefCard(row({ candidateId: "secret-user-id" }));
    expect(Object.keys(card).sort()).toEqual([
      "experienceYears",
      "jobId",
      "jobTitle",
      "reasons",
      "role",
      "skills",
    ]);
    expect(JSON.stringify(card)).not.toContain("secret-user-id");
  });

  it("the payload schema rejects contact fields", () => {
    const schema = NOTIFICATION_PAYLOAD_SCHEMAS.companyCandidatesDigest;
    const card = toBriefCard(row());
    expect(
      schema.safeParse({ matchCount: 1, sampleCandidates: [card] }).success,
    ).toBe(true);
    for (const extra of [
      { email: "a@b.c" },
      { phone: "+100" },
      { fullName: "Jane" },
      { candidateId: "c-1" },
    ]) {
      expect(
        schema.safeParse({
          matchCount: 1,
          sampleCandidates: [{ ...card, ...extra }],
        }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        matchCount: 6,
        sampleCandidates: Array.from({ length: 6 }, () => card),
      }).success,
    ).toBe(false);
  });

  it("the Telegram text links to the job in the employer cabinet", () => {
    const payload = {
      matchCount: 1,
      sampleCandidates: [toBriefCard(row({ jobId: "job-42" }))],
    };
    const text = telegramText({
      locale: "ru",
      type: "company.candidates_digest",
      payload,
      siteUrl: "https://intgetion.com",
    })!;
    expect(text).toContain("Backend engineer · 6 лет — Rust engineer");
    expect(text).toContain("Почему: навыки, роль");
    expect(text).toContain("https://intgetion.com/ru/employer/jobs/job-42");
    expect(text).not.toContain("@");
  });
});
