#!/usr/bin/env node
/**
 * stage-3-run.ts (#5415, incremento 2/3 — Stage 3, ESCOPO PARCIAL)
 *
 * Orquestrador DETERMINÍSTICO de parte do Stage 3 (Imagens) do orchestrator
 * diar.ia.br (`.claude/agents/orchestrator-stage-3.md`) — mesmo padrão de
 * `scripts/stage-0-run.ts` (#5415 incremento 1/3), `scripts/clarice-novos-run.ts`
 * (#4941) e `scripts/audience-run.ts` (#5192).
 *
 * ═══════════════════════════════════════════════════════════════════════
 * POR QUE ESCOPO PARCIAL (achado ao vivo, comentário da issue #5415 em
 * 260820 04:13:30 — "a premissa 'Stage 0 e 3 são limpos' não bate com o
 * playbook atual")
 * ═══════════════════════════════════════════════════════════════════════
 *
 * Diferente do que a auditoria original da #5415 assumia, o playbook do
 * Stage 3 INTEIRO não é "sequência fixa de npx tsx sem julgamento": §3a-bis
 * dispatcha `Skill("humanizador", ...)` + `mcp__clarice__correct_text` com
 * um filtro de julgamento semântico explícito ("na dúvida, descartar a
 * correção duvidosa"), e o fim de §3b dispatcha `Agent("image-crop-reviewer",
 * ...)` seguido de um GATE HUMANO real. Nenhum desses três é alcançável de
 * dentro de um `spawnSync` — script Node puro não chama MCP, Skill, Agent,
 * nem para pra esperar resposta do editor.
 *
 * Este script cobre só o MIOLO DETERMINÍSTICO de §3b — a parte que a
 * própria issue já apontava como "geração já é script, sem Agent no meio":
 * lint pre-flight, `image-generate.ts` (2x1 + 4x5 nativo; sem 1x1 desde o #12226) por destaque,
 * composição do card 4:5, fetch do leaderboard, injeção do callout do sorteio (#9236),
 * e as invariantes pré-gate. **Ele roda independente de §3a/§3a-bis** — a
 * geração de imagens de destaque não depende do É IA? ter terminado, só do
 * sentinel da Etapa 2 (destaques escritos).
 *
 * COBERTO:
 *   Assert do sentinel Stage 2 (02-reviewed.md, 03-social.md).
 *   Leitura de destaque_count (`_internal/01-approved-capped.json`).
 *   Checagem de saúde do ComfyUI, quando `platform.config.json.image_generator
 *     === "comfyui"` (HALT se indisponível — mesma severidade do playbook).
 *   Por destaque presente (d1, d2, e d3 só se destaque_count === 3):
 *     lint-image-prompt.ts (em série) e depois image-generate.ts (2x1) e
 *     image-generate.ts --ratio 4x5 (nativo) de TODOS os destaques em
 *     paralelo (#14036; teto `--concurrency N`, default 6; `--serial` volta à
 *     ordem e ao abort na 1ª falha de antes). Falha de lint pausa SÓ aquele
 *     destaque (report, não hard-abort). Falha de `image-generate.ts`
 *     (qualquer ratio) no paralelo é repetida uma vez em série, com `--force`,
 *     se outra imagem passou ou se o stderr indica limite de concorrência
 *     (`shouldRetrySerially`); se persistir, é BLOQUEANTE — para o Stage 3
 *     inteiro, igual ao playbook (#4090), com o destaque/ratio que falhou em
 *     `destaques[].error` e `imageJobs`. Cada filho tem teto de 15 min e, se o
 *     runner receber SIGINT/SIGTERM, a árvore de cada filho vivo é morta por
 *     PID antes de sair.
 *   gen-social-card-4x5.ts (compõe os cards de todos os destaques prontos) —
 *     BLOQUEANTE (#4090) se falhar.
 *   gen-carousel-cards.ts (#6005 Parte B — 3 slides de parágrafo + CTA do
 *     carrossel diário por destaque, a partir de 03-social.md) — BLOQUEANTE
 *     se o render falhar (mesma classe do card 4:5 acima).
 *   fetch-leaderboard-top1.ts — fail-soft (#1753, não-bloqueante).
 *   inject-champions-callout.ts — no-op/injected tratados como sucesso;
 *     exit 1 (raffle stale, #4583) vira HALT, nunca publica data errada.
 *   check-invariants.ts --stage 3 — reportado no resultado (invariantsPassed
 *     + invariantsViolations), NUNCA aborta o script (é pre-gate report, o
 *     gate em si é do orchestrator).
 *   run-image-crop-reviewer.ts em modo DESCOBERTA (sem --input-json) — só a
 *     parte determinística (scan de disco); os pares descobertos voltam em
 *     `cropReviewPairs` no JSON de saída, junto com um `pendingAgentDispatch`
 *     pronto pro orchestrator montar a chamada `Agent("image-crop-reviewer")`.
 *
 * NÃO COBERTO — delegado ao orchestrator, NUNCA simulado aqui (ver
 * `DELEGATED_STEPS` abaixo para o texto completo):
 *   §3a — polling do eia-compose.ts em background + retry/skip em timeout
 *     de 10min (decisão do editor no timeout).
 *   §3a-bis — Skill("humanizador") + mcp__clarice__correct_text + filtro de
 *     julgamento semântico sobre a descrição do É IA?.
 *   §3b (crop-reviewer) — dispatch `Agent("image-crop-reviewer", ...)` e a
 *     chamada `--input-json` que persiste o veredito. Este script só faz a
 *     DESCOBERTA dos pares (devolvidos em `cropReviewPairs`).
 *   §3b (gate humano final) — aprovar/regenerar + escrever o sentinel do
 *     Stage 3 (`pipeline-sentinel.ts write --step 3`) — só acontece DEPOIS
 *     da aprovação do editor, então nunca é responsabilidade deste script.
 *
 * Cada sub-script é invocado por SPAWN (`process.execPath --import tsx`,
 * nunca `npx tsx` — guard #4343), nunca por import.
 *
 * Exit codes:
 *   0 — sucesso (mesmo com destaque(s) pausado(s) por violação de lint, ou
 *       invariantes falhando — isso não é erro do script, é trabalho que o
 *       orchestrator/editor ainda precisa fazer antes do gate)
 *   1 — erro duro (sentinel Stage 2 ausente, sub-script obrigatório com
 *       exit inesperado, `image-generate.ts`/`gen-social-card-4x5.ts`
 *       falhando — BLOQUEANTE #4090)
 *   2 — HALT obrigatório (ComfyUI indisponível quando configurado,
 *       `inject-champions-callout.ts` FATAL por raffle stale #4583 — banner
 *       já renderizado, incluído em `haltRequired` no JSON de saída)
 *
 * Uso:
 *   npx tsx scripts/stage-3-run.ts --edition AAMMDD [--only d1,d2] [--force] [--concurrency N | --serial]
 *
 * @see .claude/agents/orchestrator-stage-3.md (playbook em prosa — este
 *      script cobre só o miolo de §3b; NÃO editado nesta unidade — cutover
 *      do orchestrator é decisão separada, mesmo padrão do stage-0-run.ts)
 * @see scripts/stage-0-run.ts (padrão de referência mais próximo, #5415 1/3)
 * @see scripts/clarice-novos-run.ts (padrão original, #4941)
 */
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";

