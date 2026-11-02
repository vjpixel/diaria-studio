/**
 * test/sync-hint-gaps-11729.test.ts (#11729, resíduo do #11732)
 *
 * O #11732 pôs a dica "possível defasagem de sync do OneDrive" + idade do
 * arquivo mais recente da edição no `pipeline-sentinel.ts exists` e no
 * `assert --sync-hint` com sentinel ausente. Faltavam três caminhos pelos
 * quais uma skill `/diaria-*` no `300` ainda concluía "etapa não feita" sem
 * mostrar a idade:
 *   1. `find-current-edition.ts --stage N` sem candidatos (skill rodada sem
 *      AAMMDD, `.step-4-done.json` aprovado no Neo e ainda não sincronizado);
 *   2. `assert --sync-hint` com exit 2 (sentinel chegou, outputs ainda não);
 *   3. o exit 4 do `stale-edition-guard.ts` (dizia "aguardar o sync" sem
 *      a idade).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describeNoCandidates, findEditionsInProgress } from "../scripts/lib/find-current-edition.ts";
import { formatNewestFileEvidence, SYNC_LAG_PHRASE } from "../scripts/lib/sentinel-absence-hint.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// URL absoluta do tsx: com cwd num tmpdir, `--import tsx` não resolve o pacote.
const TSX_LOADER = import.meta.resolve("tsx");

function tsx(script: string, args: string[], cwd: string = repoRoot) {
  return spawnSync(process.execPath, ["--import", TSX_LOADER, join(repoRoot, script), ...args], {
    cwd,
    encoding: "utf8",
  });
}

describe("formatNewestFileEvidence (#11729)", () => {
  const NOW = Date.parse("2026-10-30T15:00:00Z");
  it("traz caminho, idade e ISO", () => {
    const s = formatNewestFileEvidence({ relPath: "03-social.md", mtimeMs: NOW - 2 * 3_600_000 }, NOW);
    assert.ok(s.includes("03-social.md"), s);
    assert.ok(s.includes("há 2 h 00 min"), s);
    assert.ok(s.includes("2026-10-30T13:00:00.000Z"), s);
  });
  it("pasta vazia não inventa idade", () => {
    assert.match(formatNewestFileEvidence(null, NOW), /ausente ou vazia/);
  });
});

describe("find-current-edition sem candidatos cita o sync (#11729)", () => {
  function setup(): { root: string; edition: string } {
    const root = mkdtempSync(join(tmpdir(), "fce-sync-"));
    const edition = join(root, "data", "editions", "2610", "261030");
    mkdirSync(join(edition, "_internal"), { recursive: true });
    // Stage 4 aprovado no Neo; aqui só chegaram os arquivos do Stage 2/3.
    writeFileSync(join(edition, "02-reviewed.md"), "x");
    writeFileSync(join(edition, "03-social.md"), "x");
    const old = new Date(Date.now() - 3 * 3_600_000);
    utimesSync(join(edition, "03-social.md"), old, old);
    utimesSync(join(edition, "02-reviewed.md"), old, old);
    return { root, edition };
  }

  it("describeNoCandidates: zero candidatos no Stage 5 → dica com o prereq e a idade", () => {
    const { root } = setup();
    try {
      assert.deepEqual(findEditionsInProgress(5, root), []);
      const hint = describeNoCandidates(5, root);
      assert.ok(hint, "esperava dica");
      assert.ok(hint!.includes(SYNC_LAG_PHRASE), hint!);
      assert.ok(hint!.includes("_internal/.step-4-done.json"), hint!);
      assert.ok(hint!.includes("261030"), hint!);
      assert.ok(hint!.includes("modificado há 3 h"), hint!);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("edição já concluída para o stage não gera dica", () => {
    const { root, edition } = setup();
    try {
      writeFileSync(join(edition, "_internal", ".step-4-done.json"), "{}");
      writeFileSync(join(edition, "_internal", "06-social-published.json"), "{}");
      assert.equal(describeNoCandidates(5, root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("sem data/editions não gera dica nem lança", () => {
    const root = mkdtempSync(join(tmpdir(), "fce-sync-empty-"));
    try {
      assert.equal(describeNoCandidates(5, root), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("CLI: stdout continua só o JSON; a dica vai para o stderr", () => {
    const { root } = setup();
    try {
      const r = tsx("scripts/lib/find-current-edition.ts", ["--stage", "5"], root);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { stage: 5, candidates: [] });
      assert.ok(r.stderr.includes(`[aviso] Nenhuma edição em curso para o Stage 5`), r.stderr);
      assert.ok(r.stderr.includes(SYNC_LAG_PHRASE), r.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("pipeline-sentinel assert exit 2 com --sync-hint (#11729)", () => {
  it("sentinel presente e outputs ausentes: dica só com --sync-hint", () => {
    const root = mkdtempSync(join(tmpdir(), "sentinel-exit2-"));
    try {
      const editionDir = join(root, "261030");
      mkdirSync(join(editionDir, "_internal"), { recursive: true });
      writeFileSync(
        join(editionDir, "_internal", ".step-4-done.json"),
        JSON.stringify({ step: 4, completed_at: "2026-10-30T12:22:00Z", outputs: ["02-reviewed.md", "03-social.md"] }),
      );
      writeFileSync(join(editionDir, "02-reviewed.md"), "x");
      const base = ["assert", "--edition", "261030", "--step", "4", "--dir", editionDir, "--outputs", "02-reviewed.md,03-social.md"];
      const plain = tsx("scripts/pipeline-sentinel.ts", base);
      assert.equal(plain.status, 2, plain.stderr);
      assert.ok(!plain.stderr.includes(SYNC_LAG_PHRASE), plain.stderr);
      const hinted = tsx("scripts/pipeline-sentinel.ts", [...base, "--sync-hint"]);
      assert.equal(hinted.status, 2, hinted.stderr);
      assert.ok(hinted.stderr.includes(SYNC_LAG_PHRASE), hinted.stderr);
      assert.ok(hinted.stderr.includes("03-social.md ausente"), hinted.stderr);
      assert.ok(hinted.stderr.includes("modificado há"), hinted.stderr);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stale-edition-guard exit 4 mostra a idade (#11729)", () => {
  it("mensagem de data/ defasado traz o arquivo mais recente da edição", () => {
    const dir = mkdtempSync(join(tmpdir(), "stale-age-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", ".step-5-done.json"), "{}");
      const r = tsx("scripts/stale-edition-guard.ts", ["check", "--edition-dir", dir, "--step", "4"]);
      assert.equal(r.status, 4, r.stderr);
      assert.ok(r.stderr.includes("Arquivo mais recente da edição aqui: _internal/.step-5-done.json"), r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
