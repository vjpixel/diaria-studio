#!/usr/bin/env node
/**
 * scripts/claude-session-version-drift-alarm.ts (#6927)
 *
 * Alarme "sem política" (opção 3 do #6927): detecta sessão(ões) de Claude
 * Code de vida longa (`--remote-control`, tmux) cujo binário em memória
 * está defasado do que o auto-updater já reinstalou em disco — o sintoma
 * medido ao vivo em #6875/#6891 que realimentava um ciclo de reinstalação
 * (~30min, ~214MB/ciclo, 4 quebras de cron em ~15h antes do fix mecânico
 * do #6891 Partes A/B). Não repara nada — só nomeia o estado por e-mail.
 *
 * Lógica pura em `scripts/lib/claude-session-version-drift-alarm.ts` — este
 * arquivo é só I/O (`ps` pra enumerar processos + idade, `readlink` de
 * `/proc/<pid>/exe`, estado, e-mail), mesmo molde de
 * `scripts/node-modules-loop-alarm.ts`/`scripts/robots-txt-drift-check.ts`.
 *
 * Uso:
 *   npx tsx scripts/claude-session-version-drift-alarm.ts                  # avalia + persiste + alarma se achado NOVO
 *   npx tsx scripts/claude-session-version-drift-alarm.ts --dry-run        # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/claude-session-version-drift-alarm.ts --to email@x     # override do destinatário
 *   npx tsx scripts/claude-session-version-drift-alarm.ts --threshold-hours 24  # default 24 (medição real: 31h/36h)
 *
 * Plataforma: Linux apenas — depende de `/proc/<pid>/exe` (achado do #6875
 * é específico do `helios`, único servidor que roda sessões de vida longa
 * hoje). Em qualquer outra plataforma (`process.platform !== "linux"`), o
 * script sai 0 sem checar nada (fail-soft — nunca falha o timer systemd por
 * rodar num SO onde a técnica não se aplica).
 *
 * Env: precisa de `data/.credentials.json` com o scope `gmail.send` só
 * quando há achado pra de fato enviar o e-mail; a checagem em si (`ps` +
 * `readlink`) não depende de nenhuma credencial. Persistir o estado de
 * idempotência precisa do junction `data/`.
 *
 * Estado (idempotência): `data/claude-session-version-drift-alarm/state.json`.
 *
 * Escopo deliberadamente mínimo (#6927 "alarme, sem política"): nenhuma
 * issue GitHub é criada automaticamente (diferente de `node-modules-loop-alarm.ts`,
 * que integra com `alarm-issues.ts`) — o achado aqui não é um bug a
 * rastrear até fechar, é um estado operacional que reaparece toda vez que
 * uma sessão fica velha o bastante, então uma issue reaberta a cada ciclo
 * seria ruído. Só e-mail.
 */
import { existsSync, readFileSync, mkdirSync, readlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getStringArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  evaluateSessionDrift,
  isSessionDriftPending,
  shouldAlarmClaudeSessionDrift,
  advanceClaudeSessionDriftAlarmState,
  emptyClaudeSessionDriftAlarmState,
  buildClaudeSessionDriftAlarmEmail,
  type ClaudeSessionProcess,
  type SessionDriftEvaluation,
  type ClaudeSessionDriftAlarmState,
} from "./lib/claude-session-version-drift-alarm.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "claude-session-version-drift-alarm", "state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[claude-session-version-drift-alarm]";

/** Threshold default (#6927) — a medição real do #6875 que causava o loop
 * usava sessões de 31h/36h; 24h dá folga suficiente pra não alarmar sobre
 * uma sessão de trabalho normal do dia. */
const DEFAULT_THRESHOLD_HOURS = 24;

// ─── Estado (idempotência) — mesmo padrão I/O de node-modules-loop-alarm.ts ─

export function loadState(statePath: string = STATE_PATH): ClaudeSessionDriftAlarmState {
  if (!existsSync(statePath)) return emptyClaudeSessionDriftAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<ClaudeSessionDriftAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint
        : null;
    const checkedAt = typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt : null;
    return { lastAlarmedFingerprint: fingerprint ?? null, lastCheckedAt: checkedAt ?? null };
  } catch {
    return emptyClaudeSessionDriftAlarmState();
  }
}

