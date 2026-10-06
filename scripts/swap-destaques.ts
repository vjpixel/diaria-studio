#!/usr/bin/env tsx
/**
 * swap-destaques.ts (#8995)
 *
 * Substitui 1-3 destaques por itens que NÃO estão no pool de
 * `01-approved.json` (URL nova, dada pelo editor no gate — ex: "inclua X
 * como D1 e Y como D2"). Complementa `swap-destaque.ts` (#2499), que só
 * aceita itens JÁ presentes num bucket secundário — o caso descrito na
 * #8995 é justamente quando nenhum dos itens novos veio do pool, e o
 * processo documentado na #8784 continuava 100% manual (escrever
 * `01-approved*.json` à mão, deslocar imagens/prompts, re-render).
 *
 * O que ESTE script faz (mecânico, nas duas `01-approved*.json`):
 *   1. Insere um highlight mínimo `{ rank, score: null, bucket: "manual",
 *      url, article: { url, title, title_options: [title], score: null } }`
 *      na posição pedida, substituindo o destaque existente ali;
 *   2. O destaque substituído volta para o bucket `radar` (índice 0) —
 *      default determinístico (não há bucket de origem do item promovido
 *      pra "trocar de lugar" com ele, ao contrário do swap-destaque.ts;
 *      RADAR é o pool genérico de reentrada, mesmo destino usado quando o
 *      editor demove um D3 manualmente, CLAUDE.md #2316/#2343) — ou é
 *      descartado com `--drop`;
 *   3. Bloco `**DESTAQUE N**` de `02-reviewed.md` substituído por
 *      placeholder `[RASCUNHO PENDENTE]`;
 *   4. Imagens (`04-d{N}-*`) e prompts (`02-d{N}-*`) antigos da posição
 *      removidos (precisam regenerar).
 *
 * O que NÃO faz (exige LLM/agente ou decisão editorial — sai em
 * `next_steps`, mesmo padrão do promote-to-destaque.ts):
 *   - regravar `.social-source-hash.json` (#9149) — de propósito: o
 *     `03-social.md` ainda descreve o destaque antigo, então o guard
 *     `social-hash-fresh` (#1413) TEM que continuar acusando até o `## d{N}`
 *     ser reescrito. O recarimbo vem em `next_steps` logo após o splice do
 *     social, via `refresh-social-hash.ts` (hash da lib
 *     `social-source-hash.ts`, o mesmo que o check do Stage 4 recomputa e que
 *     o `reorder-destaques.ts` grava). Nada impede MECANICAMENTE um recarimbo
 *     prematuro — a ordem é garantida só pelo `next_steps`;
 *   - re-baixar a fonte do destaque novo e invalidar o manifest do
 *     fact-check (`refresh-destaque-sources.ts`, #9102) — 1º passo de
 *     `next_steps`, antes do writer-destaque;
 *   - reescrever o texto de `02-reviewed.md`/`03-social.md` para o novo
 *     destaque (writer-destaque + social-writer/social-curto);
 *   - gerar a imagem 2:1/4:5 + cards de carrossel + upload;
 *   - fact-check e re-render.
 *
 * Uso:
 *   npx tsx scripts/swap-destaques.ts --edition 260929 \
 *     --d1-url https://exemplo.com/artigo-x --d1-title "Título de X" \
 *     --d2-url https://exemplo.com/artigo-y --d2-title "Título de Y" \
 *     [--drop] [--dry-run] [--edition-dir <path>]
 *
 * `--drop` descarta TODOS os destaques substituídos nesta chamada (em vez
 * de devolvê-los ao RADAR) — não há flag por-slot: numa edição real o
 * motivo de descartar (o destaque não serve mais pra lugar nenhum) tende
 * a ser o mesmo para todos os slots trocados na mesma chamada; usar
 * `swap-destaque.ts` ou chamadas separadas para misturar drop/keep.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts"; // #9173
import {
  extractUrl,
  extractTitle,
  toBucketItem,
  removeDestaqueBlockFromMd,
  deleteDestaqueImages,
  deleteDestaquePrompts,
} from "./swap-destaque.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SlotSwap {
  position: 1 | 2 | 3;
  url: string;
  title: string;
}

export interface SwapDestaquesArgs {
  edition: string;
  editionDir: string;
  slots: SlotSwap[];
  drop: boolean;
  dryRun: boolean;
}

export interface SwapDestaquesResult {
  edition: string;
  dry_run: boolean;
  swapped: Array<{
    position: number;
    promoted: { url: string; title: string };
    demoted: { url: string; title: string; dropped: boolean };
  }>;
  modified: {
    rewritten: string[];
    deleted: string[];
  };
  /** Avisos não-fatais — arquivo secundário divergente, placeholder não inserido, etc. */
  warnings: string[];
  next_steps: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Highlight mínimo pra um item que não veio de nenhum bucket do pool. */
