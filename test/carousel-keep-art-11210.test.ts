/**
 * test/carousel-keep-art-11210.test.ts (#11210)
 *
 * Caso real (edição 261027, gate 4): o editor reparagrafou o texto social de
 * d2 e d3 e pediu para MANTER o carrossel antigo. Sem como registrar isso,
 * `carousel-cards-stale` e `carousel-text-overflow` bloqueavam o gate e o
 * `gen-carousel-cards.ts` abortava a geração de TODOS os destaques (inclusive
 * o 4º post). `_internal/carousel-keep-art.json` registra a exceção por
 * destaque: as violações viram warning citando o motivo (nunca silenciam) e o
 * gerador pula só o destaque mantido.
 */

import { describe, it, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CAROUSEL_SLIDE_SLOTS,
  carouselSlideFilename,
  readCarouselSourceHashes,
  writeCarouselSourceHashes,
} from "../scripts/lib/daily-carousel-card.ts";
import {
  checkCarouselCardsStale,
  checkCarouselTextOverflow,
  checkCarouselCardsMissing,
} from "../scripts/lib/invariant-checks/stage-4.ts";
import { STAGE_2_RULES } from "../scripts/lib/invariant-checks/stage-2.ts";
import {
  parseCarouselKeepArt,
  readCarouselKeepArt,
  readCarouselKeepArtSafe,
  carouselKeepArtPath,
} from "../scripts/lib/carousel-keep-art.ts";
import { genCarouselCards, type RenderUseMelhorSlidesFn } from "../scripts/gen-carousel-cards.ts";
import { writeUseMelhorPostState, type UseMelhorPostConfigState } from "../scripts/lib/use-melhor-post.ts";
import { useMelhorSlideFilename } from "../scripts/lib/use-melhor-carousel.ts";

const OFF: UseMelhorPostConfigState = { enabled: false, time: null, reason: "off" };
const ON: UseMelhorPostConfigState = { enabled: true, time: "07:45" };
const MOTIVO = "editor reparagrafou só o texto (261027)";

const paraDe = (n: number): string => {
  let s = "";
  while (s.length < n) s += (s ? " " : "") + "palavra";
  return s.slice(0, n).trim();
};
const CURTO = ["Primeiro parágrafo.", "Segundo parágrafo.", "Terceiro parágrafo."].join("\n\n");
const ESTOURA = [paraDe(80), paraDe(800), paraDe(90)].join("\n\n");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function makeEdition(texts: { d1: string; d2: string; d3: string; um?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "diaria-keep-art-11210-"));
  dirs.push(dir);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(
    join(dir, "_internal", "01-approved-capped.json"),
    JSON.stringify({
      highlights: [{}, {}, {}],
      use_melhor: [{ url: "https://fast.com/b", title: "Guia B", summary: "Resumo B", score: 83 }],
    }),
  );
  const md = ["# Social", "", "## d1", "", texts.d1, "", "## d2", "", texts.d2, "", "## d3", "", texts.d3, ""];
  if (texts.um) md.push("## um", "", texts.um, "");
  writeFileSync(join(dir, "03-social.md"), md.join("\n"), "utf8");
  return dir;
}

function writeSlides(dir: string, d: string, content = "arte-antiga"): void {
  for (const slot of CAROUSEL_SLIDE_SLOTS) writeFileSync(join(dir, carouselSlideFilename(d, slot)), content);
}

function writeKeepArt(dir: string, value: unknown): void {
  writeFileSync(carouselKeepArtPath(dir), typeof value === "string" ? value : JSON.stringify(value));
}

