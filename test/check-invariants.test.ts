/**
 * test/check-invariants.test.ts (#965 / #966)
 *
 * Cobre o pre-flight de invariantes editoriais. Modo static (sem
 * edition_dir, valida estrutura do repo) + per-edition.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BEEHIIV_CTA_ALLOWLIST,
  checkNoBeehiivHostInPublicCta,
  checkNoForensicInDriveSync,
  checkNoHtmlInMonthlyDriveSync,
  STATIC_RULES,
} from "../scripts/check-invariants.ts";

describe("check-invariants — STATIC_RULES (#966)", () => {
  it("expõe pelo menos 1 rule estática", () => {
    assert.ok(STATIC_RULES.length >= 1);
    for (const rule of STATIC_RULES) {
      assert.ok(typeof rule.id === "string");
      assert.ok(typeof rule.description === "string");
      assert.ok(typeof rule.run === "function");
    }
  });
});

describe("check-invariants — checkNoForensicInDriveSync (#959)", () => {
  it("repo atual passa o check (zero violations)", () => {
    const violations = checkNoForensicInDriveSync();
    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  });
});

describe("check-invariants — checkNoHtmlInMonthlyDriveSync (#1022)", () => {
  it("repo atual passa o check (zero violations)", () => {
    const violations = checkNoHtmlInMonthlyDriveSync();
    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  });

  it("ATIVA quando .md tem drive-sync push com .html em --files", () => {
    // Cria fixture md com violação injetada
    const tmp = mkdtempSync(join(tmpdir(), "check-html-"));
    writeFileSync(
      join(tmp, "SKILL.md"),
      "Push: `npx tsx scripts/drive-sync.ts --mode push --files preview-list9.html`\n",
      "utf8",
    );
    try {
      const violations = checkNoHtmlInMonthlyDriveSync(tmp);
      assert.equal(violations.length, 1);
      assert.equal(violations[0].rule, "no-html-in-monthly-drive-sync");
      assert.equal(violations[0].source_issue, "#1022");
      assert.equal(violations[0].severity, "error");
      assert.match(violations[0].message, /HTML/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("não ativa em linha sem --files (comentário menciona .html)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "check-html-comment-"));
    writeFileSync(
      join(tmp, "SKILL.md"),
      "Veja o output em `preview.html` local — não enviado pro Drive.\n",
      "utf8",
    );
    try {
      const violations = checkNoHtmlInMonthlyDriveSync(tmp);
      assert.equal(violations.length, 0, "Comentário sem --files não deve disparar");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("não ativa em drive-sync de outro file (md/json/jpg em --files)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "check-html-md-"));
    writeFileSync(
      join(tmp, "SKILL.md"),
      "Push: `npx tsx scripts/drive-sync.ts --mode push --files draft.md,01-eai-A.jpg`\n",
      "utf8",
    );
    try {
      const violations = checkNoHtmlInMonthlyDriveSync(tmp);
      assert.equal(violations.length, 0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("check-invariants CLI (#966)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "check-invariants.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("--static exit 0 no repo atual", () => {
    const r = runCli(["--static"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.passed, true);
    assert.ok(out.rules_run.includes("no-forensic-in-drive-sync"));
  });

  it("--static --rule <id> roda só a regra escolhida", () => {
    const r = runCli(["--static", "--rule", "no-forensic-in-drive-sync"]);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.rules_run, ["no-forensic-in-drive-sync"]);
  });

  it("sem args = exit 2 (erro de input)", () => {
    const r = runCli([]);
    assert.equal(r.status, 2);
  });
});

describe("check-invariants — checkNoBeehiivHostInPublicCta (#4059)", () => {
  it("repo atual passa o check (a varredura do #4059 limpou tudo que não é infra)", () => {
    const violations = checkNoBeehiivHostInPublicCta();
    assert.equal(violations.length, 0, JSON.stringify(violations, null, 2));
  });

  it("REGRESSÃO: um CTA público novo apontando pra diaria.beehiiv.com falha o check", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-cta-"));
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(
        join(dir, "scripts", "novo-cta.ts"),
        'export const CTA = "https://diaria.beehiiv.com/?utm_source=x";\n',
        "utf8",
      );
      const violations = checkNoBeehiivHostInPublicCta(dir);
      assert.equal(violations.length, 1, JSON.stringify(violations, null, 2));
      assert.equal(violations[0].rule, "no-beehiiv-host-in-public-cta");
      assert.equal(violations[0].severity, "error");
      assert.equal(violations[0].source_issue, "#4059");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("o host de marca (diar.ia.br) NÃO é flagado", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-cta-ok-"));
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(
        join(dir, "scripts", "novo-cta.ts"),
        'export const CTA = "https://diar.ia.br/?utm_source=x";\n',
        "utf8",
      );
      assert.deepEqual(checkNoBeehiivHostInPublicCta(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("menção em COMENTÁRIO (contexto histórico) não é flagada", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-cta-cmt-"));
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(
        join(dir, "scripts", "doc.ts"),
        "// antes ia pra https://diaria.beehiiv.com (#2613)\nexport const X = 1;\n",
        "utf8",
      );
      assert.deepEqual(checkNoBeehiivHostInPublicCta(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo na allowlist é pulado (infra/medição/histórico)", () => {
    const dir = mkdtempSync(join(tmpdir(), "inv-cta-allow-"));
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      writeFileSync(
        join(dir, "scripts", "seo-pull.ts"),
        'const site = "https://diaria.beehiiv.com/";\n',
        "utf8",
      );
      assert.deepEqual(checkNoBeehiivHostInPublicCta(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a allowlist é explícita e não vazia (silêncio != guard funcionando)", () => {
    assert.ok(BEEHIIV_CTA_ALLOWLIST.length >= 5);
    assert.ok(BEEHIIV_CTA_ALLOWLIST.includes("workers/poll/wrangler.toml"));
  });
});
