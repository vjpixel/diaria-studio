/**
 * retrospectiva-worker-secret-sync.ts (#8046)
 *
 * Miolo puro (injeção de `fetchFn`, nenhuma chamada real aqui) do sync do
 * secret `KIT_API_KEY` do Worker `workers/retrospectiva` — fecha o gap
 * identificado na retro do #8046: o secret é gravado manualmente via
 * `wrangler secret put` (ver histórico em `workers/retrospectiva/README.md`
 * §Cutover) e não existe NENHUM mecanismo no repo que o mantenha
 * sincronizado com a key ativa em `.env`/Doppler — a lógica de verificação
 * (`verifySubscriberViaKitByEmail`, `scripts/lib/shared/subscriber-verify.ts`)
 * estava correta; só a key DEPLOYADA estava desatualizada.
 *
 * Por que REST API em vez de shell-out ao `wrangler secret put` (mesmo
 * racional de `check-cloudflare-token.ts`/`worker-drift-check.ts`/
 * `cloudflare-kv-upload.ts`, "REST > CLI" — testável com mock de fetch, sem
 * dependência do binário no PATH, sem side-effects de login interativo):
 *
 *   PUT https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}/secrets
 *   body: { name, text, type: "secret_text" }
 *
 * grava/sobrescreve o secret de forma idempotente (mesmo efeito de
 * `wrangler secret put`, sem herdar side-effects do CLI). A API TAMBÉM
 * expõe:
 *
 *   GET https://api.cloudflare.com/client/v4/accounts/{account_id}/workers/scripts/{script_name}/secrets
 *
 * que lista os NOMES dos secrets configurados (nunca o valor — a Cloudflare
 * não devolve o conteúdo de um secret depois de gravado). Isso permite
 * confirmar "o secret KIT_API_KEY existe no Worker" sem vazar nada, mas
 * **não** permite confirmar "o valor deployado bate com o `.env` local" —
 * essa comparação é estruturalmente impossível pela API pública (é a
 * própria razão de secrets existirem). `verifyRetrospectivaWorkerSecret`
 * abaixo é honesto sobre esse limite: `status: "present"` significa apenas
 * "o nome está registrado", nunca "o valor está correto".
 *
 * Nada neste arquivo executa rede de verdade — toda I/O é via `fetchFn`
 * injetado (default `fetch` global só no script CLI que chama isto).
 */

export const RETROSPECTIVA_WORKER_SCRIPT_NAME = "retrospectiva";
export const RETROSPECTIVA_WORKER_SECRET_NAME = "KIT_API_KEY";

type FetchFn = typeof fetch;

export interface RetrospectivaWorkerSecretSyncConfig {
  /** Valor do secret a gravar (tipicamente `process.env.KIT_API_KEY`). */
  secretValue?: string;
  /** Account ID Cloudflare (tipicamente `process.env.CLOUDFLARE_ACCOUNT_ID`). */
  accountId?: string;
  /** API token com permissão Workers Scripts:Edit (tipicamente
   * `process.env.CLOUDFLARE_WORKERS_TOKEN` — mesmo token que
   * `.github/workflows/deploy-worker.yml` mapeia pra `CLOUDFLARE_API_TOKEN`
   * no deploy via CI). */
  token?: string;
  /** Nome do script do Worker. Default: `RETROSPECTIVA_WORKER_SCRIPT_NAME`. */
  scriptName?: string;
  /** Nome do secret. Default: `RETROSPECTIVA_WORKER_SECRET_NAME`. */
  secretName?: string;
}

export type SyncStatus =
  | "synced" // PUT 2xx — secret gravado
  | "missing_secret_value" // secretValue ausente/vazio — nada a gravar
  | "missing_credentials" // accountId ou token ausente
  | "api_error"; // PUT retornou erro (4xx/5xx) ou fetch lançou

export interface SyncResult {
  status: SyncStatus;
  /** Mensagem legível pra log/terminal — nunca inclui o valor do secret. */
  message: string;
  /** Corpo cru da resposta de erro da API (quando status === "api_error"), pra diagnóstico. */
  apiError?: string;
}

