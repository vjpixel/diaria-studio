/**
 * scripts/meta-ads-ingest-spend.ts (#5469, #8239, #8245)
 *
 * CLI fino em cima de `scripts/lib/meta-ads-ingest.ts` (núcleo puro/
 * testável). Atualiza `data/aquisicao/spend.csv` (#5236) com as linhas do
 * canal `META_ADS_CANAL` abaixo — mantendo Google Ads/Microsoft
 * Advertising/LinkedIn/Beehiiv Boosts e qualquer mês fora do range
 * consultado intocados.
 *
 * ## Dois caminhos — headless (REST, #8245) e manual (`--input`, #5469)
 *
 * **Sem `--input` (headless, #8245):** com `META_ADS_ACCESS_TOKEN` no
 * ambiente, este script chama `fetchMetaAdsChannelMetrics`
 * (`scripts/lib/ads-campaign-economics-fetch.ts`) — o MESMO fetch REST
 * (Graph API `act_{id}/insights?level=account&time_increment=1`, paginação,
 * System User token no header `Authorization`) que já alimenta o painel
 * `/ads` ao vivo desde #7536. Este script reusa a função, nunca reimplementa
 * fetch/auth/paginação — só agrega o `ChannelDailyMetric[]` diário
 * resultante por MÊS (`aggregateMetaAdsChannelMetricsByMonth` abaixo, este
 * arquivo) e passa por `mergeSpendRows`, igual Google/Microsoft
 * (`google-ads-ingest-spend.ts`/`microsoft-ads-ingest-spend.ts`). Sem
 * `META_ADS_ACCESS_TOKEN` no ambiente: `fallback()` com o motivo explícito
 * "variável(is) de ambiente ausente(s): META_ADS_ACCESS_TOKEN" — nunca
 * silêncio, e desde o #9012 **exit não-zero** (`META_ADS_INGEST_FAILURE_EXIT_CODE`
 * abaixo — esta task é independente, sair não-zero não cala canal vizinho).
 *
 * **Com `--input` (manual, #5469, inalterado por #8245):** a Meta Ads MCP
 * (`mcp__claude_ai_Meta_Ads__*`, `mcp.facebook.com/ads`) só existe dentro de
 * uma sessão do Claude Code — não há caminho REST com o nível de detalhe
 * (`ad_entities` por campanha) que esse fluxo manual usa. Continua em duas
 * etapas:
 *
 *   1. Uma sessão/agente com acesso ao conector Meta Ads chama
 *      `ads_get_ad_entities` (nível `campaign`, `fields: ["id", "name",
 *      "spend"]`, `time_increment: "monthly"`, `date_preset` ou
 *      `time_range` cobrindo o período desejado — usar
 *      `META_ADS_AD_ACCOUNT_ID` de `scripts/lib/meta-ads-ingest.ts`) e
 *      salva a resposta bruta (o envelope `{"ad_entities": "..."}`) num
 *      arquivo JSON.
 *   2. Este script lê esse arquivo via `--input` e faz parse → agregação →
 *      merge em `spend.csv`.
 *
 * ## Fail-soft nos DADOS, fail-loud no exit code (#9012)
 *
 * Nos dois caminhos, qualquer estado inesperado (token ausente, API fora do
 * ar depois do retry, `--input` ausente/JSON inválido/envelope malformado)
 * imprime um aviso e deixa `data/aquisicao/spend.csv` como estava — o
 * relatório (`cac-report.ts`) nunca quebra. Mas o processo sai com
 * `META_ADS_INGEST_FAILURE_EXIT_CODE` (não-zero), pra a unit systemd
 * aparecer como `failed` em vez de "sucesso" silencioso. Gasto zero real
 * segue exit 0. (Google/Microsoft adotaram o mesmo contrato no #9071.)
 *
 * ## Uso
 *
 *   npx tsx scripts/meta-ads-ingest-spend.ts                      # headless, requer META_ADS_ACCESS_TOKEN
 *   npx tsx scripts/meta-ads-ingest-spend.ts --since 2026-09-01   # recálculo (#9378): regrava os meses da janela
 *
 * ## Filtro por campanha (#9378)
 *
 * O headless consulta `level=campaign` filtrando por `platform.config.json`
 * → `meta_ads.campaign_ids` (a conta também roda a campanha do ingresso do
 * evento agente-ia desde 24/09/2026). `mergeSpendRows` substitui a linha
 * `(canal, mes)` inteira, então `--since` no dia 1 de um mês recalcula esse
 * mês do zero com o filtro — é o comando de recálculo do histórico.
 *   npx tsx scripts/meta-ads-ingest-spend.ts --input /path/to/ad-entities-dump.json
 *   npx tsx scripts/meta-ads-ingest-spend.ts --input dump.json --spend data/aquisicao/spend.csv
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import { runMetaAdsIngest } from "./lib/meta-ads-ingest.ts";
import {
  runSpendIngest,
  SPEND_INGEST_FAILURE_EXIT_CODE,
  SPEND_INGEST_FETCH_RETRY,
  spendIngestRetryOptions,
  type SpendIngestFetchResult,
} from "./lib/spend-ingest.ts";
import {
  fetchMetaAdsChannelMetrics,
  loadMetaAdsCampaignIds,
  metaAdsAuthConfigFromEnv,
  metaAdsDateRange,
  type MetaFetchLike,
} from "./lib/ads-campaign-economics-fetch.ts";
import { withFetchRetry } from "./lib/fetch-retry.ts";
import type { ChannelDailyMetric } from "./lib/ads-campaign-economics.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SPEND_CSV_PATH = resolve(ROOT, "data", "aquisicao", "spend.csv");

/**
 * Canal escrito em `spend.csv` (#8239, espelha #7544 Defeito 2 do
 * Microsoft) — precisa bater EXATO com a entrada correspondente em
 * `CHANNEL_KEY_SPECS` (`scripts/lib/shared/channel-key-specs.ts`) e em
 * `ADS_TEST_2608_BRACOS` (`scripts/lib/ads-test-run-state.ts`), senão a
 * linha cai no caminho "canal desconhecido" (`unknownCanais`, aviso em
 * stderr + n=0 no relatório) mesmo com gasto real acontecendo, e/ou
 * duplica o gasto do teste 2608 numa linha `Meta` avulsa que nenhum braço
 * do teste reconhece (achado ao vivo #8239 — mesmo defeito do Google já
 * confirmado em produção, aqui ainda LATENTE porque `meta-ads-ingest-spend.ts`
 * não tem task agendada). `runMetaAdsIngest` (`scripts/lib/meta-ads-ingest.ts`)
 * usa o default `META_ADS_CANAL = "Meta"` (`RESERVED_CHANNEL_NAMES`, não
 * `CHANNEL_KEY_SPECS`) quando nenhum `canal` é passado — nome reservado mas
 * SEM spec cadastrada, então nunca seria `measured`. Passar esta constante
 * explicitamente em `runMetaAdsIngest({ canal: META_ADS_CANAL, ... })`
 * evita esse caminho. Quando as specs temporárias "(teste 2608)" saírem
 * (decisão da #5862, prevista 08/10), este valor muda junto —
 * `test/meta-ads-ingest-spend.test.ts` trava que ele sempre bate com uma
 * entrada real de `CHANNEL_KEY_SPECS` E de `ADS_TEST_2608_BRACOS`.
 */
