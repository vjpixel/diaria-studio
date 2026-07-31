/**
 * test/cursos-error-alarm-script.test.ts (#4320)
 *
 * Cobre a camada de I/O de `scripts/cursos-error-alarm.ts` — parsing da
 * resposta GraphQL (`parseGraphqlLogsResponse`) e a chamada de rede em si
 * (`fetchCursosLogEvents`), com `fetch` mockado (nunca rede real em teste,
 * mesmo padrão de `test/postmaster-spam-sync.test.ts`/`check-cloudflare-token.test.ts`).
 *
 * IMPORTANTE (ver docstring do módulo): o shape de `logs{}` por grupo de
 * invocação não foi confirmado contra uma resposta real da Cloudflare
 * GraphQL Analytics API nesta sessão (sem credenciais/rede ao vivo). Estes
 * testes travam o CONTRATO assumido por `parseGraphqlLogsResponse` — se o
 * schema real divergir, só essa função (+ `CURSOS_LOGS_QUERY`) precisa
 * mudar, e estes testes voltam a ser o guia de "o que o parser espera".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPHQL_URL,
  CURSOS_SCRIPT_NAME,
  parseGraphqlLogsResponse,
  fetchCursosLogEvents,
  type RawGraphqlLogsResponse,
} from "../scripts/cursos-error-alarm.ts";

// ── parseGraphqlLogsResponse ──

test("parseGraphqlLogsResponse — achata grupos de invocação em CursosLogEvent[], usando o datetime do grupo", () => {
  const body: RawGraphqlLogsResponse = {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptiveGroups: [
              {
                dimensions: { datetime: "2026-07-31T10:00:00Z" },
                logs: [
                  { message: "[cursos] COOKIE_HMAC_SECRET ausente — servindo teaser; NINGUÉM consegue desbloquear", level: "error" },
                ],
              },
              {
                dimensions: { datetime: "2026-07-31T10:05:00Z" },
                logs: [{ message: "[cursos] ?email= não confirmado como assinante ativo — servindo teaser", level: "warn" }],
              },
            ],
          },
        ],
      },
    },
  };
  const events = parseGraphqlLogsResponse(body);
  assert.equal(events.length, 2);
  assert.equal(events[0].timestamp, "2026-07-31T10:00:00Z");
  assert.match(events[0].message, /COOKIE_HMAC_SECRET ausente/);
  assert.equal(events[1].timestamp, "2026-07-31T10:05:00Z");
});

test("parseGraphqlLogsResponse — grupo sem `logs` (invocação sem console.log) → nenhum evento, não lança", () => {
  const body: RawGraphqlLogsResponse = {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptiveGroups: [{ dimensions: { datetime: "2026-07-31T10:00:00Z" } }],
          },
        ],
      },
    },
  };
  assert.deepEqual(parseGraphqlLogsResponse(body), []);
});

test("parseGraphqlLogsResponse — resposta vazia/sem accounts → array vazio, não lança", () => {
  assert.deepEqual(parseGraphqlLogsResponse({}), []);
  assert.deepEqual(parseGraphqlLogsResponse({ data: { viewer: { accounts: [] } } }), []);
});

test("parseGraphqlLogsResponse — log com message vazia/ausente é descartado", () => {
  const body: RawGraphqlLogsResponse = {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptiveGroups: [
              {
                dimensions: { datetime: "2026-07-31T10:00:00Z" },
                logs: [{ message: "", level: "log" }, { level: "log" }, { message: "linha real" }],
              },
            ],
          },
        ],
      },
    },
  };
  const events = parseGraphqlLogsResponse(body);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "linha real");
});

// ── fetchCursosLogEvents ──

function mockFetchOk(body: RawGraphqlLogsResponse) {
  return async (url: string, init?: RequestInit) => {
    assert.equal(url, GRAPHQL_URL);
    const parsedBody = JSON.parse(String(init?.body));
    assert.equal(parsedBody.variables.scriptName, CURSOS_SCRIPT_NAME);
    assert.match(String((init?.headers as Record<string, string>)?.Authorization ?? ""), /^Bearer /);
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test("fetchCursosLogEvents — 200 com eventos → retorna CursosLogEvent[] parseado", async () => {
  const body: RawGraphqlLogsResponse = {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptiveGroups: [
              { dimensions: { datetime: "2026-07-31T10:00:00Z" }, logs: [{ message: "linha 1" }] },
            ],
          },
        ],
      },
    },
  };
  const events = await fetchCursosLogEvents(
    "acc123",
    "token456",
    new Date("2026-07-31T08:00:00Z"),
    new Date("2026-07-31T10:00:00Z"),
    mockFetchOk(body) as typeof fetch,
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "linha 1");
});

test("fetchCursosLogEvents — HTTP não-ok → lança com status no texto do erro", async () => {
  const fetchImpl = async () => new Response("token inválido", { status: 401 });
  await assert.rejects(
    fetchCursosLogEvents("acc123", "token-invalido", new Date(), new Date(), fetchImpl as typeof fetch),
    /401/,
  );
});

test("fetchCursosLogEvents — corpo com `errors` do GraphQL (200 mas query inválida) → lança", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ errors: [{ message: 'Unknown argument "scriptName"' }] }), { status: 200 });
  await assert.rejects(
    fetchCursosLogEvents("acc123", "token456", new Date(), new Date(), fetchImpl as typeof fetch),
    /Unknown argument/,
  );
});
