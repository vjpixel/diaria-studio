/**
 * test/aquisicao-spend.test.ts (#5236 Parte 1)
 *
 * Parser de `data/aquisicao/spend.csv` — tolerante mas barulhento (requisito
 * explícito da issue): header faltando lança; célula obrigatória vazia ou
 * `valor` inválido vira `errors[]`, nunca `null` silencioso.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SPEND_CSV_HEADERS,
  SPEND_SEED_ROWS,
  parseSpendCsv,
  readSpendCsv,
  formatSpendCsv,
} from "../scripts/lib/aquisicao-spend.ts";

describe("parseSpendCsv — caminho feliz", () => {
  it("parseia as 5 colunas obrigatórias", () => {
    const csv = "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,painel Ads\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 956.21, fonte: "painel Ads" });
  });

  it("aceita valor 0 (canal sem gasto ainda, ex: LinkedIn)", () => {
    const csv = "canal,mes,moeda,valor,fonte\nLinkedIn,2026-08,BRL,0,nenhum gasto ainda\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(rows[0].valor, 0);
  });

  it("aceita fonte com vírgula (campo quoted)", () => {
    const csv = 'canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,"painel Ads, apurado 29/jul"\n';
    const { rows, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(rows[0].fonte, "painel Ads, apurado 29/jul");
  });
});

describe("parseSpendCsv — barulhento em header faltando (LANÇA, nunca silencioso)", () => {
  it("lança com as colunas faltando nomeadas", () => {
    const csv = "canal,valor\nGoogle Ads,956.21\n";
    assert.throws(() => parseSpendCsv(csv), /mes, moeda, fonte/);
  });

  it("header vazio lança mencionando '(vazio)'", () => {
    assert.throws(() => parseSpendCsv(""), /\(vazio\)/);
  });
});

describe("parseSpendCsv — barulhento em célula faltando/valor inválido (nunca null silencioso)", () => {
  it("canal vazio vira error, linha excluída de rows", () => {
    const csv = "canal,mes,moeda,valor,fonte\n,2026-02,BRL,956.21,painel Ads\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].line, 2);
    assert.match(errors[0].reason, /canal/);
  });

  it("valor não-numérico vira error com dica de formato", () => {
    const csv = "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,R$ 956,21,painel Ads\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /ponto decimal/);
  });

  it("valor negativo vira error", () => {
    const csv = "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,-1,painel Ads\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.equal(rows.length, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].reason, /negativo/);
  });

  it("uma linha ruim não derruba as outras linhas válidas (tolerante)", () => {
    const csv = [
      "canal,mes,moeda,valor,fonte",
      "Google Ads,2026-02,BRL,956.21,painel Ads",
      ",2026-02,BRL,100,linha quebrada",
      "LinkedIn,2026-08,BRL,0,ainda sem gasto",
    ].join("\n");
    const { rows, errors } = parseSpendCsv(csv);
    assert.equal(rows.length, 2);
    assert.equal(errors.length, 1);
    assert.deepEqual(rows.map((r) => r.canal), ["Google Ads", "LinkedIn"]);
  });
});

describe("readSpendCsv — arquivo ausente", () => {
  it("lança com instrução de como criar o seed", () => {
    assert.throws(() => readSpendCsv("/caminho/que/nao/existe/spend.csv"), /seed-spend-csv/);
  });

  it("lê arquivo real do disco", () => {
    const dir = mkdtempSync(join(tmpdir(), "spend-csv-"));
    try {
      const path = join(dir, "spend.csv");
      writeFileSync(path, "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,painel Ads\n", "utf8");
      const { rows } = readSpendCsv(path);
      assert.equal(rows.length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SPEND_CSV_HEADERS / SPEND_SEED_ROWS", () => {
  it("SPEND_CSV_HEADERS é exatamente canal,mes,moeda,valor,fonte", () => {
    assert.deepEqual(SPEND_CSV_HEADERS, ["canal", "mes", "moeda", "valor", "fonte"]);
  });

  it("SPEND_SEED_ROWS tem as 3 linhas do histórico (Google Ads, Beehiiv Boosts, LinkedIn)", () => {
    assert.equal(SPEND_SEED_ROWS.length, 3);
    const byCanal = Object.fromEntries(SPEND_SEED_ROWS.map((r) => [r.canal, r]));
    assert.equal(byCanal["Google Ads"].valor, 956.21);
    assert.equal(byCanal["Beehiiv Boosts"].valor, 397.08);
    assert.equal(byCanal["LinkedIn"].valor, 0);
    for (const row of SPEND_SEED_ROWS) {
      assert.equal(row.moeda, "BRL");
      assert.ok(row.mes.length > 0, `mes vazio pra ${row.canal}`);
      assert.ok(row.fonte.length > 0, `fonte vazia pra ${row.canal}`);
    }
  });
});

describe("formatSpendCsv / round-trip com parseSpendCsv", () => {
  it("formata e re-parseia SPEND_SEED_ROWS sem perda", () => {
    const csv = formatSpendCsv(SPEND_SEED_ROWS);
    const { rows, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.deepEqual(rows, SPEND_SEED_ROWS);
  });

  it("escapa fonte com vírgula corretamente (round-trip)", () => {
    const rows = [{ canal: "X", mes: "2026-01", moeda: "BRL", valor: 1, fonte: "a, b, c" }];
    const csv = formatSpendCsv(rows);
    const { rows: reparsed, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.deepEqual(reparsed, rows);
  });
});

// ---------------------------------------------------------------------------
// Coluna opcional `subcanal` (#5496)
// ---------------------------------------------------------------------------

describe("subcanal (#5496) — coluna opcional, não faz parte de SPEND_CSV_HEADERS", () => {
  it("SPEND_CSV_HEADERS continua só as 5 obrigatórias (subcanal NÃO entra)", () => {
    assert.equal((SPEND_CSV_HEADERS as readonly string[]).includes("subcanal"), false);
  });

  it("arquivo SEM a coluna subcanal parseia idêntico a antes do #5496 (nenhuma linha tem .subcanal)", () => {
    const csv = "canal,mes,moeda,valor,fonte\nGoogle Ads,2026-02,BRL,956.21,painel Ads\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(rows[0].subcanal, undefined);
    assert.deepEqual(Object.keys(rows[0]).sort(), ["canal", "fonte", "mes", "moeda", "valor"]);
  });

  it("arquivo COM a coluna subcanal preenchida popula SpendRow.subcanal", () => {
    const csv = "canal,mes,moeda,valor,fonte,subcanal\nGoogle Ads,2026-02,BRL,718.39,painel Ads,PMax\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(rows[0].subcanal, "PMax");
  });

  it("coluna subcanal presente mas célula vazia -> subcanal fica undefined (não string vazia)", () => {
    const csv = "canal,mes,moeda,valor,fonte,subcanal\nGoogle Ads,2026-02,BRL,718.39,painel Ads,\n";
    const { rows, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.equal(rows[0].subcanal, undefined);
  });

  it("formatSpendCsv omite a coluna subcanal quando nenhuma linha a usa (round-trip idêntico ao seed)", () => {
    const csv = formatSpendCsv(SPEND_SEED_ROWS);
    assert.equal(csv.startsWith("canal,mes,moeda,valor,fonte\n"), true);
    assert.equal(csv.includes("subcanal"), false);
  });

  it("formatSpendCsv inclui a coluna subcanal quando pelo menos uma linha a usa, e faz round-trip", () => {
    const rows = [
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 718.39, fonte: "painel Ads", subcanal: "PMax" },
      { canal: "Google Ads", mes: "2026-02", moeda: "BRL", valor: 239.62, fonte: "painel Ads", subcanal: "Search" },
    ];
    const csv = formatSpendCsv(rows);
    assert.equal(csv.startsWith("canal,mes,moeda,valor,fonte,subcanal\n"), true);
    const { rows: reparsed, errors } = parseSpendCsv(csv);
    assert.deepEqual(errors, []);
    assert.deepEqual(reparsed, rows);
  });
});
