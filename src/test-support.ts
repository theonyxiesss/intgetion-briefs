import { deliverInTransaction, isNotificationType } from "@intgetion/notifications";
import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { setBriefsPorts, type BriefsPorts } from "./ports";

/** The platform users table, as tests insert into it. */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  authUid: uuid("auth_uid").notNull(),
  locale: text("locale").notNull().default("en"),
  termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }),
  termsVersion: text("terms_version"),
});

export const chatNotes: { userId: string; text: string }[] = [];

/**
 * In-process ports, as the platform will wire them: delivery writes with the
 * brief's own transaction through the notifications package.
 */
export function useInProcessPorts(overrides: Partial<BriefsPorts> = {}) {
  setBriefsPorts({
    deliver: async (input, tx) => {
      if (!isNotificationType(input.type)) throw new Error(`unknown type ${input.type}`);
      await deliverInTransaction(tx as Parameters<typeof deliverInTransaction>[0], {
        ...input,
        type: input.type,
      });
    },
    matchScreen: async () => [],
    computeMatchesForJob: async () => {},
    postSystemEvent: async (userId, text) => {
      chatNotes.push({ userId, text });
    },
    llm: () => null,
    ...overrides,
  });
}
