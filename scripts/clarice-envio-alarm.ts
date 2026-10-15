#!/usr/bin/env node
/**
 * scripts/clarice-envio-alarm.ts (#5058, item 2)
 *
 * Task diária (20:30 BRT — 1h30 depois do `Diaria-Clarice-Envio` das 19:00,
 * folga suficiente pro retry-com-backoff embutido em `clarice-envio-run.ts`
 * — até 3 tentativas, cap de 35min cada — esgotar antes desta checagem
 * rodar): lê o relatório mais recente que `runEnvio` escreveu HOJE
 * (`data/clarice-subscribers/envio-reports/envio-{aammdd}*.md`, TODO
 * caminho de saída grava exatamente 1) e classifica o desfecho. Se a rodada
 * falhou (ou nem rodou), alarma o editor por e-mail — sem isso, o único
 * sinal era um unit systemd vermelho que ninguém olha (achado ao vivo
 * 260811: a onda de 12/08 só existiu porque um humano montou à mão).
 *
 * Lógica pura em `scripts/lib/clarice-envio-alarm.ts` — este arquivo é só
 * I/O (listar arquivos, ler mtimes, enviar e-mail).
 *
 * Uso:
 *   npx tsx scripts/clarice-envio-alarm.ts               # avalia + alarma se necessário
 *   npx tsx scripts/clarice-envio-alarm.ts --dry-run      # avalia + imprime, NÃO envia nem persiste
 *   npx tsx scripts/clarice-envio-alarm.ts --to email@x   # override do destinatário
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` (mesmo requisito
 * dos outros alarmes locais deste repo) — só necessário pra ENVIAR o alarme;
 * a leitura dos relatórios não precisa de credencial nenhuma.
 *
 * Estado: `data/clarice-subscribers/envio-alarm-issues.json` (tracking de
 * issue por achado, `alarm-issues.ts`).
 *
 * **E-mail (#7960, migrado do estado próprio `lastAlarmedAammdd` pro portão
 * `notifyEditorForOutcomes`):** duas severidades desde o #10208.
 *   - `"urgente"` — achados que só o EDITOR decide (parada vencida, base
 *     colapsada, parada não gravada, decisão contradita pelo toggle; ver
 *     `isEditorDecisionFinding`). Mandam e-mail também sob
 *     `notifications.email_policy: "urgent_only"` (na criação da issue) e a
 *     issue nasce com `develop-track`, fora da fila autônoma: o corpo traz o
 *     comando que religa envio real a terceiros, e uma rodada overnight
 *     "resolvendo" a issue rodaria esse comando sem decisão humana.
 *   - `"acao"` — falha comum do dia (`-abort`, sem relatório...). Só
 *     cria/reusa a issue sob `"urgent_only"`.
 * Sob `"legacy"`, `legacyResendIntent: "dedupe-new-occurrences-only"` vale
 * pras duas: re-executar reusa a issue (`action: "reused"`) e não re-emite
 * e-mail. Achado de EVENTO (fingerprint com `aammdd`) avisa uma vez por dia;
 * achado de ESTADO (parada `halt:{ciclo}:{since}`, `base-colapsada`, decisão
 * contradita) avisa uma vez por condição, nunca diariamente.
 * `shouldSendEnvioAlarm`/`markEnvioAlarmed`/`envio-alarm-state.json`
 * continuam definidos em `lib/clarice-envio-alarm.ts` (e testados lá) mas
 * não são mais chamados por este script.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { datePartsInTz, toAammdd, BRT_TIMEZONE } from "./lib/next-edition-date.ts";
import {
  evaluateEnvioAlarm,
  buildEnvioAlarmEmail,
  buildHaltStaleAlarmEmail,
  type EnvioAlarmEvaluation,
  pickLatestEnvioReport,
  type EnvioAlarmReportFile,
} from "./lib/clarice-envio-alarm.ts";
import {
  BASE_COLLAPSE_REPORT_SUFFIX,
  HALT_STALE_REPORT_SUFFIX,
  HALT_WRITE_FAILED_REPORT_SUFFIX,
  describeBaseCollapseActions,
  evaluateHaltReadStaleness,
  haltAlarmFingerprint,
  readClariceEnvioBaseAck,
  readClariceEnvioBaseCollapse,
  readClariceEnvioHalt,
  type ClariceEnvioBaseAck,
  type ClariceEnvioBaseCollapseRead,
  type ClariceEnvioHaltRead,
} from "./lib/clarice-envio-halt.ts";
import { RAMP_BASE_COLLAPSE_MIN_FRACTION } from "../workers/brevo-dashboard/src/weekly-plan.ts";
import { computeExpectedEnvioCycle } from "./lib/clarice-envio-cycle.ts";
import { notifyEditorForOutcomes } from "./lib/editor-notify.ts";
import {
  checkDecisionStates,
  fetchOpenIssuesWithTrustedComments,
  formatDriftReportLines,
  productionToggleReader,
  type DecisionStateCheck,
} from "./lib/decision-state-drift.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  loadAlarmIssuesState,
  saveAlarmIssuesState,
  type AlarmFinding,
  type AlarmFindingOutcome,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS_DIR = resolve(ROOT, "data", "clarice-subscribers", "envio-reports");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "clarice-subscribers", "envio-alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[clarice-envio-alarm]";
/** #5339: task roda diária (20:30) — 2 execuções consecutivas SEM o achado
 * fecham a issue de ESTADO automaticamente (parada, base colapsada, decisão
 * contradita); achados de EVENTO (fingerprint com `aammdd`) nunca
 * auto-fecham (#5553). Mesmo valor de cadência dos alarmes do lote 1/3. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

// loadAlarmIssuesState/saveAlarmIssuesState: consolidados em
// scripts/lib/alarm-issues.ts (#7124) — importados acima.

/** Converte uma avaliação NÃO-ok no `AlarmFinding` genérico que
 * `scripts/lib/alarm-issues.ts` consome (#5339). `check` fixo
 * ("clarice-envio"); `fingerprint` inclui `aammdd` — cada dia é seu próprio
 * achado (a rodada de amanhã é logicamente outro EVENTO), então uma falha de
 * HOJE nunca "esconde" atrás do estado de ontem. Sem PII: só `aammdd`,
 * verdict e `reportId` (nenhum e-mail de assinante entra aqui).
 *
 * `family: "evento"` (#5553) — a falha de um `aammdd` específico é um fato
 * histórico: a checagem de amanhã avalia OUTRO dia, então este achado
 * simplesmente sai de `pending` sem que nada tenha sido corrigido. Mesmo
 * racional de `clarice-guardrail-alarm.ts` (fingerprint `campaign-{id}`).
 *
 * **Exceção: parada vencida (#10123).** `reportId` terminando em
 * `HALT_STALE_REPORT_SUFFIX` não é falha de um dia — é uma CONDIÇÃO que
 * persiste até o `--clear`. Por isso ganha fingerprint derivado da parada
 * (`haltAlarmFingerprint`, ex.: `halt:2610-11:2026-10-01T22:00:00.000Z`, sem
 * `aammdd`), `family: "estado"` (fecha sozinha depois que a parada some, via
 * streak de `CLOSE_ALARM_ISSUE_AFTER_RUNS`) e título/corpo próprios — o
 * texto de "falhou"/"monte a onda manualmente" contradizia a parada. Antes,
 * uma parada sem decisão abria uma issue P2 nova por dia. `halt` é a leitura
 * de `data/clarice-envio-halt.json` no momento do alarme. */
