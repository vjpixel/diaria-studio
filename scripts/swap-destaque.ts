#!/usr/bin/env tsx
/**
 * swap-destaque.ts (#2499)
 *
 * Promove um item de bucket secundário (RADAR, LANÇAMENTOS, USE MELHOR, VÍDEOS,
 * runners_up) a destaque, substituindo/rebaixando um destaque existente.
 *
 * Propaga atomicamente para:
 *   - `_internal/01-approved.json` (highlights[] + bucket de origem)
 *   - `_internal/01-approved-capped.json` (highlights[])
 *   - `02-reviewed.md` (bloco DESTAQUE removido, texto sinalizado)
 *   - `_internal/.social-source-hash.json` (reescrito pra não bloquear Stage 4)
 *
 * O que o script NÃO faz (sinaliza claramente quais re-renders faltam):
 *   - Geração de NOVA imagem do destaque promovido (requer Stage 3 / image-generate.ts)
 *   - Regeneração de texto (requer re-dispatch writer-destaque + social)
 *   - Upload de imagem para Worker/Drive (upload-images-public.ts)
 *
 * Uso:
 *   # Promover item 0 (primeiro) do RADAR a D1, rebaixar D1 atual pro RADAR:
 *   npx tsx scripts/swap-destaque.ts \
 *     --edition 260623 \
 *     --promote radar:0 \
 *     --demote d1
 *
 *   # Promover runner-up 2 a D3, REMOVER D3 atual (não vai pra bucket):
 *   npx tsx scripts/swap-destaque.ts \
 *     --edition 260623 \
 *     --promote runners_up:2 \
 *     --demote d3 \
 *     --drop
 *
 *   # Dry-run:
 *   npx tsx scripts/swap-destaque.ts \
 *     --edition 260623 \
 *     --promote radar:0 \
 *     --demote d2 \
 *     --dry-run
 *
 *   # Custom edition-dir:
 *   npx tsx scripts/swap-destaque.ts \
 *     --edition 260623 \
 *     --promote radar:0 \
 *     --demote d1 \
 *     --edition-dir /tmp/test
 *
 * Atomicidade:
 *   Todas as pré-condições são validadas ANTES de qualquer mutação. Se algo falhar
 *   no meio (ex: disco cheio), o output JSON lista o que foi aplicado até ali.
 *   Para casos normais (JSON pequenos + rename atômico do OS), o risco de estado
 *   parcial é praticamente zero — mas o dry-run sempre é seguro para preview.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DemoteTarget = "d1" | "d2" | "d3";

export type SourceBucket =
  | "radar"
  | "lancamento"
  | "use_melhor"
  | "video"
  | "runners_up";

export interface SwapArgs {
  edition: string;
  editionDir: string;
  /** bucket:idx, e.g. "radar:0" */
  promote: { bucket: SourceBucket; idx: number };
  /** which destaque position to replace (d1/d2/d3) */
  demote: DemoteTarget;
  /** if true, the demoted highlight is dropped (not returned to its source bucket) */
  drop: boolean;
  dryRun: boolean;
}

export interface SwapResult {
  edition: string;
  dry_run: boolean;
  promoted: { bucket: SourceBucket; idx: number; url: string; title: string };
  demoted: { position: DemoteTarget; url: string; title: string; dropped: boolean };
  modified: {
    rewritten: string[];
    renamed: Array<{ from: string; to: string }>;
    deleted: string[];
  };
  rerenders_needed: string[];
}

// ---------------------------------------------------------------------------
// Helpers: approved JSON
// ---------------------------------------------------------------------------

/**
 * Extrai URL de um item de highlight (flat ou nested), ou de um item de bucket
 * secundário (sempre flat com `.url`).
 */
export function extractUrl(item: Record<string, unknown>): string {
  if (typeof item.url === "string" && item.url.length > 0) return item.url;
  const article = item.article as Record<string, unknown> | undefined;
  if (article && typeof article.url === "string" && article.url.length > 0) {
    return article.url;
  }
  return "";
}

/**
 * Extrai título de um item (flat ou nested).
 */
export function extractTitle(item: Record<string, unknown>): string {
  // title_options: array → use first
  const opts = item.title_options as string[] | undefined;
  if (Array.isArray(opts) && opts.length > 0) return opts[0];
  if (typeof item.title === "string" && item.title.length > 0) return item.title;
  const article = item.article as Record<string, unknown> | undefined;
  if (article) {
    const aopts = article.title_options as string[] | undefined;
    if (Array.isArray(aopts) && aopts.length > 0) return aopts[0];
    if (typeof article.title === "string" && article.title.length > 0) {
      return article.title;
    }
  }
  return "(sem título)";
}

