/**
 * studio-metrics.ts (#7178, fatia 6 do epic #7172)
 *
 * Camada de LEITURA pra `GET /api/metrics` — a superfície que dá leitor às
 * fatias F3-F5 (`scripts/lib/metrics/registry.ts`/`metas.ts`/`metas-store.ts`):
 * hoje o acompanhamento de baseline/queda/metas/decomposição é leitura manual
 * de script em terminal, e é exatamente esse modo que o épico existe pra
 * acabar. Mesmo padrão de `studio-ads.ts`/`studio-utms.ts` — `server.ts` só
 * roteia, este arquivo monta o snapshot.
 *
 * **Zero fórmula, zero taxonomia, zero I/O de série gravada.** Este módulo
 * NUNCA recalcula métrica (isso é F3/F4, `MetricDef.computar`), NUNCA decide
 * classe de aquisição (F1) e NUNCA lê `data/metrics/captura-log.jsonl`/
 * `data/metas.json` fora dos helpers já existentes (`loadMetas`,
 * `hasCaptureOnDay` via `aggregateAcquisition` dentro de `registry.ts`). O
 * que este arquivo FAZ é montar os `deps` que `MetricDef.computar` exige
 * (`registros`, `capturaLog`, `subscriptionCoverageLow`, snapshot Beehiiv,
 * leitura viva do Kit) a partir de `data/`, e devolver o `MetricResult`/
 * `MetaStatus` já prontos pra tela — decisão 12 do épico ("rota viva mais
 * série gravada: quem funde as duas é o `computar()` do `MetricDef`").
 *
 * **Fail-soft por camada** (mesmo padrão de `studio-ads.ts`/
 * `studio-utms.ts`): `data/` ausente (sessão cloud, clone fresco) nunca
 * lança — cada camada (captura-log, store `diaria-subscribers`, snapshot
 * Beehiiv, `data/metas.json`) tem seu próprio estado de erro, e a tela
 * degrada por camada, nunca em bloco.
 *
 * **`kitActive` de `base-ativa` — deixou de ser um `null` fixo (#7916, fatia
 * 1/N).** Antes desta fatia a leitura VIVA do Kit (`listAllKitSubscribers`,
 * decisão 12 do épico) não estava implementada e `kitActive` era sempre
 * `null`. Agora `loadKitActiveLayer` conta `subscription` com
 * `platform='kit' AND status='active'` no MESMO store `diaria-subscribers`
 * que `queryKitRegistros` já lê (nenhuma chamada de rede nova, nenhuma leitura
 * direta da API do Kit) e expõe o frescor (`MAX(updated_at)` das linhas
 * contadas — proxy de "quando a última ingestão rodou", ver docstring de
 * `KitActiveSummary`) e o motivo quando indisponível — nunca um número cego.
 * **`baseAtivaAnterior` deixou de depender só do dia atual (#7916, fatia
 * 3/N).** Antes desta fatia `baseAtivaAnterior` (comparação com o dia
 * anterior, zona "Queda") sempre saía com `kitActive: null` — o store só
 * guardava o estado ATUAL do Kit, e reusar a contagem de HOJE como se fosse
 * "ontem" inflaria/desinflaria a variação calculada em silêncio. Agora
 * `loadKitActiveCountForDay` lê `data/metrics/kit-active-history.jsonl`
 * (série gravada por `diaria-subscribers-ingest-kit.ts` a cada execução
 * `--write`, ver `scripts/lib/metrics/kit-active-history.ts`) — continua
 * `null` explícito quando não há história gravada pro dia pedido (arquivo
 * ainda não existe, ou o dia é anterior à 1ª execução com `--write` desta
 * fatia), nunca um `0` fabricado.
 *
 * **`registros()` do Kit lê o store `diaria-subscribers` (#6464) — `utm_source`
 * corrigido no #7916 (fatia 1/N).** Antes desta fatia o SELECT de
 * `queryKitRegistros` nem lia a coluna `subscription.utm_source` e o valor
 * saía sempre `null`, mesmo quando `ingestKitRoster` já gravava
 * `fields.utm_source` ali desde #7207 — bug de LEITURA, não de ingestão. Ver
 * a docstring de `queryKitRegistros` para o detalhe; `classifyAcquisition`
 * agora enxerga o `utm_source` real quando ele existe, e continua caindo em
 * `referring_site` (`resolveGroupKey`) quando a Kit genuinamente não tem o
 * campo preenchido — nunca inventa `"organico"` como default. A mesma nota
 * do docstring de `registry.ts` ("subscription está POPULADA NO CÓDIGO mas o
 * store real ainda não foi reingerido") segue valendo pra cobertura baixa em
 * geral — a métrica sai `indeterminado` por `subscriptionCoverageLow`, o
 * caminho honesto.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { detectExecMode, type ExecMode } from "../lib/exec-mode.ts";
import {
  METRICAS,
  getMetric,
  enumerarDiasInclusive,
  type MetricDef,
  type MetricResult,
  type Janela,
  type AcquisitionMetricDeps,
  type AcquisitionRecordInput,
  type BaseAtivaDeps,
  type LeitorV1Deps,
  type ReceitaMensalDeps,
  type ArpuAtivoDeps,
  type ChurnMensalDeps,
  type ConversaoApoiadorDeps,
  type LtvCaixaDeps,
  type LtvPorOrigemDeps,
  type LtvPorOrigemClasseInput,
  type LtvCacRatioDeps,
} from "../lib/metrics/registry.ts";
import { classifyAcquisition, type AcquisitionClass } from "../lib/metrics/acquisition-class.ts";
import { normalizeEmail } from "../lib/cac.ts";
import { readMonthCacheDetailed } from "../lib/apoia-se.ts";
import { loadAmazonRevenueConfig } from "../lib/amazon-revenue-config.ts";
import { loadManualCleanupEmails, manualCleanupEmailsPath } from "../lib/manual-cleanup-emails.ts";
import {
  computeChurnRate,
  computeConversaoApoiador,
  computeCustoPorAtivo,
  summarizeApoiaSeMonthRevenue,
  previousCompetenceMonth,
  findChurnBaselineDate,
  computeChurnExitsBetweenSnapshots,
  excludeInternalAndTestSubscribers,
  resolveApoiaSeCampaignName,
  type ChurnExitEvent,
  type ApoiaSeMonthCacheEntry,
} from "../lib/ltv.ts";
import { buildAdsData } from "./studio-ads.ts";
import { evaluateMeta, type Meta, type MetaStatus, type MedicaoDia } from "../lib/metrics/metas.ts";
import { loadMetas, validateMetas } from "../lib/metrics/metas-store.ts";
import type { CapturaLogEntry } from "../lib/metrics/captura-log.ts";
import { parseKitActiveHistoryLines, findKitActiveCountForDay } from "../lib/metrics/kit-active-history.ts";
import {
  openDiariaSubscribersDbSafe,
  getStoreCounts,
  getKitActiveSummary,
  getCrossPlatformActiveSummary,
} from "../lib/diaria-subscribers-db.ts";
import {
  latestSnapshotDate,
  listSnapshotDates,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "../lib/beehiiv-backup-snapshots.ts";

// Re-exportadas (#8423) — o núcleo mora em `scripts/lib/ltv.ts` (compartilhado
// com `scripts/cac-report.ts`, que também monta um LTV de caixa); este
// módulo reexporta pra quem testa/consome a camada "Valor" via `studio-
// metrics.ts` sem precisar saber que a implementação é compartilhada.
export { previousCompetenceMonth, findChurnBaselineDate, computeChurnExitsBetweenSnapshots };

// ─── tipos do snapshot ──────────────────────────────────────────────────

export interface MetricDefSummary {
  id: string;
  nome: string;
  produto: string;
  etapa: string;
  definicao: string;
  unidade: string;
  direcao: string;
  fonte: string;
  decomposicoes: readonly string[];
}

export interface MetricsCapturaLogLayer {
  path: string;
  entries: CapturaLogEntry[];
  error: string | null;
}

export interface MetricsSubscriptionCoverageLayer {
  dbPath: string;
  available: boolean;
  low: boolean;
  motivo: string | null;
}

export interface MetricsBeehiivSnapshotLayer {
  root: string;
  date: string | null;
  previousDate: string | null;
  error: string | null;
}

export interface MetricBaselineItem {
  metric: MetricDefSummary;
  result: MetricResult;
}

export interface MetricsMetaItem {
  meta: Meta;
  status: MetaStatus | null;
  /** Não-nulo quando a AVALIAÇÃO desta meta específica falhou (ex:
   *  `metrica_id` órfã escapou de `validateMetas` por algum motivo) — nunca
   *  derruba as outras metas do array. */
  erro: string | null;
}

