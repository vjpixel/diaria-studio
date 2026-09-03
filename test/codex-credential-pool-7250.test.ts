/**
 * test/codex-credential-pool-7250.test.ts (#7250)
 *
 * Regressão do alarme das contas OpenAI Codex do Hermes.
 *
 * As fixtures não são inventadas: reproduzem o estado REAL medido em
 * `~/.hermes/auth.json` no helios em 03/09/2026, quando o alarme foi escrito —
 * 2 contas `exhausted` com `usage_limit_reached`/429 e reset ~26 e ~29 dias à
 * frente, 1 conta `ok`. É o caso que motivou a issue.
 *
 * O que estes testes travam, em ordem de importância:
 *
 * 1. **Esgotamento nunca é inferido de `last_status` sozinho.** Uma conta com
 *    falha de razão desconhecida é `indeterminada`, não `esgotada` — a
 *    distinção existe porque OAuth expirado e erro de rede se parecem com
 *    cota estourada, e alarmar pelo motivo errado esconde o problema real.
 * 2. **`indeterminada` não conta como viva.** Fail-closed: alarmar à toa custa
 *    uma mensagem; não alarmar custa semanas de delegação parada.
 * 3. **O alarme dispara na PENÚLTIMA conta**, não na última — decisão do
 *    editor, e com reset mensal é a diferença entre ter margem e não ter.
 * 4. **A mensagem nunca vaza segredo.** O canal de entrega do contínuo é o
 *    Telegram; token no corpo do alarme seria vazamento a um encaminhamento
 *    de distância.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifyCodexCredential,
  evaluateCodexPool,
  parseResetAt,
  computeCodexPoolFingerprint,
  buildCodexAlarmMessage,
  CODEX_ALARM_LIVE_THRESHOLD,
  type CodexCredentialEntry,
} from "../scripts/lib/codex-credential-pool.ts";

/** Estado real medido no helios em 03/09/2026. */
const POOL_REAL: CodexCredentialEntry[] = [
  {
    label: "vjpixel",
    priority: 0,
    last_status: "exhausted",
    last_error_reason: "usage_limit_reached",
    last_error_code: 429,
    last_error_reset_at: 1790703924.0,
  },
  {
    label: "diaria.editor",
    priority: 1,
    last_status: "exhausted",
    last_error_reason: "usage_limit_reached",
    last_error_code: 429,
    last_error_reset_at: 1790903326.0,
  },
  { label: "memelab", priority: 2, last_status: "ok" },
];

describe("classifyCodexCredential (#7250)", () => {
  it("conta ok é viva", () => {
    const v = classifyCodexCredential({ label: "memelab", last_status: "ok" });
    assert.equal(v.state, "viva");
    assert.equal(v.resetsAtIso, null);
  });

  it("usage_limit_reached é esgotada, com a data de retorno preservada", () => {
    const v = classifyCodexCredential(POOL_REAL[0]);
    assert.equal(v.state, "esgotada");
    assert.equal(v.label, "vjpixel");
    assert.match(v.resetsAtIso ?? "", /^2026-09-29T/);
  });

  it("429 sozinho basta para esgotada, mesmo sem a razão textual", () => {
    const v = classifyCodexCredential({ label: "x", last_status: "error", last_error_code: 429 });
    assert.equal(v.state, "esgotada");
  });

  it("falha de razão DESCONHECIDA é indeterminada, nunca esgotada", () => {
    // OAuth expirado e erro de rede caem aqui. Chamar isso de "esgotada"
    // esconderia o problema real atrás do alarme errado.
    const v = classifyCodexCredential({
      label: "y",
      last_status: "error",
      last_error_reason: "invalid_grant",
      last_error_code: 401,
    });
    assert.equal(v.state, "indeterminada");
  });

  it("entrada sem last_status é indeterminada, não viva", () => {
    const v = classifyCodexCredential({ label: "z" });
    assert.equal(v.state, "indeterminada");
  });

  it("nunca usa o token como rótulo quando falta label", () => {
    const v = classifyCodexCredential({ id: "cred_123", last_status: "ok" });
    assert.equal(v.label, "cred_123");
  });
});

describe("parseResetAt (#7250)", () => {
  it("aceita epoch em número e em string", () => {
    assert.equal(parseResetAt(1790703924), parseResetAt("1790703924"));
  });

  it("ausente, vazio ou ilegível vira null — nunca data inventada", () => {
    for (const raw of [null, undefined, "", "não-é-data", 0, -1, NaN]) {
      assert.equal(parseResetAt(raw as never), null, `falhou para ${String(raw)}`);
    }
  });
});

