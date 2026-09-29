/**
 * list-autostashes.ts (#8991) — lista (read-only) os autostashes de sync-code.
 * Uso: npx tsx scripts/list-autostashes.ts
 */
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { listAutostashes, formatAutostashReport } from "./lib/autostash-report.ts";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const entries = listAutostashes((cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  });
  process.stdout.write(formatAutostashReport(entries));
}
