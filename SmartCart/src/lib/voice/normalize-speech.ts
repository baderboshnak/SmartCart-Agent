// Speech transcripts spell numbers out ("two liters of three percent milk").
// The shopping agent's checks need digits and % ("2 liters of 3% milk"), so voice
// requests are normalized before the agent sees them. Typed messages are untouched.

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NUMBER_WORD = [...Object.keys(UNITS), ...Object.keys(TENS), 'hundred', 'thousand'].join('|');
// A run of number words such as "two hundred and fifty" or "one point five".
// "and"/"point" count only between number words, so ", and twelve eggs" keeps its "and".
const ENGLISH_NUMBER = new RegExp(`\\b(?:${NUMBER_WORD})(?:(?:[\\s-]+(?:and|point))?[\\s-]+(?:${NUMBER_WORD}))*\\b`, 'giu');

/** Convert one run of English number words to digits, or return null if it is not a number. */
function englishNumber(words: string[]): string | null {
  const tokens = words.map(word => word.toLowerCase());
  while (tokens[0] === 'and') tokens.shift();
  while (tokens.at(-1) === 'and' || tokens.at(-1) === 'point') tokens.pop();
  if (!tokens.length) return null;
  const pointAt = tokens.indexOf('point');
  const whole = pointAt === -1 ? tokens : tokens.slice(0, pointAt);
  const fraction = pointAt === -1 ? [] : tokens.slice(pointAt + 1);
  let total = 0;
  let current = 0;
  let seen = false;
  for (const token of whole) {
    if (token === 'and') continue;
    if (token in UNITS) current += UNITS[token]!;
    else if (token in TENS) current += TENS[token]!;
    else if (token === 'hundred') current = (current || 1) * 100;
    else if (token === 'thousand') { total += (current || 1) * 1000; current = 0; }
    else return null;
    seen = true;
  }
  if (!seen && !fraction.length) return null;
  const digits = fraction.map(token => UNITS[token]);
  if (digits.some(digit => digit === undefined || digit > 9)) return null;
  return `${total + current}${digits.length ? `.${digits.join('')}` : ''}`;
}

const HEBREW_NUMBERS: Record<string, number> = {
  אחד: 1, אחת: 1, שניים: 2, שתיים: 2, שני: 2, שתי: 2, שלושה: 3, שלוש: 3, ארבעה: 4, ארבע: 4, חמישה: 5, חמש: 5,
  שישה: 6, שש: 6, שבעה: 7, שבע: 7, שמונה: 8, תשעה: 9, תשע: 9, עשרה: 10, עשר: 10
};
const ARABIC_NUMBERS: Record<string, number> = {
  واحد: 1, اثنين: 2, اثنان: 2, ثلاثة: 3, ثلاث: 3, أربعة: 4, اربعة: 4, خمسة: 5, ستة: 6, سبعة: 7, ثمانية: 8, تسعة: 9, عشرة: 10
};
const hebrewWords = Object.keys(HEBREW_NUMBERS).join('|');
const arabicWords = Object.keys(ARABIC_NUMBERS).join('|');

export function normalizeSpokenRequest(text: string): string {
  let result = text.replace(/[٠-٩]/gu, digit => String(digit.charCodeAt(0) - 0x0660));
  // English: number words to digits ("a dozen" is left alone; the request validator understands it).
  result = result.replace(ENGLISH_NUMBER, match => englishNumber(match.split(/[\s-]+/u)) ?? match);
  // "3 percent" / "3 per cent" -> "3%"
  result = result.replace(/(\d+(?:\.\d+)?)\s*(?:percent|per\s+cent|pct)\b/giu, '$1%');
  // Hebrew: "שלושה אחוז" / "3 אחוזים" -> "3%"
  result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${hebrewWords}|\\d+(?:\\.\\d+)?)\\s*אחוז(?:ים)?(?!\\p{L})`, 'gu'),
    (_, value: string) => `${HEBREW_NUMBERS[value] ?? value}%`);
  // Arabic: "ثلاثة بالمئة" / "3 في المئة" -> "3%"
  result = result.replace(new RegExp(`(?<![\\p{L}\\p{N}])(${arabicWords}|\\d+(?:\\.\\d+)?)\\s*(?:بالمئة|بالمائة|في\\s+المئة|في\\s+المائة)(?!\\p{L})`, 'gu'),
    (_, value: string) => `${ARABIC_NUMBERS[value] ?? value}%`);
  return result.replace(/\s+/gu, ' ').trim();
}
