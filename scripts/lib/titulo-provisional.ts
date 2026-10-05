/**
 * titulo-provisional.ts (#9601, review da PR #9666)
 *
 * O `swap-destaque.ts` troca, no bloco TÍTULO/SUBTÍTULO do topo do
 * `02-reviewed.md`, o título do destaque que saiu pelo título PROVISÓRIO do
 * item promovido — o `title` do item de pool, que é o título da FONTE (às
 * vezes em inglês, ex. "Kolibri Has Landed: A Sovereign Open-Weight Model").
 * O título final só existe depois que o writer-destaque reescreve o bloco
 * `**DESTAQUE N |`. Se a troca provisório → final dependesse só de um passo em
 * prosa no `rerenders_needed`, pular esse passo mandaria o subject/preview do
 * e-mail com o título da fonte.
 *
 * Fechamento mecânico, em 3 peças:
 *   1. o swap grava `_internal/swap-destaque-titulo-pending.json` com
 *      `{ position, provisional_title }` sempre que pôs um provisório no bloco;
 *   2. `swap-destaque.ts --finalize-titulo` troca o provisório pelo título
 *      atual do D{N} e limpa o marcador (passo do `rerenders_needed`);
 *   3. o invariante `titulo-subtitulo-not-provisional` (Stage 4, `error`)
 *      barra o gate enquanto o bloco ainda carregar um provisório que difere
 *      do título atual do D{N} (ou o D{N} ainda for o placeholder do swap).
 *
 * A troca é por SEGMENTO INTEIRO e só na linha da posição: D1 → linha do
 * TÍTULO; D2/D3 → linha do SUBTÍTULO, segmentos separados por ` | `. Nunca
 * por substring (um título que fosse substring de outro alteraria o vizinho).
 *
 * #9668: o título da fonte pode conter ` | ` (`"OpenAI DevDay | TechCrunch"`).
 * Gravado cru, ele virava 2 segmentos e `segs.includes(prov)` nunca casava —
 * invariante mudo e finalize apagando o marcador como `already_final`. Agora
 * (1) o provisório passa por `normalizeItemTitle` + troca de `|` remanescente
 * (`toProvisionalTitulo`) antes de ir pro bloco e pro marcador, e (2) a busca
 * compara a SEQUÊNCIA de segmentos (`findSegmentRun`), o que cobre marcador
 * legado gravado antes deste fix.
 *
 * #9669: a posição do marcador envelhece se `reorder-destaques.ts` roda entre
 * o swap e o finalize (o bloco é re-derivado e o provisório muda de linha).
 * `reorder-destaques.ts` remapeia o marcador (`remapPendingTitulosForReorder`)
 * e, como defesa, invariante/finalize derivam a posição de ONDE o provisório
 * está no bloco (`locateProvisionalTitulo`), não só do campo `position`.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractTitlesFromMd } from "../insert-titulo-subtitulo.ts";
import { normalizeItemTitle } from "./strip-publisher-suffix.ts"; // #9668
import type { InvariantViolation } from "./invariant-checks/types.ts";

export const TITULO_PENDING_MARKER = "swap-destaque-titulo-pending.json";

export interface PendingTitulo {
  position: 1 | 2 | 3;
  provisional_title: string;
}

export function tituloPendingPath(editionDir: string): string {
  return resolve(editionDir, "_internal", TITULO_PENDING_MARKER);
}

/** Lança em JSON malformado/shape inválido — o chamador decide como reportar. */
export function parsePendingTitulos(raw: string): PendingTitulo[] {
  const data = JSON.parse(raw) as { pending?: unknown };
  if (!data || !Array.isArray(data.pending)) {
    throw new Error("campo `pending` ausente ou não é array");
  }
  return data.pending.map((e, i) => {
    const entry = e as Record<string, unknown>;
    const pos = entry.position;
    const title = entry.provisional_title;
    if ((pos !== 1 && pos !== 2 && pos !== 3) || typeof title !== "string" || !title.trim()) {
      throw new Error(`entrada ${i} inválida: ${JSON.stringify(e)}`);
    }
    return { position: pos, provisional_title: title };
  });
}

export function serializePendingTitulos(entries: PendingTitulo[]): string {
  return JSON.stringify({ pending: entries }, null, 2) + "\n";
}

/** Substitui a entrada da mesma posição (swap repetido no mesmo slot). @pure */
export function upsertPendingTitulo(entries: PendingTitulo[], entry: PendingTitulo): PendingTitulo[] {
  return [...entries.filter((e) => e.position !== entry.position), entry].sort(
    (a, b) => a.position - b.position,
  );
}

