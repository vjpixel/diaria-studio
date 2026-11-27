import { it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removePoolItem } from "../scripts/remove-pool-item.ts";
import { movePoolItem } from "../scripts/move-pool-item.ts";

const url = "https://example.com/guia";
const md = `**🛠️ USE MELHOR**

**[Guia](https://example.com/guia)**
Use ChatPGT. (5 min)

---

**📡 RADAR**

**[Outro](https://example.com/outro)**
Outra notícia.

---
`;

for (const dryRun of [false, true]) {
  for (const operation of ["remove", "move"] as const) {
    for (const scenario of ["removed", "preserved", "missing", "empty", "no_error", "already_absent"] as const) {
      it(`#14270 ${operation}, ${scenario}, dryRun=${dryRun}`, () => {
        const dir = mkdtempSync(join(tmpdir(), "pool-error-14270-"));
        try {
          mkdirSync(join(dir, "_internal"));
          const input = scenario === "preserved" ? md + "\nChatPGT permanece aqui.\n" : md;
          writeFileSync(join(dir, "02-reviewed.md"), input);
          const record = {
            wrong_value: scenario === "empty" ? "" : scenario === "already_absent" ? "Gemnii" : "ChatPGT",
            no_error: scenario === "no_error",
          };
          const recordPath = join(dir, "_internal", "intentional-error.json");
          if (scenario !== "missing") writeFileSync(recordPath, JSON.stringify(record));
          const result = operation === "remove"
            ? removePoolItem(dir, url, { dryRun })
            : movePoolItem(dir, url, "radar", { dryRun });
          const steps = result.next_steps.filter((s) => s.includes("replant-intentional-error.ts"));
          const expected = scenario === "already_absent" || (operation === "remove" && scenario === "removed");
          assert.equal(steps.length, expected ? 1 : 0);
          if (expected) assert.ok(steps[0].includes(`--edition-dir ${dir}/`));
          if (dryRun) assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), input);
          if (scenario !== "missing") assert.equal(readFileSync(recordPath, "utf8"), JSON.stringify(record));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
}
