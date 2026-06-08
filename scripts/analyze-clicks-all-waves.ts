/**
 * analyze-clicks-all-waves.ts — análise de clicks per-contact em T1
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
const API_KEY = process.env.BREVO_CLARICE_API_KEY!;

const waves = [
  { wave: "W1", campaign: 29, list: 9, day: "sex" },
  { wave: "W2", campaign: 30, list: 10, day: "seg" },
  { wave: "W3", campaign: 31, list: 11, day: "ter" },
  { wave: "W4", campaign: 32, list: 12, day: "qua" },
  { wave: "W5", campaign: 33, list: 13, day: "qui" },
  { wave: "W6", campaign: 34, list: 14, day: "sex" },
  { wave: "W7", campaign: 36, list: 15, day: "dom" },
];

async function exportClickers(campaignId: number): Promise<Set<string>> {
  const res = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/exportRecipients`, {
    method: "POST",
    headers: { "api-key": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ recipientsType: "clickers", notifyURL: "https://example.com/webhook" }),
  });
  if (!res.ok) {
    console.error(`  campaign ${campaignId}: ${res.status} ${await res.text()}`);
    return new Set();
  }
  const { processId } = await res.json() as { processId: number };
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pres = await fetch(`https://api.brevo.com/v3/processes/${processId}`, { headers: { "api-key": API_KEY } });
    const proc = await pres.json() as { status: string; export_url?: string };
    if (proc.status === "completed") {
      if (!proc.export_url) return new Set(); // no clickers
      const csv = await (await fetch(proc.export_url)).text();
      const lines = csv.split("\n").slice(1).filter((l) => l.trim());
      const out = new Set<string>();
      for (const l of lines) {
        const e = l.split(";")[2]?.trim().toLowerCase();
        if (e) out.add(e);
      }
      return out;
    }
  }
  return new Set();
}

async function fetchListEmails(listId: number): Promise<string[]> {
  const out: string[] = [];
  let offset = 0;
  for (;;) {
    const res = await fetch(`https://api.brevo.com/v3/contacts/lists/${listId}/contacts?limit=500&offset=${offset}`, {
      headers: { "api-key": API_KEY },
    });
    const data = await res.json() as { contacts: Array<{ email: string }> };
    if (!data.contacts?.length) break;
    for (const c of data.contacts) out.push(c.email.toLowerCase());
    if (data.contacts.length < 500) break;
    offset += 500;
  }
  return out;
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

async function main() {
  const probs = readProbs();
  const allClicks: { wave: string; day: string; email: string; prob: number }[] = [];
  const summary: { wave: string; day: string; sent: number; clickers: number; clickRate: number }[] = [];

  for (const w of waves) {
    const emails = await fetchListEmails(w.list);
    const clickers = await exportClickers(w.campaign);
    console.error(`${w.wave} (${w.day}): ${emails.length} sent, ${clickers.size} clickers`);
    summary.push({ wave: w.wave, day: w.day, sent: emails.length, clickers: clickers.size, clickRate: clickers.size / emails.length * 100 });
    for (const e of clickers) {
      const p = probs.get(e);
      if (p !== undefined) allClicks.push({ wave: w.wave, day: w.day, email: e, prob: p });
    }
  }

  console.log("\n=== Click rate por wave ===");
  console.log("Wave | dia | sent | clickers | rate%");
  for (const s of summary) {
    console.log(`${s.wave}   | ${s.day} | ${String(s.sent).padStart(4)} | ${String(s.clickers).padStart(8)} | ${s.clickRate.toFixed(2)}%`);
  }

  console.log(`\nTotal clicks: ${allClicks.length}`);
  console.log("\n=== Quem clicou (por OPEN_PROBABILITY) ===");
  console.log("wave | dia | prob | email");
  for (const c of allClicks.sort((a, b) => b.prob - a.prob)) {
    console.log(`${c.wave}   | ${c.day} | ${String(c.prob).padStart(4)} | ${c.email}`);
  }

  // OPEN_PROBABILITY bin analysis
  console.log("\n=== Clicks por bin OPEN_PROBABILITY ===");
  const probsAll: number[] = [];
  const clickersAll = new Set<string>();
  for (const w of waves) {
    const emails = await fetchListEmails(w.list);
    for (const e of emails) {
      const p = probs.get(e);
      if (p !== undefined) probsAll.push(p);
    }
  }
  for (const c of allClicks) clickersAll.add(c.email);

  const bins = [[0,30],[30,50],[50,60],[60,65],[65,70],[70,75],[75,80],[80,101]];
  console.log("bin       | n total | clickers | rate%");
  // re-collect by-contact data
  const contactData: { prob: number; clicked: boolean }[] = [];
  for (const w of waves) {
    const emails = await fetchListEmails(w.list);
    const clickers = await exportClickers(w.campaign);
    for (const e of emails) {
      const p = probs.get(e);
      if (p !== undefined) contactData.push({ prob: p, clicked: clickers.has(e) });
    }
  }
  for (const [lo, hi] of bins) {
    const f = contactData.filter((c) => c.prob >= lo && c.prob < hi);
    if (!f.length) continue;
    const cl = f.filter((c) => c.clicked).length;
    console.log(`${String(lo).padStart(3)}-${String(hi === 101 ? "80+" : hi).padEnd(3)} | ${String(f.length).padStart(7)} | ${String(cl).padStart(8)} | ${(cl / f.length * 100).toFixed(2)}%`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
