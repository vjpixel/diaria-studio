import { classifyExecTrack } from "/home/vjpixel/diaria-studio/scripts/lib/issue-exec-track.ts";
import { execSync } from "node:child_process";
const raw = execSync("gh issue list --state open --limit 200 --json number,title,labels,body", { encoding: "utf8", maxBuffer: 40e6 });
const issues = JSON.parse(raw);
const counts = {};
const elig = [];
for (const i of issues) {
  const t = classifyExecTrack({ labels: (i.labels ?? []).map((l) => l.name), body: i.body ?? "" });
  const key = typeof t === "string" ? t : (t?.track ?? JSON.stringify(t));
  counts[key] = (counts[key] ?? 0) + 1;
  if (key === "overnight") elig.push(i.number);
}
console.log("total abertas:", issues.length);
console.log("por track:", JSON.stringify(counts));
console.log("elegiveis overnight:", elig.length, elig.slice(0, 12));
