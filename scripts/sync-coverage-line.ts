#!/usr/bin/env npx tsx
/**
 * sync-coverage-line.ts (#1097, refined em #1323)
 *
 * Auto-calcula e sincroniza a linha de cobertura no `02-reviewed.md`:
 *
 *   "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia
 *    encontrou outros Y artigos. Selecionamos os Z mais relevantes para
 *    as pessoas que assinam a newsletter."
 *
 * X = número de **e-mails recebidos em diariaeditor@gmail.com** (cada
 *     thread/forward = 1, independente de quantas URLs ele contém). Conta
 *     tanto forwards diretos do editor (From: editor) quanto forwards de
 *     newsletters cujo sender foi preservado pelo cliente (From: brand).
 *     Fonte preferida: marker da Stage 1 (soma editor_blocks +
 *     newsletter_blocks); fallback: inbox-archive; last resort: inbox.md.
 *
 * Y = `total_pool_initial - X`. Artigos que vieram de RSS, source-researchers,
 *     discovery-searchers, OU URLs extras dos forwards do editor (newsletter
 *     com 30 URLs = 29 entram em Y após subtrair 1 da própria submissão).
 *
 * Z = itens visíveis no `02-reviewed.md` final — destaques + itens nas
 *     seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS / VÍDEOS. Excluímos
 *     links de afiliados e blocos editoriais fixos (SORTEIO / PARA ENCERRAR
 *     / ERRO INTENCIONAL / É IA?).
 *
 * Histórico:
 * - 260512: pipeline trocou número chutado pelo LLM por sync auto via flag.
 * - 260518: editor flagou que count "5 submissões" estava inflado — 1 forward
 *   de newsletter Cyberman com 30 URLs contava como 30 submissões. Fix: 1
 *   forward = 1 submissão, não URL-multiplicado.
 * - 260520 (#1414): editor enviou 9 diretos + 4 forwards de newsletters, mas
 *   só os 9 contavam (newsletter_blocks excluído). Fix: somar ambos.
 *
 * Uso:
 *   npx tsx scripts/sync-coverage-line.ts --edition-dir data/editions/260512
 *
 * Exit codes:
 *   0 — linha sincronizada (ou já estava correta, no-op)
 *   1 — erro: arquivo ausente ou MD sem linha de cobertura pra atualizar
 *   2 — erro de uso (args)
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseInboxMd, filterEditorBlocks } from "./inject-inbox-urls.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { countSelectedItems as sharedCountSelectedItems } from "./lib/newsletter-count.ts";

interface RawArticle {
  url?: string;
  flag?: string;
  source?: string;
}

/**
 * Pure (#1323): X = número de e-mails encaminhados pelo editor (1 por
 * thread/email, independente de URL count). Y = pool_total - X.
 *
 * Trocou heurística por-URL (#1280) por por-email — o editor flagou em
 * 260518 que forward de newsletter Cyberman com 30 URLs era contado como
 * 30 submissões. Cada email-forward é 1 ato editorial, não 30.
 *
 * Caller passa pool_total + forwarded_emails_count (ambos calculados externamente
 * pra manter função pura/testável).
 */
export function countEditorVsAuto(
  pool: RawArticle[],
  forwardedEmailsCount: number,
): { x: number; y: number } {
  const x = forwardedEmailsCount;
  return { x, y: Math.max(0, pool.length - x) };
}

/**
 * Pure (#1404): extrai array de artigos do JSON parseado, suportando ambos
 * shapes que o pipeline produz:
 * - Flat array `[...]` (legado, pre-enrich)
 * - Wrapped object `{articles: [...], expanded: [...], warnings: [...]}`
 *   (atual, pós enrich-inbox-articles.ts)
 *
 * Retorna `null` quando o input não bate em nenhum shape conhecido — caller
 * decide se aborta. Antes do fix, qualquer wrapped JSON gerava `pool.length
 * === undefined → NaN` na linha de cobertura final (caso real 260520:
 * intro saiu como "outros NaN artigos").
 */
export function parsePoolArticles(raw: unknown): RawArticle[] | null {
  if (Array.isArray(raw)) return raw as RawArticle[];
  if (
    raw !== null &&
    typeof raw === "object" &&
    "articles" in raw &&
    Array.isArray((raw as { articles?: unknown }).articles)
  ) {
    return (raw as { articles: RawArticle[] }).articles;
  }
  return null;
}

/**
 * Helper: conta e-mails distintos do editor lendo `data/inbox.md`.
 * Cada bloco do inbox com `from: editor` conta como 1 submission.
 *
 * Retorna 0 se inbox.md não existir ou parse falhar (defensive — pipeline
 * continua sem coverage line precisa).
 */
