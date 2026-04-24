import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { filterDateWindow } from "../scripts/filter-date-window.ts";

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

  it("cutoff = edition_date - window_days", () => {
    const input = {
      lancamento: [
        { url: "https://a.com/1", title: "Dia do corte", date: "2026-04-21" },
        { url: "https://a.com/2", title: "Dia antes do corte", date: "2026-04-20" },
      ],
      pesquisa: [],
      noticias: [],
    };
    const { kept, removed, cutoff } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(cutoff, "2026-04-21");
    assert.equal(kept.lancamento.length, 1);
    assert.equal(kept.lancamento[0].title, "Dia do corte");
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
    const input = {
      lancamento: [{ url: "https://a.com/1", title: "Antigo", date: "2026-04-10" }],
      pesquisa: [],
      noticias: [],
    };
    const { removed } = filterDateWindow(input, "2026-04-24", 3);
    assert.equal(removed.length, 1);
    assert.equal(removed[0].reason, "date_window");
    assert.ok(removed[0].detail.includes("2026-04-10"));
    assert.ok(removed[0].detail.includes("2026-04-21"));
  });

  it("window=1 permite só ontem e hoje", () => {
    const input = {
      lancamento: [
        { url: "https://a.com/1", title: "Hoje", date: "2026-04-24" },
        { url: "https://a.com/2", title: "Ontem", date: "2026-04-23" },
        { url: "https://a.com/3", title: "Anteontem", date: "2026-04-22" },
      ],
      pesquisa: [],
      noticias: [],
    };
    const { kept } = filterDateWindow(input, "2026-04-24", 1);
    assert.equal(kept.lancamento.length, 2);
    assert.deepEqual(
      kept.lancamento.map((a) => a.title),
      ["Hoje", "Ontem"],
    );
  });
});
