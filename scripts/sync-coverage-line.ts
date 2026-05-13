#!/usr/bin/env npx tsx
/**
 * sync-coverage-line.ts (#1097)
 *
 * Auto-calcula e sincroniza a linha de cobertura no `02-reviewed.md`:
 *
 *   "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia
 *    encontrou outros Y artigos. Selecionamos os Z mais relevantes para
 *    as pessoas que assinam a newsletter."
 *
 * X = artigos no pool inicial (`tmp-articles-raw.json`) com flag
 *     `editor_submitted` OU `newsletter_extracted` OU `source: "inbox"`.
 *     Forwards do Pixel + links extraídos de newsletters encaminhadas.
 *
 * Y = `total_pool_initial - X`. Artigos que vieram de RSS, source-researchers
 *     ou discovery-searchers (não-inbox).
 *
 * Z = itens visíveis no `02-reviewed.md` final — destaques + itens nas
 *     seções LANÇAMENTOS / PESQUISAS / OUTRAS NOTÍCIAS / VÍDEOS. Excluímos
 *     links de afiliados e blocos editoriais fixos (SORTEIO / PARA ENCERRAR
 *     / ERRO INTENCIONAL / É IA?).
 *
 * Antes (incident 260512): números chutados pelo writer LLM ficavam stale
 * após edições do pipeline (caps, podas, score-filter). Editor publicou com
 * "5 submissões / 130 artigos / 34 selecionados" quando o real era 13/125/12.
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

interface RawArticle {
  url?: string;
  flag?: string;
  source?: string;
}

/**
 * Pure: dado o pool inicial, conta editor_submitted + newsletter_extracted
 * + source:inbox como X (do editor); o restante é Y (auto-found).
 */
export function countEditorVsAuto(pool: RawArticle[]): { x: number; y: number } {
  let x = 0;
  for (const a of pool) {
    // #1190: newsletter_extracted = link extraído de newsletter forwarded
    // pelo Pixel (Cyberman, AlphaSignal, etc). Pixel NÃO curou esses links
    // individualmente — só forwarded a newsletter inteira. Semanticamente é
    // descoberta automática assistida, não submissão editorial. Vai pra Y.
    //
    // editor_submitted = forward direto do Pixel com link específico → X.
    // source: "inbox" = back-compat com runs antigos (pré-#1095, quando
    // tudo do inbox era considerado editor submission).
    if (a.flag === "editor_submitted" || a.source === "inbox") {
      x++;
    }
  }
  return { x, y: pool.length - x };
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
  const { x, y } = countEditorVsAuto(pool);
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
