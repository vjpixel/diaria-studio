/**
 * test/lint-newsletter-md-why-matters-length.test.ts (#3993)
 *
 * Cobre `checkWhyMattersLength` e `--check why-matters-length` CLI.
 *
 * Janela 180-300 chars pro parágrafo "Por que isso importa" (mais curta que
 * a spec anterior do writer, ~400 chars — pedido do editor sessão 260724,
 * pra manter o parágrafo objetivo). Contagem exclui a label e o bloco
 * "Aprofunde:" (#3920).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  checkWhyMattersLength,
  WHY_MATTERS_MIN_CHARS,
  WHY_MATTERS_MAX_CHARS,
} from "../scripts/lint-newsletter-md.ts";

/**
 * Gera um bloco DESTAQUE com "Por que isso importa" em linha separada
 * (formato real do writer — ver context/templates/newsletter.md), com um
 * parágrafo-filler de `whyChars` caracteres exatos (sem espaços internos,
 * pra permitir controle preciso do char count).
 */
function makeDestaqueMd(
  num: number,
  category: string,
  whyChars: number,
  opts?: { aprofunde?: boolean; multiSentence?: boolean },
): string {
  let why: string;
  if (opts?.multiSentence) {
    // 2 frases curtas ("A...A. B...B."), chars totais == whyChars exatos.
    const remaining = Math.max(0, whyChars - 3); // ". " (2) + "." (1)
    const part1Len = Math.ceil(remaining / 2);
    const part2Len = remaining - part1Len;
    why = "A".repeat(part1Len) + ". " + "B".repeat(part2Len) + ".";
  } else {
    why = "X".repeat(Math.max(0, whyChars));
  }

  const lines = [
    `**DESTAQUE ${num} | ${category}**`,
    "",
    `**[Título Teste](https://example.com/${num})**`,
    "",
    "Corpo do destaque com texto de exemplo pra preencher o corpo do parágrafo introdutório.",
    "",
    "Por que isso importa:",
    "",
    why,
  ];
  if (opts?.aprofunde) {
    lines.push(
      "",
      "Aprofunde:",
      "",
      `* [Fonte extra](https://example.com/${num}/extra) - Veículo X`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

describe("checkWhyMattersLength (#3993) — helper puro", () => {
  it("ok=true quando todos os destaques estão dentro de 180-300 chars", () => {
    const md = [
      makeDestaqueMd(1, "PRODUTO", 200),
      "---",
      makeDestaqueMd(2, "PESQUISA", 250),
      "---",
      makeDestaqueMd(3, "MERCADO", 300),
    ].join("\n");
    const r = checkWhyMattersLength(md);
    assert.equal(r.ok, true, JSON.stringify(r.highlights));
    assert.equal(r.errors.length, 0);
  });

  it("179 chars: falha (abaixo do mínimo, boundary -1)", () => {
    const md = makeDestaqueMd(1, "PRODUTO", 179);
    const r = checkWhyMattersLength(md);
    assert.equal(r.highlights[0].chars, 179);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].destaque, 1);
    assert.equal(r.errors[0].min, 180);
  });

  it("180 chars: passa (boundary exata do mínimo)", () => {
    const md = makeDestaqueMd(1, "PRODUTO", 180);
    const r = checkWhyMattersLength(md);
    assert.equal(r.highlights[0].chars, 180);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("300 chars: passa (boundary exata do máximo)", () => {
    const md = makeDestaqueMd(1, "PRODUTO", 300);
    const r = checkWhyMattersLength(md);
    assert.equal(r.highlights[0].chars, 300);
    assert.equal(r.ok, true);
    assert.equal(r.errors.length, 0);
  });

  it("301 chars: falha (acima do máximo, boundary +1)", () => {
    const md = makeDestaqueMd(1, "PRODUTO", 301);
    const r = checkWhyMattersLength(md);
    assert.equal(r.highlights[0].chars, 301);
    assert.equal(r.ok, false);
    assert.equal(r.errors[0].destaque, 1);
    assert.equal(r.errors[0].max, 300);
  });

  it("PQI multi-frase (2 frases curtas) dentro da janela: passa", () => {
    const md = makeDestaqueMd(1, "PRODUTO", 220, { multiSentence: true });
    const r = checkWhyMattersLength(md);
    assert.equal(r.ok, true, JSON.stringify(r.highlights));
    // Confere que de fato tem 2 frases (2 pontos finais) no texto medido.
    assert.equal((r.highlights[0] as any).chars, 220);
  });

  it("bloco 'Aprofunde:' logo após o why NÃO conta na medição (#3920)", () => {
    // why de 220 chars + bloco Aprofunde bem maior — se o Aprofunde vazasse
    // pra contagem, o destaque falharia por excesso (220 + aprofunde >> 300).
    const md = makeDestaqueMd(1, "PRODUTO", 220, { aprofunde: true });
    const r = checkWhyMattersLength(md);
    assert.equal(r.highlights[0].chars, 220, "Aprofunde vazou pra contagem do why");
    assert.equal(r.ok, true);
  });

  it("MD sem destaques: ok=true (nada pra checar)", () => {
    const md = "Apenas texto sem destaques.";
    const r = checkWhyMattersLength(md);
    assert.equal(r.ok, true);
    assert.equal(r.highlights.length, 0);
  });

  it("destaque sem 'Por que isso importa' detectável: não conta (pego por outro check)", () => {
    const md = [
      `**DESTAQUE 1 | PRODUTO**`,
      "",
      `**[Título](https://example.com/1)**`,
      "",
      "Corpo sem why nenhum.",
      "",
    ].join("\n");
    const r = checkWhyMattersLength(md);
    assert.equal(r.highlights.length, 0);
    assert.equal(r.ok, true);
  });
});

describe("WHY_MATTERS_MIN_CHARS / WHY_MATTERS_MAX_CHARS constants (#3993)", () => {
  it("janela é 180-300, mais curta que a spec anterior (~400 chars)", () => {
    assert.equal(WHY_MATTERS_MIN_CHARS, 180);
    assert.equal(WHY_MATTERS_MAX_CHARS, 300);
  });
});

describe("--check why-matters-length CLI (#3993)", () => {
  function runCli(args: string[]) {
    const projectRoot = join(import.meta.dirname, "..");
    const scriptPath = join(projectRoot, "scripts", "lint-newsletter-md.ts");
    return spawnSync(
      process.execPath,
      ["--import", "tsx", scriptPath, ...args],
      { cwd: projectRoot, encoding: "utf8" },
    );
  }

  it("exit 0 quando todos os destaques estão dentro de 180-300 chars", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-why-len-ok-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        makeDestaqueMd(1, "PRODUTO", 200),
        "---",
        makeDestaqueMd(2, "PESQUISA", 250),
        "---",
        makeDestaqueMd(3, "MERCADO", 290),
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "why-matters-length", "--md", mdPath]);
      assert.equal(r.status, 0, r.stderr);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1 quando D2 está acima do máximo (401 chars — spec antiga ~400)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-why-len-fail-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        makeDestaqueMd(1, "PRODUTO", 200),
        "---",
        makeDestaqueMd(2, "PESQUISA", 401),
        "---",
        makeDestaqueMd(3, "MERCADO", 250),
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "why-matters-length", "--md", mdPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /D2.*acima do máximo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exit 1 quando D3 está abaixo do mínimo (150 chars)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lint-why-len-fail-min-"));
    try {
      const mdPath = join(dir, "02-reviewed.md");
      const md = [
        makeDestaqueMd(1, "PRODUTO", 200),
        "---",
        makeDestaqueMd(2, "PESQUISA", 250),
        "---",
        makeDestaqueMd(3, "MERCADO", 150),
      ].join("\n");
      writeFileSync(mdPath, md, "utf8");
      const r = runCli(["--check", "why-matters-length", "--md", mdPath]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /D3.*abaixo do mínimo/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Fixture golden (#3993 item 6 do plano) — calibração contra edições reais
 * recentes (data/editions/2607/{260717,260720,260722,260723,260724}). Estas
 * edições foram escritas sob a spec ANTERIOR (~400 chars) e servem só pra
 * documentar (não validar) o quanto o parágrafo real diverge da nova janela
 * 180-300. Números completos no PR body (#3993) — aqui fixamos apenas os
 * dados como snapshot determinístico (sem depender de `data/` no worktree,
 * que é um junction local do OneDrive ausente em clone fresco/CI).
 *
 * Achado da calibração: 11/15 destaques amostrados (73%) ficam fora da nova
 * janela — quase todos ACIMA do máximo (spec antiga mirava ~400,
 * consideravelmente acima do novo teto de 300). Isso é esperado (as edições
 * foram escritas ANTES desta mudança) e não invalida a janela — é
 * exatamente o motivo de #3993 mandar atualizar o PROMPT do writer, não só
 * adicionar lint por cima.
 */
describe("calibração (#3993 item 6) — snapshot de edições reais 2607/26072{0,2,3,4} e 260717", () => {
  const REAL_WHY_CHARS: Record<string, number[]> = {
    "260717": [294, 169, 350],
    "260720": [361, 277, 265],
    "260722": [212, 365, 417],
    "260723": [384, 317, 333],
    "260724": [533, 162, 344],
  };

  it("11/15 destaques amostrados ficam fora de 180-300 (documentado, não bloqueante)", () => {
    let outOfWindow = 0;
    let total = 0;
    for (const chars of Object.values(REAL_WHY_CHARS).flat()) {
      total++;
      if (chars < WHY_MATTERS_MIN_CHARS || chars > WHY_MATTERS_MAX_CHARS) outOfWindow++;
    }
    assert.equal(total, 15);
    assert.equal(outOfWindow, 11);
  });
});
