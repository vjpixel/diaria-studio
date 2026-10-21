/**
 * Regressão #10609: 429 velho no pool do Hermes não pode ser afirmado como
 * esgotamento (caso memelab, 20/10/2026 — 429 de 03:06Z lido às 13:50Z).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexCredential,
  evaluateCodexPool,
  buildCodexAlarmMessage,
  buildCodexAlarmSubject,
  findSharedResetAt,
  allConfirmedExhausted,
  computeCodexPoolFingerprint,
  CODEX_STALE_429_HOURS,
} from "../scripts/lib/codex-credential-pool.ts";

const NOW = "2026-10-20T13:50:00.000Z";
const RESET = Date.parse("2026-11-16T21:36:00Z") / 1000;
const base = {
  label: "memelab",
  last_status: "exhausted",
  last_error_reason: "usage_limit_reached",
  last_error_code: 429,
  last_error_reset_at: RESET,
};
const STALE_AT_10639 = Date.parse("2026-10-20T03:06:00Z") / 1000;

// #10639: o rebaixamento só vale com a data de retorno compartilhada com outra
// conta (contexto do pool, passado por `evaluateCodexPool`).
const SHARED = { resetAtSharedWithOtherAccount: true } as const;

describe("classifyCodexCredential — 429 velho (#10609)", () => {
  it("429 gravado há 10h, data compartilhada com outra conta: vira indeterminada (não reconfirmado)", () => {
    const v = classifyCodexCredential({ ...base, last_status_at: Date.parse("2026-10-20T03:06:00Z") / 1000 }, NOW, SHARED);
    assert.equal(v.state, "indeterminada");
    assert.match(v.reason, /não foi reconfirmado/);
  });
  it("aceita last_status_at em ISO", () => {
    const v = classifyCodexCredential({ ...base, last_status_at: "2026-10-20T03:06:00Z" }, NOW, SHARED);
    assert.equal(v.state, "indeterminada");
  });
  it("429 recente continua esgotada", () => {
    const at = Date.parse(NOW) / 1000 - (CODEX_STALE_429_HOURS - 1) * 3600;
    assert.equal(classifyCodexCredential({ ...base, last_status_at: at }, NOW, SHARED).state, "esgotada");
  });
  it("sem last_status_at legível continua esgotada", () => {
    assert.equal(classifyCodexCredential(base, NOW, SHARED).state, "esgotada");
    assert.equal(classifyCodexCredential({ ...base, last_status_at: "lixo" }, NOW, SHARED).state, "esgotada");
  });
});

// Regressão #10639: o Hermes não seleciona conta `exhausted` antes do
// `last_error_reset_at` (hermes-agent, agent/credential_pool.py,
// `_exhausted_until`/`_available_entries`), e a sonda de reabertura só
// reescreve a entrada quando a cota volta. Com a cota de fato esgotada,
// `last_status_at` fica parado no 1º 429 por SEMANAS (21,9–29,2 dias medidos).
// A idade do 429, sozinha, não pode rebaixar esse esgotamento.
describe("classifyCodexCredential — esgotamento real além de 6h (#10639)", () => {
  // Conta esgotada de verdade às 03:06Z, ainda esgotada 3 dias depois.
  const LATER = "2026-10-23T03:06:00.000Z";
  const real = { ...base, last_status_at: STALE_AT_10639 };

  it("chamada isolada (sem contexto do pool) mantém esgotada", () => {
    assert.equal(classifyCodexCredential(real, LATER).state, "esgotada");
  });

  it("pool com data de retorno PRÓPRIA por conta: 429 de 3 dias segue esgotada e o alarme segue 'TODAS'", () => {
    const v = evaluateCodexPool(
      [
        { ...real, label: "vjpixel", last_error_reset_at: RESET },
        { ...real, label: "diaria.editor", last_error_reset_at: RESET + 3 * 86_400 },
        { ...real, label: "memelab", last_error_reset_at: RESET + 7 * 86_400 },
      ],
      undefined,
      LATER,
    );
    assert.equal(v.esgotadas, 3);
    assert.equal(v.indeterminadas, 0);
    assert.equal(allConfirmedExhausted(v), true);
    assert.match(buildCodexAlarmSubject(v), /TODAS as contas Codex esgotadas/);
    assert.doesNotMatch(buildCodexAlarmMessage(v, LATER), /não foi reconfirmado/);
  });

  it("a idade do 429 não muda o fingerprint de um esgotamento real (sem 2º alarme rebaixando)", () => {
    const pool = [
      { ...real, label: "a", last_error_reset_at: RESET },
      { label: "b", last_status: "ok" },
    ];
    const at1h = new Date(Date.parse("2026-10-20T04:06:00Z")).toISOString();
    assert.equal(
      computeCodexPoolFingerprint(evaluateCodexPool(pool, undefined, at1h)),
      computeCodexPoolFingerprint(evaluateCodexPool(pool, undefined, LATER)),
    );
  });

  it("conta viva com o mesmo resets_at velho não conta como 'compartilhada'", () => {
    const v = evaluateCodexPool(
      [
        { ...real, label: "a" },
        { label: "b", last_status: "ok", last_error_reset_at: RESET },
      ],
      undefined,
      LATER,
    );
    assert.equal(v.verdicts.find((c) => c.label === "a")?.state, "esgotada");
  });

  it("data de retorno vencida continua indeterminada (#7320 intacto)", () => {
    const after = new Date((RESET + 60) * 1000).toISOString();
    assert.equal(evaluateCodexPool([{ ...real, label: "a" }], undefined, after).verdicts[0]?.state, "indeterminada");
  });
});

// Resíduo do #10609 (pós-PR #10615): a mensagem e o assunto do alarme.
const STALE_AT = Date.parse("2026-10-20T03:06:00Z") / 1000;
const FRESH_AT = Date.parse(NOW) / 1000 - 3600;

describe("mensagem do alarme — cenário de 20/10 (#10609)", () => {
  // Caso real: 3 contas com o MESMO resets_at, 429 gravado às 03:06Z.
  const pool = ["vjpixel", "diaria.editor", "memelab"].map((label) => ({
    ...base,
    label,
    last_status_at: STALE_AT,
  }));

  it("3 contas com 429 velho: não diz 'TODAS esgotadas' nem que a data passou", () => {
    const v = evaluateCodexPool(pool, undefined, NOW);
    assert.equal(v.esgotadas, 0);
    const msg = buildCodexAlarmMessage(v, NOW);
    assert.doesNotMatch(msg, /TODAS as contas Codex estão esgotadas/);
    assert.doesNotMatch(msg, /data de retorno passou para todas/, "a data é FUTURA (16/11) — afirmar que passou é falso");
    assert.match(msg, /não foi reconfirmado/, "a 3ª origem do INDETERMINADO aparece na nota agregada");
    assert.doesNotMatch(buildCodexAlarmSubject(v), /TODAS/);
  });

  it("mesma data de retorno nas 3 contas vira aviso explícito", () => {
    const v = evaluateCodexPool(pool, undefined, NOW);
    const shared = findSharedResetAt(v.verdicts);
    assert.equal(shared.length, 1);
    assert.deepEqual([...shared[0]!.labels].sort(), ["diaria.editor", "memelab", "vjpixel"]);
    assert.match(buildCodexAlarmMessage(v, NOW), /MESMA data de retorno \(2026-11-16 21:36 UTC\)/);
  });

  it("datas diferentes não geram aviso; conta viva nunca entra no grupo", () => {
    const v = evaluateCodexPool(
      [
        { ...base, label: "a", last_status_at: FRESH_AT },
        { ...base, label: "b", last_status_at: FRESH_AT, last_error_reset_at: RESET + 60 },
        { label: "c", last_status: "ok" },
      ],
      undefined,
      NOW,
    );
    assert.deepEqual(findSharedResetAt(v.verdicts), []);
    assert.doesNotMatch(buildCodexAlarmMessage(v, NOW), /MESMA data de retorno/);
  });

  it("zero vivas com MISTURA (1 esgotada recente + 2 com 429 velho) não é 'TODAS esgotadas'", () => {
    const v = evaluateCodexPool(
      [
        { ...base, label: "a", last_status_at: FRESH_AT },
        { ...base, label: "b", last_status_at: STALE_AT },
        { ...base, label: "c", last_status_at: STALE_AT },
      ],
      undefined,
      NOW,
    );
    assert.equal(v.allExhausted, true);
    assert.equal(allConfirmedExhausted(v), false);
    const msg = buildCodexAlarmMessage(v, NOW);
    assert.doesNotMatch(msg, /TODAS as contas Codex estão esgotadas/);
    assert.match(msg, /1 confirmada\(s\) esgotada\(s\) e 2 em estado desconhecido/);
    assert.match(buildCodexAlarmSubject(v), /nenhuma conta Codex confirmada viva/);
  });

  it("todas com 429 recente continua 'TODAS esgotadas' (caso real não enfraquecido)", () => {
    const v = evaluateCodexPool(
      ["a", "b"].map((label) => ({ ...base, label, last_status_at: FRESH_AT })),
      undefined,
      NOW,
    );
    assert.equal(allConfirmedExhausted(v), true);
    assert.match(buildCodexAlarmMessage(v, NOW), /TODAS as contas Codex estão esgotadas/);
    assert.match(buildCodexAlarmSubject(v), /TODAS as contas Codex esgotadas/);
  });

  it("assunto de pool vazio e de pool com viva não mudaram", () => {
    assert.match(buildCodexAlarmSubject(evaluateCodexPool([], undefined, NOW)), /VAZIO/);
    assert.match(
      buildCodexAlarmSubject(evaluateCodexPool([{ label: "x", last_status: "ok" }], undefined, NOW)),
      /resta 1 conta Codex viva de 1/,
    );
  });
});
