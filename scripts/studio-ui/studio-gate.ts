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
 *     (`highlights[n].title`, ou `highlights[n].article.title` no formato
 *     aninhado — mesmo fallback duplo de `url-bucket.ts`, #4c.1) +
 *     `countTitlesPerHighlight` sobre `02-reviewed.md` (mesmo parser de
 *     `titles-per-highlight`, #178).
 *   - URL do WhatsApp / sugestão de meta description: `_internal/
 *     stage4-capture-state.json` (§4c.1b/§4c.1c, #5414).
 *   - Fact-check: `_internal/fact-check.json` (resultado) e `_internal/
 *     fact-check-autofix.json` (correções automáticas aplicadas, §4c.6/6b).
 *   - Boxes de divulgação: `_internal/box-selection.json` (§4c.7, #4626).
 *   - Avisos de render: `_internal/render-warnings.json` (§4c.2, #4673).
 *   - Lints: `runReviewLints` (studio-review.ts) sobre `reviewed` e
 *     `social` — estendido nesta mesma issue (achado 4) pra incluir
 *     `validate-domain-diversity.ts` e `validate-lancamentos.ts` também
 *     pós-escrita, além do `intentional-error-flagged` (este último já é
 *     GATE-BLOCKING no gate real também — orchestrator-stage-4.md §4c.2
 *     roda os dois como backstop quando o Stage 2 pulou a declaração; não é
 *     um check "adiantado" do Stage 5, é o mesmo backstop, só antes).
 *
 * Fail-soft por campo: um arquivo ausente/corrompido nunca lança — vira
 * `{ available: false, note }` (mensagem clara pro editor, nunca um painel
 * quebrado). Edição antiga/retomada de checkpoint anterior a algum desses
 * arquivos existir é o caso normal, não um bug. Os 4 estados `Gate*State`
 * abaixo são discriminated unions por `available` — TypeScript não deixa ler
 * `summary`/`slots`/`events` sem antes narrowar em `available === true`,
 * então um arquivo com shape inesperado (JSON válido mas campo faltando)
 * não pode silenciosamente virar "0 problemas, tudo ok" em algum consumidor
 * futuro (achado de review #6449: `factCheck.summary?.attention_items ?? 0`
 * SEM checar `available` antes seria exatamente esse bug).
 *
 * Erros de leitura são logados (nunca engolidos em silêncio) e distinguidos
 * por classe: `ENOENT` (arquivo ausente — caso normal, sem log) vs. outro
 * erro de FS real (`EACCES`/`EPERM`/lock do OneDrive — logado via
 * `console.error`, mesmo padrão de `stage4-capture-state.ts`) vs. JSON
 * corrompido (logado, degrada). Nenhuma dessas 3 classes lança.
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

/**
 * Lê e faz `JSON.parse` de `path`, distinguindo as 3 classes de resultado
 * possíveis (nunca lança):
 *   - arquivo ausente (`ENOENT`) → `null`, silencioso (caso normal — stage
 *     que gera esse arquivo ainda não rodou nesta edição);
 *   - erro de FS real (`EACCES`/`EPERM`/`EISDIR`/lock do OneDrive) → `null`,
 *     mas logado via `console.error` (mesmo padrão de
 *     `readStage4CaptureState`) — é um problema operacional, não "ainda não
 *     rodou", e silenciá-lo faria o painel mostrar a mensagem errada;
 *   - JSON corrompido/mid-write → `null`, logado.
 */
function readJsonFile<T>(path: string): T | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`studio-gate: falha ao ler ${path}: ${(err as Error).message} — tratando como indisponível`);
    }
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`studio-gate: JSON inválido em ${path}: ${(err as Error).message} — tratando como indisponível`);
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
   * `highlights[n-1].title` (ou `.article.title` no formato aninhado) —
   * `null` quando `01-approved.json` está ausente ou o índice não existe. */
  originalTitle: string | null;
  /** Título final escolhido — só presente quando `titleCount === 1` (poda já
   * feita); `null` enquanto houver mais de 1 opção. */
  finalTitle: string | null;
  /** Quantas opções de título ainda estão em `02-reviewed.md` pra este
   * destaque — `null` = destaque não encontrado no MD. */
  titleCount: number | null;
  /** Equivalente a `titleCount === 1` — campo derivado, não uma fonte de
   * verdade adicional (mantido por conveniência de leitura no client). */
  resolved: boolean;
}

// #6449 review: os 4 estados abaixo são discriminated unions por
// `available` — o branch `false` SEMPRE carrega `note`, o branch `true`
// SEMPRE carrega o(s) payload(s). Isso torna ilegal em tempo de compilação
// ler `summary`/`slots`/`events` sem antes narrowar em `available`, o que
// evita a classe de bug "arquivo com shape inesperado passa por available:
// true com payload undefined, e um `?? 0` em algum lugar lê isso como '0
// problemas'".
export type GateFactCheckState =
  | { available: true; summary: FactCheckResult["summary"] }
  | { available: false; note: string };

export type GateFactCheckAutofixState =
  | { available: true; summary: AutofixResult["summary"]; socialModified: boolean }
  | { available: false; note: string };

export type GateBoxSelectionState =
  | { available: true; slots: SlotSelectionRecord[] }
  | { available: false; note: string };

export type GateRenderWarningsState =
  | { available: true; events: RenderWarningEvent[] }
  | { available: false; note: string };

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

/** `countTitlesPerHighlight` é usado sem guard em todo outro call site
 * (sempre dentro de `runCheck`, que tem seu próprio try/catch — ver
 * `studio-review.ts`). Aqui é chamado direto, fora de `runCheck`, então
 * precisa do próprio try/catch pra honrar o "fail-soft por campo" que o
 * docstring do módulo promete — uma falha aqui não deveria derrubar
 * fact-check/lints/boxes junto (#6449 review). */
function safeCountTitlesPerHighlight(md: string): ReturnType<typeof countTitlesPerHighlight> | null {
  if (!md) return null;
  try {
    return countTitlesPerHighlight(md);
  } catch (err) {
    console.error(`studio-gate: countTitlesPerHighlight falhou: ${(err as Error).message} — títulos indisponíveis`);
    return null;
  }
}

function buildHighlightTitles(editionDir: string): GateHighlightTitle[] {
  const approved = readJsonFile<ApprovedJson>(resolve(editionDir, "_internal", "01-approved.json"));
  const md = readReviewedMd(editionDir);
  const titleReport = safeCountTitlesPerHighlight(md);

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
  if (!result || typeof result.summary !== "object" || result.summary === null) {
    return { available: false, note: "fact-check.json indisponível — rode o fact-checker (§4c.6) antes de aprovar." };
  }
  return { available: true, summary: result.summary };
}

function buildFactCheckAutofix(editionDir: string): GateFactCheckAutofixState {
  const result = readJsonFile<AutofixResult>(resolve(editionDir, "_internal", "fact-check-autofix.json"));
  if (!result || typeof result.summary !== "object" || result.summary === null) {
    return { available: false, note: "fact-check-autofix.json indisponível — nenhuma correção automática registrada ainda." };
  }
  return { available: true, summary: result.summary, socialModified: result.social_modified === true };
}

function buildBoxSelection(editionDir: string): GateBoxSelectionState {
  const slots = readJsonFile<SlotSelectionRecord[]>(resolve(editionDir, "_internal", "box-selection.json"));
  if (!Array.isArray(slots)) {
    return { available: false, note: "box-selection.json indisponível — edição retomada de checkpoint anterior ao #4626, ou Stage 2 ainda não rodou." };
  }
  return { available: true, slots };
}

function buildRenderWarnings(editionDir: string): GateRenderWarningsState {
  const parsed = readJsonFile<{ generated_at?: string; warnings?: RenderWarningEvent[] }>(
    resolve(editionDir, "_internal", "render-warnings.json"),
  );
  if (!parsed || !Array.isArray(parsed.warnings)) {
    return { available: false, note: "render-warnings.json indisponível — pré-render (§4b) ainda não rodou nesta edição." };
  }
  return { available: true, events: parsed.warnings };
}

/** `runReviewLints` roda checks individuais fail-soft (`runCheck`), mas não
 * tem um try/catch próprio ao redor de si mesma — uma exceção fora do laço
 * de checks (ex: leitura de `01-approved.json` malformada dentro de um
 * check não coberto por `runCheck`) não deveria derrubar o resumo do Gate
 * inteiro. Degrada pro mesmo shape de "sem lints aplicáveis" com uma nota
 * explicando o que houve (#6449 review). */
function safeRunReviewLints(
  rootDir: string,
  editionDir: string,
  slug: "reviewed" | "social",
  content: string,
): LintReport {
  try {
    return runReviewLints(rootDir, editionDir, slug, content);
  } catch (err) {
    console.error(`studio-gate: runReviewLints(${slug}) falhou: ${(err as Error).message}`);
    return {
      ok: false,
      checks: [],
      skipped: [],
      note: `Lints indisponíveis (erro inesperado ao rodar): ${(err as Error).message}`,
    };
  }
}

/** Conta quantos checks BLOQUEANTES falharam num `LintReport` (mesma
 * definição de "bloqueia o gate" já usada pelo agregador `lint-newsletter-md.ts
 * --stage 4 --json`: `severity: gate-blocking` com `ok:false`). `runCheck`
 * (studio-review.ts) já seta `ok: false` no branch `crashed`, então checar
 * só `!c.ok` já cobre os dois casos — sem precisar de `|| c.crashed`. */
function countBlockingFailures(report: LintReport): number {
  return report.checks.filter((c) => c.blocking && !c.ok).length;
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

  const factCheckOk = factCheck.available && factCheck.summary.attention_items === 0;
  const factCheckDetail = !factCheck.available
    ? factCheck.note
    : factCheckOk
    ? ""
    : `${factCheck.summary.attention_items} claim(s) pedindo atenção`;

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
    // `ok: false` é setado direto aqui (não derivado de `checklist.every(...)`,
    // que daria `true` vacuamente sobre um array vazio) — de propósito: uma
    // edição inexistente nunca é "pronta pra aprovar". Se este branch algum
    // dia for "simplificado" pra reusar a mesma derivação do branch principal
    // abaixo, o significado inverte silenciosamente (#6449 review).
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
      renderWarnings: { available: false, note: "edição não encontrada" },
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
  const lintReviewed = safeRunReviewLints(rootDir, editionDir, "reviewed", readReviewedMd(editionDir));
  const lintSocial = safeRunReviewLints(rootDir, editionDir, "social", readSocialMd(editionDir));
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
