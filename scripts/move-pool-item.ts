#!/usr/bin/env tsx
/**
 * move-pool-item.ts (#9680)
 *
 * Move um item do pool entre seções secundárias da edição (LANÇAMENTOS,
 * RADAR, USE MELHOR, VÍDEOS) no gate do Stage 4 — ex: RADAR → USE MELHOR.
 *
 * Por que existe: na edição 261006 mover um item do RADAR pro USE MELHOR foi
 * feito à mão e quebrou 3 checks em sequência: `url-bucket` (gate-blocking —
 * o objeto precisa mudar de bucket em `01-approved.json` E em
 * `01-approved-capped.json`), `use-melhor-tempo` (USE MELHOR exige "(N min)")
 * e `intro-count-consistent` (intro "selecionei os N").
 *
 * O que ESTE script faz (mecânico, num lote verificado — #9188):
 *   1. `02-reviewed.md`: tira o bloco do item (linha do link + descrição) da
 *      seção de origem e o anexa ao fim da seção de destino; seção de origem
 *      que fica vazia é removida (header + `---`); headers singular/plural
 *      ajustados à contagem nova (LANÇAMENTO/LANÇAMENTOS, VÍDEO/VÍDEOS);
 *   2. tempo de leitura: indo pro USE MELHOR sem "(N min)" na descrição, exige
 *      `--tempo N` (minutos, informado pelo editor) e anexa " (N min)". O
 *      script NÃO estima tempo — tempo sem fonte é exatamente o chute que o
 *      editor teve que fazer em 261006. Saindo do USE MELHOR, o "(N min)" do
 *      fim da descrição é removido (as outras seções não usam);
 *   3. intro "selecionei os N": recalculada se a contagem real mudou
 *      (`replaceIntroClaimedCount`, mesma fonte do invariante);
 *   4. `_internal/01-approved.json` e `01-approved-capped.json`: objeto movido
 *      do bucket de origem pro de destino (o arquivo que não tinha o item
 *      recebe uma cópia, senão `url-bucket` acusa "missing").
 *
 * O que NÃO faz (LLM ou decisão editorial — sai em `next_steps`):
 *   - reescrever a descrição pro tom da seção nova;
 *   - re-selecionar o item do 4º post social (`## um`, #9568) e reescrevê-lo
 *     quando o item que SAIU do USE MELHOR era o escolhido;
 *   - criar uma seção que não existe em `02-reviewed.md` (ordem e posição das
 *     seções são editoriais — recusa com exit 2);
 *   - validar link oficial quando o destino é LANÇAMENTOS (`validate-lancamentos.ts`).
 *
 * Destaques (D1/D2/D3) estão fora: use `reorder-destaques.ts`,
 * `promote-to-destaque.ts` ou `swap-destaque.ts`.
 *
 * Uso:
 *   npx tsx scripts/move-pool-item.ts --edition-dir data/editions/2610/261006 \
 *     --url https://exemplo.com/guia --to use_melhor --tempo 8 [--dry-run]
 *
 * Exit: 0 ok; 2 uso errado ou movimento recusado (nada gravado).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsWithTrueDefault, isMainModule } from "./lib/cli-args.ts";
import { writeFilesVerified, type VerifiedWrite } from "./lib/write-files-verified.ts";
import {
  SECTIONS,
  sectionHeaderRegex,
  singularizeSectionName,
  stripEmojiPrefix,
  type SectionBucket,
} from "./lib/section-naming.ts";
import { USE_MELHOR_TEMPO_RE } from "./lib/lint-checks/use-melhor-tempo.ts";
import { countSelectedItems, lintIntroCount, replaceIntroClaimedCount } from "./lib/newsletter-count.ts";
import { lintNewsletter, type ApprovedJson } from "./lib/lint-checks/url-bucket.ts";
import { readUseMelhorPostState } from "./lib/use-melhor-post.ts";

export const POOL_BUCKETS: readonly SectionBucket[] = ["lancamento", "radar", "use_melhor", "video"];

/** Chaves de `01-approved*.json` → seção (mesma tabela de `buildUrlBucketMap`, url-bucket.ts). */
const APPROVED_KEY_TO_BUCKET: Record<string, SectionBucket> = {
  lancamento: "lancamento",
  radar: "radar",
  pesquisa: "radar",
  noticias: "radar",
  use_melhor: "use_melhor",
  tutorial: "use_melhor",
  video: "video",
};

