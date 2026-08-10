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
 * --esp beehiiv|brevo: merge tag do link de voto do É IA? (#4266). Default
 *   beehiiv (`{{email}}` cru — o token opaco do #4487 foi revertido neste
 *   ramo pelo #4581). brevo usa `{{ contact.POLL_TOKEN }}%40vote.eia.diaria.local`
 *   (token opaco, ainda vivo lá, #4517; `@` percent-encoded desde #4692) — só relevante pro modo --format html sem --split
 *   (É IA? standalone/split fica sempre Beehiiv).
 *
 * Image references use {{IMG:filename}} placeholders. The publish agent
 * uploads images to Beehiiv CDN first, then replaces placeholders with URLs.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts"; // #535

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── Re-exports (back-compat: callers import by name from this module) ──
export type { EIA, NewsletterContent } from "./lib/newsletter-parse.ts";
export type { RenderOpts, RenderWarningEvent } from "./lib/newsletter-render-html.ts"; // RenderWarningEvent: #4673
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
  extractCoverageLineTrailer,
  reconcileCoverageCount,
  extractIntroCallout,
  extractBoxDivulgacao0,
  BOX0_SENTINEL, // #4338
  extractBoxDivulgacao1,
  extractBoxDivulgacao2,
  extractBoxDivulgacao3,
  stripBoxDivulgacao1,
  stripBoxDivulgacao2,
  stripBoxDivulgacao3,
  readBoxDivulgacao0Image,
  readBoxDivulgacao1Image,
  readBoxDivulgacao2Image,
  readBoxDivulgacao3Image,
  readBoxDivulgacaoCategoriaForSlot, // #3981
  readBoxDivulgacaoAltForSlot, // #4086

  isBoxDivulgacaoLivros,
  extractContent,
  unescapeMd,
  joinMultilineLinks,
  pickErroIntencionalReveal,
} from "./lib/newsletter-parse.ts";

export {
  processInlineItalics,
  processInlineLinks,
  applyBrandWordmark,
  isSponsoredCallout,
  renderCoverage,
  renderBodyParasInner,
  renderWhyBoxInner,
  renderDestaque,
  renderIntroCallout,
  renderMidCallout,
  renderBoxDivulgacao,
  renderLeaderboardTop1Row,
  renderLeaderboardLinkRow,
  renderJogarArchiveLinkRow, // #3524
  buildJogarArchiveUrl, // #3524
  renderHTML,
  renderEiaStandalone,
  assignDivulgacaoGaps, // #4624
  getRenderWarnings, // #4673
} from "./lib/newsletter-render-html.ts";

export { singularizeSectionName } from "./lib/section-naming.ts";

// ── Imports for main() ─────────────────────────────────────────────────
import { extractContent, type NewsletterContent } from "./lib/newsletter-parse.ts";
import {
  renderHTML,
  renderEiaStandalone,
  resetRenderWarnings, // #4687
  getRenderWarnings, // #4673
  type Esp,
} from "./lib/newsletter-render-html.ts";
import { applyPatronosBoxes } from "./lib/newsletter-patronos.ts"; // #4275
import {
  buildLinkLayout,
  buildPublishedLinks,
  readScoredUrls,
} from "./lib/link-layout.ts"; // #4841

// #4266 — fonte única do conjunto válido; deriva mensagem de uso/erro do CLI
// em vez de repetir o union literal (ver doc comment de `Esp`). `Record<Esp,
// true>` (não array solto) é de propósito: se `Esp` ganhar um 3º valor e
// alguém esquecer de adicionar aqui, o TS recusa compilar (propriedade
// faltando) — um array `readonly Esp[]` não daria esse erro (achado do
// review automatizado do PR #4267, type-design-analyzer).
const ESP_SET: Record<Esp, true> = { beehiiv: true, brevo: true };
const VALID_ESP = Object.keys(ESP_SET) as Esp[];

// ── Main ──────────────────────────────────────────────────────────────

/**
 * #4673: persiste os eventos coletados por `getRenderWarnings()` (populados
 * pela chamada de `renderHTML()` que acabou de rodar) em
 * `_internal/render-warnings.json` — sinal consumível por caller programático
 * (`checkRenderWarnings`, scripts/lib/invariant-checks/stage-4.ts), em vez de
 * só stderr cru que nenhum caller do Stage 4 lia. Escreve SEMPRE (mesmo array
 * vazio) — o Stage 4 pré-render roda de novo a cada retomada/re-render da
 * edição (§4b/§4c.6b do orchestrator), e um arquivo escrito só quando há
 * warning deixaria uma entrada STALE de uma rodada anterior sobrevivendo
 * depois que a causa foi corrigida (edição sem perda voltaria a acusar
 * warning fantasma). Sobrescrever sempre com o estado fresco desta chamada
 * evita esse falso positivo.
 */
function writeRenderWarningsFile(resolvedDir: string): void {
  const warnings = getRenderWarnings();
  const internalDir = resolve(resolvedDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const warningsPath = resolve(internalDir, "render-warnings.json");
  writeFileSync(
    warningsPath,
    JSON.stringify({ generated_at: new Date().toISOString(), warnings }, null, 2) + "\n",
  );
  if (warnings.length > 0) {
    console.error(
      `[render-newsletter-html] ${warnings.length} evento(s) de conteúdo perdido gravado(s) em ` +
        `${warningsPath} (#4673) — ver checkRenderWarnings no gate do Stage 4.`,
    );
  }
}

/**
 * #4841: grava, a cada render, os dois artefatos de instrumentação de
 * posição/proveniência de link — `link-layout.json` (posição: bloco +
 * ordinal local + ordinal global) e `published-links.json` (proveniência:
 * scored vs writer_inserted, cruzando contra `01-approved.json`). Ambos
 * derivados diretamente da `NewsletterContent` já parseada (nunca reparsam
 * HTML) — ver docstring completa em `scripts/lib/link-layout.ts`. Escreve
 * SEMPRE (mesmo padrão de `writeRenderWarningsFile` acima, #4673) — nunca
 * deixa uma entrada STALE de uma rodada anterior sobreviver a um
 * re-render/retomada da mesma edição.
 */
function writeLinkInstrumentationFiles(resolvedDir: string, content: NewsletterContent): void {
  const internalDir = resolve(resolvedDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const layout = buildLinkLayout(content);
  writeFileSync(resolve(internalDir, "link-layout.json"), JSON.stringify(layout, null, 2) + "\n");
  const scoredUrls = readScoredUrls(resolvedDir);
  const published = buildPublishedLinks(layout, scoredUrls);
  writeFileSync(
    resolve(internalDir, "published-links.json"),
    JSON.stringify(published, null, 2) + "\n",
  );
}

function main(): void {
  const args = process.argv.slice(2);
  const editionDir = args.find((a) => !a.startsWith("--"));
  const { values, flags } = parseCliArgs(args); // #535: fix indexOf+1 bug
  const format = values["format"] ?? "html";
  const outPath = values["out"] ?? null;
  const split = flags.has("split"); // #1046 — paste híbrido (body + È IA? standalone)

  if (!editionDir) {
    console.error(
      "Usage: npx tsx scripts/render-newsletter-html.ts <edition-dir> [--format html|json] [--out <path>] [--split] [--esp beehiiv|brevo] [--patronos]\n" +
        "  --split: produz 2 arquivos em {edition}/_internal/ — newsletter-body.html (sem È IA?) + newsletter-eia.html (È IA? standalone, preserva merge tags). #1046\n" +
        `  --esp: merge tag do link de voto do É IA? (${VALID_ESP.join("|")}, default beehiiv). #4266\n` +
        "  --patronos: variante Patronos (#4275, Fase 1) — MESMO 02-reviewed.md, troca só o preenchimento dos slots de caixa via platform.config.json → boxes_divulgacao_patronos. Combine com --out apontando pra um arquivo distinto (ex: _internal/newsletter-final-patronos.html) — não sobrescreve o --out padrão sozinho.",
    );
    process.exit(1);
  }

  // #4266 — guard local que REJEITA explicitamente `--esp=valor` (sintaxe
  // com igual), em vez de aceitá-la. Nota #4272: `parseCliArgs`
  // (`scripts/lib/cli-args.ts`) passou a suportar `--key=valor` de modo
  // geral — sem este guard, `--esp=brevo` seria parseado normalmente e
  // aceito. Mas esta flag específica mantém a rejeição por decisão
  // deliberada (preservada do commit 7f899655): um `--esp` mal-configurado
  // tem consequência de produção (voto perdido sem aviso), então prefere-se
  // forçar a forma canônica única (`--esp valor`, com espaço) e falhar alto
  // em qualquer variação, a aceitar silenciosamente uma segunda sintaxe.
  // Guard não é redundante pós-#4272 — é uma restrição intencional mais
  // estrita que o parser genérico permite.
  const espEquals = args.find((a) => a.startsWith("--esp="));
  if (espEquals) {
    console.error(
      `--esp não aceita sintaxe "=" (recebido "${espEquals}") — use "--esp ${espEquals.slice(6)}" (espaço, não igual).`,
    );
    process.exit(1);
  }

  // #4266 — `--esp` SEM valor (último argv, ou seguido de outra --flag) cai em
  // `flags`, não em `values` (contrato de parseCliArgs) — sem este guard
  // explícito, `values["esp"]` fica `undefined` e o `?? "beehiiv"` abaixo
  // aceitaria silenciosamente o default errado em vez de falhar. Achado do
  // review automatizado do PR #4267 (silent-failure-hunter, confirmado por
  // repro): exatamente a classe de bug que este PR existe pra evitar — voto
  // vindo de um envio Brevo mal-configurado chegaria com merge tag errada e
  // não creditaria ninguém, sem nenhum aviso.
  if (flags.has("esp")) {
    console.error(`--esp requer um valor (${VALID_ESP.join("|")}) — recebido sem valor.`);
    process.exit(1);
  }
  const espRaw = values["esp"] ?? "beehiiv";
  if (!VALID_ESP.includes(espRaw as Esp)) {
    console.error(`--esp inválido: "${espRaw}" (esperado ${VALID_ESP.join("|")})`);
    process.exit(1);
  }
  const esp = espRaw as Esp;

  // #4266 — modo --split sempre emite È IA? standalone Beehiiv-only
  // (renderEiaStandalone não aceita esp, ver lib/newsletter-render-html.ts) —
  // mesmo padrão de aviso explícito já usado pra --split + --out (abaixo).
  if (split && esp === "brevo") {
    console.error(
      "--split + --esp brevo: --esp ignorado. newsletter-eia.html do modo split é sempre Beehiiv (paste híbrido não suporta Brevo).",
    );
  }

  const resolvedDir = resolve(ROOT, editionDir);
  const baseContent = extractContent(resolvedDir);
  // #4275: --patronos sobrescreve só os campos de box de divulgação — destaques/
  // seções/demais campos do conteúdo base (mesmo 02-reviewed.md) saem intocados.
  // Aplicado ANTES dos 2 branches abaixo (split e non-split) pra funcionar com
  // ambos sem duplicar a checagem da flag.
  const patronos = flags.has("patronos");
  const content = patronos ? applyPatronosBoxes(baseContent) : baseContent;

  // #4841 — grava link-layout.json + published-links.json a partir do MESMO
  // `content` estruturado que os 2 branches abaixo (split/non-split) usam pra
  // renderizar — independe de --format/--split, então roda uma única vez
  // aqui, antes de qualquer branch.
  writeLinkInstrumentationFiles(resolvedDir, content);

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
    writeRenderWarningsFile(resolvedDir); // #4673 — captura eventos desta chamada de renderHTML
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
    // #4687 — `renderHTML()` não roda neste branch, então `getRenderWarnings()`
    // não reflete NADA desta invocação. Sem este reset+write explícitos, uma
    // invocação anterior (--format html, mesmo processo — ex: testes; ou um
    // `render-warnings.json` já em disco de uma execução anterior no mesmo
    // diretório) deixava um aviso STALE sobrevivendo indefinidamente — o
    // editor via "2 caixas dropadas" no gate do Stage 4 mesmo depois de
    // corrigir a causa, porque `--format json` (uso legítimo de debug/
    // inspeção) nunca reescrevia o arquivo. Resetar+escrever aqui também
    // garante array vazio quando não há renderHTML nesta chamada.
    resetRenderWarnings();
    writeRenderWarningsFile(resolvedDir);
  } else {
    // #1936 --full: documento HTML completo (shell DS + preheader) pro preview/
    // email Worker-hosted. Sem a flag: fragmento container pro paste no Beehiiv.
    output = renderHTML(content, { fullDocument: flags.has("full"), esp });
    writeRenderWarningsFile(resolvedDir); // #4673 — captura eventos desta chamada de renderHTML
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

if (isMainModule(import.meta.url)) {
  main();
}
