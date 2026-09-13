#!/usr/bin/env npx tsx
/**
 * scripts/upload-google-ads-enhanced-conversions.ts (#7770)
 *
 * Sobe conversões de cadastro (Enhanced Conversions for Leads, sem
 * `gclid`) pro Google Ads a partir de uma lista de `{ email,
 * signupTimestamp }` — o mecanismo pra recuperar as ~24 conversões perdidas
 * de 05-06/09/2026 (rótulo de conversão removido, ver #7523), e qualquer
 * outro lote futuro do mesmo tipo.
 *
 * ## O QUE ESTE SCRIPT NÃO FAZ (pendente, fora de escopo daqui — ver #7770)
 *
 *   1. Não habilita Enhanced Conversions for Leads na conta nem aceita os
 *      termos de dados do cliente — ação do editor no painel do Google Ads.
 *      Sem isso, `--send` vai falhar na chamada de rede.
 *   2. Não cria a ação de conversão de destino. `7418673798 Assinatura
 *      Confirmada` é `WEBPAGE_CODELESS` e NÃO aceita upload — é preciso
 *      criar uma ação `UPLOAD_CLICKS` (categoria `SIGNUP`) e passar o id
 *      dela em `--conversion-action-id`. Não há default: a issue não
 *      decidiu esse id ainda.
 *   3. Não gera a lista real de e-mails/timestamps de 05-06/09. Ver
 *      "Como derivar o input do Kit" abaixo.
 *
 * ## Formato do input (`--input`, CSV ou JSON — decidido pela extensão)
 *
 * CSV (cabeçalho obrigatório, nomes aceitos entre parênteses):
 *
 *   email,signup_timestamp
 *   seu@email.com,2026-09-05T14:30:00-03:00
 *
 * JSON (array de objetos):
 *
 *   [{ "email": "seu@email.com", "signupTimestamp": "2026-09-05T14:30:00-03:00" }]
 *
 * `gclid`/`wbraid`/`gbraid` são colunas/campos OPCIONAIS (#8023) — quando
 * presentes, sobem JUNTO com o hash do e-mail na mesma conversão (Enhanced
 * Conversions for Leads como parâmetro adicional ao click-id, não como
 * substituto):
 *
 *   email,signup_timestamp,gclid
 *   seu@email.com,2026-09-05T14:30:00-03:00,Cj0KCQjw...
 *
 * `signupTimestamp`/`signup_timestamp` PRECISA ser ISO 8601 com offset
 * explícito (não aceita "Z" implícito por omissão nem hora sem fuso) — o
 * valor vai direto pro `conversion_date_time` da API, preservando a hora
 * LOCAL do cadastro (não convertido pra UTC).
 *
 * ## Como derivar o input do Kit (passo manual, FORA deste script)
 *
 * O Kit tem e-mail + timestamp de cadastro (`created_at`) — exatamente o
 * que a Enhanced Conversions for Leads pede. Não gerado automaticamente
 * aqui de propósito (a issue #7770 pede que a lista real de 05-06/09 seja
 * "outro passo, feito por quem for executar"). Caminho sugerido, usando
 * `scripts/lib/kit-subscribers.ts`:
 *
 *   import { listKitSubscribersPage } from "./lib/kit-subscribers.ts";
 *   // paginar por `after` até `pagination.has_next_page` ser false;
 *   // filtrar subscribers com `created_at` entre 2026-09-05T00:00:00-03:00
 *   // e 2026-09-06T12:27:00-03:00 (o corte deste script) E cujo
 *   // `fields.utm_source` (ou o campo custom que o projeto usa pra
 *   // atribuição — ver `docs/definicao-leitor.md`/`kit-subscribers-ingest.ts`
 *   // pra qual campo carrega isso hoje) seja "google-ads";
 *   // montar { email: s.email_address, signupTimestamp: s.created_at }.
 *
 * Ou via API do Kit direto: `GET /v4/subscribers?created_after=2026-09-05&
 * created_before=2026-09-06`, paginado, filtrando pelo campo de atribuição
 * de UTM que o projeto já usa. Descartar SEMPRE os cadastros de teste do
 * editor antes ou depois — este script já descarta qualquer plus-address do
 * editor (Gmail pessoal, `vjpixel+<tag>`) automaticamente (ver
 * `isEditorTestEmail`), então não é estritamente
 * necessário filtrar na extração, mas reduz ruído no relatório de dry-run.
 *
 * ## Segurança
 *
 *   - `--dry-run` é o DEFAULT: imprime o payload completo, NENHUMA chamada
 *     de rede acontece (nem a renovação do access token). Só `--send`
 *     envia de verdade.
 *   - Corte de 2026-09-06T12:27:00-03:00: qualquer timestamp posterior
 *     recusa o LOTE INTEIRO (nada é enviado) a menos que
 *     `--allow-past-cutoff` seja passado — ver docstring de
 *     `validateSignupRecords` em `scripts/lib/google-ads-enhanced-conversions.ts`.
 *   - Qualquer plus-address do editor no Gmail pessoal (`vjpixel+<tag>`)
 *     nunca sobe como conversão — descartado silenciosamente (contado no resumo).
 *
 * ## Uso
 *
 *   npx tsx scripts/upload-google-ads-enhanced-conversions.ts \
 *     --input data/aquisicao/google-ads/enhanced-conversions-260905-06.csv \
 *     --conversion-action-id 999999999
 *     # dry-run — imprime o payload, não envia
 *
 *   npx tsx scripts/upload-google-ads-enhanced-conversions.ts \
 *     --input <mesmo arquivo> --conversion-action-id 999999999 --send
 *     # envia de verdade — requer as env vars GOOGLE_ADS_* (ver
 *     # docs/google-ads-api-setup.md)
 *
 * Requer no ambiente, só quando `--send` (dry-run não precisa de nenhuma):
 *   GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_REFRESH_TOKEN,
 *   GOOGLE_ADS_DEVELOPER_TOKEN, GOOGLE_ADS_LOGIN_CUSTOMER_ID
 * `--customer-id` (ou `GOOGLE_ADS_CUSTOMER_ID` no ambiente) é necessário
 * SEMPRE (inclusive em dry-run) quando `--conversion-action-id` for um id
 * numérico cru em vez de um resource name completo (`customers/.../
 * conversionActions/...`) — é o que permite montar o resource name.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import Papa from "papaparse";
import { getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { refreshGoogleAdsAccessToken, type GoogleAdsAuthConfig } from "./lib/google-ads-ingest.ts";
import {
  validateSignupRecords,
  buildUploadClickConversionsPayload,
  resolveConversionActionResourceName,
  parseSignupCsv,
  parseSignupJson,
  uploadClickConversions,
  type SignupRecordInput,
} from "./lib/google-ads-enhanced-conversions.ts";

const REQUIRED_SEND_ENV_VARS = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
] as const;

/** Lê e parseia o arquivo de input pela extensão (`.csv` ou `.json`).
 *  Lança com mensagem clara pra extensão não reconhecida. */
