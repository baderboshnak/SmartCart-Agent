import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { runShoppingAgent } from '@/lib/agent/agent';
import type { AgentEvent } from '@/lib/agent/events';
import type { AgentModel } from '@/lib/agent/gemini';
import { getCart } from '@/lib/db/carts.repository';
import { collections } from '@/lib/db/mongodb';
import { createSession } from '@/lib/db/sessions.repository';
import { selectBasket } from '@/lib/shopping/optimizer';
import { toCartView } from '@/lib/shopping/cart-view';
import { STORES } from '../helpers/fixtures';
import { cartFromInstruction, createFakeMatcher, functionCallTurn, lastToolResponses, MATCHING_CODES, scriptedModel, textTurn } from '../helpers/fake-models';
import { createTestDatabase, databaseSkipReason, type TestDatabase } from '../helpers/test-db';

const REQUEST = 'I want 2 liters of 3% milk, preferably Tnuva, 12 eggs, 500 grams of bread, and 500 grams of shredded mozzarella';
const REQUEST_TEXT = '2 liters of 3% milk, preferably Tnuva, 12 eggs, 500 grams of bread, and 500 grams of shredded mozzarella';
const MILK = {
  sourceText: '2 liters of 3% milk, preferably Tnuva', product: 'milk', coreSearchTerm: 'חלב', quantity: { amount: 2, unit: 'l' },
  constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' }, { type: 'PREFERENCE', kind: 'BRAND', sourceText: 'Tnuva' }]
};
const ITEMS = [
  MILK,
  { sourceText: '12 eggs', product: 'eggs', coreSearchTerm: 'ביצים', quantity: { amount: 12, unit: 'units' } },
  { sourceText: '500 grams of bread', product: 'bread', coreSearchTerm: 'לחם', quantity: { amount: 500, unit: 'g' } },
  { sourceText: '500 grams of shredded mozzarella', product: 'mozzarella', coreSearchTerm: 'מוצרלה', quantity: { amount: 500, unit: 'g' },
    constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: 'shredded' }] }
];

