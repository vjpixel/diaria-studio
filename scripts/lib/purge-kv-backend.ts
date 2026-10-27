/**
 * purge-kv-backend.ts (#11253)
 *
 * Decide, de forma determinística e logável, por qual caminho
 * `purge-leaderboard.ts` fala com o KV do POLL:
 *
 *   1. `wrangler whoami` (env sanitizado, `check-wrangler-auth.ts`) indica
 *      login OAuth → backend `wrangler`. É o caminho de sempre do Neo (#2265),
 *      mantido como 1ª escolha pra não mudar nada onde ele já funciona — o
 *      `.env` de uma máquina pode ter um `CLOUDFLARE_API_TOKEN` mais antigo,
 *      sem permissão de KV (era exatamente o caso do #2265).
 *   2. Sem login OAuth, mas com `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
 *      no env → backend `rest` (API REST do KV com Bearer token). É o caso do
 *      servidor `300`, que não tem navegador pra `wrangler login`; o token atual
 *      lê e grava no namespace POLL (probe ao vivo de 27/10/2026, #11253).
 *   3. Nenhum dos dois → `none`, com motivo legível. O caller falha alto.
 *
 * `override` (`--kv-backend wrangler|rest`) pula a detecção: `wrangler` nem
 * checa o login (o próprio wrangler vai reclamar se não houver), `rest` exige
 * token + account.
 *
 * Função pura: o `wrangler whoami` entra como callback (`checkWrangler`) e só
 * é chamado quando a decisão depende dele.
 */

export type PurgeKvBackendName = "wrangler" | "rest";
export type PurgeKvBackendOverride = PurgeKvBackendName | "auto";

export type PurgeKvBackendChoice =
  | { backend: "wrangler"; reason: string }
  | { backend: "rest"; reason: string; accountId: string; token: string }
  | { backend: "none"; reason: string };

export interface ResolvePurgeKvBackendInput {
  env: NodeJS.ProcessEnv;
  /** Roda `wrangler whoami` com o env sanitizado (ver `check-wrangler-auth.ts`). */
  checkWrangler: () => { ok: boolean; stderr: string };
  override?: PurgeKvBackendOverride;
}

export function parseKvBackendOverride(raw: string | null | undefined): PurgeKvBackendOverride {
  if (raw === null || raw === undefined || raw === "") return "auto";
  if (raw === "auto" || raw === "wrangler" || raw === "rest") return raw;
  throw new Error(`--kv-backend inválido: "${raw}" (use auto, wrangler ou rest)`);
}

function restCredentials(env: NodeJS.ProcessEnv): { accountId: string; token: string } | null {
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  const accountId = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  if (!token || !accountId) return null;
  return { accountId, token };
}

function missingRestVars(env: NodeJS.ProcessEnv): string {
  const missing: string[] = [];
  if (!env.CLOUDFLARE_API_TOKEN?.trim()) missing.push("CLOUDFLARE_API_TOKEN");
  if (!env.CLOUDFLARE_ACCOUNT_ID?.trim()) missing.push("CLOUDFLARE_ACCOUNT_ID");
  return missing.join(" e ");
}

export function resolvePurgeKvBackend(input: ResolvePurgeKvBackendInput): PurgeKvBackendChoice {
  const override = input.override ?? "auto";

  if (override === "wrangler") {
    return { backend: "wrangler", reason: "forçado por --kv-backend wrangler" };
  }

  if (override === "rest") {
    const creds = restCredentials(input.env);
    if (!creds) {
      return { backend: "none", reason: `--kv-backend rest pedido, mas falta ${missingRestVars(input.env)} no env` };
    }
    return { backend: "rest", reason: "forçado por --kv-backend rest", ...creds };
  }

  const wr = input.checkWrangler();
  if (wr.ok) {
    return { backend: "wrangler", reason: "wrangler logado via OAuth (wrangler whoami ok)" };
  }

  const wranglerWhy = (wr.stderr || "wrangler whoami falhou").trim().split("\n")[0];
  const creds = restCredentials(input.env);
  if (creds) {
    return {
      backend: "rest",
      reason: `wrangler sem login OAuth (${wranglerWhy}); usando API REST com CLOUDFLARE_API_TOKEN`,
      ...creds,
    };
  }

  return {
    backend: "none",
    reason:
      `wrangler sem login OAuth (${wranglerWhy}) e falta ${missingRestVars(input.env)} no env — ` +
      "rode `wrangler login` ou defina o token (Doppler/.env)",
  };
}
