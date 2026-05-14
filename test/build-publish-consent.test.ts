import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = resolve(ROOT, "scripts/build-publish-consent.ts");

function run(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", SCRIPT, ...args], {
    encoding: "utf8",
    cwd: ROOT,
    env: { ...process.env },
  });
}

describe("build-publish-consent CLI (#1238 follow-up)", () => {
  it("--help exibe usage com exit 0", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Uso:/);
  });

  it("sem --edition retorna exit 2", () => {
    const r = run(["--auto-approve"]);
    assert.equal(r.status, 2);
  });

  it("sem mode retorna exit 2", () => {
    const r = run(["--edition", "260514"]);
    assert.equal(r.status, 2);
  });

  it("múltiplos modes retornam exit 2", () => {
    const r = run(["--edition", "260514", "--auto-approve", "--default-manual"]);
    assert.equal(r.status, 2);
  });

  it("--auto-approve grava consent all-auto", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
    try {
      const out = join(dir, "consent.json");
      const r = run(["--edition", "260514", "--auto-approve", "--out", out]);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(parsed.newsletter, "auto");
      assert.equal(parsed.linkedin, "auto");
      assert.equal(parsed.facebook, "auto");
      assert.equal(parsed.source, "auto_approve_default");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--default-manual grava consent all-manual", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
    try {
      const out = join(dir, "consent.json");
      const r = run(["--edition", "260514", "--default-manual", "--out", out]);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(parsed.newsletter, "manual");
      assert.equal(parsed.source, "default_manual");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--editor-response 'all' grava all-auto", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
    try {
      const out = join(dir, "consent.json");
      const r = run(["--edition", "260514", "--editor-response", "all", "--out", out]);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(parsed.newsletter, "auto");
      assert.match(parsed.source, /editor_response/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--editor-response '1,3,5' grava all-auto via CSV", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
    try {
      const out = join(dir, "consent.json");
      const r = run(["--edition", "260514", "--editor-response", "1,3,5", "--out", out]);
      assert.equal(r.status, 0);
      const parsed = JSON.parse(readFileSync(out, "utf8"));
      assert.equal(parsed.newsletter, "auto");
      assert.equal(parsed.linkedin, "auto");
      assert.equal(parsed.facebook, "auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--editor-response inválida retorna exit 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
    try {
      const out = join(dir, "consent.json");
      const r = run(["--edition", "260514", "--editor-response", "abc", "--out", out]);
      assert.equal(r.status, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cria diretório de saída se não existe", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
    try {
      const out = join(dir, "nested", "deep", "consent.json");
      const r = run(["--edition", "260514", "--auto-approve", "--out", out]);
      assert.equal(r.status, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stdout duplica JSON pra pipe/redirecionamento", () => {
    const dir = mkdtempSync(join(tmpdir(), "consent-test-"));
    try {
      const out = join(dir, "consent.json");
      const r = run(["--edition", "260514", "--auto-approve", "--out", out]);
      assert.equal(r.status, 0);
      const fromStdout = JSON.parse(r.stdout);
      assert.equal(fromStdout.newsletter, "auto");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
