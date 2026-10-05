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
 *     `lancamento` → `radar`), `rank` renumerado
 *   - `_internal/01-approved-capped.json` (highlights[])
 *   - `02-reviewed.md` (`applySwapToReviewedMd`, #9601): bloco DESTAQUE vira
 *     placeholder; o item promovido sai da seção de pool de origem (seção
 *     esvaziada sai inteira); o título antigo é trocado pelo novo no
 *     TÍTULO/SUBTÍTULO (cirúrgico — bloco escrito à mão fica intocado, com
 *     aviso); contagem da intro re-sincronizada
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
  readdirSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { normalizeItemTitle } from "./lib/strip-publisher-suffix.ts"; // #9381
import { resolveEditionDir } from "./lib/find-current-edition.ts"; // #3491: layout flat+nested
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts"; // #9173
import { lintIntroCount, replaceIntroClaimedCount } from "./lib/newsletter-count.ts"; // #9601
import { ALL_SECTION_NAMES_PATTERN, sectionHeaderRegex } from "./lib/section-naming.ts"; // #9601
import { extractTitlesFromMd } from "./insert-titulo-subtitulo.ts"; // #9601

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
    intro_count: { before: number | null; after: number | null; changed: boolean };
  };
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
 * #9381: converte um destaque rebaixado em item de POOL. A manchete de
 * destaque (`title_options`, ≤52 chars, gancho de e-mail) não serve pro
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
  if (article) {
    const a: Record<string, unknown> = { ...article };
    delete a.title_options;
    if (sourceTitle) a.title = normalizeItemTitle(sourceTitle);
    out.article = a;
  }
  if (sourceTitle && (!article || typeof item.title === "string")) {
    out.title = normalizeItemTitle(sourceTitle);
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

/**
 * #9601: troca, só dentro do bloco TÍTULO/SUBTÍTULO do topo, o título do
 * destaque que saiu pelo do que entrou. Substituição CIRÚRGICA (#495/#7401):
 * nunca regenera o bloco inteiro — se o editor escreveu um TÍTULO/SUBTÍTULO
 * próprio (o título antigo não aparece literalmente no bloco), não toca nada
 * e devolve `old_title_not_found` pra o chamador avisar.
 *
 * @pure
 */
export function replaceTitleInTituloSubtitulo(
  md: string,
  oldTitle: string | null,
  newTitle: string,
): { md: string; status: "updated" | "no_block" | "old_title_not_found" } {
  const lines = md.split("\n");
  const scan = Math.min(lines.length, 40);
  let tIdx = -1;
  for (let i = 0; i < scan; i++) {
    if (lines[i].trim() === "TÍTULO") {
      tIdx = i;
      break;
    }
  }
  if (tIdx < 0) return { md, status: "no_block" };
  let endIdx = lines.length;
  for (let i = tIdx + 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  const old = (oldTitle ?? "").trim();
  if (!old) return { md, status: "old_title_not_found" };
  let hit = false;
  for (let i = tIdx + 1; i < endIdx; i++) {
    if (lines[i].includes(old)) {
      lines[i] = lines[i].split(old).join(newTitle);
      hit = true;
    }
  }
  if (!hit) return { md, status: "old_title_not_found" };
  return { md: lines.join("\n"), status: "updated" };
}

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
        ]
      : [];
  return [
    `Re-baixar a fonte do destaque promovido (d${position}) e invalidar o manifest do fact-check: npx tsx scripts/refresh-destaque-sources.ts --edition-dir ${dir} — antes do writer-destaque (#9102).`,
    `writer-destaque DESTAQUE ${position} (novo item: "${promotedTitle}", source_text_path = path da entrada de sources com destaque === ${position} no stdout do refresh)`,
    `Depois de integrar o texto do writer-destaque: trocar no TÍTULO/SUBTÍTULO o título provisório "${promotedTitle}" pelo título final do D${position} (o swap já pôs o provisório no lugar do antigo, #9601)`,
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
  const withPlaceholder = removeDestaqueBlockFromMd(md, position, promotedTitle, promotedUrl);
  const pool = removePoolItemFromMd(withPlaceholder, promotedUrl);
  const titulo = replaceTitleInTituloSubtitulo(pool.md, oldTitle, promotedTitle);
  const intro = syncIntroCountInMd(titulo.md);
  return {
    md: intro.md,
    updates: {
      pool_item_removed: pool.removed,
      section_removed: pool.section_removed,
      titulo_subtitulo: titulo.status,
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
  /** #9601: bucket que recebe o rebaixado (default: `bucket`, comportamento antigo). */
  demoteTo?: string,
): { synced: boolean; warning?: string } {
  const cappedHighlights = approvedCappedData.highlights as
    | Record<string, unknown>[]
    | undefined;
  if (Array.isArray(cappedHighlights) && cappedHighlights.length > demotePos) {
    const cappedDemotedItem = cappedHighlights[demotePos];
    cappedHighlights[demotePos] = toHighlightItem(promotedItem, demotePos + 1, bucket); // #9601
    renumberRanks(cappedHighlights);
    if (!drop) {
      const target = demoteTo ?? bucket;
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

function main(): void {
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
    rerenders_needed: buildSwapDestaqueSteps(editionDir, demotePosition, promotedTitle, drop ? null : demoteTo),
  };

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          ...result,
          dry_run_plan: {
            approved_json: `highlights[${demotePos}] ← ${promote.bucket}[${promote.idx}] ("${promotedTitle}")`,
            demoted_item: drop ? `descartado` : `devolvido a ${demoteTo}[0] (flat, #9601)`,
            social_hash: "NÃO regravado (#9169) — recarimbar via refresh-social-hash.ts depois do splice do social",
            md_block: `DESTAQUE ${demotePosition} em 02-reviewed.md substituído por placeholder; item promovido sai da seção de pool (seção esvaziada sai junto), TÍTULO/SUBTÍTULO e contagem da intro re-sincronizados (#9601)`,
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
      demoteTo,
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
        demoteTo,
      );
      if (warning) console.error(`AVISO: ${warning}`);
    }
    pendingWrites.push({
      path: approvedCappedPath,
      content: JSON.stringify(approvedCappedData, null, 2) + "\n",
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
    if (applied.updates.titulo_subtitulo === "old_title_not_found") {
      console.error(
        `AVISO (#9601): o título antigo do D${demotePosition} não aparece no bloco TÍTULO/SUBTÍTULO — ` +
          `bloco escrito à mão? Não foi alterado; conferir antes do gate.`,
      );
    }
  }

  writeFilesVerified(pendingWrites, "swap-destaque");
  for (const w of pendingWrites) result.modified.rewritten.push(w.path);

  // 4. Delete old images for the swapped position (new ones need Stage 3)
  const deletedImages = deleteDestaqueImages(editionDir, demotePosition, false);
  for (const d of deletedImages) {
    result.modified.deleted.push(d.deleted);
  }

  // 5. Delete old prompts for the swapped position (new ones need Stage 3)
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
      `  Rebaixado:  [${demote}] "${demotedTitle}"  →  ${drop ? "DESCARTADO" : `${demoteTo}[0]`}`,
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
