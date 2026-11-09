import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { httpBriefsPorts } from "./remote-ports";

const token = "test-token";
const app = createApp({ serviceToken: token });
const admin = "11111111-1111-4111-8111-111111111111";
const call = (path: string, init: RequestInit = {}) =>
  app(new Request(`http://briefs${path}`, init));
const auth = { authorization: `Bearer ${token}` };

describe("briefs http", () => {
  it("serves health without a token", async () => {
    expect((await call("/health")).status).toBe(200);
  });
  it("refuses a missing token", async () => {
    expect((await call("/v1/admin")).status).toBe(401);
  });
  it("needs the admin id before the body", async () => {
    const res = await call("/v1/admin/settings", { method: "PUT", headers: auth, body: "{bad" });
    expect(res.status).toBe(401);
  });
  it("rejects a bad body", async () => {
    const res = await call("/v1/admin/settings", {
      method: "PUT",
      headers: { ...auth, "x-user-id": admin },
      body: JSON.stringify({ paused: "yes" }),
    });
    expect(res.status).toBe(400);
  });
  it("answers 404 for a bad job id and unknown routes", async () => {
    expect((await call("/v1/jobs/nope/candidate-cards", { headers: auth })).status).toBe(404);
    expect((await call("/v1/nothing", { headers: auth })).status).toBe(404);
  });
});

describe("remote ports", () => {
  it("maps the match screen and throws on failure", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("match-screen")
        ? Response.json({ items: [{ score: 90, job: { id: "j" } }] })
        : new Response("no", { status: 503 }),
    );
    const ports = httpBriefsPorts({
      notifications: { url: "http://n", token: "a" },
      matching: { url: "http://m/", token: "b" },
      platform: { url: "http://p", token: "c" },
      fetchImpl: fetchImpl as typeof fetch,
    });
    const items = await ports.matchScreen(admin, { limit: 5, locale: "en" });
    expect(items[0]?.score).toBe(90);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe("http://m/v1/me/match-screen?tab=all&limit=5&locale=en");
    await expect(ports.computeMatchesForJob("j")).rejects.toThrow("503");
  });
});
