// One-off helper for batch3 engagement backup — merges N raw engagement page
// files + 1 click-identity file, dedupes programmatically (never by hand),
// and pipes the result to apply-mcp-subscriber-engagement.ts via stdin.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , postId, title, pagesFetched, totalPages, clicksFile, ...pageFiles] = process.argv;

type Rec = Record<string, any>;

const bySubscriber = new Map<string, Rec>();
for (const f of pageFiles) {
  const data = JSON.parse(readFileSync(f, "utf8"));
  for (const s of data.subscribers as Rec[]) {
    bySubscriber.set(s.subscriber_id, s); // dedup by subscriber_id
  }
}

const clicksByEmail = new Map<string, Rec[]>();
if (clicksFile && clicksFile !== "-") {
  const clickData = JSON.parse(readFileSync(clicksFile, "utf8"));
  const seen = new Set<string>();
  for (const c of clickData.subscribers as Rec[]) {
    const key = `${c.subscription_id}|${c.url_hash}|${c.clicked_at}`;
    if (seen.has(key)) continue; // dedup by (sub, url_hash, clicked_at)
    seen.add(key);
    const list = clicksByEmail.get(c.email) ?? [];
    list.push({ subscription_id: c.subscription_id, url_hash: c.url_hash, clicked_at: c.clicked_at });
    clicksByEmail.set(c.email, list);
  }
}

const engagement = [...bySubscriber.values()].map((s) => {
  const clicks = clicksByEmail.get(s.email);
  return clicks ? { ...s, clicks } : s;
});

const payload = JSON.stringify({ engagement });
const args = [
  "scripts/apply-mcp-subscriber-engagement.ts",
  "--post-id",
  postId,
  "--title",
  title,
  "--pages-fetched",
  pagesFetched,
  "--total-pages",
  totalPages,
];
const out = execFileSync("npx", ["tsx", ...args], { input: payload, encoding: "utf8" });
console.log(out.trim());
console.log(`merged ${engagement.length} unique subscribers from ${pageFiles.length} page file(s)`);
