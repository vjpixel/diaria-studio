/**
 * count-subscriptions-by-utm.test.ts (#2457)
 *
 * Cobre os helpers puros de parsing/agregação de utm_source das subscriptions.
 * Sem rede — fetchAndAggregate (que depende de I/O) não é exercida aqui; a
 * lógica de paginação está coberta pela estrutura análoga em backup-beehiiv.test.ts.
 *
 * Regra #633: testes de regressão que garantem que a contagem por origem
 * (utm_source) funciona corretamente com mocks de resposta da API Beehiiv.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeUtmSource,
  aggregateByUtmSource,
  formatCountsTable,
} from "../scripts/count-subscriptions-by-utm.ts";

// ---------------------------------------------------------------------------
// normalizeUtmSource
// ---------------------------------------------------------------------------

describe("normalizeUtmSource (#2457)", () => {
  it("retorna __none__ para null", () => {
    assert.equal(normalizeUtmSource(null), "__none__");
  });

  it("retorna __none__ para undefined", () => {
    assert.equal(normalizeUtmSource(undefined), "__none__");
  });

  it("retorna __none__ para string vazia", () => {
    assert.equal(normalizeUtmSource(""), "__none__");
  });

  it("retorna __none__ para string só-espaço", () => {
    assert.equal(normalizeUtmSource("   "), "__none__");
  });

  it("lowercaseia mensal-brevo", () => {
    assert.equal(normalizeUtmSource("Mensal-Brevo"), "mensal-brevo");
  });

  it("trimeia espaços extras", () => {
    assert.equal(normalizeUtmSource("  mensal-brevo  "), "mensal-brevo");
  });

  it("preserva o valor exato lowercase", () => {
    assert.equal(normalizeUtmSource("twitter"), "twitter");
    assert.equal(normalizeUtmSource("organic"), "organic");
  });
});

// ---------------------------------------------------------------------------
// aggregateByUtmSource
// ---------------------------------------------------------------------------

describe("aggregateByUtmSource (#2457)", () => {
  it("conta corretamente por utm_source", () => {
    const subs = [
      { id: "s1", utm_source: "mensal-brevo" },
      { id: "s2", utm_source: "mensal-brevo" },
      { id: "s3", utm_source: "twitter" },
      { id: "s4", utm_source: null },
      { id: "s5", utm_source: "" },
    ];
    const counts = aggregateByUtmSource(subs);
    assert.equal(counts["mensal-brevo"], 2);
    assert.equal(counts["twitter"], 1);
    assert.equal(counts["__none__"], 2); // null + ""
  });

  it("retorna objeto vazio para array vazio", () => {
    const counts = aggregateByUtmSource([]);
    assert.deepEqual(counts, {});
  });

  it("case-insensitive: Mensal-Brevo e mensal-brevo contam juntos", () => {
    const subs = [
      { id: "s1", utm_source: "Mensal-Brevo" },
      { id: "s2", utm_source: "mensal-brevo" },
      { id: "s3", utm_source: "MENSAL-BREVO" },
    ];
    const counts = aggregateByUtmSource(subs);
    assert.equal(counts["mensal-brevo"], 3);
    assert.equal(Object.keys(counts).length, 1);
  });

  it("ausência do campo utm_source cai em __none__", () => {
    const subs = [
      { id: "s1" }, // sem utm_source
      { id: "s2", utm_source: undefined },
    ] as Array<Record<string, unknown>>;
    const counts = aggregateByUtmSource(subs);
    assert.equal(counts["__none__"], 2);
  });

  it("múltiplas fontes são contadas independentemente", () => {
    const subs = [
      { id: "s1", utm_source: "mensal-brevo" },
      { id: "s2", utm_source: "organic" },
      { id: "s3", utm_source: "twitter" },
      { id: "s4", utm_source: "organic" },
      { id: "s5", utm_source: "organic" },
    ];
    const counts = aggregateByUtmSource(subs);
    assert.equal(counts["mensal-brevo"], 1);
    assert.equal(counts["organic"], 3);
    assert.equal(counts["twitter"], 1);
    assert.equal(Object.keys(counts).length, 3);
  });

  it("total das contagens == número de subscriptions", () => {
    const subs = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      utm_source: i < 3 ? "mensal-brevo" : null,
    }));
    const counts = aggregateByUtmSource(subs);
    const sum = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, 10);
  });
});

// ---------------------------------------------------------------------------
// formatCountsTable
// ---------------------------------------------------------------------------

describe("formatCountsTable (#2457)", () => {
  it("retorna mensagem para objeto vazio", () => {
    assert.equal(formatCountsTable({}, 0), "(nenhum assinante encontrado)");
  });

  it("inclui header utm_source", () => {
    const table = formatCountsTable({ "mensal-brevo": 5, "__none__": 100 }, 105);
    assert.ok(table.includes("utm_source"), "deve incluir header 'utm_source'");
  });

  it("inclui as fontes com contagem", () => {
    const table = formatCountsTable({ "mensal-brevo": 7, "__none__": 93 }, 100);
    assert.ok(table.includes("mensal-brevo"), "deve incluir 'mensal-brevo'");
    assert.ok(table.includes("7"), "deve incluir a contagem 7");
    assert.ok(table.includes("__none__"), "deve incluir '__none__'");
  });

  it("inclui linha TOTAL", () => {
    const table = formatCountsTable({ "mensal-brevo": 5 }, 5);
    assert.ok(table.includes("TOTAL"), "deve incluir linha TOTAL");
  });

  it("percentagem de mensal-brevo está correta", () => {
    const table = formatCountsTable({ "mensal-brevo": 10, "__none__": 90 }, 100);
    // 10% — deve aparecer "10.0%"
    assert.ok(table.includes("10.0%"), `percentagem esperada 10.0% não encontrada. Tabela:\n${table}`);
  });

  it("ordena por contagem decrescente (maior primeiro)", () => {
    const table = formatCountsTable({
      "twitter": 2,
      "mensal-brevo": 50,
      "__none__": 300,
    }, 352);
    const idxNone = table.indexOf("__none__");
    const idxMensal = table.indexOf("mensal-brevo");
    const idxTwitter = table.indexOf("twitter");
    assert.ok(idxNone < idxMensal, "__none__ (300) deve aparecer antes de mensal-brevo (50)");
    assert.ok(idxMensal < idxTwitter, "mensal-brevo (50) deve aparecer antes de twitter (2)");
  });
});

// ---------------------------------------------------------------------------
// Regressão: mock de resposta da API Beehiiv (estrutura real)
// ---------------------------------------------------------------------------

describe("aggregateByUtmSource — mock resposta API Beehiiv (#2457)", () => {
  /**
   * Simula o shape real de um objeto de subscription retornado pela API Beehiiv
   * com `expand[]=utm_params`. Os campos utm_* ficam no nível raiz da subscription.
   */
  function makeBeehiivSub(id: string, utm_source: string | null): Record<string, unknown> {
    return {
      id,
      email: `${id}@example.com`,
      status: "active",
      created: 1700000000,
      utm_source,
      utm_medium: null,
      utm_campaign: null,
      utm_channel: null,
      referring_site: null,
    };
  }

  it("conta mensal-brevo corretamente num batch de subscriptions", () => {
    const subs = [
      makeBeehiivSub("a1", "mensal-brevo"),
      makeBeehiivSub("a2", "mensal-brevo"),
      makeBeehiivSub("a3", "mensal-brevo"),
      makeBeehiivSub("a4", null),
      makeBeehiivSub("a5", "twitter"),
      makeBeehiivSub("a6", null),
    ];
    const counts = aggregateByUtmSource(subs);
    assert.equal(counts["mensal-brevo"], 3, "deve contar 3 via mensal-brevo");
    assert.equal(counts["__none__"], 2, "deve contar 2 sem utm");
    assert.equal(counts["twitter"], 1, "deve contar 1 via twitter");
    assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 6, "total deve ser 6");
  });

  it("base sem nenhum mensal-brevo retorna 0 (campo ausente do counts)", () => {
    const subs = [
      makeBeehiivSub("b1", null),
      makeBeehiivSub("b2", "organic"),
    ];
    const counts = aggregateByUtmSource(subs);
    assert.equal(counts["mensal-brevo"], undefined, "mensal-brevo não deve aparecer se count=0");
    assert.equal(counts["__none__"] ?? 0, 1);
    assert.equal(counts["organic"] ?? 0, 1);
  });
});
