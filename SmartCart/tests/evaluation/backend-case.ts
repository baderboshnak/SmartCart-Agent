import type { EvaluationCase } from './types';

export async function recordCase<T>(
  cases: EvaluationCase[],
  definition: Omit<EvaluationCase, 'status' | 'durationMs' | 'actual'>,
  execute: () => T | Promise<T>,
  verify: (result: T) => void
): Promise<void> {
  const started = performance.now();
  let actual: T | undefined;
  try {
    actual = await execute();
    verify(actual);
    cases.push({ ...definition, status: 'pass', actual, durationMs: performance.now() - started });
  } catch (error) {
    cases.push({
      ...definition, status: 'fail', actual, durationMs: performance.now() - started,
      logs: [...(definition.logs ?? []), error instanceof Error ? error.message : String(error)]
    });
  }
}