export interface MetricsMetasLayer {
  path: string;
  /** Motivo de fail-soft de `loadMetas` (arquivo/`data/` ausente) — nunca
   *  erro de parse, que é `validationError` abaixo. */
  motivo: string | null;
  /** Não-nulo quando `validateMetas` lançou (id duplicado, `metrica_id`
   *  órfã) — `items` fica `[]` nesse caso: metas malformadas não têm
   *  avaliação parcial confiável. */
  validationError: string | null;
  items: MetricsMetaItem[];
}

export interface MetricsPlacar {
  naoPagoNaoReativacao: MetricResult;
  organicoEstrito: MetricResult;
  indeterminados: MetricResult;
  janela: Janela;
  janelaDias: number;
}

/**
 * Contribuição do Kit pra `base-ativa` (#7916, fatia 1/N) — exposta À PARTE
 * do `MetricResult` fundido (`queda.baseAtiva`) porque o resultado fundido
 * só carrega 1 `frescor` (o mais restritivo, ver `computeBaseAtiva`), e
 * "informar frescor e eventuais falhas de coleta" da contribuição do Kit
 * (critério de aceite da issue) exige poder inspecionar o lado Kit sozinho,
 * sem decompor o resultado fundido.
 */
export interface MetricsKitActiveLayer {
  /** `false` quando o store `diaria-subscribers` está ausente/ilegível —
   *  mesma causa raiz de `MetricsSubscriptionCoverageLayer.available`. */
  available: boolean;
  /** `null` quando `available === false`; nunca `0` fingindo "Kit sem
   *  assinante ativo" no lugar de "não deu pra medir". */
  count: number | null;
  /** ISO 8601 do `MAX(updated_at)` das linhas contadas — ver docstring de
   *  `KitActiveSummary` (`diaria-subscribers-db.ts`). `null` quando
   *  `available === false` OU quando o store existe mas não tem nenhuma
   *  linha Kit ativa ainda. */
  asOf: string | null;
  /** Não-nulo explica por que `count`/`asOf` são `null`, ou por que `asOf`
   *  ficou `null` com `count === 0`. */
  motivo: string | null;
}

/**
 * Bloco "Valor" (#8423) — receita, ARPU, churn, conversão em apoiador, LTV
 * (blended e por origem) e LTV÷CAC. Cálculo puro em `scripts/lib/ltv.ts`;
 * aqui só a resolução dos insumos a partir de `data/` (cache da apoia.se,
 * diff de 2 snapshots Beehiiv, config manual da Amazon, `CacReport` de
 * `studio-ads.ts`).
 *
 * **Limitações declaradas, não escondidas** (mesma disciplina do resto do
 * módulo):
 * - Numerador/denominador de `conversaoApoiador`/`ltvPorOrigem` usam só a
 *   base ATIVA BEEHIIV (não a cross-plataforma deduplicada) — é a única
 *   população em que o vínculo por e-mail com a apoia.se é resolvido aqui.
 * - `ltvCacRatio` usa o LTV BLENDED (ponto médio da faixa), o mesmo pra
 *   todo canal — ainda não há LTV medido POR CANAL (isso dependeria de
 *   #7916 entregar receita por coorte no store unificado); `ltvPorOrigem`
 *   é o número mais fino disponível hoje, por CLASSE de aquisição, não por
 *   canal individual.
 */
export interface MetricsValorLayer {
  receitaMensal: MetricResult;
  arpuAtivo: MetricResult;
  churnMensal: MetricResult;
  conversaoApoiador: MetricResult;
  ltvCaixa: MetricResult;
  ltvPorOrigem: MetricResult;
  ltvCacRatio: MetricResult;
  /** Config manual da receita Amazon (`data/ltv/amazon-revenue.json`, sem
   *  fonte automatizada — decisão da issue #8423) — `valorMensalBrl: null`
   *  quando o arquivo está ausente/malformado, nunca `0` fabricado. */
  amazonConfig: { valorMensalBrl: number | null; atualizadoEm: string | null; motivo: string | null };
  /** Cache da apoia.se usado (mês de competência FECHADO anterior ao
   *  corrente — o mês corrente pode estar incompleto/congelado, #4490).
   *  `available` exige existir E ter parseado com sucesso — `corrupted:
   *  true` é o caso "existe mas não parseou" (#8423 fleet review item 1),
   *  distinto de "nunca escrito" (`corrupted: false`, `available: false`).
   *  `paidWithoutValueCount` > 0 sinaliza entradas `isPaidThisMonth: true`
   *  sem valor numérico (item 5) — excluídas da receita/n de pagantes. */
  apoiaSeCache: { path: string; available: boolean; competenceMonth: string; corrupted: boolean; paidWithoutValueCount: number };
  /** Arquivo de limpeza manual conhecida (`descadastrados-manuais-2607.json`)
   *  — `error` não-nulo quando o arquivo existe mas falhou ler/parsear
   *  (#8423 fleet review item 3); nesse caso `churnMensal`/`ltvCaixa` saem
   *  `indeterminado` em vez de colapsar orgânico×com-limpeza em silêncio.
   *  `skipped` > 0 sinaliza linhas do arquivo puladas pelo parser. */
  manualCleanup: { path: string; emailCount: number; error: string | null; skipped: number };
  /** Par de snapshots Beehiiv usado pro diff de churn — `baselineDate` é
   *  `null` quando não há snapshot suficientemente espaçado (~30 dias) do
   *  mais recente, e `churnMensal` sai `indeterminado` nesse caso. */
  churnPeriodo: { baselineDate: string | null; latestDate: string | null; periodMonths: number | null };
}