/** Normalização pro match: sem fragmento, sem barra final, sem espaços. */
export function normalizeUrl(url: string): string {
  return url.trim().replace(/#.*$/, "").replace(/\/+$/, "");
}

function sameUrl(a: unknown, url: string): boolean {
  return typeof a === "string" && normalizeUrl(a) === normalizeUrl(url);
}

// ─── 01-approved*.json ─────────────────────────────────────────────────────

export interface ApprovedMoveResult {
  /** Bucket de origem encontrado neste arquivo (null se o item não estava fora do destino). */
  from: SectionBucket | null;
  /** O objeto do item (do bucket de origem, ou do destino se já estava lá). */
  item: Record<string, unknown> | null;
  changed: boolean;
}

/** Pure: acha o objeto do item em qualquer bucket do pool. */
export function findPoolItem(json: Record<string, unknown>, url: string): Record<string, unknown> | null {
  for (const key of Object.keys(APPROVED_KEY_TO_BUCKET)) {
    const arr = json[key];
    if (!Array.isArray(arr)) continue;
    const hit = arr.find((it) => sameUrl((it as { url?: unknown })?.url, url));
    if (hit && typeof hit === "object") return hit as Record<string, unknown>;
  }
  return null;
}

/**
 * Pure (muta `json`): remove o item de todo bucket do pool que não é `to` e
 * garante UMA cópia em `json[to]` (usa `fallbackItem` se este arquivo não
 * tinha o item). Lança se a URL é destaque.
 */
export function moveInApprovedJson(
  json: Record<string, unknown>,
  url: string,
  to: SectionBucket,
  fallbackItem: Record<string, unknown> | null = null,
): ApprovedMoveResult {
  const highlights = json.highlights;
  if (Array.isArray(highlights)) {
    const isHighlight = highlights.some((h) => {
      const x = h as { url?: unknown; article?: { url?: unknown } };
      return sameUrl(x?.url, url) || sameUrl(x?.article?.url, url);
    });
    if (isHighlight) {
      throw new Error(`a URL é destaque, não item do pool — use reorder-destaques/promote/swap: ${url}`);
    }
  }

  let from: SectionBucket | null = null;
  let item: Record<string, unknown> | null = null;
  let alreadyInTarget = false;
  let changed = false;
  for (const [key, bucket] of Object.entries(APPROVED_KEY_TO_BUCKET)) {
    const arr = json[key];
    if (!Array.isArray(arr)) continue;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!sameUrl((arr[i] as { url?: unknown })?.url, url)) continue;
      if (bucket === to) {
        if (alreadyInTarget) {
          arr.splice(i, 1); // duplicata no próprio destino (#5757) — fica uma só
          changed = true;
        } else {
          alreadyInTarget = true;
          item = item ?? (arr[i] as Record<string, unknown>);
        }
        continue;
      }
      const [removed] = arr.splice(i, 1) as Record<string, unknown>[];
      from = from ?? bucket;
      item = item ?? removed;
      changed = true;
    }
  }
  if (!alreadyInTarget) {
    const toInsert = item ?? fallbackItem;
    if (toInsert) {
      if (!Array.isArray(json[to])) json[to] = [];
      (json[to] as unknown[]).push({ ...toInsert });
      changed = true;
      item = item ?? toInsert;
    }
  }
  return { from, item, changed };
}

// ─── 02-reviewed.md ────────────────────────────────────────────────────────

const SECTION_HEADER_RES = SECTIONS.map((s) => ({
  def: s,
  re: sectionHeaderRegex(s.pattern, { flags: "u" }),
}));

const ITEM_URL_RE = /\]\((https?:\/\/[^\s)]*(?:\([^\s)]*\)[^\s)]*)*)\)/;

interface SectionRange {
  bucket: SectionBucket;
  label: string;
  legacy: boolean;
  /** índice da linha do header */
  header: number;
  /** índice da linha que encerra a seção (`---`, outro header, ou lines.length) */
  end: number;
}

function matchSectionHeader(line: string): (typeof SECTION_HEADER_RES)[number]["def"] | null {
  const t = line.trim();
  for (const { def, re } of SECTION_HEADER_RES) if (re.test(t)) return def;
  return null;
}

