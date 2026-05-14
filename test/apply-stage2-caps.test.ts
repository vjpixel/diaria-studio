/**
 * test/apply-stage2-caps.test.ts (#358, #907)
 *
 * Cobre o helper puro `applyStage2Caps` + `checkStage2Caps` + `capOutrasNoticias`.
 *
 * Caso real que motivou o issue: 260507 publicou 9 itens em Outras Notícias
 * quando o cap esperado era 4 (3 destaques + 2 lançamentos + 3 pesquisas →
 * outras = max(2, 12-3-2-3) = 4).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyStage2Caps,
  checkStage2Caps,
  capOutrasNoticias,
  STAGE_2_CAP_LANCAMENTOS,
  STAGE_2_CAP_PESQUISAS,
  STAGE_2_MIN_OUTRAS,
} from "../scripts/lib/apply-stage2-caps.ts";

describe("capOutrasNoticias (#358)", () => {
  it("max(2, 12 - 3 - 2 - 3) = 4 (caso 260507)", () => {
    assert.equal(capOutrasNoticias(3, 2, 3), 4);
  });

  it("max(2, 12 - 3 - 5 - 3) = 2 (todos os outros buckets cheios)", () => {
    assert.equal(capOutrasNoticias(3, 5, 3), 2);
  });

  it("max(2, 12 - 3 - 0 - 0) = 9 (sem lançamento nem pesquisa)", () => {
    assert.equal(capOutrasNoticias(3, 0, 0), 9);
  });

  it("piso é sempre 2 (mesmo se conta < 2)", () => {
    assert.equal(capOutrasNoticias(3, 5, 5), STAGE_2_MIN_OUTRAS); // 12-3-5-5 = -1 → 2
  });

  it("0 destaques (edge): max(2, 12 - 0 - 0 - 0) = 12", () => {
    assert.equal(capOutrasNoticias(0, 0, 0), 12);
  });
});

describe("applyStage2Caps", () => {
  it("trunca buckets que excedem cap, preserva resto", () => {
    const approved = {
      highlights: new Array(3).fill({}).map((_, i) => ({ url: `https://h.${i}` })),
      lancamento: new Array(8).fill({}).map((_, i) => ({ url: `https://l.${i}` })),
      pesquisa: new Array(7).fill({}).map((_, i) => ({ url: `https://p.${i}` })),
      noticias: new Array(20).fill({}).map((_, i) => ({ url: `https://n.${i}` })),
      runners_up: [{ url: "https://ru.0" }],
    };
    const { approved: capped, report } = applyStage2Caps(approved);

    assert.equal(capped.highlights?.length, 3); // unchanged
    assert.equal(capped.lancamento?.length, STAGE_2_CAP_LANCAMENTOS); // 5
    assert.equal(capped.pesquisa?.length, STAGE_2_CAP_PESQUISAS); // 3
    // Outras: max(2, 12 - 3 - 5 - 3) = 2
    assert.equal(capped.noticias?.length, 2);
    // Runners-up preservados
    assert.equal(capped.runners_up?.length, 1);

    assert.equal(report.before.lancamento, 8);
    assert.equal(report.after.lancamento, 5);
    assert.equal(report.truncated.lancamento, 3);
    assert.equal(report.before.noticias, 20);
    assert.equal(report.after.noticias, 2);
  });

  it("não muta o input (devolve cópia)", () => {
    const approved = {
      highlights: [{ url: "https://h" }],
      lancamento: [
        { url: "https://l/1" },
        { url: "https://l/2" },
        { url: "https://l/3" },
        { url: "https://l/4" },
        { url: "https://l/5" },
        { url: "https://l/6" },
      ],
      pesquisa: [],
      noticias: [],
    };
    const before = JSON.parse(JSON.stringify(approved));
    applyStage2Caps(approved);
    assert.deepEqual(approved, before);
  });

  it("preserva ordem original (slice mantém os primeiros N)", () => {
    const approved = {
      highlights: [],
      lancamento: [
        { url: "https://l/0" },
        { url: "https://l/1" },
        { url: "https://l/2" },
        { url: "https://l/3" },
        { url: "https://l/4" },
        { url: "https://l/5" },
        { url: "https://l/6" },
      ],
      pesquisa: [],
      noticias: [],
    };
    const { approved: capped } = applyStage2Caps(approved);
    assert.equal(capped.lancamento?.length, 5);
    assert.equal((capped.lancamento?.[0] as { url: string }).url, "https://l/0");
    assert.equal((capped.lancamento?.[4] as { url: string }).url, "https://l/4");
  });

  it("caso 260507: 3 dest + 2 lanç + 5 pesq + 20 outras → 3+2+3+4 (cap aplica)", () => {
    const approved = {
      highlights: [{ url: "h1" }, { url: "h2" }, { url: "h3" }],
      lancamento: [{ url: "l1" }, { url: "l2" }],
      pesquisa: [
        { url: "p1" },
        { url: "p2" },
        { url: "p3" },
        { url: "p4" },
        { url: "p5" },
      ],
      noticias: new Array(20).fill({}).map((_, i) => ({ url: `n${i}` })),
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(capped.highlights?.length, 3);
    assert.equal(capped.lancamento?.length, 2); // não cortou (≤5)
    assert.equal(capped.pesquisa?.length, 3); // truncou de 5 → 3
    assert.equal(capped.noticias?.length, 4); // max(2, 12-3-2-3) = 4
    assert.equal(report.truncated.pesquisa, 2);
    assert.equal(report.truncated.noticias, 16);
    assert.equal(report.caps.noticias, 4);
  });

  it("buckets ausentes/vazios viram arrays vazios no output", () => {
    const approved = {
      highlights: [],
      lancamento: undefined as unknown as [],
      pesquisa: [],
      noticias: [],
    };
    const { approved: capped } = applyStage2Caps(approved);
    assert.equal(capped.lancamento?.length, 0);
    assert.equal(capped.pesquisa?.length, 0);
    assert.equal(capped.noticias?.length, 0);
  });
});

describe("apply-stage2-caps CLI — coverage.line recalc (#906)", () => {
  it("CLI recalcula coverage.line/selected pós-caps quando coverage existe", async () => {
    // Importa o módulo só pra simular o que o CLI faria — testa via spawn
    // pra validar end-to-end.
    const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");

    const dir = mkdtempSync(join(tmpdir(), "apply-caps-cov-"));
    try {
      const inPath = join(dir, "01-approved.json");
      const outPath = join(dir, "01-approved-capped.json");
      writeFileSync(
        inPath,
        JSON.stringify({
          highlights: [{ url: "h1" }, { url: "h2" }, { url: "h3" }],
          lancamento: [{ url: "l1" }, { url: "l2" }],
          pesquisa: [
            { url: "p1" },
            { url: "p2" },
            { url: "p3" },
            { url: "p4" },
            { url: "p5" },
          ],
          noticias: new Array(20).fill({}).map((_, i) => ({ url: `n${i}` })),
          coverage: {
            editor_submitted: 5,
            diaria_discovered: 100,
            selected: 30, // erroneous pre-cap value
            line:
              "Para esta edição, eu (o editor) enviei 5 submissões e a Diar.ia encontrou outros 100 artigos. Selecionamos os 30 mais relevantes para as pessoas que assinam a newsletter.",
          },
        }),
        "utf8",
      );

      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "apply-stage2-caps.ts");
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--in", inPath, "--out", outPath],
        { cwd: projectRoot, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);

      const capped = JSON.parse(readFileSync(outPath, "utf8"));
      // Selected real: 3 + 2 + 3 + 4 = 12 (max(2, 12-3-2-3) = 4 outras)
      assert.equal(capped.coverage.selected, 12);
      assert.match(
        capped.coverage.line,
        /Selecionamos os 12 mais relevantes/,
      );
      assert.doesNotMatch(capped.coverage.line, /30 mais/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomic write não deixa .tmp órfão após sucesso (review #921 P1)", async () => {
    const { mkdtempSync, writeFileSync, existsSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { spawnSync } = await import("node:child_process");

    const dir = mkdtempSync(join(tmpdir(), "apply-caps-atomic-"));
    try {
      const inPath = join(dir, "01-approved.json");
      const outPath = join(dir, "01-approved-capped.json");
      writeFileSync(
        inPath,
        JSON.stringify({
          highlights: [{ url: "h1" }, { url: "h2" }, { url: "h3" }],
          lancamento: [{ url: "l1" }],
          pesquisa: [{ url: "p1" }],
          noticias: [{ url: "n1" }],
        }),
        "utf8",
      );

      const projectRoot = join(import.meta.dirname, "..");
      const scriptPath = join(projectRoot, "scripts", "apply-stage2-caps.ts");
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--in", inPath, "--out", outPath],
        { cwd: projectRoot, encoding: "utf8" },
      );
      assert.equal(r.status, 0, r.stderr);

      // Output existe e .tmp foi removido (rename atomico).
      assert.equal(existsSync(outPath), true, "outPath deve existir");
      assert.equal(
        existsSync(outPath + ".tmp"),
        false,
        ".tmp não deve ficar órfão após sucesso",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checkStage2Caps", () => {
  it("ok=true quando todos buckets dentro do cap", () => {
    const approved = {
      highlights: [{}, {}, {}],
      lancamento: new Array(5).fill({}),
      pesquisa: new Array(3).fill({}),
      noticias: new Array(2).fill({}), // cap = max(2, 12-3-5-3) = 2
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it("ok=false quando outras_noticias passa cap (caso 260507)", () => {
    const approved = {
      highlights: [{}, {}, {}],
      lancamento: [{}, {}], // 2
      pesquisa: [{}, {}, {}], // 3
      noticias: new Array(9).fill({}), // cap esperado = max(2, 12-3-2-3) = 4, real = 9
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /OUTRAS NOTÍCIAS: 9 > cap 4/);
  });

  it("detecta múltiplas violações simultâneas", () => {
    const approved = {
      highlights: [{}, {}, {}],
      lancamento: new Array(7).fill({}), // cap=5, real=7 → viola
      pesquisa: new Array(4).fill({}), // cap=3, real=4 → viola
      noticias: new Array(20).fill({}), // viola
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 3);
  });

  it("dentro do cap mesmo com 0 destaques", () => {
    const approved = {
      highlights: [],
      lancamento: new Array(5).fill({}),
      pesquisa: new Array(3).fill({}),
      noticias: new Array(4).fill({}), // max(2, 12-0-5-3) = 4
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
  });
});

describe("#1240 — dedup intra-edicao (remove highlights URLs dos buckets antes do cap)", () => {
  it("caso 260514: D2=Claude promovido de lancamento, e tambem listado em lancamento → removido", () => {
    // Cenario real edicao 260514: Claude for SB virou D2 (destaque) e tambem
    // estava em LANCAMENTOS como item secundario. Editor pediu remocao manual.
    // #1240: agora aplicado automaticamente em apply-stage2-caps.
    const approved = {
      highlights: [
        { url: "https://anthropic.com/news/claude-sb", bucket: "lancamento" },
        { url: "https://example.com/d1" },
        { url: "https://example.com/d3" },
      ],
      lancamento: [
        { url: "https://anthropic.com/news/claude-sb" }, // overlap
        { url: "https://google.com/blog/fraud" },
      ],
      pesquisa: [],
      noticias: [],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(capped.lancamento?.length, 1, "claude-sb removido, sobra google");
    assert.equal(capped.lancamento?.[0].url, "https://google.com/blog/fraud");
    assert.equal(report.removed_overlap.lancamento, 1);
    assert.equal(report.removed_overlap.pesquisa, 0);
    assert.equal(report.removed_overlap.noticias, 0);
  });

  it("caso 260511: 2 highlights de noticias E noticias bucket tem os mesmos → removidos", () => {
    // Pool: 10 noticias. Top 2 (n0, n1) viraram destaques.
    // #1240: dedup remove n0, n1 do bucket antes do cap. nCap = max(2, 12-3-1-1) = 7.
    // Bucket apos dedup tem 8 (n2..n9). Slice pra 7. Renderiza 7 outras = target ok.
    const noticias = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/n${i}`,
      title: `News ${i}`,
    }));
    const approved = {
      highlights: [
        { url: "https://example.com/n0", bucket: "noticias" },
        { url: "https://example.com/n1", bucket: "noticias" },
        { url: "https://other.com/lanc", bucket: "lancamento" },
      ],
      lancamento: [{ url: "https://x.com/l1" }],
      pesquisa: [{ url: "https://x.com/p1" }],
      noticias,
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.noticias, 2, "n0 e n1 removidos do bucket");
    assert.equal(report.caps.noticias, 7, "cap sem inflacao (#1071 obsoleto pos-#1240)");
    assert.equal(capped.noticias?.length, 7, "7 renderizadas = target editorial");
    // Confirma que n0 e n1 nao estao no output
    const outputUrls = (capped.noticias ?? []).map((n) => n.url);
    assert.ok(!outputUrls.includes("https://example.com/n0"));
    assert.ok(!outputUrls.includes("https://example.com/n1"));
  });

  it("URLs com tracking params canonicalizadas batem (utm_source ignorado)", () => {
    const approved = {
      highlights: [
        { url: "https://example.com/news?utm_source=newsletter" },
      ],
      noticias: [
        { url: "https://example.com/news" }, // mesma URL sem utm — overlap
        { url: "https://example.com/other" },
      ],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.noticias, 1, "canonicalize remove utm");
    assert.equal(capped.noticias?.length, 1);
    assert.equal(capped.noticias?.[0].url, "https://example.com/other");
  });

  it("sem overlap → buckets intactos, removed_overlap zerado", () => {
    const approved = {
      highlights: [
        { url: "https://example.com/dest1" },
        { url: "https://example.com/dest2" },
        { url: "https://example.com/dest3" },
      ],
      lancamento: [{ url: "https://example.com/l1" }],
      pesquisa: [{ url: "https://example.com/p1" }],
      noticias: [{ url: "https://example.com/n1" }, { url: "https://example.com/n2" }],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.lancamento, 0);
    assert.equal(report.removed_overlap.pesquisa, 0);
    assert.equal(report.removed_overlap.noticias, 0);
    assert.equal(capped.lancamento?.length, 1);
    assert.equal(capped.pesquisa?.length, 1);
    assert.equal(capped.noticias?.length, 2);
  });

  it("highlights vazio → buckets intactos", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://example.com/l1" }],
      noticias: Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/n${i}` })),
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.lancamento, 0);
    assert.equal(report.removed_overlap.noticias, 0);
    assert.equal(capped.noticias?.length, 5);
  });
});

describe("cap calculation pós-#1240 (sem inflacao do #1071)", () => {
  // #1071 destaquesFromBucket foi removida pos-#1240 (dedup direto substitui).
  it("destaques nenhum vindo de noticias → cap calculado sem inflacao", () => {
    const noticias = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/n${i}`,
    }));
    const approved = {
      highlights: [
        { url: "x", bucket: "lancamento" },
        { url: "y", bucket: "pesquisa" },
        { url: "z", bucket: "lancamento" },
      ],
      noticias,
    };
    const { report } = applyStage2Caps(approved);
    // max(2, 12-3-0-0) = 9 (cap direto, sem inflacao)
    assert.equal(report.caps.noticias, 9);
  });

  it("checkStage2Caps com noticias dentro do cap → ok=true", () => {
    const approved = {
      highlights: [
        { url: "x", bucket: "lancamento" },
        { url: "y", bucket: "lancamento" },
        { url: "z", bucket: "lancamento" },
      ],
      lancamento: [{ url: "l1" }],
      pesquisa: [{ url: "p1" }],
      // 7 noticias <= max(2, 12-3-1-1) = 7
      noticias: Array.from({ length: 7 }, (_, i) => ({ url: `n${i}` })),
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
    assert.equal(r.expectedCaps.noticias, 7);
  });
});
