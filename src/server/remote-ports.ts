import { logger } from "@intgetion/kit";
import type { BriefLlm, BriefsPorts, FeedMatch } from "../ports";

export type Endpoint = { url: string; token: string };

export type RemoteConfig = {
  notifications: Endpoint;
  matching: Endpoint;
  platform: Endpoint;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Ports answered by notifications and matching, and by the platform for the
 * assistant chat and the LLM until bot moves out. Delivery over HTTP runs
 * inside the brief transaction: a refused delivery rolls the claim back, so
 * the next run tries again.
 */
export function httpBriefsPorts(config: RemoteConfig): BriefsPorts {
  const doFetch = config.fetchImpl ?? fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const json = { "content-type": "application/json" };

  async function call(to: Endpoint, path: string, init: RequestInit = {}) {
    return doFetch(`${to.url.replace(/\/+$/, "")}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${to.token}`, ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }
  async function ok(to: Endpoint, path: string, init?: RequestInit) {
    const response = await call(to, path, init);
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    return response;
  }

  const llm: BriefLlm = {
    async complete(request) {
      const response = await ok(config.platform, "/api/internal/briefs/llm", {
        method: "POST",
        headers: json,
        body: JSON.stringify(request),
      });
      return (await response.json()) as { text: string };
    },
  };

  return {
    async deliver(input) {
      await ok(config.notifications, "/v1/deliver", {
        method: "POST",
        headers: json,
        body: JSON.stringify({
          userId: input.userId,
          type: input.type,
          locale: input.locale,
          payload: input.payload,
          emailPayload: input.emailPayload,
        }),
      });
    },
    async matchScreen(userId, input) {
      const query = new URLSearchParams({ tab: "all", limit: String(input.limit), locale: input.locale });
      const response = await ok(config.matching, `/v1/me/match-screen?${query}`, {
        headers: { "x-user-id": userId },
      });
      return ((await response.json()) as { items: FeedMatch[] }).items;
    },
    async computeMatchesForJob(jobId) {
      await ok(config.matching, `/v1/jobs/${encodeURIComponent(jobId)}/compute`, { method: "POST" });
    },
    async postSystemEvent(userId, text) {
      try {
        await ok(config.platform, "/api/internal/briefs/chat-note", {
          method: "POST",
          headers: json,
          body: JSON.stringify({ userId, text }),
        });
      } catch (error) {
        logger.warn({ err: error, userId }, "briefs: chat note failed");
        throw error;
      }
    },
    llm: () => llm,
  };
}
