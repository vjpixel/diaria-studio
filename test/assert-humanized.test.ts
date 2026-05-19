/**
 * test/assert-humanized.test.ts (#1385)
 *
 * Cobre assertHumanized helper — usado pelo invariant Stage 2
 * `humanizer-ran` e pelo orchestrator-stage-2 §2c.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertHumanized,
  DEFAULT_SNAPSHOT_PAIRS,
} from "../scripts/lib/assert-humanized.ts";

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-assert-humanized-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return dir;
}

function setMtime(path: string, msAgo: number): void {
  const now = Date.now();
  const t = new Date(now - msAgo);
  utimesSync(path, t, t);
}

describe("assertHumanized (#1385)", () => {
  it("ok=true quando ambos snapshots presentes e mais recentes", () => {
    const dir = makeFixture();
    // Snapshot foi escrito DEPOIS do final (humanizer rodou após writer)
    writeFileSync(join(dir, "02-reviewed.md"), "content");
    setMtime(join(dir, "02-reviewed.md"), 60_000); // 1min ago
    writeFileSync(join(dir, "_internal", "02-humanized.md"), "snapshot");
    setMtime(join(dir, "_internal", "02-humanized.md"), 30_000); // 30s ago (newer)

    writeFileSync(join(dir, "03-social.md"), "content");
    setMtime(join(dir, "03-social.md"), 50_000);
    writeFileSync(join(dir, "_internal", "03-social-pre-humanizador.md"), "snapshot");
    setMtime(join(dir, "_internal", "03-social-pre-humanizador.md"), 20_000);

    const r = assertHumanized(dir);
    assert.equal(r.ok, true, JSON.stringify(r.missing));
    assert.equal(r.missing.length, 0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("ok=false quando snapshot social ausente (caso 260519)", () => {
    const dir = makeFixture();
    writeFileSync(join(dir, "02-reviewed.md"), "content");
    writeFileSync(join(dir, "_internal", "02-humanized.md"), "snapshot");
    writeFileSync(join(dir, "03-social.md"), "content");
    // social snapshot ausente — humanizer pulado

    const r = assertHumanized(dir);
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].final, "03-social.md");
    assert.equal(r.missing[0].reason, "snapshot_missing");
    rmSync(dir, { recursive: true, force: true });
  });

  it("ok=false quando newsletter snapshot ausente", () => {
    const dir = makeFixture();
    writeFileSync(join(dir, "02-reviewed.md"), "content");
    // newsletter snapshot ausente
    writeFileSync(join(dir, "03-social.md"), "content");
    writeFileSync(join(dir, "_internal", "03-social-pre-humanizador.md"), "snapshot");

    const r = assertHumanized(dir);
    assert.equal(r.ok, false);
    assert.equal(r.missing[0].final, "02-reviewed.md");
    assert.equal(r.missing[0].reason, "snapshot_missing");
    rmSync(dir, { recursive: true, force: true });
  });

  it("skip silencioso quando final não existe (stage não rodou ainda)", () => {
    const dir = makeFixture();
    // Nada — nem final, nem snapshot
    const r = assertHumanized(dir);
    assert.equal(r.ok, true, "Esperava ok=true (stage não rodou ainda, sem assertion possível)");
    rmSync(dir, { recursive: true, force: true });
  });

  it("detecta snapshot_stale: final muito mais recente que snapshot (>1h)", () => {
    const dir = makeFixture();
    writeFileSync(join(dir, "02-reviewed.md"), "content edited later");
    setMtime(join(dir, "02-reviewed.md"), 60_000); // 1min ago
    writeFileSync(join(dir, "_internal", "02-humanized.md"), "old snapshot");
    setMtime(join(dir, "_internal", "02-humanized.md"), 3 * 60 * 60 * 1000); // 3h ago (stale)

    writeFileSync(join(dir, "03-social.md"), "content");
    setMtime(join(dir, "03-social.md"), 50_000);
    writeFileSync(join(dir, "_internal", "03-social-pre-humanizador.md"), "snapshot");
    setMtime(join(dir, "_internal", "03-social-pre-humanizador.md"), 20_000);

    const r = assertHumanized(dir);
    assert.equal(r.ok, false);
    assert.equal(r.missing.length, 1);
    assert.equal(r.missing[0].final, "02-reviewed.md");
    assert.equal(r.missing[0].reason, "snapshot_stale");
    rmSync(dir, { recursive: true, force: true });
  });

  it("aceita snapshot levemente mais antigo (edição leve pós-humanizer, <1h tolerance)", () => {
    const dir = makeFixture();
    // Final escrito agora, snapshot escrito 30min atrás — dentro de tolerance
    writeFileSync(join(dir, "02-reviewed.md"), "lightly edited");
    setMtime(join(dir, "02-reviewed.md"), 0); // now
    writeFileSync(join(dir, "_internal", "02-humanized.md"), "snapshot");
    setMtime(join(dir, "_internal", "02-humanized.md"), 30 * 60 * 1000); // 30min ago

    writeFileSync(join(dir, "03-social.md"), "content");
    writeFileSync(join(dir, "_internal", "03-social-pre-humanizador.md"), "snapshot");

    const r = assertHumanized(dir);
    assert.equal(r.ok, true, JSON.stringify(r.missing));
    rmSync(dir, { recursive: true, force: true });
  });

  it("DEFAULT_SNAPSHOT_PAIRS cobre newsletter + social", () => {
    assert.equal(DEFAULT_SNAPSHOT_PAIRS.length, 2);
    assert.equal(DEFAULT_SNAPSHOT_PAIRS[0].final, "02-reviewed.md");
    assert.equal(DEFAULT_SNAPSHOT_PAIRS[1].final, "03-social.md");
  });
});
