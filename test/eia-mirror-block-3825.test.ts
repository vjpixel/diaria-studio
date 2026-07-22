/**
 * test/eia-mirror-block-3825.test.ts (#3825)
 *
 * Unit tests para os helpers puros que extraem/parseiam o bloco `**É IA?**`
 * espelho dentro de `02-reviewed.md` — usados pelo invariant check
 * `checkEiaCreditSynced` (scripts/lib/invariant-checks/stage-4.ts) pra
 * comparar contra `01-eia.md`, a fonte real do render.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractEiaMirrorBlock, parseEiaMirrorBlock } from "../scripts/lib/newsletter-parse.ts";

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "diaria-eia-mirror-"));
}

describe("extractEiaMirrorBlock (#3825)", () => {
  it("extrai o bloco isolado entre `---` cujo header é **É IA?** (negrito)", () => {
    const md = [
      "**DESTAQUE 2 | MERCADO**",
      "",
      "Corpo do D2.",
      "",
      "---",
      "",
      "**É IA?**",
      "",
      "Crédito da imagem.",
      "",
      "---",
      "",
      "**DESTAQUE 3 | PRODUTO**",
      "",
      "Corpo do D3.",
    ].join("\n");
    const block = extractEiaMirrorBlock(md);
    assert.ok(block);
    assert.match(block!, /^\*\*É IA\?\*\*/);
    assert.match(block!, /Crédito da imagem\./);
    assert.doesNotMatch(block!, /DESTAQUE/);
  });

  it("aceita header legacy sem negrito ('É IA?')", () => {
    const md = ["---", "", "É IA?", "", "Legacy credit.", "", "---"].join("\n");
    const block = extractEiaMirrorBlock(md);
    assert.ok(block);
    assert.match(block!, /^É IA\?/);
  });

  it("retorna null quando o bloco não existe (edição legada sem stitch)", () => {
    const md = ["**DESTAQUE 1 | MERCADO**", "", "Corpo.", "", "---", "", "**LANÇAMENTOS**"].join(
      "\n",
    );
    assert.equal(extractEiaMirrorBlock(md), null);
  });

  it("tolera CRLF", () => {
    const md = ["---", "", "**É IA?**", "", "Crédito CRLF.", "", "---"].join("\r\n");
    const block = extractEiaMirrorBlock(md);
    assert.ok(block);
    assert.match(block!, /Crédito CRLF\./);
  });
});

describe("parseEiaMirrorBlock (#3825)", () => {
  it("parseia credit + prevResultLine com a MESMA lógica de parseEIA", () => {
    const dir = makeDir();
    try {
      const block = [
        "**É IA?**",
        "",
        "Crédito da imagem [link](https://x.com).",
        "",
        "Resultado da última edição: 57% das pessoas acertaram.",
      ].join("\n");
      const eia = parseEiaMirrorBlock(block, dir);
      assert.match(eia.credit, /Crédito da imagem/);
      assert.equal(
        eia.prevResultLine,
        "Resultado da última edição: 57% das pessoas acertaram.",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("remove a linha '> Gabarito: ...' (formato legado do writer.md single-writer) antes de parsear — não vaza pro credit", () => {
    const dir = makeDir();
    try {
      const block = [
        "**É IA?**",
        "",
        "Crédito da imagem.",
        "",
        "> Gabarito: **A é a IA**",
      ].join("\n");
      const eia = parseEiaMirrorBlock(block, dir);
      assert.equal(eia.credit, "Crédito da imagem.");
      assert.ok(!eia.credit.includes("Gabarito"), "credit não pode conter a linha de gabarito");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