/**
 * Grava (ou sobrescreve) o secret no Worker via REST API. Idempotente —
 * chamar de novo com o mesmo valor não tem efeito colateral adicional
 * (mesmo comportamento de `wrangler secret put`).
 */
export async function syncRetrospectivaWorkerSecret(
  cfg: RetrospectivaWorkerSecretSyncConfig,
  fetchFn: FetchFn,
): Promise<SyncResult> {
  const secretValue = cfg.secretValue ?? "";
  const accountId = cfg.accountId ?? "";
  const token = cfg.token ?? "";
  const scriptName = cfg.scriptName ?? RETROSPECTIVA_WORKER_SCRIPT_NAME;
  const secretName = cfg.secretName ?? RETROSPECTIVA_WORKER_SECRET_NAME;

  if (!secretValue) {
    return {
      status: "missing_secret_value",
      message: `${secretName} ausente/vazio — nada a gravar. Rode 'npm run sync-env' ou preencha .env manualmente.`,
    };
  }
  if (!accountId || !token) {
    return {
      status: "missing_credentials",
      message:
        "CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_WORKERS_TOKEN ausentes — necessários pra autenticar contra a API de Workers Scripts.",
    };
  }

  let res: Response;
  try {
    res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: secretName, text: secretValue, type: "secret_text" }),
      },
    );
  } catch (err) {
    return {
      status: "api_error",
      message: `Falha de rede ao chamar a API Cloudflare: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      status: "api_error",
      message: `API Cloudflare retornou ${res.status} ao gravar o secret ${secretName} no Worker ${scriptName}.`,
      apiError: body,
    };
  }

  return {
    status: "synced",
    message: `Secret ${secretName} gravado no Worker ${scriptName} (via API Cloudflare).`,
  };
}

export type VerifyStatus =
  | "present" // secret name está na lista retornada pela API (valor não verificável — ver docstring do arquivo)
  | "absent" // secret name NÃO está na lista
  | "missing_credentials"
  | "api_error";

export interface VerifyResult {
  status: VerifyStatus;
  message: string;
  /** Nomes de todos os secrets registrados no Worker (nunca valores). */
  secretNames?: string[];
  apiError?: string;
}

/**
 * Confirma se o NOME do secret está registrado no Worker — nunca confirma o
 * VALOR (a API da Cloudflare não expõe conteúdo de secret depois de
 * gravado). `status: "present"` é evidência de que algum valor foi setado
 * em algum momento, não de que é o valor atual do `.env`/Doppler.
 */
export async function verifyRetrospectivaWorkerSecret(
  cfg: Omit<RetrospectivaWorkerSecretSyncConfig, "secretValue">,
  fetchFn: FetchFn,
): Promise<VerifyResult> {
  const accountId = cfg.accountId ?? "";
  const token = cfg.token ?? "";
  const scriptName = cfg.scriptName ?? RETROSPECTIVA_WORKER_SCRIPT_NAME;
  const secretName = cfg.secretName ?? RETROSPECTIVA_WORKER_SECRET_NAME;

  if (!accountId || !token) {
    return {
      status: "missing_credentials",
      message: "CLOUDFLARE_ACCOUNT_ID e/ou CLOUDFLARE_WORKERS_TOKEN ausentes.",
    };
  }

  let res: Response;
  try {
    res = await fetchFn(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${scriptName}/secrets`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch (err) {
    return {
      status: "api_error",
      message: `Falha de rede ao consultar secrets do Worker: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      status: "api_error",
      message: `API Cloudflare retornou ${res.status} ao listar secrets do Worker ${scriptName}.`,
      apiError: body,
    };
  }

  const json = (await res.json().catch(() => null)) as { result?: Array<{ name?: string }> } | null;
  const secretNames = (json?.result ?? []).map((s) => s.name).filter((n): n is string => typeof n === "string");

  return secretNames.includes(secretName)
    ? {
        status: "present",
        message: `${secretName} está registrado no Worker ${scriptName} (valor não verificável via API).`,
        secretNames,
      }
    : {
        status: "absent",
        message: `${secretName} NÃO está registrado no Worker ${scriptName}.`,
        secretNames,
      };
}