export interface MetricsSnapshot {
  execMode: ExecMode;
  generatedAt: string;
  cached: boolean;
  hasDataDir: boolean;
  capturaLog: MetricsCapturaLogLayer;
  subscriptionCoverage: MetricsSubscriptionCoverageLayer;
  beehiivSnapshot: MetricsBeehiivSnapshotLayer;
  /** Dia BRT usado como "hoje" pra baseline/decomposição — o mais recente
   *  dia com captura registrada, ou o dia corrente (`now()` - 3h) quando
   *  não há nenhuma captura ainda. */
  diaReferencia: string;
  baseline: MetricBaselineItem[];
  queda: {
    baseAtiva: MetricResult;
    baseAtivaAnterior: MetricResult | null;
    /** Frescor/motivo da contribuição Kit isolada — ver `MetricsKitActiveLayer`. */
    kitActiveLayer: MetricsKitActiveLayer;
    /** Frescor/motivo da contagem DEDUPLICADA cross-plataforma isolada
     *  (#7916, fatia 4/N) — mesmo shape de `MetricsKitActiveLayer`, mas
     *  `count` aqui já é `COUNT(DISTINCT subscriber_id)` ativo em qualquer
     *  plataforma coberta, não só Kit. `baseAtiva.valor` usa este `count`
     *  quando `available === true` (ver `computeBaseAtiva`). */
    crossPlatformActiveLayer: MetricsKitActiveLayer;
  };
  metas: MetricsMetasLayer;
  placar: MetricsPlacar;
  decomposicaoCadastros: MetricResult;
  valor: MetricsValorLayer;
}

// ─── janela / BRT ───────────────────────────────────────────────────────

function brtDateFromMs(ms: number): string {
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10);
}

function janelaDia(dia: string): Janela {
  return { de: dia, ate: dia, granularidade: "dia", fuso: "BRT" };
}

function janelaJanela(de: string, ate: string): Janela {
  return { de, ate, granularidade: "dia", fuso: "BRT" };
}

function addDaysToYmd(ymd: string, delta: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

// ─── camada: captura-log.jsonl (F2) ────────────────────────────────────

/** Mesmo caminho default de `DEFAULT_CAPTURA_LOG_PATH`
 *  (`diaria-subscribers-ingest-kit.ts`) — recalculado aqui a partir de
 *  `rootDir` (testável sem depender do módulo default global). */
function defaultCapturaLogPath(rootDir: string): string {
  return resolve(rootDir, "data", "metrics", "captura-log.jsonl");
}

// ─── camada: kit-active-history.jsonl (#7916, fatia 3/N) ───────────────

/** Mesmo caminho default de `DEFAULT_KIT_ACTIVE_HISTORY_PATH`
 *  (`diaria-subscribers-ingest-kit.ts`) — recalculado aqui pela mesma razão
 *  de `defaultCapturaLogPath` acima (testável sem depender do módulo
 *  default global). */
function defaultKitActiveHistoryPath(rootDir: string): string {
  return resolve(rootDir, "data", "metrics", "kit-active-history.jsonl");
}

/**
 * Contagem do Kit ativo pra `dia` (BRT) a partir da série histórica —
 * `null` (nunca lança) quando o arquivo está ausente, ilegível, ou não tem
 * nenhuma entry pra `dia` (fail-soft, mesmo padrão de `loadCapturaLog`).
 * Reusado tanto pro dia de referência (baseline) quanto pro dia anterior
 * (zona "Queda") — mesma fonte, dias diferentes.
 */
function loadKitActiveCountForDay(rootDir: string, dia: string): number | null {
  const path = defaultKitActiveHistoryPath(rootDir);
  if (!existsSync(path)) return null;
  try {
    const entries = parseKitActiveHistoryLines(readFileSync(path, "utf8"));
    return findKitActiveCountForDay(entries, dia);
  } catch {
    return null; // fail-soft — arquivo corrompido/ilegível não derruba o snapshot
  }
}

function loadCapturaLog(path: string): MetricsCapturaLogLayer {
  if (!existsSync(path)) {
    return { path, entries: [], error: `captura-log ausente em ${path} (fail-soft — nenhuma coleta registrada ainda)` };
  }
  try {
    const raw = readFileSync(path, "utf8");
    const entries: CapturaLogEntry[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as CapturaLogEntry);
      } catch {
        continue; // linha corrompida — ignora, mesmo padrão de parseSubscribersJsonl
      }
    }
    return { path, entries, error: null };
  } catch (e) {
    return { path, entries: [], error: (e as Error).message };
  }
}

// ─── camada: store diaria-subscribers (cobertura + registros do Kit) ──

function loadSubscriptionCoverage(
  dbPath: string,
): { layer: MetricsSubscriptionCoverageLayer; db: DatabaseSync | null } {
  const db = openDiariaSubscribersDbSafe(dbPath);
  if (!db) {
    return {
      layer: {
        dbPath,
        available: false,
        low: true,
        motivo: `store diaria-subscribers ausente ou ilegível em ${dbPath} — cadastros tratados como indeterminado`,
      },
      db: null,
    };
  }
  const counts = getStoreCounts(db);
  return {
    layer: {
      dbPath,
      available: true,
      low: counts.subscriptions_coverage_low,
      motivo: counts.subscriptions_coverage_low
        ? `cobertura de subscription baixa (${counts.subscriptions} linha(s) / ${counts.subscribers} subscriber(s))`
        : null,
    },
    db,
  };
}

/**
 * Monta a camada de contribuição Kit pra `base-ativa` (#7916, fatia 1/N) —
 * `db === null` (store ausente/ilegível, mesma causa de
 * `MetricsSubscriptionCoverageLayer.available === false`) é o único jeito de
 * `available` sair `false`; qualquer erro de leitura na query em si também
 * cai aqui via `try/catch` (fail-soft, mesmo padrão do resto do módulo —
 * nunca deixa uma exceção de SQL derrubar o snapshot inteiro).
 */
function loadKitActiveLayer(db: DatabaseSync | null): MetricsKitActiveLayer {
  if (!db) {
    return {
      available: false,
      count: null,
      asOf: null,
      motivo: "store diaria-subscribers ausente ou ilegível — contribuição do Kit tratada como indeterminada",
    };
  }
  try {
    const summary = getKitActiveSummary(db);
    return {
      available: true,
      count: summary.count,
      asOf: summary.asOf,
      motivo:
        summary.count === 0
          ? "nenhuma subscription Kit com status='active' encontrada no store ainda"
          : null,
    };
  } catch (e) {
    return { available: false, count: null, asOf: null, motivo: (e as Error).message };
  }
}

/**
 * Monta a camada de contribuição DEDUPLICADA cross-plataforma pra
 * `base-ativa` (#7916, fatia 4/N) — mesmo `db` já aberto acima, nenhuma
 * abertura extra do store. Sempre preferida sobre `loadKitActiveLayer` pelo
 * `computeBaseAtiva` abaixo quando `available === true`: `getCrossPlatformActiveSummary`
 * já conta 1 vez qualquer assinante ativo em 2+ plataformas (ver docstring
 * de `CrossPlatformActiveSummary` em `diaria-subscribers-db.ts`), ao
 * contrário da soma ingênua `beehiiv.active + kitActive` que dobra esse
 * caso. Mesmo padrão fail-soft de `loadKitActiveLayer` — `db === null` ou
 * qualquer erro de leitura degrada pra `available: false`, nunca lança.
 */
function loadCrossPlatformActiveLayer(db: DatabaseSync | null): MetricsKitActiveLayer {
  if (!db) {
    return {
      available: false,
      count: null,
      asOf: null,
      motivo: "store diaria-subscribers ausente ou ilegível — contagem deduplicada cross-plataforma indisponível",
    };
  }
  try {
    const summary = getCrossPlatformActiveSummary(db);
    return {
      available: true,
      count: summary.count,
      asOf: summary.asOf,
      motivo:
        summary.count === 0
          ? "nenhuma subscription com status='active' encontrada no store ainda (nenhuma plataforma)"
          : null,
    };
  } catch (e) {
    return { available: false, count: null, asOf: null, motivo: (e as Error).message };
  }
}

