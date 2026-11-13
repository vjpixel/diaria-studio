/**
 * cloudflare-plan.test.ts (#12533)
 *
 * Nunca fala com a Cloudflare real: a lógica pura é testada direto e o CLI
 * recebe um fetch falso.
 *
 * Cenário central da issue: o token do projeto responde `10000
 * Authentication error` a `/subscriptions` (sem Account › Billing › Read).
 * O helper tem que sair com o aviso "token sem Billing:Read — não
 * verificado", exit != 0, e NUNCA afirmar plano.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXIT_ERROR,
  EXIT_NO_BILLING_PERMISSION,
  EXIT_VERIFIED,
  KV_QUOTAS,
  NO_BILLING_PERMISSION_MESSAGE,
  buildPlanReport,
  classifyWorkersPlan,
  exitCodeFor,
  interpretKvUsageResponse,
  interpretSubscriptionsResponse,
  monthWindow,
  renderPlanReport,
  summarizeKvUsage,
  type CfSubscription,
} from "../scripts/lib/cloudflare-plan.ts";
import { main } from "../scripts/cloudflare-plan.ts";

const AUTH_ERROR_BODY = {
  success: false,
  errors: [{ code: 10000, message: "Authentication error" }],
  messages: [],
  result: null,
};

const PAID_SUB: CfSubscription = {
  id: "sub1",
  state: "Paid",
  price: 5,
  currency: "USD",
  frequency: "monthly",
  rate_plan: { id: "workers_paid", public_name: "Workers Paid" },
};

const WINDOW = monthWindow(new Date("2026-11-13T12:00:00Z"));

// ── interpretSubscriptionsResponse ──────────────────────────────────────────

test("403 com código 10000 → no-billing-permission (cenário real de 09/11/2026)", () => {
  const v = interpretSubscriptionsResponse(403, AUTH_ERROR_BODY);
  assert.equal(v.kind, "no-billing-permission");
  if (v.kind === "no-billing-permission") assert.match(v.detail, /10000 Authentication error/);
});

test("código 10000 mesmo com status 400 → no-billing-permission", () => {
  assert.equal(interpretSubscriptionsResponse(400, AUTH_ERROR_BODY).kind, "no-billing-permission");
});

test("401 sem corpo → no-billing-permission", () => {
  assert.equal(interpretSubscriptionsResponse(401, null).kind, "no-billing-permission");
});

test("200 com result array → ok", () => {
  const v = interpretSubscriptionsResponse(200, { success: true, errors: [], result: [PAID_SUB] });
  assert.equal(v.kind, "ok");
  if (v.kind === "ok") assert.equal(v.subscriptions.length, 1);
});

test("500 ou 200 sem result → error (nunca ok)", () => {
  assert.equal(interpretSubscriptionsResponse(500, { errors: [{ code: 1, message: "x" }] }).kind, "error");
  assert.equal(interpretSubscriptionsResponse(200, { success: true }).kind, "error");
  assert.equal(interpretSubscriptionsResponse(200, { success: false, result: [] }).kind, "error");
});

// ── classifyWorkersPlan ─────────────────────────────────────────────────────

test("assinatura Workers Paid ativa → workers-paid", () => {
  const c = classifyWorkersPlan([PAID_SUB]);
  assert.equal(c.plan, "workers-paid");
  assert.equal(c.subscription?.id, "sub1");
});

test("reconhece o plano pelo public_name ou pelo nome do produto", () => {
  assert.equal(classifyWorkersPlan([{ state: "Paid", rate_plan: { public_name: "Workers Paid" } }]).plan, "workers-paid");
  assert.equal(classifyWorkersPlan([{ state: "Paid", product: { name: "Workers Bundled" } }]).plan, "workers-paid");
});

test("assinatura Workers cancelada não conta → workers-free", () => {
  assert.equal(classifyWorkersPlan([{ ...PAID_SUB, state: "Cancelled" }]).plan, "workers-free");
});

test("só assinaturas de outros produtos → workers-free, com a contagem no motivo", () => {
  const c = classifyWorkersPlan([{ state: "Paid", rate_plan: { id: "pro", public_name: "Pro Plan" } }]);
  assert.equal(c.plan, "workers-free");
  assert.match(c.reason, /1 assinatura/);
});

// ── monthWindow ─────────────────────────────────────────────────────────────

test("mês corrente vai do dia 1 até hoje (UTC)", () => {
  assert.deepEqual(WINDOW, { month: "2026-11", start: "2026-11-01", end: "2026-11-13" });
});

test("mês passado vai até o último dia, inclusive fevereiro", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  assert.equal(monthWindow(now, "2026-10").end, "2026-10-31");
  assert.equal(monthWindow(now, "2026-02").end, "2026-02-28");
});

test("mês futuro ou malformado lança", () => {
  const now = new Date("2026-11-13T12:00:00Z");
  assert.throws(() => monthWindow(now, "2026-12"), /futuro/);
  assert.throws(() => monthWindow(now, "2026-13"), /01-12/);
  assert.throws(() => monthWindow(now, "nov"), /YYYY-MM/);
});

// ── uso de KV ───────────────────────────────────────────────────────────────

const GROUPS = [
  { sum: { requests: 400 }, dimensions: { actionType: "write", date: "2026-11-01" } },
  { sum: { requests: 900 }, dimensions: { actionType: "write", date: "2026-11-02" } },
  { sum: { requests: 5000 }, dimensions: { actionType: "read", date: "2026-11-01" } },
  { sum: { requests: 300 }, dimensions: { actionType: "list", date: "2026-11-02" } },
  { sum: { requests: 7 }, dimensions: { actionType: "unknown", date: "2026-11-02" } },
];

test("summarizeKvUsage soma o mês e acha o pico diário por ação", () => {
  const s = summarizeKvUsage(GROUPS);
  assert.deepEqual(s.totals, { read: 5000, write: 1300, delete: 0, list: 300 });
  assert.deepEqual(s.peakDay.write, { date: "2026-11-02", requests: 900 });
  assert.equal(s.peakDay.delete, null);
  assert.deepEqual(s.otherActions, { unknown: 7 });
});

test("interpretKvUsageResponse: ok, erro GraphQL e conta ausente", () => {
  const ok = interpretKvUsageResponse(200, {
    data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: GROUPS }] } },
    errors: null,
  });
  assert.equal(ok.kind, "ok");
  assert.equal(
    interpretKvUsageResponse(200, { data: null, errors: [{ message: "not authorized" }] }).kind,
    "error",
  );
  assert.equal(interpretKvUsageResponse(200, { data: { viewer: { accounts: [] } } }).kind, "error");
  assert.equal(interpretKvUsageResponse(403, {}).kind, "error");
});

// ── buildPlanReport / render / exit ─────────────────────────────────────────

test("sem Billing:Read: unverified, exit 3, aviso explícito e NENHUM plano no relatório", () => {
  const report = buildPlanReport({
    window: WINDOW,
    subscriptions: interpretSubscriptionsResponse(403, AUTH_ERROR_BODY),
    usage: { kind: "ok", summary: summarizeKvUsage(GROUPS) },
  });
  assert.equal(report.status, "unverified");
  assert.equal(report.plan, undefined);
  assert.equal(report.quotaComparison, undefined);
  assert.equal(exitCodeFor(report), EXIT_NO_BILLING_PERMISSION);
  assert.notEqual(EXIT_NO_BILLING_PERMISSION, 0);
  const text = renderPlanReport(report);
  assert.ok(text.includes(NO_BILLING_PERMISSION_MESSAGE));
  assert.doesNotMatch(text, /Plano Workers verificado|Workers Free|Workers Paid/);
  assert.match(text, /não é comparado com cota/);
});

test("Workers Paid + uso: compara totais do mês com a cota mensal", () => {
  const report = buildPlanReport({
    window: WINDOW,
    subscriptions: { kind: "ok", subscriptions: [PAID_SUB] },
    usage: { kind: "ok", summary: summarizeKvUsage(GROUPS) },
  });
  assert.equal(report.status, "verified");
  assert.equal(exitCodeFor(report), EXIT_VERIFIED);
  const write = report.quotaComparison?.rows.find((r) => r.action === "write");
  assert.deepEqual(write, { action: "write", used: 1300, limit: KV_QUOTAS["workers-paid"].limits.write, pct: 0.1 });
  assert.match(renderPlanReport(report), /cota mensal incluída/);
});

test("Workers Free + uso: compara o PICO diário com o teto diário", () => {
  const report = buildPlanReport({
    window: WINDOW,
    subscriptions: { kind: "ok", subscriptions: [] },
    usage: { kind: "ok", summary: summarizeKvUsage(GROUPS) },
  });
  const write = report.quotaComparison?.rows.find((r) => r.action === "write");
  assert.deepEqual(write, { action: "write", used: 900, limit: 1000, pct: 90, peakDate: "2026-11-02" });
  assert.match(renderPlanReport(report), /teto DIÁRIO/);
});

test("plano verificado com uso falho: exit 0, uso declarado como não verificado", () => {
  const report = buildPlanReport({
    window: WINDOW,
    subscriptions: { kind: "ok", subscriptions: [PAID_SUB] },
    usage: { kind: "error", detail: "not authorized" },
  });
  assert.equal(exitCodeFor(report), EXIT_VERIFIED);
  assert.equal(report.quotaComparison, undefined);
  assert.match(renderPlanReport(report), /Uso de KV não verificado: not authorized/);
});

test("erro na consulta de assinaturas: status error, exit 1", () => {
  const report = buildPlanReport({
    window: WINDOW,
    subscriptions: { kind: "error", httpStatus: 500, detail: "boom" },
    usage: null,
  });
  assert.equal(report.plan, undefined);
  assert.equal(exitCodeFor(report), EXIT_ERROR);
});

// ── CLI com fetch falso ─────────────────────────────────────────────────────

function fakeFetch(routes: { subs: [number, unknown]; graphql: [number, unknown] }) {
  const calls: { url: string; method: string }[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    const [status, body] = url.endsWith("/graphql") ? routes.graphql : routes.subs;
    return new Response(JSON.stringify(body), { status });
  };
  return { fn, calls };
}

async function captureConsole(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => err.push(a.join(" "));
  try {
    const code = await fn();
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

const ENV = { CLOUDFLARE_API_TOKEN: "tok", CLOUDFLARE_ACCOUNT_ID: "acc123" } as NodeJS.ProcessEnv;
const NOW = new Date("2026-11-13T12:00:00Z");

test("CLI: token sem Billing:Read → exit 3 com o aviso, só GET/consulta (nada gravado)", async () => {
  const { fn, calls } = fakeFetch({
    subs: [403, AUTH_ERROR_BODY],
    graphql: [200, { data: { viewer: { accounts: [{ kvOperationsAdaptiveGroups: GROUPS }] } } }],
  });
  const r = await captureConsole(() => main([], ENV, fn, NOW));
  assert.equal(r.code, EXIT_NO_BILLING_PERMISSION);
  assert.ok(r.out.includes(NO_BILLING_PERMISSION_MESSAGE));
  assert.ok(calls.some((c) => c.url.endsWith("/accounts/acc123/subscriptions") && c.method === "GET"));
  // única chamada não-GET é a query GraphQL (leitura de analytics)
  assert.ok(calls.every((c) => c.method === "GET" || c.url.endsWith("/graphql")));
});

test("CLI: prefere CLOUDFLARE_BILLING_TOKEN ao CLOUDFLARE_API_TOKEN", async () => {
  const seen: string[] = [];
  const fn = async (url: string, init?: RequestInit) => {
    seen.push(String((init?.headers as Record<string, string>)?.Authorization));
    return new Response(JSON.stringify(url.endsWith("/graphql") ? {} : { success: true, result: [PAID_SUB] }), {
      status: 200,
    });
  };
  const r = await captureConsole(() =>
    main(["--json"], { ...ENV, CLOUDFLARE_BILLING_TOKEN: "billing" } as NodeJS.ProcessEnv, fn, NOW),
  );
  assert.equal(r.code, EXIT_VERIFIED);
  assert.ok(seen.every((h) => h === "Bearer billing"));
  assert.equal(JSON.parse(r.out).plan, "workers-paid");
});

test("CLI: sem CLOUDFLARE_ACCOUNT_ID → exit 1 sem chamar a rede", async () => {
  const { fn, calls } = fakeFetch({ subs: [200, {}], graphql: [200, {}] });
  const r = await captureConsole(() => main([], { CLOUDFLARE_API_TOKEN: "t" } as NodeJS.ProcessEnv, fn, NOW));
  assert.equal(r.code, EXIT_ERROR);
  assert.equal(calls.length, 0);
  assert.match(r.err, /CLOUDFLARE_ACCOUNT_ID/);
});

test("CLI: --month inválido → exit 1", async () => {
  const { fn } = fakeFetch({ subs: [200, {}], graphql: [200, {}] });
  const r = await captureConsole(() => main(["--month", "2027-01"], ENV, fn, NOW));
  assert.equal(r.code, EXIT_ERROR);
});

test("CLI: fetch que lança vira erro, nunca plano", async () => {
  const fn = async () => {
    throw new Error("offline");
  };
  const r = await captureConsole(() => main([], ENV, fn, NOW));
  assert.equal(r.code, EXIT_ERROR);
  assert.doesNotMatch(r.out, /Plano Workers verificado/);
});
