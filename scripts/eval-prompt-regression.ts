#!/usr/bin/env npx tsx
/**
 * scripts/eval-prompt-regression.ts (#8143)
 *
 * Eval de regressão de prompt: re-executa `writer-destaque`/`social-writer`
 * (candidato = versão em disco, baseline = versão em `--baseline-ref`, default
 * `origin/master`) sobre fixtures de edições CONGELADAS
 * (`scripts/lib/replay-stage-input.ts`, preset "2" — `_internal/
 * 01-approved.json`) e compara os dois PAREADO sobre o MESMO input, via
 * graders mecânicos já existentes (`scripts/lib/prompt-regression-eval.ts`
 * — ver docstring daquele módulo para o desenho completo: repetição com
 * checagem de maioria, comparação pareada nunca-nota-isolada, dry-run
 * default).
 *
 * Complementar à Camada 3 da #7972 (`distillation-backtest.ts`, read-only
 * sobre texto JÁ PRODUZIDO por edições passadas) — este script RE-EXECUTA o
 * agent de verdade, o que aquele módulo explicitamente não faz.
 *
 * ## Uso
 *
 *   # dry-run (default) — monta os fixtures, mostra o plano de execução,
 *   # NUNCA spawna `claude` nem gasta token:
 *   npx tsx scripts/eval-prompt-regression.ts \
 *     --agent social-writer --reference-editions 260401,260402,260403
 *
 *   # rodada real — gasta token de verdade (assinatura claude.ai, nunca API
 *   # — #5608/#6714, filtragem herdada de callClaudeCli):
 *   npx tsx scripts/eval-prompt-regression.ts \
 *     --agent social-writer --reference-editions 260401,...,260410 \
 *     --repetitions 3 --live --out data/prompt-eval/social-writer-260410.json
 *
 * `--reference-editions` é uma lista CSV explícita de AAMMDD (o coordenador
 * decide quais 10 usar, ex: as mais recentes com `_internal/01-approved.json`
 * em disco — não é descoberta automática aqui, mesmo espírito de
 * `replay-stage-input.ts`, que também recebe a edição de referência
 * explícita).
 *
 * Cada fixture (baseline e candidato, por edição) grava seu PRÓPRIO
 * `_internal/cost.json` via `writeCostArtifact` (`edition-cost.ts`) — gasto
 * MEDIDO a partir do `usage` retornado por `claude --print --output-format
 * json`, nunca estimado (só em modo `--live`; dry-run não grava custo, não
 * há execução real).
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { createReplayFixture } from "./lib/replay-stage-input.ts";
import { writeCostArtifact, type AgentCostEntry } from "./lib/edition-cost.ts";
import { applyStage2Caps, type ApprovedJson } from "./lib/apply-stage2-caps.ts";
import {
  isPromptEvalAgent,
  readAgentBodyFromDisk,
  readAgentBodyAtGitRef,
  readAgentModelSpecFromDisk,
  readAgentModelSpecAtGitRef,
  parseArms,
  type AgentModelSpec,
  type EvalArm,
  readApprovedHighlight,
  readApprovedHighlightTitles,
  buildWriterDestaqueInput,
  buildSocialWriterInput,
  runAgentRepetitions,
  checkRepetitionConsistency,
  compareBaselineVsCandidate,
  verdictsFromOutcomes,
  type PromptEvalAgent,
  type GraderDelta,
  type AgentRunOutcome,
  type RunAgentRepetitionsOptions,
} from "./lib/prompt-regression-eval.ts";

const ROOT = resolve(import.meta.dirname, "..");
export const DEFAULT_REPETITIONS = 3;
export const DEFAULT_BASELINE_REF = "origin/master";
type CallClaudeCliFn = RunAgentRepetitionsOptions["callClaudeCliFn"];
/** `writer-destaque` roda contra D1 nesta 1ª fatia — avaliar os 3 em paralelo é extensão natural (fora de escopo da issue #8143, que pede só "o agent alterado", sem mandato de cobrir os 3 slots por edição). */
const WRITER_DESTAQUE_SLOT: 1 | 2 | 3 = 1;

