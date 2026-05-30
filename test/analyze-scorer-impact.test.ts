import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordToCtrRow,
  loadCtrRows,
  dateToEdition,
  inWindow,
  computeWindowMetrics,
  renderReport,
  type CtrRow,
} from "../scripts/analyze-scorer-impact.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

describe("recordToCtrRow", () => {
  it("mapeia record limpo", () => {
    const r = recordToCtrRow({
      date: "2026-05-20", base_url: "https://x.com/a", unique_opens: "100",
      unique_verified_clicks: "4", ctr_pct: "4.00", category: "Aplicação", origin: "BR",
    })!;
    assert.equal(r.date, "2026-05-20");
    assert.equal(r.base_url, "https://x.com/a");
    assert.equal(r.unique_opens, 100);
    assert.equal(r.unique_verified_clicks, 4);
    assert.equal(r.category, "Aplicação");
    assert.equal(r.origin, "BR");
  });

  it("rejeita record sem date válida", () => {
    assert.equal(recordToCtrRow({ date: "lixo" }), null);
    assert.equal(recordToCtrRow({}), null);
  });

  it("campos numéricos ausentes/inválidos viram 0", () => {
    const r = recordToCtrRow({ date: "2026-05-20", unique_opens: "abc" })!;
    assert.equal(r.unique_opens, 0);
  });
});

describe("loadCtrRows (papaparse — vírgulas em campos quotados)", () => {
  it("parseia CSV com vírgula em title E em base_url sem corromper colunas", () => {
    const dir = mkdtempSync(join(tmpdir(), "ctr-"));
    try {
      const csv = [
        "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin",
        '2026-05-20,"Título, com vírgula",Seção,Aprofunde,"https://y.com/a,b",y.com,200,10,8,4.00,Segurança,INT',
        "2026-05-21,Limpo,Sec,Aprofunde,https://z.com/c,z.com,100,3,3,3.00,Aplicação,BR",
      ].join("\n");
      const p = join(dir, "ctr.csv");
      writeFileSync(p, csv);
      const rows = loadCtrRows(p.replace(/\\/g, "/"));
      assert.equal(rows.length, 2);
      // base_url com vírgula preservado inteiro; category/origin corretos
      assert.equal(rows[0].base_url, "https://y.com/a,b");
      assert.equal(rows[0].category, "Segurança");
      assert.equal(rows[0].origin, "INT");
      assert.equal(rows[0].unique_verified_clicks, 8);
      assert.equal(rows[1].base_url, "https://z.com/c");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("dateToEdition", () => {
  it("YYYY-MM-DD → AAMMDD", () => {
    assert.equal(dateToEdition("2026-05-20"), "260520");
    assert.equal(dateToEdition("2026-06-12"), "260612");
  });
  it("data inválida → string vazia", () => {
    assert.equal(dateToEdition("xx"), "");
  });
});

describe("inWindow", () => {
  it("inclusivo nas bordas", () => {
    assert.equal(inWindow("2026-05-20", "2026-05-20", "2026-05-28"), true);
    assert.equal(inWindow("2026-05-28", "2026-05-20", "2026-05-28"), true);
    assert.equal(inWindow("2026-05-29", "2026-05-20", "2026-05-28"), false);
    assert.equal(inWindow("2026-05-19", "2026-05-20", "2026-05-28"), false);
  });
});

describe("computeWindowMetrics", () => {
  const D1 = "https://d1.com/a", D2 = "https://d2.com/b", SEC = "https://sec.com/c";
  const rows: CtrRow[] = [
    // edição 260520: 2 destaques (D1 Aplicação BR, D2 Segurança INT) + 1 secundária
    { date: "2026-05-20", base_url: D1, unique_opens: 100, unique_verified_clicks: 6, ctr_pct: 6, category: "Aplicação", origin: "BR" },
    { date: "2026-05-20", base_url: D2, unique_opens: 100, unique_verified_clicks: 4, ctr_pct: 4, category: "Segurança", origin: "INT" },
    { date: "2026-05-20", base_url: SEC, unique_opens: 100, unique_verified_clicks: 2, ctr_pct: 2, category: "Mercado", origin: "INT" },
    // fora da janela
    { date: "2026-06-01", base_url: D1, unique_opens: 100, unique_verified_clicks: 9, ctr_pct: 9, category: "Aplicação", origin: "BR" },
  ];
  const highlights = new Map<string, Set<string>>([
    ["260520", new Set([canonicalize(D1), canonicalize(D2)])],
  ]);

  const m = computeWindowMetrics(rows, "2026-05-20", "2026-05-28", highlights);

  it("identifica destaques via join de URL", () => {
    assert.equal(m.destaque_rows, 2);
  });

  it("H2 — CTR médio destaques vs secundárias", () => {
    assert.equal(m.destaque_ctr_mean, 5); // (6+4)/2
    assert.equal(m.secondary_ctr_mean, 2); // só SEC
  });

  it("H1 — edições com >=1 destaque por categoria-alvo", () => {
    assert.equal(m.h1_editions_with_category["Aplicação"], 1);
    assert.equal(m.h1_editions_with_category["Segurança"], 1);
  });

  it("H3 — distribuição BR/INT dos destaques", () => {
    assert.equal(m.destaque_origin["BR"], 1);
    assert.equal(m.destaque_origin["INT"], 1);
    assert.equal(m.destaque_br_pct, 50);
  });

  it("ignora linhas fora da janela", () => {
    assert.equal(m.editions_with_destaques, 1); // só 260520
  });

  it("janela sem destaques maduros → zeros, sem crash", () => {
    const empty = computeWindowMetrics(rows, "2026-07-01", "2026-07-10", highlights);
    assert.equal(empty.editions_found, 0);
    assert.equal(empty.destaque_rows, 0);
    assert.equal(empty.destaque_ctr_mean, null);
  });
});

describe("renderReport", () => {
  it("marca aviso quando treatment vazio", () => {
    const base = computeWindowMetrics([], "2026-05-20", "2026-05-28", new Map());
    const treat = computeWindowMetrics([], "2026-05-30", "2026-06-12", new Map());
    const md = renderReport(base, treat);
    assert.ok(md.includes("Treatment sem edições"));
    assert.ok(md.includes("H1"));
    assert.ok(md.includes("H2"));
    assert.ok(md.includes("H3"));
  });
});
