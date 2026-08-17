/**
 * test/google-ads-csv-import.test.ts (#5503)
 *
 * Cobre `scripts/lib/google-ads-csv.ts` (parser puro dos exports manuais do
 * painel Google Ads) e `scripts/google-ads-import-csv.ts` (CLI fino,
 * exercitado com `readFile` injetado — NUNCA lê `data/aquisicao/google-ads/`
 * real: `data/` é gitignored e ausente em clone fresco, #5227/#5503).
 *
 * Fixture sintética cobrindo os casos de incompatibilidade da issue:
 * preâmbulo de 2 linhas, decimal com vírgula, milhar com ponto, linha
 * `Total:`, célula ` --`, header ausente.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  parsePtBrNumber,
  findHeaderRowIndex,
  parsePanelCsv,
  parseGoogleAdsCampanhasCsv,
  classifyCampanhaSubcanal,
  buildSpendRowsFromCampanhas,
  parseGoogleAdsKeywordsCsv,
  zeroImpressionKeywords,
  parseGoogleAdsTermosCsv,
  termsWithCost,
} from "../scripts/lib/google-ads-csv.ts";
import { runImport, runReport } from "../scripts/google-ads-import-csv.ts";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// parsePtBrNumber
// ---------------------------------------------------------------------------

describe("#5503 — parsePtBrNumber", () => {
  it("vírgula decimal: '239,62' -> 239.62", () => {
    assert.equal(parsePtBrNumber("239,62"), 239.62);
  });

  it("ponto de milhar sem decimal: '7.936' -> 7936", () => {
    assert.equal(parsePtBrNumber("7.936"), 7936);
  });

  it("milhar + decimal juntos: '1.234,56' -> 1234.56", () => {
    assert.equal(parsePtBrNumber("1.234,56"), 1234.56);
  });

  it("célula ' --' -> null, NUNCA 0", () => {
    assert.equal(parsePtBrNumber(" --"), null);
    assert.equal(parsePtBrNumber("--"), null);
  });

  it("string vazia -> null", () => {
    assert.equal(parsePtBrNumber(""), null);
    assert.equal(parsePtBrNumber("   "), null);
  });

  it("número simples sem separador: '42' -> 42", () => {
    assert.equal(parsePtBrNumber("42"), 42);
  });

  it("símbolo de moeda residual removido: 'R$ 14,00' -> 14", () => {
    assert.equal(parsePtBrNumber("R$ 14,00"), 14);
  });
});

// ---------------------------------------------------------------------------
// findHeaderRowIndex / parsePanelCsv (preâmbulo + Total: + --)
// ---------------------------------------------------------------------------

const CAMPANHAS_FIXTURE = [
  "Relatório de campanha",
  "Todo o período",
  "Status da campanha,Campanha,Orçamento,Nome do orçamento,Tipo de orçamento,Código da moeda,Status,Motivos do status,Custo / conv.,Conversões,Tipo de campanha,Custo",
  'Pausada,Pesquisa 260113,"14,00", --,Diário,BRL,Pausado,campanha pausada,"21,78","11,00",Pesquisa,"239,62"',
  'Ativada,Max,"30,00", --,Diário,BRL,Ativado, --,"12,83","56,00",Performance Max,"718,39"',
  "Total: Campanhas,,,,,,,,,,,\"958,01\"",
].join("\n");

describe("#5503 — findHeaderRowIndex / parsePanelCsv", () => {
  it("acha o header por PRESENÇA de coluna, ignorando 2 linhas de preâmbulo livre", () => {
    const rows = [
      ["Relatório de campanha"],
      ["Todo o período"],
      ["Status da campanha", "Campanha", "Custo"],
      ["Pausada", "Pesquisa 260113", "239,62"],
    ];
    assert.equal(findHeaderRowIndex(rows, [/^Campanha$/, /^Custo$/]), 2);
  });

  it("header ausente (nenhuma linha bate) -> lança, nunca degrada silencioso", () => {
    assert.throws(() => parsePanelCsv("a,b,c\n1,2,3", [/^Campanha$/, /^Custo$/]), /header não encontrado/);
  });

  it("linha 'Total:' é descartada (não somaria em dobro)", () => {
    const { rows } = parsePanelCsv(CAMPANHAS_FIXTURE, [/^Campanha$/, /^Custo$/]);
    assert.equal(rows.length, 2); // só as 2 campanhas, não a linha Total
    assert.ok(!rows.some((r) => r.Campanha?.startsWith("Total")));
  });

  it("célula ' --' preservada crua no record (normalização é responsabilidade de quem lê a coluna)", () => {
    const { rows } = parsePanelCsv(CAMPANHAS_FIXTURE, [/^Campanha$/, /^Custo$/]);
    assert.equal(rows[0]["Nome do orçamento"], "--");
  });
});

// ---------------------------------------------------------------------------
// parseGoogleAdsCampanhasCsv + classifyCampanhaSubcanal + buildSpendRowsFromCampanhas
// ---------------------------------------------------------------------------

describe("#5503 — parseGoogleAdsCampanhasCsv", () => {
  it("extrai campanha + custo (decimal com vírgula convertido)", () => {
    const { rows } = parseGoogleAdsCampanhasCsv(CAMPANHAS_FIXTURE);
    assert.equal(rows.length, 2);
    const pesquisa = rows.find((r) => r.campanha === "Pesquisa 260113")!;
    assert.equal(pesquisa.custo, 239.62);
    const max = rows.find((r) => r.campanha === "Max")!;
    assert.equal(max.custo, 718.39);
  });

  it("linha Total: nunca aparece nas rows extraídas (regressão: somaria em dobro)", () => {
    const { rows } = parseGoogleAdsCampanhasCsv(CAMPANHAS_FIXTURE);
    const total = 239.62 + 718.39;
    const sum = rows.reduce((s, r) => s + (r.custo ?? 0), 0);
    assert.ok(Math.abs(sum - total) < 1e-9); // 958.01, não 1916.02 (dobro)
  });

  it("célula ' --' na coluna Custo vira custo: null, nunca 0", () => {
    const fixture = [
      "Relatório de campanha",
      "Todo o período",
      "Campanha,Custo",
      "Campanha sem gasto, --",
    ].join("\n");
    const { rows } = parseGoogleAdsCampanhasCsv(fixture);
    assert.equal(rows[0].custo, null);
  });
});

describe("#5503 — classifyCampanhaSubcanal", () => {
  it("'Pesquisa 260113' -> Search", () => {
    assert.equal(classifyCampanhaSubcanal("Pesquisa 260113"), "Search");
  });
  it("'Max' -> PMax", () => {
    assert.equal(classifyCampanhaSubcanal("Max"), "PMax");
  });
  it("'Performance Max — Brasil' -> PMax", () => {
    assert.equal(classifyCampanhaSubcanal("Performance Max — Brasil"), "PMax");
  });
  it("campanha não reconhecida -> Outros (nunca adivinha um dos dois conhecidos)", () => {
    assert.equal(classifyCampanhaSubcanal("Campanha de Display XPTO"), "Outros");
  });
});

describe("#5503 — buildSpendRowsFromCampanhas", () => {
  it("agrupa por sub-canal e soma custo, produzindo 1 SpendRow por sub-canal presente", () => {
    const { rows } = parseGoogleAdsCampanhasCsv(CAMPANHAS_FIXTURE);
    const spendRows = buildSpendRowsFromCampanhas(rows, { canal: "Google Ads", mes: "2026-02", moeda: "BRL", fonteLabel: "teste" });
    assert.equal(spendRows.length, 2);
    const pmax = spendRows.find((r) => r.subcanal === "PMax")!;
    const search = spendRows.find((r) => r.subcanal === "Search")!;
    assert.equal(pmax.valor, 718.39);
    assert.equal(search.valor, 239.62);
    assert.ok(spendRows.every((r) => r.canal === "Google Ads" && r.mes === "2026-02"));
  });

  it("custo null (célula ' --') nunca entra na soma do sub-canal", () => {
    const spendRows = buildSpendRowsFromCampanhas(
      [
        { campanha: "Pesquisa A", custo: 100 },
        { campanha: "Pesquisa B", custo: null },
      ],
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", fonteLabel: "teste" },
    );
    const search = spendRows.find((r) => r.subcanal === "Search")!;
    assert.equal(search.valor, 100); // não 100+0
  });
});

// ---------------------------------------------------------------------------
// keywords/termos (--report)
// ---------------------------------------------------------------------------

const KEYWORDS_FIXTURE = [
  "Relatório de palavras-chave",
  "Todo o período",
  "Palavra-chave,Impr.,Cliques,Custo",
  '"newsletter de IA em português","12", --, --',
  '"boletim diário de IA","0", --, --',
  '"resumo diário de inteligência artificial","0", --, --',
  "Total: Contas,,,,",
].join("\n");

describe("#5503 — parseGoogleAdsKeywordsCsv / zeroImpressionKeywords", () => {
  it("identifica keywords com 0 impressões explícito", () => {
    const { rows } = parseGoogleAdsKeywordsCsv(KEYWORDS_FIXTURE);
    assert.equal(rows.length, 3);
    const zero = zeroImpressionKeywords(rows);
    assert.equal(zero.length, 2);
    assert.ok(zero.some((r) => r.palavraChave === "boletim diário de IA"));
  });

  it("impressoes null (' --') NÃO conta como zero — dado ausente é diferente de zero medido", () => {
    const fixture = ["Relatório", "Todo o período", "Palavra-chave,Impr.", '"termo x", --'].join("\n");
    const { rows } = parseGoogleAdsKeywordsCsv(fixture);
    assert.equal(rows[0].impressoes, null);
    assert.equal(zeroImpressionKeywords(rows).length, 0);
  });
});

const TERMOS_FIXTURE = [
  "Relatório de termos de pesquisa",
  "Todo o período",
  "Termo de pesquisa,Impr.,Custo",
  '"newsletter ia",10,"5,50"',
  '"outro termo",3, --',
  '"termo caro",20,"200,00"',
  "Total: Contas,,",
].join("\n");

describe("#5503 — parseGoogleAdsTermosCsv / termsWithCost", () => {
  it("identifica termos com custo > 0, excluindo null e 0", () => {
    const { rows } = parseGoogleAdsTermosCsv(TERMOS_FIXTURE);
    assert.equal(rows.length, 3);
    const withCost = termsWithCost(rows);
    assert.equal(withCost.length, 2);
    assert.ok(withCost.some((r) => r.termoDePesquisa === "termo caro" && r.custo === 200));
  });
});

// ---------------------------------------------------------------------------
// CLI (runImport/runReport) — readFile injetado, NUNCA toca data/ real
// ---------------------------------------------------------------------------

describe("#5503 — runImport (CLI, dir temporário real — NUNCA data/aquisicao/google-ads real)", () => {
  it("lê campanhas-*.csv do dir e produz SpendRow[] com sub-canal", () => {
    const dir = mkdtempSync(join(tmpdir(), "google-ads-csv-import-5503-"));
    try {
      writeFileSync(join(dir, "campanhas-260816.csv"), CAMPANHAS_FIXTURE, "utf8");
      writeFileSync(join(dir, "anuncios-260816.csv"), "irrelevante — prefixo diferente, não deve ser lido", "utf8");

      const { spendRows, filesRead } = runImport({ dir, mes: "2026-02", readFile: (p) => readFileSync(p, "utf8") });

      assert.equal(filesRead.length, 1);
      assert.ok(filesRead[0].endsWith("campanhas-260816.csv"));
      assert.equal(spendRows.length, 2);
      assert.ok(spendRows.every((r) => r.canal === "Google Ads" && r.mes === "2026-02"));
      const pmax = spendRows.find((r) => r.subcanal === "PMax")!;
      assert.equal(pmax.valor, 718.39);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runReport lê palavras-chave-*.csv e termos-de-pesquisa-*.csv do dir temporário", () => {
    const dir = mkdtempSync(join(tmpdir(), "google-ads-csv-report-5503-"));
    try {
      writeFileSync(join(dir, "palavras-chave-260816.csv"), KEYWORDS_FIXTURE, "utf8");
      writeFileSync(join(dir, "termos-de-pesquisa-260816.csv"), TERMOS_FIXTURE, "utf8");

      const lines = runReport({ dir, readFile: (p) => readFileSync(p, "utf8") });
      const joined = lines.join("\n");
      assert.match(joined, /boletim diário de IA/);
      assert.match(joined, /termo caro/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#5503 — runReport/runImport contra diretório inexistente", () => {
  it("dir ausente -> runImport lança com o path checado (nunca 'nenhum CSV' silencioso)", () => {
    assert.throws(
      () =>
        runImport({
          dir: "/definitely/does/not/exist/5503",
          mes: "2026-02",
          readFile: () => {
            throw new Error("não deveria chamar readFile");
          },
        }),
      /nenhum arquivo "campanhas-\*\.csv" encontrado/,
    );
  });

  it("dir ausente -> runReport devolve aviso, não lança (readdirSync guard interno)", () => {
    const lines = runReport({ dir: "/definitely/does/not/exist/5503", readFile: () => "" });
    assert.ok(lines.some((l) => l.includes("nenhum")));
  });
});
