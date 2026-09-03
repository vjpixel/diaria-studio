#!/usr/bin/env node
/**
 * scripts/check-metrics-health.ts (#7172, fatia 8 — #7180)
 *
 * UM alarme, N sinais (ver `scripts/lib/metrics/health.ts` — a lógica pura,
 * incluindo a prestação de contas completa ao #6798) — NUNCA um alarme por
 * métrica. Este arquivo é só I/O: wireia os `MetricDef` do registry (F3,
 * `scripts/lib/metrics/registry.ts`) e as `Meta`s (F5,
 * `scripts/lib/metrics/metas-store.ts`) contra as fontes reais disponíveis
 * nesta máquina, chama `health.ts` pra derivar os achados, e fecha o loop
 * achado → e-mail + issue via `scripts/lib/alarm-issues.ts` (mesmo par
 * puro/IO de `task-never-armed-alarm.ts`).
 *
 * ## O que é wireado nesta v1 (7 das 8 métricas do registry)
 *
 *   - As 4 métricas de AQUISIÇÃO (`cadastros-dia` e derivadas) — via
 *     `scripts/lib/metrics/acquisition-store-deps.ts` (o mesmo par usado por
 *     `scripts/metrics-cli.ts`, #7295), 1 chamada de `computar()` por dia da
 *     janela.
 *   - `doi-confirmacao-dia` — sempre `indeterminado` nesta fatia do épico
 *     (dependência dura declarada em `registry.ts`); `computar()` é chamado
 *     mesmo assim (deps vazio, ela ignora) só pra manter a série presente —
 *     nunca gera achado de queda (sem valor numérico) nem de frescor
 *     (frescor nunca fica não-nulo, ver `evaluateFrescorFromResult`).
 *   - `base-ativa`/`leitor-v1` — via snapshots locais de
 *     `data/beehiiv-backup/` (`scripts/lib/beehiiv-backup-snapshots.ts`,
 *     leitura pura de arquivo, NUNCA API Beehiiv ao vivo — guard de
 *     publicação do overnight/develop). `kitActive` entra como `null`
 *     (nenhuma chamada Kit ao vivo nesta task — decisão desta fatia, não
 *     limitação do contrato: `BaseAtivaDeps.kitActive` já aceita `null` por
 *     desenho).
 *
 * **`doi-orfaos` fica de fora desta v1, por decisão explícita, não
 * esquecimento**: o valor dela depende só do INSTANTE em que roda (idade dos
 * `inactive` Kit contra `now`) — não existe um "dia D" gravado em disco pra
 * formar uma série histórica sem chamar a API do Kit ao vivo todo dia (o
 * contrato pede `listAllKitSubscribers`/`listAllFormSubscribers`, chamadas
 * de rede). Sinal de frescor não se aplica a ela por natureza (o "insumo" É
 * a leitura ao vivo — nunca fica velho por definição) e sinal de queda
 * exigiria uma série que este alarme não tem como montar sem custo de rede
 * novo, fora do escopo desta fatia (#7180 é sobre reusar F3/F5/F2, nunca
 * inventar coleta nova). Documentado aqui pra não ser lido como bug — segue
 * fora do escopo até uma fatia futura decidir gravar snapshot próprio.
 *
 * Uso:
 *   npx tsx scripts/check-metrics-health.ts [--dry-run] [--to editor@exemplo]
 *     [--db path] [--root data/beehiiv-backup] [--metas data/metas.json]
 *     [--queda-min-pct N] [--frescor-max-dias N] [--min-dias-serie N]
 *     [--indeterminado-max-fracao N]
 *
 *   --dry-run  avalia + imprime os achados e fingerprints — NÃO envia
 *              e-mail, NÃO abre/comenta/fecha issue, NÃO persiste estado.
 *              Mesmo contrato de todo alarme local deste repo.
 *
 * Env: `data/.credentials.json` com o scope `gmail.send` só pra ENVIAR
 * (avaliação em si não precisa de credencial nenhuma). Requer o junction
 * `data/` (OneDrive) — sem ele, `registry-mudo` dispara honestamente (nenhum
 * insumo local disponível é bem diferente de "0 findings, tudo ok").
 *
 * Estado: `data/metrics-health/.alarm-issues-state.json` (tracking de issue,
 * `alarm-issues.ts`) + `data/metrics-health/.meta-atingida-state.json`
 * (sticky de `atingida_em` por meta — `evaluateMeta` nunca reverte uma meta
 * TERMINAL, ver `metas.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { sendGmailMessage } from "./lib/gmail-send.ts";
import { resolveEditorEmail } from "./lib/inbox-stats.ts";
import { DEFAULT_DB_PATH, openDiariaSubscribersDb } from "./lib/diaria-subscribers-db.ts";
import { buildAcquisitionDepsFromStore, brtDayKey } from "./lib/metrics/acquisition-store-deps.ts";
import type { CapturaLogEntry } from "./lib/metrics/captura-log.ts";
import {
  getMetric,
  METRICAS,
  enumerarDiasInclusive,
  type Janela,
  type MetricDef,
  type BaseAtivaDeps,
  type LeitorV1Deps,
} from "./lib/metrics/registry.ts";
import { evaluateMeta, type Meta, type MedicaoDia as MetaMedicaoDia } from "./lib/metrics/metas.ts";
import { loadMetas, validateMetas, DEFAULT_METAS_PATH } from "./lib/metrics/metas-store.ts";
import { listSnapshotDates, readSnapshotSubscribers } from "./lib/beehiiv-backup-snapshots.ts";
import { LEITOR_V1_THRESHOLDS, MISSING_STATS_WARN_FRACTION, summarizeLeitores } from "./lib/leitor.ts";
import {
  METRICS_HEALTH_THRESHOLDS,
  assertQuedaMinAbsCobreUnidades,
  evaluateFrescorFromCapturaLog,
  evaluateFrescorFromResult,
  evaluateIndeterminadoCrescendo,
  evaluateMetaSinal,
  evaluateQueda,
  evaluateRegistryMudo,
  metricsHealthFingerprint,
  type MedicaoDia,
  type MetricsHealthFinding,
  type MetricsHealthThresholds,
} from "./lib/metrics/health.ts";
import {
  planAlarmReconciliation,
  applyAlarmReconciliation,
  emptyAlarmIssuesState,
  saveAlarmIssuesState,
  saveState,
  type AlarmFinding,
  type AlarmIssuesState,
  type AlarmIssueResult,
} from "./lib/alarm-issues.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT, "data");
const DEFAULT_STATE_DIR = resolve(DATA_DIR, "metrics-health");
const ALARM_ISSUES_STATE_PATH = resolve(DEFAULT_STATE_DIR, ".alarm-issues-state.json");
const META_STICKY_STATE_PATH = resolve(DEFAULT_STATE_DIR, ".meta-atingida-state.json");
const PLATFORM_CONFIG_PATH = resolve(ROOT, "platform.config.json");
const LOG_PREFIX = "[check-metrics-health]";
/** Mesmo valor de `CLOSE_ALARM_ISSUE_AFTER_RUNS` do resto do repo (ex.:
 *  `task-never-armed-alarm.ts`) — 2 execuções consecutivas sem reproduzir
 *  fecha a issue automaticamente com `--reason "not planned"`. */
