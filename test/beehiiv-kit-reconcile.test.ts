/**
 * test/beehiiv-kit-reconcile.test.ts (#6269)
 *
 * Regressão pura pra `scripts/lib/beehiiv-kit-reconcile.ts` — sem rede, sem
 * credencial. Cobre o CENÁRIO REAL da issue (divergência simétrica: mesma
 * contagem dos dois lados, interseção menor) porque um teste que só cobrisse
 * contagens iguais passaria sem detectar nada — é exatamente o bug que o
 * #6269 documenta.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeEmail,
  toNormalizedEmailSet,
  sha256OfSortedEmailSet,
  reconcileEmailSets,
  decideGuardExitCode,
  maskEmail,
  formatGuardReport,
} from "../scripts/lib/beehiiv-kit-reconcile.ts";

describe("normalizeEmail (#6269)", () => {
  it("trim + lowercase", () => {
    assert.equal(normalizeEmail("  Joao@Example.COM  "), "joao@example.com");
  });

  it("já normalizado — idempotente", () => {
    assert.equal(normalizeEmail("joao@example.com"), "joao@example.com");
  });
});

describe("toNormalizedEmailSet (#6269)", () => {
  it("dedup case/espaço — dois inputs que normalizam igual viram 1 entrada", () => {
    const set = toNormalizedEmailSet(["Joao@Example.com", "  joao@example.com  "]);
    assert.equal(set.size, 1);
    assert.ok(set.has("joao@example.com"));
  });

  it("descarta strings vazias/whitespace", () => {
    const set = toNormalizedEmailSet(["a@x.com", "   ", ""]);
    assert.equal(set.size, 1);
  });

  it("conjunto vazio", () => {
    assert.equal(toNormalizedEmailSet([]).size, 0);
  });
});

describe("sha256OfSortedEmailSet (#6269)", () => {
  it("determinístico independente da ordem de entrada", () => {
    const h1 = sha256OfSortedEmailSet(["b@x.com", "a@x.com", "c@x.com"]);
    const h2 = sha256OfSortedEmailSet(["c@x.com", "a@x.com", "b@x.com"]);
    assert.equal(h1, h2);
  });

  it("conjuntos de mesmo TAMANHO mas conteúdo diferente produzem hashes diferentes", () => {
    const h1 = sha256OfSortedEmailSet(["a@x.com", "b@x.com", "c@x.com"]);
    const h2 = sha256OfSortedEmailSet(["a@x.com", "b@x.com", "d@x.com"]);
    assert.notEqual(h1, h2);
  });

  it("conjunto vazio produz hash estável (não lança)", () => {
    const h = sha256OfSortedEmailSet([]);
    assert.equal(typeof h, "string");
    assert.equal(h.length, 64);
  });
});

describe("reconcileEmailSets — cenário REAL da issue: divergência SIMÉTRICA (#6269)", () => {
  // Mesma forma do achado ao vivo: 587 == 587, interseção 584 (3 só de cada
  // lado). Reduzido a N=6/6 com interseção 3 pra manter o teste legível,
  // preservando a propriedade que importa: TAMANHOS IGUAIS, conjuntos
  // diferentes.
  const shared = ["a@x.com", "b@x.com", "c@x.com"];
  const onlyBeehiivRaw = ["d@x.com", "e@x.com", "f@x.com"];
  const onlyKitRaw = ["g@x.com", "h@x.com", "i@x.com"];
  const beehiivEmails = [...shared, ...onlyBeehiivRaw];
  const kitEmails = [...shared, ...onlyKitRaw];

  it("contagens BATEM (6 == 6) — é o que torna o bug invisível a uma checagem por contagem", () => {
    const result = reconcileEmailSets(beehiivEmails, kitEmails);
    assert.equal(result.beehiivTotal, result.kitTotal);
    assert.equal(result.beehiivTotal, 6);
  });

  it("mas a interseção é MENOR que o total — divergência real detectada", () => {
    const result = reconcileEmailSets(beehiivEmails, kitEmails);
    assert.equal(result.intersectionSize, 3);
    assert.deepEqual(result.onlyInBeehiiv, ["d@x.com", "e@x.com", "f@x.com"]);
    assert.deepEqual(result.onlyInKit, ["g@x.com", "h@x.com", "i@x.com"]);
  });

  it("os hashes dos dois conjuntos ordenados DIFEREM — é o que torna a divergência simétrica detectável", () => {
    const result = reconcileEmailSets(beehiivEmails, kitEmails);
    assert.notEqual(result.beehiivHash, result.kitHash);
  });

  it("guard: onlyInBeehiiv > 0 é BLOQUEANTE — exit 1", () => {
    const result = reconcileEmailSets(beehiivEmails, kitEmails);
    const decision = decideGuardExitCode(result);
    assert.equal(decision.blocking, true);
    assert.equal(decision.exitCode, 1);
  });

  it("guard também reporta o warning só-no-Kit no mesmo veredito", () => {
    const result = reconcileEmailSets(beehiivEmails, kitEmails);
    const decision = decideGuardExitCode(result);
    assert.equal(decision.hasWarning, true);
  });
});

describe("reconcileEmailSets — conjuntos IDÊNTICOS (#6269)", () => {
  it("nenhuma divergência — exit 0", () => {
    const emails = ["a@x.com", "b@x.com", "c@x.com"];
    const result = reconcileEmailSets(emails, [...emails]);
    assert.equal(result.onlyInBeehiiv.length, 0);
    assert.equal(result.onlyInKit.length, 0);
    assert.equal(result.intersectionSize, 3);
    assert.equal(result.beehiivHash, result.kitHash);

    const decision = decideGuardExitCode(result);
    assert.equal(decision.blocking, false);
    assert.equal(decision.hasWarning, false);
    assert.equal(decision.exitCode, 0);
  });

  it("ordem de chegada diferente não afeta o resultado (hash por conjunto ordenado)", () => {
    const a = reconcileEmailSets(["a@x.com", "b@x.com"], ["b@x.com", "a@x.com"]);
    assert.equal(a.onlyInBeehiiv.length, 0);
    assert.equal(a.onlyInKit.length, 0);
    assert.equal(a.beehiivHash, a.kitHash);
  });
});

describe("reconcileEmailSets — normalização case/espaço evita falso positivo (#6269)", () => {
  it("mesmo e-mail com case/espaço diferente entre as duas plataformas conta como igual", () => {
    const result = reconcileEmailSets(["  Joao@Example.COM  "], ["joao@example.com"]);
    assert.equal(result.onlyInBeehiiv.length, 0);
    assert.equal(result.onlyInKit.length, 0);
    assert.equal(result.intersectionSize, 1);
    const decision = decideGuardExitCode(result);
    assert.equal(decision.exitCode, 0);
  });
});

describe("reconcileEmailSets — apenas onlyInKit (warning) nunca bloqueia sozinho (#6269)", () => {
  it("exit 0 mesmo com só-no-Kit > 0, quando só-na-Beehiiv é 0", () => {
    const result = reconcileEmailSets(["a@x.com"], ["a@x.com", "b@x.com"]);
    assert.equal(result.onlyInBeehiiv.length, 0);
    assert.equal(result.onlyInKit.length, 1);
    const decision = decideGuardExitCode(result);
    assert.equal(decision.blocking, false);
    assert.equal(decision.hasWarning, true);
    assert.equal(decision.exitCode, 0);
  });
});

describe("reconcileEmailSets — conjuntos vazios (#6269)", () => {
  it("dois lados vazios — sem divergência, exit 0", () => {
    const result = reconcileEmailSets([], []);
    assert.equal(result.beehiivTotal, 0);
    assert.equal(result.kitTotal, 0);
    assert.equal(result.intersectionSize, 0);
    assert.equal(result.onlyInBeehiiv.length, 0);
    assert.equal(result.onlyInKit.length, 0);
    assert.equal(decideGuardExitCode(result).exitCode, 0);
  });

  it("um lado vazio, outro com dados — tudo cai em onlyInBeehiiv, bloqueante", () => {
    const result = reconcileEmailSets(["a@x.com", "b@x.com"], []);
    assert.equal(result.onlyInBeehiiv.length, 2);
    assert.equal(result.onlyInKit.length, 0);
    assert.equal(decideGuardExitCode(result).exitCode, 1);
  });
});

describe("maskEmail (#6269)", () => {
  it("mantém 1º caractere do local-part + domínio completo", () => {
    assert.equal(maskEmail("joao@example.com"), "j***@example.com");
  });

  it("e-mail sem @ mascara tudo menos o 1º caractere (fail-soft)", () => {
    assert.equal(maskEmail("naoehemail"), "n***");
  });

  it("string vazia não lança", () => {
    assert.equal(maskEmail(""), "***");
  });
});

describe("formatGuardReport (#6269)", () => {
  it("nunca inclui e-mail cru — só mascarado (sem PII no stdout)", () => {
    const result = reconcileEmailSets(["joao@example.com"], []);
    const decision = decideGuardExitCode(result);
    const report = formatGuardReport(result, decision);
    assert.ok(!report.includes("joao@example.com"));
    assert.ok(report.includes("j***@example.com"));
  });

  it("veredito bloqueante aparece no texto", () => {
    const result = reconcileEmailSets(["a@x.com"], []);
    const decision = decideGuardExitCode(result);
    const report = formatGuardReport(result, decision);
    assert.ok(report.includes("BLOQUEANTE") || report.includes("DIVERGE"));
  });

  it("veredito OK aparece quando não há divergência bloqueante", () => {
    const result = reconcileEmailSets(["a@x.com"], ["a@x.com"]);
    const decision = decideGuardExitCode(result);
    const report = formatGuardReport(result, decision);
    assert.ok(report.includes("OK"));
  });
});
