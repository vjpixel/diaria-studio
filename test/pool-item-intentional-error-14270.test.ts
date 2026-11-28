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

function withEdition(mdText: string, record: Record<string, unknown>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "pool-error-14278-"));
  try {
    mkdirSync(join(dir, "_internal"));
    writeFileSync(join(dir, "02-reviewed.md"), mdText);
    writeFileSync(join(dir, "_internal", "intentional-error.json"), JSON.stringify(record));
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const replantSteps = (steps: string[]) => steps.filter((s) => s.includes("replant-intentional-error.ts"));

// #14278: placeholder `{PREENCHER ...}` não é verificável — nunca manda replantar.
for (const operation of ["remove", "move"] as const) {
  for (const dryRun of [false, true]) {
    it(`#14278 ${operation}, wrong_value placeholder não dispara replantio, dryRun=${dryRun}`, () => {
      withEdition(md, { wrong_value: "{PREENCHER: valor errado plantado}", location: "{PREENCHER}" }, (dir) => {
        const result = operation === "remove"
          ? removePoolItem(dir, url, { dryRun })
          : movePoolItem(dir, url, "radar", { dryRun });
        assert.deepEqual(replantSteps(result.next_steps), []);
        assert.equal(result.next_steps.filter((s) => s.includes("mudou de")).length, 0);
      });
    });
  }
}

// #14278 P3: presença por palavra inteira — "Large 3" dentro de "Large 30" não conta.
it("#14278 remove: valor errado só dentro de palavra maior conta como ausente", () => {
  const input = md.replace("Use ChatPGT.", "Use Large 3.").replace("Outra notícia.", "Saiu o Large 30.");
  withEdition(input, { wrong_value: "Large 3" }, (dir) => {
    assert.equal(replantSteps(removePoolItem(dir, url, { dryRun: true }).next_steps).length, 1);
  });
});

// #14278 ponto lateral: mover o item com o erro avisa que `location` aponta pra seção antiga.
for (const [location, expected] of [["USE MELHOR (Guia)", 1], ["RADAR", 0], [undefined, 0]] as const) {
  it(`#14278 move do item com o erro, location=${String(location)}`, () => {
    withEdition(md, { wrong_value: "ChatPGT", location }, (dir) => {
      const result = movePoolItem(dir, url, "radar", { dryRun: true });
      assert.equal(result.next_steps.filter((s) => s.includes("mudou de USE MELHOR para RADAR")).length, expected);
      assert.deepEqual(replantSteps(result.next_steps), []);
    });
  });
}
