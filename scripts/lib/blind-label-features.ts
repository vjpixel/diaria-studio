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

export const FEATURE_REGISTRY: Record<string, FeatureDef> = {
  [BUCKET_TIEBREAKER_8211_FEATURE.id]: BUCKET_TIEBREAKER_8211_FEATURE,
};

export function getFeature(id: string): FeatureDef | undefined {
  return FEATURE_REGISTRY[id];
}