interface KitSubscriptionRow {
  email: string | null;
  external_id: string | null;
  entered_at: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_channel: string | null;
  referring_site: string | null;
}

/**
 * Lê os cadastros do Kit dentro de `janela` a partir do store unificado
 * (`diaria-subscribers-db.ts`).
 *
 * **`utm_source` (#7916, fatia 1/N — corrigido; ANTES saía sempre `null`).**
 * A coluna `subscription.utm_source` existe desde #7207 e `ingestKitRoster`
 * (`kit-subscribers-ingest.ts`) já grava `fields.utm_source` nela a cada
 * rodada de ingestão — o bug real não era ausência de dado na ingestão, era
 * este SELECT nunca ter incluído a coluna e a linha abaixo forçar `null`
 * incondicionalmente, mascarando o valor real quando ele existia. Corrigido
 * para propagar o valor da coluna; continua saindo `null` explícito (nunca
 * `"organico"`/outro default inventado) quando a Kit genuinamente não tem o
 * custom field preenchido pra aquele assinante, ou pra linhas ingeridas
 * antes do #7207 existir. `email` cai pra um identificador sintético quando
 * o alias não tem e-mail populado, nunca descarta a linha silenciosamente.
 */
function queryKitRegistros(db: DatabaseSync, janela: Janela): AcquisitionRecordInput[] {
  const dias = new Set(enumerarDiasInclusive(janela.de, janela.ate));
  const rows = db
    .prepare(
      `SELECT ia.email AS email, ia.external_id AS external_id, s.entered_at AS entered_at,
              s.utm_source AS utm_source, s.utm_medium AS utm_medium, s.utm_channel AS utm_channel,
              s.referring_site AS referring_site
       FROM subscription s
       LEFT JOIN identity_alias ia ON ia.subscriber_id = s.subscriber_id AND ia.platform = s.platform
       WHERE s.platform = 'kit' AND s.entered_at IS NOT NULL`,
    )
    .all() as unknown as KitSubscriptionRow[];
  const out: AcquisitionRecordInput[] = [];
  for (const r of rows) {
    if (!r.entered_at) continue;
    const createdMs = Date.parse(r.entered_at);
    if (Number.isNaN(createdMs)) continue;
    const dia = brtDateFromMs(createdMs);
    if (!dias.has(dia)) continue;
    out.push({
      email: r.email ?? `kit-id:${r.external_id ?? "desconhecido"}`,
      dia,
      utm_source: r.utm_source ?? null,
      utm_medium: r.utm_medium ?? null,
      utm_channel: r.utm_channel ?? null,
      referring_site: r.referring_site ?? null,
      created: Math.floor(createdMs / 1000),
    });
  }
  return out;
}

function buildAcquisitionDeps(
  db: DatabaseSync | null,
  capturaLog: readonly CapturaLogEntry[],
  coverageLow: boolean,
  coverageMotivo: string | null,
): AcquisitionMetricDeps {
  return {
    registros: (janela) => (db ? queryKitRegistros(db, janela) : []),
    capturaLog,
    subscriptionCoverageLow: coverageLow,
    subscriptionCoverageMotivo: coverageMotivo ?? undefined,
  };
}

// ─── camada: snapshot Beehiiv ───────────────────────────────────────────

function loadBeehiivSnapshotLayer(root: string): {
  layer: MetricsBeehiivSnapshotLayer;
  subscribers: BeehiivBackupSubscriber[];
} {
  const dates = listSnapshotDates(root);
  const date = latestSnapshotDate(root);
  const idx = date ? dates.indexOf(date) : -1;
  const previousDate = idx > 0 ? dates[idx - 1] : null;
  if (!date) {
    return {
      layer: { root, date: null, previousDate: null, error: `nenhum snapshot Beehiiv encontrado em ${root}` },
      subscribers: [],
    };
  }
  const subscribers = readSnapshotSubscribers(root, date);
  return {
    layer: {
      root,
      date,
      previousDate,
      error: subscribers.length === 0 ? `subscribers.jsonl ausente/vazio para ${date}` : null,
    },
    subscribers,
  };
}

function countActive(subs: readonly BeehiivBackupSubscriber[]): number {
  return subs.filter((s) => s.status === "active").length;
}

// ─── camada: Valor (#8423) — receita, ARPU, churn, conversão em apoiador, ──
// ─── LTV blended/por origem, LTV÷CAC ────────────────────────────────────

/**
 * Monta o bloco "Valor" (#8423) inteiro — nunca lança POR INSUMO AUSENTE OU
 * CORROMPIDO (mesma disciplina do resto do módulo): qualquer insumo
 * ausente/corrompido vira `MetricResult` `indeterminado` com motivo, não uma
 * exceção que derruba o snapshot inteiro. (Não é uma garantia de "nunca
 * lança" absoluta — um bug de programação ainda pode lançar; o contrato é
 * especificamente sobre dado externo malformado/ausente.)
 */
