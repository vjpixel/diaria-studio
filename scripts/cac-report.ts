/**
 * cac-report.ts (#5236 Parte 2)
 *
 * Relatório de custo por leitor por canal — a peça que fecha a camada de
 * dados de aquisição (#5235 definiu `leitor-v1` + mapa de origem
 * recuperada; este script cruza os dois com `data/aquisicao/spend.csv` e
 * ranqueia).
 *
 * **Só leitura local — nunca chama a API Beehiiv/Google Ads/LinkedIn ao
 * vivo** (guard de publicação do overnight/develop). Toda a computação real
 * mora em `scripts/lib/cac.ts` (puro, testável sem I/O); este arquivo só
 * carrega os 3 insumos do disco, chama `buildCacReport`, formata e registra.
 *
 * ## Insumos
 *
 * 1. Snapshot mais recente de `data/beehiiv-backup/{YYYY-MM-DD}/subscribers.jsonl`
 *    (task `Diaria-Beehiiv-Backup`, #5229) — `--snapshot` pra outra data.
 * 2. `data/aquisicao/origem-original.json` (opcional — `scripts/build-origem-map.ts`,
 *    #5235). Sem ele, o relatório roda com o `utm_source` CRU do snapshot
 *    (aviso explícito no output, nunca silencioso) — cadastros reativados
 *    via `brevo-diaria` (#4530) vão aparecer como esse canal em vez da
 *    origem original.
 * 3. `data/aquisicao/spend.csv` (#5236 Parte 1) — `--spend` pra outro path;
 *    `npx tsx scripts/seed-spend-csv.ts` cria o seed inicial se ausente.
 *
 * ## Uso
 *
 *   npx tsx scripts/cac-report.ts
 *   npx tsx scripts/cac-report.ts --json
 *   npx tsx scripts/cac-report.ts --snapshot 2026-08-14 --no-register
 *
 * Exit codes: 0 = sucesso; 1 = insumo obrigatório ausente/ilegível (spend.csv
 * ou snapshot).
 *
 * ## Seção Kit (#7359) — informativa, não substitui o relatório Beehiiv acima
 *
 * O cadastro real hoje nasce majoritariamente no Kit (workers de assinatura,
 * `POST /v4/subscribers`/`POST /jogar/subscribe` — ver
 * `workers/poll/src/subscribe.ts`), mas `subscriber_backend` continua
 * `"beehiiv"` (ver nota em `platform.config.json`) — o snapshot local
 * (`data/beehiiv-backup/`) que este relatório lê NUNCA viu esses cadastros.
 * Sem uma seção própria, "custo por leitor" simplesmente não enxergava
 * conversão paga nenhuma, mesmo com o encanamento de UTM funcionando.
 *
 * Este relatório NÃO reimplementa o funil completo (`buildCacReport`) pro
 * lado Kit — a base Kit é ingerida via um mecanismo bem diferente (SQLite
 * incremental, `scripts/lib/kit-subscribers-ingest.ts`/#7202, sem os campos
 * de engajamento por-post que `computeMeasuredRow` usa). A seção abaixo é
 * deliberadamente mais simples: cadastros por `utm_source`/`utm_campaign`
 * via `fetchAndAggregateKit` (`count-subscriptions-by-utm.ts`, corrigida no
 * mesmo #7359 pra ler `fields` — a fonte real — em vez do bloco
 * `attribution` nativo, que vem sempre nulo pra cadastro via API/worker).
 * Serve pra confirmar QUE o cadastro pago aparece — não pra ranquear custo
 * por leitor lado a lado com a tabela Beehiiv (paridade de funil fica pra
 * quando/se `subscriber_backend` migrar de verdade). Fail-soft: sem
 * `KIT_API_KEY` ou com a API do Kit fora do ar, a seção continua aparecendo
 * com um aviso explicando o motivo (nunca desaparece em silêncio) — nunca
 * derruba o relatório Beehiiv. Só `--no-kit` omite a seção por completo.
 *
 * ## Seção Leitores via store unificado (#7393) — informativa e PARCIAL
 *
 * Segunda seção aditiva, mesma receita do #7359: lê `leitor-v1`
 * CROSS-PLATAFORMA (Beehiiv + Kit + Brevo diária já ingeridos) direto de
 * `data/diaria-subscribers/diaria-subscribers.db` via
 * `summarizeStoreLeitoresCanonicalDedup` (`scripts/lib/leitor-store.ts`).
 * Só leitura local (nunca chama API) — fail-soft: store ausente/ilegível vira
 * aviso explícito, nunca some em silêncio nem derruba o relatório Beehiiv
 * acima. **PARCIAL de propósito**: o store não tem, hoje, os mesmos campos de
 * engajamento por-post que `computeMeasuredRow` usa pro funil Beehiiv (mesma
 * ressalva que o #7359 já registrou pro Kit) — por isso esta seção mostra só
 * o resumo `leitor-v1` (total/ativos/leitores + cobertura de assinatura), sem
 * tentar produzir um "custo por leitor" cross-plataforma que pareceria
 * autoritativo sem ser. Só `--no-store-leitores` omite a seção por completo;
 * `--store-db <path>` sobrepõe o caminho do DB (default
 * `data/diaria-subscribers/diaria-subscribers.db`).
 *
 * ## `--fonte store|beehiiv` (#8238) — fonte da COORTE do funil principal
 *
 * Default `beehiiv` (comportamento inalterado): o funil principal (tabela do
 * topo, ranking, "Funil por canal") lê a coorte do snapshot local
 * `data/beehiiv-backup/`. Canal cujo cadastro nasce no Kit e nunca passa pela
 * Beehiiv (os 3 braços "(teste 2608)" — `publishing.newsletter.backend =
 * "kit"`, ver `CHANNEL_KEY_SPECS`) aparece com 0 cadastros nesta fonte,
 * mesmo tendo cadastros reais — não porque o canal não converteu, mas porque
 * a fonte nunca viu esses assinantes (achado #8238).
 *
 * `--fonte store` troca a coorte inteira pelo store unificado
 * (`data/diaria-subscribers/diaria-subscribers.db`, Kit + Beehiiv + Brevo
 * diária já ingeridos) via `buildCacCompatibleSubscribersFromStore`
 * (`scripts/lib/leitor-store.ts`, construído originalmente pro #8210 Bug 2 —
 * reusado aqui, não duplicado). Requer `--snapshot AAAA-MM-DD` explícito
 * (rótulo/corte do relatório — não existe "snapshot mais recente" no store,
 * que é mutável) e não tem snapshot ANTERIOR conhecido, então a linha "vs.
 * base" (sinal de degradação) não é calculada neste modo. Reproduzir a
 * mesma leitura mais tarde ainda depende do store não ter mudado — congelar
 * um corte determinístico por timestamp de evento (truncar `event.ts` no
 * corte) é escopo remanescente do #8238, não implementado aqui.
 *
 * **Detecção fail-soft, mesmo em `--fonte beehiiv`:** quando a fonte é
 * `beehiiv`, o relatório roda uma checagem adicional (`detectTeste2608BeehiivStoreMismatch`)
 * comparando, só para os canais "(teste 2608)", os cadastros do snapshot
 * Beehiiv contra o store — se o Beehiiv mostra 0 e o store mostra > 0, isso
 * vira um aviso explícito no relatório (nunca silencioso) recomendando
 * `--fonte store`. Store ausente/ilegível é fail-soft (a checagem só some,
 * nunca derruba o relatório principal).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, hasFlag, getStringArg } from "./lib/cli-args.ts";
import {
  latestSnapshotDate,
  listSnapshotDates,
  readSnapshotSubscribers,
  type BeehiivBackupSubscriber,
} from "./lib/beehiiv-backup-snapshots.ts";
import { readSpendCsv, type SpendRow, type SpendRowError } from "./lib/aquisicao-spend.ts";
import {
  buildCacReport,
  filterInternalAndTestSubscribers,
  applyOrigemOverride,
  buildNormalizedOrigemIndex,
  computeMonthBudgetUsage,
  MONTHLY_BUDGET_FLOOR_BRL,
  CHANNEL_GROUP_KEYS,
  CHANNEL_KEY_SPECS,
  subscribersForChannel,
  type CacReport,
  type CacRow,
  type OrigemEntryFields,
} from "./lib/cac.ts";
import {
  parseSinceToEpochSeconds,
  parseUntilToEpochSecondsExclusive,
  resolveWindowGuardError,
  type CohortWindow,
} from "./cohort-engagement.ts";
import { registerReport, reportId } from "./studio-ui/studio-reports.ts";
import { fetchAndAggregateKit, formatCountsTable, type UtmCountResult } from "./count-subscriptions-by-utm.ts";
import { resolveKitConfig, type KitConfig } from "./lib/kit-config.ts";
import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_DB_PATH as DEFAULT_STORE_DB_PATH, openDiariaSubscribersDbSafe } from "./lib/diaria-subscribers-db.ts";
import {
  summarizeStoreLeitoresCanonicalDedup,
  buildCacCompatibleSubscribersFromStore,
  type StoreLeitorSummary,
} from "./lib/leitor-store.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_BACKUP_ROOT = resolve(ROOT, "data", "beehiiv-backup");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");
export const DEFAULT_ORIGEM_MAP_PATH = resolve(ROOT, "data", "aquisicao", "origem-original.json");

// ---------------------------------------------------------------------------
// Carregamento de insumos (I/O — não testado como pure, ver cac.test.ts pro
// núcleo puro e studio-ads.test.ts pra fixture-based end-to-end)
// ---------------------------------------------------------------------------

interface OrigemMapFile {
  origem?: Record<string, OrigemEntryFields>;
}

export function loadOrigemIndex(path: string): { index: Map<string, OrigemEntryFields>; applied: boolean } {
  if (!existsSync(path)) {
    console.error(
      `[cac-report] aviso: mapa de origem ausente (${path}) — usando utm_source cru do snapshot. ` +
        `Rode "npx tsx scripts/build-origem-map.ts" pra reconstruir a origem recuperada (#5235).`,
    );
    return { index: new Map(), applied: false };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as OrigemMapFile;
    return { index: buildNormalizedOrigemIndex(parsed.origem ?? {}), applied: true };
  } catch (e) {
    console.error(`[cac-report] aviso: falha ao ler mapa de origem (${path}): ${(e as Error).message} — usando utm_source cru.`);
    return { index: new Map(), applied: false };
  }
}

/** Resultado da seção Kit (#7359) — sempre um dos dois shapes, nunca lança. */
export type CacReportKitSection =
  | { applied: true; result: UtmCountResult }
  | { applied: false; reason: string };

