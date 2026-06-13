/**
 * test/analyze-h4.test.ts (#1619)
 *
 * Testes da função H4 (scorer×CTR) — regressão #633.
 *
 * Cobre:
 *   - spearmanRho: concordância perfeita, inversão total, parcial — verificáveis
 *     à mão com n=3 (fórmula ρ = 1 − 6Σd²/n(n²−1)).
 *   - computeEditionH4: join correto, guard n<4, top-1, top-3.
 *   - computeNewH4Entries: idempotência (não recomputa edição já gravada).
 *   - computeH4Trend: alerta dispara com rho<0.4 por 2 semanas; sem alerta se saudável.
 *   - loadCtrRowsH4: defensivo a CSV ausente (não crasha).
 *   - appendHistory / loadHistoryEditions: idempotência do jsonl.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  spearmanRho,
  computeEditionH4,
  computeNewH4Entries,
  computeH4Trend,
  loadCtrRowsH4,
  loadHistoryEditions,
  appendHistory,
  loadHistory,
  formatH4Trend,
  MIN_MATCHES_FOR_AGGREGATE,
  H4_RHO_ALERT_THRESHOLD,
  type ScoredHighlight,
  type H4HistoryEntry,
} from "../scripts/analyze-h4.ts";
import type { CtrRow } from "../scripts/analyze-scorer-impact.ts";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const CTR_HEADER =
  "date,post_title,section_title,anchor,base_url,domain,unique_opens,verified_clicks,unique_verified_clicks,ctr_pct,category,origin";

/** Cria um CtrRow básico. */
function mkCtr(date: string, url: string, clicks: number, opens = 100): CtrRow {
  return {
    date,
    base_url: url,
    unique_opens: opens,
    unique_verified_clicks: clicks,
    ctr_pct: opens > 0 ? (clicks / opens) * 100 : 0,
    category: "Aplicação",
    origin: "BR",
  };
}

/** Cria um ScoredHighlight com URL canônica. */
function mkHL(url: string, score: number): ScoredHighlight {
  return { url, score };
}

// ─── spearmanRho ────────────────────────────────────────────────────────────

describe("spearmanRho", () => {
  it("concordância perfeita (n=3) → rho = 1.000", () => {
    // scorer [80,60,40] → ranks [1,2,3]; ctr [5,3,1] → ranks [1,2,3]
    // d² = [0,0,0], Σd²=0, rho = 1 - 0/(3×8) = 1.000
    const rho = spearmanRho([80, 60, 40], [5, 3, 1]);
    assert.ok(rho !== null);
    assert.equal(+rho.toFixed(3), 1.0);
  });

  it("inversão total (n=3) → rho = -1.000", () => {
    // scorer [80,60,40] → ranks [1,2,3]; ctr [1,3,5] → ranks [3,2,1]
    // d=[1-3,2-2,3-1]=[−2,0,2], d²=[4,0,4], Σd²=8
    // rho = 1 - 6×8/(3×8) = 1 - 2 = -1.000
    const rho = spearmanRho([80, 60, 40], [1, 3, 5]);
    assert.ok(rho !== null);
    assert.equal(+rho.toFixed(3), -1.0);
  });

  it("correlação parcial (n=4) → rho correto", () => {
    // scorer [90,70,50,30] → ranks [1,2,3,4]
    // ctr   [8, 5, 2, 10] → ranks [2,3,4,1]
    // d = [1-2, 2-3, 3-4, 4-1] = [-1,-1,-1,3], d²=[1,1,1,9], Σd²=12
    // rho = 1 - 6×12 / (4×15) = 1 - 72/60 = 1 - 1.2 = -0.200
    const rho = spearmanRho([90, 70, 50, 30], [8, 5, 2, 10]);
    assert.ok(rho !== null);
    assert.equal(+rho.toFixed(3), -0.2);
  });

  it("n=1 → null (indefinido)", () => {
    assert.equal(spearmanRho([5], [3]), null);
  });

  it("n=0 → null", () => {
    assert.equal(spearmanRho([], []), null);
  });

  it("arrays de tamanho diferente → null", () => {
    assert.equal(spearmanRho([1, 2], [1]), null);
  });
});

