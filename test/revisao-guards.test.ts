/**
 * test/revisao-guards.test.ts (#3668) — cobertura da lógica PURA do guard de
 * divergência do painel de revisão
 * (`scripts/studio-ui/public/revisao-guards.js`). Mesmo padrão de
 * `test/revisao-prompts.test.ts` (#3629): o módulo não toca
 * `document`/`fetch`, então é testável com fixtures puras, sem DOM real.
 *
 * Regressão coberta (#3668 — 3 gaps do guard original em revisao.js,
 * introduzido em #3635/PR #3664):
 *   - gap 2: o guard disparava pra QUALQUER slug salvo (`01-categorized`,
 *     `02-reviewed`, `03-social`), mas só `02-reviewed.md` alimenta o render
 *     do HTML final — `shouldConfirmDivergenceGuard` restringe a `reviewed`.
 *   - gap 1: a mensagem afirmava categoricamente "editado manualmente", uma
 *     alegação de autoria não decidível do lado client (um re-render
 *     agent-driven legítimo do Stage 4 também diverge do baseline sem
 *     nenhuma edição manual) — `DIVERGENCE_CONFIRM_MESSAGE` foi reescrita
 *     pra descrever o fato observável em vez de afirmar autoria.
 * (gap 3 — TOCTOU da flag em memória — não é lógica pura, coberto via
 * contrato estático em test/studio-review-server.test.ts, que confere que
 * `saveCurrent()` em revisao.js re-busca o estado fresco antes de decidir.)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  shouldConfirmDivergenceGuard,
  DIVERGENCE_CONFIRM_MESSAGE,
} from "../scripts/studio-ui/public/revisao-guards.js";

describe("shouldConfirmDivergenceGuard (#3668 gap 2)", () => {
  it("true só para 'reviewed' (02-reviewed.md — único slug que alimenta o render do HTML final)", () => {
    assert.equal(shouldConfirmDivergenceGuard("reviewed"), true);
  });

  it("false para 'categorized' (01-categorized.md não tem vínculo causal com o HTML final)", () => {
    assert.equal(shouldConfirmDivergenceGuard("categorized"), false);
  });

  it("false para 'social' (03-social.md não tem vínculo causal com o HTML final)", () => {
    assert.equal(shouldConfirmDivergenceGuard("social"), false);
  });

  it("false para 'html-final' (não faz sentido avisar sobre o arquivo que o editor está justamente editando)", () => {
    assert.equal(shouldConfirmDivergenceGuard("html-final"), false);
  });

  it("false para slug desconhecido (fail-closed — não amplia o guard por engano)", () => {
    assert.equal(shouldConfirmDivergenceGuard("nope"), false);
    assert.equal(shouldConfirmDivergenceGuard(""), false);
    assert.equal(shouldConfirmDivergenceGuard(undefined), false);
  });
});

describe("DIVERGENCE_CONFIRM_MESSAGE (#3668 gap 1)", () => {
  it("NÃO afirma categoricamente 'editado manualmente' (autoria não é decidível só do lado client)", () => {
    assert.doesNotMatch(DIVERGENCE_CONFIRM_MESSAGE, /editado manualmente/);
  });

  it("descreve o fato observável (modificado desde a última leitura) sem afirmar autoria", () => {
    assert.match(DIVERGENCE_CONFIRM_MESSAGE, /modificado desde a última vez/);
    assert.match(DIVERGENCE_CONFIRM_MESSAGE, /pode ser edição sua ou re-render do agente/);
  });

  it("ainda comunica o risco real (re-render futuro descarta as mudanças sem aviso)", () => {
    assert.match(DIVERGENCE_CONFIRM_MESSAGE, /newsletter-final\.html/);
    assert.match(DIVERGENCE_CONFIRM_MESSAGE, /re-render futuro/);
    assert.match(DIVERGENCE_CONFIRM_MESSAGE, /sem aviso automático da pipeline/);
  });
});
