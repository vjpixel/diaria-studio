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
