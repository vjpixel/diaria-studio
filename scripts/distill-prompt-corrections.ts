#!/usr/bin/env tsx
/**
 * scripts/distill-prompt-corrections.ts (#7981, Camada 3 da #7972 — Fase 7:
 * destilação de prompt de geração de texto)
 *
 * Monta o diff candidato de prompt MECANICAMENTE a partir de exemplos
 * concretos já rotulados (`_internal/editor-requests.jsonl`, #4966/#7974)
 * — nunca uma 2ª LLM propondo interpretação livre. Condicionado a
 * `capture-verified` por tipo de pedido (`capture-verified-request-
 * types.ts`) e a uma barra elevada: ≥5 edições DISTINTAS, cobrindo ≥2
 * histórias/URLs diferentes.
 *
 * ## Exceção `length-cut` (precedente #6439)
 *
 * Quando o tipo de pedido é `length-cut` e o backtest mostra repetição do
 * mesmo padrão de overflow, este script propõe um guard MECÂNICO (não um
 * diff de prompt) e roteia pra pista de aprovação B (PR normal de código,
 * auto-merge #5251) — NUNCA pra pista de sign-off editorial. `title-
 * length` recebe o MESMO tratamento estrutural (overflow mensurável via
 * `title_char_count`) mas continua na pista A (sign-off) por decisão
 * literal do texto da issue #7981, que nomeia só `length-cut` na exceção
 * — trade-off registrado, não decidido silenciosamente (ver relatório
 * final da #7972).
 *
 * ## O que este script NÃO faz ainda (escopo desta 1ª versão)
 *
 * Síntese mecânica de diff de prompt só é implementada pros 2 tipos com
 * padrão MENSURÁVEL numericamente (`length-cut`, `title-length` — ambos
 * via contagem de caracteres, sem ambiguidade de interpretação). Pros
 * outros 6 tipos capture-verified (`tone`, `lead-rewrite`, `social-
 * rewrite`, `factual-correction`, `eia-choice`) — texto livre, sem um
 * eixo numérico óbvio — o script produz o PACOTE DE EVIDÊNCIA (mesmo
 * rigor de `calibrate-scoring-weights.ts`/#7990: ≥5 edições, ≥2 histórias,
 * casos nomeados) mas NÃO sintetiza o texto do diff — fica marcado
 * `lane: "evidence-only"`, `accepted: false`, esperando redação humana
 * informada pela evidência. Sintetizar diff de texto livre de forma
 * genuinamente mecânica (sem virar "uma 2ª LLM interpretando") é escopo
 * maior que esta rodada — decisão explícita, não uma lacuna escondida.
 *
 * ## Crítica holística (3x, maioria)
 *
 * Só roda pros candidatos numéricos (`length-cut` NÃO passa por crítica —
 * é proposta de guard mecânico, sem julgamento holístico envolvido;
 * `title-length` passa). Usa `runHolisticCritique`
 * (`lib/holistic-critique.ts`) sobre `callClaudeCli`
 * (`lib/claude-cli-subprocess.ts`, filtragem de ambiente NÃO-NEGOCIÁVEL) —
 * default `dryRun: true` (nunca spawna um `claude` de verdade nem gasta
 * token sem `--live` explícito no CLI).
 *
 * Read-only: nunca escreve em `.claude/agents/*.md`/`context/templates/`.
 * Abrir PR de verdade (draft, `needs-editor-signoff` pra `editorial-
 * signoff`; PR normal pra `mechanical-guard`) é ação de sessão, fora deste
 * script — mesma separação de #7990/REGRA DE OURO.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { enumerateEditionDirs } from "./lib/find-current-edition.ts";
import { isCaptureVerifiedRequestType } from "./lib/capture-verified-request-types.ts";
import { runDistillationBacktest, TITLE_MAX_CHARS, type DistillationBacktestReport } from "./lib/distillation-backtest.ts";
import { evaluateDistillationCadence, type DistillationCadenceState, type DistillationCadenceDecision } from "./lib/distillation-cadence-guard.ts";
import { estimateDistillationCost, type DistillationCostEstimate } from "./lib/distillation-cost-estimate.ts";
import { runHolisticCritique, buildCritiquePrompt, type HolisticCritiqueResult, type CallClaudeCliFn } from "./lib/holistic-critique.ts";
import { callClaudeCli } from "./lib/claude-cli-subprocess.ts";
import type { EditorRequestEntry, RequestType } from "./log-editor-request.ts";
import type { ScoringFeatureRow } from "./lib/scoring-features.ts";

const ROOT = resolve(import.meta.dirname, "..");

export const MIN_DISTINCT_EDITIONS = 5;
export const MIN_DISTINCT_STORIES = 2;
/** Aproximação grosseira chars→tokens (~4 chars/token, convenção comum pra estimativa, nunca contagem exata — a medição real vem do uso reportado pelo `claude --print`). */
const CHARS_PER_TOKEN_ESTIMATE = 4;
const CRITIQUE_OUTPUT_TOKENS_ESTIMATE = 150;

