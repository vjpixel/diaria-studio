#!/usr/bin/env node
/**
 * scripts/overnight/run-nightly-chain.ts (#10552)
 *
 * Runner da CADEIA NOTURNA agendada no `300`, disparado pela task
 * `Diaria-Nightly-Chain` (`scripts/lib/scheduled-tasks.ts`, 00:15 BRT):
 *
 *   1. `hermes/scripts/opus-daily-diff-review.sh` — review Opus do diff
 *      acumulado do dia, que abre as issues `[daily-review]`. Antes rodava
 *      sozinho às 09:00 pelo job Hermes `645d5debb7f0`.
 *   2. `/diaria-overnight --agendado` headless (`claude --print`), que já
 *      encontra na fila as issues recém-abertas pelo passo 1.
 *
 * **Encadeamento por wrapper, nunca por `exec` dentro do review** (desenho
 * da issue): o overnight sobe QUALQUER que seja o resultado do review —
 * noop, falha, timeout —, porque o backlog existe de qualquer jeito. A falha
 * do review vai pro log e pro exit code (`EXIT_REVIEW_FAILED`, que deixa a
 * unit `failed` e acorda o `Diaria-Systemd-Failed-Units-Alarm`), mas só
 * DEPOIS de o overnight ter rodado. O review continua executável sozinho.
 *
 * **Overnight headless** no molde de `run-scheduled-edicao.ts`:
 *   - `claudeCliEnv` remove `CLAUDE_CLI_STRIPPED_ENV_VARS` (#5608/#6714): o
 *     unit gerado faz `EnvironmentFile=-.env`, e o `.env` tem
 *     `ANTHROPIC_API_KEY` legitimamente. Sessão de Claude Code autentica
 *     SEMPRE pela assinatura claude.ai.
 *   - `--model claude-sonnet-5-5 --effort medium` (#9530): o mesmo par do
 *     frontmatter da skill e do launcher interativo `start.sh`. Como a
 *     sessão já nasce nesse par, a sonda do #9527 não diverge.
 *   - `DISABLE_AUTOUPDATER=1` só no ambiente do filho (#6891).
 *   - SEM `--no-session-persistence`, ao contrário do runner da edição: a
 *     Fase 0 do overnight lê o PRÓPRIO transcript (sonda
 *     `effective-model-probe.ts`, `coordinator-usage-estimate.ts`).
 *   - `--add-dir=<alvo real de data/>` quando `data/` resolve pra fora do
 *     repo (#10569, mesmo fix do #9086 no runner da edição): no `300`,
 *     `data` é link pro OneDrive, e `--permission-mode acceptEdits` só
 *     aceita escrita dentro do diretório de trabalho. Sem isso, o
 *     `plan.json`/`report.md` da rodada seriam negados sem ninguém pra
 *     aprovar.
 *   - SEM `--max-turns`: o editor decidiu "sem teto" pro modo agendado
 *     (comentário de 19/10/2026 na #10552, mesmo racional do #5272). A
 *     rodada para quando a fila seca; a colisão com a edição segue sob o
 *     guard de colisão editorial da própria skill.
 *   - O registro no `session-registry` é feito pela PRÓPRIA sessão (Fase 0
 *     passo 1, `register --kind overnight --unattended` quando
 *     `--agendado`): o `session_id` é o do processo `claude`, injetado pelo
 *     hook `inject-session-id.mjs` — este runner não tem como registrá-lo
 *     de fora. O que o runner faz com o registro é LER: se já existe uma
 *     sessão overnight ativa (rodada aberta à mão que ainda não terminou),
 *     não sobe uma segunda.
 *
 * **Zero perguntas:** a flag `--agendado` é o gatilho explícito do modo
 * desassistido na skill (nunca inferido por "não tem TTY", decisão do
 * editor). Ver `.claude/skills/diaria-overnight/SKILL.md` §Argumentos.
 *
 * Este script NÃO arma nada: o timer é gerado por
 * `scripts/setup-systemd-timers.ts` a partir do registro (a task nasceu
 * `enabled: false`; ligada em 20/10/2026). Passos manuais: `docs/overnight-nightly-chain.md`.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/cli-args.ts";
import { resolveClaudeBin } from "../lib/resolve-claude-bin.ts";
import { getScheduledTaskByName } from "../lib/scheduled-tasks.ts";
import { hasActiveSessionOfKind } from "../lib/session-registry.ts";
import { NO_BACKGROUND_DIRECTIVE, dataAddDirArgs } from "../lib/edition-stage-runner.ts";
import { claudeCliEnv } from "./run-scheduled-edicao.ts";

/** Script do review, relativo à raiz do repo. */
export const DAILY_REVIEW_SCRIPT = "hermes/scripts/opus-daily-diff-review.sh";