export function toAlarmFinding(
  evaluation: EnvioAlarmEvaluation,
  aammdd: string,
  halt: ClariceEnvioHaltRead | null = null,
): AlarmFinding {
  if (evaluation.reportId?.endsWith(HALT_STALE_REPORT_SUFFIX)) {
    return toHaltAlarmFinding(aammdd, halt, evaluation.reportId);
  }
  // #10114 — base colapsada também é CONDIÇÃO (re-derivada do histórico da
  // Brevo toda rodada até o editor decidir), não evento de um dia: mesma
  // lógica do #10123 — fingerprint estável, `family: "estado"`, uma issue
  // enquanto durar, fecha sozinha depois do `--accept-base`/envio confirmado.
  if (evaluation.reportId?.endsWith(BASE_COLLAPSE_REPORT_SUFFIX)) {
    return toBaseCollapseAlarmFinding(aammdd, null, evaluation.reportId);
  }
  // #10208 item 2 — a rodada PAROU por fila insuficiente e a trava durável
  // não foi gravada. Orientação da regra 260811 (parar, nunca enviar menos),
  // nunca "monte a onda manualmente".
  if (evaluation.reportId?.endsWith(HALT_WRITE_FAILED_REPORT_SUFFIX)) {
    return {
      check: "clarice-envio",
      fingerprint: `${aammdd}:${evaluation.verdict}:${evaluation.reportId}`,
      family: "evento",
      title: `[diar.ia.br] Clarice: parada por fila insuficiente NÃO gravada em ${aammdd} — rampa pode recomeçar de base residual`,
      body: [
        "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
        "(`scripts/clarice-envio-alarm.ts`, #10115/#10208).",
        "",
        `aammdd: ${aammdd}`,
        `relatório: data/clarice-subscribers/envio-reports/${evaluation.reportId}.md`,
        "",
        "A rodada parou por fila insuficiente (regra 260811: parar, nunca enviar volume menor que o",
        "proposto) e NÃO conseguiu gravar `data/clarice-envio-halt.json` — o erro está no relatório.",
        "Sem a trava, a próxima rodada agendada pode escalar sobre uma base residual.",
        "",
        "NÃO monte a onda manualmente. Decisão do editor:",
        "",
        "- conferir disco/permissão/sync de `data/` (a causa da falha de escrita);",
        "- se a rampa não deve seguir sozinha, pausar o kill switch antes das 19:00 BRT:",
        '  `npx tsx scripts/lib/clarice-envio-enabled.ts --set disabled --reason "..."`.',
        "",
        EDITOR_DECISION_NOTE,
      ].join("\n"),
      labels: [...EDITOR_DECISION_LABELS],
      priority: "P2",
    };
  }
  return {
    check: "clarice-envio",
    fingerprint: `${aammdd}:${evaluation.verdict}:${evaluation.reportId ?? "no-report"}`,
    family: "evento",
    title:
      evaluation.verdict === "alarm-no-report"
        ? `[diar.ia.br] Diaria-Clarice-Envio: nenhum relatório encontrado pra ${aammdd}`
        : `[diar.ia.br] Diaria-Clarice-Envio falhou em ${aammdd} (${evaluation.reportId})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
      "(`scripts/clarice-envio-alarm.ts`).",
      "",
      `aammdd: ${aammdd}`,
      `verdict: ${evaluation.verdict}`,
      evaluation.reportId ? `reportId: ${evaluation.reportId}` : "Nenhum relatório encontrado — a rodada nem chegou a rodar.",
      "",
      "Monte a onda manualmente via /diaria-clarice-envio (skill manual) se ainda",
      "não houver onda agendada pra amanhã 06:00 BRT — não espere a task de amanhã.",
      "",
      "Esta issue é criada automaticamente pelo alarme (#5339) — achado de EVENTO",
      "PASSADO (#5553): a falha é do dia acima, não se auto-fecha quando a checagem",
      "seguinte avaliar outro dia. Fica aberta até um humano investigar/fechar",
      "(rota Overnight na Triagem).",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/** #10208 — labels dos achados que só o editor decide. `develop-track` tira a
 * issue da fila autônoma (`classifyExecTrack` → `develop`): o corpo traz o
 * comando que religa (ou mantém) envio real a terceiros. */
export const EDITOR_DECISION_LABELS = ["bug", "develop-track"] as const;

const EDITOR_DECISION_NOTE = [
  "**Decisão do editor (#10208):** esta issue NÃO é resolvível por rodada autônoma",
  "(overnight/continuo/develop sem o editor) — os comandos acima retomam ou mantêm",
  "envio real a terceiros. Label `develop-track` de propósito; não remover sem decisão.",
].join("\n");

/** Fingerprint do achado de base colapsada (#10114) — estável, sem `aammdd`. */
export const BASE_COLLAPSE_FINGERPRINT = "base-colapsada";

/** Prefixo do fingerprint de decisão contradita pelo toggle (#10210). */
export const DECISION_DRIFT_FINGERPRINT_PREFIX = "decisao-contradita:";

/** Fingerprint de achado de parada (`haltAlarmFingerprint` sempre prefixa `halt:`). */
export function isHaltFingerprint(fingerprint: string): boolean {
  return fingerprint.startsWith("halt:");
}

/** #10208 — achado que só o editor decide → severidade `"urgente"` (e-mail
 * também sob `urgent_only`) e labels `EDITOR_DECISION_LABELS`. */
export function isEditorDecisionFinding(fingerprint: string): boolean {
  return (
    isHaltFingerprint(fingerprint) ||
    fingerprint === BASE_COLLAPSE_FINGERPRINT ||
    fingerprint.startsWith(DECISION_DRIFT_FINGERPRINT_PREFIX) ||
    fingerprint.endsWith(HALT_WRITE_FAILED_REPORT_SUFFIX)
  );
}

/** Achado de ESTADO da base colapsada (#10114, #10209). `collapse` é a leitura
 * de `data/clarice-envio-base-collapse.json` (null = não lida); `reportId` é o
 * relatório `-base-colapsada` de hoje, se houver. */
export function toBaseCollapseAlarmFinding(
  aammdd: string,
  collapse: ClariceEnvioBaseCollapseRead | null,
  reportId: string | null,
): AlarmFinding {
  const state = collapse?.collapsed && !collapse.invalid ? collapse.state : null;
  const numbers = state
    ? `base ${state.baseVolume} em ${state.baseDay} = ${(state.fraction * 100).toFixed(1)}% do pico ${state.peakVolume} (${state.peakDay}); detectado em ${state.detectedAt}`
    : collapse?.collapsed && collapse.invalid
      ? `data/clarice-envio-base-collapse.json ILEGÍVEL (${collapse.error}) — tratado como colapso ativo`
      : "números no relatório";
  return {
    check: "clarice-envio",
    fingerprint: BASE_COLLAPSE_FINGERPRINT,
    family: "estado",
    title: "[diar.ia.br] Clarice: volume-base da rampa colapsou — rodada agendada parada (base-colapsada)",
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
      "(`scripts/clarice-envio-alarm.ts`, #10114/#10209).",
      "",
      `primeira detecção: ${aammdd}`,
      reportId
        ? `relatório: data/clarice-subscribers/envio-reports/${reportId}.md`
        : "relatório: nenhum `-base-colapsada` hoje — colapso lido de data/clarice-envio-base-collapse.json (#10209)",
      numbers,
      "",
      "O último dia com onda da rampa (dN) ficou muito abaixo do pico recente — provável",
      "resíduo de onda parcial depois de uma parada. A rodada agendada não escala sobre essa",
      "base e não agenda nada até decisão do editor:",
      "",
      ...describeBaseCollapseActions(state?.peakVolume ?? null, RAMP_BASE_COLLAPSE_MIN_FRACTION).map((a) => `- ${a}`),
      "",
      "Achado de ESTADO: as rodadas seguintes com a base ainda colapsada reusam esta issue,",
      "que se fecha sozinha depois que a rodada agendada volta a calcular a proposta sem",
      "colapso (ou do `--accept-base`).",
      "",
      EDITOR_DECISION_NOTE,
    ].join("\n"),
    labels: [...EDITOR_DECISION_LABELS],
    priority: "P2",
  };
}

/** #10210 — decisão vigente do editor (marcador `decisao-editor` com
 * `estado_esperado`) contradita pelo toggle real. Achado de ESTADO por
 * decisão: some quando o toggle volta ao esperado ou o editor registra nova
 * decisão; 1 issue por decisão, nunca uma por dia. */
export function toDecisionDriftAlarmFinding(drift: DecisionStateCheck): AlarmFinding {
  return {
    check: "clarice-envio",
    fingerprint: `${DECISION_DRIFT_FINGERPRINT_PREFIX}${drift.issue}:${drift.toggle}:${drift.decision.decided_at}`,
    family: "estado",
    title: `[diar.ia.br] Clarice: toggle ${drift.toggle} contradiz decisão do editor (#${drift.issue})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
      "(`scripts/clarice-envio-alarm.ts`, #10105/#10210).",
      "",
      ...formatDriftReportLines([drift]),
      "",
      "Enquanto a divergência durar, as rodadas diárias seguem o TOGGLE, não a decisão.",
      "Caminhos (decisão do editor):",
      "",
      `- ajustar o toggle \`${drift.toggle}\` à decisão (CLI \`scripts/lib/${drift.toggle}.ts --set ... --reason "..."\`);`,
      `- ou registrar decisão nova na #${drift.issue} (marcador \`decisao-editor\`).`,
      "",
      "Achado de ESTADO: fecha sozinho depois que toggle e decisão voltam a bater.",
      "",
      EDITOR_DECISION_NOTE,
    ].join("\n"),
    labels: [...EDITOR_DECISION_LABELS],
    priority: "P2",
  };
}