export type DistillationLane = "mechanical-guard" | "editorial-signoff" | "evidence-only";

export interface EvidenceEvent {
  edition: string;
  target: string;
  description: string;
  url: string | null;
}

export interface RequestTypeCandidate {
  requestType: RequestType;
  lane: DistillationLane;
  editions_count: number;
  distinct_stories: number;
  events_missing_url: number;
  sample_events: EvidenceEvent[];
  proposal: string | null;
  critique: HolisticCritiqueResult | null;
  accepted: boolean;
  rejection_reasons: string[];
}

export interface DistillationResult {
  status: "cadence_blocked" | "no_qualifying_pattern" | "candidates_produced";
  cadence: DistillationCadenceDecision;
  backtest: DistillationBacktestReport;
  candidates: RequestTypeCandidate[];
  cost_estimate: DistillationCostEstimate | null;
}

interface RawEvent extends EditorRequestEntry {}

function readAllEditorRequests(editionDirsByAammdd: ReadonlyMap<string, string>): RawEvent[] {
  const events: RawEvent[] = [];
  for (const [, dir] of editionDirsByAammdd) {
    const path = join(dir, "_internal", "editor-requests.jsonl");
    if (!existsSync(path)) continue;
    let content: string;
    try {
      content = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry === "object") events.push(entry as RawEvent);
      } catch {
        // linha malformada — ignorada, mesma tolerância de readEditorRequestsForEditions
      }
    }
  }
  return events;
}

function extractUrl(context: Record<string, unknown> | undefined): string | null {
  const url = context?.url;
  return typeof url === "string" && url !== "" ? url : null;
}

/** Média de excesso de caracteres acima de `TITLE_MAX_CHARS` pros highlights de todo o corpus — `null` se nenhum highlight tiver title_char_count disponível. Reusa scoring-features.json (mesma fonte de `distillation-backtest.ts::title-length-52-chars`), nunca reextrai título. */
function averageTitleOverflow(editionDirsByAammdd: ReadonlyMap<string, string>): number | null {
  const overflows: number[] = [];
  for (const [, dir] of editionDirsByAammdd) {
    const featuresPath = join(dir, "_internal", "scoring-features.json");
    if (!existsSync(featuresPath)) continue;
    try {
      const payload = JSON.parse(readFileSync(featuresPath, "utf8"));
      const rows: ScoringFeatureRow[] = Array.isArray(payload?.rows) ? payload.rows : [];
      for (const r of rows) {
        if (r.bucket === "highlights" && r.title_char_count > TITLE_MAX_CHARS) {
          overflows.push(r.title_char_count - TITLE_MAX_CHARS);
        }
      }
    } catch {
      continue;
    }
  }
  if (overflows.length === 0) return null;
  return overflows.reduce((a, b) => a + b, 0) / overflows.length;
}

