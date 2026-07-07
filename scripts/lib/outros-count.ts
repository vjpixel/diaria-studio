/**
 * outros-count.ts (#2331/F4, #3052)
 *
 * Shared helper: calcula o total de itens não-destaque da edição
 * (lancamento + radar + use_melhor + video). Esse é o número correto
 * para "mais N destaques" no comment_diaria e post_pixel do LinkedIn.
 *
 * Importado por:
 *   - scripts/publish-linkedin.ts   (Stage 5 — resolve do approved FINAL p/ comment_diaria)
 *   - scripts/resolve-post-pixel.ts (Stage 6 — resolve do approved FINAL p/ post_pixel, #3052)
 *   - scripts/lint-social-numbers.ts (Stage 2 gate — lint deterministico)
 *
 * Manter a formula sincronizada nos pontos de consumo era frágil;
 * este módulo garante compile-time que usam a mesma lógica.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyStage2Caps } from "./apply-stage2-caps.ts";

export interface ApprovedBuckets {
  lancamento?: unknown[];
  radar?: unknown[];
  use_melhor?: unknown[];
  video?: unknown[];
}

/**
 * Conta itens não-destaque do approved JSON.
 * Determinístico — nunca deve ser estimado pelo LLM.
 */
export function outrosCount(approved: ApprovedBuckets): number {
  return (
    (approved.lancamento?.length ?? 0) +
    (approved.radar?.length ?? 0) +
    (approved.use_melhor?.length ?? 0) +
    (approved.video?.length ?? 0)
  );
}

/**
 * #2331/F1-F2-F3 + #3052: Resolve outros_count a partir do estado FINAL da
 * edição em disco (`{editionDir}/_internal/`), com fallback e fail-soft
 * (retorna `null` em vez de lançar — caller decide como reagir).
 *
 * Ordem de tentativa:
 *   1. `01-approved-capped.json` (preferencial — estado FINAL pós-caps do Stage 2)
 *   2. `01-approved.json` (uncapped) com `applyStage2Caps()` aplicado antes de
 *      contar (F2 — evita inflar a contagem com itens que o cap removeu)
 *   3. `null` se nenhum dos dois for legível (F3 — caller nunca deve postar
 *      literal `{outros_count}`; para dispatch automático isso é fail-fast,
 *      para reminders não-bloqueantes o caller pode optar por avisar e seguir)
 *
 * Extraído de `publish-linkedin.ts` (#2331) para reuso por `resolve-post-pixel.ts`
 * (#3052) — `post_pixel` nunca passa pelo dispatch de `publish-linkedin.ts`
 * (postagem manual, #1690), mas precisa da MESMA lógica de resolução.
 */
export function resolveOutrosCountFromEditionDir(editionDir: string): number | null {
  const cappedPath = resolve(editionDir, "_internal", "01-approved-capped.json");
  const uncappedPath = resolve(editionDir, "_internal", "01-approved.json");

  let result: number | null = null;

  // 1ª tentativa: capped (preferencial — estado FINAL)
  if (existsSync(cappedPath)) {
    try {
      const approvedData = JSON.parse(readFileSync(cappedPath, "utf8")) as ApprovedBuckets;
      result = outrosCount(approvedData);
      console.error(`#2319: outros_count resolvido de capped → ${result}`);
    } catch (e) {
      // F1: corrupção no capped NÃO rompe o fluxo — tenta uncapped abaixo
      console.error(`#2319: falha ao parsear 01-approved-capped.json (${(e as Error).message}) — tentando 01-approved.json com caps aplicados`);
    }
  }

  // 2ª tentativa: uncapped com caps aplicados (F2 — evita contagem inflada)
  if (result === null && existsSync(uncappedPath)) {
    try {
      const approvedData = JSON.parse(readFileSync(uncappedPath, "utf8")) as Parameters<typeof applyStage2Caps>[0];
      const { approved: cappedData } = applyStage2Caps(approvedData);
      result = outrosCount(cappedData);
      console.error(`#2319: outros_count resolvido de uncapped+caps → ${result}`);
    } catch (e) {
      console.error(`#2319: falha ao parsear 01-approved.json — ${(e as Error).message}`);
    }
  }

  // F3: nenhum arquivo legível → null. Caller decide (fail-fast ou fail-soft).
  return result;
}