/** Achado de ESTADO da parada vencida (#10123). `reportId` null (#10125):
 * a parada foi detectada vencida lendo `data/clarice-envio-halt.json` direto,
 * sem relatório `-vencida` hoje — o fingerprint é o mesmo (`haltAlarmFingerprint`),
 * então a issue aberta é reusada em vez de fechar pela streak e reabrir. */
export function toHaltAlarmFinding(
  aammdd: string,
  halt: ClariceEnvioHaltRead | null,
  reportId: string | null,
): AlarmFinding {
  const fingerprint = haltAlarmFingerprint(halt);
  const haltLine =
    halt && halt.halted
      ? halt.invalid
        ? `parada: data/clarice-envio-halt.json ILEGÍVEL (${halt.error})`
        : `parada: desde ${halt.halt.since}, ciclo ${halt.halt.cycle} (${halt.halt.reportId}) — fila ${halt.halt.queueAvailable}, desejado ${halt.halt.desiredVolume}`
      : "parada: arquivo ausente no momento do alarme (já limpa?)";
  return {
    check: "clarice-envio",
    fingerprint,
    family: "estado",
    title: `[diar.ia.br] Clarice: rampa parada há tempo demais por fila insuficiente (${fingerprint})`,
    body: [
      "Achado automático do alarme `Diaria-Clarice-Envio-Alarm`",
      "(`scripts/clarice-envio-alarm.ts`, #10118/#10123).",
      "",
      `primeira detecção: ${aammdd}`,
      reportId
        ? `relatório: data/clarice-subscribers/envio-reports/${reportId}.md`
        : "relatório: nenhum `-vencida` hoje — parada lida direto de data/clarice-envio-halt.json (#10125)",
      haltLine,
      "",
      "A rampa Clarice está PARADA de propósito (regra 260811, parada durável #10096) e a",
      "parada venceu: passou do limite de dias, o ciclo virou desde ela ou o arquivo está",
      "ilegível. Não é erro de execução; nenhuma onda é agendada até decisão do editor:",
      "",
      "- retomar a automação: `npx tsx scripts/lib/clarice-envio-halt.ts --clear --reason \"...\"`",
      "- envio pontual com volume confirmado: `/diaria-clarice-envio --volume N` (não limpa a parada)",
      "",
      "Uma issue por parada (achado de ESTADO, #10123): as rodadas seguintes com a mesma",
      "parada reusam esta issue, e ela se fecha sozinha depois do `--clear`.",
      "",
      EDITOR_DECISION_NOTE,
    ].join("\n"),
    labels: [...EDITOR_DECISION_LABELS],
    priority: "P2",
  };
}

