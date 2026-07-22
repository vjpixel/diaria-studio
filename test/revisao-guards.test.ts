/**
 * test/revisao-guards.test.ts (#3668) — cobertura da lógica PURA do guard de
 * divergência do painel de revisão
 * (`scripts/studio-ui/public/revisao-guards.js`). Mesmo padrão de
 * `test/chat-hydration.test.ts`: o módulo não toca `document`/`fetch`, então
 * é testável com fixtures puras, sem DOM real.
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
  SAVE_CONFLICT_CONFIRM_MESSAGE,
  activeSidePaneAfterSave,
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

// #3729 — warn-before-save: mensagem mostrada quando o server responde 409
// pra um PUT de save (o arquivo mudou em disco desde o último load — o
// pipeline escreveu por baixo). Mesmo padrão de teste de
// DIVERGENCE_CONFIRM_MESSAGE acima: só a mensagem PURA, sem harness de DOM.
describe("SAVE_CONFLICT_CONFIRM_MESSAGE (#3729)", () => {
  it("descreve o fato observável (arquivo mudou desde a abertura do painel) e aponta o pipeline como causa provável", () => {
    assert.match(SAVE_CONFLICT_CONFIRM_MESSAGE, /mudou desde que você abriu/);
    assert.match(SAVE_CONFLICT_CONFIRM_MESSAGE, /pipeline/);
  });

  it("comunica as 2 opções reais: sobrescrever (OK) ou recarregar descartando edições locais (Cancelar)", () => {
    assert.match(SAVE_CONFLICT_CONFIRM_MESSAGE, /OK.*SOBRESCREVER/is);
    assert.match(SAVE_CONFLICT_CONFIRM_MESSAGE, /Cancelar.*RECARREGAR/is);
    assert.match(SAVE_CONFLICT_CONFIRM_MESSAGE, /perdidas/);
  });
});

// #3872 (achado #3866 dimensão 2) — depois de um save bem-sucedido, o painel
// lateral aberto (Diff/Lints/Preview) ficava mostrando o resultado do estado
// ANTERIOR ao save até o editor re-clicar manualmente. `activeSidePaneAfterSave`
// decide qual painel re-rodar dado o estado `hidden` dos 3 painéis — lógica
// pura, testável sem harness de DOM (mesmo padrão dos guards acima).
describe("activeSidePaneAfterSave (#3872)", () => {
  it("retorna 'diff' quando o painel Diff está visível", () => {
    assert.equal(
      activeSidePaneAfterSave({ diffHidden: false, lintHidden: true, previewHidden: true }),
      "diff",
    );
  });

  it("retorna 'lint' quando o painel Lints está visível", () => {
    assert.equal(
      activeSidePaneAfterSave({ diffHidden: true, lintHidden: false, previewHidden: true }),
      "lint",
    );
  });

  it("retorna 'preview' quando o painel Preview está visível", () => {
    assert.equal(
      activeSidePaneAfterSave({ diffHidden: true, lintHidden: true, previewHidden: false }),
      "preview",
    );
  });

  it("retorna null quando nenhum painel lateral está aberto (nada a re-sincronizar)", () => {
    assert.equal(
      activeSidePaneAfterSave({ diffHidden: true, lintHidden: true, previewHidden: true }),
      null,
    );
  });
});