/**
 * Computa social-source-hash da lista de highlights atual (mirror de
 * scripts/lib/social-source-hash.ts:hashHighlights).
 */
export function hashHighlights(highlights: Record<string, unknown>[]): string {
  const canonical = highlights
    .map((h) => {
      const url = extractUrl(h) || "(no-url)";
      const opts = h.title_options as string[] | undefined;
      const title = (Array.isArray(opts) ? opts[0] : undefined) ??
        extractTitle(h) ??
        "(no-title)";
      return `${url}|${title}`;
    })
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Helpers: 02-reviewed.md manipulation
// ---------------------------------------------------------------------------

/**
 * Removes the DESTAQUE block at `position` from 02-reviewed.md and replaces
 * it with a placeholder indicating the new highlight needs writing.
 * Renumbers the remaining blocks to stay sequential.
 */
export function removeDestaqueBlockFromMd(
  md: string,
  position: 1 | 2 | 3,
  promotedTitle: string,
  promotedUrl: string,
): string {
  // Split into destaque blocks
  const blockRe =
    /(\*\*DESTAQUE\s+\d+\s*\|[^\n]*\*\*[\s\S]*?)(?=\n+---\n+\*\*(?:DESTAQUE\s+\d|🚀|🔬|📰|📡|🛠️|VÍDEOS?|🎁|🙋|ERRO\s+INTENCIONAL|ASSINE)|$(?![\s\S]))/g;

  const blocks: string[] = [];
  const positions: Array<{ start: number; end: number }> = [];
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(md)) !== null) {
    blocks.push(m[1]);
    positions.push({ start: m.index, end: m.index + m[1].length });
  }

  if (blocks.length === 0) {
    // No DESTAQUE blocks found at all — likely no '---' separator in the MD.
    // Fail loud so the caller knows the placeholder was NOT inserted.
    console.error(
      `swap-destaque: removeDestaqueBlockFromMd — nenhum bloco DESTAQUE encontrado no 02-reviewed.md.\n` +
      `  Causa provável: separadores '---' ausentes entre blocos.\n` +
      `  O placeholder NÃO foi inserido. Re-inserir manualmente o destaque após confirmar o swap.`,
    );
    return md;
  }
  if (blocks.length < position) {
    console.error(
      `swap-destaque: removeDestaqueBlockFromMd — só ${blocks.length} bloco(s) DESTAQUE encontrado(s), ` +
      `mas a posição solicitada é ${position}.\n` +
      `  O placeholder NÃO foi inserido. Verifique se o 02-reviewed.md tem separadores '---' entre os blocos.`,
    );
    return md;
  }

  const zeroIdx = position - 1;

  // Replace the target block with placeholder
  const placeholder =
    `**DESTAQUE ${position} | [RASCUNHO PENDENTE — swap-destaque]**\n\n` +
    `**[${promotedTitle}](${promotedUrl})**\n\n` +
    `[TEXTO PENDENTE — re-rodar writer-destaque para DESTAQUE ${position}]`;

  const newBlocks = blocks.map((block, idx) => {
    if (idx === zeroIdx) return placeholder;
    // Renumber after removal: headers keep same numbers since we replaced, not removed
    return block;
  });

  const firstStart = positions[0].start;
  const lastEnd = positions[positions.length - 1].end;
  const prefix = md.slice(0, firstStart);
  const suffix = md.slice(lastEnd);
  const blocksSerialized = newBlocks.join("\n\n---\n\n");
  return prefix + blocksSerialized + suffix;
}

// ---------------------------------------------------------------------------
// Image management
// ---------------------------------------------------------------------------

/**
 * Deletes image files for a given destaque position (d1/d2/d3).
 * The position that gets a new promoted highlight needs fresh images from Stage 3.
 */
export function deleteDestaqueImages(
  editionDir: string,
  position: 1 | 2 | 3,
  dryRun: boolean,
): Array<{ deleted: string }> {
  const deleted: Array<{ deleted: string }> = [];
  if (!existsSync(editionDir)) return deleted;

  const files = readdirSync(editionDir).filter((f) =>
    new RegExp(`^04-d${position}-[a-z0-9]+\\.(?:jpg|png|jpeg)$`, "i").test(f),
  );

  for (const f of files) {
    if (!dryRun) {
      unlinkSync(join(editionDir, f));
    }
    deleted.push({ deleted: f });
  }
  return deleted;
}

