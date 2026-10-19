/**
 * Registro da fila COMPLETA de elegíveis por onda do `--daily` + verificador
 * de ordem (#10479, definição de feito do #9824).
 *
 * O snapshot de 30 contatos por onda não permite provar que nenhum incluído
 * tem score menor que um elegível deixado de fora. Este arquivo grava, por
 * onda, score + data de cadastro de TODO elegível, marcando quem entrou.
 */
import Papa from "papaparse";

export interface EligibleQueueRow {
  email: string;
  priority_points?: number | null;
  created?: string | null;
}

export const ELIGIBLE_QUEUE_FIELDS = ["rank", "email", "priority_points", "created", "included"];

/** `ordered` já vem na ordem canônica da fila; os `included` primeiros são o corte do budget. */
export function buildEligibleQueueCsv(ordered: EligibleQueueRow[], includedCount: number): string {
  return Papa.unparse({
    fields: ELIGIBLE_QUEUE_FIELDS,
    data: ordered.map((r, i) => ({
      rank: i + 1,
      email: r.email,
      priority_points: r.priority_points ?? 0,
      created: r.created ?? "",
      included: i < includedCount ? 1 : 0,
    })),
  });
}

export interface EligibleQueueViolation {
  included_email: string;
  included_score: number;
  excluded_email: string;
  excluded_score: number;
}

/** Violação = incluído com score MENOR que algum elegível deixado de fora. */
export function verifyEligibleQueueCsv(csv: string): EligibleQueueViolation[] {
  const rows = Papa.parse<Record<string, string>>(csv, { header: true, skipEmptyLines: true }).data;
  const score = (r: Record<string, string>) => Number(r.priority_points) || 0;
  const included = rows.filter((r) => r.included === "1");
  const excluded = rows.filter((r) => r.included !== "1");
  if (included.length === 0 || excluded.length === 0) return [];
  const topExcluded = excluded.reduce((a, b) => (score(b) > score(a) ? b : a));
  return included
    .filter((r) => score(r) < score(topExcluded))
    .map((r) => ({
      included_email: r.email,
      included_score: score(r),
      excluded_email: topExcluded.email,
      excluded_score: score(topExcluded),
    }));
}