export const META_ADS_CANAL = "Meta Ads (teste 2608)";

/** Prefixo de `fonte` do caminho headless (#8245) — mesmo formato dos
 *  demais ingests automáticos (`google-ads-ingest-spend.ts`:
 *  `"... — GAQL cost_micros, N dia(s) (range), ingestão automática"`), só
 *  que sem o separador `—` porque este prefixo já descreve completamente a
 *  fonte (endpoint + parâmetros), sem precisar de um "label" curto na
 *  frente. Formato final (`runHeadless`, janela conhecida — #9413 item 3):
 *  `${META_ADS_HEADLESS_FONTE_LABEL}, N dia(s) (AAAA-MM-DD..AAAA-MM-DD),
 *  janela AAAA-MM-DD..AAAA-MM-DD, ingestão automática`; sem janela
 *  (chamador legado de `aggregateMetaAdsChannelMetricsByMonth`), sem o
 *  trecho `janela ...`. */
export const META_ADS_HEADLESS_FONTE_LABEL = "Meta Graph API insights (level=campaign, meta_ads.campaign_ids, time_increment=1)";

/**
 * Agrega `ChannelDailyMetric[]` (1 ponto por dia, vindo de
 * `fetchMetaAdsChannelMetrics` — `scripts/lib/ads-campaign-economics-fetch.ts`,
 * o mesmo fetch REST que já alimenta o `/ads` ao vivo) por MÊS, no formato
 * `SpendRow` que `spend.csv` espera. Distinto de `aggregateMetaAdsSpendByMonth`
 * (`scripts/lib/meta-ads-ingest.ts`), que parte do envelope MCP
 * `ads_get_ad_entities` do caminho `--input` — as duas fontes têm shape
 * diferente (`ChannelDailyMetric` já normalizado vs. `MetaAdsEntityRow`
 * bruto), então cada caminho tem seu próprio agregador; o merge final
 * (`mergeSpendRows`) é o único ponto genérico compartilhado pelos dois.
 * Linha sem `date` reconhecível é descartada — nunca contamina a soma como
 * `0` silencioso. **Na prática, via `runHeadless` abaixo, essa checagem
 * nunca dispara:** `fetchMetaAdsChannelMetrics`/`normalizeMetaAdsInsightsRows`
 * (`ads-campaign-economics-fetch.ts`, código COMPARTILHADO com o `/ads` ao
 * vivo) já descarta silenciosamente qualquer linha sem `date_start`
 * reconhecível ANTES de produzir `ChannelDailyMetric[]` — todo item que
 * chega aqui já passou por aquele mesmo regex. A checagem continua aqui
 * como defesa de contrato pra quem chamar esta função com outra fonte
 * (é exercida diretamente pelos testes puros com `ChannelDailyMetric[]`
 * sintético malformado), não porque o caminho real precise dela hoje.
 * Discard-visibility no ponto onde ele PODE de fato acontecer (dentro de
 * `normalizeMetaAdsInsightsRows`, compartilhado por Google/Microsoft/Meta)
 * é decisão de escopo maior — toca os 3 fetchers do `/ads` ao vivo, fora
 * desta PR (ver corpo do #8304).
 *
 * **Janela vs. mês truncado (#8245 item 3, corrigido aqui — Google segue
 * latente, `buildDefaultGaqlQuery` continua fora de escopo).** `mergeSpendRows`
 * troca a linha `(canal, mes)` inteira; se a janela de
 * `fetchMetaAdsChannelMetrics` (`lookbackDays` arbitrário via `--since`; o
 * default do cron sempre começa num dia 1, ver `defaultMetaAdsLookbackDays`) começar NO MEIO
 * de um mês, o agregado parcial desse mês SUBSTITUIRIA (não somaria) o
 * gasto real já registrado pros dias que ficaram fora da janela — ex:
 * rodada em 06/10 com janela iniciando 07/09 reescreveria setembro sem
 * 05-06/09. Esta função mitiga isso. **Sem `windowStart` (critério legado):**
 * quando há **2 ou mais meses distintos** no `metrics` recebido, o mês mais
 * ANTIGO só é incluído no resultado se o dia mais cedo com dado nesse mês for
 * o dia 1 — caso contrário essa linha
 * é DESCARTADA do retorno (nunca enviada a `mergeSpendRows`), preservando o
 * que já está em `spend.csv` pra esse mês. **O check é "começa no dia 1",
 * não "sem lacuna interna"** — confia no contrato de `fetchMetaAdsChannelMetrics`
 * (janela contígua dia a dia, sem buracos no meio); se esse contrato
 * mudasse (paginação parcial, filtro que pulasse dias), um mês com dia 1
 * presente mas um buraco no meio passaria pelo check sem ser pego — fora do
 * que este guard cobre hoje. Com apenas 1 mês presente (o caso comum:
 * janela inteira dentro do mês corrente), nada é descartado — é o mesmo
 * comportamento incremental que Google/Microsoft já têm pro mês em
 * andamento, sem risco de perda porque não há um mês MAIS RECENTE que
 * comprove que a cobertura do mês antigo é de fato parcial.
 *
 * **`windowStart` (#9378):** quando o chamador sabe onde a JANELA consultada
 * começou (`AAAA-MM-DD`), o guard usa ela em vez do primeiro dia COM DADO.
 * Sem isso, uma campanha que só começou a gastar no meio do mês (a da
 * newsletter começou em ~19/09) nunca regravava aquele mês nem com
 * `--since` no dia 1 — o mês ficava com o agregado antigo da conta inteira,
 * exatamente o valor errado que o recálculo existe pra corrigir. Com
 * `windowStart` ≤ dia 1 do mês mais antigo, a janela cobre o mês inteiro e
 * a ausência de dados nos primeiros dias é gasto zero real, não truncamento.
 * Com `windowStart` o check vale **mesmo com 1 mês só** nos dados: a janela
 * prova o truncamento sozinha (ex: campanha pausada o mês corrente inteiro e
 * janela de 30 dias começando 11/09 — antes, setembro seria regravado só com
 * 11–30/09 a cada rodada). Formato `AAAA-MM-DD` em UTC, mesma convenção de
 * `metaAdsDateRange` (`ads-campaign-economics-fetch.ts`); comparação
 * lexicográfica, então valor fora desse formato quebra o guard.
 *
 * **Mês sem gasto dentro da janela (#9413):** com `windowStart` conhecido,
 * todo mês INTEIRAMENTE coberto pela janela (do 1º mês cujo dia 1 está na
 * janela até o mês de `windowEnd` — ou, sem `windowEnd`, até o mês mais
 * recente com dado) que não tenha nenhuma linha sai com `valor: 0`. Antes
 * esse mês nem entrava no retorno e `mergeSpendRows` mantinha a linha antiga
 * (ex: `--since 2026-08-01` não tocava agosto se a campanha da newsletter
 * não gastou lá, e o agregado `level=account` antigo ficava). O mês de
 * `windowEnd` é o mês em andamento: 0 é o gasto real até ali, mesmo
 * contrato incremental de quando há dado. Sem `windowStart`, nada é
 * preenchido (a janela é desconhecida, ausência de linha não prova zero).
 * Também nada é preenchido quando NENHUMA linha datada chegou: resposta
 * inteiramente vazia é indistinguível de schema drift (linhas sem
 * `date_start` já descartadas upstream) e zerar ali apagaria gasto real —
 * esse caso segue o banner "sem gasto, spend.csv intocado".
 *
 * @pure
 */
