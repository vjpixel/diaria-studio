/**
 * lint-newsletter-md.ts (#165)
 *
 * Validação pós-writer do `02-draft.md` (ou `02-reviewed.md`) cruzando
 * URLs das seções secundárias contra `_internal/01-approved.json`. Pega
 * casos onde o writer LLM colocou um artigo na seção errada por
 * associação temática (ex: ferramenta nova em LANÇAMENTOS mesmo com
 * `bucket: "noticias"` no approved).
 *
 * Bug latente que o lint pega: ComfyUI (bucket: noticias, score 61) foi
 * colocado em LANÇAMENTOS na 260426 — exatamente o tipo de erro que
 * causou #160 também.
 *
 * Uso:
 *   npx tsx scripts/lint-newsletter-md.ts \
 *     --md <path> \
 *     --approved <path-to-01-approved.json>
 *
 * Exit codes:
 *   0  Todas as URLs nas seções batem com bucket
 *   1  Erros de seção (URL no bucket errado ou ausente do approved)
 *   2  Erro de leitura
 *
 * Output JSON em stdout: { ok, errors[], warnings[] }
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseCliArgs, isMainModule } from "./lib/cli-args.ts"; // #926
import { lintIntroCount as sharedLintIntroCount, type IntroCountResult } from "./lib/newsletter-count.ts"; // #1455
// #1737 item 2: checks extraídos pra módulos por-check (espelha invariant-checks/).
import {
  lintNewsletter,
  checkSectionCounts,
  type ApprovedJson,
} from "./lib/lint-checks/url-bucket.ts";
import { lintMultilineLinks } from "./lib/lint-checks/multiline-links.ts";
import { lintRelativeTime } from "./lib/lint-checks/relative-time.ts";
import { lintCalloutPlacement, lintStackedIntroCallouts } from "./lib/lint-checks/callout-placement.ts";
import { findOrphanBoxWarnings } from "./lib/newsletter-parse.ts"; // #3204
import { checkWhyMattersFormat } from "./lib/lint-checks/why-matters-format.ts";
import { checkEaiSection } from "./lib/lint-checks/eai-section.ts";
import { checkCoverageLine } from "./lib/lint-checks/coverage-line-format.ts";
import {
  checkDestaqueMinChars,
  checkDestaqueMaxChars,
} from "./lib/lint-checks/destaque-chars.ts";
import { countTitlesPerHighlight } from "./lib/lint-checks/titles-per-highlight.ts";
import {
  checkTitleLengths,
  MAX_TITLE_LENGTH,
} from "./lib/lint-checks/title-length.ts";
import { checkEiaAnswer } from "./lib/lint-checks/eia-answer-check.ts";
import { checkIntentionalError, checkIntentionalErrorSafety } from "./lib/lint-checks/intentional-error.ts";
import {
  extractCurrentDeclarationFromMd,
  extractRawCurrentNarrative,
  narrativeIsGenericPlaceholder,
  narrativeIsCatalogShaped,
  narrativeIsSelfConcatenated,
} from "./render-erro-intencional.ts";
import { checkSectionItemFormat } from "./lib/lint-checks/section-item-format.ts";
import {
  checkUseMelhorTempo,
} from "./lib/lint-checks/use-melhor-tempo.ts";
import {
  checkSecondaryItemsHaveSummary,
  type SecondaryItemSummaryError,
  type SecondaryItemSummaryReport,
} from "./lib/lint-checks/secondary-items-have-summary.ts";
import {
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
  type TitlePublisherSuffixError,
  type TitlePublisherSuffixReport,
  type TitleTrailingPeriodError,
  type TitleTrailingPeriodReport,
} from "./lib/lint-checks/title-normalization.ts"; // #2664 + #2672
import {
  checkNoTrailingEllipsis,
  type NoTrailingEllipsisError,
  type NoTrailingEllipsisReport,
} from "./lib/lint-checks/no-trailing-ellipsis.ts"; // #2881
import {
  checkMidSentenceEllipsis,
  type MidSentenceEllipsisError,
  type MidSentenceEllipsisReport,
} from "./lib/lint-checks/mid-sentence-ellipsis.ts"; // #3196
import {
  checkNoUntranslatedSummary,
  type UntranslatedSummaryError,
  type UntranslatedSummaryReport,
} from "./lib/lint-checks/no-untranslated-summary.ts"; // #3196
import {
  checkVideoLinksAreYoutube,
  type VideoLinkYoutubeError,
  type VideoLinkYoutubeReport,
} from "./lib/lint-checks/video-links-are-youtube.ts"; // #3202
import {
  checkSectionLinksResolve,
  type SectionLinkUnresolvedError,
  type SectionLinksResolveReport,
} from "./lib/lint-checks/section-links-resolve.ts"; // #3821
// Re-export pra back-compat (testes + outros módulos importam daqui).
export {
  lintMultilineLinks,
  type MultilineLinkMatch,
  type MultilineLinkResult,
} from "./lib/lint-checks/multiline-links.ts";
export {
  lintRelativeTime,
  type RelativeTimeMatch,
  type RelativeTimeResult,
} from "./lib/lint-checks/relative-time.ts";
export {
  lintCalloutPlacement,
  type CalloutPlacementMatch,
  type CalloutPlacementResult,
  lintStackedIntroCallouts,
  type StackedIntroCalloutResult,
} from "./lib/lint-checks/callout-placement.ts";
export {
  checkWhyMattersFormat,
  type WhyMattersError,
  type WhyMattersReport,
} from "./lib/lint-checks/why-matters-format.ts";
export { checkEaiSection } from "./lib/lint-checks/eai-section.ts";
export {
  checkCoverageLine,
  COVERAGE_LINE_RE,
} from "./lib/lint-checks/coverage-line-format.ts";
export {
  checkDestaqueMinChars,
  checkDestaqueMaxChars,
  DESTAQUE_MIN_CHARS,
  DESTAQUE_MAX_CHARS,
  type DestaqueMinCharsError,
  type DestaqueMinCharsReport,
  type DestaqueMaxCharsError,
  type DestaqueMaxCharsReport,
} from "./lib/lint-checks/destaque-chars.ts";
export {
  countTitlesPerHighlight,
  type TitleCheckResult,
  type TitleCheckReport,
} from "./lib/lint-checks/titles-per-highlight.ts";
export {
  checkTitleLengths,
  MAX_TITLE_LENGTH,
  type TitleLengthError,
  type TitleLengthReport,
} from "./lib/lint-checks/title-length.ts";
export {
  checkEiaAnswer,
  type EiaAnswerCheckResult,
} from "./lib/lint-checks/eia-answer-check.ts";
export {
  checkIntentionalError,
  checkIntentionalErrorSafety,
  type IntentionalErrorCheckResult,
  type IntentionalErrorSafetyResult,
} from "./lib/lint-checks/intentional-error.ts";
export {
  checkSectionItemFormat,
  type SectionItemFormatError,
  type SectionItemFormatReport,
} from "./lib/lint-checks/section-item-format.ts";
export {
  checkUseMelhorTempo,
  USE_MELHOR_TEMPO_RE,
  type UseMelhorTempoError,
  type UseMelhorTempoReport,
} from "./lib/lint-checks/use-melhor-tempo.ts";
export {
  checkSecondaryItemsHaveSummary,
  type SecondaryItemSummaryError,
  type SecondaryItemSummaryReport,
} from "./lib/lint-checks/secondary-items-have-summary.ts";
export {
  checkTitlePublisherSuffix,
  checkTitleTrailingPeriod,
  type TitlePublisherSuffixError,
  type TitlePublisherSuffixReport,
  type TitleTrailingPeriodError,
  type TitleTrailingPeriodReport,
} from "./lib/lint-checks/title-normalization.ts"; // #2664 + #2672
export {
  checkNoTrailingEllipsis,
  type NoTrailingEllipsisError,
  type NoTrailingEllipsisReport,
} from "./lib/lint-checks/no-trailing-ellipsis.ts"; // #2881
export {
  checkMidSentenceEllipsis,
  type MidSentenceEllipsisError,
  type MidSentenceEllipsisReport,
} from "./lib/lint-checks/mid-sentence-ellipsis.ts"; // #3196
export {
  checkNoUntranslatedSummary,
  type UntranslatedSummaryError,
  type UntranslatedSummaryReport,
} from "./lib/lint-checks/no-untranslated-summary.ts"; // #3196
export {
  checkVideoLinksAreYoutube,
  type VideoLinkYoutubeError,
  type VideoLinkYoutubeReport,
} from "./lib/lint-checks/video-links-are-youtube.ts"; // #3202
export {
  checkSectionLinksResolve,
  type SectionLinkUnresolvedError,
  type SectionLinksResolveReport,
} from "./lib/lint-checks/section-links-resolve.ts"; // #3821
export {
  lintNewsletter,
  extractUrlsBySection,
  buildUrlBucketMap,
  countItemsPerSection,
  checkSectionCounts,
  type LintError,
  type LintResult,
  type SectionCounts,
  type SectionCountsResult,
} from "./lib/lint-checks/url-bucket.ts";

// #1737 item 2: o cluster core URL×bucket (lintNewsletter, extractUrlsBySection,
// buildUrlBucketMap, countItemsPerSection, checkSectionCounts + tipos/SECTIONS)
// foi pra scripts/lib/lint-checks/url-bucket.ts. Re-export no topo; main() importa.

// #1737 item 2: checkDestaqueMinChars (#914) + checkDestaqueMaxChars (#964) +
// constantes DESTAQUE_MIN/MAX_CHARS movidos pra
// scripts/lib/lint-checks/destaque-chars.ts. Re-exportados no topo.

// #1737 item 2: checkSectionItemFormat (#909) → lint-checks/section-item-format.ts. Re-export no topo.

// #1737 item 2: checkEiaAnswer (#744/#927) → lint-checks/eia-answer-check.ts;
// checkIntentionalError (#754) → lint-checks/intentional-error.ts (migrado pra
// ler _internal/intentional-error.json em vez de frontmatter YAML, #3222).
// Re-export no topo do arquivo pra back-compat.

/**
 * Verifica que o número declarado na intro ("Selecionamos os N mais relevantes")
 * bate com a contagem real de URLs editoriais no body (#743).
 *
 * URLs contadas:
 *   - 1 URL por bloco DESTAQUE (a URL canônica, não as opções de título)
 *   - 1 URL por item em LANÇAMENTOS, PESQUISAS, OUTRAS NOTÍCIAS
 *   - É IA? é excluído (créditos de imagem)
 *
 * Retorna `{ ok, claimed, actual }`.
 * Se não conseguir parsear o número da intro, retorna `{ ok: true }` (não bloqueia).
 */
