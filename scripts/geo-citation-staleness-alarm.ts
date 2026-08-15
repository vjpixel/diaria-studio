#!/usr/bin/env node
/**
 * scripts/geo-citation-staleness-alarm.ts (#4755)
 *
 * Task semanal: lê o `ts` do registro mais recente de
 * `data/geo-citations/history.jsonl` (escrito por `geo-citation-monitor.ts`,
 * #4558 Parte C) e alarma o editor por e-mail (Gmail) quando faz mais de
 * `STALENESS_THRESHOLD_DAYS` que nenhum registro novo chegou — sinal que
 * cobre, com o mesmo sintoma observável, task desabilitada/removida do Task
 * Scheduler, máquina fora por semanas, ou todo provider sem API key (ver
 * docstring de `scripts/lib/geo-citation-staleness-alarm.ts`).
 *
 * Por que não basta checar se a task está registrada: um guard desse tipo
 * cobre só o registro inicial, nunca `State`/`LastTaskResult`. Este alarme
 * olha o SINTOMA (histórico parado), não o registro da task, e roda
 * separado — mesma task desabilitada e sem re-registrar nunca dispararia
 * um guard de registro de novo. (`scripts/lib/pending-scheduled-tasks.ts`,
 * que fazia esse tipo de checagem contra os antigos `.ps1` do Windows, foi
 * removido no #5115 — cutover final.)
 *
 * Uso:
 *   npx tsx scripts/geo-citation-staleness-alarm.ts [--dry-run] [--to email@x]
 *
 *   --dry-run  computa a staleness e avalia se alarmaria, mas NÃO envia
 *              e-mail nem avança o estado persistido — mesmo contrato de
 *              `apoios-diff-alarm.ts`/`clarice-opens-catchup-alarm.ts`.
 *   --to       override do destinatário (default: resolveEditorEmail).
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` + o junction
 * `data/` (OneDrive) — mesmo requisito dos demais alarmes por e-mail do
 * repo. NÃO requer nenhuma das API keys de provider GEO — só lê o histórico
 * já escrito, nunca chama os providers.
 *
 * Estado (idempotência): `data/geo-citations/staleness-alarm-state.json`.
 */
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { hasFlag, getArg, isMainModule } from "./lib/cli-args.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import {
  DEFAULT_GEO_CITATIONS_LOG_PATH,
  GEO_PROVIDERS,
  latestRoundProviders,
  type GeoProviderId,
} from "./lib/geo-citation-monitor.ts";
import {
  emptyGeoCitationStalenessAlarmState,
  computeStaleness,
  computeMultiPanelStaleness,
  fingerprintFor,
  advanceState,
  shouldAlarm,
  buildGeoCitationStalenessAlarmEmail,
  computeMultiPanelMissingProviders,
  shouldAlarmMissingProviders,
  buildMissingProviderAlarmEmail,
  type GeoCitationStalenessAlarmState,
} from "./lib/geo-citation-staleness-alarm.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  type AlarmFinding,
  type AlarmIssuesState,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = resolve(ROOT, DEFAULT_GEO_CITATIONS_LOG_PATH);
