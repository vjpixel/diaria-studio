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
    // Truncado (achado do fleet review, #6450): a mensagem do SyntaxError do
    // V8 normalmente só cita posição/caractere, mas nunca confiar nisso —
    // `raw` é um secret, e um parser diferente/versão futura poderia ecoar
    // um trecho maior do input malformado na mensagem de erro.
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 80);
    throw new InvalidServiceAccountJsonError(`não é JSON válido (${reason})`);
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

/** Resultado de `parseServiceAccountJsonWithFallback`: além do objeto
 * parseado, diz de ONDE ele veio — o chamador usa isso só pra logar (nunca
 * pra mudar comportamento). */
export interface ParsedWithSource {
  parsed: ServiceAccountShape;
  source: "env" | "fallback";
}

/**
 * `parseServiceAccountJson(raw)` com um fallback: se `raw` (tipicamente
 * `process.env.GOOGLE_ADS_SERVICE_ACCOUNT_JSON` via `.env`/dotenv) não
 * parsear, chama `fetchFallback()` e tenta de novo com o resultado — achado
 * ao vivo (#6450, 28/08/2026): `dotenv@16.6.1` desescapa `\n`/`\r` em TODO o
 * valor de um secret JSON multi-linha entre aspas duplas, inclusive os `\n`
 * que fazem parte da `private_key` (o bloco PEM tem newlines escapados como
 * parte da própria string JSON) — o round-trip Doppler→`.env`→dotenv
 * corrompe a estrutura de um jeito que nenhum unescape posterior conserta.
 * `fetchFallback` tipicamente busca o valor direto do Doppler CLI, que não
 * sofre esse round-trip. Pura/testável: `fetchFallback` é injetado, nunca
 * chama `execFileSync` diretamente aqui — só a orquestração de qual erro
 * relatar mora nesta função; o I/O de buscar o fallback fica no chamador
 * (`scripts/materialize-google-ads-credentials.ts`).
 *
 * `fetchFallback` retornando `null` (não disponível/falhou) é tratado como
 * "sem fallback" — relança o erro ORIGINAL do parse de `raw`, nunca um erro
 * sintético sobre o fallback em si.
 */
export function parseServiceAccountJsonWithFallback(
  raw: string,
  fetchFallback: () => string | null,
): ParsedWithSource {
  try {
    return { parsed: parseServiceAccountJson(raw), source: "env" };
  } catch (err) {
    if (!(err instanceof InvalidServiceAccountJsonError)) throw err;
    const fallbackRaw = fetchFallback();
    if (fallbackRaw === null) throw err; // sem fallback disponível — erro original é o que importa
    // Erro do fallback (se houver) NÃO é capturado aqui de propósito — se o
    // fallback também falhar o parse, o SyntaxError/InvalidServiceAccountJsonError
    // dele é mais informativo (secret genuinamente quebrado no Doppler) do
    // que o erro do `.env` corrompido, que o chamador já não usaria mesmo.
    return { parsed: parseServiceAccountJson(fallbackRaw), source: "fallback" };
  }
}

/** Path fixo por máquina onde a credencial materializada vive — fora do
 * repo, nunca versionado (equivalente a `~/.config/diaria/google-ads-sa.json`
 * sugerido na issue). Recebe `homeDir` explícito (nunca lê `os.homedir()`
 * aqui) pra manter o módulo puro/testável. */
export function defaultCredentialsPath(homeDir: string): string {
  return join(homeDir, ".config", "diaria", "google-ads-sa.json");
}

/**
 * Resultado de `applyServiceAccountEnvUpdates`: o conteúdo atualizado do
 * `.env` + se a linha `GOOGLE_ADS_SERVICE_ACCOUNT_JSON` foi reescrita (só
 * quando `source === "fallback"` — o `.env` só está confirmadamente
 * corrompido nesse caminho; se `source === "env"` o raw já parseou direto,
 * então a linha em disco já está boa e reescrevê-la seria trabalho inútil,
 * ou pior, arriscaria introduzir uma diferença onde não havia bug).
 */
export interface ServiceAccountEnvUpdateResult {
  content: string;
  rewroteServiceAccountJson: boolean;
}

/**
 * Aplica ao conteúdo de um `.env` as 2 atualizações que
 * `materialize-google-ads-credentials.ts` precisa fazer: sempre aponta
 * `GOOGLE_APPLICATION_CREDENTIALS` pro arquivo materializado, e — só quando
 * `source === "fallback"` (achado #6704) — reescreve `GOOGLE_ADS_SERVICE_ACCOUNT_JSON`
 * com o JSON compacto (sem indentação, 1 linha física) SEM aspas ao redor.
 *
 * **Por que sem aspas conserta de vez, não só para esta execução (#6704):**
 * o achado original do #6450 é que o round-trip Doppler→`.env`→dotenv
 * corrompe o secret porque `dotenv` desescapa `\n`/`\r` em TODO valor entre
 * aspas DUPLAS — inclusive os `\n` que fazem parte da `private_key` dentro do
 * JSON. `dotenv` só aplica esse unescape a valores citados; um valor SEM
 * aspas é copiado literalmente para `process.env`, então os `\n` da
 * `private_key` chegam como os 2 caracteres `\` + `n` (exatamente como estão
 * no JSON serializado) e o `JSON.parse` subsequente os interpreta
 * corretamente como quebra de linha. O arquivo `.env` em si nunca teve
 * problema de estrutura (é sempre 1 linha física, com ou sem aspas) — o bug
 * mora inteiro no unescape do dotenv em tempo de load, por isso reescrever
 * sem aspas resolve para QUALQUER consumidor futuro que carregue o `.env`
 * via `env-loader.ts`, não só para esta execução do script.
 */
export function applyServiceAccountEnvUpdates(
  envContent: string,
  credPath: string,
  source: "env" | "fallback",
  parsed: ServiceAccountShape,
): ServiceAccountEnvUpdateResult {
  let content = upsertEnvVar(envContent, "GOOGLE_APPLICATION_CREDENTIALS", credPath);
  let rewroteServiceAccountJson = false;
  if (source === "fallback") {
    content = upsertEnvVar(content, "GOOGLE_ADS_SERVICE_ACCOUNT_JSON", JSON.stringify(parsed));
    rewroteServiceAccountJson = true;
  }
  return { content, rewroteServiceAccountJson };
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
