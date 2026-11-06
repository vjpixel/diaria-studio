import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { filterClariceSuggestions } from "../scripts/lib/clarice-suggestion-guard.ts";

const conditional = { from: "seria", to: "é" };
const real = { from: "as empresa", to: "as empresas" };
test("Stage 4 preserva condicional corrigido à mão e trechos do autofix", () => {
  const factual = { from: "40%", to: "50%" };
  const r = filterClariceSuggestions([conditional, factual, real], {
    correctedTexts: ["A redução foi de 40%."], protectConditional: true,
  });
  assert.deepEqual(r.kept, [real]);
  assert.deepEqual(r.dropped.map(d => d.reason), ["fact_check_protected", "fact_check_protected"]);
  assert.deepEqual(filterClariceSuggestions([conditional]).kept, [conditional]);
});
test("CLI integra proteção, ignora log dry-run e recusa log inválido", () => {
  const dir = mkdtempSync(join(tmpdir(), "clarice-factual-"));
  try {
    mkdirSync(join(dir, "_internal"));
    const input = join(dir, "in.json"), out = join(dir, "out.json");
    const log = join(dir, "_internal/fact-check-autofix.json");
    const factual = { from: "40%", to: "50%" };
    writeFileSync(input, JSON.stringify([conditional, factual, real]));
    const run = () => spawnSync(process.execPath, ["--import", "tsx", "scripts/clarice-filter.ts", "--edition-dir", dir, "--suggestions", input, "--out", out], { encoding: "utf8" });
    assert.equal(run().status, 0);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [factual, real]);
    writeFileSync(log, JSON.stringify({ entries: [
      { status: "applied", suggested_fix: "Caiu 40%." },
      { status: "skipped_no_fix", suggested_fix: "as empresa" },
    ] }));
    const r = run();
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [real]);
    assert.equal(JSON.parse(r.stdout).dropped, 2);
    writeFileSync(log, JSON.stringify({ dry_run: true, entries: [{ status: "applied", suggested_fix: "40%" }] }));
    assert.equal(run().status, 0);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), [factual, real]);
    writeFileSync(log, "{}");
    assert.equal(run().status, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("os dois fluxos do Stage 4 habilitam a proteção factual", () => {
  const text = readFileSync(".claude/agents/orchestrator-stage-4.md", "utf8");
  const commands = text.match(/scripts\/clarice-filter\.ts[^`]*`/g) ?? [];
  assert.equal(commands.length, 2);
  for (const command of commands) assert.match(command, /--edition-dir \{EDITION_DIR\}/);
  assert.match(text, /fact_check_protected/);
});
