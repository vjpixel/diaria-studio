#!/usr/bin/env tsx
/**
 * promote-to-destaque.ts (#8757)
 *
 * Promove um item do pool (RADAR / USE MELHOR / LANÇAMENTOS / vídeo — qualquer
 * bucket de `01-approved.json` fora de `highlights[]`) a destaque numa edição
 * de 2 destaques, INSERINDO na posição pedida e deslocando os existentes
 * (ex: `--position 1` → D1 antigo vira D2, D2 antigo vira D3).
 *
 * Por que existe: `reorder-destaques.ts` só aceita permutação dos destaques
 * JÁ existentes. Na edição 260924 a promoção de um item do RADAR a D1 foi
 * feita à mão — rodízio de `04-d{N}-*` no OneDrive (sumiram 7 arquivos,
 * mesma causa já documentada em #8058/#8679), `01-approved*.json` esquecido
 * (`upload-images-public` nunca subiu o `d3_2x1`) e `02-d{N}-prompt.md`
 * trocado de slot.
 *
 * Mecanismo: a inserção É uma permutação de [1,2,3] em que o slot 3 — que
 * numa edição de 2 destaques não existe — gira para a posição nova
 * (`--position 1` ⇒ newOrder [3,1,2]). Todo o movimento de arquivo reusa os
 * helpers já verificados de `reorder-destaques.ts` (`stageAndWriteVerified`,
 * #5564 — staging local, nunca nome temporário dentro do `data/`), e como o
 * `d3` antigo não existe, o slot novo simplesmente fica vazio.
 *
 * O que ESTE script faz (mecânico):
 *   1. `04-d{N}-*` e `_internal/02-d{N}-{prompt.md,sd-prompt.json,draft.md}`
 *      deslocados;
 *   2. `01-approved.json` + `01-approved-capped.json`: item removido do
 *      bucket de origem e inserido em `highlights[]` na posição, ranks
 *      renumerados 1..3;
 *   3. `02-reviewed.md`: headers `**DESTAQUE N |` renumerados (N≥posição → N+1);
 *   4. `03-social.md`: seções `## d{N}` renumeradas;
 *   5. `_internal/intentional-error.json` (`location`), carimbos de social/
 *      carrossel, `fact-check-sources/`, `04-crop-review.json`,
 *      `06-public-images.json` (chaves das posições deslocadas invalidadas).
 *
 * O que NÃO faz (exige LLM, geração de imagem ou decisão editorial — sai
 * como `next_steps` no JSON):
 *   - escrever o bloco `**DESTAQUE {posição}**` em `02-reviewed.md`
 *     (`writer-destaque`) e o `## d{posição}` em `03-social.md`;
 *   - escrever `_internal/02-d{posição}-prompt.md` e gerar a imagem
 *     (`image-generate.ts --destaque d{posição}`), cards, carrossel e upload.
 *
 * Edição já com 3 destaques: recusa (exit 2). Pela regra do #3369, promover
 * com 3 destaques é SUBSTITUIR um existente, não inserir — outra operação.
 *
 * Uso:
 *   npx tsx scripts/promote-to-destaque.ts --edition-dir data/editions/2609/260924 \
 *     --url https://exemplo.com/artigo --position 1 [--dry-run]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsWithTrueDefault, isMainModule } from "./lib/cli-args.ts";
import {
  renameDestaqueImages,
  renameDestaquePrompts,
  reorderSocialMd,
  updateIntentionalErrorLocationJson,
  refreshSocialSourceHash,
  reindexCarouselSourceHashes,
  reorderFactCheckSources,
  reorderCropReviewJson,
  invalidatePublicImagesForReorder,
} from "./reorder-destaques.ts";
import {
  loadIntentionalErrorJson,
  writeIntentionalErrorJson,
  intentionalErrorJsonPath,
} from "./lib/intentional-errors.ts";

/** Pure: newOrder que insere o slot vazio (3) na `position` (1..3). */
export function insertionOrder(position: number): number[] {
  if (![1, 2, 3].includes(position)) throw new Error(`--position precisa ser 1, 2 ou 3 (recebido: ${position})`);
  const existing = [1, 2];
  return [...existing.slice(0, position - 1), 3, ...existing.slice(position - 1)];
}

type ApprovedJson = { highlights?: unknown[]; [bucket: string]: unknown };

