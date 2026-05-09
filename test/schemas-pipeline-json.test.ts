import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEiaMeta, EiaMetaSchema } from "../scripts/lib/schemas/eia-meta.ts";
import { parsePublicImages, PublicImagesSchema } from "../scripts/lib/schemas/public-images.ts";
import { parseClariceSuggestions, ClariceSuggestionsSchema } from "../scripts/lib/schemas/clarice-suggestions.ts";

/**
 * Tests de schemas Zod pra JSONs internos do pipeline (#1012).
 *
 * Estratégia:
 *   - Validação positiva via fixtures em test/fixtures/pipeline-jsons/
 *     (cópias snapshot de produção real de edições passadas)
 *   - Validação negativa pra catch schema drift
 *   - Fixtures isoladas garantem que testes não quebram quando
 *     edições reais são deletadas/movidas
 */

const FIXTURES = resolve(import.meta.dirname, "fixtures/pipeline-jsons");

// Nota: 01-approved.json já tem schema em scripts/lib/schemas/edition-state.ts
// (ApprovedJsonSchema/parseApprovedJson) com tests em test/schemas/edition-state.test.ts.
// Não re-testar aqui pra evitar duplicação.

// ─── 01-eia-meta.json ──────────────────────────────────────────────────────

describe("EiaMetaSchema (01-eia-meta.json)", () => {
  it("valida fixture real", () => {
    const path = resolve(FIXTURES, "01-eia-meta.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = parseEiaMeta(raw);
    assert.ok(["A", "B"].includes(parsed.ai_side));
    assert.ok(parsed.wikimedia.title);
  });

  it("rejeita ai_side fora de {A, B}", () => {
    assert.throws(() =>
      parseEiaMeta({
        edition: "260504",
        composed_at: "2026-05-04T01:17:00Z",
        ai_image_file: "01-eia-B.jpg",
        real_image_file: "01-eia-A.jpg",
        ai_side: "C",
        wikimedia: { title: "x", image_url: "https://x.com/x.jpg" },
      }),
    );
  });

  it("rejeita sem campo wikimedia", () => {
    assert.throws(() =>
      parseEiaMeta({
        edition: "260504",
        composed_at: "...",
        ai_image_file: "x",
        real_image_file: "y",
        ai_side: "A",
      }),
    );
  });
});

// ─── 06-public-images.json ─────────────────────────────────────────────────

describe("PublicImagesSchema (06-public-images.json)", () => {
  it("valida fixture real", () => {
    const path = resolve(FIXTURES, "06-public-images.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = parsePublicImages(raw);
    assert.ok(parsed.images, "Esperava map images");
    // Campos típicos: cover, d2, d3, eai_real, eai_ia
    const slots = Object.keys(parsed.images);
    assert.ok(slots.length > 0, "Esperava ≥1 slot de imagem");
  });

  it("aceita slots arbitrários (record genérico)", () => {
    const parsed = parsePublicImages({
      images: {
        custom_slot: {
          file_id: "abc",
          url: "https://x.com",
          mime_type: "image/jpeg",
          filename: "x.jpg",
        },
      },
    });
    assert.ok(parsed.images.custom_slot);
  });

  it("rejeita imagem sem file_id", () => {
    assert.throws(() =>
      parsePublicImages({
        images: {
          cover: { url: "https://x.com", mime_type: "image/jpeg", filename: "x.jpg" },
        },
      }),
    );
  });
});

// ─── 02-clarice-suggestions.json ───────────────────────────────────────────

describe("ClariceSuggestionsSchema (02-clarice-suggestions.json)", () => {
  it("valida fixture real", () => {
    const path = resolve(FIXTURES, "02-clarice-suggestions.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = parseClariceSuggestions(raw);
    assert.ok(Array.isArray(parsed));
    assert.ok(parsed.length > 0, "Esperava ≥1 sugestão na fixture");
    assert.ok(parsed[0].from, "Sugestão deve ter campo from");
    assert.ok(parsed[0].to, "Sugestão deve ter campo to");
  });

  it("array vazio é válido (humanização não retornou sugestões)", () => {
    const parsed = parseClariceSuggestions([]);
    assert.equal(parsed.length, 0);
  });

  it("rejeita sugestão sem from/to", () => {
    assert.throws(() => parseClariceSuggestions([{ rule: "x" }]));
  });

  it("rule e explanation são opcionais", () => {
    const parsed = parseClariceSuggestions([{ from: "a", to: "b" }]);
    assert.equal(parsed[0].from, "a");
  });
});
