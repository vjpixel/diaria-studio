#!/usr/bin/env node
/**
 * scripts/kit-subscriber-limit-alarm.ts (#7362)
 *
 * Alarme agendado: lê o teto de assinantes do plano Kit (`subscriber_limit`,
 * `GET /v4/account` via `getKitAccount`) × a contagem de assinantes ATIVOS
 * (`listAllKitSubscribers(config, {status: "active"})`), e alarma quando a
 * contagem cruza `DEFAULT_KIT_SUBSCRIBER_ALARM_THRESHOLD` (900, decisão do
 * editor #7362, 03/09/2026 — ver docstring de
 * `scripts/lib/kit-subscriber-limit-alarm.ts`).
 *
 * Antes desta unidade, NENHUM script do repo lia `subscriber_limit` — o teto
 * do plano era invisível pra toda a maquinaria de guard/alarme, achado na
 * auditoria de pré-voo de mídia paga do #7362.
 *
 * Mesmo molde de `scripts/kit-doi-orphan-guard.ts`: este arquivo faz só I/O
 * (2 chamadas REST Kit + e-mail + issue via `scripts/lib/alarm-issues.ts`);
 * toda a decisão (threshold, latch de idempotência, corpo do e-mail) é pura
 * e testada em `scripts/lib/kit-subscriber-limit-alarm.ts`.
 *
 * ## Uso
 *
 *   npx tsx scripts/kit-subscriber-limit-alarm.ts               # avalia + persiste + alarma se NOVO cruzamento
 *   npx tsx scripts/kit-subscriber-limit-alarm.ts --dry-run      # avalia + imprime, NÃO persiste nem alarma
 *   npx tsx scripts/kit-subscriber-limit-alarm.ts --to email@x   # override do destinatário
 *
 * ## Config/env
 *
 * `KIT_API_KEY` (leitura, `scripts/lib/kit-config.ts`) — mesma key dos
 * demais scripts REST Kit deste repo, nunca escrita: este script só chama
 * `GET /v4/account` e `GET /v4/subscribers` (ambos LEITURA).
 *
 * `data/.credentials.json` com o scope `gmail.send` — só necessário quando
 * há um cruzamento NOVO pra de fato enviar o e-mail (mesmo requisito dos
 * outros alarmes locais deste repo).
 *
 * ## Guard de publicação
 *
 * Só LEITURA contra o Kit. Nenhuma escrita, nenhuma mudança de plano — nada
 * aqui decide sozinho subir de degrau ou capar o teste pago (decisão
 * EXPLICITAMENTE recusada pelo editor na issue #7362, "decidir na hora").
 * Não executado ao vivo nesta unidade (worktree isolado, sem `KIT_API_KEY`
 * real garantida) — validado via testes com `kitFetch`/`fetch` mockado.
 *
 * Como os outros alarmes locais deste repo, o registro na task
 * (`scripts/lib/scheduled-tasks.ts` → `Diaria-Kit-Subscriber-Limit-Alarm`)
 * nasce DECLARADO — armar via `scripts/setup-systemd-timers.ts` na checkout
 * compartilhada (`helios`) é ação POSTERIOR do editor.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { listAllKitSubscribers } from "./lib/kit-subscribers.ts";
import { getKitAccount } from "./lib/kit-client.ts";
import { resolveKitConfig } from "./lib/kit-config.ts";
import {
  evaluateKitSubscriberLimitAlarm,
  shouldAlarmKitSubscriberLimit,
  advanceKitSubscriberLimitAlarmState,
  emptyKitSubscriberLimitAlarmState,
  buildKitSubscriberLimitAlarmEmail,
  KIT_SUBSCRIBER_LIMIT_FINDING_KEY,
  type KitSubscriberLimitAlarmState,
  type KitSubscriberLimitEvaluation,
} from "./lib/kit-subscriber-limit-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_PATH = resolve(ROOT, "data", "kit-subscriber-limit-alarm", "state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "kit-subscriber-limit-alarm", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[kit-subscriber-limit-alarm]";
/** Task roda de 4 em 4h (mesma cadência de `Diaria-Clarice-Guardrail-Alarm`/
 *  `Diaria-Brevo-Diaria-Guardrail`) — 2 execuções limpas consecutivas = ~8h
 *  sem o threshold cruzado antes de fechar a issue automaticamente, mesmo
 *  valor default do resto do repo (`CLOSE_ALARM_ISSUE_AFTER_RUNS`). */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// ─── Estado (idempotência do e-mail) ───────────────────────────────────────

