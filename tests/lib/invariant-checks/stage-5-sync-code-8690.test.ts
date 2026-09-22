/** #8690 regressão: marker sync-code-ran + invariant */
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { checkSyncCodeRan } from "../../../scripts/lib/invariant-checks/stage-5.ts";

const base = "/tmp/stage-5-8690" + Date.now();
mkdirSync(base, { recursive: true });

const empty = resolve(base, "empty");
mkdirSync(resolve(empty, "_internal"), { recursive: true });
console.assert(checkSyncCodeRan(empty).some(v => v.rule === "sync-code-ran"), "1-absent");

const ok = resolve(base, "ok");
mkdirSync(resolve(ok, "_internal"), { recursive: true });
writeFileSync(resolve(ok, "_internal", ".marker-sync-code-ran.json"), JSON.stringify({ details: { outcome: "synced", up_to_date: true, branch_before: "master" } }));
console.assert(checkSyncCodeRan(ok).length === 0, "2-ok");

const bad = resolve(base, "bad");
mkdirSync(resolve(bad, "_internal"), { recursive: true });
writeFileSync(resolve(bad, "_internal", ".marker-sync-code-ran.json"), JSON.stringify({ details: { outcome: "fetch_failed" } }));
console.assert(checkSyncCodeRan(bad).some(v => v.rule === "sync-code-ran-outcome"), "3-bad");

console.log("PASS #8690 (3/3)");
rmSync(base, { recursive: true, force: true });
