import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runShoppingAgent } from '@/lib/agent/agent';
import type { AgentEvent } from '@/lib/agent/events';
import { getCart, getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { createSession } from '@/lib/db/sessions.repository';
import { fixtureDb } from '../evaluation/fixture-db';
import { fixtureCatalog } from '../evaluation/scenario-data';
import { cartItem } from '../helpers/fixtures';
import { createFakeMatcher, functionCallTurn, lastToolResponses, scriptedModel, textTurn } from '../helpers/fake-models';

const drinksRequest = 'תוסיף שתייה להופעה עבור 10 אנשים, זה לא משנה איזה.';
const guessedDrinks = { name: 'addItems', args: { requestText: drinksRequest, items: [{
  sourceText: 'שתייה להופעה עבור 10 אנשים, זה לא משנה איזה.', product: 'שתייה', coreSearchTerm: 'שתייה קלה',
  quantity: { amount: 10, unit: 'bottle' }
}] } };

async function shoppingFixture(term?: string) {
  const { db } = fixtureDb(term ? fixtureCatalog().filter(offer => offer.name.startsWith(term + ' ')) : []);
  const { session } = await createSession(db);
  const events: AgentEvent[] = [];
  const matcher = createFakeMatcher({ identity: (product, candidate) => candidate.name.startsWith(product + ' ') });
  return {
    db, session, events,
    async send(message: string, model: ReturnType<typeof scriptedModel>) {
      const result = await runShoppingAgent({ db, sessionId: session._id, message, model,
        matcher: { callModel: matcher.callModel, model: 'fixture-matcher' },
        emit: event => events.push(event), signal: new AbortController().signal });
      return { result, cart: (await getCart(db, session._id))! };
    }
  };
}

test('a rejected direct purchase can recover through the existing shopping planner', async () => {
  const fixture = await shoppingFixture('מים');
  const model = scriptedModel([
    request => {
      assert.match(request.systemInstruction, /Shopping plans \(addRecipe\)/u);
      assert.match(request.tools.find(tool => tool.name === 'addRecipe')?.description ?? '', /occasion or delegated shopping choice/u);
      return functionCallTurn([guessedDrinks]);
    },
    request => {
      const [{ response }] = lastToolResponses(request);
      assert.equal(response.ok, false);
      assert.match(String(response.error), /switch to addRecipe/u);
      return functionCallTurn([{ name: 'addRecipe', args: {
        requestText: drinksRequest,
        recipe: { dish: 'שתייה להופעה', servings: 10, servingsSource: 'EXPLICIT', notes: 'הערכה של חצי ליטר לאדם.',
          ingredients: [{ name: 'מים', coreSearchTerm: 'מים', quantity: { amount: 5, unit: 'l' } }] }
      } }]);
    },
    () => functionCallTurn([{ name: 'optimizeBasket', args: {} }]),
    textTurn('הוספתי מים לתוכנית ל-10 אנשים. הכמות מבוססת על חצי ליטר לאדם.')
  ]);
  const { cart, result } = await fixture.send(drinksRequest, model);
  assert.equal(result.status, 'completed');
  assert.equal(cart.recipePlans[0]!.servings, 10);
  assert.equal(cart.items.length, 1);
  assert.deepEqual(cart.items[0]!.quantity, { amount: 5, unit: 'l' });
  assert.equal(cart.calculation?.status, 'COMPLETE');
  assert.equal(cart.calculation?.verification.passed, true);
});

test('planning for a group keeps the guest count, grocery quantity, and budget separate', async () => {
  const fixture = await shoppingFixture('קרקרים');
  const requestText = 'Choose snacks for 8 people under ₪60.';
  const model = scriptedModel([
    functionCallTurn([
      { name: 'setBudget', args: { userQuote: 'under ₪60', budgetIls: 60, budgetExclusive: true } },
      { name: 'addRecipe', args: { requestText: 'Choose snacks for 8 people', recipe: {
        dish: 'Snacks for the group', servings: 8, servingsSource: 'EXPLICIT', notes: 'About 60 g of crackers per person.',
        ingredients: [{ name: 'קרקרים', coreSearchTerm: 'קרקרים', quantity: { amount: 500, unit: 'g' } }]
      } } }
    ]),
    request => {
      assert.deepEqual(lastToolResponses(request).map(entry => entry.response.ok), [true, true]);
      return functionCallTurn([{ name: 'optimizeBasket', args: {} }]);
    },
    textTurn('The snack plan is for eight people. I estimated about 60 grams of crackers per person.')
  ]);
  const { cart } = await fixture.send(requestText, model);
  assert.equal(cart.recipePlans[0]!.servings, 8);
  assert.deepEqual(cart.budget, { amountIls: 60, exclusive: true });
  assert.deepEqual(cart.items[0]!.quantity, { amount: 500, unit: 'g' });
  assert.equal(cart.calculation?.status, 'COMPLETE');
  assert.equal(cart.calculation?.verification.passed, true);
});

test('repeated rejected additions stop and preserve the earlier cart', async () => {
  const fixture = await shoppingFixture();
  const initial = await getOrCreateCart(fixture.db, fixture.session._id);
  const saved = await saveCart(fixture.db, fixture.session._id, initial.revision, mutableFields({ ...initial,
    items: [cartItem({ product: 'ביסלי', searchTerms: ['ביסלי'], quantity: { amount: 0, unit: 'unspecified' } })] }));
  const model = scriptedModel([
    functionCallTurn([guessedDrinks]),
    functionCallTurn([guessedDrinks]),
    request => {
      assert.match(String(lastToolResponses(request)[0]!.response.error), /disabled for this request/u);
      assert.ok(request.tools.some(tool => tool.name === 'addRecipe'));
      assert.ok(request.tools.every(tool => tool.name !== 'addItems'));
      return functionCallTurn([guessedDrinks]);
    }
  ]);
  const { cart, result } = await fixture.send(drinksRequest, model);
  assert.equal(result.status, 'limit_reached');
  assert.match(result.message.content, /לא הצלחתי להוסיף/u);
  assert.deepEqual(fixture.events.filter(event => event.type === 'tool.started').map(event => event.tool), ['addItems', 'addItems']);
  assert.equal(cart.revision, saved.revision);
  assert.deepEqual(cart.items.map(item => item.product), ['ביסלי']);
});
