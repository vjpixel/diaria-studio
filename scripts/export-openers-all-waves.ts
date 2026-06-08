/**
 * export-openers-all-waves.ts — exporta openers de todas as 6 waves + calibração
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
const API_KEY = process.env.BREVO_CLARICE_API_KEY!;

async function exportOpeners(campaignId: number): Promise<Set<string>> {
  // POST exportRecipients
  const res = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/exportRecipients`, {
    method: "POST",
    headers: { "api-key": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ recipientsType: "openers", notifyURL: "https://example.com/webhook" }),
  });
  if (!res.ok) throw new Error(`exportRecipients ${campaignId}: ${res.status} ${await res.text()}`);
  const { processId } = await res.json() as { processId: number };
  console.error(`  campaign ${campaignId}: processId=${processId}, waiting...`);

  // Poll process
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pres = await fetch(`https://api.brevo.com/v3/processes/${processId}`, {
      headers: { "api-key": API_KEY, Accept: "application/json" },
    });
    if (!pres.ok) continue;
    const proc = await pres.json() as { status: string; export_url?: string };
    if (proc.status === "completed" && proc.export_url) {
      console.error(`  campaign ${campaignId}: export ready`);
      const csvRes = await fetch(proc.export_url);
      const csv = await csvRes.text();
      const lines = csv.split("\n").slice(1).filter((l) => l.trim());
      const emails = new Set<string>();
      for (const line of lines) {
        const cols = line.split(";");
        const email = cols[2]?.trim().toLowerCase();
        if (email && email.includes("@")) emails.add(email);
      }
      return emails;
    }
  }
  throw new Error(`timeout waiting for campaign ${campaignId} export`);
}

function readProbs(): Map<string, number> {
  const csv = readFileSync("data/clarice-subscribers/brevo-import-t01.csv", "utf8");
  const lines = csv.split("\n").slice(1).filter((l) => l.trim());
  const m = new Map<string, number>();
  for (const l of lines) {
    const [email, , prob] = l.split(",");
    m.set(email.trim().toLowerCase(), parseInt(prob));
  }
  return m;
}

async function fetchListEmails(listId: number): Promise<string[]> {
  const out: string[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts?limit=500&offset=${offset}`, {
      headers: { "api-key": API_KEY, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`list ${listId}: ${res.status}`);
    const data = await res.json() as { contacts: Array<{ email: string }> };
    if (!data.contacts.length) break;
    for (const c of data.contacts) out.push(c.email.toLowerCase());
    if (data.contacts.length < 500) break;
    offset += 500;
  }
  return out;
}

async function main() {
  const probs = readProbs();
  const waves = [
    { wave: "W1", campaign: 29, list: 9 },
    { wave: "W2", campaign: 30, list: 10 },
    { wave: "W3", campaign: 31, list: 11 },
    { wave: "W4", campaign: 32, list: 12 },
    { wave: "W5", campaign: 33, list: 13 },
    { wave: "W6", campaign: 34, list: 14 },
  ];

  // Bins
  type Bin = { lo: number; hi: number; total: number; opened: number };
  function makeBins(): Bin[] {
    return [
      { lo: 0, hi: 30, total: 0, opened: 0 },
      { lo: 30, hi: 50, total: 0, opened: 0 },
      { lo: 50, hi: 60, total: 0, opened: 0 },
      { lo: 60, hi: 70, total: 0, opened: 0 },
      { lo: 70, hi: 101, total: 0, opened: 0 },
    ];
  }
  function bin(bins: Bin[], p: number): Bin {
    for (const b of bins) if (p >= b.lo && p < b.hi) return b;
    return bins[bins.length - 1];
  }

  // Aggregate across all waves
  const globalBins = makeBins();
  const perWaveBins = new Map<string, Bin[]>();

  for (const w of waves) {
    console.error(`\n${w.wave} (campaign ${w.campaign}, list ${w.list}):`);
    const listEmails = await fetchListEmails(w.list);
    const openers = await exportOpeners(w.campaign);
    console.error(`  list size=${listEmails.length}, openers=${openers.size}`);

    const wbins = makeBins();
    for (const e of listEmails) {
      const p = probs.get(e);
      if (p === undefined) continue;
      const b1 = bin(globalBins, p);
      const b2 = bin(wbins, p);
      const opened = openers.has(e) ? 1 : 0;
      b1.total++; b1.opened += opened;
      b2.total++; b2.opened += opened;
    }
    perWaveBins.set(w.wave, wbins);
  }

  console.log("\n=== CALIBRAÇÃO AGREGADA (todas as 6 waves combinadas) ===");
  console.log("bin       | n    | opened | open_%  | (esperado se prob é literal)");
  for (const b of globalBins) {
    if (!b.total) continue;
    const rate = (b.opened / b.total * 100).toFixed(1);
    const midPoint = (b.lo + Math.min(b.hi, 80)) / 2;
    console.log(`${String(b.lo).padStart(3)}-${String(b.hi === 101 ? 80 : b.hi).padEnd(3)} | ${String(b.total).padStart(4)} | ${String(b.opened).padStart(6)} | ${rate.padStart(5)}% | ~${midPoint.toFixed(0)}%`);
  }

  console.log("\n=== POR WAVE ===");
  console.log("Wave | <30 | 30-50 | 50-60 | 60-70 | 70+    (open_%/n)");
  for (const [wave, bins] of perWaveBins) {
    const cells = bins.map((b) => b.total === 0 ? "  -" : `${(b.opened / b.total * 100).toFixed(0)}%/${b.total}`);
    console.log(`${wave}   | ${cells.map((c) => c.padEnd(7)).join(" | ")}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