async function computeValorLayer(
  rootDir: string,
  beehiivSubsRaw: readonly BeehiivBackupSubscriber[],
  beehiivRoot: string,
  beehiivDates: readonly string[],
  latestDate: string | null,
  now: Date,
): Promise<MetricsValorLayer> {
  // Contas internas/teste fora da população inteira do bloco Valor (#9074):
  // denominador do ARPU, os DOIS lados do diff de churn (baseline filtrado
  // abaixo) e os confirmados de conversão/LTV por origem — mesma população
  // em tudo que compõe o LTV (#9023).
  const beehiivSubs = excludeInternalAndTestSubscribers(beehiivSubsRaw).kept;
  const campaign = resolveApoiaSeCampaignName();
  const month = previousCompetenceMonth(now);
  const cacheDir = resolve(rootDir, "data", "apoia-se", campaign);
  const cachePath = resolve(cacheDir, `${month}.json`);
  // `available` exige EXISTIR e ter sido parseado com sucesso — um cache
  // corrompido (JSON inválido) nunca é tratado como "disponível com R$0"
  // (#8423 fleet review item 1: `existsSync` sozinho não via distinção, e
  // `porFonte["apoia-se"]` saía com 0 fabricado quando o parse falhava).
  const { cache: apoiaSeCache, corrupted: apoiaSeCacheCorrupted } = readMonthCacheDetailed(cacheDir, month) as {
    cache: Record<string, ApoiaSeMonthCacheEntry>;
    corrupted: boolean;
  };
  const apoiaSeCacheExists = existsSync(cachePath);
  const apoiaSeCacheAvailable = apoiaSeCacheExists && !apoiaSeCacheCorrupted;
  if (apoiaSeCacheCorrupted) {
    console.error(
      `[studio-metrics] valor: cache apoia.se corrompido em ${cachePath} — tratado como indisponível, nunca R$0 fabricado`,
    );
  }
  const revSummary = summarizeApoiaSeMonthRevenue(apoiaSeCache); // apoiaSeCache é {} quando ausente/corrompido
  const amazonConfig = loadAmazonRevenueConfig(rootDir);

  const janelaMes = janelaDia(`${month}-01`);
  const porFonte: Record<string, number | null> = {
    "apoia-se": apoiaSeCacheAvailable ? revSummary.grossRevenueBrl : null,
    amazon: amazonConfig.valorMensalBrl,
  };

  // População: só a base ATIVA BEEHIIV — é a única em que o vínculo por
  // e-mail com a apoia.se é resolvido aqui (ver docstring de
  // `MetricsValorLayer`). Base vazia (nenhum snapshot ainda) fica `null`,
  // nunca `0` fabricado.
  const activeBeehiiv = beehiivSubs.filter((s) => s.status === "active");
  const baseAtivaBeehiiv = activeBeehiiv.length > 0 ? activeBeehiiv.length : null;
  // Snapshot Beehiiv vazio/anômalo (nenhum subscriber lido) — churn/ARPU/LTV
  // não rodam em cima dele (#8423 fleet review item 6): mesma condição que
  // `loadBeehiivSnapshotLayer` usa pra marcar `error` na camada de snapshot.
  // Filtrado vazio (snapshot só com internos/teste) também é anômalo — senão
  // todo ativo do baseline viraria "saída" (paridade com cac-report.ts).
  const beehiivSnapshotEmpty = beehiivSubs.length === 0;

  const receitaMensal = await getMetric("receita-mensal")!.computar({
    janela: janelaMes,
    deps: { porFonte } satisfies ReceitaMensalDeps,
  });
  const arpuAtivo = await getMetric("arpu-ativo")!.computar({
    janela: janelaMes,
    deps: { porFonte, baseAtiva: baseAtivaBeehiiv } satisfies ArpuAtivoDeps,
  });

  // ── Churn — diff de 2 snapshots Beehiiv ~30 dias de distância ──────────
  const manualCleanupResult = loadManualCleanupEmails(rootDir);
  const baselineDate = !beehiivSnapshotEmpty && latestDate ? findChurnBaselineDate(beehiivDates, latestDate) : null;
  let churnMensalDeps: ChurnMensalDeps;
  let churnPeriodo: MetricsValorLayer["churnPeriodo"] = { baselineDate, latestDate, periodMonths: null };
  if (beehiivSnapshotEmpty || !latestDate || !baselineDate) {
    churnMensalDeps = { exits: [], manualCleanupEmails: new Set(), periodMonths: 0, avgActiveBase: null };
  } else {
    const baselineSubs = baselineDate === latestDate ? beehiivSubs : excludeInternalAndTestSubscribers(readSnapshotSubscribers(beehiivRoot, baselineDate)).kept;
    const latestSubs = beehiivSubs; // já carregado pelo chamador (snapshot mais recente)
    const { exits, avgActiveBase } = computeChurnExitsBetweenSnapshots(baselineSubs, latestSubs);
    const periodMonths = Math.abs(Date.parse(latestDate) - Date.parse(baselineDate)) / 86_400_000 / 30;
    churnPeriodo = { baselineDate, latestDate, periodMonths };
    churnMensalDeps = { exits, manualCleanupEmails: manualCleanupResult.emails, periodMonths, avgActiveBase };
  }

  // Conjunto de limpeza manual indisponível/corrompido (arquivo existe mas
  // não parseou) — não dá pra separar orgânico de com-limpeza com segurança;
  // nunca deixa as duas leituras colapsarem em silêncio pro mesmo número
  // (#8423 fleet review item 3). Só se aplica quando de fato há um diff de
  // churn rodando (baseline+latest presentes) — sem diff, já é indeterminado
  // pelo motivo de sempre.
  const manualCleanupUnavailableMotivo =
    manualCleanupResult.error && baselineDate && latestDate && !beehiivSnapshotEmpty
      ? `conjunto de limpeza manual indisponível/corrompido (${manualCleanupEmailsPath(rootDir)}: ${manualCleanupResult.error}) — churn orgânico×com-limpeza não pode ser diferenciado com segurança`
      : beehiivSnapshotEmpty
        ? "snapshot Beehiiv vazio/anômalo — churn não computável"
        : null;

  let churnMensal: MetricResult;
  let churnRaw: ReturnType<typeof computeChurnRate> | null = null;
  if (manualCleanupUnavailableMotivo) {
    churnMensal = { valor: null, janela: janelaMes, frescor: null, qualidade: "indeterminado", motivo: manualCleanupUnavailableMotivo };
  } else {
    churnMensal = await getMetric("churn-mensal")!.computar({ janela: janelaMes, deps: churnMensalDeps });
    // Reaproveita o MESMO cálculo puro (não recomputado a partir do
    // MetricResult, que já perdeu a granularidade organico/comLimpeza fora
    // da decomposicao) pra alimentar ltv-caixa abaixo.
    churnRaw = computeChurnRate(churnMensalDeps);
  }

  const ltvCaixa = churnRaw
    ? await getMetric("ltv-caixa")!.computar({
        janela: janelaMes,
        deps: {
          arpuMensal: arpuAtivo.valor,
          churnMensalOrganico: churnRaw.monthly?.organico ?? null,
          churnMensalComLimpeza: churnRaw.monthly?.comLimpeza ?? null,
        } satisfies LtvCaixaDeps,
      })
    : { valor: null, janela: janelaMes, frescor: null, qualidade: "indeterminado" as const, motivo: manualCleanupUnavailableMotivo ?? "churn indisponível" };

  // ── Conversão em apoiador + LTV por origem — vínculo por e-mail ────────
  // Sem cache apoia.se disponível/válido, NÃO dá pra saber quem é apoiador —
  // rodar a agregação sobre um cache vazio fabricaria `apoiadores=0` como se
  // fosse "0% converteu" (um número real, não indeterminado). #8423 fleet
  // review item 2: as duas métricas saem indeterminadas direto, sem
  // percorrer `activeBeehiiv`.
  const apoiaSeUnavailableMotivo = !apoiaSeCacheAvailable ? `cache da apoia.se indisponível/corrompido para ${month}` : null;

  let conversaoApoiador: MetricResult;
  let ltvPorOrigem: MetricResult;
  if (apoiaSeUnavailableMotivo) {
    conversaoApoiador = { valor: null, janela: janelaMes, frescor: null, qualidade: "indeterminado", motivo: apoiaSeUnavailableMotivo };
    ltvPorOrigem = { valor: null, janela: janelaMes, frescor: null, qualidade: "indeterminado", motivo: apoiaSeUnavailableMotivo };
  } else {
    const apoiaSeIndex = new Map<string, ApoiaSeMonthCacheEntry>();
    for (const [email, entry] of Object.entries(apoiaSeCache)) apoiaSeIndex.set(normalizeEmail(email), entry);

    const amazonPerActive =
      amazonConfig.valorMensalBrl != null && baseAtivaBeehiiv ? amazonConfig.valorMensalBrl / baseAtivaBeehiiv : null;

    interface ClasseAgg {
      confirmados: number;
      apoiadores: number;
      payingCount: number;
      sumPaid: number;
    }
    const porClasseAgg = new Map<AcquisitionClass, ClasseAgg>();
    let totalApoiadoresOverall = 0;
    for (const s of activeBeehiiv) {
      const classe = classifyAcquisition({
        utm_source: s.utm_source,
        utm_medium: s.utm_medium,
        // `BeehiivBackupSubscriber.utm_channel` é `unknown` (nunca confirmado
        // ao vivo, ver docstring de `beehiiv-backup-snapshots.ts`) — mesma
        // disciplina tolerante do resto da interface, só passa adiante quando
        // já é string.
        utm_channel: typeof s.utm_channel === "string" ? s.utm_channel : null,
        referring_site: s.referring_site,
        created: s.created,
      });
      let agg = porClasseAgg.get(classe);
      if (!agg) {
        agg = { confirmados: 0, apoiadores: 0, payingCount: 0, sumPaid: 0 };
        porClasseAgg.set(classe, agg);
      }
      agg.confirmados++;
      const backer = apoiaSeIndex.get(normalizeEmail(s.email));
      if (backer?.isBacker) {
        agg.apoiadores++;
        totalApoiadoresOverall++;
        if (backer.isPaidThisMonth && typeof backer.thisMonthPaidValue === "number") {
          agg.payingCount++;
          agg.sumPaid += backer.thisMonthPaidValue;
        }
      }
    }

    conversaoApoiador = await getMetric("conversao-apoiador")!.computar({
      janela: janelaMes,
      deps: { apoiadores: totalApoiadoresOverall, confirmados: activeBeehiiv.length } satisfies ConversaoApoiadorDeps,
    });

    const porClasse: Partial<Record<AcquisitionClass, LtvPorOrigemClasseInput>> = {};
    for (const [classe, agg] of porClasseAgg) {
      const conv = computeConversaoApoiador({ apoiadores: agg.apoiadores, confirmados: agg.confirmados });
      porClasse[classe] = {
        conversaoApoiador: conv.valor,
        valorMedioApoiadorMensal: agg.payingCount > 0 ? agg.sumPaid / agg.payingCount : null,
        outrasFontesPerAtivoMensal: amazonPerActive,
        n: agg.apoiadores,
      };
    }
    ltvPorOrigem = await getMetric("ltv-por-origem")!.computar({
      janela: janelaMes,
      decomposicao: "classe",
      deps: { porClasse } satisfies LtvPorOrigemDeps,
    });
  }

  // ── LTV ÷ CAC — reusa o CacReport que studio-ads.ts já computa (nenhuma
  //    releitura de spend.csv/snapshot aqui). Simplificação DECLARADA: usa
  //    o LTV BLENDED (ponto médio da faixa), igual pra todo canal — ainda
  //    não há LTV medido POR CANAL (dependeria de #7916). `buildAdsData` já
  //    documenta "nunca lança" (fail-soft por conta própria), mas esta
  //    camada de Valor promete o mesmo contrato pro CALLER — o try/catch é
  //    defesa em profundidade, não desconfiança do contrato alheio.
  const custoPorCanal: Record<string, number | null> = {};
  try {
    const adsSnapshot = buildAdsData(rootDir);
    if (adsSnapshot.report) {
      for (const row of adsSnapshot.report.rows) {
        // Custo por ATIVO (gasto ÷ ativos), não `row.custoPorLeitor`: o LTV
        // é por ativo (ARPU = receita ÷ base ativa), então o denominador
        // precisa da mesma unidade (#9023).
        if (row.kind === "measured") custoPorCanal[row.canal] = computeCustoPorAtivo(row.spend.valor, row.ativos);
      }
    }
  } catch (e) {
    console.error(`[studio-metrics] valor: falha ao montar CacReport via buildAdsData (ignorada, LTV÷CAC sai indeterminado): ${(e as Error).message}`);
  }
  const ltvBlendedMidpoint =
    ltvCaixa.qualidade === "faixa" && ltvCaixa.limites ? (ltvCaixa.limites.min + ltvCaixa.limites.max) / 2 : ltvCaixa.valor;
  const ltvPorCanal: Record<string, number | null> = {};
  for (const canal of Object.keys(custoPorCanal)) ltvPorCanal[canal] = ltvBlendedMidpoint;
  const ltvCacRatio = await getMetric("ltv-cac-ratio")!.computar({
    janela: janelaMes,
    decomposicao: "canal",
    deps: { ltvPorCanal, custoPorCanal } satisfies LtvCacRatioDeps,
  });

  return {
    receitaMensal,
    arpuAtivo,
    churnMensal,
    conversaoApoiador,
    ltvCaixa,
    ltvPorOrigem,
    ltvCacRatio,
    amazonConfig,
    apoiaSeCache: {
      path: cachePath,
      available: apoiaSeCacheAvailable,
      competenceMonth: month,
      corrupted: apoiaSeCacheCorrupted,
      paidWithoutValueCount: revSummary.paidWithoutValueCount,
    },
    manualCleanup: {
      path: manualCleanupEmailsPath(rootDir),
      emailCount: manualCleanupResult.emails.size,
      error: manualCleanupResult.error,
      skipped: manualCleanupResult.skipped,
    },
    churnPeriodo,
  };
}