const CLOSE_ALARM_ISSUE_AFTER_RUNS = 2;

/** Métricas cujo insumo é escrito por `diaria-subscribers-ingest-kit.ts`
 *  (F2, `data/metrics/captura-log.jsonl`) — únicas avaliadas pelo buraco de
 *  captura-log (`evaluateFrescorFromCapturaLog`). Ver docstring do módulo
 *  acima pro porquê de `doi-confirmacao-dia` ficar de fora. */
const ACQUISITION_METRIC_IDS = [
  "cadastros-dia",
  "cadastros-nao-pago-nao-reativacao-dia",
  "cadastros-organicos-dia",
  "cadastros-indeterminados-dia",
] as const;

/** Todas as métricas WIREADAS nesta v1 — ver docstring do módulo pro porquê
 *  de `doi-orfaos` ficar de fora. */
const WIRED_METRIC_IDS = [...ACQUISITION_METRIC_IDS, "doi-confirmacao-dia", "base-ativa", "leitor-v1"] as const;

function defaultCapturaLogPath(dbPath: string): string {
  return resolve(dirname(dbPath), "..", "metrics", "captura-log.jsonl");
}

function readCapturaLog(path: string): CapturaLogEntry[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const entries: CapturaLogEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as CapturaLogEntry);
    } catch {
      continue; // linha corrompida — pulada, mesmo padrão de metrics-cli.ts
    }
  }
  return entries;
}