describe("evaluateCodexPool (#7250)", () => {
  it("o estado real de 03/09 dispara alarme — resta 1 viva de 3", () => {
    const v = evaluateCodexPool(POOL_REAL);
    assert.equal(v.vivas, 1);
    assert.equal(v.esgotadas, 2);
    assert.equal(v.shouldAlarm, true, "com 1 viva o alarme tem de disparar");
    assert.equal(v.allExhausted, false);
  });

  it("3 vivas não alarma", () => {
    const v = evaluateCodexPool([
      { label: "a", last_status: "ok" },
      { label: "b", last_status: "ok" },
      { label: "c", last_status: "ok" },
    ]);
    assert.equal(v.shouldAlarm, false);
  });

  it("zero vivas alarma E marca allExhausted", () => {
    const v = evaluateCodexPool(POOL_REAL.map((e) => ({ ...e, last_status: "exhausted", last_error_code: 429 })));
    assert.equal(v.vivas, 0);
    assert.equal(v.allExhausted, true);
    assert.equal(v.shouldAlarm, true);
  });

  it("indeterminada NÃO conta como viva — fail-closed", () => {
    const v = evaluateCodexPool([
      { label: "a", last_status: "ok" },
      { label: "b", last_status: "error", last_error_reason: "invalid_grant", last_error_code: 401 },
      { label: "c", last_status: "error", last_error_reason: "invalid_grant", last_error_code: 401 },
    ]);
    assert.equal(v.vivas, 1);
    assert.equal(v.indeterminadas, 2);
    assert.equal(v.shouldAlarm, true, "2 indeterminadas não podem passar por 'tudo bem'");
  });

  it("pool vazio não alarma — ausência de dado não é ausência de conta", () => {
    const v = evaluateCodexPool([]);
    assert.equal(v.shouldAlarm, false);
    assert.equal(v.allExhausted, false);
  });

  it("o limiar é configurável e o default avisa na penúltima", () => {
    assert.equal(CODEX_ALARM_LIVE_THRESHOLD, 1);
    const duasVivas = [
      { label: "a", last_status: "ok" },
      { label: "b", last_status: "ok" },
      { label: "c", last_status: "exhausted", last_error_code: 429 },
    ];
    assert.equal(evaluateCodexPool(duasVivas).shouldAlarm, false);
    assert.equal(evaluateCodexPool(duasVivas, 2).shouldAlarm, true);
  });
});

describe("computeCodexPoolFingerprint (#7250)", () => {
  it("estável enquanto os estados não mudam — não repete alarme à toa", () => {
    const a = computeCodexPoolFingerprint(evaluateCodexPool(POOL_REAL));
    const b = computeCodexPoolFingerprint(evaluateCodexPool([...POOL_REAL].reverse()));
    assert.equal(a, b, "ordem das entradas não pode mudar o fingerprint");
  });

  it("muda quando uma conta muda de estado", () => {
    const antes = computeCodexPoolFingerprint(evaluateCodexPool(POOL_REAL));
    const depois = computeCodexPoolFingerprint(
      evaluateCodexPool(POOL_REAL.map((e) => (e.label === "memelab" ? { ...e, last_status: "exhausted", last_error_code: 429 } : e))),
    );
    assert.notEqual(antes, depois);
  });
});

describe("buildCodexAlarmMessage (#7250)", () => {
  it("nunca inclui token, refresh_token ou fingerprint de segredo", () => {
    const comSegredo = POOL_REAL.map((e) => ({
      ...e,
      access_token: "sk-SEGREDO-NAO-PODE-VAZAR",
      refresh_token: "rt-SEGREDO-NAO-PODE-VAZAR",
    })) as CodexCredentialEntry[];
    const msg = buildCodexAlarmMessage(evaluateCodexPool(comSegredo), "2026-09-03T07:52:00Z");
    assert.ok(!msg.includes("SEGREDO"), "a mensagem do alarme vazou material de credencial");
    assert.ok(!msg.includes("sk-"), "a mensagem do alarme vazou prefixo de token");
  });

  it("diz quantas restam e quando cada esgotada volta", () => {
    const msg = buildCodexAlarmMessage(evaluateCodexPool(POOL_REAL), "2026-09-03T07:52:00Z");
    assert.match(msg, /Resta 1 conta Codex viva de 3/);
    assert.match(msg, /vjpixel/);
    assert.match(msg, /2026-09-29/);
    assert.match(msg, /SEMANAS/, "o horizonte em semanas é o que muda a urgência — tem de estar na mensagem");
  });

  it("quando todas esgotam, a mensagem diz que a delegação PAROU", () => {
    const todas = POOL_REAL.map((e) => ({ ...e, last_status: "exhausted", last_error_code: 429 }));
    const msg = buildCodexAlarmMessage(evaluateCodexPool(todas), "2026-09-03T07:52:00Z");
    assert.match(msg, /TODAS as contas Codex estão esgotadas/);
    assert.match(msg, /delegação está parada/);
  });

  it("declara explicitamente quando há conta indeterminada", () => {
    const msg = buildCodexAlarmMessage(
      evaluateCodexPool([
        { label: "a", last_status: "ok" },
        { label: "b", last_status: "error", last_error_reason: "invalid_grant" },
      ]),
      "2026-09-03T07:52:00Z",
    );
    assert.match(msg, /INDETERMINADO/);
    assert.match(msg, /não são contadas como vivas/i);
  });
});
