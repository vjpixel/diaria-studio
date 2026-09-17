/**
 * scripts/meta-ads-ingest-spend.ts (#5469, #8239)
 *
 * CLI fino em cima de `scripts/lib/meta-ads-ingest.ts` (núcleo puro/
 * testável). Atualiza `data/aquisicao/spend.csv` (#5236) com as linhas do
 * canal `META_ADS_CANAL` abaixo — mantendo Google Ads/Microsoft
 * Advertising/LinkedIn/Beehiiv Boosts e qualquer mês fora do range
 * consultado intocados.
 *
 * ## Por que este script NÃO faz `fetch` (diferente de
 * `google-ads-ingest-spend.ts`/`microsoft-ads-ingest-spend.ts`)
 *
 * Google Ads e Microsoft Advertising expõem API REST com credencial
 * estática (`GOOGLE_ADS_*`/`MICROSOFT_ADS_*` no `.env`) — o script chama a
 * API sozinho. A Meta Ads MCP (`mcp__claude_ai_Meta_Ads__*`,
 * `mcp.facebook.com/ads`) só existe dentro de uma sessão do Claude Code —
 * não há `META_ADS_*` no ambiente nem endpoint REST documentado com key
 * própria pra este projeto (ver `docs/meta-ads-mcp-tools.md`). Por isso o
 * fluxo é em duas etapas:
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
 * ## Fail-soft — envelope ausente/inválido NUNCA quebra o relatório
 *
 * Sem `--input` (ou arquivo ausente/JSON inválido/envelope malformado),
 * este script imprime um aviso e sai com **exit 0**, deixando
 * `data/aquisicao/spend.csv` como estava — mesma disciplina de
 * `google-ads-ingest-spend.ts`/`microsoft-ads-ingest-spend.ts`.
 *
 * ## Uso
 *
 *   npx tsx scripts/meta-ads-ingest-spend.ts --input /path/to/ad-entities-dump.json
 *   npx tsx scripts/meta-ads-ingest-spend.ts --input dump.json --spend data/aquisicao/spend.csv
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule, getStringArg } from "./lib/cli-args.ts";
import { readSpendCsv, formatSpendCsv, type SpendRow } from "./lib/aquisicao-spend.ts";
import { runMetaAdsIngest } from "./lib/meta-ads-ingest.ts";

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

function fallback(reason: string): void {
  console.warn(`[meta-ads-ingest-spend] fallback pro CSV manual — ${reason}`);
  console.warn("  spend.csv não foi alterado. Editar manualmente se necessário.");
  console.warn(
    "  Ver docstring deste arquivo para como gerar o --input (dump de ads_get_ad_entities via sessão com o conector Meta Ads).",
  );
}

export async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const spendPath = getStringArg(argv, "spend") ?? DEFAULT_SPEND_CSV_PATH;
  const inputPath = getStringArg(argv, "input");

  if (!inputPath) {
    fallback("nenhum --input informado (Meta Ads não tem caminho REST com key própria — ver docstring)");
    return 0;
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
