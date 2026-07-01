/**
 * inbox-stats.ts (#592, #609)
 *
 * Conta submissões do editor no archive da edição. Usado pela linha de
 * cobertura do `01-categorized.md` e do `02-reviewed.md`:
 *
 *   "Para esta edição, eu (o editor) enviei {X} submissões e a Diar.ia
 *    encontrou outros {Y} artigos. Selecionamos os {Z} mais relevantes
 *    para as pessoas que assinam a newsletter."
 *
 * #609: usa "submissões" (não "artigos enviados") — cada bloco de inbox
 * conta como 1 submissão, independente de quantas URLs venham dentro
 * (forwards de newsletter podem ter dezenas de URLs mas representam 1
 * ação editorial de envio).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLARICE_SEED_EMAIL } from "./clarice-seed.ts";

/**
 * #2697 item 2 (self-review #2696) — antes este módulo duplicava o literal
 * `"vjpixel@gmail.com"` como constante própria (`DEFAULT_EDITOR_EMAIL`), separada
 * de `CLARICE_SEED_EMAIL` em `clarice-seed.ts`. Mesmo endereço, mesmo conceito
 * ("email pessoal do editor"), duas fontes de verdade — deriva de
 * `CLARICE_SEED_EMAIL` em vez de redeclarar o literal.
 */
const DEFAULT_EDITOR_EMAIL = CLARICE_SEED_EMAIL;

/**
 * #1864: número de LINKS que entraram pelo canal do editor (forwards diretos +
 * newsletters) — `total_editor_urls + total_newsletter_urls` do marker
 * `.marker-inject-inbox-urls.json` (escrito pelo inject-inbox-urls).
 *
 * Usado pra calcular Y ("a Diar.ia encontrou outros Y artigos") como
 * `total_pool_links − inbox_links`. O bug do #1864: Y subtraía a contagem de
 * EMAILS (X) da contagem de LINKS (pool), misturando unidades → "Diar.ia
 * encontrou" inflado. X conta e-mails (submissões), Y conta links — os links do
 * editor (inbox) são subtraídos do pool pra sobrar só o que a Diar.ia descobriu.
 *
 * Retorna null se o marker ausente/sem os campos (caller faz fallback).
 */
function readInjectMarker(internalDir: string): {
  total_editor_urls?: number;
  total_newsletter_urls?: number;
  total_pool_size?: number;
} | null {
  const markerPath = join(internalDir, ".marker-inject-inbox-urls.json");
  if (!existsSync(markerPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf8")) as {
      total_editor_urls?: number;
      total_newsletter_urls?: number;
      total_pool_size?: number;
      details?: { total_editor_urls?: number; total_newsletter_urls?: number; total_pool_size?: number };
    };
    return raw.details ?? raw;
  } catch {
    return null;
  }
}

export function readInboxLinkCountFromMarker(internalDir: string): number | null {
  const data = readInjectMarker(internalDir);
  if (!data) return null;
  const e = typeof data.total_editor_urls === "number" ? data.total_editor_urls : null;
  const n = typeof data.total_newsletter_urls === "number" ? data.total_newsletter_urls : null;
  if (e === null && n === null) return null;
  return (e ?? 0) + (n ?? 0);
}

/**
 * #1864: tamanho do pool BRUTO (pré-dedup/filtro) = `total_pool_size` do mesmo
 * marker. Pareado com `readInboxLinkCountFromMarker` (também pré-filtro) pra
 * computar Y = pool_bruto − inbox_links de forma STAGE-CONSISTENTE — subtrair os
 * links do editor (pré-filtro) de um total pós-filtro (totalConsidered) zerava o
 * Y (review #1882: 138 categorizados − 157 injetados = max(0,−19)=0).
 *
 * Retorna null se ausente (caller faz fallback).
 */
export function readInjectPoolSizeFromMarker(internalDir: string): number | null {
  const data = readInjectMarker(internalDir);
  if (!data || typeof data.total_pool_size !== "number") return null;
  return data.total_pool_size;
}