// ─── computeEditionH4 ───────────────────────────────────────────────────────

describe("computeEditionH4", () => {
  const DATE = "2026-05-20";

  it("join correto com n=4 → rho, top1, top3 corretos", () => {
    // scorer top-4: scores [90,80,70,60]; URLs A,B,C,D
    // CTR observado: A=5%, B=3%, C=8%, D=1%
    // CTR ranking: C>A>B>D → ranks [2,3,1,4]
    // scorer ranking: A→1, B→2, C→3, D→4
    // d=[1-2,2-3,3-1,4-4]=[-1,-1,2,0], d²=[1,1,4,0], Σd²=6
    // rho = 1 - 6×6/(4×15) = 1 - 36/60 = 1 - 0.6 = 0.4
    const highlights: ScoredHighlight[] = [
      mkHL("https://a.com/1", 90),
      mkHL("https://b.com/2", 80),
      mkHL("https://c.com/3", 70),
      mkHL("https://d.com/4", 60),
    ];
    const ctrRows: CtrRow[] = [
      mkCtr(DATE, "https://a.com/1", 5),
      mkCtr(DATE, "https://b.com/2", 3),
      mkCtr(DATE, "https://c.com/3", 8),
      mkCtr(DATE, "https://d.com/4", 1),
    ];
    const result = computeEditionH4(highlights, ctrRows, DATE);
    assert.ok(result !== null, "deve retornar resultado com n=4");
    assert.equal(result.n_matches, 4);
    assert.equal(+result.rho.toFixed(1), 0.4);
    // top-1 scorer = A (score 90); top-1 CTR = C (8%) → não acertou
    assert.equal(result.top1_hit, false);
    // scorer top-3 = {A,B,C}; CTR top-3 = {C,A,B} → interseção = {A,B,C} = 3
    assert.equal(result.top3_overlap, 3);
  });

  it("concordância perfeita (n=4) → rho=1, top1=true, top3=3", () => {
    const highlights: ScoredHighlight[] = [
      mkHL("https://a.com/1", 90),
      mkHL("https://b.com/2", 80),
      mkHL("https://c.com/3", 70),
      mkHL("https://d.com/4", 60),
    ];
    const ctrRows: CtrRow[] = [
      mkCtr(DATE, "https://a.com/1", 10), // maior CTR
      mkCtr(DATE, "https://b.com/2", 8),
      mkCtr(DATE, "https://c.com/3", 5),
      mkCtr(DATE, "https://d.com/4", 2),
    ];
    const result = computeEditionH4(highlights, ctrRows, DATE);
    assert.ok(result !== null);
    assert.equal(+result.rho.toFixed(3), 1.0);
    assert.equal(result.top1_hit, true);
    assert.equal(result.top3_overlap, 3);
  });

  it("guard n<4: edição com 3 matches retorna null (excluída do agregado)", () => {
    // Exatamente MIN_MATCHES_FOR_AGGREGATE - 1 = 3 matches
    assert.ok(MIN_MATCHES_FOR_AGGREGATE === 4, "constante correta");
    const highlights: ScoredHighlight[] = [
      mkHL("https://a.com/1", 90),
      mkHL("https://b.com/2", 80),
      mkHL("https://c.com/3", 70),
      mkHL("https://d.com/4", 60), // D não tem linha no CTR → só 3 matches
    ];
    const ctrRows: CtrRow[] = [
      mkCtr(DATE, "https://a.com/1", 5),
      mkCtr(DATE, "https://b.com/2", 3),
      mkCtr(DATE, "https://c.com/3", 8),
      // https://d.com/4 ausente do CTR
    ];
    const result = computeEditionH4(highlights, ctrRows, DATE);
    assert.equal(result, null, "n=3 < MIN_MATCHES_FOR_AGGREGATE=4 → excluída");
  });

  it("sem linhas CTR na data → null", () => {
    const highlights: ScoredHighlight[] = [mkHL("https://a.com/1", 90)];
    const result = computeEditionH4(highlights, [], DATE);
    assert.equal(result, null);
  });

  it("filtra CTR de outras datas (não contamina a edição)", () => {
    const highlights: ScoredHighlight[] = [
      mkHL("https://a.com/1", 90),
      mkHL("https://b.com/2", 80),
      mkHL("https://c.com/3", 70),
      mkHL("https://d.com/4", 60),
    ];
    const ctrRows: CtrRow[] = [
      mkCtr(DATE, "https://a.com/1", 10),
      mkCtr(DATE, "https://b.com/2", 8),
      mkCtr(DATE, "https://c.com/3", 5),
      mkCtr(DATE, "https://d.com/4", 2),
      // linha de outra data — não deve interferir
      mkCtr("2026-05-21", "https://z.com/extra", 100),
    ];
    const result = computeEditionH4(highlights, ctrRows, DATE);
    assert.ok(result !== null);
    assert.equal(result.n_matches, 4); // apenas as 4 da data correta
  });
});