/** Par model/effort do coordenador overnight (#9530) — igual ao frontmatter da skill e ao `start.sh`. */
export const NIGHTLY_OVERNIGHT_MODEL = "claude-sonnet-5-5";
export const NIGHTLY_OVERNIGHT_EFFORT = "medium";

/** Flag que liga o modo desassistido na skill. */
export const AGENDADO_FLAG = "--agendado";

/**
 * Teto do REVIEW (não do overnight). O script já põe `timeout 5400` no
 * `claude -p` dele; os 30 min a mais cobrem `git fetch` e o pós-processamento.
 * Sem este teto externo, um review travado fora do `claude -p` seguraria o
 * overnight da noite inteira — o oposto do "sobe sempre" do desenho.
 */
export const REVIEW_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Overnight falhou (exit ≠ 0 do `claude`, ou erro de spawn). O exit original vai pro log. */
export const EXIT_OVERNIGHT_FAILED = 2;

/** Review falhou mas o overnight rodou (ou foi pulado legitimamente). Fora de `successExitCodes` de propósito. */
export const EXIT_REVIEW_FAILED = 3;

export type ReviewStatus = "ok" | "noop" | "failed" | "timeout";
export type OvernightStatus = "ok" | "failed" | "skipped-active-session";

export interface ReviewOutcome {
  status: ReviewStatus;
  exitCode: number | null;
  tail: string;
}

export interface OvernightOutcome {
  status: OvernightStatus;
  exitCode: number | null;
}

/** Prompt posicional do overnight agendado. */
export function buildOvernightPrompt(): string {
  return `/diaria-overnight ${AGENDADO_FLAG} ${NO_BACKGROUND_DIRECTIVE}`;
}

/**
 * Argumentos do `claude` pro overnight agendado. `--` antes do prompt (#9579).
 * `--add-dir` do alvo real de `data/` quando fora do repo (#10569/#9086) — na
 * forma `--add-dir=<path>` (#9348) e antes do `--`.
 */
export function buildOvernightClaudeArgs(
  repoRootAbs: string,
  realpathFn: (p: string) => string = realpathSync,
): string[] {
  return [
    "--print",
    "--model",
    NIGHTLY_OVERNIGHT_MODEL,
    "--effort",
    NIGHTLY_OVERNIGHT_EFFORT,
    "--permission-mode",
    "acceptEdits",
    "--output-format",
    "json",
    ...dataAddDirArgs(repoRootAbs, realpathFn),
    "--",
    buildOvernightPrompt(),
  ];
}

/** Ambiente do `claude` filho: sem as vars de auth da API (#5608/#6714) e sem auto-updater (#6891). */
export function buildOvernightEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...claudeCliEnv(env), DISABLE_AUTOUPDATER: "1" };
}

/**
 * Ambiente do review: mesmo filtro de auth (o script já faz `env -u`, isto é
 * defesa em profundidade) e o diretório do binário `claude` à frente do PATH.
 * Sob systemd o PATH é o mínimo e não tem `~/.npm-global/bin` (#5549) — o
 * script chama `claude` pelo nome, então sem isto o preflight dele falha.
 */