/**
 * Busca cadastros Kit agregados por UTM (#7359) — fail-soft: config ausente
 * ou falha de rede vira `{applied:false, reason}`, nunca lança. `fetcher`
 * injetável pra teste (default `fetchAndAggregateKit`); `env` injetável pelo
 * mesmo motivo (`resolveKitConfig` já é puro/injetável).
 */
export async function loadKitUtmSection(
  fetcher: (config?: KitConfig) => Promise<UtmCountResult> = fetchAndAggregateKit,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): Promise<CacReportKitSection> {
  const cfgResult = resolveKitConfig(env);
  if (!cfgResult.ok) {
    return { applied: false, reason: cfgResult.reason };
  }
  try {
    const result = await fetcher(cfgResult.config);
    return { applied: true, result };
  } catch (e) {
    return { applied: false, reason: `Kit API falhou: ${(e as Error).message}` };
  }
}

/** Resultado da seção "Leitores via store unificado" (#7393) — sempre um dos
 *  dois shapes, nunca lança. */
export type CacReportStoreSection =
  | { applied: true; summary: StoreLeitorSummary }
  | { applied: false; reason: string };

/**
 * Resume `leitor-v1` cross-plataforma a partir do store unificado (#7393) —
 * fail-soft: store ausente/ilegível ou erro de leitura vira
 * `{applied:false, reason}`, nunca lança. `openDb`/`dbPath` injetáveis pra
 * teste (mesmo padrão de `loadKitUtmSection`).
 */
