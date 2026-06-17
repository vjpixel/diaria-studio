/**
 * 2-destaques-e2e.test.ts (#2343)
 *
 * Prova que uma edição com 2 destaques flui end-to-end:
 *   resolveDestaques (via #2333) → Stage-1 invariant → stitch (sem D3) → render
 *
 * CARDINAL RULE: 3-destaque happy path permanece IDÊNTICO.
 * Este arquivo adiciona cobertura para 2 destaques SEM modificar os testes
 * existentes de 3 destaques.
 */

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  checkApprovedHas3Highlights,
} from "../scripts/lib/invariant-checks/stage-1.ts";
import { stitchNewsletter } from "../scripts/stitch-newsletter.ts";
import { extractDestaquesFromSocialMd } from "../scripts/publish-facebook.ts";
import { extractDestaquesFromLinkedInMd } from "../scripts/publish-linkedin.ts";
import { parseDestaqueHeaders } from "../scripts/lint-social-md.ts";

// ---------------------------------------------------------------------------
// Stage-1 invariant: range {2,3} aceito; {<2, >3} falha
// ---------------------------------------------------------------------------

describe("Stage-1 invariant approved-has-3-highlights (#2343 range {2,3})", () => {
  function makeFixture(highlightCount: number): string {
    const dir = mkdtempSync(join(tmpdir(), "inv-stage1-2343-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "01-approved.json"),
      JSON.stringify({
        highlights: Array.from({ length: highlightCount }, (_, i) => ({
          rank: i + 1,
          article: { url: `https://example.com/${i + 1}`, title: `T${i + 1}` },
        })),
        coverage: { line: "x" },
      }),
    );
    return dir;
  }

  it("PASSA com 2 highlights (novo — 2-destaque edition)", () => {
    const dir = makeFixture(2);
    try {
      const v = checkApprovedHas3Highlights(dir);
      assert.equal(v.length, 0, `Esperava 0 violations com 2 destaques, achei: ${JSON.stringify(v)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PASSA com 3 highlights (caminho feliz existente — regressão)", () => {
    const dir = makeFixture(3);
    try {
      const v = checkApprovedHas3Highlights(dir);
      assert.equal(v.length, 0, `Esperava 0 violations com 3 destaques, achei: ${JSON.stringify(v)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FALHA com 1 highlight (fail-loud: < 2)", () => {
    const dir = makeFixture(1);
    try {
      const v = checkApprovedHas3Highlights(dir);
      assert.equal(v.length, 1, `Esperava 1 violation com 1 destaque`);
      assert.equal(v[0].rule, "approved-has-3-highlights");
      assert.match(v[0].message, /1 highlight|range.*2/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FALHA com 0 highlights (fail-loud: < 2)", () => {
    const dir = makeFixture(0);
    try {
      const v = checkApprovedHas3Highlights(dir);
      assert.equal(v.length, 1, `Esperava 1 violation com 0 destaques`);
      assert.equal(v[0].rule, "approved-has-3-highlights");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FALHA com 4 highlights (fail-loud: > 3)", () => {
    const dir = makeFixture(4);
    try {
      const v = checkApprovedHas3Highlights(dir);
      assert.equal(v.length, 1, `Esperava 1 violation com 4 destaques`);
      assert.equal(v[0].rule, "approved-has-3-highlights");
      assert.match(v[0].message, /4 highlight|range/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// stitch-newsletter: 2-destaque edition (sem D3) não crasha
// ---------------------------------------------------------------------------

describe("stitchNewsletter 2-destaque edition (#2343)", () => {
  function setupEdition2D() {
    const dir = mkdtempSync(join(tmpdir(), "stitch-2d-"));
    const internalDir = join(dir, "_internal");
    mkdirSync(internalDir, { recursive: true });
    return { dir, internalDir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }

  it("stitch sem D3 não crasha (d3Path=null)", () => {
    const { dir, internalDir, cleanup } = setupEdition2D();
    try {
      writeFileSync(
        join(internalDir, "02-d1-draft.md"),
        "**DESTAQUE 1 | 🚀 LANÇAMENTO**\n\n[**Title 1**](https://example.com/d1)\n\nbody1",
      );
      writeFileSync(
        join(internalDir, "02-d2-draft.md"),
        "**DESTAQUE 2 | ⚖️ REGULAÇÃO**\n\n[**Title 2**](https://example.com/d2)\n\nbody2",
      );
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Para esta edição, 2 destaques." },
          highlights: [
            { rank: 1, article: { url: "https://example.com/d1", title: "Title 1" } },
            { rank: 2, article: { url: "https://example.com/d2", title: "Title 2" } },
          ],
          lancamento: [],
          radar: [{ title: "R1", url: "https://r.com/1", summary: "rdesc" }],
        }),
      );

      let result: string;
      assert.doesNotThrow(() => {
        result = stitchNewsletter({
          d1Path: join(internalDir, "02-d1-draft.md"),
          d2Path: join(internalDir, "02-d2-draft.md"),
          d3Path: null, // 2-destaque: sem D3
          approvedCappedPath: join(internalDir, "01-approved-capped.json"),
          editionDir: dir,
        });
      });

      // D1 e D2 presentes
      assert.match(result!, /DESTAQUE 1/);
      assert.match(result!, /DESTAQUE 2/);
      // D3 ausente
      assert.doesNotMatch(result!, /DESTAQUE 3/);
      // Seções fixas presentes
      assert.match(result!, /SORTEIO/);
      assert.match(result!, /PARA ENCERRAR/);
      assert.match(result!, /ERRO INTENCIONAL/);
      // Conteúdo das seções secundárias presentes
      assert.match(result!, /https:\/\/r\.com\/1/);
    } finally {
      cleanup();
    }
  });

  it("stitch sem D3 omite D3 e preserva ordem D1 > É IA? > seções > SORTEIO", () => {
    const { dir, internalDir, cleanup } = setupEdition2D();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "DESTAQUE 1 body");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "DESTAQUE 2 body");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage 2D." },
          highlights: [
            { rank: 1, article: { url: "https://a.com", title: "T1" } },
            { rank: 2, article: { url: "https://b.com", title: "T2" } },
          ],
          lancamento: [{ title: "L1", url: "https://l.com/1", summary: "ldesc" }],
          radar: [],
        }),
      );
      writeFileSync(
        join(dir, "01-eia.md"),
        "É IA?\n\nFoto descrição 2D.\n\n> Gabarito: **A é a IA**",
      );

      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: null,
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });

      // Ordem: D2 > É IA? (D3 omitido) > LANÇAMENTOS > SORTEIO
      const d2Pos = result.indexOf("DESTAQUE 2 body");
      const eiaPos = result.indexOf("É IA?");
      const lancPos = result.indexOf("LANÇAMENTO");
      const sortPos = result.indexOf("SORTEIO");

      assert.ok(d2Pos > 0, "D2 presente");
      assert.ok(eiaPos > d2Pos, `É IA? após D2 (d2=${d2Pos} eia=${eiaPos})`);
      assert.ok(lancPos > eiaPos, `LANÇAMENTOS após É IA? (eia=${eiaPos} lanc=${lancPos})`);
      assert.ok(sortPos > lancPos, `SORTEIO após LANÇAMENTOS (lanc=${lancPos} sort=${sortPos})`);
      assert.doesNotMatch(result, /DESTAQUE 3/, "D3 NÃO deve aparecer");
    } finally {
      cleanup();
    }
  });

  it("stitch 2-destaque omite D3 mas mantém É IA? placeholder quando 01-eia.md ausente", () => {
    const { dir, internalDir, cleanup } = setupEdition2D();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "c" }, highlights: [{}, {}] }),
      );
      // 01-eia.md ausente propositalmente

      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: null,
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });

      assert.match(result, /É IA\? ainda processando/);
      assert.doesNotMatch(result, /DESTAQUE 3/);
    } finally {
      cleanup();
    }
  });

  it("stitch 3-destaques ainda funciona normalmente (regressão do happy path)", () => {
    const { dir, internalDir, cleanup } = setupEdition2D();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "DESTAQUE 1 body");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "DESTAQUE 2 body");
      writeFileSync(join(internalDir, "02-d3-draft.md"), "DESTAQUE 3 body");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({
          coverage: { line: "Coverage 3D." },
          highlights: [{}, {}, {}],
          lancamento: [],
          radar: [],
        }),
      );

      const result = stitchNewsletter({
        d1Path: join(internalDir, "02-d1-draft.md"),
        d2Path: join(internalDir, "02-d2-draft.md"),
        d3Path: join(internalDir, "02-d3-draft.md"),
        approvedCappedPath: join(internalDir, "01-approved-capped.json"),
        editionDir: dir,
      });

      assert.match(result, /DESTAQUE 1 body/);
      assert.match(result, /DESTAQUE 2 body/);
      assert.match(result, /DESTAQUE 3 body/);
      assert.match(result, /SORTEIO/);
    } finally {
      cleanup();
    }
  });

  it("stitch com d3Path presente mas arquivo ausente crasha (fail-loud para path errado)", () => {
    const { dir, internalDir, cleanup } = setupEdition2D();
    try {
      writeFileSync(join(internalDir, "02-d1-draft.md"), "D1");
      writeFileSync(join(internalDir, "02-d2-draft.md"), "D2");
      writeFileSync(
        join(internalDir, "01-approved-capped.json"),
        JSON.stringify({ coverage: { line: "c" }, highlights: [{}, {}] }),
      );
      // d3Path fornecido mas arquivo não existe → deve lançar exceção

      assert.throws(
        () =>
          stitchNewsletter({
            d1Path: join(internalDir, "02-d1-draft.md"),
            d2Path: join(internalDir, "02-d2-draft.md"),
            d3Path: join(internalDir, "02-d3-draft.md"), // path fornecido mas ausente
            approvedCappedPath: join(internalDir, "01-approved-capped.json"),
            editionDir: dir,
          }),
        /input ausente/,
      );
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Publishers: derivação de destaques presentes do 03-social.md (#2343 review)
// ---------------------------------------------------------------------------

describe("publishers extract destaques presentes (#2343)", () => {
  const social3 =
    "# LinkedIn\n## d1\npost1\n## d2\npost2\n## d3\npost3\n\n# Facebook\n## d1\nfb1\n## d2\nfb2\n## d3\nfb3\n";
  const social2 =
    "# LinkedIn\n## d1\npost1\n## d2\npost2\n\n# Facebook\n## d1\nfb1\n## d2\nfb2\n";

  it("Facebook: 3-destaque retorna [d1,d2,d3] (regressão happy path)", () => {
    assert.deepEqual(extractDestaquesFromSocialMd(social3, "facebook"), ["d1", "d2", "d3"]);
  });

  it("Facebook: 2-destaque retorna [d1,d2]", () => {
    assert.deepEqual(extractDestaquesFromSocialMd(social2, "facebook"), ["d1", "d2"]);
  });

  it("Facebook: seção ausente cai no fallback [d1,d2,d3]", () => {
    assert.deepEqual(extractDestaquesFromSocialMd("# LinkedIn\n## d1\nx\n", "facebook"), ["d1", "d2", "d3"]);
  });

  it("Facebook: CRLF (Drive Windows) ainda parseia", () => {
    const crlf = social2.replace(/\n/g, "\r\n");
    assert.deepEqual(extractDestaquesFromSocialMd(crlf, "facebook"), ["d1", "d2"]);
  });

  it("LinkedIn: 3-destaque retorna [d1,d2,d3] (regressão happy path)", () => {
    assert.deepEqual(extractDestaquesFromLinkedInMd(social3), ["d1", "d2", "d3"]);
  });

  it("LinkedIn: 2-destaque retorna [d1,d2]", () => {
    assert.deepEqual(extractDestaquesFromLinkedInMd(social2), ["d1", "d2"]);
  });

  it("LinkedIn: seção ausente retorna [] (caller aplica fallback)", () => {
    assert.deepEqual(extractDestaquesFromLinkedInMd("# Facebook\n## d1\nx\n"), []);
  });

  it("parseDestaqueHeaders: ignora ## post_pixel e dedup, ordem canônica", () => {
    const section = "## d2\nb\n## post_pixel\nx\n## d1\na\n## d1\nrepeat\n";
    assert.deepEqual(parseDestaqueHeaders(section), ["d1", "d2"]);
  });

  it("parseDestaqueHeaders: warns on ## d4 (typo) but NOT on valid ## d1/d2/d3 (#2356 fix 2)", () => {
    // #2356 fix 2 — garante que o bloco de warn em parseDestaqueHeaders detecta
    // headers fora do conjunto canônico [d1, d2, d3].
    //
    // Failure scenario: se o `for (const d of destaques) { if (!canonical.has(d)) ... }`
    // for removido, errors.length === 0 e o assert abaixo FALHA, mantendo CI vermelho.
    const errors: string[] = [];
    mock.method(console, "error", (...args: unknown[]) =>
      errors.push(String(args[0])),
    );

    try {
      // ## d4 deve disparar warn e NÃO aparecer no retorno (filtrado pelo canonical)
      const result = parseDestaqueHeaders("## d4\nalgum texto\n## d1\nvalido\n");
      assert.deepEqual(result, ["d1"], "d4 deve ser filtrado do retorno");
      assert.ok(
        errors.some((e) => e.includes("d4")),
        "#2356: parseDestaqueHeaders deve emitir console.error mencionando 'd4' ao encontrar header não-canônico",
      );

      // Headers válidos d1/d2/d3 NÃO devem gerar warn
      errors.length = 0;
      parseDestaqueHeaders("## d1\na\n## d2\nb\n## d3\nc\n");
      assert.equal(errors.length, 0, "d1/d2/d3 canônicos não devem gerar warn");
    } finally {
      mock.restoreAll();
    }
  });
});
