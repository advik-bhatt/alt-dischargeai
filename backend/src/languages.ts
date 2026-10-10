/** Languages the translate endpoint accepts, by BCP-47 code, English name and native name. */
export interface Language {
  code: string;
  name: string;
  nativeName: string;
}

export const LANGUAGES: Language[] = [
  { code: "en", name: "English", nativeName: "English" },
  { code: "es", name: "Spanish", nativeName: "Español" },
  { code: "zh", name: "Mandarin Chinese", nativeName: "中文" },
  { code: "ar", name: "Arabic", nativeName: "العربية" },
  { code: "pt", name: "Portuguese", nativeName: "Português" },
  { code: "fr", name: "French", nativeName: "Français" },
  { code: "ht", name: "Haitian Creole", nativeName: "Kreyòl ayisyen" },
  { code: "ru", name: "Russian", nativeName: "Русский" },
  { code: "ko", name: "Korean", nativeName: "한국어" },
  { code: "vi", name: "Vietnamese", nativeName: "Tiếng Việt" },
  { code: "tl", name: "Tagalog", nativeName: "Tagalog" },
  { code: "hi", name: "Hindi", nativeName: "हिन्दी" },
  { code: "gu", name: "Gujarati", nativeName: "ગુજરાતી" },
  { code: "pl", name: "Polish", nativeName: "Polski" },
  { code: "it", name: "Italian", nativeName: "Italiano" },
  { code: "de", name: "German", nativeName: "Deutsch" },
  { code: "ja", name: "Japanese", nativeName: "日本語" },
  { code: "ur", name: "Urdu", nativeName: "اردو" },
  { code: "bn", name: "Bengali", nativeName: "বাংলা" },
  { code: "fa", name: "Persian", nativeName: "فارسی" },
];

const ALIASES: Record<string, string> = {
  chinese: "zh",
  mandarin: "zh",
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-tw": "zh",
  filipino: "tl",
  creole: "ht",
  "haitian creole": "ht",
  farsi: "fa",
  castellano: "es",
  "es-mx": "es",
  "es-us": "es",
  "en-us": "en",
  "pt-br": "pt",
};

/** Accepts a code ("es"), an English name ("Spanish"), a native name ("Español") or an alias. */
export function resolveLanguage(input: string): Language | undefined {
  const key = input.trim().toLowerCase();
  if (!key) return undefined;
  const direct = LANGUAGES.find(
    (l) => l.code === key || l.name.toLowerCase() === key || l.nativeName.toLowerCase() === key,
  );
  if (direct) return direct;
  const alias = ALIASES[key];
  if (alias) return LANGUAGES.find((l) => l.code === alias);
  const base = key.split(/[-_]/)[0];
  return LANGUAGES.find((l) => l.code === base);
}
