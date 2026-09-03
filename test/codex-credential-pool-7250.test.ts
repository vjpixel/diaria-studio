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

  it('429 como STRING conta igual — o tipo permite, então o teste cobra', () => {
    // `last_error_code` é `number | string | null` porque o Hermes já
    // serializou código HTTP das duas formas. Se só o número fosse coberto,
    // uma conta esgotada passaria por `indeterminada` no dia em que o formato
    // mudasse — e `indeterminada` não alarma sozinha.
    const v = classifyCodexCredential({ label: "x", last_status: "error", last_error_code: "429" });
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

  it("pool VAZIO alarma — perder de vista as contas não é 'está tudo bem'", () => {
    // Este teste inverteu durante o review do #7250. A versão original
    // afirmava `shouldAlarm: false`, tratando zero entradas como silêncio
    // legítimo — o que dava fail-OPEN justamente no sinal mais grave: o
    // rastreamento das contas sumiu. Note que isto NÃO é "não consegui ler"
    // (esse caso é `readCodexPool` → `null` → exit 1); é ler com sucesso um
    // pool que ficou sem nenhuma conta.
    const v = evaluateCodexPool([]);
    assert.equal(v.poolVazio, true);
    assert.equal(v.shouldAlarm, true);
    assert.equal(v.allExhausted, false, "vazio não é o mesmo que todas esgotadas");
  });

  it("pool vazio tem mensagem própria, que não fala em conta esgotada", () => {
    const msg = buildCodexAlarmMessage(evaluateCodexPool([]), "2026-09-03T08:00:00Z");
    assert.match(msg, /VAZIO/);
    assert.match(msg, /nenhuma conta rastreada/);
    assert.doesNotMatch(msg, /Resta \d+ conta/, "não pode reusar o texto de contagem");
  });

  it("o fingerprint do pool vazio é estável e distinto de qualquer pool com contas", () => {
    const vazio = computeCodexPoolFingerprint(evaluateCodexPool([]));
    assert.equal(vazio, computeCodexPoolFingerprint(evaluateCodexPool([])));
    assert.notEqual(vazio, computeCodexPoolFingerprint(evaluateCodexPool(POOL_REAL)));
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

const ESGOTADA_VOLTA_29_09 = {
  label: "vjpixel",
  last_status: "exhausted",
  last_error_reason: "usage_limit_reached",
  last_error_code: 429,
  last_error_reset_at: Date.parse("2026-09-29T17:45:00Z") / 1000,
};

describe("#7320 — resets_at no passado", () => {
  // ─── #7320 ───
// `resets_at` no passado não é `esgotada` nem `viva` — é `indeterminada`.


  it("#7320 — antes da data de retorno, segue ESGOTADA", () => {
  const v = classifyCodexCredential(ESGOTADA_VOLTA_29_09, "2026-09-03T09:00:00Z");
  assert.equal(v.state, "esgotada");
  assert.equal(v.resetsAtIso?.slice(0, 10), "2026-09-29");
});

  it("#7320 — DEPOIS da data de retorno vira INDETERMINADA, não viva nem esgotada", () => {
  const v = classifyCodexCredential(ESGOTADA_VOLTA_29_09, "2026-09-30T09:00:00Z");
  assert.equal(v.state, "indeterminada", "promessa da OpenAI não vira fato nosso — mas afirmar esgotamento também não");
  assert.match(v.reason, /data de retorno já passou/);
  assert.equal(v.resetsAtIso?.slice(0, 10), "2026-09-29", "a data continua visível na mensagem");
});

  it("#7320 — o relógio é INJETADO: a mesma entrada muda de estado só pelo tempo passar", () => {
  const antes = classifyCodexCredential(ESGOTADA_VOLTA_29_09, "2026-09-29T17:44:00Z");
  const depois = classifyCodexCredential(ESGOTADA_VOLTA_29_09, "2026-09-29T17:46:00Z");
  assert.equal(antes.state, "esgotada");
  assert.equal(depois.state, "indeterminada");
});

  it("#7320 — conta indeterminada por data vencida NÃO conta como viva (fail-closed)", () => {
  // Cenário exato de 30/09/2026 no helios: 2 esgotadas com data já vencida,
  // 1 viva. O alarme tem de continuar disparando — ninguém confirmou que as
  // duas voltaram.
  const v = evaluateCodexPool(
    [
      ESGOTADA_VOLTA_29_09,
      { ...ESGOTADA_VOLTA_29_09, label: "diaria.editor" },
      { label: "memelab", last_status: "ok" },
    ],
    undefined,
    "2026-09-30T09:00:00Z",
  );
  assert.equal(v.vivas, 1, "só a que reportou ok conta como viva");
  assert.equal(v.indeterminadas, 2);
  assert.equal(v.esgotadas, 0);
  assert.equal(v.shouldAlarm, true, "segue alarmando — o estado das duas é desconhecido, não saudável");
  assert.equal(v.allExhausted, false);
});

  it("#7320 — a mensagem não afirma a origem errada do estado indeterminado", () => {
  const v = evaluateCodexPool([ESGOTADA_VOLTA_29_09, { label: "memelab", last_status: "ok" }], undefined, "2026-09-30T09:00:00Z");
  const msg = buildCodexAlarmMessage(v, "2026-09-30T09:00:00Z");
  assert.match(msg, /data de retorno já passou/, "a razão específica aparece");
  assert.match(msg, /nunca vira "está esgotada"/, "a nota agregada cobre as duas origens");
});

  it("#7320 — entrada sem resets_at continua ESGOTADA (nada a comparar)", () => {
  const v = classifyCodexCredential(
    { label: "x", last_status: "exhausted", last_error_reason: "usage_limit_reached", last_error_code: 429 },
    "2030-01-01T00:00:00Z",
  );
  assert.equal(v.state, "esgotada", "sem data prometida não há como dizer que ela passou");
});
});

describe("#7320 — zero vivas não implica todas esgotadas", () => {
  it('#7320 — 3 contas com data vencida: nunca afirma "TODAS esgotadas / delegação parada"', () => {
    // Sem esta distinção o alarme diria que a delegação está parada sobre um
    // pool que pode estar inteiro utilizável — ninguém retestou.
    const v = evaluateCodexPool(
      [
        ESGOTADA_VOLTA_29_09,
        { ...ESGOTADA_VOLTA_29_09, label: "diaria.editor" },
        { ...ESGOTADA_VOLTA_29_09, label: "memelab" },
      ],
      undefined,
      "2026-10-05T09:00:00Z",
    );
    assert.equal(v.vivas, 0);
    assert.equal(v.esgotadas, 0, "nenhuma CONFIRMADA esgotada");
    assert.equal(v.allExhausted, true, "o campo segue sendo vivas===0 — não é ele que muda");

    const msg = buildCodexAlarmMessage(v, "2026-10-05T09:00:00Z");
    assert.doesNotMatch(msg, /TODAS as contas Codex estão esgotadas/);
    assert.doesNotMatch(msg, /delegação está parada/);
    assert.match(msg, /estado das 3 é desconhecido/);
    assert.match(msg, /podem estar todas utilizáveis, ou nenhuma/);
  });

  it("#7320 — esgotamento REAL de todas continua dizendo que a delegação parou", () => {
    const v = evaluateCodexPool(
      [
        { ...ESGOTADA_VOLTA_29_09, label: "a" },
        { ...ESGOTADA_VOLTA_29_09, label: "b" },
      ],
      undefined,
      "2026-09-03T09:00:00Z", // antes da data de retorno: esgotamento confirmado
    );
    assert.equal(v.esgotadas, 2);
    const msg = buildCodexAlarmMessage(v, "2026-09-03T09:00:00Z");
    assert.match(msg, /TODAS as contas Codex estão esgotadas/, "o caso real não foi enfraquecido");
    assert.match(msg, /delegação está parada/);
  });
});
