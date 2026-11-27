export type EvaluationMode = 'MOCK' | 'REPLAY' | 'LIVE' | 'DETERMINISTIC';
export type EvaluationStatus = 'pass' | 'fail' | 'skip' | 'requires-live';

export interface EvaluationCase {
  id: string;
  title: string;
  status: EvaluationStatus;
  category?: string;
  request?: string;
  expected?: unknown;
  actual?: unknown;
  logs?: string[];
  component?: string;
  durationMs?: number;
  metrics?: Record<string, unknown>;
}

export interface EvaluationSection {
  name: string;
  mode: EvaluationMode;
  cases: EvaluationCase[];
  metrics?: Record<string, unknown>;
  notes?: string[];
}

export async function evaluateCase(
  details: Omit<EvaluationCase, 'status' | 'durationMs'>,
  check: () => Promise<Partial<EvaluationCase>> | Partial<EvaluationCase>
): Promise<EvaluationCase> {
  const started = performance.now();
  try {
    return { ...details, status: 'pass', ...await check(), durationMs: performance.now() - started };
  } catch (error) {
    const failure = error as Error & { actual?: unknown; expected?: unknown };
    return {
      ...details, status: 'fail', durationMs: performance.now() - started,
      actual: failure.actual ?? details.actual ?? String(error),
      expected: details.expected ?? failure.expected,
      logs: [...(details.logs ?? []), String(error)]
    };
  }
}
