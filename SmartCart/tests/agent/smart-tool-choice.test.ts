import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runShoppingAgent } from '@/lib/agent/agent';
import type { AgentEvent } from '@/lib/agent/events';
import { getCart, getOrCreateCart, mutableFields, saveCart } from '@/lib/db/carts.repository';
import { createSession } from '@/lib/db/sessions.repository';
import type { RecipePlan } from '@/lib/shared/types';
import { fixtureDb } from '../evaluation/fixture-db';
import { fixtureCatalog } from '../evaluation/scenario-data';
import { cartItem } from '../helpers/fixtures';
import { createFakeMatcher, functionCallTurn, lastToolResponses, scriptedModel, textTurn } from '../helpers/fake-models';

const partyTitle = 'מסיבה עם חטיפים ושתייה קלה';
const partyPlanId = 'rcp_party';
const correction = 'המסיבה היא ל-10 אנשים';
const products = ['קרקרים', 'מים'];

async function fixture() {
  const { db } = fixtureDb(fixtureCatalog().filter(offer => products.some(product => offer.name.startsWith(`${product} `))));
  const { session } = await createSession(db);
  const initial = await getOrCreateCart(db, session._id);
  const unrelated = cartItem({ id: 'itm_direct', product: 'קרקרים', searchTerms: ['קרקרים'], quantity: { amount: 1, unit: 'pack' } });
  const planItems = products.map((product, index) => cartItem({
    id: `itm_party_${index}`, product, searchTerms: [product], quantity: { amount: 2, unit: 'pack' },
    origin: { type: 'RECIPE', recipePlanId: partyPlanId, dish: partyTitle }
  }));
  const plan: RecipePlan = {
    id: partyPlanId, dish: partyTitle, servings: 6, servingsSource: 'ASSUMED', requestText: 'אני רוצה חטיפים ושתייה קלה',
    createdAt: initial.createdAt, notes: 'An estimate for six people.',
    ingredients: planItems.map(item => ({ name: item.product, quantity: item.quantity, itemId: item.id, optional: false }))
  };
  const saved = await saveCart(db, session._id, initial.revision, mutableFields({ ...initial,
    items: [unrelated, ...planItems], recipePlans: [plan] }));
  const matcher = createFakeMatcher({ identity: (product, candidate) => candidate.name.startsWith(`${product} `) });

  return {
    saved, unrelated, planItems,
    async send(message: string, model: ReturnType<typeof scriptedModel>) {
      const events: AgentEvent[] = [];
      const result = await runShoppingAgent({ db, sessionId: session._id, message, model,
        matcher: { callModel: matcher.callModel, model: 'fixture-matcher' },
        emit: event => events.push(event), signal: new AbortController().signal });
      const cart = await getCart(db, session._id);
      assert.ok(cart);
      return { result, cart, started: events.filter(event => event.type === 'tool.started').map(event => event.tool) };
    }
  };
}

function addPlan(requestText: string, servings: number, dish = partyTitle) {
  return functionCallTurn([{ name: 'addRecipe', args: { requestText, recipe: {
    dish, servings, servingsSource: 'EXPLICIT',
    ingredients: products.map(name => ({ name, coreSearchTerm: name, quantity: { amount: 4, unit: 'pack' } }))
  } } }]);
}

