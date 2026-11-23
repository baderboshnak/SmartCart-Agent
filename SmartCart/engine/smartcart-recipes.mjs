// Grocery quantities are SmartCart's local recipe estimates. Each template
// states a reference yield so the planner can scale and explain its purchases.
export const TEMPLATE_VERSION = 1;

export const ingredients = {
  flour: { product: 'wheat flour', aliases: ['all-purpose flour', 'plain flour', 'flour', 'קמח'], terms: ['קמח', 'קמח חיטה'] },
  glutenFreeFlour: { product: 'gluten-free flour', aliases: ['gluten-free flour', 'gluten free flour', 'קמח ללא גלוטן', 'flour', 'קמח'], terms: ['קמח', 'קמח ללא גלוטן'], glutenLabel: true },
  dough: { product: 'ready-made pizza dough', aliases: ['pizza dough', 'ready-made dough', 'dough', 'בצק לפיצה'], terms: ['בצק לפיצה', 'בצק פיצה', 'בסיס לפיצה'], glutenLabel: true, veganLabel: true, eggFreeLabel: true },
  yeast: { product: 'baking yeast', aliases: ['baking yeast', 'dry yeast', 'yeast', 'שמרים'], terms: ['שמרים'], glutenLabel: true },
  water: { product: 'drinking water', aliases: ['drinking water', 'water', 'מים'], terms: ['מים'] },
  salt: { product: 'plain salt', aliases: ['table salt', 'salt', 'מלח'], terms: ['מלח'] },
  oil: { product: 'vegetable cooking oil', aliases: ['vegetable oil', 'olive oil', 'cooking oil', 'oil', 'שמן'], terms: ['שמן', 'שמן זית'] },
  sauce: { product: 'tomato sauce for pizza or pasta', aliases: ['pizza sauce', 'pasta sauce', 'tomato sauce', 'sauce', 'רוטב עגבניות'], terms: ['רוטב עגבניות', 'רוטב פיצה', 'רוטב לפיצה'], glutenLabel: true, veganLabel: true },
  mozzarella: { product: 'mozzarella cheese', aliases: ['mozzarella cheese', 'mozzarella', 'cheese', 'מוצרלה', 'גבינה'], terms: ['מוצרלה'], glutenLabel: true },
  veganCheese: { product: 'vegan cheese suitable for pizza', aliases: ['vegan mozzarella', 'vegan cheese', 'גבינה טבעונית'], terms: ['גבינה טבעונית', 'מוצרלה טבעונית', 'תחליף גבינה'], veganLabel: true, glutenLabel: true },
  basil: { product: 'fresh basil', aliases: ['fresh basil', 'basil', 'בזיליקום'], terms: ['בזיליקום'] },
  eggs: { product: 'eggs', aliases: ['eggs', 'egg', 'ביצים', 'ביצה'], terms: ['ביצים'] },
  milk: { product: 'milk', aliases: ['dairy milk', 'milk', 'חלב'], terms: ['חלב'] },
  plantMilk: { product: 'oat milk', aliases: ['oat milk', 'plant milk', 'משקה שיבולת שועל'], terms: ['משקה שיבולת שועל', 'חלב שיבולת שועל'], veganLabel: true, glutenLabel: true },
  sugar: { product: 'granulated sugar', aliases: ['granulated sugar', 'white sugar', 'sugar', 'סוכר'], terms: ['סוכר'], veganLabel: true },
  cocoa: { product: 'plain unsweetened cocoa powder', aliases: ['cocoa powder', 'cocoa', 'קקאו'], terms: ['קקאו', 'אבקת קקאו'], veganLabel: true, glutenLabel: true },
  bakingPowder: { product: 'baking powder', aliases: ['baking powder', 'אבקת אפייה'], terms: ['אבקת אפייה'], veganLabel: true, glutenLabel: true },
  chocolate: { product: 'dark chocolate', aliases: ['dark chocolate', 'chocolate', 'שוקולד מריר'], terms: ['שוקולד מריר'], veganLabel: true, glutenLabel: true },
  chicken: { product: 'chicken breast', aliases: ['chicken breast', 'chicken', 'חזה עוף', 'עוף'], terms: ['חזה עוף', 'עוף'] },
  rice: { product: 'plain dry rice', aliases: ['dry rice', 'rice', 'אורז'], terms: ['אורז'] },
  pasta: { product: 'dry pasta', aliases: ['dry pasta', 'pasta', 'פסטה'], terms: ['פסטה'], glutenLabel: true, veganLabel: true, eggFreeLabel: true }
};

