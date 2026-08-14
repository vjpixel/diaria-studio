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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = resolve(ROOT, DEFAULT_GEO_CITATIONS_LOG_PATH);
const STATE_PATH = resolve(ROOT, "data", "geo-citations", "staleness-alarm-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[geo-citation-staleness-alarm]";

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
  if (shouldAlarm(state, check, fingerprint)) {
    const worst = agg.stalePanels[0];
    const { subject, body } = buildGeoCitationStalenessAlarmEmail(
      worst.latestRecordTs,
      worst.check.staleDays,
      agg.stalePanels.map((p) => p.panel).join(", "),
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

  // #5316: provider ausente da última rodada — sinal INDEPENDENTE de
  // staleness (ver docstring de `computeMultiPanelMissingProviders` em
  // lib/geo-citation-staleness-alarm.ts pro porquê). Compara contra
  // GEO_PROVIDERS (o conjunto canônico que o monitor sabe consultar), não
  // contra "quem tinha key na rodada anterior" — detecta tanto uma ausência
  // de 1 rodada quanto uma persistente há semanas com a mesma checagem.
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
  if (shouldAlarmMissingProviders(state, missingCheck, missingCheck.fingerprint)) {
    const { subject, body } = buildMissingProviderAlarmEmail(missingCheck.panelsWithMissing);
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
