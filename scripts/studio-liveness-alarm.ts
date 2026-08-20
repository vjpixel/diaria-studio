#!/usr/bin/env node
/**
 * scripts/studio-liveness-alarm.ts (#5759)
 *
 * Task periódica: `GET http://127.0.0.1:4174/` (o Studio server, ver
 * `scripts/studio-ui/server.ts`) com timeout curto — alarma quando a porta
 * fica inacessível por 2 checks CONSECUTIVOS (não no 1º, que cobre um
 * restart normal do serviço, ~7s: `RestartSec=5` + boot do `tsx`). Fecha o
 * ponto cego confirmado no incidente 260820 (#5759): a unit
 * `diaria-studio-server.service` ficou ~15min `active/running` sem escutar
 * a porta (zumbi de restart travado) e o único sweep genérico de serviço
 * (`Diaria-Systemd-Failed-Units-Alarm`, `--state=failed`) é cego a esse
 * modo — uma unit zumbi nunca entra em `failed`.
 *
 * Lógica pura em `scripts/lib/studio-liveness-alarm.ts` — este arquivo é só
 * I/O: `fetch()` com `AbortController` (timeout), `systemctl --user
 * is-active diaria-studio-server.service` (SÓ LEITURA — ver guard abaixo),
 * envio de e-mail, dedup/criação de issue via `scripts/lib/alarm-issues.ts`.
 *
 * **GUARD (invariável, mesmo padrão dos vizinhos):** este script NUNCA
 * chama `systemctl` com `start`/`stop`/`restart`/`enable`/`disable`, e
 * NUNCA reinicia o processo do Studio server sozinho — só reporta. Religar
 * é ação manual do editor, de propósito: reiniciar automaticamente
 * mascararia o defeito em vez de expô-lo (a issue #5759 propõe
 * explicitamente NÃO fazer isso por default).
 *
 * **Guard de máquina sem o serviço** (sessão cloud, clone fresco, ou
 * qualquer máquina onde `diaria-studio-server.service` nunca foi
 * registrado): `systemctl --user is-active` retorna "unknown" — tratado
 * como "não detectável aqui", o check HTTP nem chega a rodar, nunca vira
 * alarme falso (mesmo padrão de `onedrive-sync-alarm.ts`). Quando a unit É
 * reconhecida (`active`/`inactive`/`failed` — os 3 provam que esta máquina
 * roda o serviço), o check HTTP roda de verdade mesmo que o systemd relate
 * `active` — é justamente o caso zumbi que esta unidade existe pra pegar.
 *
 * Uso:
 *   npx tsx scripts/studio-liveness-alarm.ts                 # avalia + alarma se necessário
 *   npx tsx scripts/studio-liveness-alarm.ts --dry-run        # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/studio-liveness-alarm.ts --to email@x     # override do destinatário
 *   npx tsx scripts/studio-liveness-alarm.ts --port 4174      # override da porta (default STUDIO_PORT || 4174)
 *   npx tsx scripts/studio-liveness-alarm.ts --timeout-ms 5000 # override do timeout do GET (default 5000)
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` — só necessário pra
 * ENVIAR o alarme (mesmo requisito dos outros alarmes locais deste repo).
 *
 * Estado: `data/.studio-liveness-alarm-state.json` (streak de falhas +
 * dedup do e-mail) + `data/.studio-liveness-alarm-issues.json` (tracking de
 * issue por achado, `alarm-issues.ts`).
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, getIntArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { parseSystemctlIsActiveOutput, type OnedriveServiceState } from "./lib/onedrive-sync-alarm.ts";
import {
  recordStudioHttpCheck,
  shouldSendStudioLivenessAlarm,
  markStudioLivenessAlarmed,
  emptyStudioLivenessAlarmState,
  buildStudioLivenessAlarmEmail,
  isAlarmingVerdict,
  type StudioHttpCheckResult,
  type StudioLivenessAlarmState,
  type StudioLivenessEvaluation,
} from "./lib/studio-liveness-alarm.ts";
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
const STATE_PATH = join(DATA_DIR, ".studio-liveness-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = join(DATA_DIR, ".studio-liveness-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[studio-liveness-alarm]";
const SERVICE_UNIT = "diaria-studio-server.service";
const DEFAULT_PORT = process.env.STUDIO_PORT ?? "4174";
const DEFAULT_TIMEOUT_MS = 5000;
/** Cadência recomendada é a cada 10min (ver `scripts/lib/scheduled-tasks.ts`)
 * — 2 execuções limpas consecutivas = ~20min sem o achado, ordem de
 * grandeza compatível com a janela real do incidente de referência (~15min). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Sinal 1: estado da unit (SÓ LEITURA) — decide se esta máquina roda o serviço ──

/** `"unknown"` = não foi possível determinar (systemctl ausente, unit não
 * encontrada) — caller trata como "não detectável aqui", nunca chega a
 * rodar o check HTTP. */
export function readStudioServiceState(execFn: typeof execFileSync = execFileSync): OnedriveServiceState {
  try {
    const out = execFn("systemctl", ["--user", "is-active", SERVICE_UNIT], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }) as unknown as string;
    return parseSystemctlIsActiveOutput(String(out ?? ""), 0);
  } catch (e: unknown) {
    const err = e as { stdout?: string };
    if (typeof err.stdout === "string") {
      return parseSystemctlIsActiveOutput(err.stdout, null);
    }
    return "unknown";
  }
}

