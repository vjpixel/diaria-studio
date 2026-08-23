/**
 * test/weekly-linkedin-swap-checkpoint.test.ts (#5974)
 *
 * Cobre a lógica pura do checkpoint síncrono de troca #5538 — sem I/O:
 * `hasHeadlineSwaps5538` dispara com 1+ troca e não dispara sem troca,
 * `renderSwapCheckpointBanner` produz um banner com o conteúdo esperado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hasHeadlineSwaps5538,
  renderSwapCheckpointBanner,
  type HeadlineSwapRecord5538,
} from "../scripts/lib/weekly-linkedin-swap-checkpoint.ts";

describe("hasHeadlineSwaps5538", () => {
  it("false quando o campo está ausente (nenhuma troca ocorreu)", () => {
    assert.equal(hasHeadlineSwaps5538({}), false);
  });

  it("false quando o campo é um array vazio", () => {
    assert.equal(hasHeadlineSwaps5538({ headlineSwaps5538: [] }), false);
  });

  it("false quando o campo não é um array (defensivo contra JSON malformado)", () => {
    assert.equal(hasHeadlineSwaps5538({ headlineSwaps5538: "não é array" }), false);
  });

  it("true quando há 1 troca", () => {
    const swap: HeadlineSwapRecord5538 = {
      originalTitle: "Manchete original",
      originalVerdict: "paywall",
      replacementTitle: "Candidato de reposição",
    };
    assert.equal(hasHeadlineSwaps5538({ headlineSwaps5538: [swap] }), true);
  });

  it("true quando há 2+ trocas", () => {
    const swap: HeadlineSwapRecord5538 = {
      originalTitle: "A",
      originalVerdict: "blocked",
      replacementTitle: "B",
    };
    assert.equal(hasHeadlineSwaps5538({ headlineSwaps5538: [swap, swap] }), true);
  });
});

describe("renderSwapCheckpointBanner", () => {
  it("inclui título/verdict original e título de reposição de cada troca", () => {
    const swaps: HeadlineSwapRecord5538[] = [
      {
        originalTitle: "TSE exige aviso em propaganda eleitoral com IA",
        originalEditionDate: "260818",
        originalVerdict: "paywall",
        replacementTitle: "ATS: o filtro que decide seu currículo",
        replacementEditionDate: "260819",
        replacementKind: "section",
      },
    ];
    const banner = renderSwapCheckpointBanner(swaps);

    assert.match(banner, /TSE exige aviso em propaganda eleitoral com IA/);
    assert.match(banner, /paywall/);
    assert.match(banner, /ATS: o filtro que decide seu currículo/);
    assert.match(banner, /#5538/);
  });

  it("numera cada troca quando há múltiplas", () => {
    const swaps: HeadlineSwapRecord5538[] = [
      { originalTitle: "Original A", originalVerdict: "blocked", replacementTitle: "Reposição A" },
      { originalTitle: "Original B", originalVerdict: "uncertain", replacementTitle: "Reposição B" },
    ];
    const banner = renderSwapCheckpointBanner(swaps);

    assert.match(banner, /1\. .*Original A/);
    assert.match(banner, /2\. .*Original B/);
  });

  it("deixa explícito que é aviso, não pergunta bloqueante", () => {
    const swaps: HeadlineSwapRecord5538[] = [
      { originalTitle: "X", originalVerdict: "paywall", replacementTitle: "Y" },
    ];
    const banner = renderSwapCheckpointBanner(swaps);
    assert.match(banner, /aviso, não uma pergunta/);
  });

  it("não faz I/O — puramente uma string derivada do input", () => {
    const swaps: HeadlineSwapRecord5538[] = [
      { originalTitle: "X", originalVerdict: "paywall", replacementTitle: "Y" },
    ];
    assert.equal(typeof renderSwapCheckpointBanner(swaps), "string");
  });
});