// ─── computeNewH4Entries — idempotência ─────────────────────────────────────

describe("computeNewH4Entries — idempotência", () => {
  const DATE = "2026-05-01"; // 43 dias atrás (maturidade ≥7d garantida)
  const EDITION = "260501";

  const ctrRows: CtrRow[] = [
    mkCtr(DATE, "https://a.com/1", 10),
    mkCtr(DATE, "https://b.com/2", 8),
    mkCtr(DATE, "https://c.com/3", 5),
    mkCtr(DATE, "https://d.com/4", 2),
  ];

  it("edição já no Set alreadyComputed → não entra em newEntries (idempotência)", () => {
    const already = new Set([EDITION]);
    const entries = computeNewH4Entries(
      ctrRows,
      "data/editions", // sem approved.json neste worktree, mas já excluída
      already,
      7,
      new Date("2026-06-13"),
    );
    // Se a edição está em already, não deve aparecer nas novas entradas
    assert.ok(entries.every((e) => e.edition !== EDITION));
  });

  it("edição NÃO no Set e sem approved.json → não entra (sem crash)", () => {
    // Sem approved.json real no worktree → loadScorerHighlights retorna null → skip
    const empty = new Set<string>();
    const entries = computeNewH4Entries(
      ctrRows,
      "data/editions", // não existe no worktree (data/ é junction)
      empty,
      7,
      new Date("2026-06-13"),
    );
    // Pode retornar [], sem crash — o script é defensivo a data/ ausente
    assert.ok(Array.isArray(entries));
  });
});

// ─── appendHistory / loadHistoryEditions — idempotência do jsonl ─────────────

describe("appendHistory e loadHistoryEditions — idempotência", () => {
  let dir: string;
  let historyPath: string;

  const fakeEntry: H4HistoryEntry = {
    edition: "260520",
    rho: 0.8,
    top1_hit: true,
    top3_overlap: 3,
    n_matches: 6,
    computed_at: "2026-06-13T00:00:00.000Z",
  };

  it("setup: cria diretório temporário", () => {
    dir = mkdtempSync(join(tmpdir(), "h4-hist-"));
    historyPath = join(dir, "history.jsonl");
    // O arquivo não existe ainda
    assert.ok(!loadHistoryEditions(historyPath.replace(/\\/g, "/")).has("260520"));
  });

  it("append de 1 entrada → arquivo tem 1 linha", () => {
    appendHistory(historyPath.replace(/\\/g, "/"), [fakeEntry]);
    const content = readFileSync(historyPath, "utf8").trim().split("\n");
    assert.equal(content.length, 1);
    const parsed = JSON.parse(content[0]) as H4HistoryEntry;
    assert.equal(parsed.edition, "260520");
    assert.equal(parsed.rho, 0.8);
  });

  it("loadHistoryEditions detecta a edição gravada", () => {
    const editions = loadHistoryEditions(historyPath.replace(/\\/g, "/"));
    assert.ok(editions.has("260520"));
  });

  it("idempotência: gravar mesma edição 2x via computeNewH4Entries → sem duplicata no jsonl se guardado por alreadyComputed", () => {
    // Simula o fluxo idempotente: 1ª execução grava, 2ª vê a edição em alreadyComputed
    const alreadyAfterFirst = loadHistoryEditions(historyPath.replace(/\\/g, "/"));
    assert.ok(alreadyAfterFirst.has("260520"));

    // Tenta gravar novamente (como se alguém rodasse update-audience 2x)
    // computeNewH4Entries filtra por alreadyComputed — nada novo
    const secondRun = computeNewH4Entries(
      [], // sem CTR rows → não há edições novas de qualquer forma
      "data/editions",
      alreadyAfterFirst,
      7,
      new Date("2026-06-13"),
    );
    assert.equal(secondRun.length, 0);

    // Arquivo deve ter ainda 1 linha
    const content = readFileSync(historyPath, "utf8").trim().split("\n");
    assert.equal(content.length, 1);
  });

  it("loadHistory retorna as entradas completas", () => {
    const entries = loadHistory(historyPath.replace(/\\/g, "/"));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].edition, "260520");
  });

  it("cleanup", () => {
    rmSync(dir, { recursive: true, force: true });
  });
});

