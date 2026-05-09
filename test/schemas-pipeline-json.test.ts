import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseApproved, ApprovedSchema } from "../scripts/lib/schemas/approved.ts";
import { parseEiaMeta, EiaMetaSchema } from "../scripts/lib/schemas/eia-meta.ts";
import { parsePublicImages, PublicImagesSchema } from "../scripts/lib/schemas/public-images.ts";
import { parseClariceSuggestions, ClariceSuggestionsSchema } from "../scripts/lib/schemas/clarice-suggestions.ts";

/**
 * Tests de schemas Zod pra JSONs internos do pipeline (#1012).
 *
 * Estratégia:
 *   - Validação positiva via fixtures reais existentes em data/editions/
 *   - Validação negativa pra catch schema drift
 *   - Tests não dependem de edição específica — usam glob da edição mais recente
 */

const ROOT = resolve(import.meta.dirname, "..");

// ─── 01-approved.json ──────────────────────────────────────────────────────

describe("ApprovedSchema (01-approved.json)", () => {
  it("valida fixture real (edição 260508)", () => {
    const path = resolve(ROOT, "data/editions/260508/_internal/01-approved.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = parseApproved(raw);
    assert.ok(parsed.highlights.length > 0, "Esperava ≥1 highlight");
    assert.ok(parsed.highlights[0].article.url, "Highlight deve ter article.url");
  });

  it("highlights vazio é válido", () => {
    const parsed = parseApproved({ highlights: [] });
    assert.equal(parsed.highlights.length, 0);
  });

  it("rejeita raw sem highlights", () => {
    assert.throws(() => parseApproved({}), /highlights/);
  });

  it("rejeita highlight sem article", () => {
    assert.throws(() =>
      parseApproved({
        highlights: [{ rank: 1, score: 80 }],
      }),
    );
  });

  it("aceita campos extras (passthrough)", () => {
    const parsed = parseApproved({
      highlights: [
        {
          rank: 1,
          score: 80,
          article: { url: "https://x.com", title: "Test" },
          campo_novo: "valor",
        },
      ],
      extra_top_level: 42,
    });
    assert.equal((parsed.highlights[0] as { campo_novo?: string }).campo_novo, "valor");
  });
});

// ─── 01-eia-meta.json ──────────────────────────────────────────────────────

describe("EiaMetaSchema (01-eia-meta.json)", () => {
  it("valida fixture real (edição 260504)", () => {
    const path = resolve(ROOT, "data/editions/260504/_internal/01-eia-meta.json");
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
  it("valida fixture real (edição 260424)", () => {
    const path = resolve(ROOT, "data/editions/260424/06-public-images.json");
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
  it("valida fixture real (edição 260428)", () => {
    const path = resolve(ROOT, "data/editions/260428/_internal/02-clarice-suggestions.json");
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
