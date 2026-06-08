/**
 * correlate-prob-opens.ts — correlação per-contact entre OPEN_PROBABILITY/score e abrir
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
const API_KEY = process.env.BREVO_CLARICE_API_KEY!;

const waves = [
  { wave: "W1", campaign: 29, list: 9 },
  { wave: "W2", campaign: 30, list: 10 },
  { wave: "W3", campaign: 31, list: 11 },
  { wave: "W4", campaign: 32, list: 12 },
  { wave: "W5", campaign: 33, list: 13 },
  { wave: "W6", campaign: 34, list: 14 },
];

async function exportOpeners(campaignId: number): Promise<Set<string>> {
  const res = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/exportRecipients`, {
    method: "POST",
    headers: { "api-key": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ recipientsType: "openers", notifyURL: "https://example.com/webhook" }),
  });
  const { processId } = await res.json() as { processId: number };
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pres = await fetch(`https://api.brevo.com/v3/processes/${processId}`, { headers: { "api-key": API_KEY } });
    const proc = await pres.json() as { status: string; export_url?: string };
    if (proc.status === "completed" && proc.export_url) {
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
  throw new Error(`timeout ${campaignId}`);
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

interface Row { email: string; wave: string; rank: number; prob: number; opened: 0 | 1; }

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}

async function main() {
  // t01.csv with row index = score rank
  const csv = readFileSync("data/clarice-subscribers/brevo-import-t01.csv", "utf8");
  const lines = csv.split("\n").slice(1).filter((l) => l.trim());
  const emailToData = new Map<string, { rank: number; prob: number }>();
  for (let i = 0; i < lines.length; i++) {
    const [email, , prob] = lines[i].split(",");
    emailToData.set(email.trim().toLowerCase(), { rank: i + 1, prob: parseInt(prob) });
  }

  // Build dataset
  const rows: Row[] = [];
  for (const w of waves) {
    const emails = await fetchListEmails(w.list);
    const openers = await exportOpeners(w.campaign);
    for (const e of emails) {
      const d = emailToData.get(e);
      if (!d) continue;
      rows.push({ email: e, wave: w.wave, rank: d.rank, prob: d.prob, opened: openers.has(e) ? 1 : 0 });
    }
    console.error(`${w.wave}: ${emails.length} emails, ${openers.size} openers`);
  }
  console.error(`\nTotal rows: ${rows.length}, total opens: ${rows.filter(r => r.opened).length}`);

  // === Correlation aggregate ===
  console.log("\n=== Correlação per-contact AGREGADA (todas as waves combinadas) ===");
  const probs = rows.map((r) => r.prob);
  const ranks = rows.map((r) => r.rank);
  const opened = rows.map((r) => r.opened);
  console.log(`Pearson r (OPEN_PROBABILITY → opened): ${pearson(probs, opened).toFixed(4)}`);
  console.log(`Pearson r (score rank → opened):        ${pearson(ranks, opened).toFixed(4)}`);
  console.log(`(Nota: rank baixo = score alto. Esperado r negativo se score predizer abertura)`);

  // === Within-wave (controla efeito sender/dia) ===
  console.log("\n=== Correlação per-contact POR WAVE (controla efeito sender/dia) ===");
  console.log("Wave | n   | opens | r(prob→opened) | r(rank→opened)");
  for (const w of waves) {
    const wrows = rows.filter((r) => r.wave === w.wave);
    if (wrows.length < 3) continue;
    const wp = wrows.map((r) => r.prob);
    const wr = wrows.map((r) => r.rank);
    const wo = wrows.map((r) => r.opened);
    const rProb = pearson(wp, wo);
    const rRank = pearson(wr, wo);
    console.log(`${w.wave}   | ${String(wrows.length).padStart(3)} | ${String(wrows.filter(r=>r.opened).length).padStart(5)} | ${rProb.toFixed(4).padStart(14)} | ${rRank.toFixed(4).padStart(14)}`);
  }

  // === Bins by prob (aggregate) ===
  console.log("\n=== Bins de OPEN_PROBABILITY (agregado, todas waves) ===");
  const buckets = [[0,30],[30,50],[50,60],[60,65],[65,70],[70,75],[75,80]];
  console.log("bin       | n   | opened | %");
  for (const [lo, hi] of buckets) {
    const f = rows.filter((r) => r.prob >= lo && r.prob < hi);
    if (!f.length) continue;
    const op = f.filter((r) => r.opened).length;
    console.log(`${String(lo).padStart(3)}-${String(hi).padEnd(3)} | ${String(f.length).padStart(3)} | ${String(op).padStart(6)} | ${(op/f.length*100).toFixed(1)}%`);
  }

  // === Logistic-style: split into top/bottom half within each wave, compare opens ===
  console.log("\n=== Within-wave: top-half vs bottom-half do OPEN_PROBABILITY ===");
  console.log("Wave | top%   | bot%   | uplift (pp) | uplift relativo");
  for (const w of waves) {
    const wrows = rows.filter((r) => r.wave === w.wave).sort((a, b) => b.prob - a.prob);
    if (wrows.length < 4) continue;
    const mid = Math.floor(wrows.length / 2);
    const top = wrows.slice(0, mid);
    const bot = wrows.slice(mid);
    const topR = top.filter((r) => r.opened).length / top.length * 100;
    const botR = bot.filter((r) => r.opened).length / bot.length * 100;
    const uplift = topR - botR;
    const rel = botR > 0 ? (topR / botR).toFixed(2) + "x" : (topR > 0 ? "∞" : "n/a");
    console.log(`${w.wave}   | ${topR.toFixed(1).padStart(5)}% | ${botR.toFixed(1).padStart(5)}% | ${uplift.toFixed(1).padStart(11)} | ${rel.padStart(15)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
