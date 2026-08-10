/**
 * test/snapshot-audience-profile-4842.test.ts (#4842 item 2)
 *
 * Guard: `context/audience-profile.md` é regerado toda edição e pode mudar
 * significativamente em poucos dias (medido: derivou 9 de 17 posições em 5
 * dias) — sem um snapshot por edição, não há como saber retroativamente qual
 * tabela o scorer de uma edição PASSADA de fato leu. Cobre o script chamado
 * pelo Stage 0 (0i) logo após `update-audience.ts` regenerar o profile.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  snapshotAudienceProfile,
  SNAPSHOT_FILENAME,
} from "../scripts/snapshot-audience-profile.ts";

describe("snapshotAudienceProfile (unit)", () => {
  it("copia o profile fonte pra {editionDir}/_internal/audience-profile-snapshot.md", () => {
    const copyCalls: Array<[string, string]> = [];
    const mkdirCalls: string[] = [];
    const result = snapshotAudienceProfile("/edicoes/260423", "/context/audience-profile.md", {
      exists: () => true,
      copy: (src, dest) => copyCalls.push([src, dest]),
      mkdir: (p) => mkdirCalls.push(p),
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.dest, join("/edicoes/260423", "_internal", SNAPSHOT_FILENAME));
    }
    assert.deepEqual(copyCalls, [["/context/audience-profile.md", join("/edicoes/260423", "_internal", SNAPSHOT_FILENAME)]]);
    assert.deepEqual(mkdirCalls, [join("/edicoes/260423", "_internal")]);
  });

  it("profile fonte ausente → fail-soft, ok:false com motivo, sem copiar", () => {
    const copyCalls: Array<[string, string]> = [];
    const result = snapshotAudienceProfile("/edicoes/260423", "/context/audience-profile.md", {
      exists: () => false,
      copy: (src, dest) => copyCalls.push([src, dest]),
      mkdir: () => {},
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.reason, /ausente/);
    }
    assert.deepEqual(copyCalls, []);
  });
});

describe("snapshot-audience-profile CLI (#4842)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "snapshot-audience-profile.ts");
    return spawnSync(process.execPath, ["--import", "tsx", scriptPath, ...args], {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 15000,
    });
  }

  it("grava o snapshot em _internal/ a partir de --source explícito", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-audience-profile-"));
    try {
      const editionDir = join(dir, "260423");
      const sourcePath = join(dir, "fake-audience-profile.md");
      writeFileSync(sourcePath, "# Perfil da audiência\n\nCTR BR: 5%\n", "utf8");

      const r = runCli(["--edition-dir", editionDir, "--source", sourcePath]);
      assert.equal(r.status, 0, `CLI falhou: ${r.stderr}`);

      const destPath = join(editionDir, "_internal", SNAPSHOT_FILENAME);
      assert.ok(existsSync(destPath), "snapshot não foi gravado");
      assert.equal(readFileSync(destPath, "utf8"), readFileSync(sourcePath, "utf8"));

      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--source apontando pra arquivo inexistente → exit 0 (fail-soft), sem escrever nada", () => {
    const dir = mkdtempSync(join(tmpdir(), "snapshot-audience-profile-missing-"));
    try {
      const editionDir = join(dir, "260423");
      const sourcePath = join(dir, "nao-existe.md");

      const r = runCli(["--edition-dir", editionDir, "--source", sourcePath]);
      assert.equal(r.status, 0, "fail-soft: nunca deve abortar o Stage 0");
      assert.match(r.stderr, /WARN/);

      const destPath = join(editionDir, "_internal", SNAPSHOT_FILENAME);
      assert.ok(!existsSync(destPath));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem --edition-dir → exit 1 com uso", () => {
    const r = runCli([]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Uso:/);
  });
});
