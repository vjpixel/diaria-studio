/**
 * scripts/lib/spend-ingest.ts (#5502 Parte B)
 *
 * Núcleo genérico e agnóstico de canal do fluxo "buscar gasto na API do
 * anunciante → normalizar em `SpendRow[]` → mesclar em cima do
 * `spend.csv` existente", extraído de `scripts/lib/google-ads-ingest.ts`
 * (#5237). Antes da extração, o Google era o único canal com ingestão
 * automática — a issue #5502 pede um 2º canal (Microsoft Advertising) e
 * documenta que reescrever a mesma orquestração pela 2ª vez é o sinal de
 * que ela devia ter sido genérica desde o início.
 *
 * O que é genérico (mora aqui): `mergeSpendRows` (idempotente por
 * `(canal, mes)`) e a orquestração fetch→normaliza→merge, sempre fail-soft
 * (`{ kind: "fallback", reason }`, nunca lança — MCP/API indisponível NUNCA
 * pode derrubar `cac-report.ts`, mesma disciplina do #5237).
 *
 * O que é ESPECÍFICO por canal (fica no adaptador, ex:
 * `google-ads-ingest.ts`/`microsoft-ads-ingest.ts`): a forma da resposta
 * bruta da API (GAQL vs Reporting API do Bing Ads), a autenticação
 * (OAuth2 do Google vs Azure AD do Microsoft), e a normalização
 * "resposta bruta → `{mes, valor}`". Um adaptador implementa só
 * `SpendIngestFetcher` (busca + normaliza, devolvendo `SpendRow[]` já no
 * formato final) e chama `runSpendIngest` — o merge nunca é reimplementado.
 */

import type { SpendRow } from "./aquisicao-spend.ts";

/**
 * Funde linhas novas (`incoming`) em cima do conjunto existente lido do
 * `spend.csv` atual: uma linha `incoming` SUBSTITUI qualquer linha
 * `existing` com o mesmo par (`canal`, `mes`) — idempotente em re-execução —
 * e linhas de outros canais/meses são preservadas intactas.
 *
 * @pure
 */
export function mergeSpendRows(existing: SpendRow[], incoming: SpendRow[]): SpendRow[] {
  const key = (r: SpendRow) => `${r.canal} ${r.mes}`;
  const incomingKeys = new Set(incoming.map(key));
  const kept = existing.filter((r) => !incomingKeys.has(key(r)));
  return [...kept, ...incoming].sort((a, b) => a.canal.localeCompare(b.canal) || a.mes.localeCompare(b.mes));
}

/**
 * Resultado de UM fetch+normalize específico de canal — `rows` já no
 * formato final `SpendRow[]` (agregado por mês, com `canal`/`fonte`
 * preenchidos pelo adaptador). `fetchedCount` é livre pro adaptador reportar
 * o que fizer sentido pro seu canal (ex: nº de dias/linhas brutas da API,
 * distinto do nº de `SpendRow` agregados por mês) — só usado em log/retorno,
 * nunca pela lógica de merge.
 */
export type SpendIngestFetchResult =
  | { kind: "ok"; rows: SpendRow[]; fetchedCount: number }
  | { kind: "error"; reason: string };

/** Um adaptador de canal implementa isto: busca na API + normaliza pro
 *  formato `SpendRow[]`, nunca lançando (fail-soft é responsabilidade do
 *  PRÓPRIO adaptador — ver `google-ads-ingest.ts`/`microsoft-ads-ingest.ts`
 *  pro padrão de "toda etapa de rede devolve `{error}` em vez de lançar"). */
export type SpendIngestFetcher = () => Promise<SpendIngestFetchResult>;

export interface RunSpendIngestOptions {
  fetcher: SpendIngestFetcher;
  existingRows: SpendRow[];
}

export type SpendIngestResult =
  | { kind: "updated"; rows: SpendRow[]; fetchedCount: number }
  | { kind: "fallback"; reason: string };

/**
 * Orquestra fetch → merge, sempre fail-soft: qualquer falha do `fetcher`
 * (rede/auth/API — env ausente é responsabilidade do CLI checar antes de
 * chamar isto) devolve `{ kind: "fallback", reason }` em vez de lançar — o
 * CLI decide o que logar, mas NUNCA quebra o relatório (`cac-report.ts`
 * segue lendo o `spend.csv` manual intocado).
 */
export async function runSpendIngest(opts: RunSpendIngestOptions): Promise<SpendIngestResult> {
  const result = await opts.fetcher();
  if (result.kind === "error") return { kind: "fallback", reason: result.reason };
  if (result.rows.length === 0) {
    return { kind: "fallback", reason: "fetch não devolveu nenhuma linha com custo — nada pra atualizar" };
  }
  const merged = mergeSpendRows(opts.existingRows, result.rows);
  return { kind: "updated", rows: merged, fetchedCount: result.fetchedCount };
}
