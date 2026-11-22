/**
 * test/linkedin-weekly-opening-count-13819.test.ts (#13819)
 *
 * A abertura padrão do artigo semanal do LinkedIn dizia sempre "As cinco
 * edições completas ficam com os títulos no fim do post.". No 26w47 a seção
 * "Outros destaques da semana" listou 4 edições e o texto seguiu em "cinco".
 * Agora o número acompanha as edições que a seção lista de fato (o mesmo corte
 * do render: manchetes e Use Melhor já mostrados saem), e sem edição listada a
 * frase some junto com a seção. `--opening` explícito continua sobrepondo.
 */
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultOpening, DEFAULT_OPENING, main } from "../scripts/render-linkedin-weekly.ts";
import { listedWeeklyEditions, OTHER_HIGHLIGHTS_HEADING } from "../scripts/lib/weekly-linkedin-render.ts";

const SECOND_PARAGRAPH = "Aqui no LinkedIn, trago toda segunda os três destaques que mais renderam cliques na semana.";

describe("#13819 — defaultOpening acompanha a contagem", () => {
  it("5, 4, 1 e 0 edições", () => {
    assert.ok(defaultOpening(5).endsWith(`${SECOND_PARAGRAPH} As 5 edições completas ficam com os títulos no fim do post.`));
    assert.ok(defaultOpening(4).endsWith(`${SECOND_PARAGRAPH} As 4 edições completas ficam com os títulos no fim do post.`));
    assert.ok(defaultOpening(1).endsWith(`${SECOND_PARAGRAPH} A edição completa fica com os títulos no fim do post.`));
    assert.ok(defaultOpening(0).endsWith(SECOND_PARAGRAPH), "sem edição listada, a frase não cita a seção");
    for (const n of [0, 1, 4, 5]) assert.ok(!defaultOpening(n).includes("cinco"), `regressão: "cinco" fixo (n=${n})`);
  });

  it("DEFAULT_OPENING é a semana cheia e mantém os 2 parágrafos (#11776)", () => {
    assert.equal(DEFAULT_OPENING, defaultOpening(5));
    assert.equal(DEFAULT_OPENING.split("\n\n").length, 2);
  });

  it("listedWeeklyEditions aplica o corte do render (manchete e Use Melhor já mostrados)", () => {
    const weeklyEditions = [
      { editionDate: "261116", url: "https://diar.ia.br/p/a", destaques: ["M1"] },
      { editionDate: "261117", url: "https://diar.ia.br/p/b", destaques: ["M2", "Outro B"] },
      { editionDate: "261118", url: "https://diar.ia.br/p/c", destaques: ["Use"] },
    ];
    const headlines = [
      { title: "M1", body: "", why: "" },
      { title: "M2", body: "", why: "" },
    ];
    const useMelhor = { title: "Use", url: "https://ex.com/u", description: "", editorComment: "" };
    assert.deepEqual(
      listedWeeklyEditions({ headlines, useMelhor, weeklyEditions }).map((x) => x.item.editionDate),
      ["261117"],
    );
  });
});

describe("#13819 — CLI: abertura padrão com o número de edições listadas", () => {
  let root = "";
  const originalArgv = process.argv;
  afterEach(() => {
    process.argv = originalArgv;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function render(weeklyEditions: unknown[], headlineTitles: string[], extraArgs: string[] = []): string {
    root = mkdtempSync(join(tmpdir(), "ln-opening-13819-"));
    const sel = join(root, "data", "weekly", "26w47", "_internal");
    mkdirSync(sel, { recursive: true });
    writeFileSync(
      join(sel, "ln-selection.json"),
      JSON.stringify({
        cycle: "26w47",
        headlines: headlineTitles.map((title, i) => ({ title, body: "Corpo.", why: "", editionDate: `26111${6 + i}` })),
        useMelhor: null,
        weeklyEditions,
        video: null,
      }),
    );
    process.argv = ["node", "render-linkedin-weekly.ts", "--cycle", "26w47", ...extraArgs];
    main(root);
    return readFileSync(join(root, "data", "weekly", "26w47", "ln-26w47.html"), "utf8");
  }

  const ed = (d: string, destaques: string[]) => ({ editionDate: d, url: `https://diar.ia.br/p/${d}`, destaques });

  it("semana de 4 edições (26w47): 'As 4 edições', igual ao número de edições na seção", () => {
    const html = render(
      [ed("261116", ["M1", "A2"]), ed("261117", ["B1", "B2"]), ed("261118", ["C1"]), ed("261119", ["D1"])],
      ["M1"],
    );
    assert.ok(html.includes("As 4 edições completas ficam com os títulos no fim do post."), html);
    assert.equal((html.match(/>Edição de \d\d\/\d\d</g) ?? []).length, 4);
  });

  it("edição cujos destaques todos viraram manchete sai da contagem", () => {
    const html = render(
      [ed("261116", ["M1"]), ed("261117", ["M2"]), ed("261118", ["C1"]), ed("261119", ["D1"]), ed("261120", ["E1"])],
      ["M1", "M2"],
    );
    assert.ok(html.includes("As 3 edições completas"), html);
    assert.equal((html.match(/>Edição de \d\d\/\d\d</g) ?? []).length, 3);
  });

  it("semana de 1 edição listada: singular", () => {
    const html = render([ed("261116", ["M1", "A2"])], ["M1"]);
    assert.ok(html.includes("A edição completa fica com os títulos no fim do post."), html);
  });

  it("sem edição listada: a seção some e a frase não a cita", () => {
    const html = render([ed("261116", ["M1"])], ["M1"]);
    assert.ok(!html.includes(OTHER_HIGHLIGHTS_HEADING));
    assert.ok(!html.includes("no fim do post"), html);
    assert.ok(html.includes(`<p>${SECOND_PARAGRAPH}</p>`));
  });

  it("--opening explícito continua sobrepondo o default", () => {
    const html = render([ed("261116", ["M1", "A2"])], ["M1"], ["--opening", "Abertura minha."]);
    assert.ok(html.includes("<p>Abertura minha.</p>"));
    assert.ok(!html.includes("no fim do post"));
  });
});
