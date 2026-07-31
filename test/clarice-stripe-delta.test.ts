/**
 * test/clarice-stripe-delta.test.ts (#4347 Etapa 1)
 *
 * Regressão pro delta Stripe direto na API (fecha G1). Cobre: paginação
 * `starting_after`, header do CSV byte-idêntico ao schema alvo (verbatim do
 * export do Dashboard), join subscription/charge → Status/Plan/Total Spend/
 * Payment Count, `cohortOf()` do merge sobre as linhas geradas, `--from-csv`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import Papa from "papaparse";
import {
  STRIPE_DELTA_CSV_HEADER,
  buildDeltaRows,
  rowsToCsv,
  stripeListAllSince,
  fetchStripeDelta,
  resolveDefaultSince,
  deltaOutputPath,
  main,
  type StripeCustomerRaw,
  type StripeSubscriptionRaw,
  type StripeChargeRaw,
} from "../scripts/clarice-stripe-delta.ts";
import { cohortOf } from "../scripts/merge-clarice-subscribers.ts";
import { COHORT_ASSINANTES_ATIVOS, COHORT_EX_ASSINANTES } from "../scripts/lib/cohorts.ts";

function mkRes(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Header — byte-idêntico ao schema alvo (verbatim do export do Dashboard, #4347)
// ---------------------------------------------------------------------------

test("STRIPE_DELTA_CSV_HEADER: header do CSV byte-idêntico ao schema alvo do export do Dashboard", () => {
  const rows = buildDeltaRows(
    [{ id: "cus_1", email: "a@x.com", name: "A", created: 1782000000, delinquent: null }],
    [],
    [],
  );
  const csv = rowsToCsv(rows);
  const headerLine = csv.split("\n")[0].replace(/\r$/, "");
  assert.equal(
    headerLine,
    "id,Description,Email,Name,Created (UTC),Delinquent,Plan,Status,Total Spend,Payment Count,Refunded Volume,Dispute Losses,tag (metadata)",
  );
  assert.deepEqual(
    [...STRIPE_DELTA_CSV_HEADER],
    ["id", "Description", "Email", "Name", "Created (UTC)", "Delinquent", "Plan", "Status", "Total Spend", "Payment Count", "Refunded Volume", "Dispute Losses", "tag (metadata)"],
  );
});

// ---------------------------------------------------------------------------
// Paginação starting_after
// ---------------------------------------------------------------------------

test("stripeListAllSince: pagina via starting_after até has_more=false (fixture com 3 páginas)", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (!u.includes("starting_after")) {
      return mkRes(200, { data: [{ id: "cus_1" }, { id: "cus_2" }], has_more: true });
    }
    if (u.includes("starting_after=cus_2")) {
      return mkRes(200, { data: [{ id: "cus_3" }, { id: "cus_4" }], has_more: true });
    }
    if (u.includes("starting_after=cus_4")) {
      return mkRes(200, { data: [{ id: "cus_5" }], has_more: false });
    }
    return mkRes(200, { data: [], has_more: false });
  }) as typeof fetch;

  const items = await stripeListAllSince<{ id: string }>("customers", "", 1782000000, "sk_test", fetchImpl);
  assert.deepEqual(items.map((i) => i.id), ["cus_1", "cus_2", "cus_3", "cus_4", "cus_5"]);
  assert.equal(calls.length, 3, "3 páginas — não N+1 por cliente");
  assert.ok(calls[0].includes("created[gte]=1782000000"), "usa --since na query");
});

test("fetchStripeDelta: busca customers+subscriptions+charges em paralelo, cada um paginado", async () => {
  const seen = { customers: 0, subscriptions: 0, charges: 0 };
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/customers")) { seen.customers++; return mkRes(200, { data: [{ id: "cus_1", email: "a@x.com", name: "A", created: 1782000000, delinquent: false }], has_more: false }); }
    if (u.includes("/subscriptions")) { seen.subscriptions++; return mkRes(200, { data: [], has_more: false }); }
    if (u.includes("/charges")) { seen.charges++; return mkRes(200, { data: [], has_more: false }); }
    return mkRes(404, {});
  }) as typeof fetch;

  const { customers, subscriptions, charges } = await fetchStripeDelta("sk_test", 1782000000, fetchImpl);
  assert.equal(customers.length, 1);
  assert.equal(subscriptions.length, 0);
  assert.equal(charges.length, 0);
  assert.equal(seen.customers, 1);
  assert.equal(seen.subscriptions, 1);
  assert.equal(seen.charges, 1);
});

// ---------------------------------------------------------------------------
// Join — subscription/charge → Status/Plan/Total Spend/Payment Count
// ---------------------------------------------------------------------------

test("buildDeltaRows: join com subscription ATIVA e charges succeeded — Status/Plan/Total Spend/Payment Count corretos", () => {
  const customers: StripeCustomerRaw[] = [
    { id: "cus_1", email: "payer@x.com", name: "Payer", created: 1782000000, delinquent: false },
  ];
  const subscriptions: StripeSubscriptionRaw[] = [
    { id: "sub_1", customer: "cus_1", status: "active", created: 1782000100, items: { data: [{ price: { id: "price_abc", nickname: "Mensal" } }] } },
  ];
  const charges: StripeChargeRaw[] = [
    { id: "ch_1", customer: "cus_1", amount: 4900, amount_captured: 4900, amount_refunded: 0, status: "succeeded", paid: true, created: 1782000200 },
    { id: "ch_2", customer: "cus_1", amount: 4900, amount_captured: 4900, amount_refunded: 0, status: "succeeded", paid: true, created: 1782100000 },
    { id: "ch_3", customer: "cus_1", amount: 4900, status: "failed", paid: false, created: 1782200000 }, // falhou — não conta
  ];
  const [row] = buildDeltaRows(customers, subscriptions, charges);
  assert.equal(row.Status, "active");
  assert.equal(row.Plan, "Mensal");
  assert.equal(row["Total Spend"], "98.00");
  assert.equal(row["Payment Count"], "2");
  assert.equal(row["Refunded Volume"], "0.00");
  assert.equal(row["Dispute Losses"], "0");
  assert.equal(row.Email, "payer@x.com");
});

test("buildDeltaRows: customer sem subscription/charge — Status/Plan vazios, Total Spend 0", () => {
  const [row] = buildDeltaRows(
    [{ id: "cus_lead", email: "lead@x.com", name: "Lead", created: 1782000000, delinquent: null }],
    [],
    [],
  );
  assert.equal(row.Status, "");
  assert.equal(row.Plan, "");
  assert.equal(row["Total Spend"], "0.00");
  assert.equal(row["Payment Count"], "0");
});

test("buildDeltaRows: múltiplas subscriptions do mesmo customer — vence a de status mais 'ativo'", () => {
  const customers: StripeCustomerRaw[] = [{ id: "cus_1", email: "a@x.com", name: "A", created: 1782000000, delinquent: false }];
  const subscriptions: StripeSubscriptionRaw[] = [
    { id: "sub_old", customer: "cus_1", status: "canceled", created: 1782000000, items: { data: [{ price: { id: "p1" } }] } },
    { id: "sub_new", customer: "cus_1", status: "active", created: 1782100000, items: { data: [{ price: { id: "p2" } }] } },
  ];
  const [row] = buildDeltaRows(customers, subscriptions, []);
  assert.equal(row.Status, "active");
  assert.equal(row.Plan, "p2");
});

test("buildDeltaRows: refund reduz Refunded Volume mas não reduz o count", () => {
  const customers: StripeCustomerRaw[] = [{ id: "cus_1", email: "a@x.com", name: "A", created: 1782000000, delinquent: false }];
  const charges: StripeChargeRaw[] = [
    { id: "ch_1", customer: "cus_1", amount: 10000, amount_captured: 10000, amount_refunded: 3000, status: "succeeded", paid: true, created: 1782000100 },
  ];
  const [row] = buildDeltaRows(customers, [], charges);
  assert.equal(row["Total Spend"], "100.00"); // net = captured (refund é reportado à parte)
  assert.equal(row["Refunded Volume"], "30.00");
  assert.equal(row["Payment Count"], "1");
});

// ---------------------------------------------------------------------------
// cohortOf() sobre as linhas geradas — o downstream ingere sem mudança
// ---------------------------------------------------------------------------

test("cohortOf() sobre linhas geradas por buildDeltaRows bate com o esperado (via CSV round-trip do merge)", () => {
  const customers: StripeCustomerRaw[] = [
    { id: "cus_payer", email: "payer@x.com", name: "Payer", created: 1782000000, delinquent: false },
    { id: "cus_ex", email: "ex@x.com", name: "Ex", created: 1782000000, delinquent: false },
  ];
  const subscriptions: StripeSubscriptionRaw[] = [
    { id: "sub_payer", customer: "cus_payer", status: "active", created: 1782000100, items: { data: [{ price: { id: "p1" } }] } },
    { id: "sub_ex", customer: "cus_ex", status: "canceled", created: 1782000100, items: { data: [{ price: { id: "p2" } }] } },
  ];
  const charges: StripeChargeRaw[] = [
    { id: "ch_ex", customer: "cus_ex", amount: 5000, amount_captured: 5000, amount_refunded: 0, status: "succeeded", paid: true, created: 1782000200 },
  ];
  const rows = buildDeltaRows(customers, subscriptions, charges);

  // Simula a leitura pelo merge (normalizeRow lê exatamente essas colunas).
  const merged = rows.map((r) => ({
    id: r.id || null,
    email: r.Email,
    name: r.Name || null,
    created: new Date(r["Created (UTC)"]),
    description: r.Description || null,
    tag: r["tag (metadata)"] || null,
    delinquent: r.Delinquent === "true" ? true : r.Delinquent === "false" ? false : null,
    plan: r.Plan || null,
    status: r.Status || null,
    total_spend: Number(r["Total Spend"]),
    payment_count: Number(r["Payment Count"]),
    refunded_volume: Number(r["Refunded Volume"]),
    dispute_losses: Number(r["Dispute Losses"]),
    stripe_ids: [r.id],
    source_files: ["delta.csv"],
  }));
  assert.equal(cohortOf(merged[0]), COHORT_ASSINANTES_ATIVOS);
  assert.equal(cohortOf(merged[1]), COHORT_EX_ASSINANTES);
});

// ---------------------------------------------------------------------------
// --from-csv — fallback pro export manual
// ---------------------------------------------------------------------------

test("--from-csv: copia o arquivo verbatim pro destino canônico (--execute)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "stripe-delta-fromcsv-"));
  const outDir = mkdtempSync(resolve(tmpdir(), "stripe-delta-fromcsv-out-"));
  const src = resolve(dir, "manual-export.csv");
  const content =
    "id,Description,Email,Name,Created (UTC),Delinquent,Plan,Status,Total Spend,Payment Count,Refunded Volume,Dispute Losses,tag (metadata)\n" +
    "cus_1,,manual@x.com,Manual,2026-07-15 00:00,false,,active,0,0,0,0,\n";
  writeFileSync(src, content, "utf8");

  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let out: string;
  try {
    await main(["--from-csv", src, "--execute", "--out-dir", outDir]);
    out = JSON.parse(logs.join("\n")).out;
  } finally {
    console.log = origLog;
  }
  assert.ok(out.startsWith(outDir), "path de saída deve respeitar --out-dir (isolado do disco real de produção)");
  assert.ok(existsSync(out), "arquivo de destino canônico deve existir");
  assert.equal(readFileSync(out, "utf8"), content, "conteúdo copiado verbatim");
});

test("--from-csv sem --execute é dry-run — não escreve nada", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "stripe-delta-fromcsv-dry-"));
  const outDir = mkdtempSync(resolve(tmpdir(), "stripe-delta-fromcsv-dry-out-"));
  const src = resolve(dir, "manual-export.csv");
  writeFileSync(
    src,
    "id,Description,Email,Name,Created (UTC),Delinquent,Plan,Status,Total Spend,Payment Count,Refunded Volume,Dispute Losses,tag (metadata)\ncus_1,,a@x.com,A,2026-07-15 00:00,false,,active,0,0,0,0,\n",
    "utf8",
  );
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  let parsed: any;
  try {
    await main(["--from-csv", src, "--out-dir", outDir]);
    parsed = JSON.parse(logs.join("\n"));
  } finally {
    console.log = origLog;
  }
  assert.equal(parsed.mode, "dry-run");
  assert.equal(existsSync(parsed.out), false, "dry-run não deve escrever o destino");
});

// ---------------------------------------------------------------------------
// resolveDefaultSince / deltaOutputPath — puros
// ---------------------------------------------------------------------------

test("resolveDefaultSince: MAX(created) do store menos 2 dias de folga", () => {
  const fakeDb = { prepare: () => ({ get: () => ({ maxCreated: "2026-07-20T00:00:00.000Z" }) }) };
  const since = resolveDefaultSince(fakeDb, new Date("2026-07-29T00:00:00Z"));
  assert.equal(since, "2026-07-18"); // 20 - 2 dias
});

test("resolveDefaultSince: store vazio (sem created) cai pra 30 dias atrás de `now`", () => {
  const fakeDb = { prepare: () => ({ get: () => ({ maxCreated: null }) }) };
  const since = resolveDefaultSince(fakeDb, new Date("2026-07-29T00:00:00Z"));
  // 29/jul - 30d = 29/jun; - 2d de folga = 27/jun
  assert.equal(since, "2026-06-27");
});

test("deltaOutputPath: nome no formato stripe-customers-{YYYY-MM}-delta-{MMDD}.csv (data da execução)", () => {
  const path = deltaOutputPath(new Date("2026-07-29T12:00:00Z"));
  assert.match(path, /stripe-customers-2026-07-delta-0729\.csv$/);
});