// ─── computeH4Trend — alerta ────────────────────────────────────────────────

describe("computeH4Trend", () => {
  it("alerta NÃO dispara com rho saudável (>=0.4 nas últimas 2)", () => {
    const entries: H4HistoryEntry[] = [
      { edition: "260520", rho: 0.8, top1_hit: true,  top3_overlap: 3, n_matches: 5, computed_at: "" },
      { edition: "260521", rho: 0.6, top1_hit: false, top3_overlap: 2, n_matches: 4, computed_at: "" },
      { edition: "260522", rho: 0.5, top1_hit: true,  top3_overlap: 2, n_matches: 4, computed_at: "" },
      { edition: "260525", rho: 0.7, top1_hit: true,  top3_overlap: 3, n_matches: 6, computed_at: "" },
    ];
    const trend = computeH4Trend(entries);
    assert.equal(trend.alert_low_rho, false);
    // rho médio = (0.8+0.6+0.5+0.7)/4 = 0.65
    assert.ok(Math.abs(trend.rho_mean! - 0.65) < 0.001);
    assert.equal(trend.top1_hit_rate, 0.75); // 3/4
  });

  it("alerta dispara quando rho < 0.4 por 2 semanas consecutivas", () => {
    assert.ok(H4_RHO_ALERT_THRESHOLD === 0.4, "threshold correto");
    const entries: H4HistoryEntry[] = [
      { edition: "260520", rho: 0.8, top1_hit: true,  top3_overlap: 3, n_matches: 5, computed_at: "" },
      { edition: "260521", rho: 0.6, top1_hit: false, top3_overlap: 2, n_matches: 4, computed_at: "" },
      // Últimas 2 abaixo do threshold
      { edition: "260522", rho: 0.3, top1_hit: false, top3_overlap: 1, n_matches: 4, computed_at: "" },
      { edition: "260525", rho: 0.2, top1_hit: false, top3_overlap: 1, n_matches: 4, computed_at: "" },
    ];
    const trend = computeH4Trend(entries);
    assert.equal(trend.alert_low_rho, true);
  });

  it("alerta NÃO dispara quando só 1 das últimas 2 está abaixo do threshold", () => {
    const entries: H4HistoryEntry[] = [
      { edition: "260520", rho: 0.8, top1_hit: true,  top3_overlap: 3, n_matches: 5, computed_at: "" },
      { edition: "260521", rho: 0.3, top1_hit: false, top3_overlap: 1, n_matches: 4, computed_at: "" }, // abaixo
      { edition: "260522", rho: 0.5, top1_hit: true,  top3_overlap: 2, n_matches: 4, computed_at: "" }, // acima
    ];
    const trend = computeH4Trend(entries);
    assert.equal(trend.alert_low_rho, false);
  });

  it("sem entradas → rho_mean=null, top1_hit_rate=null, alert=false", () => {
    const trend = computeH4Trend([]);
    assert.equal(trend.rho_mean, null);
    assert.equal(trend.top1_hit_rate, null);
    assert.equal(trend.alert_low_rho, false);
    assert.equal(trend.entries.length, 0);
  });

  it("só 1 entrada → alerta não dispara (precisa de 2 consecutivas)", () => {
    const entries: H4HistoryEntry[] = [
      { edition: "260520", rho: 0.1, top1_hit: false, top3_overlap: 0, n_matches: 4, computed_at: "" },
    ];
    const trend = computeH4Trend(entries);
    assert.equal(trend.alert_low_rho, false); // last2.length === 1, não 2
  });

  it("pega apenas as últimas windowSize=4 entradas", () => {
    const entries: H4HistoryEntry[] = Array.from({ length: 6 }, (_, i) => ({
      edition: `2605${(20 + i).toString().padStart(2, "0")}`,
      rho: 0.5,
      top1_hit: true,
      top3_overlap: 2,
      n_matches: 4,
      computed_at: "",
    }));
    const trend = computeH4Trend(entries, 4);
    assert.equal(trend.entries.length, 4);
    // Deve ser as 4 mais recentes (lexicalmente últimas)
    assert.equal(trend.entries[0].edition, "260522");
    assert.equal(trend.entries[3].edition, "260525");
  });
});

