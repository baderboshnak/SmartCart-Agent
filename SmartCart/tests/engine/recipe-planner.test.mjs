import assert from 'node:assert/strict';
import test from 'node:test';
import { assertShoppingPlanCoverage, understandShoppingRequest } from '../../engine/smartcart-llm.mjs';
import { assertRecipeShoppingPlan, planRecipeRequest, recognizeRequestIntent } from '../../engine/smartcart-recipe-planner.mjs';
import { buildCatalog, searchCatalog } from '../../engine/smartcart-search.mjs';
import { matchProducts } from '../../engine/smartcart-matcher.mjs';
import { buildQuantityPriceOptions } from '../../engine/smartcart-quantity-price.mjs';
import { optimizeBaskets } from '../../engine/smartcart-basket-optimizer.mjs';
import { createItemContext } from '../../engine/smartcart-pipeline-context.mjs';

const noModel = () => assert.fail('This recipe request should use the deterministic local templates.');
const recipe = text => planRecipeRequest(text, { parseShoppingRequest: noModel });
const findIngredient = (planned, key) => planned.ingredients.find(ingredient => ingredient.ingredientId === key);
const findPurchase = (plan, key) => plan.items.find(ingredient => ingredient.ingredientId === key);
const assertReady = plan => {
  assert.equal(plan.status, 'READY');
  assert.equal(plan.provenance.kind, 'LOCAL_TEMPLATE_ESTIMATE');
  assertRecipeShoppingPlan(JSON.parse(JSON.stringify(plan)), assertShoppingPlanCoverage);
};
const assertClarification = (plan, phrase) => {
  assert.equal(plan.status, 'NEEDS_CLARIFICATION');
  assert.deepEqual(plan.items, []);
  assert.match(plan.questions.join(' '), phrase);
};

function stubMilk({ flavored = true, amount = 2 } = {}) {
  return {
    product: 'milk', coreSearchTerm: 'חלב', searchTerms: ['חלב'],
    sourceText: `${amount} liters of ${flavored ? '3% ' : ''}milk`,
    constraintEvidence: flavored
      ? [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: '3%' }] : [],
    quantity: { amount, unit: 'l' }
  };
}

function composeWithModel(text, rows) {
  return planRecipeRequest(text, {
    parseShoppingRequest: portion => understandShoppingRequest(portion, {
      callModel: ({ declaration }) => {
        assert.ok(['audit_shopping_request', 'submit_shopping_request'].includes(declaration.name));
        return { items: rows };
      }
    })
  });
}

test('R1 bare cooking goal identifies missing servings and offers dough variants', async () => {
  const text = 'I want to make pizza.';
  assert.equal(recognizeRequestIntent(text).intent, 'RECIPE_OR_MEAL_GOAL');
  const plan = await recipe(text);
  assertClarification(plan, /how many people.*scratch dough.*ready-made dough/iu);
  assert.deepEqual(plan.choices.map(choice => choice.templateId), ['pizzaScratch', 'pizzaPrepared']);
});

test('R2 pizza for four uses sourced quantities with explicit serving count', async () => {
  const plan = await recipe('I want to make pizza for 4 people.');
  assertReady(plan);
  const [pizza] = plan.recipes;
  assert.equal(pizza.servings, 4);
  assert.equal(pizza.servingsSource, 'explicit');
  assert.deepEqual(findIngredient(pizza, 'flour').quantity, { amount: 500, unit: 'g' });
  assert.equal(findIngredient(pizza, 'basil').required, false);
  assert.equal(findPurchase(plan, 'basil'), undefined);
  assert.match(plan.provenance.doughSelection, /ready-made dough/iu);
});

test('R3 baking a chocolate cake generates ingredients with documented template yield', async () => {
  const plan = await recipe('I want to bake a chocolate cake.');
  assertReady(plan);
  assert.equal(plan.recipes[0].dish, 'chocolate cake');
  assert.equal(plan.recipes[0].servingsSource, 'template_default');
  assert.deepEqual(findPurchase(plan, 'cocoa').quantity, { amount: 45, unit: 'g' });
  assert.equal(plan.items.some(item => item.product === 'chocolate cake'), false);
});

