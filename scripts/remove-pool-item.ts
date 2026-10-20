#!/usr/bin/env tsx
/**
 * remove-pool-item.ts (#10598)
 *
 * Remove um item do pool (LANÇAMENTOS, RADAR, USE MELHOR, VÍDEOS) de
 * `02-reviewed.md` no gate do Stage 4 — o par de `move-pool-item.ts` (#9680)
 * pra quando o editor corta o item em vez de mudá-lo de seção.
 *
 * Por que existe: na edição 261020 cortar itens à mão deixou a intro
 * "selecionei os N mais relevantes" desatualizada (`intro-count-consistent`)
 * e uma seção LANÇAMENTOS vazia que teve de ser apagada à mão.
 *
 * O que ESTE script faz (mecânico, só em `02-reviewed.md`, gravação verificada):
 *   1. tira o bloco do item (linha do link + descrição) da seção;
 *   2. seção que fica vazia é removida (header + `---`); header singular/plural
 *      ajustado à contagem nova (LANÇAMENTOS → LANÇAMENTO, VÍDEOS → VÍDEO);
 *   3. intro "selecionei os N": recalculada se a contagem real mudou.
 *
 * O que NÃO faz, de propósito:
 *   - NÃO toca `_internal/01-approved.json` nem `01-approved-capped.json`. O
 *     invariante `approved-item-removal` (#8121) proíbe apagar item do
 *     approved no Stage 4 — corrompe o sinal de calibração do categorizador/
 *     scorer. Desreferenciar no MD já basta pro `url-bucket`, que só valida
 *     URLs que aparecem no MD;
 *   - NÃO estima tempo "(N min)" de USE MELHOR — segue manual (decisão do
 *     editor, briefing 261020);
 *   - NÃO re-seleciona/reescreve o 4º post social (`## um`, #9568) quando o
 *     item removido era o escolhido — sai em `next_steps`.
 *
 * Destaques (D1/D2/D3) estão fora: use `swap-destaque.ts`/`promote-to-destaque.ts`.
 *
 * Uso:
 *   npx tsx scripts/remove-pool-item.ts --edition-dir data/editions/2610/261020 \
 *     --url https://exemplo.com/item [--dry-run]
 *
 * Exit: 0 ok; 2 uso errado ou remoção recusada (nada gravado).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsWithTrueDefault, isMainModule } from "./lib/cli-args.ts";
import { writeFilesVerified } from "./lib/write-files-verified.ts";
import type { SectionBucket } from "./lib/section-naming.ts";
import { normalizeUseMelhorUrl, readUseMelhorPostState } from "./lib/use-melhor-post.ts";
import {
  fixSectionHeaderPlurals,
  locatePoolItem,
  reconcileIntroCount,
  removeBlockFromSection,
} from "./move-pool-item.ts";

export interface MdRemoveResult {
  md: string;
  from: SectionBucket;
  section_removed: boolean;
  intro_count: { before: number; after: number } | null;
}

/**
 * Pure: remove o bloco do item com `url` de `02-reviewed.md`. Lança (sem
 * efeito) se a URL não está numa seção do pool.
 */
export function removeItemFromReviewedMd(md: string, url: string): MdRemoveResult {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  const lines = md.replace(/\r\n/g, "\n").split("\n");

  const found = locatePoolItem(lines, url);
  const from = found.sec.bucket;
  const sectionRemoved = removeBlockFromSection(lines, found);
  fixSectionHeaderPlurals(lines, [from]);
  const { md: out, intro_count } = reconcileIntroCount(lines.join("\n"));

  return {
    md: eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out,
    from,
    section_removed: sectionRemoved,
    intro_count,
  };
}

export interface RemovePoolItemResult {
  url: string;
  from: SectionBucket;
  dry_run: boolean;
  rewritten: string[];
  section_removed: boolean;
  intro_count: { before: number; after: number } | null;
  next_steps: string[];
}

export function removePoolItem(
  editionDir: string,
  url: string,
  opts: { dryRun?: boolean } = {},
): RemovePoolItemResult {
  const dryRun = opts.dryRun === true;
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) throw new Error(`02-reviewed.md não encontrado em ${editionDir}`);

  const r = removeItemFromReviewedMd(readFileSync(mdPath, "utf8"), url);
  if (!dryRun) writeFilesVerified([{ path: mdPath, content: r.md }], "remove-pool-item");

  const nextSteps: string[] = [];
  const state = readUseMelhorPostState(editionDir);
  const chosen = state?.item && typeof state.item.url === "string" ? state.item.url : null;
  if (chosen && normalizeUseMelhorUrl(chosen) === normalizeUseMelhorUrl(url)) {
    const dir = editionDir.replace(/\/+$/, "");
    nextSteps.push(
      `O item removido era o do 4º post social (## um, #9568). Re-selecionar: ` +
        `npx tsx scripts/select-use-melhor-post.ts --edition-dir ${dir}/ --reviewed — depois reescrever ` +
        `## um em # Social e # Curto (social-writer/social-curto com use_melhor_post_path), humanizar e ` +
        `regerar os cards (gen-carousel-cards.ts).`,
    );
  }
  nextSteps.push(
    `01-approved.json fica intacto de propósito (#8121). Rodar check-invariants.ts --stage 4.`,
  );

  return {
    url,
    from: r.from,
    dry_run: dryRun,
    rewritten: [mdPath],
    section_removed: r.section_removed,
    intro_count: r.intro_count,
    next_steps: nextSteps,
  };
}

function main(): void {
  const args = parseArgsWithTrueDefault(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  const url = args.url;
  if (!editionDir || !url) {
    console.error("Uso: remove-pool-item.ts --edition-dir <dir> --url <url> [--dry-run]");
    process.exit(2);
  }
  try {
    const result = removePoolItem(resolve(editionDir), url, { dryRun: args["dry-run"] === "true" });
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`remove-pool-item: ${(e as Error).message}`);
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
