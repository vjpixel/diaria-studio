/**
 * test/cursos-error-alarm-script.test.ts (#4320, REDESENHADO no #4382)
 *
 * Cobre a camada de I/O de `scripts/cursos-error-alarm.ts` — parsing do
 * valor cru lido do KV (`parseCounterValue`) e a leitura dos 4 contadores em
 * si (`fetchCurrentCounters`), com `fetch` mockado (nunca rede real em
 * teste, mesmo padrão de `test/cloudflare-kv-upload.test.ts`).
 *
 * #4382: a versão original testava `parseGraphqlLogsResponse`/
 * `fetchCursosLogEvents` contra a Cloudflare GraphQL Analytics API —
 * confirmado ao vivo que o dataset usado não existe na API real. O redesign
 * lê 4 chaves KV via `getTextFromWorkerKV` (fetch-based, injetável) em vez de
 * fazer uma query GraphQL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCounterValue, fetchCurrentCounters } from "../scripts/cursos-error-alarm.ts";
import { CURSOS_ALARM_COUNTER_KEYS } from "../scripts/lib/shared/cursos-alarm-counters.ts";

// ── parseCounterValue ──

test("parseCounterValue — string numérica válida → inteiro", () => {
  assert.equal(parseCounterValue("42"), 42);
  assert.equal(parseCounterValue("0"), 0);
});

test("parseCounterValue — null (chave ausente no KV) → 0", () => {
  assert.equal(parseCounterValue(null), 0);
});

test("parseCounterValue — lixo/corrompido/negativo → 0 (fail-soft, nunca lança)", () => {
  assert.equal(parseCounterValue("não é número"), 0);
  assert.equal(parseCounterValue(""), 0);
  assert.equal(parseCounterValue("-5"), 0);
  assert.equal(parseCounterValue("NaN"), 0);
});

// ── fetchCurrentCounters ──

function mockFetchWithValues(values: Record<string, string | null>) {
  return async (url: string) => {
    const key = decodeURIComponent(url.split("/values/").pop() ?? "");
    const v = values[key];
    if (v === undefined || v === null) return new Response("not found", { status: 404 });
    return new Response(v, { status: 200 });
  };
}

test("fetchCurrentCounters — lê as 4 chaves e monta o snapshot", async () => {
  const fetchImpl = mockFetchWithValues({
    [CURSOS_ALARM_COUNTER_KEYS.fatalCookieHmacSecretAusente]: "3",
    [CURSOS_ALARM_COUNTER_KEYS.fatalCadastroBeehiivFalhou]: "1",
    [CURSOS_ALARM_COUNTER_KEYS.emailGateConfirmed]: "120",
    [CURSOS_ALARM_COUNTER_KEYS.emailGateNotConfirmed]: "8",
  });
  const snapshot = await fetchCurrentCounters("ns123", { accountId: "acc1", token: "tok1" }, fetchImpl as typeof fetch);
  assert.deepEqual(snapshot, {
    fatalCookieHmacSecretAusente: 3,
    fatalCadastroBeehiivFalhou: 1,
    emailGateConfirmed: 120,
    emailGateNotConfirmed: 8,
  });
});

test("fetchCurrentCounters — chaves ausentes (nunca incrementadas, 1ª leitura do worker) → 0, não lança", async () => {
  const fetchImpl = mockFetchWithValues({});
  const snapshot = await fetchCurrentCounters("ns123", { accountId: "acc1", token: "tok1" }, fetchImpl as typeof fetch);
  assert.deepEqual(snapshot, {
    fatalCookieHmacSecretAusente: 0,
    fatalCadastroBeehiivFalhou: 0,
    emailGateConfirmed: 0,
    emailGateNotConfirmed: 0,
  });
});

test("fetchCurrentCounters — falha de rede/auth real (não-404) propaga exceção (caller decide não avançar o cursor)", async () => {
  const fetchImpl = async () => new Response("token inválido", { status: 401 });
  await assert.rejects(
    fetchCurrentCounters("ns123", { accountId: "acc1", token: "tok-invalido" }, fetchImpl as typeof fetch),
    /401/,
  );
});
