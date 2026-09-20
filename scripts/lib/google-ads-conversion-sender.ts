/**
 * scripts/lib/google-ads-conversion-sender.ts (#8555)
 *
 * Parte de ENVIO extraída de `scripts/upload-google-ads-enhanced-conversions.ts`
 * (#7770) pra ser compartilhada com o lote de confirmação
 * (`scripts/upload-google-ads-confirmations.ts`): resolução do resource name
 * da ação de conversão, montagem da config de auth a partir do ambiente,
 * renovação do access token e o POST `uploadClickConversions`. O CLI antigo
 * fica por cima, só com parsing de input e mensagens.
 *
 * Nenhuma função aqui lê o ambiente sozinha nem toca disco: `env` e
 * `fetchFn` são injetados, então tudo é testável com mocks — nunca há
 * chamada de rede em teste.
 *
 * Guard de publicação (`context/overnight-dispatch-rules.md` item 1): este
 * módulo É o caminho de escrita na Google Ads API. Só é alcançado por CLIs em
 * modo `--send` explícito; nenhum teste ou sessão de desenvolvimento o
 * executa contra a API real.
 */

import { refreshGoogleAdsAccessToken, type GoogleAdsAuthConfig } from "./google-ads-ingest.ts";
import {
  resolveConversionActionResourceName,
  uploadClickConversions,
  type UploadClickConversionsPayload,
} from "./google-ads-enhanced-conversions.ts";

export const REQUIRED_SEND_ENV_VARS = [
  "GOOGLE_ADS_CLIENT_ID",
  "GOOGLE_ADS_CLIENT_SECRET",
  "GOOGLE_ADS_REFRESH_TOKEN",
  "GOOGLE_ADS_DEVELOPER_TOKEN",
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID",
] as const;

type Env = Record<string, string | undefined>;

/** Monta a config de auth a partir do `env` injetado; devolve as variáveis
 *  ausentes quando incompleto. @pure */
export function authConfigFromEnv(
  env: Env,
  customerId: string,
): { auth: GoogleAdsAuthConfig } | { missing: string[] } {
  const missing = REQUIRED_SEND_ENV_VARS.filter((name) => !env[name]);
  if (missing.length > 0) return { missing };
  return {
    auth: {
      clientId: env.GOOGLE_ADS_CLIENT_ID!,
      clientSecret: env.GOOGLE_ADS_CLIENT_SECRET!,
      refreshToken: env.GOOGLE_ADS_REFRESH_TOKEN!,
      developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN!,
      loginCustomerId: env.GOOGLE_ADS_LOGIN_CUSTOMER_ID!,
      customerId,
      apiVersion: env.GOOGLE_ADS_API_VERSION,
    },
  };
}

/** Resolve o resource name da ação. Id cru exige `customerId`. @pure */
export function resolveActionResourceName(
  conversionActionId: string,
  customerId: string | undefined,
): { ok: true; resourceName: string } | { ok: false; error: string } {
  if (conversionActionId.startsWith("customers/")) return { ok: true, resourceName: conversionActionId };
  if (!customerId) {
    return {
      ok: false,
      error:
        "--conversion-action-id não é um resource name completo e nem --customer-id nem " +
        "GOOGLE_ADS_CUSTOMER_ID estão definidos — não dá pra montar 'customers/{id}/conversionActions/{id}'.",
    };
  }
  return { ok: true, resourceName: resolveConversionActionResourceName(customerId, conversionActionId) };
}

export type SendPayloadResult =
  | { ok: true; response: unknown }
  | { ok: false; stage: "customer-id" | "env" | "token" | "upload"; error: string; missing?: string[] };

/**
 * Renova o token e faz o POST do payload. Nunca lança; toda falha vira
 * `{ ok: false, stage, error }`. `stage` diz onde parou (nada foi enviado em
 * `customer-id`/`env`/`token`).
 */
export async function sendConversionPayload(opts: {
  fetchFn: typeof fetch;
  env: Env;
  customerId: string | undefined;
  payload: UploadClickConversionsPayload;
}): Promise<SendPayloadResult> {
  if (!opts.customerId) {
    return {
      ok: false,
      stage: "customer-id",
      error: "--send requer --customer-id ou GOOGLE_ADS_CUSTOMER_ID no ambiente (usado no header login-customer-id/no path da chamada).",
    };
  }
  const configResult = authConfigFromEnv(opts.env, opts.customerId);
  if ("missing" in configResult) {
    return {
      ok: false,
      stage: "env",
      error: `--send requer as variáveis de ambiente ausentes: ${configResult.missing.join(", ")}.`,
      missing: configResult.missing,
    };
  }
  const tokenResult = await refreshGoogleAdsAccessToken(opts.fetchFn, configResult.auth);
  if ("error" in tokenResult) {
    return { ok: false, stage: "token", error: `falha ao renovar access token: ${tokenResult.error}` };
  }
  const uploadResult = await uploadClickConversions(opts.fetchFn, configResult.auth, tokenResult.accessToken, opts.payload);
  if (!uploadResult.ok) {
    return { ok: false, stage: "upload", error: `upload falhou: ${uploadResult.error}` };
  }
  return { ok: true, response: uploadResult.response };
}

/**
 * Extrai os índices (0-based, na ordem de `payload.conversions`) das
 * conversões que o Google recusou dentro de um `partialFailureError`.
 * Devolve `null` quando há `partialFailureError` mas os índices não puderam
 * ser lidos (quem chama deve tratar como "falha total, nada confirmado");
 * `[]` quando NÃO há erro parcial. Best-effort sobre o formato REST
 * (`details[].errors[].location.fieldPathElements[0].index`). @pure
 */
export function extractPartialFailureIndexes(response: unknown): number[] | null {
  const r = response as { partialFailureError?: unknown } | null;
  if (!r || typeof r !== "object" || !r.partialFailureError) return [];
  const err = r.partialFailureError as { details?: unknown };
  const indexes = new Set<number>();
  const details = Array.isArray(err.details) ? err.details : [];
  for (const d of details) {
    const errors = (d as { errors?: unknown })?.errors;
    if (!Array.isArray(errors)) continue;
    for (const e of errors) {
      const elements = (e as { location?: { fieldPathElements?: unknown } })?.location?.fieldPathElements;
      if (!Array.isArray(elements)) continue;
      const first = elements.find((el) => (el as { fieldName?: string })?.fieldName === "conversions") as
        | { index?: unknown }
        | undefined;
      if (first && typeof first.index === "number") indexes.add(first.index);
    }
  }
  return indexes.size > 0 ? [...indexes].sort((a, b) => a - b) : null;
}
