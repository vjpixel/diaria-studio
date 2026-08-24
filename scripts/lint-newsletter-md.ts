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
import { checkTitleMentionsIA } from "./lib/lint-checks/ia-in-title.ts"; // #4825
import { checkTitleClickbaitVulgar } from "./lib/lint-checks/title-clickbait-vulgar.ts"; // #6008
import { checkEiaAnswer } from "./lib/lint-checks/eia-answer-check.ts";
import { checkIntentionalError, checkIntentionalErrorSafety } from "./lib/lint-checks/intentional-error.ts";
// #5895: extractCurrentDeclarationFromMd/extractRawCurrentNarrative/
// narrativeIs*Shaped/Placeholder/Concatenated eram usados só pelos blocos
// erro-intencional-placeholder e erro-intencional-narrative-generico de
// main() — movidos pra scripts/lib/lint-checks/cli/, que importam
// diretamente de ./render-erro-intencional.ts. Nada mais neste arquivo
// (nem runStage2/4LintReport) usa esses símbolos.
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
  checkSecondaryItemCoherence,
  type SecondaryItemCoherenceError,
  type SecondaryItemCoherenceReport,
} from "./lib/lint-checks/secondary-item-coherence.ts"; // #5663
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
import {
  checkAprofundeFormat,
  type AprofundeFormatError,
  type AprofundeFormatReport,
} from "./lib/lint-checks/aprofunde-format.ts"; // #3920
import {
  checkWhyMattersLength,
  WHY_MATTERS_MIN_CHARS,
  WHY_MATTERS_MAX_CHARS,
  type WhyMattersLengthError,
  type WhyMattersLengthReport,
} from "./lib/lint-checks/why-matters-length.ts"; // #3993
import {
  checkNoXmlArtifacts,
  type NoXmlArtifactsError,
  type NoXmlArtifactsReport,
} from "./lib/lint-checks/no-xml-artifacts.ts"; // #4077
import {
  runSnippetStalenessCheck,
  type SnippetStalenessReport,
  type SnippetStalenessWarning,
} from "./lib/lint-checks/snippet-staleness.ts"; // #4076
import {
  checkAgradecimentoHardcoded,
  type AgradecimentoHardcodedResult,
} from "./lib/lint-checks/agradecimento-hardcoded.ts"; // #4359
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
  checkTitleMentionsIA,
  type TitleMentionsIaError,
  type TitleMentionsIaReport,
} from "./lib/lint-checks/ia-in-title.ts"; // #4825
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
  checkSecondaryItemCoherence,
  type SecondaryItemCoherenceError,
  type SecondaryItemCoherenceReport,
} from "./lib/lint-checks/secondary-item-coherence.ts"; // #5663
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
  checkAprofundeFormat,
  type AprofundeFormatError,
  type AprofundeFormatReport,
} from "./lib/lint-checks/aprofunde-format.ts"; // #3920
export {
  checkWhyMattersLength,
  WHY_MATTERS_MIN_CHARS,
  WHY_MATTERS_MAX_CHARS,
  type WhyMattersLengthError,
  type WhyMattersLengthReport,
} from "./lib/lint-checks/why-matters-length.ts"; // #3993
export {
  checkNoXmlArtifacts,
  detectTrailingToolCallArtifact,
  stripTrailingToolCallArtifact,
  type NoXmlArtifactsError,
  type NoXmlArtifactsReport,
} from "./lib/lint-checks/no-xml-artifacts.ts"; // #4077
export {
  runSnippetStalenessCheck,
  resolveUsedSnippets,
  evaluateSnippetStaleness,
  readBoxesDivulgacaoConfig,
  isAgradecimentoSnippetUsed,
  type SnippetStalenessReport,
  type SnippetStalenessWarning,
  type UsedSnippetEntry,
  type BoxesDivulgacaoConfigLike,
} from "./lib/lint-checks/snippet-staleness.ts"; // #4076
export {
  checkAgradecimentoHardcoded,
  type AgradecimentoHardcodedResult,
} from "./lib/lint-checks/agradecimento-hardcoded.ts"; // #4359
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