function sameUrl(a: unknown, url: string): boolean {
  return typeof a === "string" && a.trim() === url.trim();
}

/**
 * Pure: remove o item com `url` de qualquer bucket fora de `highlights` e o
 * insere em `highlights` na `position`, renumerando `rank`. Retorna o bucket
 * de origem, ou `null` se a URL não estiver em nenhum bucket (nada muda).
 * Lança se a URL já for destaque ou se `highlights` não tiver 2 itens.
 */
export function promoteInApprovedJson(
  json: ApprovedJson,
  url: string,
  position: number,
): { sourceBucket: string } | null {
  const h = json.highlights;
  if (!Array.isArray(h)) throw new Error("01-approved: `highlights` ausente");
  if (h.some((x) => sameUrl((x as { url?: unknown })?.url, url))) {
    throw new Error(`a URL já é destaque: ${url}`);
  }
  if (h.length !== 2) {
    throw new Error(
      `a edição tem ${h.length} destaque(s); promover com inserção só vale para 2 → 3. ` +
        `Com 3 destaques, promover é SUBSTITUIR um existente (#3369) — outra operação.`,
    );
  }
  for (const [bucket, items] of Object.entries(json)) {
    if (bucket === "highlights" || !Array.isArray(items)) continue;
    const idx = items.findIndex((it) => sameUrl((it as { url?: unknown })?.url, url));
    if (idx < 0) continue;
    const [article] = items.splice(idx, 1) as Record<string, unknown>[];
    const highlight = {
      rank: position,
      score: article.score ?? null,
      bucket: typeof article.category === "string" ? article.category : bucket,
      url: article.url,
      article,
    };
    h.splice(position - 1, 0, highlight);
    h.forEach((x, i) => {
      if (x && typeof x === "object") (x as { rank?: number }).rank = i + 1;
    });
    return { sourceBucket: bucket };
  }
  return null;
}

/** Pure: renumera headers `**DESTAQUE N |` com N ≥ position para N+1. */
export function shiftDestaqueHeadersInMd(md: string, position: number): string {
  return md.replace(/^\*\*DESTAQUE\s+(\d+)(\s*\|)/gm, (full, n: string, rest: string) => {
    const num = parseInt(n, 10);
    return num >= position ? `**DESTAQUE ${num + 1}${rest}` : full;
  });
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
}

export interface PromoteResult {
  position: number;
  new_order: number[];
  source_bucket: string;
  dry_run: boolean;
  rewritten: string[];
  renamed: Array<{ from: string; to: string }>;
  warnings: string[];
  next_steps: string[];
}

