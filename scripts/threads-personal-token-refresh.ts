#!/usr/bin/env node
/**
 * scripts/threads-personal-token-refresh.ts (#10772)
 *
 * Renova o token de longa duração (60 dias) do Threads PESSOAL do editor e grava o
 * novo no Doppler + `.env` (`THREADS_PERSONAL_ACCESS_TOKEN`,
 * `THREADS_PERSONAL_TOKEN_EXPIRES_AT`). Roda diário pela task
 * `Diaria-Threads-Personal-Token` (`scripts/lib/scheduled-tasks.ts`); só chama a
 * API quando faltam ≤30 dias (ou o vencimento é desconhecido). Lógica e regras
 * (espelho do refresh do Worker, #9618): `scripts/lib/threads-personal-token.ts`.
 *
 * Sem `THREADS_PERSONAL_ACCESS_TOKEN` → sai 0 sem fazer nada.
 * Exit 1 = o editor precisa agir (token vencido, falha perto do vencimento, Doppler recusou).
 *
 * Uso:
 *   npx tsx scripts/threads-personal-token-refresh.ts
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { defaultDopplerSet, persistSecrets } from "./lib/secret-persist.ts";
import { runThreadsPersonalTokenRefresh } from "./lib/threads-personal-token.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[threads-personal-token-refresh]";

async function main(): Promise<number> {
  loadProjectEnv();
  const r = await runThreadsPersonalTokenRefresh({
    env: process.env,
    now: () => new Date(),
    persist: (secrets) =>
      persistSecrets({
        secrets,
        dopplerSet: defaultDopplerSet,
        envPath: resolve(ROOT, ".env"),
        readEnv: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
        writeEnv: (p, c) => writeFileAtomic(p, c),
      }),
  });
  (r.exitCode === 0 ? console.log : console.error)(`${LOG_PREFIX} ${r.outcome}: ${r.message}`);
  return r.exitCode;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`${LOG_PREFIX} erro:`, e) });
}
