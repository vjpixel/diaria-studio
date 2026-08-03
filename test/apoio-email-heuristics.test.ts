/**
 * test/apoio-email-heuristics.test.ts (#4490 causa 3)
 *
 * Regressão pura pra `scripts/lib/apoio-email-heuristics.ts` — nenhuma rede,
 * nenhum I/O. Cobre os 4 casos reais citados na issue #4490 (MURILO, Vanessa,
 * Hugo, Fabiana) mais o caso "sem match nenhum" (nunca inventa candidato).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findEmailMatchCandidates } from "../scripts/lib/apoio-email-heuristics.ts";

describe("findEmailMatchCandidates (#4490 causa 3)", () => {
  it("(a) local-part normalizado sem pontuação — MURILO", () => {
    const candidates = findEmailMatchCandidates(
      "Murilo",
      ["murilo.sarno@online.uscs.edu.br"],
      [{ subscriptionId: "sub-1", email: "murilosarno@gmail.com" }, { subscriptionId: "sub-2", email: "outrapessoa@gmail.com" }],
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].subscriptionId, "sub-1");
    assert.equal(candidates[0].email, "murilosarno@gmail.com");
    assert.equal(candidates[0].reason, "local-part");
    assert.match(candidates[0].detail, /local-part normalizado/);
  });

  it("(b) nome do contato aparece no local-part — Vanessa", () => {
    const candidates = findEmailMatchCandidates(
      "Vanessa",
      ["creek.soup.8q@icloud.com"],
      [{ subscriptionId: "sub-1", email: "vanessaventuracontato@gmail.com" }],
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].email, "vanessaventuracontato@gmail.com");
    assert.equal(candidates[0].reason, "name-in-local-part");
    assert.match(candidates[0].detail, /nome do contato aparece no local-part/);
  });

  it("(c) domínio próprio similar ao nome do contato — Hugo", () => {
    const candidates = findEmailMatchCandidates(
      "Hugo Pena",
      ["oliveira.pena.h@gmail.com"],
      [{ subscriptionId: "sub-1", email: "behiiv@hugopenna.com" }],
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].email, "behiiv@hugopenna.com");
    assert.equal(candidates[0].reason, "own-domain");
    assert.match(candidates[0].detail, /domínio.*parece pessoal/);
  });

  it("(c) domínio público comum (gmail) NUNCA conta como 'domínio próprio', mesmo com nome parecido", () => {
    const candidates = findEmailMatchCandidates("Ana", ["outroemail@x.com"], [
      { subscriptionId: "sub-1", email: "ana@gmail.com" },
    ]);
    // "ana" é curto (<4) então nem heurística (b)/(c) tentam de qualquer
    // forma — cenário reforça que provedores comuns não geram falso positivo
    // por domínio.
    assert.deepEqual(candidates, []);
  });

  it("(d) local-part parecido (typo/variação) com e-mail já conhecido — Fabiana", () => {
    const candidates = findEmailMatchCandidates(
      "Fabiana",
      ["fbartholo@hotmail.com"],
      [{ subscriptionId: "sub-1", email: "fabartholo@gmail.com" }],
    );
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].email, "fabartholo@gmail.com");
    assert.equal(candidates[0].reason, "typo-variant");
    assert.match(candidates[0].detail, /parecido com fbartholo@hotmail\.com/);
  });

  it("sem match nenhum — nunca inventa candidato", () => {
    const candidates = findEmailMatchCandidates(
      "Zeca",
      ["zeca@example.com"],
      [
        { subscriptionId: "sub-1", email: "completamentediferente@outrodominio.com" },
        { subscriptionId: "sub-2", email: "maria@gmail.com" },
      ],
    );
    assert.deepEqual(candidates, []);
  });

  it("nunca duplica o mesmo assinante mesmo se batesse em mais de uma heurística", () => {
    // "murilo.sarno" bate (a) local-part normalizado E teoricamente poderia
    // bater (b)/(d) — só 1 entrada deve sair pra este subscriptionId.
    const candidates = findEmailMatchCandidates(
      "Murilo Sarno",
      ["murilo.sarno@online.uscs.edu.br"],
      [{ subscriptionId: "sub-1", email: "murilosarno@gmail.com" }],
    );
    assert.equal(candidates.length, 1);
  });

  it("lista vazia de subscriptions -> nenhum candidato", () => {
    assert.deepEqual(findEmailMatchCandidates("Qualquer", ["a@x.com"], []), []);
  });
});