export function aggregateMetaAdsChannelMetricsByMonth(
  metrics: ChannelDailyMetric[],
  canal: string,
  moeda = "BRL",
  windowStart?: string,
  windowEnd?: string,
): SpendRow[] {
  const byMonth = new Map<string, { sum: number; dates: string[] }>();

  for (const m of metrics) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) continue;
    const mes = m.date.slice(0, 7);
    const entry = byMonth.get(mes) ?? { sum: 0, dates: [] };
    entry.sum += m.gastoBrl;
    entry.dates.push(m.date);
    byMonth.set(mes, entry);
  }

  // #8245 item 3: com 2+ meses no resultado, o mais ANTIGO pode ser um
  // fragmento da janela (ela começou no meio dele) — descartar em vez de
  // deixar `mergeSpendRows` sobrescrever a linha completa já existente.
  const mesesOrdenados = [...byMonth.keys()].sort();
  if (windowStart !== undefined) {
    // #9378: a janela prova o truncamento, com 1 mês ou mais nos dados.
    const maisAntigo = mesesOrdenados[0];
    if (maisAntigo !== undefined && windowStart > `${maisAntigo}-01`) byMonth.delete(maisAntigo);
  } else if (mesesOrdenados.length >= 2) {
    const maisAntigo = mesesOrdenados[0];
    const primeiroDia = byMonth.get(maisAntigo)!.dates.slice().sort()[0];
    if (primeiroDia.slice(8, 10) !== "01") byMonth.delete(maisAntigo);
  }

  // #9413: meses inteiros da janela sem nenhuma linha → valor 0 explícito.
  // Só com ≥1 linha datada: resposta 100% vazia pode ser schema drift
  // (`normalizeMetaAdsInsightsRows` descarta linha sem `date_start`) e não
  // pode zerar meses reais — esse caso segue "sem gasto, spend.csv intocado".
  const zeroMonths =
    windowStart !== undefined && mesesOrdenados.length > 0
      ? monthsFullyCoveredByWindow(windowStart, windowEnd, mesesOrdenados.at(-1))
      : [];
  const janela = `${windowStart}..${windowEnd ?? ""}`;
  const janelaSuffix = windowStart !== undefined ? `, janela ${janela}` : "";
  for (const mes of zeroMonths) if (!byMonth.has(mes)) byMonth.set(mes, { sum: 0, dates: [] });

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, { sum, dates }]) => {
      if (dates.length === 0) {
        return {
          canal,
          mes,
          moeda,
          valor: 0,
          fonte: `${META_ADS_HEADLESS_FONTE_LABEL}, 0 dia(s) com gasto na janela ${janela}, ingestão automática`,
        };
      }
      const sorted = dates.slice().sort();
      const first = sorted[0];
      const last = sorted.at(-1);
      const range = first === last ? first : `${first}..${last}`;
      return {
        canal,
        mes,
        moeda,
        valor: Math.round(sum * 100) / 100,
        // #9413 item 3: com a janela conhecida, ela vai na `fonte` — sem isso
        // "N dia(s) (19..30/09)" parece mês truncado mesmo quando a janela
        // cobriu desde o dia 1 (o mês só não teve gasto antes do dia 19).
        fonte: `${META_ADS_HEADLESS_FONTE_LABEL}, ${dates.length} dia(s) (${range})${janelaSuffix}, ingestão automática`,
      };
    });
}

