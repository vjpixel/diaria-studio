#!/usr/bin/env npx tsx
/** Read-only briefing queue (#12684). Failure is explicit, never an empty queue. */
import { execFileSync, spawnSync } from "node:child_process";
import { isMainModule } from "./lib/cli-args.ts";

export function overdueEscalation(events: { event: string; label?: { name: string }; created_at: string }[], now: number): string | null {
  let since: string | null = null;
  for (const event of events) {
    if (event.label?.name !== "continuo-escalado") continue;
    if (event.event === "labeled") since = event.created_at;
    if (event.event === "unlabeled") since = null;
  }
  return since && now - Date.parse(since) > 24 * 60 * 60 * 1000 ? since : null;
}

function gh(args: string[]): unknown {
  return JSON.parse(execFileSync("gh", args, { encoding: "utf8", timeout: 60_000 }));
}

if (isMainModule(import.meta.url)) {
  try {
    const prs = gh(["pr", "list", "--state", "open", "--label", "continuo-escalado", "--limit", "1000", "--json", "number,url"]) as { number: number; url: string }[];
    // Do not silently truncate a large queue.
    if (prs.length >= 1000) throw new Error("fila atingiu limite de paginação");
    const queue = [];
    for (const pr of prs) {
      const pages = gh(["api", `repos/{owner}/{repo}/issues/${pr.number}/events`, "--paginate", "--slurp"]) as Parameters<typeof overdueEscalation>[0][];
      const since = overdueEscalation(pages.flat(), Date.now());
      if (!since) continue;
      const gate = spawnSync("npx", ["tsx", "scripts/check-continuo-merge-gate.ts", "--pr", String(pr.number)], { encoding: "utf8", timeout: 180_000 });
      if (gate.error || ![0, 1, 2].includes(gate.status ?? -1)) throw new Error(`gate #${pr.number} falhou: ${gate.stderr}`);
      const result = JSON.parse(gate.stdout);
      queue.push({ ...pr, since, owner: "editor", queue: "briefing overnight/develop", action: result.action, reason: result.reason });
    }
    console.log(JSON.stringify({ queue }));
  } catch (error) {
    console.error(`[list-continuo-escalation-queue] ${String(error)}`);
    process.exitCode = 1;
  }
}
