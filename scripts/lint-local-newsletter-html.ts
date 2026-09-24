#!/usr/bin/env tsx
/**
 * lint-local-newsletter-html.ts (#8635)
 *
 * Fallback do `review-test-email` quando ele volta `inconclusive` (Gmail MCP
 * indisponível no subagente, e-mail não encontrado em 30s). Sem isto, o gate
 * do Stage 6 ficava sem NENHUMA checagem automática — só o olho do editor.
 *
 * Roda os mesmos lints determinísticos do e-mail de teste
 * (`lint-test-email-structure.ts` + `lint-test-email-encoding.ts`) contra o
 * HTML FINAL LOCAL que foi enviado ao ESP, em vez do dump do Gmail. Cobre
 * drift source MD → HTML (seção faltando, contagem de destaques, encoding);
 * NÃO cobre o que só aparece depois do ESP (tracking de link, template do
 * Beehiiv, imagem proxiada) — por isso o resultado é rotulado
 * `local_html_fallback`, nunca equivalente a um review completo.
 *
 * Uso:
 *   npx tsx scripts/lint-local-newsletter-html.ts --edition-dir data/editions/2609/260924/ \
 *     [--platform kit|beehiiv] [--out <json>]
 *
 * Exit: 0 sem issues, 1 com issues (informativo — nunca bloqueia o Stage 5,
 * mesma semântica do #3839), 2 arquivos ausentes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple as parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  extractMdStructure,
  extractEmailStructure,
  compareStructure,
} from "./lint-test-email-structure.ts";
import { stripHtmlToText, checkEncoding } from "./lint-test-email-encoding.ts";

export type LocalLintPlatform = "kit" | "beehiiv";

/** HTML final local por plataforma. Kit tem fragmento próprio; ambos caem no genérico. */
export function resolveLocalHtmlPath(editionDir: string, platform: LocalLintPlatform): string | null {
  const candidates =
    platform === "kit"
      ? ["_internal/newsletter-final-kit.html", "_internal/newsletter-final.html"]
      : ["_internal/newsletter-final.html"];
  for (const rel of candidates) {
    const p = resolve(editionDir, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

export function lintLocalNewsletterHtml(sourceMd: string, html: string) {
  const structureIssues = compareStructure(extractMdStructure(sourceMd), extractEmailStructure(html));
  const encodingIssues = checkEncoding(sourceMd, stripHtmlToText(html));
  return { structure_issues: structureIssues, encoding_issues: encodingIssues };
}

function main(): number {
  const values = parseArgs(process.argv.slice(2));
  const editionDir = values["edition-dir"];
  const platform: LocalLintPlatform = values.platform === "beehiiv" ? "beehiiv" : "kit";
  if (!editionDir) {
    console.error("Uso: lint-local-newsletter-html.ts --edition-dir <dir> [--platform kit|beehiiv] [--out <json>]");
    return 2;
  }
  const mdPath = resolve(editionDir, "02-reviewed.md");
  const htmlPath = resolveLocalHtmlPath(editionDir, platform);
  if (!existsSync(mdPath) || !htmlPath) {
    console.error(`[lint-local-newsletter-html] arquivo ausente: ${!existsSync(mdPath) ? mdPath : "HTML final local"}`);
    return 2;
  }
  const result = {
    source: "local_html_fallback" as const,
    platform,
    html_path: htmlPath,
    ...lintLocalNewsletterHtml(readFileSync(mdPath, "utf8"), readFileSync(htmlPath, "utf8")),
  };
  if (values.out) writeFileSync(values.out, JSON.stringify(result, null, 2), "utf8");
  console.log(JSON.stringify(result, null, 2));
  const n = result.structure_issues.length + result.encoding_issues.length;
  if (n > 0) {
    console.error(`[lint-local-newsletter-html] ${n} issue(s) no HTML local (fallback do review inconclusivo, #8635)`);
    return 1;
  }
  return 0;
}

if (isMainModule(import.meta.url)) process.exit(main());
