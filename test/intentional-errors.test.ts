/**
 * intentional-errors.test.ts (#630, #754)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseIntentionalErrorsJsonl,
  loadIntentionalErrors,
  intentionalErrorsForEdition,
  isIntentionalError,
  normalizeDestaque,
} from "../scripts/lib/intentional-errors.ts";

const SAMPLE_LINE_1 = JSON.stringify({
  edition: "260505",
  error_type: "version_inconsistency",
  destaque: 2,
  is_feature: true,
  detail: "V4 no título, V5/V6/V7 no corpo",
});
const SAMPLE_LINE_2 = JSON.stringify({
  edition: "260506",
  error_type: "numeric",
  destaque: "outras_noticias",
  is_feature: true,
  detail: "220 anos no título (correto: 22 anos)",
});

describe("parseIntentionalErrorsJsonl (#630)", () => {
  it("parses 2 entries from JSONL com newlines normais", () => {
    const content = `${SAMPLE_LINE_1}\n${SAMPLE_LINE_2}\n`;
    const errors = parseIntentionalErrorsJsonl(content);
    assert.equal(errors.length, 2);
    assert.equal(errors[0].edition, "260505");
    assert.equal(errors[1].edition, "260506");
  });

  it("ignora linhas vazias", () => {
    const content = `${SAMPLE_LINE_1}\n\n\n${SAMPLE_LINE_2}\n`;
    assert.equal(parseIntentionalErrorsJsonl(content).length, 2);
  });

  it("ignora linhas com JSON inválido (sem crash)", () => {
    const content = `${SAMPLE_LINE_1}\n{ broken json\n${SAMPLE_LINE_2}\n`;
    const errors = parseIntentionalErrorsJsonl(content);
    assert.equal(errors.length, 2);
  });

  it("ignora entries sem edition (defensive)", () => {
    const content = `${SAMPLE_LINE_1}\n${JSON.stringify({ error_type: "x" })}\n`;
    assert.equal(parseIntentionalErrorsJsonl(content).length, 1);
  });

  it("string vazia retorna []", () => {
    assert.deepEqual(parseIntentionalErrorsJsonl(""), []);
  });
});

describe("loadIntentionalErrors (#630)", () => {
  let tmpDir: string;
  let path: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "intentional-errors-"));
    path = join(tmpDir, "errors.jsonl");
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("retorna [] quando arquivo não existe (sem crash)", () => {
    assert.deepEqual(loadIntentionalErrors(path), []);
  });

  it("carrega entries de arquivo válido", () => {
    writeFileSync(path, `${SAMPLE_LINE_1}\n${SAMPLE_LINE_2}\n`, "utf8");
    const errors = loadIntentionalErrors(path);
    assert.equal(errors.length, 2);
  });
});

describe("intentionalErrorsForEdition (#630)", () => {
  it("filtra por edition exata", () => {
    const errors = parseIntentionalErrorsJsonl(`${SAMPLE_LINE_1}\n${SAMPLE_LINE_2}\n`);
    assert.equal(intentionalErrorsForEdition(errors, "260505").length, 1);
    assert.equal(intentionalErrorsForEdition(errors, "260506").length, 1);
    assert.equal(intentionalErrorsForEdition(errors, "260507").length, 0);
  });
});

describe("normalizeDestaque (#630)", () => {
  it("normaliza varias formas pra string numérica", () => {
    assert.equal(normalizeDestaque(2), "2");
    assert.equal(normalizeDestaque("2"), "2");
    assert.equal(normalizeDestaque("DESTAQUE 2"), "2");
    assert.equal(normalizeDestaque("destaque 2"), "2");
  });

  it("string sem dígito retorna lowercase trim", () => {
    assert.equal(normalizeDestaque("outras_noticias"), "outras_noticias");
    assert.equal(normalizeDestaque("OUTRAS_NOTICIAS"), "outras_noticias");
  });
});

describe("isIntentionalError (#630)", () => {
  const errors = parseIntentionalErrorsJsonl(`${SAMPLE_LINE_1}\n${SAMPLE_LINE_2}\n`);

  it("match exato edition + error_type + destaque", () => {
    assert.equal(
      isIntentionalError(
        { error_type: "version_inconsistency", destaque: "DESTAQUE 2" },
        "260505",
        errors,
      ),
      true,
    );
  });

  it("match com destaque numérico", () => {
    assert.equal(
      isIntentionalError(
        { error_type: "version_inconsistency", destaque: 2 },
        "260505",
        errors,
      ),
      true,
    );
  });

  it("não match edition diferente", () => {
    assert.equal(
      isIntentionalError(
        { error_type: "version_inconsistency", destaque: 2 },
        "260506",
        errors,
      ),
      false,
    );
  });

  it("não match error_type diferente", () => {
    assert.equal(
      isIntentionalError(
        { error_type: "numeric", destaque: 2 },
        "260505",
        errors,
      ),
      false,
    );
  });

  it("não match destaque diferente", () => {
    assert.equal(
      isIntentionalError(
        { error_type: "version_inconsistency", destaque: 1 },
        "260505",
        errors,
      ),
      false,
    );
  });

  it("detection sem destaque match qualquer destaque do error_type", () => {
    assert.equal(
      isIntentionalError(
        { error_type: "version_inconsistency" },
        "260505",
        errors,
      ),
      true,
    );
  });

  it("destaque outras_noticias normaliza", () => {
    assert.equal(
      isIntentionalError(
        { error_type: "numeric", destaque: "outras_noticias" },
        "260506",
        errors,
      ),
      true,
    );
  });
});
