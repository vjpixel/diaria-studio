/**
 * lib/repeat-theme-check.ts (#8896)
 *
 * Miolo puro de `scripts/check-repeat-theme.ts` — o passo §1w-quint-b
 * ("Repeat-de-tema (fail-soft)") já documentado no playbook do Stage 1
 * (`.claude/agents/orchestrator-stage-1-research.md`, linha 665, campo
 * `repeatTheme` já listado no gate humano §1x) mas cujo script nunca existiu
 * no repo — achado ao vivo investigando a #8896: `repeatTheme` sempre
 * chegava vazio ao gate porque `check-repeat-theme.ts` nunca foi commitado.
 *
 * Caso real que expôs o gap: D1 da edição 260928 (Wired — "agente da OpenAI
 * invadiu o sistema de saúde australiano") era o MESMO evento do D1 da
 * 260925 (Guardian — "Agente rebelde invade sistema de governo"), 3 dias
 * antes — URLs e ângulo de cobertura diferentes, mesmo fato. O dedup "hard"
 * de `scripts/dedup.ts` (Pass 1c, threshold 0.55-0.60 de Jaccard de título)
 * não capturou porque a similaridade de título entre os dois é baixa
 * (~0.22 — títulos parafraseados por fontes diferentes) — correta e
 * intencionalmente abaixo do threshold de REMOÇÃO. O gap não é o threshold
 * de remoção estar errado (removê-lo automaticamente seria falso-positivo
 * caro numa notícia genuinamente diferente); é a ausência de um sinal mais
 * fraco, WARNING-only, que avise o editor sem remover nada — mesmo padrão
 * de `has-negative-impact-highlight` (#3916/#3918, warning nunca bloqueia).
 *
 * Dois sinais, cada um fail-soft/warning-only:
 *
 * 1. **Subject-theme substring match** (mecanismo original #1475, via
 *    `matchesRecentTheme`/`extractPastThemeEntities` de
 *    `past-editions-extract.ts`) — candidato cujo título/summary cita uma
 *    entidade capitalizada do SUBJECT LINE de uma edição das últimas
 *    `window`. Reusa infra existente, sem mudança.
 *
 * 2. **Cross-source event overlap** (#8896, o gap concreto do incidente
 *    real) — Jaccard de título do candidato × título de cada DESTAQUE
 *    (D1/D2/D3, nunca runners_up/pool secundário) das últimas `window`
 *    edições reais salvas em `data/editions/`, com o MESMO ajuste de
 *    threshold por entidade compartilhada do dedup "hard" (`thresholdForPair`,
 *    #1331), mas numa banda BEM mais baixa (`REPEAT_THEME_WARN_THRESHOLD`
 *    0.20, contra 0.55-0.60 do dedup.ts) — o objetivo aqui é avisar, não
 *    remover. 0.20 foi escolhido porque é o menor valor que ainda captura o
 *    caso real medido (Jaccard Wired×Guardian ≈ 0.22) sem cair a ponto de
 *    disparar em qualquer par de manchetes do domínio IA (títulos sem
 *    nenhuma palavra de conteúdo em comum ficam em 0 — ver
 *    `test/repeat-theme-check.test.ts` pro caso negativo).
 */

import {
  tokenizeForJaccard,
  jaccardSimilarity,
  thresholdForPair,
} from "./title-similarity.ts";
import { matchesRecentTheme } from "./past-editions-extract.ts";
import type { PastDestaqueTitle } from "./past-editions-extract.ts";

/** Piso de Jaccard pra warning quando candidato e past NÃO compartilham entidade nomeada. */
export const REPEAT_THEME_WARN_THRESHOLD = 0.2;
/** Piso mais baixo quando compartilham ≥1 entidade nomeada (#1331, mesmo padrão do dedup.ts). */
export const REPEAT_THEME_WARN_THRESHOLD_LOWERED = 0.15;

export interface RepeatThemeCandidate {
  title?: string;
  summary?: string;
  url?: string;
  bucket?: string;
}

export interface RepeatThemeEventMatch {
  candidateTitle: string;
  candidateUrl?: string;
  candidateBucket?: string;
  pastTitle: string;
  pastAammdd: string;
  pastUrl?: string;
  jaccard: number;
  threshold: number;
  sharedEntities: string[];
}