// #1455: re-exporta `IntroCountResult` da lib pra manter compat com callers
// existentes (test/lint-intro-count.test.ts, scripts/check-stage2-invariants.ts).
export type { IntroCountResult } from "./lib/newsletter-count.ts";

/**
 * #1454/#1455: wrapper sobre `lib/newsletter-count.ts:lintIntroCount` —
 * single source of truth com `sync-coverage-line.ts:countSelectedItems`.
 *
 * Antes (até #1453) os dois usavam algoritmos diferentes: producer dividia
 * por `---` E section-header lookahead com emoji+singular suportados, consumer
 * (este) tinha state machine line-by-line com regex que NÃO casava emoji
 * prefix (`**🚀 LANÇAMENTOS**`) nem singular (`**🚀 LANÇAMENTO**`). Caso
 * real 260522: intro dizia "12" (correto), lint reclamava "real é 3".
 *
 * Agora delegam pra mesma função — divergência por construção é impossível.
 */
export function lintIntroCount(md: string): IntroCountResult {
  return sharedLintIntroCount(md);
}

// #1737 item 2: lintMultilineLinks (#1213) e lintRelativeTime (#747) movidos
// pra scripts/lib/lint-checks/. Re-exportados abaixo pra back-compat (vários
// testes importam daqui). main() usa as funções importadas no topo do arquivo.