/** Meses `AAAA-MM` cujo dia 1 está dentro da janela (`windowStart` ≤ dia 1),
 *  do primeiro até o mês de `windowEnd` (ou `fallbackLast` sem `windowEnd`).
 *  Formato inválido → `[]`. @pure */
function monthsFullyCoveredByWindow(windowStart: string, windowEnd: string | undefined, fallbackLast: string | undefined): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) return [];
  const last = windowEnd !== undefined ? windowEnd.slice(0, 7) : fallbackLast;
  if (last === undefined || !/^\d{4}-\d{2}$/.test(last)) return [];
  let y = Number(windowStart.slice(0, 4));
  let mo = Number(windowStart.slice(5, 7));
  if (windowStart.slice(8, 10) !== "01") {
    mo++;
    if (mo > 12) { mo = 1; y++; }
  }
  const out: string[] = [];
  for (;;) {
    const mes = `${y}-${String(mo).padStart(2, "0")}`;
    if (mes > last) break;
    out.push(mes);
    mo++;
    if (mo > 12) { mo = 1; y++; }
  }
  return out;
}

/**
 * Exit code de FALHA REAL (#9012) — token ausente, Graph API indisponível
 * depois de esgotar o retry, `--input` ausente/inválido, erro inesperado.
 * Antes do #9012 este script saía 0 em toda falha (herança do contrato
 * Google/Microsoft #5237/#5502), então a unit systemd
 * `diaria-meta-ads-spend-ingest.service` sempre terminava "sucesso" e o
 * único sinal era o banner no log, lido 11min depois pelo
 * `Diaria-Ads-Spend-Ingest-Alarm`. A justificativa original do exit 0
 * ("não calar a plataforma vizinha") não se aplica aqui: esta task tem UM
 * step só e roda como unit INDEPENDENTE (`scripts/lib/scheduled-tasks.ts`)
 * — sair não-zero não cala nenhum outro canal, e deixa a falha visível no
 * `systemctl --state=failed` (#5563) além do alarme. Gasto zero real
 * ("API respondeu, sem gasto no período") continua exit 0: não é falha.
 * Desde o #9071 é alias de `SPEND_INGEST_FAILURE_EXIT_CODE`
 * (`scripts/lib/spend-ingest.ts`), o mesmo contrato do Google/Microsoft.
 */
