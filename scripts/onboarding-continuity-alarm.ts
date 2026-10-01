#!/usr/bin/env node
/**
 * scripts/onboarding-continuity-alarm.ts (#7665, follow-up de detecção)
 *
 * Task diária (`Diaria-Onboarding-Continuity-Alarm`, 09:10 BRT, ARMADA na
 * `300` — confirmado pelo drift-check em 10/09/2026, #7553; estado vivo:
 * `npx tsx scripts/lib/scheduled-tasks.ts --list`): lê `data/onboarding/store.json` e
 * alarma (issue + e-mail) quando `consecutive_zero_detections` cruza o
 * limiar já decidido em #7599 (`ZERO_DETECTION_ALARM_THRESHOLD_RUNS`) sem
 * que nada o tenha surfaced antes — hoje o sinal existe (`zeroDetectionAlarm`
 * roda dentro de `onboarding-welcome-run.ts`) mas só vira uma linha de log
 * que ninguém lê rotineiramente. Ver a docstring de
 * `scripts/lib/onboarding-continuity-alarm.ts` para o contexto completo
 * (por que este NÃO é o alarme de sequence do Kit que a #7665 propôs
 * originalmente — esse escopo foi descartado no próprio thread da issue).
 *
 * ## Transporte ativo (#7922, pré-requisito do corte — §3 de
 * docs/onboarding-kit-cutover.md)
 *
 * A streak de detecção é a mesma nos dois regimes (quem detecta é sempre
 * `onboarding-welcome-run.ts`). Com `onboarding.kit_transport.enabled: true`
 * este alarme também avalia o executor Kit (`evaluateKitTransportHealth`,
 * sobre `store.kit_transport.last_send_run`/`consecutive_failed_send_runs`,
 * gravados por `onboarding-kit-transport-run.ts --send`) — 2º eixo,
 * `check: "onboarding-kit-transport"`, issue própria: rodadas que não
 * entregam, OU executor que não roda (rodada ausente/parada há >48h — com o
 * switch ligado devia haver uma). Com o Kit desligado (inclusive rollback
 * do §6) o check não se aplica e uma issue Kit aberta fecha sozinha; com o
 * config ilegível o transporte é "desconhecido" e o check nem alarma nem
 * fecha. `cannot-verify` nunca conta como "resolvido"
 * (`reconcileEvaluatedChecks`). Decisão da rodada: `evaluateContinuityRound`
 * (pura, testável).
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
 * Env: nenhum — lê só `data/onboarding/store.json` (sem API) e
 * `platform.config.json` (`onboarding.kit_transport.enabled`, #7922), mais
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
import { readStore, DEFAULT_STORE_PATH, type OnboardingStore } from "./lib/onboarding-store.ts";
import {
  evaluateOnboardingContinuity,
  buildOnboardingContinuityAlarmEmail,
  evaluateKitTransportHealth,
  buildKitTransportAlarmEmail,
  describeKitTransportSignal,
  resolveActiveOnboardingTransport,
  type OnboardingContinuityEvaluation,
  type KitTransportHealthEvaluation,
  type OnboardingTransportLabel,
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
  type AlarmReconcileAction,
  type ApplyAlarmReconciliationOptions,
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

/** #7922: check/fingerprint do achado do executor Kit — eixo PRÓPRIO (issue
 *  própria), nunca misturado com a detecção: são falhas diferentes com
 *  remédios diferentes. */
export const DETECTION_CHECK = "onboarding-continuity";
export const KIT_TRANSPORT_CHECK = "onboarding-kit-transport";
const KIT_FINDING_FINGERPRINT = "kit-send-failure-streak";
const KIT_NOT_RUNNING_FINGERPRINT = "kit-send-run-stalled";

/** Lê `onboarding.kit_transport.enabled` sem lançar — config ilegível vira
 *  `error` (transporte "desconhecido": o check Kit nem alarma nem fecha nada). */
export function readKitTransportEnabled(configPath: string): { enabled: unknown; error: string | null } {
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as { onboarding?: { kit_transport?: { enabled?: unknown } } };
    return { enabled: raw.onboarding?.kit_transport?.enabled, error: null };
  } catch (e) {
    return { enabled: undefined, error: (e as Error).message };
  }
}

