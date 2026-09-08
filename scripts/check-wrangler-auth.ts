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
 * Uso: `npx tsx scripts/check-wrangler-auth.ts` — exit 0 se autenticado (stdout
 * com a identidade do `wrangler whoami`); exit != 0 se não autenticado, timeout,
 * erro de resolução do binário ou falha de execução.
 *
 * #7610 (review P1): `wrangler whoami` exita 0 TAMBÉM quando não está logado
 * (imprime "You are not authenticated. Please run `wrangler login`"), então o
 * exit code do child sozinho não discrimina — o guard parseia o stdout pra
 * detectar o caso de não-autenticação, que é o mais comum na sessão cloud.
 *
 * #7606: a resolução do binário (`resolveWranglerBin`) AGORA roda dentro de
 * `checkWranglerAuth`, sob try/catch — qualquer falha de resolução
 * (node_modules desatualizado, wrangler desinstalado, workspace sem hoist)
 * vira `{ ok: false, stderr: <msg> }`, o mesmo formato de qualquer outra
 * falha de auth, em vez de derrubar o processo inteiro no momento do import
 * com stack trace bruto. O §6h do orchestrator já trata exit != 0 como
 * "não autenticado, degradar pra warn e seguir sem a purga" — o crash que
 * #7606 reportava quebrava essa expectativa.
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
// Resolvido LAZILY dentro de checkWranglerBin (#7606) — não mais no import.

/** Assinatura mínima de `execFileSync` usada por `checkWranglerAuth` —
 * injetável pra teste de regressão do #6900 sem tocar wrangler de verdade. */
export type ExecFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; encoding: "utf8"; timeout: number; stdio: ["ignore", "pipe", "pipe"] },
) => string;

/** Resolve o caminho do binário `wrangler`. Injetável pra teste de regressão
 * do #7606 — é this callback que pode lançar (e queremos que lance vira
 * `{ ok: false }`, nunca crash no import). */
export type ResolveWranglerBin = (fromModuleUrl: string) => string;

export interface WranglerAuthResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

const WRANGLER_WHOAMI_TIMEOUT_MS = 15_000; // mesmo timeout curto que a prosa antiga do §6h já pedia

/**
 * `wrangler whoami` exita 0 mesmo sem estar logado — nesse caso imprime uma
 * mensagem de "não autenticado" e sai limpo. O exit code do child portanto
 * NUNCA discrimina autenticado de não-autenticado (#7610 review P1, verificado
 * ao vivo: `wrangler 4.128.0` + "You are not authenticated. Please run
 * `wrangler login`" + EXIT=0). O §6h do orchestrator trata `exit != 0` como
 * degrade-to-warn — se o guard passasse `ok:true` nesse caso, a purga rodiria
 * e falharia logo em `purge-leaderboard.ts` com `Authentication error`, e o
 * degrade nunca acontecia no cenário mais comum.
 *
 * Detectamos o caso pelo stdout, que é o único sinal confiável. O caminho
 * "autenticado" é a ausência de qualquer marca de não-autenticação.
 */
const NOT_AUTH_PATTERNS = [
  /not authenticated/i,
  /please run\s+`?wrangler\s+login`/i,
  /authentication error/i,
  /not logged in/i,
];

function stdoutIndicatesNotAuthenticated(stdout: string): boolean {
  return NOT_AUTH_PATTERNS.some((re) => re.test(stdout));
}

/**
 * Roda `wrangler whoami` com o env sanitizado (sem `CLOUDFLARE_API_TOKEN`/
 * `CLOUDFLARE_ACCOUNT_ID`) — a MESMA função `sanitizedCloudflareOAuthEnv`
 * que `purge-leaderboard.ts` chama antes de qualquer operação de KV. `exec`,
 * `env` e `resolveBin` são injetáveis pra teste determinístico (nunca chama
 * o wrangler real fora do CLI entry abaixo).
 *
 * #7606: a resolução do binário roda AQUI, sob try/catch — se o wrangler não
 * resolve, retorna `{ ok: false, stderr }` em vez de lançar no import.
 */
export function checkWranglerAuth(
  exec: ExecFn = execFileSync as unknown as ExecFn,
  env: NodeJS.ProcessEnv = process.env,
  resolveBin: ResolveWranglerBin = resolveWranglerBin,
): WranglerAuthResult {
  let wranglerBin: string;
  try {
    wranglerBin = resolveBin(import.meta.url);
  } catch (e) {
    return {
      ok: false,
      stdout: "",
      stderr: e instanceof Error ? (e.message ?? String(e)) : String(e),
    };
  }

  try {
    const stdout = exec(process.execPath, [wranglerBin, "whoami"], {
      cwd: POLL_DIR,
      env: sanitizedCloudflareOAuthEnv(env),
      encoding: "utf8",
      timeout: WRANGLER_WHOAMI_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // #7610: exit 0 não é suficiente — o wrangler sai limpo também sem
    // estar logado. O stdout é o sinal real.
    if (stdoutIndicatesNotAuthenticated(stdout)) {
      return {
        ok: false,
        stdout,
        stderr: "wrangler whoami saiu com exit 0 mas stdout indica que nao esta autenticado",
      };
    }
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
