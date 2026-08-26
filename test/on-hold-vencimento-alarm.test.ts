/**
 * test/on-hold-vencimento-alarm.test.ts (#5317, unificação de convenção #6199)
 *
 * Cobertura da lógica pura de `scripts/lib/on-hold-vencimento-alarm.ts`:
 * extração da linha `Vencimento:` do corpo (nunca do título), a resolução
 * unificada `resolveVencimento` (linha explícita OU marcador
 * `aguardando-ate:` como fallback, #6199 item 1), e decisão de alarme pros
 * 3 estados possíveis (data futura/passada, "sem data" explícito — que
 * agora SILENCIA de verdade, #6199 item 2 — e ausência total).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseVencimentoLine,
  resolveVencimento,
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

describe("resolveVencimento — unificação de convenção (#6199 item 1)", () => {
  it("linha 'Vencimento:' presente → usa ela, marcador é ignorado", () => {
    const result = resolveVencimento("Vencimento: 2026-09-15\n\n<!-- aguardando-ate: 2026-10-01 -->");
    assert.deepEqual(result, { kind: "date", date: "2026-09-15" });
  });

  it("SEM linha 'Vencimento:', mas COM marcador 'aguardando-ate:' → usa a data do marcador", () => {
    const result = resolveVencimento("corpo qualquer\n\n<!-- aguardando-ate: 2026-09-29 -->");
    assert.deepEqual(result, { kind: "date", date: "2026-09-29" });
  });

  it("nenhuma das duas convenções presente → absent", () => {
    assert.deepEqual(resolveVencimento("corpo sem nenhum sinal de data"), { kind: "absent" });
  });

  it("'Vencimento: sem data' vence mesmo com marcador presente (linha explícita sempre tem prioridade)", () => {
    const result = resolveVencimento("Vencimento: sem data\n\n<!-- aguardando-ate: 2026-09-29 -->");
    assert.deepEqual(result, { kind: "explicit-no-date" });
  });

  it("marcador com data calendarialmente inválida (parseWaitUntil já rejeita) → absent, não date malformada", () => {
    // 2026-02-30 não existe; parseWaitUntil (issue-exec-track.ts) já rejeita
    // via round-trip contra a string — resolveVencimento nunca produz uma
    // `date` malformada a partir do marcador.
    const result = resolveVencimento("<!-- aguardando-ate: 2026-02-30 -->");
    assert.deepEqual(result, { kind: "absent" });
  });

  // Fixtures reais #4469/#4554/#4556 (auditoria #6191): as três carregavam
  // AMBAS as convenções com a MESMA data — resolveVencimento preserva o
  // comportamento de sempre (linha explícita vence), mas o ponto novo é que
  // mesmo se a linha 'Vencimento:' um dia sumir dessas issues (#6199 item 3
  // as deixa só com o marcador), o alarme continua funcionando.
  it("#4469 (fixture real): Vencimento E marcador com a mesma data → resolve pra essa data", () => {
    const body = ["Vencimento: 2026-09-29", "", "<!-- aguardando-ate: 2026-09-29 -->"].join("\n");
    assert.deepEqual(resolveVencimento(body), { kind: "date", date: "2026-09-29" });
  });

  it("#4469 pós-item-3 (linha Vencimento removida, só o marcador sobra) → alarme continua funcionando", () => {
    const body = "<!-- aguardando-ate: 2026-09-29 -->";
    assert.deepEqual(resolveVencimento(body), { kind: "date", date: "2026-09-29" });
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

  it("'Vencimento: sem data' -> null, silencia de verdade agora (#6199 item 2 — antes era sempre achado)", () => {
    const result = evaluateOnHoldIssue(issue({ number: 4549, body: "Vencimento: sem data" }), NOW);
    assert.equal(result, null);
  });

  it("marcador 'aguardando-ate:' sozinho (sem linha 'Vencimento:'), data futura -> null", () => {
    const result = evaluateOnHoldIssue(issue({ body: "<!-- aguardando-ate: 2026-09-15 -->" }), NOW);
    assert.equal(result, null);
  });

  it("marcador 'aguardando-ate:' sozinho, data JÁ VENCIDA -> achado 'due' (#6199 item 1 — antes era invisível pro alarme)", () => {
    const result = evaluateOnHoldIssue(issue({ number: 4556, body: "<!-- aguardando-ate: 2026-08-01 -->" }), NOW);
    assert.deepEqual(result, {
      number: 4556,
      title: "Issue de teste",
      url: "https://github.com/vjpixel/diaria-studio/issues/1000",
      reason: "due",
      vencimento: "2026-08-01",
    });
  });

  it("linha ausente -> sempre achado 'vencimento-line-missing' (nunca ignorado em silêncio)", () => {
    const result = evaluateOnHoldIssue(issue({ number: 4549, body: "on-hold, external-blocker, sem linha declarada" }), NOW);
    assert.equal(result?.reason, "vencimento-line-missing");
  });

  it("mês fora do intervalo (NaN) -> sempre achado 'invalid-date', nunca null (regressão do buraco de supressão silenciosa)", () => {
    const result = evaluateOnHoldIssue(issue({ number: 9001, body: "Vencimento: 2026-13-01" }), NOW);
    assert.equal(result?.reason, "invalid-date");
    assert.equal(result?.vencimento, "2026-13-01");
  });

  it("dia fora do intervalo com rollover silencioso pra data real -> sempre achado 'invalid-date', nunca avaliado contra o dia errado", () => {
    // 2026-02-30 não existe; new Date() rola pra 2026-03-02 sem erro.
    const result = evaluateOnHoldIssue(issue({ number: 9002, body: "Vencimento: 2026-02-30" }), NOW);
    assert.equal(result?.reason, "invalid-date");
    assert.equal(result?.vencimento, "2026-02-30");
  });

  it("caso feliz: data calendarialmente válida e futura continua sem alarme (não regride)", () => {
    const result = evaluateOnHoldIssue(issue({ body: "Vencimento: 2026-09-15" }), NOW);
    assert.equal(result, null);
  });
});

describe("evaluateOnHoldIssues", () => {
  it("filtra os null (data futura e 'sem data' silenciosa) e ordena por número crescente", () => {
    const issues: OnHoldIssueInput[] = [
      issue({ number: 4554, body: "Vencimento: 2026-09-30" }), // futuro -> fora
      issue({ number: 4469, body: "Vencimento: 2026-07-01" }), // vencida
      issue({ number: 4549, body: "Vencimento: sem data" }), // #6199 item 2: silencia, fora
      issue({ number: 9999, body: "sem nenhuma das duas convenções" }), // sempre achado
    ];
    const findings = evaluateOnHoldIssues(issues, NOW);
    assert.deepEqual(
      findings.map((f) => f.number),
      [4469, 9999],
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

  it("false quando o ÚNICO on-hold é 'Vencimento: sem data' (#6199 item 2 — o digest fica vazio de verdade)", () => {
    const findings = evaluateOnHoldIssues([issue({ body: "Vencimento: sem data" })], NOW);
    assert.equal(shouldSendOnHoldVencimentoAlarm(findings), false);
  });

  it("true quando há pelo menos 1 achado", () => {
    const findings = evaluateOnHoldIssues([issue({ body: "Vencimento: 2026-01-01" })], NOW);
    assert.equal(shouldSendOnHoldVencimentoAlarm(findings), true);
  });
});

describe("buildOnHoldVencimentoAlarmEmail", () => {
  it("assunto cita a contagem de achados e o corpo lista cada issue com motivo + url", () => {
    const findings = evaluateOnHoldIssues(
      [
        issue({ number: 4469, title: "Meta de direct abaixo de 25%", url: "https://x/4469", body: "Vencimento: 2026-07-01" }),
        issue({ number: 9002, title: "Sem data declarada", url: "https://x/9002", body: "sem nenhuma convenção" }),
      ],
      NOW,
    );
    const { subject, body } = buildOnHoldVencimentoAlarmEmail(findings);
    assert.match(subject, /^⚠️ 2 issue\(ns\)/);
    assert.match(body, /#4469 — Meta de direct abaixo de 25% \(venceu em 2026-07-01\)/);
    assert.match(body, /https:\/\/x\/4469/);
    assert.match(body, /#9002 — Sem data declarada \(sem 'Vencimento:' nem marcador 'aguardando-ate:' declarado\)/);
    assert.match(body, /https:\/\/x\/9002/);
    assert.match(body, /NÃO remove a label on-hold sozinho/);
  });

  it("'Vencimento: sem data' nunca aparece no e-mail (silenciada antes de chegar aqui)", () => {
    const findings = evaluateOnHoldIssues([issue({ number: 4549, body: "Vencimento: sem data" })], NOW);
    const { subject, body } = buildOnHoldVencimentoAlarmEmail(findings);
    assert.match(subject, /^⚠️ 0 issue\(ns\)/);
    assert.ok(!body.includes("#4549"));
  });
});
