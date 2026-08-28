/**
 * scripts/lib/google-ads-credentials.ts (#6450)
 *
 * Miolo PURO (sem I/O) do materializador de credencial do MCP `google-ads`
 * declarado em `.mcp.json`. Achado da investigação do #6450: o server
 * (`ads_mcp/utils.py`, `_create_credentials()`) só aceita ADC — nunca o
 * fluxo OAuth client-id/secret/refresh-token que `GOOGLE_ADS_CLIENT_ID`/
 * `GOOGLE_ADS_CLIENT_SECRET`/`GOOGLE_ADS_REFRESH_TOKEN` já cobrem pro caminho
 * REST (`scripts/lib/google-ads-ingest.ts`) — e `GOOGLE_APPLICATION_CREDENTIALS`
 * (ADC) exige um ARQUIVO no disco, nunca JSON inline.
 *
 * Decisão do editor (#6450, 27/08/2026): service account + Doppler, não
 * `gcloud auth application-default login` interativo por máquina — o secret
 * (`GOOGLE_ADS_SERVICE_ACCOUNT_JSON`, conteúdo bruto da chave) trafega pelo
 * vault e chega em `.env` via `npm run sync-env` como qualquer outro; falta
 * só materializá-lo em arquivo antes do MCP subir. Este módulo é o miolo
 * (validação + path + transformação de texto); o I/O (ler env, escrever
 * arquivo/`.env`) vive em `scripts/materialize-google-ads-credentials.ts`.
 */

import { join } from "node:path";

export interface ServiceAccountShape {
  client_email: string;
  private_key: string;
  project_id?: string;
  [key: string]: unknown;
}

/** Nunca aceita "presente mas malformado" como sucesso silencioso — mesma
 * disciplina do #573 (validar deterministicamente, nunca confiar que "tem
 * valor" implica "valor utilizável"). */
export class InvalidServiceAccountJsonError extends Error {
  constructor(reason: string) {
    super(`GOOGLE_ADS_SERVICE_ACCOUNT_JSON inválido: ${reason}`);
    this.name = "InvalidServiceAccountJsonError";
  }
}

/** Valida e parseia o JSON da service account. Confere só os 2 campos que o
 * `google-auth` (biblioteca Python do MCP) exige pra reconhecer o arquivo
 * como uma service account key — não valida a chave criptográfica em si
 * (isso só a própria API do Google faz). */
export function parseServiceAccountJson(raw: string): ServiceAccountShape {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidServiceAccountJsonError(`não é JSON válido (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InvalidServiceAccountJsonError("JSON não é um objeto");
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.client_email !== "string" || !obj.client_email) {
    throw new InvalidServiceAccountJsonError("campo client_email ausente/vazio");
  }
  if (typeof obj.private_key !== "string" || !obj.private_key) {
    throw new InvalidServiceAccountJsonError("campo private_key ausente/vazio");
  }
  return obj as ServiceAccountShape;
}

/** Path fixo por máquina onde a credencial materializada vive — fora do
 * repo, nunca versionado (equivalente a `~/.config/diaria/google-ads-sa.json`
 * sugerido na issue). Recebe `homeDir` explícito (nunca lê `os.homedir()`
 * aqui) pra manter o módulo puro/testável. */
export function defaultCredentialsPath(homeDir: string): string {
  return join(homeDir, ".config", "diaria", "google-ads-sa.json");
}

/** Upsert idempotente de uma linha `KEY=value` no conteúdo de um `.env` —
 * substitui a linha existente (primeira ocorrência) ou acrescenta ao final
 * se ausente. Nunca duplica a chave nem reordena as demais linhas. Pura:
 * recebe/devolve string, quem chama decide se lê/escreve arquivo. */
export function upsertEnvVar(envContent: string, key: string, value: string): string {
  const lines = envContent.length ? envContent.split(/\r?\n/) : [];
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escapedKey}=`);
  let found = false;
  const next = lines.map((line) => {
    if (!found && pattern.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(`${key}=${value}`);
  }
  return next.join("\n");
}