// ─── Sinal 2: liveness HTTP ──────────────────────────────────────────────────

/** I/O — `GET http://127.0.0.1:{port}/` com timeout via `AbortController`.
 * Qualquer resposta HTTP (mesmo 4xx/5xx de APLICAÇÃO) já prova que o
 * processo está escutando a porta — é esse o único sinal que este alarme
 * mede; não distingue status de aplicação (escopo de outro alarme). */
export async function checkStudioLiveness(
  port: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch,
): Promise<StudioHttpCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetchFn(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    return "ok";
  } catch (e: unknown) {
    const err = e as { name?: string };
    return err?.name === "AbortError" ? "timeout" : "failure";
  } finally {
    clearTimeout(timer);
  }
}

export function toAlarmFinding(evaluation: StudioLivenessEvaluation): AlarmFinding {
  return {
    check: "studio-liveness",
    // Fingerprint estável (não inclui o número de falhas) — o mesmo achado
    // "streak de indisponibilidade em curso" continua sendo o MESMO
    // fingerprint enquanto o streak não zerar, mesmo que o e-mail já não
    // reenvie (ver `shouldSendStudioLivenessAlarm`).
    fingerprint: "unreachable",
    title: `[diar.ia.br] Studio server inacessível (${evaluation.consecutiveFailures} falhas consecutivas)`,
    body: [
      "Achado automático do alarme `Diaria-Studio-Liveness-Alarm`",
      "(`scripts/studio-liveness-alarm.ts`, #5759).",
      "",
      `\`GET http://127.0.0.1:${DEFAULT_PORT}/\` falhou ${evaluation.consecutiveFailures}x seguidas ` +
        `(última: "${evaluation.latestResult}").`,
      "",
      `A unit \`${SERVICE_UNIT}\` pode estar reportando \`active\` no systemd (zumbi de restart ` +
        "travado, ver incidente 260820 na issue) mesmo sem escutar a porta.",
      "",
      `Investigar: \`systemctl --user status ${SERVICE_UNIT}\` e ` +
        `\`journalctl --user -u ${SERVICE_UNIT} -n 80\`. Religar/reiniciar é ação manual do editor ` +
        "(este alarme nunca muta o serviço).",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
    family: "estado",
  };
}

function loadState(): StudioLivenessAlarmState {
  if (!existsSync(STATE_PATH)) return emptyStudioLivenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8")) as Partial<StudioLivenessAlarmState>;
    return {
      consecutiveFailures: typeof raw.consecutiveFailures === "number" ? raw.consecutiveFailures : 0,
      alarmedThisStreak: raw.alarmedThisStreak === true,
    };
  } catch {
    return emptyStudioLivenessAlarmState();
  }
}

function saveState(state: StudioLivenessAlarmState): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileAtomic(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

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

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const portOverride = getArg(argv, "port");
  const timeoutOverride = getIntArg(argv, "timeout-ms", { min: 1 });
  const port = portOverride || DEFAULT_PORT;
  const timeoutMs = timeoutOverride ?? DEFAULT_TIMEOUT_MS;

  const serviceState = readStudioServiceState();
  if (serviceState === "unknown") {
    console.log(
      `${LOG_PREFIX} unit ${SERVICE_UNIT} não detectável nesta máquina (sessão cloud/clone fresco) — nada a checar.`,
    );
    return;
  }

  const state = loadState();
  const checkResult = await checkStudioLiveness(port, timeoutMs);
  const { nextState, evaluation } = recordStudioHttpCheck(state, checkResult);
  console.log(
    `${LOG_PREFIX} serviceState=${serviceState} check=${checkResult} verdict=${evaluation.verdict} ` +
      `consecutiveFailures=${evaluation.consecutiveFailures}`,
  );

  const alarmFindings: AlarmFinding[] = isAlarmingVerdict(evaluation.verdict) ? [toAlarmFinding(evaluation)] : [];
  const alarmState = loadAlarmIssuesState();
  const issueRefs: AlarmIssueResult[] = [];

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, estado NÃO gravado.`,
    );
  } else {
    const { nextState: nextAlarmState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextAlarmState);
    for (const outcome of findingOutcomes) {
      const ref: AlarmIssueResult = {
        issueNumber: outcome.issueNumber,
        url: outcome.url,
        action: outcome.action,
        error: outcome.error,
      };
      issueRefs.push(ref);
      if (outcome.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
      }
    }
  }

  if (!shouldSendStudioLivenessAlarm(evaluation, state)) {
    if (!isDryRun) saveState(nextState);
    console.log(
      isAlarmingVerdict(evaluation.verdict)
        ? `${LOG_PREFIX} já alarmado pro mesmo streak de falhas — não reenvia.`
        : `${LOG_PREFIX} check ${checkResult === "ok" ? "ok" : "degradado mas abaixo do limiar"} — nenhum alarme necessário.`,
    );
    return;
  }

  const issueLines = issueRefs.length
    ? "\n\nIssues:\n" +
      issueRefs
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    : "";
  const { subject, body } = buildStudioLivenessAlarmEmail(evaluation, issueLines);
  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO gravado.`);
    return;
  }
  await sendGmailMessage(to, subject, body);
  saveState(markStudioLivenessAlarmed(nextState));
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