test('a party correction resizes the saved plan and keeps the separate purchase', async () => {
  const shopping = await fixture();
  const resized = shopping.planItems.map((item, index) => ({ ...item, quantity: { amount: 3 + index, unit: 'pack' } }));
  const model = scriptedModel([
    request => {
      assert.ok(request.systemInstruction.includes(partyPlanId));
      assert.ok(request.tools.some(tool => tool.name === 'resizeShoppingPlan'));
      return addPlan(correction, 10, 'חטיפים ושתייה למסיבה');
    },
    request => {
      const [rejection] = lastToolResponses(request);
      assert.equal(rejection?.response.ok, false);
      assert.match(String(rejection?.response.error), /resizeShoppingPlan/u);
      return functionCallTurn([{ name: 'resizeShoppingPlan', args: {
        planId: partyPlanId, servings: 10, userQuote: correction,
        quantities: resized.map(item => ({ itemId: item.id, quantity: item.quantity })).reverse()
      } }]);
    },
    request => {
      assert.equal(lastToolResponses(request)[0]?.response.ok, true);
      return functionCallTurn([{ name: 'optimizeBasket', args: {} }]);
    },
    textTurn('עדכנתי את התוכנית הקיימת למסיבה של עשרה אנשים.')
  ]);

  const { cart, result, started } = await shopping.send(correction, model);
  assert.equal(result.status, 'completed', result.message.content);
  assert.deepEqual(started, ['addRecipe', 'resizeShoppingPlan', 'optimizeBasket']);
  assert.equal(cart.recipePlans.length, 1);
  assert.equal(cart.recipePlans[0]?.id, partyPlanId);
  assert.equal(cart.recipePlans[0]?.servings, 10);
  assert.equal(cart.recipePlans[0]?.servingsSource, 'EXPLICIT');
  assert.deepEqual(cart.items, [shopping.unrelated, ...resized]);
  assert.deepEqual(cart.recipePlans[0]?.ingredients.map(item => [item.itemId, item.quantity.amount]),
    resized.map(item => [item.id, item.quantity.amount]));
  assert.equal(cart.calculation?.verification.passed, true);
});

test('a resize with an unrelated item leaves the original plan intact and reports the failure', async () => {
  const shopping = await fixture();
  const model = scriptedModel([
    functionCallTurn([{ name: 'resizeShoppingPlan', args: {
      planId: partyPlanId, servings: 10, userQuote: correction,
      quantities: [shopping.planItems[0]!, shopping.unrelated].map(item => ({
        itemId: item.id, quantity: { amount: 4, unit: 'pack' }
      }))
    } }]),
    request => {
      assert.equal(lastToolResponses(request)[0]?.response.ok, false);
      return textTurn('עדכנתי את התוכנית הקיימת למסיבה של עשרה אנשים.');
    }
  ]);

  const { cart, result, started } = await shopping.send(correction, model);
  assert.equal(result.status, 'completed', result.message.content);
  assert.match(result.message.content, /הכמויות בעגלה נשארו כמו שהיו/u);
  assert.deepEqual(started, ['resizeShoppingPlan']);
  assert.deepEqual(cart, shopping.saved);
});

test('an explicit request for a separate party plan keeps both plans', async () => {
  const shopping = await fixture();
  const request = 'Make a separate plan for another party for 10 people.';
  const model = scriptedModel([
    addPlan(request, 10),
    view => {
      assert.equal(lastToolResponses(view)[0]?.response.ok, true);
      return functionCallTurn([{ name: 'optimizeBasket', args: {} }]);
    },
    textTurn('I prepared a separate plan for ten people.')
  ]);

  const { cart, result } = await shopping.send(request, model);
  assert.equal(result.status, 'completed', result.message.content);
  assert.deepEqual(cart.recipePlans.map(plan => plan.servings), [6, 10]);
  assert.deepEqual(cart.recipePlans[0], shopping.saved.recipePlans[0]);
  assert.notEqual(cart.recipePlans[1]?.id, partyPlanId);
  assert.deepEqual(cart.items.slice(0, 3), shopping.saved.items);
  assert.equal(cart.items.length, 5);
});

test('a greeting and a cart question leave an unpriced cart untouched', async () => {
  const shopping = await fixture();
  for (const [message, reply] of [
    ['Thanks.', 'You’re welcome!'],
    ['What is in my cart?', 'Your cart contains crackers and water.']
  ] as const) {
    const model = scriptedModel([textTurn(reply)]);
    const { cart, result, started } = await shopping.send(message, model);
    assert.equal(result.message.content, reply);
    assert.equal(model.requests.length, 1);
    assert.deepEqual(started, []);
    assert.equal(cart.revision, shopping.saved.revision);
    assert.equal(cart.calculation, null);
  }
});

test('an ambiguous item reference can be clarified without changing the cart', async () => {
  const shopping = await fixture();
  const question = 'Which item should I remove?';
  const model = scriptedModel([functionCallTurn([{ name: 'requestClarification', args: { question, options: ['Crackers', 'Water'] } }])]);

  const { cart, result, started } = await shopping.send('Remove that one.', model);
  assert.equal(result.status, 'clarification');
  assert.equal(result.message.content, question);
  assert.deepEqual(started, ['requestClarification']);
  assert.equal(cart.revision, shopping.saved.revision);
  assert.deepEqual(cart.items, shopping.saved.items);
});
