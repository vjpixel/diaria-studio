#!/usr/bin/env node
/**
 * scripts/onboarding-continuity-alarm.ts (#7665, follow-up de detecção)
 *
 * Task diária (DECLARADA, NÃO ARMADA — ver `scripts/lib/scheduled-tasks.ts`,
 * `Diaria-Onboarding-Continuity-Alarm`): lê `data/onboarding/store.json` e
 * alarma (issue + e-mail) quando `consecutive_zero_detections` cruza o
 * limiar já decidido em #7599 (`ZERO_DETECTION_ALARM_THRESHOLD_RUNS`) sem
 * que nada o tenha surfaced antes — hoje o sinal existe (`zeroDetectionAlarm`
 * roda dentro de `onboarding-welcome-run.ts`) mas só vira uma linha de log
 * que ninguém lê rotineiramente. Ver a docstring de
 * `scripts/lib/onboarding-continuity-alarm.ts` para o contexto completo
 * (por que este NÃO é o alarme de sequence do Kit que a #7665 propôs
 * originalmente — esse escopo foi descartado no próprio thread da issue).
 *
 * Lógica pura em `scripts/lib/onboarding-continuity-alarm.ts` — este
 * arquivo é só I/O: ler o store, enviar e-mail, dedup/criação de issue via
 * `scripts/lib/alarm-issues.ts` (mesmo padrão de
 * `scripts/meta-capi-staleness-alarm.ts`, #7776).
 *
 * ## Fail-soft do PRÓPRIO alarme
 *
 * `data/onboarding/store.json` ausente (junction `data/` não montada) ou
 * ilegível: `verdict === "cannot-verify"`, sai limpo, NUNCA alarma a partir
 * de uma leitura que não aconteceu. Distinto de `"stale"` de propósito —
 * ver docstring do lib e o tri-state honesto exigido pelo #7776.
 *
 * Uso:
 *   npx tsx scripts/onboarding-continuity-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/onboarding-continuity-alarm.ts --dry-run      # avalia + imprime, NÃO envia/persiste
 *   npx tsx scripts/onboarding-continuity-alarm.ts --to email@x   # override do destinatário
 *
 * Env: nenhum — lê só `data/onboarding/store.json` (sem API), mais
 * `data/.credentials.json` com o scope `gmail.send` (só necessário pra
 * ENVIAR o alarme).
 *
 * Estado: `data/onboarding/.continuity-alarm-issues.json` (tracking de
 * issue, `alarm-issues.ts`) — arquivo PRÓPRIO, distinto de `store.json`
 * (que este script só LÊ, nunca escreve) e de `.welcome-run.log` (que o
 * run diário já usa).
 *
 * **E-mail (#7960, migrado do estado próprio `lastAlarmedDay` pro portão
 * `notifyEditorForOutcomes`):** severidade `"acao"` — só cria/reusa a issue,
 * nunca manda e-mail sob `notifications.email_policy: "urgent_only"`. Sob
 * `"legacy"`, `legacyResendIntent: "dedupe-new-occurrences-only"` preserva
 * o comportamento histórico: `shouldSendOnboardingContinuityAlarm` gateava
 * por DIA (`lastAlarmedDay`), apesar do fingerprint ser FIXO
 * (`FINDING_FINGERPRINT`) enquanto o streak persistir — re-executar no
 * MESMO dia reusa a issue (`action: "reused"`) e não deve re-emitir e-mail.
 * `shouldSendOnboardingContinuityAlarm`/`markOnboardingContinuityAlarmed`/
 * `.continuity-alarm-state.json` continuam definidos em
 * `lib/onboarding-continuity-alarm.ts` (e testados lá) mas não são mais
 * chamados por este script.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { readStore, DEFAULT_STORE_PATH } from "./lib/onboarding-store.ts";
import {
  evaluateOnboardingContinuity,
  buildOnboardingContinuityAlarmEmail,
  type OnboardingContinuityEvaluation,
} from "./lib/onboarding-continuity-alarm.ts";
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
const ONBOARDING_DIR = join(ROOT, "data", "onboarding");
const ALARM_ISSUES_STATE_PATH = join(ONBOARDING_DIR, ".continuity-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[onboarding-continuity-alarm]";
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** Fingerprint fixo — a condição é um único ESTADO global (o streak do
 * store), não um item por assinante/campanha; o valor exato do streak não
 * entra no fingerprint de propósito (senão cada rodada com streak
 * diferente reabriria uma issue "nova" pro mesmo achado). */
const FINDING_FINGERPRINT = "zero-detection-streak";

// Mesmo padrão de meta-capi-staleness-alarm.ts: loadAlarmIssuesState fica
// LOCAL (não importado de alarm-issues.ts) pra logar o parse error, não só
// um catch silencioso.
function loadAlarmIssuesState(statePath: string): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch (e) {
    console.error(
      `${LOG_PREFIX} estado de alarm-issues corrompido/ilegível em ${statePath} — resetando pra vazio: ${(e as Error).message}`,
    );
    return emptyAlarmIssuesState();
  }
}

