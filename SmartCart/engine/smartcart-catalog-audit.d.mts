export function auditCatalog(
  products: unknown[],
  options?: { asOf?: string; staleDays?: number; maxExamples?: number }
): Record<string, unknown>;
