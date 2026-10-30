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
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../lib/cli-args.ts";
import { normalizeIssues } from "../lib/plan-issues-normalize.ts";
import { isTerminalForBar } from "../overnight-statusline.ts";
import { resolveClaudeBin } from "../lib/resolve-claude-bin.ts";
import { getScheduledTaskByName } from "../lib/scheduled-tasks.ts";
import { hasActiveSessionOfKind } from "../lib/session-registry.ts";
import { NO_BACKGROUND_DIRECTIVE, dataAddDirArgs } from "../lib/edition-stage-runner.ts";
import { claudeCliEnv } from "./run-scheduled-edicao.ts";
import {
  EXIT_WORKSPACE_UNTRUSTED,
  checkWorkspaceTrust,
  stderrSaysWorkspaceUntrusted,
  type WorkspaceTrustResult,
} from "../lib/claude-workspace-trust.ts";

export { EXIT_WORKSPACE_UNTRUSTED } from "../lib/claude-workspace-trust.ts";

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

/**
 * Overnight saiu 0 mas não gravou `plan.json` nem `report.md` em
 * `data/overnight/*` durante a run (#10808). A Fase 0 grava o `plan.json`
 * antes de decidir qualquer coisa, inclusive "0 elegíveis"; sair sem ele é
 * aborto cedo, que antes aparecia como `overnight=ok`. Fora de
 * `successExitCodes`: a unit sai `failed` e o alarme de units avisa.
 */
export const EXIT_OVERNIGHT_NO_TRACE = 4;

export const EXIT_OVERNIGHT_DELIVERY_ALARM = 5;

/** Rodada terminou com trabalho pendente ou plano ilegível (#11665). */
export const EXIT_OVERNIGHT_INCOMPLETE = 6;

export type ReviewStatus = "ok" | "noop" | "failed" | "timeout";
export type OvernightStatus =
  | "ok"
  | "failed"
  | "no-trace"
  | "delivery-alarm"
  | "rodada-incompleta"
  | "skipped-active-session"
  /** Repo sem `hasTrustDialogAccepted` em `~/.claude.json`, ou o CLI disse isso no stderr (#11383). */
  | "untrusted-workspace";

export interface ReviewOutcome {
  status: ReviewStatus;
  exitCode: number | null;
  tail: string;
  /** Linha `RESUMO-DAILY-REVIEW:` do review completo, lida do transcript final (#10779). */
  summary?: string | null;
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
    "stream-json",
    "--verbose",
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
 * Linha EXATA que `opus-daily-diff-review.sh` emite no noop (#10779). Ancorada
 * por linha (flag `m`): desde o #10699 o stderr do review carrega o stream-json
 * inteiro, com os `tool_result` de `git diff`/`git show`, e qualquer diff que
 * contivesse a string "— noop" (o próprio script, este arquivo) rotulava um
 * review completo como noop. Dentro de um evento JSON a mensagem fica no meio
 * da linha, com a quebra escapada, então a âncora `^...$` não casa.
 */
export const REVIEW_NOOP_LINE_RE = /^\[daily-review\] nada novo desde o último review \(.*\) — noop$/m;

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
  return REVIEW_NOOP_LINE_RE.test(r.stderr ?? "") ? "noop" : "ok";
}

/** Teto por linha no tail legível (#10779): nenhuma linha solta pode inflar o log da cadeia. */
export const TAIL_LINE_MAX_CHARS = 500;

function capLine(l: string): string {
  return l.length > TAIL_LINE_MAX_CHARS ? `${l.slice(0, TAIL_LINE_MAX_CHARS)}…` : l;
}

/**
 * Tail LEGÍVEL de uma saída que mistura linhas de texto com eventos
 * stream-json (#10779). Descarta as linhas de evento (começam com `{`) e o
 * fragmento de evento que sobra quando a cauda lida do disco começa no meio
 * de uma linha (termina com `}`), e corta cada linha restante em
 * `TAIL_LINE_MAX_CHARS`.
 */
export function readableTail(text: string, n = 8): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("{") && !l.endsWith("}"))
    .map(capLine);
  return tailLines(lines.join("\n"), n);
}

/** Transcript final do review, relativo a `data/` (`$OUT_FILE` de `opus-daily-diff-review.sh`). */
export const REVIEW_OUTPUT_REL = "continuo/last-daily-review-output.txt";

