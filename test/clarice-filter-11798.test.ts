/** Regressão #11798 — fluxos manuais filtram o ruído da Clarice via clarice-filter. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { filterClariceSuggestions } from "../scripts/lib/clarice-suggestion-guard.ts";

const NOISE = [
  { from: "A OpenAI", to: "\n\nA OpenAI" },
  { from: ".", to: '."}]}]);\n}', explanation: "ponto final dentro das aspas" },
];
const REAL = { from: "os resultado", to: "os resultados", rule: "Concordância" };

test("filterClariceSuggestions mantém a correção real e descarta o ruído", () => {
  const r = filterClariceSuggestions([...NOISE, REAL, null, { from: 1 }]);
  assert.deepEqual(r.kept, [REAL]);
  assert.deepEqual(
    r.dropped.map((d) => d.reason),
    ["whitespace_only", "structural_injection", "invalid_shape", "invalid_shape"],
  );
});

test("CLI clarice-filter grava só as legítimas", () => {
  const dir = mkdtempSync(join(tmpdir(), "clarice-filter-"));
  const inp = join(dir, "in.json");
  const out = join(dir, "out.json");
  writeFileSync(inp, JSON.stringify([...NOISE, REAL]));
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/clarice-filter.ts", "--suggestions", inp, "--out", out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [REAL]);
  assert.equal(JSON.parse(r.stdout).dropped, 2);
});

test("CLI sem args sai 1", () => {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/clarice-filter.ts"], { encoding: "utf8" });
  assert.equal(r.status, 1);
});
