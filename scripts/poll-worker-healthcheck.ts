/**
 * poll-worker-healthcheck.ts (#1411, #1412, #1415, #1420)
 *
 * Smoke test pré-flight do Worker `poll` — roda no Stage 0 da pipeline
 * antes de qualquer etapa que depende do worker (Stage 3 É IA?, Stage 4
 * close-poll, geração de URLs de vote). Detecta cedo:
 *
 *   - #1412: DNS unbound — `poll.diaria.workers.dev` NXDOMAIN.
 *   - #1411: KV image serving down — /img/{key} retorna não-200.
 *   - #1415/#1420: secrets perdidos pós-redeploy — /vote retorna 503
 *     com `missing_secrets[]`, ou 500 (Worker crash legacy sem guard
 *     #1420).
 *
 * Em vez de descobrir esses problemas só quando subscribers reclamarem
 * que imagens não carregam, ou quando close-poll falha 3h depois.
 *
 * Endpoints testados (todos read-only, sem efeito colateral):
 *   1. GET /stats?edition=AAMMDD — público, sem secret. 200 = DNS OK.
 *   2. GET /vote?email=test&edition=AAMMDD&choice=A&sig=invalid — esperado
 *      403 (sig inválida) ou 410 (edição não-listada). 500/503 = problema.
 *
 * Uso:
 *   npx tsx scripts/poll-worker-healthcheck.ts [--edition AAMMDD] [--worker-url URL]
 *
 * Env:
 *   POLL_WORKER_URL — override; default https://poll.diaria.workers.dev
 *
 * Exit codes:
 *   0 — todos os checks passaram
 *   1 — args inválidos
 *   2 — DNS broken (NXDOMAIN ou similar)
 *   3 — endpoint público falhou (Worker crashed ou KV down)
 *   4 — secrets ausentes (503 missing_secrets ou 500 crash legacy)
 */

import "dotenv/config";

import { parseArgs as parseCliArgs } from "./lib/cli-args.ts";
import { dohFetch } from "./lib/doh-fetch.ts";

const DEFAULT_WORKER_URL = "https://poll.diaria.workers.dev";

export interface CheckResult {
  name: string;
  ok: boolean;
  status?: number;
  detail?: string;
  body_snippet?: string;
}

export interface HealthcheckResult {
  worker_url: string;
  checks: CheckResult[];
  overall_ok: boolean;
  exit_code: 0 | 2 | 3 | 4;
}

/**
 * Pure: classifica o resultado de uma response de /vote com sig inválida.
 * - 403/410: OK (rejection esperada, Worker está saudável)
 * - 503: secrets ausentes (#1420)
 * - 500: legacy crash (Worker velho sem guard #1420, ou erro inesperado)
 * - Outros: anomalia
 */
export function classifyVoteResponse(status: number, bodySnippet: string):
  | { ok: true }
  | { ok: false; kind: "secrets_missing" | "legacy_crash" | "anomaly"; detail: string } {
  if (status === 403 || status === 410) return { ok: true };
  if (status === 503) {
    const detail = bodySnippet.includes("missing_secrets")
      ? "Secrets faltando — re-set via `wrangler secret put`. Body: " + bodySnippet
      : "503 sem missing_secrets payload. Investigar config: " + bodySnippet;
    return { ok: false, kind: "secrets_missing", detail };
  }
  if (status === 500) {
    return {
      ok: false,
      kind: "legacy_crash",
      detail:
        "500 — Worker crash. Provavelmente Worker pré-#1420 (sem guard) com secrets ausentes; " +
        "redeploy + `wrangler secret put POLL_SECRET ADMIN_SECRET`. Body: " + bodySnippet,
    };
  }
  return { ok: false, kind: "anomaly", detail: `status ${status} inesperado. Body: ${bodySnippet}` };
}

async function checkPublicEndpoint(workerUrl: string, edition: string): Promise<CheckResult> {
  const url = `${workerUrl}/stats?edition=${edition}`;
  try {
    const res = await dohFetch(url);
    const body = await res.text();
    if (!res.ok) {
      return {
        name: "public_endpoint",
        ok: false,
        status: res.status,
        detail: `GET /stats falhou — Worker pode estar down ou KV inacessível`,
        body_snippet: body.slice(0, 200),
      };
    }
    return { name: "public_endpoint", ok: true, status: res.status };
  } catch (e) {
    return {
      name: "public_endpoint",
      ok: false,
      detail: `network/DNS error: ${(e as Error).message}`,
    };
  }
}

async function checkSecretsGuard(workerUrl: string, edition: string): Promise<CheckResult> {
  // sig deliberadamente inválido — esperamos 403 ou 410. 500/503 indica problema.
  const url = `${workerUrl}/vote?email=healthcheck@diar.ia&edition=${edition}&choice=A&sig=invalid&test=1`;
  try {
    const res = await dohFetch(url);
    const body = await res.text();
    const classification = classifyVoteResponse(res.status, body.slice(0, 200));
    if (classification.ok) {
      return { name: "secrets_guard", ok: true, status: res.status };
    }
    return {
      name: "secrets_guard",
      ok: false,
      status: res.status,
      detail: classification.detail,
      body_snippet: body.slice(0, 200),
    };
  } catch (e) {
    return {
      name: "secrets_guard",
      ok: false,
      detail: `network/DNS error: ${(e as Error).message}`,
    };
  }
}

export async function runHealthcheck(workerUrl: string, edition: string): Promise<HealthcheckResult> {
  const checks: CheckResult[] = [];

  const publicCheck = await checkPublicEndpoint(workerUrl, edition);
  checks.push(publicCheck);
  if (!publicCheck.ok) {
    const isDns = publicCheck.detail?.includes("network/DNS") ?? false;
    return {
      worker_url: workerUrl,
      checks,
      overall_ok: false,
      exit_code: isDns ? 2 : 3,
    };
  }

  const secretsCheck = await checkSecretsGuard(workerUrl, edition);
  checks.push(secretsCheck);
  if (!secretsCheck.ok) {
    return {
      worker_url: workerUrl,
      checks,
      overall_ok: false,
      exit_code: 4,
    };
  }

  return { worker_url: workerUrl, checks, overall_ok: true, exit_code: 0 };
}

async function main(): Promise<void> {
  const { values } = parseCliArgs(process.argv.slice(2));
  const workerUrl = values["worker-url"] ?? process.env.POLL_WORKER_URL ?? DEFAULT_WORKER_URL;
  // Edição usada apenas como query param — não precisa ser real. Default
  // 260101 (sentinel obviously-test, qualquer edição funciona).
  const edition = values["edition"] ?? "260101";

  if (!/^\d{6}$/.test(edition)) {
    console.error("--edition deve ser AAMMDD (6 dígitos numéricos)");
    process.exit(1);
  }

  const result = await runHealthcheck(workerUrl, edition);
  console.log(JSON.stringify(result, null, 2));
  if (!result.overall_ok) {
    console.error(`[poll-worker-healthcheck] FATAL: ${result.checks.find((c) => !c.ok)?.detail}`);
  }
  process.exit(result.exit_code);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main().catch((err) => {
    console.error(`[poll-worker-healthcheck] unexpected error: ${err}`);
    process.exit(3);
  });
}