export function promoteToDestaque(
  editionDir: string,
  url: string,
  position: number,
  dryRun = false,
): PromoteResult {
  const internalDir = resolve(editionDir, "_internal");
  const newOrder = insertionOrder(position);
  const rewritten: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  const warnings: string[] = [];

  // 0. Valida e prepara os JSONs ANTES de mexer em qualquer arquivo — URL
  //    ausente ou edição com 3 destaques abortam sem efeito colateral.
  const approvedPaths = ["01-approved.json", "01-approved-capped.json"]
    .map((f) => resolve(internalDir, f))
    .filter((p) => existsSync(p));
  if (approvedPaths.length === 0) throw new Error(`nenhum 01-approved*.json em ${internalDir}`);
  const updated: Array<{ path: string; data: ApprovedJson }> = [];
  let sourceBucket: string | null = null;
  for (const p of approvedPaths) {
    const data = readJson(p) as ApprovedJson;
    const r = promoteInApprovedJson(data, url, position);
    if (!r) {
      throw new Error(`URL não encontrada em nenhum bucket de ${p}: ${url}`);
    }
    sourceBucket = sourceBucket ?? r.sourceBucket;
    updated.push({ path: p, data });
  }

  // 1. Arquivos binários/prompt primeiro (única etapa capaz de abortar no
  //    meio — mesmo sequenciamento de reorder-destaques.ts, #5087).
  renamed.push(...renameDestaqueImages(editionDir, newOrder, dryRun));
  renamed.push(...renameDestaquePrompts(internalDir, newOrder, dryRun));

  // 2. JSONs canônicos.
  for (const { path, data } of updated) {
    if (!dryRun) writeJson(path, data);
    rewritten.push(path);
  }

  // 3. 02-reviewed.md — só renumera; o bloco novo é do writer-destaque.
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, "utf8");
    const shifted = shiftDestaqueHeadersInMd(md, position);
    if (shifted !== md) {
      if (!dryRun) writeFileSync(mdPath, shifted, "utf8");
      rewritten.push(mdPath);
    }
  }

  // 4. intentional-error.json
  const iePath = intentionalErrorJsonPath(editionDir);
  const ie = loadIntentionalErrorJson(iePath);
  if (ie) {
    const { record, changed } = updateIntentionalErrorLocationJson(ie, newOrder);
    if (changed) {
      if (!dryRun) writeIntentionalErrorJson(iePath, record);
      rewritten.push(iePath);
    }
  }

  // 5. 03-social.md + carimbos.
  const socialPath = resolve(editionDir, "03-social.md");
  if (existsSync(socialPath)) {
    const md = readFileSync(socialPath, "utf8");
    const shifted = reorderSocialMd(md, newOrder);
    if (shifted !== md) {
      if (!dryRun) writeFileSync(socialPath, shifted, "utf8");
      rewritten.push(socialPath);
      const refreshed = refreshSocialSourceHash(editionDir, dryRun);
      if (refreshed) rewritten.push(refreshed.path);
    }
  }
  const carousel = reindexCarouselSourceHashes(editionDir, newOrder, dryRun);
  if (carousel) rewritten.push(carousel.path);

  // 6. fact-check-sources (secundário: falha vira warning, igual ao reorder).
  try {
    const fc = reorderFactCheckSources(internalDir, newOrder, dryRun);
    rewritten.push(...fc.modified);
    renamed.push(...fc.renamed);
  } catch (e) {
    warnings.push(`fact-check-sources/ pode ter ficado parcialmente deslocado: ${(e as Error).message}`);
  }

  // 7. 04-crop-review.json + 06-public-images.json (fail-soft em JSON ruim).
  const cropPath = resolve(internalDir, "04-crop-review.json");
  const publicPath = resolve(editionDir, "06-public-images.json");
  for (const [path, apply] of [
    [cropPath, (d: unknown) => reorderCropReviewJson(d, newOrder)],
    [publicPath, (d: unknown) => invalidatePublicImagesForReorder(d, newOrder)],
  ] as const) {
    if (!existsSync(path)) continue;
    let data: unknown;
    try {
      data = readJson(path);
    } catch (e) {
      warnings.push(`${path} ilegível (${(e as Error).message}), pulando.`);
      continue;
    }
    const r = apply(data);
    if (r.changed) {
      if (!dryRun) writeJson(path, r.data);
      rewritten.push(path);
    }
  }
  if (rewritten.includes(publicPath)) {
    warnings.push("06-public-images.json: chaves das posições deslocadas removidas — rodar upload-images-public.ts de novo.");
  }

  const d = `d${position}`;
  const nextSteps = [
    `Escrever o bloco **DESTAQUE ${position}** em 02-reviewed.md (writer-destaque) a partir do item promovido.`,
    `Escrever a seção ## ${d} em 03-social.md (# Social e # Curto).`,
    `Escrever _internal/02-${d}-prompt.md e gerar a imagem: npx tsx scripts/image-generate.ts --editorial ${editionDir}/_internal/02-${d}-prompt.md --out-dir ${editionDir}/ --destaque ${d}`,
    `Regerar cards/carrossel e subir as imagens: gen-carousel-cards.ts + upload-images-public.ts.`,
    `Rodar check-invariants.ts --stage 4.`,
  ];

  return {
    position,
    new_order: newOrder,
    source_bucket: sourceBucket!,
    dry_run: dryRun,
    rewritten,
    renamed,
    warnings,
    next_steps: nextSteps,
  };
}

function main(): void {
  const args = parseArgsWithTrueDefault(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  const url = args.url;
  const position = parseInt(args.position ?? "", 10);
  if (!editionDir || !url || !Number.isFinite(position)) {
    console.error("Uso: promote-to-destaque.ts --edition-dir <dir> --url <url do item> --position <1|2|3> [--dry-run]");
    process.exit(2);
  }
  try {
    const result = promoteToDestaque(resolve(editionDir), url, position, args["dry-run"] === "true");
    for (const w of result.warnings) console.error(`⚠️  ${w}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`promote-to-destaque: ${(e as Error).message}`);
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
