/**
 * cloudflare-plan.ts (#12533)
 *
 * Informa o plano Workers da conta Cloudflare e o uso de KV do mês contra o
 * que o plano inclui. Somente leitura: um GET de assinaturas e uma query
 * GraphQL de analytics; nada é gravado na Cloudflare.
 *
 * Uso:
 *   npx tsx scripts/cloudflare-plan.ts [--month YYYY-MM] [--json]
 *
 * Credenciais (do .env / Doppler):
 *   CLOUDFLARE_BILLING_TOKEN  token só de leitura com Account › Billing › Read,
 *                             usado só em /subscriptions (#12533); na falta,
 *                             cai no CLOUDFLARE_API_TOKEN
 *   CLOUDFLARE_API_TOKEN      usado na GraphQL de analytics (Account Analytics:
 *                             Read); na falta, cai no CLOUDFLARE_BILLING_TOKEN
 *   CLOUDFLARE_ACCOUNT_ID     id da conta
 *
 * Exit codes:
 *   0 = plano E uso de KV verificados
 *   4 = plano verificado, uso de KV NÃO verificado (erro na GraphQL ou sem dados)
 *   3 = token sem Billing:Read OU inválido/expirado: plano NÃO verificado, sem
 *       palpite (ação: conferir se o token é válido e dar Billing:Read a ele)
 *   5 = assinatura ligada a Workers que o padrão não reconhece: plano NÃO
 *       verificado, rótulos listados (ajustar o padrão em lib/cloudflare-plan.ts)
 *   1 = erro (variável ausente, rede, resposta inesperada, argumento inválido)
 *
 * Lógica pura e testes: scripts/lib/cloudflare-plan.ts,
 * test/cloudflare-plan.test.ts.
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
import { isMainModule } from "./lib/cli-args.ts";
import {
  EXIT_ERROR,
  KV_USAGE_QUERY,
  buildPlanReport,
  exitCodeFor,
  interpretKvUsageResponse,
  interpretSubscriptionsResponse,
  monthWindow,
  renderPlanReport,
  type KvUsageVerdict,
  type MonthWindow,
  type SubscriptionsVerdict,
} from "./lib/cloudflare-plan.ts";

const CF_API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 15_000;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => "");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { errors: [{ message: `resposta não-JSON: ${text.slice(0, 120)}` }] };
  }
}

export async function fetchSubscriptions(
  accountId: string,
  token: string,
  fetchFn: FetchFn = fetch,
): Promise<SubscriptionsVerdict> {
  try {
    const res = await fetchFn(`${CF_API}/accounts/${encodeURIComponent(accountId)}/subscriptions`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return interpretSubscriptionsResponse(res.status, await readJson(res));
  } catch (e) {
    return { kind: "error", httpStatus: 0, detail: `rede: ${(e as Error).message}` };
  }
}

export async function fetchKvUsage(
  accountId: string,
  token: string,
  window: MonthWindow,
  fetchFn: FetchFn = fetch,
): Promise<KvUsageVerdict> {
  try {
    const res = await fetchFn(`${CF_API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: KV_USAGE_QUERY,
        variables: { accountTag: accountId, start: window.start, end: window.end },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return interpretKvUsageResponse(res.status, await readJson(res));
  } catch (e) {
    return { kind: "error", detail: `rede: ${(e as Error).message}` };
  }
}

function parseArgs(argv: string[]): { month?: string; json: boolean } {
  let month: string | undefined;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") json = true;
    else if (a === "--month") {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error("--month sem valor (esperado YYYY-MM)");
      month = v;
    } else if (a.startsWith("--month=")) {
      month = a.slice("--month=".length);
      if (!month) throw new Error("--month sem valor (esperado YYYY-MM)");
    }
    else throw new Error(`argumento desconhecido: ${a}`);
  }
  return { month, json };
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: FetchFn = fetch,
  now: Date = new Date(),
): Promise<number> {
  let args: { month?: string; json: boolean };
  let window: MonthWindow;
  try {
    args = parseArgs(argv);
    window = monthWindow(now, args.month);
  } catch (e) {
    console.error(`[cloudflare-plan] ${(e as Error).message}`);
    return EXIT_ERROR;
  }

  // Billing token só em /subscriptions; a GraphQL usa o token geral (#12533).
  const billingToken = env.CLOUDFLARE_BILLING_TOKEN || env.CLOUDFLARE_API_TOKEN || "";
  const analyticsToken = env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_BILLING_TOKEN || "";
  const accountId = env.CLOUDFLARE_ACCOUNT_ID || "";
  if (!billingToken || !accountId) {
    console.error(
      "[cloudflare-plan] falta " +
        [!billingToken ? "CLOUDFLARE_BILLING_TOKEN/CLOUDFLARE_API_TOKEN" : "", !accountId ? "CLOUDFLARE_ACCOUNT_ID" : ""]
          .filter(Boolean)
          .join(" e ") +
        " no ambiente. Plano não verificado.",
    );
    return EXIT_ERROR;
  }

  const [subscriptions, usage] = await Promise.all([
    fetchSubscriptions(accountId, billingToken, fetchFn),
    fetchKvUsage(accountId, analyticsToken, window, fetchFn),
  ]);
  const report = buildPlanReport({ window, subscriptions, usage });
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderPlanReport(report));
  return exitCodeFor(report);
}

if (isMainModule(import.meta.url)) {
  loadProjectEnv();
  main().then((code) => {
    process.exitCode = code;
  });
}