test('R4 birthday cake without a purchase or baking verb is ambiguous', async () => {
  const plan = await recipe('I want a birthday cake for 10 people.');
  assert.equal(plan.intent, 'AMBIGUOUS');
  assertClarification(plan, /buy a finished birthday cake.*bake one/iu);
});

test('R5 pancakes for three use the three-serving flour and liquid estimates', async () => {
  const plan = await recipe('I want to make pancakes for 3 people.');
  assertReady(plan);
  assert.equal(plan.recipes[0].servings, 3);
  assert.deepEqual(findPurchase(plan, 'flour').quantity, { amount: 180, unit: 'g' });
  assert.deepEqual(findPurchase(plan, 'milk').quantity, { amount: 225, unit: 'ml' });
  assert.deepEqual(findPurchase(plan, 'eggs').quantity, { amount: 2, unit: 'units' });
});

test('R6 unknown eggs and milk stock asks for quantities and retains full recipe', async () => {
  const plan = await recipe('I want to make pancakes, but I already have eggs and milk.');
  assertClarification(plan, /milk.*eggs/iu);
  assert.deepEqual(plan.pantry.map(entry => entry.quantity), [null, null]);
  assert.deepEqual(findIngredient(plan.recipes[0], 'eggs').quantity, { amount: 2, unit: 'units' });
  assert.deepEqual(findIngredient(plan.recipes[0], 'milk').quantity, { amount: 225, unit: 'ml' });
});

test('R7 gluten-free pizza uses appropriate flour and hard constraints on relevant packaged ingredients', async () => {
  const plan = await recipe('I want gluten-free pizza.');
  assertReady(plan);
  assert.deepEqual(plan.recipes[0].diet, ['gluten-free']);
  assert.equal(findPurchase(plan, 'flour'), undefined);
  for (const id of ['glutenFreeFlour', 'yeast', 'sauce', 'mozzarella']) {
    assert.deepEqual(findPurchase(plan, id).requirements, ['gluten-free']);
  }
});

test('R8 vegan chocolate cake substitutes plant milk and requires vegan evidence where relevant', async () => {
  const plan = await recipe('I want vegan chocolate cake.');
  assertReady(plan);
  assert.deepEqual(plan.recipes[0].diet, ['vegan']);
  assert.equal(findIngredient(plan.recipes[0], 'eggs'), undefined);
  assert.equal(findIngredient(plan.recipes[0], 'milk'), undefined);
  for (const id of ['plantMilk', 'cocoa']) assert.deepEqual(findPurchase(plan, id).requirements, ['vegan']);
});

test('R9 pizza cheese can prefer Tnuva while keeping its mandatory constraints independent', async () => {
  const plan = await recipe('I want pizza, preferably with Tnuva cheese.');
  assertReady(plan);
  const cheese = findPurchase(plan, 'mozzarella');
  assert.deepEqual(cheese.requirements, []);
  assert.deepEqual(cheese.preferences, ['Tnuva']);
  assert.equal(plan.items.filter(item => item.preferences.includes('Tnuva')).length, 1);
});

test('R10 Gad mozzarella is a mandatory cheese-brand requirement', async () => {
  const plan = await recipe('I want pizza with only Gad mozzarella.');
  assertReady(plan);
  const cheese = findPurchase(plan, 'mozzarella');
  assert.deepEqual(cheese.requirements, ['Gad']);
  assert.deepEqual(cheese.preferences, []);
  assert.equal(cheese.constraintEvidence[0].kind, 'BRAND');
});

test('R11 pizza and measured 3% milk combines a recipe with grounded direct extraction', async () => {
  const plan = await composeWithModel('I want pizza and 2 liters of 3% milk.', [stubMilk()]);
  assertReady(plan);
  assert.equal(plan.intent, 'MIXED_REQUEST');
  assert.deepEqual(plan.intents, ['RECIPE_OR_MEAL_GOAL', 'DIRECT_SHOPPING', 'MIXED_REQUEST']);
  assert.equal(plan.directPlan.userRequest, '2 liters of 3% milk.');
  const milk = plan.items.find(item => item.product === 'milk');
  assert.deepEqual(milk.requirements, ['3%']);
  assert.deepEqual(milk.quantity, { amount: 2, unit: 'l' });
  assert.ok(findPurchase(plan, 'flour'));
});