export function buildManualHighlight(
  url: string,
  title: string,
  position: number,
): Record<string, unknown> {
  return {
    rank: position,
    score: null,
    bucket: "manual",
    url,
    article: { url, title, title_options: [title], score: null },
  };
}

/**
 * Aplica os swaps em `data.highlights[]` IN PLACE. `slots` já validado sem
 * posições duplicadas pelo parser de CLI, mas a função revalida (chamada
 * também direto em teste). O destaque substituído em cada slot vai para
 * `data.radar[0]` (a menos que `drop`), NUNCA para o bucket original do
 * highlight (não é rastreável de forma confiável — ver docstring do
 * arquivo).
 */
export function swapManualInApprovedJson(
  data: Record<string, unknown>,
  slots: SlotSwap[],
  drop: boolean,
): {
  ok: true;
  demoted: Array<{ position: number; url: string; title: string }>;
} | { ok: false; reason: string } {
  const highlights = data.highlights as Record<string, unknown>[] | undefined;
  if (!Array.isArray(highlights)) {
    return { ok: false, reason: "highlights[] ausente ou inválido no JSON" };
  }

  for (const s of slots) {
    if (s.position < 1 || s.position > highlights.length) {
      return {
        ok: false,
        reason: `posição d${s.position} fora de range (edição tem ${highlights.length} destaque(s))`,
      };
    }
  }
  const positions = slots.map((s) => s.position);
  if (new Set(positions).size !== positions.length) {
    return { ok: false, reason: "posições repetidas entre os slots pedidos" };
  }

  const existingUrls = new Set(highlights.map((h) => extractUrl(h)));
  const newUrls = new Set<string>();
  for (const s of slots) {
    if (!s.url) {
      return { ok: false, reason: `slot d${s.position}: --url vazia` };
    }
    if (!s.title) {
      return { ok: false, reason: `slot d${s.position}: --title vazio` };
    }
    if (existingUrls.has(s.url)) {
      return { ok: false, reason: `a URL já é destaque nesta edição: ${s.url}` };
    }
    if (newUrls.has(s.url)) {
      return { ok: false, reason: `a mesma URL foi pedida em mais de um slot: ${s.url}` };
    }
    newUrls.add(s.url);
  }

  const demoted: Array<{ position: number; url: string; title: string }> = [];
  for (const s of slots) {
    const idx = s.position - 1;
    const demotedItem = highlights[idx];
    demoted.push({
      position: s.position,
      url: extractUrl(demotedItem),
      title: extractTitle(demotedItem),
    });
    highlights[idx] = buildManualHighlight(s.url, s.title, s.position);
    if (!drop) {
      const radar = (data.radar as Record<string, unknown>[] | undefined) ?? [];
      data.radar = [toBucketItem(demotedItem, "radar"), ...radar]; // #9381 + #9601: item de pool é flat
    }
  }
  data.highlights = highlights;

  return { ok: true, demoted };
}

/**
 * `next_steps` impressos após a troca, em ORDEM de execução. #9149: o 1º é o
 * refresh de fontes do #9102 (sem ele o writer-destaque escreve só do título
 * e o fact-checker lê o manifest do destaque ANTIGO); o recarimbo do hash
 * social vem DEPOIS do splice do `03-social.md`, nunca antes.
 */