// ─── cache (mesmo padrão de studio-ads.ts/studio-utms.ts) ──────────────

export interface BuildMetricsDataOptions {
  now?: () => Date;
  cacheTtlMs?: number;
  forceRefresh?: boolean;
  /** Janela (em dias) usada pro placar da meta de ativação — default 35,
   *  espelhando a medição de referência do épico #7172 (25/07-28/08). */
  placarWindowDays?: number;
  /** Nº de dias trailing usado pra montar `medicoes` de cada meta — default
   *  14. Meta com `consecutivos` maior que este valor fica sujeita a essa
   *  janela (simplificação documentada no PR — estender sob demanda). */
  metaWindowDays?: number;
}

interface CacheEntry {
  data: MetricsSnapshot;
  expiresAt: number;
}

const cacheByRoot = new Map<string, CacheEntry>();

/** Limpa o cache — usado só por testes pra isolar casos entre si. */
export function clearMetricsCache(): void {
  cacheByRoot.clear();
}

function summarizeMetric(def: MetricDef): MetricDefSummary {
  return {
    id: def.id,
    nome: def.nome,
    produto: def.produto,
    etapa: def.etapa,
    definicao: def.definicao,
    unidade: def.unidade,
    direcao: def.direcao,
    fonte: def.fonte,
    decomposicoes: def.decomposicoes,
  };
}

const BASELINE_METRIC_IDS: readonly string[] = [
  "cadastros-dia",
  "doi-confirmacao-dia",
  "doi-orfaos",
  "base-ativa",
  "leitor-v1",
];

/**
 * Monta o snapshot completo pra `GET /api/metrics`. Nunca lança — qualquer
 * falha de insumo vira campo `error`/`motivo` da camada correspondente
 * (fail-soft, mesmo padrão de `buildAdsData`/`buildUtmsData`).
 *
 * **Assíncrona** (diferente de `buildAdsData`, que é síncrona): `MetricDef.
 * computar` (registry.ts) devolve `Promise<MetricResult>` — o contrato F3
 * reserva essa assinatura pra permitir I/O dentro de `computar` no futuro
 * (F7/backfill), mesmo as 8 métricas de F4 sendo puras hoje. Simular uma
 * leitura síncrona de uma Promise sem `await` real não é seguro em JS puro
 * (o `.then` sempre roda em microtask, mesmo sobre uma promise já
 * resolvida) — `await` de verdade é a única forma correta.
 */