/** Primeira linha `RESUMO-DAILY-REVIEW:` do texto (mesmo `grep -m1` do script), ou null. */
export function extractReviewSummary(text: string): string | null {
  const line = text.split(/\r?\n/).find((l) => l.includes("RESUMO-DAILY-REVIEW:"));
  return line ? capLine(line.trim()) : null;
}

/**
 * Lê o resumo do review completo de `$OUT_FILE` (#10779). Só chamado com
 * status `ok`: o script trunca o arquivo antes do `claude -p` e só sai 0 depois
 * de conferir o marcador, então nesse caso o arquivo é desta run. Fail-soft.
 */
export function readReviewSummary(repoRootAbs: string): string | null {
  const path = join(repoRootAbs, "data", ...REVIEW_OUTPUT_REL.split("/"));
  try {
    return existsSync(path) ? extractReviewSummary(readFileTail(path)) : null;
  } catch {
    return null;
  }
}

/** Evento `result` do stream-json do `claude --print` (#10808). */
export interface StreamResult {
  subtype: string | null;
  isError: boolean;
  numTurns: number | null;
  durationMs: number | null;
  result: string;
}

/**
 * Último evento `type: "result"` de uma saída stream-json (#10808). Linhas que
 * não parseiam (o fragmento inicial da cauda lida do disco, texto solto) são
 * ignoradas. null = nenhum evento `result`: a sessão não chegou ao fim normal.
 */
export function parseStreamResult(stdout: string): StreamResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].trim();
    if (!l.startsWith("{")) continue;
    let ev: unknown;
    try {
      ev = JSON.parse(l);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    const e = ev as Record<string, unknown>;
    if (e.type !== "result") continue;
    return {
      subtype: typeof e.subtype === "string" ? e.subtype : null,
      isError: e.is_error === true,
      numTurns: typeof e.num_turns === "number" ? e.num_turns : null,
      durationMs: typeof e.duration_ms === "number" ? e.duration_ms : null,
      result: typeof e.result === "string" ? e.result : "",
    };
  }
  return null;
}

/** Linha de log com o desfecho da sessão do overnight (#10808). */
export function formatStreamResult(r: StreamResult | null): string {
  if (!r) {
    return "overnight: AVISO — sem evento result no stream-json (a sessão não chegou ao fim normal; ver .nightly-chain-last-overnight.json)";
  }
  const secs = r.durationMs === null ? "?" : String(Math.round(r.durationMs / 1000));
  return `overnight: resultado subtype=${r.subtype ?? "?"} is_error=${r.isError} turns=${r.numTurns ?? "?"} duracao_s=${secs} tail=${readableTail(r.result) || "(vazio)"}`;
}

/** Arquivos que contam como rastro de uma rodada overnight (#10808). */
export const ROUND_TRACE_FILES = ["plan.json", "report.md"] as const;

/** Folga de mtime pra granularidade de filesystem/OneDrive. */
const ROUND_TRACE_MTIME_SLACK_MS = 2000;

/**
 * Arquivos de rodada (`data/overnight/{dir}/plan.json|report.md`) modificados
 * desde `sinceMs` (#10808). null = não dá pra verificar (sem `data/`, ou a
 * leitura do diretório falhou); [] = verificado, nenhum rastro.
 */
export function findRoundTraceSince(repoRootAbs: string, sinceMs: number): string[] | null {
  if (!existsSync(join(repoRootAbs, "data"))) return null;
  const dir = join(repoRootAbs, "data", "overnight");
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const hits: string[] = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue;
    for (const f of ROUND_TRACE_FILES) {
      try {
        if (statSync(join(dir, name, f)).mtimeMs >= sinceMs - ROUND_TRACE_MTIME_SLACK_MS) hits.push(`${name}/${f}`);
      } catch {
        // ausente, ou `name` não é diretório: não é rastro
      }
    }
  }
  return hits;
}

/** Contagem estruturada no relatório final; nunca infere entrega da prosa (#11235). */
export function readDeliveryCounts(report: string): { implementedUnits: number; openedPrs: number } | null {
  const matches = [...report.matchAll(/<!-- overnight-delivery: (.*?) -->/g)];
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(matches[0][1]);
    if (!value || !Number.isSafeInteger(value.implementedUnits) || value.implementedUnits < 0 ||
        !Number.isSafeInteger(value.openedPrs) || value.openedPrs < 0) return null;
    return { implementedUnits: value.implementedUnits, openedPrs: value.openedPrs };
  } catch { return null; }
}

