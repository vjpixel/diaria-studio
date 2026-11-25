import { it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, statSync, utimesSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

const script = resolve("scripts/gen-carousel-cards.ts");
function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", timeout: 30_000 });
}

for (const flag of ["--help", "-h"]) {
  it(`${flag} mostra uso sem edição nem fonte e preserva JPGs (#13926)`, () => {
    const dir = mkdtempSync(join(tmpdir(), "carousel-help-"));
    try {
      const names = ["p1", "p2", "p3", "cta"].map((slot) => `04-d1-carousel-${slot}.jpg`);
      for (const name of names) {
        const path = join(dir, name);
        writeFileSync(path, "arte aprovada");
        utimesSync(path, 1_600_000_000, 1_600_000_000);
      }
      const before = names.map((name) => statSync(join(dir, name)).mtimeMs);
      for (const args of [[flag], ["--edition-dir", dir, flag], [flag, "--edition-dir", dir, "--force"]]) {
        const result = run(args);
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /uso: gen-carousel-cards\.ts/);
        assert.match(result.stdout, /--edition-dir.*--force/s);
        assert.equal(result.stderr, "");
        assert.deepEqual(names.map((name) => statSync(join(dir, name)).mtimeMs), before);
        assert.deepEqual(readdirSync(dir).sort(), names.sort());
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const flag of ["--unknown", "--unknown=value", "-x"]) {
  it(`rejeita ${flag} antes da geração (#13926)`, () => {
    const result = run(["--edition-dir", "/edicao-inexistente", flag]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option/);
    assert.equal(result.stdout, "");
  });
}
