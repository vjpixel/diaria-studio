#!/usr/bin/env node
/**
 * stage-2-run.ts (#14031) — runner determinístico da Etapa 2 (Escrita).
 *
 * Mesmo molde de `stage-0-run.ts`, `stage-1-run.ts` e `stage-3-run.ts`
 * (#5415): o miolo de `npx tsx` da Etapa 2 (caps, fontes, stitch, merge,
 * lints, normalize, Clarice REST, guards pós-Clarice, invariantes, sentinel)
 * roda aqui, em fases; o top-level só despacha agentes e lê o JSON. Antes a
 * skill `/diaria-2-escrita` e o playbook `orchestrator-stage-2.md` pediam
 * ~30 chamadas Bash separadas, cada uma um turno com ~122k de contexto
 * (mediana de novembro: 32 turnos, 3,9M tokens_in no Stage 2).
 *
 * FASES (`--phase`), na ordem em que o top-level as chama:
 *
 *   pre-dispatch   sentinel do Stage 1, validate-lancamentos --approved,
 *                  apply-stage2-caps, translate-summaries,
 *                  refresh-destaque-sources --record-writer-inputs,
 *                  select-use-melhor-post, youtube-title-research.
 *                  → `pendingAgentDispatch`: writer-destaque × N (ou writer
 *                  único no fallback) + social-writer + social-curto, numa
 *                  mensagem só.
 *   post-writers   verify-agent-outputs (#9962), stitch-newsletter,
 *                  validate-stage-2-outputs, merge-social-md, lint
 *                  platform-headers-unicos, pool-descriptions --input.
 *                  → `pendingAgentDispatch`: writer-pool (se houver item).
 *   post-pool      verify do writer-pool + pool-descriptions --apply,
 *                  lint-newsletter-md --stage 2, normalize, singularize,
 *                  snapshot pré-humanizador do social.
 *                  → `pendingAgentDispatch`: os DOIS humanizadores (newsletter
 *                  e social), na mesma mensagem: não dependem um do outro.
 *   post-humanize  checagem dos humanizadores, Clarice REST da newsletter e
 *                  depois do social (EM SÉRIE, #4952), registro de prova do
 *                  social. Termina aí (`nextPhase: post-checks`): Clarices +
 *                  checagens numa chamada podiam passar dos 600 s da Bash.
 *   post-checks    strip de travessão, sync do É IA?, URL/cupons, intro,
 *                  lançamentos, paywall/agregador (validate-domains, aviso no
 *                  gate, #14244), cobertura, erro intencional (render + plantio
 *                  em `--no-gates`), check-stage2-invariants, lints do social,
 *                  check-invariants --stage 2 --phase pre-gate (sem a regra
 *                  de 1 título por destaque, #14266), measure-highlights. Re-rodável
 *                  sozinho depois de uma correção cirúrgica (não refaz Clarice).
 *   post-gate      title-picker (fallback pós-gate), validações de estrutura,
 *                  TÍTULO/SUBTÍTULO, selo do humanizador social, sentinel do
 *                  Stage 2, snapshot de pedidos editoriais, limpeza.
 *
 * A ORDEM humanizador → Clarice é a mesma do playbook (#1072): a Clarice roda
 * sobre o texto humanizado e tem precedência sobre ele (#3929).
 *
 * Clarice (#14029): o teto da Clarice da NEWSLETTER (`--deadline-ms`) vem de
 * `resolveClariceStage2DeadlineMs` (`preflight-state.json` →
 * `clariceRealProbe`): 90 s quando o ping real do Stage 0 falhou, 480 s no
 * resto; arquivo ilegível vira 480 s com aviso no gate. Exit 6
 * (`clarice_unavailable`) da newsletter segue pelo `clarice-pending.ts skip`,
 * como antes. O SOCIAL usa sempre o teto normal de 480 s inteiro (não tem
 * `resume`): as duas Clarices dividem um orçamento de 540 s por chamada (a
 * Bash tool corta em 10 min), e quando a da newsletter deixa menos de 480 s o
 * runner devolve exit 3 com `rerunArgs: ["--social-clarice-only"]`, e a do
 * social roda numa chamada própria (#14093). O runner usa só o caminho REST: script Node não chama o MCP
 * `mcp__clarice__correct_text` (1.491 das 1.510 tentativas de 20/10-25/11 já
 * eram REST).
 *
 * Clarice do social: qualquer falha, inclusive o exit 6, é HALT (code 2) — o
 * `clarice-pending resume` do Stage 4 só cobre a newsletter, então o social
 * nunca segue sem Clarice em silêncio. Retomada: `--phase post-humanize
 * --social-clarice-only [--deadline-ms N]` (refaz só a Clarice do social, teto
 * normal ou o override). `--no-gates` do pre-dispatch fica gravado no estado e
 * vale nos re-runs.
 *
 * Lint gate-blocking no `post-pool`: re-despachar só o writer do destaque e
 * re-rodar `--phase post-pool --restitch` (stitch + reaplica o pool já escrito,
 * sem novo writer-pool). `--scope` explícito numa fase vence o escopo gravado.
 *
 * NÃO COBERTO (delegado ao top-level, ver `DELEGATED_STEPS`): os dispatches
 * de Agent, o gate humano, `record-agent-costs.ts` (precisa dos `<usage>` dos
 * agentes), `update-stage-status`/`capture-stage-usage`, a proposta interativa
 * do erro intencional e as correções cirúrgicas pedidas pelos checks.
 *
 * Estado entre fases: `_internal/02-stage2-run-state.json` (modo, escopo,
 * instantes de dispatch, paths esperados). Cada sub-script é invocado por
 * spawn (`process.execPath --import tsx`, guard #4343).
 *
 * Exit codes (`code` no JSON):
 *   0 — fase concluída (pode trazer `pendingAgentDispatch`)
 *   1 — erro duro: sub-script obrigatório falhou, estado ausente, arg inválido
 *   2 — HALT: sentinel do Stage 1 ausente, Clarice exit 2/3/5 (chave ausente,
 *       HTTP non-2xx, staleness) ou skip recusado; `haltRequired` traz o banner
 *   3 — conserto necessário antes de seguir: output de agente ausente/defasado,
 *       lint gate-blocking, humanizador no-op, invariante do Stage 2 ou sentinel
 *       recusado; `fixes[]` diz o quê e `rerunPhase` qual fase re-rodar
 *
 * Uso:
 *   npx tsx scripts/stage-2-run.ts --phase pre-dispatch --edition AAMMDD [--scope all|newsletter|social]
 *   npx tsx scripts/stage-2-run.ts --phase post-writers --edition AAMMDD
 *   npx tsx scripts/stage-2-run.ts --phase post-pool --edition AAMMDD [--restitch]
 *   npx tsx scripts/stage-2-run.ts --phase post-humanize --edition AAMMDD [--no-gates] [--social-clarice-only]   # Bash timeout 600000
 *   npx tsx scripts/stage-2-run.ts --phase post-checks --edition AAMMDD [--no-gates]
 *   npx tsx scripts/stage-2-run.ts --phase post-gate --edition AAMMDD [--after-title-picker]
 *
 * @see .claude/agents/orchestrator-stage-2.md (passos fora do runner), .claude/agents/orchestrator-stage-2-fallback.md
 *   (prosa de cada passo, lida só no fallback, #14113), .claude/skills/diaria-2-escrita/SKILL.md
 * @see scripts/stage-3-run.ts (molde mais próximo)
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { CLARICE_NORMAL_DEADLINE_MS, resolveClariceStage2DeadlineForEdition, type ClariceStage2Deadline } from "./lib/clarice-stage2-deadline.ts";
import { emitStepTimings, StepTimingRecorder } from "./lib/runner-step-timings.ts";

loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Spawn — mesmo helper de stage-3-run.ts.
// ---------------------------------------------------------------------------

export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** `label` (opcional) só serve à medição por passo (#14032); o spawn real ignora. */
export type ExecFn = (scriptRelPath: string, args: string[], label?: string) => StepResult;

export function realExec(rootDir: string): ExecFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    const result = spawnSync(process.execPath, ["--import", "tsx", abs, ...args], {
      cwd: rootDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status === null) {
      return {
        code: 1,
        stdout: result.stdout ?? "",
        stderr: (result.stderr ?? "") + `\nERRO: o passo nao executou (falha de spawn): ${result.error?.message ?? "status null"}\n`,
      };
    }
    return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
}

