/**
 * analyze-open-times.ts — extrai hora/dia de cada open + lag desde send
 */
import "dotenv/config";
const API_KEY = process.env.BREVO_CLARICE_API_KEY!;

const waves = [
  { wave: "W1", campaign: 29, send: "2026-05-08T19:24:07-03:00" },
  { wave: "W2", campaign: 30, send: "2026-05-11T06:03:09-03:00" },
  { wave: "W3", campaign: 31, send: "2026-05-12T06:14:34-03:00" },
  { wave: "W4", campaign: 32, send: "2026-05-13T06:14:33-03:00" },
  { wave: "W5", campaign: 33, send: "2026-05-14T06:14:18-03:00" },
  { wave: "W6", campaign: 34, send: "2026-05-15T06:48:25-03:00" },
];

interface Open { email: string; sendDate: string; openDate: string; }

async function exportOpens(campaignId: number): Promise<Open[]> {
  const res = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/exportRecipients`, {
    method: "POST",
    headers: { "api-key": API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ recipientsType: "openers", notifyURL: "https://example.com/webhook" }),
  });
  const { processId } = await res.json() as { processId: number };
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const pres = await fetch(`https://api.brevo.com/v3/processes/${processId}`, {
      headers: { "api-key": API_KEY },
    });
    const proc = await pres.json() as { status: string; export_url?: string };
    if (proc.status === "completed" && proc.export_url) {
      const csv = await (await fetch(proc.export_url)).text();
      const lines = csv.split("\n").slice(1).filter((l) => l.trim());
      const opens: Open[] = [];
      for (const line of lines) {
        const cols = line.split(";");
        const email = cols[2]?.trim().toLowerCase();
        const sendDate = cols[3]?.trim();
        const openDate = cols[5]?.trim();
        if (email && openDate) opens.push({ email, sendDate, openDate });
      }
      return opens;
    }
  }
  throw new Error(`timeout ${campaignId}`);
}

function parseOpenDate(s: string): Date {
  // formato: "15-05-2026 08:56:59" (BRT, sem TZ)
  const [d, t] = s.split(" ");
  const [day, mon, year] = d.split("-").map(Number);
  const [hr, mn, sec] = t.split(":").map(Number);
  // Brevo open dates are in BRT (UTC-3)
  return new Date(Date.UTC(year, mon - 1, day, hr + 3, mn, sec));
}

async function main() {
  console.log("Wave | n  | hora envio (BRT) | dia    | open_hr_BRT modal | lag_h median");
  console.log("-----+----+------------------+--------+-------------------+------------");

  const allHourDist: number[][] = []; // per-wave: [count for hour 0..23]

  for (const w of waves) {
    const opens = await exportOpens(w.campaign);
    const sendDt = new Date(w.send);
    const lags: number[] = [];
    const hourDist = new Array(24).fill(0);
    for (const o of opens) {
      const od = parseOpenDate(o.openDate);
      const lagH = (od.getTime() - sendDt.getTime()) / (1000 * 60 * 60);
      lags.push(lagH);
      // BRT hour = UTC - 3
      const brtHour = (od.getUTCHours() - 3 + 24) % 24;
      hourDist[brtHour]++;
    }
    allHourDist.push(hourDist);
    lags.sort((a, b) => a - b);
    const median = lags.length ? lags[Math.floor(lags.length / 2)] : NaN;
    const modalHour = hourDist.indexOf(Math.max(...hourDist));
    const sendStr = w.send.slice(11, 16);
    const dayShort = ["seg","ter","qua","qui","sex","sab","dom"][sendDt.getDay() === 0 ? 6 : sendDt.getDay() - 1];
    console.log(`${w.wave}   | ${String(opens.length).padStart(2)} | ${sendStr.padEnd(16)} | ${dayShort.padEnd(6)} | ${String(modalHour).padStart(2)}h (${hourDist[modalHour]} opens)     | ${median.toFixed(1)}h`);
  }

  console.log("\n=== Distribuição de hora-do-dia (BRT) de opens por wave ===");
  console.log("hr | W1 W2 W3 W4 W5 W6");
  for (let h = 0; h < 24; h++) {
    const cells = allHourDist.map((d) => String(d[h]).padStart(2)).join(" ");
    if (allHourDist.some((d) => d[h] > 0)) console.log(`${String(h).padStart(2)} | ${cells}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