interface EditionSideOutcome {
  /** `baseline`, `candidate` ou `arm:{modelo}[:{effort}]` (#9003). */
  side: string;
  /** Modelo/effort efetivamente passados ao `claude -p` neste lado (#9003). `undefined` = default do eval ("sonnet"). */
  model?: string;
  effort?: string;
  edition: string;
  testDirName: string;
  outcomes: AgentRunOutcome[];
}

interface EditionEvalResult {
  edition: string;
  baseline: EditionSideOutcome;
  candidate: EditionSideOutcome;
  deltas: GraderDelta[];
  /** Braços extras (`--arms`): corpo do candidato em outros modelos/effort, comparados ao baseline (#9003). */
  arms: Array<{ arm: EvalArm; outcome: EditionSideOutcome; deltas: GraderDelta[] }>;
}

export interface PromptRegressionEvalReport {
  agent: PromptEvalAgent;
  baseline_ref: string;
  repetitions: number;
  dry_run: boolean;
  editions: EditionEvalResult[];
}

/**
 * Constrói o input do agent (payload de coordenador) pro fixture já
 * materializado em `testDir`. Lança se `_internal/01-approved.json` estiver
 * ausente/malformado no fixture — sinal de que `--stage 2` não copiou o
 * esperado.
 *
 * **Nota deliberada:** em produção o coordenador passa `_internal/
 * 01-approved-capped.json` pro `writer-destaque` (mesmo `highlights[]`,
 * pool capado de tamanho pro Stage 2) e `01-approved.json` pro
 * `social-writer` (ver `## Input` dos 2 agents). O preset `"2"` de
 * `replay-stage-input.ts` só congela `_internal/01-approved.json` — usamos
 * esse arquivo pros dois lados aqui; os `highlights[]` (o que ambos os
 * agents de fato consomem) são idênticos entre as duas variantes, o "cap"
 * afeta só o tamanho do POOL de descarte, irrelevante pro replay de 1
 * destaque/post social.
 */
function buildInputForFixture(agent: PromptEvalAgent, testDir: string): { input: Record<string, unknown>; producedFileAbsPath: string } {
  const approvedJsonPath = join(testDir, "_internal", "01-approved.json");
  if (!existsSync(approvedJsonPath)) {
    throw new Error(`eval-prompt-regression: _internal/01-approved.json ausente em ${testDir} — fixture incompleto.`);
  }

  if (agent === "writer-destaque") {
    const article = readApprovedHighlight(approvedJsonPath, WRITER_DESTAQUE_SLOT);
    const otherTitles = readApprovedHighlightTitles(approvedJsonPath).filter((_, idx) => idx !== WRITER_DESTAQUE_SLOT - 1);
    // #8168 fleet review, finding 5: diferente de `readApprovedHighlight` (que LANÇA se
    // url/title estiverem ausentes), `readApprovedHighlightTitles` devolve "" em silêncio por
    // título ausente — e uma edição de 2 destaques (legítima, CLAUDE.md "2 ou 3, nunca 4") sempre
    // produz só 1 peer title aqui. Nunca lançar (regressão pra edições de 2 destaques), só avisar
    // antes de injetar peer title vazio num prompt REAL (--live gasta token mesmo assim).
    if (otherTitles.length < 2 || otherTitles.slice(0, 2).some((t) => !t)) {
      console.warn(
        `[eval-prompt-regression] fixture com peer title incompleto (highlights totais no fixture: ${otherTitles.length + 1}, esperado 3) — peer_titles vai incluir string vazia no prompt real do writer-destaque. Esperado pra edições legítimas de 2 destaques; nunca deveria passar despercebido.`,
      );
    }
    const peerTitles: [string, string] = [otherTitles[0] ?? "", otherTitles[1] ?? ""];
    const outPathRel = `_internal/02-d${WRITER_DESTAQUE_SLOT}-draft.md`;
    const imagePromptOutPathRel = `_internal/02-d${WRITER_DESTAQUE_SLOT}-prompt.md`;
    const input = buildWriterDestaqueInput({
      destaqueN: WRITER_DESTAQUE_SLOT,
      article,
      categoryLabel: article.category ?? "NOTÍCIAS",
      peerTitles,
      editionDateIso: new Date().toISOString(),
      outPathRel,
      imagePromptOutPathRel,
    });
    return { input, producedFileAbsPath: join(testDir, outPathRel) };
  }

  const outPathRel = "_internal/03-social.tmp.md";
  const input = buildSocialWriterInput({ approvedJsonPathRel: "_internal/01-approved.json", outDirRel: "." });
  return { input, producedFileAbsPath: join(testDir, outPathRel) };
}