/** Leituras de ESTADO além da parada (#10209/#10210). Opcional pra manter os
 * callers/testes antigos de `buildEnvioAlarmFindings` intactos. */
export interface EnvioAlarmStateReads {
  /** `data/clarice-envio-base-collapse.json` (#10209). */
  baseCollapse?: ClariceEnvioBaseCollapseRead | null;
  /** `--accept-base` do editor (#10273). Ack posterior ao relatório
   * `-base-colapsada` desarma o achado por relatório (decisão já tomada). */
  baseAck?: ClariceEnvioBaseAck | null;
  /** mtime (ms) do relatório mais recente — compara com `baseAck.acceptedAt`. */
  reportMtimeMs?: number | null;
  /** Checagens decisão×toggle (#10210) — só as com `ok: false` viram achado.
   * `null` = o alarme decisão×toggle não rodou (gh falhou). */
  decisionChecks?: readonly DecisionStateCheck[] | null;
}

/**
 * #10125 — achados desta execução do alarme, a partir do relatório de hoje E
 * da leitura atual de `data/clarice-envio-halt.json`. Puro (`now` injetado).
 *
 * 1. **Parada vencida não depende do relatório mais recente.** Antes, o achado
 *    de parada só existia se o relatório mais novo do dia terminava em
 *    `-fila-insuficiente-vencida`; dia sem relatório, `-lock-held`/`-abort` ou
 *    um `--volume N` manual depois das 19:00 contavam como ausência, e 2 dias
 *    assim (`CLOSE_ALARM_ISSUE_AFTER_RUNS`) fechavam a issue com a parada
 *    ainda vencida — reabrindo no dia seguinte (ruído + e-mail). Agora a parada
 *    é lida sempre: ativa e vencida (pelo relatório OU pela própria avaliação
 *    de `evaluateHaltReadStaleness`) → mesmo fingerprint, a issue é reusada.
 * 2. **Relatório `-vencida` sem arquivo de parada não é achado.** O editor
 *    rodou `--clear` entre a rodada das 19:00 e o alarme das 20:30: a parada
 *    já foi decidida. Antes isso gerava `halt:sem-arquivo` (issue nova +
 *    e-mail); agora não emite nada, e a issue real da parada avança a streak
 *    de fechamento.
 * 3. **Base colapsada também é lida do estado (#10209).** Mesmo raciocínio do
 *    item 1: `data/clarice-envio-base-collapse.json` mantém o achado em dias
 *    `-paused`/`-abort`/sem relatório. O relatório `-base-colapsada` de hoje
 *    também basta (o arquivo pode ter falhado ao gravar).
 * 4. **Decisão contradita vira achado (#10210)** — antes era só uma linha no
 *    relatório, e a rodada enviava normalmente contra a decisão.
 *
 * Falha comum do dia (não `-vencida`/`-base-colapsada`) continua achado de
 * EVENTO próprio, ao lado dos achados de estado quando coexistem.
 */
