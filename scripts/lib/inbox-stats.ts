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
interface InjectMarkerFields {
  total_editor_urls?: number;
  total_newsletter_urls?: number;
  total_pool_size?: number;
  newsletter_source?: string;
  captured_newsletter_count?: number;
  capture_failed?: boolean;
  capture_error?: string;
}

function readInjectMarker(internalDir: string): InjectMarkerFields | null {
  const markerPath = join(internalDir, ".marker-inject-inbox-urls.json");
  if (!existsSync(markerPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf8")) as InjectMarkerFields & {
      details?: InjectMarkerFields;
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

/**
 * #1541: conta entradas em `{internalDir}/captured-newsletters.json` — 1 por
 * newsletter thread capturada (não por URL extraída). Duplica
 * `readCapturedNewsletterCount` de `sync-coverage-line.ts` (mesmo arquivo,
 * mesma semântica) — mantido aqui pra `getTotalEditorSubmissions` não
 * importar de `scripts/sync-coverage-line.ts` (script top-level, não lib).
 */
function readCapturedNewsletterCountFile(internalDir: string): number {
  const capPath = join(internalDir, "captured-newsletters.json");
  if (!existsSync(capPath)) return 0;
  try {
    const data = JSON.parse(readFileSync(capPath, "utf8"));
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * #3696: X real de "enviados por mim" = blocos do inbox archive
 * (`countEditorSubmissions`) + newsletters capturadas fora do inbox.md
 * quando o marker sinaliza `newsletter_source: "captured-articles"`
 * (`fetch-newsletter-threads.ts` → `capture-newsletter-urls.ts`, Stage 0
 * §0b-bis — Cyberman/Superhuman/TLDR/Lenny's/Marktechpost/7min.ai).
 *
 * Bug raiz (#3696): quando as newsletters vêm pelo caminho "captured-articles"
 * (refatoração #1520, "no inbox.md intermediary"), elas NUNCA criam bloco em
 * `inbox.md` — `countEditorSubmissions` sozinha não tem visibilidade sobre
 * elas, subcontando X. Caso real 260720: `countEditorSubmissions` = 3
 * (editor_blocks), mas `captured_newsletter_count` = 9 — X correto = 12.
 *
 * Quando `newsletter_source` é `"inbox-md"` (newsletters forwardadas
 * preservando o sender original, sem o caminho de captura), os blocos JÁ
 * estão no inbox.md e `countEditorSubmissions` (que conta TODOS os blocos,
 * #1486) já os inclui — somar `captured_newsletter_count` aqui duplicaria.
 * Só soma quando `newsletter_source === "captured-articles"` (0 blocos
 * gravados nesse caminho, #1520).
 *
 * Marker ausente/incompleto → apenas `countEditorSubmissions` (comportamento
 * anterior, sem dado extra disponível pra somar).
 *
 * Mesma lógica de composição que `sync-coverage-line.ts:readSubmissionsCountFromMarker`
 * já implementa (via `editor_blocks + captured_newsletter_count`) — aqui
 * reescrita sobre a contagem de blocos do ARCHIVE (não o `editor_blocks` do
 * marker), que é o dado disponível em `apply-gate-edits.ts` (Stage 1, roda
 * antes do inbox.md ser arquivado — #680).
 */
export function getTotalEditorSubmissions(
  inboxArchivePath: string,
  internalDir: string,
  editorEmail?: string,
): number {
  const directBlocks = countEditorSubmissions(inboxArchivePath, editorEmail);
  const marker = readInjectMarker(internalDir);
  if (!marker || marker.newsletter_source !== "captured-articles") return directBlocks;
  const captured =
    typeof marker.captured_newsletter_count === "number"
      ? marker.captured_newsletter_count
      : readCapturedNewsletterCountFile(internalDir);
  return directBlocks + captured;
}

/**
 * #3709: mesmo guard que `sync-coverage-line.ts:readCaptureFailedFromMarker`
 * (#2878) já aplica no Stage 2, agora também no Stage 1 (`apply-gate-edits.ts`,
 * ponto de chamada mais cedo no pipeline). Quando `fetch-newsletter-threads.ts`
 * (Stage 0 §0b-bis) falha por auth/rede, `newsletter_source` pode resolver pra
 * `"captured-articles"` com `captured_newsletter_count: 0` (ou cair pra
 * `"inbox-md"`), e `getTotalEditorSubmissions` compõe silenciosamente um X
 * plausível mas errado — mesmo failure mode que #2878 corrigiu no Stage 2, um
 * stage antes.
 *
 * Duplica (não importa) a lógica equivalente de `scripts/sync-coverage-line.ts`
 * pelo mesmo motivo de `readCapturedNewsletterCountFile` acima: este módulo é
 * lib, aquele é script top-level — evita import script→script.
 *
 * Retorna `{ failed: false }` quando o marker está ausente, corrompido, ou não
 * sinaliza falha — nunca inventa `failed: true` por ausência de dado.
 */
export function readCaptureFailedFromMarker(
  internalDir: string,
): { failed: boolean; error?: string } {
  const data = readInjectMarker(internalDir);
  if (!data) return { failed: false };
  if (data.capture_failed === true) {
    return { failed: true, error: data.capture_error ?? "motivo desconhecido" };
  }
  return { failed: false };
}

/**
 * #3709: mesmo texto de aviso que `sync-coverage-line.ts:renderCaptureFailedLine`
 * (#2878) — trocado por `formatCoverageLine` quando `readCaptureFailedFromMarker`
 * sinaliza falha, pra não afirmar um X que não pode confiar já no
 * `01-approved.json` (`apply-gate-edits.ts`, Stage 1).
 */
export function renderCaptureFailedLine(reason: string): string {
  return `⚠️ contagem de submissões indisponível (captura de newsletters falhou: ${reason}) — recompute após reautenticar.`;
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
 * Formata o bloco de boas-vindas/cobertura no formato canônico (#3461,
 * substitui o formato legado #592/#609 a partir da edição 260715 — pedido
 * explícito do editor: "salve como padrão: todas as edições devem começar
 * com esse texto").
 *
 * 4 parágrafos (separados por `\n\n`), SEM negrito — texto corrido no topo
 * da edição, não um box com borda. `[Pixel](...)` e `[considere apoiar o
 * projeto](...)` são links markdown que `processInlineLinks` converte em
 * `<a>` no render (ver `renderCoverage`, que precisa processar links, não
 * escapar texto puro).
 *
 * #701: pluralização condicional pra concordância numérica em PT-BR — antes
 * "1 artigos"/"o(s) N mais relevante(s)" caía no leitor. Caller é livre pra
 * passar `selected = 0` (caso degenerado), mas a frase fica esquisita.
 *
 * Regex em `lib/lint-checks/coverage-line-format.ts` (`COVERAGE_LINE_RE`)
 * precisa reconhecer este formato pra `checkCoverageLine`/`sync-coverage-line.ts`
 * não acusarem falso-positivo de "linha de cobertura ausente".
 */
export function formatCoverageLine(args: {
  editorSubmissions: number;
  diariaDiscovered: number;
  selected: number;
}): string {
  const total = args.editorSubmissions + args.diariaDiscovered;
  const selPhrase =
    args.selected === 1
      ? "selecionei o artigo mais relevante"
      : `selecionei os ${args.selected} mais relevantes`;
  // #3731: pluralização condicional também pra "artigos"/"enviados"/"encontrados"
  // — o comentário #701 acima só cobria `selPhrase`; "1 artigos"/"1 enviados"/
  // "1 encontrados" ainda caíam no leitor quando total/editorSubmissions/
  // diariaDiscovered valiam 1.
  const totalWord = total === 1 ? "artigo" : "artigos";
  const enviadosWord = args.editorSubmissions === 1 ? "enviado" : "enviados";
  const encontradosWord = args.diariaDiscovered === 1 ? "encontrado" : "encontrados";
  return [
    "Olá! Eu sou o [Pixel](https://www.linkedin.com/in/vjpixel/), editor dessa newsletter.",
    "Todos os dias, junto com a IA da diar.ia.br, seleciono e resumo as notícias mais importantes para economizar o seu tempo.",
    `Nesta edição, a IA analisou ${total} ${totalWord} (${args.editorSubmissions} ${enviadosWord} por mim e ${args.diariaDiscovered} ${encontradosWord} automaticamente) e ${selPhrase}.`,
    "Se esse trabalho faz diferença para você, [considere apoiar o projeto](https://apoia.se/diaria).",
  ].join("\n\n");
}