describe('agent end to end with MongoDB and a scripted Gemini', { skip: databaseSkipReason }, () => {
  let testDb: TestDatabase;
  const matcher = createFakeMatcher();
  before(async () => { testDb = await createTestDatabase({ seed: true }); });
  after(async () => { await testDb?.cleanup(); });

  async function send(sessionId: string, message: string, model: AgentModel) {
    const events: AgentEvent[] = [];
    const result = await runShoppingAgent({
      db: testDb.db, sessionId, message, model, matcher: { callModel: matcher.callModel, model: 'fake-matcher' },
      emit: event => events.push(event), signal: new AbortController().signal, limits: { retryDelayMs: 5 }
    });
    return { result, events, cart: (await getCart(testDb.db, sessionId))! };
  }

  test('builds, verifies and saves a multi-item cart, then follows up conversationally (27)', async () => {
    const { session } = await createSession(testDb.db);

    // 1. Extract items; the first attempt drops "3%" and is rejected by deterministic validation.
    const build = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'add_items', requestText: REQUEST_TEXT, items: [{ ...MILK, constraintEvidence: [MILK.constraintEvidence[1]] }, ...ITEMS.slice(1)] }] } }]),
      request => {
        assert.match(String(lastToolResponses(request)[0]!.response.error), /3%/u);
        return functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'add_items', requestText: REQUEST_TEXT, items: ITEMS }] } }]);
      },
      request => {
        assert.equal(lastToolResponses(request)[0]!.response.ok, true);
        return functionCallTurn([{ name: 'optimizeBasket', args: {} }]);
      },
      request => {
        const result = lastToolResponses(request)[0]!.response.result as { recommended: { store: string; totalIls: number } };
        return textTurn(`${result.recommended.store}: ₪${result.recommended.totalIls}`);
      }
    ]);
    const first = await send(session._id, REQUEST, build);
    assert.equal(first.result.status, 'completed');
    assert.equal(first.result.message.content, 'Rami Levy · store 039: ₪67.26');
    assert.equal(first.cart.items.length, 4);
    assert.deepEqual(first.cart.items[0]!.requirements, ['3%']);
    assert.deepEqual(first.cart.items[0]!.preferences, ['Tnuva']);
    assert.equal(first.cart.calculation?.status, 'COMPLETE');
    assert.equal(first.cart.calculation?.verification.passed, true);
    assert.equal(first.cart.calculation?.itemsVersion, first.cart.itemsVersion);
    const basket = selectBasket(first.cart).basket!;
    assert.equal(basket.storeKey, STORES.ramiLevy);
    assert.equal(basket.totalPriceIls, 67.26);
    assert.ok(first.events.some(event => event.type === 'tool.progress'), 'real matching progress is streamed');
    assert.deepEqual(first.events.filter(event => event.type === 'tool.started').map(event => event.type === 'tool.started' && event.tool), ['updateCart', 'updateCart', 'optimizeBasket']);
    assert.ok(first.events.some(event => event.type === 'cart.updated' && event.cart.status === 'COMPLETE'));
    assert.equal(first.events.at(-1)?.type, 'agent.completed');
    const matcherCallsAfterBuild = matcher.stats.calls;
    assert.ok(matcherCallsAfterBuild > 0);

    // 2. "Make it cheaper": the mode changes, every requirement stays, matching is fully cached.
    const cheaper = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'set_mode', mode: 'cheapest', userQuote: 'Make it cheaper' }] } }]),
      functionCallTurn([{ name: 'optimizeBasket', args: {} }]),
      request => textTurn(`Cheapest: ₪${(lastToolResponses(request)[0]!.response.result as { recommended: { totalIls: number } }).recommended.totalIls}`)
    ]);
    const second = await send(session._id, 'Make it cheaper', cheaper);
    assert.equal(second.cart.mode, 'cheapest');
    assert.deepEqual(second.cart.items[0]!.requirements, ['3%']);
    const cheapest = selectBasket(second.cart).basket!;
    assert.ok(cheapest.totalPriceIls <= basket.totalPriceIls);
    assert.equal(cheapest.totalPriceIls, Math.min(...second.cart.calculation!.result.storeComparisons.map(store => store.cheapest.totalPriceIls)));
    assert.equal(matcher.stats.calls, matcherCallsAfterBuild, 'unchanged items reuse cached decisions');

    // 3. "Only Tnuva milk": Tnuva becomes mandatory and 3% is kept.
    const onlyTnuva = scriptedModel([
      request => {
        const milk = cartFromInstruction(request).items.find(item => item.product === 'milk')!;
        return functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'set_constraints', itemId: milk.itemId, userQuote: 'Only Tnuva milk', constraints: [{ value: '3%', type: 'REQUIREMENT' }, { value: 'Tnuva', type: 'REQUIREMENT', kind: 'BRAND' }] }] } }]);
      },
      functionCallTurn([{ name: 'optimizeBasket', args: {} }]),
      textTurn('Switched to Tnuva milk only.')
    ]);
    const third = await send(session._id, 'Only Tnuva milk', onlyTnuva);
    const milkItem = third.cart.items.find(item => item.product === 'milk')!;
    assert.deepEqual(milkItem.requirements, ['3%', 'Tnuva']);
    assert.deepEqual(milkItem.preferences, []);
    const milkLine = selectBasket(third.cart).basket!.items.find(line => line.item === 'milk')!;
    for (const product of milkLine.products) {
      assert.deepEqual(product.requirementChecks.map(check => [check.requirement, check.result]), [['3%', 'MET'], ['Tnuva', 'MET']]);
    }

    // 4. "Remove eggs" without recalculating: the backend recalculates and verifies before answering.
    const removeEggs = scriptedModel([
      request => {
        const eggs = cartFromInstruction(request).items.find(item => item.product === 'eggs')!;
        return functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'remove_items', itemIds: [eggs.itemId], userQuote: 'Remove eggs' }] } }]);
      },
      textTurn('Removed the eggs.'),
      request => {
        assert.match(String(request.contents.at(-1)?.parts?.[0]?.text), /SYSTEM NOTE/u);
        return textTurn('Removed the eggs. Your verified cart now has 3 items.');
      }
    ]);
    const fourth = await send(session._id, 'Remove eggs', removeEggs);
    assert.equal(fourth.cart.items.length, 3);
    assert.ok(!fourth.cart.items.some(item => item.product === 'eggs'));
    assert.equal(fourth.cart.calculation?.itemsVersion, fourth.cart.itemsVersion, 'the saved calculation is current');
    assert.equal(selectBasket(fourth.cart).basket?.items.length, 3);
    assert.ok(fourth.events.some(event => event.type === 'tool.started' && event.label === 'Verifying your final cart'));
    assert.equal(fourth.result.message.content, 'Removed the eggs. Your verified cart now has 3 items.');

    // 26. The conversation and run metadata are persisted.
    const stored = await collections.sessions(testDb.db).findOne({ _id: session._id });
    assert.deepEqual(stored?.messages.map(entry => entry.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    assert.equal(stored?.activeRun, null, 'the run lock is released');
    const runs = await collections.agentRuns(testDb.db).find({ sessionId: session._id }).sort({ startedAt: 1 }).toArray();
    assert.equal(runs.length, 4);
    assert.ok(runs.every(run => run.status === 'completed' && run.durationMs !== null && run.tokenUsage.totalTokens > 0));
    assert.ok(runs[0]!.toolCalls.some(call => call.name === 'updateCart' && call.status === 'error'), 'the rejected extraction is recorded');
  });

  test('30. a recipe request becomes a validated ingredient plan and a priced cart', async () => {
    const recipeMatcher = createFakeMatcher({
      identity: (product, candidate) => ({
        'wheat flour': /^קמח (?:לבן|ארוז)/u,
        'dry yeast': /^שמרי/u,
        'tomato sauce': /^רוטב עגבניות/u,
        mozzarella: /מוצרלה/u
      } as Record<string, RegExp>)[product]?.test(candidate.name) === true &&
        (product !== 'mozzarella' || MATCHING_CODES.mozzarella!.has(candidate.id.split(':').at(-1)!))
    });
    const { session } = await createSession(testDb.db);
    const model = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'add_recipe', requestText: 'make pizza for 4 people', recipe: {
        dish: 'pizza', servings: 4, servingsSource: 'EXPLICIT',
        ingredients: [
          { name: 'wheat flour', coreSearchTerm: 'קמח', quantity: { amount: 500, unit: 'g' } },
          { name: 'dry yeast', coreSearchTerm: 'שמרים', quantity: { amount: 0, unit: 'unspecified' } },
          { name: 'tomato sauce', coreSearchTerm: 'רוטב עגבניות', quantity: { amount: 220, unit: 'g' } },
          { name: 'mozzarella', coreSearchTerm: 'מוצרלה', quantity: { amount: 400, unit: 'g' } },
          { name: 'fresh basil', coreSearchTerm: 'בזיליקום', quantity: { amount: 0, unit: 'unspecified' }, optional: true }
        ]
      } }] } }]),
      functionCallTurn([{ name: 'optimizeBasket', args: {} }]),
      textTurn('Here is your pizza shopping list.')
    ]);
    const events: AgentEvent[] = [];
    await runShoppingAgent({
      db: testDb.db, sessionId: session._id, message: 'I want to make pizza for 4 people', model,
      matcher: { callModel: recipeMatcher.callModel, model: 'fake-recipe-matcher' }, emit: event => events.push(event), signal: new AbortController().signal
    });
    const cart = (await getCart(testDb.db, session._id))!;
    assert.equal(cart.recipePlans.length, 1);
    assert.equal(cart.recipePlans[0]!.servings, 4);
    assert.equal(cart.items.length, 4, 'the optional basil is listed but not added');
    assert.ok(cart.items.every(item => item.origin.type === 'RECIPE'));
    assert.equal(cart.calculation?.status, 'COMPLETE');
    assert.equal(cart.calculation?.verification.passed, true);
    const view = toCartView(cart);
    assert.equal(view.recipePlans[0]!.ingredients.find(ingredient => ingredient.name === 'fresh basil')?.optional, true);
    assert.equal(view.basket?.lines.length, 4);
  });

  test('asks a clarifying question, stores it, and treats the next message as the answer', async () => {
    const { session } = await createSession(testDb.db);
    const ask = scriptedModel([functionCallTurn([{ name: 'requestClarification', args: { question: 'Should the cake be chocolate or vanilla?', options: ['Chocolate', 'Vanilla'] } }])]);
    const { result, events } = await send(session._id, 'I want to bake a cake', ask);
    assert.equal(result.message.kind, 'clarification');
    assert.deepEqual(result.message.options, ['Chocolate', 'Vanilla']);
    assert.ok(events.some(event => event.type === 'clarification.required'));
    assert.equal((await collections.sessions(testDb.db).findOne({ _id: session._id }))?.pendingClarification?.question, 'Should the cake be chocolate or vanilla?');

    const answer = scriptedModel([request => {
      assert.match(request.systemInstruction, /Should the cake be chocolate or vanilla\?/u);
      assert.equal(request.contents.at(-1)?.parts?.[0]?.text, 'Chocolate');
      return textTurn('Great, chocolate it is.');
    }]);
    await send(session._id, 'Chocolate', answer);
    assert.equal((await collections.sessions(testDb.db).findOne({ _id: session._id }))?.pendingClarification, null);
  });

  test('a vague request ("something tasty with chocolate") adds the clear item, asks with options and checks no products', async () => {
    const { session } = await createSession(testDb.db);
    const message = 'I want 2 bottles of milk and something tasty with chocolate';
    const milk = { sourceText: '2 bottles of milk', product: 'milk', coreSearchTerm: 'חלב', quantity: { amount: 2, unit: 'bottle' } };
    const vague = { sourceText: 'something tasty with chocolate', product: 'chocolate', coreSearchTerm: 'שוקולד', quantity: { amount: 0, unit: 'unspecified' } };
    const options = ['Chocolate bar', 'Chocolate spread', 'Chocolate cookies', 'Chocolate milk'];
    const checksBefore = matcher.stats.calls;
    const model = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'add_items', requestText: '2 bottles of milk and something tasty with chocolate', items: [milk, vague] }] } }]),
      request => {
        assert.match(JSON.stringify(lastToolResponses(request)[0]?.response), /not a specific product/u, 'the vague item is refused');
        return functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'add_items', requestText: '2 bottles of milk', items: [milk] }] } }]);
      },
      functionCallTurn([{ name: 'requestClarification', args: { question: 'What kind of chocolate treat would you like?', options } }])
    ]);
    const { result, events, cart } = await send(session._id, message, model);
    assert.equal(result.message.kind, 'clarification');
    assert.deepEqual(result.message.options, options);
    assert.deepEqual(cart.items.map(item => item.product), ['milk']);
    assert.equal(cart.calculation, null, 'nothing is priced before the answer');
    assert.equal(matcher.stats.calls, checksBefore, 'no products were checked');
    assert.ok(!events.some(event => event.type === 'tool.started' && event.tool === 'optimizeBasket'), 'no basket search ran');
  });

  test('a spoken request is stored as voice and reported back with the text the agent used', async () => {
    const { session } = await createSession(testDb.db);
    const events: AgentEvent[] = [];
    await runShoppingAgent({
      db: testDb.db, sessionId: session._id, message: 'Do you have oat milk?', via: 'voice',
      model: scriptedModel([textTurn('Let me check.')]), matcher: { callModel: matcher.callModel, model: 'fake-matcher' },
      emit: event => events.push(event), signal: new AbortController().signal
    });
    const started = events.find(event => event.type === 'agent.started');
    assert.equal(started?.type === 'agent.started' && started.userText, 'Do you have oat milk?');
    const stored = await collections.sessions(testDb.db).findOne({ _id: session._id });
    assert.equal(stored?.messages[0]?.via, 'voice');
    assert.equal(stored?.messages[1]?.via, undefined, 'the answer is a normal assistant message');
  });

  test('replies in the language of the customer\'s words, or of their earlier messages when a message has none', async () => {
    const { session } = await createSession(testDb.db);
    const hebrew = scriptedModel([textTurn('בודק')]);
    await send(session._id, 'יש לכם חלב שיבולת שועל?', hebrew);
    assert.match(hebrew.requests[0]!.systemInstruction, /# Reply language: Hebrew\n/u);

    const noWords = scriptedModel([textTurn('')]);
    const { result } = await send(session._id, '2', noWords);
    assert.match(noWords.requests[0]!.systemInstruction, /# Reply language: Hebrew\n/u, 'keeps the conversation\'s language');
    // Nothing was added, so the backup answer says it did not understand rather than "your cart is empty".
    assert.equal(result.message.content, 'מצטער, לא הבנתי. מה תרצו לקנות?', 'the backup answer is in Hebrew too');
  });

  test('a spoken request answered after the backend recalculates stays in the language the voice model heard', async () => {
    const { session } = await createSession(testDb.db);
    const model = scriptedModel([
      functionCallTurn([{ name: 'updateCart', args: { operations: [{ op: 'add_items', requestText: REQUEST_TEXT, items: ITEMS }] } }]),
      textTurn('Added.'),
      request => {
        assert.match(request.systemInstruction, /# Reply language: Hebrew\n/u);
        assert.match(String(request.contents.at(-1)?.parts?.[0]?.text), /^SYSTEM NOTE: .*written in Hebrew\.$/su, 'the last turn the model sees repeats the language');
        return textTurn('');
      }
    ]);
    const result = await runShoppingAgent({
      db: testDb.db, sessionId: session._id, message: REQUEST, via: 'voice', language: 'he', model,
      matcher: { callModel: matcher.callModel, model: 'fake-matcher' }, emit: () => {}, signal: new AbortController().signal, limits: { retryDelayMs: 5 }
    });
    assert.equal(model.requests.length, 3, 'the backend asked for a final answer after recalculating');
    const lines = result.message.content.split('\n');
    assert.match(lines[0]!, /: ₪67\.26 עבור 4 פריטים, עמידה בהעדפות: \d\/\d\.$/u, 'the backup summary is in Hebrew');
    assert.equal(lines.at(-1), 'המחירים לקוחים מתמונת מצב של הקטלוג, ולא מהקופה בזמן אמת.');
  });

  test('model failures end the run with a clear error and an unlocked session', async () => {
    const { session } = await createSession(testDb.db);
    const broken: AgentModel = { name: 'broken', generate: async () => { throw new Error('API key not valid. Please pass a valid API key.'); } };
    const { result, events } = await send(session._id, 'I want milk', broken);
    assert.equal(result.status, 'failed');
    assert.equal(result.message.kind, 'error');
    assert.ok(events.some(event => event.type === 'agent.failed'));
    const stored = await collections.sessions(testDb.db).findOne({ _id: session._id });
    assert.equal(stored?.activeRun, null);
    assert.equal(stored?.messages.at(-1)?.kind, 'error');
    await assert.rejects(runShoppingAgent({
      db: testDb.db, sessionId: session._id, message: ' ', model: broken, matcher: { callModel: null, model: 'x' }, emit: () => {}, signal: new AbortController().signal
    }), /Type a message/u);
  });
});
