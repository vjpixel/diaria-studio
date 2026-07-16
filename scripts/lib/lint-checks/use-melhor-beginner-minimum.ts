/**
 * lint-checks/use-melhor-beginner-minimum.ts (#3213)
 *
 * Garante que o bucket USE MELHOR final (pós `apply-stage2-caps.ts`, #358/#2339)
 * tenha pelo menos N itens acessíveis a quem está COMEÇANDO com IA —
 * "iniciante" aqui é definido como classe `casual` (leigo, sem código) OU
 * `dev-iniciante` (onboarding técnico sem infra avançada), nunca `dev-avancado`.
 *
 * Deliberadamente NÃO inventa um critério de nível novo: reusa
 * `classifyAudienceClass` (#2339, `scripts/lib/use-melhor-curation.ts`) — o
 * MESMO classificador que já alimenta o split 2 casual + 2 dev-iniciante de
 * `selectUseMelhorSplit` e o warn de composição de `review-use-melhor.ts`
 * (#2339/#3027/#3059). Duas fontes de verdade pra "o que é iniciante" seria
 * a receita pra divergência silenciosa (um item classificado casual por um
 * critério e dev-avancado por outro).
 *
 * Caso real 260710: edição chegou ao Stage 4 com só 2 itens em USE MELHOR,
 * ambos dev-avancado (comparação de frameworks de orquestração LLM, tuning de
 * harness pra Nemotron 3 Ultra) — nenhum acessível a quem está começando.
 *
 * WARN-ONLY (consistente com toda a família de guards de composição USE
 * MELHOR — #1798/#2339/#3027/#3059 — nenhum bloqueia o pipeline; a seção
 * depende de o pool do dia genuinamente ter conteúdo iniciante, e um hard
 * block arriscaria travar edições legítimas sem candidato suficiente).
 */

import { classifyAudienceClass, type UseMelhorAudienceClass } from "../use-melhor-curation.ts";

export interface BeginnerMinimumItem {
  url?: string;
  title?: string;
  summary?: string;
  audience_affinity?: { matched?: string[] } | null;
  [key: string]: unknown;
}

export interface BeginnerMinimumReport {
  ok: boolean;
  /** Itens classificados como casual ou dev-iniciante ("iniciante-friendly"). */
  beginnerCount: number;
  /** Total de itens no bucket use_melhor avaliado. */
  total: number;
  /** Mínimo exigido (default 2, #3213). */
  min: number;
  /** Classificação individual de cada item — para diagnóstico no gate. */
  breakdown: Array<{ url: string; title?: string; class: UseMelhorAudienceClass }>;
}

const BEGINNER_CLASSES = new Set<UseMelhorAudienceClass>(["casual", "dev-iniciante"]);

/**
 * #3213: `true` quando a classe de audiência do item é acessível a quem está
 * começando com IA (casual OU dev-iniciante — nunca dev-avancado).
 */
export function isBeginnerFriendlyClass(cls: UseMelhorAudienceClass): boolean {
  return BEGINNER_CLASSES.has(cls);
}

/**
 * Avalia se o bucket `use_melhor` (já pós-caps/split — ver
 * `apply-stage2-caps.ts`) tem pelo menos `min` itens acessíveis a iniciantes.
 */
export function checkUseMelhorBeginnerMinimum(
  items: BeginnerMinimumItem[],
  min = 2,
): BeginnerMinimumReport {
  const breakdown: BeginnerMinimumReport["breakdown"] = [];
  let beginnerCount = 0;
  for (const item of items) {
    const cls = classifyAudienceClass(item);
    if (isBeginnerFriendlyClass(cls)) beginnerCount++;
    breakdown.push({
      url: typeof item.url === "string" ? item.url : "",
      title: typeof item.title === "string" ? item.title : undefined,
      class: cls,
    });
  }
  return {
    ok: beginnerCount >= min,
    beginnerCount,
    total: items.length,
    min,
    breakdown,
  };
}
