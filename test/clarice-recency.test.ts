import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveNotSentCutoff, excludeSentSince } from "../scripts/lib/clarice-recency.ts";

describe("resolveNotSentCutoff (#4719)", () => {
  const now = new Date("2026-08-07T00:00:00.000Z");

  it("nenhuma flag → null (filtro desligado)", () => {
    assert.equal(resolveNotSentCutoff(null, null, now), null);
    assert.equal(resolveNotSentCutoff(undefined, undefined, now), null);
  });

  it("--not-sent-since resolve pra meia-noite UTC da data pedida", () => {
    assert.equal(resolveNotSentCutoff(null, "2026-08-01", now), "2026-08-01T00:00:00.000Z");
  });

  it("--not-sent-since rejeita formato fora de YYYY-MM-DD", () => {
    assert.throws(() => resolveNotSentCutoff(null, "01/08/2026", now), /YYYY-MM-DD/);
    assert.throws(() => resolveNotSentCutoff(null, "ontem", now), /YYYY-MM-DD/);
  });

  it("REGRESSÃO (fleet review): --not-sent-since rejeita dia inexistente no calendário, não rola em silêncio (2026-02-31 → 2026-03-03)", () => {
    assert.throws(() => resolveNotSentCutoff(null, "2026-02-31", now), /inexistente no calendário/);
    assert.throws(() => resolveNotSentCutoff(null, "2026-04-31", now), /inexistente no calendário/);
  });

  it("--not-sent-since mês fora de 01-12 já é rejeitado no parse (Date.parse devolve NaN, não rola pra outro ano)", () => {
    assert.throws(() => resolveNotSentCutoff(null, "2026-13-01", now), /YYYY-MM-DD/);
  });

  it("--not-sent-within Nd calcula relativo a `now` (injetado, nunca Date.now() implícito)", () => {
    assert.equal(resolveNotSentCutoff("30d", null, now), "2026-07-08T00:00:00.000Z");
    assert.equal(resolveNotSentCutoff("1d", null, now), "2026-08-06T00:00:00.000Z");
  });

  it("--not-sent-within rejeita formato fora de 'Nd'", () => {
    assert.throws(() => resolveNotSentCutoff("30 dias", null, now), /formato "Nd"/);
    assert.throws(() => resolveNotSentCutoff("1mês", null, now), /formato "Nd"/);
    assert.throws(() => resolveNotSentCutoff("d", null, now), /formato "Nd"/);
  });

  it("--not-sent-within rejeita 0 ou negativo", () => {
    assert.throws(() => resolveNotSentCutoff("0d", null, now), /> 0 dias/);
  });

  it("os dois juntos são mutuamente exclusivos — lança, nunca escolhe um silenciosamente", () => {
    assert.throws(() => resolveNotSentCutoff("30d", "2026-08-01", now), /mutuamente exclusivos/);
  });
});

describe("excludeSentSince (#4719)", () => {
  const cutoff = "2026-08-01T00:00:00.000Z";

  it("exclui quem tem last_sent_at >= cutoff (recebeu dentro da janela)", () => {
    const rows = [
      { email: "a", last_sent_at: "2026-08-02T09:00:00.000Z" }, // dentro — excluído
      { email: "b", last_sent_at: "2026-08-01T00:00:00.000Z" }, // exatamente no cutoff — excluído (inclusive)
      { email: "c", last_sent_at: "2026-07-31T23:59:59.000Z" }, // fora — mantido
    ];
    const out = excludeSentSince(rows, cutoff);
    assert.deepEqual(out.map((r) => r.email), ["c"]);
  });

  it("last_sent_at ausente NUNCA é excluído (fail-safe: 'nunca recebeu' não é 'recebeu recentemente')", () => {
    const rows = [{ email: "a", last_sent_at: null }, { email: "b" }];
    assert.deepEqual(excludeSentSince(rows, cutoff).map((r) => r.email), ["a", "b"]);
  });

  it("last_sent_at inválido também não é excluído (dado ruim não vira 'recebeu recentemente')", () => {
    const rows = [{ email: "a", last_sent_at: "não é uma data" }];
    assert.deepEqual(excludeSentSince(rows, cutoff).map((r) => r.email), ["a"]);
  });

  it("cutoff inválido devolve as linhas intactas (defensivo — não deveria acontecer via resolveNotSentCutoff)", () => {
    const rows = [{ email: "a", last_sent_at: "2026-08-02T00:00:00.000Z" }];
    assert.deepEqual(excludeSentSince(rows, "lixo").map((r) => r.email), ["a"]);
  });

  it("preserva a ordem relativa dos remanescentes", () => {
    const rows = [
      { email: "a", last_sent_at: "2026-07-01T00:00:00.000Z" },
      { email: "b", last_sent_at: "2026-08-05T00:00:00.000Z" },
      { email: "c", last_sent_at: "2026-06-01T00:00:00.000Z" },
    ];
    assert.deepEqual(excludeSentSince(rows, cutoff).map((r) => r.email), ["a", "c"]);
  });
});
