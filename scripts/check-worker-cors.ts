#!/usr/bin/env npx tsx
/**
 * check-worker-cors.ts (#1132 P2.4)
 *
 * Pre-flight check: verifica que o Worker `poll` (ou outro)
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
 *   npx tsx scripts/check-worker-cors.ts --worker-url https://eia.diar.ia.br
 *   npx tsx scripts/check-worker-cors.ts (lê de platform.config.json → poll.worker_url)
 *
 * Exit codes:
 *   0 — CORS header presente
 *   1 — CORS header ausente ou Worker inacessível (FATAL pra publish flow)
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface CheckResult {
  ok: boolean;
  worker_url: string;
  /** #9116: URL efetivamente sondada (key inexistente de propósito). */
  probe_url?: string;
  status?: number;
  header?: string;
  reason?: string;
  /** #9116: explica por que `status: 404` com `ok: true` é o resultado esperado. */
  note?: string;
}

/**
 * #9116: nota anexada ao resultado quando o probe devolve 404 — o probe usa
 * uma key que não existe de propósito, então 404 é o esperado; só o header
 * CORS decide o `ok`. Sem a nota, `ok: true` + `status: 404` lia como sinal
 * contraditório (edição 260930).
 */
export function probeStatusNote(status: number): string | undefined {
  if (status === 404) {
    return "404 esperado — o probe usa uma key inexistente; só o header CORS decide o ok";
  }
  return undefined;
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
  // Usar uma key impossível (vai retornar 404 mas com CORS header). As imagens
  // reais usam a convenção `img-{edition}-*` (#1908); aqui só checamos o header.
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
      probe_url: probeUrl,
      status: res.status,
      header: corsHeader ?? undefined,
      reason: evaluation.reason,
      note: evaluation.ok ? probeStatusNote(res.status) : undefined,
    };
  } catch (e) {
    return {
      ok: false,
      worker_url: workerUrl,
      probe_url: probeUrl,
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
  return "https://poll.diaria.workers.dev";
}

function parseArgs(argv: string[]): { workerUrl: string | null } {
  const values = parseArgsSimple(argv);
  return { workerUrl: values["worker-url"] ?? null };
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
    // #9116: exitCode (não process.exit) — checkCors() acabou de fazer fetch;
    // process.exit() com o socket keep-alive fechando abortava o Node no
    // Windows com UV_HANDLE_CLOSING (exit 127 em vez de 0/1, edição 260930).
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.url);
if (isMain) {
  main().catch((e) => {
    process.stderr.write(`[check-worker-cors] fatal: ${(e as Error).message}\n`);
    process.exitCode = 1;
  });
}