export function parseStepJson<T = unknown>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const starts = ["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0);
  if (starts.length === 0) return undefined;
  try {
    return JSON.parse(trimmed.slice(Math.min(...starts))) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Tipos do resultado.
// ---------------------------------------------------------------------------

export const PHASES = ["pre-dispatch", "post-writers", "post-pool", "post-humanize", "post-checks", "post-gate"] as const;
export type Phase = (typeof PHASES)[number];
export type Scope = "all" | "newsletter" | "social";
export type Mode = "parallel" | "fallback";

export interface PendingAgentDispatch {
  step: string;
  agent: string;
  description: string;
  /** Parâmetros que vão no prompt do agente (paths já resolvidos). */
  params: Record<string, unknown>;
  detail: string;
}

export interface HaltRequired {
  stage: string;
  reason: string;
  action: string;
}

export interface Fix {
  check: string;
  action: string;
  detail?: unknown;
}

export interface Stage2RunResult {
  code: 0 | 1 | 2 | 3;
  phase: Phase | "invalid";
  editionDir?: string;
  scope?: Scope;
  mode?: Mode;
  nextPhase?: Phase | null;
  pendingAgentDispatch: PendingAgentDispatch[];
  /** `true` quando os itens de `pendingAgentDispatch` saem numa mensagem só. */
  dispatchTogether?: boolean;
  haltRequired?: HaltRequired;
  fixes: Fix[];
  rerunPhase?: Phase;
  /** Flags extras para a re-execução de `rerunPhase` (ex.: `--restitch`). */
  rerunArgs?: string[];
  /** Linhas a levar ao resumo do gate (avisos warn-only, Clarice pendente, etc.). */
  gateNotes: string[];
  clarice?: {
    deadlineMs: number;
    degraded: boolean;
    reason: string;
    /** `preflight-state.json` existe e não pôde ser lido (#14084); `null` no resto. */
    stateError: string | null;
    newsletter?: ClariceOutcome;
    social?: ClariceOutcome;
  };
  delegatedSteps: string[];
  notes: string[];
}

export type ClariceOutcome = "applied" | "unavailable-skipped" | "no-suggestions" | "headers-lost-kept-humanized" | "not-run";

export const DELEGATED_STEPS = [
  "Dispatch dos agentes de `pendingAgentDispatch` (Agent síncrono, sem polling #9223) — script Node não chama Agent/Skill/MCP.",
  "record-agent-costs.ts com os `<usage>` dos agentes (writers, social, writer-pool, title-picker).",
  "Gate humano unificado (§2d / Passo 6) — o runner só junta `gateNotes`.",
  "Proposta do erro intencional no modo interativo (o plantio determinístico só roda com --no-gates).",
  "Correções cirúrgicas pedidas em `fixes[]` (re-dispatch de writer, descrição de item, Curto acima de 280).",
  "update-stage-status.ts --stage 2 --status done e capture-stage-usage.ts --stage 2.",
];

// ---------------------------------------------------------------------------
// Opções.
// ---------------------------------------------------------------------------

export class Stage2Abort extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Stage2Abort";
  }
}

export interface Stage2RunOptions {
  phase: Phase;
  edition: string;
  scope: Scope;
  /** `--scope` veio na linha de comando: vence o escopo gravado no estado. */
  scopeExplicit: boolean;
  noGates: boolean;
  afterTitlePicker: boolean;
  /** post-pool: refaz stitch + `pool-descriptions --apply` (sem novo writer-pool) antes dos lints. */
  restitch: boolean;
  /** post-humanize: só a Clarice do social (a da newsletter já rodou). */
  socialClariceOnly: boolean;
  /** post-humanize `--social-clarice-only`: override do teto da Clarice do social (ms). */
  deadlineMsOverride?: number;
}

export function parseStage2RunArgs(argv: string[]): Stage2RunOptions {
  const phase = getStringArg(argv, "phase", { example: "pre-dispatch" });
  if (!phase || !(PHASES as readonly string[]).includes(phase)) {
    throw new Stage2Abort(`--phase precisa ser um de: ${PHASES.join(", ")} — recebido: "${phase ?? ""}"`);
  }
  const edition = getStringArg(argv, "edition", { example: "260423" });
  if (!edition || !/^\d{6}$/.test(edition)) {
    throw new Stage2Abort('--edition AAMMDD é obrigatório (6 dígitos, ex: "260423").');
  }
  const scopeArg = getStringArg(argv, "scope", { example: "all" });
  const scopeRaw = scopeArg ?? "all";
  if (!["all", "newsletter", "social"].includes(scopeRaw)) {
    throw new Stage2Abort(`--scope precisa ser all, newsletter ou social — recebido: "${scopeRaw}"`);
  }
  return {
    phase: phase as Phase,
    edition,
    scope: scopeRaw as Scope,
    scopeExplicit: scopeArg !== undefined,
    // `--no-gate` (singular) é a grafia legada do #874, aceita como sinônimo.
    noGates: hasFlag(argv, "no-gates") || hasFlag(argv, "no-gate"),
    afterTitlePicker: hasFlag(argv, "after-title-picker"),
    restitch: hasFlag(argv, "restitch"),
    socialClariceOnly: hasFlag(argv, "social-clarice-only"),
    deadlineMsOverride: parseDeadlineOverride(getStringArg(argv, "deadline-ms", { example: "480000" }), hasFlag(argv, "social-clarice-only")),
  };
}

