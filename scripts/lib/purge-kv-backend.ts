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
 *      servidor `300`, que não tem navegador pra `wrangler login`. Em 27/10/2026
 *      o token do `.env` lia e gravava no POLL (probe manual, #11253) — o
 *      `--check-auth` refaz essa prova a cada execução, não confiar nesta data.
 *   3. Nenhum dos dois → `none`, com motivo legível. O caller falha alto.
 *
 * `override` (`--kv-backend wrangler|rest`) pula a detecção: `wrangler` nem
 * checa o login (o próprio wrangler vai reclamar se não houver), `rest` exige
 * token + account.
 *
 * Função pura: o `wrangler whoami` entra como callback (`checkWrangler`) e só
 * é chamado quando a decisão depende dele.
 */

import type { WranglerAuthResult } from "../check-wrangler-auth.ts";
import type { KvOps } from "./cloudflare-kv-rest.ts";

export type PurgeKvBackendName = "wrangler" | "rest";
export type PurgeKvBackendOverride = PurgeKvBackendName | "auto";

export type PurgeKvBackendChoice =
  | { backend: "wrangler"; reason: string }
  | {
      backend: "rest";
      reason: string;
      accountId: string;
      token: string;
      /** Presente quando o modo `auto` caiu pro REST porque o wrangler não tem
       * login — o caller imprime como `[warn]` no stderr. */
      fallbackWarning?: string;
    }
  | { backend: "none"; reason: string };

export interface ResolvePurgeKvBackendInput {
  env: NodeJS.ProcessEnv;
  /** Roda `wrangler whoami` com o env sanitizado (ver `check-wrangler-auth.ts`). */
  checkWrangler: () => Pick<WranglerAuthResult, "ok" | "stderr">;
  override?: PurgeKvBackendOverride;
}

export function parseKvBackendOverride(raw: string | null | undefined): PurgeKvBackendOverride {
  if (raw === null || raw === undefined || raw === "") return "auto";
  if (raw === "auto" || raw === "wrangler" || raw === "rest") return raw;
  throw new Error(`--kv-backend inválido: "${raw}" (use auto, wrangler ou rest)`);
}

/**
 * Lê `--kv-backend` de argv. Flag ausente → `auto`; flag presente SEM valor
 * (último arg, ou seguida de outra `--flag`) lança — nunca vira `auto` em
 * silêncio, que esconderia um `--kv-backend rest` truncado.
 */
export function readKvBackendFlag(args: readonly string[]): PurgeKvBackendOverride {
  const idx = args.indexOf("--kv-backend");
  if (idx === -1) return "auto";
  const raw = args[idx + 1];
  if (raw === undefined || raw === "" || raw.startsWith("--")) {
    throw new Error("--kv-backend exige um valor (auto, wrangler ou rest)");
  }
  return parseKvBackendOverride(raw);
}

/**
 * `wrangler kv key get` de chave inexistente sai != 0 com
 * `Failed to fetch {url} - 404: Not Found` no stderr (wrangler 4.128.0,
 * `fetchKVGetValueBase`; a chave entra URL-encoded na URL, então `:` vira
 * `%3A` e o `404` da chave nunca fica colado em `: Not Found`). `[code: 10009]`
 * é o código "key not found" da API, aceito por defesa (o DELETE de chave
 * inexistente responde 200 e nem chega aqui). Só stderr/stdout entram no
 * teste — NUNCA `err.message`, que é `Command failed: node wrangler ... <KEY>`
 * e carrega a chave: uma chave com "404" no nome (`vote:260404:...`) fazia um
 * erro de auth/rede virar "não encontrada" e a purga reportar apagado um voto
 * que ficou (#11253 review A1).
 */
export function isWranglerKvNotFound(e: unknown): boolean {
  const err = e as { stderr?: Buffer | string; stdout?: Buffer | string };
  const out = [err?.stderr, err?.stdout].map((x) => x?.toString() ?? "").join("\n");
  return /(?:^|\s)404: Not Found\b|\[code: 10009\]/.test(out);
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
      fallbackWarning: `wrangler whoami falhou (${wranglerWhy}) — caindo pra API REST do KV`,
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

export interface CheckPurgeAuthInput {
  choice: PurgeKvBackendChoice;
  /** Monta as ops do backend escolhido (wrangler ou REST). */
  opsFor: (choice: Exclude<PurgeKvBackendChoice, { backend: "none" }>) => Pick<KvOps, "probe">;
  /** `ADMIN_SECRET`/`POLL_ADMIN_SECRET` presente — o `--execute` exige (#4474). */
  adminSecretPresent: boolean;
}

export interface CheckPurgeAuthResult {
  ok: boolean;
  /** Linhas pro stdout. */
  out: string[];
  /** Linhas pro stderr. */
  err: string[];
}

/**
 * `--check-auth` (#11253). Exit 0 só quando a purga `--execute` tem tudo pra
 * rodar: (1) há backend de KV; (2) o probe dele LÊ e GRAVA no namespace —
 * nos dois backends, inclusive com `--kv-backend wrangler` forçado (list +
 * PUT/DELETE de uma chave sentinela, ver `KV_PROBE_SENTINEL_KEY`); (3)
 * `ADMIN_SECRET`/`POLL_ADMIN_SECRET` está no env. Não verifica o endpoint
 * `/admin/purge-score-do` em si (só a presença do secret).
 */
export async function checkPurgeAuth(input: CheckPurgeAuthInput): Promise<CheckPurgeAuthResult> {
  const { choice } = input;
  const out: string[] = [];
  const err: string[] = [];
  if (choice.backend === "none") {
    err.push(`[purge] sem backend de KV: ${choice.reason}`);
    return { ok: false, out, err };
  }
  if (choice.backend === "rest" && choice.fallbackWarning) err.push(`[warn] ${choice.fallbackWarning}`);
  try {
    await input.opsFor(choice).probe();
  } catch (e) {
    err.push(
      `[purge] backend ${choice.backend} escolhido (${choice.reason}), mas o probe de leitura/escrita do ` +
        `namespace falhou: ${(e as Error).message}`,
    );
    return { ok: false, out, err };
  }
  out.push(`[purge] kv backend: ${choice.backend} — ${choice.reason}`);
  if (!input.adminSecretPresent) {
    err.push(
      "[purge] ADMIN_SECRET (ou POLL_ADMIN_SECRET) ausente — o KV está acessível, mas o --execute vai falhar " +
        "(purga do DO ScoreCounter, #4474). Ver .env/Doppler.",
    );
    return { ok: false, out, err };
  }
  out.push("[purge] ADMIN_SECRET: presente");
  return { ok: true, out, err };
}
