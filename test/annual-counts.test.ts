/**
 * test/annual-counts.test.ts (#7569)
 *
 * O bloco de aniversário afirma quantas edições saíram "no período" — um
 * número factual que vai por e-mail para a base inteira. A versão anterior
 * contava os diretórios inteiros de `data/monthly/` e `data/artigo-especial/`,
 * o que acerta por acaso na 1ª rodada (a janela cobre a vida do projeto) e
 * passa a inflar da 2ª em diante.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  annualCounts,
  countMonthlyDigests,
  countSpecialArticles,
  coversFullYears,
  windowYears,
} from "../scripts/lib/anual/annual-counts.ts";
import { monthsBetween } from "../scripts/lib/anual/annual-window.ts";

/** Cria `data/monthly/` de mentira: ciclos com e sem `draft.md`. */
function fakeMonthly(ciclos: { dir: string; draft: boolean }[]): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "annual-monthly-"));
  for (const c of ciclos) {
    mkdirSync(join(base, c.dir), { recursive: true });
    if (c.draft) writeFileSync(join(base, c.dir, "draft.md"), "# draft");
  }
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

function fakeSpecials(dirs: string[]): { base: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), "annual-special-"));
  for (const d of dirs) mkdirSync(join(base, d), { recursive: true });
  return { base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe("digests mensais do período", () => {
  it("conta só os ciclos cujo mês de CONTEÚDO está na janela", () => {
    const { base, cleanup } = fakeMonthly([
      { dir: "2503-04", draft: true }, // fora (antes)
      { dir: "2604-05", draft: true }, // dentro
      { dir: "2605-06", draft: true }, // dentro
      { dir: "2609-10", draft: true }, // fora (depois)
    ]);
    try {
      assert.equal(countMonthlyDigests(base, monthsBetween("2604", "2608")), 2);
    } finally {
      cleanup();
    }
  });

  it("ciclo sem draft.md não conta — começado não é publicado", () => {
    const { base, cleanup } = fakeMonthly([
      { dir: "2604-05", draft: true },
      { dir: "2605-06", draft: false },
    ]);
    try {
      assert.equal(countMonthlyDigests(base, monthsBetween("2604", "2608")), 1);
    } finally {
      cleanup();
    }
  });

  it("a contagem CUMULATIVA seria maior — é essa a diferença que importa", () => {
    const ciclos = [
      { dir: "2503-04", draft: true },
      { dir: "2504-05", draft: true },
      { dir: "2604-05", draft: true },
    ];
    const { base, cleanup } = fakeMonthly(ciclos);
    try {
      const janela = countMonthlyDigests(base, monthsBetween("2604", "2608"));
      assert.equal(janela, 1);
      assert.notEqual(janela, ciclos.length, "contar o diretório inteiro publicaria 3 no lugar de 1");
    } finally {
      cleanup();
    }
  });

  it("diretório inexistente devolve 0 em vez de quebrar", () => {
    assert.equal(countMonthlyDigests(join(tmpdir(), "nao-existe-annual-xyz"), ["2604"]), 0);
  });
});

describe("artigos especiais do período", () => {
  it("conta pelos anos que a janela toca (o diretório não guarda mês)", () => {
    const { base, cleanup } = fakeSpecials(["2025-um-tema", "2026-engenharia-de-ilusao", "2027-outro"]);
    try {
      assert.equal(countSpecialArticles(base, monthsBetween("2508", "2608")), 2);
    } finally {
      cleanup();
    }
  });

  it("diretório fora do padrão {AAAA}-{slug} é ignorado", () => {
    const { base, cleanup } = fakeSpecials(["2026-valido", "rascunho", "_arquivo"]);
    try {
      assert.equal(countSpecialArticles(base, monthsBetween("2601", "2612")), 1);
    } finally {
      cleanup();
    }
  });
});

describe("sinalização de imprecisão", () => {
  it("janela ago–jul NÃO cobre anos inteiros — a contagem de especiais é aproximada", () => {
    assert.equal(coversFullYears(monthsBetween("2508", "2607")), false);
  });

  it("janela de ano civil cobre o ano inteiro — contagem exata", () => {
    assert.equal(coversFullYears(monthsBetween("2601", "2612")), true);
  });

  it("os anos tocados pela janela saem certos na virada", () => {
    assert.deepEqual([...windowYears(monthsBetween("2511", "2602"))].sort(), [2025, 2026]);
  });

  it("annualCounts propaga a flag junto dos números", () => {
    const m = fakeMonthly([{ dir: "2604-05", draft: true }]);
    const e = fakeSpecials(["2026-x"]);
    try {
      const c = annualCounts({
        monthlyBase: m.base,
        specialBase: e.base,
        months: monthsBetween("2508", "2608"),
        edicoesDiarias: 266,
      });
      assert.deepEqual(c, {
        edicoes_diarias: 266,
        digests_mensais: 1,
        artigos_especiais: 1,
        especiais_ano_aproximado: true,
      });
    } finally {
      m.cleanup();
      e.cleanup();
    }
  });
});
