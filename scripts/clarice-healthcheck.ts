/**
 * clarice-healthcheck.ts (#1329) — ping REST Clarice cortex API pra
 * detectar conectividade antes do Stage 2.
 *
 * Roda no Stage 0 (preflight). Não falha o pipeline — só sinaliza
 * (degraded / down) e loga warn. O caminho normal de Stage 2 continua
 * sendo MCP, mas o orchestrator agora **sabe** se o REST tá disponível
 * pra cair no fallback (`clarice-correct.ts`) sem halt.
 *
 * Stdout: JSON { ok: boolean, latency_ms?: number, error?: string }
 * Exit codes:
 *   0 — saudável (ok: true)
 *   2 — degraded (ok: false, exibe `error`)
 *
 * Não escolhi exit 1 pra erro: 1 é "arg inválido" em vários scripts do repo
 * e poderia ser confundido com falha de uso vs falha de conectividade.
 */

import "dotenv/config";

const CLARICE_ENDPOINT = "https://cortex.clarice.ai/api-correction";
const PROBE_TEXT = "ola";
const DEFAULT_TIMEOUT_MS = 5_000;

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

async function main(): Promise<void> {
  const apiKey = process.env.CLARICE_API_KEY;
  if (!apiKey) {
    console.log(JSON.stringify({ ok: false, error: "CLARICE_API_KEY ausente" }));
    process.exit(2);
  }
  const result = await checkClariceHealth({ apiKey });
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 2);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  await main();
}
