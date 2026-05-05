import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseApprovedJson, parseCategorizedJson } from "../../scripts/lib/schemas/edition-state.ts";

const validApproved = {
  highlights: [
    { rank: 1, score: 92, bucket: "noticias", url: "https://a.com/", article: { url: "https://a.com/", title: "A", date: "2026-05-05", score: 92 } },
    { rank: 2, score: 85, bucket: "noticias", url: "https://b.com/", article: { url: "https://b.com/", title: "B", date: "2026-05-05", score: 85 } },
    { rank: 3, score: 78, bucket: "noticias", url: "https://c.com/", article: { url: "https://c.com/", title: "C", date: "2026-05-05", score: 78 } },
  ],
  lancamento: [{ url: "https://anthropic.com/news/x", title: "T", date: "2026-05-05", score: 70 }],
  pesquisa: [{ url: "https://arxiv.org/abs/1234", title: "P", date: "2026-05-04", score: 60 }],
  noticias: [{ url: "https://techcrunch.com/y", title: "N", date: "2026-05-05", score: 50 }],
};

describe("edition-state schemas (#632)", () => {
  describe("parseApprovedJson", () => {
    it("parse válido sem erro", () => {
      const result = parseApprovedJson(validApproved);
      assert.equal(result.highlights.length, 3);
    });

    it("rejeita highlights vazio", () => {
      assert.throws(
        () => parseApprovedJson({ ...validApproved, highlights: [] }),
        /too_small|invalid_type/i,
      );
    });

    it("rejeita highlights com mais de 3", () => {
      assert.throws(
        () => parseApprovedJson({ ...validApproved, highlights: [...validApproved.highlights, validApproved.highlights[0]] }),
        /too_big|invalid_type/i,
      );
    });

    it("rejeita URL inválida em lancamento", () => {
      const bad = { ...validApproved, lancamento: [{ url: "not-a-url", title: "T" }] };
      assert.throws(() => parseApprovedJson(bad), /url|invalid/i);
    });

    it("aceita campos extras (passthrough)", () => {
      const extra = { ...validApproved, custom_field: "custom" };
      const result = parseApprovedJson(extra);
      assert.equal((result as Record<string, unknown>).custom_field, "custom");
    });
  });

  describe("parseCategorizedJson", () => {
    it("parse mínimo com buckets obrigatórios", () => {
      const result = parseCategorizedJson({
        lancamento: [],
        pesquisa: [],
        noticias: [],
      });
      assert.deepEqual(result.lancamento, []);
    });

    it("aceita highlights opcional", () => {
      const result = parseCategorizedJson({ lancamento: [], pesquisa: [], noticias: [], highlights: [] });
      assert.deepEqual(result.highlights, []);
    });

    it("rejeita missing lancamento", () => {
      assert.throws(
        () => parseCategorizedJson({ pesquisa: [], noticias: [] }),
        /required|invalid/i,
      );
    });
  });
});