// ---------------------------------------------------------------------------
// #5416 — Modo agregador `--stage <2|4> --json`
// ---------------------------------------------------------------------------
//
// `.claude/agents/orchestrator-stage-4.md` §4c.2 dispara 15 invocações
// separadas de `lint-newsletter-md.ts` (1 processo Node por check). As duas
// funções abaixo rodam o MESMO conjunto de checks — mesmas funções puras,
// mesmos arquivos-fonte — numa única chamada de processo, devolvendo um
// relatório único com veredito por check.
//
// **Aditivo, nunca substitui os modos `--check X` individuais acima** — cada
// handler CLI (extraído pra `scripts/lib/lint-checks/cli/{check-name}.ts`,
// #5895 — motion puro, main() virou um dispatch table CHECK_HANDLERS em vez
// dos ~34 blocos `if (args.check === "...")` inline) continua existindo
// intacto e continua sendo o jeito suportado de rodar 1 check isolado
// (debug, testes existentes). Este agregador só empacota os MESMOS checks
// numa chamada.
//
// A severity (`gate-blocking` vs `warn-only`) de cada entrada espelha o
// comportamento REAL de `process.exit()` do modo `--check` correspondente
// (não a prosa do playbook, que diverge em 1 ponto conhecido — ver nota em
// `stacked-intro-callouts` abaixo) — garante que `--stage N --json` produz o
// MESMO veredito que rodar cada `--check X` isoladamente.

export type StageCheckSeverity = "gate-blocking" | "warn-only";

export interface StageCheckResult {
  id: string;
  source_issue: string;
  severity: StageCheckSeverity;
  ok: boolean;
  result: unknown;
}

export interface StageLintReport {
  stage: 2 | 4;
  /** `true` quando nenhum check `gate-blocking` falhou (warn-only nunca bloqueia). */
  passed: boolean;
  checks: StageCheckResult[];
}

type PushCheckFn = (
  id: string,
  sourceIssue: string,
  severity: StageCheckSeverity,
  ok: boolean,
  result: unknown,
) => void;

/**
 * Isola cada check individual dentro dos agregadores `--stage <2|4> --json`
 * abaixo (#5455 fix, review de #5416). Sem isto, uma exceção não tratada em
 * QUALQUER check (ex: `01-approved.json` presente mas malformado —
 * `JSON.parse` sem try/catch) derrubava a função inteira: `main()` propagava
 * sem capturar, o processo morria, stdout ficava vazio, e a granularidade de
 * TODOS os outros checks independentes (que não tinham nada a ver com o
 * arquivo corrompido) se perdia junto. `runCheckSafely` converte essa exceção
 * numa entrada `StageCheckResult` normal — `ok: false`, severity SEMPRE
 * `gate-blocking` (fail-safe: nunca deixar uma exceção virar "warn-only" por
 * engano, mesmo quando o check original é warn-only) — preservando a
 * execução dos checks seguintes.
 */
