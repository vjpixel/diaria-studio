/**
 * test/eia-meta-schema.test.ts (#1176)
 *
 * Tests pro schema EiaMeta/WikimediaInfo — foca no fix do #1176 onde
 * eia-compose.ts escrevia `null` literal mas o schema só aceitava undefined.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseEiaMeta,
  WikimediaInfoSchema,
  EiaMetaSchema,
} from "../scripts/lib/schemas/eia-meta.ts";

describe("WikimediaInfoSchema — campos nullable (#1176)", () => {
  const BASE = {
    title: "File:Foo.jpg",
    image_url: "https://example.com/foo.jpg",
  };

  it("aceita subject_wikipedia_url null (caso real edição 260513)", () => {
    const input = { ...BASE, subject_wikipedia_url: null };
    const r = WikimediaInfoSchema.parse(input);
    assert.equal(r.subject_wikipedia_url, null);
  });

  it("aceita subject_wikipedia_url undefined (omitido)", () => {
    const input = { ...BASE };
    const r = WikimediaInfoSchema.parse(input);
    assert.equal(r.subject_wikipedia_url, undefined);
  });

  it("aceita subject_wikipedia_url string", () => {
    const input = {
      ...BASE,
      subject_wikipedia_url: "https://en.wikipedia.org/wiki/Foo",
    };
    const r = WikimediaInfoSchema.parse(input);
    assert.equal(r.subject_wikipedia_url, "https://en.wikipedia.org/wiki/Foo");
  });

  it("aceita artist_url e license_url null (eia-compose pattern)", () => {
    const input = {
      ...BASE,
      artist_url: null,
      license_url: null,
    };
    const r = WikimediaInfoSchema.parse(input);
    assert.equal(r.artist_url, null);
    assert.equal(r.license_url, null);
  });

  it("rejeita ainda os campos required (title, image_url)", () => {
    assert.throws(() => WikimediaInfoSchema.parse({ image_url: "x" }));
    assert.throws(() => WikimediaInfoSchema.parse({ title: "x" }));
  });

  it("image_date_used continua não-nullable (eia-compose sempre escreve string)", () => {
    // Regression: o fix narrou .nullish() pra .optional() em image_date_used
    // pra não widening o type. JSON do eia-compose nunca tem null aqui.
    assert.throws(
      () => WikimediaInfoSchema.parse({ ...BASE, image_date_used: null }),
      /image_date_used/,
    );
    // Mas aceita string ou ausente:
    assert.doesNotThrow(() =>
      WikimediaInfoSchema.parse({ ...BASE, image_date_used: "2026-05-10" }),
    );
    assert.doesNotThrow(() => WikimediaInfoSchema.parse({ ...BASE }));
  });

  it("snapshot integral do JSON real 260513 parseia sem erro", () => {
    // Copy literal do data/editions/260513/_internal/01-eia-meta.json (caso #1176).
    const raw = {
      edition: "260513",
      composed_at: "2026-05-12T19:56:39.814Z",
      ai_image_file: "01-eia-B.jpg",
      real_image_file: "01-eia-A.jpg",
      ai_side: "B",
      wikimedia: {
        title: "File:Bloemknoppen van een Crocosmia. 25-06-2024. (d.j.b) 02.jpg",
        image_url:
          "https://upload.wikimedia.org/wikipedia/commons/5/57/Bloemknoppen.jpg",
        credit: "Own work",
        artist_url: "https://commons.wikimedia.org/wiki/User:Famberhorst",
        subject_wikipedia_url: null,
        license_url: "https://creativecommons.org/licenses/by-sa/4.0",
        image_date_used: "2026-05-10",
      },
    };
    const parsed = parseEiaMeta(raw);
    assert.equal(parsed.edition, "260513");
    assert.equal(parsed.ai_side, "B");
    assert.equal(parsed.wikimedia.subject_wikipedia_url, null);
    assert.equal(
      parsed.wikimedia.artist_url,
      "https://commons.wikimedia.org/wiki/User:Famberhorst",
    );
  });
});

describe("EiaMetaSchema — campos required preservados", () => {
  it("rejeita ai_side fora do enum", () => {
    const input = {
      edition: "260513",
      composed_at: "2026-05-12T19:56:39.814Z",
      ai_image_file: "x.jpg",
      real_image_file: "y.jpg",
      ai_side: "C", // inválido
      wikimedia: { title: "t", image_url: "u" },
    };
    assert.throws(() => EiaMetaSchema.parse(input));
  });

  it("rejeita falta de edition", () => {
    const input = {
      composed_at: "x",
      ai_image_file: "x.jpg",
      real_image_file: "y.jpg",
      ai_side: "A",
      wikimedia: { title: "t", image_url: "u" },
    };
    assert.throws(() => EiaMetaSchema.parse(input));
  });
});

describe("EiaMetaSchema — selection/pct_correct (#2869)", () => {
  const BASE = {
    edition: "260630",
    composed_at: "2026-07-01T00:00:00.000Z",
    ai_image_file: "01-eia-A.jpg",
    real_image_file: "01-eia-B.jpg",
    ai_side: "A" as const,
    wikimedia: { title: "t", image_url: "u" },
  };

  it("aceita ausência total de selection/pct_correct (composição diária, back-compat)", () => {
    const r = EiaMetaSchema.parse(BASE);
    assert.equal(r.selection, undefined);
    assert.equal(r.pct_correct, undefined);
  });

  it("aceita selection: criterion + pct_correct numérico (mensal, critério aplicado)", () => {
    const r = EiaMetaSchema.parse({ ...BASE, selection: "criterion", pct_correct: 50 });
    assert.equal(r.selection, "criterion");
    assert.equal(r.pct_correct, 50);
  });

  it("aceita selection: fallback_last + pct_correct null (#2869 — sem critério aplicável)", () => {
    const r = EiaMetaSchema.parse({ ...BASE, selection: "fallback_last", pct_correct: null });
    assert.equal(r.selection, "fallback_last");
    assert.equal(r.pct_correct, null);
  });

  it("aceita selection: manual (editor escolheu no gate)", () => {
    const r = EiaMetaSchema.parse({ ...BASE, selection: "manual", pct_correct: null });
    assert.equal(r.selection, "manual");
  });

  it("rejeita selection fora do enum", () => {
    assert.throws(() => EiaMetaSchema.parse({ ...BASE, selection: "guess" }));
  });
});

describe("WikimediaInfoSchema — description (#3984)", () => {
  const BASE = {
    title: "File:Foo.jpg",
    image_url: "https://example.com/foo.jpg",
  };

  it("aceita ausência de description (edições compostas ANTES do #3984, back-compat)", () => {
    const r = WikimediaInfoSchema.parse(BASE);
    assert.equal(r.description, undefined);
  });

  it("aceita description string (frase traduzida pt-BR ou fallback EN)", () => {
    const r = WikimediaInfoSchema.parse({ ...BASE, description: "Uma ponte no Japão." });
    assert.equal(r.description, "Uma ponte no Japão.");
  });

  it("rejeita description não-string (schema type-safe)", () => {
    assert.throws(() => WikimediaInfoSchema.parse({ ...BASE, description: 123 }));
  });
});