function findSections(lines: string[]): SectionRange[] {
  const out: SectionRange[] = [];
  for (let i = 0; i < lines.length; i++) {
    const def = matchSectionHeader(lines[i]);
    if (!def) continue;
    let end = i + 1;
    while (end < lines.length && lines[end].trim() !== "---" && !matchSectionHeader(lines[end])) end++;
    out.push({ bucket: def.bucket, label: def.label, legacy: def.legacy === true, header: i, end });
  }
  return out;
}

function isItemStart(line: string): boolean {
  const t = line.trim();
  return /^\*{0,2}\[/.test(t) && ITEM_URL_RE.test(t);
}

/** Blocos de item `[start, end)` dentro de uma seção. */
function itemBlocks(lines: string[], sec: SectionRange): Array<{ start: number; end: number; url: string }> {
  const blocks: Array<{ start: number; end: number; url: string }> = [];
  for (let i = sec.header + 1; i < sec.end; i++) {
    if (!isItemStart(lines[i])) continue;
    let j = i + 1;
    while (j < sec.end && lines[j].trim() !== "" && !isItemStart(lines[j])) j++;
    blocks.push({ start: i, end: j, url: lines[i].match(ITEM_URL_RE)![1] });
    i = j - 1;
  }
  return blocks;
}

const TEMPO_SUFFIX_RE = /\s*(?:\(\s*~?\s*\d+\s*min[^)]*\)|[–—]\s*~?\s*\d+\s*min(?:\s+de\s+leitura)?)\s*$/;

export interface MdMoveResult {
  md: string;
  from: SectionBucket;
  tempo_added: string | null;
  tempo_removed: boolean;
  source_section_removed: boolean;
  intro_count: { before: number; after: number } | null;
}

/**
 * Pure: move o bloco do item com `url` pra seção `to`. Lança (sem efeito) se
 * o item não está numa seção do pool, já está em `to`, a seção `to` não existe,
 * ou vai pro USE MELHOR sem tempo e sem `tempo`.
 */