/** Subconjunto do estado de issues que pertence aos checks avaliados nesta
 *  rodada — chave é `check:fingerprint` (`alarmIssueStateKey`). */
function pickStateForChecks(state: AlarmIssuesState, checks: ReadonlySet<string>): AlarmIssuesState {
  return Object.fromEntries(Object.entries(state).filter(([key]) => checks.has(key.split(":")[0]!)));
}

/** Planeja a reconciliação SÓ sobre os checks avaliados — um check em
 *  `cannot-verify` fica fora, senão a ausência do achado dele contaria como
 *  "resolvido" e fecharia a issue aberta a partir de uma leitura que não
 *  aconteceu (#7776). */
export function planEvaluatedChecks(
  findings: readonly AlarmFinding[],
  state: AlarmIssuesState,
  evaluatedChecks: ReadonlySet<string>,
  closeAfterRuns: number,
): AlarmReconcileAction[] {
  return planAlarmReconciliation(findings, pickStateForChecks(state, evaluatedChecks), closeAfterRuns);
}

/** Aplica a reconciliação só sobre os checks avaliados e devolve o estado
 *  completo (entradas dos checks não avaliados preservadas byte a byte). */
export function reconcileEvaluatedChecks(
  findings: readonly AlarmFinding[],
  state: AlarmIssuesState,
  evaluatedChecks: ReadonlySet<string>,
  opts: ApplyAlarmReconciliationOptions,
): { nextState: AlarmIssuesState; findingOutcomes: AlarmFindingOutcome[] } {
  const subset = pickStateForChecks(state, evaluatedChecks);
  const { nextState, findingOutcomes } = applyAlarmReconciliation(findings, subset, opts);
  const preserved = Object.fromEntries(Object.entries(state).filter(([key]) => !(key in subset)));
  return { nextState: { ...preserved, ...nextState }, findingOutcomes };
}

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
    check: DETECTION_CHECK,
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

/** #7922: achado do executor Kit (transporte ativo = Kit). Dois fingerprints
 *  de propósito: "executor não roda" (task desarmada) e "executor roda mas
 *  não entrega" pedem remédios diferentes e não devem se fundir numa issue. */
export function toKitTransportAlarmFinding(evaluation: KitTransportHealthEvaluation): AlarmFinding {
  const notRunning = evaluation.staleReason === "rodada_ausente" || evaluation.staleReason === "rodada_parada";
  return {
    check: KIT_TRANSPORT_CHECK,
    fingerprint: notRunning ? KIT_NOT_RUNNING_FINGERPRINT : KIT_FINDING_FINGERPRINT,
    // Re-checável: some sozinho quando o executor volta a rodar/entregar.
    family: "estado",
    title: notRunning
      ? "[diar.ia.br] Executor do transporte Kit do onboarding não está rodando"
      : "[diar.ia.br] Transporte Kit do onboarding não está entregando (rodadas --send falhando)",
    body: [
      "Achado automático do alarme `Diaria-Onboarding-Continuity-Alarm`",
      "(`scripts/onboarding-continuity-alarm.ts`, check do transporte Kit — #7922).",
      "",
      `Sinal: ${describeKitTransportSignal(evaluation)}`,
      "",
      "Quem foi detectado nesse período não recebeu o e-mail 1/2, e o rascunho do e-mail 3 não nasceu.",
      "Ver `kit_transport.last_send_run` e o `last_error` dos lotes em `data/onboarding/store.json`.",
      "",
      "**Rollback (§6 de `docs/onboarding-kit-cutover.md`):** com `onboarding.kit_transport.enabled`",
      "desligado este check deixa de valer e esta issue é comentada/fechada sozinha após",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções — o fechamento NÃO significa que a causa foi resolvida;`,
      "conferir antes de religar o switch.",
      "",
      "Fora do rollback, a issue é comentada/fechada sozinha quando o sinal sumir por",
      `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
    ].join("\n"),
    labels: ["bug"],
    priority: "P1",
  };
}