export function buildReviewEnv(env: NodeJS.ProcessEnv, claudeBin: string): NodeJS.ProcessEnv {
  const base = claudeCliEnv(env);
  const binDir = dirname(claudeBin);
  const path = base.PATH ?? "";
  const parts = path.split(delimiter).filter((p) => p.length > 0);
  return {
    ...base,
    DISABLE_AUTOUPDATER: "1",
    PATH: parts.includes(binDir) ? path : [binDir, ...parts].join(delimiter),
  };
}

/** Últimas `n` linhas não-vazias, achatadas numa linha (pra log). */
export function tailLines(text: string, n = 8): string {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .slice(-n)
    .join(" / ");
}

/**
 * Classifica o resultado do review. O script sai 0 tanto no review completo
 * quanto no noop ("nada novo desde o último review"); o noop só é
 * distinguível pelo stderr.
 */
export function classifyReviewResult(r: Pick<SpawnSyncReturns<string>, "status" | "signal" | "error" | "stderr">): ReviewStatus {
  const err = r.error as (NodeJS.ErrnoException & { code?: string }) | undefined;
  if (err && err.code === "ETIMEDOUT") return "timeout";
  if (r.signal === "SIGTERM" && r.status === null) return "timeout";
  if (err || r.status !== 0) return "failed";
  return /— noop/.test(r.stderr ?? "") ? "noop" : "ok";
}

/**
 * Exit code final da cadeia. Falha do overnight vence (é a parte cara e a
 * que o editor precisa ver primeiro); review falho com overnight ok/pulado →
 * `EXIT_REVIEW_FAILED`; o resto → 0.
 */
export function chainExitCode(review: ReviewStatus, overnight: OvernightOutcome): number {
  // Código fixo, não o exit do `claude`: um `claude` que saísse 3 seria lido
  // como "só o review falhou". O exit original fica no log.
  if (overnight.status === "failed") return EXIT_OVERNIGHT_FAILED;
  if (review === "failed" || review === "timeout") return EXIT_REVIEW_FAILED;
  return 0;
}

export interface NightlyChainDeps {
  spawn: typeof spawnSync;
  resolveClaudeBin: () => string;
  hasActiveOvernight: (repoRootAbs: string) => boolean;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Grava o JSON do `claude --print` do overnight (default: `data/overnight/.nightly-chain-last-overnight.json`). */
  writeOvernightOutput: (repoRootAbs: string, stdout: string) => void;
  /**
   * Anexa UMA linha ao log incremental (`LIVE_LOG_REL`, #10672) no momento em
   * que ela é emitida. Opcional: ausente, a cadeia só loga via `log`.
   */
  appendLiveLog?: (repoRootAbs: string, line: string) => void;
  /** Rotaciona o log incremental da run anterior (#10699). Opcional, chamado uma vez no início do `main`. */
  rotateLiveLog?: (repoRootAbs: string) => void;
}

/** Nome da task no registro (`scripts/lib/scheduled-tasks.ts`) que dispara este runner. */
export const NIGHTLY_CHAIN_TASK_NAME = "Diaria-Nightly-Chain";

/** Caminho usado se a task sumir do registro (renomeada): o log incremental não pode derrubar a cadeia. */
const FALLBACK_LIVE_LOG_REL = "overnight/.nightly-chain.live.log";

/**
 * Deriva o log incremental do `logPath` da task (#10699 item 2): `x.log` →
 * `x.live.log`. Mudar o `logPath` no registro move os dois juntos.
 */
export function liveLogRelFromLogPath(logPath: string): string {
  return logPath.endsWith(".log") ? `${logPath.slice(0, -".log".length)}.live.log` : `${logPath}.live.log`;
}

