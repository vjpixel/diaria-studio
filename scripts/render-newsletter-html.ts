#!/usr/bin/env npx tsx
/**
 * render-newsletter-html.ts (#1889)
 *
 * CLI entry point — thin shell over the parse↔render pipeline:
 *   scripts/lib/newsletter-parse.ts   — md → NewsletterContent
 *   scripts/lib/newsletter-render-html.ts — NewsletterContent → HTML
 *
 * Pre-renders the newsletter body as Beehiiv-compatible HTML.
 * This eliminates block-by-block filling in the browser editor —
 * the agent pastes one HTML block instead of ~20 individual operations.
 *
 * Usage:
 *   npx tsx scripts/render-newsletter-html.ts <edition-dir> [--format html|json] [--out <path>]
 *
 * --format html (default): outputs HTML body content for Beehiiv Custom HTML block
 * --format json: outputs structured JSON with all parsed sections
 * --out: write to file instead of stdout
 *
 * Image references use {{IMG:filename}} placeholders. The publish agent
 * uploads images to Beehiiv CDN first, then replaces placeholders with URLs.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs } from "./lib/cli-args.ts"; // #535

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Re-exports (back-compat: callers import by name from this module) ──
export type { EIA, NewsletterContent } from "./lib/newsletter-parse.ts";
export type { RenderOpts } from "./lib/newsletter-render-html.ts";
export {
  CATEGORY_EMOJI,
  extractTemplateBlock,
  truncateAtSectionTerminator,
  parseSections,
  parseListItems,
  resolvePrevResultLine,
  fallbackEIA,
  parseEIA,
  extractCoverageLine,
  reconcileCoverageCount,
  extractIntroCallout,
  extractMidCallout,
  stripMidCalloutFromD1,
  readMidCalloutImage,
  isMidCalloutLivros,
  extractContent,
  unescapeMd,
  joinMultilineLinks,
  pickErroIntencionalReveal,
} from "./lib/newsletter-parse.ts";

export {
  processInlineItalics,
  processInlineLinks,
  isSponsoredCallout,
  renderCoverage,
  renderIntroCallout,
  renderMidCallout,
  renderLeaderboardTop1Row,
  renderLeaderboardLinkRow,
  renderHTML,
  renderEiaStandalone,
} from "./lib/newsletter-render-html.ts";

export { singularizeSectionName } from "./lib/section-naming.ts";

// ── Imports for main() ─────────────────────────────────────────────────
import { extractContent } from "./lib/newsletter-parse.ts";
import { renderHTML, renderEiaStandalone } from "./lib/newsletter-render-html.ts";

// ── Main ──────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const editionDir = args.find((a) => !a.startsWith("--"));
  const { values, flags } = parseCliArgs(args); // #535: fix indexOf+1 bug
  const format = values["format"] ?? "html";
  const outPath = values["out"] ?? null;
  const split = flags.has("split"); // #1046 — paste híbrido (body + È IA? standalone)

  if (!editionDir) {
    console.error(
      "Usage: npx tsx scripts/render-newsletter-html.ts <edition-dir> [--format html|json] [--out <path>] [--split]\n" +
        "  --split: produz 2 arquivos em {edition}/_internal/ — newsletter-body.html (sem È IA?) + newsletter-eia.html (È IA? standalone, preserva merge tags). #1046",
    );
    process.exit(1);
  }

  const resolvedDir = resolve(ROOT, editionDir);
  const content = extractContent(resolvedDir);

  // #1046 — Modo split: produz 2 arquivos pro paste híbrido (body via
  // ClipboardEvent + È IA? via insertContent). --format json incompatível;
  // --out ignorado com warning explícito (#1052 review follow-up).
  if (split) {
    if (format !== "html") {
      console.error("--split incompatível com --format json");
      process.exit(1);
    }
    if (outPath) {
      console.error(
        `--split + --out: --out (${outPath}) ignorado. Modo split sempre escreve em _internal/newsletter-{body,eia}.html`,
      );
    }
    const internalDir = resolve(resolvedDir, "_internal");
    // #1052 review follow-up: garante que _internal/ existe antes de write.
    // Stage 4 normalmente já tem (criado por scripts anteriores), mas defensive
    // contra fresh edition dirs ou ordens de execução não-padrão.
    mkdirSync(internalDir, { recursive: true });
    const bodyPath = resolve(internalDir, "newsletter-body.html");
    const eiaPath = resolve(internalDir, "newsletter-eia.html");
    const bodyHtml = renderHTML(content, { excludeEia: true });
    writeFileSync(bodyPath, bodyHtml + "\n");
    console.error(`Written body to ${bodyPath} (${bodyHtml.length} bytes)`);
    const eiaHtml = renderEiaStandalone(content);
    if (eiaHtml) {
      writeFileSync(eiaPath, eiaHtml + "\n");
      console.error(`Written È IA? to ${eiaPath} (${eiaHtml.length} bytes)`);
    } else {
      console.error(`È IA? sem credit configurado — pulando ${eiaPath}`);
    }
    return;
  }

  let output: string;
  if (format === "json") {
    output = JSON.stringify(content, null, 2);
  } else {
    // #1936 --full: documento HTML completo (shell DS + preheader) pro preview/
    // email Worker-hosted. Sem a flag: fragmento container pro paste no Beehiiv.
    output = renderHTML(content, { fullDocument: flags.has("full") });
  }

  if (outPath) {
    const resolvedOut = resolve(ROOT, outPath);
    mkdirSync(dirname(resolvedOut), { recursive: true }); // garantir que _internal/ existe (#2042)
    writeFileSync(resolvedOut, output + "\n");
    console.error(`Written to ${outPath}`);
  } else {
    // #2012: quando stdout não é TTY (pipe / redirect) e --out está ausente,
    // o HTML pode ir silenciosamente pro /dev/null — exatamente o que causou
    // 260610 (newsletter-draft.html nunca foi regenerado, upload subiu stale).
    // Avisar no stderr sem quebrar quem usa pipe legitimamente (ex: jq, diff).
    if (!process.stdout.isTTY) {
      const outputLabel = format === "json" ? "JSON" : "HTML";
      process.stderr.write(
        `[render-newsletter-html] AVISO: stdout não é TTY e --out está ausente. ` +
          `O ${outputLabel} será escrito no stdout — se estiver redirecionando para /dev/null ou ` +
          "similar, o arquivo em disco NÃO será atualizado. " +
          "Use --out <path> para gravar explicitamente (ex: --out " +
          `${resolvedDir}/_internal/newsletter-draft.html).\n`,
      );
    }
    process.stdout.write(output);
  }
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
