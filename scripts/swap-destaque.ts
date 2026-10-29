#!/usr/bin/env tsx
/**
 * swap-destaque.ts (#2499)
 *
 * Promove um item de bucket secundário (RADAR, LANÇAMENTOS, USE MELHOR, VÍDEOS,
 * runners_up) a destaque, substituindo/rebaixando um destaque existente.
 *
 * Propaga atomicamente para:
 *   - `_internal/01-approved.json` (highlights[] + bucket de origem) — é o
 *     §4d.1b i+ii do playbook do Stage 4 (#9601): o item que sobe entra no
 *     wrapper de highlight (`toHighlightItem`), o que desce vai FLAT pro
 *     bucket `--demote-to` (`toBucketItem`; default = bucket de origem, exceto
 *     `lancamento` → `radar`), `rank` renumerado; qualquer cópia da URL do
 *     rebaixado em outro bucket de pool sai antes (#9961 — senão o
 *     `url-bucket` acusa `duplicate`), e o pós-check do `url-bucket` põe
 *     qualquer duplicata restante à frente de `rerenders_needed`
 *   - `_internal/01-approved-capped.json` (highlights[])
 *   - `02-reviewed.md` (`applySwapToReviewedMd`, #9601): bloco DESTAQUE vira
 *     placeholder; o item promovido sai da seção de pool de origem (seção
 *     esvaziada sai inteira); o título antigo é trocado pelo novo no
 *     TÍTULO/SUBTÍTULO (cirúrgico, por segmento inteiro na linha da posição —
 *     bloco escrito à mão fica intocado, com aviso; o provisório fica em
 *     `_internal/swap-destaque-titulo-pending.json` até `--finalize-titulo`,
 *     e o invariante `titulo-subtitulo-not-provisional` barra o gate 4
 *     enquanto isso); contagem da intro re-sincronizada
 *   - `_internal/04-estilo-regen.json` (#10335): estado do plano de
 *     regeneração por Noite Estrelada da posição zerado — a imagem nova não
 *     herda o `pending`/contagem da antiga
 *   - `06-public-images.json` (#11252): chaves da posição (hero 2:1, 4:5,
 *     carrossel, legado) removidas — a URL ainda era da arte antiga
 *   - `_internal/carousel-keep-art.json` (#11213): exceção "manter a arte" da
 *     posição removida — era da história rebaixada
 *   - Artefatos do rebaixado (#11529): `02-dN-{draft,prompt}.md`, imagens
 *     `04-dN-*`, sidecars e as chaves removidas de `06-public-images.json` são
 *     MOVIDOS para `_internal/_forensic/swap-{aammdd-hhmm}-dN/` com um
 *     `manifest.json` (url, título, bucket de origem), não apagados. Se o
 *     editor trouxer o item de volta (novo swap promovendo-o à mesma posição),
 *     `--restore dN` devolve arquivos e chaves; sobra só o re-upload
 *     (`lib/swap-destaque-forensic.ts`).
 *
 * O que o script NÃO faz (sinaliza claramente quais re-renders faltam, em
 * ORDEM, no `rerenders_needed` do JSON de saída):
 *   - Regravar `_internal/.social-source-hash.json` (#9169, espelho do #9149) —
 *     de propósito: o `03-social.md` ainda descreve o destaque antigo, então o
 *     guard `social-hash-fresh` (#1413) TEM que continuar acusando até o
 *     `## d{N}` ser reescrito. O recarimbo vem em `rerenders_needed` logo após
 *     o splice do social, via `refresh-social-hash.ts` (hash da lib
 *     `social-source-hash.ts`, o mesmo que o check do Stage 4 recomputa);
 *   - Re-baixar a fonte do destaque promovido e invalidar o manifest do
 *     fact-check (`refresh-destaque-sources.ts`, #9102) — 1º passo;
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
 *   # Depois do writer-destaque: trocar o título provisório (da fonte) pelo
 *   # final no TÍTULO/SUBTÍTULO e limpar o marcador (review PR #9666):
 *   npx tsx scripts/swap-destaque.ts --finalize-titulo --edition-dir <path>
 *
 *   # Depois de trazer o rebaixado de volta à mesma posição (#11529): devolver
 *   # rascunho, prompt, imagens e chaves de 06-public-images.json do backup:
 *   npx tsx scripts/swap-destaque.ts --restore d3 --edition-dir <path> [--from <dir>] [--force]
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
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { normalizeItemTitle } from "./lib/strip-publisher-suffix.ts"; // #9381
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts"; // #9173
import { appendStage4DroppedItems, stage4DroppedItemsPath } from "./lib/stage4-dropped-items.ts"; // #10100
import { clearEstiloRegenDestaques, updateEstiloRegenStateFile } from "./lib/estilo-regen-state.ts"; // #10335
import { planPublicImagesInvalidation, publicImagesInvalidatedWarning } from "./lib/public-images-invalidate.ts"; // #11252
import { clearCarouselKeepArt, updateCarouselKeepArtFile } from "./lib/carousel-keep-art.ts"; // #11213
import { lintIntroCount, replaceIntroClaimedCount } from "./lib/newsletter-count.ts"; // #9601
import { ALL_SECTION_NAMES_PATTERN, sectionHeaderRegex } from "./lib/section-naming.ts"; // #9601
import { extractTitlesFromMd } from "./insert-titulo-subtitulo.ts"; // #9601
import { useMelhorPostReselectStep } from "./lib/use-melhor-post.ts"; // #9755
import { lintNewsletter, type ApprovedJson } from "./lib/lint-checks/url-bucket.ts"; // #9961
import { urlsMatch } from "./lib/url-utils.ts"; // #11497
import {
  backupDemotedDestaque,
  findSwapBackupForUrl,
  listDestaqueImageFiles,
  listDestaquePromptFiles,
  listSwapBackups,
  readPublicImagesForPosition,
  restoreConflicts,
  restoreSwapBackup,
  SWAP_BACKUP_MANIFEST,
  type FoundBackup,
  type SwapBackupManifest,
} from "./lib/swap-destaque-forensic.ts"; // #11529
import {
  replaceTitleInTituloSubtitulo,
  tituloPendingPath,
  parsePendingTitulos,
  serializePendingTitulos,
  upsertPendingTitulo,
  toProvisionalTitulo,
  finalizeProvisionalTitulos,
  type PendingTitulo,
} from "./lib/titulo-provisional.ts"; // #9601 review PR #9666

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
  /** #9601: bucket que recebe o rebaixado (`--demote-to`); default `defaultDemoteBucket(promote.bucket)`. */
  demoteTo: SourceBucket;
  dryRun: boolean;
}

