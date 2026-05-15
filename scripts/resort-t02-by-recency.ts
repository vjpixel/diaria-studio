/**
 * resort-t02-by-recency.ts — re-ordena T02 (ex-assinantes) por recência
 *
 * Critério novo:
 *   1° created_max DESC  (signup mais recente primeiro)
 *   2° payment_count DESC
 *   3° total_spend DESC
 *
 * Em vez do sort atual por `score` (dominado por log(spend)).
 *
 * Output: data/clarice-subscribers/brevo-import-t02.csv reordenado (overwrite).
 * Backup: data/clarice-subscribers/brevo-import-t02.csv.bak-score-sorted
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import Papa from "papaparse";

const ROOT = "data/clarice-subscribers";

interface StripeRow {
  Email?: string;
  "Created (UTC)"?: string;
  "Total Spend"?: string;
  "Payment Count"?: string;
}

interface MergedData {
  created_max: number; // unix ms; 0 se ausente
  payment_count: number;
  total_spend: number;
}

function parseStripeCsv(path: string): StripeRow[] {
  const content = readFileSync(path, "utf8");
  return Papa.parse<StripeRow>(content, { header: true, skipEmptyLines: true }).data;
}

function parseDate(s: string | undefined): number {
  if (!s) return 0;
  // Stripe format: "2024-09-22 17:34:11"
  const ms = Date.parse(s.replace(" ", "T") + "Z");
  return Number.isFinite(ms) ? ms : 0;
}

function buildStripeMap(): Map<string, MergedData> {
  const files = [
    "stripe-customers-2021-2022.csv",
    "stripe-customers-2023.csv",
    "stripe-customers-2024.csv",
    "stripe-customers-2025-2026.csv",
  ];
  const m = new Map<string, MergedData>();
  for (const f of files) {
    const rows = parseStripeCsv(`${ROOT}/${f}`);
    for (const r of rows) {
      const email = (r.Email || "").trim().toLowerCase();
      if (!email) continue;
      const created = parseDate(r["Created (UTC)"]);
      const spend = parseFloat(r["Total Spend"] || "0") || 0;
      const pcount = parseInt(r["Payment Count"] || "0") || 0;
      const existing = m.get(email);
      if (existing) {
        // MAX merge
        existing.created_max = Math.max(existing.created_max, created);
        existing.payment_count = Math.max(existing.payment_count, pcount);
        existing.total_spend = Math.max(existing.total_spend, spend);
      } else {
        m.set(email, { created_max: created, payment_count: pcount, total_spend: spend });
      }
    }
    console.error(`  [${f}] processed, total emails: ${m.size}`);
  }
  return m;
}

interface T02Row { email: string; NOME: string; OPEN_PROBABILITY: string; }

function main() {
  console.error("[1/4] Lendo stripe CSVs...");
  const stripe = buildStripeMap();
  console.error(`      stripe map: ${stripe.size} emails únicos`);

  console.error("[2/4] Lendo t02.csv atual...");
  const t02Path = `${ROOT}/brevo-import-t02.csv`;
  const t02Content = readFileSync(t02Path, "utf8");
  const t02Parsed = Papa.parse<T02Row>(t02Content, { header: true, skipEmptyLines: true });
  const t02 = t02Parsed.data.filter((r) => r.email && r.email.includes("@"));
  console.error(`      t02: ${t02.length} contatos`);

  console.error("[3/4] Join + sort por recência...");
  const enriched = t02.map((r) => {
    const email = r.email.trim().toLowerCase();
    const data = stripe.get(email) ?? { created_max: 0, payment_count: 0, total_spend: 0 };
    return { row: r, ...data };
  });

  // Stats antes de sortear
  const noStripeData = enriched.filter((e) => e.created_max === 0).length;
  console.error(`      sem stripe match: ${noStripeData} (${(noStripeData/enriched.length*100).toFixed(1)}%)`);

  enriched.sort((a, b) => {
    if (b.created_max !== a.created_max) return b.created_max - a.created_max;
    if (b.payment_count !== a.payment_count) return b.payment_count - a.payment_count;
    return b.total_spend - a.total_spend;
  });

  console.error("[4/4] Backup + write...");
  const backupPath = `${t02Path}.bak-score-sorted`;
  copyFileSync(t02Path, backupPath);
  console.error(`      backup: ${backupPath}`);

  const out = Papa.unparse(enriched.map((e) => e.row), { header: true });
  writeFileSync(t02Path, out + "\n", "utf8");
  console.error(`      written: ${t02Path}`);

  // Sample first 10 + last 10
  console.log("\n=== Primeiros 10 (recência DESC) ===");
  console.log("# | email                                    | NOME           | prob | created       | pcount | spend");
  for (let i = 0; i < 10; i++) {
    const e = enriched[i];
    const dt = e.created_max ? new Date(e.created_max).toISOString().slice(0, 10) : "—";
    console.log(`${String(i+1).padStart(2)} | ${e.row.email.padEnd(40)} | ${(e.row.NOME || "").slice(0, 14).padEnd(14)} | ${(e.row.OPEN_PROBABILITY || "").padStart(4)} | ${dt} | ${String(e.payment_count).padStart(6)} | ${e.total_spend.toFixed(2).padStart(7)}`);
  }
  console.log("\n=== Últimos 10 (mais antigos) ===");
  for (let i = enriched.length - 10; i < enriched.length; i++) {
    const e = enriched[i];
    const dt = e.created_max ? new Date(e.created_max).toISOString().slice(0, 10) : "—";
    console.log(`${String(i+1).padStart(4)} | ${e.row.email.padEnd(40)} | ${(e.row.NOME || "").slice(0, 14).padEnd(14)} | ${(e.row.OPEN_PROBABILITY || "").padStart(4)} | ${dt} | ${String(e.payment_count).padStart(6)} | ${e.total_spend.toFixed(2).padStart(7)}`);
  }

  // Distribuição de recência
  console.log("\n=== Distribuição de recência ===");
  const now = Date.now();
  const buckets = [
    [0, 30, "<30 dias"],
    [30, 90, "30-90d"],
    [90, 180, "90-180d"],
    [180, 365, "6-12mo"],
    [365, 730, "1-2 anos"],
    [730, 1095, "2-3 anos"],
    [1095, 1825, "3-5 anos"],
    [1825, 9999, ">5 anos"],
  ] as Array<[number, number, string]>;
  for (const [lo, hi, label] of buckets) {
    const n = enriched.filter((e) => {
      if (e.created_max === 0) return false;
      const days = (now - e.created_max) / (1000 * 60 * 60 * 24);
      return days >= lo && days < hi;
    }).length;
    if (n > 0) console.log(`  ${label.padEnd(10)}: ${String(n).padStart(5)} (${(n/enriched.length*100).toFixed(1)}%)`);
  }
  const noData = enriched.filter((e) => e.created_max === 0).length;
  if (noData > 0) console.log(`  sem data : ${String(noData).padStart(5)} (${(noData/enriched.length*100).toFixed(1)}%)`);
}
main();
