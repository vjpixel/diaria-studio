/**
 * studio-ads.ts (#5236 Parte 3, fatia da EPIC "Studio UI" #3554)
 *
 * Camada de leitura pra `GET /api/ads`: a tela que responde as 4 perguntas
 * de 5 segundos da issue #5236 — qual canal traz leitor mais barato (e com
 * que `n`)? a coorte de cada canal lê mais ou menos que a base? quanto do
 * orçamento do mês já foi consumido? algum canal degradou desde o último
 * período? Mesmo padrão de `studio-tasks.ts`/`studio-utms.ts` — `server.ts`
 * só roteia, este arquivo monta o snapshot.
 *
 * **Reuso total do núcleo puro (#5236 requisito explícito).** Nenhuma
 * lógica de agrupamento/ranking é reimplementada aqui — `buildAdsData` só
 * carrega os 3 insumos do disco (mesmos helpers de I/O de
 * `scripts/cac-report.ts`: `loadOrigemIndex`/`loadPreparedSubscribers`) e
 * chama `buildCacReport`/`computeMonthBudgetUsage` de `scripts/lib/cac.ts`.
 *
 * **Sessão cloud (`data/` ausente) renderiza "sem dados" graciosamente,
 * nunca lança** (requisito explícito da issue) — `detectExecMode` decide o
 * eixo, mas o guard REAL é `existsSync` em cada arquivo/diretório
 * individual: mesmo em sessão `local`, `spend.csv` pode não existir ainda
 * (1ª execução antes do seed) e o snapshot Beehiiv pode não ter rodado —
 * cada camada tem seu próprio `error`/estado ausente, igual
 * `studio-utms.ts`/`studio-integrations.ts` (fail-soft por camada).
 *
 * **Cache + TTL** (10 min default — gasto muda ~1×/trimestre por decisão
 * explícita da issue "nenhuma task agendada... o relatório roda sob
 * demanda", então não há necessidade de TTL curto tipo `studio-tasks.ts`).
 * `forceRefresh` bypassa.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectExecMode, type ExecMode } from "../lib/exec-mode.ts";
import { latestSnapshotDate, listSnapshotDates } from "../lib/beehiiv-backup-snapshots.ts";
import { readSpendCsv, type SpendRow, type SpendRowError } from "../lib/aquisicao-spend.ts";
import { buildCacReport, computeMonthBudgetUsage, MONTHLY_BUDGET_FLOOR_BRL, type CacReport, type MonthBudgetUsage } from "../lib/cac.ts";
import { loadOrigemIndex, loadPreparedSubscribers } from "../cac-report.ts";

// ─── tipos do snapshot ──────────────────────────────────────────────────

export interface AdsSpendLayer {
  path: string;
  rows: SpendRow[];
  rowErrors: SpendRowError[];
  /** Preenchido quando o arquivo está ausente/ilegível — `rows` fica `[]`. */
  error: string | null;
}

export interface AdsSnapshotLayer {
  root: string;
  date: string | null;
  previousDate: string | null;
  error: string | null;
}

export interface AdsOrigemLayer {
  applied: boolean;
  path: string;
}

export interface AdsSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  cached: boolean;
  /** `false` só quando `data/` inteiro está ausente (sessão cloud sem
   *  junction) — sinal de topo pra UI mostrar "sem dados" em vez de tabela
   *  vazia confusa. Camadas individuais (spend/snapshot) têm seus próprios
   *  `error` independente disso. */
  hasDataDir: boolean;
  spend: AdsSpendLayer;
  snapshot: AdsSnapshotLayer;
  origem: AdsOrigemLayer;
  /** `null` quando spend ou snapshot falharam (sem os dois insumos não há
   *  relatório pra montar). */
  report: CacReport | null;
  budget: MonthBudgetUsage | null;
  monthKey: string | null;
}

// ─── construção (fail-soft por camada) ──────────────────────────────────

function loadSpendLayer(path: string): AdsSpendLayer {
  try {
    const { rows, errors } = readSpendCsv(path);
    return { path, rows, rowErrors: errors, error: null };
  } catch (e) {
    return { path, rows: [], rowErrors: [], error: (e as Error).message };
  }
}

export interface BuildAdsDataOptions {
  now?: () => Date;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  backupRoot?: string;
  spendPath?: string;
  origemPath?: string;
}

interface CacheEntry {
  data: AdsSnapshot;
  expiresAt: number;
}

/** Cache em memória por `rootDir` — mesmo espírito de `studio-tasks.ts`/`studio-utms.ts`. */
const cacheByRoot = new Map<string, CacheEntry>();

/** Limpa o cache — usado só por testes pra isolar casos entre si. */
export function clearAdsCache(): void {
  cacheByRoot.clear();
}

/**
 * Monta o snapshot completo pra `GET /api/ads`. Nunca lança — qualquer
 * falha de insumo vira campo `error` da camada correspondente (fail-soft,
 * mesmo padrão de `buildTasksData`/`buildUtmsData`).
 */
export function buildAdsData(rootDir: string, opts: BuildAdsDataOptions = {}): AdsSnapshot {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;

  if (!opts.forceRefresh) {
    const cached = cacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.data, cached: true };
    }
  }

  const execMode = detectExecMode({ projectRoot: rootDir });
  const generatedAt = new Date(nowMs).toISOString();
  const hasDataDir = existsSync(resolve(rootDir, "data"));

  const backupRoot = opts.backupRoot ?? resolve(rootDir, "data", "beehiiv-backup");
  const spendPath = opts.spendPath ?? resolve(rootDir, "data", "aquisicao", "spend.csv");
  const origemPath = opts.origemPath ?? resolve(rootDir, "data", "aquisicao", "origem-original.json");

  const spendLayer = loadSpendLayer(spendPath);

  const dates = listSnapshotDates(backupRoot);
  const snapshotDate = latestSnapshotDate(backupRoot);
  const idx = snapshotDate ? dates.indexOf(snapshotDate) : -1;
  const previousDate = idx > 0 ? dates[idx - 1] : null;

  const snapshotLayer: AdsSnapshotLayer = {
    root: backupRoot,
    date: snapshotDate,
    previousDate,
    error: snapshotDate ? null : `nenhum snapshot encontrado em ${backupRoot}`,
  };

  const { index: origemIndex, applied: origemApplied } = loadOrigemIndex(origemPath);
  const origemLayer: AdsOrigemLayer = { applied: origemApplied, path: origemPath };

  let report: CacReport | null = null;
  let budget: MonthBudgetUsage | null = null;
  let monthKey: string | null = null;

  if (spendLayer.error == null && spendLayer.rows.length > 0 && snapshotDate) {
    const { subs, internalFiltered } = loadPreparedSubscribers(backupRoot, snapshotDate, origemIndex);
    const previousSubs = previousDate ? loadPreparedSubscribers(backupRoot, previousDate, origemIndex).subs : undefined;
    report = buildCacReport(spendLayer.rows, subs, { previousSubs, originApplied: origemApplied, internalFiltered });
    monthKey = snapshotDate.slice(0, 7);
    budget = computeMonthBudgetUsage(spendLayer.rows, monthKey, MONTHLY_BUDGET_FLOOR_BRL);
  }

  const data: AdsSnapshot = {
    execMode,
    generatedAt,
    cached: false,
    hasDataDir,
    spend: spendLayer,
    snapshot: snapshotLayer,
    origem: origemLayer,
    report,
    budget,
    monthKey,
  };
  cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  return data;
}