export function saveState(state: ClaudeSessionDriftAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Descoberta de processos (I/O) ─────────────────────────────────────────

/** Injeção de `execFileSync`/`readlinkSync` — só pra testabilidade
 * determinística, mesmo racional de `NodeModulesFsOps` em
 * `node-modules-loop-alarm.ts`. */
export interface SessionDiscoveryOps {
  execFileSync: typeof execFileSync;
  readlinkSync: typeof readlinkSync;
}

const defaultOps: SessionDiscoveryOps = { execFileSync, readlinkSync };

/**
 * Enumera processos `claude ... --remote-control` vivos via `ps -eo
 * pid=,etimes=,args=` — só sessões de vida longa via Remote Control (tmux,
 * sem terminal anexado) contam (o achado do #6875 foi medido nelas; uma
 * sessão comum num terminal anexado não fica dias viva).
 *
 * `ps` falhando PROPAGA (nunca vira lista vazia) — achado do #6953 (review
 * silent-failure-hunter): num host Linux (este script já saiu cedo em
 * qualquer outro `process.platform`), `ps` está sempre presente; uma falha
 * aqui é ela mesma uma anomalia do host (binário quebrado, `/proc`
 * indisponível, recurso exaurido), nunca "confirmado zero sessões". Tratar
 * como lista vazia faria exatamente o que este alarme existe pra evitar em
 * QUALQUER outro lugar do módulo (indeterminado virando "ok" por omissão)
 * — e tem efeito colateral pior: uma falha transitória de `ps` zeraria
 * `evaluations`, `advanceClaudeSessionDriftAlarmState` leria isso como
 * "nada pendente" e resetaria `lastAlarmedFingerprint` pra `null`, fazendo
 * a PRÓXIMA execução bem-sucedida re-alarmar um drift que já tinha sido
 * avisado (duplicata) em vez de simplesmente re-tentar a checagem que
 * falhou. Deixar propagar faz `main()` sair com `exitCode = 1` sem tocar
 * `saveState` — o task-runner registra a run como falha de verdade, e o
 * cursor de idempotência fica intacto pra próxima tentativa.
 */
export function listLongLivedClaudeProcesses(ops: SessionDiscoveryOps = defaultOps): ClaudeSessionProcess[] {
  const raw = ops.execFileSync("ps", ["-eo", "pid=,etimes=,args="], { encoding: "utf8" });

  const sessions: ClaudeSessionProcess[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pidStr, etimesStr, cmd] = match;
    if (!cmd.includes("claude") || !cmd.includes("--remote-control")) continue;
    const pid = Number(pidStr);
    const ageSeconds = Number(etimesStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ageSeconds)) continue;
    sessions.push({ pid, cmd, ageSeconds });
  }
  return sessions;
}

/** `readlink /proc/<pid>/exe` — `null` se a leitura falhar por QUALQUER
 * motivo (processo já morreu entre o `ps` e agora, permissão, plataforma
 * sem `/proc`). Nunca lança — quem chama trata `null` como "unresolved",
 * nunca como "ok" (ver `evaluateSessionDrift`). */
export function readExeLink(pid: number, ops: SessionDiscoveryOps = defaultOps): string | null {
  try {
    return ops.readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getStringArg(argv, "to");
  const thresholdArg = getStringArg(argv, "threshold-hours");
  const thresholdHours = thresholdArg ? Number(thresholdArg) : DEFAULT_THRESHOLD_HOURS;
  if (!Number.isFinite(thresholdHours) || thresholdHours <= 0) {
    throw new Error(`--threshold-hours deve ser um número positivo, recebido "${thresholdArg}"`);
  }

  if (process.platform !== "linux") {
    console.log(`${LOG_PREFIX} plataforma ${process.platform} não suportada (depende de /proc/<pid>/exe) — nada a checar.`);
    return;
  }

  const processes = listLongLivedClaudeProcesses();
  const evaluations: SessionDriftEvaluation[] = processes.map((session) => {
    const ageHours = session.ageSeconds / 3600;
    const exeLinkTarget = ageHours >= thresholdHours ? readExeLink(session.pid) : null;
    return evaluateSessionDrift(session, exeLinkTarget, thresholdHours);
  });

  for (const e of evaluations) console.log(`${LOG_PREFIX} ${e.message}`);
  if (evaluations.length === 0) console.log(`${LOG_PREFIX} nenhum processo claude --remote-control encontrado.`);

  const pending = evaluations.filter(isSessionDriftPending);
  const state = loadState();

  if (shouldAlarmClaudeSessionDrift(state, evaluations)) {
    const { subject, body } = buildClaudeSessionDriftAlarmEmail(evaluations, thresholdHours, new Date());
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Sem try/catch — mesmo racional de node-modules-loop-alarm.ts: se o
      // envio falhar, o cursor abaixo não avança, então a próxima execução
      // tenta alarmar de novo em vez de marcar como "já avisado" sem o
      // editor ter recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (${pending.length} sessão(ões) pendente(s)).`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (sem sessão pendente, ou o mesmo conjunto já foi alarmado antes).`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: cursor NÃO avançado.`);
    return;
  }

  saveState(advanceClaudeSessionDriftAlarmState(evaluations, new Date()));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
