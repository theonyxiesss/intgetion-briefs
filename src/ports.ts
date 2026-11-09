import type { AppLocale } from "@intgetion/kit";
import type { toEmailJob } from "@intgetion/notifications";

/** The job fields an email card needs (as notifications reads them). */
export type EmailJobSource = Parameters<typeof toEmailJob>[0];

/** The part of an LLM provider the brief intro needs (same shape as the platform's). */
export type BriefLlm = {
  model?: string;
  complete: (request: {
    model: string;
    system: string;
    messages: { role: "user"; content: string }[];
    maxTokens: number;
  }) => Promise<{ text: string }>;
};

export type BriefDelivery = {
  userId: string;
  type: "matches.digest" | "company.candidates_digest";
  locale: AppLocale;
  payload: Record<string, unknown>;
  emailPayload?: Record<string, unknown>;
  now: Date;
};

/** A job on the candidate's match screen, as matching serves it. */
export type FeedMatch = {
  score: number;
  job: EmailJobSource & {
    id: string;
    title: string;
    publishedAt: string | null;
    company: { name: string };
  };
};

export type BriefsPorts = {
  /**
   * notifications: one scheduled notice by the person's preferences. Called
   * inside the brief transaction that claims the delivery; an in-process
   * adapter writes with `tx` so the claim and the notice commit together.
   */
  deliver: (input: BriefDelivery, tx?: unknown) => Promise<void>;
  /** matching: the candidate's match screen, and a fresh match run for a job. */
  matchScreen: (userId: string, input: { limit: number; locale: AppLocale }) => Promise<FeedMatch[]>;
  computeMatchesForJob: (jobId: string) => Promise<void>;
  /** bot (platform until extracted): a note in the assistant chat; failures never stop a brief. */
  postSystemEvent: (userId: string, text: string) => Promise<void>;
  /** The LLM for the friendly intro; null or a failure gives the template. */
  llm: () => BriefLlm | null;
};

let ports: BriefsPorts | null = null;

export function setBriefsPorts(next: BriefsPorts): void {
  ports = next;
}

export function briefsPorts(): BriefsPorts {
  if (!ports) throw new Error("briefs ports are not configured");
  return ports;
}