/** Data (`AAAA-MM-DD`) do snapshot mais recente que existe EM OU ANTES de
 *  `dia` — snapshots são semanais (`Diaria-Beehiiv-Backup`, domingo), então
 *  a maioria dos dias da janela carrega o valor pra frente (`qualidade:
 *  'piso'`, ver `baseAtivaDef` em `registry.ts`). `null` se nenhum snapshot
 *  existe ainda ou em ou antes de `dia`. @pure */
function nearestSnapshotOnOrBefore(dates: readonly string[], dia: string): string | null {
  let best: string | null = null;
  for (const d of dates) {
    if (d <= dia && (best === null || d > best)) best = d;
  }
  return best;
}

function countActive(subs: readonly { status: string }[]): number {
  return subs.filter((s) => s.status === "active").length;
}

interface MetaAtingidaState {
  [metaId: string]: string; // atingida_em ISO
}

function loadMetaAtingidaState(path: string): MetaAtingidaState {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as MetaAtingidaState;
    return {};
  } catch {
    return {};
  }
}

function parseFloatArg(argv: string[], key: string): number | undefined {
  const raw = getArg(argv, key);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${key} deve ser um número, recebido "${raw}".`);
  }
  return value;
}

function resolveThresholds(argv: string[]): MetricsHealthThresholds {
  const quedaMinPct = parseFloatArg(argv, "queda-min-pct");
  const frescorMaxDias = parseFloatArg(argv, "frescor-max-dias");
  const minDiasSerie = parseFloatArg(argv, "min-dias-serie");
  const indeterminadoMaxFracao = parseFloatArg(argv, "indeterminado-max-fracao");
  return {
    ...METRICS_HEALTH_THRESHOLDS,
    QUEDA_MIN_PCT: quedaMinPct ?? METRICS_HEALTH_THRESHOLDS.QUEDA_MIN_PCT,
    FRESCOR_MAX_DIAS: frescorMaxDias ?? METRICS_HEALTH_THRESHOLDS.FRESCOR_MAX_DIAS,
    MIN_DIAS_SERIE: minDiasSerie ?? METRICS_HEALTH_THRESHOLDS.MIN_DIAS_SERIE,
    INDETERMINADO_MAX_FRACAO: indeterminadoMaxFracao ?? METRICS_HEALTH_THRESHOLDS.INDETERMINADO_MAX_FRACAO,
  };
}

// ---------------------------------------------------------------------------
// Achado → AlarmFinding (title/body/labels — puro em relação ao alarm-issues)
// ---------------------------------------------------------------------------

const SINAL_LABEL: Record<MetricsHealthFinding["sinal"], string> = {
  queda: "queda",
  frescor: "frescor",
  "meta-nao-atingida": "meta não atingida",
  "indeterminado-alto": "indeterminado alto",
  "registry-mudo": "registry mudo",
};

export function toMetricsHealthAlarmFinding(f: MetricsHealthFinding): AlarmFinding {
  const fingerprint = metricsHealthFingerprint(f);
  return {
    check: "metrics-health",
    fingerprint,
    title: `[diar.ia.br] saúde de métrica — ${SINAL_LABEL[f.sinal]}: ${f.metrica_id}`,
    body: [
      "Achado automático do alarme `Diaria-Metrics-Health-Alarm`",
      "(`scripts/check-metrics-health.ts`, #7180).",
      "",
      `Sinal: **${f.sinal}**`,
      `Métrica: \`${f.metrica_id}\``,
      "",
      f.motivo,
      "",
      "Este achado é RE-CHECÁVEL a cada execução (family: estado) — comenta",
      "'não reproduz mais' na 1ª ausência e fecha automaticamente",
      `(--reason "not planned") depois de ${CLOSE_ALARM_ISSUE_AFTER_RUNS} execuções consecutivas sem reproduzir.`,
      "",
      "Antes de agir: conferir à mão o `MetricResult`/`MetaStatus` de origem",
      "(`npx tsx scripts/metrics-cli.ts --json` ou o painel do Studio) contra",
      "o motivo acima — eixo de veracidade do #6798, ver docstring de",
      "`scripts/lib/metrics/health.ts`.",
    ].join("\n"),
    labels: ["bug"],
    priority: "P2",
    family: "estado",
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  loadProjectEnv(ROOT);
  const argv = process.argv.slice(2);
  const isDryRun = hasFlag(argv, "dry-run");
  const toOverride = getArg(argv, "to");
  const thresholds = resolveThresholds(argv);

  assertQuedaMinAbsCobreUnidades(METRICAS, thresholds);

  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;
  const backupRoot = getArg(argv, "root") || resolve(DATA_DIR, "beehiiv-backup");
  const metasPath = getArg(argv, "metas") || DEFAULT_METAS_PATH;

  if (!existsSync(DATA_DIR)) {
    // Sem data/, nenhum insumo local existe — registry-mudo é o achado
    // honesto (nunca "0 findings, tudo ok"). Segue até o fim do fluxo
    // normal (o resto simplesmente não avalia nada).
    console.error(`${LOG_PREFIX} data/ ausente em ${DATA_DIR} — nenhum insumo local disponível nesta máquina.`);
  }

  const hoje = brtDayKey(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);
  const primeiroDia = enumerarDiasInclusive(hoje, hoje)[0];
  const dias = enumerarDiasInclusive(
    addDaysYmd(primeiroDia, -(thresholds.MIN_DIAS_SERIE - 1)),
    hoje,
  );

  const capturaLog = readCapturaLog(defaultCapturaLogPath(dbPath));

  const findings: MetricsHealthFinding[] = [];
  const skipMotivos: string[] = [];
  const avaliadasIds = new Set<string>();
  const seriesById = new Map<string, MedicaoDia[]>();

  // ── Aquisição (4 métricas) — via store real ──────────────────────────
  let db: ReturnType<typeof openDiariaSubscribersDb> | null = null;
  try {
    db = openDiariaSubscribersDb(dbPath);
  } catch (err) {
    console.error(`${LOG_PREFIX} store do #6464 indisponível (${dbPath}): ${(err as Error).message} — aquisição não avaliada.`);
  }
  if (db) {
    const acquisitionDeps = buildAcquisitionDepsFromStore(db, capturaLog);
    for (const id of ACQUISITION_METRIC_IDS) {
      const def = getMetric(id);
      if (!def) throw new Error(`${LOG_PREFIX} métrica "${id}" não encontrada no registry`);
      const medicoes: MedicaoDia[] = [];
      for (const dia of dias) {
        const janela: Janela = { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
        const resultado = await def.computar({ janela, deps: acquisitionDeps });
        medicoes.push({ chave: dia, resultado });
      }
      seriesById.set(id, medicoes);
      avaliadasIds.add(id);
    }
    db.close();
  }

  // ── doi-confirmacao-dia — sempre indeterminado nesta fatia, série
  //    presente só pra completude (nunca gera achado, ver docstring). ──
  {
    const def = getMetric("doi-confirmacao-dia");
    if (def) {
      const medicoes: MedicaoDia[] = [];
      for (const dia of dias) {
        const janela: Janela = { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
        const resultado = await def.computar({ janela, deps: {} });
        medicoes.push({ chave: dia, resultado });
      }
      seriesById.set("doi-confirmacao-dia", medicoes);
      avaliadasIds.add("doi-confirmacao-dia");
    }
  }

  // ── base-ativa / leitor-v1 — via snapshots locais de data/beehiiv-backup/ ──
  const snapshotDates = listSnapshotDates(backupRoot);
  if (snapshotDates.length > 0) {
    const baseAtivaDef = getMetric("base-ativa") as MetricDef<BaseAtivaDeps> | undefined;
    const leitorV1Def = getMetric("leitor-v1") as MetricDef<LeitorV1Deps> | undefined;
    const subscribersCache = new Map<string, ReturnType<typeof readSnapshotSubscribers>>();
    const readCached = (date: string) => {
      let cached = subscribersCache.get(date);
      if (!cached) {
        cached = readSnapshotSubscribers(backupRoot, date);
        subscribersCache.set(date, cached);
      }
      return cached;
    };

    if (baseAtivaDef) {
      const medicoes: MedicaoDia[] = [];
      for (const dia of dias) {
        const snapshotDate = nearestSnapshotOnOrBefore(snapshotDates, dia);
        const janela: Janela = { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
        const beehiiv = snapshotDate ? { date: snapshotDate, active: countActive(readCached(snapshotDate)) } : null;
        const resultado = await baseAtivaDef.computar({ janela, deps: { beehiiv, kitActive: null, hoje: dia } });
        medicoes.push({ chave: dia, resultado });
      }
      seriesById.set("base-ativa", medicoes);
      avaliadasIds.add("base-ativa");
    }

    if (leitorV1Def) {
      const medicoes: MedicaoDia[] = [];
      for (const dia of dias) {
        const snapshotDate = nearestSnapshotOnOrBefore(snapshotDates, dia);
        const janela: Janela = { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
        const resultado = snapshotDate
          ? await leitorV1Def.computar({
              janela,
              deps: { subscribers: readCached(snapshotDate), snapshotDate },
            })
          : {
              valor: null,
              janela,
              frescor: null,
              qualidade: "indeterminado" as const,
              motivo: `nenhum snapshot Beehiiv em ou antes de ${dia}`,
            };
        medicoes.push({ chave: dia, resultado });
      }
      seriesById.set("leitor-v1", medicoes);
      avaliadasIds.add("leitor-v1");
    }
  } else {
    skipMotivos.push(`base-ativa/leitor-v1: nenhum snapshot em ${backupRoot} — não avaliados`);
  }

  // ── Sinal 5: registry-mudo ────────────────────────────────────────────
  const registryMudo = evaluateRegistryMudo(METRICAS.length, avaliadasIds.size);
  if (registryMudo) findings.push(registryMudo);

  // ── Sinais 1-2 por métrica avaliada ───────────────────────────────────
  for (const id of WIRED_METRIC_IDS) {
    const medicoes = seriesById.get(id);
    if (!medicoes) continue;
    const def = getMetric(id);
    if (!def) continue;

    const { finding: quedaFinding, skipMotivo } = evaluateQueda(def, medicoes, capturaLog, dias, thresholds);
    if (quedaFinding) findings.push(quedaFinding);
    if (skipMotivo) skipMotivos.push(skipMotivo);

    const frescorResultFinding = evaluateFrescorFromResult(id, medicoes, hoje, thresholds.FRESCOR_MAX_DIAS);
    if (frescorResultFinding) findings.push(frescorResultFinding);

    if ((ACQUISITION_METRIC_IDS as readonly string[]).includes(id)) {
      const frescorCapturaFinding = evaluateFrescorFromCapturaLog(id, dias, capturaLog);
      if (frescorCapturaFinding) findings.push(frescorCapturaFinding);
    }
  }

  // ── Sinais 3-4: metas (F5) ─────────────────────────────────────────────
  const { metas, motivo: metasMotivo } = loadMetas(metasPath);
  if (metasMotivo) skipMotivos.push(metasMotivo);
  if (metas.length > 0) {
    validateMetas(metas, METRICAS);
  }
  const metaAtingidaState = loadMetaAtingidaState(META_STICKY_STATE_PATH);
  const nextMetaAtingidaState: MetaAtingidaState = { ...metaAtingidaState };
  for (const meta of metas as Meta[]) {
    const medicoes = seriesById.get(meta.metrica_id);
    if (!medicoes) {
      skipMotivos.push(`meta "${meta.id}": métrica "${meta.metrica_id}" não wireada nesta execução — não avaliada`);
      continue;
    }
    const metaMedicoes: MetaMedicaoDia[] = medicoes.map((m) => ({ chave: m.chave, resultado: m.resultado }));
    const atingidaEmAnterior = metaAtingidaState[meta.id] ?? null;
    const status = evaluateMeta(meta, metaMedicoes, hoje, atingidaEmAnterior);
    if (status.estado === "atingida" && status.atingida_em) {
      nextMetaAtingidaState[meta.id] = status.atingida_em;
    }

    const metaFinding = evaluateMetaSinal(meta, status);
    if (metaFinding) findings.push(metaFinding);

    const indeterminadoFinding = evaluateIndeterminadoCrescendo(meta, status, dias.length, thresholds.INDETERMINADO_MAX_FRACAO);
    if (indeterminadoFinding) findings.push(indeterminadoFinding);
  }

  console.log(`${LOG_PREFIX} janela ${dias[0]}..${dias[dias.length - 1]} (${dias.length} dias) — hoje=${hoje} BRT`);
  console.log(`${LOG_PREFIX} métricas avaliadas: ${[...avaliadasIds].join(", ") || "(nenhuma)"}`);
  for (const s of skipMotivos) console.log(`${LOG_PREFIX} skip: ${s}`);
  console.log(`${LOG_PREFIX} ${findings.length} achado(s):`);
  for (const f of findings) {
    console.log(`${LOG_PREFIX}   [${metricsHealthFingerprint(f)}] ${f.motivo}`);
  }

  const alarmFindings = findings.map(toMetricsHealthAlarmFinding);
  const alarmState: AlarmIssuesState = existsSync(ALARM_ISSUES_STATE_PATH)
    ? (JSON.parse(readFileSync(ALARM_ISSUES_STATE_PATH, "utf8")) as AlarmIssuesState)
    : emptyAlarmIssuesState();

  if (isDryRun) {
    const actions = planAlarmReconciliation(alarmFindings, alarmState, CLOSE_ALARM_ISSUE_AFTER_RUNS);
    console.log(
      `${LOG_PREFIX} --dry-run: ${actions.length} ação(ões) de issue seriam tomadas ` +
        `(${actions.map((a) => a.kind).join(", ") || "nenhuma"}) — gh NÃO foi chamado, estado NÃO gravado, ` +
        "e-mail NÃO enviado.",
    );
    return;
  }

  const { nextState, findingOutcomes } = applyAlarmReconciliation(alarmFindings, alarmState, {
    cwd: ROOT,
    closeAfterRuns: CLOSE_ALARM_ISSUE_AFTER_RUNS,
  });
  saveAlarmIssuesState(nextState, ALARM_ISSUES_STATE_PATH);
  saveState(nextMetaAtingidaState, META_STICKY_STATE_PATH);

  const issueRefs: AlarmIssueResult[] = [];
  for (const outcome of findingOutcomes) {
    issueRefs.push({ issueNumber: outcome.issueNumber, url: outcome.url, action: outcome.action, error: outcome.error });
    if (outcome.action === "failed") {
      console.error(`${LOG_PREFIX} issue não criada/reusada (${outcome.check}:${outcome.fingerprint}): ${outcome.error}`);
    } else {
      console.log(`${LOG_PREFIX} issue #${outcome.issueNumber} (${outcome.action}): ${outcome.url}`);
    }
  }

  if (findings.length === 0) {
    console.log(`${LOG_PREFIX} nenhum achado — nenhum e-mail enviado.`);
    return;
  }

  const to = toOverride || resolveEditorEmail(PLATFORM_CONFIG_PATH);
  const subject = `[diar.ia.br] Diaria-Metrics-Health-Alarm — ${findings.length} achado(s)`;
  const body = [
    `Janela avaliada: ${dias[0]}..${dias[dias.length - 1]} (${dias.length} dias, hoje=${hoje} BRT)`,
    "",
    ...findings.map((f) => `- [${f.sinal}] ${f.metrica_id}: ${f.motivo}`),
    "",
    "Issues:",
    ...issueRefs.map((r) => (r.action === "failed" ? `  - falha ao criar/reusar (${r.error})` : `  - #${r.issueNumber} (${r.url})`)),
  ].join("\n");
  await sendGmailMessage(to, subject, body);
  console.log(`${LOG_PREFIX} e-mail de alarme enviado pra ${to}.`);
}

/** `AAAA-MM-DD` + delta dias (pode ser negativo) — mesma implementação de
 *  `addDaysToYmd` em `registry.ts`, não importada de lá (função interna,
 *  não exportada — duplicação de 6 linhas preferível a exportar só pra este
 *  1 uso fora do módulo). @pure */
function addDaysYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`${LOG_PREFIX} erro:`, e);
    process.exit(1);
  });
}
