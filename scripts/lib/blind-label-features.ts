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

export const FEATURE_REGISTRY: Record<string, FeatureDef> = {
  [BUCKET_TIEBREAKER_8211_FEATURE.id]: BUCKET_TIEBREAKER_8211_FEATURE,
  [NEGATIVE_IMPACT_8414_FEATURE.id]: NEGATIVE_IMPACT_8414_FEATURE,
};

export function getFeature(id: string): FeatureDef | undefined {
  return FEATURE_REGISTRY[id];
}