// #926: parseArgs local removido — usar parseCliArgs (scripts/lib/cli-args.ts).

// #1737 item 2: countTitlesPerHighlight (#178) + checkTitleLengths (#701) +
// as regexes de header compartilhadas movidos pra scripts/lib/lint-checks/
// (titles-per-highlight.ts, title-length.ts, highlight-parsing.ts). Re-export no topo.

// #1737 item 2: checkWhyMattersFormat (#701) e checkEaiSection (#588) movidos
// pra scripts/lib/lint-checks/. Re-exportados no topo do arquivo pra back-compat.

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = parseCliArgs(process.argv.slice(2)).values;

  // Modo --check titles-per-highlight (#178)
  if (args.check === "titles-per-highlight") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check titles-per-highlight --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = countTitlesPerHighlight(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.errors.length} erro(s):`);
      for (const e of result.errors) console.error(`  ${e}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check title-length (#701) — verifica que títulos cabem em ≤52 chars
  if (args.check === "title-length") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check title-length --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkTitleLengths(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.errors.length} título(s) excedem ${MAX_TITLE_LENGTH} chars:`);
      for (const e of result.errors) {
        console.error(`  DESTAQUE ${e.destaque} (${e.category}): ${e.length} chars — "${e.title}"`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check why-matters-format (#701) — bloqueia "Para [audiência]," opener
  if (args.check === "why-matters-format") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check why-matters-format --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkWhyMattersFormat(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.errors.length} parágrafo(s) "Por que isso importa" começam com ` +
          `"Para [audiência]," (editorial-rules:35):`,
      );
      for (const e of result.errors) {
        console.error(`  linha ${e.line}: "${e.text}"`);
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check eai-section (#588) — verifica presença da seção É IA?
  if (args.check === "eai-section") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check eai-section --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkEaiSection(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.error}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check eia-answer (#744) — verifica que 02-reviewed.md tem eia_answer
  // quando 01-eia.md existe na edition_dir
  if (args.check === "eia-answer") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check eia-answer --md <md-path> [--edition-dir <dir>]",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    const editionDir = args["edition-dir"]
      ? resolve(ROOT, args["edition-dir"])
      : undefined;
    const result = checkEiaAnswer(mdPath, editionDir);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.label}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check intentional-error-flagged (#754) — verifica que a edição tem
  // intentional_error declarado em `_internal/intentional-error.json` (#3222 —
  // migrado de frontmatter YAML; concurso mensal de erro proposital). Roda no
  // Stage 4 (publish-newsletter) antes de criar draft.
  if (args.check === "intentional-error-flagged") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check intentional-error-flagged --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    const result = checkIntentionalError(mdPath);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.label}`);
      console.error(
        `\nCrie/edite _internal/intentional-error.json (sibling de ${args.md}) com os campos:`,
      );
      console.error(`{
  "description": "o que o assinante deve identificar",
  "location": "DESTAQUE 2, parágrafo 2, primeira frase",
  "category": "factual",
  "correct_value": "valor correto",
  "reveal": "Na última edição, escrevi X onde o correto é Y."
}
// category: factual | ortografico | numeric | attribution | data | version_inconsistency | factual_synthetic`);
      process.exit(1);
    }
    // F1/#2149: wire safety check — warn (não bloqueia) para categorias de risco de desinformação
    if (!result.no_error) {
      const safetyResult = checkIntentionalErrorSafety(result.parsed?.category);
      if (!safetyResult.safe && safetyResult.warn) {
        console.error(`
⚠️  ${safetyResult.warn}`);
      }
    }
    return;
  }

  // Modo --check erro-intencional-placeholder (#2078, estendido #3489) —
  // verifica que a narrativa "Nessa edição, …" do bloco ERRO INTENCIONAL foi
  // substituída pelo editor por uma declaração real ANTES da publicação.
  // Nenhum outro lint pega esse caso.
  //
  // #3489: o check original só detectava o placeholder LITERAL
  // ({PREENCHER_NARRATIVA_DO_ERRO} intacto). Prosa corrompida/genérica que
  // SUBSTITUIU o placeholder (mas não é uma declaração válida) passava
  // silenciosamente — foi exatamente o que aconteceu no #3485, cujo fallback
  // não-idempotente produzia "Nessa edição, Na última edição, escrevi que a
  // Acme foi fundada em 2020, quando na verdade foi em 2022." (texto
  // agramatical e auto-contraditório, sem o literal `{PREENCHER...}`).
  // Estendido pra reusar os mesmos predicados de classificação que
  // `extractCurrentDeclarationFromMd` já aplica na extração (#2377/#2411),
  // mais o predicado novo de auto-concatenação (#3489) — elimina a
  // divergência de rigor entre extração e lint em vez de criar uma terceira
  // regra paralela.
  if (args.check === "erro-intencional-placeholder") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check erro-intencional-placeholder --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const hasPlaceholder = /\{PREENCHER_NARRATIVA_DO_ERRO\}/.test(md);
    let label: string | undefined;
    if (hasPlaceholder) {
      label =
        "erro-intencional-placeholder: placeholder {PREENCHER_NARRATIVA_DO_ERRO} ainda presente — preencha a narrativa do erro desta edição no bloco ERRO INTENCIONAL antes de publicar";
    } else {
      // (#3489) Placeholder literal ausente — mas a prosa que o substituiu
      // pode ainda assim ser inválida (corrompida/genérica/catalog-shaped).
      // Extração CRUA (sem filtro) pra classificar a razão específica.
      const rawNarrative = extractRawCurrentNarrative(md);
      if (rawNarrative) {
        if (narrativeIsSelfConcatenated(rawNarrative)) {
          label =
            `erro-intencional-placeholder: narrativa corrompida por auto-concatenação — ` +
            `"Nessa edição, ${rawNarrative.slice(0, 120)}${rawNarrative.length > 120 ? "…" : ""}." ` +
            `começa com "Na última edição," (abertura do reveal da edição ANTERIOR, não da ` +
            `declaração desta edição). Sinal da mesma classe de bug do #3485 — reescreva a ` +
            `narrativa desta edição no bloco ERRO INTENCIONAL antes de publicar.`;
        } else if (narrativeIsGenericPlaceholder(rawNarrative)) {
          label =
            `erro-intencional-placeholder: narrativa genérica — "Nessa edição, ` +
            `${rawNarrative.slice(0, 120)}${rawNarrative.length > 120 ? "…" : ""}." parece ` +
            `texto copiado do bloco de convite ao sorteio (contém frases como "há um erro ` +
            `proposital", "responda este e-mail", "concorrer ao sorteio"), não uma declaração ` +
            `real. Preencha a narrativa específica do erro desta edição antes de publicar.`;
        } else if (narrativeIsCatalogShaped(rawNarrative)) {
          label =
            `erro-intencional-placeholder: narrativa catalog-shaped — "Nessa edição, ` +
            `${rawNarrative.slice(0, 120)}${rawNarrative.length > 120 ? "…" : ""}." começa com ` +
            `um label interno (ex: "DESTAQUE N") em vez de prosa first-person legível pelo ` +
            `assinante. Preencha a narrativa desta edição antes de publicar.`;
        }
      }
    }
    const result = { ok: !label, label };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.label}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check erro-intencional-narrative-generico (#2377) — verifica que a
  // narrativa "Nessa edição, …" no bloco ERRO INTENCIONAL é uma declaração
  // específica de primeira pessoa do editor (não um placeholder genérico copiado
  // do bloco de convite ao sorteio). Root cause do bug #2377: "há um erro
  // proposital escondido em um dos destaques. Responda este e-mail com a correção
  // para concorrer ao sorteio" foi gravado como narrative e formatado verbatim no
  // reveal da edição seguinte. Guard determinístico aqui pega isso no gate Stage 4
  // ANTES de publicar — muito mais cedo do que a publicação incorreta.
  //
  // Bloqueante: o editor precisa escrever a narrativa real ("Nessa edição, escrevi
  // que [X], quando o correto é [Y]") antes de aprovar o gate.
  if (args.check === "erro-intencional-narrative-generico") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check erro-intencional-narrative-generico --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const extracted = extractCurrentDeclarationFromMd(md);
    let isGeneric = false;
    let label: string | undefined;
    if (extracted && extracted.narrative) {
      isGeneric = narrativeIsGenericPlaceholder(extracted.narrative);
      if (isGeneric) {
        label =
          `erro-intencional-narrative-generico: a narrativa "Nessa edição, ${extracted.narrative}." ` +
          `parece ser um placeholder genérico copiado do bloco de convite ao sorteio (contém frases ` +
          `como "há um erro proposital", "responda este e-mail", "concorrer ao sorteio"). ` +
          `O reveal da próxima edição sairá com esse texto genérico em vez do erro real. ` +
          `Substitua pela declaração específica de primeira pessoa do editor: ` +
          `"Nessa edição, escrevi que [afirmação errada], quando o correto é [valor correto]."`;
      }
    }
    const result = { ok: !isGeneric, label };
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ ${result.label}`);
      process.exit(1);
    }
    return;
  }

  // Modo --check destaque-min-chars (#914) — valida mínimo de chars por destaque
  if (args.check === "destaque-min-chars") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check destaque-min-chars --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkDestaqueMinChars(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ destaque-min-chars: ${result.errors.length} destaque(s) abaixo do mínimo:`,
      );
      for (const e of result.errors) {
        const deficit = e.min - e.chars;
        console.error(
          `  D${e.destaque} (${e.category}): ${e.chars} chars — abaixo do mínimo de ${e.min} (deficit: ${deficit} chars)`,
        );
      }
      console.error(
        `\nFix: re-disparar writer pra expandir o body do destaque (mais 1 parágrafo OU "Por que isso importa" estendido).`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check destaque-max-chars (#964) — valida máximo de chars por destaque
  if (args.check === "destaque-max-chars") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check destaque-max-chars --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkDestaqueMaxChars(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ destaque-max-chars: ${result.errors.length} destaque(s) acima do máximo:`,
      );
      for (const e of result.errors) {
        const excess = e.chars - e.max;
        console.error(
          `  D${e.destaque} (${e.category}): ${e.chars} chars — acima do máximo de ${e.max} (excesso: ${excess} chars)`,
        );
      }
      console.error(
        `\nFix: re-disparar writer pra trimar o body do destaque (corte parágrafo redundante OU encurte "Por que isso importa").`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check section-item-format (#909) — valida formato de itens em seções secundárias
  if (args.check === "section-item-format") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check section-item-format --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkSectionItemFormat(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ section-item-format: ${result.errors.length} item(ns) fora do formato esperado:`,
      );
      for (const e of result.errors) {
        console.error(`  ${e.section} linha ${e.line}: ${e.type}`);
        console.error(`    "${e.excerpt}"`);
      }
      console.error(
        `\nFormato esperado: "**[Título](URL)**" + linha em branco + descrição plain.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check section-counts (#907) — verifica que seções secundárias
  // respeitam caps de #358 (lançamentos≤5, pesquisas≤3, outras=max(2, 12-d-l-p))
  if (args.check === "section-counts") {
    if (!args.md || !args.approved) {
      console.error(
        "Uso: lint-newsletter-md.ts --check section-counts --md <md-path> --approved <01-approved.json-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    const approvedPath = resolve(ROOT, args.approved);
    if (!existsSync(mdPath) || !existsSync(approvedPath)) {
      console.error(
        `Arquivo não encontrado: ${!existsSync(mdPath) ? mdPath : approvedPath}`,
      );
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
    const result = checkSectionCounts(md, approved);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ section-counts: ${result.violations.length} seção(ões) excede(m) cap de #358:`,
      );
      for (const v of result.violations) console.error(`  ${v}`);
      console.error(
        `\nDestaques na edição: ${result.destaques}. Caps esperados: ` +
          `lançamentos≤${result.caps.lancamento}, radar≤${result.caps.radar}, ` +
          `vídeos≤${result.caps.video} ` +
          `(#1629: radar = max(5, 12-${result.destaques}-l); #1693: vídeos≤2)`,
      );
      console.error(
        `\nFix: re-rodar /diaria-2-escrita ${args.md.match(/\d{6}/)?.[0] ?? "AAMMDD"} newsletter — ` +
          `o orchestrator agora aplica caps via apply-stage2-caps.ts antes do writer.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check intro-count (#743) — verifica que intro bate com contagem real
  if (args.check === "intro-count") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check intro-count --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintIntroCount(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ intro-count: intro afirma ${result.claimed} mas contagem real é ${result.actual}`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check coverage-line-format (#1207) — valida formato canônico da
  // linha de cobertura via checkCoverageLine (existing helper, #592/#609)
  if (args.check === "coverage-line-format") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check coverage-line-format --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkCoverageLine(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(`\n❌ coverage-line-format: primeira linha não bate com regex canônico.`);
      console.error(
        `   Esperado: "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter."`,
      );
      console.error(`   Encontrado: "${result.firstLine.slice(0, 120)}"`);
      process.exit(1);
    }
    return;
  }

  // Modo --check multiline-links (#1213) — detecta links markdown quebrados
  if (args.check === "multiline-links") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check multiline-links --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintMultilineLinks(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} link(s) markdown quebrado(s) em múltiplas linhas:`,
      );
      for (const m of result.matches) {
        console.error(`  linha ${m.line}: "${m.context}"`);
      }
      console.error(
        `\n   Fix: junte cada link em uma única linha — [Label](url) sem newline entre os elementos.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check relative-time (#747) — detecta referências temporais relativas
  if (args.check === "relative-time") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check relative-time --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintRelativeTime(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} referência(s) temporal(is) relativa(s) detectada(s):`,
      );
      for (const m of result.matches) {
        console.error(
          `  linha ${m.line}: relative_time: '${m.word}' encontrado — edição publica D+1, use data absoluta\n    contexto: "...${m.context}..."`,
        );
      }
      process.exit(1);
    }
    return;
  }

  // Modo --check use-melhor-tempo (#2372) — cada item USE MELHOR precisa de
  // estimativa de tempo "— N min" na linha de descrição.
  if (args.check === "use-melhor-tempo") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check use-melhor-tempo --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkUseMelhorTempo(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ use-melhor-tempo: ${result.errors.length} item(ns) USE MELHOR sem estimativa de tempo:`,
      );
      for (const e of result.errors) {
        console.error(
          `  item ${e.item} (linha ${e.titleLine}): descrição "${e.excerpt}" não contém "(N min)" ou "— N min"`,
        );
      }
      console.error(
        `\nFix: adicione "(X min)" ou "— X min" à descrição de cada item (ex: "(5 min)" ou "— 5 min de leitura").`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check secondary-items-have-summary (#2545) — item de seção secundária
  // (LANÇAMENTOS/RADAR/USE MELHOR) sem descrição. Acusa ANTES do gate Stage 4
  // para que o editor possa corrigir antes de publicar.
  if (args.check === "secondary-items-have-summary") {
    if (!args.md) {
      console.error(
        "Uso: lint-newsletter-md.ts --check secondary-items-have-summary --md <md-path>",
      );
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkSecondaryItemsHaveSummary(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ secondary-items-have-summary: ${result.errors.length} item(ns) sem descrição nas seções secundárias:`,
      );
      for (const e of result.errors) {
        console.error(`  ${e.section} linha ${e.titleLine}: "${e.titleExcerpt}"`);
      }
      console.error(
        `\nFix: adicione uma linha de descrição (plain text, 1 frase) abaixo de cada título pelado.`,
      );
      console.error(
        `Causa provável: cache-miss no enrich-inbox-articles (body não cacheado no 1i). Re-rodar Etapa 1 ou adicionar descrição manualmente.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check title-publisher-suffix (#2664) — título com sufixo de veículo
  // (` | Veículo`, ` - Veículo`, ` — Veículo`) que não foi strippado no Stage 1.
  // WARN-ONLY (#2715 item 3): orchestrator-stage-4.md §4c.2 documenta este check
  // como WARN-ONLY (heurística ampla, sem allowlist — pode ter falso-positivo em
  // traço editorial legítimo), mas até #2715 o CLI saía com exit 1 + ❌, o que
  // contradizia a doc e podia levar o orchestrator LLM a bloquear o gate
  // indevidamente. Sempre exit 0 — matches são surfaçados como ⚠️ no gate via
  // `{violations_block}`, nunca bloqueiam.
  if (args.check === "title-publisher-suffix") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check title-publisher-suffix --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkTitlePublisherSuffix(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n⚠️  title-publisher-suffix: ${result.errors.length} título(s) com sufixo de veículo:`,
      );
      for (const e of result.errors) {
        console.error(`  linha ${e.line} [${e.separator}]: "${e.title}" → sufixo: "${e.suffix}"`);
      }
      console.error(
        `\nFix: o sufixo deveria ter sido removido pelo enrich-inbox-articles.ts (Stage 1). Edite o título manualmente ou re-rode Stage 1.`,
      );
      // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
    }
    return;
  }

  // Modo --check title-trailing-period (#2672) — título terminando com ponto final.
  // Manchetes não terminam em ponto. Residual de og:title.
  // WARN-ONLY (#2715 item 3) — mesma justificativa de title-publisher-suffix acima.
  if (args.check === "title-trailing-period") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check title-trailing-period --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkTitleTrailingPeriod(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n⚠️  title-trailing-period: ${result.errors.length} título(s) terminando com ponto final:`,
      );
      for (const e of result.errors) {
        console.error(`  linha ${e.line}: "${e.title}"`);
      }
      console.error(
        `\nFix: o ponto final deveria ter sido removido pelo enrich-inbox-articles.ts (Stage 1). Edite o título manualmente ou re-rode Stage 1.`,
      );
      // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
    }
    return;
  }

  // Modo --check no-trailing-ellipsis (#2881) — item de seção secundária cuja
  // descrição termina em `…`/`...` (reticências herdadas do snippet da fonte).
  // Backstop para casos que escaparam de `sanitizeTrailingEllipsis` no Stage 1
  // (ex: texto curado manualmente pelo editor). WARN-ONLY — mesma justificativa
  // de title-publisher-suffix/title-trailing-period acima (#2715): heurística
  // ampla, sem allowlist, não bloqueia o gate.
  if (args.check === "no-trailing-ellipsis") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check no-trailing-ellipsis --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkNoTrailingEllipsis(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n⚠️  no-trailing-ellipsis: ${result.errors.length} item(ns) de seção secundária com descrição terminando em reticências:`,
      );
      for (const e of result.errors) {
        console.error(
          `  ${e.section} linha ${e.line}: "${e.titleExcerpt}" → descrição: "...${e.descriptionExcerpt}"`,
        );
      }
      console.error(
        `\nFix: a reticência é herdada do snippet/meta-description da fonte (não é nosso truncamento). Edite a descrição manualmente ou re-rode Stage 1 (enrich-inbox-articles.ts já sanitiza casos novos).`,
      );
      // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
    }
    return;
  }

  // Modo --check mid-sentence-ellipsis (#3196) — item de seção secundária cuja
  // descrição contém `…`/`...` no MEIO da frase (backstop pra truncamento de
  // meta-description de veículo que não termina no fim da string, ex: G1).
  // WARN-ONLY — mesma justificativa de no-trailing-ellipsis acima (#2715):
  // heurística ampla, sem allowlist, também pega reticência estilística
  // legítima no meio da frase; o editor decide.
  if (args.check === "mid-sentence-ellipsis") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check mid-sentence-ellipsis --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkMidSentenceEllipsis(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n⚠️  mid-sentence-ellipsis: ${result.errors.length} item(ns) de seção secundária com reticência NO MEIO da descrição:`,
      );
      for (const e of result.errors) {
        console.error(
          `  ${e.section} linha ${e.line}: "${e.titleExcerpt}" → descrição: "${e.descriptionExcerpt}"`,
        );
      }
      console.error(
        `\nFix: a reticência é herdada do snippet/meta-description da fonte truncada no meio (não é nosso truncamento), OU é um uso estilístico legítimo — decida caso a caso e edite a descrição manualmente se necessário.`,
      );
      // WARN-ONLY (#2715): exit 0 mesmo com matches — não bloqueia o gate.
    }
    return;
  }

  // Modo --check no-untranslated-summary (#3196) — item de seção secundária
  // com marcador literal [TRADUZIR] OU descrição em inglês (heurística) que
  // sobreviveu até o gate. GATE-BLOCKING (mirrors secondary-items-have-summary,
  // #2545): um item não-traduzido não é publicável.
  if (args.check === "no-untranslated-summary") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check no-untranslated-summary --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkNoUntranslatedSummary(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ no-untranslated-summary: ${result.errors.length} item(ns) de seção secundária não traduzido(s):`,
      );
      for (const e of result.errors) {
        const why = e.reason === "traduzir_prefix" ? "marcador [TRADUZIR] literal" : "heurística EN (sem marcador)";
        console.error(`  ${e.section} linha ${e.line} [${why}]: "${e.titleExcerpt}" → "${e.descriptionExcerpt}"`);
      }
      console.error(
        `\nFix: traduza a descrição pra PT-BR em 02-reviewed.md e remova o prefixo "[TRADUZIR] " se presente, antes de aprovar o gate.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check video-links-are-youtube (#3202) — item da seção VÍDEOS com
  // URL fora de youtube.com/youtu.be (página que só embeda o vídeo, ex: blog
  // oficial). GATE-BLOCKING: regra editorial nova (context/editorial-rules.md
  // — Seção "Vídeos") exige link do YouTube sempre; a resolução automática
  // (Stage 1, scripts/resolve-video-youtube.ts) já tenta trocar pela URL do
  // YouTube — este lint é o backstop que garante que nada não-YouTube
  // sobrevive até o gate (resolução pulada, ou link colado manualmente).
  if (args.check === "video-links-are-youtube") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check video-links-are-youtube --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkVideoLinksAreYoutube(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ video-links-are-youtube: ${result.errors.length} item(ns) da seção VÍDEOS sem URL do YouTube:`,
      );
      for (const e of result.errors) {
        console.error(`  linha ${e.line}: ${e.url}`);
      }
      console.error(
        `\nFix: substitua pela URL do YouTube (youtube.com/watch?v=... ou youtu.be/...) equivalente em 02-reviewed.md antes de aprovar, ou mova o item pra fora de VÍDEOS.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check section-links-resolve (#3821) — roda o parser REAL
  // (parseSections) e falha se algum item de seção secundária saiu com
  // url vazia (formato não reconhecido por nenhum branch de parseListItems,
  // ex: 2 links markdown na mesma linha em VÍDEOS).
  if (args.check === "section-links-resolve") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check section-links-resolve --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = checkSectionLinksResolve(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ section-links-resolve: ${result.errors.length} item(ns) sem URL (formato não reconhecido pelo parser real):`,
      );
      for (const e of result.errors) {
        console.error(`  [${e.section}] ${e.titleExcerpt}`);
      }
      console.error(
        `\nFix: o item degradou pro fallback legado de parseListItems (linha inteira virou title cru, url/description vazios) — geralmente 2 links markdown na mesma linha (ex: **[Título]** — [Canal](URL)) ou blank line entre título e descrição do mesmo item. Reescreva o item em 02-reviewed.md como [Título](URL) numa linha + descrição na linha IMEDIATAMENTE seguinte (sem blank line entre elas). Ver context/templates/newsletter.md.`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check callout-placement (#1972) — callout (📣/📚/🎉) colado DENTRO de
  // uma seção de DESTAQUE (antes do `---`) em vez de isolado entre dois `---`.
  if (args.check === "callout-placement") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check callout-placement --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintCalloutPlacement(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.matches.length} callout(s) colado(s) dentro de uma seção de DESTAQUE:`,
      );
      for (const m of result.matches) {
        console.error(`  linha ${m.line}: "${m.context}"`);
      }
      console.error(
        `\n   Fix: mova o callout pra sua PRÓPRIA seção, isolada entre o \`---\` que fecha o D1 e o \`---\` que abre o D2. (O render já de-duplica — #1972 Opção A — mas o MD deve ficar correto.)`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check stacked-intro-callouts (#2729) — ≥2 blocos `**(🎉|📣)…**`
  // empilhados na região de intro (antes do 1º `**DESTAQUE`) fundem no
  // `extractIntroCallout` greedy (#2727): `**` internos vazam como texto
  // literal + separador "Divulgação" do bloco 📣 se perde.
  if (args.check === "stacked-intro-callouts") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check stacked-intro-callouts --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const result = lintStackedIntroCallouts(md);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) {
      console.error(
        `\n❌ ${result.count} blocos de callout (🎉/📣) empilhados na região de intro (linhas ${result.lines.join(", ")}):`,
      );
      console.error(
        `\n   Fix: manter só 1 bloco \`**🎉/📣 …**\` na região de intro (antes do 1º **DESTAQUE). Blocos empilhados fundem no render (extractIntroCallout é greedy, #2727) — \`**\` internos vazam como texto literal e o separador "Divulgação" do bloco patrocinado se perde. Se 2 CTAs são necessários, mesclar num único bloco ou mover o 2º para uma lacuna entre destaques (box de divulgação).`,
      );
      process.exit(1);
    }
    return;
  }

  // Modo --check orphan-box-in-gap (#3204, estendido pro slot 3 em #3476) —
  // backstop pós marcador-agnóstico: (a) callout com forma de box (bold-line
  // inteiro OU emoji-led) colado DENTRO de uma seção de destaque, sem `---`
  // isolando-o (reusa lintCalloutPlacement, agora marcador-agnóstico); (b)
  // lacuna (D1/D2, D2/D3) OU região pós-último-destaque (slot 3, entre o
  // último destaque e USE MELHOR/É IA?) com MAIS de 1 bloco extra
  // `---`-isolado — ambíguo, `locateBoxInGap`/`locateBoxAfterLastDestaque`
  // descartariam os excedentes silenciosamente (findOrphanBoxWarnings).
  if (args.check === "orphan-box-in-gap") {
    if (!args.md) {
      console.error("Uso: lint-newsletter-md.ts --check orphan-box-in-gap --md <md-path>");
      process.exit(2);
    }
    const mdPath = resolve(ROOT, args.md);
    if (!existsSync(mdPath)) {
      console.error(`Arquivo não existe: ${mdPath}`);
      process.exit(2);
    }
    const md = readFileSync(mdPath, "utf8");
    const placement = lintCalloutPlacement(md);
    const orphanGaps = findOrphanBoxWarnings(md);
    const ok = placement.ok && orphanGaps.length === 0;
    console.log(JSON.stringify({ ok, calloutPlacement: placement, orphanGaps }, null, 2));
    if (!ok) {
      console.error(
        `\n❌ possível box de divulgação órfão (marcador não reconhecido NÃO é mais o problema — a extração é por posição; o problema é ESTRUTURA ambígua):`,
      );
      for (const m of placement.matches) {
        console.error(
          `  linha ${m.line}: "${m.context}" — parece um box colado DENTRO de uma seção de destaque, sem \`---\` isolando-o.`,
        );
      }
      for (const w of orphanGaps) {
        console.error(`  ${w.reason}`);
      }
      console.error(
        `\n   Fix: isole o box em sua PRÓPRIA seção, entre o \`---\` que fecha o destaque anterior e o \`---\` que abre o próximo — exatamente 1 bloco extra por lacuna.`,
      );
      process.exit(1);
    }
    return;
  }

  if (!args.md || !args.approved) {
    console.error(
      "Uso: lint-newsletter-md.ts --md <md-path> --approved <01-approved.json-path>\n" +
        "  ou: lint-newsletter-md.ts --check titles-per-highlight --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check title-length --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check why-matters-format --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check eai-section --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check eia-answer --md <md-path> [--edition-dir <dir>]\n" +
        "  ou: lint-newsletter-md.ts --check intro-count --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check coverage-line-format --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check relative-time --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check section-counts --md <md-path> --approved <01-approved.json>\n" +
        "  ou: lint-newsletter-md.ts --check destaque-min-chars --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check destaque-max-chars --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check erro-intencional-placeholder --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check erro-intencional-narrative-generico --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check use-melhor-tempo --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check secondary-items-have-summary --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check title-publisher-suffix --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check title-trailing-period --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check no-trailing-ellipsis --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check mid-sentence-ellipsis --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check no-untranslated-summary --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check video-links-are-youtube --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check callout-placement --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check stacked-intro-callouts --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check orphan-box-in-gap --md <md-path>",
    );
    process.exit(2);
  }
  const mdPath = resolve(ROOT, args.md);
  const approvedPath = resolve(ROOT, args.approved);
  if (!existsSync(mdPath) || !existsSync(approvedPath)) {
    console.error(`Arquivo não encontrado: ${!existsSync(mdPath) ? mdPath : approvedPath}`);
    process.exit(2);
  }
  const md = readFileSync(mdPath, "utf8");
  const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
  const result = lintNewsletter(md, approved);
  // #592, #609: check separado da linha de cobertura — não polui lintNewsletter
  // (que tem semântica focada em buckets), mas roda no mesmo CLI.
  const coverage = checkCoverageLine(md);
  if (!coverage.ok) {
    result.errors.push({
      section: "coverage_line",
      expected_bucket: "radar",
      url: "",
      line: 1,
      found_in_bucket: "missing",
      title: coverage.firstLine.slice(0, 80),
    });
    result.ok = false;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    const sectionErrors = result.errors.filter((e) => e.section !== "coverage_line");
    const coverageErrors = result.errors.filter((e) => e.section === "coverage_line");
    if (coverageErrors.length > 0) {
      console.error(`\n❌ Linha de cobertura ausente ou em formato inválido (#592, #609).`);
      console.error(
        `  Esperado: "Para esta edição, eu (o editor) enviei X submissões e a Diar.ia encontrou outros Y artigos. Selecionamos os Z mais relevantes para as pessoas que assinam a newsletter."`,
      );
      console.error(`  Encontrado (primeira linha): "${coverageErrors[0].title}"`);
    }
    if (sectionErrors.length > 0) console.error(`\n❌ ${sectionErrors.length} erro(s) de seção:`);
    for (const e of sectionErrors) {
      const titleHint = e.title ? ` ("${e.title.slice(0, 60)}")` : "";
      console.error(
        `  ${e.section} (linha ${e.line}): ${e.url}${titleHint}\n    bucket no approved: ${e.found_in_bucket}, esperado: ${e.expected_bucket}`,
      );
    }
    process.exit(1);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}
