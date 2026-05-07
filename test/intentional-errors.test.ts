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
  destaqueFromLocation,
  frontmatterToEntry,
  syncFrontmatterToEntries,
  type IntentionalError,
  type IntentionalErrorFrontmatter,
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

describe("destaqueFromLocation — parse de location string (#754)", () => {
  it("DESTAQUE 1/2/3 → numero", () => {
    assert.equal(destaqueFromLocation("DESTAQUE 1, parágrafo 2"), 1);
    assert.equal(destaqueFromLocation("destaque 2"), 2);
    assert.equal(destaqueFromLocation("D3 — primeira frase"), ""); // não bate "destaque" literal
    assert.equal(destaqueFromLocation("DESTAQUE 3"), 3);
  });

  it("OUTRAS NOTÍCIAS / LANÇAMENTOS / PESQUISAS", () => {
    assert.equal(destaqueFromLocation("OUTRAS NOTÍCIAS, item 3"), "outras_noticias");
    assert.equal(destaqueFromLocation("LANÇAMENTOS"), "lancamentos");
    assert.equal(destaqueFromLocation("Pesquisas — item 2"), "pesquisas");
  });

  it("É IA? → header", () => {
    assert.equal(destaqueFromLocation("É IA? caption"), "header");
    assert.equal(destaqueFromLocation("eia"), "header");
    assert.equal(destaqueFromLocation("cabeçalho"), "header");
  });

  it("string vazia / não-match → string vazia", () => {
    assert.equal(destaqueFromLocation(""), "");
    assert.equal(destaqueFromLocation("conteúdo aleatório"), "");
    assert.equal(destaqueFromLocation(null as unknown as string), "");
  });

  it("destaque inválido (>3) não vira número", () => {
    assert.equal(destaqueFromLocation("DESTAQUE 4"), "");
    assert.equal(destaqueFromLocation("DESTAQUE 0"), "");
  });
});

describe("frontmatterToEntry — converte frontmatter pra entry (#754)", () => {
  const fm: IntentionalErrorFrontmatter = {
    description: "OpenAI no lugar de Anthropic",
    location: "DESTAQUE 2, parágrafo 2",
    category: "attribution",
    correct_value: "Anthropic",
  };

  it("mapa campos básicos corretamente", () => {
    const entry = frontmatterToEntry(fm, "260506");
    assert.equal(entry.edition, "260506");
    assert.equal(entry.error_type, "attribution");
    assert.equal(entry.destaque, 2);
    assert.equal(entry.is_feature, true);
    assert.equal(entry.detail, "OpenAI no lugar de Anthropic");
  });

  it("source/detected_by/resolution preenchidos pra rastreabilidade", () => {
    const entry = frontmatterToEntry(fm, "260506");
    assert.equal(entry.source, "frontmatter_02_reviewed");
    assert.match(entry.detected_by!, /lint-newsletter-md/);
    assert.equal(entry.resolution, "published_intentionally");
  });

  it("preserva correct_value como campo extra", () => {
    const entry = frontmatterToEntry(fm, "260506") as IntentionalError & {
      correct_value?: string;
    };
    assert.equal(entry.correct_value, "Anthropic");
  });

  it("category ausente → 'unknown'", () => {
    const entry = frontmatterToEntry({ description: "x" }, "260506");
    assert.equal(entry.error_type, "unknown");
  });

  it("location ausente → destaque undefined", () => {
    const entry = frontmatterToEntry({ category: "factual" }, "260506");
    assert.equal(entry.destaque, undefined);
  });
});

describe("syncFrontmatterToEntries — idempotência (#754)", () => {
  const fm: IntentionalErrorFrontmatter = {
    description: "x",
    category: "factual",
    location: "DESTAQUE 1",
    correct_value: "y",
  };

  it("primeira sync: added=true", () => {
    const r = syncFrontmatterToEntries(fm, "260510", []);
    assert.equal(r.added, true);
    assert.equal(r.entries.length, 1);
    assert.equal(r.entries[0].source, "frontmatter_02_reviewed");
  });

  it("segunda sync da mesma edição: added=false (idempotente)", () => {
    const first = syncFrontmatterToEntries(fm, "260510", []);
    const second = syncFrontmatterToEntries(fm, "260510", first.entries);
    assert.equal(second.added, false);
    assert.equal(second.entries.length, first.entries.length);
  });

  it("edição diferente: added=true mesmo com entries existentes", () => {
    const first = syncFrontmatterToEntries(fm, "260510", []);
    const second = syncFrontmatterToEntries(fm, "260511", first.entries);
    assert.equal(second.added, true);
    assert.equal(second.entries.length, 2);
  });

  it("entry pré-existente da mesma edição com source diferente: ainda adiciona", () => {
    const existing: IntentionalError[] = [
      {
        edition: "260510",
        error_type: "factual",
        is_feature: true,
        source: "manual_post_paste",
      },
    ];
    const r = syncFrontmatterToEntries(fm, "260510", existing);
    // A frontmatter sync NÃO conflita com manual entries — só checa source frontmatter
    assert.equal(r.added, true);
  });
});