export interface SwapResult {
  edition: string;
  dry_run: boolean;
  promoted: { bucket: SourceBucket; idx: number; url: string; title: string };
  demoted: {
    position: DemoteTarget;
    url: string;
    title: string;
    dropped: boolean;
    /** #9601: bucket de destino (ausente quando `dropped`). */
    to_bucket?: SourceBucket;
  };
  /** #9601: o que o swap ajustou no `02-reviewed.md` além do placeholder. */
  md_updates?: {
    pool_item_removed: boolean;
    section_removed: string | null;
    titulo_subtitulo: "updated" | "no_block" | "old_title_not_found";
    /** #9668: título provisório efetivamente gravado (fonte normalizada, sem `|`). */
    provisional_title: string;
    intro_count: { before: number | null; after: number | null; changed: boolean };
  };
  modified: {
    rewritten: string[];
    renamed: Array<{ from: string; to: string }>;
    deleted: string[];
  };
  rerenders_needed: string[];
  /**
   * #11529: para onde foram os artefatos do rebaixado (`dir: null` = não havia
   * nada a guardar). Restaurar com `--restore dN`.
   */
  backup?: { dir: string | null; files: string[]; public_image_keys: string[] };
  /**
   * #11213: avisos fail-soft dos JSONs secundários (estado do Noite Estrelada,
   * `carousel-keep-art.json` malformado) — mesmo campo de `swap-destaques.ts`
   * e `reorder-destaques.ts` (#8679). Opcional: ausente quando não há aviso.
   */
  warnings?: string[];
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
 * #9381: converte um destaque rebaixado em item de POOL. A manchete de
 * destaque (`title_options`, curta, gancho de e-mail) não serve pro
 * RADAR/LANÇAMENTOS — o editor trocava à mão pelo título da fonte. Remove
 * `title_options` (topo e `article`) e usa o título da FONTE (`article.title`,
 * senão `title`) normalizado via `normalizeItemTitle`. Devolve cópia; não muta.
 *
 * @pure
 */
export function toPoolItem(item: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...item };
  delete out.title_options;
  const article = item.article as Record<string, unknown> | undefined;
  const sourceTitle =
    (article && typeof article.title === "string" && article.title.length > 0
      ? article.title
      : undefined) ??
    (typeof item.title === "string" && item.title.length > 0 ? item.title : undefined);
  // #10313: URL do item deixa o strip reconhecer " - {Veículo}" pelo domínio.
  const itemUrl =
    (article && typeof article.url === "string" ? article.url : undefined) ??
    (typeof item.url === "string" ? item.url : undefined);
  if (article) {
    const a: Record<string, unknown> = { ...article };
    delete a.title_options;
    if (sourceTitle) a.title = normalizeItemTitle(sourceTitle, itemUrl);
    out.article = a;
  }
  if (sourceTitle && (!article || typeof item.title === "string")) {
    out.title = normalizeItemTitle(sourceTitle, itemUrl);
  }
  return out;
}

/**
 * #9601 (§4d.1b passo i): converte o destaque rebaixado no shape do bucket de
 * DESTINO. Itens de pool (`radar`/`lancamento`/`use_melhor`/`video`) são FLAT —
 * o shape de `article`, sem o wrapper `{rank, score, bucket, reason, url,
 * article}` de `highlights[]`; só `runners_up[]` guarda o wrapper (é o shape
 * que `apply-gate-edits.ts::normalizeRunnerUp` produz). Antes o wrapper
 * inteiro ia pro pool, sem `title` no topo.
 *
 * @pure
 */
export function toBucketItem(
  item: Record<string, unknown>,
  bucket: string,
): Record<string, unknown> {
  const pooled = toPoolItem(item); // #9381: tira a manchete, usa o título da fonte
  if (bucket === "runners_up") return pooled;
  const article = pooled.article as Record<string, unknown> | undefined;
  if (!article || typeof article !== "object") return pooled;
  const flat: Record<string, unknown> = { ...article };
  if (typeof flat.url !== "string" || flat.url.length === 0) {
    const url = extractUrl(item);
    if (url) flat.url = url;
  }
  return flat;
}

/**
 * #9601 (§4d.1b passo ii): envolve o item que sobe no wrapper de `highlights[]`
 * — o mesmo shape de `promoteInApprovedJson` (`promote-to-destaque.ts`) e de
 * `buildHighlight` (`apply-gate-edits.ts`), que writer-destaque/publishers leem
 * via `article`. Item que já é wrapper (vindo de `runners_up[]`) só ganha o
 * `rank` novo. Antes o item FLAT do pool entrava cru em `highlights[]`.
 *
 * @pure
 */
export function toHighlightItem(
  item: Record<string, unknown>,
  rank: number,
  bucket: string,
): Record<string, unknown> {
  const article = item.article as Record<string, unknown> | undefined;
  if (article && typeof article === "object") return { ...item, rank };
  const category =
    typeof item.category === "string" && item.category.length > 0
      ? item.category
      : bucket === "runners_up"
        ? "radar"
        : bucket;
  return {
    rank,
    score: (item.score as number | undefined) ?? null,
    bucket: category,
    reason: "promovido do pool pelo editor (swap-destaque, #9601)",
    url: extractUrl(item),
    article: item,
  };
}

/** #9601: renumera `rank` 1..N (só em itens objeto — mesmo laço do promote-to-destaque). */
function renumberRanks(highlights: unknown[]): void {
  highlights.forEach((x, i) => {
    if (x && typeof x === "object") (x as { rank?: number }).rank = i + 1;
  });
}

/**
 * #9601: bucket default do destaque rebaixado quando `--demote-to` não vem.
 * Mantém o comportamento antigo (mesmo bucket do item promovido), EXCETO
 * `lancamento`: LANÇAMENTOS só aceita link oficial (#160), e um destaque
 * rebaixado (tipicamente notícia/cobertura) quebraria `validate-lancamentos`
 * — vai pro RADAR, o destino "típico" do §4d.1b passo i.
 *
 * @pure
 */
export function defaultDemoteBucket(promoteBucket: SourceBucket): SourceBucket {
  return promoteBucket === "lancamento" ? "radar" : promoteBucket;
}

/** Normalização mínima pra comparar URL do MD com a do JSON. */
function normUrl(u: string): string {
  return u.trim().replace(/\/+$/, "");
}

/**
 * #9961: pós-check do swap — roda o mesmo `url-bucket` do gate (#165/#5757)
 * contra o approved recém-mutado e devolve uma linha por URL presente em >1
 * bucket (`found_in_bucket: duplicate`), que o chamador põe à frente de
 * `rerenders_needed`. A duplicata é detectada direto do JSON — não depende de
 * o rebaixado já estar listado no `02-reviewed.md`.
 *
 * @pure
 */
export function urlBucketDuplicateWarnings(
  md: string,
  approved: Record<string, unknown>,
  label: string,
): string[] {
  return lintNewsletter(md, approved as ApprovedJson)
    .errors.filter((e) => e.found_in_bucket === "duplicate")
    .map(
      (e) =>
        `CORRIGIR ANTES DO GATE (#9961): url-bucket acusa ${e.url} duplicada em ${label} ` +
        `(buckets: ${(e.duplicate_buckets ?? []).join(", ")}) — remover a cópia do bucket errado.`,
    );
}

/** #9869/#9961: buckets de pool de `01-approved*.json` (os aceitos por `--demote-to`). */
export const POOL_BUCKETS: readonly SourceBucket[] = ["radar", "lancamento", "use_melhor", "video", "runners_up"];

/**
 * #9869 (movido do swap-destaques.ts no #9961): tira de todos os buckets de
 * pool os itens com a URL dada (comparação sem barra final). `highlights[]`
 * não é tocado. URL vazia → no-op. Muta `data`.
 */
export function removeUrlFromPoolBuckets(data: Record<string, unknown>, url: string): void {
  const key = normUrl(url);
  if (!key) return;
  for (const b of POOL_BUCKETS) {
    const list = data[b];
    if (!Array.isArray(list)) continue;
    data[b] = list.filter(
      (it) => !(it && typeof it === "object" && normUrl(extractUrl(it as Record<string, unknown>)) === key),
    );
  }
}

