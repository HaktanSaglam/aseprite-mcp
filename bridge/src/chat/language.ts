// Models told "reply in the user's language" sometimes guess wrong (German or Russian
// for an English request), so the bridge names the language. A cheap heuristic is
// enough: scripts first, then letters and small words typical of one language.

interface LanguageRule {
  name: string;
  test: (text: string, words: Set<string>) => boolean;
}

const has = (words: Set<string>, list: string[], min = 1) => list.filter((w) => words.has(w)).length >= min;

const RULES: LanguageRule[] = [
  { name: "Japanese", test: (t) => /[぀-ヿ]/.test(t) },
  { name: "Korean", test: (t) => /[가-힯]/.test(t) },
  { name: "Chinese", test: (t) => /[一-鿿]/.test(t) },
  { name: "Russian", test: (t) => /[Ѐ-ӿ]/.test(t) },
  { name: "Arabic", test: (t) => /[؀-ۿ]/.test(t) },
  {
    name: "Turkish",
    test: (t, w) =>
      /[ğışİ]/.test(t) ||
      has(w, ["bir", "ve", "bu", "şu", "için", "ile", "yap", "çiz", "ekle", "daha", "gibi", "olsun", "renk", "küçük", "büyük"]),
  },
  { name: "German", test: (t, w) => /ß/.test(t) || has(w, ["der", "die", "das", "und", "ein", "eine", "mit", "nicht", "ist"], 2) },
  { name: "Spanish", test: (t, w) => /ñ|¿|¡/.test(t) || has(w, ["el", "la", "los", "las", "una", "con", "para", "del", "que"], 2) },
  { name: "Portuguese", test: (t, w) => /[ãõ]/.test(t) || has(w, ["um", "uma", "com", "para", "não", "do", "da"], 2) },
  { name: "French", test: (t, w) => has(w, ["le", "la", "les", "un", "une", "avec", "pour", "des", "du", "est"], 2) },
  { name: "Italian", test: (t, w) => has(w, ["il", "lo", "gli", "una", "con", "per", "della", "che"], 2) },
];

/** The language a request is written in, or undefined when it doesn't say (empty text). */
export function detectLanguage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const words = new Set(trimmed.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean));
  return RULES.find((rule) => rule.test(trimmed, words))?.name ?? "English";
}
