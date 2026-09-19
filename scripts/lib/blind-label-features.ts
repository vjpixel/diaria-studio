/**
 * blind-label-features.ts (#8413 — Fase 0 do epic #8412)
 *
 * Registro de FEATURES do harness de gabarito cego genérico
 * (`scripts/lib/blind-label-core.ts`). Cada medição futura do epic (#8414+)
 * adiciona sua própria entrada aqui — este arquivo só precisa conter a
 * feature usada pela reprodução do #8211 nesta issue (#8413).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { categorizeWithRule, categoryToBucket, isFallbackCategorizationRule, type Bucket } from "./launch-heuristics.ts";
import { enumerateEditionDirs } from "./find-current-edition.ts";
import { tokenizeForJaccard, jaccardSimilarity, thresholdForPair } from "./title-similarity.ts";
import type { FeatureDef, PoolItem } from "./blind-label-core.ts";

const BUCKETS = ["lancamento", "radar", "use_melhor"] as const;

/**
 * Feature `bucket-tiebreaker-8211` — generaliza a lógica hardcoded do
 * `scripts/blind-label-sample.ts` original (#5995/#8206): pool = itens do
 * SILÊNCIO (categorizado == aprovado, nunca tocados pelo editor no gate),
 * estrato = bucket que saiu na edição, palpite oculto = bucket do
 * categorizador. Reusada pela reprodução do gabarito do #8211 exigida pelo
 * critério de pronto do #8413 (mesma pergunta, `scripts/lib/jev-questions.ts`
 * → `BUCKET_TIEBREAKER_8211`).
 */
export const BUCKET_TIEBREAKER_8211_FEATURE: FeatureDef = {
  id: "bucket-tiebreaker-8211",
  labels: [...BUCKETS, "nao_pertence"],
  optOutLabels: ["nao_pertence"],
  collectPool(rootDir: string) {
    const editionsRoot = join(rootDir, "data", "editions");
    const pool: PoolItem[] = [];
    const skipped: string[] = [];
    if (!existsSync(editionsRoot)) return { pool, skipped };

    const seen = new Set<string>();
    for (const [edition, dir] of enumerateEditionDirs(editionsRoot)) {
      const pa = join(dir, "_internal", "01-approved.json");
      const pc = join(dir, "_internal", "01-categorized.json");
      if (!existsSync(pa) || !existsSync(pc)) continue;
      let A: Record<string, unknown>;
      let C: Record<string, unknown>;
      try {
        A = JSON.parse(readFileSync(pa, "utf8"));
        C = JSON.parse(readFileSync(pc, "utf8"));
      } catch (e) {
        skipped.push(`${edition} (${e instanceof Error ? e.message.slice(0, 60) : "JSON inválido"})`);
        continue;
      }
      const catOf = (url: string): Bucket | null => {
        for (const b of BUCKETS) for (const a of ((C[b] as any[]) ?? [])) if (a?.url === url) return b;
        return null;
      };
      for (const b of BUCKETS) {
        for (const a of ((A[b] as any[]) ?? [])) {
          if (!a?.url || !a?.title) continue;
          if (seen.has(a.url)) continue;
          if (catOf(a.url) !== b) continue; // moveu → é decisão, não silêncio
          seen.add(a.url);
          const r = categorizeWithRule(a);
          const hiddenGuess = categoryToBucket(r.category);
          pool.push({
            id: a.url,
            display: {
              url: a.url,
              title: a.title,
              source: String(a.source ?? ""),
              summary: String(a.summary ?? "").slice(0, 300),
              edition,
            },
            jevState: { title: a.title, url: a.url, summary: String(a.summary ?? "") },
            stratum: b,
            hiddenGuess,
            hiddenRule: r.rule,
            edition,
          });
        }
      }
    }
    return { pool, skipped };
  },
};

/** Só entradas mecânicas usadas por `--tiebreaker-source` (para filtrar por regra fallback, ver `jev-eval.ts`). */
export { isFallbackCategorizationRule };

const NEGATIVE_IMPACT_LABELS = ["dano_real", "nao_dano"] as const;

