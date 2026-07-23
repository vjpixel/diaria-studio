/**
 * negative-impact-curation.ts (#3916, #3918)
 *
 * Helper determinístico para garantir que Stage 1 sempre gera ao menos 1
 * candidato de discovery com ângulo de IMPACTO NEGATIVO da IA — risco, dano
 * ou custo real (desinformação/deepfake, golpe, viés/discriminação, impacto
 * no trabalho, privacidade/vigilância, custo ambiental, falha com
 * consequência real, dependência/saúde mental, litígio/regulação punitiva,
 * falha de segurança de modelo).
 *
 * Sem pesquisa dedicada, a regra editorial de "sempre ≥1 destaque de impacto
 * negativo" (context/editorial-rules.md — Destaques) fica refém do acaso do
 * pool do dia: não dá pra selecionar o que não foi encontrado. Segue o mesmo
 * padrão de `getHowToDiscoveryQueries` (#2278, use-melhor-curation.ts) —
 * rotação pseudo-determinística por edição, mesmo mecanismo de dispatch
 * (Path A: fetch-websearch-batch.ts; Path B: discovery-searcher agents).
 *
 * Todos os exports são funções puras, sem I/O, testáveis diretamente.
 */

/**
 * Queries de discovery pro ângulo crítico/impacto-negativo. Cobrem os temas
 * citados na regra editorial (context/editorial-rules.md) sem se repetir —
 * a rotação por edição garante variedade ao longo do tempo em vez de martelar
 * sempre o mesmo tema (ex: só deepfake todo dia).
 */
export const NEGATIVE_IMPACT_DISCOVERY_TOPICS: readonly string[] = [
  // Desinformação / deepfake / golpe
  "golpe com deepfake de IA vítimas prejuízo",
  "desinformação eleitoral gerada por IA impacto real",
  // Viés / discriminação
  "IA discriminação racial ou de gênero caso real",
  // Trabalho
  "empresa demite funcionários citando IA substituição",
  // Privacidade / vigilância
  "vigilância com reconhecimento facial IA abuso direitos",
  // Custo ambiental
  "consumo de energia ou água data center IA impacto ambiental",
  // Falha com consequência real
  "falha de IA causa dano real consequência grave",
  // Dependência / saúde mental
  "dependência de chatbot IA saúde mental risco",
  // Litígio / regulação punitiva
  "processo judicial ou multa regulatória contra empresa de IA",
  // Segurança de modelo
  "vulnerabilidade de segurança em modelo de IA exploração",
];

/**
 * #3916/#3918: retorna as queries de impacto-negativo para discovery nesta
 * edição. Seleção pseudo-determinística por editionNum para variar por dia
 * (mesmo esquema de `getHowToDiscoveryQueries`, #2278).
 *
 * @param editionNum  Número da edição (ex: parseInt("260615") = 260615).
 * @param count       Quantas queries retornar (default 1 — "+1 tema fixo").
 */
export function getNegativeImpactDiscoveryQueries(
  editionNum: number,
  count = 1,
): string[] {
  const total = NEGATIVE_IMPACT_DISCOVERY_TOPICS.length;
  // Guard NaN (e.g. parseInt("") = NaN) — fall back to slot 0, mesmo padrão
  // do #2305 em getHowToDiscoveryQueries.
  const safeBase = Number.isFinite(editionNum) ? editionNum : 0;
  // Clamp count ao tamanho do pool pra evitar duplicatas.
  const safeCount = Math.min(count, total);
  const queries: string[] = [];
  for (let i = 0; i < safeCount; i++) {
    const idx = (safeBase + i) % total;
    queries.push(NEGATIVE_IMPACT_DISCOVERY_TOPICS[idx]);
  }
  return queries;
}
