/**
 * test/onboarding-7665-bootstrap-gap.test.ts (#7665 residual)
 *
 * Regressão do relato de coorte órfã no bootstrap de troca de backend de
 * detecção (#7599): quem cadastrou na janela entre o cursor antigo e o
 * bootstrap não recebe boas-vindas, e a nota precisa DIZER isso — com o
 * número, e sem prometer nenhuma ação automática. A decisão do editor no
 * #7665 foi reportar, nunca reinscrever.
 *
 * **A 1ª versão deste arquivo importava de `vitest`** — dependência que este
 * repo não usa (o runner é `node:test`), o que quebrava o `Typecheck ratchet`
 * com um `TS2307` novo — **e era tautológica**: montava `notaBase + gapReport`
 * à mão dentro do próprio teste e assertava sobre a string que acabara de
 * concatenar, sem chamar nenhuma função do código. Passaria verde com o bug
 * presente, ou com a função deletada. Aqui o teste chama
 * `buildBackendSwitchNote` de verdade — a montagem da nota foi extraída de
 * dentro do `main()` de `onboarding-welcome-run.ts` pra `onboarding-state.ts`
 * justamente pra poder ser exercida sem I/O, mesmo padrão de
 * `shouldResetCursorForBackendSwitch` (#7599) ao lado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBackendSwitchNote,
  BOOTSTRAP_GAP_COUNT_UNKNOWN,
} from "../scripts/lib/onboarding-state.ts";

describe("#7665 bootstrap gap report (residual — reporta, nunca reinscreve)", () => {
  it("gapCount > 0: nota traz o número e nomeia a coorte órfã", () => {
    const nota = buildBackendSwitchNote("beehiiv", "kit", 31);
    assert.match(nota, /31 cadastros/);
    assert.match(nota, /coorte órfã/);
    assert.match(nota, /#7665/);
    assert.match(nota, /reinscrever só sob decisão do editor/);
  });

  it("nota NUNCA promete ação automática — é o ponto da decisão do editor", () => {
    const nota = buildBackendSwitchNote("beehiiv", "kit", 31);
    assert.doesNotMatch(nota, /reinscrito automaticamente/);
    assert.doesNotMatch(nota, /enviado retroativo/);
    assert.doesNotMatch(nota, /reinscrevemos|reenviado|já foram/i);
  });

  it("gapCount 0 afirma 'contei e não havia ninguém' — não é o mesmo que falha", () => {
    const nota = buildBackendSwitchNote("beehiiv", "kit", 0);
    assert.match(nota, /0 cadastros/);
    assert.doesNotMatch(nota, /não foi possível contar/);
  });

  it("falha no fetch (UNKNOWN) reporta que não contou, e NÃO inventa um número", () => {
    const nota = buildBackendSwitchNote("beehiiv", "kit", BOOTSTRAP_GAP_COUNT_UNKNOWN);
    assert.match(nota, /não foi possível contar coorte órfã/);
    assert.doesNotMatch(nota, /cadastros/, "sem número inventado quando a contagem falhou");
    assert.doesNotMatch(nota, /-1/, "a sentinela nunca vaza pro texto lido pelo editor");
  });

  it("UNKNOWN é -1, e qualquer negativo cai no mesmo relato (a sentinela não é mágica de call site)", () => {
    assert.equal(BOOTSTRAP_GAP_COUNT_UNKNOWN, -1);
    assert.match(buildBackendSwitchNote("kit", "beehiiv", -7), /não foi possível contar/);
  });

  it("preserva a nota do #7599 (bootstrap, sem entrada retroativa) e nomeia os dois backends", () => {
    const nota = buildBackendSwitchNote("beehiiv", "kit", 5);
    assert.match(nota, /troca de backend de detecção beehiiv → kit/);
    assert.match(nota, /cursor remarcado em now/);
    assert.match(nota, /nenhuma entrada retroativa adicionada \(#7599\)/);
  });

  it("backend anterior desconhecido (null) não quebra a nota — é o caso do 1º bootstrap", () => {
    const nota = buildBackendSwitchNote(null, "kit", 0);
    assert.match(nota, /troca de backend de detecção null → kit/);
    assert.match(nota, /0 cadastros/);
  });
});

describe("#7665: campo de backend AUSENTE não é troca real — não conta, não afirma zero", () => {
  it("houveTrocaReal=false omite o relato de coorte em vez de dizer '0 cadastros'", () => {
    const nota = buildBackendSwitchNote(null, "kit", 0, false);
    assert.match(nota, /sem janela de coorte órfã/);
    assert.doesNotMatch(
      nota,
      /0 cadastros/,
      "afirmar '0 cadastros' diria ao editor que se mediu e não havia ninguém — não se mediu nada",
    );
  });

  it("troca real (default) mantém o relato com o número", () => {
    assert.match(buildBackendSwitchNote("beehiiv", "kit", 3), /3 cadastros/);
    assert.match(buildBackendSwitchNote("beehiiv", "kit", 3, true), /3 cadastros/);
  });
});