/** Pendências finais; schema inválido falha fechado, issues: [] é fila vazia. */
export function pendingRoundIssues(text: string): string[] {
  const plan = JSON.parse(text);
  if (!plan || typeof plan !== "object" || !plan.issues || typeof plan.issues !== "object") {
    return ["schema de issues ausente/inválido"];
  }
  return normalizeIssues<{ number?: number; status?: string; in_round?: boolean }>(plan)
    .filter(issue => !issue || (issue.in_round !== false && !isTerminalForBar(issue.status ?? "")))
    .map(issue => `#${issue?.number ?? "?"}:${issue?.status ?? "status ausente"}`);
}

/**
 * Exit code final da cadeia. Falha do overnight vence (é a parte cara e a
 * que o editor precisa ver primeiro); review falho com overnight ok/pulado →
 * `EXIT_REVIEW_FAILED`; o resto → 0.
 */
export function chainExitCode(review: ReviewStatus, overnight: OvernightOutcome): number {
  // Código fixo, não o exit do `claude`: um `claude` que saísse 3 seria lido
  // como "só o review falhou". O exit original fica no log.
  // Workspace sem confiança vence tudo: é a causa raiz de qualquer outra
  // falha da mesma run (allowlist inteira ignorada, #11383).
  if (overnight.status === "untrusted-workspace") return EXIT_WORKSPACE_UNTRUSTED;
  if (overnight.status === "failed") return EXIT_OVERNIGHT_FAILED;
  if (overnight.status === "no-trace") return EXIT_OVERNIGHT_NO_TRACE;
  if (overnight.status === "rodada-incompleta") return EXIT_OVERNIGHT_INCOMPLETE;
  if (overnight.status === "delivery-alarm") return EXIT_OVERNIGHT_DELIVERY_ALARM;
  if (review === "failed" || review === "timeout") return EXIT_REVIEW_FAILED;
  return 0;
}

export interface NightlyChainDeps {
  spawn: typeof spawnSync;
  resolveClaudeBin: () => string;
  hasActiveOvernight: (repoRootAbs: string) => boolean;
  env: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /**
   * Anexa UMA linha ao log incremental (`LIVE_LOG_REL`, #10672) no momento em
   * que ela é emitida. Opcional: ausente, a cadeia só loga via `log`.
   */
  appendLiveLog?: (repoRootAbs: string, line: string) => void;
  /** Rotaciona o log incremental da run anterior (#10699). Opcional, chamado uma vez no início do `main`. */
  rotateLiveLog?: (repoRootAbs: string) => void;
  /** Resumo do review completo (#10779). Opcional: ausente, o log fica sem `resumo=`. */
  readReviewSummary?: (repoRootAbs: string) => string | null;
  /**
   * Rastro de rodada gravado desde `sinceMs` (#10808). Opcional: ausente, ou
   * devolvendo null (não verificável), o runner não reprova por falta de rastro.
   */
  findRoundTrace?: (repoRootAbs: string, sinceMs: number) => string[] | null;
  /**
   * Preflight de confiança do workspace (#11383), chamado antes de subir o
   * overnight. Recebe o `env` da cadeia (de onde sai o `HOME`). Opcional:
   * ausente, o preflight não roda (harness de teste antigo); o
   * `DEFAULT_DEPS` sempre liga.
   */
  checkWorkspaceTrust?: (repoRootAbs: string, env: NodeJS.ProcessEnv) => WorkspaceTrustResult;
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
  // captura persistente dos filhos.
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

/**
 * Teto de bytes lidos de volta de cada arquivo de saída persistido (#10748).
 * Os consumidores (`tailLines`, `classifyReviewResult`) só olham a cauda; o
 * arquivo inteiro segue no disco pra diagnóstico.
 */
export const PERSISTED_OUTPUT_TAIL_BYTES = 1024 * 1024;

/**
 * Lê só os últimos `maxBytes` bytes de `path` (#10748). O stream-json do
 * overnight não tem teto de tamanho: `readFileSync` do arquivo inteiro lança
 * acima do limite de string do V8 e transformava um overnight que terminou bem
 * em "overnight: FALHOU". Um caractere multibyte cortado no início vira U+FFFD
 * e é descartado.
 */
export function readFileTail(path: string, maxBytes: number = PERSISTED_OUTPUT_TAIL_BYTES): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, size - length + read);
      if (n === 0) break;
      read += n;
    }
    const text = buf.subarray(0, read).toString("utf8");
    return length < size ? text.replace(/^�+/, "") : text;
  } finally {
    closeSync(fd);
  }
}