// Mesma disciplina do #4983 — carregar .env ANTES de qualquer outro código.
loadProjectEnv();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Spawn de sub-script — mesmo helper de stage-0-run.ts.
// ---------------------------------------------------------------------------

export interface StepResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (scriptRelPath: string, args: string[]) => StepResult;

/** Versão assíncrona do `ExecFn` (#14036) — usada só na geração de imagens,
 * que roda em paralelo. Mesmo contrato de retorno. */
export type AsyncExecFn = (scriptRelPath: string, args: string[]) => Promise<StepResult>;

/** #14036: teto por `image-generate.ts`. O Codex tem 300 s próprios
 * (`codex.timeout_seconds`), o fallback outro tanto, mais a compressão. */
export const IMAGE_JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** Mata a ÁRVORE do filho por PID (#5432: nunca por nome de imagem). Windows:
 * `taskkill /T /F /PID`. POSIX: o filho nasce líder de grupo (`detached`) e o
 * grupo inteiro recebe SIGKILL. Mesmo desenho de `killProcessTree` em
 * `scripts/codex-image.js` (#9097), sem importá-lo (ele carrega sharp). */
export function killChildTree(
  pid: number | undefined,
  {
    platform = process.platform,
    killFn = process.kill.bind(process) as (pid: number, sig: NodeJS.Signals) => void,
    execTaskkill = (p: number) => {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(p)], { stdio: "ignore" });
    },
  }: {
    platform?: NodeJS.Platform;
    killFn?: (pid: number, sig: NodeJS.Signals) => void;
    execTaskkill?: (pid: number) => void;
  } = {},
): void {
  if (!pid) return;
  if (platform === "win32") {
    execTaskkill(pid);
    return;
  }
  try {
    killFn(-pid, "SIGKILL");
  } catch {
    /* grupo já morreu */
  }
  try {
    killFn(pid, "SIGKILL");
  } catch {
    /* já morreu */
  }
}

/** Filhos vivos de `realExecAsync`, pra o repasse de SIGINT/SIGTERM. */
const liveChildPids = new Set<number>();
let signalForwardingInstalled = false;
function installSignalForwarding(): void {
  if (signalForwardingInstalled) return;
  signalForwardingInstalled = true;
  // Se o runner morrer (Ctrl+C, task parada), nenhum image-generate.ts fica
  // órfão gerando imagem: mata a árvore de cada filho vivo e sai com o código
  // convencional do sinal.
  for (const [sig, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(sig, () => {
      for (const pid of liveChildPids) killChildTree(pid);
      liveChildPids.clear();
      process.exit(exitCode);
    });
  }
}

export interface RealExecAsyncOptions {
  timeoutMs?: number;
  killTree?: (pid: number | undefined) => void;
  /** false só em teste: não instala handlers de sinal no processo do runner de testes. */
  forwardSignals?: boolean;
}

export function realExecAsync(rootDir: string, opts: RealExecAsyncOptions = {}): AsyncExecFn {
  const timeoutMs = opts.timeoutMs ?? IMAGE_JOB_TIMEOUT_MS;
  const killTree = opts.killTree ?? ((pid: number | undefined) => killChildTree(pid));
  if (opts.forwardSignals !== false) installSignalForwarding();
  return (scriptRelPath, args) =>
    new Promise((resolvePromise) => {
      const abs = resolve(rootDir, ...scriptRelPath.split("/"));
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let pid: number | undefined;
      const finish = (r: StepResult) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (pid !== undefined) liveChildPids.delete(pid);
        resolvePromise(r);
      };
      const child = spawn(process.execPath, ["--import", "tsx", abs, ...args], {
        cwd: rootDir,
        detached: process.platform !== "win32", // POSIX: grupo próprio → kill(-pid)
        windowsHide: true,
      });
      pid = child.pid;
      if (pid !== undefined) liveChildPids.add(pid);
      timer = setTimeout(() => {
        killTree(pid);
        finish({ code: 1, stdout, stderr: stderr + `\nERRO: o passo passou de ${Math.round(timeoutMs / 1000)}s e foi morto (árvore, por PID)\n` });
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (c: string) => (stdout += c));
      child.stderr.on("data", (c: string) => (stderr += c));
      child.on("error", (err) =>
        finish({ code: 1, stdout, stderr: stderr + `\nERRO: o passo nao executou (falha de spawn): ${err.message}\n` }),
      );
      child.on("close", (code, signal) =>
        finish(
          code === null
            ? { code: 1, stdout, stderr: stderr + `\nERRO: o passo terminou sem exit code (sinal ${signal ?? "desconhecido"})\n` }
            : { code, stdout, stderr },
        ),
      );
    });
}

/** #14036: stderr que sugere limite de concorrência/taxa do backend — o único
 * caso em que repetir em série tem chance de mudar o resultado quando TODAS as
 * imagens falharam. */
export const CONCURRENCY_ERROR_RE = /\b429\b|too many requests|rate[ _-]?limit|concurren|simult[aâ]ne/i;

/**
 * Decide se as falhas do passo paralelo merecem a repetição em série (#14036).
 * Pura. Repete se pelo menos um job passou (o backend funciona, a falha pode
 * ter sido da concorrência) ou se o stderr de alguma falha indica limite de
 * concorrência. Todos falharam sem esse sinal (login expirado, backend fora)
 * = abort direto, sem gastar outra rodada.
 */
export function shouldRetrySerially(outcomes: Array<{ ok: boolean; stderr: string }>): boolean {
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length === 0) return false;
  if (failed.length < outcomes.length) return true;
  return failed.some((o) => CONCURRENCY_ERROR_RE.test(o.stderr));
}

