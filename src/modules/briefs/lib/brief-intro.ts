/**
 * The opening line of a morning brief (D370): written by the LLM from the
 * ready cards, or this template when the LLM is missing or fails.
 */
import { messagesFor } from "../../../i18n/messages";
import type { AppLocale } from "@intgetion/kit";

export type BriefAudience = "candidate" | "employer";

/** Longest intro we keep; the rest of the brief carries the details. */
export const BRIEF_INTRO_MAX = 300;

function plural(template: string, count: number, locale: AppLocale): string {
  const rules = new Intl.PluralRules(locale);
  return template
    .replace(
      /\{count, plural, ((?:[a-z]+ \{[^}]*\} ?)+)\}/g,
      (_match, forms: string) => {
        const branches = new Map(
          [...forms.matchAll(/([a-z]+) \{([^}]*)\}/g)].map(
            ([, key, value]) => [key, value] as const,
          ),
        );
        const branch =
          branches.get(rules.select(count)) ?? branches.get("other") ?? "";
        return branch.replaceAll("#", String(count));
      },
    )
    .replaceAll("{count}", String(count));
}

/** The fallback intro from messages/{locale}.json. */
export function templateIntro(
  locale: AppLocale,
  audience: BriefAudience,
  count: number,
): string {
  const copy = messagesFor(locale).notifications.briefIntro;
  return plural(copy[audience], count, locale);
}

/**
 * One plain line: no links, no markup, at most BRIEF_INTRO_MAX characters.
 * Null when nothing usable is left, so the caller falls back to the template.
 */
export function cleanIntro(text: string): string | null {
  const line = text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/[<>*_`#[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (line.length < 10) return null;
  if (line.length <= BRIEF_INTRO_MAX) return line;
  const cut = line.slice(0, BRIEF_INTRO_MAX);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "));
  return end > 40
    ? cut.slice(0, end + 1)
    : `${cut.slice(0, BRIEF_INTRO_MAX - 1)}…`;
}
