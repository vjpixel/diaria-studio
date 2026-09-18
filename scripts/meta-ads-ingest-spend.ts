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
 * silêncio, sempre **exit 0** (mesmo contrato do Google/Microsoft: a task
 * agendada não pode calar a ingestão do canal vizinho por causa disto, ver
 * `scripts/lib/ads-spend-ingest-alarm.ts`).
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
 * ## Fail-soft — token ausente OU envelope ausente/inválido NUNCA quebra o
 * relatório
 *
 * Nos dois caminhos, qualquer estado inesperado (token ausente, API fora do
 * ar, `--input` ausente/JSON inválido/envelope malformado) imprime um aviso
 * e sai com **exit 0**, deixando `data/aquisicao/spend.csv` como estava —
 * mesma disciplina de `google-ads-ingest-spend.ts`/
 * `microsoft-ads-ingest-spend.ts`.
 *
 * ## Uso
 *
 *   npx tsx scripts/meta-ads-ingest-spend.ts                      # headless, requer META_ADS_ACCESS_TOKEN
 *   npx tsx scripts/meta-ads-ingest-spend.ts --input /path/to/ad-entities-dump.json
 *   npx tsx scripts/meta-ads-ingest-spend.ts --input dump.json --spend data/aquisicao/spend.csv
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import { runMetaAdsIngest } from "./lib/meta-ads-ingest.ts";
import { runSpendIngest, type SpendIngestFetchResult } from "./lib/spend-ingest.ts";
import { fetchMetaAdsChannelMetrics, metaAdsAuthConfigFromEnv } from "./lib/ads-campaign-economics-fetch.ts";
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
 *  frente. Formato final: `${META_ADS_HEADLESS_FONTE_LABEL}, N dia(s)
 *  (AAAA-MM-DD..AAAA-MM-DD), ingestão automática`. */
export const META_ADS_HEADLESS_FONTE_LABEL = "Meta Graph API insights (level=account, time_increment=1)";

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
 * **Janela vs. mês truncado (fora de escopo do #8245, latente aqui como no
 * Google — ver comentário da issue #8245 item 3):** `mergeSpendRows` troca a
 * linha `(canal, mes)` inteira; se a janela de `fetchMetaAdsChannelMetrics`
 * (default `lookbackDays=30`) começar NO MEIO de um mês, o agregado parcial
 * desse mês SUBSTITUI (não soma) o gasto real já registrado pros dias que
 * ficaram fora da janela — mesma borda já latente na janela de 90 dias do
 * Google (`buildDefaultGaqlQuery`), documentada e deliberadamente não
 * corrigida por nenhuma das duas unidades ainda.
 *
 * @pure
 */
export function aggregateMetaAdsChannelMetricsByMonth(metrics: ChannelDailyMetric[], canal: string, moeda = "BRL"): SpendRow[] {
  const byMonth = new Map<string, { sum: number; dates: string[] }>();

  for (const m of metrics) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(m.date)) continue;
    const mes = m.date.slice(0, 7);
    const entry = byMonth.get(mes) ?? { sum: 0, dates: [] };
    entry.sum += m.gastoBrl;
    entry.dates.push(m.date);
    byMonth.set(mes, entry);
  }

  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, { sum, dates }]) => {
      const sorted = dates.slice().sort();
      const first = sorted[0];
      const last = sorted.at(-1);
      const range = first === last ? first : `${first}..${last}`;
      return {
        canal,
        mes,
        moeda,
        valor: Math.round(sum * 100) / 100,
        fonte: `${META_ADS_HEADLESS_FONTE_LABEL}, ${dates.length} dia(s) (${range}), ingestão automática`,
      };
    });
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
 * motivo explícito, exit 0 — mesmo contrato do Google/Microsoft. `fetchImpl`
 * é injetável só pra teste (default `fetch` global), mesmo padrão de
 * `runGoogleAdsIngest(fetch, …)`.
 */
export async function runHeadless(spendPath: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  const authResult = metaAdsAuthConfigFromEnv();
  if ("missing" in authResult) {
    fallback(`variável(is) de ambiente ausente(s): ${authResult.missing.join(", ")}`);
    return 0;
  }

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

  const fetcher = async (): Promise<SpendIngestFetchResult> => {
    const fetchResult = await fetchMetaAdsChannelMetrics(fetchImpl, authResult.auth.accessToken);
    if (fetchResult.error) {
      networkErrorReason = `Graph API (Meta Ads insights) falhou — ${fetchResult.error}`;
      return { kind: "error", reason: networkErrorReason };
    }
    fetchedMetricsCount = fetchResult.metrics.length;
    const rows = aggregateMetaAdsChannelMetricsByMonth(fetchResult.metrics, META_ADS_CANAL);
    return { kind: "ok", rows, fetchedCount: fetchResult.metrics.length };
  };

  const result = await runSpendIngest({ fetcher, existingRows });

  if (result.kind === "fallback") {
    if (networkErrorReason !== null) {
      fallback(result.reason);
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

  if (!inputPath) {
    return await runHeadless(spendPath);
  }
  if (!existsSync(inputPath)) {
    fallback(`arquivo de --input não encontrado: ${inputPath}`);
    return 0;
  }

  let envelopePayload: unknown;
  try {
    envelopePayload = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (e) {
    fallback(`--input não é JSON válido: ${e instanceof Error ? e.message : e}`);
    return 0;
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
      // "nunca quebra o relatório" mesmo diante de um bug aqui.
      fallback(`erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(0);
    });
}
