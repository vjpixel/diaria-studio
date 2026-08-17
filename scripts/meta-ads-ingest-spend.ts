/**
 * scripts/meta-ads-ingest-spend.ts (#5469)
 *
 * CLI fino em cima de `scripts/lib/meta-ads-ingest.ts` (núcleo puro/
 * testável). Atualiza `data/aquisicao/spend.csv` (#5236) com as linhas do
 * canal `"Meta"` (nome canônico — `scripts/lib/cac.ts` →
 * `RESERVED_CHANNEL_NAMES`) — mantendo Google Ads/Microsoft
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

  const result = await runMetaAdsIngest({ envelopePayload, existingRows });

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