export function toAlarmFinding(evaluation: OnboardingContinuityEvaluation): AlarmFinding {
  return {
    check: "onboarding-continuity",
    fingerprint: FINDING_FINGERPRINT,
    // #5553 — condição RE-CHECÁVEL (streak zera assim que um cadastro novo
    // for detectado): resolve sozinha, mesmo padrão de meta-capi-staleness.
    family: "estado",
    title: "[diar.ia.br] Detecção de cadastro novo do onboarding parada (streak de zero detecções)",
    body: [
      "Achado automático do alarme `Diaria-Onboarding-Continuity-Alarm`",
      "(`scripts/onboarding-continuity-alarm.ts`, follow-up de detecção da #7665).",
      "",
      `Sinal: ${evaluation.streak} rodadas diárias consecutivas de \`Diaria-Onboarding-Welcome-Run\` ` +
        `com 0 assinantes novos detectados (limiar ${evaluation.threshold}).`,
      "",
      "Verificação manual sugerida (distinguir seca real de cadastro vs. quebra silenciosa na detecção):",
      "`GET https://api.kit.com/v4/account/growth_stats` — se houver cadastro no período com o streak",
      "subindo mesmo assim, é quebra de detecção (ver `scripts/onboarding-welcome-run.ts`, bloco de",
      "detecção backend `kit`). Contexto completo do porquê o alarme original de sequence do Kit foi",
      "descartado (canal migrou pro Brevo, #7599): ver a #7665.",
      "",
      "Esta issue é criada automaticamente pelo alarme e será",
      "comentada/fechada sozinha quando o streak voltar a zerar por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
  };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const storeExists = existsSync(DEFAULT_STORE_PATH);
  const { store, corrupted } = readStore(DEFAULT_STORE_PATH);
  const evaluation = evaluateOnboardingContinuity(
    storeExists,
    corrupted,
    store.consecutive_zero_detections ?? 0,
    undefined,
    // #7665: sem o carimbo da última rodada, a streak sozinha não distingue
    // "detectou zero" de "parou de rodar" — ver evaluateOnboardingContinuity.
    store.last_zero_detection_run_at ?? null,
  );

  if (evaluation.verdict === "cannot-verify") {
    // Fail-soft honesto: não dá pra concluir nada — nunca alarma a partir
    // de uma leitura que não aconteceu. Mesmo racional dos demais alarmes
    // do repo (`context/overnight-dispatch-rules.md`).
    console.log(`${LOG_PREFIX} não foi possível verificar (${evaluation.cannotVerifyReason}) — nenhum alarme, nada gravado.`);
    if (evaluation.cannotVerifyReason === "store_missing") {
      console.log(
        `${LOG_PREFIX} data/onboarding/store.json ausente — provável junction data/ não montada ainda ` +
          `(mesmo guard das tasks-irmãs Diaria-Onboarding-Welcome-Run/-Watch-Returning).`,
      );
    }
    return;
  }

  console.log(`${LOG_PREFIX} verdict=${evaluation.verdict} streak=${evaluation.streak} threshold=${evaluation.threshold}`);

  const alarmFindings: AlarmFinding[] = evaluation.verdict === "stale" ? [toAlarmFinding(evaluation)] : [];
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
    console.log(`${LOG_PREFIX} sem staleness — nenhum alarme necessário.`);
    return;
  }

  const buildMessage = (qualifying: readonly AlarmFindingOutcome[]) => {
    const issueLines =
      "\n\nIssues:\n" +
      qualifying
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n");
    return buildOnboardingContinuityAlarmEmail(evaluation, issueLines);
  };
  const result = await notifyEditorForOutcomes(findingOutcomes, "acao", buildMessage, {
    cwd: ROOT,
    platformConfigPath: PLATFORM_CONFIG_PATH,
    emailTo: toOverride,
    // #8271: `shouldSendOnboardingContinuityAlarm` gateava por DIA
    // (`lastAlarmedDay`) apesar do fingerprint fixo enquanto o streak
    // persistir — 1 e-mail por dia, não reenvio periódico deliberado.
    // Reexecução no MESMO dia reusa a issue (`action: "reused"`) e não
    // deve re-emitir e-mail sob `email_policy: "legacy"`.
    legacyResendIntent: "dedupe-new-occurrences-only",
  });
  if (result.qualifying.length === 0) {
    console.log(`${LOG_PREFIX} política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
  } else if (result.emailSent) {
    console.log(`${LOG_PREFIX} e-mail de alarme enviado.`);
  } else {
    console.error(`${LOG_PREFIX} falha ao enviar e-mail: ${result.emailError}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
