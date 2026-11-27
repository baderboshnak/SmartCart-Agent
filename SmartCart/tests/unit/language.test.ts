import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { fallbackSummary } from '@/lib/agent/agent';
import { buildSystemInstruction } from '@/lib/agent/prompts';
import { conversationLanguage, detectLanguage, LANGUAGES, parseLanguage } from '@/lib/i18n/language';
import type { Cart } from '@/lib/shared/types';
import { cartItem } from '../helpers/fixtures';

function emptyCart(): Cart {
  const now = new Date('2026-11-19T10:00:00Z');
  return { _id: 'cart_x', sessionId: 's', revision: 3, itemsVersion: 5, mode: 'balanced', maxPremiumPct: 15, budget: null, items: [], recipePlans: [], selectedStoreKey: null, calculation: null, createdAt: now, updatedAt: now, expiresAt: now };
}

describe('the customer\'s language comes from their words', () => {
  test('most words decide; brands, units and numbers inside a sentence do not', () => {
    assert.equal(detectLanguage('אני רוצה 2 ליטר חלב 3% של Tnuva'), 'he');
    assert.equal(detectLanguage('2 ק"ג עגבניות ו-500 ml שמנת'), 'he');
    assert.equal(detectLanguage('I want 2 liters of 3% milk, preferably Tnuva'), 'en');
    assert.equal(detectLanguage('add קוטג׳ please'), 'en');
    assert.equal(detectLanguage('بدي 2 لتر حليب 3% من Tnuva'), 'ar');
    assert.equal(detectLanguage('שָׁלוֹם'), 'he', 'vowel points stay part of the word');
  });

  test('a tie goes to the language that comes first; text without words has none', () => {
    assert.equal(detectLanguage('I want חלב תנובה'), 'en');
    assert.equal(detectLanguage('חלב תנובה please now'), 'he');
    for (const text of ['', '2', '3%', '👍', '...']) assert.equal(detectLanguage(text), null, text);
  });

  test('the conversation\'s language is the customer\'s latest message with words', () => {
    assert.equal(conversationLanguage([
      { role: 'user', content: 'אני רוצה חלב' },
      { role: 'user', content: 'I want milk' },
      { role: 'assistant', content: 'בטח, הוספתי חלב' },
      { role: 'user', content: '2' }
    ]), 'en');
    assert.equal(conversationLanguage([{ role: 'assistant', content: 'שלום' }]), null, 'only the customer\'s messages count');
    assert.equal(conversationLanguage([]), null);
  });

  test('the voice model\'s language names and codes are understood; anything else is ignored', () => {
    assert.equal(parseLanguage('Hebrew'), 'he');
    assert.equal(parseLanguage(' hebrew '), 'he');
    assert.equal(parseLanguage('he-IL'), 'he');
    assert.equal(parseLanguage('ar'), 'ar');
    assert.equal(parseLanguage('English'), 'en');
    for (const value of ['French', 'heb', '', 42, null, undefined]) assert.equal(parseLanguage(value), null, String(value));
  });
});

describe('the agent replies in the customer\'s language', () => {
  test('the system instruction names the reply language after the cart data', () => {
    const instruction = buildSystemInstruction({ cart: emptyCart(), stores: [], today: '2026-11-25', pendingClarification: null, language: 'he' });
    assert.match(instruction, /# Reply language: Hebrew\nThe customer is writing in Hebrew\. Write your whole reply in Hebrew/u);
    assert.ok(instruction.indexOf('# Reply language') > instruction.indexOf('# Current cart'), 'not buried before the large cart JSON');
    assert.doesNotMatch(instruction, /English by default/u);
    assert.match(buildSystemInstruction({ cart: emptyCart(), stores: [], today: '2026-11-25', pendingClarification: null, language: 'ar' }), /# Reply language: Arabic\n/u);
  });

  test('the answer used when the model gives none is written in that language', () => {
    const stale: Cart = { ...emptyCart(), items: [cartItem({ product: 'milk', searchTerms: ['חלב'], quantity: { amount: 1, unit: 'l' } })] };
    for (const language of LANGUAGES) {
      assert.equal(detectLanguage(fallbackSummary(emptyCart(), language)), language, `empty cart in ${language}`);
      assert.equal(detectLanguage(fallbackSummary(stale, language)), language, `uncalculated cart in ${language}`);
    }
    assert.equal(fallbackSummary(emptyCart()), 'Your cart is empty. Tell me what you would like to buy.', 'English stays the default');
    assert.equal(fallbackSummary(emptyCart(), 'he'), 'העגלה שלך ריקה. ספרו לי מה תרצו לקנות.');
  });
});