test('R12 dinner for five carries the strict budget to basket optimization', async () => {
  const plan = await recipe('I want dinner for 5 people under ₪100.');
  assertReady(plan);
  assert.equal(plan.intent, 'MEAL_PLANNING');
  assert.equal(plan.budgetIls, 100);
  assert.equal(plan.budgetExclusive, true);
  assert.equal(plan.recipes[0].servings, 5);
  assert.match(plan.provenance.selection, /selected a local dinner template/iu);
});

test('R13 chicken and rice meal has chicken and rice with no invented dietary requirements', async () => {
  const plan = await recipe('I want to cook chicken and rice.');
  assertReady(plan);
  assert.equal(plan.recipes[0].dish, 'chicken and rice');
  assert.ok(findPurchase(plan, 'chicken'));
  assert.ok(findPurchase(plan, 'rice'));
  assert.ok(plan.items.every(item => item.requirements.length === 0 && item.preferences.length === 0));
});

test('R14 cheese omission excludes all cheese from a pizza recipe and shopping list', async () => {
  const plan = await recipe('I want to make pizza without cheese.');
  assertReady(plan);
  assert.equal(findIngredient(plan.recipes[0], 'mozzarella'), undefined);
  assert.equal(plan.items.some(item => /cheese/iu.test(item.product)), false);
});

test('R15 egg-free cake uses an egg-free template', async () => {
  const plan = await recipe('I want to bake a cake without eggs.');
  assertReady(plan);
  assert.equal(plan.recipes[0].templateId, 'eggFreeCake');
  assert.equal(findIngredient(plan.recipes[0], 'eggs'), undefined);
  assert.equal(findPurchase(plan, 'eggs'), undefined);
});

test('R16 Hebrew cooking intent recognizes four servings', async () => {
  const plan = await recipe('אני רוצה להכין פיצה לארבעה אנשים.');
  assertReady(plan);
  assert.equal(plan.intent, 'RECIPE_OR_MEAL_GOAL');
  assert.equal(plan.recipes[0].servings, 4);
  assert.equal(plan.recipes[0].servingsSource, 'explicit');
});

test('R17 Arabic chocolate cake intent recognizes six servings', async () => {
  const plan = await recipe('بدي أعمل كيكة شوكولاتة لست أشخاص.');
  assertReady(plan);
  assert.equal(plan.recipes[0].dish, 'chocolate cake');
  assert.equal(plan.recipes[0].servings, 6);
  assert.equal(plan.recipes[0].servingsSource, 'explicit');
  assert.deepEqual(findPurchase(plan, 'cocoa').quantity, { amount: 33.75, unit: 'g' });
});

test('R18 frozen pizza goes to the direct shopping parser', async () => {
  const text = 'I want to buy a frozen pizza.';
  assert.equal(recognizeRequestIntent(text).intent, 'DIRECT_SHOPPING');
  const plan = await composeWithModel(text, [{
    product: 'frozen pizza', sourceText: 'frozen pizza',
    coreSearchTerm: 'פיצה', searchTerms: ['פיצה קפואה'],
    constraintEvidence: [{ type: 'REQUIREMENT', kind: 'OTHER', sourceText: 'frozen' }],
    quantity: { amount: 0, unit: 'unspecified' }
  }]);
  assert.equal(plan.items.length, 1);
  assert.equal(plan.items[0].product, 'frozen pizza');
});

test('R19 one vegan and one regular pizza preserve separate ingredient constraints', async () => {
  const plan = await recipe('I want to make 2 pizzas, one vegan and one regular.');
  assertReady(plan);
  const [vegan, regular] = plan.recipes;
  assert.equal(vegan.pizzas, 1);
  assert.equal(regular.pizzas, 1);
  assert.equal(findIngredient(vegan, 'mozzarella'), undefined);
  assert.deepEqual(findIngredient(vegan, 'veganCheese').requirements, ['vegan']);
  assert.ok(findIngredient(regular, 'mozzarella'));
  assert.equal(findIngredient(regular, 'veganCheese'), undefined);
  assert.equal(plan.items.filter(item => item.ingredientId === 'sauce').length, 2);
  assert.equal(plan.items.filter(item => item.ingredientId === 'flour').length, 1);
});