/**
 * Log INCREMENTAL da cadeia, relativo a `data/` (#10672). O task-runner
 * (`execTsxStep`, `spawnSync`) só grava o `logPath` da task quando
 * o processo termina, e a cadeia pode passar de 16h: reboot, OOM ou
 * `systemctl stop` no meio apagavam tudo, inclusive o veredito do review,
 * que roda antes do overnight. Este arquivo recebe cada linha na hora, via
 * `appendFileSync`. É um arquivo separado de propósito: anexar direto no log
 * do task-runner duplicaria todas as linhas quando a run termina normalmente,
 * e o contrato do task-runner vale pras outras tasks também. Derivado do
 * `logPath` da task (#10699), hoje `overnight/.nightly-chain.live.log`.
 */
export const LIVE_LOG_REL = (() => {
  const task = getScheduledTaskByName(NIGHTLY_CHAIN_TASK_NAME);
  return task ? liveLogRelFromLogPath(task.logPath) : FALLBACK_LIVE_LOG_REL;
})();

/**
 * Sufixo da rotação (#10699 item 3): no início de cada run o log incremental
 * da run anterior vira `{LIVE_LOG_REL}.prev` (sobrescrevendo o `.prev` mais
 * antigo). O arquivo sincroniza pelo OneDrive; sem rotação ele só crescia.
 */
export const LIVE_LOG_PREV_SUFFIX = ".prev";

function liveLogAbs(repoRootAbs: string): string {
  return join(repoRootAbs, "data", ...LIVE_LOG_REL.split("/"));
}

/** Renomeia o log incremental da run anterior pra `.prev`. Fail-soft: nunca lança. */
export function rotateLiveLog(repoRootAbs: string): void {
  if (!existsSync(join(repoRootAbs, "data"))) return;
  const path = liveLogAbs(repoRootAbs);
  if (!existsSync(path)) return;
  try {
    renameSync(path, `${path}${LIVE_LOG_PREV_SUFFIX}`);
  } catch (e) {
    console.warn(`run-nightly-chain: falha ao rotacionar o log incremental ${path} — ${(e as Error).message}`);
  }
}

/** Formato de cada linha do log incremental: mesmo prefixo ISO do `log` default. */
export function formatLiveLogLine(line: string, at: Date = new Date()): string {
  return `[${at.toISOString()}] ${line}\n`;
}

let liveLogWarned = false;

function defaultAppendLiveLog(repoRootAbs: string, line: string): void {
  // Clone sem `data/` (sessão cloud, CI): nada a gravar, igual ao
  // `defaultWriteOvernightOutput`.
  if (!existsSync(join(repoRootAbs, "data"))) return;
  const path = liveLogAbs(repoRootAbs);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, formatLiveLogLine(line), "utf8");
  } catch (e) {
    // Fail-soft: perder o log incremental não pode derrubar a cadeia. Avisa
    // uma vez só, pra não repetir o warning a cada linha.
    if (!liveLogWarned) {
      liveLogWarned = true;
      console.warn(`run-nightly-chain: falha ao gravar o log incremental ${path} — ${(e as Error).message}`);
    }
  }
}

function defaultWriteOvernightOutput(repoRootAbs: string, stdout: string): void {
  const dir = join(repoRootAbs, "data", "overnight");
  if (!existsSync(join(repoRootAbs, "data"))) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".nightly-chain-last-overnight.json"), stdout, "utf8");
  } catch (e) {
    console.warn(`run-nightly-chain: falha ao gravar o output do overnight — ${(e as Error).message}`);
  }
}

export const DEFAULT_DEPS: NightlyChainDeps = {
  spawn: spawnSync,
  resolveClaudeBin,
  hasActiveOvernight: (root) => hasActiveSessionOfKind(root, "overnight"),
  env: process.env,
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  writeOvernightOutput: defaultWriteOvernightOutput,
  appendLiveLog: defaultAppendLiveLog,
  rotateLiveLog,
};

