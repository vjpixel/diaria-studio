/**
 * calibration-open-prob.ts — calibração per-contact de OPEN_PROBABILITY
 *
 * Fetcha engagement individual de uma campanha + join com brevo-import-t01.csv
 * pra ver se OPEN_PROBABILITY prediz comportamento real.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
const API_KEY = process.env.BREVO_CLARICE_API_KEY!;

const CAMPAIGN_ID = parseInt(process.argv[2] || "34");

interface Sub { email: string; status?: string; uniqueOpenings?: number; openings?: number; clicks?: number; }

async function fetchSubs(campaignId: number): Promise<Sub[]> {
  const all: Sub[] = [];
  let offset = 0;
  const limit = 500;
  for (;;) {
    const url = `https://api.brevo.com/v3/emailCampaigns/${campaignId}/exports/recipients?limit=${limit}&offset=${offset}`;
    // First try the direct campaign report endpoint
    const altUrl = `https://api.brevo.com/v3/smtp/statistics/reports?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { "api-key": API_KEY, Accept: "application/json" } });
    if (!res.ok) {
      // Fallback: list contacts in the list, then fetch each contact's engagement
      console.error(`exports/recipients not available (${res.status}). Falling back.`);
      return all;
    }
    const data = await res.json() as { contacts?: Sub[]; recipients?: Sub[] };
    const batch = data.contacts ?? data.recipients ?? [];
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

// Alternative: get list contacts + their stats
async function fetchListContactsWithStats(listId: number): Promise<Map<string, { uniqueOpens: number; clicks: number }>> {
  const out = new Map<string, { uniqueOpens: number; clicks: number }>();
  let offset = 0;
  const limit = 500;
  for (;;) {
    const url = `https://api.brevo.com/v3/contacts/lists/${listId}/contacts?limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { "api-key": API_KEY, Accept: "application/json" } });
    if (!res.ok) throw new Error(`list ${listId}: ${res.status}`);
    const data = await res.json() as {
      contacts: Array<{ email: string; attributes?: Record<string, unknown> }>;
    };
    if (!data.contacts || data.contacts.length === 0) break;
    for (const c of data.contacts) out.set(c.email.toLowerCase(), { uniqueOpens: 0, clicks: 0 });
    if (data.contacts.length < limit) break;
    offset += limit;
  }
  return out;
}

// Use the post-subscriber-engagement style — list contacts that opened from a campaign
// Brevo API: GET /emailCampaigns/{id}/exportRecipients (creates export job — too async)
// Better: campaign stats endpoint /smtp/statistics/events?campaignId=X (gives per-event)
async function fetchOpensViaEvents(campaignId: number): Promise<Map<string, number>> {
  const opens = new Map<string, number>();
  let offset = 0;
  const limit = 100;
  for (;;) {
    const url = `https://api.brevo.com/v3/smtp/statistics/events?campaignId=${campaignId}&event=opens&limit=${limit}&offset=${offset}`;
    const res = await fetch(url, { headers: { "api-key": API_KEY, Accept: "application/json" } });
    if (!res.ok) throw new Error(`events: ${res.status} ${await res.text()}`);
    const data = await res.json() as { events?: Array<{ email: string }>; total?: number };
    if (!data.events || data.events.length === 0) break;
    for (const e of data.events) {
      const k = e.email.toLowerCase();
      opens.set(k, (opens.get(k) ?? 0) + 1);
    }
    if (data.events.length < limit) break;
    offset += limit;
  }
  return opens;
}

function readCsv(path: string): Map<string, number> {
  const csv = readFileSync(path, "utf8");
  const lines = csv.split("\n").slice(1).filter((l) => l.trim());
  const m = new Map<string, number>();
  for (const l of lines) {
    const [email, , prob] = l.split(",");
    m.set(email.trim().toLowerCase(), parseInt(prob));
  }
  return m;
}

async function main() {
  const csvProbs = readCsv("data/clarice-subscribers/brevo-import-t01.csv");
  console.error(`Loaded ${csvProbs.size} contacts from t01.csv`);

  // List ID for the campaign — for W6 it's list 14
  const listIdMap: Record<number, number> = { 29: 9, 30: 10, 31: 11, 32: 12, 33: 13, 34: 14 };
  const listId = listIdMap[CAMPAIGN_ID];
  if (!listId) throw new Error(`unknown campaign id ${CAMPAIGN_ID}`);

  const listContacts = await fetchListContactsWithStats(listId);
  console.error(`List ${listId}: ${listContacts.size} contacts`);

  // Mark openers via events
  let opens: Map<string, number>;
  try {
    opens = await fetchOpensViaEvents(CAMPAIGN_ID);
    console.error(`Opens via events: ${opens.size} unique openers (from /smtp/statistics/events)`);
  } catch (e) {
    console.error(`events failed: ${e}`);
    opens = new Map();
  }

  // Bin by OPEN_PROBABILITY
  type Bin = { range: string; total: number; opened: number; probs: number[] };
  const bins: Bin[] = [
    { range: "0-10", total: 0, opened: 0, probs: [] },
    { range: "10-20", total: 0, opened: 0, probs: [] },
    { range: "20-30", total: 0, opened: 0, probs: [] },
    { range: "30-40", total: 0, opened: 0, probs: [] },
    { range: "40-50", total: 0, opened: 0, probs: [] },
    { range: "50-60", total: 0, opened: 0, probs: [] },
    { range: "60-70", total: 0, opened: 0, probs: [] },
    { range: "70-80", total: 0, opened: 0, probs: [] },
    { range: "80-100", total: 0, opened: 0, probs: [] },
  ];
  function binFor(p: number): Bin {
    if (p < 10) return bins[0];
    if (p < 20) return bins[1];
    if (p < 30) return bins[2];
    if (p < 40) return bins[3];
    if (p < 50) return bins[4];
    if (p < 60) return bins[5];
    if (p < 70) return bins[6];
    if (p < 80) return bins[7];
    return bins[8];
  }

  let matched = 0;
  let unmatched = 0;
  for (const email of listContacts.keys()) {
    const prob = csvProbs.get(email);
    if (prob === undefined) { unmatched++; continue; }
    matched++;
    const opened = opens.has(email) ? 1 : 0;
    const b = binFor(prob);
    b.total++;
    b.opened += opened;
    b.probs.push(prob);
  }
  console.error(`Matched ${matched} contacts, unmatched ${unmatched}`);
  console.error("");
  console.log(`Campaign ${CAMPAIGN_ID} (list ${listId}) — calibration by OPEN_PROBABILITY bin`);
  console.log(`bin         | n   | opened | actual_open_% | avg_prob_in_bin`);
  console.log(`------------+-----+--------+---------------+-----------------`);
  for (const b of bins) {
    if (b.total === 0) continue;
    const rate = (b.opened / b.total * 100).toFixed(1);
    const avgProb = (b.probs.reduce((a, c) => a + c, 0) / b.probs.length).toFixed(1);
    console.log(`${b.range.padEnd(11)} | ${String(b.total).padStart(3)} | ${String(b.opened).padStart(6)} | ${rate.padStart(12)}% | ${avgProb.padStart(15)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