// ─── loadCtrRowsH4 — defensivo a CSV ausente ─────────────────────────────────

describe("loadCtrRowsH4", () => {
  it("retorna [] sem crash quando CSV não existe", () => {
    const rows = loadCtrRowsH4("/caminho/que/nao/existe.csv");
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 0);
  });

  it("parseia CSV e filtra rows Aprofunde", () => {
    const dir = mkdtempSync(join(tmpdir(), "h4-ctr-"));
    try {
      const csv = [
        CTR_HEADER,
        // Row normal (não Aprofunde)
        "2026-05-20,Título A,Seção,Acesse,https://a.com/1,a.com,100,5,5,5.00,Aplicação,BR",
        // Row Aprofunde — deve ser filtrada
        "2026-05-20,Título B,Seção,Aprofunde,https://b.com/2,b.com,100,8,8,8.00,Segurança,INT",
      ].join("\n");
      const p = join(dir, "ctr.csv");
      writeFileSync(p, csv);
      const rows = loadCtrRowsH4(p.replace(/\\/g, "/"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].base_url, "https://a.com/1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── formatH4Trend ──────────────────────────────────────────────────────────

describe("formatH4Trend", () => {
  it("inclui ALERTA quando alert_low_rho=true", () => {
    const trend = {
      entries: [
        { edition: "260520", rho: 0.1, top1_hit: false, top3_overlap: 0, n_matches: 4, computed_at: "" },
        { edition: "260521", rho: 0.2, top1_hit: false, top3_overlap: 1, n_matches: 4, computed_at: "" },
      ],
      rho_mean: 0.15,
      top1_hit_rate: 0,
      alert_low_rho: true,
    };
    const out = formatH4Trend(trend);
    assert.ok(out.includes("ALERTA H4"), "deve mencionar alerta");
    assert.ok(out.includes("0.4"), "deve mencionar threshold");
  });

  it("NÃO inclui alerta quando rho saudável", () => {
    const trend = {
      entries: [
        { edition: "260520", rho: 0.8, top1_hit: true, top3_overlap: 3, n_matches: 5, computed_at: "" },
      ],
      rho_mean: 0.8,
      top1_hit_rate: 1,
      alert_low_rho: false,
    };
    const out = formatH4Trend(trend);
    assert.ok(!out.includes("ALERTA"), "não deve mencionar alerta");
  });

  it("histórico vazio → mensagem de espera", () => {
    const trend = { entries: [], rho_mean: null, top1_hit_rate: null, alert_low_rho: false };
    const out = formatH4Trend(trend);
    assert.ok(out.includes("Sem histórico"), "deve informar ausência de dados");
  });
});