export const META_ADS_INGEST_FAILURE_EXIT_CODE = SPEND_INGEST_FAILURE_EXIT_CODE;

/**
 * Retry da Graph API no caminho headless (#9012). Causa raiz do alarme de
 * 29/09/2026 12:54 UTC: o `300` perdeu resolução DNS por alguns minutos
 * (o mesmo run registrou "Could not resolve host" no git-sync) e a ÚNICA
 * chamada à Graph API, sem retry, falhou com `fetch failed` — Google
 * (12:50) e Microsoft (12:52) tinham passado minutos antes. Erro de rede e
 * 5xx são retentados (`fetchWithRetry`; 4xx nunca: token inválido é achado
 * real, não blip). Pior caso por página: 125s de backoff + 4×30s de
 * timeout ≈ 4min — com a paginação típica (1 página) cabe antes do alarme
 * das 10:05 BRT (task às 09:54 BRT). O timeout cobre só até os headers;
 * a leitura do corpo (`res.json()` em `fetchMetaAdsChannelMetrics`) fica
 * fora dele — resposta pequena, risco aceito. Um `init.signal` do
 * chamador seria substituído (nenhum chamador passa um hoje). Desde o
 * #9071 é alias de `SPEND_INGEST_FETCH_RETRY`, compartilhado com os
 * ingests Google/Microsoft.
 */
export const META_ADS_FETCH_RETRY = SPEND_INGEST_FETCH_RETRY;