export function runReview(repoRootAbs: string, claudeBin: string, deps: NightlyChainDeps): ReviewOutcome {
  const script = resolve(repoRootAbs, DAILY_REVIEW_SCRIPT);
  if (!existsSync(script)) {
    return { status: "failed", exitCode: null, tail: `script ausente: ${script}` };
  }
  const r = deps.spawn("bash", [script], {
    cwd: repoRootAbs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: buildReviewEnv(deps.env, claudeBin),
    timeout: REVIEW_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = classifyReviewResult(r);
  const tail = tailLines(`${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`);
  return { status, exitCode: r.status, tail };
}

export function runOvernight(repoRootAbs: string, claudeBin: string, deps: NightlyChainDeps): OvernightOutcome {
  const r = deps.spawn(claudeBin, buildOvernightClaudeArgs(repoRootAbs), {
    cwd: repoRootAbs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: buildOvernightEnv(deps.env),
    maxBuffer: 256 * 1024 * 1024,
  });
  deps.writeOvernightOutput(repoRootAbs, r.stdout ?? "");
  if (r.error || r.status !== 0) {
    deps.log(
      `overnight: FALHOU exit=${r.status ?? "?"} ${r.error ? `erro=${r.error.message} ` : ""}tail=${tailLines(r.stderr ?? "")}`,
    );
    return { status: "failed", exitCode: r.status };
  }
  return { status: "ok", exitCode: 0 };
}

export function main(repoRootAbs: string, baseDeps: NightlyChainDeps = DEFAULT_DEPS): number {
  // Toda linha vai pro `log` (stdout → log final do task-runner) E, na hora,
  // pro log incremental (#10672) — inclusive as que `runOvernight` emite.
  // Antes da 1ª linha, a run anterior vira `.prev` (#10699).
  baseDeps.rotateLiveLog?.(repoRootAbs);
  const deps: NightlyChainDeps = {
    ...baseDeps,
    log: (line) => {
      baseDeps.log(line);
      baseDeps.appendLiveLog?.(repoRootAbs, line);
    },
  };
  deps.log("cadeia noturna: início (#10552)");

  let claudeBin: string;
  try {
    claudeBin = deps.resolveClaudeBin();
  } catch (e) {
    // Sem binário nem o review nem o overnight rodam — falha dura, nomeada.
    deps.log(`cadeia noturna: FALHOU — binário claude não encontrado: ${(e as Error).message}`);
    return 1;
  }

  // 1. Review. Qualquer desfecho segue pro passo 2.
  let review: ReviewOutcome;
  try {
    review = runReview(repoRootAbs, claudeBin, deps);
  } catch (e) {
    review = { status: "failed", exitCode: null, tail: (e as Error).message };
  }
  deps.log(`review: ${review.status} exit=${review.exitCode ?? "?"} tail=${review.tail}`);
  if (review.status === "failed" || review.status === "timeout") {
    deps.log("review: falhou — o overnight sobe mesmo assim (o backlog existe de qualquer jeito)");
  }

  // 2. Overnight, sempre — exceto se já houver uma rodada overnight viva.
  let overnight: OvernightOutcome;
  if (deps.hasActiveOvernight(repoRootAbs)) {
    deps.log("overnight: SKIP — já existe sessão overnight ativa no session-registry (rodada aberta à mão?)");
    overnight = { status: "skipped-active-session", exitCode: null };
  } else {
    deps.log(`overnight: claude --print /diaria-overnight ${AGENDADO_FLAG} (${NIGHTLY_OVERNIGHT_MODEL}/${NIGHTLY_OVERNIGHT_EFFORT})`);
    try {
      overnight = runOvernight(repoRootAbs, claudeBin, deps);
    } catch (e) {
      deps.log(`overnight: FALHOU — ${(e as Error).message}`);
      overnight = { status: "failed", exitCode: null };
    }
  }

  const code = chainExitCode(review.status, overnight);
  deps.log(`cadeia noturna: fim review=${review.status} overnight=${overnight.status} exit=${code}`);
  return code;
}

if (isMainModule(import.meta.url)) {
  const repoRootAbs = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  process.exit(main(repoRootAbs));
}
