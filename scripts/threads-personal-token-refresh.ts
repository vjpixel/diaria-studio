#!/usr/bin/env node
/**
 * scripts/threads-personal-token-refresh.ts (#10772)
 *
 * Renova o token de longa duração (60 dias) do Threads PESSOAL do editor e grava o
 * novo no Doppler + `.env` (`THREADS_PERSONAL_ACCESS_TOKEN`,
 * `THREADS_PERSONAL_TOKEN_EXPIRES_AT`). Só chama a API quando faltam ≤30 dias (ou
 * o vencimento é desconhecido). Lógica e regras (espelho do refresh do Worker,
 * #9618): `scripts/lib/threads-personal-token.ts`.
 *
 * Onde rodar: na máquina com o Doppler CLI autenticado com ESCRITA em
 * `diaria-studio/dev` (hoje, a do editor). A task `Diaria-Threads-Personal-Token`
 * está DECLARADA, NÃO ARMADA: o `300` não tem o Doppler CLI (#11077). Até lá,
 * rodar à mão nesta máquina quando faltar ≤30 dias.
 *
 * Setup do token (passo a passo na #10772): gravar no Doppler as TRÊS chaves —
 * `THREADS_PERSONAL_ACCESS_TOKEN`, `THREADS_PERSONAL_USER_ID` e
 * `THREADS_PERSONAL_TOKEN_EXPIRES_AT` (ISO = agora + `expires_in` da troca pelo
 * token longo). Sem o vencimento a idade conta como desconhecida: a 1ª execução
 * tenta renovar e, se o token tiver <24h, a Meta recusa (sai 0 com aviso).
 *
 * Exit codes:
 *   0 — renovado, nada a fazer (folga >30 dias, sem token e sem user id), ou
 *       falha transitória com folga / recusa "<24h";
 *   1 — o editor precisa agir: token vencido; falha com ≤15 dias ou idade
 *       desconhecida; user id configurado sem o token neste host; ou o Doppler
 *       fora de sincronia (marcador `data/threads-personal/doppler-out-of-sync.json`,
 *       mantém exit 1 em toda execução até uma gravação no Doppler dar certo).
 *
 * Uso:
 *   npx tsx scripts/threads-personal-token-refresh.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { writeFileAtomic } from "./lib/atomic-write.ts";
import { defaultDopplerSet, persistSecrets } from "./lib/secret-persist.ts";
import { THREADS_PERSONAL_DOPPLER_MARKER, runThreadsPersonalTokenRefresh, type DopplerOutOfSyncMarker } from "./lib/threads-personal-token.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOG_PREFIX = "[threads-personal-token-refresh]";
const MARKER_PATH = resolve(ROOT, "data", THREADS_PERSONAL_DOPPLER_MARKER);

function readMarker(): DopplerOutOfSyncMarker | null {
  if (!existsSync(MARKER_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MARKER_PATH, "utf8")) as DopplerOutOfSyncMarker;
  } catch {
    // Marcador ilegível ainda significa "houve falha": trata como presente.
    return { since: "desconhecido", keys: [], errors: ["marcador ilegível"] };
  }
}

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
    marker: {
      read: readMarker,
      write: (m) => {
        mkdirSync(dirname(MARKER_PATH), { recursive: true });
        writeFileAtomic(MARKER_PATH, JSON.stringify(m, null, 2) + "\n");
      },
      clear: () => rmSync(MARKER_PATH, { force: true }),
    },
  });
  (r.exitCode === 0 ? console.log : console.error)(`${LOG_PREFIX} ${r.outcome}: ${r.message}`);
  return r.exitCode;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error(`${LOG_PREFIX} erro:`, e) });
}