export function loadStoreLeitorSection(
  dbPath: string = DEFAULT_STORE_DB_PATH,
  openDb: (path: string) => DatabaseSync | null = openDiariaSubscribersDbSafe,
): CacReportStoreSection {
  const db = openDb(dbPath);
  if (!db) {
    return {
      applied: false,
      reason: `store não encontrado/ilegível em ${dbPath} — rode as ingestões (#6586/#6587) antes.`,
    };
  }
  try {
    const summary = summarizeStoreLeitoresCanonicalDedup(db);
    return { applied: true, summary };
  } catch (e) {
    return { applied: false, reason: `falha ao ler o store: ${(e as Error).message}` };
  } finally {
    db.close();
  }
}

/**
 * Checagem fail-soft (#8238): quando a coorte do funil principal vem do
 * snapshot Beehiiv (`--fonte beehiiv`, o default), compara — só pros canais
 * "(teste 2608)" de `CHANNEL_KEY_SPECS` — os cadastros que o Beehiiv viu
 * contra os que o store unificado (Kit + Beehiiv + Brevo diária) tem pro
 * MESMO canal. Beehiiv em 0 com store > 0 é o sintoma exato do #8238
 * (cadastro nasceu no Kit, nunca passou pela Beehiiv) — vira aviso explícito
 * no relatório em vez de deixar "0 cadastros" passar sem contexto.
 *
 * Nunca lança: store ausente/ilegível ou qualquer erro de leitura faz a
 * checagem devolver `[]` silenciosamente — é um EXTRA sobre o relatório
 * principal (que já rodou com a fonte escolhida via `--fonte`), nunca um
 * motivo pra derrubá-lo. `openDb` injetável pro mesmo padrão de
 * `loadStoreLeitorSection`. @pure o suficiente pra teste (I/O isolado em
 * `openDb`).
 */
export function detectTeste2608BeehiivStoreMismatch(
  report: CacReport,
  storeDbPath: string = DEFAULT_STORE_DB_PATH,
  openDb: (path: string) => DatabaseSync | null = openDiariaSubscribersDbSafe,
): string[] {
  let db: DatabaseSync | null = null;
  try {
    db = openDb(storeDbPath);
    if (!db) return [];
    const storeSubs = buildCacCompatibleSubscribersFromStore(db);
    const testeCanais = [...new Set(CHANNEL_KEY_SPECS.filter((s) => s.canal.includes("(teste 2608)")).map((s) => s.canal))];
    const warnings: string[] = [];
    for (const canal of testeCanais) {
      const beehiivRow = report.rows.find(
        (r): r is Extract<CacRow, { kind: "measured" }> => r.kind === "measured" && r.canal === canal,
      );
      const beehiivCadastros = beehiivRow?.cadastros ?? 0;
      if (beehiivCadastros > 0) continue;
      const storeCount = subscribersForChannel(storeSubs, canal).length;
      if (storeCount > 0) {
        warnings.push(
          `${canal}: Beehiiv mostra ${beehiivCadastros} cadastro(s), store unificado tem ${storeCount}.`,
        );
      }
    }
    return warnings;
  } catch (e) {
    console.error(`[cac-report] aviso: checagem beehiiv-vs-store (#8238) falhou (fail-soft): ${(e as Error).message}`);
    return [];
  } finally {
    db?.close();
  }
}

