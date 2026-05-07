import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReport,
  listInternalJsonFiles,
  payloadLevel,
  PAYLOAD_WARN_BYTES,
  PAYLOAD_ERROR_BYTES,
} from "../scripts/log-stage-1-payload-sizes.ts";

function makeFixture(): { root: string; internalDir: string; edition: string } {
  const root = mkdtempSync(join(tmpdir(), "stage1-payload-sizes-"));
  const editionDir = join(root, "data", "editions", "260507");
  const internalDir = join(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  return { root, internalDir, edition: "260507" };
}

describe("listInternalJsonFiles (#891)", () => {
  it("retorna [] quando _internal/ não existe", () => {
    const root = mkdtempSync(join(tmpdir(), "stage1-payload-empty-"));
    try {
      const files = listInternalJsonFiles(join(root, "missing"));
      assert.deepEqual(files, []);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("lista apenas .json, ignorando .md/.bak/etc", () => {
    const { root, internalDir } = makeFixture();
    try {
      writeFileSync(join(internalDir, "researcher-results.json"), "[]");
      writeFileSync(join(internalDir, "01-categorized.json"), "{}");
      writeFileSync(join(internalDir, "01-categorized.md.bak-2026-05-07"), "stale md");
      writeFileSync(join(internalDir, "cost.md"), "# cost");
      writeFileSync(join(internalDir, "01-categorized.json.pre-refinement.bak"), "{}");

      const files = listInternalJsonFiles(internalDir);
      const names = files.map((f) => f.split(/[\\/]/).pop()).sort();
      assert.deepEqual(names, ["01-categorized.json", "researcher-results.json"]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("ignora subdir link-verify-bodies (cache de raw HTML, não payload de agent)", () => {
    const { root, internalDir } = makeFixture();
    try {
      writeFileSync(join(internalDir, "link-verify-all.json"), "[]");
      const bodiesDir = join(internalDir, "link-verify-bodies");
      mkdirSync(bodiesDir, { recursive: true });
      writeFileSync(join(bodiesDir, "001.html"), "<html>...</html>");
      writeFileSync(join(bodiesDir, "002.json"), "{\"oops\":true}");

      const files = listInternalJsonFiles(internalDir);
      const names = files.map((f) => f.split(/[\\/]/).pop());
      assert.deepEqual(names, ["link-verify-all.json"]);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("ignora _test-backup-* dirs", () => {
    const { root, internalDir } = makeFixture();
    try {
      writeFileSync(join(internalDir, "01-approved.json"), "{}");
      const backupDir = join(internalDir, "_test-backup-20260505-181634");
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, "01-approved.json"), "{}");

      const files = listInternalJsonFiles(internalDir);
      assert.equal(files.length, 1);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("buildReport (#891)", () => {
  it("agrega bytes e calcula tokens estimados", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      // 100 bytes
      writeFileSync(join(internalDir, "researcher-results.json"), "x".repeat(100));
      // 200 bytes
      writeFileSync(join(internalDir, "tmp-articles-raw.json"), "y".repeat(200));

      const report = buildReport({
        edition,
        internalDir,
        repoRoot: root,
        now: new Date("2026-05-07T12:00:00.000Z"),
      });

      assert.equal(report.edition, "260507");
      assert.equal(report.generated_at, "2026-05-07T12:00:00.000Z");
      assert.equal(report.totals.file_count, 2);
      assert.equal(report.totals.bytes, 300);
      // 1 token ≈ 4 bytes — 300 * 0.25 = 75
      assert.equal(report.totals.est_tokens, 75);
      assert.equal(report.files.length, 2);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("top_3 ordena por bytes desc, máx 3", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      writeFileSync(join(internalDir, "small.json"), "a".repeat(10));
      writeFileSync(join(internalDir, "huge.json"), "b".repeat(10000));
      writeFileSync(join(internalDir, "medium.json"), "c".repeat(500));
      writeFileSync(join(internalDir, "tiny.json"), "d".repeat(5));

      const report = buildReport({ edition, internalDir, repoRoot: root });
      assert.equal(report.top_3.length, 3);
      assert.ok(report.top_3[0].path.endsWith("huge.json"));
      assert.ok(report.top_3[1].path.endsWith("medium.json"));
      assert.ok(report.top_3[2].path.endsWith("small.json"));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("top_3 com tie em bytes: ordem é estável (alfabética por filename)", () => {
    // Array.sort() é estável desde ES2019. Como listInternalJsonFiles já retorna
    // os arquivos em ordem alfabética, ties em `bytes` preservam essa ordem no
    // sort decrescente — garantia explícita para evitar regressão futura.
    const { root, internalDir, edition } = makeFixture();
    try {
      writeFileSync(join(internalDir, "a-large.json"), "x".repeat(100));
      writeFileSync(join(internalDir, "b-medium.json"), "y".repeat(50));
      writeFileSync(join(internalDir, "c-medium.json"), "z".repeat(50));

      const report1 = buildReport({ edition, internalDir, repoRoot: root });
      const report2 = buildReport({ edition, internalDir, repoRoot: root });
      const report3 = buildReport({ edition, internalDir, repoRoot: root });

      assert.equal(report1.top_3.length, 3);
      assert.ok(report1.top_3[0].path.endsWith("a-large.json"));
      assert.equal(report1.top_3[0].bytes, 100);
      // Tie em 50 bytes entre b-medium.json e c-medium.json — alfabética desempata
      assert.ok(
        report1.top_3[1].path.endsWith("b-medium.json"),
        `expected b-medium.json second, got: ${report1.top_3[1].path}`
      );
      assert.equal(report1.top_3[1].bytes, 50);
      assert.ok(
        report1.top_3[2].path.endsWith("c-medium.json"),
        `expected c-medium.json third, got: ${report1.top_3[2].path}`
      );
      assert.equal(report1.top_3[2].bytes, 50);

      // Determinismo: runs consecutivos produzem mesmo top_3
      assert.deepEqual(report2.top_3, report1.top_3);
      assert.deepEqual(report3.top_3, report1.top_3);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("paths são relativos ao repo root, com separadores POSIX", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      writeFileSync(join(internalDir, "researcher-results.json"), "{}");
      const report = buildReport({ edition, internalDir, repoRoot: root });
      assert.equal(report.files.length, 1);
      const path = report.files[0].path;
      assert.ok(path.includes("/"), `expected POSIX separator, got: ${path}`);
      assert.ok(!path.includes("\\"), `expected no backslash, got: ${path}`);
      assert.ok(path.endsWith("_internal/researcher-results.json"));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("_internal/ vazio retorna report bem-formado com totals zerados", () => {
    const { root, internalDir, edition } = makeFixture();
    try {
      const report = buildReport({ edition, internalDir, repoRoot: root });
      assert.equal(report.totals.file_count, 0);
      assert.equal(report.totals.bytes, 0);
      assert.equal(report.totals.est_tokens, 0);
      assert.deepEqual(report.files, []);
      assert.deepEqual(report.top_3, []);
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  it("_internal/ inexistente também retorna report vazio (não crash)", () => {
    const root = mkdtempSync(join(tmpdir(), "stage1-payload-missing-"));
    try {
      const report = buildReport({
        edition: "260507",
        internalDir: join(root, "missing"),
        repoRoot: root,
      });
      assert.equal(report.totals.file_count, 0);
      assert.deepEqual(report.files, []);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});

describe("payloadLevel ratchet (#891)", () => {
  it("info quando bytes < 300KB (baseline saudável pós-cap)", () => {
    assert.equal(payloadLevel(0), "info");
    assert.equal(payloadLevel(150 * 1024), "info");
    // Baseline 260507 pós-cap (243K) cai em info — pipeline saudável.
    assert.equal(payloadLevel(243 * 1024), "info");
    assert.equal(payloadLevel(PAYLOAD_WARN_BYTES - 1), "info");
  });

  it("warn quando bytes >= 300KB e < 700KB", () => {
    assert.equal(payloadLevel(PAYLOAD_WARN_BYTES), "warn");
    assert.equal(payloadLevel(500 * 1024), "warn");
    assert.equal(payloadLevel(PAYLOAD_ERROR_BYTES - 1), "warn");
  });

  it("error quando bytes >= 700KB", () => {
    assert.equal(payloadLevel(PAYLOAD_ERROR_BYTES), "error");
    assert.equal(payloadLevel(1024 * 1024), "error");
    // 1M bytes — território de context overflow, dispara issue via auto-reporter.
    assert.equal(payloadLevel(1500 * 1024), "error");
  });

  it("cenário do bug original (561K pré-cap em 260507) cai em warn agora", () => {
    // Pre-cap, 561K passava sob o radar (sem alarm). Pós-cap, threshold 300/700
    // pega esse range em warn (não bloqueia, mas sinaliza pra editor investigar).
    assert.equal(payloadLevel(561 * 1024), "warn");
  });

  it("constants exportadas: warn=300KB, error=700KB", () => {
    assert.equal(PAYLOAD_WARN_BYTES, 300 * 1024);
    assert.equal(PAYLOAD_ERROR_BYTES, 700 * 1024);
  });
});