test('R20 five days of meals requests missing household and meal details', async () => {
  const text = 'I want to prepare meals for 5 days.';
  assert.equal(recognizeRequestIntent(text).days, 5);
  const plan = await recipe(text);
  assert.equal(plan.intent, 'MEAL_PLANNING');
  assertClarification(plan, /how many people.*which meals/iu);
});

test('a named daily dish with explicit servings and days scales the same template across the schedule', async () => {
  const plan = await recipe('I want to prepare pasta for 3 people each day for 5 days.');
  assertReady(plan);
  assert.equal(plan.intent, 'MEAL_PLANNING');
  assert.deepEqual(plan.schedule, { days: 5, servingsPerDay: 3, totalServings: 15 });
  assert.equal(plan.recipes[0].servings, 15);
  assert.equal(plan.recipes[0].servingsSource, 'explicit_days_and_daily_servings');
  assert.deepEqual(findPurchase(plan, 'pasta').quantity, { amount: 1500, unit: 'g' });
  assertClarification(await recipe('I want to prepare pasta for 3 people each day.'), /how many days/iu);
});

test('optional dietary variants ask for a choice and egg-free packaged dough needs evidence', async () => {
  const optional = await recipe('I want to make pizza for 4 people, preferably vegan.');
  assertClarification(optional, /which dietary version/iu);
  const eggFree = await recipe('I want to make egg-free pizza for 4 people with ready-made dough.');
  assertReady(eggFree);
  assert.deepEqual(eggFree.recipes[0].exclusions, ['eggs']);
  assert.deepEqual(findPurchase(eggFree, 'dough').requirements, ['egg-free']);
  assert.equal(findPurchase(eggFree, 'dough').constraintEvidence[0].kind, 'OTHER');
});

test('known pantry quantities are deducted without removing full recipe ingredients', async () => {
  const plan = await recipe('I want to make pancakes for 3 people, but I already have 2 eggs and 100 ml of milk.');
  assertReady(plan);
  assert.equal(findPurchase(plan, 'eggs'), undefined);
  const eggs = findIngredient(plan.recipes[0], 'eggs');
  assert.deepEqual(eggs.quantity, { amount: 2, unit: 'units' });
  assert.deepEqual(eggs.onHandQuantity, { amount: 2, unit: 'units' });
  assert.deepEqual(findPurchase(plan, 'milk').quantity, { amount: 125, unit: 'ml' });
  for (const inventory of ['-2 eggs', '2 cartons of milk', 'all the ingredients']) {
    const unclear = await recipe(`I want to make pancakes for 3 people, but I already have ${inventory}.`);
    assertClarification(unclear, /what (?:quantity|amount)/iu);
  }
});

test('unverified pantry diet labels do not fulfill mandatory recipe requirements', async () => {
  const plan = await recipe('I want gluten-free pizza, but I already have 1 kg flour.');
  assertClarification(plan, /flour.*confirm its gluten-free label/iu);
  assert.equal(findIngredient(plan.recipes[0], 'glutenFreeFlour').onHandQuantity.amount, 0);
});

test('requesting ready-made pizza dough changes the selected ingredient template', async () => {
  const plan = await recipe('I want to make pizza for 4 people with ready-made dough.');
  assertReady(plan);
  assert.equal(plan.recipes[0].templateId, 'pizzaPrepared');
  assert.equal(findPurchase(plan, 'flour'), undefined);
  assert.deepEqual(findPurchase(plan, 'dough').quantity, { amount: 500, unit: 'g' });
});

test('mixed quantities merge only for equivalent grocery needs', async () => {
  const text = 'I want to make pancakes for 3 people and also buy 2 liters of milk.';
  const plan = await composeWithModel(text, [stubMilk({ flavored: false })]);
  assertReady(plan);
  assert.equal(plan.items.filter(item => item.product === 'milk').length, 1);
  assert.deepEqual(findPurchase(plan, 'milk').quantity, { amount: 2225, unit: 'ml' });
  const constrained = await composeWithModel(text.replace('of milk', 'of 3% milk'), [stubMilk()]);
  assertReady(constrained);
  assert.deepEqual(constrained.items.filter(item => item.product === 'milk').map(item => item.requirements), [[], ['3%']]);
});

