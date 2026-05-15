import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterDateWindow, bucketWindowDays } from "../scripts/filter-date-window.ts";

describe("filterDateWindow", () => {
  it("remove artigos antes da janela", () => {
    const input = {
      lancamento: [
        { url: "https://a.com/1", title: "Hoje", date: "2026-04-24" },
        { url: "https://a.com/2", title: "Antigo", date: "2026-04-10" },
      ],
      pesquisa: [],
      noticias: [],
    };
    const { kept, removed } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(kept.lancamento.length, 1);
    assert.equal(kept.lancamento[0].title, "Hoje");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].title, "Antigo");
  });

  it("cutoff = edition_date - window_days (testando bucket noticias que segue default)", () => {
    // #1155: lancamento e pesquisa usam janela maior; teste reformulado
    // pra usar noticias que segue o windowDays passado.
    const input = {
      lancamento: [],
      pesquisa: [],
      noticias: [
        { url: "https://a.com/1", title: "Dia do corte", date: "2026-04-21" },
        { url: "https://a.com/2", title: "Dia antes do corte", date: "2026-04-20" },
      ],
    };
    const { kept, removed, cutoff } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(cutoff, "2026-04-21");
    assert.equal(kept.noticias.length, 1);
    assert.equal(kept.noticias[0].title, "Dia do corte");
    assert.equal(removed[0].title, "Dia antes do corte");
  });

  it("mantém artigos sem data com flag date_unverified", () => {
    const input = {
      lancamento: [{ url: "https://a.com/1", title: "Sem data", date: null }],
      pesquisa: [],
      noticias: [],
    };
    const { kept } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(kept.lancamento.length, 1);
    assert.equal(kept.lancamento[0].date_unverified, true);
  });

  it("processa os 3 buckets separadamente", () => {
    const input = {
      lancamento: [{ url: "https://a.com/1", title: "L", date: "2026-04-24" }],
      pesquisa: [{ url: "https://b.com/1", title: "P antigo", date: "2026-04-10" }],
      noticias: [{ url: "https://c.com/1", title: "N", date: "2026-04-23" }],
    };
    const { kept, removed } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(kept.lancamento.length, 1);
    assert.equal(kept.pesquisa.length, 0);
    assert.equal(kept.noticias.length, 1);
    assert.equal(removed[0].bucket, "pesquisa");
  });

  it("aceita buckets vazios ou ausentes", () => {
    const input = {
      lancamento: [{ url: "https://a.com/1", title: "L", date: "2026-04-24" }],
      pesquisa: [],
      noticias: [],
    };
    const { kept } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(kept.lancamento.length, 1);
    assert.equal(kept.pesquisa.length, 0);
    assert.equal(kept.noticias.length, 0);
  });

  it("normaliza datas ISO completas antes de comparar", () => {
    const input = {
      lancamento: [
        { url: "https://a.com/1", title: "ISO full", date: "2026-04-24T12:00:00Z" },
      ],
      pesquisa: [],
      noticias: [],
    };
    const { kept } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(kept.lancamento.length, 1);
  });

  it("removed inclui detail descritivo", () => {
    // #1155: usa noticias pra validar cutoff = anchor - 3 sem extensão
    const input = {
      lancamento: [],
      pesquisa: [],
      noticias: [{ url: "https://a.com/1", title: "Antigo", date: "2026-04-10" }],
    };
    const { removed } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].reason, "date_window");
    assert.ok(removed[0].detail.includes("2026-04-10"));
    assert.ok(removed[0].detail.includes("2026-04-21"));
  });

  it("window=1 permite só ontem e hoje (testando noticias que segue default)", () => {
    // #1155: lancamento usa min 7d; teste reformulado pra noticias.
    const input = {
      lancamento: [],
      pesquisa: [],
      noticias: [
        { url: "https://a.com/1", title: "Hoje", date: "2026-04-24" },
        { url: "https://a.com/2", title: "Ontem", date: "2026-04-23" },
        { url: "https://a.com/3", title: "Anteontem", date: "2026-04-22" },
      ],
    };
    const { kept } = filterDateWindow(input, "2026-04-24", 1);
    assert.equal(kept.noticias.length, 2);
    assert.deepEqual(
      kept.noticias.map((a) => a.title),
      ["Hoje", "Ontem"],
    );
  });

  describe("passthrough de campos extras (#247)", () => {
    it("preserva clusters[] do topic-cluster output", () => {
      const input = {
        lancamento: [{ url: "https://a.com/1", title: "ok", date: "2026-04-24" }],
        pesquisa: [],
        noticias: [],
        clusters: [
          { top_url: "https://a.com/1", member_urls: ["https://a.com/1"], jaccard_min: 0.42 },
        ],
      };
      const { kept } = filterDateWindow(input, "2026-04-24", 3);
      assert.deepEqual(
        (kept as unknown as { clusters: unknown[] }).clusters,
        input.clusters,
      );
    });

    it("preserva metadata arbitrária", () => {
      const input = {
        lancamento: [],
        pesquisa: [],
        noticias: [],
        metadata: { source: "smoke", version: 3 },
        custom_field: ["a", "b"],
      };
      const { kept } = filterDateWindow(input, "2026-04-24", 3);
      assert.deepEqual(
        (kept as unknown as { metadata: unknown }).metadata,
        { source: "smoke", version: 3 },
      );
      assert.deepEqual(
        (kept as unknown as { custom_field: unknown }).custom_field,
        ["a", "b"],
      );
    });

    it("clusters[] sobrevive mesmo quando articles do cluster são removidos", () => {
      const input = {
        lancamento: [
          { url: "https://a.com/old", title: "Antigo", date: "2026-04-10" }, // será removido
        ],
        pesquisa: [],
        noticias: [],
        clusters: [
          {
            top_url: "https://a.com/old",
            member_urls: ["https://a.com/old", "https://a.com/old2"],
            jaccard_min: 0.5,
          },
        ],
      };
      const { kept, removed } = filterDateWindow(input, "2026-04-24", 3);
      assert.equal(removed.length, 1);
      // Cluster info é informativa — preservada mesmo com members fora.
      assert.deepEqual(
        (kept as unknown as { clusters: unknown[] }).clusters,
        input.clusters,
      );
    });

    it("rest spread NÃO sobrescreve os 4 buckets", () => {
      // Cenário hipotético: alguém passa `lancamento` extra no rest (não acontece
      // pelo destructure, mas vale defensivo) — buckets reset garantidos.
      const input = {
        lancamento: [{ url: "https://a.com/1", title: "ok", date: "2026-04-24" }],
        pesquisa: [],
        noticias: [],
      };
      const { kept } = filterDateWindow(input, "2026-04-24", 3);
      assert.ok(Array.isArray(kept.lancamento));
      assert.equal(kept.lancamento.length, 1);
      assert.equal(kept.lancamento[0].title, "ok");
    });
  });

  describe("anchor vs edition_date (#560)", () => {
    it("anchor independente do edition_date — janela cobre passado do anchor", () => {
      const input = {
        // anchor=2026-05-04, window=3 → cutoff=2026-05-01
        // edition_date=2026-05-09 (futuro) — não deve mudar nada.
        // #1155: usa noticias (default windowDays) pra teste do cutoff anchor-based
        lancamento: [],
        pesquisa: [],
        noticias: [
          { url: "https://a.com/1", title: "Recente", date: "2026-05-03" },
          { url: "https://a.com/2", title: "Antes do cutoff", date: "2026-04-30" },
        ],
      };
      const { kept, removed, cutoff, anchor } = filterDateWindow(
        input,
        "2026-05-04",
        3,
        "2026-05-09",
      );
      assert.equal(anchor, "2026-05-04");
      assert.equal(cutoff, "2026-05-01");
      assert.equal(kept.noticias.length, 1);
      assert.equal(kept.noticias[0].title, "Recente");
      assert.equal(removed[0].title, "Antes do cutoff");
      assert.ok(removed[0].detail.includes("edition 2026-05-09"));
    });

    it("removed.detail menciona anchor e (quando passado) edition_date", () => {
      const input = {
        lancamento: [{ url: "https://a.com/1", title: "Antigo", date: "2026-04-10" }],
        pesquisa: [],
        noticias: [],
      };
      const { removed: r1 } = filterDateWindow(input, "2026-04-24", 3);
      assert.ok(r1[0].detail.includes("anchor 2026-04-24"));
      assert.ok(!r1[0].detail.includes("edition"));

      const { removed: r2 } = filterDateWindow(input, "2026-04-24", 3, "2026-04-25");
      assert.ok(r2[0].detail.includes("anchor 2026-04-24"));
      assert.ok(r2[0].detail.includes("edition 2026-04-25"));
    });
  });
});

