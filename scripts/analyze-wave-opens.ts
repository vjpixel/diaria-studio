/**
 * analyze-wave-opens.ts (one-off — investigação trend de open rate)
 *
 * Fetcha campanhas 29-34 do Brevo + agrega métricas pra análise.
 */
import "dotenv/config";
const API_KEY = process.env.BREVO_CLARICE_API_KEY!;

interface Campaign {
  id: number;
  name: string;
  subject: string;
  sentDate: string;
  scheduledAt: string;
  recipients?: { lists?: number[] };
  statistics?: {
    campaignStats?: Array<{
      listId: number;
      sent: number;
      delivered: number;
      uniqueViews: number;
      viewed: number;
      uniqueClicks: number;
      clickers: number;
      hardBounces: number;
      softBounces: number;
      unsubscriptions: number;
      complaints: number;
      trackableViews: number;
    }>;
  };
}

async function getCampaign(id: number): Promise<Campaign> {
  const res = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, {
    headers: { "api-key": API_KEY, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET campaign ${id}: ${res.status} ${await res.text()}`);
  return await res.json() as Campaign;
}

async function main() {
  const ids = [29, 30, 31, 32, 33, 34];
  console.log("wave | id  | list | sent       | recipients | delivered | uniq_open | open_rate | uniq_click | click_rate | bounces | unsub");
  console.log("-----+-----+------+------------+------------+-----------+-----------+-----------+------------+------------+---------+------");
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    try {
      const c = await getCampaign(id);
      const g = c.statistics?.campaignStats?.[0] ?? null;
      const sent = g?.sent ?? 0;
      const delivered = g?.delivered ?? sent;
      const uniqOpen = g?.uniqueViews ?? 0;
      const uniqClick = g?.uniqueClicks ?? 0;
      const bounces = (g?.hardBounces ?? 0) + (g?.softBounces ?? 0);
      const unsub = g?.unsubscriptions ?? 0;
      const openRate = delivered > 0 ? (uniqOpen / delivered * 100).toFixed(2) : "n/a";
      const clickRate = delivered > 0 ? (uniqClick / delivered * 100).toFixed(2) : "n/a";
      const listId = c.recipients?.lists?.[0] ?? "?";
      const sentStr = (c.sentDate || c.scheduledAt || "").slice(0, 10);
      console.log(`W${i + 1}   | ${id}  | ${String(listId).padEnd(4)} | ${sentStr} | ${String(sent).padStart(10)} | ${String(delivered).padStart(9)} | ${String(uniqOpen).padStart(9)} | ${openRate.padStart(8)}% | ${String(uniqClick).padStart(10)} | ${clickRate.padStart(9)}% | ${String(bounces).padStart(7)} | ${String(unsub).padStart(5)}`);
    } catch (e) {
      console.log(`W${i + 1}   | ${id}  | error: ${(e as Error).message.slice(0, 80)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
