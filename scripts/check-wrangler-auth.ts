#!/usr/bin/env tsx
/**
 * check-wrangler-auth.ts
 *
 * Guard de auth do §6h do Stage 6 (#6900) — roda `wrangler whoami` com o
 * MESMO env sanitizado que `purge-leaderboard.ts` usa de fato (ver
 * `scripts/lib/cloudflare-oauth-env.ts`), pra que o guard nunca valide uma
 * identidade diferente da que a purga real vai usar em seguida.
 *
 * Antes: o playbook do orchestrator rodava `npx wrangler whoami` no
 * ambiente NORMAL do processo, que ainda tem `CLOUDFLARE_API_TOKEN` — então
 * o guard podia dar "autenticado" (via API Token) enquanto a sessão OAuth
 * que `purge-leaderboard.ts` de fato usa estava expirada, e a purga falhava
 * logo depois com `Authentication error [code: 10000]` (achado ao vivo
 * #6900, edição 260901).
 *
 * Uso: `npx tsx scripts/check-wrangler-auth.ts` — exit 0 + stdout do
 * `wrangler whoami` se autenticado; exit != 0 (ou timeout) se não.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { sanitizedCloudflareOAuthEnv } from "./lib/cloudflare-oauth-env.ts";
import { isMainModule } from "./lib/cli-args.ts";
import { resolveWranglerBin } from "./lib/resolve-wrangler-bin.ts"; // #7117

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const POLL_DIR = resolve(ROOT, "workers", "poll");
// #7117: workers/ virou npm workspace — wrangler hoista pro node_modules da
// RAIZ, não mais workers/poll/node_modules (mesmo fix de scripts/purge-leaderboard.ts).
export const WRANGLER_BIN = resolveWranglerBin(import.meta.url);

/** Assinatura mínima de `execFileSync` usada por `checkWranglerAuth` —
 * injetável pra teste de regressão do #6900 sem tocar wrangler de verdade. */
export type ExecFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "pipe"] },
) => string;

export interface WranglerAuthResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const WRANGLER_WHOAMI_TIMEOUT_MS = 15_000; // mesmo timeout curto que a prosa antiga do §6h já pedia

/**
 * Roda `wrangler whoami` com o env sanitizado (sem `CLOUDFLARE_API_TOKEN`/
 * `CLOUDFLARE_ACCOUNT_ID`) — a MESMA função `sanitizedCloudflareOAuthEnv`
 * que `purge-leaderboard.ts` chama antes de qualquer operação de KV. `exec`
 * e `env` são injetáveis pra teste determinístico (nunca chama o wrangler
 * real fora do CLI entry abaixo).
 */
export function checkWranglerAuth(
  exec: ExecFn = execFileSync as unknown as ExecFn,
  env: NodeJS.ProcessEnv = process.env,
): WranglerAuthResult {
  try {
    const stdout = exec(process.execPath, [WRANGLER_BIN, "whoami"], {
      cwd: POLL_DIR,
      env: sanitizedCloudflareOAuthEnv(env),
      encoding: "utf8",
      timeout: WRANGLER_WHOAMI_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout, stderr: "" };
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: err.stdout ? err.stdout.toString() : "",
      stderr: err.stderr ? err.stderr.toString() : (err.message ?? ""),
    };
  }
}

if (isMainModule(import.meta.url)) {
  const result = checkWranglerAuth();
  if (result.ok) {
    console.log(result.stdout.trim());
    process.exit(0);
  } else {
    console.error(result.stderr.trim() || "wrangler whoami falhou sem detalhe");
    process.exit(1);
  }
}
