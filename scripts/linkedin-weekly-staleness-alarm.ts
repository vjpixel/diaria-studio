#!/usr/bin/env node
/**
 * scripts/linkedin-weekly-staleness-alarm.ts (#5111)
 *
 * Task semanal (domingo à noite, ver `scripts/lib/scheduled-tasks.ts`): checa
 * se `data/weekly/{cycle}/ln-{cycle}.json` existe pra última semana de
 * conteúdo completa — se não, alarma o editor por e-mail. Fecha o buraco de
 * observabilidade achado ao vivo em 260812 (ciclo `26w32` perdido em
 * silêncio, recuperado 2 dias depois só porque o editor lembrou sozinho).
 *
 * Lógica pura em `scripts/lib/linkedin-weekly-staleness-alarm.ts` — este
 * arquivo é só I/O (existsSync, envio de e-mail).
 *
 * Uso:
 *   npx tsx scripts/linkedin-weekly-staleness-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/linkedin-weekly-staleness-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/linkedin-weekly-staleness-alarm.ts --to email@x   # override do destinatário
 *
 * Estado: `data/weekly/linkedin-staleness-alarm-issues.json` (tracking de
 * issue por achado, `alarm-issues.ts`).
 *
 * **E-mail (#7960, migrado do estado próprio `lastAlarmedCycle` pro portão
 * `notifyEditor`):** severidade `"acao"` (staleness — não é dos 5 canais
 * `"urgente"` do #7957) — só cria/reusa a issue, nunca manda e-mail sob
 * `notifications.email_policy: "urgent_only"`. `shouldSendLinkedinWeeklyStalenessAlarm`/
 * `markLinkedinWeeklyStalenessAlarmed`/`data/weekly/linkedin-staleness-alarm-state.json`
 * continuam definidos em `lib/linkedin-weekly-staleness-alarm.ts` (e
 * testados lá) mas não são mais chamados por este script — a idempotência
 * do e-mail agora vem de `AlarmIssueResult.action === "created"`
 * (`notifyEditorForOutcomes`, `scripts/lib/editor-notify.ts`), não de um
 * estado por ciclo separado.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { weeklyLinkedinRelDir } from "./lib/weekly-linkedin-cycle.ts";
import { mostRecentCompletedCycle, evaluateLinkedinWeeklyStalenessAlarm, buildLinkedinWeeklyStalenessAlarmEmail } from "./lib/linkedin-weekly-staleness-alarm.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  saveAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmFindingOutcome,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "weekly", "linkedin-staleness-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[linkedin-weekly-staleness-alarm]";
/** #5339: task roda semanal (domingos 22:00) — 2 execuções limpas
 * consecutivas = 2 semanas sem o achado, mesmo valor usado pelos alarmes
 * de #5112 em diante (`cursos-error-alarm.ts`, deste mesmo lote, usa 24 —
 * cadência diária, não semanal), aplicado à cadência semanal desta task. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// saveState/saveAlarmIssuesState: consolidados em scripts/lib/alarm-issues.ts
// (#7124) — importados acima.

// loadAlarmIssuesState continua LOCAL (#7124) — diverge do padrão comum ao
// logar o parse error via console.error, não só um catch silencioso; não
// forçado para o helper genérico pra não perder o diagnóstico.
export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(`${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${ALARM_ISSUES_STATE_PATH} — resetando pra vazio: ${(e as Error).message}`);
    return emptyAlarmIssuesState();
  }
}

/** Converte o ciclo faltante num `AlarmFinding` (#5339) — `fingerprint` =
 * `cycle` (estável enquanto o mesmo ciclo seguir sem artefato; muda toda
 * semana pra um ciclo novo, então cada semana perdida é um achado distinto
 * — mesma granularidade que já governa `lastAlarmedCycle`). Sem PII — o
 * achado só cita o ciclo (`{YY}w{WW}`), nenhum dado de assinante. */
export function toAlarmFinding(cycle: string): AlarmFinding {
  return {
    check: "linkedin-weekly-staleness",
    fingerprint: cycle,
    // #5553 — apesar do fingerprint embutir um ID (o ciclo), a condição
    // observada é "o artefato existe pra ESTE ciclo?", re-checada toda
    // semana — quando o arquivo aparece, resolve sozinho (#5497, o caso que
    // motivou a issue #5553 confirmar como auto-close CORRETO). É exatamente
    // este alarme que prova que "fingerprint com ID → evento" não é regra
    // confiável — daí a declaração explícita em vez de inferida.
    family: "estado",
    title: `[diar.ia.br] LinkedIn semanal: ciclo ${cycle} não foi produzido`,
    body: [
      "Achado automático do alarme `Diaria-LinkedIn-Weekly-Staleness-Alarm`",
      "(`scripts/linkedin-weekly-staleness-alarm.ts`).",
      "",
      `A newsletter semanal do LinkedIn (/diaria-linkedin-semanal) deveria ter produzido`,
      `data/weekly/${cycle}/ln-${cycle}.json pra semana de conteúdo do ciclo ${cycle}, e o`,
      "arquivo não existe.",
      "",
      `Rode manualmente: /diaria-linkedin-semanal --publish-monday {AAMMDD da próxima segunda útil}.`,
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) e será",
      "comentada/fechada sozinha quando o achado deixar de reproduzir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/** `data/weekly/{cycle}/ln-{cycle}.json` existe no disco? (I/O isolado pra facilitar teste do resto do fluxo.) */
export function artifactExistsForCycle(cycle: string, rootDir: string = ROOT): boolean {
  return existsSync(join(rootDir, weeklyLinkedinRelDir(cycle), `ln-${cycle}.json`));
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const cycle = mostRecentCompletedCycle(new Date());
  const exists = artifactExistsForCycle(cycle);
  const evaluation = evaluateLinkedinWeeklyStalenessAlarm(cycle, exists);
  console.log(`${LOG_PREFIX} cycle=${cycle} artifact_exists=${exists} verdict=${evaluation.verdict}`);

  // #5339 — reconcilia uma issue pro ciclo faltante; roda toda execução
  // não-dry-run. #7960: o e-mail (abaixo) é decidido a partir do OUTCOME
  // desta reconciliação (`action === "created"` sob `urgent_only`), não
  // mais de um estado `lastAlarmedCycle` separado.
  const alarmFindings: AlarmFinding[] = evaluation.verdict === "alarm-missing" ? [toAlarmFinding(cycle)] : [];
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, e-mail NÃO avaliado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
    }
  }

  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} ciclo ${cycle} OK — nenhum alarme necessário.`);
    return;
  }

  const result = await notifyEditorForOutcomes(
    findingOutcomes as AlarmFindingOutcome[],
    "acao",
    (qualifying) => buildLinkedinWeeklyStalenessAlarmEmail(cycle, qualifying[0]),
    { cwd: ROOT, platformConfigPath: PLATFORM_CONFIG_PATH, emailTo: toOverride },
  );
  if (result.qualifying.length === 0) {
    console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
  } else if (result.emailSent) {
    console.log(`${LOG_PREFIX} e-mail de alarme enviado (cycle=${cycle}).`);
  } else {
    console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
