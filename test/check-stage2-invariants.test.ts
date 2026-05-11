/**
 * test/check-stage2-invariants.test.ts (#1072 / #1073)
 *
 * Cobre os 3 invariants pós-Stage 2: humanizador, Clarice, e
 * render-erro-intencional. Cada um detectável via comparação byte-idêntica
 * de arquivos intermediários ou presença de placeholder literal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkHumanizadorRan,
  checkClariceRan,
  checkErroIntencionalRendered,
  checkStage2Invariants,
} from "../scripts/check-stage2-invariants.ts";

function mkEdition() {
  const dir = mkdtempSync(join(tmpdir(), "stage2-invariants-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("checkHumanizadorRan (#1072)", () => {
  it("OK quando 02-humanized.md existe e difere de 02-normalized.md", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "texto agent");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "texto humano");
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-humanized.md não existe", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "x");
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, false);
      assert.match(r.label!, /humanized_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-humanized.md byte-idêntico a 02-normalized.md (no-op)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const txt = "texto idêntico em ambos";
      writeFileSync(join(dir, "_internal", "02-normalized.md"), txt);
      writeFileSync(join(dir, "_internal", "02-humanized.md"), txt);
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, false);
      assert.match(r.label!, /humanized_unchanged/);
    } finally {
      cleanup();
    }
  });

  it("OK quando 02-normalized.md não existe (passo anterior falhou — não é problema do humanizador)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "x");
      const r = checkHumanizadorRan(join(dir, "_internal"));
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });
});

describe("checkClariceRan (#1072)", () => {
  it("OK quando 02-reviewed.md difere de _internal/02-pre-clarice.md", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "pré");
      writeFileSync(join(dir, "02-reviewed.md"), "pós-clarice");
      const r = checkClariceRan(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-reviewed.md não existe", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "x");
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /reviewed_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando snapshot 02-pre-clarice.md ausente (assertion #889)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "x");
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /pre_clarice_missing/);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando 02-reviewed.md byte-idêntico a 02-pre-clarice.md (Clarice no-op)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const txt = "texto idêntico";
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), txt);
      writeFileSync(join(dir, "02-reviewed.md"), txt);
      const r = checkClariceRan(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /clarice_unchanged/);
    } finally {
      cleanup();
    }
  });
});

describe("checkErroIntencionalRendered (#1073)", () => {
  it("OK quando reviewed não tem placeholder literal", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "02-reviewed.md"), "**ERRO INTENCIONAL**\n\nNa última edição, X.\n");
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando placeholder literal do writer ainda presente", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "Body...\n\n{placeholder, script render-erro-intencional.ts substitui pós-Clarice}\n",
      );
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, false);
      assert.match(r.label!, /erro_intencional_placeholder/);
    } finally {
      cleanup();
    }
  });

  it("FAIL com variante de placeholder (case-insensitive, com ou sem vírgula)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(
        join(dir, "02-reviewed.md"),
        "{Placeholder script render-erro-intencional substitui}",
      );
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, false);
    } finally {
      cleanup();
    }
  });

  it("OK quando reviewed.md não existe (outro check captura)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      const r = checkErroIntencionalRendered(dir);
      assert.equal(r.ok, true);
    } finally {
      cleanup();
    }
  });
});

describe("checkStage2Invariants — integração", () => {
  it("OK quando os 3 invariants passam", () => {
    const { dir, cleanup } = mkEdition();
    try {
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-humanized.md"), "a humanizado");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "b");
      writeFileSync(join(dir, "02-reviewed.md"), "b clarificado, sem placeholder");
      const r = checkStage2Invariants(dir);
      assert.equal(r.ok, true);
      assert.equal(r.checks.humanizador.ok, true);
      assert.equal(r.checks.clarice.ok, true);
      assert.equal(r.checks.erro_intencional.ok, true);
    } finally {
      cleanup();
    }
  });

  it("FAIL quando humanizador pulou (260511 real case)", () => {
    const { dir, cleanup } = mkEdition();
    try {
      // Pula humanizador (sem 02-humanized.md)
      writeFileSync(join(dir, "_internal", "02-normalized.md"), "a");
      writeFileSync(join(dir, "_internal", "02-pre-clarice.md"), "a");
      writeFileSync(join(dir, "02-reviewed.md"), "a clarificado");
      const r = checkStage2Invariants(dir);
      assert.equal(r.ok, false);
      assert.equal(r.checks.humanizador.ok, false);
    } finally {
      cleanup();
    }
  });
});