const STATE_PATH = resolve(ROOT, "data", "geo-citations", "staleness-alarm-state.json");
const ALARM_ISSUES_STATE_PATH = resolve(ROOT, "data", "geo-citations", "alarm-issues.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[geo-citation-staleness-alarm]";
/** #5339: task roda semanal (domingos 10:30) — 2 execuções limpas
 * consecutivas = 2 semanas sem o achado, mesmo valor (número de execuções)
 * dos demais alarmes deste lote, aplicado à cadência semanal desta task. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

export function loadState(statePath: string = STATE_PATH): GeoCitationStalenessAlarmState {
  if (!existsSync(statePath)) return emptyGeoCitationStalenessAlarmState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8")) as Partial<GeoCitationStalenessAlarmState>;
    const fingerprint =
      typeof raw.lastAlarmedFingerprint === "string" || raw.lastAlarmedFingerprint === null
        ? raw.lastAlarmedFingerprint ?? null
        : null;
    const checkedAt =
      typeof raw.lastCheckedAt === "string" || raw.lastCheckedAt === null ? raw.lastCheckedAt ?? null : null;
    // #5316: mesmo tratamento fail-soft do campo original — string ou null
    // são válidos, qualquer outra coisa (campo ausente num state antigo,
    // shape inesperado) cai pra null.
    const missingProviderFingerprint =
      typeof raw.lastAlarmedMissingProviderFingerprint === "string" || raw.lastAlarmedMissingProviderFingerprint === null
        ? raw.lastAlarmedMissingProviderFingerprint ?? null
        : null;
    return {
      lastAlarmedFingerprint: fingerprint,
      lastCheckedAt: checkedAt,
      lastAlarmedMissingProviderFingerprint: missingProviderFingerprint,
    };
  } catch {
    return emptyGeoCitationStalenessAlarmState();
  }
}

export function saveState(state: GeoCitationStalenessAlarmState, statePath: string = STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

// ─── Estado (dedup/reconciliação de ISSUE por achado, #5339) ──────────────
// Arquivo separado de STATE_PATH de propósito — mesmo racional dos demais
// alarmes deste lote: idempotência do E-MAIL (acima) e tracking de ISSUE
// por achado são preocupações independentes.

export function loadAlarmIssuesState(statePath: string = ALARM_ISSUES_STATE_PATH): AlarmIssuesState {
  if (!existsSync(statePath)) return emptyAlarmIssuesState();
  try {
    const raw = JSON.parse(readFileSync(statePath, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as AlarmIssuesState;
    return emptyAlarmIssuesState();
  } catch {
    return emptyAlarmIssuesState();
  }
}

export function saveAlarmIssuesState(state: AlarmIssuesState, statePath: string = ALARM_ISSUES_STATE_PATH): void {
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n");
}

/** Converte o veredito de staleness (agregado, #4900) num `AlarmFinding`
 * (#5339) — `check` fixo, `fingerprint` = `agg.fingerprint` (mesma fórmula
 * que já governa a idempotência do e-mail, cobre só os painéis STALE). Sem
 * PII — o achado só cita nome de painel e timestamp de registro, nenhum
 * dado de assinante. */
function toStalenessFinding(agg: { isStale: boolean; stalePanels: { panel: string; latestRecordTs: string | null; check: { staleDays: number | null } }[]; fingerprint: string }): AlarmFinding {
  const worst = agg.stalePanels[0];
  const lines = [
    "Achado automático do alarme `Diaria-Geo-Citation-Staleness-Alarm`",
    "(`scripts/geo-citation-staleness-alarm.ts`).",
    "",
    `Painel(is) stale: ${agg.stalePanels.map((p) => p.panel).join(", ")}`,
    `Painel mais grave: "${worst.panel}" — último registro: ${worst.latestRecordTs ?? "nenhum"} ` +
      `(${worst.check.staleDays ?? "?"} dia(s)).`,
    "",
    "Verifique se a task `Diaria-Geo-Citation-Monitor` (domingos 07:00) segue registrada e rodando",
    "(Get-ScheduledTask -TaskName 'Diaria-Geo-Citation-Monitor' | Get-ScheduledTaskInfo) e se ao menos",
    "um provider (ANTHROPIC_API_KEY/OPENAI_API_KEY/GEMINI_API_KEY) segue configurado.",
    "",
    "Esta issue é criada automaticamente pelo alarme (#5339) e será",
    "comentada/fechada sozinha quando o achado deixar de reproduzir por",
    `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
  ];
  return {
    check: "geo-citation-staleness",
    fingerprint: agg.fingerprint,
    title: `[diar.ia.br] monitor de citação GEO sem medição nova (${agg.stalePanels.map((p) => p.panel).join(", ")})`,
    body: lines.join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/** Converte o veredito de provider ausente (#5316) num `AlarmFinding`
 * (#5339) — `check` distinto de `toStalenessFinding` (sinal independente,
 * ver docstring de `computeMultiPanelMissingProviders`). Sem PII. */
function toMissingProviderFinding(missingCheck: { hasMissing: boolean; panelsWithMissing: { panel: string; missingProviders: string[] }[]; fingerprint: string }): AlarmFinding {
  const allMissing = [...new Set(missingCheck.panelsWithMissing.flatMap((p) => p.missingProviders))].sort();
  const lines = [
    "Achado automático do alarme `Diaria-Geo-Citation-Staleness-Alarm`",
    "(`scripts/geo-citation-staleness-alarm.ts`, checagem de provider ausente #5316).",
    "",
    ...missingCheck.panelsWithMissing.map((p) => `  - painel "${p.panel}": faltando ${p.missingProviders.join(", ")}`),
    "",
    "Causa mais provável: a API key do provider sumiu do .env da máquina que roda",
    "a task Diaria-Geo-Citation-Monitor. Verifique com",
    "npx tsx scripts/geo-citation-monitor.ts --dry-run.",
    "",
    "Esta issue é criada automaticamente pelo alarme (#5339) e será",
    "comentada/fechada sozinha quando o achado deixar de reproduzir por",
    `${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas (mesmo padrão de #5112).`,
  ];
  return {
    check: "geo-citation-missing-provider",
    fingerprint: missingCheck.fingerprint,
    title: `[diar.ia.br] monitor de citação GEO sem registro de ${allMissing.join(", ")} na última rodada`,
    body: lines.join("\n"),
    labels: ["bug"],
    priority: "P2",
  };
}

/**
 * Lê o `ts` do ÚLTIMO registro legível de `history.jsonl`, andando de trás
 * pra frente — fail-soft linha a linha (uma linha corrompida não invalida
 * as anteriores, mesmo espírito string-safe de `extract-opens-catchup-status.ts`).
 * Retorna `null` quando o arquivo não existe, está vazio, ou nenhuma linha é
 * um JSON válido com `ts` string.
 */
export function readLatestGeoCitationTs(
  historyPath: string = HISTORY_PATH,
  /** #4900: quando informado, considera só os registros DESTE painel.
   * Registro legado sem campo `panel` conta como `"geral"` — mesma regra de
   * leitura de `readHistoryRecordsForPanel` em `lib/geo-citation-monitor.ts`.
   * Sem o parâmetro, o comportamento é o de antes (última linha legível,
   * qualquer painel). */
  panel?: string,
): string | null {
  if (!existsSync(historyPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(historyPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const record = JSON.parse(lines[i]) as { ts?: unknown; panel?: unknown };
      if (typeof record.ts !== "string" || record.ts.length === 0) continue;
      if (panel !== undefined) {
        const recPanel = typeof record.panel === "string" && record.panel.length > 0 ? record.panel : "geral";
        if (recPanel !== panel) continue;
      }
      return record.ts;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Lê `{date, provider}` de TODOS os registros de UM painel de
 * `history.jsonl` — alimenta `latestRoundProviders` (import de
 * `lib/geo-citation-monitor.ts`) pra checagem de provider ausente (#5316).
 * Mesmo fail-soft de `readLatestGeoCitationTs` acima: linha corrompida é
 * ignorada, não invalida as demais. Duplica (não importa) a lógica
 * equivalente de `readHistoryRecordsForPanel` em `scripts/geo-citation-monitor.ts`
 * de propósito — aquele é um CLI script (não `lib/`), sem precedente no
 * repo de um script importar diretamente de outro, e a lógica é pequena o
 * bastante pra não valer esse acoplamento.
 */
export function readPanelProviderRecords(
  historyPath: string,
  panel: string,
): Array<{ date: string; provider: GeoProviderId }> {
  if (!existsSync(historyPath)) return [];
  let raw: string;
  try {
    raw = readFileSync(historyPath, "utf8");
  } catch {
    return [];
  }
  const out: Array<{ date: string; provider: GeoProviderId }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { date?: unknown; provider?: unknown; panel?: unknown };
      if (typeof r.date !== "string" || typeof r.provider !== "string") continue;
      const recPanel = typeof r.panel === "string" && r.panel.length > 0 ? r.panel : "geral";
      if (recPanel !== panel) continue;
      // `provider` legado é sempre um dos 3 ids conhecidos — cast, não
      // validação, mesmo espírito fail-soft do resto do módulo: um valor
      // fora da união só cairia num id que `GEO_PROVIDERS` também não tem,
      // então nunca aparece "presente" numa comparação contra ele.
      out.push({ date: r.date, provider: r.provider as GeoProviderId });
    } catch {
      continue;
    }
  }
  return out;
}

/** Painéis que a task `Diaria-Geo-Citation-Monitor` roda hoje — precisa
 * espelhar os `steps` de `scripts/lib/scheduled-tasks.ts`. Literal e não
 * derivado do registry de propósito: derivar acoplaria o alarme ao formato
 * dos args da task, e um painel removido da task deve continuar sendo
 * checado até alguém decidir explicitamente que a série dele acabou. */
const MONITORED_PANELS = ["geral", "hubs"] as const;

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");

  const now = new Date();
  // #4900: um painel por vez. Com 2 painéis ativos, olhar só a última linha
  // do arquivo esconderia um painel quebrado atrás do outro saudável — ver
  // docstring de `computeMultiPanelStaleness`.
  const perPanel = MONITORED_PANELS.map((panel) => {
    const latestRecordTs = readLatestGeoCitationTs(HISTORY_PATH, panel);
    return { panel, latestRecordTs, check: computeStaleness(latestRecordTs, now) };
  });
  const agg = computeMultiPanelStaleness(perPanel);
  const state = loadState();

  for (const p of perPanel) {
    console.log(
      `${LOG_PREFIX} painel "${p.panel}": último registro ${p.latestRecordTs ?? "nenhum"} ` +
        `(${p.check.staleDays ?? "?"} dia(s), stale=${p.check.isStale}).`,
    );
  }
  console.log(`${LOG_PREFIX} última checagem: ${state.lastCheckedAt ?? "nunca"}.`);

  const check = { isStale: agg.isStale, staleDays: agg.stalePanels[0]?.check.staleDays ?? null };
  const fingerprint = agg.fingerprint;

  // #5316: provider ausente da última rodada — sinal INDEPENDENTE de
  // staleness (ver docstring de `computeMultiPanelMissingProviders` em
  // lib/geo-citation-staleness-alarm.ts pro porquê). Compara contra
  // GEO_PROVIDERS (o conjunto canônico que o monitor sabe consultar), não
  // contra "quem tinha key na rodada anterior" — detecta tanto uma ausência
  // de 1 rodada quanto uma persistente há semanas com a mesma checagem.
  // Computado ANTES do bloco de staleness abaixo (#5339) pra poder
  // reconciliar as issues dos dois achados numa única passada.
  const configuredProviderIds = GEO_PROVIDERS.map((p) => p.id);
  const perPanelProviders = MONITORED_PANELS.map((panel) => {
    const records = readPanelProviderRecords(HISTORY_PATH, panel);
    const latest = latestRoundProviders(records);
    return { panel, latestRoundProviders: latest?.providers ?? [] };
  });
  for (const p of perPanelProviders) {
    console.log(
      `${LOG_PREFIX} painel "${p.panel}": última rodada tinha providers [${p.latestRoundProviders.join(", ") || "nenhum"}].`,
    );
  }
  const missingCheck = computeMultiPanelMissingProviders(perPanelProviders, configuredProviderIds);

  // #5339 — reconcilia uma issue por achado (staleness / provider ausente)
  // ANTES de montar os e-mails, mesmo padrão de hub-drift-check.ts. Roda
  // toda execução não-dry-run, independente de um e-mail novo disparar
  // nesta rodada.
  const alarmFindings: AlarmFinding[] = [
    ...(agg.isStale ? [toStalenessFinding(agg)] : []),
    ...(missingCheck.hasMissing ? [toMissingProviderFinding(missingCheck)] : []),
  ];
  const alarmState = loadAlarmIssuesState();
  let issueRefs: Map<string, { issueNumber: number | null; url: string | null; action: string; error?: string }> | undefined;

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
    saveAlarmIssuesState(nextState);
    issueRefs = new Map(
      findingOutcomes.map((o) => [
        o.check,
        { issueNumber: o.issueNumber, url: o.url, action: o.action, error: o.error },
      ]),
    );
    for (const o of findingOutcomes) {
      if (o.action === "failed") {
        console.error(`${LOG_PREFIX} [${o.check}] issue não criada/reusada: ${o.error}`);
      } else {
        console.log(`${LOG_PREFIX} [${o.check}] issue #${o.issueNumber} (${o.action}): ${o.url}`);
      }
    }
  }

  if (shouldAlarm(state, check, fingerprint)) {
    const worst = agg.stalePanels[0];
    const { subject, body } = buildGeoCitationStalenessAlarmEmail(
      worst.latestRecordTs,
      worst.check.staleDays,
      agg.stalePanels.map((p) => p.panel).join(", "),
      issueRefs?.get("geo-citation-staleness"),
    );
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(`${LOG_PREFIX} --dry-run: enviaria e-mail pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`);
    } else {
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail necessário (não stale, ou esta staleness já foi alarmada antes).`);
  }

  if (shouldAlarmMissingProviders(state, missingCheck, missingCheck.fingerprint)) {
    const { subject, body } = buildMissingProviderAlarmEmail(
      missingCheck.panelsWithMissing,
      issueRefs?.get("geo-citation-missing-provider"),
    );
    const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
    if (isDryRun) {
      console.log(
        `${LOG_PREFIX} --dry-run: enviaria e-mail (provider ausente) pra ${to}:\n--- subject ---\n${subject}\n--- body ---\n${body}`,
      );
    } else {
      await sendGmailMessage(to, subject, body);
      console.log(`${LOG_PREFIX} e-mail de alarme (provider ausente) enviado pra ${to}.`);
    }
  } else {
    console.log(`${LOG_PREFIX} nenhum e-mail de provider ausente necessário.`);
  }

  if (isDryRun) {
    console.log(`${LOG_PREFIX} --dry-run: estado NÃO avançado.`);
    return;
  }

  const nextFingerprint = check.isStale ? fingerprint : null;
  const nextMissingProviderFingerprint = missingCheck.hasMissing ? missingCheck.fingerprint : null;
  saveState(advanceState(nextFingerprint, now, nextMissingProviderFingerprint));
}

if (isMainModule(import.meta.url)) {
  // #4745: process.exitCode em vez de process.exit() — este catch roda DEPOIS
  // de um await de rede em voo (sendGmailMessage via gFetch), mesmo cenário
  // UV_HANDLE_CLOSING no Windows documentado em hub-drift-check.ts.
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exitCode = 1;
  });
}