export function countForwardedEmailsFromInbox(
  inboxMdPath: string,
  editorEmail: string,
): number {
  if (!existsSync(inboxMdPath)) return 0;
  try {
    const text = readFileSync(inboxMdPath, "utf8");
    const blocks = parseInboxMd(text);
    const editorBlocks = filterEditorBlocks(blocks, editorEmail);
    return editorBlocks.length;
  } catch {
    return 0;
  }
}

/**
 * #1368, refined em #1414: lê total de submissões do marker
 * `.marker-inject-inbox-urls.json`. Submissão = 1 email recebido em
 * `diariaeditor@gmail.com` — independente do `From:` ser o editor diretamente
 * (`editor_blocks`) ou um forward de newsletter preservando o sender original
 * (`newsletter_blocks`). Ambos são atos editoriais de envio.
 *
 * Caso real 260520: editor enviou 9 emails diretos + 4 forwards de newsletters
 * (Cyberman/Superhuman/AlphaSignal/etc) = 13 blocos no inbox archive. Antes
 * de #1414 o script retornava só 9 (editor_blocks), undercounting as
 * submissões pra leitor.
 *
 * Caso real 260519 (#1368): sync-coverage-line.ts lia `data/inbox.md` que já
 * tinha sido arquivado → forwardedEmails = 0 → intro saía "0 submissões"
 * mesmo o editor tendo enviado 4.
 *
 * Retorna null se marker ausente OU sem `editor_blocks` (caller faz fallback
 * pro archive ou inbox.md). `newsletter_blocks` ausente conta como 0
 * (markers pre-#1095 não tinham o campo).
 */
export function readSubmissionsCountFromMarker(editionDir: string): number | null {
  const markerPath = join(editionDir, "_internal", ".marker-inject-inbox-urls.json");
  if (!existsSync(markerPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(markerPath, "utf8")) as {
      editor_blocks?: number;
      newsletter_blocks?: number;
      details?: {
        editor_blocks?: number;
        newsletter_blocks?: number;
      };
    };
    // #1476: marker pode ter campos no top-level (legado) ou em details (atual)
    const data = raw.details ?? raw;
    if (typeof data.editor_blocks !== "number") return null;
    const newsletter = typeof data.newsletter_blocks === "number" ? data.newsletter_blocks : 0;
    return data.editor_blocks + newsletter;
  } catch {
    return null;
  }
}

/**
 * #1414: deriva data ISO (YYYY-MM-DD) da data de pesquisa de uma edição.
 * Edition AAMMDD publica em YYYY-MM-DD; a pesquisa rodou D-1 (CLAUDE.md
 * "Edição é sempre D+1"). Inbox archive é nomeado pela data de pesquisa.
 *
 * Exemplo: edition_dir `data/editions/260520/` → research date `2026-05-19`.
 *
 * Retorna null se o basename do editionDir não bater no formato AAMMDD.
 */
export function deriveResearchDateISO(editionDir: string): string | null {
  const base = editionDir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  const m = base.match(/^(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, yy, mm, dd] = m;
  const date = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd)));
  date.setUTCDate(date.getUTCDate() - 1);
  const iso = date.toISOString().slice(0, 10);
  return iso;
}

/**
 * #1414: fallback pra contar submissões direto do inbox archive
 * (`data/inbox-archive/{YYYY-MM-DD}.md`) quando o marker está ausente.
 * Cada bloco `^## ` é 1 email recebido — independente do sender. Match
 * o mesmo semantic do `readSubmissionsCountFromMarker` (soma editor +
 * newsletter blocks).
 *
 * Retorna null se archive não existir (caller faz fallback final pra
 * inbox.md, ou aceita 0 se nada mais sobrou).
 */