export interface ContinuityRoundInput {
  storeExists: boolean;
  corrupted: boolean;
  store: Pick<OnboardingStore, "consecutive_zero_detections" | "last_zero_detection_run_at" | "kit_transport">;
  cfgRead: { enabled: unknown; error: string | null };
  now?: Date;
}

export interface ContinuityRound {
  /** `"desconhecido"` = config ilegível nesta rodada. */
  transport: OnboardingTransportLabel;
  evaluation: OnboardingContinuityEvaluation;
  /** `null` quando o check Kit não foi avaliado (transporte Brevo ou desconhecido). */
  kitEvaluation: KitTransportHealthEvaluation | null;
  /** Checks que participam da reconciliação de issues nesta rodada. */
  evaluatedChecks: Set<string>;
  findings: AlarmFinding[];
}

/**
 * Decisão de uma rodada do alarme, sem I/O (testável). Regras:
 *  - detecção: avaliada sempre; `cannot-verify` fica fora da reconciliação;
 *  - transporte Kit ATIVO: `evaluateKitTransportHealth` — `stale` vira achado;
 *    `cannot-verify` (store ausente/ilegível) fica fora da reconciliação;
 *  - transporte BREVO (config legível, switch desligado — inclusive rollback
 *    do §6): o check Kit não se aplica; entra na reconciliação SEM achado,
 *    então uma issue Kit aberta é comentada e fecha sozinha (o corpo dela
 *    avisa que fechar por rollback não é "causa resolvida");
 *  - config ILEGÍVEL: transporte desconhecido — check Kit fora da
 *    reconciliação (nem alarma, nem fecha nada).
 *
 * @pure
 */