export interface RunDistillationOptions {
  cadenceState: DistillationCadenceState;
  nowIso: string;
  /** `true` (default): nunca chama `claude --print` de verdade — crítica holística fica `null` pros candidatos que precisariam dela. `false`: roda a crítica 3x de verdade (custo real, requer `claude` instalado). */
  dryRun?: boolean;
  socialCriticBody?: string;
  callClaudeCliFn?: CallClaudeCliFn;
  rootDir?: string;
}

export function runDistillPromptCorrections(editionsRoot: string, opts: RunDistillationOptions): DistillationResult {
  const cadence = evaluateDistillationCadence(opts.cadenceState, opts.nowIso);
  const rootDir = opts.rootDir ?? ROOT;
  const backtest = runDistillationBacktest(editionsRoot, rootDir);

  if (!cadence.canTrigger) {
    return { status: "cadence_blocked", cadence, backtest, candidates: [], cost_estimate: null };
  }

  const editionDirsByAammdd = enumerateEditionDirs(editionsRoot);
  const allEvents = readAllEditorRequests(editionDirsByAammdd);

  const qualifyingEvents = allEvents.filter(
    (e) => (e.resolution === "accepted" || e.resolution === "partial") && isCaptureVerifiedRequestType(e.request_type),
  );

  const byType = new Map<RequestType, RawEvent[]>();
  for (const e of qualifyingEvents) {
    const list = byType.get(e.request_type) ?? [];
    list.push(e);
    byType.set(e.request_type, list);
  }

  const avgTitleOverflow = byType.has("title-length") ? averageTitleOverflow(editionDirsByAammdd) : null;

  const candidates: RequestTypeCandidate[] = [];
  let anyCritiqueNeeded = false;

  for (const [requestType, events] of byType) {
    const editionsSet = new Set(events.map((e) => e.edition));
    const urls = events.map((e) => extractUrl(e.context)).filter((u): u is string => u !== null);
    const distinctStories = new Set(urls).size;
    const eventsMissingUrl = events.length - urls.length;

    const sampleEvents: EvidenceEvent[] = [...events]
      .sort((a, b) => b.edition.localeCompare(a.edition))
      .slice(0, 5)
      .map((e) => ({ edition: e.edition, target: e.target, description: e.description, url: extractUrl(e.context) }));

    const rejectionReasons: string[] = [];
    if (editionsSet.size < MIN_DISTINCT_EDITIONS) {
      rejectionReasons.push(`só ${editionsSet.size} edições distintas — mínimo ${MIN_DISTINCT_EDITIONS}.`);
    }
    if (distinctStories < MIN_DISTINCT_STORIES) {
      rejectionReasons.push(`só ${distinctStories} história(s)/URL(s) distinta(s) capturada(s) (${eventsMissingUrl} evento(s) sem URL em context — não contam pra este mínimo) — mínimo ${MIN_DISTINCT_STORIES}.`);
    }

    if (rejectionReasons.length > 0) {
      candidates.push({
        requestType,
        lane: "evidence-only",
        editions_count: editionsSet.size,
        distinct_stories: distinctStories,
        events_missing_url: eventsMissingUrl,
        sample_events: sampleEvents,
        proposal: null,
        critique: null,
        accepted: false,
        rejection_reasons: rejectionReasons,
      });
      continue;
    }

    if (requestType === "length-cut") {
      const overflowCheck = backtest.checks.find((c) => c.name === "carousel-text-overflow");
      const proposal =
        `Guard mecânico (NUNCA pista de sign-off editorial — exceção length-cut, precedente #6439): ` +
        `${editionsSet.size} edições com correção length-cut capturada (capture-verified), ` +
        `taxa de overflow medida pelo backtest = ${overflowCheck ? (overflowCheck.violation_rate * 100).toFixed(1) : "n/d"}% ` +
        `de ${overflowCheck?.editions_evaluated ?? 0} edições avaliáveis. Reforçar o guard existente ` +
        `(findOverflowingCarouselSlides/checkCarouselTextOverflow, lib/daily-carousel-card.ts + lib/invariant-checks/stage-4.ts) ` +
        `— ex: baixar o teto de caracteres orientativo no prompt do social-writer, seguindo o mesmo padrão do #6136/#6078 ` +
        `(medição decide o novo teto, não um palpite). Abrir como PR normal de código (auto-merge #5251 após review+CI verdes), ` +
        `nunca como PR de sign-off editorial.`;
      candidates.push({
        requestType,
        lane: "mechanical-guard",
        editions_count: editionsSet.size,
        distinct_stories: distinctStories,
        events_missing_url: eventsMissingUrl,
        sample_events: sampleEvents,
        proposal,
        critique: null, // guard mecânico não passa por crítica holística — não há julgamento de "soa como IA" num script
        accepted: true,
        rejection_reasons: [],
      });
      continue;
    }

    if (requestType === "title-length" && avgTitleOverflow !== null) {
      anyCritiqueNeeded = true;
      const proposedTarget = Math.max(20, TITLE_MAX_CHARS - Math.round(avgTitleOverflow));
      const proposal =
        `Pista de sign-off editorial (muda instrução de geração real): título de destaque medido excede ` +
        `${TITLE_MAX_CHARS} chars em ${avgTitleOverflow.toFixed(1)} chars em média (highlights, todo o corpus disponível). ` +
        `Candidato: apertar o teto ORIENTATIVO no prompt de .claude/agents/writer-destaque.md de "${TITLE_MAX_CHARS} caracteres" ` +
        `pra "${proposedTarget} caracteres" (mesmo padrão de medição-decide-o-teto do #6136 pro carrossel) — o limite ` +
        `MECÂNICO real (${TITLE_MAX_CHARS}) não muda, só o alvo que o prompt pede pro LLM mirar, dando margem real.`;
      const critique = opts.dryRun !== false ? null : runCritiqueForProposal(proposal, opts, rootDir);
      const accepted = opts.dryRun === false ? critique?.consistent === true && critique.majorityPasses === true : false;
      const rejectionReasonsForCritique: string[] = [];
      if (opts.dryRun !== false) rejectionReasonsForCritique.push("dry-run: crítica holística não rodou (precisa --live) — candidato NÃO aceito automaticamente, só a evidência+proposta ficam prontas.");
      else if (!critique?.consistent) rejectionReasonsForCritique.push("crítica holística divergiu entre as 3 rodadas — bloqueio automático, precisa revisão humana.");
      else if (critique.majorityPasses !== true) rejectionReasonsForCritique.push("crítica holística rejeitou o candidato (3/3 concordantes em REJEITA).");

      candidates.push({
        requestType,
        lane: "editorial-signoff",
        editions_count: editionsSet.size,
        distinct_stories: distinctStories,
        events_missing_url: eventsMissingUrl,
        sample_events: sampleEvents,
        proposal,
        critique,
        accepted,
        rejection_reasons: rejectionReasonsForCritique,
      });
      continue;
    }

    // Demais tipos capture-verified sem padrão numérico mecânico — evidência pronta, síntese de diff fica pra redação humana (ver docstring do módulo).
    candidates.push({
      requestType,
      lane: "evidence-only",
      editions_count: editionsSet.size,
      distinct_stories: distinctStories,
      events_missing_url: eventsMissingUrl,
      sample_events: sampleEvents,
      proposal: null,
      critique: null,
      accepted: false,
      rejection_reasons: [`"${requestType}" tem evidência suficiente (barra passada) mas síntese mecânica de diff de texto livre não é suportada nesta versão — ver docstring do módulo. Evidência pronta pra redação humana informada.`],
    });
  }

  let costEstimate: DistillationCostEstimate | null = null;
  if (anyCritiqueNeeded && opts.socialCriticBody) {
    const promptChars = buildCritiquePrompt(opts.socialCriticBody, "candidato exemplo").length;
    costEstimate = estimateDistillationCost(Math.ceil(promptChars / CHARS_PER_TOKEN_ESTIMATE), CRITIQUE_OUTPUT_TOKENS_ESTIMATE, 3);
  }

  const status: DistillationResult["status"] = candidates.length === 0 ? "no_qualifying_pattern" : "candidates_produced";
  return { status, cadence, backtest, candidates, cost_estimate: costEstimate };
}