export function buildEnvioAlarmFindings(
  evaluation: EnvioAlarmEvaluation,
  aammdd: string,
  halt: ClariceEnvioHaltRead | null,
  now: Date,
  reads: EnvioAlarmStateReads = {},
): AlarmFinding[] {
  const reportSaysStale = evaluation.reportId?.endsWith(HALT_STALE_REPORT_SUFFIX) ?? false;
  const collapse = reads.baseCollapse ?? null;
  // #10273: `--accept-base` apaga o estado mas não escreve relatório novo; o
  // `-base-colapsada` segue "o mais recente". Ack posterior a ele = decidido.
  const ackedAfterReport =
    !collapse?.collapsed &&
    reads.baseAck != null &&
    reads.reportMtimeMs != null &&
    Date.parse(reads.baseAck.acceptedAt) >= reads.reportMtimeMs;
  const reportSaysCollapse =
    (evaluation.reportId?.endsWith(BASE_COLLAPSE_REPORT_SUFFIX) ?? false) && !ackedAfterReport;
  const findings: AlarmFinding[] = [];
  if (halt?.halted) {
    const stale = reportSaysStale || evaluateHaltReadStaleness(halt, now, computeExpectedEnvioCycle(now)).stale;
    if (stale) findings.push(toHaltAlarmFinding(aammdd, halt, reportSaysStale ? evaluation.reportId : null));
  }
  if (reportSaysCollapse || collapse?.collapsed) {
    findings.push(toBaseCollapseAlarmFinding(aammdd, collapse, reportSaysCollapse ? evaluation.reportId : null));
  }
  for (const check of reads.decisionChecks ?? []) {
    if (!check.ok) findings.push(toDecisionDriftAlarmFinding(check));
  }
  const reportIsCollapse = evaluation.reportId?.endsWith(BASE_COLLAPSE_REPORT_SUFFIX) ?? false;
  if (evaluation.verdict !== "ok" && !reportSaysStale && !reportIsCollapse) {
    findings.push(toAlarmFinding(evaluation, aammdd));
  }
  return findings;
}