/**
 * #9601: remove do `02-reviewed.md` a entrada do item PROMOVIDO na seção de
 * pool de onde ele saiu (RADAR/LANÇAMENTOS/USE MELHOR/VÍDEOS) — senão a URL
 * aparece 2× (placeholder do destaque + item do pool) e a contagem da intro
 * fica errada. Só olha seções cujo header é de pool (nunca o bloco DESTAQUE,
 * que agora carrega o placeholder com a mesma URL). Se a seção fica sem
 * nenhum item, ela sai inteira, junto com o separador `---` que a abria
 * (caso 261005: LANÇAMENTOS só tinha a Kolibri).
 *
 * @pure
 */
export function removePoolItemFromMd(
  md: string,
  url: string,
): { md: string; removed: boolean; section_removed: string | null } {
  const target = normUrl(url);
  const lines = md.split("\n");
  const headerRe = sectionHeaderRegex(ALL_SECTION_NAMES_PATTERN, { capture: "name", flags: "u" });
  const itemRe = /^(?:\*\*)?\[.*\]\((https?:\/\/[^)\s]+)\)/;
  const seps: number[] = [];
  lines.forEach((l, i) => {
    if (/^---\s*$/.test(l)) seps.push(i);
  });
  // Fronteiras de seção: [-1, ...seps, lines.length]
  const bounds = [-1, ...seps, lines.length];
  for (let b = 0; b < bounds.length - 1; b++) {
    const start = bounds[b] + 1;
    const end = bounds[b + 1]; // exclusivo
    let h = start;
    while (h < end && lines[h].trim() === "") h++;
    if (h >= end) continue;
    const hm = headerRe.exec(lines[h].trim());
    if (!hm) continue;
    for (let i = h + 1; i < end; i++) {
      const m = itemRe.exec(lines[i]);
      if (!m || normUrl(m[1]) !== target) continue;
      // Item = linha do link até a próxima linha em branco; leva junto as
      // linhas em branco seguintes (sem cruzar o fim da seção).
      let j = i + 1;
      while (j < end && lines[j].trim() !== "") j++;
      while (j < end && lines[j].trim() === "") j++;
      const remaining = [...lines.slice(h + 1, i), ...lines.slice(j, end)];
      const hasItems = remaining.some((l) => itemRe.test(l));
      if (hasItems) {
        // Item do meio/fim: a linha em branco antes dele (ou depois do header)
        // continua separando o que sobra — basta cortar [i, j).
        const out = [...lines.slice(0, i), ...lines.slice(j)];
        return { md: out.join("\n"), removed: true, section_removed: null };
      }
      // Seção esvaziada: corta do `---` que a ABRE até o fim dela; o `---` que
      // a FECHA passa a separar a seção anterior da seguinte. Sem `---` de
      // abertura (seção no topo), corta até o de fechamento, inclusive.
      const out =
        bounds[b] >= 0
          ? [...lines.slice(0, bounds[b]), ...lines.slice(end)]
          : [...lines.slice(0, start), ...lines.slice(Math.min(end + 1, lines.length))];
      return { md: out.join("\n"), removed: true, section_removed: hm[1] };
    }
  }
  return { md, removed: false, section_removed: null };
}

// #9601: `replaceTitleInTituloSubtitulo` (troca por SEGMENTO inteiro, só na
// linha da posição — review da PR #9666) vive em `lib/titulo-provisional.ts`,
// junto do marcador de título provisório e do invariante do Stage 4.
export { replaceTitleInTituloSubtitulo };

/**
 * #9601: re-sincroniza "selecionei os N" da intro com a contagem real, depois
 * do swap (mesma lógica de `sync-intro-count.ts`, sem o I/O). `actual === 0`
 * é bug de parser (#973) — não mexe.
 *
 * @pure
 */
export function syncIntroCountInMd(md: string): {
  md: string;
  before: number | null;
  after: number | null;
  changed: boolean;
} {
  const check = lintIntroCount(md);
  const before = check.claimed ?? null;
  if (check.ok || check.claimed === undefined || check.actual === undefined || check.actual === 0) {
    return { md, before, after: before, changed: false };
  }
  const r = replaceIntroClaimedCount(md, check.actual);
  return { md: r.md, before, after: r.changed ? check.actual : before, changed: r.changed };
}

/**
 * Re-renders impressos após a troca, em ORDEM de execução (#9169, espelho do
 * `buildSwapNextSteps` do swap-destaques.ts, #9149): 1º o refresh de fontes do
 * #9102 (sem ele o writer-destaque escreve só do título e o fact-checker lê o
 * manifest do destaque ANTIGO); o recarimbo do hash social vem DEPOIS do
 * splice do `03-social.md`, nunca antes — e nunca no próprio swap.
 */
export function buildSwapDestaqueSteps(
  editionDir: string,
  position: 1 | 2 | 3,
  promotedTitle: string,
  /** #9601: bucket que recebeu o rebaixado (`null` = `--drop`). */
  demotedTo: SourceBucket | null = null,
): string[] {
  const dir = editionDir.replace(/\/+$/, "");
  const poolStep =
    demotedTo && demotedTo !== "runners_up"
      ? [
          `Incluir o destaque rebaixado como item da seção ${demotedTo} em 02-reviewed.md (formato de item de pool, título da fonte) e re-sincronizar a intro: npx tsx scripts/sync-intro-count.ts --md ${dir}/02-reviewed.md (#9601)`,
          `Depois de incluir o item: conferir o url-bucket (gate-blocking) contra os 2 approved — npx tsx scripts/lint-newsletter-md.ts --md ${dir}/02-reviewed.md --approved ${dir}/_internal/01-approved.json e o mesmo com ${dir}/_internal/01-approved-capped.json (#9961: cópia da URL em outro bucket dá found_in_bucket: duplicate)`,
        ]
      : [];
  return [
    `Re-baixar a fonte do destaque promovido (d${position}) e invalidar o manifest do fact-check: npx tsx scripts/refresh-destaque-sources.ts --edition-dir ${dir} — antes do writer-destaque (#9102).`,
    `writer-destaque DESTAQUE ${position} (novo item: "${promotedTitle}", source_text_path = path da entrada de sources com destaque === ${position} no stdout do refresh)`,
    `Depois de integrar o texto do writer-destaque: trocar no TÍTULO/SUBTÍTULO o título provisório "${toProvisionalTitulo(promotedTitle)}" pelo título final do D${position} — npx tsx scripts/swap-destaque.ts --finalize-titulo --edition-dir ${dir} (até lá o invariante titulo-subtitulo-not-provisional do Stage 4 barra o gate, #9601)`,
    ...poolStep,
    `social-writer + social-curto em escopo reduzido (d${position}), splice em 03-social.md`,
    `Só DEPOIS do splice: recarimbar o hash social — npx tsx scripts/refresh-social-hash.ts --edition-dir ${dir} (até lá o social-hash-fresh do Stage 4 acusa de propósito, #9169)`,
    `Escrever _internal/02-d${position}-prompt.md e gerar a imagem: npx tsx scripts/image-generate.ts --editorial ${dir}/_internal/02-d${position}-prompt.md --out-dir ${dir}/ --destaque d${position}`,
    `gen-carousel-cards.ts + upload-images-public.ts (após gerar imagem nova)`,
    `fact-checker completo antes do gate (destaque novo, sem checagem prévia)`,
    `npx tsx scripts/check-invariants.ts --edition-dir ${dir} --stage 4`,
  ];
}

