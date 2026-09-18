/**
 * test/ads-chart-tooltip.test.ts (#8300) — regressão do bug "passar o mouse
 * sobre os pontos não mostra os valores" no gráfico "Custo/cadastro
 * acumulado por canal" do painel /ads.
 *
 * O gráfico é SVG desenhado à mão (#7536), sem lib de chart — até esta
 * issue os pontos eram `<circle r="2.5">` sem `<title>` nem handler de
 * mouse, então o hover não mostrava nada.
 *
 * Mesmo padrão de `test/gate-badge.test.ts` (#7050): a lógica pura vive em
 * um módulo próprio porque `ads.js` toca `document` no topo e não é
 * importável em node:test (este projeto não tem jsdom).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  clampToContainer,
  nearestDateIndex,
  skippedPausedLabel,
  tooltipRowsForIndex,
} from "../scripts/studio-ui/public/ads-chart.js";

// Mesma geometria do gráfico real: 13 colunas espalhadas em 648px de plot.
const PLOT_W = 648;
const COUNT = 13;
const xForIndex = (i: number) => (i / (COUNT - 1)) * PLOT_W;

describe("nearestDateIndex (#8300)", () => {
  it("resolve a coluna pelo x do cursor — não exige acertar o ponto de r=2.5", () => {
    // Exatamente em cima da coluna 6, e 20px ao lado dela: mesma resposta.
    // É esse o bug do #8300 — antes só o pixel do círculo respondia.
    assert.equal(nearestDateIndex(xForIndex, COUNT, xForIndex(6), PLOT_W), 6);
    assert.equal(nearestDateIndex(xForIndex, COUNT, xForIndex(6) + 20, PLOT_W), 6);
    assert.equal(nearestDateIndex(xForIndex, COUNT, xForIndex(6) - 20, PLOT_W), 6);
  });

  it("bordas do plot resolvem a primeira e a última coluna", () => {
    assert.equal(nearestDateIndex(xForIndex, COUNT, 0, PLOT_W), 0);
    assert.equal(nearestDateIndex(xForIndex, COUNT, PLOT_W, PLOT_W), COUNT - 1);
  });

  it("fora do plot → null (esconde o tooltip, não gruda no último valor)", () => {
    assert.equal(nearestDateIndex(xForIndex, COUNT, -40, PLOT_W), null);
    assert.equal(nearestDateIndex(xForIndex, COUNT, PLOT_W + 40, PLOT_W), null);
  });

  it("folga pequena nas pontas ainda resolve — o mouse não precisa ser cirúrgico", () => {
    assert.equal(nearestDateIndex(xForIndex, COUNT, -5, PLOT_W), 0);
    assert.equal(nearestDateIndex(xForIndex, COUNT, PLOT_W + 5, PLOT_W), COUNT - 1);
  });

  it("folga explícita cobre as margens do SVG — hover sobre o rótulo do eixo ainda resolve", () => {
    // `ads.js` passa CHART_MARGIN.left (56) justamente pra que qualquer x
    // dentro do SVG devolva uma coluna: esconder sobre o eixo seria outra
    // forma do bug do #8300 (mouse no gráfico, nenhum valor).
    assert.equal(nearestDateIndex(xForIndex, COUNT, -50, PLOT_W, 56), 0);
    assert.equal(nearestDateIndex(xForIndex, COUNT, PLOT_W + 50, PLOT_W, 56), COUNT - 1);
    assert.equal(nearestDateIndex(xForIndex, COUNT, -80, PLOT_W, 56), null);
  });

  it("série de 1 ponto só resolve a coluna 0", () => {
    assert.equal(nearestDateIndex(() => 0, 1, 0, PLOT_W), 0);
  });

  it("defensivo: contagem zero ou x não-finito nunca lança", () => {
    assert.equal(nearestDateIndex(xForIndex, 0, 10, PLOT_W), null);
    assert.equal(nearestDateIndex(xForIndex, COUNT, Number.NaN, PLOT_W), null);
  });
});

const SERIES = [
  {
    canal: "Google Ads (teste 2608)",
    points: [
      { date: "2026-09-13", custoPorCadastroAcumulado: 6.77 },
      { date: "2026-09-14", custoPorCadastroAcumulado: 6.9 },
    ],
  },
  {
    canal: "Meta Ads (teste 2608)",
    points: [
      { date: "2026-09-13", custoPorCadastroAcumulado: null },
      { date: "2026-09-14", custoPorCadastroAcumulado: 3.52 },
    ],
  },
];

describe("tooltipRowsForIndex (#8300)", () => {
  it("devolve o valor de cada canal na coluna pedida", () => {
    const rows = tooltipRowsForIndex(SERIES, 1);
    assert.deepEqual(
      rows.map((r) => [r.canal, r.value]),
      [
        ["Google Ads (teste 2608)", 6.9],
        ["Meta Ads (teste 2608)", 3.52],
      ],
    );
  });

  it("canal sem valor no dia entra como null, NUNCA some da lista", () => {
    // Omitir a linha seria indistinguível de "esse canal não existe" — a
    // tela existe pra comparar canais lado a lado.
    const rows = tooltipRowsForIndex(SERIES, 0);
    assert.equal(rows.length, SERIES.length);
    assert.equal(rows[1].canal, "Meta Ads (teste 2608)");
    assert.equal(rows[1].value, null);
  });

  it("colorIndex acompanha a posição na série (= cor da linha e da legenda)", () => {
    const rows = tooltipRowsForIndex(SERIES, 1);
    assert.deepEqual(rows.map((r) => r.colorIndex), [0, 1]);
  });

  it("índice além do fim da série vira null em vez de undefined/erro", () => {
    const rows = tooltipRowsForIndex(SERIES, 99);
    assert.equal(rows.length, 2);
    assert.ok(rows.every((r) => r.value === null));
  });

  it("defensivo: série ausente ou índice inválido devolve lista vazia", () => {
    assert.deepEqual(tooltipRowsForIndex(undefined, 0), []);
    assert.deepEqual(tooltipRowsForIndex(SERIES, -1), []);
  });
});

describe("clampToContainer (#8300, finding do review)", () => {
  it("posição confortável passa intacta", () => {
    assert.equal(clampToContainer(120, 180, 700), 120);
  });

  it("vazamento pela borda inicial vira 0", () => {
    assert.equal(clampToContainer(-30, 180, 700), 0);
  });

  it("vazamento pela borda final encosta no fim do container", () => {
    assert.equal(clampToContainer(650, 180, 700), 520);
  });

  it("tooltip maior que o container encosta no início — nunca corta a data", () => {
    assert.equal(clampToContainer(40, 900, 700), 0);
  });

  it("defensivo: medida ausente (offsetWidth 0 antes do 1º layout) nunca vira NaN", () => {
    assert.equal(clampToContainer(Number.NaN, 180, 700), 0);
    assert.equal(clampToContainer(50, Number.NaN, 700), 50);
  });
});

describe("skippedPausedLabel (#8307)", () => {
  it("lista as datas quando são poucas", () => {
    assert.equal(
      skippedPausedLabel(["2026-09-10", "2026-09-11"]),
      "2 dias sem veiculação (pausa) fora do gráfico: 10/09, 11/09",
    );
  });

  it("singular com 1 dia só", () => {
    assert.equal(skippedPausedLabel(["2026-09-10"]), "1 dia sem veiculação (pausa) fora do gráfico: 10/09");
  });

  it("acima de 3 dias vira intervalo — legenda não vira uma lista de 7 datas", () => {
    // A pausa de produção (10 a 16/09) é exatamente este caso.
    const pausa = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15", "2026-09-16"];
    assert.equal(skippedPausedLabel(pausa), "7 dias sem veiculação (pausa) fora do gráfico: 10/09 a 16/09");
  });

  it("nada pulado → string vazia (a UI não imprime nota nenhuma)", () => {
    assert.equal(skippedPausedLabel([]), "");
    assert.equal(skippedPausedLabel(undefined), "");
  });

  it("formata a data como DD/MM sem passar por Date — nunca desloca um dia por fuso", () => {
    assert.match(skippedPausedLabel(["2026-01-01"]), /01\/01/);
  });
});
