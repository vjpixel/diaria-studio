import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEditionDate,
  ageDays,
  classifyEdition,
  archiveDestination,
  archiveEditions,
  readPublishedStatus,
} from "../scripts/archive-editions.ts";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("parseEditionDate (#98)", () => {
  it("parseia AAMMDD válido pra UTC midnight", () => {
    const d = parseEditionDate("260101");
    assert.equal(d?.getUTCFullYear(), 2026);
    assert.equal(d?.getUTCMonth(), 0);
    assert.equal(d?.getUTCDate(), 1);
  });

  it("rejeita formato inválido (5 dígitos, letras, vazio)", () => {
    assert.equal(parseEditionDate("26010"), null);
    assert.equal(parseEditionDate("abcdef"), null);
    assert.equal(parseEditionDate(""), null);
  });

  it("rejeita rollovers calendar (Feb 30, mês 13)", () => {
    assert.equal(parseEditionDate("260230"), null);
    assert.equal(parseEditionDate("261301"), null);
  });

  it("aceita Feb 29 em ano bissexto (2024 = bissexto)", () => {
    assert.notEqual(parseEditionDate("240229"), null);
  });

  it("rejeita Feb 29 em ano não-bissexto", () => {
    assert.equal(parseEditionDate("260229"), null);
  });
});

describe("ageDays", () => {
  it("calcula dias entre duas datas", () => {
    const a = new Date("2026-01-01T00:00:00Z");
    const b = new Date("2026-01-11T00:00:00Z");
    assert.equal(ageDays(a, b), 10);
  });

  it("negativo quando edição é no futuro", () => {
    const a = new Date("2026-12-01T00:00:00Z");
    const now = new Date("2026-01-01T00:00:00Z");
    assert.ok(ageDays(a, now) < 0);
  });
});

describe("classifyEdition — decision logic (#98)", () => {
  const NOW = new Date("2026-04-30T00:00:00Z");

  it("ok_published quando edição > threshold E status published", () => {
    const c = classifyEdition("260101", "published", NOW, 90, false);
    assert.equal(c.reason, "ok_published");
    assert.ok(c.age_days > 90);
  });

  it("scheduled também conta como published", () => {
    const c = classifyEdition("260101", "scheduled", NOW, 90, false);
    assert.equal(c.reason, "ok_published");
  });

  it("skip_too_recent quando age <= threshold", () => {
    // 260415 = 15 days before NOW; threshold 90
    const c = classifyEdition("260415", "published", NOW, 90, false);
    assert.equal(c.reason, "skip_too_recent");
  });

  it("skip_no_published quando 05-published.json missing (default)", () => {
    const c = classifyEdition("260101", "missing", NOW, 90, false);
    assert.equal(c.reason, "skip_no_published");
  });

  it("skip_unpublished quando status draft / failed (default)", () => {
    assert.equal(
      classifyEdition("260101", "draft", NOW, 90, false).reason,
      "skip_unpublished",
    );
    assert.equal(
      classifyEdition("260101", "failed", NOW, 90, false).reason,
      "skip_unpublished",
    );
  });

  it("includeTest=true permite arquivar missing/draft/failed", () => {
    assert.equal(
      classifyEdition("260101", "missing", NOW, 90, true).reason,
      "ok_published",
    );
    assert.equal(
      classifyEdition("260101", "draft", NOW, 90, true).reason,
      "ok_published",
    );
  });

  it("threshold respected (180d)", () => {
    // 260101 → 119 days old at NOW=Apr 30
    const c = classifyEdition("260101", "published", NOW, 180, false);
    assert.equal(c.reason, "skip_too_recent");
  });

  it("formato de edição inválido vira skip_no_published", () => {
    const c = classifyEdition("invalid", "published", NOW, 90, false);
    assert.equal(c.reason, "skip_no_published");
  });
});

describe("archiveDestination", () => {
  it("agrupa por YYMM dentro do archive dir", () => {
    assert.equal(
      archiveDestination("/x/data/archive", "260423"),
      "/x/data/archive/2604/260423",
    );
  });

  it("Janeiro vai pra YYMM=2601", () => {
    assert.equal(
      archiveDestination("/x", "260105"),
      "/x/2601/260105",
    );
  });
});

// ---------------------------------------------------------------------------
// Integration — fs fixtures
// ---------------------------------------------------------------------------

interface Fixture {
  root: string;
  editionsDir: string;
  archiveDir: string;
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "diaria-archive-"));
  const editionsDir = join(root, "data/editions");
  const archiveDir = join(root, "data/archive");
  mkdirSync(editionsDir, { recursive: true });
  return { root, editionsDir, archiveDir };
}

function makeEdition(
  editionsDir: string,
  edition: string,
  status: string | null,
): string {
  const dir = join(editionsDir, edition);
  mkdirSync(dir, { recursive: true });
  if (status !== null) {
    writeFileSync(
      join(dir, "05-published.json"),
      JSON.stringify({ status, edition }, null, 2),
    );
  }
  // simulate a typical edition output to make the directory non-empty
  writeFileSync(join(dir, "02-reviewed.md"), `# Edição ${edition}\n`);
  return dir;
}