/**
 * #10208 — e-mail dos outcomes qualificados. Um achado → o e-mail dele; mais
 * de um → um e-mail só, com uma seção por achado (antes só o 1º era descrito).
 * `findingsByFingerprint` dá o texto dos achados que não têm builder próprio
 * em `lib/clarice-envio-alarm.ts` (base colapsada lida do estado, decisão
 * contradita).
 */
export function buildEnvioAlarmEmailForOutcomes(
  qualifying: readonly AlarmFindingOutcome[],
  evaluation: EnvioAlarmEvaluation,
  aammdd: string,
  findingsByFingerprint: ReadonlyMap<string, AlarmFinding>,
): { subject: string; body: string } {
  const one = (o: AlarmFindingOutcome): { subject: string; body: string } => {
    if (isHaltFingerprint(o.fingerprint)) {
      // #10125: achado de parada sem relatório `-vencida` hoje — o e-mail
      // aponta pro arquivo de parada, não pra um relatório que não existe.
      const staleReport = evaluation.reportId?.endsWith(HALT_STALE_REPORT_SUFFIX) ? evaluation.reportId : null;
      return buildHaltStaleAlarmEmail(staleReport, o);
    }
    if (o.fingerprint === BASE_COLLAPSE_FINGERPRINT || o.fingerprint.startsWith(DECISION_DRIFT_FINGERPRINT_PREFIX)) {
      const f = findingsByFingerprint.get(o.fingerprint);
      const issueLine =
        o.action === "failed" ? `Issue: falha ao criar/reusar (${o.error})` : `Issue: #${o.issueNumber} (${o.url})`;
      return {
        subject: `⚠️ ${f ? f.title.replace(/^\[diar\.ia\.br\]\s*/, "") : o.fingerprint}`,
        body: `${f?.body ?? o.fingerprint}\n\n${issueLine}`,
      };
    }
    return buildEnvioAlarmEmail(evaluation, aammdd, o);
  };
  if (qualifying.length === 1) return one(qualifying[0]);
  const parts = qualifying.map(one);
  return {
    subject: `⚠️ Diaria-Clarice-Envio: ${parts.length} alarmes em ${aammdd} — ${parts[0].subject.replace(/^⚠️\s*/, "")}`,
    body: parts.map((p) => `## ${p.subject}\n\n${p.body}`).join("\n\n---\n\n"),
  };
}

