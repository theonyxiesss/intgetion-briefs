import { describe, expect, it } from "vitest";
import type { BriefLlm as LLMProvider } from "../../../ports";
import { cleanIntro, templateIntro } from "../lib/brief-intro";
import { writeBriefIntro } from "../service/brief-intro";
import { telegramText } from "@intgetion/notifications";

const cards = [
  {
    id: "11111111-1111-1111-1111-111111111111",
    lines: ["Rust engineer — Acme"],
  },
  { id: "22222222-2222-2222-2222-222222222222", lines: ["Go engineer — Beta"] },
];

const failing: LLMProvider = {
  complete: async () => {
    throw new Error("429 limit");
  },
};
const hanging: LLMProvider = { complete: () => new Promise(() => {}) };
const answering = (text: string): LLMProvider => ({
  complete: async () => ({
    text,
    toolCalls: [],
    usage: { tokensIn: 1, tokensOut: 1 },
    stopReason: "end",
  }),
});

describe("brief intro (D370)", () => {
  it("an LLM error gives the template", async () => {
    const intro = await writeBriefIntro(
      { locale: "ru", audience: "candidate", cards },
      { provider: failing, model: "m" },
    );
    expect(intro).toEqual({
      source: "template",
      text: "Доброе утро! Сегодня я нашёл 2 подходящие вакансии.",
    });
  });

  it("a timeout gives the template", async () => {
    const intro = await writeBriefIntro(
      { locale: "pt-BR", audience: "employer", cards },
      { provider: hanging, model: "m", timeoutMs: 10 },
    );
    expect(intro.source).toBe("template");
    expect(intro.text).toBe(
      "Bom dia! Hoje encontrei 2 candidatos para suas vagas.",
    );
  });

  it("an empty answer gives the template; a good one is cleaned", async () => {
    expect(
      (
        await writeBriefIntro(
          { locale: "en", audience: "candidate", cards },
          { provider: answering("  "), model: "m" },
        )
      ).source,
    ).toBe("template");
    const intro = await writeBriefIntro(
      { locale: "en", audience: "candidate", cards },
      {
        provider: answering(
          "**Morning!** Two Go and Rust roles https://x.y today.",
        ),
        model: "m",
      },
    );
    expect(intro).toEqual({
      source: "llm",
      text: "Morning! Two Go and Rust roles today.",
    });
  });

  it("templates exist in every language", () => {
    for (const locale of ["en", "ru", "es", "pt-BR"] as const) {
      expect(templateIntro(locale, "candidate", 1)).not.toContain("{");
      expect(templateIntro(locale, "employer", 5)).toContain("5");
    }
    expect(cleanIntro("x".repeat(400))!.length).toBeLessThanOrEqual(300);
  });

  it("Telegram opens with the intro", () => {
    const text = telegramText({
      locale: "en",
      type: "matches.digest",
      payload: {
        matchCount: 1,
        sampleJobIds: [],
        intro: "Hello there, one job.",
      },
      siteUrl: "https://intgetion.com",
    })!;
    expect(text.split("\n")[1]).toBe("Hello there, one job.");
  });
});