export const recipeTemplates = {
  pizzaScratch: {
    dish: 'pizza', title: 'Homemade pizza with scratch dough', servings: 4, pizzas: 2,
    ingredients: [['flour', 500, 'g'], ['yeast', 7, 'g'], ['water', 320, 'ml'], ['salt', 8, 'g'],
      ['oil', 25, 'ml'], ['sauce', 220, 'g'], ['mozzarella', 200, 'g']],
    optional: [['basil', 10, 'g']]
  },
  pizzaPrepared: {
    dish: 'pizza', title: 'Pizza with ready-made dough', servings: 4, pizzas: 2,
    ingredients: [['dough', 500, 'g'], ['sauce', 220, 'g'], ['mozzarella', 200, 'g']],
    optional: [['basil', 10, 'g']]
  },
  chocolateCake: {
    dish: 'chocolate cake', title: 'Chocolate cake', servings: 8,
    ingredients: [['flour', 220, 'g'], ['sugar', 180, 'g'], ['cocoa', 45, 'g'],
      ['bakingPowder', 10, 'g'], ['eggs', 3, 'units'], ['milk', 180, 'ml'], ['oil', 110, 'ml']],
    optional: [['chocolate', 60, 'g']]
  },
  eggFreeChocolateCake: {
    dish: 'chocolate cake', title: 'Egg-free chocolate cake with plant milk', servings: 8,
    ingredients: [['flour', 240, 'g'], ['sugar', 180, 'g'], ['cocoa', 45, 'g'],
      ['bakingPowder', 12, 'g'], ['plantMilk', 280, 'ml'], ['oil', 95, 'ml']],
    optional: [['chocolate', 60, 'g']]
  },
  vanillaCake: {
    dish: 'cake', title: 'Simple cake', servings: 8,
    ingredients: [['flour', 240, 'g'], ['sugar', 170, 'g'], ['bakingPowder', 10, 'g'],
      ['eggs', 3, 'units'], ['milk', 190, 'ml'], ['oil', 105, 'ml']],
    optional: []
  },
  eggFreeCake: {
    dish: 'cake', title: 'Egg-free cake with plant milk', servings: 8,
    ingredients: [['flour', 250, 'g'], ['sugar', 170, 'g'], ['bakingPowder', 12, 'g'],
      ['plantMilk', 260, 'ml'], ['oil', 110, 'ml']],
    optional: []
  },
  pancakes: {
    dish: 'pancakes', title: 'Simple pancakes', servings: 3,
    ingredients: [['flour', 180, 'g'], ['milk', 225, 'ml'], ['eggs', 2, 'units'],
      ['bakingPowder', 8, 'g'], ['oil', 15, 'ml']],
    optional: [['sugar', 12, 'g']]
  },
  chickenRice: {
    dish: 'chicken and rice', title: 'Chicken and rice dinner', servings: 4,
    ingredients: [['chicken', 600, 'g'], ['rice', 300, 'g'], ['oil', 20, 'ml']],
    optional: [['salt', 5, 'g']]
  },
  pasta: {
    dish: 'pasta', title: 'Pasta with tomato sauce', servings: 4,
    ingredients: [['pasta', 400, 'g'], ['sauce', 400, 'g']],
    optional: [['basil', 10, 'g']]
  }
};
