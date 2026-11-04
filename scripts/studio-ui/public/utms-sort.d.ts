// Tipos de utms-sort.js (#4463, #12116) — só pro typecheck dos testes
// (tsconfig.test.json); o browser carrega o .js direto, sem build step.

export interface UtmsConversionInput {
  subscribers?: number | null;
  clicks?: number | null;
}

export type UtmsSortColumn = "clicks" | "subscribers" | "conversion";

export interface UtmsMediumBreakdownInput {
  medium?: string | null;
  subscribersByMedium?: Record<string, number> | null;
}

export function computeConversion(row: UtmsConversionInput): number | null;
export function fmtPercent(n: number | null | undefined): string;
export function sortRows<T extends UtmsConversionInput>(
  rows: readonly T[],
  column: UtmsSortColumn | null | undefined,
  direction: "asc" | "desc",
): T[];
export function mediumBreakdownText(row: UtmsMediumBreakdownInput): string;
