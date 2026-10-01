/**
 * lib/editor-rejected-items.ts (#9360)
 *
 * Itens que o EDITOR cortou no gate do Stage 4 nas últimas N edições —
 * consumido pelo dedup do Stage 1 (`scripts/dedup.ts`, Pass 1r) do mesmo jeito
 * que `past-editions.md` é consumido pelo Pass 1.
 *
 * Por que existe: item cortado nunca é publicado, então nunca entra em
 * `past-editions.md` e o dedup não o barra no dia seguinte. Casos reais
 * (issue #9360): "OpenAI Pauses Training..." (wired.com) cortado em 260930 E
 * 261001; "Gemma 4" (deepmind.google) e "Local Agentic AI Workflows with
 * Hermes + Ollama" cortados em 260929 E 260930.
 *
 * Registro DERIVADO, não persistido: para cada edição da janela, compara os
 * links de item (`**[título](url)**`) da SAÍDA DA PIPELINE do Stage 2 (o
 * último arquivo intermediário escrito antes do editor tocar a edição) com
 * TODOS os links do `02-reviewed.md` final. URL de item da pipeline que não
 * aparece em lugar nenhum do final = corte do editor. Mover de seção, promover
 * a destaque ou rebaixar pra "Aprofunde:" mantêm a URL e não contam como corte.
 *
 * Não depende do snapshot `editor-request-snapshots/stage2-post-gate/` — ele
 * é gravado DEPOIS da edição humana (#9356) e daria diff vazio. Os arquivos
 * `_internal/02-*.md` da pipeline são escritos uma vez no Stage 2 e nunca
 * regravados pelo gate, então servem de referência pré-edição (mesmo critério
 * de backfill proposto no #9356: o de maior mtime).
 *
 * Fail-soft: edição sem `02-reviewed.md` ou sem arquivo de pipeline é pulada
 * (edição em curso, layout legado) — nunca lança.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalize } from "./url-utils.ts";
import { enumerateEditionDirs } from "./find-current-edition.ts";
import { recentEditionDirs } from "./past-editions-extract.ts";

export interface EditorRejectedItem {
  url: string;
  title: string;
  /** AAMMDD da edição em que o editor cortou o item. */
  edition: string;
}

/**
 * Saídas da pipeline do Stage 2 (newsletter), relativas ao dir da edição.
 * A ordem de escrita varia entre edições (humanizador antes/depois da Clarice),
 * então o escolhido é o de maior mtime — o último que a PIPELINE escreveu.
 */
export const PIPELINE_OUTPUT_CANDIDATES = [
  "_internal/02-humanized.md",
  "_internal/02-clarice-corrected.md",
  "_internal/02-pre-clarice.md",
  "_internal/02-normalized.md",
  "_internal/02-draft.md",
] as const;

const ITEM_LINK_RE = /^\s*\*\*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\*\*/;
const ANY_LINK_RE = /\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;

/** Pure: links de item (linha `**[título](url)**`) de um markdown de newsletter. */
export function extractItemLinks(md: string): { title: string; url: string }[] {
  const out: { title: string; url: string }[] = [];
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(ITEM_LINK_RE);
    if (m) out.push({ title: m[1].trim(), url: m[2] });
  }
  return out;
}

/** Pure: URLs canônicas de TODOS os links markdown do texto. */
export function extractAllLinkUrls(md: string): Set<string> {
  const urls = new Set<string>();
  for (const m of md.matchAll(ANY_LINK_RE)) urls.add(canonicalize(m[1]));
  return urls;
}

/**
 * Pure: itens da saída da pipeline ausentes do final. Dedup por URL canônica
 * (o mesmo link pode aparecer 2x no markdown — destaque + "Aprofunde:").
 */
export function diffRejectedItems(
  pipelineMd: string,
  finalMd: string,
  edition: string,
): EditorRejectedItem[] {
  const finalUrls = extractAllLinkUrls(finalMd);
  const seen = new Set<string>();
  const out: EditorRejectedItem[] = [];
  for (const { title, url } of extractItemLinks(pipelineMd)) {
    const canon = canonicalize(url);
    if (finalUrls.has(canon) || seen.has(canon)) continue;
    seen.add(canon);
    out.push({ url, title, edition });
  }
  return out;
}

/** Path absoluto da saída da pipeline mais recente (maior mtime), ou null. */
export function resolvePipelineOutput(editionDir: string): string | null {
  let best: { path: string; mtime: number } | null = null;
  for (const rel of PIPELINE_OUTPUT_CANDIDATES) {
    const p = resolve(editionDir, rel);
    if (!existsSync(p)) continue;
    const mtime = statSync(p).mtimeMs;
    if (!best || mtime > best.mtime) best = { path: p, mtime };
  }
  return best?.path ?? null;
}

/**
 * Itens cortados pelo editor nas últimas `window` edições reais de
 * `editionsDir` (edição corrente excluída — mesma janela de
 * `extractPastDestaqueUrls`).
 */
export function extractEditorRejectedItems(
  editionsDir: string,
  window: number,
  currentAammdd?: string,
): EditorRejectedItem[] {
  if (!existsSync(editionsDir)) return [];
  const dirsByAammdd = enumerateEditionDirs(editionsDir);
  const out: EditorRejectedItem[] = [];
  for (const aammdd of recentEditionDirs(editionsDir, window, currentAammdd)) {
    const editionDir = dirsByAammdd.get(aammdd);
    if (!editionDir) continue;
    const finalPath = resolve(editionDir, "02-reviewed.md");
    const pipelinePath = resolvePipelineOutput(editionDir);
    if (!pipelinePath || !existsSync(finalPath)) continue;
    try {
      out.push(
        ...diffRejectedItems(
          readFileSync(pipelinePath, "utf8"),
          readFileSync(finalPath, "utf8"),
          aammdd,
        ),
      );
    } catch {
      // arquivo ilegível — fail-soft, igual aos demais extratores da janela
    }
  }
  return out;
}
