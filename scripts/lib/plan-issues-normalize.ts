/**
 * plan-issues-normalize.ts (#4860 — promove o helper introduzido pelo #4817)
 *
 * `plan.json.issues` (overnight/develop) aceita dois shapes observados na
 * prática:
 * - **array** (`/diaria-overnight`, documentado no SKILL.md) — `[{ number, ... }, ...]`.
 * - **dict** (`/diaria-develop`, observado ao vivo em `data/develop/260808b/plan.json`
 *   apesar do SKILL.md dizer "reusa o schema do overnight") — `{ "4800": {...}, "4783": {...} }`,
 *   chaveado pelo número da issue como string, com entradas que tipicamente NÃO têm o
 *   campo `number` (é implícito na chave) nem `batch`/`timeline` (usam `onda`/outros campos
 *   do schema de desbloqueio do develop).
 *
 * `normalizeIssues` resolve os dois formatos para array — TODO consumidor de
 * `plan.issues` deve passar por aqui, nunca ler o campo diretamente. O #4817
 * corrigiu só `scripts/render-overnight-timeline.ts` (que CRASHAVA — `for
 * (const issue of plan.issues)` contra um dict lança `TypeError: ... is not
 * iterable`). O self-review do #4817/#4859 (#4860) achou o MESMO mismatch,
 * sem tratamento, em 4 outros consumidores — esses não crashavam, mas
 * tratavam o dict como se fosse vazio, perdendo o dado silenciosamente:
 * `scripts/overnight-statusline.ts`, `scripts/build-diaria-dashboard-data.ts`,
 * `scripts/studio-ui/studio-round-queue.ts`, `scripts/studio-ui/studio-round.ts`.
 */

/** Qualquer objeto "plan-like" — só precisa ter (ou não) um campo `issues`. */
export interface IssuesBearing<T> {
  issues?: T[] | Record<string, Partial<T> & { number?: number }> | null;
  [key: string]: unknown;
}

/**
 * Normaliza `plan.issues` para array, agnóstico de o `plan.json` de origem
 * ter gravado array (overnight) ou dict chaveado por número (develop,
 * #4817). Uma entrada de dict sem `number` explícito recebe o número
 * derivado da própria chave — `Object.entries` preserva a ordem de inserção
 * para chaves não-numéricas, mas chaves inteiras (o caso aqui) são
 * reordenadas pelo motor JS em ordem numérica ascendente; é uma propriedade
 * do próprio dict do develop, não algo que este normalizador consiga (ou
 * deva) corrigir.
 *
 * Degrada graciosamente: `plan` null/undefined, `issues` ausente/null, ou
 * qualquer valor que não seja array nem objeto → `[]` (nunca lança).
 */
export function normalizeIssues<T>(plan: IssuesBearing<T> | null | undefined): T[] {
  const raw = plan?.issues;
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  return Object.entries(raw).map(([key, issue]) => {
    const number = typeof issue?.number === "number" ? issue.number : Number(key);
    return { ...(issue as object), number } as T;
  });
}