/** Args da repetição em série (#14036): `--force`, pra nunca pular por "já
 * existe" um arquivo parcial deixado pela tentativa que falhou (ex.: a
 * compressão falhou depois de o gerador gravar). `--keep-4x5-nativo` do 2x1
 * fica como estava. */
export function retryArgs(args: string[]): string[] {
  return args.includes("--force") ? [...args] : [...args, "--force"];
}

/**
 * Roda `jobs` com no máximo `limit` em voo ao mesmo tempo (#14036). Ordem de
 * início = ordem da lista; o resultado volta na MESMA ordem da lista, nunca na
 * de término. Nenhum job derruba os outros: a função devolve todos os
 * resultados e quem chama decide o que é falha.
 */
export async function runWithConcurrency<T>(jobs: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
    }
  };
  const n = Math.max(1, Math.min(limit, jobs.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function realExec(rootDir: string): ExecFn {
  return (scriptRelPath, args) => {
    const abs = resolve(rootDir, ...scriptRelPath.split("/"));
    const result = spawnSync(process.execPath, ["--import", "tsx", abs, ...args], {
      cwd: rootDir,
      encoding: "utf8",
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

/** Extrai o primeiro bloco JSON de stdout — mesmo helper de stage-0-run.ts/clarice-novos-run.ts. */
export function parseStepJson<T = unknown>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const start = Math.min(...["{", "["].map((c) => trimmed.indexOf(c)).filter((i) => i >= 0));
  if (!Number.isFinite(start)) return undefined;
  try {
    return JSON.parse(trimmed.slice(start)) as T;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Abort tipado.
// ---------------------------------------------------------------------------

export class Stage3Abort extends Error {
  readonly code = 1 as const;
  constructor(message: string) {
    super(message);
    this.name = "Stage3Abort";
  }
}

// ---------------------------------------------------------------------------
// Opções da CLI
// ---------------------------------------------------------------------------

export type DestaqueId = "d1" | "d2" | "d3";
const AAMMDD_RE = /^\d{6}$/;
const VALID_DESTAQUES: DestaqueId[] = ["d1", "d2", "d3"];

export interface Stage3RunOptions {
  edition: string;
  only?: DestaqueId[];
  force: boolean;
  /** #14036 — máximo de `image-generate.ts` em voo ao mesmo tempo. Default
   * `DEFAULT_IMAGE_CONCURRENCY` (3 destaques × 2x1/4x5); `--serial` = 1. */
  imageConcurrency: number;
}

/** #14036: 3 destaques × (2x1 + 4x5 nativo) = 6 imagens, todas de uma vez. */
export const DEFAULT_IMAGE_CONCURRENCY = 6;

export function parseStage3RunArgs(argv: string[]): Stage3RunOptions {
  const edition = getStringArg(argv, "edition", { example: "260423" });
  if (!edition || !AAMMDD_RE.test(edition)) {
    throw new Stage3Abort('--edition AAMMDD é obrigatório (6 dígitos, ex: "260423").');
  }

  const onlyRaw = getStringArg(argv, "only", { example: "d1,d2" });
  let only: DestaqueId[] | undefined;
  if (onlyRaw !== undefined) {
    const parts = onlyRaw.split(",").map((s) => s.trim());
    for (const p of parts) {
      if (!(VALID_DESTAQUES as string[]).includes(p)) {
        throw new Stage3Abort(`--only inválido: "${p}" — esperado d1, d2 ou d3.`);
      }
    }
    only = parts as DestaqueId[];
  }

  const concurrencyRaw = getStringArg(argv, "concurrency", { example: "3" });
  let imageConcurrency = DEFAULT_IMAGE_CONCURRENCY;
  if (concurrencyRaw !== undefined) {
    const n = Number(concurrencyRaw);
    if (!Number.isInteger(n) || n < 1 || n > DEFAULT_IMAGE_CONCURRENCY) {
      throw new Stage3Abort(`--concurrency inválido: "${concurrencyRaw}" — esperado inteiro de 1 a ${DEFAULT_IMAGE_CONCURRENCY}.`);
    }
    imageConcurrency = n;
  }
  if (hasFlag(argv, "serial")) imageConcurrency = 1;

  return { edition, only, force: hasFlag(argv, "force"), imageConcurrency };
}

// ---------------------------------------------------------------------------
// Deps injetáveis.
// ---------------------------------------------------------------------------

export interface Stage3RunDeps {
  rootDir: string;
  exec: ExecFn;
  /** #14036 — exec assíncrono pra geração de imagens em paralelo. Ausente
   * (testes antigos), cai num wrapper do `exec` síncrono (roda em série). */
  execAsync?: AsyncExecFn;
  existsSync: (p: string) => boolean;
  readFile: (p: string) => string;
  /** Checa se o ComfyUI local está no ar (`http://127.0.0.1:8188/system_stats`).
   * Só é chamado quando `platform.config.json.image_generator === "comfyui"`.
   * Injetável pra teste — a implementação real usa `curl` com timeout curto
   * (mesmo comando que o playbook prescreve, #4090 §3b). */
  checkComfyUi: () => boolean;
}

export function productionDeps(rootDir: string = ROOT): Stage3RunDeps {
  return {
    rootDir,
    exec: realExec(rootDir),
    execAsync: realExecAsync(rootDir),
    existsSync: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, "utf8"),
    checkComfyUi: () => {
      try {
        const result = spawnSync("curl", ["-sf", "--max-time", "3", "http://127.0.0.1:8188/system_stats"], { encoding: "utf8" });
        return result.status === 0;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Report — acumula texto humano-legível pra devolver no JSON final.
// ---------------------------------------------------------------------------

class ReportBuilder {
  readonly notes: string[] = [];
  note(line: string): void {
    this.notes.push(line);
    console.error(line);
  }
}

function softStep(
  deps: Stage3RunDeps,
  report: ReportBuilder,
  label: string,
  scriptRelPath: string,
  args: string[],
): { result: StepResult; json: unknown } {
  report.note(`▶ ${label} (fail-soft)`);
  const result = deps.exec(scriptRelPath, args);
  if (result.stderr.trim()) console.error(result.stderr.trim());
  if (result.code !== 0) {
    report.note(`⚠️  ${label} falhou (exit ${result.code}) — fail-soft, não bloqueia Stage 3.`);
  }
  return { result, json: parseStepJson(result.stdout) };
}

function logEvent(
  deps: Stage3RunDeps,
  edition: string,
  level: "info" | "warn" | "error",
  message: string,
  opts: { details?: unknown; informational?: boolean } = {},
): void {
  const args = ["--edition", edition, "--stage", "3", "--agent", "orchestrator", "--level", level, "--message", message];
  if (opts.details !== undefined) args.push("--details", JSON.stringify(opts.details));
  if (opts.informational) args.push("--informational");
  const result = deps.exec("scripts/log-event.ts", args);
  if (result.code !== 0) {
    console.error(`⚠️  log-event.ts falhou (exit ${result.code}) ao registrar: ${message}`);
  }
}

/** Últimas linhas de stderr — mesmo corte de stage-0-run.ts pra mensagem de erro compacta. */
function tailStderr(stderr: string, n = 6): string {
  return stderr.trim().split("\n").slice(-n).join(" | ") || "(sem stderr)";
}

// ---------------------------------------------------------------------------
// destaque_count — mesmo cálculo (não-exportado) de
// scripts/lib/invariant-checks/stage-3.ts readDestaqueCount, reimplementado
// aqui como helper puro pra não importar um símbolo interno de outro módulo
// (mesmo padrão de stage-0-run.ts: pequenas funções puras vivem localmente).
// ---------------------------------------------------------------------------

export function readDestaqueCountFromDisk(deps: Stage3RunDeps, editionDir: string): 2 | 3 {
  const p = resolve(deps.rootDir, editionDir, "_internal", "01-approved-capped.json");
  if (!deps.existsSync(p)) return 3; // default; invariante do Stage 1 cobre ausência
  try {
    const data = JSON.parse(deps.readFile(p)) as { highlights?: unknown[] };
    if (!Array.isArray(data.highlights)) return 3;
    const n = data.highlights.length;
    if (n === 2) return 2;
    if (n === 3) return 3;
    return 3; // fora do intervalo já é rejeitado pelo invariante do Stage 1
  } catch {
    return 3;
  }
}

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------

export interface DestaqueOutcome {
  destaque: DestaqueId;
  lintOk: boolean;
  lintViolations?: string;
  imageGenerated: boolean;
  nativeArt4x5Generated: boolean;
  error?: string;
}

export type ImageJobRatio = "2x1" | "4x5";

/** #14036 — resultado de uma chamada de `image-generate.ts`. */
export interface ImageJobOutcome {
  destaque: DestaqueId;
  ratio: ImageJobRatio;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  /** true quando o job só rodou de novo, em série, depois de falhar no paralelo. */
  retriedSerially?: boolean;
  stderrTail?: string;
}

export interface PendingAgentDispatch {
  step: string;
  agent: string;
  detail: string;
  manifestPath?: string;
}

export interface HaltRequired {
  stage: string;
  reason: string;
  action: string;
}

export type ChampionsInjectedState = "injected" | "noop" | "skipped-existing-callout";

export interface Stage3RunResult {
  code: 0 | 1 | 2;
  editionDir?: string;
  destaqueCount?: 2 | 3;
  destaques: DestaqueOutcome[];
  /** #14036 — cada chamada de `image-generate.ts` (destaque × ratio). */
  imageJobs?: ImageJobOutcome[];
  imageConcurrency?: number;
  cardsGenerated: boolean;
  /** #6005 Parte B — slides sem foto (3 parágrafos + CTA) do carrossel diário. */
  carouselCardsGenerated: boolean;
  /** #6068 — destaques cujos slides foram REGERADOS por mudança de texto. */
  carouselRefreshed?: string[];
  leaderboardFetched: boolean;
  championsInjected?: ChampionsInjectedState;
  invariantsPassed?: boolean;
  invariantsViolations?: unknown[];
  cropReviewPairs?: unknown[];
  pendingAgentDispatch: PendingAgentDispatch[];
  haltRequired?: HaltRequired;
  delegatedSteps: string[];
  notes: string[];
}

const DELEGATED_STEPS = [
  '3a — É IA? (coleta do dispatch em background + polling com retry/skip em timeout de 10min, decisão do editor) — nunca executado por este script.',
  '3a-bis — Skill("humanizador") + mcp__clarice__correct_text + filtro de julgamento semântico sobre a descrição do É IA? — nunca executado por este script.',
  '3b (crop-reviewer) — dispatch Agent("image-crop-reviewer", { edition, pairs: cropReviewPairs, out_path }) e a chamada --input-json que persiste o veredito, seguida de --estilo-regen-plan (#10312: regenerar destaque com Noite Estrelada e repetir o revisor) — este script só faz a DESCOBERTA dos pares (cropReviewPairs no resultado).',
  '3b (gate humano final) — aprovar/regenerar imagens + escrever o sentinel do Stage 3 (pipeline-sentinel.ts write --step 3) — nunca executado por este script.',
];

// ---------------------------------------------------------------------------
// Orquestração principal.
// ---------------------------------------------------------------------------

export async function runStage3(argv: string[], deps: Stage3RunDeps): Promise<Stage3RunResult> {
  const report = new ReportBuilder();
  const pendingAgentDispatch: PendingAgentDispatch[] = [];
  // #14036: fora do try pra que um abort por falha de imagem ainda devolva o
  // estado de cada destaque (qual ratio falhou), e não `[]`.
  let destaquesOut: DestaqueOutcome[] = [];
  let imageJobsOut: ImageJobOutcome[] | undefined;
  let imageConcurrencyOut: number | undefined;
  try {
    const opts = parseStage3RunArgs(argv);
    imageConcurrencyOut = opts.imageConcurrency;

    // --- resolver EDITION_DIR (idempotente, mesma chamada do Stage 0/playbook) ---
    const resolveResult = deps.exec("scripts/lib/find-current-edition.ts", ["--resolve", opts.edition]);
    const editionDir = resolveResult.stdout.trim();
    if (resolveResult.code !== 0 || !editionDir) {
      throw new Stage3Abort(`❌ find-current-edition.ts --resolve não devolveu um path (exit ${resolveResult.code}): ${tailStderr(resolveResult.stderr)}`);
    }

    // --- pré-condição: sentinel Stage 2 ---
    const sentinelResult = deps.exec("scripts/pipeline-sentinel.ts", [
      "assert",
      "--edition",
      opts.edition,
      "--step",
      "2",
      "--outputs",
      "02-reviewed.md,03-social.md",
    ]);
    if (sentinelResult.code === 1) {
      throw new Stage3Abort(`❌ Etapa 2 não completou (sentinel ausente). Re-rodar /diaria-2-escrita ${opts.edition} antes de continuar.`);
    }
    if (sentinelResult.code === 2) {
      throw new Stage3Abort(`❌ Outputs do Stage 2 ausentes (02-reviewed.md/03-social.md). Re-rodar Etapa 2.`);
    }
    if (sentinelResult.code === 3) {
      logEvent(deps, opts.edition, "warn", "stage2_sentinel_missing_legacy");
      report.note("⚠️  stage2_sentinel_missing_legacy — outputs presentes mas sentinel ausente (edição legada).");
    } else if (sentinelResult.code !== 0) {
      throw new Stage3Abort(`❌ pipeline-sentinel assert --step 2 erro inesperado (exit ${sentinelResult.code}): ${tailStderr(sentinelResult.stderr)}`);
    }

    logEvent(deps, opts.edition, "info", "etapa 3 imagens started");
    report.note("▶ etapa 3 imagens started");

    // --- destaque_count + lista de destaques a processar ---
    const destaqueCount = readDestaqueCountFromDisk(deps, editionDir);
    const allDestaques: DestaqueId[] = destaqueCount === 3 ? ["d1", "d2", "d3"] : ["d1", "d2"];
    if (opts.only) {
      for (const d of opts.only) {
        if (!allDestaques.includes(d)) report.note(`⚠️  --only incluiu ${d} mas destaque_count=${destaqueCount} — ignorado.`);
      }
    }
    const destaquesToRun = (opts.only ? opts.only.filter((d) => allDestaques.includes(d)) : allDestaques);

    // --- ComfyUI health check (só se configurado — mesmo gate do playbook) ---
    let imageGenerator = "gemini";
    try {
      const cfg = JSON.parse(deps.readFile(resolve(deps.rootDir, "platform.config.json"))) as { image_generator?: string };
      imageGenerator = cfg.image_generator ?? "gemini";
    } catch {
      report.note("⚠️  platform.config.json ilegível — assumindo image_generator=gemini (default).");
    }
    if (imageGenerator === "comfyui" && !deps.checkComfyUi()) {
      const reason = 'ComfyUI configurado (platform.config.json → image_generator="comfyui") mas http://127.0.0.1:8188/system_stats não respondeu.';
      const action = "iniciar o ComfyUI local (ver docs/comfyui-setup.md) e rodar de novo.";
      const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "3 — Imagens", "--reason", reason, "--action", action]);
      report.note(banner.stdout.trim() || `HALT: ${reason}`);
      logEvent(deps, opts.edition, "error", "comfyui_unavailable", { details: { reason } });
      return {
        code: 2,
        editionDir,
        destaqueCount,
        destaques: [],
        cardsGenerated: false,
        carouselCardsGenerated: false,
        leaderboardFetched: false,
        pendingAgentDispatch,
        haltRequired: { stage: "3 — Imagens", reason, action },
        delegatedSteps: DELEGATED_STEPS,
        notes: report.notes,
      };
    }

    // --- por destaque: lint (em série, rápido) ---
    // A geração vem depois, num passo só: erro de I/O no lint de qualquer
    // destaque aborta antes de gastar qualquer chamada de imagem.
    const destaques: DestaqueOutcome[] = [];
    destaquesOut = destaques;
    const readyForImages: DestaqueId[] = [];
    for (const d of destaquesToRun) {
      const promptRel = `${editionDir}/_internal/02-${d}-prompt.md`;
      if (!deps.existsSync(resolve(deps.rootDir, promptRel))) {
        report.note(`⚠️  ${d}: prompt ausente (${promptRel}) — pulando (Stage 2 deveria ter gerado).`);
        destaques.push({ destaque: d, lintOk: false, imageGenerated: false, nativeArt4x5Generated: false, error: "prompt_missing" });
        continue;
      }

      const lintResult = deps.exec("scripts/lint-image-prompt.ts", [promptRel]);
      if (lintResult.code === 2) {
        throw new Stage3Abort(`❌ lint-image-prompt.ts ${d}: erro de I/O (exit 2): ${tailStderr(lintResult.stderr)}`);
      }
      if (lintResult.code === 1) {
        report.note(`⏸️  ${d}: lint encontrou violação(ões) — geração pausada até o editor corrigir o prompt.`);
        destaques.push({ destaque: d, lintOk: false, lintViolations: lintResult.stderr.trim(), imageGenerated: false, nativeArt4x5Generated: false });
        continue; // pausa SÓ este destaque — próximo segue normalmente
      }
      readyForImages.push(d);
    }

    // --- geração: 2x1 + 4x5 nativo de todos os destaques em paralelo (#14036) ---
    // Os dois formatos usam o mesmo prompt e não dependem um do outro. Antes
    // rodavam em série (até 6 chamadas de 1-3 min cada); agora o total é o
    // tempo da mais lenta. Duas corridas ficam fechadas:
    //   - prompt JSON: cada ratio grava o seu (`sdPromptPathFor` em
    //     image-generate.ts), então o 2x1 e o 4x5 não se sobrescrevem;
    //   - purga do nativo (#6010): quando o 2x1 vai ser REGERADO (ausente, ou
    //     --force), a ordem antiga apagava o nativo e o 4x5 seguinte o recriava.
    //     Em paralelo, o 4x5 recebe --force (regera do prompt atual, mesmo
    //     resultado da ordem antiga) e o 2x1 recebe --keep-4x5-nativo (não
    //     apaga o que o 4x5 está gravando). Com o 2x1 presente e sem --force,
    //     nada muda: os dois seguem o skip-if-exists de sempre.
    const execAsync: AsyncExecFn = deps.execAsync ?? (async (script, args) => deps.exec(script, args));
    interface ImageJobSpec {
      destaque: DestaqueId;
      ratio: ImageJobRatio;
      args: string[];
    }
    const specs: ImageJobSpec[] = [];
    for (const d of readyForImages) {
      const promptRel = `${editionDir}/_internal/02-${d}-prompt.md`;
      const genArgs = ["--editorial", promptRel, "--out-dir", `${editionDir}/`, "--destaque", d];
      const wide2x1Regenerates = opts.force || !deps.existsSync(resolve(deps.rootDir, editionDir, `04-${d}-2x1.jpg`));
      specs.push({
        destaque: d,
        ratio: "2x1",
        args: [...genArgs, ...(opts.force ? ["--force"] : []), ...(wide2x1Regenerates ? ["--keep-4x5-nativo"] : [])],
      });
      specs.push({
        destaque: d,
        ratio: "4x5",
        args: [...genArgs, "--ratio", "4x5", ...(wide2x1Regenerates ? ["--force"] : [])],
      });
    }

    const runJob = async (spec: ImageJobSpec): Promise<{ outcome: ImageJobOutcome; result: StepResult }> => {
      const t0 = Date.now();
      const result = await execAsync("scripts/image-generate.ts", spec.args);
      return {
        result,
        outcome: {
          destaque: spec.destaque,
          ratio: spec.ratio,
          ok: result.code === 0,
          exitCode: result.code,
          durationMs: Date.now() - t0,
          ...(result.code !== 0 ? { stderrTail: tailStderr(result.stderr) } : {}),
        },
      };
    };

    const imageConcurrency = opts.imageConcurrency;
    if (specs.length > 0) {
      report.note(`▶ image-generate.ts: ${specs.length} imagem(ns), até ${Math.min(imageConcurrency, specs.length)} em paralelo.`);
    }
    type JobRun = { outcome: ImageJobOutcome; result: StepResult };
    // `undefined` = job que não chegou a rodar (só em `--serial`, depois da 1ª falha).
    let runs: Array<JobRun | undefined>;
    if (imageConcurrency === 1) {
      // `--serial`: a ordem e o abort de antes do #14036 — para na 1ª falha,
      // sem rodar o resto nem repetir.
      runs = new Array<JobRun | undefined>(specs.length);
      for (let i = 0; i < specs.length; i++) {
        runs[i] = await runJob(specs[i]);
        if (!runs[i]!.outcome.ok) break;
      }
    } else {
      runs = await runWithConcurrency(
        specs.map((spec) => () => runJob(spec)),
        imageConcurrency,
      );
    }
    const collectOutcomes = () => runs.filter((r): r is JobRun => r !== undefined).map((r) => r.outcome);
    imageJobsOut = collectOutcomes();

    // Fallback em série (#14036): repetir as que falharam, uma por vez, na
    // ordem original, com `--force` (`retryArgs`), só quando a repetição tem
    // chance de mudar o resultado (`shouldRetrySerially`): pelo menos uma
    // imagem passou, ou o stderr indica limite de concorrência/taxa. Todas
    // falharam sem esse sinal = abort direto. Em `--serial` não há repetição.
    const failedIdx = runs.map((r, i) => (r && !r.outcome.ok ? i : -1)).filter((i) => i >= 0);
    if (
      failedIdx.length > 0 &&
      imageConcurrency > 1 &&
      shouldRetrySerially(runs.map((r) => ({ ok: r!.outcome.ok, stderr: r!.result.stderr })))
    ) {
      const labels = failedIdx.map((i) => `${specs[i].destaque}:${specs[i].ratio}`);
      report.note(`⚠️  image-generate.ts: ${labels.join(", ")} falhou(aram) em paralelo — repetindo em série, com --force.`);
      logEvent(deps, opts.edition, "warn", "stage3_image_parallel_fallback", {
        details: { failed: failedIdx.map((i) => runs[i]!.outcome) },
      });
      for (const i of failedIdx) {
        const retry = await runJob({ ...specs[i], args: retryArgs(specs[i].args) });
        runs[i] = { result: retry.result, outcome: { ...retry.outcome, retriedSerially: true } };
      }
      imageJobsOut = collectOutcomes();
    } else if (failedIdx.length > 0 && imageConcurrency > 1) {
      report.note("↷ todas as imagens falharam sem sinal de limite de concorrência — sem repetição em série.");
    }

    // Resultado por destaque. Falha de qualquer ratio segue BLOQUEANTE (#4090),
    // mas cada destaque/ratio que falhou aparece no resultado e na mensagem:
    // em paralelo, mais de um pode falhar na mesma rodada.
    const failures: string[] = [];
    const secs = (ms: number) => `${Math.round(ms / 1000)}s`;
    for (const d of readyForImages) {
      const r2 = runs.find((r) => r?.outcome.destaque === d && r.outcome.ratio === "2x1");
      const r45 = runs.find((r) => r?.outcome.destaque === d && r.outcome.ratio === "4x5");
      if (!r2 && !r45) continue; // `--serial` abortou antes deste destaque
      const errs: string[] = [];
      if (r2 && !r2.outcome.ok) {
        errs.push(`❌ image-generate.ts ${d} (2x1) falhou (exit ${r2.outcome.exitCode}): ${tailStderr(r2.result.stderr)}`);
      }
      if (r45 && !r45.outcome.ok) {
        errs.push(
          `❌ image-generate.ts ${d} (4x5 nativo) falhou (exit ${r45.outcome.exitCode}) — BLOQUEANTE (#4090): ${tailStderr(r45.result.stderr)}`,
        );
      }
      destaques.push({
        destaque: d,
        lintOk: true,
        imageGenerated: r2?.outcome.ok ?? false,
        nativeArt4x5Generated: r45?.outcome.ok ?? false,
        ...(errs.length > 0 ? { error: errs.join(" ; ") } : {}),
      });
      if (errs.length > 0) {
        for (const e of errs) report.note(e);
        failures.push(...errs);
      } else if (r2 && r45) {
        report.note(
          `✅ ${d}: lint ok, imagens 2x1 (${secs(r2.outcome.durationMs)}) / 4x5-nativo (${secs(r45.outcome.durationMs)}) geradas.`,
        );
      }
    }
    // Ordem d1, d2, d3 no resultado (pausados/sem prompt entraram antes).
    destaques.sort((a, b) => VALID_DESTAQUES.indexOf(a.destaque) - VALID_DESTAQUES.indexOf(b.destaque));
    if (failures.length > 0) {
      throw new Stage3Abort(
        failures.length === 1 ? failures[0] : `${failures.length} imagens falharam — BLOQUEANTE (#4090): ${failures.join(" ; ")}`,
      );
    }

    // --- card 4:5 do feed (compõe TODOS os destaques prontos de uma vez, #4114) ---
    const anyReady = destaques.some((d) => d.imageGenerated && d.nativeArt4x5Generated);
    let cardsGenerated = false;
    if (anyReady) {
      const cardResult = deps.exec("scripts/gen-social-card-4x5.ts", ["--edition-dir", `${editionDir}/`]);
      if (cardResult.code !== 0) {
        throw new Stage3Abort(
          `❌ gen-social-card-4x5.ts falhou (exit ${cardResult.code}) — BLOQUEANTE (#4090). Causa comum: assertBrandSerifAvailable ` +
            `(fonte Georgia ausente) — instalar a fonte ou setar DIARIA_ALLOW_FONT_FALLBACK=1. Stderr: ${tailStderr(cardResult.stderr, 8)}`,
        );
      }
      cardsGenerated = true;
      report.note("✅ cards 4:5 do feed compostos.");
    } else {
      report.note("↷ nenhum destaque com imagens prontas — pulando gen-social-card-4x5.ts.");
    }

    // --- carrossel diário (#6005 Parte B): slides sem foto (3 parágrafos +
    // CTA) por destaque, a partir de 03-social.md — independe das imagens
    // de destaque terem sido geradas nesta rodada (só depende do Stage 2).
    // BLOQUEANTE só quando o render falha (fonte/sharp) — falta de texto de
    // UM destaque específico é best-effort dentro do próprio script
    // (skipped no resultado, cai pro fallback single-image no publish).
    const carouselResult = deps.exec("scripts/gen-carousel-cards.ts", ["--edition-dir", `${editionDir}/`]);
    let carouselCardsGenerated = false;
    if (carouselResult.code !== 0) {
      throw new Stage3Abort(
        `❌ gen-carousel-cards.ts falhou (exit ${carouselResult.code}) — BLOQUEANTE (#6005). Causa comum: assertBrandSerifAvailable ` +
          `(fonte Georgia ausente) — instalar a fonte ou setar DIARIA_ALLOW_FONT_FALLBACK=1. Stderr: ${tailStderr(carouselResult.stderr, 8)}`,
      );
    }
    carouselCardsGenerated = true;
    // #6068: o script reporta em `refreshed[]` quais destaques ele REGEROU por
    // o texto ter mudado desde a última rasterização. Sem surfacear isso, um
    // auto-conserto real ficava indistinguível de "nada a fazer" — o mesmo
    // silêncio que o #6064 existe pra eliminar, só que do lado do conserto.
    let carouselRefreshed: string[] = [];
    try {
      const parsed = JSON.parse(carouselResult.stdout) as { refreshed?: unknown };
      if (Array.isArray(parsed.refreshed)) carouselRefreshed = parsed.refreshed.map(String);
    } catch (e) {
      // stdout não-JSON não é motivo pra derrubar o stage — o exit code já
      // atestou o sucesso; só perdemos o detalhe do que foi regerado. Mas o
      // caso é raro o bastante pra que o warning sem causa nenhuma não ajude
      // ninguém a depurar quando acontecer (#6068).
      report.note(
        `⚠️  gen-carousel-cards.ts: stdout não parseou como JSON (${(e as Error).message}) — ` +
          `sem detalhe de regeneração. stdout: ${carouselResult.stdout.slice(0, 200)}`,
      );
    }
    report.note(
      carouselRefreshed.length > 0
        ? `✅ cards de carrossel (parágrafo + CTA) gerados — REGERADOS: ${carouselRefreshed.join(", ")} (texto editado após a última rasterização).`
        : "✅ cards de carrossel (parágrafo + CTA) gerados.",
    );

    // --- leaderboard top1 (fail-soft, #1753) ---
    const leaderboardOut = `${editionDir}/_internal/04-leaderboard-top1.json`;
    const leaderboardStep = softStep(deps, report, "fetch-leaderboard-top1", "scripts/fetch-leaderboard-top1.ts", ["--edition", opts.edition, "--out", leaderboardOut]);
    const leaderboardFetched = leaderboardStep.result.code === 0;

    // --- box de campeões (#2725) — exit 1 (#4583 raffle stale) é FATAL, nunca no-op silencioso ---
    const championsResult = deps.exec("scripts/inject-champions-callout.ts", ["--edition", opts.edition, "--edition-dir", `${editionDir}/`]);
    let championsInjected: ChampionsInjectedState | undefined;
    if (championsResult.code === 1) {
      const reason = `inject-champions-callout.ts FATAL (exit 1): ${tailStderr(championsResult.stderr, 4)}`;
      const action =
        "confirmar com o editor o dia do sorteio deste mês e atualizar platform.config.json → raffle.sorteio_do_mes " +
        '{ "mes": "{YYYY-MM da edição}", "dia": N } (ou checar se 02-reviewed.md está presente); então re-rodar.';
      const banner = deps.exec("scripts/render-halt-banner.ts", ["--stage", "3 — Imagens", "--reason", reason, "--action", action]);
      report.note(banner.stdout.trim() || `HALT: ${reason}`);
      logEvent(deps, opts.edition, "error", "inject_champions_callout_fatal", { details: { stderr: championsResult.stderr.trim() } });
      return {
        code: 2,
        editionDir,
        destaqueCount,
        destaques,
        cardsGenerated,
        carouselCardsGenerated,
        leaderboardFetched,
        pendingAgentDispatch,
        haltRequired: { stage: "3 — Imagens", reason, action },
        delegatedSteps: DELEGATED_STEPS,
        notes: report.notes,
      };
    }
    if (championsResult.code === 2) {
      throw new Stage3Abort(`❌ inject-champions-callout.ts erro de uso (exit 2): ${tailStderr(championsResult.stderr)}`);
    }
    if (championsResult.code !== 0) {
      throw new Stage3Abort(`❌ inject-champions-callout.ts erro inesperado (exit ${championsResult.code}): ${tailStderr(championsResult.stderr)}`);
    }
    if (/callout já presente/.test(championsResult.stdout)) {
      championsInjected = "skipped-existing-callout";
    } else if (/injetado em/.test(championsResult.stdout)) {
      championsInjected = "injected";
    } else {
      championsInjected = "noop";
    }
    report.note(`ℹ️  inject-champions-callout: ${championsInjected}.`);

    // --- pre-gate invariants (#1007 Fase 1) — reporta, nunca aborta o script ---
    const invariantsResult = deps.exec("scripts/check-invariants.ts", ["--stage", "3", "--edition-dir", editionDir]);
    if (invariantsResult.code === 2) {
      throw new Stage3Abort(`❌ check-invariants --stage 3 erro de uso (exit 2): ${tailStderr(invariantsResult.stderr)}`);
    }
    const invariantsPassed = invariantsResult.code === 0;
    let invariantsViolations: unknown[] | undefined;
    if (!invariantsPassed) {
      const parsed = parseStepJson<{ violations?: unknown[] }>(invariantsResult.stdout);
      invariantsViolations = parsed?.violations ?? [];
      report.note(`⚠️  check-invariants --stage 3: ${invariantsViolations.length} violação(ões) — gate deve exigir fix antes de aprovar.`);
      logEvent(deps, opts.edition, "warn", "stage3_invariants_failed", { details: { violations: invariantsViolations } });
    } else {
      report.note("✅ check-invariants --stage 3: ok.");
    }

    // --- crop-reviewer: só a DESCOBERTA (script), dispatch do Agent fica pro orchestrator ---
    let cropReviewPairs: unknown[] | undefined;
    const cropDiscovery = deps.exec("scripts/run-image-crop-reviewer.ts", ["--edition-dir", `${editionDir}/`]);
    if (cropDiscovery.code === 0) {
      const parsed = parseStepJson<{ edition?: string; pairs?: unknown[]; out_path?: string }>(cropDiscovery.stdout);
      if (parsed?.pairs && parsed.pairs.length > 0) {
        cropReviewPairs = parsed.pairs;
        pendingAgentDispatch.push({
          step: "3b-crop-reviewer",
          agent: "image-crop-reviewer",
          detail: `${parsed.pairs.length} par(es) de imagem pra revisar — dispatch via Agent("image-crop-reviewer", { edition: "${opts.edition}", pairs: cropReviewPairs, out_path: "${parsed.out_path}" }); depois persistir com "run-image-crop-reviewer.ts --edition-dir ${editionDir}/ --input-json <output-do-agent>" e rodar "run-image-crop-reviewer.ts --edition-dir ${editionDir}/ --estilo-regen-plan" (#10312 — regenera destaque com Noite Estrelada).`,
          manifestPath: parsed.out_path,
        });
      }
    } else {
      report.note("↷ run-image-crop-reviewer (descoberta): nenhum par encontrado — pulando revisor de crop (warn, não bloqueia).");
      logEvent(deps, opts.edition, "warn", "crop_reviewer_no_pairs", { informational: true });
    }

    return {
      code: 0,
      editionDir,
      destaqueCount,
      destaques,
      ...(imageJobsOut ? { imageJobs: imageJobsOut } : {}),
      imageConcurrency,
      cardsGenerated,
      carouselCardsGenerated,
      ...(carouselRefreshed.length > 0 ? { carouselRefreshed } : {}),
      leaderboardFetched,
      championsInjected,
      invariantsPassed,
      invariantsViolations,
      cropReviewPairs,
      pendingAgentDispatch,
      delegatedSteps: DELEGATED_STEPS,
      notes: report.notes,
    };
  } catch (e) {
    const abort = e instanceof Stage3Abort ? e : new Stage3Abort(`erro inesperado: ${(e as Error).message}`);
    report.note(`❌ ${abort.message}`);
    return {
      code: abort.code,
      destaques: destaquesOut,
      ...(imageJobsOut ? { imageJobs: imageJobsOut } : {}),
      ...(imageConcurrencyOut !== undefined ? { imageConcurrency: imageConcurrencyOut } : {}),
      cardsGenerated: false,
      carouselCardsGenerated: false,
      leaderboardFetched: false,
      pendingAgentDispatch,
      delegatedSteps: DELEGATED_STEPS,
      notes: report.notes,
    };
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  const deps = productionDeps(ROOT);
  runStage3(process.argv.slice(2), deps).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exitCode = r.code;
  });
}
