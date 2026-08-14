/**
 * test/on-hold-vencimento-alarm.test.ts (#5317)
 *
 * Cobertura da lógica pura de `scripts/lib/on-hold-vencimento-alarm.ts`:
 * extração da linha `Vencimento:` do corpo (nunca do título) + decisão de
 * alarme pros 3 estados possíveis (data futura/passada, "sem data"
 * explícito, linha ausente).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseVencimentoLine,
  evaluateOnHoldIssue,
  evaluateOnHoldIssues,
  shouldSendOnHoldVencimentoAlarm,
  buildOnHoldVencimentoAlarmEmail,
  type OnHoldIssueInput,
} from "../scripts/lib/on-hold-vencimento-alarm.ts";

const NOW = new Date("2026-08-14T12:00:00");

function issue(overrides: Partial<OnHoldIssueInput> = {}): OnHoldIssueInput {
  return {
    number: 1000,
    title: "Issue de teste",
    url: "https://github.com/vjpixel/diaria-studio/issues/1000",
    body: "corpo qualquer",
    ...overrides,
  };
}

describe("parseVencimentoLine", () => {
  it("extrai uma data válida AAAA-MM-DD", () => {
    const result = parseVencimentoLine("algum texto\n\nVencimento: 2026-09-15\n\nmais texto");
    assert.deepEqual(result, { kind: "date", date: "2026-09-15" });
  });

  it("reconhece 'Vencimento: sem data' como explicit-no-date", () => {
    const result = parseVencimentoLine("Vencimento: sem data");
    assert.deepEqual(result, { kind: "explicit-no-date" });
  });

  it("devolve absent quando a linha não existe", () => {
    const result = parseVencimentoLine("um corpo qualquer sem a linha esperada");
    assert.deepEqual(result, { kind: "absent" });
  });

  it("NUNCA lê o título — só o corpo (formatos frágeis tipo '~16/08' no título não contam)", () => {
    // título não é nem passado pra esta função — garantindo isso pelo tipo
    // (parseVencimentoLine só aceita `body: string`), este teste documenta
    // a intenção: um corpo sem a linha explícita é sempre "absent", mesmo
    // que o texto contenha uma data em outro formato solta por aí.
    const result = parseVencimentoLine("prazo por volta de ~16/08/2026, ver título");
    assert.deepEqual(result, { kind: "absent" });
  });

  it("trata texto não-data após 'Vencimento:' como explicit-no-date (fail-safe, nunca quebra)", () => {
    const result = parseVencimentoLine("Vencimento: 16/08/2026");
    assert.deepEqual(result, { kind: "explicit-no-date" });
  });
});

describe("evaluateOnHoldIssue", () => {
  it("data futura declarada -> null (nenhum achado, ainda não venceu)", () => {
    const result = evaluateOnHoldIssue(issue({ body: "Vencimento: 2026-09-15" }), NOW);
    assert.equal(result, null);
  });

  it("data passada declarada -> achado 'due'", () => {
    const result = evaluateOnHoldIssue(issue({ number: 4556, body: "Vencimento: 2026-08-01" }), NOW);
    assert.deepEqual(result, {
      number: 4556,
      title: "Issue de teste",
      url: "https://github.com/vjpixel/diaria-studio/issues/1000",
      reason: "due",
      vencimento: "2026-08-01",
    });
  });

  it("data igual a hoje -> achado 'due' (venceu hoje conta como vencida)", () => {
    const result = evaluateOnHoldIssue(issue({ body: "Vencimento: 2026-08-14" }), NOW);
    assert.equal(result?.reason, "due");
  });

  it("'Vencimento: sem data' -> sempre achado 'no-date-declared'", () => {
    const result = evaluateOnHoldIssue(issue({ number: 4549, body: "Vencimento: sem data" }), NOW);
    assert.equal(result?.reason, "no-date-declared");
    assert.equal(result?.vencimento, null);
  });

  it("linha ausente -> sempre achado 'vencimento-line-missing' (nunca ignorado em silêncio)", () => {
    const result = evaluateOnHoldIssue(issue({ number: 4549, body: "on-hold, external-blocker, sem linha declarada" }), NOW);
    assert.equal(result?.reason, "vencimento-line-missing");
  });
});

describe("evaluateOnHoldIssues", () => {
  it("filtra os null (data futura) e ordena por número crescente", () => {
    const issues: OnHoldIssueInput[] = [
      issue({ number: 4554, body: "Vencimento: 2026-09-30" }), // futuro -> fora
      issue({ number: 4469, body: "Vencimento: 2026-07-01" }), // vencida
      issue({ number: 4549, body: "Vencimento: sem data" }), // sempre achado
    ];
    const findings = evaluateOnHoldIssues(issues, NOW);
    assert.deepEqual(
      findings.map((f) => f.number),
      [4469, 4549],
    );
  });

  it("lista vazia -> nenhum achado", () => {
    assert.deepEqual(evaluateOnHoldIssues([], NOW), []);
  });
});

describe("shouldSendOnHoldVencimentoAlarm", () => {
  it("false quando não há achados", () => {
    assert.equal(shouldSendOnHoldVencimentoAlarm([]), false);
  });

  it("true quando há pelo menos 1 achado", () => {
    const findings = evaluateOnHoldIssues([issue({ body: "Vencimento: sem data" })], NOW);
    assert.equal(shouldSendOnHoldVencimentoAlarm(findings), true);
  });
});

describe("buildOnHoldVencimentoAlarmEmail", () => {
  it("assunto cita a contagem de achados e o corpo lista cada issue com motivo + url", () => {
    const findings = evaluateOnHoldIssues(
      [
        issue({ number: 4469, title: "Meta de direct abaixo de 25%", url: "https://x/4469", body: "Vencimento: 2026-07-01" }),
        issue({ number: 4549, title: "Amostras físicas", url: "https://x/4549", body: "Vencimento: sem data" }),
      ],
      NOW,
    );
    const { subject, body } = buildOnHoldVencimentoAlarmEmail(findings);
    assert.match(subject, /^⚠️ 2 issue\(ns\)/);
    assert.match(body, /#4469 — Meta de direct abaixo de 25% \(venceu em 2026-07-01\)/);
    assert.match(body, /https:\/\/x\/4469/);
    assert.match(body, /#4549 — Amostras físicas \(sem data \(declarada explicitamente\)\)/);
    assert.match(body, /https:\/\/x\/4549/);
    assert.match(body, /NÃO remove a label on-hold sozinho/);
  });
});