/** Até que dia (UTC) do mês a janela default ainda volta ao mês anterior
 *  (#9459). Cobre a virada (fecha o mês fechado com o último dia) e alguns
 *  dias de folga pra cron que falhou, sem regravar o mês anterior o mês todo. */
export const META_ADS_PREV_MONTH_REACH_DAYS = 5;

/**
 * Janela default do cron (#9459). A antiga janela móvel de 30 dias + o guard
 * de mês truncado só gravavam o mês M na rodada em que a janela começava em
 * `M-01` (dia 30): as de 31/10 e 01/11 descartavam outubro e o fim do mês
 * nunca chegava ao `spend.csv`. Agora a janela SEMPRE começa num dia 1 (UTC),
 * então o guard nunca descarta o mês corrente:
 *  - dia 1..`META_ADS_PREV_MONTH_REACH_DAYS`: desde o dia 1 do mês ANTERIOR —
 *    o mês recém-fechado é regravado inteiro (inclusive o último dia);
 *  - depois disso: desde o dia 1 do mês corrente — o mês anterior (já
 *    fechado) não é mais tocado, preservando reconciliação manual e evitando
 *    que o zero-fill do #9413 grave 0 sobre ele o mês inteiro.
 * O painel `/ads` segue com os 30 dias de `fetchMetaAdsChannelMetrics`. @pure
 */
export function defaultMetaAdsLookbackDays(now: Date): number {
  const monthOffset = now.getUTCDate() <= META_ADS_PREV_MONTH_REACH_DAYS ? 1 : 0;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthOffset, 1);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((today - start) / 86_400_000) + 1;
}

export interface RunHeadlessOptions {
  /** Injetável só pra teste — nunca espera de verdade fora de produção. */
  sleep?: (ms: number) => Promise<void>;
  /** Janela da consulta (#9378) — default desde o dia 1 do mês anterior
   *  (`defaultMetaAdsLookbackDays`, #9459).
   *  `--since AAAA-MM-DD` do CLI vira isto via `lookbackDaysSince`. */
  lookbackDays?: number;
  /** Injetável só pra teste (default `new Date()`). */
  now?: Date;
  /** Override das campanhas (#9378) — default `platform.config.json` →
   *  `meta_ads.campaign_ids`. Só pra teste. */
  campaignIds?: readonly string[];
  /** Caminho do `platform.config.json` lido quando `campaignIds` não vem
   *  (#9413) — default o da raiz do repo. Só pra teste. */
  campaignConfigPath?: string;
}

/**
 * `--since AAAA-MM-DD` → `lookbackDays` inclusivo até `now` (#9378, recálculo
 * do histórico). `null` se a data for inválida ou futura. Pra regravar um mês
 * inteiro, `since` precisa ser o dia 1 dele: o guard de mês truncado
 * (`aggregateMetaAdsChannelMetricsByMonth`) descarta o mês mais antigo da
 * janela quando ela não começa no dia 1 — e desde o fix do #9378 olha o
 * início da JANELA, não o primeiro dia com gasto. @pure
 */
