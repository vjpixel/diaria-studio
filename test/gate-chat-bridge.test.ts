/**
 * test/gate-chat-bridge.test.ts (#3870) — cobertura da lógica PURA da ponte
 * visível entre o card de Gate 4/6 do cockpit (`edicao.js`) e o card de
 * AskUserQuestion/tool-decision do chat drawer
 * (`scripts/studio-ui/public/gate-chat-bridge.js`). Mesmo padrão de
 * `test/chat-hydration.test.ts` (#3617): módulo extraído sem tocar
 * `document`, testável via node:test puro — este projeto não tem
 * jsdom/happy-dom (ver `test/studio-edicao-page.test.ts`), então a cobertura
 * de DOM real fica pro nível de integração server-side
 * (`test/studio-server.test.ts`/`test/studio-edicao-page.test.ts`).
 *
 * Regressão do #3870 (achado #3866 dimensão 4): antes deste fix, o cockpit
 * não tinha NENHUM sinal de que a ação de aprovar um gate pendente já estava
 * disponível como card no chat drawer da própria página — o texto sempre
 * mandava "aprovar no terminal", mesmo quando havia card. Estes testes
 * cobrem a decisão pura que evita essa regressão: gate pendente + card no
 * chat → `hasCard: true`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveGateChatBridge, formatWaitingSince, pickBannerGate } from "../scripts/studio-ui/public/gate-chat-bridge.js";

describe("resolveGateChatBridge (#3870)", () => {
  it("gate não pendente → { pending: false, hasCard: false }, mesmo com card no chat", () => {
    const result = resolveGateChatBridge(4, [6], [{ toolUseId: "a", askedAt: Date.now() }]);
    assert.deepEqual(result, { pending: false, hasCard: false, oldestAskedAt: null });
  });

  it("gate pendente + nenhum card pendente no chat → sessão-terminal (hasCard: false)", () => {
    const result = resolveGateChatBridge(4, [4], []);
    assert.equal(result.pending, true);
    assert.equal(result.hasCard, false);
    assert.equal(result.oldestAskedAt, null);
  });

  it("gate pendente + card no chat → hasCard: true, expõe o askedAt mais antigo", () => {
    const t1 = Date.now() - 5 * 60_000;
    const t2 = Date.now() - 1 * 60_000;
    const result = resolveGateChatBridge(4, [4], [
      { toolUseId: "a", askedAt: t2 },
      { toolUseId: "b", askedAt: t1 },
    ]);
    assert.equal(result.pending, true);
    assert.equal(result.hasCard, true);
    assert.equal(result.oldestAskedAt, t1);
  });

  it("regression #3870: gate 6 pendente reconhece card de kind 'tool' (#3804) igual a 'question'", () => {
    // O wire não carrega `kind` aqui (não importa pra decisão — o botão
    // "Responder no chat" serve pros dois tipos de card, o drawer já sabe
    // renderizar ambos).
    const result = resolveGateChatBridge(6, [6], [{ toolUseId: "x", toolName: "Bash", askedAt: Date.now() }]);
    assert.equal(result.pending, true);
    assert.equal(result.hasCard, true);
  });

  it("defensivo: gatesPending malformado (não-array) nunca lança, resolve pending:false", () => {
    assert.doesNotThrow(() => resolveGateChatBridge(4, undefined, []));
    assert.equal(resolveGateChatBridge(4, null, []).pending, false);
  });

  it("defensivo: entradas de chatPermissionsPending sem askedAt numérico são ignoradas, não quebram o cálculo", () => {
    const result = resolveGateChatBridge(4, [4], [{ toolUseId: "a" }, { toolUseId: "b", askedAt: "not-a-number" }]);
    assert.equal(result.pending, true);
    assert.equal(result.hasCard, false);
  });
});

describe("formatWaitingSince (#3870)", () => {
  it("0 minutos → 'esperando…'", () => {
    const now = 1_000_000;
    assert.equal(formatWaitingSince(now - 10_000, now), "esperando…");
  });

  it("N minutos → 'esperando há Nmin'", () => {
    const now = 1_000_000;
    assert.equal(formatWaitingSince(now - 5 * 60_000, now), "esperando há 5min");
  });

  it("input inválido → string vazia, nunca lança", () => {
    assert.equal(formatWaitingSince(undefined), "");
    assert.equal(formatWaitingSince(NaN), "");
  });
});

describe("pickBannerGate (#3870)", () => {
  it("nenhum gate pendente → null", () => {
    assert.equal(pickBannerGate({ pending: false }, { pending: false }), null);
  });

  it("só o gate 4 pendente → escolhe o gate 4", () => {
    const picked = pickBannerGate({ pending: true, hasCard: true, oldestAskedAt: 1 }, { pending: false });
    assert.equal(picked.gate, 4);
  });

  it("só o gate 6 pendente → escolhe o gate 6", () => {
    const picked = pickBannerGate({ pending: false }, { pending: true, hasCard: false, oldestAskedAt: null });
    assert.equal(picked.gate, 6);
  });

  it("os dois pendentes (cenário raro) → escolhe o que está esperando há mais tempo", () => {
    const older = 1000;
    const newer = 5000;
    const picked = pickBannerGate(
      { pending: true, hasCard: true, oldestAskedAt: newer },
      { pending: true, hasCard: true, oldestAskedAt: older },
    );
    assert.equal(picked.gate, 6);
  });

  it("os dois pendentes, empate/sem askedAt → prioriza o gate 4 (ordem natural do pipeline)", () => {
    const picked = pickBannerGate(
      { pending: true, hasCard: false, oldestAskedAt: null },
      { pending: true, hasCard: false, oldestAskedAt: null },
    );
    assert.equal(picked.gate, 4);
  });
});