/**
 * Lista os relatórios `envio-{aammdd}*.md` de HOJE — cada `writeAndRegisterReport`
 * de `runEnvio` grava exatamente 1 por invocação, então >1 candidato só
 * acontece se a rodada rodou mais de 1x no dia (retry manual). Ausência de
 * `data/` (junction não montada) devolve `[]` — o guard de registro
 * (`requiredFile: "clarice-subscribers/clarice-users.db"`) já cobre esse
 * caso antes de a task chegar aqui, mas `existsSync` defensivo evita um
 * `readdirSync` lançando em cima disso.
 */
export function listTodayEnvioReports(reportsDir: string, aammdd: string): EnvioAlarmReportFile[] {
  if (!existsSync(reportsDir)) return [];
  const prefix = `envio-${aammdd}`;
  return readdirSync(reportsDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".md"))
    .map((f) => {
      const reportId = f.slice(0, -".md".length);
      const mtimeMs = statSync(resolve(reportsDir, f)).mtimeMs;
      return { reportId, mtimeMs };
    });
}

/** #10208 — separa os outcomes pela severidade do achado: decisão do editor →
 * `"urgente"` (e-mail também sob `urgent_only`), resto → `"acao"`. Puro. */
export function splitOutcomesBySeverity(outcomes: readonly AlarmFindingOutcome[]): {
  urgente: AlarmFindingOutcome[];
  acao: AlarmFindingOutcome[];
} {
  const urgente: AlarmFindingOutcome[] = [];
  const acao: AlarmFindingOutcome[] = [];
  for (const o of outcomes) (isEditorDecisionFinding(o.fingerprint) ? urgente : acao).push(o);
  return { urgente, acao };
}

/**
 * #10210 — com o alarme decisão×toggle sem rodar (`gh` falhou), a ausência de
 * achado de decisão contradita NÃO prova que a divergência acabou. As
 * entries dessas issues ficam FORA da reconciliação (sem avançar a streak de
 * fechamento) e voltam intactas ao estado. Puro.
 */
export function holdDecisionDriftEntries(state: AlarmIssuesState): { active: AlarmIssuesState; held: AlarmIssuesState } {
  const active: AlarmIssuesState = {};
  const held: AlarmIssuesState = {};
  const prefix = `clarice-envio:${DECISION_DRIFT_FINGERPRINT_PREFIX}`;
  for (const [key, entry] of Object.entries(state)) (key.startsWith(prefix) ? held : active)[key] = entry;
  return { active, held };
}

/** #10210 — checagens decisão×toggle, ou `null` se não deu pra rodar (fail-soft:
 * o alarme de envio não pode cair por causa do `gh`). */