/**
 * Feature `negative-impact-8414` (#8414, medição 1 do epic #8412) — pool =
 * todo artigo aprovado (`01-approved.json`, buckets `lancamento`/`radar`/
 * `use_melhor`/`highlights`) de cada edição do corpus, com `negative_impact`
 * booleano gravado pelo `scorer-chunk` (Sonnet) no momento do scoring.
 * Estrato/palpite oculto = a própria tag do mecanismo atual
 * (`dano_real` quando `negative_impact === true`, `nao_dano` caso contrário)
 * — é isso que a medição compara contra o Jev (pergunta tipo `noul`,
 * `scripts/lib/jev-questions.ts` → `NEGATIVE_IMPACT_8414`).
 *
 * `01-approved.json` já é o snapshot PÓS-gate (itens que o editor manteve),
 * então o pool não distingue "promovido pelo backstop" de "já veio com a tag
 * do scorer" — `01-approved.json` não registra proveniência da promoção
 * (`negative-impact-promotion.ts` não persiste esse evento em disco em
 * nenhuma edição do corpus atual, checado ao vivo em 19/09/2026). A medição
 * trata os dois casos igual: o que importa pro veredito é se a tag FINAL
 * (`negative_impact === true`, veio ela de onde vier) concorda com o Jev e
 * com o rótulo do editor — não a origem da tag.
 */
export const NEGATIVE_IMPACT_8414_FEATURE: FeatureDef = {
  id: "negative-impact-8414",
  labels: [...NEGATIVE_IMPACT_LABELS],
  collectPool(rootDir: string) {
    const editionsRoot = join(rootDir, "data", "editions");
    const pool: PoolItem[] = [];
    const skipped: string[] = [];
    if (!existsSync(editionsRoot)) return { pool, skipped };

    const seen = new Set<string>();
    for (const [edition, dir] of enumerateEditionDirs(editionsRoot)) {
      const pa = join(dir, "_internal", "01-approved.json");
      if (!existsSync(pa)) continue;
      let A: Record<string, unknown>;
      try {
        A = JSON.parse(readFileSync(pa, "utf8"));
      } catch (e) {
        skipped.push(`${edition} (${e instanceof Error ? e.message.slice(0, 60) : "JSON inválido"})`);
        continue;
      }
      const buckets = ["lancamento", "radar", "use_melhor", "highlights"] as const;
      for (const b of buckets) {
        for (const raw of ((A[b] as any[]) ?? [])) {
          // `highlights` pode envolver o artigo em `.article`; os demais buckets são flat.
          const a = raw?.article ?? raw;
          if (!a?.url || !a?.title) continue;
          if (seen.has(a.url)) continue;
          seen.add(a.url);
          // Checa AS DUAS localizações (flat e `.article` aninhado), nunca só a
          // resolvida por `a` acima — mesmo padrão de `hasNegativeImpactTag`
          // (`negative-impact-promotion.ts`): a cópia do artigo dentro de um
          // highlight pode ser lossy em relação ao finalist original (#4838),
          // então a tag pode sobreviver numa localização e não na outra.
          const tagged = raw?.negative_impact === true || raw?.article?.negative_impact === true;
          const hiddenGuess = tagged ? "dano_real" : "nao_dano";
          pool.push({
            id: a.url,
            display: {
              url: a.url,
              title: a.title,
              source: String(a.source ?? ""),
              summary: String(a.summary ?? "").slice(0, 400),
              edition,
            },
            jevState: { title: a.title, url: a.url, summary: String(a.summary ?? "") },
            stratum: hiddenGuess,
            hiddenGuess,
            hiddenRule: tagged ? "scorer-chunk:negative_impact=true" : "scorer-chunk:negative_impact!=true",
            edition,
          });
        }
      }
    }
    return { pool, skipped };
  },
};

// ---------------------------------------------------------------------------
// #8417 (medição 4 do epic #8412) — zona cinzenta do dedup e do
// check-highlight-themes: "A e B são a mesma história/tema?"
// ---------------------------------------------------------------------------