describe("carousel-keep-art.ts — leitor (#11210)", () => {
  it("arquivo ausente: {} (comportamento de sempre)", () => {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    assert.deepEqual(readCarouselKeepArt(dir), {});
    assert.deepEqual(readCarouselKeepArtSafe(dir), { keepArt: {}, error: null });
  });

  it("entrada válida: destaque → motivo (trim)", () => {
    assert.deepEqual(parseCarouselKeepArt({ d2: `  ${MOTIVO} `, d3: "x" }), { d2: MOTIVO, d3: "x" });
  });

  it("JSON malformado, valor vazio, chave inválida e não-objeto LANÇAM", () => {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    writeKeepArt(dir, "{ d2: ");
    assert.throws(() => readCarouselKeepArt(dir), /não é JSON válido/);
    assert.throws(() => parseCarouselKeepArt({ d2: "   " }), /string não vazia/);
    assert.throws(() => parseCarouselKeepArt({ d2: 3 }), /string não vazia/);
    assert.throws(() => parseCarouselKeepArt({ um: "x" }), /chave 'um'/);
    assert.throws(() => parseCarouselKeepArt(["d2"]), /objeto JSON/);
    const safe = readCarouselKeepArtSafe(dir);
    assert.deepEqual(safe.keepArt, {});
    assert.match(safe.error ?? "", /#11210/);
  });
});

describe("carousel-cards-stale com exceção (#11210)", () => {
  function staleEdition(): string {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    for (const d of ["d1", "d2", "d3"]) writeSlides(dir, d);
    writeCarouselSourceHashes(dir, { d1: "carimbo-velho-1", d2: "carimbo-velho-2", d3: "carimbo-velho-3" });
    return dir;
  }

  it("sem exceção: divergência segue ERROR (comportamento inalterado)", () => {
    const v = checkCarouselCardsStale(staleEdition());
    assert.equal(v.length, 3);
    assert.ok(v.every((x) => x.rule === "carousel-cards-stale" && x.severity === "error"));
  });

  it("com exceção para d2: d2 vira WARNING citando o motivo; d1/d3 seguem error", () => {
    const dir = staleEdition();
    writeKeepArt(dir, { d2: MOTIVO });
    const v = checkCarouselCardsStale(dir);
    assert.equal(v.length, 3, "nunca silencia");
    const d2 = v.find((x) => x.message.includes("slides de d2"));
    assert.ok(d2);
    assert.equal(d2.severity, "warning");
    assert.ok(d2.message.includes(MOTIVO), "cita o motivo do editor");
    assert.equal(v.filter((x) => x.severity === "error").length, 2);
  });

  it("exceção malformada: nenhuma exceção vale (tudo segue error)", () => {
    const dir = staleEdition();
    writeKeepArt(dir, { d2: "" });
    assert.ok(checkCarouselCardsStale(dir).every((x) => x.severity === "error"));
  });
});

describe("carousel-text-overflow com exceção (#11210)", () => {
  it("sem exceção: overflow segue ERROR", () => {
    const dir = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO });
    writeSlides(dir, "d2");
    const v = checkCarouselTextOverflow(dir, OFF);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
  });

  it("com exceção e arte no disco: WARNING citando o motivo (Stage 4 e Stage 2)", () => {
    const dir = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO });
    writeSlides(dir, "d2");
    writeKeepArt(dir, { d2: MOTIVO });
    const v = checkCarouselTextOverflow(dir, OFF);
    assert.equal(v.length, 1, "nunca silencia");
    assert.equal(v[0].rule, "carousel-text-overflow");
    assert.equal(v[0].severity, "warning");
    assert.ok(v[0].message.includes(MOTIVO));
    assert.match(v[0].message, /## d2/);

    const stage2 = STAGE_2_RULES.find((r) => r.id === "carousel-text-overflow");
    assert.ok(stage2);
    const v2 = stage2.run(dir);
    assert.ok(v2.some((x) => x.severity === "warning" && x.message.includes(MOTIVO)));
    assert.ok(!v2.some((x) => x.severity === "error" && x.message.includes("## d2")));
  });

  it("com exceção mas SEM arte no disco: segue ERROR (não há o que manter)", () => {
    const dir = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO });
    writeKeepArt(dir, { d2: MOTIVO });
    const v = checkCarouselTextOverflow(dir, OFF);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /não vale/);
  });

  it("JSON malformado é reportado como ERROR, nunca ignorado", () => {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    writeKeepArt(dir, "não é json");
    const v = checkCarouselTextOverflow(dir, OFF);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.equal(v[0].file, carouselKeepArtPath(dir));
  });

  it("valor vazio é reportado como ERROR", () => {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    writeKeepArt(dir, { d3: "" });
    const v = checkCarouselTextOverflow(dir, OFF);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "error");
    assert.match(v[0].message, /'d3' precisa ser o motivo/);
  });
});

