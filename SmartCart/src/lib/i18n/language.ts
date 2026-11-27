// The languages SmartCart talks in. Each is written in its own script, so the script of a
// message's words tells them apart reliably, without asking a model.
// Shared by the server (agent, voice token) and the browser (voice session).

export const LANGUAGES = ['en', 'he', 'ar'] as const;
export type Language = (typeof LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<Language, string> = { en: 'English', he: 'Hebrew', ar: 'Arabic' };

const WORD = /[\p{L}\p{M}]+/gu;

function wordLanguage(word: string): Language | null {
  if (/\p{Script=Hebrew}/u.test(word)) return 'he';
  if (/\p{Script=Arabic}/u.test(word)) return 'ar';
  if (/\p{Script=Latin}/u.test(word)) return 'en';
  return null;
}

/**
 * The language most of the text's words are written in; on a tie, the one that appears first.
 * Brands and units inside a Hebrew sentence ("2 ליטר חלב 3% של Tnuva") do not outvote it.
 * Null when the text has no Hebrew, Arabic or Latin words ("2", "👍").
 */
export function detectLanguage(text: string): Language | null {
  const counts: Record<Language, number> = { en: 0, he: 0, ar: 0 };
  const firstSeen: Language[] = [];
  for (const [word] of text.matchAll(WORD)) {
    const language = wordLanguage(word);
    if (!language) continue;
    if (!counts[language]) firstSeen.push(language);
    counts[language]++;
  }
  const top = Math.max(...Object.values(counts));
  return top ? firstSeen.find(language => counts[language] === top) ?? null : null;
}

/** The language of the customer's most recent message that has words, or null. */
export function conversationLanguage(messages: readonly { role: string; content: string }[]): Language | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'user') continue;
    const language = detectLanguage(message.content);
    if (language) return language;
  }
  return null;
}

/** A supported language from a name or code such as "Hebrew", "he" or "he-IL"; null otherwise. */
export function parseLanguage(value: unknown): Language | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return LANGUAGES.find(code => key === code || key.startsWith(`${code}-`) || key === LANGUAGE_NAMES[code].toLowerCase()) ?? null;
}