describe("bucketWindowDays (#1155)", () => {
  it("lancamento usa max(default, 7) — 7 dias mínimo", () => {
    assert.equal(bucketWindowDays("lancamento", 3), 7);
    assert.equal(bucketWindowDays("lancamento", 4), 7);
    assert.equal(bucketWindowDays("lancamento", 7), 7);
    assert.equal(bucketWindowDays("lancamento", 10), 10);
  });

  it("pesquisa usa max(default, 5) — 5 dias mínimo", () => {
    assert.equal(bucketWindowDays("pesquisa", 3), 5);
    assert.equal(bucketWindowDays("pesquisa", 5), 5);
    assert.equal(bucketWindowDays("pesquisa", 7), 7);
  });

  it("noticias e tutorial usam default direto", () => {
    assert.equal(bucketWindowDays("noticias", 3), 3);
    assert.equal(bucketWindowDays("noticias", 7), 7);
    assert.equal(bucketWindowDays("tutorial", 3), 3);
  });

  it("bucket desconhecido usa default", () => {
    assert.equal(bucketWindowDays("video", 3), 3);
    assert.equal(bucketWindowDays("foo", 5), 5);
  });
});

describe("filterDateWindow — janela adaptativa por bucket (#1155)", () => {
  it("lancamento mantém artigo até 7 dias atrás (vs default 3)", () => {
    const input = {
      lancamento: [
        { url: "https://a.com/1", title: "5 dias atrás", date: "2026-05-10" },
        { url: "https://a.com/2", title: "8 dias atrás", date: "2026-05-07" },
      ],
      pesquisa: [],
      noticias: [],
    };
    // Default windowDays=3, mas lancamento usa 7
    const { kept, removed } = filterDateWindow(input, "2026-05-15", 3);
    assert.equal(kept.lancamento.length, 1, "5 dias atrás passa (≤7d)");
    assert.equal(kept.lancamento[0].title, "5 dias atrás");
    assert.equal(removed.length, 1);
    assert.equal(removed[0].title, "8 dias atrás");
  });

  it("pesquisa mantém artigo até 5 dias atrás (vs default 3)", () => {
    const input = {
      lancamento: [],
      pesquisa: [
        { url: "https://a.com/1", title: "4 dias atrás", date: "2026-05-11" },
        { url: "https://a.com/2", title: "6 dias atrás", date: "2026-05-09" },
      ],
      noticias: [],
    };
    const { kept, removed } = filterDateWindow(input, "2026-05-15", 3);
    assert.equal(kept.pesquisa.length, 1, "4 dias atrás passa (≤5d)");
    assert.equal(kept.pesquisa[0].title, "4 dias atrás");
    assert.equal(removed[0].title, "6 dias atrás");
  });

  it("noticias mantém comportamento default — 5 dias atrás removido", () => {
    const input = {
      lancamento: [],
      pesquisa: [],
      noticias: [
        { url: "https://a.com/1", title: "1 dia atrás", date: "2026-05-14" },
        { url: "https://a.com/2", title: "5 dias atrás", date: "2026-05-10" },
      ],
    };
    const { kept, removed } = filterDateWindow(input, "2026-05-15", 3);
    assert.equal(kept.noticias.length, 1, "1 dia atrás passa (≤3d)");
    assert.equal(kept.noticias[0].title, "1 dia atrás");
    assert.equal(removed[0].title, "5 dias atrás");
  });

  it("removed.detail menciona bucket-window pra debug", () => {
    const input = {
      lancamento: [{ url: "https://a.com/1", title: "Antigo", date: "2026-04-30" }],
      pesquisa: [],
      noticias: [],
    };
    const { removed } = filterDateWindow(input, "2026-05-15", 3);
    assert.ok(removed[0].detail.includes("bucket-window=7d"));
  });
});