describe("carousel-cards-missing não é escondido pela exceção (#11210)", () => {
  it("exceção para todos com carrossel ausente: segue ERROR", () => {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    writeKeepArt(dir, { d1: MOTIVO, d2: MOTIVO, d3: MOTIVO });
    const v = checkCarouselCardsMissing(dir);
    assert.equal(v.length, 1);
    assert.equal(v[0].rule, "carousel-cards-missing");
    assert.equal(v[0].severity, "error");
  });
});

describe("gen-carousel-cards com exceção (#11210)", () => {
  const P = (s: string) => `${s} **Trecho em negrito.** Fim.`;
  const UM = [P("Um guia prático para planilhas."), P("Como pedir fórmulas."), "#IA"].join("\n\n");

  function setupUm(dir: string): void {
    writeUseMelhorPostState(dir, {
      enabled: true,
      time: "07:45",
      item: { url: "https://fast.com/b", title: "Guia B", summary: "", score: 83 },
      generated_at: "x",
    });
  }

  function renders() {
    const destaques: string[] = [];
    const um: string[][] = [];
    const render = async (texto: string, outPaths: Record<string, string>) => {
      destaques.push(texto.slice(0, 20));
      for (const p of Object.values(outPaths)) writeFileSync(p, "arte-nova");
      return outPaths as never;
    };
    const renderUseMelhor: RenderUseMelhorSlidesFn = async (d, slides) => {
      um.push(slides.map((s) => s.slot));
      return slides.map((s) => {
        const p = join(d, useMelhorSlideFilename(s.slot));
        writeFileSync(p, "um");
        return p;
      });
    };
    return { destaques, um, render, renderUseMelhor };
  }

  it("sem exceção: d2 estourando ABORTA tudo (inclusive o 4º post)", async () => {
    const dir = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO, um: UM });
    setupUm(dir);
    const r = renders();
    await assert.rejects(
      () => genCarouselCards(dir, { render: r.render, useMelhorConfig: ON, renderUseMelhor: r.renderUseMelhor }),
      /não cabem no card/,
    );
    assert.equal(r.destaques.length, 0);
    assert.equal(r.um.length, 0);
  });

  it("com exceção para d2: não aborta, gera d1/d3/um e mantém a arte de d2", async () => {
    const dir = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO, um: UM });
    setupUm(dir);
    writeSlides(dir, "d2", "arte-antiga");
    writeCarouselSourceHashes(dir, { d2: "carimbo-antigo-d2" });
    writeKeepArt(dir, { d2: MOTIVO });
    const r = renders();

    const result = await genCarouselCards(dir, { render: r.render, useMelhorConfig: ON, renderUseMelhor: r.renderUseMelhor });

    assert.equal(r.destaques.length, 2, "renderizou só d1 e d3");
    assert.equal(r.um.length, 1, "4º post gerado");
    assert.equal(result.use_melhor?.status, "generated");
    assert.deepEqual(result.skipped, [{ destaque: "d2", reason: "arte mantida pelo editor (carousel-keep-art.json)" }]);
    for (const slot of CAROUSEL_SLIDE_SLOTS) {
      const p = join(dir, carouselSlideFilename("d2", slot));
      assert.equal(readFileSync(p, "utf8"), "arte-antiga", "arte de d2 intocada");
      assert.ok(result.generated.includes(p), "slides existentes de d2 seguem contando como presentes");
      assert.equal(readFileSync(join(dir, carouselSlideFilename("d1", slot)), "utf8"), "arte-nova");
      assert.equal(readFileSync(join(dir, carouselSlideFilename("d3", slot)), "utf8"), "arte-nova");
    }
    const stamps = readCarouselSourceHashes(dir);
    assert.equal(stamps.d2, "carimbo-antigo-d2", "não grava carimbo novo pro destaque mantido");
    assert.ok(stamps.d1 && stamps.d3);
  });

  it("exceção com arte PARCIAL/ausente não vale: o destaque gera normalmente e o overflow aborta", async () => {
    // Arte incompleta (ex.: swap-destaque apagou o carrossel) — nada a manter.
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    writeFileSync(join(dir, carouselSlideFilename("d2", "p1")), "parcial");
    writeKeepArt(dir, { d2: MOTIVO });
    const r = renders();
    const result = await genCarouselCards(dir, { render: r.render, useMelhorConfig: OFF });
    assert.equal(r.destaques.length, 3, "d2 também renderiza");
    assert.deepEqual(result.skipped, []);
    assert.ok(readCarouselSourceHashes(dir).d2, "d2 ganha carimbo como qualquer outro");

    const dir2 = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO });
    writeKeepArt(dir2, { d2: MOTIVO });
    await assert.rejects(() => genCarouselCards(dir2, { render: r.render, useMelhorConfig: OFF }), /não cabem no card/);
  });

  it("edição com 2 destaques: exceção para d2 vale", async () => {
    const dir = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO });
    writeFileSync(join(dir, "_internal", "01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}] }));
    writeSlides(dir, "d2");
    writeKeepArt(dir, { d2: MOTIVO });
    const r = renders();
    const result = await genCarouselCards(dir, { render: r.render, useMelhorConfig: OFF });
    assert.equal(r.destaques.length, 1);
    assert.deepEqual(result.skipped.map((s) => s.destaque), ["d2"]);
    const v = checkCarouselTextOverflow(dir, OFF);
    assert.equal(v.length, 1);
    assert.equal(v[0].severity, "warning");
  });

  it("JSON malformado ABORTA (instrução editorial explícita, nunca ignorada)", async () => {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    writeKeepArt(dir, "{");
    const r = renders();
    await assert.rejects(() => genCarouselCards(dir, { render: r.render, useMelhorConfig: OFF }), /carousel-keep-art/);
    assert.equal(r.destaques.length, 0);
  });
});