export function loadPreparedSubscribers(
  root: string,
  date: string,
  origemIndex: Map<string, OrigemEntryFields>,
): { subs: BeehiivBackupSubscriber[]; internalFiltered: number } {
  const raw = readSnapshotSubscribers(root, date);
  const overridden = applyOrigemOverride(raw, origemIndex);
  const { kept, removedCount } = filterInternalAndTestSubscribers(overridden);
  return { subs: kept, internalFiltered: removedCount };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface CacReportCliArgs {
  backupRoot: string;
  spendPath: string;
  origemPath: string;
  snapshotDate: string | null;
  json: boolean;
  register: boolean;
  /** `--desde AAAA-MM-DD` cru, como passado — `null` = sem borda inferior (#5495). */
  desde: string | null;
  /** `--ate AAAA-MM-DD` cru, como passado (INCLUSIVO — o dia inteiro entra) — `null` = sem borda superior. */
  ate: string | null;
  /** `--strict` (#5860): quando `true`, gasto não atribuído (`report.unattributedSpend`
   *  não-vazio) vira exit code 1 em vez do default 0 — acionável no momento
   *  em que acontece (cron/task agendada falha visivelmente), não só um
   *  aviso em stderr de uma execução antiga que ninguém vai reler. Default
   *  `false` pra não quebrar callers/tasks existentes que já toleram gasto
   *  não atribuído como aviso — opt-in deliberado (a issue permite as duas
   *  formas: exit code sempre diferente de 0, OU uma flag que force isso). */
  strict: boolean;
  /** `--no-kit` (#7359): desliga a seção informativa "Cadastros no Kit por
   *  UTM" (`loadKitUtmSection`) — default `true` (liga). Existe pra CLI/testes
   *  que preferem pular a resolução de `KIT_API_KEY`/chamada de rede por
   *  completo, em vez de confiar no fail-soft de `loadKitUtmSection`. */
  kit: boolean;
  /** `--no-store-leitores` (#7393): desliga a seção informativa "Leitores via
   *  store unificado" (`loadStoreLeitorSection`) — default `true` (liga).
   *  Só leitura local, mas existe pro mesmo motivo do `--no-kit`: CLI/testes
   *  que preferem pular a tentativa de abrir o DB por completo. */
  storeLeitores: boolean;
  /** `--store-db <path>` (#7393): sobrepõe o caminho do store unificado
   *  (default `data/diaria-subscribers/diaria-subscribers.db`). */
  storeDbPath: string;
  /** `--fonte store|beehiiv` (#8238): fonte da coorte do FUNIL PRINCIPAL
   *  (tabela/ranking/funil-por-canal) — não confundir com as seções
   *  informativas "Kit"/"Leitores via store unificado" acima, que sempre
   *  rodam independente disto. Default `"beehiiv"` (comportamento
   *  inalterado). Ver docstring do módulo. */
  fonte: string;
}

export function parseCacReportArgs(argv: string[]): CacReportCliArgs {
  return {
    backupRoot: getStringArg(argv, "root") ?? DEFAULT_BACKUP_ROOT,
    spendPath: getStringArg(argv, "spend") ?? DEFAULT_SPEND_CSV_PATH,
    origemPath: getStringArg(argv, "origem") ?? DEFAULT_ORIGEM_MAP_PATH,
    snapshotDate: getStringArg(argv, "snapshot") ?? null,
    json: hasFlag(argv, "json"),
    register: !hasFlag(argv, "no-register"),
    desde: getStringArg(argv, "desde") ?? null,
    ate: getStringArg(argv, "ate") ?? null,
    strict: hasFlag(argv, "strict"),
    kit: !hasFlag(argv, "no-kit"),
    storeLeitores: !hasFlag(argv, "no-store-leitores"),
    storeDbPath: getStringArg(argv, "store-db") ?? DEFAULT_STORE_DB_PATH,
    fonte: getStringArg(argv, "fonte") ?? "beehiiv",
  };
}

/** Valores aceitos por `--fonte` (#8238). @pure */
export const CAC_REPORT_FONTES = ["beehiiv", "store"] as const;
export type CacReportFonte = (typeof CAC_REPORT_FONTES)[number];

/** @pure */
export function isValidCacReportFonte(fonte: string): fonte is CacReportFonte {
  return (CAC_REPORT_FONTES as readonly string[]).includes(fonte);
}

/**
 * Id do relatório congelado (`data/aquisicao/cac-reports/{id}.md`,
 * `registerReport` `sessionId`) — fonte ÚNICA da regra, consumida tanto por
 * `main()` (que escreve o arquivo) quanto por `scripts/ads-test-watch.ts`
 * (que precisa saber, ANTES de rodar, qual path o relatório vai ocupar pra
 * montar o e-mail de sucesso). `--fonte store` ganha sufixo `--store`
 * (#8238) — sem isso, `--fonte store --snapshot D` sobrescreveria em
 * silêncio um relatório `--fonte beehiiv` já registrado com o mesmo rótulo
 * de data; janela (`--desde`/`--ate`) mantém o sufixo `--w...` de sempre
 * (#5495), aplicado sempre DEPOIS do sufixo de fonte. @pure
 */
export function cacReportSnapshotId(
  snapshotDate: string,
  fonte: CacReportFonte,
  desde: string | null = null,
  ate: string | null = null,
): string {
  const fonteSuffix = fonte === "store" ? "--store" : "";
  const windowSuffix = desde || ate ? `--w${desde ?? "x"}_${ate ?? "x"}` : "";
  return `${snapshotDate}${fonteSuffix}${windowSuffix}`;
}

/** Resolve `--desde`/`--ate` crus (strings AAAA-MM-DD) numa `CohortWindow`
 *  epoch, reusando os parsers/guard de `cohort-engagement.ts` (#5495 —
 *  "reusar filterWindow, nunca reimplementar" vale igual pro parsing da
 *  janela). Lança com a mesma mensagem de erro do CLI de `cohort-engagement.ts`
 *  se o formato for inválido ou `--desde` vier depois de `--ate`. `null`
 *  quando nenhuma das duas flags foi passada (sem janela). */
export function resolveCacReportWindow(args: Pick<CacReportCliArgs, "desde" | "ate">): CohortWindow | null {
  if (args.desde == null && args.ate == null) return null;
  const since = args.desde != null ? parseSinceToEpochSeconds(args.desde) : null;
  const untilExclusive = args.ate != null ? parseUntilToEpochSecondsExclusive(args.ate) : null;
  const guardError = resolveWindowGuardError({ since, untilExclusive }, { since: args.desde, until: args.ate });
  if (guardError) throw new Error(`[cac-report] ${guardError}`);
  return { since, untilExclusive };
}

function fmtPct(frac: number | null): string {
  if (frac == null) return "—";
  return `${(frac * 100).toFixed(1)}%`;
}

function fmtBrl(n: number | null): string {
  if (n == null) return "—";
  return `R$ ${n.toFixed(2).replace(".", ",")}`;
}

function amostraQualifier(row: Extract<CacRow, { kind: "measured" }>): string {
  if (row.amostraVazia) return "⚠ vazia";
  if (row.amostraPequena) return "⚠ pequena";
  if (row.amostraInstavel) return "⚠ instável";
  return "";
}

/** Metadados de procedência opcionais (#5495 — "o relatório precisa ser
 *  auto-suficiente quando copiado pra fora do arquivo"). Sempre opcionais:
 *  chamadores existentes (testes, callers antigos) continuam funcionando sem
 *  passar nada — as linhas correspondentes só aparecem quando informadas. */
export interface CacReportProvenance {
  /** ISO — momento em que ESTE relatório foi apurado (não o do snapshot). */
  apuradoEm?: string;
  /** Data/rótulo do snapshot usado (`YYYY-MM-DD`) — no modo `--fonte store`
   *  é o `--snapshot` passado na CLI (rótulo/corte), não um snapshot Beehiiv
   *  de verdade (#8238). */
  snapshotDate?: string;
  /** `"beehiiv"` (default) ou `"store"` (#8238) — fonte da coorte do funil
   *  principal. `undefined` só em chamadas antigas de teste que não passam
   *  provenance completo; tratado como `"beehiiv"` pra rótulo. */
  fonte?: CacReportFonteLabel;
}

/** Só pra rótulo no markdown — não reimporta o tipo de `parseCacReportArgs`
 *  pra manter este módulo de formatação independente de como a CLI valida
 *  o valor. @pure */
export type CacReportFonteLabel = "beehiiv" | "store";

/** @pure */
export function formatCacReportMarkdown(
  report: CacReport,
  budget: ReturnType<typeof computeMonthBudgetUsage>,
  provenance: CacReportProvenance = {},
  kitSection?: CacReportKitSection,
  storeSection?: CacReportStoreSection,
  mismatchWarnings: readonly string[] = [],
): string {
  const lines: string[] = [];
  lines.push(`# Custo por leitor por canal`, "");
  if (provenance.apuradoEm) lines.push(`Apurado em: ${provenance.apuradoEm}.`);
  lines.push(`Fonte da coorte: ${provenance.fonte ?? "beehiiv"}.`);
  if (provenance.snapshotDate) {
    lines.push(
      provenance.fonte === "store"
        ? `Rótulo/corte (store unificado): ${provenance.snapshotDate}.`
        : `Snapshot Beehiiv usado: ${provenance.snapshotDate}.`,
    );
  }
  if (mismatchWarnings.length > 0) {
    lines.push("");
    lines.push(
      "⚠ Possível coorte na fonte errada (#8238) — canal(is) do teste 2608 com 0 cadastros no snapshot Beehiiv " +
        "mas cadastros REAIS no store unificado (nasceram no Kit). Considere rodar com `--fonte store`:",
    );
    for (const w of mismatchWarnings) lines.push(`  - ${w}`);
  }
  if (report.window) {
    const sinceLabel = report.window.since != null ? new Date(report.window.since * 1000).toISOString().slice(0, 10) : "(sem borda inferior)";
    const untilLabel =
      report.window.untilExclusive != null
        ? new Date(report.window.untilExclusive * 1000 - 86_400_000).toISOString().slice(0, 10)
        : "(sem borda superior)";
    lines.push(`Janela de cadastro aplicada (--desde/--ate): ${sinceLabel} a ${untilLabel} (inclusive).`);
    if (report.excludedMissingCreated > 0) {
      lines.push(`⚠ ${report.excludedMissingCreated} assinante(s) descartado(s) da base por falta de \`created\` sob a janela.`);
    }
  } else {
    lines.push(`Nenhuma janela de cadastro aplicada (--desde/--ate) — números acumulados desde sempre, não recortados por período.`);
  }
  lines.push(`Base (todos os ativos, todos os canais): abertura agregada ${fmtPct(report.base.aberturaAgregada)} (n=${report.base.amostraConsiderada}).`);
  lines.push(`Orçamento do mês ${budget.monthKey}: ${fmtBrl(budget.spentBrl)} de ${fmtBrl(budget.budgetFloorBrl)} (${fmtPct(budget.fractionUsed)}).`);
  if (report.internalFiltered > 0) {
    lines.push(`${report.internalFiltered} conta(s) interna(s)/teste excluída(s) antes de agrupar.`);
  }
  if (!report.originApplied) {
    lines.push(`⚠ mapa de origem recuperada NÃO aplicado — canais reativados via brevo-diaria podem estar mal atribuídos.`);
  }
  if (report.unmappedChannels.length > 0) {
    lines.push(`⚠ canal(is) desconhecido(s) em spend.csv (confira o nome exato): ${report.unmappedChannels.join(", ")}.`);
  }
  if (report.channelsMissingSpend.length > 0) {
    lines.push(
      `⚠ canal(is) com assinantes atribuídos mas SEM linha em spend.csv (ausente do relatório): ${report.channelsMissingSpend.join(", ")}.`,
    );
  }
  lines.push("");

  const rowTableHeader = [
    "| Canal | Sub-canal | Custo/leitor | Leitores | Ativos | Cadastros | Abertura (canal) | vs. base | n | Amostra | Gasto | Mês | Fonte |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];

  const rowToTableLine = (row: CacRow): string => {
    const subcanal = row.spend.subcanal ?? "—";
    if (row.kind === "measured") {
      const versusBase =
        row.aberturaAgregada != null && report.base.aberturaAgregada != null
          ? `${row.aberturaAgregada >= report.base.aberturaAgregada ? "▲" : "▼"} ${fmtPct(Math.abs(row.aberturaAgregada - report.base.aberturaAgregada) as number)}`
          : "—";
      const degradedFlag = row.degradado === true ? " ⚠ degradou" : "";
      return `| ${row.canal} | ${subcanal} | ${fmtBrl(row.custoPorLeitor)} | ${row.leitores} | ${row.ativos} | ${row.cadastros} | ${fmtPct(row.aberturaAgregada)}${degradedFlag} | ${versusBase} | ${row.amostraConsiderada} | ${amostraQualifier(row) || "—"} | ${fmtBrl(row.spend.valor)} | ${row.spend.mes} | ${row.spend.fonte} |`;
    }
    return `| ${row.canal} | ${subcanal} | ${fmtBrl(row.range.custoPorLeitorMin)}–${fmtBrl(row.range.custoPorLeitorMax)} | ${row.range.leitoresMin}–${row.range.leitoresMax} | ${row.range.ativosMin}–${row.range.ativosMax} | — | — | — | — | estimado (não medido) | ${fmtBrl(row.spend.valor)} | ${row.spend.mes} | ${row.spend.fonte} |`;
  };

  // Ranking principal (#5859) — só canais com custo por leitor válido E
  // gasto real (> 0). "Sem dado suficiente" e "Gasto zero" são blocos
  // PRÓPRIOS logo abaixo, nunca misturados/indistinguíveis dentro deste
  // ranking ordenado.
  lines.push(...rowTableHeader);
  if (report.rankedRows.length > 0) {
    for (const row of report.rankedRows) lines.push(rowToTableLine(row));
  } else {
    lines.push("| _nenhum canal ranqueável (todos sem dado ou com gasto zero — ver blocos abaixo)_ | | | | | | | | | | | | |");
  }

  if (report.noDataRows.length > 0) {
    lines.push("");
    lines.push("### Sem dado suficiente");
    lines.push("");
    lines.push("Canal medido, mas sem nenhum leitor no snapshot ainda — não é \"caríssimo\", é \"sem dado\" (#5859).");
    lines.push("");
    lines.push(...rowTableHeader);
    for (const row of report.noDataRows) lines.push(rowToTableLine(row));
  }

  if (report.zeroSpendRows.length > 0) {
    lines.push("");
    lines.push("### Gasto zero");
    lines.push("");
    lines.push(
      "Canal com leitores no snapshot mas gasto registrado R$ 0,00 (ex: linha placeholder antes da campanha rodar) — " +
        "custo zero não é eficiência infinita, então nunca entra no ranking acima (#5859).",
    );
    lines.push("");
    lines.push(...rowTableHeader);
    for (const row of report.zeroSpendRows) lines.push(rowToTableLine(row));
  }

  if (report.unattributedSpend.length > 0) {
    lines.push("");
    lines.push("## Gasto não atribuído");
    lines.push("");
    lines.push(
      "Linha(s) de `spend.csv` cujo canal não bateu com nenhum nome reconhecido — o gasto NUNCA vira uma linha " +
        "`measured`/n=0 fantasma (indistinguível de \"canal medido, zero leitores\"); fica aqui até o nome ser corrigido " +
        "no CSV ou uma spec nova entrar em `CHANNEL_KEY_SPECS` (#5860).",
    );
    lines.push("");
    lines.push("| Canal (como veio em spend.csv) | Gasto | Mês | Fonte |");
    lines.push("|---|---|---|---|");
    for (const entry of report.unattributedSpend) {
      lines.push(`| ${entry.label} | ${fmtBrl(entry.spend.valor)} | ${entry.spend.mes} | ${entry.spend.fonte} |`);
    }
    lines.push("");
    lines.push(`Nomes canônicos disponíveis: ${Object.keys(CHANNEL_GROUP_KEYS).join(", ")}, ou exatamente "Beehiiv Boosts".`);
  }

  // Funil por braço (§5 / §8.8 do protocolo 2608). Tabela separada de propósito:
  // a tabela acima já tem 13 colunas, e o funil responde outra pergunta — não
  // "quanto custou o leitor", mas "onde o cadastro parou".
  const measuredRows = report.rows.filter((r): r is Extract<CacRow, { kind: "measured" }> => r.kind === "measured");
  if (measuredRows.length > 0) {
    lines.push("");
    lines.push("### Funil por canal");
    lines.push("");
    lines.push(
      "Passo 3 da §5. `Pending` é o cadastro que clicou e não confirmou — o mais informativo " +
        "deste teste, e o segmento que o canal `brevo_diaria` mira (§7.3b).",
    );
    lines.push("");
    lines.push("| Canal | Sub-canal | Cadastros | Pending | % pending | Inativos | Invalid | Outros | Ativos | Leitores |");
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    for (const row of measuredRows) {
      const pctPending = row.cadastros > 0 ? fmtPct(row.pending / row.cadastros) : "—";
      lines.push(
        `| ${row.canal} | ${row.spend.subcanal ?? "—"} | ${row.cadastros} | ${row.pending} | ${pctPending} | ` +
          `${row.inativos} | ${row.invalid} | ${row.outrosStatus} | ${row.ativos} | ${row.leitores} |`,
      );
    }
  }

  lines.push("");
  lines.push(`Total medido (exclui estimativas): ${fmtBrl(report.totalGastoMedido)}.`);
  const boostRow = report.rows.find((r): r is Extract<CacRow, { kind: "boost-estimate" }> => r.kind === "boost-estimate");
  if (boostRow) lines.push(`${boostRow.canal}: ${boostRow.note}`);

  if (kitSection) {
    lines.push("");
    lines.push("## Cadastros no Kit por UTM (informativo, #7359)");
    lines.push("");
    if (!kitSection.applied) {
      lines.push(`⚠ seção Kit não aplicada: ${kitSection.reason}`);
    } else {
      lines.push(
        "O cadastro real nasce hoje majoritariamente no Kit (workers de assinatura), fora do snapshot Beehiiv " +
          "usado no relatório acima — esta tabela só confirma QUE o cadastro pago aparece, não ranqueia custo por " +
          "leitor (sem paridade de funil com a tabela principal; ver docstring do módulo).",
      );
      lines.push("");
      lines.push("```");
      lines.push(formatCountsTable(kitSection.result.counts, kitSection.result.total));
      lines.push("```");
    }
  }

  if (storeSection) {
    lines.push("");
    lines.push("## Leitores via store unificado (informativo, PARCIAL, #7393)");
    lines.push("");
    if (!storeSection.applied) {
      lines.push(`⚠ seção do store não aplicada: ${storeSection.reason}`);
    } else {
      const s = storeSection.summary;
      lines.push(
        "`leitor-v1` cross-plataforma (Beehiiv + Kit + Brevo diária já ingeridos), calculado sobre o store " +
          "unificado (`data/diaria-subscribers/diaria-subscribers.db`) — NÃO é substituto do funil Beehiiv acima " +
          "nem do custo por leitor: o store não tem, hoje, os mesmos campos de engajamento por-post que a tabela " +
          "principal usa (mesma ressalva registrada pro Kit no #7359), então esta seção mostra só o resumo " +
          "`leitor-v1`, sem ranquear custo por canal.",
      );
      lines.push("");
      lines.push(`Plataformas cobertas: ${s.platforms_counted.join(", ")}.`);
      lines.push(`Subscribers no store: ${s.total_subscribers}. Ativos: ${s.total_active}. Leitores-v1: ${s.leitores_v1}.`);
      if (s.subscription_data_coverage_low) {
        lines.push(
          `⚠ cobertura de dado de assinatura BAIXA — "leitores_v1"/"total_active" acima NÃO significam ` +
            `"zero leitores reais", significam "dado de assinatura pouco populado" (ver \`leitor-store.ts\`, #7198).`,
        );
      }
      lines.push(`${s.note}`);
    }
  }

  return lines.join("\n") + "\n";
}

function reportSpendErrorsToLines(errors: SpendRowError[]): string[] {
  return errors.map((e) => `[cac-report] spend.csv linha ${e.line}: ${e.reason}`);
}

/**
 * `rootDir` é onde `data/aquisicao/cac-reports/{id}.md` é escrito e onde o
 * relatório é registrado (`registerReport`) — SEPARADO de `args.backupRoot`
 * (que é só a leitura de snapshots, pode apontar pra qualquer lugar via
 * `--root`). Default `ROOT` (raiz real do projeto); testes injetam um
 * tmpdir aqui pra nunca escrever/registrar contra `data/reports/index.jsonl`
 * de verdade.
 *
 * Retorna o `CacReport` computado (ou `null` num caminho de erro/exit
 * antecipado) — adicionado em #8238 pra permitir que callers como
 * `scripts/ads-test-watch.ts` inspecionem o resultado (ex: guard de
 * cadastros zerados nos 3 braços) sem reparsear o markdown/arquivo
 * registrado. Chamadores existentes que ignoravam o retorno (`void`)
 * continuam funcionando sem alteração.
 */
export async function main(
  argv: string[] = process.argv.slice(2),
  rootDir: string = ROOT,
  now: () => Date = () => new Date(),
): Promise<CacReport | null> {
  const args = parseCacReportArgs(argv);

  if (!isValidCacReportFonte(args.fonte)) {
    console.error(`[cac-report] --fonte inválido: "${args.fonte}" (esperado um de: ${CAC_REPORT_FONTES.join(", ")}).`);
    process.exitCode = 1;
    return null;
  }
  const fonte = args.fonte;

  let window: CohortWindow | null;
  try {
    window = resolveCacReportWindow(args);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return null;
  }

  let spendResult: { rows: SpendRow[]; errors: SpendRowError[] };
  try {
    spendResult = readSpendCsv(args.spendPath);
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return null;
  }
  for (const line of reportSpendErrorsToLines(spendResult.errors)) console.error(line);
  if (spendResult.rows.length === 0) {
    console.error(`[cac-report] spend.csv não tem nenhuma linha válida — nada para reportar.`);
    process.exitCode = 1;
    return null;
  }

  const { index: origemIndex, applied: originApplied } = loadOrigemIndex(args.origemPath);

  let snapshotDate: string;
  let subs: BeehiivBackupSubscriber[];
  let internalFiltered: number;
  let previousSubs: BeehiivBackupSubscriber[] | undefined;
  // Só populado no ramo `beehiiv` (sinal de degradação vs. o snapshot
  // anterior) — `null` em `--fonte store`, onde não existe "anterior".
  let previousDate: string | null = null;

  if (fonte === "store") {
    // #8238: coorte inteira vem do store unificado (Kit + Beehiiv + Brevo
    // diária) — necessário pros canais "(teste 2608)", cujo cadastro nasce
    // no Kit e nunca aparece no snapshot Beehiiv. Sem "mais recente" nesta
    // fonte (o store é mutável, não datado em diretórios) — `--snapshot` é
    // obrigatório como rótulo/corte do relatório.
    if (!args.snapshotDate) {
      console.error(`[cac-report] --snapshot AAAA-MM-DD é obrigatório com --fonte store (rótulo/corte do relatório, #8238).`);
      process.exitCode = 1;
      return null;
    }
    snapshotDate = args.snapshotDate;
    const db = openDiariaSubscribersDbSafe(args.storeDbPath);
    if (!db) {
      console.error(`[cac-report] store não encontrado/ilegível em ${args.storeDbPath} (--fonte store).`);
      process.exitCode = 1;
      return null;
    }
    let rawStoreSubs: BeehiivBackupSubscriber[];
    try {
      rawStoreSubs = buildCacCompatibleSubscribersFromStore(db);
    } finally {
      db.close();
    }
    const overridden = applyOrigemOverride(rawStoreSubs, origemIndex);
    const filtered = filterInternalAndTestSubscribers(overridden);
    subs = filtered.kept;
    internalFiltered = filtered.removedCount;
    previousSubs = undefined; // sem snapshot anterior nesta fonte — sem sinal de degradação.
    if (subs.length === 0) {
      console.error(`[cac-report] store ${args.storeDbPath} não tem subscribers legíveis (--fonte store).`);
      process.exitCode = 1;
      return null;
    }
  } else {
    const dates = listSnapshotDates(args.backupRoot);
    const resolvedSnapshotDate = args.snapshotDate ?? latestSnapshotDate(args.backupRoot);
    if (!resolvedSnapshotDate) {
      console.error(`[cac-report] nenhum snapshot encontrado em ${args.backupRoot}.`);
      process.exitCode = 1;
      return null;
    }
    snapshotDate = resolvedSnapshotDate;
    const prepared = loadPreparedSubscribers(args.backupRoot, snapshotDate, origemIndex);
    subs = prepared.subs;
    internalFiltered = prepared.internalFiltered;
    if (subs.length === 0) {
      console.error(`[cac-report] snapshot ${snapshotDate} não tem subscribers legíveis em ${args.backupRoot}.`);
      process.exitCode = 1;
      return null;
    }
    // Snapshot anterior (pro sinal de degradação) — o segundo mais recente
    // ANTES de `snapshotDate` na lista ordenada ascendente, quando existir.
    const idx = dates.indexOf(snapshotDate);
    previousDate = idx > 0 ? dates[idx - 1] : null;
    previousSubs = previousDate ? loadPreparedSubscribers(args.backupRoot, previousDate, origemIndex).subs : undefined;
  }

  let report: CacReport;
  try {
    report = buildCacReport(spendResult.rows, subs, { previousSubs, originApplied, internalFiltered, window: window ?? undefined });
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
    return null;
  }
  const monthKey = snapshotDate.slice(0, 7); // "YYYY-MM-DD" -> "YYYY-MM"
  const budget = computeMonthBudgetUsage(spendResult.rows, monthKey, MONTHLY_BUDGET_FLOOR_BRL);
  const apuradoEm = now().toISOString();
  const provenance: CacReportProvenance = { apuradoEm, snapshotDate, fonte };

  // #8238: fail-soft, só quando a fonte É o snapshot Beehiiv — compara os
  // canais "(teste 2608)" contra o store pra detectar coorte perdida (ver
  // docstring do módulo e de `detectTeste2608BeehiivStoreMismatch`).
  const mismatchWarnings: string[] = fonte === "beehiiv" ? detectTeste2608BeehiivStoreMismatch(report, args.storeDbPath) : [];

  // #7359: seção informativa "Cadastros no Kit por UTM" — opt-out via
  // --no-kit; fail-soft por conta própria (loadKitUtmSection nunca lança).
  const kitSection: CacReportKitSection | undefined = args.kit
    ? await loadKitUtmSection()
    : undefined;

  // #7393: seção informativa "Leitores via store unificado" — opt-out via
  // --no-store-leitores; fail-soft por conta própria (loadStoreLeitorSection
  // nunca lança).
  const storeSection: CacReportStoreSection | undefined = args.storeLeitores
    ? loadStoreLeitorSection(args.storeDbPath)
    : undefined;

  if (args.json) {
    console.log(
      JSON.stringify({ snapshotDate, previousDate, report, budget, apuradoEm, fonte, mismatchWarnings, kitSection, storeSection }, null, 2),
    );
  } else {
    console.log(formatCacReportMarkdown(report, budget, provenance, kitSection, storeSection, mismatchWarnings));
  }

  if (args.register) {
    const markdown = formatCacReportMarkdown(report, budget, provenance, kitSection, storeSection, mismatchWarnings);
    const dir = resolve(rootDir, "data", "aquisicao", "cac-reports");
    mkdirSync(dir, { recursive: true });
    // Id inclui a janela quando --desde/--ate foi passado (#5495 — "duas
    // apurações não se sobrescreverem"): sem flags de janela, o id continua
    // igual a sempre (só `snapshotDate`) — comportamento OBSERVÁVEL
    // inalterado pro caso default, coberto pelos testes de regressão já
    // existentes. Com janela, o sufixo garante que rodar o relatório com
    // duas janelas diferentes no mesmo dia produz dois arquivos/registros
    // distintos em vez de um sobrescrever o outro silenciosamente.
    // #8238: `--fonte store` ganha sufixo próprio — sem isso, rodar
    // `--fonte store --snapshot 2026-09-17` sobrescreveria em silêncio um
    // relatório `--fonte beehiiv` já registrado com o mesmo rótulo de data.
    const id = cacReportSnapshotId(snapshotDate, fonte, args.desde, args.ate);
    const relPath = `data/aquisicao/cac-reports/${id}.md`;
    writeFileSync(resolve(rootDir, relPath), markdown, "utf8");
    const result = registerReport(rootDir, {
      kind: "cac",
      sessionId: id,
      title: `Custo por leitor por canal — snapshot ${snapshotDate}`,
      htmlPath: relPath,
    });
    if (!result.ok) {
      console.error(`[cac-report] aviso: registro do relatório falhou (fail-soft, #3714): ${result.error}`);
    } else {
      console.error(`[cac-report] registrado: ${reportId("cac", id)} → /relatorios/${reportId("cac", id)}`);
    }
  }

  // #5860 item 2: com --strict, gasto não atribuído é acionável NA HORA
  // (exit code diferente de 0) em vez de só um aviso em stderr que ninguém
  // relê depois. Checado por ÚLTIMO — nunca impede o relatório de ser
  // gerado/registrado, só sinaliza a falha pro caller (cron/task agendada)
  // depois que todo o resto já rodou.
  if (args.strict && report.unattributedSpend.length > 0) {
    console.error(
      `[cac-report] --strict: ${report.unattributedSpend.length} linha(s) de gasto não atribuído em spend.csv ` +
        `(${report.unmappedChannels.join(", ")}) — corrija o nome do canal ou cadastre uma spec nova.`,
    );
    process.exitCode = 1;
  }

  return report;
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`[cac-report] ERRO inesperado: ${(e as Error).message}`);
    process.exitCode = 1;
  });
}