export function evaluateContinuityRound(input: ContinuityRoundInput): ContinuityRound {
  const now = input.now ?? new Date();
  const evaluation = evaluateOnboardingContinuity(
    input.storeExists,
    input.corrupted,
    input.store.consecutive_zero_detections ?? 0,
    undefined,
    // #7665: sem o carimbo da última rodada, a streak sozinha não distingue
    // "detectou zero" de "parou de rodar" — ver evaluateOnboardingContinuity.
    input.store.last_zero_detection_run_at ?? null,
    now,
  );
  const transport: OnboardingTransportLabel =
    input.cfgRead.error != null ? "desconhecido" : resolveActiveOnboardingTransport(input.cfgRead.enabled);

  const evaluatedChecks = new Set<string>();
  const findings: AlarmFinding[] = [];
  if (evaluation.verdict !== "cannot-verify") {
    evaluatedChecks.add(DETECTION_CHECK);
    if (evaluation.verdict === "stale") findings.push(toAlarmFinding(evaluation));
  }

  let kitEvaluation: KitTransportHealthEvaluation | null = null;
  if (transport === "kit") {
    kitEvaluation = evaluateKitTransportHealth(input.storeExists, input.corrupted, input.store.kit_transport, undefined, now);
    if (kitEvaluation.verdict !== "cannot-verify") {
      evaluatedChecks.add(KIT_TRANSPORT_CHECK);
      if (kitEvaluation.verdict === "stale") findings.push(toKitTransportAlarmFinding(kitEvaluation));
    }
  } else if (transport === "brevo") {
    evaluatedChecks.add(KIT_TRANSPORT_CHECK);
  }
  return { transport, evaluation, kitEvaluation, evaluatedChecks, findings };
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const storeExists = existsSync(DEFAULT_STORE_PATH);
  const { store, corrupted } = readStore(DEFAULT_STORE_PATH);
  const cfgRead = readKitTransportEnabled(PLATFORM_CONFIG_PATH);
  if (cfgRead.error != null) {
    console.error(`${LOG_PREFIX} platform.config.json ilegível (${cfgRead.error}) — check do transporte Kit NÃO avaliado nesta rodada.`);
  }
  const round = evaluateContinuityRound({ storeExists, corrupted, store, cfgRead });
  const { transport, evaluation, kitEvaluation, evaluatedChecks, findings: alarmFindings } = round;
  console.log(`${LOG_PREFIX} transporte ativo: ${transport}`);

  if (evaluation.verdict === "cannot-verify") {
    // Fail-soft honesto: não dá pra concluir nada — nunca alarma a partir
    // de uma leitura que não aconteceu. Mesmo racional dos demais alarmes
    // do repo (`context/overnight-dispatch-rules.md`).
    console.log(`${LOG_PREFIX} detecção: não foi possível verificar (${evaluation.cannotVerifyReason}) — sem alarme deste check.`);
    if (evaluation.cannotVerifyReason === "store_missing") {
      console.log(
        `${LOG_PREFIX} data/onboarding/store.json ausente — provável junction data/ não montada ainda ` +
          `(mesmo guard das tasks-irmãs Diaria-Onboarding-Welcome-Run/-Watch-Returning).`,
      );
    }
  } else {
    console.log(`${LOG_PREFIX} detecção: verdict=${evaluation.verdict} streak=${evaluation.streak} threshold=${evaluation.threshold}`);
  }
  if (kitEvaluation != null) {
    console.log(
      `${LOG_PREFIX} transporte Kit: verdict=${kitEvaluation.verdict} ` +
        `motivo=${kitEvaluation.staleReason ?? kitEvaluation.cannotVerifyReason ?? "-"} ` +
        `rodadas_falhas=${kitEvaluation.consecutiveFailedRuns ?? "-"} ultima_rodada=${kitEvaluation.lastRunAt ?? "-"}`,
    );
  }

  if (evaluatedChecks.size === 0) {
    console.log(`${LOG_PREFIX} nenhum check verificável nesta rodada — nenhum alarme, nada gravado.`);
    return;
  }

  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);

  if (isDryRun) {
    const actions = planEvaluatedChecks(alarmFindings, alarmState, evaluatedChecks, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, e-mail NÃO avaliado.`,
    );
    return;
  }

  const { nextState, findingOutcomes } = reconcileEvaluatedChecks(alarmFindings, alarmState, evaluatedChecks, {
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
    console.log(`${LOG_PREFIX} sem achado — nenhum alarme necessário.`);
    return;
  }

  const buildMessage = (qualifying: readonly AlarmFindingOutcome[]) =>
    buildContinuityAlarmMessage(qualifying, evaluation, kitEvaluation, transport);
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

/** Monta o e-mail a partir dos outcomes qualificados — uma seção por check
 *  (detecção e/ou transporte Kit), cada uma com as próprias issues. */
export function buildContinuityAlarmMessage(
  qualifying: readonly AlarmFindingOutcome[],
  evaluation: OnboardingContinuityEvaluation,
  kitEvaluation: KitTransportHealthEvaluation | null,
  transport: OnboardingTransportLabel,
): { subject: string; body: string } {
  const issueLinesFor = (check: string): string => {
    const rows = qualifying.filter((r) => r.check === check);
    if (rows.length === 0) return "";
    return (
      "\n\nIssues:\n" +
      rows
        .map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`))
        .join("\n")
    );
  };
  const parts: { subject: string; body: string }[] = [];
  if (qualifying.some((r) => r.check === DETECTION_CHECK)) {
    parts.push(buildOnboardingContinuityAlarmEmail(evaluation, issueLinesFor(DETECTION_CHECK), transport));
  }
  if (kitEvaluation != null && qualifying.some((r) => r.check === KIT_TRANSPORT_CHECK)) {
    parts.push(buildKitTransportAlarmEmail(kitEvaluation, issueLinesFor(KIT_TRANSPORT_CHECK)));
  }
  if (parts.length === 0) {
    // Defensivo: outcome de check desconhecido — nunca e-mail vazio.
    return buildOnboardingContinuityAlarmEmail(evaluation, "", transport);
  }
  if (parts.length === 1) return parts[0]!;
  return {
    subject: "⚠️ Diaria-Onboarding-Continuity-Alarm: detecção E transporte Kit do onboarding com problema",
    body: parts.map((p) => p.body).join("\n\n---\n\n"),
  };
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