function runSideForEdition(params: {
  agent: PromptEvalAgent;
  edition: string;
  side: string;
  agentBody: string;
  editionsRootDir: string;
  repetitions: number;
  dryRun: boolean;
  live: boolean;
  model?: string;
  effort?: string;
  callClaudeCliFn?: CallClaudeCliFn;
}): EditionSideOutcome {
  const label = `${params.agent}-${params.edition}-${params.side.replace(/[^A-Za-z0-9.-]+/g, "_")}`;
  const manifest = createReplayFixture({
    editionsRootDir: params.editionsRootDir,
    referenceAammdd: params.edition,
    stage: "2",
    label,
    force: true,
  });
  const testDir = join(params.editionsRootDir, manifest.test_dir_name);

  // #8168 fleet review, finding 3: `newsletter-lint-gate-blocking`
  // (`gradeStage2LintReport`) exige `_internal/01-approved-capped.json`, que o preset "2" de
  // `replay-stage-input.ts` nunca copia (só congela `01-approved.json`). Deriva o capped a
  // partir do approved já presente no fixture, reusando o MESMO helper puro que a produção usa
  // (`applyStage2Caps`) — nunca uma aproximação inventada. Sem isso, o grader ficava
  // permanentemente not-evaluable pros dois agents (achado unânime do fleet review).
  const approvedJsonPathForCaps = join(testDir, "_internal", "01-approved.json");
  if (existsSync(approvedJsonPathForCaps)) {
    const approved = JSON.parse(readFileSync(approvedJsonPathForCaps, "utf8")) as ApprovedJson;
    const { approved: capped } = applyStage2Caps(approved);
    writeFileSync(join(testDir, "_internal", "01-approved-capped.json"), JSON.stringify(capped, null, 2) + "\n", "utf8");
  }

  const { input, producedFileAbsPath } = buildInputForFixture(params.agent, testDir);

  const outcomes = runAgentRepetitions({
    agent: params.agent,
    agentBody: params.agentBody,
    input,
    cwd: testDir,
    producedFileAbsPath,
    editionDirForGrading: testDir,
    rootDir: ROOT,
    repetitions: params.repetitions,
    dryRun: params.dryRun,
    model: params.model,
    effort: params.effort,
    callClaudeCliFn: params.callClaudeCliFn,
  });

  if (params.live && !params.dryRun) {
    // #8168 fleet review, finding 4: repetições com `usage === null` (falha de parse do JSON de
    // resposta do CLI) eram filtradas fora de `costEntries` sem nenhum log — se TODAS as
    // repetições de um lado falhassem o parse, `writeCostArtifact` nem era chamado, silêncio
    // total contradizendo "custo MEDIDO, não estimado" (docstring do módulo).
    for (const o of outcomes) {
      if (!o.dryRun && o.usage === null) {
        console.error(
          `[eval-prompt-regression] ${label} repetição ${o.repetitionIndex}: usage null (JSON da resposta do CLI não parseou) — esta repetição NÃO entra em cost.json, custo medido fica incompleto pra ela.`,
        );
      }
    }
    const costEntries: AgentCostEntry[] = outcomes
      .filter((o) => o.usage !== null)
      .map((o) => ({
        stage: 2,
        agent_type: `${params.agent}-eval-${params.side}`,
        subagent_tokens: o.usage!.subagent_tokens,
        tool_uses: o.usage!.tool_uses,
        duration_ms: o.usage!.duration_ms,
        recorded_at: new Date().toISOString(),
      }));
    if (costEntries.length > 0) {
      writeCostArtifact(testDir, manifest.test_dir_name, costEntries);
    }
  }

  return { side: params.side, model: params.model, effort: params.effort, edition: params.edition, testDirName: manifest.test_dir_name, outcomes };
}