export function loadState(statePath: string = STATE_PATH): KitSubscriberLimitAlarmState {
  if (!existsSync(statePath)) return emptyKitSubscriberLimitAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<KitSubscriberLimitAlarmState>;
    return {
      alarmed: raw.alarmed === true,
      lastCheckedAt: typeof raw.lastCheckedAt === "string" ? raw.lastCheckedAt : null,
    };
  } catch (e) {
    console.error(
      `${LOG_PREFIX} state corrompido/ilegível em ${statePath}: ${(e as Error).message} — resetando latch.`,
    );
    return emptyKitSubscriberLimitAlarmState();
  }
}

export { saveState };

/** Converte a avaliação no `AlarmFinding` que `scripts/lib/alarm-issues.ts`
 *  consome — array de 0 ou 1 (não `triggered` → nenhum finding, mesma
 *  convenção de "achado" do resto do repo: ausência = resolvido, o próprio
 *  `alarm-issues.ts` fecha a issue depois de `CLOSE_ALARM_ISSUE_AFTER_RUNS`
 *  execuções limpas consecutivas). */
export function toAlarmFindings(evaluation: KitSubscriberLimitEvaluation): AlarmFinding[] {
  if (!evaluation.triggered) return [];
  return [
    {
      check: KIT_SUBSCRIBER_LIMIT_FINDING_KEY,
      fingerprint: KIT_SUBSCRIBER_LIMIT_FINDING_KEY,
      family: "estado",
      title: `[diar.ia.br] Kit: ${evaluation.activeCount} assinantes ativos cruzou o alarme de ${evaluation.threshold} (teto do plano: ${evaluation.subscriberLimit})`,
      body: [
        "Achado automático do alarme `Diaria-Kit-Subscriber-Limit-Alarm`",
        "(`scripts/kit-subscriber-limit-alarm.ts`).",
        "",
        `Assinantes ativos: ${evaluation.activeCount} | threshold de alarme: ${evaluation.threshold} | ` +
          `teto do plano (subscriber_limit): ${evaluation.subscriberLimit} | margem restante: ${evaluation.remainingToLimit}.`,
        "",
        "Decisão do editor (#7362, 03/09/2026): armar alarme em 900 e decidir na",
        "hora — não subir de degrau preventivamente nem capar o teste.",
        "",
        "Esta issue é criada automaticamente pelo alarme e será",
        "comentada/fechada sozinha quando a contagem cair de volta abaixo do",
        `threshold por ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
      ].join("\n"),
      labels: ["bug"],
      priority: "P1",
    },
  ];
}

// ─── main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const kitConfigResult = resolveKitConfig();
  if (!kitConfigResult.ok) {
    console.log(`${LOG_PREFIX} ${kitConfigResult.reason} — nada a checar.`);
    return;
  }
  const kitConfig = kitConfigResult.config;

  const [account, activeSubscribers] = await Promise.all([
    getKitAccount(kitConfig),
    listAllKitSubscribers(kitConfig, { status: "active" }),
  ]);

  const evaluation = evaluateKitSubscriberLimitAlarm(activeSubscribers.length, account.subscriber_limit);
  console.log(
    `${LOG_PREFIX} ativos=${evaluation.activeCount} threshold=${evaluation.threshold} ` +
      `subscriber_limit=${evaluation.subscriberLimit} (plano ${account.plan_type || "?"}) ` +
      `triggered=${evaluation.triggered} margem=${evaluation.remainingToLimit}`,
  );

  const state = loadState();

  // Reconcilia issue ANTES de montar o e-mail (o e-mail cita a issue), mesmo
  // padrão de kit-doi-orphan-guard.ts. Roda toda execução não-dry-run,
  // independente de um e-mail novo disparar nesta rodada.
  const alarmFindings = toAlarmFindings(evaluation);
  const alarmState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  let issueRef: { issueNumber: number | null; url: string | null; action: string; error?: string } | undefined;

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado.`,
    );
  } else {
    const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
      cwd: ROOT,
      closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
    });
    saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`${LOG_PREFIX} issue não criada/reusada: ${o.error}`);
      } else {
        console.log(`${LOG_PREFIX} issue #${o.issueNumber} (${o.action}): ${o.url}`);
      }
      issueRef = { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error };
    }
  }

  if (shouldAlarmKitSubscriberLimit(state, evaluation)) {
    const { subject, body } = buildKitSubscriberLimitAlarmEmail(evaluation, new Date(), issueRef);
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      // Sem try/catch — mesmo racional de kit-doi-orphan-guard.ts: se o
      // envio falhar, saveState abaixo não roda, e a próxima execução tenta
      // alarmar de novo em vez de marcar este achado como "já avisado" sem
      // o editor ter recebido nada.
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(
      `${LOG_PREFIX} nenhum e-mail necessário (${
        evaluation.triggered ? "threshold já estava cruzado, e-mail já enviado (latch)" : "abaixo do threshold"
      }).`,
    );
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: latch NÃO avançado.`);
    return;
  }

  saveState(advanceKitSubscriberLimitAlarmState(state, evaluation, new Date()), STATE_PATH);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