export function buildSwapNextSteps(editionDir: string, slots: SlotSwap[]): string[] {
  const ds = slots.map((s) => `d${s.position}`).join(", ");
  const dir = editionDir.replace(/\/+$/, "");
  return [
    `Re-baixar a fonte dos destaques novos (${ds}) e invalidar o manifest do fact-check: npx tsx scripts/refresh-destaque-sources.ts --edition-dir ${dir} — rodar UMA vez, antes dos writer-destaque (#9102).`,
    ...slots.map(
      (s) =>
        `Escrever DESTAQUE ${s.position} em 02-reviewed.md (writer-destaque, item: "${s.title}", source_text_path = path da entrada de sources com destaque === ${s.position} no stdout do refresh)`,
    ),
    `social-writer + social-curto em escopo reduzido (${ds}), splice em 03-social.md`,
    `Só DEPOIS do splice: recarimbar o hash social — npx tsx scripts/refresh-social-hash.ts --edition-dir ${dir} (até lá o social-hash-fresh do Stage 4 acusa de propósito, #9149)`,
    ...slots.map(
      (s) =>
        `Escrever _internal/02-d${s.position}-prompt.md e gerar a imagem: npx tsx scripts/image-generate.ts --editorial ${dir}/_internal/02-d${s.position}-prompt.md --out-dir ${dir}/ --destaque d${s.position}`,
    ),
    `gen-carousel-cards.ts + upload-images-public.ts após as imagens novas`,
    `fact-checker completo antes do gate (destaques novos, sem checagem prévia)`,
    `npx tsx scripts/check-invariants.ts --edition-dir ${dir} --stage 4`,
  ];
}

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

export function parseSwapDestaquesArgs(argv: string[]): SwapDestaquesArgs {
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
      "Uso: swap-destaques.ts --edition AAMMDD --d1-url <url> --d1-title <title> " +
        "[--d2-url <url> --d2-title <title>] [--d3-url <url> --d3-title <title>] [--drop] [--dry-run]",
    );
    process.exit(2);
  }

  const slots: SlotSwap[] = [];
  for (const position of [1, 2, 3] as const) {
    const url = args[`d${position}-url`];
    const title = args[`d${position}-title`];
    if (!url && !title) continue;
    if (!url || !title) {
      console.error(
        `Erro: --d${position}-url e --d${position}-title precisam vir juntos (recebido só ${url ? "url" : "title"})`,
      );
      process.exit(2);
    }
    slots.push({ position, url, title });
  }

  if (slots.length === 0) {
    console.error("Erro: pelo menos um par --d{N}-url/--d{N}-title é obrigatório");
    process.exit(2);
  }

  // #3491: mesmo default de swap-destaque.ts — resolveEditionDir acha o dir
  // real (flat ou nested); --edition-dir é o override cru de path completo.
  const editionsRootDir = args["editions-dir"]
    ? resolve(args["editions-dir"])
    : resolve(ROOT, "data", "editions");
  const editionDir =
    args["edition-dir"] ?? resolveEditionDir(editionsRootDir, args.edition);

  return { edition: args.edition, editionDir, slots, drop, dryRun };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function jsonContent(data: unknown): string {
  return JSON.stringify(data, null, 2) + "\n";
}