// ---------------------------------------------------------------------------
// Helpers: 02-reviewed.md manipulation
// ---------------------------------------------------------------------------

/**
 * Bloco placeholder do destaque que ainda precisa do writer-destaque. O header
 * `[RASCUNHO PENDENTE — swap-destaque]` é o que `isSwapPlaceholder`
 * (lib/titulo-provisional.ts) reconhece — #9755: `promote-to-destaque.ts`
 * reusa o mesmo bloco, então o finalize/invariante do título provisório vale
 * igual nas duas operações. @pure
 */
export function renderDestaquePlaceholder(position: 1 | 2 | 3, title: string, url: string): string {
  return (
    `**DESTAQUE ${position} | [RASCUNHO PENDENTE — swap-destaque]**\n\n` +
    `**[${title}](${url})**\n\n` +
    `[TEXTO PENDENTE — re-rodar writer-destaque para DESTAQUE ${position}]`
  );
}

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
  const placeholder = renderDestaquePlaceholder(position, promotedTitle, promotedUrl);

  const newBlocks = blocks.map((block, idx) => {
    // #9254: o lookahead do blockRe só corta antes de `---` seguido de
    // DESTAQUE/seção — uma caixa de divulgação na lacuna (ex: entre D2 e D3,
    // `---\n\n**📚 ...**`) fica DENTRO do bloco do destaque anterior. Só o
    // texto do destaque até o 1º `---` é trocado; a cauda (caixa + seus
    // separadores) é preservada byte a byte.
    if (idx === zeroIdx) {
      const tailIdx = block.search(/\n+---[ \t]*\n/);
      return tailIdx >= 0 ? placeholder + block.slice(tailIdx) : placeholder;
    }
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

/**
 * #9601: aplica ao `02-reviewed.md` TUDO que o swap muda no texto, na ordem:
 * (1) placeholder no bloco DESTAQUE N; (2) tira o item promovido da seção de
 * pool de origem (e a seção, se esvaziar); (3) troca o título antigo pelo novo
 * no TÍTULO/SUBTÍTULO (cirúrgico); (4) re-sincroniza a contagem da intro.
 * O título antigo é lido do MD ANTES do placeholder (é o que o bloco do topo
 * cita, não o `title_options` do JSON).
 *
 * @pure
 */
export function applySwapToReviewedMd(
  md: string,
  position: 1 | 2 | 3,
  promotedTitle: string,
  promotedUrl: string,
): { md: string; updates: NonNullable<SwapResult["md_updates"]> } {
  const titles = extractTitlesFromMd(md);
  const oldTitle = position === 1 ? titles.d1 : position === 2 ? titles.d2 : titles.d3;
  // #9668: o título da FONTE pode trazer sufixo de veículo com ` | `
  // ("X | TechCrunch") — gravado cru, partia o segmento do SUBTÍTULO e o guard
  // do provisório nunca o achava. Placeholder, bloco e marcador usam o mesmo
  // provisório normalizado.
  const provisional = toProvisionalTitulo(promotedTitle);
  const withPlaceholder = removeDestaqueBlockFromMd(md, position, provisional, promotedUrl);
  const pool = removePoolItemFromMd(withPlaceholder, promotedUrl);
  const titulo = replaceTitleInTituloSubtitulo(pool.md, oldTitle, provisional, position);
  const intro = syncIntroCountInMd(titulo.md);
  return {
    md: intro.md,
    updates: {
      pool_item_removed: pool.removed,
      section_removed: pool.section_removed,
      titulo_subtitulo: titulo.status,
      provisional_title: provisional,
      intro_count: { before: intro.before, after: intro.after, changed: intro.changed },
    },
  };
}

// ---------------------------------------------------------------------------
// Image management
// ---------------------------------------------------------------------------

/**
 * Deletes image files for a given destaque position (d1/d2/d3).
 * The position that gets a new promoted highlight needs fresh images from Stage 3.
 *
 * #9755: o sufixo aceita hífen (`[a-z0-9-]+`, mesmo padrão de
 * `renameDestaqueImages` em reorder-destaques.ts, #5085/#9679) — sem isso
 * `04-d{N}-4x5-nativo.jpg` e `04-d{N}-carousel-{slot}-4x5.jpg` sobreviviam ao
 * swap e `image-generate.ts` (que pula slot com imagem final, #4989) deixava a
 * arte do destaque ANTIGO grudada no novo. `.json` cobre o
 * `04-d{N}-sd-prompt.json` na raiz (layout legado).
 */
export function deleteDestaqueImages(
  editionDir: string,
  position: 1 | 2 | 3,
  dryRun: boolean,
): Array<{ deleted: string }> {
  const deleted: Array<{ deleted: string }> = [];
  for (const f of listDestaqueImageFiles(editionDir, position)) { // #11529: padrão na lib do backup
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
 *
 * #9755: também os sidecars `04-d{N}-{sd-prompt,generator}.json` que o
 * reorder já remapeia (#9679) — senão o sidecar do gerador do destaque antigo
 * fica atribuído ao novo.
 */
export function deleteDestaquePrompts(
  internalDir: string,
  position: 1 | 2 | 3,
  dryRun: boolean,
): Array<{ deleted: string }> {
  const deleted: Array<{ deleted: string }> = [];
  for (const f of listDestaquePromptFiles(internalDir, position)) { // #11529: padrão na lib do backup
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
 *
 * #4865: `promotedItem` is copied VERBATIM from `sourceBucket[promoteIdx]` into
 * `highlights[demotePos]` — no re-derivation of `url` from `article.url` happens
 * here, unlike `buildHighlight()` in `apply-gate-edits.ts`. This is safe by
 * construction rather than by an added check: `01-approved.json` is written
 * exclusively by `apply-gate-edits.ts` (`highlights[]` via `buildHighlight()`,
 * `runners_up[]` via `normalizeRunnerUp()`), and every OTHER bucket
 * (`radar`/`lancamento`/`use_melhor`/`video`) is a flat `Article[]` with a
 * single `url` field — no nested `article.url` to diverge from. Every possible
 * `promoteBucket` therefore already has `url === article.url` (or no nested
 * `article` at all) by the time it reaches this function — there is no write
 * path that could hand `swapInApprovedJson` a divergent item. Adding a
 * redundant post-swap check here would duplicate `url-matches-article-url`
 * (`scripts/lib/invariant-checks/stage-1.ts`) without covering any gap it
 * doesn't already close upstream — deliberately not added (see #4865 scope
 * item 3).
 */
export function swapInApprovedJson(
  data: Record<string, unknown>,
  promoteBucket: SourceBucket,
  promoteIdx: number,
  demotePos: number,
  drop: boolean,
  /** #9601: bucket que recebe o rebaixado. Default: `defaultDemoteBucket(promoteBucket)`. */
  demoteTo?: SourceBucket,
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

  // Build new highlights array: replace demoted position with promoted item,
  // wrapped in the highlight shape (#9601, §4d.1b ii) and ranks renumbered.
  const newHighlights = [...highlights];
  newHighlights[demotePos] = toHighlightItem(promotedItem, demotePos + 1, promoteBucket);
  renumberRanks(newHighlights);
  data.highlights = newHighlights;

  // #9961: o destaque é um wrapper cujo `article` pode NUNCA ter saído do
  // bucket de origem (ex: D3 vindo de `lancamento`). Demover pra outro bucket
  // deixava a URL em 2 buckets → `url-bucket` acusa `duplicate`. Tira toda
  // cópia pré-existente antes de inserir no destino (mesmo do #9869).
  // #9990: vale também pro `--drop` — sem isso o item "descartado" seguia no
  // bucket de origem e o writer o publicava no pool.
  removeUrlFromPoolBuckets(data, extractUrl(demotedItem));

  // If not dropping, prepend demoted item to the destination bucket, in that
  // bucket's shape (#9601, §4d.1b i — flat for pool buckets).
  if (!drop) {
    const target = demoteTo ?? defaultDemoteBucket(promoteBucket);
    const existing = data[target];
    data[target] = [
      toBucketItem(demotedItem, target), // #9381 + #9601
      ...(Array.isArray(existing) ? (existing as Record<string, unknown>[]) : []),
    ];
  }

  return { ok: true, promotedItem, demotedItem };
}

/**
 * #11497: posição do item com a URL dada no bucket `bucket` de um approved
 * (comparação por URL canônica, `urlsMatch`). -1 se o bucket não existe ou não
 * tem o item. O `--promote bucket:idx` vale para `01-approved.json`; o
 * `01-approved-capped.json` tem o mesmo bucket com outro tamanho e outra ordem
 * (edição 261029: radar com 77 itens num, 5 no outro), então o índice do
 * capped sai daqui, pela URL, nunca reaproveitado.
 *
 * @pure
 */
export function findBucketIndexByUrl(
  data: Record<string, unknown>,
  bucket: string,
  url: string,
): number {
  const items = data[bucket];
  if (!Array.isArray(items) || !url) return -1;
  return (items as unknown[]).findIndex(
    (it) => it !== null && typeof it === "object" && urlsMatch(extractUrl(it as Record<string, unknown>), url),
  );
}

/**
 * #11497: divergências de `highlights[]` entre os dois approved depois do
 * swap — uma linha por posição com URL diferente (comparação canônica) e uma
 * para tamanho diferente. Lista vazia = os dois arquivos concordam.
 *
 * @pure
 */
export function highlightUrlDivergence(
  approved: Record<string, unknown>,
  capped: Record<string, unknown>,
): string[] {
  const urls = (d: Record<string, unknown>): string[] =>
    Array.isArray(d.highlights)
      ? (d.highlights as unknown[]).map((h) =>
          h !== null && typeof h === "object" ? extractUrl(h as Record<string, unknown>) : "",
        )
      : [];
  const a = urls(approved);
  const c = urls(capped);
  const out: string[] = [];
  if (a.length !== c.length) {
    out.push(`highlights[] tem ${a.length} itens em 01-approved.json e ${c.length} em 01-approved-capped.json`);
  }
  for (let i = 0; i < Math.min(a.length, c.length); i++) {
    if (!a[i] || !c[i] || !urlsMatch(a[i], c[i])) {
      out.push(`D${i + 1}: 01-approved.json = ${a[i] || "(sem URL)"} | 01-approved-capped.json = ${c[i] || "(sem URL)"}`);
    }
  }
  return out;
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
  /** #9601: bucket que recebe o rebaixado. Default: `defaultDemoteBucket(bucket)` — o mesmo de `swapInApprovedJson`. */
  demoteTo?: string,
): { synced: boolean; warning?: string } {
  const cappedHighlights = approvedCappedData.highlights as
    | Record<string, unknown>[]
    | undefined;
  if (Array.isArray(cappedHighlights) && cappedHighlights.length > demotePos) {
    const cappedDemotedItem = cappedHighlights[demotePos];
    cappedHighlights[demotePos] = toHighlightItem(promotedItem, demotePos + 1, bucket); // #9601
    renumberRanks(cappedHighlights);
    removeUrlFromPoolBuckets(approvedCappedData, extractUrl(cappedDemotedItem)); // #9961; #9990: também no --drop
    if (!drop) {
      const target = demoteTo ?? defaultDemoteBucket(bucket as SourceBucket);
      const cappedBucket = approvedCappedData[target];
      const demotedForBucket = toBucketItem(cappedDemotedItem, target); // #9381 + #9601
      if (Array.isArray(cappedBucket)) {
        approvedCappedData[target] = [demotedForBucket, ...cappedBucket];
      } else {
        approvedCappedData[target] = [demotedForBucket];
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
      "Uso: swap-destaque.ts --edition AAMMDD --promote bucket:idx --demote d{1|2|3} [--demote-to bucket] [--drop] [--dry-run] [--edition-dir <path>]",
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

  // #9601: --demote-to bucket (opcional)
  let demoteTo = defaultDemoteBucket(promote.bucket);
  if (args["demote-to"] !== undefined) {
    if (!validBuckets.includes(args["demote-to"] as SourceBucket)) {
      console.error(
        `Erro: --demote-to "${args["demote-to"]}" inválido. Válidos: ${validBuckets.join(", ")}`,
      );
      process.exit(2);
    }
    demoteTo = args["demote-to"] as SourceBucket;
  }

  // #3491: sem --edition-dir (o override "cru" de path COMPLETO, já existente),
  // o default construía `data/editions/{AAMMDD}` à mão (layout FLAT) — mesma
  // classe de bug de #3483/#3484. Este é um comando editor-invocado
  // diretamente (sem caller fixo no orchestrator que sempre passe
  // --edition-dir), então o default É o path realmente exercitado no uso
  // normal. `resolveEditionDir` acha o dir REAL no disco (flat ou nested).
  // `--editions-dir` (plural, raiz) é um segundo override, só de teste (mesmo
  // padrão de close-poll.ts #3031) — distinto de `--edition-dir` (singular,
  // dir completo).
  const editionsRootDir = args["editions-dir"]
    ? resolve(args["editions-dir"])
    : resolve(ROOT, "data", "editions");
  const editionDir =
    args["edition-dir"] ?? resolveEditionDir(editionsRootDir, args.edition);

  return { edition: args.edition, editionDir, promote, demote, drop, demoteTo, dryRun };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * `--finalize-titulo` (review PR #9666): troca no TÍTULO/SUBTÍTULO cada título
 * provisório registrado pelo swap pelo título ATUAL do D{N} (já reescrito pelo
 * writer-destaque) e limpa o marcador. Exit 1 se algum ainda não dá pra
 * finalizar (D{N} em placeholder) — o marcador fica com o que restou.
 */
function finalizeTituloMain(argv: string[]): void {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const editionDirArg = get("--edition-dir");
  const edition = get("--edition");
  if (!editionDirArg && !edition) {
    console.error("Uso: swap-destaque.ts --finalize-titulo (--edition-dir <path> | --edition AAMMDD)");
    process.exit(2);
  }
  const editionDir = editionDirArg
    ? resolve(editionDirArg)
    : resolveEditionDir(resolve(ROOT, "data", "editions"), edition as string);
  const markerPath = tituloPendingPath(editionDir);
  if (!existsSync(markerPath)) {
    console.log(JSON.stringify({ finalized: [], remaining: [], note: "nenhum título provisório pendente" }, null, 2));
    return;
  }
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) {
    console.error(`Erro: ${mdPath} não encontrado`);
    process.exit(1);
  }
  let entries: PendingTitulo[];
  try {
    entries = parsePendingTitulos(readFileSync(markerPath, "utf8"));
  } catch (e) {
    console.error(`Erro: marcador ${markerPath} ilegível: ${(e as Error).message}`);
    process.exit(1);
  }
  const md = readFileSync(mdPath, "utf8");
  const r = finalizeProvisionalTitulos(md, entries);
  if (r.md !== md) writeFilesVerified([{ path: mdPath, content: r.md }], "swap-destaque --finalize-titulo");
  if (r.remaining.length === 0) {
    unlinkSync(markerPath);
  } else {
    writeFilesVerified(
      [{ path: markerPath, content: serializePendingTitulos(r.remaining.map(({ position, provisional_title }) => ({ position, provisional_title }))) }],
      "swap-destaque --finalize-titulo",
    );
  }
  console.log(JSON.stringify({ finalized: r.finalized, remaining: r.remaining }, null, 2));
  if (r.remaining.length > 0) {
    for (const x of r.remaining) console.error(`PENDENTE D${x.position}: ${x.reason}`);
    process.exit(1);
  }
}

/**
 * #11529: próximos passos depois do `--restore dN`. O `02-reviewed.md` não é
 * tocado (o bloco do D{N} segue com o placeholder do swap de volta): o texto
 * está no `02-dN-draft.md` restaurado.
 *
 * @pure
 */
export function buildRestoreSteps(editionDir: string, position: 1 | 2 | 3, hasDraft: boolean): string[] {
  const dir = editionDir.replace(/\/+$/, "");
  return [
    hasDraft
      ? `Trocar o placeholder do DESTAQUE ${position} em 02-reviewed.md pelo texto de _internal/02-d${position}-draft.md (restaurado) — sem re-rodar o writer-destaque`
      : `Backup sem _internal/02-d${position}-draft.md: re-rodar o writer-destaque DESTAQUE ${position}`,
    `Trocar o título provisório pelo final no TÍTULO/SUBTÍTULO: npx tsx scripts/swap-destaque.ts --finalize-titulo --edition-dir ${dir}`,
    `Re-upload das imagens restauradas: npx tsx scripts/upload-images-public.ts --mode newsletter e --mode social (o cache reaproveita as chaves devolvidas quando o md5 bate)`,
    `Splice do ## d${position} em 03-social.md (se o social já foi reescrito pro item que saiu) e npx tsx scripts/refresh-social-hash.ts --edition-dir ${dir}`,
    `npx tsx scripts/check-invariants.ts --edition-dir ${dir} --stage 4`,
  ];
}

/** Lê o manifest de um diretório de backup passado em `--from`. */
function readBackupDir(dir: string): FoundBackup {
  const manifest = JSON.parse(readFileSync(resolve(dir, SWAP_BACKUP_MANIFEST), "utf8")) as SwapBackupManifest;
  return { dir: resolve(dir), manifest };
}

/**
 * `--restore dN` (#11529): devolve à posição os artefatos de um backup do
 * swap. Sem `--from`, usa o backup mais recente da posição cuja URL é a do
 * destaque que está HOJE em dN no `01-approved.json` — ou seja, primeiro o
 * item volta à posição (novo swap), depois o restore. Arquivo já existente no
 * destino recusa sem `--force`.
 */
function restoreMain(argv: string[]): void {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const posRaw = get("--restore");
  if (!posRaw || !["d1", "d2", "d3"].includes(posRaw)) {
    console.error("Uso: swap-destaque.ts --restore d{1|2|3} (--edition-dir <path> | --edition AAMMDD) [--from <dir>] [--force]");
    process.exit(2);
  }
  const position = Number(posRaw.slice(1)) as 1 | 2 | 3;
  const editionDirArg = get("--edition-dir");
  const edition = get("--edition");
  if (!editionDirArg && !edition) {
    console.error("Erro: --edition-dir <path> ou --edition AAMMDD é obrigatório");
    process.exit(2);
  }
  const editionDir = editionDirArg
    ? resolve(editionDirArg)
    : resolveEditionDir(resolve(ROOT, "data", "editions"), edition as string);
  const force = argv.includes("--force");

  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  if (!existsSync(approvedPath)) {
    console.error(`Erro: ${approvedPath} não encontrado`);
    process.exit(1);
  }
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as Record<string, unknown>;
  const highlights = Array.isArray(approved.highlights) ? (approved.highlights as Record<string, unknown>[]) : [];
  const current = highlights[position - 1];
  const currentUrl = current ? extractUrl(current) : "";

  const fromArg = get("--from");
  let backup: FoundBackup | null;
  if (fromArg) {
    try {
      backup = readBackupDir(fromArg);
    } catch (e) {
      console.error(`Erro: backup ${fromArg} ilegível: ${(e as Error).message}`);
      process.exit(1);
    }
    if (backup.manifest.position !== position) {
      console.error(`Erro: o backup é do D${backup.manifest.position}, não do D${position}`);
      process.exit(1);
    }
    if (!urlsMatch(backup.manifest.url, currentUrl) && !force) {
      console.error(
        `Erro: o backup é de ${backup.manifest.url}, mas o D${position} hoje é ${currentUrl || "(vazio)"} — ` +
          `traga o item de volta à posição primeiro, ou use --force`,
      );
      process.exit(1);
    }
  } else {
    backup = currentUrl ? findSwapBackupForUrl(editionDir, position, currentUrl) : null;
    if (!backup) {
      const available = listSwapBackups(editionDir, position);
      console.error(
        `Erro: nenhum backup de swap do D${position} para ${currentUrl || "(D" + position + " vazio)"}.` +
          (available.length > 0
            ? `\n  Backups do D${position}:\n${available.map((b) => `    ${b.dir} — ${b.manifest.url} ("${b.manifest.title}")`).join("\n")}` +
              `\n  Traga o item de volta à posição (swap-destaque.ts --promote ... --demote d${position}) ou passe --from <dir>.`
            : ""),
      );
      process.exit(1);
    }
  }

  const conflicts = restoreConflicts(editionDir, backup);
  if (conflicts.length > 0 && !force) {
    console.error(`Erro: já existem no destino (use --force para sobrescrever): ${conflicts.join(", ")}`);
    process.exit(1);
  }
  const r = restoreSwapBackup(editionDir, backup, { force });
  const out = {
    restored_from: backup.dir,
    position: `d${position}`,
    url: backup.manifest.url,
    title: backup.manifest.title,
    ...r,
    next_steps: buildRestoreSteps(editionDir, position, r.files_restored.includes(`_internal/02-d${position}-draft.md`)),
  };
  console.log(JSON.stringify(out, null, 2));
  if (r.public_images_kept.length > 0) {
    console.error(
      `AVISO: chave(s) já presentes em 06-public-images.json mantidas como estavam: ${r.public_images_kept.join(", ")}`,
    );
  }
}

function main(): void {
  if (process.argv.includes("--finalize-titulo")) {
    finalizeTituloMain(process.argv.slice(2));
    return;
  }
  if (process.argv.includes("--restore")) {
    restoreMain(process.argv.slice(2));
    return;
  }
  const args = parseSwapArgs(process.argv.slice(2));
  const { edition, editionDir, promote, demote, drop, demoteTo, dryRun } = args;

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
    demoted: {
      position: demote,
      url: demotedUrl,
      title: demotedTitle,
      dropped: drop,
      ...(drop ? {} : { to_bucket: demoteTo }),
    },
    modified: { rewritten: [], renamed: [], deleted: [] },
    rerenders_needed: [
      ...buildSwapDestaqueSteps(editionDir, demotePosition, promotedTitle, drop ? null : demoteTo),
      // #9755: item promovido era o do 4º post social → re-selecionar.
      ...[useMelhorPostReselectStep(editionDir, promotedUrl)].filter((x): x is string => x !== null),
    ],
  };

  const keepArtSwapOperation = `swap trocou a história de d${demotePosition} (remover essa chave)`;

  if (dryRun) {
    // #10335: só anuncia "zerado" quando havia estado da posição — o run real
    // é no-op com arquivo ausente/sem a posição. dryRun=true não grava nada.
    const estiloPlan = updateEstiloRegenStateFile(
      internalDir,
      (d) => clearEstiloRegenDestaques(d, [`d${demotePosition}`]),
      true,
    );
    const estiloRegenPlan = estiloPlan.rewritten
      ? `_internal/04-estilo-regen.json: estado de d${demotePosition} zerado (#10335)`
      : estiloPlan.warning
        ? `_internal/04-estilo-regen.json: ${estiloPlan.warning}`
        : `_internal/04-estilo-regen.json: sem estado de d${demotePosition}, nada a zerar (#10335)`;
    // #11213: mesmo padrão do estiloRegenPlan — arquivo malformado volta
    // `rewritten: null` + `warning`, e o plano não pode dizer "nada a remover".
    const keepArtPlan = updateCarouselKeepArtFile(
      editionDir,
      (k) => clearCarouselKeepArt(k, [`d${demotePosition}`]),
      true,
      undefined,
      keepArtSwapOperation,
    );
    const keepArtPlanText = keepArtPlan.rewritten
      ? `_internal/carousel-keep-art.json: exceção de d${demotePosition} removida (#11213)`
      : keepArtPlan.warning
        ? `_internal/carousel-keep-art.json: ${keepArtPlan.warning}`
        : `_internal/carousel-keep-art.json: sem exceção de d${demotePosition}, nada a remover (#11213)`;
    const planWarnings = [estiloPlan.warning, keepArtPlan.warning].filter((w): w is string => !!w);
    if (planWarnings.length > 0) result.warnings = planWarnings;
    console.log(
      JSON.stringify(
        {
          ...result,
          dry_run_plan: {
            approved_json: `highlights[${demotePos}] ← ${promote.bucket}[${promote.idx}] ("${promotedTitle}")`,
            ...(approvedCappedData
              ? {
                  // #11497: no capped o item é localizado pela URL, não pelo índice.
                  approved_capped_json: (() => {
                    const i = findBucketIndexByUrl(approvedCappedData, promote.bucket, promotedUrl);
                    return i >= 0
                      ? `highlights[${demotePos}] ← ${promote.bucket}[${i}] (mesma URL)`
                      : `highlights[${demotePos}] ← item do 01-approved.json (URL ausente do bucket "${promote.bucket}" no capped)`;
                  })(),
                }
              : {}),
            demoted_item: drop ? `descartado` : `devolvido a ${demoteTo}[0] (flat, #9601)`,
            social_hash: "NÃO regravado (#9169) — recarimbar via refresh-social-hash.ts depois do splice do social",
            md_block: `DESTAQUE ${demotePosition} em 02-reviewed.md substituído por placeholder; item promovido sai da seção de pool (seção esvaziada sai junto), TÍTULO/SUBTÍTULO e contagem da intro re-sincronizados (#9601)`,
            images_deleted: `04-d${demotePosition}-*.{jpg,png,json} saem da posição, inclusive 4x5-nativo e carousel-* (#9755) — movidos para _internal/_forensic/swap-{aammdd-hhmm}-d${demotePosition}/ (#11529)`,
            prompts_deleted: `_internal/02-d${demotePosition}-*.md/json e 04-d${demotePosition}-{sd-prompt,generator}.json saem da posição (precisam regenerar) — movidos para o mesmo backup; --restore d${demotePosition} devolve (#11529)`,
            estilo_regen_state: estiloRegenPlan,
            carousel_keep_art: keepArtPlanText,
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
    demoteTo,
  );
  if (!swapResult.ok) {
    console.error(`Erro ao aplicar swap em 01-approved.json: ${swapResult.reason}`);
    process.exit(1);
  }
  // #9173: escritas de conteúdo acumuladas e gravadas num LOTE verificado
  // (writeFilesVerified) antes de apagar imagens/prompts.
  const pendingWrites: VerifiedWrite[] = [
    { path: approvedPath, content: JSON.stringify(approvedData, null, 2) + "\n" },
  ];

  // 2. Mutate 01-approved-capped.json (same position swap in highlights[])
  if (approvedCappedData) {
    // #11497: o índice do `--promote` é do 01-approved.json. No capped o bucket
    // tem outro tamanho e outra ordem, então o item é localizado pela URL do
    // promovido — reaproveitar o índice promovia OUTRA matéria no capped (que é
    // o que o writer-destaque lê), sem nada acusar.
    const cappedIdx = findBucketIndexByUrl(approvedCappedData, promote.bucket, promotedUrl);
    const cappedSwap =
      cappedIdx >= 0
        ? swapInApprovedJson(approvedCappedData, promote.bucket, cappedIdx, demotePos, drop, demoteTo)
        : null;
    let cappedSynced = cappedSwap?.ok === true;
    if (!cappedSynced) {
      // Item ausente do bucket no capped (o capped corta itens), ou bucket
      // ausente/curto (#2521): espelhar o swap com o item do 01-approved.json via
      // helper testável (mirrorCappedSwapFallback). Fail-loud se highlights[] for
      // curto demais pro demotePos (slot inexistente).
      if (cappedIdx < 0) {
        console.error(
          `AVISO: "${promotedTitle}" (${promotedUrl}) não está no bucket "${promote.bucket}" de ` +
            `01-approved-capped.json — o destaque do capped recebe o item do 01-approved.json (#11497).`,
        );
        // Cópia do promovido em outro bucket do capped sairia duplicada (destaque + pool).
        removeUrlFromPoolBuckets(approvedCappedData, promotedUrl);
      }
      const mirrored = mirrorCappedSwapFallback(
        approvedCappedData,
        promote.bucket,
        demotePos,
        drop,
        promotedItem,
        demoteTo,
      );
      if (mirrored.warning) console.error(`AVISO: ${mirrored.warning}`);
      cappedSynced = mirrored.synced;
    }
    // #11497: com o capped sincronizado, os dois highlights[] têm que bater em
    // URL e posição. Divergência aborta antes de gravar qualquer arquivo.
    if (cappedSynced) {
      const divergence = highlightUrlDivergence(approvedData, approvedCappedData);
      if (divergence.length > 0) {
        console.error(
          `Erro: depois do swap, highlights[] de 01-approved.json e 01-approved-capped.json divergem ` +
            `(#11497) — nada foi gravado:\n  ${divergence.join("\n  ")}`,
        );
        process.exit(1);
      }
    }
    pendingWrites.push({
      path: approvedCappedPath,
      content: JSON.stringify(approvedCappedData, null, 2) + "\n",
    });
  }

  // #10100: `--drop` declara o descarte em `_internal/stage4-dropped-items.json`
  // (no mesmo lote verificado do approved) — é esse registro que o invariante
  // `approved-item-removed` (#8121) reconhece para não acusar o drop legítimo.
  if (drop) {
    const droppedPath = stage4DroppedItemsPath(editionDir);
    pendingWrites.push({
      path: droppedPath,
      content: appendStage4DroppedItems(
        existsSync(droppedPath) ? readFileSync(droppedPath, "utf8") : null,
        [
          {
            url: demotedUrl,
            title: demotedTitle,
            position: demotePosition,
            source: "swap-destaque",
            dropped_at: new Date().toISOString(),
          },
        ],
      ),
    });
  }

  // .social-source-hash.json — NÃO regravado aqui (#9169, espelho do #9149).
  // Recarimbar agora desligaria o guard do #1413 com o 03-social.md ainda
  // descrevendo o destaque antigo (e a cópia local do hash divergia da lib,
  // fazendo o social-hash-fresh falhar sempre). O recarimbo está em
  // rerenders_needed, logo depois do splice do social.

  // 3. Replace DESTAQUE block in 02-reviewed.md with placeholder
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, "utf8");
    const applied = applySwapToReviewedMd(md, demotePosition, promotedTitle, promotedUrl);
    result.md_updates = applied.updates;
    if (applied.md !== md) {
      pendingWrites.push({ path: mdPath, content: applied.md });
    }
    // Review PR #9666: o provisório (título da FONTE) fica registrado num
    // marcador; o invariante `titulo-subtitulo-not-provisional` do Stage 4
    // barra o gate até `--finalize-titulo` trocá-lo pelo título final.
    if (applied.updates.titulo_subtitulo === "updated") {
      const markerPath = tituloPendingPath(editionDir);
      let existing: PendingTitulo[] = [];
      if (existsSync(markerPath)) {
        try {
          existing = parsePendingTitulos(readFileSync(markerPath, "utf8"));
        } catch (e) {
          console.error(`AVISO: marcador ${markerPath} ilegível (${(e as Error).message}) — sobrescrito.`);
        }
      }
      pendingWrites.push({
        path: markerPath,
        content: serializePendingTitulos(
          upsertPendingTitulo(existing, { position: demotePosition, provisional_title: applied.updates.provisional_title }),
        ),
      });
    }
    if (applied.updates.titulo_subtitulo === "old_title_not_found") {
      console.error(
        `AVISO (#9601): o título antigo do D${demotePosition} não aparece no bloco TÍTULO/SUBTÍTULO — ` +
          `bloco escrito à mão? Não foi alterado; conferir antes do gate.`,
      );
    }
  }

  // #11529: guarda as entradas públicas da posição ANTES de o lote abaixo
  // gravar o cache invalidado — vão para o manifest do backup.
  const demotedPublicImages = readPublicImagesForPosition(editionDir, demotePosition);

  // #11252: as URLs públicas da posição trocada (hero 2:1, 4:5, carrossel)
  // ainda são da arte do destaque ANTIGO — remove do cache no mesmo lote.
  const publicPlan = planPublicImagesInvalidation(editionDir, [demotePosition]);
  if (publicPlan.content !== undefined) {
    pendingWrites.push({ path: publicPlan.path, content: publicPlan.content });
    console.error(`AVISO: ${publicImagesInvalidatedWarning(publicPlan.removedKeys)}`);
  } else if (publicPlan.error) {
    console.error(
      `AVISO: 06-public-images.json ilegível (${publicPlan.error}) — chaves da posição D${demotePosition} ` +
        `NÃO removidas; conferir à mão antes do upload (#11252).`,
    );
  }

  writeFilesVerified(pendingWrites, "swap-destaque");
  for (const w of pendingWrites) result.modified.rewritten.push(w.path);

  // #9961: pós-check url-bucket (duplicata de bucket) contra os 2 approved.
  // Vai à FRENTE de rerenders_needed — é gate-blocking no Stage 4.
  {
    const mdWrite = pendingWrites.find((w) => w.path === mdPath);
    const finalMd = mdWrite ? mdWrite.content : existsSync(mdPath) ? readFileSync(mdPath, "utf8") : "";
    const dupWarnings = [
      ...urlBucketDuplicateWarnings(finalMd, approvedData, "01-approved.json"),
      ...(approvedCappedData
        ? urlBucketDuplicateWarnings(finalMd, approvedCappedData, "01-approved-capped.json")
        : []),
    ];
    if (dupWarnings.length > 0) {
      result.rerenders_needed.unshift(...dupWarnings);
      for (const w of dupWarnings) console.error(`AVISO: ${w}`);
    }
  }

  // 4+5. Tira da posição as imagens e os prompts/rascunho do rebaixado (os do
  // promovido saem do Stage 3) — MOVIDOS para _internal/_forensic/ com
  // manifest, nunca apagados (#11529): se o editor trouxer o item de volta,
  // `--restore dN` devolve tudo.
  const demotedHighlight = demotedItem as { bucket?: unknown; article?: { category?: unknown } };
  const backup = backupDemotedDestaque({
    editionDir,
    position: demotePosition,
    url: demotedUrl,
    title: demotedTitle,
    sourceBucket:
      typeof demotedHighlight.bucket === "string"
        ? demotedHighlight.bucket
        : typeof demotedHighlight.article?.category === "string"
          ? demotedHighlight.article.category
          : null,
    demotedTo: drop ? null : demoteTo,
    publicImages: demotedPublicImages,
  });
  result.backup = backup;
  for (const f of backup.files) result.modified.deleted.push(f.replace(/^_internal\//, ""));

  // 6. Zera o estado do plano de Noite Estrelada da posição (#10335): a
  // posição recebe outro item e imagem nova; um `pending` vivo da imagem
  // antiga faria o plano seguinte tratar a imagem nova como a regenerada e
  // levar o destaque a `exhausted` sem regeneração nenhuma.
  const estilo = updateEstiloRegenStateFile(
    internalDir,
    (d) => clearEstiloRegenDestaques(d, [`d${demotePosition}`]),
    false,
    (path, content) => writeFilesVerified([{ path, content }], "swap-destaque"),
  );
  if (estilo.rewritten) result.modified.rewritten.push(estilo.rewritten);
  if (estilo.warning) {
    console.error(`AVISO: ${estilo.warning}`);
    (result.warnings ??= []).push(estilo.warning);
  }

  // 7. Tira a exceção "manter a arte" da posição (#11213): ela era da história
  // rebaixada. Mantida, valeria para a arte NOVA assim que gerada — o
  // gen-carousel-cards.ts deixaria de regerá-la e o gate rebaixaria o stale.
  const keepArt = updateCarouselKeepArtFile(
    editionDir,
    (k) => clearCarouselKeepArt(k, [`d${demotePosition}`]),
    false,
    (path, content) => writeFilesVerified([{ path, content }], "swap-destaque"),
    keepArtSwapOperation,
  );
  if (keepArt.rewritten) result.modified.rewritten.push(keepArt.rewritten);
  if (keepArt.warning) {
    console.error(`AVISO: ${keepArt.warning}`);
    (result.warnings ??= []).push(keepArt.warning);
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
      `  Rebaixado:  [${demote}] "${demotedTitle}"  →  ${drop ? "DESCARTADO" : `${demoteTo}[0]`}`,
      ...(backup.dir
        ? [`  Backup do rebaixado: ${backup.dir} (voltando à posição: --restore ${demote}, #11529)`]
        : []),
      "",
      "  Re-renders necessários (NESTA ordem):",
      ...result.rerenders_needed.map((r, i) => `    ${i + 1}. ${r}`),
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
