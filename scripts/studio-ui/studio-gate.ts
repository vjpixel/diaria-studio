/**
 * studio-gate.ts (#6447 Fatia 1)
 *
 * Painel "Gate" do Studio — o resumo consolidado que hoje só existe no CHAT
 * (`orchestrator-stage-4.md` §4c/§4d) espelhado no painel de revisão, pra
 * permitir revisar/aprovar o Stage 4 sem abrir o terminal (achados 5 + 8 do
 * #6447). **Só leitura de JSON/MD já em disco — nenhuma chamada de LLM, nada
 * gerado aqui.** Cada campo é derivado de um arquivo que a pipeline REAL já
 * escreve nesses passos do orchestrator:
 *
 *   - Títulos original vs. final por destaque: `_internal/01-approved.json`
 *     (`highlights[n].title`, #4c.1) + `countTitlesPerHighlight` sobre
 *     `02-reviewed.md` (mesmo parser de `titles-per-highlight`, #178).
 *   - URL do WhatsApp / sugestão de meta description: `_internal/
 *     stage4-capture-state.json` (§4c.1b/§4c.1c, #5414).
 *   - Fact-check: `_internal/fact-check.json` (resultado) e `_internal/
 *     fact-check-autofix.json` (correções automáticas aplicadas, §4c.6/6b).
 *   - Boxes de divulgação: `_internal/box-selection.json` (§4c.7, #4626).
 *   - Avisos de render: `_internal/render-warnings.json` (§4c.2, #4673).
 *   - Lints: `runReviewLints` (studio-review.ts) sobre `reviewed` e
 *     `social` — estendido nesta mesma issue (achado 4) pra incluir
 *     `validate-domain-diversity.ts` e `validate-lancamentos.ts` também
 *     pós-escrita, além do `intentional-error-flagged`.
 *
 * Fail-soft por campo: um arquivo ausente/corrompido nunca lança — vira
 * `{ available: false, note }` (mensagem clara pro editor, nunca um painel
 * quebrado). Edição antiga/retomada de checkpoint anterior a algum desses
 * arquivos existir é o caso normal, não um bug.
 *
 * Fora de escopo desta fatia (ver corpo do PR): editor por destaque (fatia
 * 2), seleção de título por clique (fatia 2), split view reativo (fatia 3),
 * ações rápidas/aprovar-pelo-painel/galeria de imagens (fatia 4).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveEditionDir } from "../lib/find-current-edition.ts";
import { readStage4CaptureState, type Stage4CaptureState } from "../lib/stage4-capture-state.ts";
import { countTitlesPerHighlight } from "../lint-newsletter-md.ts";
import type { ApprovedJson } from "../lib/lint-checks/url-bucket.ts";
import type { FactCheckResult } from "../run-fact-checker.ts";
import type { AutofixResult } from "../apply-factcheck-autofix.ts";
import type { SlotSelectionRecord } from "../select-boxes-by-clicks.ts";
import type { RenderWarningEvent } from "../lib/newsletter-render-html.ts";
import { runReviewLints, type LintReport } from "./studio-review.ts";

// ── Leituras individuais de arquivo — cada uma fail-soft ───────────────────

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export interface GateHighlightTitle {
  n: 1 | 2 | 3;
  /** Categoria do destaque (LANÇAMENTO/PESQUISA/etc), lida do header do
   * DESTAQUE em `02-reviewed.md` via `countTitlesPerHighlight` — `null`
   * quando o destaque `n` não existe ainda (edição com 2 destaques, #3369). */
  category: string | null;
  /** Título original (categorizado/fonte), de `01-approved.json` →
   * `highlights[n-1].title` — `null` quando `01-approved.json` está ausente
   * ou o índice não existe. */
  originalTitle: string | null;
  /** Título final escolhido — só presente quando `titleCount === 1` (poda já
   * feita); `null` enquanto houver mais de 1 opção. */
  finalTitle: string | null;
  /** Quantas opções de título ainda estão em `02-reviewed.md` pra este
   * destaque — `null` = destaque não encontrado no MD. */
  titleCount: number | null;
  resolved: boolean;
}

export interface GateFactCheckState {
  available: boolean;
  summary?: FactCheckResult["summary"];
  note?: string;
}