test('stored recipes cannot silently remove a diet requirement, alter a quantity or trade pantry assumptions', async () => {
  const plan = await recipe('I want gluten-free pizza.');
  for (const edit of [
    altered => { altered.items[0].requirements = []; },
    altered => { altered.items[0].quantity.amount = 1; },
    altered => { altered.pantry.push({ product: 'gluten-free flour', quantity: { amount: 500, unit: 'g' } }); }
  ]) {
    const altered = JSON.parse(JSON.stringify(plan));
    edit(altered);
    assert.throws(() => assertRecipeShoppingPlan(altered, assertShoppingPlanCoverage), /do not match the request and local templates/iu);
  }
});

test('contextual dish words preserve ordinary grocery ordering', () => {
  for (const text of [
    'I want milk and eggs.',
    'I want pizza.',
    'I want 1 L milk and 500 g pizza.',
    'I want 500 g pizza and 2 liters of milk.',
    'I want 500 g pasta and 1 kg rice.',
    'I want gluten-free pasta.',
    'I want pizza dough and 2 liters of 3% milk.',
    'I want milk and also buy a frozen pizza.',
    'I want milk and vegan chocolate cake.',
    'I want vegan chocolate cake mix.',
    'I want ready-made meals for dinner.',
    'Make a shopping list of pizza, milk, and eggs.'
  ]) {
    assert.equal(recognizeRequestIntent(text).intent, 'DIRECT_SHOPPING', text);
  }
});

test('routed mixed request builds a complete same-store pizza and 3% milk basket', async () => {
  const request = 'I want to make pizza for 4 people with ready-made dough and also buy 2 liters of 3% milk.';
  const plan = await understandShoppingRequest(request, {
    callModel: ({ declaration }) => {
      assert.ok(['audit_shopping_request', 'submit_shopping_request'].includes(declaration.name));
      return { items: [stubMilk()] };
    }
  });
  assertReady(plan);
  assert.equal(assertShoppingPlanCoverage(plan), plan);
  const offer = (_id, name, quantity, unit, listedPriceIls) => ({
    _id, retailer: 'test', chainId: '1', subChainId: '1', storeId: '10',
    name, package: { quantity, unit, isWeighted: false }, pricing: { listedPriceIls }
  });
  const catalog = buildCatalog([
    offer('dough', 'בצק לפיצה 500 גרם', 500, 'g', 13),
    offer('sauce', 'רוטב עגבניות 250 גרם', 250, 'g', 5),
    offer('cheese', 'מוצרלה 200 גרם', 200, 'g', 11),
    offer('good-milk', 'חלב 3% 1 ליטר', 1, 'l', 7),
    offer('cheaper-milk', 'חלב 1% 1 ליטר', 1, 'l', 2)
  ]);
  const matched = await Promise.all(plan.items.map((item, itemIndex) => matchProducts({
    item, context: createItemContext(plan, itemIndex), products: searchCatalog(catalog, item).results,
    callModel: ({ declaration, prompt }) => {
      assert.equal(declaration.name, 'submit_product_matches');
      const candidates = JSON.parse(prompt.slice(prompt.lastIndexOf('\nProducts: ') + '\nProducts: '.length));
      return { decisions: candidates.map(candidate => ({
        id: candidate.id, candidate: 'Controlled fixture identity', identityEvidence: candidate.name,
        relation: 'SAME_PRODUCT', identity: 'MATCH', preferencesMet: [],
        requirementChecks: item.requirements.map(requirement => ({
          requirement, kind: 'OTHER', result: 'MET', evidenceSource: 'NAME', evidence: candidate.name.match(/\d+%/u)?.[0] ?? ''
        }))
      })) };
    }
  })));
  assert.deepEqual(matched[3].rejected.map(row => row.product._id), ['cheaper-milk']);
  const { recommendedBasket } = optimizeBaskets(matched.map(buildQuantityPriceOptions), { request: plan });
  assert.equal(recommendedBasket.totalPriceIls, 43);
  assert.deepEqual(recommendedBasket.items.map(item => item.products[0].productId), ['dough', 'sauce', 'cheese', 'good-milk']);
  assert.equal(recommendedBasket.items[3].packageCount, 2);
});