export function lookbackDaysSince(since: string, now: Date): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) return null;
  const start = Date.parse(`${since}T00:00:00Z`);
  if (!Number.isFinite(start)) return null;
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00Z`);
  const days = Math.round((today - start) / 86_400_000) + 1;
  return days >= 1 ? days : null;
}

/** Envolve `fetchImpl` com `withFetchRetry` preservando a assinatura que
 *  `fetchMetaAdsChannelMetrics` espera (cada página da paginação ganha o
 *  próprio retry). */
export function withMetaAdsFetchRetry(fetchImpl: MetaFetchLike, sleep?: (ms: number) => Promise<void>): MetaFetchLike {
  return withFetchRetry(fetchImpl, spendIngestRetryOptions(sleep));
}

function fallback(reason: string): void {
  console.warn(`[meta-ads-ingest-spend] fallback pro CSV manual — ${reason}`);
  console.warn("  spend.csv não foi alterado. Editar manualmente se necessário.");
  console.warn(
    "  Ver docstring deste arquivo para como gerar o --input (dump de ads_get_ad_entities via sessão com o conector Meta Ads), ou configurar META_ADS_ACCESS_TOKEN pro caminho headless.",
  );
}

/**
 * Caminho headless (#8245) — sem `--input`. Com `META_ADS_ACCESS_TOKEN` no
 * ambiente, busca via `fetchMetaAdsChannelMetrics` (reuso do fetch REST do
 * `/ads`, sem reimplementar auth/paginação) e grava em `spend.csv` via
 * `runSpendIngest`/`mergeSpendRows` (`scripts/lib/spend-ingest.ts`) — o
 * mesmo núcleo genérico fetch→merge que `google-ads-ingest.ts`/
 * `microsoft-ads-ingest.ts` já usam, em vez de reimplementar a orquestração
 * aqui (achado do code-review da PR #8304). Sem o token: `fallback()` com o
 * motivo explícito e `META_ADS_INGEST_FAILURE_EXIT_CODE` (#9012). Cada
 * chamada à Graph API passa por `withMetaAdsFetchRetry` (#9012). `fetchImpl`
 * e `opts.sleep` são injetáveis só pra teste (default `fetch` global),
 * mesmo padrão de `runGoogleAdsIngest(fetch, …)`.
 */
export async function runHeadless(
  spendPath: string,
  fetchImpl: MetaFetchLike = fetch,
  opts: RunHeadlessOptions = {},
): Promise<number> {
  const authResult = metaAdsAuthConfigFromEnv();
  if ("missing" in authResult) {
    fallback(`variável(is) de ambiente ausente(s): ${authResult.missing.join(", ")}`);
    return META_ADS_INGEST_FAILURE_EXIT_CODE;
  }
  const retryingFetch = withMetaAdsFetchRetry(fetchImpl, opts.sleep);

  // `data/` é a junction OneDrive (#5236) — pode estar ausente num worktree
  // sem o setup local; garantir o diretório antes de ler/escrever o CSV,
  // sem assumir que já existe.
  const spendDir = dirname(spendPath);
  if (!existsSync(spendDir)) mkdirSync(spendDir, { recursive: true });
  const existingRows: SpendRow[] = existsSync(spendPath) ? readSpendCsv(spendPath).rows : [];

  // `runSpendIngest` colapsa "fetcher devolveu erro de rede/API" e "fetcher
  // devolveu rows: [] de propósito (gasto zero real)" no mesmo
  // `{kind:"fallback"}` (só carrega `reason: string`) — `networkErrorReason`
  // viaja por fora do closure pra distinguir os dois na hora de escolher o
  // banner certo, sem recorrer a inspecionar o texto de `result.reason`.
  let networkErrorReason: string | null = null;
  let fetchedMetricsCount = 0;

  // Mesmo `now`/janela pro fetch e pro guard de mês truncado (#9378) — o
  // guard precisa saber onde a JANELA começou, não só o primeiro dia com dado.
  const now = opts.now ?? new Date();
  const lookbackDays = opts.lookbackDays ?? defaultMetaAdsLookbackDays(now);
  // #9413 item 4: mesmo helper que monta o `time_range` do fetch — a janela
  // do guard nunca diverge da janela consultada.
  const { since: windowStart, until: windowEnd } = metaAdsDateRange(now, lookbackDays);

  // #9413: config de campanhas ilegível é falha explícita, nunca `level=account`
  // silencioso — e o `level` efetivamente usado vai pro log.
  let campaignIds: readonly string[];
  try {
    campaignIds = opts.campaignIds ?? loadMetaAdsCampaignIds(opts.campaignConfigPath);
  } catch (e) {
    fallback(`config de campanhas Meta ilegível — ${e instanceof Error ? e.message : e}`);
    return META_ADS_INGEST_FAILURE_EXIT_CODE;
  }
  if (campaignIds.length > 0) {
    console.log(`[meta-ads-ingest-spend] level=campaign (${campaignIds.length} campanha(s) de meta_ads.campaign_ids)`);
  } else {
    console.warn(
      "[meta-ads-ingest-spend] level=account — meta_ads.campaign_ids ausente/vazio em platform.config.json: gasto da CONTA INTEIRA (inclui campanhas que não são da newsletter)",
    );
  }

  const fetcher = async (): Promise<SpendIngestFetchResult> => {
    const fetchResult = await fetchMetaAdsChannelMetrics(retryingFetch, authResult.auth.accessToken, {
      lookbackDays,
      now,
      campaignIds,
    });
    if (fetchResult.error) {
      networkErrorReason = `Graph API (Meta Ads insights) falhou — ${fetchResult.error}`;
      return { kind: "error", reason: networkErrorReason };
    }
    fetchedMetricsCount = fetchResult.metrics.length;
    const rows = aggregateMetaAdsChannelMetricsByMonth(fetchResult.metrics, META_ADS_CANAL, "BRL", windowStart, windowEnd);
    // #9378: mês descartado pelo guard nunca some em silêncio — diz qual e como regravar.
    const kept = new Set(rows.map((r) => r.mes));
    for (const mes of new Set(fetchResult.metrics.map((x) => x.date.slice(0, 7)))) {
      if (/^\d{4}-\d{2}$/.test(mes) && !kept.has(mes)) {
        console.warn(
          `[meta-ads-ingest-spend] ${mes} não regravado: a janela começa em ${windowStart} (mês truncado). Pra recalcular o mês inteiro: --since ${mes}-01`,
        );
      }
    }
    return { kind: "ok", rows, fetchedCount: fetchResult.metrics.length };
  };

  const result = await runSpendIngest({ fetcher, existingRows });

  if (result.kind === "fallback") {
    if (networkErrorReason !== null) {
      fallback(result.reason);
      return META_ADS_INGEST_FAILURE_EXIT_CODE;
    } else {
      // A API respondeu com sucesso, só não achou métrica nenhuma no
      // range — gasto zero real, nunca falha externa; banner de sucesso,
      // não o warning genérico de fallback.
      console.log("[meta-ads-ingest-spend] ✔ API respondeu, sem gasto no período consultado.");
      console.log("  Não é falha: spend.csv fica como está porque não há gasto a registrar.");
    }
    return 0;
  }

  writeFileSync(spendPath, formatSpendCsv(result.rows), "utf8");
  console.log(
    `[meta-ads-ingest-spend] ✔ ${spendPath} atualizado (${fetchedMetricsCount} linha(s) diárias da Graph API insights agregadas).`,
  );
  return 0;
}

export async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const spendPath = getStringArg(argv, "spend") ?? DEFAULT_SPEND_CSV_PATH;
  const inputPath = getStringArg(argv, "input");

  const since = getStringArg(argv, "since");

  if (!inputPath) {
    if (since === undefined) return await runHeadless(spendPath);
    // Um `now` só pro cálculo da janela e pro fetch (#9378): dois `new Date()`
    // em lados opostos da meia-noite UTC deslocariam o início da janela 1 dia.
    const now = new Date();
    const lookbackDays = lookbackDaysSince(since, now);
    if (lookbackDays === null) {
      fallback(`--since inválido (esperado AAAA-MM-DD, não futuro): ${since}`);
      return META_ADS_INGEST_FAILURE_EXIT_CODE;
    }
    return await runHeadless(spendPath, fetch, { lookbackDays, now });
  }
  if (!existsSync(inputPath)) {
    fallback(`arquivo de --input não encontrado: ${inputPath}`);
    return META_ADS_INGEST_FAILURE_EXIT_CODE;
  }

  let envelopePayload: unknown;
  try {
    envelopePayload = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (e) {
    fallback(`--input não é JSON válido: ${e instanceof Error ? e.message : e}`);
    return META_ADS_INGEST_FAILURE_EXIT_CODE;
  }

  // `data/` é a junction OneDrive (#5236) — pode estar ausente num worktree
  // sem o setup local; garantir o diretório antes de ler/escrever o CSV,
  // sem assumir que já existe.
  const spendDir = dirname(spendPath);
  if (!existsSync(spendDir)) mkdirSync(spendDir, { recursive: true });

  const existingRows: SpendRow[] = existsSync(spendPath) ? readSpendCsv(spendPath).rows : [];

  const result = await runMetaAdsIngest({ envelopePayload, existingRows, canal: META_ADS_CANAL });

  if (result.kind === "fallback") {
    fallback(result.reason);
    return META_ADS_INGEST_FAILURE_EXIT_CODE;
  }
  if (result.kind === "empty") {
    console.log("[meta-ads-ingest-spend] ✔ envelope válido, sem gasto no período — spend.csv fica como está.");
    return 0;
  }

  writeFileSync(spendPath, formatSpendCsv(result.rows), "utf8");
  console.log(
    `[meta-ads-ingest-spend] ✔ ${spendPath} atualizado (${result.fetchedRows} linha(s) de ad_entities agregadas).`,
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      // Último caminho que escaparia como stack cru — nunca deveria chegar
      // aqui (parse e merge já são fail-soft), mas mantém a disciplina
      // "spend.csv intocado" mesmo diante de um bug aqui; exit não-zero
      // (#9012) pra a unit não reportar sucesso.
      fallback(`erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(META_ADS_INGEST_FAILURE_EXIT_CODE);
    });
}