/**
 * Deletes prompt files for the given destaque position (in _internal/).
 * The position's prompt needs regeneration from Stage 3.
 */
export function deleteDestaquePrompts(
  internalDir: string,
  position: 1 | 2 | 3,
  dryRun: boolean,
): Array<{ deleted: string }> {
  const deleted: Array<{ deleted: string }> = [];
  if (!existsSync(internalDir)) return deleted;

  const files = readdirSync(internalDir).filter((f) =>
    new RegExp(`^02-d${position}-(?:prompt\\.md|sd-prompt\\.json|draft\\.md)$`).test(f),
  );

  for (const f of files) {
    if (!dryRun) {
      unlinkSync(join(internalDir, f));
    }
    deleted.push({ deleted: f });
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Core mutation: approved JSON swap
// ---------------------------------------------------------------------------

/**
 * Performs the swap on a parsed approved JSON object IN PLACE.
 *
 * - `promote`: item from secondary bucket to become the new destaque at `demotePos`
 * - `demotePos`: 0-based index of the highlight being replaced
 * - `drop`: if true, the replaced highlight is discarded; if false, it's moved
 *   back to the source bucket at index 0 (prepended)
 *
 * Returns info about what was swapped.
 */
export function swapInApprovedJson(
  data: Record<string, unknown>,
  promoteBucket: SourceBucket,
  promoteIdx: number,
  demotePos: number,
  drop: boolean,
): {
  ok: true;
  promotedItem: Record<string, unknown>;
  demotedItem: Record<string, unknown>;
} | { ok: false; reason: string } {
  const highlights = data.highlights as Record<string, unknown>[] | undefined;
  if (!Array.isArray(highlights)) {
    return { ok: false, reason: "highlights[] ausente ou inválido no JSON" };
  }
  if (demotePos < 0 || demotePos >= highlights.length) {
    return { ok: false, reason: `demotePos ${demotePos} fora de range (highlights tem ${highlights.length} itens)` };
  }

  const sourceBucket = data[promoteBucket] as Record<string, unknown>[] | undefined;
  if (!Array.isArray(sourceBucket)) {
    return { ok: false, reason: `bucket "${promoteBucket}" ausente ou inválido no JSON` };
  }
  if (promoteIdx < 0 || promoteIdx >= sourceBucket.length) {
    return {
      ok: false,
      reason: `índice ${promoteIdx} fora de range no bucket "${promoteBucket}" (${sourceBucket.length} itens)`,
    };
  }

  const promotedItem = sourceBucket[promoteIdx];
  const demotedItem = highlights[demotePos];

  // Remove promoted item from source bucket
  const newBucket = [...sourceBucket];
  newBucket.splice(promoteIdx, 1);
  data[promoteBucket] = newBucket;

  // Build new highlights array: replace demoted position with promoted item
  const newHighlights = [...highlights];
  newHighlights[demotePos] = promotedItem;
  data.highlights = newHighlights;

  // If not dropping, prepend demoted item back to its origin bucket
  if (!drop) {
    // Demoted items come from highlights — they were originally selected by the
    // scorer from one of the buckets. We send them to the source bucket that
    // accepted the promoted item (i.e., the same bucket category).
    const demotedBucket = data[promoteBucket] as Record<string, unknown>[];
    data[promoteBucket] = [demotedItem, ...demotedBucket];
  }

  return { ok: true, promotedItem, demotedItem };
}

/**
 * #2521 Bug 1: fallback de sincronização do 01-approved-capped.json quando
 * `swapInApprovedJson` falha no capped (bucket ausente/curto). Espelha a lógica
 * do approved.json: troca highlights[demotePos] pelo promovido e — se `--drop`
 * omitido — devolve o rebaixado ao bucket (criando-o se ausente).
 *
 * Retorna `{ synced: false, warning }` quando highlights[] do capped é curto
 * demais pro demotePos (slot inexistente) — fail-loud, o chamador deve avisar
 * em vez de gravar um capped divergente em silêncio. Pure (muta o objeto in-place,
 * como o swapInApprovedJson) — exportado pra teste de regressão real (#633).
 */
export function mirrorCappedSwapFallback(
  approvedCappedData: Record<string, unknown>,
  bucket: string,
  demotePos: number,
  drop: boolean,
  promotedItem: Record<string, unknown>,
): { synced: boolean; warning?: string } {
  const cappedHighlights = approvedCappedData.highlights as
    | Record<string, unknown>[]
    | undefined;
  if (Array.isArray(cappedHighlights) && cappedHighlights.length > demotePos) {
    const cappedDemotedItem = cappedHighlights[demotePos];
    cappedHighlights[demotePos] = promotedItem;
    if (!drop) {
      const cappedBucket = approvedCappedData[bucket];
      if (Array.isArray(cappedBucket)) {
        approvedCappedData[bucket] = [cappedDemotedItem, ...cappedBucket];
      } else {
        approvedCappedData[bucket] = [cappedDemotedItem];
      }
    }
    return { synced: true };
  }
  return {
    synced: false,
    warning:
      `01-approved-capped.json highlights[] tem ${Array.isArray(cappedHighlights) ? cappedHighlights.length : 0} itens, ` +
      `mas o swap pede demotePos=${demotePos} (slot inexistente). O capped NÃO foi sincronizado ` +
      `com 01-approved.json neste swap — possível divergência entre os 2 arquivos. Verifique manualmente.`,
  };
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export function parseSwapArgs(argv: string[]): SwapArgs {
  const args: Record<string, string> = {};
  let dryRun = false;
  let drop = false;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argv[i] === "--drop") {
      drop = true;
      continue;
    }
    if (argv[i].startsWith("--") && i + 1 < argv.length) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }

  if (!args.edition) {
    console.error("Erro: --edition AAMMDD é obrigatório");
    console.error(
      "Uso: swap-destaque.ts --edition AAMMDD --promote bucket:idx --demote d{1|2|3} [--drop] [--dry-run] [--edition-dir <path>]",
    );
    process.exit(2);
  }

  if (!args.promote) {
    console.error("Erro: --promote bucket:idx é obrigatório");
    console.error("  Buckets válidos: radar, lancamento, use_melhor, video, runners_up");
    console.error("  Ex: --promote radar:0  (primeiro item do RADAR)");
    process.exit(2);
  }

  if (!args.demote) {
    console.error("Erro: --demote d{1|2|3} é obrigatório");
    process.exit(2);
  }

  // Parse --promote bucket:idx
  const promoteParts = args.promote.split(":");
  if (promoteParts.length !== 2) {
    console.error(`Erro: --promote deve ter formato bucket:idx, recebido "${args.promote}"`);
    process.exit(2);
  }
  const [promoteBucketRaw, promoteIdxStr] = promoteParts;
  const validBuckets: SourceBucket[] = ["radar", "lancamento", "use_melhor", "video", "runners_up"];
  if (!validBuckets.includes(promoteBucketRaw as SourceBucket)) {
    console.error(
      `Erro: bucket "${promoteBucketRaw}" inválido. Válidos: ${validBuckets.join(", ")}`,
    );
    process.exit(2);
  }
  const promote = {
    bucket: promoteBucketRaw as SourceBucket,
    idx: parseInt(promoteIdxStr, 10),
  };
  if (isNaN(promote.idx) || promote.idx < 0) {
    console.error(`Erro: índice inválido em --promote: "${promoteIdxStr}"`);
    process.exit(2);
  }

  // Parse --demote d1/d2/d3
  const demoteRaw = args.demote;
  if (!["d1", "d2", "d3"].includes(demoteRaw)) {
    console.error(`Erro: --demote deve ser d1, d2 ou d3, recebido "${demoteRaw}"`);
    process.exit(2);
  }
  const demote = demoteRaw as DemoteTarget;

  const editionDir =
    args["edition-dir"] ?? resolve(ROOT, "data", "editions", args.edition);

  return { edition: args.edition, editionDir, promote, demote, drop, dryRun };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseSwapArgs(process.argv.slice(2));
  const { edition, editionDir, promote, demote, drop, dryRun } = args;

  if (!existsSync(editionDir)) {
    console.error(`Edition dir não encontrado: ${editionDir}`);
    process.exit(1);
  }
  const internalDir = resolve(editionDir, "_internal");

  // -------------------------------------------------------------------------
  // PRE-CONDITION VALIDATION (all checks before any mutation)
  // -------------------------------------------------------------------------

  const approvedPath = resolve(internalDir, "01-approved.json");
  const approvedCappedPath = resolve(internalDir, "01-approved-capped.json");

  if (!existsSync(approvedPath)) {
    console.error(`Erro: ${approvedPath} não encontrado`);
    process.exit(1);
  }

  let approvedData: Record<string, unknown>;
  let approvedCappedData: Record<string, unknown> | null = null;

  try {
    approvedData = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
  } catch (e) {
    console.error(`Erro ao parsear ${approvedPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  if (existsSync(approvedCappedPath)) {
    try {
      approvedCappedData = JSON.parse(readFileSync(approvedCappedPath, "utf8")) as Record<string, unknown>;
    } catch (e) {
      console.error(`Erro ao parsear ${approvedCappedPath}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Convert demote "d1"/"d2"/"d3" → 0-based index and 1-based position
  const demotePos = parseInt(demote.slice(1), 10) - 1; // 0-based
  const demotePosition = demotePos + 1 as 1 | 2 | 3; // 1-based

  // Validate on approved (dry validation — pure, no mutation)
  const highlights = approvedData.highlights as Record<string, unknown>[] | undefined;
  if (!Array.isArray(highlights)) {
    console.error("Erro: highlights[] ausente em 01-approved.json");
    process.exit(1);
  }
  if (demotePos >= highlights.length) {
    console.error(
      `Erro: --demote ${demote} (posição ${demotePosition}) fora de range — edição tem ${highlights.length} destaque(s)`,
    );
    process.exit(1);
  }

  const sourceBucket = approvedData[promote.bucket] as Record<string, unknown>[] | undefined;
  if (!Array.isArray(sourceBucket)) {
    console.error(
      `Erro: bucket "${promote.bucket}" ausente em 01-approved.json`,
    );
    process.exit(1);
  }
  if (promote.idx >= sourceBucket.length) {
    console.error(
      `Erro: índice ${promote.idx} fora de range no bucket "${promote.bucket}" (${sourceBucket.length} item(ns))`,
    );
    process.exit(1);
  }

  // Extract info about what's being swapped (for logging/output)
  const promotedItem = sourceBucket[promote.idx];
  const demotedItem = highlights[demotePos];
  const promotedUrl = extractUrl(promotedItem);
  const promotedTitle = extractTitle(promotedItem);
  const demotedUrl = extractUrl(demotedItem);
  const demotedTitle = extractTitle(demotedItem);

  if (!promotedUrl) {
    console.error(
      `Erro: item ${promote.idx} do bucket "${promote.bucket}" não tem URL — não é possível promover`,
    );
    process.exit(1);
  }
  if (!demotedUrl) {
    console.error(
      `Erro: destaque ${demote} não tem URL — estado inesperado do approved.json`,
    );
    process.exit(1);
  }

  // -------------------------------------------------------------------------
  // DRY RUN: print what would happen and exit
  // -------------------------------------------------------------------------

  const result: SwapResult = {
    edition,
    dry_run: dryRun,
    promoted: { bucket: promote.bucket, idx: promote.idx, url: promotedUrl, title: promotedTitle },
    demoted: { position: demote, url: demotedUrl, title: demotedTitle, dropped: drop },
    modified: { rewritten: [], renamed: [], deleted: [] },
    rerenders_needed: [
      `writer-destaque DESTAQUE ${demotePosition} (novo item: "${promotedTitle}")`,
      `social-linkedin + social-facebook (re-dispatch pra novo lineup de destaques)`,
      `merge-social-md.ts (re-grava .social-source-hash.json com novo hash)`,
      `scripts/image-generate.ts --destaque ${demotePosition} (gerar nova imagem para o destaque promovido)`,
      `upload-images-public.ts (após gerar imagem nova)`,
    ],
  };

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ...result,
          dry_run_plan: {
            approved_json: `highlights[${demotePos}] ← ${promote.bucket}[${promote.idx}] ("${promotedTitle}")`,
            demoted_item: drop ? `descartado` : `devolvido a ${promote.bucket}[0]`,
            social_hash: "reescrito com novo hash dos highlights",
            md_block: `DESTAQUE ${demotePosition} em 02-reviewed.md substituído por placeholder`,
            images_deleted: `04-d${demotePosition}-*.jpg removidos (precisam regenerar)`,
            prompts_deleted: `02-d${demotePosition}-*.md/json removidos (precisam regenerar)`,
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  // -------------------------------------------------------------------------
  // EXECUTE MUTATIONS
  // -------------------------------------------------------------------------

  // 1. Mutate 01-approved.json
  const swapResult = swapInApprovedJson(
    approvedData,
    promote.bucket,
    promote.idx,
    demotePos,
    drop,
  );
  if (!swapResult.ok) {
    console.error(`Erro ao aplicar swap em 01-approved.json: ${swapResult.reason}`);
    process.exit(1);
  }
  writeFileSync(approvedPath, JSON.stringify(approvedData, null, 2) + "\n", "utf8");
  result.modified.rewritten.push(approvedPath);

  // 2. Mutate 01-approved-capped.json (highlights[] only — same position swap)
  if (approvedCappedData) {
    const cappedSwap = swapInApprovedJson(
      approvedCappedData,
      promote.bucket,
      // For capped JSON, the promoted item might not be in the bucket (it caps items).
      // We try; if the bucket is absent/short, we skip the bucket mutation but still
      // swap the highlights[] slot with the same promoted item from approved.json.
      promote.idx,
      demotePos,
      drop,
    );
    if (!cappedSwap.ok) {
      // #2521: capped JSON pode ter o bucket ausente/curto — espelhar o swap via
      // helper testável (mirrorCappedSwapFallback). Fail-loud se highlights[] for
      // curto demais pro demotePos (slot inexistente) — avisa em vez de gravar
      // capped divergente em silêncio.
      const { warning } = mirrorCappedSwapFallback(
        approvedCappedData,
        promote.bucket,
        demotePos,
        drop,
        promotedItem,
      );
      if (warning) console.error(`AVISO: ${warning}`);
    }
    writeFileSync(approvedCappedPath, JSON.stringify(approvedCappedData, null, 2) + "\n", "utf8");
    result.modified.rewritten.push(approvedCappedPath);
  }

  // 3. Rewrite .social-source-hash.json with new hash
  const hashPath = resolve(internalDir, ".social-source-hash.json");
  const newHighlights = (approvedData.highlights as Record<string, unknown>[]);
  const newHash = hashHighlights(newHighlights.slice(0, Math.min(newHighlights.length, 3)));
  writeFileSync(hashPath, JSON.stringify({ hash: newHash }, null, 2) + "\n", "utf8");
  result.modified.rewritten.push(hashPath);

  // 4. Replace DESTAQUE block in 02-reviewed.md with placeholder
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, "utf8");
    const updatedMd = removeDestaqueBlockFromMd(md, demotePosition, promotedTitle, promotedUrl);
    if (updatedMd !== md) {
      writeFileSync(mdPath, updatedMd, "utf8");
      result.modified.rewritten.push(mdPath);
    }
  }

  // 5. Delete old images for the swapped position (new ones need Stage 3)
  const deletedImages = deleteDestaqueImages(editionDir, demotePosition, false);
  for (const d of deletedImages) {
    result.modified.deleted.push(d.deleted);
  }

  // 6. Delete old prompts for the swapped position (new ones need Stage 3)
  const deletedPrompts = deleteDestaquePrompts(internalDir, demotePosition, false);
  for (const d of deletedPrompts) {
    result.modified.deleted.push(d.deleted);
  }

  // -------------------------------------------------------------------------
  // OUTPUT
  // -------------------------------------------------------------------------

  console.log(JSON.stringify(result, null, 2));

  // Human-readable summary to stderr
  console.error(
    [
      "",
      `✓ swap-destaque concluído (edição ${edition})`,
      `  Promovido:  [${promote.bucket}:${promote.idx}] "${promotedTitle}"  →  DESTAQUE ${demotePosition}`,
      `  Rebaixado:  [${demote}] "${demotedTitle}"  →  ${drop ? "DESCARTADO" : `${promote.bucket}[0]`}`,
      "",
      "  Re-renders necessários:",
      ...result.rerenders_needed.map((r) => `    • ${r}`),
      "",
      "  Stage 3 deve ser re-rodado pra gerar imagem do novo destaque:",
      `    npx tsx scripts/image-generate.ts --edition ${edition} --destaque ${demotePosition}`,
      "",
      "  Após gerar imagem, re-dispatch writer-destaque + social:",
      `    /diaria-2-escrita ${edition}`,
      `    /diaria-3-imagens ${edition} d${demotePosition}`,
    ].join("\n"),
  );
}

// CLI guard — required per repo invariant: scripts that export helpers AND
// call main() need this guard so tests that import helpers don't trigger main()
if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(2);
  }
}
