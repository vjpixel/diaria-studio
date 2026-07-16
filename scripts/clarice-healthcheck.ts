/**
 * clarice-healthcheck.ts (#1329) — ping REST Clarice cortex API pra
 * detectar conectividade antes do Stage 2.
 *
 * Roda no Stage 0 (preflight). Não falha o pipeline — só sinaliza
 * (degraded / down) e loga warn. O caminho normal de Stage 2 continua
 * sendo MCP, mas o orchestrator agora **sabe** se o REST tá disponível
 * pra cair no fallback (`clarice-correct.ts`) sem halt.
 *
 * Uso (CLI):
 *   npx tsx scripts/clarice-healthcheck.ts [--timeout-ms N]
 *
 * Stdout: JSON { ok: boolean, latency_ms?: number, error?: string }
 * Exit codes:
 *   0 — saudável (ok: true)
 *   1 — arg inválido
 *   2 — degraded (ok: false, exibe `error`)
 *
 * Não escolhi exit 1 pra erro de conectividade: 1 é "arg inválido" em vários
 * scripts do repo e poderia ser confundido com falha de uso.
 */

import "dotenv/config";
import { isMainModule } from "./lib/cli-args.ts";

const CLARICE_ENDPOINT = "https://cortex.clarice.ai/api-correction";
const PROBE_TEXT = "ola";
/**
 * O cortex responde em ~16s mesmo pro probe de 3 chars (medido 2026-07-15).
 * O default anterior de 5s abortava SEMPRE — Stage 0 marcava CLARICE_REST=false
 * com o REST saudável, e Stage 2 pulava direto pro halt banner sem tentar o
 * fallback (orchestrator-stage-2.md §266). Alinhado com o default sem --retry
 * de clarice-correct.ts.
 */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Latência real observada no probe de 3 chars (2026-07-15). O default precisa folgar sobre isso. */
export const OBSERVED_PROBE_LATENCY_MS = 16_300;

export interface HealthResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

export interface HealthOptions {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkClariceHealth(
  opts: HealthOptions,
): Promise<HealthResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const t0 = Date.now();
  try {
    const res = await fetchFn(CLARICE_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "X-API-Key": opts.apiKey,
      },
      body: JSON.stringify({ paragraphs: [{ description: PROBE_TEXT, offset: 0 }] }),
      signal: controller.signal,
    });
    const latency_ms = Date.now() - t0;
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      return { ok: false, latency_ms, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true, latency_ms };
  } catch (e) {
    const latency_ms = Date.now() - t0;
    return { ok: false, latency_ms, error: (e as Error).message };
  } finally {
    clearTimeout(timeout);
  }
}

export function parseHealthcheckArgs(argv: string[]): { timeoutMs?: number } {
  const out: { timeoutMs?: number } = {};
  for (let i = 0; i < argv.length; i++) {
    // Mesmo guard de clarice-correct.ts: só consome o próximo token como valor
    // se ele não for outra --flag.
    const value = argv[i + 1]?.startsWith("--") ? undefined : argv[i + 1];
    if (argv[i] === "--timeout-ms" && value) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--timeout-ms deve ser um número positivo (recebido: ${value})`);
      }
      out.timeoutMs = n;
      i++;
    }
  }
  return out;
}

async function main(): Promise<void> {
  let args: { timeoutMs?: number };
  try {
    args = parseHealthcheckArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  const apiKey = process.env.CLARICE_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ ok: false, error: "CLARICE_API_KEY ausente" }));
    process.exit(2);
  }
  const result = await checkClariceHealth({ apiKey, timeoutMs: args.timeoutMs });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 2);
}

if (isMainModule(import.meta.url)) {
  await main();
}