export async function buildMetricsData(rootDir: string, opts: BuildMetricsDataOptions = {}): Promise<MetricsSnapshot> {
  const now = opts.now ?? (() => new Date());
  const nowMs = now().getTime();
  const cacheTtlMs = opts.cacheTtlMs ?? 10 * 60_000;
  const placarWindowDays = opts.placarWindowDays ?? 35;
  const metaWindowDays = opts.metaWindowDays ?? 14;

  if (!opts.forceRefresh) {
    const cached = cacheByRoot.get(rootDir);
    if (cached && cached.expiresAt > nowMs) {
      return { ...cached.data, cached: true };
    }
  }

  const execMode = detectExecMode({ projectRoot: rootDir });
  const generatedAt = new Date(nowMs).toISOString();
  const hasDataDir = existsSync(resolve(rootDir, "data"));

  const capturaLog = loadCapturaLog(defaultCapturaLogPath(rootDir));
  const dbPath = resolve(rootDir, "data", "diaria-subscribers", "diaria-subscribers.db");
  const { layer: coverageLayer, db } = loadSubscriptionCoverage(dbPath);

  const beehiivRoot = resolve(rootDir, "data", "beehiiv-backup");
  const { layer: beehiivLayer, subscribers: beehiivSubs } = loadBeehiivSnapshotLayer(beehiivRoot);

  const hojeFromNow = brtDateFromMs(nowMs);
  const diaReferencia =
    capturaLog.entries.length > 0
      ? capturaLog.entries.reduce((max, e) => (e.captured_at.slice(0, 10) > max ? e.captured_at.slice(0, 10) : max), "")
      : hojeFromNow;

  const acqDeps = buildAcquisitionDeps(db, capturaLog.entries, coverageLayer.low, coverageLayer.motivo);
  const janelaHoje = janelaDia(diaReferencia);

  // ── Contribuição Kit pra base-ativa (#7916, fatia 1/N) — MESMO db acima,
  //    nenhuma abertura extra do store. `baseAtivaAnterior` (dia anterior)
  //    NÃO recebe esta contagem — ver docstring do módulo, "sem série
  //    histórica do Kit ainda".
  const kitActiveLayer = loadKitActiveLayer(db);
  // ── Contagem DEDUPLICADA cross-plataforma pra base-ativa (#7916, fatia
  //    4/N) — MESMO db acima, nenhuma abertura extra. Mesma limitação de
  //    `kitActiveLayer` acima pra `baseAtivaAnterior`: sem série histórica
  //    DEDUPLICADA gravada ainda, `baseAtivaAnterior` continua sem receber
  //    esta contagem (ver `computeBaseAtiva`).
  const crossPlatformActiveLayer = loadCrossPlatformActiveLayer(db);

  // ── Baseline (zona 1) ──────────────────────────────────────────────
  const baseline: MetricBaselineItem[] = [];
  for (const id of BASELINE_METRIC_IDS) {
    const def = getMetric(id);
    if (!def) continue;
    const result = await computeBaseline(
      def,
      janelaHoje,
      acqDeps,
      beehiivSubs,
      beehiivLayer,
      hojeFromNow,
      kitActiveLayer.count,
      crossPlatformActiveLayer.count,
      crossPlatformActiveLayer.asOf,
    );
    baseline.push({ metric: summarizeMetric(def), result });
  }

  // ── Queda (zona 2) — base-ativa decomposta por plataforma ──────────
  const baseAtivaDef = getMetric("base-ativa")!;
  const baseAtiva = await computeBaseAtiva(
    baseAtivaDef,
    janelaDia(diaReferencia),
    beehiivSubs,
    beehiivLayer,
    hojeFromNow,
    kitActiveLayer.count,
    "plataforma",
    crossPlatformActiveLayer.count,
    crossPlatformActiveLayer.asOf,
  );
  let baseAtivaAnterior: MetricResult | null = null;
  if (beehiivLayer.previousDate) {
    const prevSubs = readSnapshotSubscribers(beehiivRoot, beehiivLayer.previousDate);
    baseAtivaAnterior = await computeBaseAtiva(
      baseAtivaDef,
      janelaDia(beehiivLayer.previousDate),
      prevSubs,
      { ...beehiivLayer, date: beehiivLayer.previousDate },
      hojeFromNow,
      // #7916 (fatia 3/N): lê a série histórica gravada por
      // `diaria-subscribers-ingest-kit.ts` (`kit-active-history.jsonl`) pro
      // dia de `beehiivLayer.previousDate` — antes desta fatia, reusar a
      // contagem ATUAL do Kit como se fosse "ontem" teria inflado/
      // desinflado a variação calculada em silêncio (docstring de F1). Sem
      // história gravada pra esse dia (arquivo ainda não existe, ou dia
      // anterior à 1ª execução com --write), continua `null` explícito —
      // nunca um `0` fabricado.
      loadKitActiveCountForDay(rootDir, beehiivLayer.previousDate),
      "plataforma",
    );
  }

  // ── Metas (zona 3) ───────────────────────────────────────────────
  const metasPath = resolve(rootDir, "data", "metas.json");
  const metasResult = loadMetas(metasPath);
  const metasLayer = await buildMetasLayer(metasResult, metasPath, acqDeps, diaReferencia, metaWindowDays);

  // ── Placar da meta de ativação — 2 números + barra de erro (decisão
  //    do editor, 02/09/2026) ─────────────────────────────────────────
  const janelaPlacar = janelaJanela(addDaysToYmd(diaReferencia, -(placarWindowDays - 1)), diaReferencia);
  const naoPagoDef = getMetric("cadastros-nao-pago-nao-reativacao-dia")!;
  const organicoDef = getMetric("cadastros-organicos-dia")!;
  const indeterminadosDef = getMetric("cadastros-indeterminados-dia")!;
  const placar: MetricsPlacar = {
    naoPagoNaoReativacao: await naoPagoDef.computar({ janela: janelaPlacar, deps: acqDeps }),
    organicoEstrito: await organicoDef.computar({ janela: janelaPlacar, deps: acqDeps }),
    indeterminados: await indeterminadosDef.computar({ janela: janelaPlacar, deps: acqDeps }),
    janela: janelaPlacar,
    janelaDias: placarWindowDays,
  };

  // ── Decomposição (zona 4) — cadastros-dia por classe ────────────────
  const cadastrosDef = getMetric("cadastros-dia")!;
  const decomposicaoCadastros = await cadastrosDef.computar({ janela: janelaHoje, decomposicao: "classe", deps: acqDeps });

  // ── Valor (#8423) — receita, ARPU, churn, conversão em apoiador, LTV ──
  const beehiivAllDates = listSnapshotDates(beehiivRoot);
  const valor = await computeValorLayer(rootDir, beehiivSubs, beehiivRoot, beehiivAllDates, beehiivLayer.date, now());

  const data: MetricsSnapshot = {
    execMode,
    generatedAt,
    cached: false,
    hasDataDir,
    capturaLog,
    subscriptionCoverage: coverageLayer,
    beehiivSnapshot: beehiivLayer,
    diaReferencia,
    baseline,
    queda: { baseAtiva, baseAtivaAnterior, kitActiveLayer, crossPlatformActiveLayer },
    metas: metasLayer,
    placar,
    decomposicaoCadastros,
    valor,
  };
  cacheByRoot.set(rootDir, { data, expiresAt: nowMs + cacheTtlMs });
  // `db` (aberto acima por `loadSubscriptionCoverage`) só é consumido
  // SINCRONAMENTE dentro desta função — `acqDeps.registros`/`kitActiveLayer`
  // já rodaram antes deste ponto, e `data` acima é um snapshot puro (nenhum
  // callback lazy segura `db` vivo depois do retorno). Fechar aqui evita
  // vazar o handle `DatabaseSync` (WAL/SHM) a cada chamada — achado ao vivo
  // ao escrever os testes do #7916: sem este close, o handle nunca era
  // liberado e travava a limpeza do diretório temporário no Windows.
  try {
    db?.close();
  } catch (e) {
    // best-effort cleanup — nunca deixar isso virar 500 pra um request cujo dado já foi computado/cacheado com sucesso
    console.error(`[studio-metrics] falha ao fechar diaria-subscribers.db (ignorada, dado já cacheado): ${(e as Error).message}`);
  }
  return data;
}

