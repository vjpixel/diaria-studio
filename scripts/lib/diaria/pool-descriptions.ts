/**
 * pool-descriptions.ts (#13884, item 2 da issue)
 *
 * Decisão do editor de 25/11/2026: a descrição de cada item de LANÇAMENTOS,
 * RADAR, USE MELHOR e VÍDEOS passa a ser escrita a partir do texto LIDO da
 * página (`_internal/pool-sources/`, baixado no passo 0 do Stage 2), não só do
 * `summary` do Stage 1. O `stitch-newsletter.ts` segue determinístico e monta
 * o `02-draft.md` com a descrição do `summary`; este módulo cerca o passo de
 * LLM que vem logo depois:
 *
 *   1. `buildPoolDescriptionsInput` lista os itens do `02-draft.md` cuja página
 *      foi baixada com texto real, com o caminho do texto e a descrição atual
 *      (`_internal/02-pool-descriptions-input.json`). É o input do agent
 *      `writer-pool`, que grava `_internal/02-pool-descriptions.json`.
 *   2. `applyPoolDescriptions` troca, no `02-draft.md`, a linha de descrição de
 *      cada item pela que o `writer-pool` escreveu, depois de validar a forma
 *      (tamanho, sem markdown, sem seta, sem URL). Para USE MELHOR preserva a
 *      estimativa de tempo da descrição anterior quando a nova não traz uma.
 *   3. Cada URL aplicada vai para `pool-sources/descriptions-applied.json`, que
 *      é o que faz o `source-not-read` contar a página como LIDA
 *      (`readSourceDownloads`). URL rejeitada ou fora do registro segue na
 *      regra do resumo e, se for o caso, bloqueia o gate 4.
 *
 * O texto baixado é DADO NÃO CONFIÁVEL: o agent é instruído a nunca seguir
 * instrução que venha dele, e a validação aqui barra a forma (não o conteúdo).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { USE_MELHOR_TEMPO_RE } from "../lint-checks/use-melhor-tempo.ts";
import {
  POOL_DESCRIPTIONS_APPLIED,
  POOL_SOURCES_DIR,
  readPoolDescriptionsApplied,
  readPoolSourcesManifest,
  type PoolBucket,
  type PoolDescriptionApplied,
} from "./pool-sources.ts";
import { SOURCE_SUMMARY_MIN_CHARS, SOURCE_TEXT_MIN_WORDS } from "./source-readability.ts";

export const POOL_DESCRIPTIONS_INPUT = "02-pool-descriptions-input.json";
export const POOL_DESCRIPTIONS_OUTPUT = "02-pool-descriptions.json";

/** Teto da descrição reescrita (as do `summary` saem com até ~150, #1572). */
export const POOL_DESCRIPTION_MAX_CHARS = 280;
/** Piso: o mesmo do resumo que conta como lido (#12258). */
export const POOL_DESCRIPTION_MIN_CHARS = SOURCE_SUMMARY_MIN_CHARS;

export interface PoolDescriptionInputItem {
  url: string;
  bucket: PoolBucket;
  title: string;
  /** Descrição que o stitch montou do `summary` (sem `[TRADUZIR]`). */
  current_description: string;
  /** Caminho absoluto do texto da página. */
  source_text_path: string;
}

export interface PoolDescriptionsInput {
  draft_path: string;
  items: PoolDescriptionInputItem[];
  /** Itens de pool do draft sem texto utilizável, com o motivo. */
  skipped: Array<{ url: string; title: string; reason: string }>;
}

/** Linha de item de seção secundária do stitch: `**[título](url)**`. */
function itemLineIndex(lines: string[], url: string): number {
  return lines.findIndex((l) => l.trimStart().startsWith("**[") && l.includes(`](${url})**`));
}

/** Índice da linha de descrição que segue a linha do item, ou -1. @pure */
function descriptionLineIndex(lines: string[], itemIdx: number): number {
  const next = itemIdx + 1;
  if (next >= lines.length) return -1;
  const l = lines[next];
  if (!l.trim() || l.trimStart().startsWith("**")) return -1;
  return next;
}

/**
 * Monta o input do `writer-pool`: itens de pool presentes no draft com texto
 * baixado utilizável (status `ok`, não prévia de paywall, com palavras
 * suficientes). @pure sobre (manifest, draft)
 */
export function buildPoolDescriptionsInput(internalDir: string, draftPath: string, draftMd: string): PoolDescriptionsInput {
  const lines = draftMd.split("\n");
  const items: PoolDescriptionInputItem[] = [];
  const skipped: PoolDescriptionsInput["skipped"] = [];
  const dir = join(internalDir, POOL_SOURCES_DIR);
  for (const e of readPoolSourcesManifest(internalDir)) {
    const idx = itemLineIndex(lines, e.url);
    if (idx < 0) continue; // item fora do draft (cortado pelo cap ou só no manifest)
    if (e.status !== "ok" || !e.file) {
      skipped.push({ url: e.url, title: e.title, reason: e.erro ?? e.status });
      continue;
    }
    if (e.completeness === "preview") {
      skipped.push({ url: e.url, title: e.title, reason: "só a prévia do paywall foi baixada" });
      continue;
    }
    if (typeof e.words === "number" && e.words < SOURCE_TEXT_MIN_WORDS) {
      skipped.push({ url: e.url, title: e.title, reason: `página baixada com ${e.words} palavras (mínimo ${SOURCE_TEXT_MIN_WORDS})` });
      continue;
    }
    const path = join(dir, e.file);
    if (!existsSync(path)) {
      skipped.push({ url: e.url, title: e.title, reason: "texto da página ausente em disco" });
      continue;
    }
    const dIdx = descriptionLineIndex(lines, idx);
    const current = dIdx >= 0 ? lines[dIdx].replace(/^\[TRADUZIR\]\s*/, "").trim() : "";
    items.push({ url: e.url, bucket: e.bucket, title: e.title, current_description: current, source_text_path: path });
  }
  return { draft_path: draftPath, items, skipped };
}