export function moveItemInReviewedMd(
  md: string,
  url: string,
  to: SectionBucket,
  opts: { tempo?: number } = {},
): MdMoveResult {
  const eol = md.includes("\r\n") ? "\r\n" : "\n";
  let lines = md.replace(/\r\n/g, "\n").split("\n");

  let sections = findSections(lines);
  let found: { sec: SectionRange; block: { start: number; end: number } } | null = null;
  for (const sec of sections) {
    const b = itemBlocks(lines, sec).find((x) => sameUrl(x.url, url));
    if (b) {
      found = { sec, block: b };
      break;
    }
  }
  if (!found) {
    throw new Error(
      `URL não encontrada em nenhuma seção do pool (LANÇAMENTOS/RADAR/USE MELHOR/VÍDEOS) de 02-reviewed.md: ${url}`,
    );
  }
  const from = found.sec.bucket;
  if (from === to) throw new Error(`o item já está na seção de destino (${found.sec.label}): ${url}`);
  if (!sections.some((s) => s.bucket === to)) {
    const label = SECTIONS.find((s) => s.bucket === to && !s.legacy)?.label ?? to;
    throw new Error(
      `a seção ${label} não existe em 02-reviewed.md — o script não cria seções (posição é editorial). ` +
        `Crie o header **${label}** no lugar certo e re-rode.`,
    );
  }

  let block = lines.slice(found.block.start, found.block.end);
  let tempoAdded: string | null = null;
  let tempoRemoved = false;
  if (to === "use_melhor" && !USE_MELHOR_TEMPO_RE.test(block.join(" "))) {
    if (opts.tempo === undefined) {
      throw new Error(
        `o item vai pro USE MELHOR sem tempo de leitura na descrição — passe --tempo N (minutos). ` +
          `O script não estima tempo (lint use-melhor-tempo, #2372).`,
      );
    }
    tempoAdded = `(${opts.tempo} min)`;
    const last = block.length - 1;
    block[last] = `${block[last].replace(/\s+$/, "")} ${tempoAdded}`;
  } else if (from === "use_melhor" && to !== "use_melhor") {
    const last = block.length - 1;
    const stripped = block[last].replace(TEMPO_SUFFIX_RE, "");
    if (stripped !== block[last] && stripped.trim() !== "") {
      block[last] = stripped;
      tempoRemoved = true;
    }
  }

  // 1. Remove da origem (+ 1 linha em branco adjacente, pra não acumular).
  const { start, end } = found.block;
  const removeFrom = start > 0 && lines[start - 1].trim() === "" ? start - 1 : start;
  lines.splice(removeFrom, end - removeFrom);

  // 1b. Seção de origem vazia → some (header até o `---`, + branco seguinte).
  let sourceRemoved = false;
  sections = findSections(lines);
  const src = sections.find((s) => s.header === found!.sec.header);
  if (src && itemBlocks(lines, src).length === 0) {
    let cut = src.end;
    if (cut < lines.length && lines[cut].trim() === "---") {
      cut++;
      if (cut < lines.length && lines[cut].trim() === "") cut++;
    }
    lines.splice(src.header, cut - src.header);
    sourceRemoved = true;
  }

  // 2. Insere no fim da seção de destino.
  sections = findSections(lines);
  const dst = sections.find((s) => s.bucket === to)!;
  let lastNonBlank = dst.end - 1;
  while (lastNonBlank > dst.header && lines[lastNonBlank].trim() === "") lastNonBlank--;
  lines.splice(lastNonBlank + 1, 0, "", ...block);

  // 3. Singular/plural dos headers afetados.
  sections = findSections(lines);
  for (const sec of sections) {
    if (sec.legacy || (sec.bucket !== to && sec.bucket !== from)) continue;
    const count = itemBlocks(lines, sec).length;
    if (count === 0) continue;
    const wanted = singularizeSectionName(sec.label, count);
    const line = lines[sec.header];
    const inner = line.trim().replace(/^\*\*/, "").replace(/\*\*$/, "");
    const bare = stripEmojiPrefix(inner);
    if (bare !== wanted) lines[sec.header] = line.replace(bare, wanted);
  }

  let out = lines.join("\n");

  // 4. Intro "selecionei os N".
  let introCount: MdMoveResult["intro_count"] = null;
  const intro = lintIntroCount(out);
  if (!intro.ok && intro.claimed !== undefined) {
    const actual = countSelectedItems(out).total;
    const r = replaceIntroClaimedCount(out, actual);
    if (r.changed) {
      out = r.md;
      introCount = { before: intro.claimed, after: actual };
    }
  }

  return {
    md: eol === "\r\n" ? out.replace(/\n/g, "\r\n") : out,
    from,
    tempo_added: tempoAdded,
    tempo_removed: tempoRemoved,
    source_section_removed: sourceRemoved,
    intro_count: introCount,
  };
}

// ─── orquestração ──────────────────────────────────────────────────────────

export interface MovePoolItemResult {
  url: string;
  from: SectionBucket;
  to: SectionBucket;
  dry_run: boolean;
  rewritten: string[];
  tempo_added: string | null;
  tempo_removed: boolean;
  source_section_removed: boolean;
  intro_count: { before: number; after: number } | null;
  warnings: string[];
  next_steps: string[];
}

