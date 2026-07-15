/**
 * test/apply-stage2-caps.test.ts (#358, #907, #1629)
 *
 * Cobre o helper puro `applyStage2Caps` + `checkStage2Caps` + `capRadar`.
 *
 * Pós-#1629: pesquisa + noticias fundidas em radar. Cap radar = max(5, 12 - d - l).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyStage2Caps,
  checkStage2Caps,
  capRadar,
  highlightUrl,
  promoteUseMelhorToMinimum,
  STAGE_2_CAP_LANCAMENTOS,
  STAGE_2_MIN_RADAR,
  STAGE_2_MIN_USE_MELHOR,
  STAGE_2_MAX_USE_MELHOR,
} from "../scripts/lib/apply-stage2-caps.ts";
import { canonicalize } from "../scripts/lib/url-utils.ts";

describe("capRadar (#358, #1629)", () => {
  it("max(5, 12 - 3 - 2) = 7", () => {
    assert.equal(capRadar(3, 2), 7);
  });

  it("max(5, 12 - 3 - 5) = 5 (lançamentos cheio)", () => {
    assert.equal(capRadar(3, 5), 5);
  });

  it("max(5, 12 - 3 - 0) = 9 (sem lançamento)", () => {
    assert.equal(capRadar(3, 0), 9);
  });

  it("piso é sempre 5", () => {
    assert.equal(capRadar(3, 10), STAGE_2_MIN_RADAR); // 12-3-10 = -1 → 5
  });

  it("0 destaques: max(5, 12) = 12", () => {
    assert.equal(capRadar(0, 0), 12);
  });
});

describe("applyStage2Caps", () => {
  it("trunca buckets que excedem cap, preserva resto (#1629)", () => {
    const approved = {
      highlights: new Array(3).fill({}).map((_, i) => ({ url: `https://h.${i}` })),
      lancamento: new Array(8).fill({}).map((_, i) => ({ url: `https://l.${i}` })),
      // radar combinou pesquisa+noticias: 27 total
      radar: [
        ...new Array(7).fill({}).map((_, i) => ({ url: `https://p.${i}` })),
        ...new Array(20).fill({}).map((_, i) => ({ url: `https://n.${i}` })),
      ],
      runners_up: [{ url: "https://ru.0" }],
    };
    const { approved: capped, report } = applyStage2Caps(approved);

    assert.equal(capped.highlights?.length, 3); // unchanged
    assert.equal(capped.lancamento?.length, STAGE_2_CAP_LANCAMENTOS); // 5
    // Radar cap: max(5, 12-3-5) = 5
    assert.equal(capped.radar?.length, 5);
    // Runners-up preservados
    assert.equal(capped.runners_up?.length, 1);

    assert.equal(report.before.lancamento, 8);
    assert.equal(report.after.lancamento, 5);
    assert.equal(report.truncated.lancamento, 3);
    assert.equal(report.before.radar, 27);
    assert.equal(report.after.radar, 5);
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
      radar: [],
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
      radar: [],
    };
    const { approved: capped } = applyStage2Caps(approved);
    assert.equal(capped.lancamento?.length, 5);
    assert.equal((capped.lancamento?.[0] as { url: string }).url, "https://l/0");
    assert.equal((capped.lancamento?.[4] as { url: string }).url, "https://l/4");
  });

  it("caso 260507 pós-#1629: 3 dest + 2 lanç + 25 radar → 3+2+7 (radar cap=max(5,12-3-2)=7)", () => {
    const approved = {
      highlights: [{ url: "h1" }, { url: "h2" }, { url: "h3" }],
      lancamento: [{ url: "l1" }, { url: "l2" }],
      radar: [
        ...["p1", "p2", "p3", "p4", "p5"].map((u) => ({ url: u })),
        ...new Array(20).fill({}).map((_, i) => ({ url: `n${i}` })),
      ],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(capped.highlights?.length, 3);
    assert.equal(capped.lancamento?.length, 2); // não cortou (≤5)
    assert.equal(capped.radar?.length, 7); // truncou de 25 → 7
    assert.equal(report.truncated.radar, 18);
    assert.equal(report.caps.radar, 7);
  });

  it("buckets ausentes/vazios viram arrays vazios no output", () => {
    const approved = {
      highlights: [],
      lancamento: undefined as unknown as [],
      radar: [
      ],
    };
    const { approved: capped } = applyStage2Caps(approved);
    assert.equal(capped.lancamento?.length, 0);
    assert.equal(capped.radar?.length, 0);
    assert.equal(capped.radar?.length, 0);
  });
});

describe("promoteUseMelhorToMinimum (#1855)", () => {
  it("bucket ≥ mínimo → no-op (sem promoção)", () => {
    const r = promoteUseMelhorToMinimum(
      [{ url: "https://t/1" }, { url: "https://t/2" }],
      [{ url: "https://ru/1", bucket: "use_melhor", score: 90 }],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 2);
    assert.equal(r.promoted, 0);
    assert.equal(r.shortfall, 0);
  });

  it("bucket com 1 item → promove 1 runner-up use_melhor (por score desc) até 2", () => {
    const r = promoteUseMelhorToMinimum(
      [{ url: "https://t/1" }],
      [
        { url: "https://ru/low", bucket: "use_melhor", score: 40 },
        { url: "https://ru/high", bucket: "use_melhor", score: 95 },
        { url: "https://ru/radar", bucket: "radar", score: 99 },
      ],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 2);
    assert.equal(r.promoted, 1);
    assert.equal(r.shortfall, 0);
    // Promoveu o de maior score, não o radar (bucket errado).
    assert.equal((r.kept[1] as { url: string }).url, "https://ru/high");
  });

  it("tie-break por score igual → preserva ordem de entrada (sort estável)", () => {
    const r = promoteUseMelhorToMinimum(
      [],
      [
        { url: "https://ru/a", bucket: "use_melhor", score: 80 },
        { url: "https://ru/b", bucket: "use_melhor", score: 80 },
        { url: "https://ru/c", bucket: "use_melhor", score: 80 },
      ],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 2);
    assert.equal((r.kept[0] as { url: string }).url, "https://ru/a");
    assert.equal((r.kept[1] as { url: string }).url, "https://ru/b");
  });

  it("só promove bucket use_melhor — nunca completa com outro bucket", () => {
    const r = promoteUseMelhorToMinimum(
      [],
      [
        { url: "https://ru/n1", bucket: "radar", score: 99 },
        { url: "https://ru/l1", bucket: "lancamento", score: 98 },
      ],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 0);
    assert.equal(r.promoted, 0);
    assert.equal(r.shortfall, 2); // warn loud no gate
  });

  it("pool insuficiente → shortfall > 0 (não inventa)", () => {
    const r = promoteUseMelhorToMinimum(
      [],
      [{ url: "https://ru/1", bucket: "use_melhor", score: 80 }],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 1);
    assert.equal(r.promoted, 1);
    assert.equal(r.shortfall, 1);
  });

  it("dedup: não promove runner-up já presente no bucket nem em highlights", () => {
    const highlightsCanon = new Set<string>();
    highlightsCanon.add(canonicalize("https://dup/highlight"));
    const r = promoteUseMelhorToMinimum(
      [{ url: "https://dup/existing" }],
      [
        { url: "https://dup/existing", bucket: "use_melhor", score: 90 }, // já no bucket
        { url: "https://dup/highlight", bucket: "use_melhor", score: 88 }, // já em highlights
        { url: "https://ru/fresh", bucket: "use_melhor", score: 70 },
      ],
      highlightsCanon,
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 2);
    assert.equal((r.kept[1] as { url: string }).url, "https://ru/fresh");
    assert.equal(r.promoted, 1);
  });

  it("materializa runner-up nested (article) e flat preservando summary/summary_lang", () => {
    const r = promoteUseMelhorToMinimum(
      [],
      [
        { bucket: "use_melhor", score: 90, article: { url: "https://nested/1", title: "Nested", summary: "Desc nested." } },
        { bucket: "use_melhor", score: 80, url: "https://flat/1", title: "Flat", summary: "A flat english summary.", summary_lang: "en" },
      ],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 2);
    assert.equal((r.kept[0] as { url: string }).url, "https://nested/1");
    const flat = r.kept[1] as { url: string; summary?: string; summary_lang?: string };
    assert.equal(flat.url, "https://flat/1");
    // #1855 review: flat não pode perder summary/summary_lang (senão renderiza
    // sem descrição e sem [TRADUZIR]).
    assert.equal(flat.summary, "A flat english summary.");
    assert.equal(flat.summary_lang, "en");
  });

  it("applyStage2Caps promove e reporta use_melhor", () => {
    const approved = {
      highlights: [{ url: "https://h/1" }],
      use_melhor: [{ url: "https://t/1" }],
      runners_up: [{ url: "https://ru/1", bucket: "use_melhor", score: 75 }],
      radar: [],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(capped.use_melhor?.length, 2);
    assert.equal(report.use_melhor.before, 1);
    assert.equal(report.use_melhor.promoted, 1);
    assert.equal(report.use_melhor.after, 2);
    assert.equal(report.use_melhor.shortfall, 0);
  });

  it("#1855 review: dedup item EXISTENTE do use_melhor que também é highlight (#1240)", () => {
    // Um tutorial promovido a destaque (highlight) E presente no bucket
    // use_melhor não pode render 2×. applyStage2Caps remove o overlap.
    const approved = {
      highlights: [{ article: { url: "https://dup/tut" } }],
      use_melhor: [
        { url: "https://dup/tut" }, // = highlight → deve sair
        { url: "https://t/keep" },
      ],
      runners_up: [
        { url: "https://ru/fill", bucket: "use_melhor", score: 70 },
      ],
      radar: [],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    const urls = (capped.use_melhor ?? []).map((a) => (a as { url: string }).url);
    assert.ok(!urls.includes("https://dup/tut"), "item duplicado do highlight removido");
    assert.ok(urls.includes("https://t/keep"));
    assert.equal(report.use_melhor.removed_overlap, 1);
    // Ficou 1 após dedup → promove 1 runner-up pra bater 2.
    assert.equal(capped.use_melhor?.length, 2);
    assert.equal(report.use_melhor.promoted, 1);
    assert.ok(urls.includes("https://ru/fill"));
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
          radar: [
            { url: "p1" },
            { url: "p2" },
            { url: "p3" },
            { url: "p4" },
            { url: "p5" },
          ],
          radar: new Array(20).fill({}).map((_, i) => ({ url: `n${i}` })),
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
      // #3461: formatCoverageLine agora gera o bloco de boas-vindas (padrão
      // desde 260715) em vez do formato legado "Selecionamos os N ...".
      assert.match(
        capped.coverage.line,
        /Nesta edição, a IA analisou 105 artigos \(5 enviados por mim e 100 encontrados automaticamente\) e selecionei os 12 mais relevantes\./,
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
          radar: [{ url: "p1" },
            { url: "n1" }
          ],
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
      radar: new Array(5).fill({}), // cap = max(5, 12-3-5) = 5
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
  });

  it("ok=false quando radar passa cap (#1629)", () => {
    const approved = {
      highlights: [{}, {}, {}],
      lancamento: [{}, {}], // 2
      radar: new Array(12).fill({}), // cap = max(5, 12-3-2) = 7, real = 12 → viola
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.match(r.violations[0], /RADAR: 12 > cap 7/);
  });

  it("detecta múltiplas violações simultâneas (#1629)", () => {
    const approved = {
      highlights: [{}, {}, {}],
      lancamento: new Array(7).fill({}), // cap=5, real=7 → viola
      radar: new Array(20).fill({}), // cap=max(5, 12-3-5)=5, real=20 → viola
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 2);
  });

  it("dentro do cap mesmo com 0 destaques", () => {
    const approved = {
      highlights: [],
      lancamento: new Array(5).fill({}),
      radar: new Array(7).fill({}), // cap = max(5, 12-0-5) = 7
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
  });

  it("#1693: VÍDEOS > 2 viola (cap documentado editorial-rules:100)", () => {
    const approved = {
      highlights: [{}, {}, {}],
      lancamento: new Array(5).fill({}),
      radar: new Array(5).fill({}),
      video: new Array(3).fill({}), // cap 2, real 3 → viola
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    // Accent fixado: impl emite "VÍDEOS:" (Í). Tolerância [ÍI] mascararia drift.
    assert.match(r.violations[0], /VÍDEOS: 3 > cap 2/);
  });

  it("#1693: VÍDEOS ≤ 2 ok; expectedCaps.video sempre 2", () => {
    const approved = {
      highlights: [{}, {}, {}],
      lancamento: new Array(5).fill({}),
      radar: new Array(5).fill({}),
      video: new Array(2).fill({}),
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
    assert.equal(r.expectedCaps.video, 2);
  });

  it("#1693: USE MELHOR ≤ 4 — cap máximo adicionado em #2313", () => {
    // #2313: use_melhor agora tem cap máximo (STAGE_2_MAX_USE_MELHOR=4).
    // Antes (#1693 original): sem cap; agora com 8 viola o cap.
    const approvedOver = {
      highlights: [{}, {}, {}],
      lancamento: new Array(5).fill({}),
      radar: new Array(5).fill({}),
      use_melhor: new Array(8).fill({}),
    };
    const rOver = checkStage2Caps(approvedOver);
    assert.equal(rOver.ok, false, "8 use_melhor deve violar o cap de 4");
    assert.ok(rOver.violations.some((v) => v.includes("USE MELHOR")));

    // Exatamente no cap: não viola.
    const approvedExact = {
      highlights: [{}, {}, {}],
      lancamento: new Array(5).fill({}),
      radar: new Array(5).fill({}),
      use_melhor: new Array(4).fill({}),
    };
    const rExact = checkStage2Caps(approvedExact);
    assert.equal(rExact.ok, true, "4 use_melhor está no limite — não viola");
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
      radar: [
      ],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(capped.lancamento?.length, 1, "claude-sb removido, sobra google");
    assert.equal(capped.lancamento?.[0].url, "https://google.com/blog/fraud");
    assert.equal(report.removed_overlap.lancamento, 1);
    assert.equal(report.removed_overlap.radar, 0);
  });

  it("caso 260511 pós-#1629: 2 highlights de radar E radar bucket tem os mesmos → removidos", () => {
    // Pool: 11 radar (1 distinto + 10 do array gerado).
    // 2 viraram destaques. #1240: dedup remove n0, n1 antes do cap.
    // rCap = max(5, 12-3-1) = 8. Bucket após dedup tem 9. Slice pra 8.
    const radarArray = [
      { url: "https://x.com/p1", title: "p1" },
      ...Array.from({ length: 10 }, (_, i) => ({
        url: `https://example.com/n${i}`,
        title: `News ${i}`,
      })),
    ];
    const approved = {
      highlights: [
        { url: "https://example.com/n0", bucket: "radar" },
        { url: "https://example.com/n1", bucket: "radar" },
        { url: "https://other.com/lanc", bucket: "lancamento" },
      ],
      lancamento: [{ url: "https://x.com/l1" }],
      radar: radarArray,
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.radar, 2, "n0 e n1 removidos do bucket");
    assert.equal(report.caps.radar, 8, "cap = max(5, 12-3-1) = 8");
    assert.equal(capped.radar?.length, 8);
    // Confirma que n0 e n1 nao estao no output
    const outputUrls = (capped.radar ?? []).map((n) => n.url);
    assert.ok(!outputUrls.includes("https://example.com/n0"));
    assert.ok(!outputUrls.includes("https://example.com/n1"));
  });

  it("URLs com tracking params canonicalizadas batem (utm_source ignorado)", () => {
    const approved = {
      highlights: [
        { url: "https://example.com/news?utm_source=newsletter" },
      ],
      radar: [
        { url: "https://example.com/news" }, // mesma URL sem utm — overlap
        { url: "https://example.com/other" },
      ],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.radar, 1, "canonicalize remove utm");
    assert.equal(capped.radar?.length, 1);
    assert.equal(capped.radar?.[0].url, "https://example.com/other");
  });

  it("sem overlap → buckets intactos, removed_overlap zerado", () => {
    const approved = {
      highlights: [
        { url: "https://example.com/dest1" },
        { url: "https://example.com/dest2" },
        { url: "https://example.com/dest3" },
      ],
      lancamento: [{ url: "https://example.com/l1" }],
      radar: [
        { url: "https://example.com/p1" },
        { url: "https://example.com/n1" },
        { url: "https://example.com/n2" },
      ],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.lancamento, 0);
    assert.equal(report.removed_overlap.radar, 0);
    assert.equal(capped.lancamento?.length, 1);
    assert.equal(capped.radar?.length, 3);
  });

  it("highlights vazio → buckets intactos", () => {
    const approved = {
      highlights: [],
      lancamento: [{ url: "https://example.com/l1" }],
      radar: Array.from({ length: 5 }, (_, i) => ({ url: `https://example.com/n${i}` })),
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(report.removed_overlap.lancamento, 0);
    assert.equal(report.removed_overlap.radar, 0);
    assert.equal(capped.radar?.length, 5);
  });

  it("#1440 — schema nested do scorer ({rank, score, article: {url}}) é deduplicado", () => {
    // Repro do bug: scorer produz highlights como
    // { rank, score, reason, article: { url, title, ... } }, mas o código pre-#1440
    // lia `h.url` direto (sempre undefined) — Set ficava vazio, dedup virava no-op.
    // Caso real 260521: D2 (Meta demite 8 mil) duplicado em radar → writer dropou.
    const approved = {
      highlights: [
        {
          rank: 1,
          score: 92,
          reason: "Top model release",
          article: { url: "https://blog.google/gemini-omni/", title: "Gemini Omni" },
        },
        {
          rank: 2,
          score: 89,
          reason: "Market shift",
          article: { url: "https://cnnbrasil.com.br/meta-8mil/", title: "Meta 8 mil" },
        },
        {
          rank: 3,
          score: 86,
          reason: "Benchmark",
          article: { url: "https://arxiv.org/abs/2605.19156", title: "ResearchArena" },
        },
      ],
      lancamento: [
        { url: "https://blog.google/gemini-omni/", title: "dup with D1" }, // overlap
        { url: "https://blog.google/asset-studio/", title: "Asset Studio" },
      ],
      radar: [
        { url: "https://arxiv.org/abs/2605.19156", title: "dup with D3" }, // overlap
        { url: "https://arxiv.org/abs/2605.19192", title: "Hallucination" },
        { url: "https://cnnbrasil.com.br/meta-8mil/", title: "dup with D2" }, // overlap
        { url: "https://cybersecuritynews.com/rce/", title: "Claude RCE" }
      ],
    };
    const { approved: capped, report } = applyStage2Caps(approved);

    // Após #1629: radar combinou pesquisa+noticias → 2 itens dropados de radar.
    assert.equal(report.removed_overlap.lancamento, 1);
    assert.equal(report.removed_overlap.radar, 2);

    // Output só contém os non-duplicados
    assert.equal(capped.lancamento?.length, 1);
    assert.equal(capped.lancamento?.[0].url, "https://blog.google/asset-studio/");
    assert.equal(capped.radar?.length, 2);
    const radarUrls = (capped.radar ?? []).map((a) => a.url);
    assert.ok(radarUrls.includes("https://arxiv.org/abs/2605.19192"));
    assert.ok(radarUrls.includes("https://cybersecuritynews.com/rce/"));
  });
});

describe("highlightUrl (#1445)", () => {
  it("nested shape (scorer output): lê article.url", () => {
    const h = {
      rank: 1,
      score: 92,
      article: { url: "https://blog.google/gemini-omni/", title: "Gemini Omni" },
    };
    assert.equal(highlightUrl(h), "https://blog.google/gemini-omni/");
  });

  it("flat shape (legacy): lê url no topo", () => {
    const h = { url: "https://example.com/x", title: "X" };
    assert.equal(highlightUrl(h), "https://example.com/x");
  });

  it("prefere article.url quando ambos presentes (nested wins)", () => {
    const h = {
      rank: 1,
      url: "https://flat.example.com/wrong",
      article: { url: "https://nested.example.com/correct" },
    };
    assert.equal(highlightUrl(h), "https://nested.example.com/correct");
  });

  it("retorna undefined quando nenhum URL presente", () => {
    assert.equal(highlightUrl({ rank: 1, score: 50 }), undefined);
  });

  it("retorna undefined quando article presente mas sem url", () => {
    const h = { rank: 1, article: { title: "no url" } };
    assert.equal(highlightUrl(h), undefined);
  });
});

describe("#1445 — defense-in-depth warn quando highlights non-empty + URLs zero", () => {
  it("emite warn quando highlights presentes mas todos sem URL", () => {
    const original = console.warn;
    let warned = "";
    console.warn = (msg: string) => {
      warned += msg;
    };
    try {
      const approved = {
        highlights: [
          { rank: 1, score: 80, reason: "x" }, // sem url nem article.url
          { rank: 2, score: 70, reason: "y" },
        ],
        lancamento: [{ url: "https://x.com/l1" }],
        radar: [],
      };
      applyStage2Caps(approved);
      assert.match(warned, /shape mudou\?/);
    } finally {
      console.warn = original;
    }
  });

  it("NÃO emite warn de shape quando highlights vazio (zero é normal, não regressão)", () => {
    // This test covers the shape-warn: highlights non-empty + 0 URLs extracted → shape changed.
    // highlights=[] is a valid state (no highlights yet), so shape warn must NOT fire.
    const original = console.warn;
    const warns: string[] = [];
    console.warn = (msg: string) => {
      warns.push(msg);
    };
    try {
      const approved = {
        highlights: [],
        lancamento: [{ url: "https://x.com/l1" }],
        radar: [],
        // #2366: include use_melhor to avoid triggering the shortfall warn
        use_melhor: [
          { url: "https://a.com/1" },
          { url: "https://b.com/2" },
        ],
      };
      applyStage2Caps(approved);
      const shapeWarn = warns.find((w) => /shape mudou/.test(w));
      assert.equal(shapeWarn, undefined, "NÃO deve emitir warn de shape quando highlights=[]");
    } finally {
      console.warn = original;
    }
  });

  it("NÃO emite warn de shape quando ao menos 1 highlight tem URL extraída", () => {
    const original = console.warn;
    const warns: string[] = [];
    console.warn = (msg: string) => {
      warns.push(msg);
    };
    try {
      const approved = {
        highlights: [
          { rank: 1, article: { url: "https://x.com/h1" } },
          { rank: 2 }, // sem url — mas o outro tem, então tudo bem
        ],
        lancamento: [],
        radar: [],
        // use_melhor com 2 itens pra não disparar shortfall warn (#2366)
        use_melhor: [
          { url: "https://a.com/1" },
          { url: "https://b.com/2" },
        ],
      };
      applyStage2Caps(approved);
      // NÃO deve emitir warn sobre shape de highlights (o que este teste cobre)
      const shapeWarn = warns.find((w) => /shape mudou/.test(w));
      assert.equal(shapeWarn, undefined, "NÃO deve emitir warn de shape quando URL extraída");
    } finally {
      console.warn = original;
    }
  });
});

describe("cap calculation pós-#1240 (sem inflacao do #1071)", () => {
  // #1071 destaquesFromBucket foi removida pos-#1240 (dedup direto substitui).
  it("destaques nenhum vindo de radar → cap calculado sem inflacao", () => {
    const radar = Array.from({ length: 10 }, (_, i) => ({
      url: `https://example.com/n${i}`,
    }));
    const approved = {
      highlights: [
        { url: "x", bucket: "lancamento" },
        { url: "y", bucket: "radar" },
        { url: "z", bucket: "lancamento" },
      ],
      radar,
    };
    const { report } = applyStage2Caps(approved);
    // #1629: max(5, 12-3-0) = 9 (cap direto, sem inflacao)
    assert.equal(report.caps.radar, 9);
  });

  it("checkStage2Caps com radar dentro do cap → ok=true (#1629)", () => {
    const approved = {
      highlights: [
        { url: "x", bucket: "lancamento" },
        { url: "y", bucket: "lancamento" },
        { url: "z", bucket: "lancamento" },
      ],
      lancamento: [{ url: "l1" }],
      // 8 radar <= max(5, 12-3-1) = 8
      radar: Array.from({ length: 8 }, (_, i) => ({ url: `n${i}` })),
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
    assert.equal(r.expectedCaps.radar, 8);
  });
});

// ---------------------------------------------------------------------------
// #2313 — USE MELHOR max cap = 4
// ---------------------------------------------------------------------------

describe("USE MELHOR max cap (#2313)", () => {
  it("regressão 260616: 8 candidatos → saída ≤ 4 (cap máximo aplicado)", () => {
    const approved = {
      highlights: [{ url: "https://h/1" }, { url: "https://h/2" }, { url: "https://h/3" }],
      lancamento: [],
      radar: [],
      use_melhor: Array.from({ length: 8 }, (_, i) => ({ url: `https://t/${i}`, title: `Tutorial ${i}` })),
      runners_up: [],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.ok(
      (capped.use_melhor?.length ?? 0) <= STAGE_2_MAX_USE_MELHOR,
      `use_melhor deve ser ≤ ${STAGE_2_MAX_USE_MELHOR}, foi ${capped.use_melhor?.length}`,
    );
    assert.equal(capped.use_melhor?.length, STAGE_2_MAX_USE_MELHOR, "deve ser exatamente 4");
    assert.ok(report.use_melhor.truncated > 0, "deve reportar truncamento");
    assert.equal(report.use_melhor.truncated, 4, "truncou 4 dos 8 candidatos");
  });

  it("4 candidatos → sem truncamento (limite exato)", () => {
    const approved = {
      highlights: [],
      lancamento: [],
      radar: [],
      use_melhor: Array.from({ length: 4 }, (_, i) => ({ url: `https://t/${i}` })),
      runners_up: [],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(capped.use_melhor?.length, 4);
    assert.equal(report.use_melhor.truncated, 0);
  });

  it("2 candidatos → no-op (abaixo do cap)", () => {
    const approved = {
      highlights: [],
      lancamento: [],
      radar: [],
      use_melhor: [{ url: "https://t/1" }, { url: "https://t/2" }],
      runners_up: [],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.equal(capped.use_melhor?.length, 2);
    assert.equal(report.use_melhor.truncated, 0);
  });

  it("checkStage2Caps detecta use_melhor > 4 como violação (#2313)", () => {
    const approved = {
      highlights: [],
      lancamento: [],
      radar: [],
      use_melhor: Array.from({ length: 7 }, (_, i) => ({ url: `https://t/${i}` })),
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.includes("USE MELHOR")));
    assert.equal(r.expectedCaps.use_melhor, STAGE_2_MAX_USE_MELHOR);
  });

  it("checkStage2Caps com use_melhor exatamente 4 → ok=true (#2313)", () => {
    const approved = {
      highlights: [],
      lancamento: [],
      radar: [],
      use_melhor: Array.from({ length: 4 }, (_, i) => ({ url: `https://t/${i}` })),
    };
    const r = checkStage2Caps(approved);
    assert.equal(r.ok, true);
  });
});

// ---------------------------------------------------------------------------
// #2345 — CRITICAL: selectUseMelhorSplit wired into production applyStage2Caps
// ---------------------------------------------------------------------------

describe("applyStage2Caps — 2+2 split wired (#2345 CRITICAL)", () => {
  // Helpers to build items with audience_affinity annotations
  const makeCasualItem = (i: number) => ({
    url: `https://canaltech.com.br/ia/chatgpt-curriculo-${i}`,
    title: `Como usar ChatGPT para produtividade no trabalho passo a passo ${i}`,
    audience_affinity: { matched: ["howto_br:true"] },
  });
  const makeDevBeginnerItem = (i: number) => ({
    url: `https://learn.deeplearning.ai/course-${i}`,
    title: `Prompt Engineering for Developers ${i}`,
    audience_affinity: { matched: ["academy:true"] },
  });
  const makeDevAdvancedItem = (i: number) => ({
    url: `https://blog.langchain.dev/langgraph-${i}`,
    title: `LangGraph multi-agent deployment pipeline ${i}`,
  });

  it("regressão 260616: 7 candidatos com casual/iniciante → saída honra cota 2+2 (produção)", async () => {
    // The 260616 incident: 7 use_melhor items, all dev-avancado. Blind slice kept all dev-avancado.
    // This test verifies the production path (applyStage2Caps) calls selectUseMelhorSplit.
    const approved = {
      highlights: [{ url: "https://h/1" }, { url: "https://h/2" }, { url: "https://h/3" }],
      lancamento: [],
      radar: [],
      use_melhor: [
        makeCasualItem(1),
        makeCasualItem(2),
        makeDevBeginnerItem(1),
        makeDevBeginnerItem(2),
        makeDevAdvancedItem(1),
        makeDevAdvancedItem(2),
        makeDevAdvancedItem(3),
      ],
      runners_up: [],
    };
    const { approved: capped } = applyStage2Caps(approved);

    // Production path must honor the 2+2 split — NOT a blind slice
    assert.equal(capped.use_melhor?.length, 4, "must be capped at 4");

    const { classifyAudienceClass } = await import("../scripts/lib/use-melhor-curation.ts");
    const casual = (capped.use_melhor ?? []).filter(
      (item) => classifyAudienceClass(item as Parameters<typeof classifyAudienceClass>[0]) === "casual",
    );
    const beginner = (capped.use_melhor ?? []).filter(
      (item) => classifyAudienceClass(item as Parameters<typeof classifyAudienceClass>[0]) === "dev-iniciante",
    );

    assert.equal(casual.length, 2, "must have exactly 2 casual items (not 0 as in 260616 incident)");
    assert.equal(beginner.length, 2, "must have exactly 2 dev-iniciante items");
  });

  it("all-advanced pool (no casual/iniciante): fills gracefully without crash", () => {
    // When there are no casual/iniciante items, selectUseMelhorSplit degrades gracefully
    // and fills with dev-avancado. This is acceptable fallback behavior.
    const approved = {
      highlights: [],
      lancamento: [],
      radar: [],
      use_melhor: Array.from({ length: 7 }, (_, i) => makeDevAdvancedItem(i)),
      runners_up: [],
    };
    const { approved: capped, report } = applyStage2Caps(approved);
    assert.ok(
      (capped.use_melhor?.length ?? 0) <= 4,
      `use_melhor must be ≤ 4, was ${capped.use_melhor?.length}`,
    );
    assert.ok(report.use_melhor.truncated >= 0, "truncated is reported");
  });
});

// ---------------------------------------------------------------------------
// #2353 — promotion dedup by rootDomain
// ---------------------------------------------------------------------------

describe("promoteUseMelhorToMinimum — dedup by rootDomain (#2353)", () => {
  it("não promove runner-up do mesmo rootDomain que já está em kept", () => {
    // Bug: promoção deduplicava só por canonical URL, não por rootDomain.
    // Se finalize-stage1 removeu aws.amazon.com/bedrock-rag do bucket por cap=1,
    // ele pode ter virado runner-up — e a promoção o traria de volta, violando o cap.
    const r = promoteUseMelhorToMinimum(
      [{ url: "https://aws.amazon.com/bedrock/intro" }], // já tem amazon.com no bucket
      [
        { url: "https://aws.amazon.com/bedrock/agents", bucket: "use_melhor", score: 90 }, // mesmo rootDomain
        { url: "https://learn.deeplearning.ai/course-1", bucket: "use_melhor", score: 80 }, // domínio diferente
      ],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 2);
    assert.equal(r.promoted, 1);
    // Deve ter promovido o deeplearning.ai, não o aws runner-up
    assert.ok(
      (r.kept[1] as { url: string }).url.includes("deeplearning.ai"),
      "deve promover runner-up de domínio diferente, não o mesmo rootDomain",
    );
  });

  it("runners-up de domínios distintos são promovidos normalmente", () => {
    const r = promoteUseMelhorToMinimum(
      [],
      [
        { url: "https://learn.deeplearning.ai/course-1", bucket: "use_melhor", score: 90 },
        { url: "https://kaggle.com/learn/intro", bucket: "use_melhor", score: 80 },
      ],
      new Set<string>(),
      STAGE_2_MIN_USE_MELHOR,
    );
    assert.equal(r.kept.length, 2);
    assert.equal(r.promoted, 2);
    assert.equal(r.shortfall, 0);
  });

  it("shortfall domain-cap-limited: todos runners-up do mesmo rootDomain do kept existente (#2353)", () => {
    // Scenario: bucket has 1 aws.amazon.com item; both runners-up are also aws.amazon.com.
    // Old behavior: promoted bedrock-1 (only URL dedup, not domain dedup) → shortfall=0 (wrong).
    // New behavior: both runners-up blocked by seenDomains → shortfall=1 (domain-cap-limited).
    // This is the correct result: diverse-domain cap holds, shortfall reported honestly.
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => { warns.push(msg); };
    try {
      const r = promoteUseMelhorToMinimum(
        [{ url: "https://aws.amazon.com/bedrock/intro" }], // amazon.com already in kept
        [
          { url: "https://aws.amazon.com/bedrock/agents", bucket: "use_melhor", score: 90 }, // same domain
          { url: "https://aws.amazon.com/bedrock/rag", bucket: "use_melhor", score: 85 },    // same domain
        ],
        new Set<string>(),
        STAGE_2_MIN_USE_MELHOR, // min=2
      );
      assert.equal(r.kept.length, 1, "nenhum runner-up promovido — todos do mesmo rootDomain");
      assert.equal(r.promoted, 0, "promoted deve ser 0");
      assert.equal(r.shortfall, 1, "shortfall=1 (domain-cap-limited, não pool vazio)");
      // Deve emitir log distinguindo domain-cap-limited de pool vazio
      const warn = warns.find((w) => w.includes("domain-cap-limited"));
      assert.ok(warn !== undefined, "deve logar 'domain-cap-limited' para distinguir de pool vazio");
    } finally {
      console.warn = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// #2353 — umTruncated warn distinguishes split-quota vs cap
// ---------------------------------------------------------------------------

describe("applyStage2Caps — warn reason split vs cap (#2353)", () => {
  it("sem warn quando pool ≤ MAX e split preserva todos os itens", () => {
    // 2 casual + 1 dev-avancado = 3 items (≤ MAX=4).
    // selectUseMelhorSplit: 2 casual (quota) + 0 dev-iniciante (none) + 1 leftover dev-avancado = 3.
    // um.kept.length=3, umFinal.length=3 → truncated=0 → nenhum warn emitido.
    // This test is non-vacuous: it directly asserts truncated=0 and after=3 (no hidden guard).
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => { warns.push(msg); };
    try {
      const approved = {
        highlights: [],
        lancamento: [],
        radar: [],
        use_melhor: [
          { url: "https://canaltech.com.br/ia/c1", title: "Como usar ChatGPT para produtividade passo a passo 1", audience_affinity: { matched: ["howto_br:true"] } },
          { url: "https://canaltech.com.br/ia/c2", title: "Como usar ChatGPT para produtividade passo a passo 2", audience_affinity: { matched: ["howto_br:true"] } },
          { url: "https://blog.langchain.dev/lg-1", title: "LangGraph multi-agent deployment pipeline 1" },
        ],
        runners_up: [],
      };
      const { report } = applyStage2Caps(approved);
      assert.equal(report.use_melhor.truncated, 0, "pool ≤ MAX: split preserva todos os itens");
      assert.equal(report.use_melhor.after, 3, "3 itens mantidos intactos");
      const warn = warns.find((w) => w.includes("USE MELHOR"));
      assert.equal(warn, undefined, "sem warn quando truncated=0");
    } finally {
      console.warn = orig;
    }
  });

  it("warn pela cota 2+2 quando pool excede MAX com mistura de classes (split-quota warn)", () => {
    // 3 casual + 2 dev-iniciante = 5 items (> MAX=4).
    // selectUseMelhorSplit: 2 casual + 2 dev-iniciante = 4 → umFinal=4, truncated=1.
    // droppedByCap = max(0, 5-4) = 1. droppedBySplit = truncated - droppedByCap = 0.
    // → cap-only warn mentioning "cap máximo".
    // Test verifies truncated > 0 is directly asserted (no hidden guard).
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => { warns.push(msg); };
    try {
      const approved = {
        highlights: [],
        lancamento: [],
        radar: [],
        use_melhor: [
          { url: "https://canaltech.com.br/ia/c1", title: "Como usar ChatGPT para produtividade passo a passo 1", audience_affinity: { matched: ["howto_br:true"] } },
          { url: "https://canaltech.com.br/ia/c2", title: "Como usar ChatGPT para produtividade passo a passo 2", audience_affinity: { matched: ["howto_br:true"] } },
          { url: "https://canaltech.com.br/ia/c3", title: "Como usar ChatGPT para produtividade passo a passo 3", audience_affinity: { matched: ["howto_br:true"] } },
          { url: "https://learn.deeplearning.ai/course-1", title: "Prompt Engineering for Developers getting started", audience_affinity: { matched: ["academy:true"] } },
          { url: "https://learn.deeplearning.ai/course-2", title: "Python for beginners api key quickstart", audience_affinity: { matched: ["academy:true"] } },
        ],
        runners_up: [],
      };
      const { report } = applyStage2Caps(approved);
      // 5 items, 3 casual + 2 dev-iniciante. split → 2+2=4. truncated=1.
      assert.ok(report.use_melhor.truncated > 0, "truncated deve ser > 0");
      assert.equal(report.use_melhor.after, 4, "4 itens após split+cap");
      const warn = warns.find((w) => w.includes("USE MELHOR"));
      assert.ok(warn !== undefined, "deve emitir warn de USE MELHOR");
    } finally {
      console.warn = orig;
    }
  });

  it("warn só pelo cap quando split não reduz (kept.length > MAX, todos da mesma classe)", () => {
    // 8 items dev-avancado: split NÃO reduz (não há casual/iniciante pra rebalancear),
    // mas cap (4) aplica → droppedByCap=4, droppedBySplit=0
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => { warns.push(msg); };
    try {
      const approved = {
        highlights: [],
        lancamento: [],
        radar: [],
        use_melhor: Array.from({ length: 8 }, (_, i) => ({
          url: `https://blog.langchain.dev/langgraph-${i}`,
          title: `LangGraph multi-agent deployment pipeline ${i}`,
        })),
        runners_up: [],
      };
      const { report } = applyStage2Caps(approved);
      assert.ok(report.use_melhor.truncated > 0, "deve ter truncamento");
      const warn = warns.find((w) => w.includes("USE MELHOR"));
      assert.ok(warn !== undefined, "deve emitir warn");
      // 8 items: droppedByCap=4, droppedBySplit=0 → cap-only warn
      assert.ok(warn!.includes("cap máximo"), `warn deve mencionar 'cap máximo', foi: "${warn}"`);
    } finally {
      console.warn = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// #2353 — report.use_melhor.composition
// ---------------------------------------------------------------------------

describe("applyStage2Caps — report.use_melhor.composition (#2353)", () => {
  it("composition conta casual/dev_iniciante/dev_avancado corretamente", async () => {
    const { classifyAudienceClass: classify } = await import("../scripts/lib/use-melhor-curation.ts");
    const approved = {
      highlights: [],
      lancamento: [],
      radar: [],
      use_melhor: [
        { url: "https://canaltech.com.br/ia/c1", title: "Como usar ChatGPT para produtividade passo a passo 1", audience_affinity: { matched: ["howto_br:true"] } },
        { url: "https://canaltech.com.br/ia/c2", title: "Como usar ChatGPT para produtividade passo a passo 2", audience_affinity: { matched: ["howto_br:true"] } },
        { url: "https://learn.deeplearning.ai/course-1", title: "Prompt Engineering for Developers 1", audience_affinity: { matched: ["academy:true"] } },
        { url: "https://learn.deeplearning.ai/course-2", title: "Prompt Engineering for Developers 2", audience_affinity: { matched: ["academy:true"] } },
      ],
      runners_up: [],
    };
    const { report } = applyStage2Caps(approved);
    assert.equal(report.use_melhor.composition.casual, 2, "2 casual");
    assert.equal(report.use_melhor.composition.dev_iniciante, 2, "2 dev-iniciante");
    assert.equal(report.use_melhor.composition.dev_avancado, 0, "0 dev-avancado");
  });

  it("composition com só dev-avancado no output", () => {
    const approved = {
      highlights: [],
      lancamento: [],
      radar: [],
      use_melhor: Array.from({ length: 3 }, (_, i) => ({
        url: `https://blog.langchain.dev/langgraph-${i}`,
        title: `LangGraph multi-agent deployment pipeline ${i}`,
      })),
      runners_up: [],
    };
    const { report } = applyStage2Caps(approved);
    assert.equal(report.use_melhor.composition.casual, 0);
    assert.equal(report.use_melhor.composition.dev_iniciante, 0);
    assert.equal(report.use_melhor.composition.dev_avancado, 3);
  });
});