/** Motivo de rejeição da descrição, ou `null` se a forma está ok. @pure */
export function validatePoolDescription(desc: string): string | null {
  const d = desc.trim();
  if (!d) return "descrição vazia";
  if (/\n/.test(d)) return "descrição com mais de uma linha";
  if (d.length < POOL_DESCRIPTION_MIN_CHARS) return `descrição de ${d.length} caracteres (mínimo ${POOL_DESCRIPTION_MIN_CHARS})`;
  if (d.length > POOL_DESCRIPTION_MAX_CHARS) return `descrição de ${d.length} caracteres (máximo ${POOL_DESCRIPTION_MAX_CHARS})`;
  if (/\*\*|^#|^[-*]\s|\]\(/.test(d)) return "descrição com markdown";
  if (/[→←]/.test(d)) return "descrição com seta (#9721)";
  if (/https?:\/\//i.test(d)) return "descrição com URL";
  if (/\[TRADUZIR\]/.test(d)) return "descrição com [TRADUZIR]";
  return null;
}

export interface PoolDescriptionsApplyResult {
  md: string;
  applied: Array<{ url: string; description: string }>;
  rejected: Array<{ url: string; reason: string }>;
}

/**
 * Aplica as descrições no draft. Só URLs presentes no `input` (as que têm
 * texto lido) são aceitas: descrição para outra URL é rejeitada. @pure
 */
export function applyPoolDescriptions(
  draftMd: string,
  input: PoolDescriptionsInput,
  descriptions: ReadonlyArray<{ url?: unknown; description?: unknown }>,
): PoolDescriptionsApplyResult {
  const lines = draftMd.split("\n");
  const byUrl = new Map(input.items.map((i) => [i.url, i]));
  const applied: PoolDescriptionsApplyResult["applied"] = [];
  const rejected: PoolDescriptionsApplyResult["rejected"] = [];
  const done = new Set<string>();
  for (const d of descriptions) {
    const url = typeof d?.url === "string" ? d.url : null;
    if (!url) continue;
    const item = byUrl.get(url);
    if (!item) {
      rejected.push({ url, reason: "URL sem texto lido no input do writer-pool" });
      continue;
    }
    if (done.has(url)) continue;
    let desc = typeof d.description === "string" ? d.description.trim() : "";
    const bad = validatePoolDescription(desc);
    if (bad) {
      rejected.push({ url, reason: bad });
      continue;
    }
    if (item.bucket === "use_melhor" && !USE_MELHOR_TEMPO_RE.test(desc)) {
      // Estimativa da descrição anterior (medida do body ou heurística, #6739),
      // no formato canônico `(X min)` (#2450).
      const minutes = item.current_description.match(USE_MELHOR_TEMPO_RE)?.[0].match(/\d+/)?.[0];
      if (minutes) desc = `${desc.trimEnd()} (${minutes} min)`;
    }
    const idx = itemLineIndex(lines, url);
    if (idx < 0) {
      rejected.push({ url, reason: "item não encontrado no draft" });
      continue;
    }
    const dIdx = descriptionLineIndex(lines, idx);
    if (dIdx >= 0) lines[dIdx] = desc;
    else lines.splice(idx + 1, 0, desc);
    done.add(url);
    applied.push({ url, description: desc });
  }
  return { md: lines.join("\n"), applied, rejected };
}

/** Acrescenta as URLs aplicadas ao registro (`descriptions-applied.json`). */
export function recordPoolDescriptionsApplied(
  internalDir: string,
  input: PoolDescriptionsInput,
  appliedUrls: string[],
  now: () => Date = () => new Date(),
): string {
  const current = readPoolDescriptionsApplied(internalDir);
  const files = new Map(input.items.map((i) => [i.url, i.source_text_path]));
  for (const url of appliedUrls) {
    const p = files.get(url);
    if (!p) continue;
    current.set(url, { url, file: p.split(/[\\/]/).pop()!, applied_at: now().toISOString() });
  }
  const path = join(internalDir, POOL_SOURCES_DIR, POOL_DESCRIPTIONS_APPLIED);
  writeFileSync(path, JSON.stringify([...current.values()] satisfies PoolDescriptionApplied[], null, 2), "utf8");
  return path;
}

/** Lê o output do `writer-pool`; aceita `{descriptions: [...]}` ou o array direto. */
export function readPoolDescriptionsOutput(path: string): Array<{ url?: unknown; description?: unknown }> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (Array.isArray(raw)) return raw;
  const list = (raw as { descriptions?: unknown } | null)?.descriptions;
  if (!Array.isArray(list)) throw new Error(`${path}: esperado { "descriptions": [{ "url", "description" }] }`);
  return list;
}