export function movePoolItem(
  editionDir: string,
  url: string,
  to: SectionBucket,
  opts: { tempo?: number; dryRun?: boolean } = {},
): MovePoolItemResult {
  if (!POOL_BUCKETS.includes(to)) {
    throw new Error(`--to precisa ser um de ${POOL_BUCKETS.join("|")} (recebido: ${to})`);
  }
  const dryRun = opts.dryRun === true;
  const internalDir = resolve(editionDir, "_internal");
  const mdPath = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(mdPath)) throw new Error(`02-reviewed.md não encontrado em ${editionDir}`);

  // 0. Tudo validado em memória antes de gravar qualquer coisa.
  const mdResult = moveItemInReviewedMd(readFileSync(mdPath, "utf8"), url, to, { tempo: opts.tempo });

  const approvedFiles = ["01-approved.json", "01-approved-capped.json"]
    .map((f) => resolve(internalDir, f))
    .filter((p) => existsSync(p))
    .map((path) => ({ path, data: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> }));
  const warnings: string[] = [];
  let fallback: Record<string, unknown> | null = null;
  for (const f of approvedFiles) fallback = fallback ?? findPoolItem(f.data, url);
  if (approvedFiles.length > 0 && fallback === null) {
    warnings.push(
      `a URL não está em nenhum bucket de 01-approved*.json — o lint url-bucket vai acusar "missing"; ` +
        `incluir o item no approved à mão.`,
    );
  }

  const writes: VerifiedWrite[] = [];
  for (const f of approvedFiles) {
    const r = moveInApprovedJson(f.data, url, to, fallback);
    if (r.changed) writes.push({ path: f.path, content: JSON.stringify(f.data, null, 2) + "\n" });
  }
  writes.push({ path: mdPath, content: mdResult.md });
  if (!dryRun) writeFilesVerified(writes, "move-pool-item");

  // Pós-check: o mesmo lint url-bucket do gate, contra o estado novo.
  for (const f of approvedFiles) {
    const lint = lintNewsletter(mdResult.md, f.data as ApprovedJson);
    for (const e of lint.errors) {
      if (sameUrl(e.url, url)) {
        warnings.push(`url-bucket (${f.path.split("/").pop()}): ${JSON.stringify(e)}`);
      }
    }
  }

  const nextSteps: string[] = [];
  if (mdResult.from === "use_melhor" || to === "use_melhor") {
    const state = readUseMelhorPostState(editionDir);
    const chosen = state?.item && typeof state.item.url === "string" ? state.item.url : null;
    if (chosen && mdResult.from === "use_melhor" && sameUrl(chosen, url)) {
      nextSteps.push(
        `O item que saiu do USE MELHOR era o do 4º post social (## um, #9568). Re-selecionar: ` +
          `npx tsx scripts/select-use-melhor-post.ts --edition-dir ${editionDir}/ --reviewed — depois reescrever ` +
          `## um em # Social e # Curto (social-writer/social-curto com use_melhor_post_path), humanizar e ` +
          `regerar os cards (gen-carousel-cards.ts).`,
      );
    } else if (chosen && to === "use_melhor") {
      nextSteps.push(
        `4º post social (## um) segue no item atual. Só se o item novo deve virar o 4º post: ` +
          `npx tsx scripts/select-use-melhor-post.ts --edition-dir ${editionDir}/ --reviewed --force e reescrever ## um.`,
      );
    }
  }
  if (to === "lancamento") {
    nextSteps.push(`LANÇAMENTOS só com link oficial (#160): npx tsx scripts/validate-lancamentos.ts ${mdPath}`);
  }
  nextSteps.push(`Ajustar a descrição ao tom da seção nova, se preciso, e rodar check-invariants.ts --stage 4.`);

  return {
    url,
    from: mdResult.from,
    to,
    dry_run: dryRun,
    rewritten: writes.map((w) => w.path),
    tempo_added: mdResult.tempo_added,
    tempo_removed: mdResult.tempo_removed,
    source_section_removed: mdResult.source_section_removed,
    intro_count: mdResult.intro_count,
    warnings,
    next_steps: nextSteps,
  };
}

function main(): void {
  const args = parseArgsWithTrueDefault(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  const url = args.url;
  const to = args.to as SectionBucket | undefined;
  const tempoRaw = args.tempo;
  if (!editionDir || !url || !to) {
    console.error(
      "Uso: move-pool-item.ts --edition-dir <dir> --url <url> --to <lancamento|radar|use_melhor|video> [--tempo N] [--dry-run]",
    );
    process.exit(2);
  }
  let tempo: number | undefined;
  if (tempoRaw !== undefined) {
    tempo = Number(tempoRaw);
    if (!Number.isInteger(tempo) || tempo <= 0) {
      console.error(`move-pool-item: --tempo precisa ser inteiro positivo (minutos), recebido: ${tempoRaw}`);
      process.exit(2);
    }
  }
  try {
    const result = movePoolItem(resolve(editionDir), url, to, { tempo, dryRun: args["dry-run"] === "true" });
    for (const w of result.warnings) console.error(`⚠️  ${w}`);
    console.log(JSON.stringify(result, null, 2));
  } catch (e) {
    console.error(`move-pool-item: ${(e as Error).message}`);
    process.exit(2);
  }
}

if (isMainModule(import.meta.url)) main();