async function computeBaseline(
  def: MetricDef,
  janela: Janela,
  acqDeps: AcquisitionMetricDeps,
  beehiivSubs: readonly BeehiivBackupSubscriber[],
  beehiivLayer: MetricsBeehiivSnapshotLayer,
  hoje: string,
  kitActive: number | null,
  crossPlatformActive: number | null = null,
  crossPlatformAsOf: string | null = null,
): Promise<MetricResult> {
  switch (def.id) {
    case "cadastros-dia":
      return def.computar({ janela, deps: acqDeps });
    case "doi-confirmacao-dia":
      return def.computar({ janela, deps: {} });
    case "doi-orfaos":
      // F2 ainda não expõe a leitura viva (`inactiveSubscribers`/
      // `formSubscriberIds`) por esta camada — mesma simplificação
      // declarada no topo do módulo pro Kit vivo: sem esses dois insumos, a
      // métrica não tem como computar honestamente, então esta zona mostra
      // o resultado indeterminado explícito em vez de forjar `deps` vazio
      // fingindo "zero órfãos".
      return {
        valor: null,
        janela,
        frescor: null,
        qualidade: "indeterminado",
        motivo:
          "leitura viva do Kit (inactiveSubscribers/formSubscriberIds) não implementada nesta fatia do painel " +
          "(#7178) — ver docstring de studio-metrics.ts",
      };
    case "base-ativa":
      return computeBaseAtiva(def, janela, beehiivSubs, beehiivLayer, hoje, kitActive, undefined, crossPlatformActive, crossPlatformAsOf);
    case "leitor-v1":
      return computeLeitorV1(def, janela, beehiivSubs, beehiivLayer);
    default:
      return {
        valor: null,
        janela,
        frescor: null,
        qualidade: "indeterminado",
        motivo: `métrica "${def.id}" sem wiring de deps nesta camada`,
      };
  }
}

function computeBaseAtiva(
  def: MetricDef,
  janela: Janela,
  beehiivSubs: readonly BeehiivBackupSubscriber[],
  beehiivLayer: MetricsBeehiivSnapshotLayer,
  hoje: string,
  kitActive: number | null,
  decomposicao?: string,
  crossPlatformActive: number | null = null,
  crossPlatformAsOf: string | null = null,
): Promise<MetricResult> {
  const deps: BaseAtivaDeps = {
    beehiiv: beehiivLayer.date ? { date: beehiivLayer.date, active: countActive(beehiivSubs) } : null,
    // Contagem real do store `diaria-subscribers` (#7916, fatia 1/N) — vem
    // de `loadKitActiveLayer` no chamador; `null` continua sendo o sinal
    // honesto de "sem coleta" quando o store está ausente/ilegível, nunca
    // um `0` fingindo "Kit sem assinante ativo".
    kitActive,
    hoje,
    // Contagem DEDUPLICADA cross-plataforma (#7916, fatia 4/N) — vem de
    // `loadCrossPlatformActiveLayer` no chamador; `null` só quando o store
    // está ausente/ilegível (`baseAtivaAnterior` também passa `null` de
    // propósito — sem série histórica DEDUPLICADA gravada ainda, mesma
    // limitação que `kitActive` teve até a fatia 3/N; reusar a contagem de
    // HOJE como "ontem" inflaria/desinflaria a variação em silêncio).
    // `baseAtivaDef.computar` prefere este campo sobre `beehiiv`/`kitActive`
    // quando presente — nunca pior que a soma ingênua, sempre melhor ou
    // igual.
    crossPlatformActive,
    crossPlatformAsOf,
  };
  return def.computar({ janela, decomposicao, deps });
}

function computeLeitorV1(
  def: MetricDef,
  janela: Janela,
  beehiivSubs: readonly BeehiivBackupSubscriber[],
  beehiivLayer: MetricsBeehiivSnapshotLayer,
): Promise<MetricResult> {
  const deps: LeitorV1Deps = {
    subscribers: beehiivSubs,
    snapshotDate: beehiivLayer.date ?? "sem-snapshot",
  };
  return def.computar({ janela, deps });
}

// ─── metas (zona 3) ──────────────────────────────────────────────────

/**
 * Métricas cujo `computar` aceita `AcquisitionMetricDeps` — as únicas que
 * este avaliador de metas sabe alimentar com segurança. `base-ativa`/
 * `leitor-v1`/`doi-orfaos`/`doi-confirmacao-dia` exigem `deps` de formato
 * DIFERENTE (`BaseAtivaDeps`/`LeitorV1Deps`/...) — passar `acqDeps` pra eles
 * silenciosamente devolveria campos `undefined` interpretados como "sem
 * dado" por engano (ex: `base-ativa` seria lido como `beehiiv: undefined`,
 * que NÃO é `null` e passaria pelo guard de indeterminado, produzindo um
 * "0" falso). Meta que aponta pra uma dessas métricas fica com `erro`
 * explícito em vez de um número forjado — mesma disciplina de honestidade
 * do resto da tela.
 */
const ACQUISITION_METRIC_IDS: ReadonlySet<string> = new Set([
  "cadastros-dia",
  "cadastros-nao-pago-nao-reativacao-dia",
  "cadastros-organicos-dia",
  "cadastros-indeterminados-dia",
]);

async function buildMetasLayer(
  metasResult: ReturnType<typeof loadMetas>,
  metasPath: string,
  acqDeps: AcquisitionMetricDeps,
  diaReferencia: string,
  metaWindowDays: number,
): Promise<MetricsMetasLayer> {
  const { metas, motivo } = metasResult;
  if (metas.length === 0) {
    return { path: metasPath, motivo, validationError: null, items: [] };
  }
  try {
    validateMetas(metas, METRICAS);
  } catch (e) {
    return { path: metasPath, motivo, validationError: (e as Error).message, items: [] };
  }

  const dias = enumerarDiasInclusive(addDaysToYmd(diaReferencia, -(metaWindowDays - 1)), diaReferencia);
  const items: MetricsMetaItem[] = await Promise.all(
    metas.map(async (meta): Promise<MetricsMetaItem> => {
      const def = getMetric(meta.metrica_id);
      if (!def) {
        return { meta, status: null, erro: `metrica_id "${meta.metrica_id}" não encontrada no registry` };
      }
      if (!ACQUISITION_METRIC_IDS.has(def.id)) {
        return {
          meta,
          status: null,
          erro: `métrica "${def.id}" ainda não tem avaliação de meta nesta fatia do painel (#7178) — deps incompatível com o avaliador atual`,
        };
      }
      try {
        const medicoes: MedicaoDia[] = await Promise.all(
          dias.map(async (dia): Promise<MedicaoDia> => ({
            chave: dia,
            resultado: await def.computar({ janela: janelaDia(dia), deps: acqDeps }),
          })),
        );
        const status = evaluateMeta(meta, medicoes, diaReferencia);
        return { meta, status, erro: null };
      } catch (e) {
        return { meta, status: null, erro: (e as Error).message };
      }
    }),
  );
  return { path: metasPath, motivo, validationError: null, items };
}
