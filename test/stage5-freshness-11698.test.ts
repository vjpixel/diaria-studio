/** Regressão #11698: Stage 5 adquire edition-lock e é fail-closed com edição defasada. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkStage5Freshness } from "../scripts/lib/stage5-freshness.ts";
import { acquireEditionLock } from "../scripts/lib/edition-lock.ts";

const DONE = Date.parse("2026-10-30T20:00:00Z");

function edition(opts: { skip?: string[]; sentinel?: boolean } = {}): string {
  const d = mkdtempSync(join(tmpdir(), "s5fresh-"));
  mkdirSync(join(d, "_internal"));
  const t = new Date(DONE - 60_000);
  for (const f of ["02-reviewed.md", "03-social.md", "06-public-images.json"]) {
    if (opts.skip?.includes(f)) continue;
    writeFileSync(join(d, f), "x");
    utimesSync(join(d, f), t, t);
  }
  if (opts.sentinel !== false) {
    writeFileSync(
      join(d, "_internal", ".step-4-done.json"),
      JSON.stringify({ outputs: ["02-reviewed.md", "03-social.md"], completed_at: new Date(DONE).toISOString() }),
    );
  }
  return d;
}

describe("checkStage5Freshness (#11698)", () => {
  it("edição consistente → ok", () => {
    assert.deepEqual(checkStage5Freshness(edition()), { ok: true, problems: [] });
  });
  it("sentinel chegou antes dos arquivos → fail-closed", () => {
    const r = checkStage5Freshness(edition({ skip: ["03-social.md"] }));
    assert.equal(r.ok, false);
    assert.match(r.problems.join(), /03-social\.md: ausente/);
  });
  it("sem sentinel → fail-closed", () => {
    assert.equal(checkStage5Freshness(edition({ sentinel: false })).ok, false);
  });
  it("output mais novo que o sentinel → fail-closed", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "02-reviewed.md"), t, t);
    assert.match(checkStage5Freshness(d).problems.join(), /modificado após o sentinel/);
  });
  it("cópia de conflito do OneDrive → fail-closed", () => {
    const d = edition();
    writeFileSync(join(d, "02-reviewed-NEO.md"), "y");
    assert.match(checkStage5Freshness(d).problems.join(), /conflito/);
  });
  it("retomada: 06-public-images.json mais novo que o sentinel → ok", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "06-public-images.json"), t, t);
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("retomada: 03-social.md regravado pelo Stage 5 (mtime pós-sentinel) → ok (P1 review)", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "03-social.md"), t, t);
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("03-social.md vazio ainda bloqueia", () => {
    const d = edition();
    writeFileSync(join(d, "03-social.md"), "");
    assert.equal(checkStage5Freshness(d).ok, false);
  });
  it("--accept-newer: edição pós-gate liberada; ausente continua bloqueando", () => {
    const d = edition();
    const t = new Date(DONE + 3600_000);
    utimesSync(join(d, "02-reviewed.md"), t, t);
    assert.equal(checkStage5Freshness(d).ok, false);
    assert.equal(checkStage5Freshness(d, { acceptNewer: true }).ok, true);
    const e = edition({ skip: ["02-reviewed.md"] });
    assert.equal(checkStage5Freshness(e, { acceptNewer: true }).ok, false);
  });
  for (const name of [
    "02-reviewed-predator-safeBackup-0001.md",
    "02-reviewed-NEO-safeBackup-0001.md",
    "02-reviewed-neo.md",
    "02-reviewed.md.tmp",
    "02-reviewed-NEO.md",
  ]) {
    it(`conflito OneDrive real detectado: ${name} (P2 review)`, () => {
      const d = edition();
      writeFileSync(join(d, name), "y");
      assert.match(checkStage5Freshness(d).problems.join(), /conflito/);
    });
  }
  it("irmão legítimo 02-reviewed-final.md não é conflito", () => {
    const d = edition();
    writeFileSync(join(d, "02-reviewed-final.md"), "y");
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("irmão legítimo 03-social-pre-humanizador.md não é conflito", () => {
    const d = edition();
    writeFileSync(join(d, "03-social-pre-humanizador.md"), "y");
    assert.equal(checkStage5Freshness(d).ok, true);
  });
  it("sentinel sem completed_at → fail-closed", () => {
    const d = edition();
    writeFileSync(join(d, "_internal", ".step-4-done.json"), JSON.stringify({ outputs: [] }));
    assert.equal(checkStage5Freshness(d).ok, false);
  });
  it("não altera arquivos", () => {
    const d = edition();
    checkStage5Freshness(d);
    assert.equal(readFileSync(join(d, "02-reviewed.md"), "utf8"), "x");
  });
});

describe("Stage 5 e edition-lock (#11698)", () => {
  it("segunda sessão recebe held_by_other no Stage 5", () => {
    const d = edition();
    acquireEditionLock(d, { sessionId: "A", stage: 5 });
    assert.equal(acquireEditionLock(d, { sessionId: "B", stage: 5 }).action, "held_by_other");
  });
  it("playbook do Stage 5 chama acquire e freshness", () => {
    const md = readFileSync(new URL("../.claude/agents/orchestrator-stage-5.md", import.meta.url), "utf8");
    assert.match(md, /edition-lock\.ts acquire --edition-dir \{EDITION_DIR\} --stage 5/);
    assert.match(md, /stage5-freshness\.ts/);
  });
});
