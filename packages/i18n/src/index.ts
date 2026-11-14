// @melax/i18n: one function, t(lang, key, vars). The wording lives in messages.ts.
// Contract: a missing variable throws (a screen with "{name}" in it must never reach a phone);
// values supplied by users are folded to GSM-7 and clipped by the caller with clip().
// Callers: apps/gateway (USSD menus, SMS templates), apps/voice (prompt text).
import { AppError, formatFcfa, formatSats } from "@melax/core";
import { toGsm7 } from "@melax/sms";
import { type Lang, type MessageKey, messages } from "./messages.ts";

export { type Lang, type MessageKey, messages };
export const LANGS: readonly Lang[] = ["fr", "wo", "en"];
export const LANG_NAMES: Record<Lang, string> = { fr: "Francais", wo: "Wolof", en: "English" };

/**
 * The Wolof copy was written by a non-native speaker and has not been reviewed.
 * It is shipped so the flows can be tested end to end; it must not be called finished
 * until a native speaker signs it off and this flag is flipped.
 */
export const WOLOF_REVIEWED = false;

export function isLang(x: unknown): x is Lang {
  return x === "fr" || x === "wo" || x === "en";
}

export function t(lang: Lang, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const template = messages[key][lang];
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined) throw new AppError("INTERNAL", `message ${key} needs {${name}}`);
    return String(v);
  });
}

/** Names of the variables a message expects. */
export function placeholders(key: MessageKey, lang: Lang): string[] {
  return [...messages[key][lang].matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
}

/** Make user-supplied text safe for a screen: GSM-7, single line, at most `max` characters. */
export function clip(text: string, max: number): string {
  const s = toGsm7(String(text ?? "")).replace(/[\r\n]+/g, " ").trim();
  return s.length <= max ? s : s.slice(0, Math.max(1, max - 1)).trimEnd() + ".";
}

export const fcfa = formatFcfa;
export const sats = formatSats;

/** How mobile-money rails are named on screen. */
export const METHOD_NAMES: Record<string, string> = { wave: "Wave", om: "Orange Money", free: "Free Money", cash: "Cash" };
export function methodName(code: string): string {
  return METHOD_NAMES[code] ?? code;
}

/** dd/mm, the way dates are written on a receipt here. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