export function loadSignupRecords(inputPath: string, content: string): SignupRecordInput[] {
  const ext = extname(inputPath).toLowerCase();
  if (ext === ".json") return parseSignupJson(content);
  if (ext === ".csv") {
    const { records, parseErrors } = parseSignupCsv(content, (c) =>
      Papa.parse<Record<string, string>>(c, { header: true, skipEmptyLines: true }),
    );
    if (parseErrors.length > 0) {
      throw new Error(`erro(s) ao parsear CSV: ${parseErrors.join("; ")}`);
    }
    return records;
  }
  throw new Error(`extensão de arquivo não reconhecida (esperado .csv ou .json): ${inputPath}`);
}

function authConfigFromEnv(customerId: string): { auth: GoogleAdsAuthConfig } | { missing: string[] } {
  const missing = REQUIRED_SEND_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) return { missing };
  return {
    auth: {
      clientId: process.env.GOOGLE_ADS_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET!,
      refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN!,
      developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN!,
      loginCustomerId: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
      customerId,
      apiVersion: process.env.GOOGLE_ADS_API_VERSION,
    },
  };
}

export async function main(argv: string[] = process.argv.slice(2), fetchFn: typeof fetch = fetch): Promise<number> {
  loadProjectEnv();

  const inputPath = getStringArg(argv, "input", { example: "data/aquisicao/enhanced-conversions.csv" });
  if (!inputPath) {
    console.error("[upload-google-ads-enhanced-conversions] ✖ --input é obrigatório (caminho pro CSV/JSON de entrada).");
    return 1;
  }
  if (!existsSync(inputPath)) {
    console.error(`[upload-google-ads-enhanced-conversions] ✖ arquivo não encontrado: ${inputPath}`);
    return 1;
  }

  const conversionActionId = getStringArg(argv, "conversion-action-id", { example: "999999999" });
  if (!conversionActionId) {
    console.error(
      "[upload-google-ads-enhanced-conversions] ✖ --conversion-action-id é obrigatório — a ação " +
        "'Assinatura Confirmada' atual é WEBPAGE_CODELESS e não aceita upload; a issue #7770 ainda não " +
        "decidiu o id da ação UPLOAD_CLICKS dedicada.",
    );
    return 1;
  }

  const send = hasFlag(argv, "send");
  const allowPastCutoff = hasFlag(argv, "allow-past-cutoff");
  const customerIdFlag = getStringArg(argv, "customer-id", { example: "2369219639" });

  let records: SignupRecordInput[];
  try {
    records = loadSignupRecords(inputPath, readFileSync(inputPath, "utf8"));
  } catch (e) {
    console.error(`[upload-google-ads-enhanced-conversions] ✖ falha ao ler/parsear ${inputPath}: ${e instanceof Error ? e.message : e}`);
    return 1;
  }

  if (records.length === 0) {
    console.warn(`[upload-google-ads-enhanced-conversions] ${inputPath} não tem nenhum registro — nada a fazer.`);
    return 0;
  }

  const validation = validateSignupRecords(records, { allowPastCutoff });
  if (!validation.ok) {
    console.error(`[upload-google-ads-enhanced-conversions] ✖ ${validation.reason}`);
    for (const v of validation.violatingRows) {
      console.error(`  linha ${v.row} (${v.email}): ${v.reason}`);
    }
    return 1;
  }

  console.log(
    `[upload-google-ads-enhanced-conversions] ${validation.conversions.length} conversão(ões) válida(s) de ${records.length} linha(s) lida(s); ` +
      `${validation.skippedTestEmails.length} e-mail(s) de teste descartado(s); ${validation.skippedMalformed.length} linha(s) malformada(s) descartada(s).`,
  );
  for (const skipped of [...validation.skippedTestEmails, ...validation.skippedMalformed]) {
    console.log(`  descartado — linha ${skipped.row} (${skipped.email || "<vazio>"}): ${skipped.reason}`);
  }
  if (validation.pastCutoffCount > 0) {
    console.warn(
      `[upload-google-ads-enhanced-conversions] ⚠ ${validation.pastCutoffCount} conversão(ões) pós-corte incluída(s) por ` +
        `--allow-past-cutoff — confirme que esses cadastros específicos ainda não foram contados pela tag ao vivo antes de enviar.`,
    );
  }

  if (validation.conversions.length === 0) {
    console.warn("[upload-google-ads-enhanced-conversions] nenhuma conversão válida após os filtros — nada a enviar.");
    return 0;
  }

  const customerId = customerIdFlag ?? process.env.GOOGLE_ADS_CUSTOMER_ID;
  let conversionActionResourceName: string;
  if (conversionActionId.startsWith("customers/")) {
    conversionActionResourceName = conversionActionId;
  } else {
    if (!customerId) {
      console.error(
        "[upload-google-ads-enhanced-conversions] ✖ --conversion-action-id não é um resource name completo " +
          "e nem --customer-id nem GOOGLE_ADS_CUSTOMER_ID estão definidos — não dá pra montar " +
          "'customers/{id}/conversionActions/{id}'.",
      );
      return 1;
    }
    conversionActionResourceName = resolveConversionActionResourceName(customerId, conversionActionId);
  }

  const payload = buildUploadClickConversionsPayload(validation.conversions, { conversionActionResourceName });

  if (!send) {
    console.log("[upload-google-ads-enhanced-conversions] DRY-RUN (default) — nenhuma chamada de rede foi feita. Payload completo:");
    console.log(JSON.stringify(payload, null, 2));
    console.log("[upload-google-ads-enhanced-conversions] rode de novo com --send para enviar de verdade.");
    return 0;
  }

  if (!customerId) {
    console.error(
      "[upload-google-ads-enhanced-conversions] ✖ --send requer --customer-id ou GOOGLE_ADS_CUSTOMER_ID no ambiente " +
        "(usado no header login-customer-id/no path da chamada).",
    );
    return 1;
  }

  const configResult = authConfigFromEnv(customerId);
  if ("missing" in configResult) {
    console.error(
      `[upload-google-ads-enhanced-conversions] ✖ --send requer as variáveis de ambiente ausentes: ${configResult.missing.join(", ")}.`,
    );
    return 1;
  }

  const tokenResult = await refreshGoogleAdsAccessToken(fetchFn, configResult.auth);
  if ("error" in tokenResult) {
    console.error(`[upload-google-ads-enhanced-conversions] ✖ falha ao renovar access token: ${tokenResult.error}`);
    return 1;
  }

  const uploadResult = await uploadClickConversions(fetchFn, configResult.auth, tokenResult.accessToken, payload);
  if (!uploadResult.ok) {
    console.error(`[upload-google-ads-enhanced-conversions] ✖ upload falhou: ${uploadResult.error}`);
    return 1;
  }

  console.log(`[upload-google-ads-enhanced-conversions] ✔ ${validation.conversions.length} conversão(ões) enviada(s).`);
  console.log(JSON.stringify(uploadResult.response, null, 2));
  console.log(
    "[upload-google-ads-enhanced-conversions] match rate é PARCIAL por natureza (ECL casa só quando o usuário " +
      "estava logado no Google ao clicar) — conferir metrics.conversions em 24-48h, não esperar 100%.",
  );
  return 0;
}

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`[upload-google-ads-enhanced-conversions] ✖ erro inesperado: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    });
}