describe("archiveEditions — integration (#98)", () => {
  const NOW = new Date("2026-04-30T00:00:00Z");

  it("dry-run: lista candidatos sem mover nada", () => {
    const { editionsDir, archiveDir } = setup();
    try {
      makeEdition(editionsDir, "260101", "published"); // > 90d
      makeEdition(editionsDir, "260415", "published"); // 15d, recent
      makeEdition(editionsDir, "251001", "published"); // very old

      const result = archiveEditions({
        editionsDir,
        archiveDir,
        thresholdDays: 90,
        execute: false,
        includeTest: false,
        now: NOW,
      });

      assert.equal(result.dry_run, true);
      assert.equal(result.archived.length, 2); // 260101 + 251001
      assert.equal(result.skipped.length, 1); // 260415

      // No actual moves
      assert.ok(existsSync(join(editionsDir, "260101")));
      assert.ok(existsSync(join(editionsDir, "251001")));
      assert.ok(!existsSync(archiveDir));
    } finally {
      rmSync(setup().root, { recursive: true, force: true });
    }
  });

  it("execute: move arquivos e cria arvore archive/{YYMM}/{AAMMDD}", () => {
    const { editionsDir, archiveDir } = setup();
    try {
      makeEdition(editionsDir, "260101", "published");
      makeEdition(editionsDir, "260415", "published"); // recent — fica

      const result = archiveEditions({
        editionsDir,
        archiveDir,
        thresholdDays: 90,
        execute: true,
        includeTest: false,
        now: NOW,
      });

      assert.equal(result.archived.length, 1);
      assert.equal(result.archived[0].edition, "260101");
      // 260101 não está mais em editions
      assert.ok(!existsSync(join(editionsDir, "260101")));
      // mas está em archive/2601/260101
      assert.ok(existsSync(join(archiveDir, "2601", "260101", "02-reviewed.md")));
      // 260415 fica intacta
      assert.ok(existsSync(join(editionsDir, "260415")));
    } finally {
      rmSync(setup().root, { recursive: true, force: true });
    }
  });

  it("execute: pula edições sem 05-published.json (default)", () => {
    const { editionsDir, archiveDir } = setup();
    try {
      makeEdition(editionsDir, "260101", null); // sem published.json

      const result = archiveEditions({
        editionsDir,
        archiveDir,
        thresholdDays: 90,
        execute: true,
        includeTest: false,
        now: NOW,
      });

      assert.equal(result.archived.length, 0);
      assert.equal(result.skipped[0].reason, "skip_no_published");
      // ainda em editions
      assert.ok(existsSync(join(editionsDir, "260101")));
    } finally {
      rmSync(setup().root, { recursive: true, force: true });
    }
  });

  it("includeTest=true: arquiva mesmo sem 05-published.json", () => {
    const { editionsDir, archiveDir } = setup();
    try {
      makeEdition(editionsDir, "260101", null);

      const result = archiveEditions({
        editionsDir,
        archiveDir,
        thresholdDays: 90,
        execute: true,
        includeTest: true,
        now: NOW,
      });

      assert.equal(result.archived.length, 1);
      assert.ok(existsSync(join(archiveDir, "2601", "260101")));
    } finally {
      rmSync(setup().root, { recursive: true, force: true });
    }
  });

  it("ignora diretórios não-AAMMDD (archive, drafts, etc)", () => {
    const { editionsDir, archiveDir } = setup();
    try {
      makeEdition(editionsDir, "260101", "published");
      mkdirSync(join(editionsDir, "drafts"), { recursive: true });
      mkdirSync(join(editionsDir, "tmp_2604"), { recursive: true });

      const result = archiveEditions({
        editionsDir,
        archiveDir,
        thresholdDays: 90,
        execute: false,
        includeTest: false,
        now: NOW,
      });

      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].edition, "260101");
    } finally {
      rmSync(setup().root, { recursive: true, force: true });
    }
  });

  it("editionsDir inexistente: retorna shape vazio sem crash", () => {
    const result = archiveEditions({
      editionsDir: "/path/that/does/not/exist/abc",
      archiveDir: "/tmp/abc",
      thresholdDays: 90,
      execute: false,
      includeTest: false,
      now: NOW,
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.archived.length, 0);
  });

  it("execute: mantém archive existente intacto, não sobrescreve", () => {
    const { editionsDir, archiveDir } = setup();
    try {
      makeEdition(editionsDir, "260101", "published");
      // Pre-criar destino conflitante
      mkdirSync(join(archiveDir, "2601", "260101"), { recursive: true });
      writeFileSync(join(archiveDir, "2601", "260101", "old.md"), "preserved");

      const result = archiveEditions({
        editionsDir,
        archiveDir,
        thresholdDays: 90,
        execute: true,
        includeTest: false,
        now: NOW,
      });

      // Não move; original ainda em editions
      assert.equal(result.archived.length, 0);
      assert.ok(existsSync(join(editionsDir, "260101")));
      // archive antigo preservado
      assert.equal(
        readdirSync(join(archiveDir, "2601", "260101")).includes("old.md"),
        true,
      );
    } finally {
      rmSync(setup().root, { recursive: true, force: true });
    }
  });
});

describe("readPublishedStatus", () => {
  it("retorna status quando JSON válido", () => {
    const status = readPublishedStatus(
      "/fake/edition",
      () => '{"status":"published"}',
      () => true,
    );
    assert.equal(status, "published");
  });

  it("retorna 'missing' quando arquivo não existe", () => {
    const status = readPublishedStatus(
      "/fake/edition",
      () => "",
      () => false,
    );
    assert.equal(status, "missing");
  });

  it("retorna 'malformed' quando JSON inválido", () => {
    const status = readPublishedStatus(
      "/fake/edition",
      () => "{not json",
      () => true,
    );
    assert.equal(status, "malformed");
  });

  it("retorna 'unknown' quando JSON não tem campo status", () => {
    const status = readPublishedStatus(
      "/fake/edition",
      () => '{"edition":"260424"}',
      () => true,
    );
    assert.equal(status, "unknown");
  });
});