/**
 * #9668: `|` é o separador de segmento do bloco TÍTULO/SUBTÍTULO — um título
 * que o carregue viraria 2 segmentos. Troca por ` – `. Idempotente. @pure
 */
export function sanitizeTituloSegment(title: string): string {
  return title.replace(/\s*\|\s*/g, " – ").replace(/\s{2,}/g, " ").trim();
}

/**
 * #9668: título da FONTE → provisório gravado no bloco e no marcador. Tira o
 * sufixo de veículo (`normalizeItemTitle`) e troca qualquer `|` que sobrar
 * (prefixo curto demais pro strip, pipe no meio do título). @pure
 */
export function toProvisionalTitulo(sourceTitle: string): string {
  const out = sanitizeTituloSegment(normalizeItemTitle(sourceTitle));
  return out || sanitizeTituloSegment(sourceTitle);
}

/**
 * #9668: posição inicial da sequência contígua de segmentos de `title`
 * (quebrado em `|`) dentro de `segs`; `-1` = ausente. Compara sequência, não
 * `includes` — título com `|` ocupa vários segmentos. @pure
 */
export function findSegmentRun(segs: string[], title: string, from = 0): number {
  const want = title.split("|").map((s) => s.trim());
  if (want.length === 0 || want.every((w) => w === "")) return -1;
  for (let i = from; i + want.length <= segs.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (segs[i + j] !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Índices das linhas de valor do bloco TÍTULO/SUBTÍTULO (header `TÍTULO` nas
 * 40 primeiras linhas, bloco até o 1º `---`). `-1` = linha ausente. @pure
 */
export function locateTituloSubtituloLines(
  lines: string[],
): { titleIdx: number; subtitleIdx: number } | null {
  const scan = Math.min(lines.length, 40);
  let tIdx = -1;
  for (let i = 0; i < scan; i++) {
    if (lines[i].trim() === "TÍTULO") {
      tIdx = i;
      break;
    }
  }
  if (tIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = tIdx + 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) {
      endIdx = i;
      break;
    }
  }
  let sIdx = -1;
  for (let i = tIdx + 1; i < endIdx; i++) {
    if (lines[i].trim() === "SUBTÍTULO") {
      sIdx = i;
      break;
    }
  }
  const firstNonEmpty = (from: number, to: number): number => {
    for (let i = from; i < to; i++) if (lines[i].trim() !== "") return i;
    return -1;
  };
  return {
    titleIdx: firstNonEmpty(tIdx + 1, sIdx >= 0 ? sIdx : endIdx),
    subtitleIdx: sIdx >= 0 ? firstNonEmpty(sIdx + 1, endIdx) : -1,
  };
}

/** Linhas candidatas pra uma posição: D1 → TÍTULO; D2/D3 → SUBTÍTULO; sem posição → ambas. */
function targetLineIdxs(
  loc: { titleIdx: number; subtitleIdx: number },
  position?: 1 | 2 | 3,
): number[] {
  const idxs =
    position === undefined
      ? [loc.titleIdx, loc.subtitleIdx]
      : position === 1
        ? [loc.titleIdx]
        : [loc.subtitleIdx];
  return idxs.filter((i) => i >= 0);
}

/** Segmentos (trim) da(s) linha(s) da posição. @pure */
function tituloSegmentsFor(md: string, position?: 1 | 2 | 3): string[] | null {
  const lines = md.split("\n");
  const loc = locateTituloSubtituloLines(lines);
  if (!loc) return null;
  return targetLineIdxs(loc, position).flatMap((i) => lines[i].split("|").map((s) => s.trim()));
}

/**
 * #9669/#9668: onde o provisório está no bloco, e a POSIÇÃO que esse lugar
 * representa — linha do TÍTULO → D1; SUBTÍTULO, 1º segmento → D2, depois → D3
 * (`renderTituloSubtituloBlock`: `{d2} | {d3}`). Independe do `position`
 * gravado no marcador, que envelhece após `reorder-destaques.ts` — exceto
 * quando o SUBTÍTULO não tem exatamente 2 segmentos: aí o índice é ambíguo e
 * `hintPosition` (D2/D3 do marcador) decide. `null` = provisório ausente do
 * bloco. @pure
 */
export function locateProvisionalTitulo(
  md: string,
  provisionalTitle: string,
  hintPosition?: 1 | 2 | 3,
): 1 | 2 | 3 | null {
  const prov = provisionalTitle.trim();
  if (!prov) return null;
  const lines = md.split("\n");
  const loc = locateTituloSubtituloLines(lines);
  if (!loc) return null;
  const segsOf = (i: number) => lines[i].split("|").map((x) => x.trim());
  if (loc.titleIdx >= 0 && findSegmentRun(segsOf(loc.titleIdx), prov) >= 0) return 1;
  if (loc.subtitleIdx >= 0) {
    const segs = segsOf(loc.subtitleIdx);
    const at = findSegmentRun(segs, prov);
    if (at >= 0) {
      const byIndex = at === 0 ? 2 : 3;
      // SUBTÍTULO fora do formato `{d2} | {d3}` (escrito à mão com 3+
      // segmentos, ou título legado com `|`): o índice não identifica o
      // destaque com segurança — vale a posição do marcador, se for D2/D3.
      const units = segs.length - (prov.split("|").length - 1);
      if (units !== 2 && (hintPosition === 2 || hintPosition === 3)) return hintPosition;
      return byIndex;
    }
  }
  return null;
}

/**
 * #9669: remapeia `position` das entradas do marcador conforme o `newOrder`
 * de `reorder-destaques.ts` (`newOrder[i]` = destaque antigo que vai pra
 * posição `i+1`). Entrada cuja posição não está no `newOrder` fica como está.
 * @pure
 */
export function remapPendingTitulosForReorder(entries: PendingTitulo[], newOrder: number[]): PendingTitulo[] {
  return entries
    .map((e) => {
      const idx = newOrder.indexOf(e.position);
      const next = idx >= 0 ? idx + 1 : e.position;
      return { ...e, position: next as 1 | 2 | 3 };
    })
    .sort((a, b) => a.position - b.position);
}

/**
 * Troca `oldTitle` por `newTitle` no bloco TÍTULO/SUBTÍTULO, por segmento
 * inteiro e só na linha da posição (sem `position`, nas duas linhas). Bloco
 * escrito à mão (sem o título antigo como segmento) fica intocado →
 * `old_title_not_found`. @pure
 */
export function replaceTitleInTituloSubtitulo(
  md: string,
  oldTitle: string | null,
  newTitle: string,
  position?: 1 | 2 | 3,
): { md: string; status: "updated" | "no_block" | "old_title_not_found" } {
  const lines = md.split("\n");
  const loc = locateTituloSubtituloLines(lines);
  if (!loc) return { md, status: "no_block" };
  const old = (oldTitle ?? "").trim();
  if (!old) return { md, status: "old_title_not_found" };
  // #9668: troca a SEQUÊNCIA de segmentos do título antigo (que pode ter `|`)
  // por um segmento só; o novo título nunca leva `|` pro bloco.
  const safeNew = sanitizeTituloSegment(newTitle);
  let hit = false;
  for (const i of targetLineIdxs(loc, position)) {
    const raw = lines[i].split("|");
    const trimmed = raw.map((seg) => seg.trim());
    const wantLen = old.split("|").length;
    const out: string[] = [];
    let k = 0;
    while (k < raw.length) {
      if (findSegmentRun(trimmed.slice(k, k + wantLen), old) === 0) {
        hit = true;
        const lead = raw[k].match(/^\s*/)?.[0] ?? "";
        const trail = raw[k + wantLen - 1].match(/\s*$/)?.[0] ?? "";
        out.push(lead + safeNew + trail);
        k += wantLen;
      } else {
        out.push(raw[k]);
        k++;
      }
    }
    lines[i] = out.join("|");
  }
  if (!hit) return { md, status: "old_title_not_found" };
  return { md: lines.join("\n"), status: "updated" };
}

/** O bloco DESTAQUE N ainda é o placeholder escrito pelo swap? @pure */
export function isSwapPlaceholder(md: string, position: 1 | 2 | 3): boolean {
  return new RegExp(`\\*\\*DESTAQUE\\s+${position}\\s*\\|\\s*\\[RASCUNHO PENDENTE — swap-destaque\\]`).test(md);
}

function currentTitle(md: string, position: 1 | 2 | 3): string | null {
  const t = extractTitlesFromMd(md);
  const v = position === 1 ? t.d1 : position === 2 ? t.d2 : t.d3;
  return v ? v.trim() : null;
}

export interface FinalizeResult {
  md: string;
  finalized: Array<PendingTitulo & { final_title: string | null; status: "updated" | "already_final" }>;
  remaining: Array<PendingTitulo & { reason: string }>;
}

/**
 * Troca cada provisório pendente pelo título ATUAL do D{N}. Fica pendente
 * (não finaliza) se o D{N} ainda é placeholder ou não tem título parseável.
 * Provisório que já não está no bloco (editor reescreveu) conta como
 * finalizado. @pure
 */
export function finalizeProvisionalTitulos(md: string, entries: PendingTitulo[]): FinalizeResult {
  let out = md;
  const finalized: FinalizeResult["finalized"] = [];
  const remaining: FinalizeResult["remaining"] = [];
  for (const entry of entries) {
    // #9669: posição real = onde o provisório está no bloco (o marcador pode
    // ter envelhecido num reorder); #9668: busca por sequência de segmentos.
    const where = locateProvisionalTitulo(out, entry.provisional_title, entry.position);
    if (where === null) {
      finalized.push({ ...entry, final_title: null, status: "already_final" });
      continue;
    }
    const e: PendingTitulo = { ...entry, position: where };
    if (isSwapPlaceholder(out, e.position)) {
      remaining.push({ ...e, reason: `D${e.position} ainda é o placeholder do swap — rodar o writer-destaque antes` });
      continue;
    }
    const final = currentTitle(out, e.position);
    if (!final) {
      remaining.push({ ...e, reason: `título do D${e.position} não encontrado em 02-reviewed.md` });
      continue;
    }
    // `|` no título final vira ` – ` no bloco (sanitizeTituloSegment): compara
    // na forma que o bloco gravaria.
    if (sanitizeTituloSegment(final) === e.provisional_title.trim()) {
      finalized.push({ ...e, final_title: final, status: "already_final" });
      continue;
    }
    const r = replaceTitleInTituloSubtitulo(out, e.provisional_title, final, e.position);
    out = r.md;
    finalized.push({ ...e, final_title: final, status: "updated" });
  }
  return { md: out, finalized, remaining };
}

/**
 * Invariante Stage 4 `titulo-subtitulo-not-provisional`: com marcador do swap
 * presente, o bloco TÍTULO/SUBTÍTULO não pode chegar ao gate com o título
 * provisório (título da fonte) quando o D{N} já tem outro título, nem com o
 * D{N} ainda em placeholder.
 */
export function checkTituloSubtituloNotProvisional(editionDir: string): InvariantViolation[] {
  const markerPath = tituloPendingPath(editionDir);
  if (!existsSync(markerPath)) return [];
  const mdPath = resolve(editionDir, "02-reviewed.md");
  const fix = `npx tsx scripts/swap-destaque.ts --finalize-titulo --edition-dir ${editionDir}`;
  let entries: PendingTitulo[];
  try {
    entries = parsePendingTitulos(readFileSync(markerPath, "utf8"));
  } catch (e) {
    return [
      {
        rule: "titulo-subtitulo-not-provisional",
        message: `marcador ${TITULO_PENDING_MARKER} ilegível (${(e as Error).message}) — conferir o TÍTULO/SUBTÍTULO à mão e rodar ${fix}`,
        source_issue: "#9601",
        severity: "error",
        file: markerPath,
      },
    ];
  }
  if (!existsSync(mdPath)) return [];
  const md = readFileSync(mdPath, "utf8");
  const violations: InvariantViolation[] = [];
  for (const e of entries) {
    const prov = e.provisional_title.trim();
    // #9668/#9669: sequência de segmentos + posição derivada do bloco.
    const where = locateProvisionalTitulo(md, prov, e.position);
    if (where === null) continue;
    const pos = where;
    const stale = pos !== e.position ? ` (marcador dizia D${e.position}; reorder depois do swap?)` : "";
    if (isSwapPlaceholder(md, pos)) {
      violations.push({
        rule: "titulo-subtitulo-not-provisional",
        message:
          `D${pos} ainda é o placeholder do swap-destaque e o TÍTULO/SUBTÍTULO carrega o título provisório ` +
          `"${prov}" (título da fonte)${stale}. Rodar o writer-destaque do D${pos} e depois ${fix}`,
        source_issue: "#9601",
        severity: "error",
        file: mdPath,
      });
      continue;
    }
    const final = currentTitle(md, pos);
    if (final && sanitizeTituloSegment(final) !== prov) {
      violations.push({
        rule: "titulo-subtitulo-not-provisional",
        message:
          `TÍTULO/SUBTÍTULO ainda carrega o título provisório "${prov}" (título da fonte, do swap-destaque), ` +
          `mas o D${pos} agora é "${final}"${stale} — o subject/preview do e-mail sairia com o título da fonte. Fix: ${fix}`,
        source_issue: "#9601",
        severity: "error",
        file: mdPath,
      });
    }
  }
  return violations;
}
