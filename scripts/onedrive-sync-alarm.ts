#!/usr/bin/env node
/**
 * scripts/onedrive-sync-alarm.ts (#5548, item 3)
 *
 * Task periódica (ver `docs/onedrive-sync-setup.md` pro horário/timer
 * recomendado): checa se o daemon `onedrive.service` (systemd --user) está
 * de fato ativo E se `data/.onedrive-sync-canary.json` continua sendo
 * atualizado dentro da tolerância configurada — os dois sinais que teriam
 * detectado o incidente #5548 (serviço morto há 17h, `data/` continuando
 * localmente funcional, ninguém percebendo).
 *
 * Lógica pura em `scripts/lib/onedrive-sync-alarm.ts` — este arquivo é só
 * I/O: `systemctl --user is-active onedrive` (SÓ LEITURA — ver guard
 * abaixo), leitura/escrita do canário, envio de e-mail, dedup/criação de
 * issue via `scripts/lib/alarm-issues.ts`.
 *
 * **GUARD (invariável, #5548 regras obrigatórias):** este script NUNCA
 * chama `systemctl` com `start`/`stop`/`restart`/`enable`/`disable` — só
 * `is-active` (leitura). Religar o serviço é ação manual do editor.
 *
 * **Guard de máquina sem OneDrive** (sessão cloud, clone fresco, ou
 * qualquer máquina onde o cliente OneDrive não está instalado): a consulta
 * ao systemd falha com ENOENT ou "unit not found" — tratado como
 * `serviceState: "unknown"`, nunca como "parado". Se `data/` também não
 * existir (sessão cloud sem o junction), o canário é pulado inteiramente
 * (sem I/O em diretório inexistente) e o veredito fica limitado ao sinal do
 * serviço.
 *
 * Uso:
 *   npx tsx scripts/onedrive-sync-alarm.ts                    # avalia + alarma se necessário
 *   npx tsx scripts/onedrive-sync-alarm.ts --dry-run           # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/onedrive-sync-alarm.ts --to email@x        # override do destinatário
 *   npx tsx scripts/onedrive-sync-alarm.ts --tolerance-hours 6 # override da tolerância do canário (default 6h)
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme (mesmo requisito dos outros alarmes locais deste repo).
 *
 * Estado: `data/.onedrive-sync-alarm-state.json` (dedup do e-mail) +
 * `data/.onedrive-sync-alarm-issues.json` (tracking de issue por achado,
 * `alarm-issues.ts`) — ambos fora de `data/weekly`/`data/apoia-se`/etc. de
 * propósito: este alarme não pertence a nenhum subsistema existente.
 */
import { existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  parseSystemctlIsActiveOutput,
  buildOnedriveSyncCanary,
  evaluateCanaryFreshness,
  evaluateOnedriveSyncAlarm,
  shouldSendOnedriveSyncAlarm,
  markOnedriveSyncAlarmed,
  emptyOnedriveSyncAlarmState,
  buildOnedriveSyncAlarmEmail,
  isAlarmingVerdict,
  type OnedriveServiceState,
  type OnedriveSyncAlarmState,
  type OnedriveSyncAlarmVerdict,
} from "./lib/onedrive-sync-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const CANARY_PATH = join(DATA_DIR, ".onedrive-sync-canary.json");
const STATE_PATH = join(DATA_DIR, ".onedrive-sync-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".onedrive-sync-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[onedrive-sync-alarm]";
const DEFAULT_TOLERANCE_HOURS = 6;
/** Cadência recomendada é a cada 4h (ver docs/onedrive-sync-setup.md) — 2
 * execuções limpas consecutivas = ~8h sem o achado, mesma ordem de grandeza
 * dos outros alarmes de cadência curta do repo (`clarice-guardrail-alarm.ts`,
 * `worker-drift-check.ts`, a cada 4h/6h, também usam 2). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Sinal 1: estado do serviço (SÓ LEITURA) ───────────────────────────────

/** `null` = não foi possível determinar (systemctl ausente, unit não
 * encontrada, qualquer erro de consulta) — caller trata como "unknown". */
export function readOnedriveServiceState(execFn: typeof execFileSync = execFileSync): OnedriveServiceState {
  try {
    const out = execFn("systemctl", ["--user", "is-active", "onedrive"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return parseSystemctlIsActiveOutput(String(out ?? ""), 0);
  } catch (e: unknown) {
    const err = e as { status?: number | null; stdout?: string };
    // `systemctl is-active` sai com status != 0 pra inactive/failed/unknown,
    // mas ainda escreve o estado em stdout — é isso que o parser usa.
    if (typeof err.stdout === "string") {
      return parseSystemctlIsActiveOutput(err.stdout, err.status ?? null);
    }
    return "unknown";
  }
}

// ─── Sinal 2: canário de frescor ───────────────────────────────────────────

function statMtimeOrNull(path: string): Date | null {
  if (!existsSync(path)) return null;
  try {
    return statSync(path).mtime;
  } catch {
    return null;
  }
}

function writeCanary(now: Date): void {
  mkdirSync(DATA_DIR, { recursive: true });
  const canary = buildOnedriveSyncCanary(now, hostname());
  writeFileAtomic(CANARY_PATH, JSON.stringify(canary, null, 2) + "\n");
}

// ─── Estado (dedup do e-mail) ───────────────────────────────────────────────

function loadState(): OnedriveSyncAlarmState {
  if (!existsSync(STATE_PATH)) return emptyOnedriveSyncAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<OnedriveSyncAlarmState>;
    const lastAlarmedVerdict =
      typeof raw.lastAlarmedVerdict === "string" || raw.lastAlarmedVerdict === null
        ? ((raw.lastAlarmedVerdict as OnedriveSyncAlarmVerdict | null) ?? null)
        : null;
    return { lastAlarmedVerdict };
  } catch {
    return emptyOnedriveSyncAlarmState();
  }
}

function saveState(state: OnedriveSyncAlarmState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado — alarm-issues.ts) ────

function loadAlarmIssuesState(): AlarmIssuesState {
  if (!existsSync(ALARM_ISSUES_STATE_PATH)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(
      `${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${ALARM_ISSUES_STATE_PATH} — resetando pra vazio: ${(e as Error).message}`,
    );
    return emptyAlarmIssuesState();
  }
}

function saveAlarmIssuesState(state: AlarmIssuesState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(ALARM_ISSUES_STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

export function toAlarmFinding(verdict: OnedriveSyncAlarmVerdict, serviceState: OnedriveServiceState): AlarmFinding {
  return {
    check: "onedrive-sync",
    fingerprint: verdict,
    title: `[diar.ia.br] OneDrive sync: ${verdict}`,
    body: [
      "Achado automático do alarme `Diaria-OneDrive-Sync-Alarm`",
      "(`scripts/onedrive-sync-alarm.ts`, #5548).",
      "",
      `verdict=${verdict}, serviceState=${serviceState}.`,
      "",
      verdict === "alarm-service-down"
        ? "O serviço onedrive.service (systemd --user) não está ativo — o sync entre máquinas parou. " +
          "`data/` continua sendo um diretório local funcional (nada falha visivelmente), só as escritas " +
          "param de propagar pra outra ponta. Religar: `systemctl --user restart onedrive` (ação manual " +
          "do editor — este alarme nunca muta o serviço)."
        : "O canário data/.onedrive-sync-canary.json não muda há mais tempo que a tolerância configurada, " +
          "mesmo com o serviço reportando um estado não-parado. Pode indicar sync degradado sem o daemon " +
          "detectar, ou esta própria task parada de rodar.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5548) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
    family: "estado",
  };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const toleranceHours = getIntArg(argv, "tolerance-hours", { min: 1 }) ?? DEFAULT_TOLERANCE_HOURS;
  const toleranceMs = toleranceHours * 60 * 60 * 1000;

  const now = new Date();
  const serviceState = readOnedriveServiceState();

  const dataDirExists = existsSync(DATA_DIR);
  const previousCanaryMtime = dataDirExists ? statMtimeOrNull(CANARY_PATH) : null;
  const canaryFreshness = evaluateCanaryFreshness(previousCanaryMtime, now, toleranceMs);

  const evaluation = evaluateOnedriveSyncAlarm(serviceState, canaryFreshness);
  console.log(
    `${LOG_PREFIX} service=${serviceState} canary=${canaryFreshness} verdict=${evaluation.verdict} tolerance=${toleranceHours}h`,
  );

  if (!dataDirExists) {
    console.log(`${LOG_PREFIX} data/ ausente nesta máquina (sessão cloud/clone fresco) — canário pulado.`);
  } else if (!isDryRun) {
    // Sobrescreve o canário DEPOIS de já ter lido o mtime anterior acima —
    // side A desta máquina (ver docstring de onedrive-sync-alarm.ts).
    writeCanary(now);
  }

  const state = loadState();

  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict)
    ? [toAlarmFinding(evaluation.verdict, serviceState)]
    : [];
  const alarmState = loadAlarmIssuesState();
  let issueRef: AlarmIssueResult | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, canário NÃO gravado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState);
    const outcome = findingOutcomes[0];
    if (outcome) {
      issueRef = { issueNumber: outcome.issueNumber, url: outcome.url, action: outcome.action, error: outcome.error };
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  if (!shouldSendOnedriveSyncAlarm(evaluation, state)) {
    console.log(
      isAlarmingVerdict(evaluation.verdict)
        ? `${LOG_PREFIX} já alarmado pra verdict=${evaluation.verdict} nesta invocação anterior — não reenvia.`
        : `${LOG_PREFIX} nenhum achado (verdict=${evaluation.verdict}) — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLine = issueRef
    ? issueRef.action === "failed"
      ? `\n\nIssue: falha ao criar/reusar (${issueRef.error})`
      : `\n\nIssue: #${issueRef.issueNumber} (${issueRef.url})`
    : "";
  const { subject, body } = buildOnedriveSyncAlarmEmail(evaluation, issueLine);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markOnedriveSyncAlarmed(evaluation.verdict));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to} (verdict=${evaluation.verdict}).`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
