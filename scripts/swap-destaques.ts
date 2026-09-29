#!/usr/bin/env tsx
/**
 * swap-destaques.ts (#8995)
 *
 * Substitui 1-2 destaques por itens que NÃO estão no pool de
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
 *   3. `.social-source-hash.json` reescrito com o novo hash (mesmo
 *      mecanismo do swap-destaque.ts) — evita bloquear o gate por hash
 *      desatualizado, mas NÃO regenera `03-social.md` em si;
 *   4. Bloco `**DESTAQUE N**` de `02-reviewed.md` substituído por
 *      placeholder `[RASCUNHO PENDENTE]`;
 *   5. Imagens (`04-d{N}-*`) e prompts (`02-d{N}-*`) antigos da posição
 *      removidos (precisam regenerar).
 *
 * O que NÃO faz (exige LLM/agente ou decisão editorial — sai em
 * `next_steps`, mesmo padrão do promote-to-destaque.ts):
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
 * de devolvê-los ao RADAR) — não há flag por-slot: numa edição real os dois
 * motivos de descartar (o destaque não serve mais pra lugar nenhum) tendem
 * a ser os mesmos para ambos os slots trocados na mesma chamada; usar
 * `swap-destaque.ts` ou 2 chamadas separadas para misturar drop/keep.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested
import {
  extractUrl,
  extractTitle,
  hashHighlights,
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
  for (const s of slots) {
    if (!s.url) {
      return { ok: false, reason: `slot d${s.position}: --url vazia` };
    }
    if (existingUrls.has(s.url)) {
      return { ok: false, reason: `a URL já é destaque nesta edição: ${s.url}` };
    }
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
      data.radar = [demotedItem, ...radar];
    }
  }
  data.highlights = highlights;

  return { ok: true, demoted };
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

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
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
  writeJson(approvedPath, approvedData);
  result.modified.rewritten.push(approvedPath);

  // 2. 01-approved-capped.json (mesmo swap, arquivo separado)
  if (existsSync(approvedCappedPath)) {
    let cappedData: Record<string, unknown>;
    try {
      cappedData = readJson(approvedCappedPath);
    } catch (e) {
      console.error(`AVISO: ${approvedCappedPath} ilegível (${(e as Error).message}), não sincronizado.`);
      cappedData = {};
    }
    if (Array.isArray(cappedData.highlights)) {
      const cappedSwap = swapManualInApprovedJson(cappedData, slots, drop);
      if (cappedSwap.ok) {
        writeJson(approvedCappedPath, cappedData);
        result.modified.rewritten.push(approvedCappedPath);
      } else {
        console.error(
          `AVISO: 01-approved-capped.json não sincronizado (${cappedSwap.reason}) — possível divergência entre os 2 arquivos.`,
        );
      }
    }
  }

  // 3. .social-source-hash.json
  const hashPath = resolve(internalDir, ".social-source-hash.json");
  const newHighlights = approvedData.highlights as Record<string, unknown>[];
  const newHash = hashHighlights(newHighlights.slice(0, Math.min(newHighlights.length, 3)));
  writeJson(hashPath, { hash: newHash });
  result.modified.rewritten.push(hashPath);

  // 4. 02-reviewed.md — placeholder por slot
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(mdPath)) {
    let md = readFileSync(mdPath, "utf8");
    for (const s of slots) {
      md = removeDestaqueBlockFromMd(md, s.position, s.title, s.url);
    }
    writeFileSync(mdPath, md, "utf8");
    result.modified.rewritten.push(mdPath);
  }

  // 5. Imagens e prompts antigos por slot
  for (const s of slots) {
    for (const d of deleteDestaqueImages(editionDir, s.position, false)) {
      result.modified.deleted.push(d.deleted);
    }
    for (const d of deleteDestaquePrompts(internalDir, s.position, false)) {
      result.modified.deleted.push(d.deleted);
    }
  }

  result.next_steps = [
    ...slots.map(
      (s) =>
        `Escrever DESTAQUE ${s.position} em 02-reviewed.md (writer-destaque, item: "${s.title}")`,
    ),
    `social-writer + social-curto em escopo reduzido (${slots.map((s) => `d${s.position}`).join(", ")}), splice em 03-social.md`,
    `Gerar prompt + imagem por slot: npx tsx scripts/image-generate.ts --edition ${edition} --destaque {N}`,
    `gen-carousel-cards.ts + upload-images-public.ts após as imagens novas`,
    `fact-checker completo antes do gate (destaques novos, sem checagem prévia)`,
    `npx tsx scripts/check-invariants.ts --stage 4`,
  ];

  console.log(JSON.stringify(result, null, 2));
  console.error(
    [
      "",
      `✓ swap-destaques concluído (edição ${edition})`,
      ...result.swapped.map(
        (s) =>
          `  d${s.position}: "${s.promoted.title}" ← NOVO  |  "${s.demoted.title}" → ${s.demoted.dropped ? "DESCARTADO" : "radar[0]"}`,
      ),
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
