import { isDeepStrictEqual } from 'node:util';
import { normalizeAmount, parseUnit } from './smartcart-package.mjs';
import { ingredients, recipeTemplates, TEMPLATE_VERSION } from './smartcart-recipes.mjs';

export const RECIPE_PLAN_TYPE = 'recipe-planner-v1';
const READY = 'READY';
const NEEDS_CLARIFICATION = 'NEEDS_CLARIFICATION';
const TEMPLATE_SOURCE = { kind: 'LOCAL_TEMPLATE_ESTIMATE', version: TEMPLATE_VERSION };
const numberWords = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6], ['seven', 7], ['eight', 8],
  ['nine', 9], ['ten', 10], ['אחד', 1], ['אחת', 1], ['שניים', 2], ['שתי', 2], ['שני', 2], ['שלושה', 3],
  ['שלוש', 3], ['ארבעה', 4], ['ארבע', 4], ['חמישה', 5], ['חמש', 5], ['שישה', 6], ['שש', 6],
  ['ستة', 6], ['ست', 6], ['خمسة', 5], ['خمس', 5], ['أربعة', 4], ['أربع', 4],
  ['ثلاثة', 3], ['ثلاث', 3], ['شخصين', 2]
]);
const numericToken = String.raw`(?:[\d٠-٩۰-۹]+|(?:${[...numberWords.keys()].join('|')}))`;
const servingPatterns = [
  new RegExp(String.raw`(?:\bfor|\bserves?)\s+(?<count>${numericToken})\s+(?:people|persons?|servings?|adults?|guests?)\b(?<daily>\s+(?:each day|per day|daily)\b)?`, 'iu'),
  new RegExp(String.raw`(?:^|\s)ל[-־]?\s*(?<count>${numericToken})\s+(?:אנשים|סועדים|מנות)(?!\p{L})`, 'u'),
  new RegExp(String.raw`(?:^|\s)ل\s*(?<count>${numericToken})\s+(?:أشخاص|اشخاص|أفراد|افراد)(?!\p{L})`, 'u')
];
const directBuy = /\b(?:buy|purchase|pick up)\s+(?:a |an |the )?|(?:^|\s)(?:לקנות|اشتري)(?=\s)/iu;
const cookingVerb = /(?:^|\s)(?:make|bake|cook|prepare)(?=\s)|(?:^|\s)(?:להכין|לבשל|לאפות|أعمل|اعمل|أسوي|أطبخ)(?=\s)/iu;
const shoppingList = /\b(?:make|prepare)\s+(?:me\s+)?(?:a\s+)?(?:shopping|grocery)\s+list\b/iu;
const genericMeal = /\b(?:meals?|dinners?|lunch(?:es)?|breakfasts?)\b|(?:^|\s)ארוחת ערב|(?:^|\s)وجبة/iu;
const birthdayCake = /\bbirthday cake\b|עוגת יום הולדת|كيكة عيد ميلاد/iu;
const dishPatterns = [
  ['chicken and rice', /\bchicken\s+(?:and|with)\s+rice\b|עוף עם אורז|دجاج مع أرز/iu],
  ['chocolate cake', /\bchocolate cake\b|עוגת שוקולד|كيك(?:ة)?\s+(?:ال)?شوكولاتة/iu],
  ['pizza', /\bpizzas?\b|(?:^|(?<!\p{L}))פיצה(?!\p{L})|بيتزا/iu],
  ['pancakes', /\bpancakes?\b|פנקייק(?:ים)?|بان كيك/iu],
  ['pasta', /\bpasta\b|פסטה|باستا/iu],
  ['cake', /\bcakes?\b|עוגה|كيك(?:ة)?/iu]
];
const implicitlyPreparedDishes = new Set(['pizza', 'cake', 'chocolate cake']);
const veganPattern = /\bvegan\b|טבעוני(?:ת|ים|ות)?|نباتي(?:ة)?\s+صرف/iu;
const glutenFreePattern = /\bgluten[- ]free\b|ללא גלוטן|خالي(?:ة)? من الغلوتين/iu;
const cheeseExclusion = /\b(?:without|no)\s+cheese\b|ללא גבינה|بدون جبن/iu;
const eggExclusion = /\b(?:(?:without|no)\s+eggs?|egg[- ]free)\b|ללא ביצים|بدون بيض/iu;
const optionalDiet = /\b(?:prefer(?:ably)?|ideally)\s+(?:vegan|gluten[- ]free|egg[- ]free)\b|\b(?:vegan|gluten[- ]free|egg[- ]free)\s+(?:preferred|if possible)\b/iu;
const scratchPattern = /\b(?:from scratch|homemade dough|scratch dough)\b|בצק ביתי/iu;
const preparedPattern = /\b(?:ready[- ]made|pre[- ]made|store[- ]bought|prepared)\s+dough\b|בצק מוכן/iu;
const regularVeganPair = /\btwo pizzas\s*,?\s+one vegan and one regular\b|\b2 pizzas\s*,?\s+one vegan and one regular\b/iu;
const brandPattern = /\b(?:(?<first>preferably|only)\s+(?:with\s+)?|with\s+(?<second>only|preferably)\s+)(?<brand>[\p{L}\p{N}][\p{L}\p{N} .'-]*?)\s+(?:mozzarella|cheese)\b/iu;
const splitPantryPattern = /(?:[,;.]?\s+(?:(?:but|and)\s+)?(?:i\s+(?:already\s+)?have|יש לי|عندي)\s+)/iu;
const explicitSplitPattern = /(?<separator>[,;.]?\s+(?:and|then)\s+(?:also\s+)?(?:buy|pick up|get)\s+)(?<request>[^\n]+)$/iu;
const measuredSplitPattern = /(?<separator>[,;]?\s+and\s+)(?<request>\d+(?:[.,]\d+)?\s*(?:liters?|litres?|l|ml|kilograms?|kg|grams?|g)\s+[^\n]+)$/iu;
const budgetClause = /\b(?<comparison>under|less than|at most|up to|budget(?:\s+of)?\s*(?:is\s+)?)\s*(?:₪\s*(?<prefix>\d+(?:[.,]\d{1,2})?)|(?<suffix>\d+(?:[.,]\d{1,2})?)\s*(?:₪|(?:nis|ils|shekels?)\b))/iu;
const dayPattern = new RegExp(String.raw`\b(?:for|over)\s+(?<count>${numericToken})\s+days?\b`, 'iu');
const goalWords = new Set((
  'i we would like want need plan am to going planning some a an the ingredients for any buy purchase ' +
  'make bake cook prepare something with and me please dinner lunch breakfast meals meal ' +
  'אני אנחנו רוצה צריך צריכה להכין לאפות לבשל מרכיבים בשביל בבקשה ארוחת ערב ' +
  'بدي أريد اريد أعمل اعمل أسوي أطبخ مكونات لعمل وجبة'
).split(' '));

function decimalDigits(value) {
  return value.replace(/[٠-٩۰-۹]/gu, digit => String(digit.charCodeAt(0) & 0xf));
}

function canonical(value) {
  return decimalDigits(value.normalize('NFKC').toLocaleLowerCase())
    .replace(/[\p{M}\p{Cf}]/gu, '')
    .replace(/[-‐‑‒–—־]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}

function numberOf(value) {
  const known = numberWords.get(canonical(value));
  const number = decimalDigits(value.trim()).replace(',', '.').replace('−', '-');
  return known ?? (/^[+-]?\d+(?:\.\d+)?$/u.test(number) ? Number(number) : NaN);
}

function splitAt(text, pattern) {
  const match = pattern.exec(text);
  return match
    ? { before: text.slice(0, match.index).trim(), after: text.slice(match.index + match[0].length).trim(), match }
    : { before: text, after: '', match: null };
}

function analyzeRequest(request) {
  if (typeof request !== 'string' || !request.trim()) throw new TypeError('Enter a nonempty shopping request.');
  const original = request.trim();
  const explicit = directBuy.exec(original);
  const cooking = shoppingList.test(original) ? null : cookingVerb.exec(original);
  const hasCookingVerb = Boolean(cooking);
  const brand = brandPattern.exec(original);
  const hasRecipeModifier = veganPattern.test(original) || glutenFreePattern.test(original) ||
    cheeseExclusion.test(original) || eggExclusion.test(original) ||
    Boolean(brand && !/\band\s*$/iu.test(original.slice(0, brand.index)));
  const possibleDish = dishPatterns.find(([, pattern]) => pattern.test(original));
  const dishMatch = possibleDish?.[1].exec(original);
  const explicitBuyFirst = Boolean(explicit && !hasCookingVerb && (!dishMatch || explicit.index < dishMatch.index));
  const possibleSplit = explicitSplitPattern.exec(original) ??
    (possibleDish && !splitPantryPattern.test(original) ? measuredSplitPattern.exec(original) : null);
  const split = possibleSplit && ((dishMatch && dishMatch.index < possibleSplit.index) ||
    (cooking && cooking.index < possibleSplit.index)) ? possibleSplit : null;
  const hasIngredientWording = /\bingredients?\s+(?:for|to make)\b|מרכיבים ל|مكونات ل/iu.test(original);
  const readyProduct = /\b(?:frozen|finished|ready[- ]made)\s+(?:pizza|cake|meals?)\b|\b(?:pizza|cake|pasta|pancake)\s+(?:dough|sauce|mix)\b/iu.test(original);
  const dishLead = dishMatch
    ? original.slice(0, dishMatch.index).replace(veganPattern, '').replace(glutenFreePattern, '').replace(eggExclusion, '')
    : '';
  const onlyDishLead = (canonical(dishLead).match(/[\p{L}\p{N}]+/gu) ?? [])
    .every(word => goalWords.has(word) && word !== 'and');
  const implicitCooking = implicitlyPreparedDishes.has(possibleDish?.[0]) && onlyDishLead &&
    (hasRecipeModifier || split) && !readyProduct;
  const ambiguousCake = birthdayCake.test(original) && !explicitBuyFirst && !hasCookingVerb;
  const mealRequested = !explicitBuyFirst && !readyProduct && genericMeal.test(original) &&
    (hasCookingVerb || /\b(?:for|under|something|anything)\b/iu.test(original));
  const workOnRecipe = hasIngredientWording || (!explicitBuyFirst && (hasCookingVerb || implicitCooking || mealRequested));

  if (ambiguousCake) return { intent: 'AMBIGUOUS', intents: ['AMBIGUOUS'], reason: 'birthday-cake' };
  if (!workOnRecipe) return { intent: 'DIRECT_SHOPPING', intents: ['DIRECT_SHOPPING'] };

  const goalWithPantry = split ? original.slice(0, split.index).trim() : original;
  const { before: goal, after: pantryText } = splitAt(goalWithPantry, splitPantryPattern);
  const dish = dishPatterns.find(([, pattern]) => pattern.test(goal))?.[0];
  const dayMatch = dayPattern.exec(goal);
  const days = dayMatch ? numberOf(dayMatch.groups.count) : null;
  const mealPlanning = Boolean(days || !dish && genericMeal.test(goal));
  const baseIntent = mealPlanning ? 'MEAL_PLANNING' : 'RECIPE_OR_MEAL_GOAL';
  const intent = split ? 'MIXED_REQUEST' : baseIntent;
  const serveMatch = servingPatterns.map(pattern => pattern.exec(goal)).find(Boolean);
  const budget = budgetClause.exec(goal);
  const goalBrand = brandPattern.exec(goal);
  const budgetIls = budget ? numberOf(budget.groups.prefix ?? budget.groups.suffix) : undefined;
  const diet = [
    ...(veganPattern.test(goal) ? ['vegan'] : []),
    ...(glutenFreePattern.test(goal) ? ['gluten-free'] : [])
  ];
  return {
    intent,
    intents: split ? [baseIntent, 'DIRECT_SHOPPING', 'MIXED_REQUEST'] : [baseIntent],
    goal, dish: dish ?? null, pantryText, explicitRequest: split?.groups.request.trim() ?? null,
    days, servings: serveMatch ? numberOf(serveMatch.groups.count) : null,
    dailyServings: Boolean(serveMatch?.groups.daily),
    ...(budgetIls === undefined ? {} : { budgetIls }),
    ...(budget && /^(?:under|less than)$/iu.test(budget.groups.comparison) ? { budgetExclusive: true } : {}),
    diet, noCheese: cheeseExclusion.test(goal), noEggs: eggExclusion.test(goal),
    optionalDiet: optionalDiet.exec(goal)?.[0] ?? null,
    scratch: scratchPattern.test(goal), prepared: preparedPattern.test(goal),
    regularVeganPair: regularVeganPair.test(goal),
    brand: goalBrand ? {
      value: goalBrand.groups.brand.trim(),
      mandatory: /^only$/iu.test(goalBrand.groups.first ?? goalBrand.groups.second)
    } : null,
    covered: [
      serveMatch?.[0], budget?.[0], dayMatch?.[0], goalBrand?.[0], regularVeganPair.exec(goal)?.[0],
      veganPattern.exec(goal)?.[0], glutenFreePattern.exec(goal)?.[0],
      cheeseExclusion.exec(goal)?.[0], eggExclusion.exec(goal)?.[0],
      scratchPattern.exec(goal)?.[0], preparedPattern.exec(goal)?.[0],
      ...dishPatterns.filter(([name]) => name === dish).map(([, pattern]) => pattern.exec(goal)?.[0])
    ].filter(Boolean)
  };
}

export function recognizeRequestIntent(request) {
  const { intent, intents, dish, servings, days } = analyzeRequest(request);
  return {
    intent, intents,
    ...(dish ? { dish } : {}),
    ...(servings !== null && servings !== undefined ? { servings } : {}),
    ...(days !== null && days !== undefined ? { days } : {})
  };
}

function uncoveredWording(details) {
  let remaining = details.goal;
  for (const covered of details.covered) remaining = remaining.replace(covered, ' ');
  const tokens = canonical(remaining).match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.filter(token => !goalWords.has(token));
}

function dinnerSelection(details) {
  if (details.days !== null) {
    if (!details.dish || !details.dailyServings || !details.servings || details.regularVeganPair) {
      return { question: 'How many people, and which meals or dishes should the plan cover each day?' };
    }
    const totalServings = details.servings * details.days;
    if (!Number.isInteger(details.days) || details.days < 1 || details.days > 31 || totalServings > 100) {
      return { question: 'Give a schedule of 1–31 days and at most 100 total servings.' };
    }
    return {
      dish: details.dish,
      schedule: { days: details.days, servingsPerDay: details.servings, totalServings }
    };
  }
  if (details.dish) return { dish: details.dish };
  if (details.intent === 'MEAL_PLANNING' || details.intents.includes('MEAL_PLANNING')) {
    if (details.servings === null) return { question: 'How many people, and what kind of meal would you like?' };
    return {
      dish: details.diet.includes('vegan') ? 'pasta' : 'chicken and rice',
      suggestion: 'The planner selected a local dinner template because the request specified a meal without a dish.'
    };
  }
  return { question: 'Which dish would you like to prepare? Local templates cover pizza, cake, pancakes, chicken and rice, and pasta.' };
}

function chooseTemplates(details, dish) {
  if (dish === 'pizza') {
    if (details.scratch && details.prepared) return { question: 'Would you like scratch dough or ready-made dough?' };
    const choices = [
      { templateId: 'pizzaScratch', label: recipeTemplates.pizzaScratch.title },
      { templateId: 'pizzaPrepared', label: recipeTemplates.pizzaPrepared.title }
    ];
    const recipeId = details.prepared ? 'pizzaPrepared' : 'pizzaScratch';
    if (details.regularVeganPair) {
      const sharedDiet = details.diet.filter(entry => entry !== 'vegan');
      const pizzas = 1;
      const servings = details.servings === null
        ? recipeTemplates[recipeId].servings * pizzas / recipeTemplates[recipeId].pizzas
        : details.servings / 2;
      const servingsSource = details.servings === null ? 'explicit_pizza_count' : 'explicit_split_between_pizzas';
      return { choices, entries: [
        { recipeId, diet: [...sharedDiet, 'vegan'], servings, servingsSource, pizzas },
        { recipeId, diet: sharedDiet, servings, servingsSource, pizzas }
      ] };
    }
    const plainGoal = details.servings === null && !details.scratch && !details.prepared &&
      !details.diet.length && !details.noCheese && !details.brand && !details.explicitRequest &&
      !details.pantryText;
    if (plainGoal) {
      return { choices, question: 'How many people are you cooking for, and would you like scratch dough or ready-made dough?' };
    }
    return { choices, entries: [{ recipeId, diet: details.diet }] };
  }
  const vegan = details.diet.includes('vegan');
  const glutenFree = details.diet.includes('gluten-free');
  if (dish === 'chicken and rice' && vegan) {
    return { question: 'Which plant-based main ingredient would you like instead of chicken?' };
  }
  if ((dish === 'pancakes' && (vegan || details.noEggs)) ||
      (glutenFree && !['pasta', 'chicken and rice'].includes(dish))) {
    return { question: 'This dish and dietary combination needs another template. Which substitute or dish would you like?' };
  }
  const eggFree = vegan || details.noEggs;
  const recipeId = {
    'chocolate cake': eggFree ? 'eggFreeChocolateCake' : 'chocolateCake',
    cake: eggFree ? 'eggFreeCake' : 'vanillaCake',
    pancakes: 'pancakes',
    'chicken and rice': 'chickenRice',
    pasta: 'pasta'
  }[dish];
  return { entries: [{ recipeId, diet: details.diet }] };
}

function amountFor(amount, unit, scale) {
  const scaled = Math.round(amount * scale * 1000) / 1000;
  return parseUnit(unit)?.family === 'count' ? Math.ceil(scaled) : scaled;
}

function ingredientRow(spec, required, recipe, details) {
  let [id, amount, unit] = spec;
  if (details.noCheese && id === 'mozzarella') return null;
  const vegan = recipe.diet.includes('vegan');
  const glutenFree = recipe.diet.includes('gluten-free');
  if (vegan && id === 'mozzarella') id = 'veganCheese';
  if (glutenFree && id === 'flour') id = 'glutenFreeFlour';
  const ingredient = ingredients[id];
  const requirements = [
    ...(vegan && ingredient.veganLabel ? ['vegan'] : []),
    ...(glutenFree && ingredient.glutenLabel ? ['gluten-free'] : []),
    ...(details.noEggs && ingredient.eggFreeLabel ? ['egg-free'] : [])
  ];
  const preferences = [];
  const brandApplies = details.brand && recipe.dish === 'pizza' &&
    (id === 'mozzarella' || id === 'veganCheese');
  if (brandApplies) (details.brand.mandatory ? requirements : preferences).push(details.brand.value);
  const quantity = { amount: amountFor(amount, unit, recipe.servings / recipe.referenceServings), unit };
  return {
    ingredientId: id, product: ingredient.product, searchTerms: [...ingredient.terms], required,
    requirements, preferences, quantity,
    provenance: { ...TEMPLATE_SOURCE, templateId: recipe.templateId, referenceQuantity: { amount, unit } }
  };
}

function recipeFrom(entry, details) {
  const template = recipeTemplates[entry.recipeId];
  const recipe = {
    templateId: entry.recipeId, dish: template.dish, title: template.title,
    servings: entry.servings ?? details.servings ?? template.servings,
    servingsSource: entry.servingsSource ?? (details.schedule ? 'explicit_days_and_daily_servings'
      : details.servings === null ? 'template_default' : 'explicit'),
    referenceServings: template.servings, diet: entry.diet,
    exclusions: [...(details.noCheese ? ['cheese'] : []), ...(details.noEggs ? ['eggs'] : [])],
    ...(entry.pizzas === undefined ? {} : { pizzas: entry.pizzas }),
    provenance: { ...TEMPLATE_SOURCE, templateId: entry.recipeId }
  };
  recipe.ingredients = [
    ...template.ingredients.map(spec => ingredientRow(spec, true, recipe, details)),
    ...template.optional.map(spec => ingredientRow(spec, false, recipe, details))
  ].filter(Boolean);
  return recipe;
}

const pantryPrefix = new RegExp(
  String.raw`^(?<amount>(?:[+−-]?\d+(?:[.,]\d+)?(?:\s*/\s*\d+)?|${numericToken}))\s*(?<rest>.+)$`, 'iu'
);

function pantryNumber(text) {
  const fraction = text.match(/^(\d+)\s*\/\s*(\d+)$/u);
  return fraction ? Number(fraction[1]) / Number(fraction[2]) : numberOf(text);
}

function parsePantryEntry(entry) {
  const sourceText = entry.trim().replace(/[.!?]+$/u, '').trim();
  const match = pantryPrefix.exec(sourceText);
  if (!match) return { sourceText, product: sourceText, quantity: null };
  const amount = pantryNumber(match.groups.amount.replace('−', '-'));
  const parts = match.groups.rest.trim().split(/\s+/u);
  if (/^(?:cartons?|packs?|jars?|cups?|teaspoons?|tablespoons?)$/iu.test(parts[0]) &&
      /^of$/iu.test(parts[1] ?? '')) {
    return { sourceText, product: parts.slice(2).join(' '), quantity: null };
  }
  const unit = parseUnit(parts[0]) ? parts.shift() : 'units';
  if (/^of$/iu.test(parts[0] ?? '')) parts.shift();
  const product = parts.join(' ');
  const quantity = normalizeAmount(amount, unit);
  return {
    sourceText,
    product,
    quantity: quantity && product ? { amount: quantity.amountBase, unit: quantity.base } : null
  };
}

function parsePantry(text) {
  return text.split(/(?<!\d),|,(?!\d)|\s+and\s+|\s+וגם\s+/iu).map(entry => entry.trim()).filter(Boolean).map(parsePantryEntry);
}

function sameProduct(name, entry) {
  const normalized = canonical(name);
  return [entry.product, ...entry.aliases].some(alias => canonical(alias) === normalized);
}

function pantryProductMatches(name, row) {
  name = name.replace(/^(?:some|enough|the)\s+/iu, '');
  const normalized = canonical(name);
  const definition = ingredients[row.ingredientId];
  if (sameProduct(name, definition)) return true;
  const withoutDietOrBrand = canonical(name.replace(veganPattern, '').replace(glutenFreePattern, '').replace(eggExclusion, ''));
  if (sameProduct(withoutDietOrBrand, definition)) return true;
  return row.requirements.some(requirement => {
    const prefix = `${canonical(requirement)} `;
    return normalized.startsWith(prefix) && sameProduct(normalized.slice(prefix.length), definition);
  });
}

function pantryMeetsRequirements(pantryProduct, requirements) {
  const normalizedProduct = ` ${canonical(pantryProduct)} `;
  return requirements.every(requirement => {
    if (requirement === 'vegan') return veganPattern.test(pantryProduct);
    if (requirement === 'gluten-free') return glutenFreePattern.test(pantryProduct);
    if (requirement === 'egg-free') return eggExclusion.test(pantryProduct);
    return normalizedProduct.includes(` ${canonical(requirement)} `);
  });
}

function applyPantry(recipes, pantry) {
  const stock = pantry.map(entry => ({ ...entry, remaining: entry.quantity?.amount ?? null }));
  const questions = new Set(pantry.some(entry => /^(?:everything|all (?:the )?ingredients)$/iu.test(entry.product))
    ? ['Which ingredients do you already have, and what amount of each?'] : []);
  for (const recipe of recipes) {
    for (const row of recipe.ingredients) {
      const { amount, unit } = row.quantity;
      const requested = normalizeAmount(amount, unit);
      let coveredBase = 0;
      if (row.required) {
        const uncertain = [];
        for (const entry of stock.filter(entry => pantryProductMatches(entry.product, row))) {
          if (coveredBase >= requested.amountBase) break;
          if (entry.remaining === null || entry.quantity.unit !== requested.base ||
              !pantryMeetsRequirements(entry.product, row.requirements)) {
            uncertain.push(entry);
            continue;
          }
          const supplied = Math.min(entry.remaining, requested.amountBase - coveredBase);
          entry.remaining -= supplied;
          coveredBase += supplied;
        }
        if (coveredBase < requested.amountBase) {
          for (const entry of uncertain) {
            const labels = row.requirements.length ? ` and confirm its ${row.requirements.join(', ')} label` : '';
            questions.add(`What quantity of ${entry.product} do you have in ${unit}${labels}?`);
          }
        }
      }
      const covered = coveredBase / parseUnit(unit).factor;
      const missing = row.required ? Math.round(Math.max(0, amount - covered) * 1000) / 1000 : 0;
      row.onHandQuantity = { amount: Math.round(covered * 1000) / 1000, unit };
      row.purchaseQuantity = { amount: missing, unit };
    }
  }
  return [...questions];
}

function constraintEvidence(row) {
  return [
    ...row.requirements.map(value => ({ type: 'REQUIREMENT', value })),
    ...row.preferences.map(value => ({ type: 'PREFERENCE', value }))
  ].map(entry => ({
    ...entry, kind: ['vegan', 'gluten-free', 'egg-free'].includes(entry.value) ? 'OTHER' : 'BRAND',
    sourceText: entry.value
  }));
}

function equalStrings(a, b) {
  return isDeepStrictEqual(a.map(canonical).sort(), b.map(canonical).sort());
}

function combineQuantity(left, right) {
  if (left?.maxAmount !== undefined || right?.maxAmount !== undefined ||
      left?.unit !== right?.unit && (parseUnit(left?.unit)?.family === 'count' || parseUnit(right?.unit)?.family === 'count')) {
    return null;
  }
  const a = normalizeAmount(left?.amount, left?.unit);
  const b = normalizeAmount(right?.amount, right?.unit);
  return a && b && a.family === b.family
    ? { amount: Math.round((a.amountBase + b.amountBase) * 1000) / 1000, unit: a.family === 'count' ? left.unit : a.base }
    : null;
}

function mergeIfCompatible(items, next) {
  if (next.choiceGroup !== undefined) return false;
  const prior = items.find(candidate => {
    const match = candidate.ingredientId
      ? sameProduct(next.product, ingredients[candidate.ingredientId])
      : canonical(candidate.product) === canonical(next.product);
    return candidate.choiceGroup === undefined && match &&
      equalStrings(candidate.requirements, next.requirements) &&
      equalStrings(candidate.preferences, next.preferences) && combineQuantity(candidate.quantity, next.quantity);
  });
  if (!prior) return false;
  prior.quantity = combineQuantity(prior.quantity, next.quantity);
  prior.sources.push(...next.sources);
  return true;
}

function shoppingItems(recipes, directPlan) {
  const items = [];
  for (const recipe of recipes) {
    for (const row of recipe.ingredients) {
      if (!row.purchaseQuantity.amount) continue;
      const next = {
        ingredientId: row.ingredientId, product: row.product, searchTerms: row.searchTerms,
        requirements: row.requirements, preferences: row.preferences, quantity: row.purchaseQuantity,
        constraintEvidence: constraintEvidence(row),
        sources: [{ type: 'RECIPE', templateId: recipe.templateId, ingredientId: row.ingredientId }]
      };
      if (!mergeIfCompatible(items, next)) items.push(next);
    }
  }
  const choiceGroups = new Map();
  for (const item of directPlan?.items ?? []) {
    const next = { ...item, sources: [{ type: 'DIRECT_SHOPPING', sourceText: item.sourceText }] };
    if (item.choiceGroup !== undefined) {
      if (!choiceGroups.has(item.choiceGroup)) choiceGroups.set(item.choiceGroup, `choice-${items.length}`);
      next.choiceGroup = choiceGroups.get(item.choiceGroup);
    }
    if (!mergeIfCompatible(items, next)) items.push(next);
  }
  return items;
}

function assemblePlan(request, details) {
  const base = {
    planType: RECIPE_PLAN_TYPE, userRequest: request, intent: details.intent,
    intents: details.intents, provenance: { ...TEMPLATE_SOURCE },
    ...(details.budgetIls === undefined ? {} : { budgetIls: details.budgetIls }),
    ...(details.budgetExclusive ? { budgetExclusive: true } : {})
  };
  const clarify = (questions, data = {}) => ({
    ...base, status: NEEDS_CLARIFICATION, items: [], recipes: [], questions, ...data
  });
  if (details.reason === 'birthday-cake') {
    return clarify(['Would you like to buy a finished birthday cake or shop for ingredients to bake one?']);
  }
  if (details.servings !== null && (!Number.isInteger(details.servings) || details.servings < 1 || details.servings > 100)) {
    return clarify(['Give a serving count between 1 and 100 for a local recipe estimate.']);
  }
  if (details.budgetIls !== undefined && (!Number.isFinite(details.budgetIls) || details.budgetIls <= 0)) {
    return clarify(['Give a shopping budget greater than zero in shekels.']);
  }
  if (details.noCheese && details.brand) {
    return clarify(['Should the pizza contain cheese? Both a cheese brand and a request to omit cheese were specified.']);
  }
  if (details.optionalDiet) {
    return clarify(['Which dietary version should the recipe use? Specify whether the dietary constraint is mandatory or choose the regular recipe.']);
  }
  if (details.dailyServings && details.days === null) {
    return clarify(['How many days should the recipe cover?']);
  }
  const dinner = dinnerSelection(details);
  if (dinner.question) return clarify([dinner.question]);
  const uncovered = uncoveredWording(details);
  if (uncovered.length) {
    return clarify([`Clarify how this wording should affect the recipe or groceries: ${uncovered.join(' ')}.`]);
  }
  const recipeDetails = dinner.schedule
    ? { ...details, servings: dinner.schedule.totalServings, schedule: dinner.schedule }
    : details;
  const templates = chooseTemplates(recipeDetails, dinner.dish);
  const choices = templates.choices ?? [];
  if (templates.question) return clarify([templates.question], { choices });
  const recipes = templates.entries.map(entry => recipeFrom(entry, recipeDetails));
  const pantry = parsePantry(details.pantryText);
  const questions = applyPantry(recipes, pantry);
  const provenance = {
    ...TEMPLATE_SOURCE,
    ...(dinner.suggestion ? { selection: dinner.suggestion } : {}),
    ...(choices.length && !details.scratch && !details.prepared
      ? { doughSelection: 'Scratch dough is the selected local template. Ready-made dough is also available.' }
      : {})
  };
  const planned = { recipes, choices, pantry, provenance, ...(dinner.schedule ? { schedule: dinner.schedule } : {}) };
  if (questions.length) return clarify(questions, planned);
  return { ...base, status: READY, ...planned, items: shoppingItems(recipes) };
}

function verifyDirectPlan(details, directPlan, assertDirectPlan) {
  if (!directPlan || directPlan.userRequest !== details.explicitRequest) {
    throw new Error('The embedded direct shopping request does not match the original cooking request.');
  }
  if (typeof assertDirectPlan !== 'function') {
    throw new TypeError('A direct shopping plan validator is required for mixed cooking requests.');
  }
  assertDirectPlan(directPlan);
}

function withDirectPlan(plan, directPlan) {
  return { ...plan, directPlan, items: shoppingItems(plan.recipes, directPlan) };
}

export async function planRecipeRequest(request, { parseShoppingRequest } = {}) {
  const details = analyzeRequest(request);
  if (details.intent === 'DIRECT_SHOPPING') {
    if (typeof parseShoppingRequest !== 'function') throw new TypeError('A direct shopping parser is required.');
    return parseShoppingRequest(request);
  }
  const plan = assemblePlan(request, details);
  if (plan.status !== READY || !details.explicitRequest) return plan;
  if (typeof parseShoppingRequest !== 'function') {
    throw new TypeError('A direct shopping parser is required for a mixed cooking request.');
  }
  const directPlan = await parseShoppingRequest(details.explicitRequest);
  if (!directPlan || directPlan.userRequest !== details.explicitRequest || !Array.isArray(directPlan.items) ||
      !directPlan.items.length) {
    throw new Error('The direct shopping portion could not be verified.');
  }
  return withDirectPlan(plan, directPlan);
}

export function assertRecipeShoppingPlan(plan, assertDirectPlan) {
  if (plan?.planType !== RECIPE_PLAN_TYPE || typeof plan.userRequest !== 'string') {
    throw new Error('Invalid recipe shopping plan.');
  }
  const details = analyzeRequest(plan.userRequest);
  if (details.intent === 'DIRECT_SHOPPING') throw new Error('The request does not identify a recipe or meal plan.');
  let expected = assemblePlan(plan.userRequest, details);
  if (expected.status === READY && details.explicitRequest) {
    verifyDirectPlan(details, plan.directPlan, assertDirectPlan);
    expected = withDirectPlan(expected, plan.directPlan);
  }
  if (!isDeepStrictEqual(plan, expected)) throw new Error('Recipe shopping items or provenance do not match the request and local templates.');
  return plan;
}