function runCritiqueForProposal(proposal: string, opts: RunDistillationOptions, rootDir: string): HolisticCritiqueResult | null {
  if (!opts.socialCriticBody) return null;
  const prompt = buildCritiquePrompt(opts.socialCriticBody, proposal);
  const callFn = opts.callClaudeCliFn ?? callClaudeCli;
  return runHolisticCritique(prompt, { cwd: rootDir }, 3, callFn);
}

function formatReport(result: DistillationResult): string {
  const lines: string[] = [];
  lines.push(`[distill-prompt-corrections] status: ${result.status}`);
  if (!result.cadence.canTrigger) {
    lines.push(`  ${result.cadence.reason}`);
    return lines.join("\n");
  }
  lines.push(`  backtest (contexto de recorrência, não corte automático):`);
  for (const c of result.backtest.checks) {
    lines.push(`    ${c.name}: ${(c.violation_rate * 100).toFixed(1)}% (${c.editions_with_violation}/${c.editions_evaluated})`);
  }
  lines.push("");
  if (result.candidates.length === 0) {
    lines.push("  nenhum tipo de pedido capture-verified passou a barra de evidência (≥5 edições, ≥2 histórias).");
    return lines.join("\n");
  }
  for (const c of result.candidates) {
    lines.push(`  ${c.requestType}: lane=${c.lane} edições=${c.editions_count} histórias=${c.distinct_stories} (${c.events_missing_url} evento(s) sem URL)`);
    if (c.proposal) lines.push(`    proposta: ${c.proposal.slice(0, 200)}${c.proposal.length > 200 ? "…" : ""}`);
    lines.push(`    ${c.accepted ? "✅ ACEITO" : "❌ NÃO ACEITO: " + c.rejection_reasons.join(" | ")}`);
  }
  if (result.cost_estimate) {
    lines.push("");
    lines.push(`  estimativa de custo (crítica holística, 3 votos): ~$${result.cost_estimate.estimated_usd.toFixed(4)} (${result.cost_estimate.estimated_input_tokens_total} tokens in / ${result.cost_estimate.estimated_output_tokens_total} tokens out, estimado)`);
  }
  return lines.join("\n");
}

if (isMainModule(import.meta.url)) {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionsRoot = resolve(ROOT, values["editions-dir"] ?? "data/editions");
  const json = flags.has("json");
  const live = flags.has("live");
  const nowIso = values["now"] ?? new Date().toISOString();

  const cadenceStatePath = resolve(ROOT, "data", "distillation-cadence.json");
  const cadenceState: DistillationCadenceState = existsSync(cadenceStatePath)
    ? JSON.parse(readFileSync(cadenceStatePath, "utf8"))
    : { triggeredAt: [] };

  const socialCriticPath = resolve(ROOT, ".claude", "agents", "social-critic.md");
  const socialCriticBody = existsSync(socialCriticPath)
    ? readFileSync(socialCriticPath, "utf8").replace(/^---[\s\S]*?---\n/, "")
    : undefined;

  const result = runDistillPromptCorrections(editionsRoot, {
    cadenceState,
    nowIso,
    dryRun: !live,
    socialCriticBody,
    rootDir: ROOT,
  });

  console.log(json ? JSON.stringify(result, null, 2) : formatReport(result));
}