export function runPromptRegressionEval(params: {
  agent: PromptEvalAgent;
  referenceEditions: string[];
  editionsRootDir: string;
  baselineRef: string;
  repetitions: number;
  dryRun: boolean;
  rootDir: string;
  readAgentBodyFromDiskFn?: typeof readAgentBodyFromDisk;
  readAgentBodyAtGitRefFn?: typeof readAgentBodyAtGitRef;
  callClaudeCliFn?: CallClaudeCliFn;
  /** Modelo/effort do frontmatter do candidato (disco) e do baseline (`baselineRef`) — injetável pra teste (#9003). */
  readAgentModelSpecFromDiskFn?: typeof readAgentModelSpecFromDisk;
  readAgentModelSpecAtGitRefFn?: typeof readAgentModelSpecAtGitRef;
  /** Braços extras (`--arms`, #9003): rodam o corpo do candidato nesses modelos/effort. */
  arms?: EvalArm[];
}): PromptRegressionEvalReport {
  const readDisk = params.readAgentBodyFromDiskFn ?? readAgentBodyFromDisk;
  const readRef = params.readAgentBodyAtGitRefFn ?? readAgentBodyAtGitRef;

  const candidateBody = readDisk(params.rootDir, params.agent);
  const baselineBody = readRef(params.rootDir, params.agent, params.baselineRef);
  // #9003: o frontmatter de cada lado decide `--model`/`--effort`. Quando o chamador injeta
  // só os leitores de CORPO (testes de fluxo sem git real), não há frontmatter a ler: spec
  // vazio, e `runAgentRepetitions` cai no default. Com leitores reais, falha de leitura LANÇA
  // (nunca cai em silêncio pro mesmo modelo nos dois lados).
  const bodyReadersInjected = params.readAgentBodyFromDiskFn !== undefined || params.readAgentBodyAtGitRefFn !== undefined;
  const readSpecDisk = params.readAgentModelSpecFromDiskFn ?? (bodyReadersInjected ? (): AgentModelSpec => ({}) : readAgentModelSpecFromDisk);
  const readSpecRef = params.readAgentModelSpecAtGitRefFn ?? (bodyReadersInjected ? (): AgentModelSpec => ({}) : readAgentModelSpecAtGitRef);
  const candidateSpec = readSpecDisk(params.rootDir, params.agent);
  const baselineSpec = readSpecRef(params.rootDir, params.agent, params.baselineRef);

  const editions: EditionEvalResult[] = params.referenceEditions.map((edition) => {
    const baseline = runSideForEdition({
      agent: params.agent,
      edition,
      side: "baseline",
      agentBody: baselineBody,
      model: baselineSpec.model,
      effort: baselineSpec.effort,
      editionsRootDir: params.editionsRootDir,
      repetitions: params.repetitions,
      dryRun: params.dryRun,
      live: !params.dryRun,
      callClaudeCliFn: params.callClaudeCliFn,
    });
    const candidate = runSideForEdition({
      agent: params.agent,
      edition,
      side: "candidate",
      agentBody: candidateBody,
      model: candidateSpec.model,
      effort: candidateSpec.effort,
      editionsRootDir: params.editionsRootDir,
      repetitions: params.repetitions,
      dryRun: params.dryRun,
      live: !params.dryRun,
      callClaudeCliFn: params.callClaudeCliFn,
    });

    const baselineConsistency = checkRepetitionConsistency(verdictsFromOutcomes(baseline.outcomes));
    const candidateConsistency = checkRepetitionConsistency(verdictsFromOutcomes(candidate.outcomes));
    const deltas = compareBaselineVsCandidate(baselineConsistency, candidateConsistency);

    const arms = (params.arms ?? []).map((arm) => {
      const outcome = runSideForEdition({
        agent: params.agent,
        edition,
        side: `arm:${arm.model}${arm.effort ? `:${arm.effort}` : ""}`,
        agentBody: candidateBody,
        editionsRootDir: params.editionsRootDir,
        repetitions: params.repetitions,
        dryRun: params.dryRun,
        live: !params.dryRun,
        model: arm.model,
        effort: arm.effort,
        callClaudeCliFn: params.callClaudeCliFn,
      });
      const armConsistency = checkRepetitionConsistency(verdictsFromOutcomes(outcome.outcomes));
      return { arm, outcome, deltas: compareBaselineVsCandidate(baselineConsistency, armConsistency) };
    });

    return { edition, baseline, candidate, deltas, arms };
  });

  return {
    agent: params.agent,
    baseline_ref: params.baselineRef,
    repetitions: params.repetitions,
    dry_run: params.dryRun,
    editions,
  };
}

