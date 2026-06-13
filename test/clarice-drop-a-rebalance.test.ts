import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { readCells, writeCells, stratSplit, type Row } from "../scripts/clarice-drop-a-rebalance.ts";

function tmp(): { dir: string; f: string } {
  const dir = mkdtempSync(join(tmpdir(), "drop-a-"));
  return { dir, f: resolve(dir, "cell.csv") };
}

describe("writeCells/readCells round-trip", () => {
  it("não corrompe o TIER da última linha (regressão CRLF+\\n)", () => {
    const { dir, f } = tmp();
    try {
      const rows: Row[] = [
        { email: "a@b.com", NOME: "Alice", TIER: "T2" },
        { email: "c@d.com", NOME: "Bob", TIER: "maio" },
      ];
      writeCells(f, rows);
      const back = readCells(f);
      assert.equal(back.length, 2);
      // o bug original lia "maio\n" na última linha
      assert.equal(back[back.length - 1].TIER, "maio");
      assert.equal(back[0].TIER, "T2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preserva NOME com vírgula entre aspas", () => {
    const { dir, f } = tmp();
    try {
      writeCells(f, [{ email: "x@y.com", NOME: "Letícia.,.", TIER: "maio" }]);
      const back = readCells(f);
      assert.equal(back[0].NOME, "Letícia.,.");
      assert.equal(back[0].TIER, "maio");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escreve/lê célula vazia (header-only) como []", () => {
    const { dir, f } = tmp();
    try {
      writeCells(f, []);
      assert.deepEqual(readCells(f), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stratSplit (round-robin por TIER)", () => {
  it("balanceia cada tier ≤1 entre B e C e preserva o total", () => {
    const rows: Row[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ email: `t1-${i}@x.com`, NOME: "n", TIER: "T1" })),
      ...Array.from({ length: 4 }, (_, i) => ({ email: `t2-${i}@x.com`, NOME: "n", TIER: "T2" })),
    ];
    const { toB, toC } = stratSplit(rows);
    assert.equal(toB.length + toC.length, rows.length);
    // T1: 5 → B=3, C=2 ; T2: 4 → B=2, C=2
    const tier = (rs: Row[], t: string) => rs.filter((r) => r.TIER === t).length;
    assert.equal(tier(toB, "T1"), 3);
    assert.equal(tier(toC, "T1"), 2);
    assert.equal(tier(toB, "T2"), 2);
    assert.equal(tier(toC, "T2"), 2);
  });
});
