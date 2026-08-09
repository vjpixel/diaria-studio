/**
 * test/poll-jogar-signup-note-4316.test.ts (#4316)
 *
 * `.signup-note` (`renderIdentityFormBlock`, jogar.ts) reescrita — a versão
 * anterior ("Seu e-mail entra no ranking público e sai do modo anônimo.
 * Assinar a Diar.ia é opcional, só se você marcar a caixinha.") errava
 * duas vezes: (1) o e-mail nunca é renderizado no leaderboard, só o
 * nome/nickname digitado neste form (`hasNickname ? nickname : masked`,
 * leaderboard-routes.ts:136 e mais 3 ocorrências — confirmado ao vivo via
 * curl em produção); (2) "opcional" era disclaimer redundante — o checkbox
 * de opt-in já entra desmarcado por padrão (LGPD art. 8º §1º), a caixa
 * desmarcada JÁ comunica a opcionalidade. Nenhum teste anterior casava
 * `signup-note` — este é o primeiro. Cobre:
 *
 *   1. Nota nova não afirma que o e-mail entra no ranking.
 *   2. Nota nova não contém "opcional".
 *   3. Nota nova afirma que o NOME aparece no ranking.
 *   4. Nota nova não promete "nunca aparece" — guard contra reintroduzir a
 *      versão que contradiz o #4253 item 5 (que aumentou de propósito a
 *      truncagem do `maskEmail` de 3→5 chars para reconhecimento — o
 *      e-mail mascarado aparece por decisão do editor).
 *   5. `name="optin"` continua sem `checked` (a caixa não pode ser marcada
 *      por padrão — LGPD art. 8º §1º).
 *   6. `renderIdentityFormBlock` é usada nas duas páginas do jogo (par único
 *      `renderJogarPageHtml` e sequência `renderJogarSequencePageHtml`) —
 *      uma edição cobre as duas.
 *   7. Copy do gate (`web-gate.ts` → `renderJogarGatePage`) intacta — este
 *      fix não toca `/jogar/gate`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  renderIdentityFormBlock,
  renderJogarPageHtml,
  renderJogarSequencePageHtml,
} from "../workers/poll/src/jogar.ts";
import { renderJogarGatePage } from "../workers/poll/src/web-gate.ts";

describe("signup-note (#4316) — não afirma que o e-mail entra no ranking", () => {
  it("renderIdentityFormBlock: nota não contém 'e-mail entra no ranking'", () => {
    const html = renderIdentityFormBlock();
    assert.doesNotMatch(html, /e-mail entra no ranking/i);
  });

  it("renderIdentityFormBlock: nota não contém 'sai do modo anônimo' (frase da versão antiga, ligada ao e-mail entrar no ranking)", () => {
    const html = renderIdentityFormBlock();
    assert.doesNotMatch(html, /sai do modo anônimo/i);
  });
});

describe("signup-note (#4316) — 'opcional' removido (disclaimer redundante com o checkbox desmarcado)", () => {
  it("renderIdentityFormBlock: nota não contém 'opcional'", () => {
    const html = renderIdentityFormBlock();
    // #4797: "diar.ia.br" dentro da nota ganhou o wordmark da marca
    // (`<strong>`/`<span>` aninhados) — `[^<]*` não casa mais o conteúdo
    // inteiro; `[\s\S]*?` (não-guloso) captura texto E marcação interna.
    const noteMatch = html.match(/<p class="signup-note">([\s\S]*?)<\/p>/);
    assert.ok(noteMatch, "signup-note deve existir");
    assert.doesNotMatch(noteMatch![1], /opcional/i);
  });
});

describe("signup-note (#4316) — afirma o NOME, não nega o e-mail em absoluto", () => {
  it("renderIdentityFormBlock: nota afirma que o ranking mostra o NOME", () => {
    const html = renderIdentityFormBlock();
    // #4797: "diar.ia.br" dentro da nota ganhou o wordmark da marca
    // (`<strong>`/`<span>` aninhados) — `[^<]*` não casa mais o conteúdo
    // inteiro; `[\s\S]*?` (não-guloso) captura texto E marcação interna.
    const noteMatch = html.match(/<p class="signup-note">([\s\S]*?)<\/p>/);
    assert.ok(noteMatch);
    assert.match(noteMatch![1], /nome/i);
  });

  it("renderIdentityFormBlock: nota NÃO promete 'nunca aparece' — guard contra reintroduzir versão que contradiz o #4253 item 5 (maskEmail truncagem 3→5 chars pra reconhecimento)", () => {
    const html = renderIdentityFormBlock();
    assert.doesNotMatch(html, /nunca aparece/i);
  });

  it("texto exato da decisão do editor (260729c)", () => {
    const html = renderIdentityFormBlock();
    // #4797: "diar.ia.br" no fim da nota ganhou o wordmark da marca.
    assert.match(
      html,
      /<p class="signup-note">No ranking você aparece pelo nome\. O e-mail é usado como seu identificador\. Marque a caixinha pra receber a <strong>diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span><\/strong>\.<\/p>/,
    );
  });
});

describe("signup-note (#4316) — checkbox de opt-in continua desmarcado por padrão", () => {
  it("input name=\"optin\" não tem atributo checked (LGPD art. 8º §1º exige ato afirmativo)", () => {
    const html = renderIdentityFormBlock();
    const inputMatch = html.match(/<input type="checkbox" name="optin"[^>]*>/);
    assert.ok(inputMatch, "checkbox de opt-in deve existir");
    assert.doesNotMatch(inputMatch![0], /checked/);
  });
});

describe("signup-note (#4316) — presente nas duas páginas do jogo (uma edição cobre as duas)", () => {
  it("par único (renderJogarPageHtml) carrega a nota nova", () => {
    const html = renderJogarPageHtml({ edition: "260701", revealed: false });
    assert.match(html, /Marque a caixinha pra receber a <strong>diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span><\/strong>\./);
  });

  it("sequência (renderJogarSequencePageHtml) carrega a nota nova", () => {
    const html = renderJogarSequencePageHtml(["260601"]);
    assert.match(html, /Marque a caixinha pra receber a <strong>diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span><\/strong>\./);
  });
});

describe("signup-note (#4316) — copy do gate (web-gate.ts) intacta, fora do escopo desta issue", () => {
  it("renderJogarGatePage não é tocado por este fix — sem a nota nova de signup-note (superfície diferente)", () => {
    const html = renderJogarGatePage(null);
    assert.doesNotMatch(html, /Marque a caixinha pra receber a <strong>diar<span[^>]*>\.<\/span>ia<span[^>]*>\.br<\/span><\/strong>\./);
  });
});