function readDecisionChecks(): readonly DecisionStateCheck[] | null {
  try {
    const fetched = fetchOpenIssuesWithTrustedComments(ROOT);
    if (!fetched.ok) {
      console.error(`${LOG_PREFIX} alarme decisão×toggle (#10105/#10210) NÃO rodou: ${fetched.error}`);
      return null;
    }
    const checks = checkDecisionStates(fetched.issues, productionToggleReader(ROOT));
    for (const line of formatDriftReportLines(checks)) console.log(`${LOG_PREFIX} ${line}`);
    return checks;
  } catch (e) {
    console.error(`${LOG_PREFIX} alarme decisão×toggle (#10105/#10210) NÃO rodou: ${(e as Error).message}`);
    return null;
  }
}

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const aammdd = toAammdd(datePartsInTz(new Date(), BRT_TIMEZONE));
  const candidates = listTodayEnvioReports(REPORTS_DIR, aammdd);
  const evaluation = evaluateEnvioAlarm(candidates, aammdd);
  console.log(
    `${LOG_PREFIX} aammdd=${aammdd} candidatos=${candidates.length} verdict=${evaluation.verdict}` +
      (evaluation.reportId ? ` reportId=${evaluation.reportId}` : ""),
  );

  // #5339 — reconcilia issue pro achado (se houver) ANTES de montar o
  // e-mail (o e-mail cita a issue), mesmo padrão do lote 1/3. Roda toda
  // execução não-dry-run. #7960: o e-mail (abaixo) é decidido a partir do
  // OUTCOME desta reconciliação (`notifyEditorForOutcomes`), não mais de
  // um estado `lastAlarmedAammdd` separado.
  // #10123/#10125: parada vencida usa a identidade da parada (não o dia) e
  // é lida SEMPRE — não só quando o relatório mais recente é o `-vencida`.
  // #10209: base colapsada idem, de `data/clarice-envio-base-collapse.json`.
  // #10210: decisão do editor contradita pelo toggle vira achado próprio.
  const haltRead = readClariceEnvioHalt(ROOT);
  const baseCollapse: ClariceEnvioBaseCollapseRead = readClariceEnvioBaseCollapse(ROOT);
  const decisionChecks = readDecisionChecks();
  const alarmFindings: AlarmFinding[] = buildEnvioAlarmFindings(evaluation, aammdd, haltRead, new Date(), {
    baseCollapse,
    baseAck: readClariceEnvioBaseAck(ROOT),
    reportMtimeMs: pickLatestEnvioReport(candidates)?.mtimeMs ?? null,
    decisionChecks,
  });
  const fullState = loadAlarmIssuesState(ALARM_ISSUES_STATE_PATH);
  const { active: alarmState, held } =
    decisionChecks === null ? holdDecisionDriftEntries(fullState) : { active: fullState, held: {} };

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
  saveAlarmIssuesState({ ...nextState, ...held }, ALARM_ISSUES_STATE_PATH);
  for (const outcome of findingOutcomes) {
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada: ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
    }
  }

  if (findingOutcomes.length === 0) {
    console.log(`${LOG_PREFIX} rodada de ${aammdd} OK — nenhum alarme necessário.`);
    return;
  }

  // #10208 — dois portões: achados que só o editor decide saem como
  // `"urgente"` (chegam por e-mail sob `urgent_only`); falhas comuns do dia
  // seguem `"acao"`. Cada grupo vira no máximo 1 e-mail.
  const findingsByFingerprint = new Map(alarmFindings.map((f) => [f.fingerprint, f]));
  const groups = splitOutcomesBySeverity(findingOutcomes);
  for (const severity of ["urgente", "acao"] as const) {
    const outcomes = groups[severity];
    if (outcomes.length === 0) continue;
    const result = await notifyEditorForOutcomes(
      outcomes,
      severity,
      (qualifying) => buildEnvioAlarmEmailForOutcomes(qualifying, evaluation, aammdd, findingsByFingerprint),
      {
        cwd: ROOT,
        platformConfigPath: PLATFORM_CONFIG_PATH,
        emailTo: toOverride,
        // Achado de ESTADO (parada, base colapsada, decisão contradita): o
        // fingerprint é a condição (sem `aammdd`) — os dias seguintes reusam
        // a issue e, por este intent, não re-enviam e-mail: 1 aviso por
        // condição. Achado de EVENTO (#8271): fingerprint inclui `aammdd`,
        // 1 ocorrência por dia; reexecução no MESMO dia reusa a issue e não
        // re-emite e-mail sob `email_policy: "legacy"`.
        legacyResendIntent: "dedupe-new-occurrences-only",
      },
    );
    if (result.qualifying.length === 0) {
      console.log(`${LOG_PREFIX} [${severity}] política '${result.emailPolicy}': nenhum e-mail necessário pra este outcome.`);
    } else if (result.emailSent) {
      console.log(`${LOG_PREFIX} [${severity}] e-mail de alarme enviado (aammdd=${aammdd}, verdict=${evaluation.verdict}).`);
    } else {
      console.error(`${LOG_PREFIX} [${severity}] falha ao enviar e-mail: ${result.emailError}`);
    }
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