interface GrayZoneArticle {
  url: string;
  title: string;
  summary: string;
  source: string;
  edition: string;
}

/** Achata os 6 buckets de `01-categorized.json` numa lista única, dedup por URL (1ª ocorrência vence). */
function flattenCategorizedArticles(edition: string, dir: string): GrayZoneArticle[] {
  const p = join(dir, "_internal", "01-categorized.json");
  if (!existsSync(p)) return [];
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return [];
  }
  const out: GrayZoneArticle[] = [];
  const seen = new Set<string>();
  const buckets = ["highlights", "runners_up", "lancamento", "radar", "use_melhor", "video"] as const;
  for (const b of buckets) {
    for (const raw of ((j[b] as any[]) ?? [])) {
      const a = raw?.article ?? raw;
      if (!a?.url || !a?.title) continue;
      if (seen.has(a.url)) continue;
      seen.add(a.url);
      out.push({ url: a.url, title: a.title, summary: String(a.summary ?? ""), source: String(a.source ?? ""), edition });
    }
  }
  return out;
}

/**
 * Coleta pares cross-edição (A de edição estritamente posterior a B) cujo
 * Jaccard de título cai em `[zoneLo, zoneHi)` — a "zona cinzenta" que o Jev
 * (Noul) vai desempatar (#8417). `hiddenGuess` reflete a decisão que o
 * mecanismo MECÂNICO já toma hoje nesse ponto exato do espectro, usando o
 * MESMO threshold com entity-lowering (`thresholdForPair`) que
 * `scripts/dedup.ts` usa de verdade — não um threshold inventado pra
 * medição.
 *
 * Escopo assumido (decisão registrada aqui, não perguntada — #5321): a
 * medição ignora a janela de edições (3 pro dedup, 10-12 pro
 * check-highlight-themes) e compara QUALQUER par cross-edição do corpus —
 * o que está sob teste é o JULGAMENTO semântico "isto é a mesma
 * história/tema", não a lógica de janela (que não muda nesta medição).
 * `O(n²)` em `allArticles` é aceitável aqui: roda 1x por `--generate`,
 * nunca no caminho de produção.
 */
function collectGrayZonePairs(
  rootDir: string,
  opts: { zoneLo: number; zoneHi: number; stratum: string; sameLabel: string; diffLabel: string; defaultThreshold: number; loweredThreshold: number },
): { pool: PoolItem[]; skipped: string[] } {
  const editionsRoot = join(rootDir, "data", "editions");
  const pool: PoolItem[] = [];
  const skipped: string[] = [];
  if (!existsSync(editionsRoot)) return { pool, skipped };

  const dirs = enumerateEditionDirs(editionsRoot);
  const editions = [...dirs.keys()].sort();
  const allArticles: GrayZoneArticle[] = [];
  for (const e of editions) {
    allArticles.push(...flattenCategorizedArticles(e, dirs.get(e)!));
  }

  const seenPairs = new Set<string>();
  for (const A of allArticles) {
    for (const B of allArticles) {
      if (A.edition <= B.edition) continue; // A estritamente depois de B — evita duplo-conta e par intra-edição
      if (A.url === B.url) continue;
      const pairId = [A.url, B.url].sort().join("|||");
      if (seenPairs.has(pairId)) continue;
      const jac = jaccardSimilarity(tokenizeForJaccard(A.title), tokenizeForJaccard(B.title));
      if (jac < opts.zoneLo || jac >= opts.zoneHi) continue;
      seenPairs.add(pairId);
      const { threshold: effThreshold } = thresholdForPair(A.title, B.title, opts.defaultThreshold, opts.loweredThreshold);
      const hiddenGuess = jac >= effThreshold ? opts.sameLabel : opts.diffLabel;
      pool.push({
        id: pairId,
        display: {
          titleA: A.title, summaryA: A.summary.slice(0, 300), sourceA: A.source, editionA: A.edition,
          titleB: B.title, summaryB: B.summary.slice(0, 300), sourceB: B.source, editionB: B.edition,
        },
        jevState: {
          a: { title: A.title, summary: A.summary, source: A.source },
          b: { title: B.title, summary: B.summary, source: B.source },
        },
        stratum: opts.stratum,
        hiddenGuess,
        hiddenRule: `jaccard=${jac.toFixed(2)} vs threshold=${effThreshold}`,
        edition: A.edition,
      });
    }
  }
  return { pool, skipped };
}