function main(): void {
  const { edition, editionDir, slots, drop, dryRun } = parseSwapDestaquesArgs(
    process.argv.slice(2),
  );

  if (!existsSync(editionDir)) {
    console.error(`Edition dir não encontrado: ${editionDir}`);
    process.exit(1);
  }
  const internalDir = resolve(editionDir, "_internal");
  const approvedPath = resolve(internalDir, "01-approved.json");
  const approvedCappedPath = resolve(internalDir, "01-approved-capped.json");

  if (!existsSync(approvedPath)) {
    console.error(`Erro: ${approvedPath} não encontrado`);
    process.exit(1);
  }

  let approvedData: Record<string, unknown>;
  try {
    approvedData = readJson(approvedPath);
  } catch (e) {
    console.error(`Erro ao parsear ${approvedPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Pré-condição validada ANTES de qualquer mutação (mesma disciplina do
  // swap-destaque.ts) — se qualquer slot for inválido, nada é escrito.
  const dryCheck = swapManualInApprovedJson(
    JSON.parse(JSON.stringify(approvedData)),
    slots,
    drop,
  );
  if (!dryCheck.ok) {
    console.error(`Erro: ${dryCheck.reason}`);
    process.exit(1);
  }

  const result: SwapDestaquesResult = {
    edition,
    dry_run: dryRun,
    swapped: slots.map((s, i) => ({
      position: s.position,
      promoted: { url: s.url, title: s.title },
      demoted: {
        url: dryCheck.demoted[i].url,
        title: dryCheck.demoted[i].title,
        dropped: drop,
      },
    })),
    modified: { rewritten: [], deleted: [] },
    warnings: [],
    next_steps: [],
  };

  if (dryRun) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // 1. 01-approved.json
  const swapResult = swapManualInApprovedJson(approvedData, slots, drop);
  if (!swapResult.ok) {
    console.error(`Erro ao aplicar swap em 01-approved.json: ${swapResult.reason}`);
    process.exit(1);
  }
  // #9173: as escritas de conteúdo (approved, capped, 02-reviewed.md) são
  // acumuladas e gravadas num LOTE verificado (writeFilesVerified — irmão do
  // stageAndWriteVerified do reorder-destaques) antes de apagar imagens/prompts.
  const pendingWrites: VerifiedWrite[] = [{ path: approvedPath, content: jsonContent(approvedData) }];

  // 2. 01-approved-capped.json (mesmo swap, arquivo separado)
  if (existsSync(approvedCappedPath)) {
    let cappedData: Record<string, unknown>;
    try {
      cappedData = readJson(approvedCappedPath);
    } catch (e) {
      const w = `${approvedCappedPath} ilegível (${(e as Error).message}), não sincronizado.`;
      console.error(`AVISO: ${w}`);
      result.warnings.push(w);
      cappedData = {};
    }
    if (Array.isArray(cappedData.highlights)) {
      const cappedSwap = swapManualInApprovedJson(cappedData, slots, drop);
      if (cappedSwap.ok) {
        pendingWrites.push({ path: approvedCappedPath, content: jsonContent(cappedData) });
      } else {
        const w = `01-approved-capped.json não sincronizado (${cappedSwap.reason}) — possível divergência entre os 2 arquivos.`;
        console.error(`AVISO: ${w}`);
        result.warnings.push(w);
      }
    }
  }

  // .social-source-hash.json — NÃO regravado aqui (#9149). Ver docstring
  // do arquivo, "O que NÃO faz": recarimbar agora desligaria o guard do #1413 com o
  // 03-social.md ainda descrevendo o destaque antigo; o recarimbo está em
  // next_steps, logo depois do splice do social.

  // 3. 02-reviewed.md — placeholder por slot. removeDestaqueBlockFromMd
  // (swap-destaque.ts) falha SILENCIOSO — devolve o md intocado + console.error
  // quando não acha o bloco DESTAQUE da posição pedida — então cada slot é
  // checado individualmente (mesmo padrão que swap-destaque.ts já usa no seu
  // próprio main(): `if (updatedMd !== md)`) em vez de assumir sucesso e
  // marcar o arquivo como reescrito incondicionalmente.
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(mdPath)) {
    let md = readFileSync(mdPath, "utf8");
    let mdChanged = false;
    for (const s of slots) {
      const updated = removeDestaqueBlockFromMd(md, s.position, s.title, s.url);
      if (updated !== md) {
        md = updated;
        mdChanged = true;
      } else {
        result.warnings.push(
          `02-reviewed.md: bloco DESTAQUE ${s.position} não encontrado — placeholder NÃO inserido, texto antigo permanece.`,
        );
      }
    }
    if (mdChanged) {
      pendingWrites.push({ path: mdPath, content: md });
    }
  }

  writeFilesVerified(pendingWrites, "swap-destaques");
  for (const w of pendingWrites) result.modified.rewritten.push(w.path);

  // 4. Imagens e prompts antigos por slot
  for (const s of slots) {
    for (const d of deleteDestaqueImages(editionDir, s.position, false)) {
      result.modified.deleted.push(d.deleted);
    }
    for (const d of deleteDestaquePrompts(internalDir, s.position, false)) {
      result.modified.deleted.push(d.deleted);
    }
  }

  result.next_steps = buildSwapNextSteps(editionDir, slots);

  console.log(JSON.stringify(result, null, 2));
  console.error(
    [
      "",
      `✓ swap-destaques concluído (edição ${edition})`,
      ...result.swapped.map(
        (s) =>
          `  d${s.position}: "${s.promoted.title}" ← NOVO  |  "${s.demoted.title}" → ${s.demoted.dropped ? "DESCARTADO" : "radar[0]"}`,
      ),
      ...(result.warnings.length > 0
        ? ["", "  Avisos:", ...result.warnings.map((w) => `    ⚠️  ${w}`)]
        : []),
      "",
      "  Próximos passos:",
      ...result.next_steps.map((n) => `    • ${n}`),
    ].join("\n"),
  );
}

if (isMainModule(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error("Fatal:", e);
    process.exit(2);
  }
}
