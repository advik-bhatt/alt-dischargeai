/**
 * Language handling for the pipeline. Any BCP-47 tag the model supports is accepted; nothing on the
 * diagram caps the list. Codes are normalised ("ES-mx" -> "es-MX", "Spanish" -> "es") and named with
 * the runtime's ICU data, so no hand-maintained list exists on this branch.
 */

export const ENGLISH = "en";

const NAME_TO_CODE: Record<string, string> = {
  english: "en",
  spanish: "es",
  español: "es",
  castellano: "es",
  mandarin: "zh",
  chinese: "zh",
  中文: "zh",
  arabic: "ar",
  العربية: "ar",
  portuguese: "pt",
  french: "fr",
  "haitian creole": "ht",
  creole: "ht",
  russian: "ru",
  korean: "ko",
  vietnamese: "vi",
  tagalog: "tl",
  filipino: "tl",
  hindi: "hi",
  gujarati: "gu",
  polish: "pl",
  italian: "it",
  german: "de",
  japanese: "ja",
  urdu: "ur",
  bengali: "bn",
  persian: "fa",
  farsi: "fa",
};

const BCP47 = /^[a-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Z]{2}|\d{3}))?$/;

/** Canonical BCP-47 code for a code, an English name or a native name; undefined when unrecognisable. */
export function normalizeLanguage(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  const byName = NAME_TO_CODE[raw.toLowerCase()];
  if (byName) return byName;
  const parts = raw.replace(/_/g, "-").split("-");
  const lang = parts[0].toLowerCase();
  if (!/^[a-z]{2,3}$/.test(lang)) return undefined;
  const rest = parts.slice(1).map((p) => (p.length === 4 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toUpperCase()));
  const code = [lang, ...rest].join("-");
  if (!BCP47.test(code)) return undefined;
  try {
    return Intl.getCanonicalLocales(code)[0] ?? code;
  } catch {
    return undefined;
  }
}

/** English display name for prompts ("es" -> "Spanish", "zh" -> "Chinese"). Falls back to the code. */
export function languageName(code: string): string {
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name && name !== code ? name : code;
  } catch {
    return code;
  }
}

/** Unique, normalised, English first; the provider-picked language is kept first among the rest. */
export function resolveLanguages(primary: string | undefined, extra: string[] = []): { primary: string; languages: string[] } {
  const p = (primary && normalizeLanguage(primary)) || ENGLISH;
  const ordered = [ENGLISH, p, ...extra.map((e) => normalizeLanguage(e)).filter((x): x is string => !!x)];
  return { primary: p, languages: [...new Set(ordered)] };
}