/**
 * Feature `dedup-grayzone-8417` — zona cinzenta de `scripts/dedup.ts`
 * (Pass 1c, subject Jaccard vs. artigo de edição anterior). Threshold real
 * do mecanismo: 0.60 default / 0.55 quando há entidade nomeada
 * compartilhada (`thresholdForPair`, mesmos valores de `dedup.ts`). Zona
 * cinzenta calibrada em `[0.35, 0.70)` — abaixo de 0.35 o Jaccard já é
 * baixo o bastante pra não confundir (mesmo piso do
 * `check-highlight-themes.ts`); 0.70 cobre folga acima do threshold mais
 * alto (0.60) sem entrar na faixa onde o Jaccard já é inequivocamente alto
 * (>=0.75, onde a amostra real não tinha mais candidato "cinzento" — ver
 * relatório da medição na issue #8417).
 */
export const DEDUP_GRAYZONE_8417_FEATURE: FeatureDef = {
  id: "dedup-grayzone-8417",
  labels: ["mesma_historia", "historias_distintas"],
  collectPool(rootDir: string) {
    return collectGrayZonePairs(rootDir, {
      zoneLo: 0.35,
      zoneHi: 0.7,
      stratum: "dedup",
      sameLabel: "mesma_historia",
      diffLabel: "historias_distintas",
      defaultThreshold: 0.6,
      loweredThreshold: 0.55,
    });
  },
};

/**
 * Feature `highlight-themes-grayzone-8417` — zona cinzenta de
 * `scripts/check-highlight-themes.ts` (`JACCARD_THRESHOLD` 0.35 /
 * `JACCARD_THRESHOLD_WITH_ENTITY` 0.25). Zona cinzenta `[0.15, 0.55)`
 * (mesmo piso do `SECONDARY_JACCARD_THRESHOLD` até uma folga acima do
 * threshold principal). Simplificação assumida (registrada, não
 * perguntada — #5321): usa o MESMO `thresholdForPair` do dedup (0.35/0.25
 * em vez de 0.60/0.55) para computar `hiddenGuess` — a lógica de
 * entity-lowering do dedup e do highlight-themes usa o mesmo formato
 * (`thresholdForPair`), só os valores absolutos mudam; não replica os 3
 * gatilhos empilhados (`entity-only`, `saga`) de `check-highlight-themes.ts`
 * porque o critério de pronto da medição é comparar o SINAL PRINCIPAL
 * (Jaccard + entity-lowering), não reproduzir os backstops adicionais.
 */
export const HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE: FeatureDef = {
  id: "highlight-themes-grayzone-8417",
  labels: ["mesmo_tema", "temas_distintos"],
  collectPool(rootDir: string) {
    return collectGrayZonePairs(rootDir, {
      zoneLo: 0.15,
      zoneHi: 0.55,
      stratum: "highlight_themes",
      sameLabel: "mesmo_tema",
      diffLabel: "temas_distintos",
      defaultThreshold: 0.35,
      loweredThreshold: 0.25,
    });
  },
};

export const FEATURE_REGISTRY: Record<string, FeatureDef> = {
  [BUCKET_TIEBREAKER_8211_FEATURE.id]: BUCKET_TIEBREAKER_8211_FEATURE,
  [NEGATIVE_IMPACT_8414_FEATURE.id]: NEGATIVE_IMPACT_8414_FEATURE,
  [DEDUP_GRAYZONE_8417_FEATURE.id]: DEDUP_GRAYZONE_8417_FEATURE,
  [HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE.id]: HIGHLIGHT_THEMES_GRAYZONE_8417_FEATURE,
};

export function getFeature(id: string): FeatureDef | undefined {
  return FEATURE_REGISTRY[id];
}