/** stdout/stderr vão direto ao disco, inclusive enquanto spawnSync bloqueia (#10699).
 * Uma geração anterior é preservada. Sem data/, mantém a captura em memória.
 * Erros de armazenamento falham explicitamente antes de iniciar o filho.
 * Só a cauda de cada arquivo volta pra memória (#10748).
 */
export const spawnWithPersistentOutput: typeof spawnSync = ((command, args, options) => {
  const root = String(options?.cwd ?? process.cwd());
  if (!existsSync(join(root, "data"))) return spawnSync(command, args, options);
  const phase = command === "bash" ? "review" : "overnight";
  const dir = join(root, "data", "overnight");
  mkdirSync(dir, { recursive: true });
  const stdoutPath = join(dir, `.nightly-chain-last-${phase}.${phase === "overnight" ? "json" : "log"}`);
  const stderrPath = join(dir, `.nightly-chain-last-${phase}.stderr.log`);
  const fds: number[] = [];
  try {
    for (const path of [stdoutPath, stderrPath]) {
      if (existsSync(path)) renameSync(path, `${path}.prev`);
      fds.push(openSync(path, "w"));
    }
    const result = spawnSync(command, args, { ...options, stdio: ["ignore", fds[0], fds[1]] });
    return { ...result, stdout: readFileTail(stdoutPath), stderr: readFileTail(stderrPath) };
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}) as typeof spawnSync;

export const DEFAULT_DEPS: NightlyChainDeps = {
  spawn: spawnWithPersistentOutput,
  resolveClaudeBin,
  hasActiveOvernight: (root) => hasActiveSessionOfKind(root, "overnight"),
  env: process.env,
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
  appendLiveLog: defaultAppendLiveLog,
  rotateLiveLog,
  readReviewSummary,
  findRoundTrace: findRoundTraceSince,
  checkWorkspaceTrust: (root, env) => checkWorkspaceTrust(root, { env }),
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
  // Sem os eventos stream-json (#10779): o stderr do review carrega o stream inteiro.
  const tail = readableTail(`${r.stdout ?? ""}\n${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`);
  const summary = status === "ok" ? (deps.readReviewSummary?.(repoRootAbs) ?? null) : null;
  return { status, exitCode: r.status, tail, summary };
}

export function runOvernight(repoRootAbs: string, claudeBin: string, deps: NightlyChainDeps): OvernightOutcome {
  const startedAt = Date.now();
  const r = deps.spawn(claudeBin, buildOvernightClaudeArgs(repoRootAbs), {
    cwd: repoRootAbs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: buildOvernightEnv(deps.env),
    maxBuffer: 256 * 1024 * 1024,
  });
  // Desfecho da sessão no log da cadeia, em qualquer exit (#10808): sem isto,
  // "fila vazia" e "abortou cedo" eram a mesma linha `overnight=ok`.
  const result = parseStreamResult(r.stdout ?? "");
  deps.log(formatStreamResult(result));
  // Defesa depois da run (#11383): o preflight leu o arquivo, mas quem decide
  // é o CLI. Se ele anunciou no stderr que ignorou a allowlist, a rodada
  // inteira rodou sem permissões, qualquer que seja o exit.
  if (stderrSaysWorkspaceUntrusted(r.stderr)) {
    deps.log(
      "overnight: WORKSPACE NÃO CONFIADO — o CLI avisou no stderr que ignorou a allowlist de .claude/settings.json " +
        `(this workspace has not been trusted); exit=${r.status ?? "?"}. Aceitar o diálogo de confiança em ${repoRootAbs} (#11383)`,
    );
    return { status: "untrusted-workspace", exitCode: r.status };
  }
  if (r.error || r.status !== 0) {
    deps.log(
      `overnight: FALHOU exit=${r.status ?? "?"} ${r.error ? `erro=${r.error.message} ` : ""}tail=${tailLines(r.stderr ?? "")}`,
    );
    return { status: "failed", exitCode: r.status };
  }
  if (result?.isError) {
    deps.log(`overnight: FALHOU — exit 0, mas o evento result veio com is_error (subtype=${result.subtype ?? "?"})`);
    return { status: "failed", exitCode: 0 };
  }
  const trace = deps.findRoundTrace?.(repoRootAbs, startedAt) ?? null;
  if (trace === null) {
    if (deps.findRoundTrace) deps.log("overnight: AVISO — não deu pra verificar o rastro da rodada em data/overnight/");
  } else if (trace.length === 0) {
    deps.log(
      "overnight: SEM RASTRO — exit 0, mas nenhum plan.json/report.md em data/overnight/ foi gravado nesta run (aborto cedo; ver .nightly-chain-last-overnight.json)",
    );
    return { status: "no-trace", exitCode: 0 };
  } else {
    deps.log(`overnight: rastro ${trace.join(", ")}`);
    // Independe de turns e da chegada tardia de PRs dos subagentes (#11665).
    const plans = new Set(trace.filter(path => path.endsWith("/plan.json")));
    // Report atualizado não pode esconder um plano pendente cujo mtime ficou antigo.
    for (const path of trace) {
      const plan = `${dirname(path)}/plan.json`;
      if (existsSync(join(repoRootAbs, "data", "overnight", plan))) plans.add(plan);
    }
    for (const path of plans) {
      let pending: string[];
      try {
        pending = pendingRoundIssues(readFileSync(join(repoRootAbs, "data", "overnight", path), "utf8"));
      } catch { pending = ["plano ausente/ilegível"]; }
      if (pending.length > 0) {
        deps.log(`overnight: RODADA INCOMPLETA — ${path}: ${pending.join(", ")}; turns=${result?.numTurns ?? "?"}; verificar worktrees e PRs overnight antes de retomar; alarme via exit 6`);
        return { status: "rodada-incompleta", exitCode: 0 };
      }
    }
    const reports = trace.filter((path) => path.endsWith("/report.md"));
    let alarm = reports.length === 0;
    for (const path of reports) {
      let counts = null;
      try { counts = readDeliveryCounts(readFileSync(join(repoRootAbs, "data", "overnight", path), "utf8")); } catch { /* ausência não é zero entrega */ }
      deps.log(`overnight: entrega ${path} ${counts ? JSON.stringify(counts) : "contagem ausente/inválida"}`);
      if (!counts || (counts.openedPrs === 0 && counts.implementedUnits >= 1)) alarm = true;
    }
    if (alarm) {
      deps.log("overnight: ALARME DE ENTREGA — 0 PRs com unidade implementada, ou contagem final ausente/inválida; Diaria-Systemd-Failed-Units-Alarm via exit 5");
      return { status: "delivery-alarm", exitCode: 0 };
    }
  }
  return { status: "ok", exitCode: 0 };
}

/**
 * Preflight de confiança (#11383). true = NÃO subir o overnight. Exceção no
 * próprio check conta como não confiado (nunca fail-soft: é o cenário que a
 * issue quer ver).
 */
function preflightUntrusted(repoRootAbs: string, deps: NightlyChainDeps): boolean {
  if (!deps.checkWorkspaceTrust) return false;
  let trust: WorkspaceTrustResult;
  try {
    trust = deps.checkWorkspaceTrust(repoRootAbs, deps.env);
  } catch (e) {
    deps.log(`overnight: PULADO — confiança do workspace: erro no preflight (${(e as Error).message}); tratado como não confiado (#11383)`);
    return true;
  }
  if (trust.status === "trusted") {
    deps.log(`overnight: ${trust.message}`);
    return false;
  }
  deps.log(`overnight: PULADO — ${trust.message}`);
  return true;
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
  deps.log(
    `review: ${review.status} exit=${review.exitCode ?? "?"}${review.summary ? ` resumo=${review.summary}` : ""} tail=${review.tail}`,
  );
  if (review.status === "failed" || review.status === "timeout") {
    deps.log("review: falhou — o overnight sobe mesmo assim (o backlog existe de qualquer jeito)");
  }

  // 2. Overnight, sempre — exceto se já houver uma rodada overnight viva.
  let overnight: OvernightOutcome;
  if (deps.hasActiveOvernight(repoRootAbs)) {
    deps.log("overnight: SKIP — já existe sessão overnight ativa no session-registry (rodada aberta à mão?)");
    overnight = { status: "skipped-active-session", exitCode: null };
  } else if (preflightUntrusted(repoRootAbs, deps)) {
    overnight = { status: "untrusted-workspace", exitCode: null };
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
