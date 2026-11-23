import { assertShoppingPlanCoverage as assertDirectPlan } from './smartcart-request-coverage.mjs';
import { assertRecipeShoppingPlan, RECIPE_PLAN_TYPE, recognizeRequestIntent } from './smartcart-recipe-planner.mjs';

export function assertShoppingPlanCoverage(plan) {
  if (plan?.planType === RECIPE_PLAN_TYPE) {
    const verified = assertRecipeShoppingPlan(plan, assertDirectPlan);
    if (typeof verified.status === 'string' && verified.status !== 'READY') {
      throw new Error(`Shopping plan needs clarification. ${verified.questions?.join(' ') ?? ''}`.trim());
    }
    return verified;
  }
  if (plan?.planType !== undefined) throw new Error('Unsupported shopping plan type.');
  if (typeof plan?.userRequest === 'string' && recognizeRequestIntent(plan.userRequest).intent !== 'DIRECT_SHOPPING') {
    throw new Error('Generate a recipe or clarification plan from the original request before searching.');
  }
  return assertDirectPlan(plan);
}
