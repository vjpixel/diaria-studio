/**
 * cohort-engagement.test.ts (#4464)
 *
 * Cobre os helpers puros de normalização/agrupamento/agregação e a
 * paginação + guard anti-truncamento de `fetchAllSubscribers` (mock de
 * `fetch`, sem tocar a API Beehiiv de verdade — regra #633 + regra
 * invariável do dispatch desta unidade).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeKey,
  resolveGroupKey,
  parseSinceToEpochSeconds,
  filterSince,
  median,
  mean,
  computeGroupEngagement,
  aggregateEngagement,
  formatEngagementTable,
  fetchAllSubscribers,
  runCohortEngagement,
  type EngagementSubscriber,
} from "../scripts/cohort-engagement.ts";

// ---------------------------------------------------------------------------
// normalizeKey / resolveGroupKey
// ---------------------------------------------------------------------------

describe("normalizeKey (#4464)", () => {
  it("retorna __none__ para null/undefined/vazio/espaço", () => {
    assert.equal(normalizeKey(null), "__none__");
    assert.equal(normalizeKey(undefined), "__none__");
    assert.equal(normalizeKey(""), "__none__");
    assert.equal(normalizeKey("   "), "__none__");
  });

  it("lowercaseia e trimeia", () => {
    assert.equal(normalizeKey("  Google-Ads  "), "google-ads");
  });
});

describe("resolveGroupKey (#4464)", () => {
  it("usa utm_source quando presente", () => {
    const key = resolveGroupKey({ utm_source: "google-ads", referring_site: "google.com" });
    assert.equal(key, "google-ads");
  });

  it("cai para referring_site quando utm_source ausente", () => {
    const key = resolveGroupKey({ utm_source: null, referring_site: "https://google.com" });
    assert.equal(key, "https://google.com");
  });

  it("retorna __none__ quando ambos ausentes", () => {
    const key = resolveGroupKey({ utm_source: null, referring_site: null });
    assert.equal(key, "__none__");
  });

  it("referring_site vazio também cai em __none__", () => {
    const key = resolveGroupKey({ utm_source: "", referring_site: "" });
    assert.equal(key, "__none__");
  });
});

// ---------------------------------------------------------------------------
// parseSinceToEpochSeconds / filterSince — bordas do dia (#4464)
// ---------------------------------------------------------------------------

describe("parseSinceToEpochSeconds (#4464)", () => {
  it("converte AAAA-MM-DD no epoch de início do dia (UTC)", () => {
    const epoch = parseSinceToEpochSeconds("2026-07-31");
    assert.equal(epoch, Date.UTC(2026, 6, 31, 0, 0, 0, 0) / 1000);
  });

  it("lança para formato inválido", () => {
    assert.throws(() => parseSinceToEpochSeconds("31/07/2026"), /--since inválido/);
    assert.throws(() => parseSinceToEpochSeconds("2026-7-31"), /--since inválido/);
    assert.throws(() => parseSinceToEpochSeconds(""), /--since inválido/);
  });
});

describe("filterSince — bordas do dia (#4464)", () => {
  const cutoff = parseSinceToEpochSeconds("2026-07-31");

  it("assinante criado EXATAMENTE na data de corte entra (inclusivo)", () => {
    const subs: EngagementSubscriber[] = [{ created: cutoff }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 1);
  });

  it("assinante criado 1 segundo antes da data de corte NÃO entra", () => {
    const subs: EngagementSubscriber[] = [{ created: cutoff - 1 }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 0);
  });

  it("assinante criado 1 dia inteiro antes não entra", () => {
    const oneDayBefore = cutoff - 86400;
    const subs: EngagementSubscriber[] = [{ created: oneDayBefore }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 0);
  });

  it("assinante criado depois da data de corte entra", () => {
    const subs: EngagementSubscriber[] = [{ created: cutoff + 86400 }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 1);
  });

  it("sem sinceEpochSeconds (null), não filtra nada", () => {
    const subs: EngagementSubscriber[] = [{ created: 0 }, { created: cutoff - 999999 }];
    const out = filterSince(subs, null);
    assert.equal(out.length, 2);
  });

  it("assinante sem `created` é excluído quando --since está ativo", () => {
    const subs: EngagementSubscriber[] = [{ created: undefined }, { created: cutoff }];
    const out = filterSince(subs, cutoff);
    assert.equal(out.length, 1);
  });
});

// ---------------------------------------------------------------------------
// median / mean
// ---------------------------------------------------------------------------

describe("median (#4464)", () => {
  it("retorna null para lista vazia", () => {
    assert.equal(median([]), null);
  });

  it("ímpar: retorna o elemento central", () => {
    assert.equal(median([1, 3, 2]), 2);
  });

  it("par: retorna a média dos dois centrais", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5);
  });

  it("não muta o array de entrada", () => {
    const input = [5, 1, 3];
    median(input);
    assert.deepEqual(input, [5, 1, 3]);
  });
});

describe("mean (#4464)", () => {
  it("retorna null para lista vazia", () => {
    assert.equal(mean([]), null);
  });

  it("calcula a média simples", () => {
    assert.equal(mean([2, 4, 6]), 4);
  });
});

// ---------------------------------------------------------------------------
// computeGroupEngagement — agregação pura (#4464)
// ---------------------------------------------------------------------------

function makeSub(overrides: Partial<EngagementSubscriber> = {}): EngagementSubscriber {
  return {
    id: "sub_x",
    status: "active",
    created: 1_700_000_000,
    utm_source: "google-ads",
    referring_site: null,
    stats: { total_sent: 10, total_received: 10, total_unique_opened: 4, open_rate: 40 },
    ...overrides,
  };
}

describe("computeGroupEngagement (#4464)", () => {
  it("conta status corretamente", () => {
    const subs = [
      makeSub({ status: "active" }),
      makeSub({ status: "active" }),
      makeSub({ status: "inactive" }),
      makeSub({ status: "pending" }),
      makeSub({ status: "invalid" }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.cadastros, 5);
    assert.equal(g.ativos, 2);
    assert.equal(g.inativos, 1);
    assert.equal(g.pending, 1);
    assert.equal(g.invalid, 1);
    assert.equal(g.outros_status, 0);
  });

  it("status desconhecido (ex: validating) cai em outros_status, não é descartado", () => {
    const subs = [makeSub({ status: "validating" })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.cadastros, 1);
    assert.equal(g.outros_status, 1);
    assert.equal(g.ativos, 0);
  });

  it("leitores = ativos com open_rate >= threshold", () => {
    const subs = [
      makeSub({ stats: { total_received: 10, total_unique_opened: 5, open_rate: 50 } }),
      makeSub({ stats: { total_received: 10, total_unique_opened: 3, open_rate: 30 } }),
      makeSub({ stats: { total_received: 10, total_unique_opened: 4, open_rate: 40 } }), // == threshold, entra
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 3);
    assert.equal(g.leitores, 2, "50 e 40 (>= 40) contam; 30 não");
  });

  it("abertura_agregada = soma(total_unique_opened) / soma(total_received)", () => {
    const subs = [
      makeSub({ stats: { total_received: 10, total_unique_opened: 5, open_rate: 50 } }),
      makeSub({ stats: { total_received: 20, total_unique_opened: 2, open_rate: 10 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    // (5+2) / (10+20) = 7/30
    assert.equal(g.abertura_agregada, 7 / 30);
  });

  it("abertura_agregada é null quando não há denominador (nenhum ativo com stats)", () => {
    const subs = [makeSub({ stats: null })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 1);
    assert.equal(g.abertura_agregada, null);
    assert.equal(g.leitores, 0);
  });

  it("assinante sem `stats` (campo ausente) não quebra e não conta como leitor", () => {
    const subs = [
      makeSub({ stats: undefined }),
      makeSub({ stats: { total_received: 10, total_unique_opened: 9, open_rate: 90 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 2, "ambos contam como ativos (status independe de stats)");
    assert.equal(g.leitores, 1, "só o que tem stats conta como leitor");
    assert.equal(g.amostra_considerada, 1, "sem-stats fica fora do denominador de engajamento");
  });

  it("inativo/pending/invalid nunca entram no denominador de leitores/abertura", () => {
    const subs = [
      makeSub({ status: "inactive", stats: { total_received: 100, total_unique_opened: 100, open_rate: 100 } }),
      makeSub({ status: "active", stats: { total_received: 10, total_unique_opened: 1, open_rate: 10 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 5 });
    assert.equal(g.leitores, 1, "só o ativo conta, mesmo tendo open_rate menor que o inativo");
    assert.equal(g.amostra_considerada, 1);
  });

  it("--min-received refaz o corte só com ativos com total_received >= N", () => {
    const subs = [
      makeSub({ stats: { total_received: 3, total_unique_opened: 3, open_rate: 100 } }), // pouco histórico
      makeSub({ stats: { total_received: 20, total_unique_opened: 2, open_rate: 10 } }),
    ];
    const semCorte = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(semCorte.leitores, 1);
    assert.equal(semCorte.amostra_considerada, 2);

    const comCorte = computeGroupEngagement(subs, { threshold: 40, minReceived: 10 });
    assert.equal(comCorte.amostra_considerada, 1, "só o de 20 recebidas sobrevive ao corte de 10");
    assert.equal(comCorte.leitores, 0, "o único considerado tem open_rate 10 < 40");
  });

  it("amostra_instavel = true quando mediana de total_received < 10", () => {
    const subs = [
      makeSub({ stats: { total_received: 2, total_unique_opened: 1, open_rate: 50 } }),
      makeSub({ stats: { total_received: 3, total_unique_opened: 1, open_rate: 33 } }),
      makeSub({ stats: { total_received: 4, total_unique_opened: 1, open_rate: 25 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.mediana_recebidas, 3);
    assert.equal(g.amostra_instavel, true);
  });

  it("amostra_instavel = false quando mediana de total_received >= 10", () => {
    const subs = [
      makeSub({ stats: { total_received: 10, total_unique_opened: 1, open_rate: 10 } }),
      makeSub({ stats: { total_received: 15, total_unique_opened: 1, open_rate: 10 } }),
      makeSub({ stats: { total_received: 20, total_unique_opened: 1, open_rate: 10 } }),
    ];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.mediana_recebidas, 15);
    assert.equal(g.amostra_instavel, false);
  });

  it("grupo sem nenhum ativo: media/mediana/abertura null, amostra_instavel false", () => {
    const subs = [makeSub({ status: "pending", stats: null })];
    const g = computeGroupEngagement(subs, { threshold: 40 });
    assert.equal(g.ativos, 0);
    assert.equal(g.media_recebidas, null);
    assert.equal(g.mediana_recebidas, null);
    assert.equal(g.abertura_agregada, null);
    assert.equal(g.amostra_instavel, false);
  });
});

// ---------------------------------------------------------------------------
// aggregateEngagement — agrupamento (#4464)
// ---------------------------------------------------------------------------

describe("aggregateEngagement (#4464)", () => {
  it("agrupa por utm_source com referring_site como fallback", () => {
    const subs = [
      makeSub({ utm_source: "google-ads", referring_site: null }),
      makeSub({ utm_source: null, referring_site: "linkedin.com" }),
      makeSub({ utm_source: null, referring_site: "linkedin.com" }),
      makeSub({ utm_source: null, referring_site: null }),
    ];
    const result = aggregateEngagement(subs, { threshold: 40 });
    assert.equal(result["google-ads"].cadastros, 1);
    assert.equal(result["linkedin.com"].cadastros, 2);
    assert.equal(result["__none__"].cadastros, 1);
  });
});

// ---------------------------------------------------------------------------
// formatEngagementTable — smoke (#4464)
// ---------------------------------------------------------------------------

describe("formatEngagementTable (#4464)", () => {
  it("retorna mensagem para resultado vazio", () => {
    const table = formatEngagementTable({
      groups: {},
      total_cadastros: 0,
      threshold: 40,
      min_received: null,
      since: null,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(table, "(nenhum assinante encontrado)");
  });

  it("inclui a origem, cadastros e o marcador de instabilidade", () => {
    const table = formatEngagementTable({
      groups: {
        "google-ads": {
          cadastros: 3,
          ativos: 3,
          inativos: 0,
          pending: 0,
          invalid: 0,
          outros_status: 0,
          leitores: 1,
          abertura_agregada: 0.249,
          media_recebidas: 5,
          mediana_recebidas: 3,
          amostra_instavel: true,
          amostra_considerada: 3,
        },
      },
      total_cadastros: 3,
      threshold: 40,
      min_received: null,
      since: null,
      fetched_at: "2026-08-02T00:00:00.000Z",
    });
    assert.ok(table.includes("google-ads"));
    assert.ok(table.includes("24.9%"));
    assert.ok(table.includes("⚠instável"));
  });
});

// ---------------------------------------------------------------------------
// fetchAllSubscribers — paginação + guard anti-truncamento (#4464)
// mesmo padrão de mock do count-subscriptions-by-utm.test.ts, NUNCA rede real.
// ---------------------------------------------------------------------------

describe("fetchAllSubscribers — paginação (#4464)", () => {
  const mockFetchPages = (pages: Array<Record<string, unknown>>) => {
    let call = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => pages[call++],
    })) as unknown as typeof fetch;
    return { restore: () => { globalThis.fetch = orig; }, calls: () => call };
  };

  it("respeita total_results e drena todas as páginas", async () => {
    const m = mockFetchPages([
      { data: Array.from({ length: 100 }, (_, i) => ({ id: `s${i}`, status: "active" })), total_results: 130, limit: 100 },
      { data: Array.from({ length: 30 }, (_, i) => ({ id: `s${100 + i}`, status: "active" })), total_results: 130, limit: 100 },
    ]);
    try {
      const subs = await fetchAllSubscribers("pub_x", "key_x");
      assert.equal(subs.length, 130);
      assert.equal(m.calls(), 2);
    } finally {
      m.restore();
    }
  });

  it("sem total_results, usa o `limit` reportado pra decidir se há mais", async () => {
    const m = mockFetchPages([
      { data: Array.from({ length: 10 }, () => ({ status: "active" })), limit: 10 },
      { data: Array.from({ length: 3 }, () => ({ status: "active" })), limit: 10 },
    ]);
    try {
      const subs = await fetchAllSubscribers("pub_x", "key_x");
      assert.equal(subs.length, 13);
      assert.equal(m.calls(), 2);
    } finally {
      m.restore();
    }
  });

  it("guard anti-truncamento: aborta (nunca retorna contagem parcial) em drenagem incompleta", async () => {
    const m = mockFetchPages([
      { data: Array.from({ length: 5 }, () => ({ status: "active" })), total_results: 50, limit: 10 },
      { data: [], total_results: 50, limit: 10 }, // página vazia mid-drain
    ]);
    try {
      await assert.rejects(
        fetchAllSubscribers("pub_x", "key_x"),
        /truncado: 5\/50/,
        "deve lançar (não retornar contagem parcial) quando total_results não foi totalmente drenado",
      );
    } finally {
      m.restore();
    }
  });

  it("página vazia sem total_results reportado encerra a drenagem normalmente", async () => {
    const m = mockFetchPages([{ data: [], limit: 100 }]);
    try {
      const subs = await fetchAllSubscribers("pub_x", "key_x");
      assert.equal(subs.length, 0);
    } finally {
      m.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// runCohortEngagement — integração fetch + since + aggregate (mock) (#4464)
// ---------------------------------------------------------------------------

describe("runCohortEngagement — integração com mock (#4464)", () => {
  const mockFetchOnePage = (data: Array<Record<string, unknown>>) => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
      json: async () => ({ data, total_results: data.length, limit: 100 }),
    })) as unknown as typeof fetch;
    return { restore: () => { globalThis.fetch = orig; } };
  };

  it("aplica --since antes de agregar", async () => {
    const cutoff = parseSinceToEpochSeconds("2026-07-31");
    const m = mockFetchOnePage([
      { id: "old", status: "active", created: cutoff - 86400, utm_source: "google-ads", stats: { total_received: 10, total_unique_opened: 4, open_rate: 40 } },
      { id: "new", status: "active", created: cutoff, utm_source: "google-ads", stats: { total_received: 10, total_unique_opened: 4, open_rate: 40 } },
    ]);
    try {
      const result = await runCohortEngagement("pub_x", "key_x", {
        threshold: 40,
        sinceEpochSeconds: cutoff,
        sinceLabel: "2026-07-31",
      });
      assert.equal(result.total_cadastros, 1, "só o assinante criado na/após a data de corte entra");
      assert.equal(result.groups["google-ads"].cadastros, 1);
      assert.equal(result.since, "2026-07-31");
    } finally {
      m.restore();
    }
  });
});