/**
 * Pure (#1864): Y da linha de cobertura ("a Diar.ia encontrou outros Y artigos")
 * = nº de LINKS descobertos pela Diar.ia (fora do canal do editor).
 *
 * Caminho preferido (STAGE-CONSISTENTE): `rawPoolSize − inboxLinks`, ambos
 * pré-filtro do marker do inject. Fallback (marker ausente): `totalConsidered −
 * editorSubmissions` (comportamento legado — mistura unidades, mas é o melhor
 * disponível sem o marker). `null` quando nenhum total é conhecido.
 */
export function computeDiariaDiscovered(opts: {
  rawPoolSize: number | null;
  inboxLinks: number | null;
  totalConsidered: number | null;
  editorSubmissions: number;
}): number | null {
  if (opts.rawPoolSize !== null && opts.inboxLinks !== null) {
    return Math.max(0, opts.rawPoolSize - opts.inboxLinks);
  }
  if (opts.totalConsidered !== null) {
    return Math.max(0, opts.totalConsidered - opts.editorSubmissions);
  }
  return null;
}

/**
 * Conta TODOS os blocos no archive como submissões do editor (#1486).
 *
 * Antes (#592), filtrava por `from:` === editorEmail, mas forwards de
 * newsletters (7min.ai, AlphaSignal, etc.) chegam com `from:` do sender
 * original — o editor apenas fez forward. Todos os blocos existem porque
 * o editor os enviou, então contamos todos.
 *
 * `_editorEmail` mantido para backwards compat mas não é mais usado.
 *
 * Retorna 0 se arquivo ausente, malformado, ou vazio.
 */
export function countEditorSubmissions(
  inboxArchivePath: string,
  _editorEmail?: string,
): number {
  if (!existsSync(inboxArchivePath)) return 0;
  let text: string;
  try {
    text = readFileSync(inboxArchivePath, "utf8");
  } catch {
    return 0;
  }
  const blocks = text.split(/^## /m).slice(1);
  return blocks.length;
}

// (resolveInboxArchivePath removida em #1008 — dead code, knip findings)

/**
 * Lê o email do editor (linha "from") de platform.config.json se houver
 * configuração, senão retorna o default `vjpixel@gmail.com`.
 *
 * Lê `inbox.editor_personal_email` (campo novo) — distinto de
 * `inbox.address` (que é o destino diariaeditor@gmail.com, não o sender).
 */
export function resolveEditorEmail(platformConfigPath: string): string {
  if (!existsSync(platformConfigPath)) return DEFAULT_EDITOR_EMAIL;
  try {
    const cfg = JSON.parse(readFileSync(platformConfigPath, "utf8")) as {
      inbox?: { editor_personal_email?: string };
    };
    return cfg.inbox?.editor_personal_email ?? DEFAULT_EDITOR_EMAIL;
  } catch {
    return DEFAULT_EDITOR_EMAIL;
  }
}

/**
 * Formata a linha de cobertura no formato canônico (#592 + #609).
 *
 * #701: pluralização condicional pra concordância numérica em PT-BR — antes
 * "1 submissões"/"1 artigos" caía no leitor. Caller é livre pra passar
 * `selected = 0` (caso degenerado), mas a frase fica esquisita.
 *
 * Regex em `lint-newsletter-md.ts COVERAGE_LINE_RE` aceita ambas as formas
 * (singular e plural).
 */
export function formatCoverageLine(args: {
  editorSubmissions: number;
  diariaDiscovered: number;
  selected: number;
}): string {
  const subWord = args.editorSubmissions === 1 ? "submissão" : "submissões";
  const artWord = args.diariaDiscovered === 1 ? "artigo" : "artigos";
  const selPhrase =
    args.selected === 1
      ? "Selecionamos o artigo mais relevante"
      : `Selecionamos os ${args.selected} mais relevantes`;
  return (
    `Para esta edição, eu (o editor) enviei ${args.editorSubmissions} ${subWord} e a ` +
    `Diar.ia encontrou outros ${args.diariaDiscovered} ${artWord}. ${selPhrase} ` +
    `para as pessoas que assinam a newsletter.`
  );
}
