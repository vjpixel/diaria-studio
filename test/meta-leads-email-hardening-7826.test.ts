/**
 * test/meta-leads-email-hardening-7826.test.ts (#7826)
 *
 * `isPlausibleEmail` (`workers/meta-leads/src/index.ts`) afirmava na
 * docstring ser "mesmo racional de `isValidVoteEmailFormat`"
 * (`workers/poll/src/lib.ts`) sem ter as três proteções do #3279/#3296:
 * teto de 254 em BYTES UTF-8 (não `.length`, que conta code units UTF-16),
 * bloqueio de confusáveis/invisíveis Unicode (`FORBIDDEN_EMAIL_CHARS_RE`),
 * e `:` barrado no regex principal.
 *
 * Como o input deste worker vem de formulário instantâneo PÚBLICO da Meta
 * (digitado por qualquer pessoa que veja o anúncio), é exatamente a classe
 * de entrada não-confiável contra a qual o #3296 endureceu o resto do
 * projeto. Este teste compara as DUAS implementações caso a caso — travar
 * a paridade de verdade, em vez de confiar na docstring de novo (o mesmo
 * defeito reapareceu depois de já ter sido corrigido uma vez, ver #7826).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPlausibleEmail } from "../workers/meta-leads/src/index.ts";
import { isValidVoteEmailFormat } from "../workers/poll/src/lib.ts";

describe("isPlausibleEmail", () => {
  it("aceita e-mail comum", () => {
    assert.equal(isPlausibleEmail("leitor@diar.ia.br"), true);
  });

  for (const bad of ["", "sem-arroba", "a@b", "a@@b.com", "com espaco@b.com", "a@.com", "a@b."]) {
    it(`recusa ${JSON.stringify(bad)}`, () => {
      assert.equal(isPlausibleEmail(bad), false);
    });
  }
});

describe("paridade da validação de e-mail com isValidVoteEmailFormat (#3296, #7826)", () => {
  // A versão anterior reimplementou a validação à mão e a docstring afirmava
  // paridade que não existia — faltavam o teto em BYTES UTF-8 e o bloqueio
  // de confusáveis Unicode. Input aqui vem de formulário PÚBLICO, exatamente
  // a classe de entrada que o #3296 endureceu.
  const casos = [
    "leitor@diar.ia.br",
    "com.acento@diária.br",
    "zero​width@b.com", // U+200B (Cf) — deve ser recusado
    "full：width@b.com", // U+FF1A fullwidth colon — deve ser recusado
    "control char@b.com", // caractere de controle (Cc) — deve ser recusado
    "dois:pontos@b.com", // ":" barrado no local-part
    "a".repeat(250) + "@b.com",
    "ç".repeat(200) + "@b.com", // 400 bytes UTF-8, 201 code units UTF-16 — só o teto em bytes acusa
    "",
    "sem-arroba",
  ];

  for (const caso of casos) {
    it(`concorda com a fonte para ${JSON.stringify(caso.slice(0, 40))}`, () => {
      assert.equal(isPlausibleEmail(caso), isValidVoteEmailFormat(caso.trim()));
    });
  }
});
