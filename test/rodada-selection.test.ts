/**
 * test/rodada-selection.test.ts (#5210) — cobertura da lógica PURA de
 * seleção/accordion do acompanhamento de rodada
 * (`scripts/studio-ui/public/rodada-selection.js`). Mesmo padrão de
 * `test/rodada-round-age.test.ts` (#3889): o módulo não toca
 * `document`/`fetch`, então é testável com fixtures puras, sem DOM real.
 *
 * Regressão coberta (#5210): clicar na entrada em verde (rodada mais
 * recente, já expandida por auto-seleção) parecia no-op. Causa raiz A:
 * `fetchRoundsList()` reauto-selecionava `rounds[0]` em TODA chamada, não só
 * na 1ª carga — o guard original era `!selected`, verdadeiro também logo
 * depois de um colapso deliberado do editor. Com uma rodada AO VIVO, o SSE
 * do evento `plan` dispara `fetchRoundsList()` a cada unidade despachada,
 * revertendo o colapso antes que o editor notasse qualquer mudança.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideToggle, decideAutoSelect } from "../scripts/studio-ui/public/rodada-selection.js";

describe("decideToggle (#5210)", () => {
  it("colapsar a entrada selecionada → selected === null", () => {
    const selected = { kind: "overnight", sessionId: "260814-abc" };
    const result = decideToggle(selected, "overnight", "260814-abc");
    assert.equal(result, null);
  });

  it("clicar numa entrada diferente da selecionada → seleciona a nova", () => {
    const selected = { kind: "overnight", sessionId: "260813-old" };
    const result = decideToggle(selected, "develop", "260814-new");
    assert.deepEqual(result, { kind: "develop", sessionId: "260814-new" });
  });

  it("nenhuma entrada selecionada ainda → clique seleciona", () => {
    const result = decideToggle(null, "overnight", "260814-abc");
    assert.deepEqual(result, { kind: "overnight", sessionId: "260814-abc" });
  });

  it("colapsar a entrada N não expande a entrada 0 — só a clicada é afetada", () => {
    // entrada N (índice != 0) está selecionada; clicar NELA colapsa, sem
    // reverter/expandir a entrada 0 (que não foi clicada).
    const selectedEntryN = { kind: "develop", sessionId: "entrada-n" };
    const result = decideToggle(selectedEntryN, "develop", "entrada-n");
    assert.equal(result, null, "colapso da própria entrada clicada, não da entrada 0");
  });
});

describe("decideAutoSelect (#5210)", () => {
  const rounds = [
    { kind: "overnight", sessionId: "260814-mais-recente" },
    { kind: "develop", sessionId: "260813-antiga" },
  ];

  it("primeira carga com selected === null → re-seleciona rounds[0] (comportamento original preservado, #3841)", () => {
    const result = decideAutoSelect({ selected: null, rounds, isInitialLoad: true });
    assert.deepEqual(result, { kind: "overnight", sessionId: "260814-mais-recente" });
  });

  it("fetchRoundsList subsequente (refresh) com selected === null NÃO re-seleciona — o caso que quebrou (#5210)", () => {
    const result = decideAutoSelect({ selected: null, rounds, isInitialLoad: false });
    assert.equal(result, null);
  });

  it("já há uma seleção — refresh não a substitui, mesmo na 1ª carga (idempotente)", () => {
    const current = { kind: "develop", sessionId: "260813-antiga" };
    const result = decideAutoSelect({ selected: current, rounds, isInitialLoad: true });
    assert.deepEqual(result, current);
  });

  it("já há uma seleção — refresh subsequente também não a substitui", () => {
    const current = { kind: "develop", sessionId: "260813-antiga" };
    const result = decideAutoSelect({ selected: current, rounds, isInitialLoad: false });
    assert.deepEqual(result, current);
  });

  it("1ª carga sem nenhuma rodada disponível → não seleciona nada (defensivo)", () => {
    const result = decideAutoSelect({ selected: null, rounds: [], isInitialLoad: true });
    assert.equal(result, null);
  });

  it("rounds ausente/malformado não quebra — trata como vazio (defensivo)", () => {
    // @ts-expect-error — teste defensivo de input malformado
    const result = decideAutoSelect({ selected: null, rounds: undefined, isInitialLoad: true });
    assert.equal(result, null);
  });
});