function runCheckSafely<T extends { ok: boolean }>(
  push: PushCheckFn,
  id: string,
  sourceIssue: string,
  severity: StageCheckSeverity,
  fn: () => T,
): void {
  try {
    const result = fn();
    push(id, sourceIssue, severity, result.ok, result);
  } catch (err) {
    push(id, sourceIssue, "gate-blocking", false, {
      error: `exceção não tratada em ${id}: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

/**
 * Roda os checks de `.claude/agents/orchestrator-stage-4.md` §4c.2 sobre
 * `{editionDir}/02-reviewed.md` numa única chamada.
 *
 * NÃO inclui `validate-lancamentos.ts` (script separado, fora deste
 * arquivo) — o orchestrator continua chamando-o à parte.
 */
export function runStage4LintReport(editionDir: string, root: string): StageLintReport {
  const mdPath = resolve(editionDir, "02-reviewed.md");
  const approvedPath = resolve(editionDir, "_internal", "01-approved.json");
  const snippetPath = resolve(root, "data", "snippets", "agradecimento-apoiadores.md");

  const checks: StageCheckResult[] = [];
  const push = (
    id: string,
    sourceIssue: string,
    severity: StageCheckSeverity,
    ok: boolean,
    result: unknown,
  ) => {
    checks.push({ id, source_issue: sourceIssue, severity, ok, result });
  };

  if (!existsSync(mdPath)) {
    push("md-exists", "#5416", "gate-blocking", false, {
      error: `arquivo não encontrado: ${mdPath}`,
    });
  } else {
    const md = readFileSync(mdPath, "utf8");

    // url-bucket + coverage-line (#165, #592, #609) — mesmo código do modo
    // default (sem --check) de main() abaixo.
    if (!existsSync(approvedPath)) {
      push("url-bucket", "#165", "gate-blocking", false, {
        error: `01-approved.json não encontrado: ${approvedPath}`,
      });
    } else {
      runCheckSafely(push, "url-bucket", "#165", "gate-blocking", () => {
        const approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
        const urlBucket = lintNewsletter(md, approved);
        const coverage = checkCoverageLine(md);
        if (!coverage.ok) {
          urlBucket.errors.push({
            section: "coverage_line",
            expected_bucket: "radar",
            url: "",
            line: 1,
            found_in_bucket: "missing",
            title: coverage.firstLine.slice(0, 80),
          });
          urlBucket.ok = false;
        }
        return urlBucket;
      });
    }

    runCheckSafely(push, "secondary-items-have-summary", "#2545", "gate-blocking", () =>
      checkSecondaryItemsHaveSummary(md),
    );

    if (existsSync(approvedPath)) {
      runCheckSafely(push, "secondary-item-coherence", "#5663", "gate-blocking", () =>
        checkSecondaryItemCoherence(
          md,
          JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson,
        ),
      );
    }

    runCheckSafely(push, "no-untranslated-summary", "#3196", "gate-blocking", () =>
      checkNoUntranslatedSummary(md),
    );

    runCheckSafely(push, "video-links-are-youtube", "#3202", "gate-blocking", () =>
      checkVideoLinksAreYoutube(md),
    );

    runCheckSafely(push, "section-links-resolve", "#3821", "gate-blocking", () =>
      checkSectionLinksResolve(md),
    );

    runCheckSafely(push, "title-publisher-suffix", "#2664", "warn-only", () =>
      checkTitlePublisherSuffix(md),
    );

    runCheckSafely(push, "title-trailing-period", "#2672", "warn-only", () =>
      checkTitleTrailingPeriod(md),
    );

    runCheckSafely(push, "no-trailing-ellipsis", "#2881", "warn-only", () =>
      checkNoTrailingEllipsis(md),
    );

    runCheckSafely(push, "mid-sentence-ellipsis", "#3196", "warn-only", () =>
      checkMidSentenceEllipsis(md),
    );

    runCheckSafely(push, "title-mentions-ia", "#4825", "warn-only", () =>
      checkTitleMentionsIA(md),
    );

    // #6008: clickbait elegante — faixa VULGAR flagrada por blocklist.
    // WARN-ONLY (mesmo molde de title-mentions-ia): decisão de tom é do
    // editor no gate da Etapa 4.
    runCheckSafely(push, "title-clickbait-vulgar", "#6008", "warn-only", () =>
      checkTitleClickbaitVulgar(md),
    );

    // stacked-intro-callouts (#2729): self-review #5416 — o playbook
    // (orchestrator-stage-4.md §4c.2) documenta este check como WARN-ONLY,
    // mas o modo `--check stacked-intro-callouts` (main() abaixo) sempre
    // `process.exit(1)` quando `!result.ok` — comportamento GATE-BLOCKING na
    // prática. A severity aqui espelha o comportamento REAL (exit code), não
    // a prosa do playbook — discrepância pré-existente, fora do escopo desta
    // issue (não alterada aqui; sinalizada no PR #5416 para triagem futura).
    runCheckSafely(push, "stacked-intro-callouts", "#2729", "gate-blocking", () =>
      lintStackedIntroCallouts(md),
    );

    runCheckSafely(push, "orphan-box-in-gap", "#3204", "gate-blocking", () => {
      const calloutPlacement = lintCalloutPlacement(md);
      const orphanGaps = findOrphanBoxWarnings(md);
      const orphanOk = calloutPlacement.ok && orphanGaps.length === 0;
      return { ok: orphanOk, calloutPlacement, orphanGaps };
    });

    runCheckSafely(push, "no-xml-artifacts", "#4077", "gate-blocking", () =>
      checkNoXmlArtifacts(md),
    );

    runCheckSafely(push, "snippet-staleness", "#4076", "warn-only", () =>
      runSnippetStalenessCheck(mdPath, root),
    );
  }

  if (existsSync(snippetPath)) {
    runCheckSafely(push, "agradecimento-hardcoded", "#4359", "warn-only", () => {
      const raw = readFileSync(snippetPath, "utf8");
      return checkAgradecimentoHardcoded(raw);
    });
  } else {
    // Mesmo espírito do resto do arquivo: snippet ausente não é violação —
    // o box de agradecimento é opcional (#4359).
    push("agradecimento-hardcoded", "#4359", "warn-only", true, {
      skipped: `snippet não encontrado: ${snippetPath}`,
    });
  }

  const passed = checks.every((c) => c.severity !== "gate-blocking" || c.ok);
  return { stage: 4, passed, checks };
}

/**
 * Roda os checks de `.claude/agents/orchestrator-stage-2.md` §2b sobre
 * `{editionDir}/_internal/02-draft.md` numa única chamada. Diferente do
 * Stage 4 (que roda 1x pré-gate), estes checks alimentam um loop de retry
 * (exit 1 → re-disparar o writer) no orchestrator — o agregador só empacota
 * o veredito de cada check; a decisão de re-disparo continua no playbook.
 */
export function runStage2LintReport(editionDir: string, root: string): StageLintReport {
  const mdPath = resolve(editionDir, "_internal", "02-draft.md");
  const approvedPath = resolve(editionDir, "_internal", "01-approved-capped.json");

  const checks: StageCheckResult[] = [];
  const push = (
    id: string,
    sourceIssue: string,
    severity: StageCheckSeverity,
    ok: boolean,
    result: unknown,
  ) => {
    checks.push({ id, source_issue: sourceIssue, severity, ok, result });
  };

  if (!existsSync(mdPath)) {
    push("md-exists", "#5416", "gate-blocking", false, {
      error: `arquivo não encontrado: ${mdPath}`,
    });
    return { stage: 2, passed: false, checks };
  }
  const md = readFileSync(mdPath, "utf8");

  if (!existsSync(approvedPath)) {
    push("url-bucket", "#165", "gate-blocking", false, {
      error: `01-approved-capped.json não encontrado: ${approvedPath}`,
    });
    push("section-counts", "#907", "gate-blocking", false, {
      error: `01-approved-capped.json não encontrado: ${approvedPath}`,
    });
  } else {
    // JSON.parse pode lançar (arquivo presente mas malformado) — isolado à
    // parte de runCheckSafely porque os DOIS checks abaixo (url-bucket e
    // section-counts) dependem do mesmo parse; uma falha aqui precisa
    // reportar os dois como gate-blocking, não só engolir o 1º.
    let approved: ApprovedJson | undefined;
    try {
      approved = JSON.parse(readFileSync(approvedPath, "utf8")) as ApprovedJson;
    } catch (err) {
      const message = `exceção não tratada ao ler/parsear ${approvedPath}: ${err instanceof Error ? err.message : String(err)}`;
      push("url-bucket", "#165", "gate-blocking", false, { error: message });
      push("section-counts", "#907", "gate-blocking", false, { error: message });
    }

    if (approved) {
      runCheckSafely(push, "url-bucket", "#165", "gate-blocking", () => {
        const urlBucket = lintNewsletter(md, approved!);
        const coverage = checkCoverageLine(md);
        if (!coverage.ok) {
          urlBucket.errors.push({
            section: "coverage_line",
            expected_bucket: "radar",
            url: "",
            line: 1,
            found_in_bucket: "missing",
            title: coverage.firstLine.slice(0, 80),
          });
          urlBucket.ok = false;
        }
        return urlBucket;
      });

      runCheckSafely(push, "section-counts", "#907", "gate-blocking", () =>
        checkSectionCounts(md, approved!),
      );
    }
  }

  runCheckSafely(push, "destaque-min-chars", "#914", "gate-blocking", () =>
    checkDestaqueMinChars(md),
  );

  runCheckSafely(push, "destaque-max-chars", "#964", "gate-blocking", () =>
    checkDestaqueMaxChars(md),
  );

  runCheckSafely(push, "why-matters-length", "#3993", "gate-blocking", () =>
    checkWhyMattersLength(md),
  );

  runCheckSafely(push, "aprofunde-format", "#3920", "gate-blocking", () =>
    checkAprofundeFormat(md),
  );

  const passed = checks.every((c) => c.severity !== "gate-blocking" || c.ok);
  return { stage: 2, passed, checks };
}

// #5895: handlers CLI extraídos pra scripts/lib/lint-checks/cli/ (motion puro).
import { runCli as run_titlesPerHighlight } from "./lib/lint-checks/cli/titles-per-highlight.ts";
import { runCli as run_titleLength } from "./lib/lint-checks/cli/title-length.ts";
import { runCli as run_whyMattersFormat } from "./lib/lint-checks/cli/why-matters-format.ts";
import { runCli as run_eaiSection } from "./lib/lint-checks/cli/eai-section.ts";
import { runCli as run_eiaAnswer } from "./lib/lint-checks/cli/eia-answer.ts";
import { runCli as run_intentionalErrorFlagged } from "./lib/lint-checks/cli/intentional-error-flagged.ts";
import { runCli as run_erroIntencionalPlaceholder } from "./lib/lint-checks/cli/erro-intencional-placeholder.ts";
import { runCli as run_erroIntencionalNarrativeGenerico } from "./lib/lint-checks/cli/erro-intencional-narrative-generico.ts";
import { runCli as run_destaqueMinChars } from "./lib/lint-checks/cli/destaque-min-chars.ts";
import { runCli as run_destaqueMaxChars } from "./lib/lint-checks/cli/destaque-max-chars.ts";
import { runCli as run_whyMattersLength } from "./lib/lint-checks/cli/why-matters-length.ts";
import { runCli as run_sectionItemFormat } from "./lib/lint-checks/cli/section-item-format.ts";
import { runCli as run_sectionCounts } from "./lib/lint-checks/cli/section-counts.ts";
import { runCli as run_introCount } from "./lib/lint-checks/cli/intro-count.ts";
import { runCli as run_coverageLineFormat } from "./lib/lint-checks/cli/coverage-line-format.ts";
import { runCli as run_multilineLinks } from "./lib/lint-checks/cli/multiline-links.ts";
import { runCli as run_relativeTime } from "./lib/lint-checks/cli/relative-time.ts";
import { runCli as run_useMelhorTempo } from "./lib/lint-checks/cli/use-melhor-tempo.ts";
import { runCli as run_secondaryItemsHaveSummary } from "./lib/lint-checks/cli/secondary-items-have-summary.ts";
import { runCli as run_secondaryItemCoherence } from "./lib/lint-checks/cli/secondary-item-coherence.ts";
import { runCli as run_titlePublisherSuffix } from "./lib/lint-checks/cli/title-publisher-suffix.ts";
import { runCli as run_titleTrailingPeriod } from "./lib/lint-checks/cli/title-trailing-period.ts";
import { runCli as run_titleMentionsIa } from "./lib/lint-checks/cli/title-mentions-ia.ts";
import { runCli as run_titleClickbaitVulgar } from "./lib/lint-checks/cli/title-clickbait-vulgar.ts";
import { runCli as run_noTrailingEllipsis } from "./lib/lint-checks/cli/no-trailing-ellipsis.ts";
import { runCli as run_midSentenceEllipsis } from "./lib/lint-checks/cli/mid-sentence-ellipsis.ts";
import { runCli as run_noUntranslatedSummary } from "./lib/lint-checks/cli/no-untranslated-summary.ts";
import { runCli as run_videoLinksAreYoutube } from "./lib/lint-checks/cli/video-links-are-youtube.ts";
import { runCli as run_sectionLinksResolve } from "./lib/lint-checks/cli/section-links-resolve.ts";
import { runCli as run_aprofundeFormat } from "./lib/lint-checks/cli/aprofunde-format.ts";
import { runCli as run_calloutPlacement } from "./lib/lint-checks/cli/callout-placement.ts";
import { runCli as run_stackedIntroCallouts } from "./lib/lint-checks/cli/stacked-intro-callouts.ts";
import { runCli as run_orphanBoxInGap } from "./lib/lint-checks/cli/orphan-box-in-gap.ts";
import { runCli as run_noXmlArtifacts } from "./lib/lint-checks/cli/no-xml-artifacts.ts";
import { runCli as run_snippetStaleness } from "./lib/lint-checks/cli/snippet-staleness.ts";
import { runCli as run_agradecimentoHardcoded } from "./lib/lint-checks/cli/agradecimento-hardcoded.ts";

// Dispatch table (#5895) — cada entrada é o handler CLI extraído pra
// scripts/lib/lint-checks/cli/{check-name}.ts (motion puro de main(), ver
// docstring de cada arquivo). Substitui os ~34 blocos
// `if (args.check === "X") { ... }` que existiam aqui antes.
const CHECK_HANDLERS: Record<string, (args: Record<string, string>, root: string) => void> = {
  "titles-per-highlight": run_titlesPerHighlight,
  "title-length": run_titleLength,
  "why-matters-format": run_whyMattersFormat,
  "eai-section": run_eaiSection,
  "eia-answer": run_eiaAnswer,
  "intentional-error-flagged": run_intentionalErrorFlagged,
  "erro-intencional-placeholder": run_erroIntencionalPlaceholder,
  "erro-intencional-narrative-generico": run_erroIntencionalNarrativeGenerico,
  "destaque-min-chars": run_destaqueMinChars,
  "destaque-max-chars": run_destaqueMaxChars,
  "why-matters-length": run_whyMattersLength,
  "section-item-format": run_sectionItemFormat,
  "section-counts": run_sectionCounts,
  "intro-count": run_introCount,
  "coverage-line-format": run_coverageLineFormat,
  "multiline-links": run_multilineLinks,
  "relative-time": run_relativeTime,
  "use-melhor-tempo": run_useMelhorTempo,
  "secondary-items-have-summary": run_secondaryItemsHaveSummary,
  "secondary-item-coherence": run_secondaryItemCoherence,
  "title-publisher-suffix": run_titlePublisherSuffix,
  "title-trailing-period": run_titleTrailingPeriod,
  "title-mentions-ia": run_titleMentionsIa,
  "title-clickbait-vulgar": run_titleClickbaitVulgar,
  "no-trailing-ellipsis": run_noTrailingEllipsis,
  "mid-sentence-ellipsis": run_midSentenceEllipsis,
  "no-untranslated-summary": run_noUntranslatedSummary,
  "video-links-are-youtube": run_videoLinksAreYoutube,
  "section-links-resolve": run_sectionLinksResolve,
  "aprofunde-format": run_aprofundeFormat,
  "callout-placement": run_calloutPlacement,
  "stacked-intro-callouts": run_stackedIntroCallouts,
  "orphan-box-in-gap": run_orphanBoxInGap,
  "no-xml-artifacts": run_noXmlArtifacts,
  "snippet-staleness": run_snippetStaleness,
  "agradecimento-hardcoded": run_agradecimentoHardcoded,
};

function main(): void {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsedArgs = parseCliArgs(process.argv.slice(2));
  const args = parsedArgs.values;

  // Modo --stage <2|4> --json (#5416) — agregador em lote, ver docstring de
  // runStage2LintReport/runStage4LintReport acima. Aditivo: não interfere
  // com nenhum modo --check abaixo (chave nova, `--json` nunca usado por eles).
  if (parsedArgs.flags.has("json") && (args.stage === "2" || args.stage === "4")) {
    if (!args["edition-dir"]) {
      console.error(
        "Uso: lint-newsletter-md.ts --stage <2|4> --json --edition-dir <edition-dir-path>",
      );
      process.exit(2);
    }
    const editionDir = resolve(ROOT, args["edition-dir"]);
    const report =
      args.stage === "4"
        ? runStage4LintReport(editionDir, ROOT)
        : runStage2LintReport(editionDir, ROOT);
    console.log(JSON.stringify(report, null, 2));
    const failing = report.checks.filter((c) => !c.ok);
    console.error(`\n=== lint-newsletter-md --stage ${args.stage} --json ===`);
    console.error(
      `Checks: ${report.checks.length} (${failing.length} com violação, ${failing.filter((c) => c.severity === "gate-blocking").length} gate-blocking)`,
    );
    for (const c of failing) {
      const tag = c.severity === "gate-blocking" ? "❌" : "⚠️";
      console.error(`  ${tag} [${c.id}/${c.source_issue}] severity=${c.severity}`);
    }
    process.exit(report.passed ? 0 : 1);
  }

  // Dispatch table (#5895) — ver CHECK_HANDLERS acima.
  if (args.check && CHECK_HANDLERS[args.check]) {
    CHECK_HANDLERS[args.check](args, ROOT);
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
        "  ou: lint-newsletter-md.ts --check why-matters-length --md <md-path>\n" +
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
        "  ou: lint-newsletter-md.ts --check orphan-box-in-gap --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check aprofunde-format --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check no-xml-artifacts --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check snippet-staleness --md <md-path>\n" +
        "  ou: lint-newsletter-md.ts --check agradecimento-hardcoded [--snippet <path>]",
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
      // #5757: duplicata de bucket em 01-approved.json — mensagem dedicada
      // (não é "seção errada", é a mesma URL reivindicada por >1 bucket).
      if (e.found_in_bucket === "duplicate") {
        console.error(
          `  ${e.url}${titleHint}\n    URL presente em MÚLTIPLOS buckets de 01-approved.json: ${(e.duplicate_buckets ?? []).join(", ")} — remover a(s) entrada(s) do(s) bucket(s) que não deveria(m) mais conter o artigo.`,
        );
        continue;
      }
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
