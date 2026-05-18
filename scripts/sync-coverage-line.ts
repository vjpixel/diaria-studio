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
 * X = número de **e-mails encaminhados pelo editor** (cada thread/forward = 1,
 *     independente de quantas URLs ele contém). Forward direto com 1 URL = 1;
 *     forward de newsletter com 30 URLs = 1. Lê de `data/inbox.md`.
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
 *   de newsletter Cyberman com 30 URLs contava como 30 submissões.
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
 * Pure: conta itens editoriais visíveis no MD final.
 * Considera DESTAQUE N + 4 seções secundárias. Pula blocos editoriais fixos
 * (SORTEIO / PARA ENCERRAR / ERRO INTENCIONAL / É IA?) e links de afiliados.
 *
 * Heurística: contar markdown links `[texto](http...)` em seções relevantes,
 * filtrando URLs de domínios de afiliado/footer (diaria.beehiiv.com,
 * wisprflow, clarice.ai, beehiiv.com?via, linkedin.com/company,
 * facebook.com/diar.ia, pt.wikipedia, commons.wikimedia, creativecommons).
 */
export function countSelectedItems(md: string): number {
  const sections = md.split(/^---\s*$/m);
  const FOOTER_DOMAINS = [
    "diaria.beehiiv.com", // afiliados (cursos, livros)
    "wisprflow.ai",
    "clarice.ai",
    "beehiiv.com?via",
    "linkedin.com/company",
    "facebook.com/diar.ia",
    "pt.wikipedia.org",
    "commons.wikimedia.org",
    "creativecommons.org",
  ];
  const SKIP_HEADERS = [
    "SORTEIO",
    "PARA ENCERRAR",
    "ERRO INTENCIONAL",
    "É IA?",
    "ASSINE",
    "TÍTULO",
    "SUBTÍTULO",
  ];

  let count = 0;
  for (const section of sections) {
    // Pular seções editoriais fixas
    const isSkip = SKIP_HEADERS.some((h) => section.includes(h));
    if (isSkip) continue;

    // Procurar markdown links — formato `[texto](url)` ou `**[texto](url)**` ou `[**texto**](url)`
    const linkRe = /\[(?:\*\*)?([^\]]+?)(?:\*\*)?\]\((https?:\/\/[^)]+)\)/g;
    let m: RegExpExecArray | null;
    const urls = new Set<string>();
    while ((m = linkRe.exec(section)) !== null) {
      const url = m[2];
      // Pular afiliados/footer
      const isFooter = FOOTER_DOMAINS.some((d) => url.includes(d));
      if (isFooter) continue;
      urls.add(url);
    }
    count += urls.size;
  }
  return count;
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
  const pool: RawArticle[] = JSON.parse(readFileSync(poolPath, "utf8"));
  const editorEmail = process.env.EDITOR_EMAIL ?? resolveEditorEmail(resolve(process.cwd(), "platform.config.json"));
  const inboxMdPath = resolve(process.cwd(), args["inbox-md"] ?? "data/inbox.md");
  const forwardedEmails = countForwardedEmailsFromInbox(inboxMdPath, editorEmail);
  const { x, y } = countEditorVsAuto(pool, forwardedEmails);
  const z = countSelectedItems(md);

  const { md: updatedMd, changed } = rewriteCoverageLine(md, x, y, z);
  if (!COVERAGE_LINE_RE.test(md)) {
    console.error("MD não tem linha de cobertura — esperava primeira linha começando com 'Para esta edição, eu (o editor) enviei...'");
    process.exit(1);
  }
  if (changed) writeFileSync(mdPath, updatedMd, "utf8");

  console.log(JSON.stringify({ x, y, z, changed, mdPath }, null, 2));
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