describe("ergonomia carousel-keep-art (#11214)", () => {
  it("--force avisa, preserva arte/carimbo e mantém as outras gerações", async () => {
    const dir = makeEdition({ d1: CURTO, d2: ESTOURA, d3: CURTO });
    writeSlides(dir, "d2");
    writeCarouselSourceHashes(dir, { d2: "antigo" });
    writeKeepArt(dir, { d2: MOTIVO });
    const warning = mock.method(console, "error", () => {});
    try {
      let calls = 0;
      await genCarouselCards(dir, { force: true, useMelhorConfig: OFF, render: async (_text, paths) => {
        calls++;
        return paths;
      } });
      assert.equal(calls, 2);
      assert.equal(readCarouselSourceHashes(dir).d2, "antigo");
      assert.equal(readFileSync(join(dir, carouselSlideFilename("d2", "p1")), "utf8"), "arte-antiga");
      assert.match(warning.mock.calls.map((c) => c.arguments.join(" ")).join("\n"), /--force.*arte mantida para d2.*remova a chave/);
    } finally { warning.mock.restore(); }
  });

  it("avisa sobre d3 sem destaque correspondente numa edição de dois destaques", async () => {
    const dir = makeEdition({ d1: CURTO, d2: CURTO, d3: CURTO });
    writeFileSync(join(dir, "_internal/01-approved-capped.json"), JSON.stringify({ highlights: [{}, {}] }));
    writeKeepArt(dir, { d3: MOTIVO });
    const warning = mock.method(console, "error", () => {});
    try {
      const result = await genCarouselCards(dir, { useMelhorConfig: OFF, render: async (_text, paths) => paths });
      assert.equal(result.generated.length, 8);
      assert.match(warning.mock.calls.map((c) => c.arguments.join(" ")).join("\n"), /d3.*não pertence.*2 destaques.*Remova a chave/);
    } finally { warning.mock.restore(); }
  });
});
