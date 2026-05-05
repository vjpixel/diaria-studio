import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractPublishedDate,
  extractPublishedAtIso,
} from "../scripts/lib/beehiiv-timestamp.ts";

const NOW = new Date("2026-05-05T02:00:00Z");

describe("extractPublishedDate (#572 + #573)", () => {
  describe("ISO fields preferidos", () => {
    it("published_at ISO → Date", () => {
      const d = extractPublishedDate({
        published_at: "2026-05-04T08:00:00Z",
      });
      assert.equal(d?.toISOString(), "2026-05-04T08:00:00.000Z");
    });

    it("scheduled_at quando published_at vazio", () => {
      const d = extractPublishedDate({
        published_at: null,
        scheduled_at: "2026-05-04T08:00:00Z",
      });
      assert.equal(d?.toISOString(), "2026-05-04T08:00:00.000Z");
    });

    it("updated_at como último ISO recurso", () => {
      const d = extractPublishedDate({
        published_at: null,
        scheduled_at: null,
        updated_at: "2026-05-04T08:00:00Z",
      });
      assert.equal(d?.toISOString(), "2026-05-04T08:00:00.000Z");
    });

    it("ISO inválido retorna null se não tem outro fallback", () => {
      const d = extractPublishedDate({ published_at: "not-a-date" });
      assert.equal(d, null);
    });
  });

  describe("publish_date Unix seconds (#572 — Beehiiv API atual)", () => {
    it("Unix seconds → Date", () => {
      // 2026-05-04T08:00:00Z = 1777881600 seconds
      const d = extractPublishedDate({ publish_date: 1777881600 });
      assert.equal(d?.toISOString(), "2026-05-04T08:00:00.000Z");
    });

    it("publish_date acionado quando todos ISO fields são null (caso real Beehiiv)", () => {
      const d = extractPublishedDate({
        published_at: null,
        scheduled_at: null,
        updated_at: null,
        publish_date: 1777881600,
      });
      assert.equal(d?.toISOString(), "2026-05-04T08:00:00.000Z");
    });

    it("publish_date em ms (> 1e12) é normalizado pra seconds", () => {
      // Defensive: se vier em ms por engano, detecta magnitude e ajusta
      const d = extractPublishedDate({ publish_date: 1777881600000 });
      assert.equal(d?.toISOString(), "2026-05-04T08:00:00.000Z");
    });

    it("publish_date 0 ou negativo retorna null", () => {
      assert.equal(extractPublishedDate({ publish_date: 0 }), null);
      assert.equal(extractPublishedDate({ publish_date: -1 }), null);
    });

    it("ISO field tem precedência sobre publish_date", () => {
      const d = extractPublishedDate({
        published_at: "2026-05-03T00:00:00Z",
        publish_date: 1777881600, // 2026-05-04
      });
      // Deve usar o ISO de 2026-05-03, não o publish_date de 2026-05-04
      assert.equal(d?.toISOString(), "2026-05-03T00:00:00.000Z");
    });
  });

  describe("future filtering (#573)", () => {
    it("post agendado pro futuro retorna null quando `now` é passado", () => {
      const d = extractPublishedDate(
        { publish_date: 1778004000 }, // 2026-05-05T18:00:00Z, 16h depois de NOW
        NOW,
      );
      assert.equal(d, null);
    });

    it("post passado retorna Date normalmente quando `now` é passado", () => {
      const d = extractPublishedDate(
        { publish_date: 1777881600 }, // 2026-05-04T08:00:00Z, antes de NOW
        NOW,
      );
      assert.equal(d?.toISOString(), "2026-05-04T08:00:00.000Z");
    });

    it("sem `now`, post futuro é retornado normalmente (compat retroativa)", () => {
      const d = extractPublishedDate({ publish_date: 1778004000 });
      assert.ok(d, "deve retornar Date sem filtro quando now é undefined");
    });

    it("post no exato instante `now` retorna o Date (não filtra)", () => {
      const d = extractPublishedDate(
        { publish_date: NOW.getTime() / 1000 },
        NOW,
      );
      assert.equal(d?.toISOString(), NOW.toISOString());
    });

    it("ISO no futuro também é filtrado quando `now` passado", () => {
      const d = extractPublishedDate(
        { published_at: "2026-05-05T18:11:00Z" },
        NOW,
      );
      assert.equal(d, null);
    });
  });

  describe("missing fields", () => {
    it("post vazio retorna null", () => {
      assert.equal(extractPublishedDate({}), null);
    });

    it("todos campos null retorna null (caso real Beehiiv pré-#572)", () => {
      const d = extractPublishedDate({
        published_at: null,
        scheduled_at: null,
        updated_at: null,
        publish_date: null,
      });
      assert.equal(d, null);
    });
  });

  describe("extractPublishedAtIso", () => {
    it("retorna ISO string quando data é parseável", () => {
      assert.equal(
        extractPublishedAtIso({ publish_date: 1777881600 }),
        "2026-05-04T08:00:00.000Z",
      );
    });

    it("retorna null quando data não é parseável", () => {
      assert.equal(extractPublishedAtIso({}), null);
    });

    it("retorna null quando data futura + now passado (#573)", () => {
      assert.equal(
        extractPublishedAtIso({ publish_date: 1778004000 }, NOW),
        null,
      );
    });
  });
});