export interface GateFactCheckAutofixState {
  available: boolean;
  summary?: AutofixResult["summary"];
  socialModified?: boolean;
  note?: string;
}

export interface GateBoxSelectionState {
  available: boolean;
  slots?: SlotSelectionRecord[];
  note?: string;
}

export interface GateRenderWarningsState {
  available: boolean;
  events: RenderWarningEvent[];
  note?: string;
}

export interface GateChecklistItem {
  id: string;
  label: string;
  ok: boolean;
  /** Detalhe legível pro editor — sempre presente quando `ok === false`,
   * omitido (string vazia) quando não há nada a acrescentar ao `label`. */
  detail: string;
}

export interface GateSummary {
  ok: boolean; // agregado: true quando TODO item do checklist está ok
  aammdd: string;
  editionExists: boolean;
  highlights: GateHighlightTitle[];
  whatsappUrl: string | null;
  metaDescriptionSuggestion: string | null;
  factCheck: GateFactCheckState;
  factCheckAutofix: GateFactCheckAutofixState;
  boxSelection: GateBoxSelectionState;
  renderWarnings: GateRenderWarningsState;
  lintReviewed: LintReport;
  lintSocial: LintReport;
  checklist: GateChecklistItem[];
}

function readReviewedMd(editionDir: string): string {
  const p = resolve(editionDir, "02-reviewed.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function readSocialMd(editionDir: string): string {
  const p = resolve(editionDir, "03-social.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

function buildHighlightTitles(editionDir: string): GateHighlightTitle[] {
  const approved = readJsonFile<ApprovedJson>(resolve(editionDir, "_internal", "01-approved.json"));
  const md = readReviewedMd(editionDir);
  const titleReport = md ? countTitlesPerHighlight(md) : null;

  const highlights: GateHighlightTitle[] = [];
  for (let n = 1; n <= 3; n++) {
    const destaqueEntry = titleReport?.destaques.find((d) => d.destaque === n) ?? null;
    const approvedEntry = approved?.highlights?.[n - 1] ?? null;
    const originalTitle = approvedEntry?.title ?? approvedEntry?.article?.title ?? null;
    const titleCount = destaqueEntry ? destaqueEntry.title_count : null;
    const finalTitle = destaqueEntry && destaqueEntry.title_count === 1 ? destaqueEntry.titles[0] : null;
    // Destaque `n` "não existe" quando nem o approved.json nem o MD têm nada
    // pra ele — edições com 2 destaques (#3369) legitimamente não têm D3.
    if (!destaqueEntry && !approvedEntry) continue;
    highlights.push({
      n: n as 1 | 2 | 3,
      category: destaqueEntry?.category ?? null,
      originalTitle,
      finalTitle,
      titleCount,
      resolved: titleCount === 1,
    });
  }
  return highlights;
}

function buildFactCheck(editionDir: string): GateFactCheckState {
  const result = readJsonFile<FactCheckResult>(resolve(editionDir, "_internal", "fact-check.json"));
  if (!result) {
    return { available: false, note: "fact-check.json indisponível — rode o fact-checker (§4c.6) antes de aprovar." };
  }
  return { available: true, summary: result.summary };
}

function buildFactCheckAutofix(editionDir: string): GateFactCheckAutofixState {
  const result = readJsonFile<AutofixResult>(resolve(editionDir, "_internal", "fact-check-autofix.json"));
  if (!result) {
    return { available: false, note: "fact-check-autofix.json indisponível — nenhuma correção automática registrada ainda." };
  }
  return { available: true, summary: result.summary, socialModified: result.social_modified };
}

function buildBoxSelection(editionDir: string): GateBoxSelectionState {
  const slots = readJsonFile<SlotSelectionRecord[]>(resolve(editionDir, "_internal", "box-selection.json"));
  if (!slots) {
    return { available: false, note: "box-selection.json indisponível — edição retomada de checkpoint anterior ao #4626, ou Stage 2 ainda não rodou." };
  }
  return { available: true, slots };
}

function buildRenderWarnings(editionDir: string): GateRenderWarningsState {
  const parsed = readJsonFile<{ generated_at?: string; warnings?: RenderWarningEvent[] }>(
    resolve(editionDir, "_internal", "render-warnings.json"),
  );
  if (!parsed) {
    return { available: false, events: [], note: "render-warnings.json indisponível — pré-render (§4b) ainda não rodou nesta edição." };
  }
  return { available: true, events: parsed.warnings ?? [] };
}

/** Conta quantos checks BLOQUEANTES falharam num `LintReport` (mesma
 * definição de "bloqueia o gate" já usada pelo agregador `lint-newsletter-md.ts
 * --stage 4 --json`: `severity: gate-blocking` com `ok:false`, ou crash). */
function countBlockingFailures(report: LintReport): number {
  return report.checks.filter((c) => c.blocking && (!c.ok || c.crashed)).length;
}

function buildChecklist(
  highlights: GateHighlightTitle[],
  lintReviewed: LintReport,
  lintSocial: LintReport,
  factCheck: GateFactCheckState,
): GateChecklistItem[] {
  const unresolved = highlights.filter((h) => !h.resolved);
  const titlesOk = unresolved.length === 0;
  const titlesDetail = titlesOk
    ? ""
    : unresolved
        .map((h) => `D${h.n} ainda com ${h.titleCount ?? "?"} título(s) sem escolha`)
        .join("; ");

  const violations = countBlockingFailures(lintReviewed) + countBlockingFailures(lintSocial);
  const violationsOk = violations === 0;

  const factCheckOk = factCheck.available && (factCheck.summary?.attention_items ?? 0) === 0;
  const factCheckDetail = !factCheck.available
    ? factCheck.note ?? "fact-check indisponível"
    : factCheckOk
    ? ""
    : `${factCheck.summary?.attention_items ?? 0} claim(s) pedindo atenção`;

  return [
    {
      id: "titles-per-highlight",
      label: "1 título escolhido por destaque",
      ok: titlesOk,
      detail: titlesDetail,
    },
    {
      id: "lint-violations",
      label: "Sem violations bloqueantes",
      ok: violationsOk,
      detail: violationsOk ? "" : `${violations} violation(ões) bloqueante(s) aberta(s)`,
    },
    {
      id: "fact-check",
      label: "Fact-check ok",
      ok: factCheckOk,
      detail: factCheckDetail,
    },
  ];
}

/** Constrói o resumo completo do painel Gate pra `aammdd`. `rootDir` é a
 * raiz do projeto (mesmo parâmetro de `resolveReviewFile`/`readReviewFile`
 * em studio-review.ts) — resolve `data/editions/{aammdd}` por baixo. */
export function buildGateSummary(rootDir: string, aammdd: string): GateSummary {
  const editionsRootAbs = resolve(rootDir, "data", "editions");
  const editionDir = resolveEditionDir(editionsRootAbs, aammdd);
  const editionExists = existsSync(editionDir);

  if (!editionExists) {
    return {
      ok: false,
      aammdd,
      editionExists: false,
      highlights: [],
      whatsappUrl: null,
      metaDescriptionSuggestion: null,
      factCheck: { available: false, note: "edição não encontrada" },
      factCheckAutofix: { available: false, note: "edição não encontrada" },
      boxSelection: { available: false, note: "edição não encontrada" },
      renderWarnings: { available: false, events: [], note: "edição não encontrada" },
      lintReviewed: { ok: true, checks: [], skipped: [] },
      lintSocial: { ok: true, checks: [], skipped: [] },
      checklist: [],
    };
  }

  const highlights = buildHighlightTitles(editionDir);
  const captureState: Stage4CaptureState = readStage4CaptureState(editionDir);
  const factCheck = buildFactCheck(editionDir);
  const factCheckAutofix = buildFactCheckAutofix(editionDir);
  const boxSelection = buildBoxSelection(editionDir);
  const renderWarnings = buildRenderWarnings(editionDir);
  const lintReviewed = runReviewLints(rootDir, editionDir, "reviewed", readReviewedMd(editionDir));
  const lintSocial = runReviewLints(rootDir, editionDir, "social", readSocialMd(editionDir));
  const checklist = buildChecklist(highlights, lintReviewed, lintSocial, factCheck);

  return {
    ok: checklist.every((c) => c.ok),
    aammdd,
    editionExists: true,
    highlights,
    whatsappUrl: captureState.whatsappUrl,
    metaDescriptionSuggestion: captureState.metaDescriptionSuggestion,
    factCheck,
    factCheckAutofix,
    boxSelection,
    renderWarnings,
    lintReviewed,
    lintSocial,
    checklist,
  };
}