function formatReport(report: PromptRegressionEvalReport): string {
  const lines: string[] = [];
  lines.push(`[eval-prompt-regression] agent=${report.agent} baseline_ref=${report.baseline_ref} repetitions=${report.repetitions} dry_run=${report.dry_run}`);
  if (report.dry_run) {
    lines.push(`  dry-run: nenhum "claude" real foi chamado — ${report.editions.length} edição(ões) x 2 lados (baseline/candidato) x ${report.repetitions} repetição(ões) planejadas.`);
  }
  for (const e of report.editions) {
    lines.push(`  edição ${e.edition}:`);
    for (const d of e.deltas) {
      lines.push(`    ${d.name}: ${d.verdict}`);
    }
    for (const a of e.arms) {
      lines.push(`    braço ${a.arm.model}${a.arm.effort ? `:${a.arm.effort}` : ""} (vs baseline):`);
      for (const d of a.deltas) lines.push(`      ${d.name}: ${d.verdict}`);
    }
  }
  return lines.join("\n");
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const agentRaw = values["agent"];
  const referenceEditionsCsv = values["reference-editions"];
  const repetitions = values["repetitions"] ? Number(values["repetitions"]) : DEFAULT_REPETITIONS;
  const baselineRef = values["baseline-ref"] ?? DEFAULT_BASELINE_REF;
  const live = flags.has("live");
  const outPath = values["out"];
  const json = flags.has("json");
  let arms: EvalArm[] | undefined;
  if (values["arms"]) {
    try {
      arms = parseArms(values["arms"]);
    } catch (e) {
      console.error(`[error] ${(e as Error).message}`);
      process.exit(1);
    }
  }

  if (!agentRaw || !isPromptEvalAgent(agentRaw)) {
    console.error("Uso: eval-prompt-regression.ts --agent writer-destaque|social-writer --reference-editions AAMMDD,AAMMDD,... [--repetitions N] [--baseline-ref REF] [--editions-dir path] [--arms modelo[:effort],...] [--live] [--out arquivo.json]");
    process.exit(1);
  }
  if (!referenceEditionsCsv) {
    console.error("[error] precisa de --reference-editions <lista-csv-AAMMDD>");
    process.exit(1);
  }
  const referenceEditions = referenceEditionsCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (referenceEditions.length === 0) {
    console.error("[error] --reference-editions ficou vazio após parse");
    process.exit(1);
  }
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    console.error(`[error] --repetitions deve ser um inteiro ≥ 1, recebido "${values["repetitions"]}"`);
    process.exit(1);
  }

  // #8143: `--editions-dir` override — este worktree/sandbox não tem a
  // junction `data/` -> OneDrive (`CLAUDE.md` §2b), então o default
  // `data/editions` sob `ROOT` fica vazio aqui. Numa máquina com a junction
  // presente (o caso normal de uso), o default funciona sem essa flag —
  // ela existe pra apontar explicitamente pro editions-root real (ou pra um
  // fixture root de teste) quando o default não resolve.
  const editionsRootDir = values["editions-dir"] ? resolve(ROOT, values["editions-dir"]) : resolve(ROOT, "data", "editions");

  let report: PromptRegressionEvalReport;
  try {
    report = runPromptRegressionEval({
      agent: agentRaw,
      referenceEditions,
      editionsRootDir,
      baselineRef,
      repetitions,
      dryRun: !live,
      rootDir: ROOT,
      arms,
    });
  } catch (e) {
    console.error(`[error] ${(e as Error).message}`);
    process.exit(1);
  }

  if (outPath) {
    const absOut = resolve(ROOT, outPath);
    mkdirSync(dirname(absOut), { recursive: true });
    writeFileSync(absOut, JSON.stringify(report, null, 2) + "\n", "utf8");
  }

  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report));
}

if (isMainModule(import.meta.url)) {
  main();
}