export interface RepeatThemeSubjectMatch {
  candidateTitle: string;
  candidateUrl?: string;
  candidateBucket?: string;
  entity: string;
}

export interface RepeatThemeResult {
  flagged: boolean;
  /** Descrição curta do melhor match (para o campo `theme` esperado pelo gate §1x). */
  theme: string | null;
  eventMatches: RepeatThemeEventMatch[];
  subjectMatches: RepeatThemeSubjectMatch[];
}

/**
 * Sinal 2 (#8896): Jaccard de título do candidato × título de destaque
 * recente. Um match por candidato (o de maior Jaccard, quando ≥ threshold
 * efetivo). Nunca lança — títulos vazios/sem token significativo são
 * silenciosamente ignorados (mesma degeneração de `jaccardSimilarity`).
 */
export function detectEventOverlap(
  candidates: RepeatThemeCandidate[],
  pastDestaques: PastDestaqueTitle[],
  opts: { warnThreshold?: number; loweredThreshold?: number } = {},
): RepeatThemeEventMatch[] {
  const warnThreshold = opts.warnThreshold ?? REPEAT_THEME_WARN_THRESHOLD;
  const loweredThreshold = opts.loweredThreshold ?? REPEAT_THEME_WARN_THRESHOLD_LOWERED;

  const pastTokens = pastDestaques
    .filter((p) => p.title && p.title.trim())
    .map((p) => ({ ...p, tokens: tokenizeForJaccard(p.title) }));
  if (pastTokens.length === 0) return [];

  const matches: RepeatThemeEventMatch[] = [];
  for (const c of candidates) {
    if (!c.title) continue;
    const cTokens = tokenizeForJaccard(c.title);
    if (cTokens.size === 0) continue;

    let best: RepeatThemeEventMatch | null = null;
    for (const p of pastTokens) {
      const sim = jaccardSimilarity(cTokens, p.tokens);
      const { threshold, sharedEntities } = thresholdForPair(
        c.title,
        p.title,
        warnThreshold,
        loweredThreshold,
      );
      if (sim >= threshold && (!best || sim > best.jaccard)) {
        best = {
          candidateTitle: c.title,
          candidateUrl: c.url,
          candidateBucket: c.bucket,
          pastTitle: p.title,
          pastAammdd: p.aammdd,
          pastUrl: p.url,
          jaccard: sim,
          threshold,
          sharedEntities,
        };
      }
    }
    if (best) matches.push(best);
  }
  return matches;
}

/**
 * Sinal 1 (mecanismo original #1475): entidade de tema recente citada no
 * título/summary do candidato. Reusa `matchesRecentTheme` sem alteração.
 */
export function detectSubjectThemeOverlap(
  candidates: RepeatThemeCandidate[],
  pastThemeEntities: Set<string>,
): RepeatThemeSubjectMatch[] {
  if (pastThemeEntities.size === 0) return [];
  const matches: RepeatThemeSubjectMatch[] = [];
  for (const c of candidates) {
    const entity = matchesRecentTheme(c.title ?? "", c.summary ?? "", pastThemeEntities);
    if (entity) {
      matches.push({
        candidateTitle: c.title ?? "(sem título)",
        candidateUrl: c.url,
        candidateBucket: c.bucket,
        entity,
      });
    }
  }
  return matches;
}

/** Combina os 2 sinais no shape `{ flagged, theme }` esperado pelo gate §1x. */
export function buildRepeatThemeResult(
  eventMatches: RepeatThemeEventMatch[],
  subjectMatches: RepeatThemeSubjectMatch[],
): RepeatThemeResult {
  const flagged = eventMatches.length > 0 || subjectMatches.length > 0;
  let theme: string | null = null;
  if (eventMatches.length > 0) {
    const best = [...eventMatches].sort((a, b) => b.jaccard - a.jaccard)[0];
    theme =
      `"${best.candidateTitle}" pode ser o mesmo evento do destaque "${best.pastTitle}" ` +
      `(edição ${best.pastAammdd}, Jaccard ${(best.jaccard * 100).toFixed(0)}%)`;
  } else if (subjectMatches.length > 0) {
    theme = `entidade "${subjectMatches[0].entity}" já apareceu em edição recente (${subjectMatches[0].candidateTitle})`;
  }
  return { flagged, theme, eventMatches, subjectMatches };
}
