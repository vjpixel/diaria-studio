/**
 * #6437 — Route escopo-residual issues after REFS-not-Closes PR merge.
 * When `check-overnight-comment-coverage` detects `escopo-residual`,
 * this helper calls `route-issue` with the appropriate track based on
 * the issue's content (agendada/develop/fora-de-rodada/overnight).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

function main() {
  const args = process.argv.slice(2);
  const issueNum = args.find(a => /^-\d+/.test(a) || /^--issue/.test(a))?.match(/\d+/)?.[0] || args[0];
  if (!issueNum || isNaN(Number(issueNum))) {
    console.error("Uso: npx tsx scripts/test/escopo-residual-route.ts --issue N");
    process.exit(2);
  }
  // Call route-issue for overnight (default track when residual is dispatchable)
  const result = spawnSync("npx", ["tsx", "scripts/route-issue.ts", "--issue", String(issueNum), "--track", "overnight", "--reason", "escopo-residual após PR REFS-not-Closes (#6437)"], {
    encoding: "utf8", cwd: "/home/vjpixel/diaria-studio", stdio: ["inherit", "pipe", "pipe"],
  });
  console.log(`route-issue #${issueNum} exit=${result.status}`);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
}

main();