export function countSubmissionsFromArchive(
  editionDir: string,
  archiveRoot = "data/inbox-archive",
): number | null {
  const iso = deriveResearchDateISO(editionDir);
  if (!iso) return null;
  const archivePath = join(archiveRoot, `${iso}.md`);
  if (!existsSync(archivePath)) return null;
  try {
    const text = readFileSync(archivePath, "utf8");
    const matches = text.match(/^## /gm);
    return matches ? matches.length : 0;
  } catch {
    return null;
  }
}

/**
 * Pure: conta itens editoriais visíveis no MD final. Z na linha de cobertura.
 *
 * #1455: agora wrapper sobre `lib/newsletter-count.ts:countSelectedItems` —
 * single source of truth com `lint-newsletter-md.ts --check intro-count`.
 * Antes os dois divergiam: producer (este) contava sections + emoji + singular
 * corretamente, consumer (lint) tinha regex restritiva que falhava em emoji
 * prefix. Caso 260522: producer setou "12", lint reclamou "real é 3".
 *
 * Retorna apenas o total — assinatura mantida pra compat com callers existentes.
 * Quem quiser breakdown por bucket usa `lib/newsletter-count.ts` direto.
 */
export function countSelectedItems(md: string): number {
  return sharedCountSelectedItems(md).total;
}

/**
 * Match a linha de cobertura. Tolerante a:
 *   - YAML frontmatter no topo (#1179): /m flag matches qualquer linha
 *   - Vírgulas opcionais após "submissões" e "artigos" (Clarice às vezes adiciona
 *     vírgula antes de "e" / conjunção). Ver edição 260513.
 *   - Whitespace trailing.
 */
const COVERAGE_LINE_RE =
  /^Para esta edição, eu \(o editor\) enviei [^\n]+ submissões,?\s+e a Diar\.ia encontrou outros [^\n]+ artigos\. Selecionamos os [^\n]+ mais relevantes para as pessoas que assinam a newsletter\.[ \t]*$/m;

/**
 * Pure: substitui a linha de cobertura no MD. Se ausente, retorna `{ md, changed: false }`.
 *
 * Normaliza pra forma canônica (sem vírgula extra após "submissões") quando
 * encontra variantes — ou seja, reverte adições não-padrão de pontuação.
 */
export function rewriteCoverageLine(
  md: string,
  x: number,
  y: number,
  z: number,
): { md: string; changed: boolean } {
  const newLine = `Para esta edição, eu (o editor) enviei ${x} submissões e a Diar.ia encontrou outros ${y} artigos. Selecionamos os ${z} mais relevantes para as pessoas que assinam a newsletter.`;
  if (!COVERAGE_LINE_RE.test(md)) return { md, changed: false };
  const updated = md.replace(COVERAGE_LINE_RE, newLine);
  return { md: updated, changed: updated !== md };
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const editionDir = args["edition-dir"];
  if (!editionDir) {
    console.error("Uso: sync-coverage-line.ts --edition-dir <path>");
    process.exit(2);
  }
  const root = resolve(process.cwd(), editionDir);
  const mdPath = join(root, "02-reviewed.md");
  const poolPath = join(root, "_internal/tmp-articles-raw.json");

  if (!existsSync(mdPath)) {
    console.error(`02-reviewed.md ausente em ${mdPath}`);
    process.exit(1);
  }
  if (!existsSync(poolPath)) {
    console.error(`tmp-articles-raw.json ausente em ${poolPath} — sem isso não dá pra calcular X/Y`);
    process.exit(1);
  }

  const md = readFileSync(mdPath, "utf8");
  // #1404: tmp-articles-raw.json pode vir como flat array (legado) ou objeto
  // wrapped (atual, pós enrich-inbox-articles.ts). parsePoolArticles cobre
  // ambos; null = shape desconhecida → abort com erro claro.
  const pool = parsePoolArticles(JSON.parse(readFileSync(poolPath, "utf8")));
  if (!pool) {
    console.error(
      `tmp-articles-raw.json formato inesperado em ${poolPath}: esperado array ou {articles:[]}`,
    );
    process.exit(1);
  }

  // Preference order (#1368, refined em #1414):
  // 1. marker `.marker-inject-inbox-urls.json` — escrito em Stage 1 antes do
  //    archive (§1y `mv data/inbox.md ...`); soma editor_blocks + newsletter_blocks.
  // 2. inbox archive `data/inbox-archive/{YYYY-MM-DD}.md` — autoritativo do
  //    que entrou no inbox naquele dia; sobrevive a marker missing.
  // 3. inbox.md ao vivo — last resort, falha se já foi arquivado.
  let forwardedEmails: number | null = readSubmissionsCountFromMarker(root);
  let source: "marker" | "archive" | "inbox_md" = "marker";
  if (forwardedEmails === null) {
    const archiveRoot = resolve(process.cwd(), args["archive-root"] ?? "data/inbox-archive");
    forwardedEmails = countSubmissionsFromArchive(root, archiveRoot);
    source = "archive";
  }
  if (forwardedEmails === null) {
    const editorEmail = process.env.EDITOR_EMAIL ?? resolveEditorEmail(resolve(process.cwd(), "platform.config.json"));
    const inboxMdPath = resolve(process.cwd(), args["inbox-md"] ?? "data/inbox.md");
    forwardedEmails = countForwardedEmailsFromInbox(inboxMdPath, editorEmail);
    source = "inbox_md";
  }
  const { x, y } = countEditorVsAuto(pool, forwardedEmails);
  const z = countSelectedItems(md);

  const { md: updatedMd, changed } = rewriteCoverageLine(md, x, y, z);
  if (!COVERAGE_LINE_RE.test(md)) {
    console.error("MD não tem linha de cobertura — esperava primeira linha começando com 'Para esta edição, eu (o editor) enviei...'");
    process.exit(1);
  }
  if (changed) writeFileSync(mdPath, updatedMd, "utf8");

  console.log(JSON.stringify({ x, y, z, changed, mdPath, source }, null, 2));
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