function parseDeadlineOverride(raw: string | undefined, socialOnly: boolean): number | undefined {
  if (raw === undefined) return undefined;
  if (!socialOnly) throw new Stage2Abort("--deadline-ms só vale com --social-clarice-only (override do teto da Clarice do social).");
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Stage2Abort(`--deadline-ms precisa ser um número positivo — recebido: "${raw}"`);
  if (n > CLARICE_PHASE_BUDGET_MS) {
    throw new Stage2Abort(`--deadline-ms ${n} passa do orçamento da fase (${CLARICE_PHASE_BUDGET_MS} ms, abaixo dos 600 s da Bash).`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Deps.
// ---------------------------------------------------------------------------

export interface Stage2RunDeps {
  exec: ExecFn;
  now: () => Date;
  /** Relógio em ms da medição por passo (#14032). Ausente = `Date.now`. */
  clockMs?: () => number;
}

export function productionDeps(rootDir: string = ROOT): Stage2RunDeps {
  return { exec: realExec(rootDir), now: () => new Date() };
}

// ---------------------------------------------------------------------------
// Estado entre fases.
// ---------------------------------------------------------------------------

export interface RunState {
  edition: string;
  scope: Scope;
  mode: Mode;
  destaqueCount: number;
  writersDispatchAt?: string;
  /** Paths que os writers/social precisam ter gravado (verify-agent-outputs). */
  writerOutputs?: string[];
  poolDispatchAt?: string | null;
  /** O `--apply` já rodou sobre um 02-pool-descriptions.json verificado (o `--restitch` reaplica). */
  poolApplied?: boolean;
  humanizeDispatchAt?: string;
  youtubeResearchOk?: boolean;
  /** `--no-gates` do pre-dispatch (#14084): vale nos re-runs mesmo sem a flag. */
  noGates?: boolean;
  /** Quantas vezes o post-writers achou `03-curto.tmp.md` ausente/defasado. */
  curtoMissingCount?: number;
  /** Aviso warn-only do Curto (2ª ausência), repetido no gate pelo post-checks. */
  curtoWarn?: string | null;
  /** Aviso do normalize que falhou no post-pool (#14094), repetido no gate pelo post-checks. */
  normalizeWarn?: string | null;
  /** Dispatch do social-curto gravado no pre-dispatch, devolvido no fix de re-dispatch. */
  curtoDispatch?: PendingAgentDispatch | null;
  /** Avisos da Clarice do post-humanize (skip/resume, cabeçalhos, degradado, stateError), repetidos no post-checks. */
  clariceWarns?: string[];
  /** post-checks terminou com code 0 (o post-gate exige). */
  postChecksDone?: boolean;
  /** Dispatch do title-picker ainda precisa da comparação estrutural (#14307). */
  titlePickerStructurePending?: boolean;
  /** Clarices já rodaram no post-humanize (o post-checks exige). */
  clariceDone?: { newsletter?: ClariceOutcome; social?: ClariceOutcome };

}

export const RUN_STATE_FILE = "02-stage2-run-state.json";

function statePath(editionDir: string): string {
  return resolve(editionDir, "_internal", RUN_STATE_FILE);
}

/** O estado existe mas não é um JSON de objeto legível (#14094) — diferente de ausente. */
export class RunStateUnreadableError extends Error {
  constructor(
    readonly path: string,
    readonly cause: string,
  ) {
    super(`${RUN_STATE_FILE} ilegível (${cause})`);
    this.name = "RunStateUnreadableError";
  }
}

/**
 * `null` só quando o arquivo não existe. Arquivo ilegível lança
 * `RunStateUnreadableError` (#14094): tratá-lo como ausente mandava rodar o
 * pre-dispatch de novo, que sobrescreve `clariceDone`/`poolApplied` e
 * re-despacha todos os writers.
 */
export function readRunState(editionDir: string): RunState | null {
  const p = statePath(editionDir);
  if (!existsSync(p)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, "utf8"));
  } catch (err) {
    throw new RunStateUnreadableError(p, (err as Error).message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RunStateUnreadableError(p, "não é um objeto JSON");
  }
  return parsed as RunState;
}

function writeRunState(editionDir: string, state: RunState): void {
  writeFileSync(statePath(editionDir), JSON.stringify(state, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------

class Ctx {
  readonly notes: string[] = [];
  readonly gateNotes: string[] = [];
  readonly fixes: Fix[] = [];
  constructor(
    readonly deps: Stage2RunDeps,
    readonly opts: Stage2RunOptions,
    readonly editionDir: string,
  ) {}
  note(line: string): void {
    this.notes.push(line);
    console.error(line);
  }
  run(label: string, script: string, args: string[]): StepResult {
    this.note(`▶ ${label}`);
    const r = this.deps.exec(script, args, label);
    if (r.stderr.trim()) console.error(r.stderr.trim());
    return r;
  }
  /** Passo obrigatório: exit != 0 lança (vira code 1). */
  must(label: string, script: string, args: string[]): StepResult {
    const r = this.run(label, script, args);
    if (r.code !== 0) {
      throw new Stage2Abort(`${label} falhou (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
    }
    return r;
  }
  /** Passo fail-soft: exit != 0 vira aviso. */
  soft(label: string, script: string, args: string[]): StepResult {
    const r = this.run(label, script, args);
    if (r.code !== 0) this.note(`⚠️  ${label} falhou (exit ${r.code}) — fail-soft, a Etapa 2 segue.`);
    return r;
  }
  log(level: "info" | "warn" | "error", message: string, details?: unknown): void {
    const args = ["--edition", this.opts.edition, "--stage", "2", "--agent", "stage-2-run", "--level", level, "--message", message];
    if (details !== undefined) args.push("--details", JSON.stringify(details));
    this.deps.exec("scripts/log-event.ts", args);
  }
  p(rel: string): string {
    return resolve(this.editionDir, rel);
  }
  /** Path no formato que os scripts e os agentes recebem (`{EDIR}/...`). */
  e(rel: string): string {
    return `${this.editionDir.replace(/[\\/]+$/, "")}/${rel}`;
  }
  get dirArg(): string {
    return `${this.editionDir.replace(/[\\/]+$/, "")}/`;
  }
  get newsletter(): boolean {
    return this.opts.scope !== "social";
  }
  get social(): boolean {
    return this.opts.scope !== "newsletter";
  }
}

function result(ctx: Ctx, code: Stage2RunResult["code"], extra: Partial<Stage2RunResult> = {}): Stage2RunResult {
  return {
    code,
    phase: ctx.opts.phase,
    editionDir: ctx.editionDir,
    scope: ctx.opts.scope,
    pendingAgentDispatch: [],
    fixes: ctx.fixes,
    gateNotes: ctx.gateNotes,
    delegatedSteps: DELEGATED_STEPS,
    notes: ctx.notes,
    ...extra,
  };
}

function fixNeeded(ctx: Ctx, rerunPhase: Phase, extra: Partial<Stage2RunResult> = {}): Stage2RunResult {
  return result(ctx, 3, { rerunPhase, nextPhase: rerunPhase, ...extra });
}

function halt(ctx: Ctx, reason: string, action: string): Stage2RunResult {
  const haltRequired = { stage: "2 — Escrita", reason, action };
  ctx.deps.exec("scripts/render-halt-banner.ts", ["--stage", haltRequired.stage, "--reason", reason, "--action", action]);
  ctx.log("error", `stage-2-run HALT: ${reason}`);
  return result(ctx, 2, { haltRequired, nextPhase: null });
}

function sameContent(a: string, b: string): boolean {
  return existsSync(a) && existsSync(b) && readFileSync(a, "utf8") === readFileSync(b, "utf8");
}

function freshNonEmpty(path: string, sinceIso: string | undefined): boolean {
  if (!existsSync(path)) return false;
  const st = statSync(path);
  if (st.size === 0) return false;
  if (!sinceIso) return true;
  return st.mtimeMs >= Date.parse(sinceIso) - 2000;
}

// ---------------------------------------------------------------------------
// Fase pre-dispatch.
// ---------------------------------------------------------------------------

interface ApprovedHighlight {
  article?: { url?: string; title?: string; category?: string } & Record<string, unknown>;
  bucket?: string;
}

function phasePreDispatch(ctx: Ctx): Stage2RunResult {
  const { edition } = ctx.opts;
  const sentinel = ctx.run("pipeline-sentinel assert --step 1", "scripts/pipeline-sentinel.ts", [
    "assert",
    "--edition",
    edition,
    "--step",
    "1",
    "--outputs",
    "01-categorized.md,_internal/01-approved.json",
  ]);
  if (sentinel.code === 3) {
    ctx.log("warn", "stage1_sentinel_missing_legacy");
  } else if (sentinel.code !== 0) {
    return halt(
      ctx,
      sentinel.code === 2 ? "outputs do Stage 1 ausentes" : "Etapa 1 não completou (sentinel ausente)",
      `re-rodar /diaria-1-pesquisa ${edition} antes da Etapa 2`,
    );
  }

  const approved = ctx.e("_internal/01-approved.json");
  const capped = ctx.e("_internal/01-approved-capped.json");
  const lanc = ctx.run("validate-lancamentos --approved", "scripts/validate-lancamentos.ts", [
    "--approved",
    approved,
    "--write-removed",
    ctx.e("_internal/02-lancamentos-removed.json"),
  ]);
  if (lanc.code > 1) ctx.note(`⚠️  validate-lancamentos --approved saiu ${lanc.code} — fail-soft.`);
  ctx.must("apply-stage2-caps", "scripts/apply-stage2-caps.ts", ["--in", approved, "--out", capped]);
  ctx.must("translate-summaries", "scripts/translate-summaries.ts", ["--in", capped, "--out", capped]);

  const sourcesStep = ctx.soft("refresh-destaque-sources --record-writer-inputs", "scripts/refresh-destaque-sources.ts", [
    "--edition-dir",
    ctx.dirArg,
    "--approved",
    capped,
    "--record-writer-inputs",
  ]);
  const sources =
    parseStepJson<{ sources?: Array<{ destaque: number; url?: string; path?: string; error?: string }> }>(sourcesStep.stdout)?.sources ?? [];
  const sourcePath = (n: number): string | undefined => {
    const s = sources.find((x) => Number(x.destaque) === n && !x.error && x.path);
    return s?.path;
  };

  let useMelhor: { enabled?: boolean; item?: { source_text_path?: string } | null } | undefined;
  if (ctx.social) {
    const um = ctx.soft("select-use-melhor-post", "scripts/select-use-melhor-post.ts", ["--edition-dir", ctx.dirArg]);
    useMelhor = parseStepJson(um.stdout);
  }
  let youtubeOk = false;
  if (ctx.newsletter) {
    const yt = ctx.soft("youtube-title-research", "scripts/youtube-title-research.ts", ["--edition-dir", ctx.dirArg, "--approved", capped]);
    youtubeOk = parseStepJson<{ status?: string }>(yt.stdout)?.status === "ok";
  }

  let highlights: ApprovedHighlight[];
  try {
    highlights = (JSON.parse(readFileSync(ctx.p("_internal/01-approved-capped.json"), "utf8")) as { highlights?: ApprovedHighlight[] }).highlights ?? [];
  } catch (err) {
    throw new Stage2Abort(`01-approved-capped.json ilegível: ${(err as Error).message}`);
  }
  const n = highlights.length;
  const mode: Mode = n >= 2 && n <= 3 ? "parallel" : "fallback";
  if (mode === "fallback") ctx.note(`⚠️  highlights.length=${n}, fora de {2,3}: writer único (legacy).`);

  const dispatchAt = ctx.deps.now().toISOString();
  const pending: PendingAgentDispatch[] = [];
  const writerOutputs: string[] = [];

  if (ctx.newsletter) {
    if (mode === "parallel") {
      highlights.forEach((h, i) => {
        const dn = i + 1;
        const out = ctx.e(`_internal/02-d${dn}-draft.md`);
        const prompt = ctx.e(`_internal/02-d${dn}-prompt.md`);
        writerOutputs.push(out, prompt);
        const params: Record<string, unknown> = {
          destaque_n: dn,
          destaque: h.article,
          category_label: "derivar de article.category pela tabela temática do playbook (#1668, #6083), nunca do bucket",
          peer_titles: highlights.filter((_, j) => j !== i).map((x) => x.article?.title),
          edition_date: edition,
          source_url: h.article?.url,
          out_path: out,
          image_prompt_out_path: prompt,
        };
        const sp = sourcePath(dn);
        if (sp) params.source_text_path = sp;
        if (dn === 1 && youtubeOk) params.youtube_title_research_path = ctx.e("_internal/youtube-title-research.json");
        pending.push({
          step: "2a",
          agent: "writer-destaque",
          description: `Etapa 2 — D${dn} writer`,
          params,
          detail: "Seguir context/templates/newsletter.md. Passar o `article` INTEIRO (#3920).",
        });
      });
    } else {
      const out = ctx.e("_internal/02-draft.md");
      writerOutputs.push(out);
      pending.push({
        step: "2a",
        agent: "writer",
        description: "Etapa 2 — newsletter writer (fallback legacy)",
        params: {
          categorized: capped,
          edition_date: edition,
          out_path: out,
          d1_prompt_path: ctx.e("_internal/02-d1-prompt.md"),
          d2_prompt_path: ctx.e("_internal/02-d2-prompt.md"),
          d3_prompt_path: ctx.e("_internal/02-d3-prompt.md"),
        },
        detail: "Writer único: highlights fora de {2,3}.",
      });
    }
  }

  if (ctx.social) {
    const sourceTextPaths: Record<string, string> = {};
    for (let dn = 1; dn <= Math.min(n, 3); dn++) {
      const sp = sourcePath(dn);
      if (sp) sourceTextPaths[`d${dn}`] = sp;
    }
    const umOn = Boolean(useMelhor?.enabled && useMelhor.item);
    if (umOn && useMelhor?.item?.source_text_path) sourceTextPaths.um = ctx.e(useMelhor.item.source_text_path);
    const socialParams: Record<string, unknown> = {
      approved_json_path: capped,
      out_dir: ctx.dirArg,
      source_text_paths: sourceTextPaths,
    };
    if (umOn) socialParams.use_melhor_post_path = ctx.e("_internal/use-melhor-post.json");
    writerOutputs.push(ctx.e("_internal/03-social.tmp.md"), ctx.e("_internal/03-curto.tmp.md"));
    pending.push({
      step: "2a",
      agent: "social-writer",
      description: "Etapa 2 — Social writer (texto único LinkedIn/Facebook/Instagram)",
      params: { ...socialParams, out_path: ctx.e("_internal/03-social.tmp.md") },
      detail: "Seções ## d1..dN + ## d{N}-cards (+ ## um com use_melhor_post_path). Não gerar ## post_pixel (#9568).",
    });
    pending.push({
      step: "2a",
      agent: "social-curto",
      description: "Etapa 2 — Twitter/Threads writer (texto curto único)",
      params: { ...socialParams, out_path: ctx.e("_internal/03-curto.tmp.md") },
      detail: "≤280 ponderados, CTA 'Mais em {edition_url}' literal (#4285). Ausência é warn-only (#3992).",
    });
  }

  writeRunState(ctx.editionDir, {
    curtoDispatch: pending.find((d) => d.agent === "social-curto") ?? null,
    edition,
    scope: ctx.opts.scope,
    mode,
    destaqueCount: n,
    writersDispatchAt: dispatchAt,
    noGates: ctx.opts.noGates,
    writerOutputs,
    youtubeResearchOk: youtubeOk,
  });

  const deadline = clariceDeadline(ctx);
  return result(ctx, 0, {
    mode,
    nextPhase: "post-writers",
    pendingAgentDispatch: pending,
    dispatchTogether: true,
    clarice: { ...deadline },
  });
}

// ---------------------------------------------------------------------------
// Fase post-writers.
// ---------------------------------------------------------------------------

function loadState(ctx: Ctx): RunState {
  let st: RunState | null;
  try {
    st = readRunState(ctx.editionDir);
  } catch (err) {
    if (!(err instanceof RunStateUnreadableError)) throw err;
    ctx.log("error", "estado da Etapa 2 ilegível — fase abortada sem sobrescrever", { path: err.path, cause: err.cause });
    throw new Stage2Abort(
      `${err.message} em ${err.path} — NÃO rodar --phase pre-dispatch (sobrescreve clariceDone/poolApplied e re-despacha os writers); corrigir ou restaurar o JSON e re-rodar esta fase.`,
    );
  }
  if (!st) throw new Stage2Abort(`estado ${RUN_STATE_FILE} ausente — rodar --phase pre-dispatch antes.`);
  if (!ctx.opts.scopeExplicit) {
    // fase chamada sem --scope: herda o do pre-dispatch.
    (ctx.opts as { scope: Scope }).scope = st.scope;
  } else if (st.scope !== ctx.opts.scope) {
    ctx.note(`--scope ${ctx.opts.scope} na linha de comando vence o escopo gravado (${st.scope}).`);
  }
  if (st.noGates && !ctx.opts.noGates) {
    // `--no-gates` do pre-dispatch vale nos re-runs (#14084).
    (ctx.opts as { noGates: boolean }).noGates = true;
    ctx.note("--no-gates herdado do pre-dispatch.");
  }
  return st;
}

/** Teto da Clarice da newsletter; avisa no gate quando degradado ou com preflight-state ilegível. */
function clariceDeadline(ctx: Ctx): ClariceStage2Deadline {
  const d = resolveClariceStage2DeadlineForEdition(ctx.editionDir);
  if (d.degraded) ctx.gateNotes.push(`Clarice: ${d.reason}`);
  if (d.stateError) {
    ctx.gateNotes.push(`⚠️  Clarice: ${d.reason}`);
    ctx.log("warn", "preflight-state ilegível — teto da Clarice no default", { stateError: d.stateError });
  }
  return d;
}

function phasePostWriters(ctx: Ctx): Stage2RunResult {
  const st = loadState(ctx);
  const mustVerify = (st.writerOutputs ?? []).filter((p) => !p.endsWith("03-curto.tmp.md"));
  if (mustVerify.length > 0) {
    const v = ctx.run("verify-agent-outputs (writers + social)", "scripts/verify-agent-outputs.ts", [
      "--agent",
      "stage2-writers",
      "--since",
      st.writersDispatchAt ?? "",
      "--paths",
      mustVerify.join(","),
    ]);
    if (v.code !== 0) {
      const bad = (parseStepJson<{ results?: Array<{ path: string; status: string }> }>(v.stdout)?.results ?? []).filter((r) => r.status !== "ok");
      ctx.fixes.push({
        check: "verify-agent-outputs",
        action: "re-disparar SÓ o agente de cada arquivo listado (mesmo prompt) e re-rodar --phase post-writers; 2ª falha: gravar o bloco colado na resposta",
        detail: bad.length ? bad : v.stderr.trim(),
      });
      return fixNeeded(ctx, "post-writers", { mode: st.mode });
    }
  }

  // Curto (#3992): 1ª ausência → re-dispatch do social-curto; 2ª → warn-only, no gate.
  const curto = (st.writerOutputs ?? []).find((p) => p.endsWith("03-curto.tmp.md"));
  if (ctx.social && curto) {
    const v = ctx.run("verify-agent-outputs (social-curto)", "scripts/verify-agent-outputs.ts", [
      "--agent",
      "social-curto",
      "--since",
      st.writersDispatchAt ?? "",
      "--paths",
      curto,
    ]);
    if (v.code !== 0) {
      st.curtoMissingCount = (st.curtoMissingCount ?? 0) + 1;
      if (st.curtoMissingCount === 1) {
        writeRunState(ctx.editionDir, st);
        ctx.fixes.push({
          check: "verify-agent-outputs (social-curto)",
          action: "re-disparar SÓ o social-curto (mesmo prompt do pre-dispatch) e re-rodar --phase post-writers; na 2ª ausência vira aviso (#3992)",
          detail: v.stderr.trim() || v.stdout.trim(),
        });
        return fixNeeded(ctx, "post-writers", {
          mode: st.mode,
          pendingAgentDispatch: st.curtoDispatch ? [st.curtoDispatch] : [],
        });
      }
      st.curtoWarn =
        "⚠️  # Curto ausente depois de 2 tentativas do social-curto: X (Buffer) e Threads vão pular os posts desta edição (#3992/#4294).";
      ctx.gateNotes.push(st.curtoWarn);
      ctx.log("warn", "03-curto.tmp.md ausente na 2ª tentativa — # Curto omitido");
    } else {
      st.curtoWarn = null;
    }
    writeRunState(ctx.editionDir, st);
  }

  if (ctx.newsletter && st.mode === "parallel") {
    ctx.must("stitch-newsletter", "scripts/stitch-newsletter.ts", ["--edition-dir", ctx.dirArg]);
  }
  if (ctx.opts.scope === "all") {
    ctx.must("validate-stage-2-outputs", "scripts/validate-stage-2-outputs.ts", ["--edition-dir", ctx.dirArg]);
  }
  if (ctx.social) {
    ctx.must("merge-social-md", "scripts/merge-social-md.ts", ["--edition-dir", ctx.dirArg]);
    const hdr = ctx.run("lint-social-md platform-headers-unicos", "scripts/lint-social-md.ts", [
      "--check",
      "platform-headers-unicos",
      "--md",
      ctx.e("03-social.md"),
    ]);
    if (hdr.code !== 0) {
      throw new Stage2Abort(
        `# Social duplicado em 03-social.md (#3388) — remover o header extra e, se veio do social-writer, ajustar o prompt dele: ${(hdr.stderr || hdr.stdout).trim().slice(0, 400)}`,
      );
    }
  }

  const pending: PendingAgentDispatch[] = [];
  let poolDispatchAt: string | null = null;
  if (ctx.newsletter) {
    const input = ctx.soft("pool-descriptions --input", "scripts/pool-descriptions.ts", ["--input", "--edition-dir", ctx.dirArg]);
    const parsed = parseStepJson<{ input_path?: string; items?: number }>(input.stdout);
    if (input.code === 0 && parsed && (parsed.items ?? 0) > 0) {
      poolDispatchAt = ctx.deps.now().toISOString();
      pending.push({
        step: "2a-pool",
        agent: "writer-pool",
        description: "Etapa 2 — descrição do pool a partir do texto lido",
        params: { input_path: parsed.input_path, out_path: ctx.e("_internal/02-pool-descriptions.json") },
        detail: "Síncrono (#9223). Itens em `skipped[]` ficam com a descrição do summary.",
      });
    } else {
      ctx.note("pool-descriptions: nenhum item para o writer-pool — passo pulado.");
    }
  }
  writeRunState(ctx.editionDir, { ...st, poolDispatchAt, poolApplied: false });
  return result(ctx, 0, { mode: st.mode, nextPhase: "post-pool", pendingAgentDispatch: pending });
}

// ---------------------------------------------------------------------------
// Fase post-pool.
// ---------------------------------------------------------------------------

const NEWSLETTER_HUMANIZER_PROMPT = (edir: string): string =>
  `Invoque a skill humanizador (Skill tool) e siga os 9 passos. Leia ${edir}/_internal/02-normalized.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions-recent.md como referência, e salve o resultado em ${edir}/_internal/02-humanized.md. ETAPA 0: itens de LANÇAMENTOS/RADAR/USE MELHOR com a descrição marcada [TRADUZIR] têm só a DESCRIÇÃO traduzida para PT-BR e o prefixo removido; o título/link nunca é traduzido (#1634); em LANÇAMENTOS com título genérico, a descrição cita o fabricante pelo domínio (#12595). Preservar template, seções, links e URLs; sem markdown.`;

const SOCIAL_HUMANIZER_PROMPT = (edir: string): string =>
  `Invoque a skill humanizador (Skill tool). Leia ${edir}/03-social.md, humanize o texto removendo marcas de IA em português, calibrando a voz com data/past-editions-recent.md como referência. Rode os 9 passos completos. Meta quantitativa do padrão #20: zero travessões no output (exceção: diálogo e meia-risca numérica). A 1ª frase de cada ## d{N} e do 1º parágrafo de cada ## d{N}-cards precisa se sustentar sozinha: ao cortar atribuição vaga ou referência temporal, nunca deixe a frase abrindo com 'O estudo', 'A empresa', 'O modelo', 'Isso' ou 'Essa' sem o sujeito ter sido nomeado antes; nomeie o sujeito concreto. Preservar hashtags, emojis, a estrutura de seções (# Social, ## d1..dN, ## d{N}-cards, ## um, # Curto) e as URLs. Salve no mesmo arquivo.`;

function phasePostPool(ctx: Ctx): Stage2RunResult {
  const st = loadState(ctx);
  if (ctx.newsletter && ctx.opts.restitch) {
    // Conserto de lint (#14084 review): o writer re-despachado regravou o
    // draft do destaque; refaz só o stitch e reaplica as descrições do pool já
    // escritas pelo writer-pool, sem novo dispatch dele nem refazer post-writers.
    if (st.mode === "parallel") ctx.must("stitch-newsletter (restitch)", "scripts/stitch-newsletter.ts", ["--edition-dir", ctx.dirArg]);
    if (st.poolApplied && existsSync(ctx.p("_internal/02-pool-descriptions.json"))) {
      ctx.soft("pool-descriptions --apply (restitch)", "scripts/pool-descriptions.ts", ["--apply", "--edition-dir", ctx.dirArg]);
    }
  } else if (ctx.newsletter && st.poolDispatchAt) {
    const out = ctx.e("_internal/02-pool-descriptions.json");
    const v = ctx.run("verify-agent-outputs (writer-pool)", "scripts/verify-agent-outputs.ts", [
      "--agent",
      "writer-pool",
      "--since",
      st.poolDispatchAt,
      "--paths",
      out,
    ]);
    if (v.code === 0) {
      ctx.soft("pool-descriptions --apply", "scripts/pool-descriptions.ts", ["--apply", "--edition-dir", ctx.dirArg]);
      st.poolApplied = true;
      writeRunState(ctx.editionDir, st);
    } else {
      ctx.note("⚠️  writer-pool não gravou 02-pool-descriptions.json — descrições do summary mantidas.");
      ctx.log("warn", "writer-pool output ausente — pool-descriptions --apply pulado");
    }
  }

  const pending: PendingAgentDispatch[] = [];
  if (ctx.newsletter) {
    const lint = ctx.run("lint-newsletter-md --stage 2", "scripts/lint-newsletter-md.ts", ["--stage", "2", "--json", "--edition-dir", ctx.editionDir]);
    const parsed = parseStepJson<{ passed?: boolean; checks?: Array<{ id: string; ok: boolean; result?: unknown }> }>(lint.stdout);
    if (!parsed || parsed.passed === false) {
      const failed = (parsed?.checks ?? []).filter((c) => !c.ok);
      ctx.fixes.push({
        check: "lint-newsletter-md --stage 2",
        action:
          "re-disparar só o writer-destaque/writer de cada check falho com a instrução do playbook (§2b, por id) e re-rodar --phase post-pool --restitch (refaz o stitch e reaplica o pool, sem novo writer-pool)",
        detail: failed.length ? failed : (lint.stderr || lint.stdout).trim().slice(0, 600),
      });
      return fixNeeded(ctx, "post-pool", { mode: st.mode, rerunArgs: ["--restitch"] });
    }

    const draft = ctx.e("_internal/02-draft.md");
    const normalized = ctx.e("_internal/02-normalized.md");
    const norm = ctx.run("normalize-newsletter", "scripts/normalize-newsletter.ts", ["--in", draft, "--out", normalized]);
    writeFileSync(ctx.p("_internal/02-normalize-report.json"), norm.stderr, "utf8");
    if (norm.code !== 0 || !existsSync(ctx.p("_internal/02-normalized.md"))) {
      // Vai ao gate e ao run-log (#14094): o humanizador roda sobre o draft cru.
      st.normalizeWarn = `⚠️  normalize-newsletter falhou (exit ${norm.code}) — 02-normalized.md é cópia do draft; humanizador e Clarice rodam sobre texto não normalizado.`;
      ctx.note(st.normalizeWarn);
      ctx.gateNotes.push(st.normalizeWarn);
      ctx.log("warn", "normalize-newsletter falhou — 02-normalized.md = cópia do draft", {
        exit: norm.code,
        stderr: norm.stderr.trim().slice(0, 600),
      });
      copyFileSync(ctx.p("_internal/02-draft.md"), ctx.p("_internal/02-normalized.md"));
    } else {
      st.normalizeWarn = null;
    }
    ctx.soft("singularize-md-sections", "scripts/singularize-md-sections.ts", ["--md", normalized]);
    pending.push({
      step: "2b-humanize",
      agent: "adhoc-opus-low",
      description: `Humanizar newsletter ${ctx.opts.edition}`,
      params: { in_path: normalized, out_path: ctx.e("_internal/02-humanized.md"), prompt: NEWSLETTER_HUMANIZER_PROMPT(ctx.editionDir.replace(/[\\/]+$/, "")) },
      detail: "Grava 02-humanized.md (o post-humanize recusa ausente ou byte-idêntico ao 02-normalized.md, #1072).",
    });
  }
  if (ctx.social) {
    copyFileSync(ctx.p("03-social.md"), ctx.p("_internal/03-social-pre-humanizador.md"));
    pending.push({
      step: "2c-humanize",
      agent: "adhoc-opus-low",
      description: `Humanizar social ${ctx.opts.edition}`,
      params: { in_path: ctx.e("03-social.md"), out_path: ctx.e("03-social.md"), prompt: SOCIAL_HUMANIZER_PROMPT(ctx.editionDir.replace(/[\\/]+$/, "")) },
      detail: "In-place. Snapshot pré-humanizador já gravado em _internal/03-social-pre-humanizador.md.",
    });
  }
  // Humanizadores novos invalidam Clarice e checagens de uma rodada anterior.
  writeRunState(ctx.editionDir, {
    ...st,
    humanizeDispatchAt: ctx.deps.now().toISOString(),
    clariceDone: undefined,
    clariceWarns: [],
    postChecksDone: false,
  });
  return result(ctx, 0, { mode: st.mode, nextPhase: "post-humanize", pendingAgentDispatch: pending, dispatchTogether: true });
}

// ---------------------------------------------------------------------------
// Fase post-humanize (Clarice).
// ---------------------------------------------------------------------------

/** Orçamento das duas Clarices numa chamada: a Bash tool corta em 600 s. */
export const CLARICE_PHASE_BUDGET_MS = 540_000;

export type SocialClaricePlan = { mode: "inline"; deadlineMs: number } | { mode: "own-call"; remainingMs: number };

/**
 * Onde roda a Clarice do social depois da da newsletter (#14093). Ela só roda
 * na mesma chamada quando o que sobra do orçamento da fase ainda cabe o teto
 * inteiro (`baseDeadlineMs`, 480 s); senão vai para uma chamada Bash própria
 * (`--social-clarice-only`), com o teto inteiro, como antes do runner. Nunca
 * recebe uma sobra encolhida: o social não tem `resume` no Stage 4 e estourar
 * o teto é halt. No dia rápido (newsletter abaixo de 60 s) nada muda.
 */
export function planSocialClarice(baseDeadlineMs: number, newsletterElapsedMs: number): SocialClaricePlan {
  const remainingMs = CLARICE_PHASE_BUDGET_MS - Math.max(0, newsletterElapsedMs);
  return remainingMs >= baseDeadlineMs ? { mode: "inline", deadlineMs: baseDeadlineMs } : { mode: "own-call", remainingMs };
}

function failureLine(stdout: string): string {
  const lines = stdout.trim().split(/\r?\n/).reverse();
  for (const l of lines) {
    const j = parseStepJson<{ failure?: { kind?: string; message?: string } }>(l);
    if (j?.failure) return `${j.failure.kind ?? "?"}: ${j.failure.message ?? ""}`;
  }
  return "";
}

const CLARICE_HALT_REASON: Record<number, string> = {
  2: "CLARICE_API_KEY ausente",
  3: "Clarice REST: HTTP non-2xx, timeout, rede ou TLS depois das tentativas",
  5: "Clarice REST: guard de staleness do --corrected-out (#5755)",
};

function socialHeadersOk(text: string, destaqueCount: number): boolean {
  if (!/^# Social\s*$/m.test(text)) return false;
  for (let dn = 1; dn <= Math.min(Math.max(destaqueCount, 1), 3); dn++) {
    if (!new RegExp(`^## d${dn}\\s*$`, "m").test(text)) return false;
  }
  return true;
}

function phasePostHumanize(ctx: Ctx): Stage2RunResult {
  const st = loadState(ctx);
  const deadline = clariceDeadline(ctx);
  const clarice: NonNullable<Stage2RunResult["clarice"]> = { ...deadline };

  // `--social-clarice-only`: retomada depois de um halt da Clarice do social —
  // humanizadores e Clarice da newsletter já passaram nesta edição.
  const socialOnly = ctx.opts.socialClariceOnly;
  if (socialOnly && !ctx.social) throw new Stage2Abort("--social-clarice-only exige escopo com social.");

  // 1. Os humanizadores gravaram de verdade?
  if (ctx.newsletter && !socialOnly) {
    const humanized = ctx.p("_internal/02-humanized.md");
    if (!freshNonEmpty(humanized, st.humanizeDispatchAt) || sameContent(humanized, ctx.p("_internal/02-normalized.md"))) {
      ctx.fixes.push({
        check: "humanizer-newsletter",
        action: "re-disparar o humanizador da newsletter (até 3 tentativas, #1072; na 3ª falha, halt) e re-rodar --phase post-humanize",
        detail: "02-humanized.md ausente, antigo ou byte-idêntico ao 02-normalized.md",
      });
    }
  }
  if (ctx.social && !socialOnly) {
    const pre = ctx.e("_internal/03-social-pre-humanizador.md");
    const cov = ctx.run("lint-social-md humanizer-section-coverage", "scripts/lint-social-md.ts", [
      "--check",
      "humanizer-section-coverage",
      "--pre",
      pre,
      "--md",
      ctx.e("03-social.md"),
    ]);
    if (sameContent(ctx.p("_internal/03-social-pre-humanizador.md"), ctx.p("03-social.md")) || cov.code !== 0) {
      ctx.fixes.push({
        check: "humanizer-social",
        action: "re-disparar o humanizador do social mirando as seções listadas (até 3 tentativas, #1072/#2148) e re-rodar --phase post-humanize",
        detail: (cov.stdout || cov.stderr).trim().slice(0, 600) || "03-social.md byte-idêntico ao pré-humanizador",
      });
    }
  }
  if (ctx.fixes.length > 0) return fixNeeded(ctx, "post-humanize", { clarice });

  // 2. Clarice da newsletter (antes do social, em série — #4952).
  let newsletterElapsed = 0;
  if (ctx.newsletter && !socialOnly) {
    ctx.must("resolve-clarice-input", "scripts/resolve-clarice-input.ts", ["--edition-dir", ctx.dirArg]);
    const inputName = readFileSync(ctx.p("_internal/02-clarice-input.txt"), "utf8").trim();
    copyFileSync(ctx.p(`_internal/${inputName}`), ctx.p("_internal/02-pre-clarice.md"));
    if (!existsSync(ctx.p("_internal/02-pre-clarice.md"))) {
      ctx.log("error", "pre-clarice snapshot missing — aborting before Clarice call");
      throw new Stage2Abort("snapshot pré-Clarice ausente — re-rodar a Etapa 2 do zero.");
    }
    const t0 = ctx.deps.now().getTime();
    const r = ctx.run(`clarice-correct (newsletter, teto ${deadline.deadlineMs / 1000}s)`, "scripts/clarice-correct.ts", [
      "--in",
      ctx.e(`_internal/${inputName}`),
      "--out",
      ctx.e("_internal/02-clarice-suggestions.json"),
      "--corrected-out",
      ctx.e("_internal/02-clarice-corrected.md"),
      "--retry",
      "--edition",
      ctx.opts.edition,
      "--deadline-ms",
      String(deadline.deadlineMs),
    ]);
    newsletterElapsed = ctx.deps.now().getTime() - t0;
    if (r.code === 0) {
      copyFileSync(ctx.p("_internal/02-clarice-corrected.md"), ctx.p("02-reviewed.md"));
      ctx.soft("clarice-diff (newsletter)", "scripts/clarice-diff.ts", [
        ctx.e("_internal/02-pre-clarice.md"),
        ctx.e("02-reviewed.md"),
        ctx.e("_internal/02-clarice-diff.md"),
        ctx.e("_internal/02-normalized.md"),
      ]);
      ctx.soft("clarice-pending clear", "scripts/clarice-pending.ts", ["clear", "--edition-dir", ctx.dirArg, "--edition", ctx.opts.edition]);
      clarice.newsletter = "applied";
    } else if (r.code === 6) {
      const skip = ctx.run("clarice-pending skip (clarice_unavailable)", "scripts/clarice-pending.ts", [
        "skip",
        "--edition-dir",
        ctx.dirArg,
        "--reason",
        "clarice_unavailable",
        "--edition",
        ctx.opts.edition,
      ]);
      if (skip.code !== 0) {
        return halt(ctx, `clarice-pending skip recusado (exit ${skip.code}): ${skip.stderr.trim().slice(0, 300)}`, "conferir 02-pre-clarice.md / 02-reviewed.md e responder 'retry' ou 'abort'");
      }
      clarice.newsletter = "unavailable-skipped";
      ctx.gateNotes.push(
        `clarice não rodou (clarice_unavailable): retomar com npx tsx scripts/clarice-pending.ts resume --edition-dir ${ctx.dirArg} --edition ${ctx.opts.edition}`,
      );
    } else {
      const why = CLARICE_HALT_REASON[r.code] ?? `clarice-correct exit ${r.code}`;
      const detail = failureLine(r.stdout);
      return halt(ctx, `${why}${detail ? ` — ${detail}` : ""}`, "corrigir e responder 'retry' (re-rodar --phase post-humanize) ou aprovar o skip consciente (#2320)");
    }
  }

  // Grava já a newsletter: um halt do social não pode apagar que ela rodou
  // (a retomada `--social-clarice-only` não a refaz).
  if (clarice.newsletter) {
    st.clariceDone = { ...(st.clariceDone ?? {}), newsletter: clarice.newsletter };
    st.clariceWarns = [...new Set([...(st.clariceWarns ?? []), ...ctx.gateNotes])];
    writeRunState(ctx.editionDir, st);
  }

  // 3. Clarice do social.
  if (ctx.social) {
    // O teto degradado (90 s) é só da newsletter, a única com `resume` no
    // Stage 4 (#14084): o social usa sempre o teto normal de 480 s inteiro.
    // Se a Clarice da newsletter comeu o orçamento a ponto de não caber, o
    // social vai para uma chamada Bash própria (#14093) em vez de rodar com a
    // sobra; na retomada `--social-clarice-only` vale o override.
    let socialDeadline = ctx.opts.deadlineMsOverride ?? CLARICE_NORMAL_DEADLINE_MS;
    if (!socialOnly && ctx.newsletter && clarice.newsletter) {
      const plan = planSocialClarice(CLARICE_NORMAL_DEADLINE_MS, newsletterElapsed);
      if (plan.mode === "own-call") {
        ctx.note(
          `Clarice da newsletter levou ${Math.round(newsletterElapsed / 1000)}s; sobram ${Math.round(plan.remainingMs / 1000)}s do orçamento da fase, menos que o teto de ${CLARICE_NORMAL_DEADLINE_MS / 1000}s do social: a Clarice do social roda numa chamada própria (#14093).`,
        );
        ctx.fixes.push({
          check: "clarice-social-own-call",
          action: `re-rodar npx tsx scripts/stage-2-run.ts --phase post-humanize --edition ${ctx.opts.edition} --social-clarice-only numa chamada Bash própria (timeout 600000); nada a corrigir, a newsletter já ficou resolvida`,
          detail: `newsletter ${Math.round(newsletterElapsed / 1000)}s, sobra ${Math.round(plan.remainingMs / 1000)}s < ${CLARICE_NORMAL_DEADLINE_MS / 1000}s`,
        });
        return fixNeeded(ctx, "post-humanize", { rerunArgs: ["--social-clarice-only"], clarice });
      }
      socialDeadline = plan.deadlineMs;
    }
    copyFileSync(ctx.p("03-social.md"), ctx.p("_internal/03-social-post-humanizador.md"));
    const r = ctx.run(`clarice-correct (social, teto ${Math.round(socialDeadline / 1000)}s)`, "scripts/clarice-correct.ts", [
      "--in",
      ctx.e("03-social.md"),
      "--out",
      ctx.e("_internal/03-clarice-suggestions.json"),
      "--corrected-out",
      ctx.e("_internal/03-clarice-corrected.md"),
      "--retry",
      "--edition",
      ctx.opts.edition,
      "--deadline-ms",
      String(socialDeadline),
    ]);
    let clariceNote: string | undefined;
    if (r.code === 0) {
      const corrected = readFileSync(ctx.p("_internal/03-clarice-corrected.md"), "utf8");
      if (!socialHeadersOk(corrected, st.destaqueCount)) {
        clarice.social = "headers-lost-kept-humanized";
        clariceNote = "Clarice removeu cabeçalho do social — texto humanizado mantido";
        ctx.gateNotes.push("⚠️  Clarice do social removeu # Social/## dN — mantido o texto humanizado, sem a correção.");
      } else {
        writeFileSync(ctx.p("03-social.md"), corrected, "utf8");
        clarice.social = sameContent(ctx.p("03-social.md"), ctx.p("_internal/03-social-post-humanizador.md")) ? "no-suggestions" : "applied";
        if (clarice.social === "no-suggestions") clariceNote = "Clarice sem sugestões";
      }
      ctx.soft("clarice-diff (social)", "scripts/clarice-diff.ts", [
        ctx.e("_internal/03-social-post-humanizador.md"),
        ctx.e("03-social.md"),
        ctx.e("_internal/03-social-clarice-diff.md"),
        ctx.e("_internal/03-social-pre-humanizador.md"),
      ]);
    } else {
      // Social sem Clarice nunca vira skip silencioso (review da #14084): o
      // `clarice-pending resume` do Stage 4 cobre só a newsletter, então
      // qualquer falha aqui — inclusive o exit 6 — é halt, como no playbook
      // (retry 3x + abort). A newsletter já ficou resolvida acima; a retomada
      // refaz só esta Clarice.
      const why =
        r.code === 6
          ? `Clarice indisponível no social (clarice_unavailable, teto ${Math.round(socialDeadline / 1000)}s)`
          : (CLARICE_HALT_REASON[r.code] ?? `clarice-correct exit ${r.code}`);
      const detail = failureLine(r.stdout);
      // Dia degradado (#14093): o halt segue (o social nunca pula a Clarice em
      // silêncio), mas o banner diz que o ping real do Stage 0 já tinha falhado.
      const degradedHint = deadline.degraded ? " (o ping real da Clarice já tinha falhado no Stage 0: API degradada hoje)" : "";
      return halt(
        ctx,
        `social: ${why}${detail ? ` — ${detail}` : ""}${degradedHint}`,
        `responder 'retry' (re-rodar npx tsx scripts/stage-2-run.ts --phase post-humanize --edition ${ctx.opts.edition} --social-clarice-only) ou 'abort'`,
      );
    }
    ctx.soft("check-humanizer-social --record-run humanizador", "scripts/check-humanizer-social.ts", [
      "--record-run",
      "--step",
      "humanizador",
      "--pre",
      ctx.e("_internal/03-social-pre-humanizador.md"),
      "--post",
      ctx.e("_internal/03-social-post-humanizador.md"),
      "--edition-dir",
      ctx.dirArg,
    ]);
    ctx.soft("check-humanizer-social --record-run clarice", "scripts/check-humanizer-social.ts", [
      "--record-run",
      "--step",
      "clarice",
      "--pre",
      ctx.e("_internal/03-social-post-humanizador.md"),
      "--post",
      ctx.e("03-social.md"),
      "--edition-dir",
      ctx.dirArg,
      ...(clariceNote ? ["--note", clariceNote] : []),
    ]);
    ctx.soft("check-humanizer-social --write", "scripts/check-humanizer-social.ts", ["--write", "--edition-dir", ctx.dirArg]);
  }

  // A fase termina aqui (#14084): duas Clarices + post-checks numa chamada
  // podiam passar dos 600 s da Bash tool. Os post-checks são a próxima chamada.
  const prev = st.clariceDone ?? {};
  writeRunState(ctx.editionDir, {
    ...st,
    clariceDone: {
      newsletter: ctx.newsletter ? (clarice.newsletter ?? prev.newsletter) : prev.newsletter,
      social: ctx.social ? (clarice.social ?? prev.social) : prev.social,
    },
    // Os avisos desta fase são todos da Clarice; somados aos de uma rodada
    // anterior (a retomada `--social-clarice-only` não refaz a newsletter).
    clariceWarns: [...new Set([...(st.clariceWarns ?? []), ...ctx.gateNotes])],
    postChecksDone: false,
  });
  return result(ctx, 0, { mode: st.mode, nextPhase: "post-checks", clarice });
}

// ---------------------------------------------------------------------------
// Fase post-checks.
// ---------------------------------------------------------------------------

function runPostChecks(ctx: Ctx, st: RunState): Stage2RunResult {
  if (ctx.newsletter) {
    const reviewed = ctx.e("02-reviewed.md");
    ctx.must("strip-emdashes-reviewed", "scripts/strip-emdashes-reviewed.ts", ["--edition-dir", ctx.editionDir]);
    const eia = ctx.run("sync-eia-block", "scripts/sync-eia-block.ts", ["--edition-dir", ctx.editionDir]);
    if (eia.code === 4) ctx.soft("sync-eia-block --from 01", "scripts/sync-eia-block.ts", ["--edition-dir", ctx.editionDir, "--from", "01"]);
    else if (eia.code !== 0) ctx.note(`⚠️  sync-eia-block saiu ${eia.code} — fail-soft.`);
    const urls = ctx.run("verify-clarice-url-stability", "scripts/verify-clarice-url-stability.ts", ["--pre", ctx.e("_internal/02-pre-clarice.md"), "--post", reviewed]);
    if (urls.code !== 0) ctx.gateNotes.push(`⚠️  URL de LANÇAMENTOS mudou pós-Clarice (#873): ${(urls.stdout || urls.stderr).trim().slice(0, 600)}`);
    const coupons = ctx.run("verify-clarice-coupons", "scripts/verify-clarice-coupons.ts", ["--pre", ctx.e("_internal/02-normalized.md"), "--post", reviewed]);
    if (coupons.code !== 0) ctx.gateNotes.push(`⚠️  cupom/link de afiliado mudou pós-LLM (#1982): ${(coupons.stdout || coupons.stderr).trim().slice(0, 600)}`);
    ctx.soft("sync-intro-count", "scripts/sync-intro-count.ts", ["--md", reviewed, "--lancamentos-removed", ctx.e("_internal/02-lancamentos-removed.json")]);
    const lanc = ctx.run("validate-lancamentos (reviewed)", "scripts/validate-lancamentos.ts", [reviewed]);
    if (lanc.code !== 0) ctx.gateNotes.push(`⚠️  LANÇAMENTOS fora da regra oficial (#160/#1968): ${(lanc.stdout || lanc.stderr).trim().slice(0, 600)}`);
    // #14244: a receita antiga rodava validate-domains no draft sem regra de
    // re-dispatch (ao contrário dos lints vizinhos); aqui vira aviso no gate,
    // como validate-lancamentos. Exit 1 = paywall/agregador; outro = não leu.
    const doms = ctx.run("validate-domains (reviewed)", "scripts/validate-domains.ts", [reviewed]);
    if (doms.code === 1) {
      ctx.gateNotes.push(`⚠️  link de paywall/agregador no 02-reviewed.md (#701), trocar por fonte primária: ${(doms.stderr || doms.stdout).trim().slice(0, 600)}`);
      ctx.log("warn", "validate-domains: paywall/agregador no 02-reviewed.md", { stdout: doms.stdout.trim().slice(0, 600) });
    } else if (doms.code !== 0) {
      ctx.gateNotes.push(`⚠️  validate-domains não rodou (exit ${doms.code}): paywall/agregador não conferidos.`);
    }
    ctx.soft("sync-coverage-line", "scripts/sync-coverage-line.ts", ["--edition-dir", ctx.dirArg]);
    ctx.must("render-erro-intencional", "scripts/render-erro-intencional.ts", ["--edition", ctx.opts.edition, "--md", reviewed]);
    if (ctx.opts.noGates) {
      const plant = ctx.run("plant-intentional-error (headless)", "scripts/plant-intentional-error.ts", ["--edition-dir", ctx.dirArg]);
      if (plant.code !== 0) {
        ctx.fixes.push({
          check: "plant-intentional-error",
          action: /history_unreadable/.test(plant.stdout)
            ? "liberar data/intentional-errors.jsonl (lock) e re-rodar --phase post-checks; NÃO montar à mão"
            : "montar o erro à mão com o filtro #3808/#5742 (sem perguntar) e re-rodar --phase post-checks",
          detail: plant.stdout.trim().slice(0, 400),
        });
      }
    } else {
      ctx.gateNotes.push("Erro intencional: propor candidata pronta para aceite no gate (filtro #3808/#5742).");
    }
    const inv = ctx.run("check-stage2-invariants", "scripts/check-stage2-invariants.ts", ["--edition-dir", ctx.dirArg]);
    if (inv.code !== 0) {
      ctx.fixes.push({
        check: "check-stage2-invariants",
        action: "corrigir o(s) check(s) listado(s) e re-rodar --phase post-checks",
        detail: (inv.stderr || inv.stdout).trim().slice(0, 800),
      });
    }
  }

  if (ctx.social) {
    const nums = ctx.run("lint-social-numbers", "scripts/lint-social-numbers.ts", [
      "--social",
      ctx.e("03-social.md"),
      "--approved",
      ctx.e("_internal/01-approved-capped.json"),
    ]);
    const numsOut = (nums.stdout || "").trim();
    if (/US\$|R\$|€/.test(numsOut)) ctx.gateNotes.push(`⚠️  cifra(s) do social não encontradas na fonte (#1711), confira: ${numsOut.slice(0, 600)}`);
    const sl = ctx.run("lint-social-md --stage 2", "scripts/lint-social-md.ts", ["--stage", "2", "--json", "--edition-dir", ctx.editionDir]);
    const parsed = parseStepJson<{ passed?: boolean; checks?: Array<{ id: string; ok: boolean; severity?: string; result?: unknown }> }>(sl.stdout);
    const warnFailed = (parsed?.checks ?? []).filter((c) => !c.ok && c.severity !== "error");
    for (const w of warnFailed) ctx.gateNotes.push(`social (warn-only) ${w.id}: ${JSON.stringify(w.result).slice(0, 300)}`);
    if (!parsed || parsed.passed === false) {
      ctx.fixes.push({
        check: "lint-social-md --stage 2",
        action: "curto-x-weight: encurtar só o post apontado; linkedin-schema / no-email-cta-instagram: re-disparar o social-writer; depois re-rodar --phase post-checks",
        detail: (parsed?.checks ?? []).filter((c) => !c.ok && c.severity === "error"),
      });
    }
  }

  if (ctx.opts.scope === "all") {
    const ci = ctx.run("check-invariants --stage 2", "scripts/check-invariants.ts", ["--stage", "2", "--phase", "pre-gate", "--edition-dir", ctx.dirArg]);
    if (ci.code !== 0) {
      ctx.fixes.push({
        check: "check-invariants --stage 2",
        action: "seguir a exceção do playbook por regra (§2d: reviewed-pool-summary-quality, reviewed-section-links-resolve, reviewed-destaque-category-noticias...) e re-rodar --phase post-checks",
        detail: (ci.stdout || ci.stderr).trim().slice(0, 800),
      });
    }
  }
  if (ctx.newsletter) {
    const m = ctx.run("measure-highlights", "scripts/measure-highlights.ts", [ctx.e("02-reviewed.md")]);
    if (m.stderr.trim()) ctx.gateNotes.push(`tamanho dos destaques: ${m.stderr.trim().slice(0, 600)}`);
  }

  if (ctx.fixes.length > 0) {
    writeRunState(ctx.editionDir, { ...st, postChecksDone: false });
    return fixNeeded(ctx, "post-checks", { mode: st.mode });
  }
  writeRunState(ctx.editionDir, { ...st, postChecksDone: true });
  return result(ctx, 0, { mode: st.mode, nextPhase: "post-gate" });
}

function phasePostChecks(ctx: Ctx): Stage2RunResult {
  const st = loadState(ctx);
  const done = st.clariceDone ?? {};
  const missing = [ctx.newsletter && !done.newsletter ? "newsletter" : null, ctx.social && !done.social ? "social" : null].filter(Boolean);
  if (missing.length > 0) {
    throw new Stage2Abort(`Clarice ainda não rodou (${missing.join(", ")}) — rodar --phase post-humanize antes do post-checks.`);
  }
  // Avisos de fases anteriores voltam ao gate (#14084): o gate lê o post-checks.
  for (const w of st.clariceWarns ?? []) ctx.gateNotes.push(w);
  if (st.curtoWarn) ctx.gateNotes.push(st.curtoWarn);
  if (st.normalizeWarn) ctx.gateNotes.push(st.normalizeWarn);
  return runPostChecks(ctx, st);
}

// ---------------------------------------------------------------------------
// Fase post-gate.
// ---------------------------------------------------------------------------

export const STAGE2_SNAPSHOTS = [
  "_internal/02-pre-clarice.md",
  "_internal/02-normalized.md",
  "_internal/02-humanized.md",
  "_internal/02-draft.pre-humanize.md",
  "_internal/03-social-pre-humanizador.md",
];

function phasePostGate(ctx: Ctx): Stage2RunResult {
  const st = loadState(ctx);
  if (!st.postChecksDone) {
    throw new Stage2Abort("post-checks ainda não passou nesta rodada — rodar --phase post-checks (e o gate) antes do post-gate.");
  }
  const reviewed = ctx.e("02-reviewed.md");
  if (ctx.newsletter) {
    const snapshot = ctx.e("_internal/02-pre-title-picker.md");
    if (!ctx.opts.afterTitlePicker) {
      copyFileSync(ctx.p("02-reviewed.md"), ctx.p("_internal/02-pre-title-picker.md"));
      const titles = ctx.run("lint titles-per-highlight", "scripts/lint-newsletter-md.ts", ["--check", "titles-per-highlight", "--md", reviewed]);
      if (titles.code !== 0) {
        const params: Record<string, unknown> = {
          md_path: reviewed,
          out_path: reviewed,
          audience_path: "context/audience-profile.md",
          editorial_rules_path: "context/editorial-rules.md",
          picks_log_path: ctx.e("_internal/02-title-picks.json"),
        };
        if (st.youtubeResearchOk) params.youtube_title_research_path = ctx.e("_internal/youtube-title-research.json");
        writeRunState(ctx.editionDir, { ...st, titlePickerStructurePending: true });
        return result(ctx, 0, {
          mode: st.mode,
          nextPhase: "post-gate",
          pendingAgentDispatch: [
            {
              step: "2d-title-picker",
              agent: "title-picker",
              description: "Escolher título final por destaque (fallback pós-gate)",
              params,
              detail: "Depois re-rodar --phase post-gate --after-title-picker.",
            },
          ],
          // Sem a flag o re-run sobrescreve o snapshot com o texto já mexido
          // e o validate-section-structure nunca roda (#14094).
          rerunArgs: ["--after-title-picker"],
        });
      }
    } else {
      if (st.titlePickerStructurePending) {
        const struct = ctx.run("validate-section-structure", "scripts/validate-section-structure.ts", ["--before", snapshot, "--after", reviewed]);
        if (struct.code !== 0) {
          copyFileSync(ctx.p("_internal/02-pre-title-picker.md"), ctx.p("02-reviewed.md"));
          ctx.gateNotes.push("⚠️ title-picker corrompeu estrutura — 02-reviewed.md restaurado do snapshot. Pode podar 1 título por destaque manualmente.");
        }
        // Consumir antes dos demais checks: retries podem incluir reparos legítimos.
        writeRunState(ctx.editionDir, { ...st, titlePickerStructurePending: false });
      }
      const titles = ctx.run("lint titles-per-highlight (pós title-picker)", "scripts/lint-newsletter-md.ts", ["--check", "titles-per-highlight", "--md", reviewed]);
      if (titles.code !== 0) {
        ctx.fixes.push({
          check: "titles-per-highlight",
          action: "re-apresentar o gate: deletar os títulos excedentes em 02-reviewed.md e re-rodar --phase post-gate --after-title-picker",
          detail: (titles.stderr || titles.stdout).trim().slice(0, 400),
        });
        return fixNeeded(ctx, "post-gate", { mode: st.mode, rerunArgs: ["--after-title-picker"] });
      }
    }
    const fm = ctx.run("validate-frontmatter-yaml", "scripts/validate-frontmatter-yaml.ts", ["--md", reviewed]);
    if (fm.code !== 0) {
      const detail = (fm.stderr || fm.stdout).trim().slice(0, 400);
      if (!ctx.opts.noGates) {
        // Interativo (#14084): o editor ainda está aqui — completar o
        // intentional-error.json antes do sentinel, nunca seguir com placeholder.
        ctx.fixes.push({
          check: "validate-frontmatter-yaml (intentional-error.json)",
          action: "pedir ao editor os campos faltantes do erro intencional (proposta pronta, #3808/#5742), gravar em _internal/intentional-error.json e re-rodar --phase post-gate --after-title-picker",
          detail,
        });
        return fixNeeded(ctx, "post-gate", { mode: st.mode, rerunArgs: ["--after-title-picker"] });
      }
      ctx.gateNotes.push(`intentional-error.json incompleto (#3222): ${detail}`);
    }
    ctx.soft("insert-titulo-subtitulo", "scripts/insert-titulo-subtitulo.ts", ["--in", reviewed]);
  }

  if (ctx.social) {
    const seal = ctx.run("check-humanizer-social --write (pós-gate)", "scripts/check-humanizer-social.ts", ["--write", "--edition-dir", ctx.dirArg]);
    if (seal.code === 3 || seal.code === 4) {
      // #12377 item 1: o editor editou o social no gate e aprovou o texto dele.
      ctx.soft("check-humanizer-social --write --bypass-reason", "scripts/check-humanizer-social.ts", [
        "--write",
        "--edition-dir",
        ctx.dirArg,
        "--bypass-reason",
        "editor editou o social no gate §2d",
        "--unproven-ok",
        "editor aprovou o texto dele no gate §2d",
      ]);
    } else if (seal.code !== 0) {
      ctx.note(`⚠️  check-humanizer-social --write saiu ${seal.code} — o sentinel abaixo acusa se faltar.`);
    }
  }

  const sentinel = ctx.run("pipeline-sentinel write --step 2", "scripts/pipeline-sentinel.ts", [
    "write",
    "--edition",
    ctx.opts.edition,
    "--step",
    "2",
    "--outputs",
    "02-reviewed.md,03-social.md",
  ]);
  if (sentinel.code !== 0) {
    ctx.fixes.push({
      check: "pipeline-sentinel write --step 2",
      action: "ler as violações (check-invariants --stage 2), corrigir e re-rodar --phase post-gate --after-title-picker; só infra (disco/permissão) vira warn",
      detail: (sentinel.stderr || sentinel.stdout).trim().slice(0, 800),
    });
    return fixNeeded(ctx, "post-gate", { mode: st.mode });
  }
  ctx.soft("derive-editor-requests snapshot-stage2", "scripts/derive-editor-requests.ts", ["snapshot-stage2", "--edition", ctx.opts.edition]);
  for (const rel of STAGE2_SNAPSHOTS) {
    const abs = ctx.p(rel);
    if (existsSync(abs)) rmSync(abs);
  }
  return result(ctx, 0, { mode: st.mode, nextPhase: null });
}

// ---------------------------------------------------------------------------
// Orquestração.
// ---------------------------------------------------------------------------

export async function runStage2(argv: string[], deps: Stage2RunDeps): Promise<Stage2RunResult> {
  let opts: Stage2RunOptions;
  try {
    opts = parseStage2RunArgs(argv);
  } catch (err) {
    return {
      code: 1,
      phase: "invalid",
      pendingAgentDispatch: [],
      fixes: [],
      gateNotes: [],
      delegatedSteps: DELEGATED_STEPS,
      notes: [(err as Error).message],
    };
  }
  // #14032: duração de cada sub-script (Clarice, lints, stitch...) num evento
  // `step_timings` do run-log, nunca no stdout. O tempo dos agentes (writers,
  // humanizadores) é o intervalo entre o fim de uma fase e o `started_at` da
  // seguinte.
  const timings = new StepTimingRecorder(deps.clockMs);
  const timedDeps: Stage2RunDeps = { ...deps, exec: timings.wrapExec(deps.exec) };
  try {
    return runStage2Phase(opts, timedDeps);
  } finally {
    emitStepTimings(deps.exec, { edition: opts.edition, stage: "2", agent: "stage-2-run" }, timings.summary(opts.phase));
  }
}

function runStage2Phase(opts: Stage2RunOptions, deps: Stage2RunDeps): Stage2RunResult {
  const resolved = deps.exec("scripts/lib/find-current-edition.ts", ["--resolve", opts.edition]);
  const editionDir = resolved.stdout.trim();
  const ctx = new Ctx(deps, opts, editionDir);
  if (resolved.code !== 0 || !editionDir) {
    ctx.note(`find-current-edition --resolve ${opts.edition} falhou (exit ${resolved.code}).`);
    return result(ctx, 1, { nextPhase: null });
  }
  try {
    switch (opts.phase) {
      case "pre-dispatch":
        return phasePreDispatch(ctx);
      case "post-writers":
        return phasePostWriters(ctx);
      case "post-pool":
        return phasePostPool(ctx);
      case "post-humanize":
        return phasePostHumanize(ctx);
      case "post-checks":
        return phasePostChecks(ctx);
      case "post-gate":
        return phasePostGate(ctx);
    }
  } catch (err) {
    ctx.note(`ERRO: ${(err as Error).message}`);
    return result(ctx, 1, { nextPhase: null });
  }
}

if (isMainModule(import.meta.url)) {
  runStage2(process.argv.slice(2), productionDeps(ROOT)).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.code;
  });
}
