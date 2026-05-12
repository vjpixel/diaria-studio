#!/usr/bin/env npx tsx
/**
 * check-worker-cors.ts (#1132 P2.4)
 *
 * Pre-flight check: verifica que o Worker `diar-ia-poll` (ou outro)
 * responde no endpoint `/img/{key}` com header `Access-Control-Allow-Origin: *`.
 *
 * Razão: paste flow do publish-newsletter fetch-a imagens do Worker de
 * dentro de `app.beehiiv.com`. Sem CORS, fetch falha com "Failed to fetch"
 * opaco, gastando ~30min de debug (caso 260512).
 *
 * Não checa se imagem específica existe (404 é OK) — só presença do header
 * em qualquer response do `/img/` endpoint.
 *
 * Uso:
 *   npx tsx scripts/check-worker-cors.ts --worker-url https://diar-ia-poll.diaria.workers.dev
 *   npx tsx scripts/check-worker-cors.ts (lê de platform.config.json → poll.worker_url)
 *
 * Exit codes:
 *   0 — CORS header presente
 *   1 — CORS header ausente ou Worker inacessível (FATAL pra publish flow)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CheckResult {
  ok: boolean;
  worker_url: string;
  status?: number;
  header?: string;
  reason?: string;
}

/**
 * Pure (sans network): valida resposta de fetch contra critério CORS.
 * Exportado pra teste.
 */
export function evaluateCorsResponse(
  status: number,
  corsHeader: string | null,
): { ok: boolean; reason?: string } {
  // O endpoint responde com 200 (img existe) ou 404 (img não existe).
  // Em ambos os casos, o header CORS deve estar presente. Mas note:
  // o handleImage do Worker só adiciona CORS no path 200; 404 não tem
  // (decisão de design — fetch ainda lê status code mesmo sem CORS em error response).
  // Pra este check, aceitar ambos.
  if (corsHeader === "*") {
    return { ok: true };
  }
  if (corsHeader === null) {
    return {
      ok: false,
      reason: `Header Access-Control-Allow-Origin ausente (status ${status})`,
    };
  }
  return {
    ok: false,
    reason: `Header Access-Control-Allow-Origin é '${corsHeader}', esperado '*'`,
  };
}

async function checkCors(workerUrl: string): Promise<CheckResult> {
  // Usar uma key que muito provavelmente exista (img-monthly-* do digest)
  // OU uma key impossível (vai retornar 404 mas com CORS header)
  const probeUrl = `${workerUrl.replace(/\/+$/, "")}/img/cors-precheck-probe`;
  try {
    const res = await fetch(probeUrl, {
      method: "GET",
      headers: { Origin: "https://app.beehiiv.com" },
    });
    const corsHeader = res.headers.get("access-control-allow-origin");
    const evaluation = evaluateCorsResponse(res.status, corsHeader);
    return {
      ok: evaluation.ok,
      worker_url: workerUrl,
      status: res.status,
      header: corsHeader ?? undefined,
      reason: evaluation.reason,
    };
  } catch (e) {
    return {
      ok: false,
      worker_url: workerUrl,
      reason: `Worker inacessível: ${(e as Error).message}`,
    };
  }
}

function resolveWorkerUrl(cliArg: string | null): string {
  if (cliArg) return cliArg;
  const cfgPath = resolve(ROOT, "platform.config.json");
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      const url = cfg?.poll?.worker_url;
      if (typeof url === "string" && url.length > 0) return url;
    } catch {
      /* fallback */
    }
  }
  return "https://diar-ia-poll.diaria.workers.dev";
}

function parseArgs(argv: string[]): { workerUrl: string | null } {
  let workerUrl: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--worker-url" && i + 1 < argv.length) {
      workerUrl = argv[i + 1];
      i++;
    }
  }
  return { workerUrl };
}

async function main(): Promise<void> {
  const { workerUrl: cliArg } = parseArgs(process.argv.slice(2));
  const workerUrl = resolveWorkerUrl(cliArg);
  const result = await checkCors(workerUrl);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) {
    process.stderr.write(
      `\n[check-worker-cors] CORS check FAILED.\n` +
      `Worker: ${workerUrl}\n` +
      `Reason: ${result.reason}\n\n` +
      `Fix: cd workers/poll && npx wrangler deploy\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("check-worker-cors.ts");
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[check-worker-cors] fatal: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
