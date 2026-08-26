/**
 * test/dump-worker-logs-paginacao-6318.test.ts (#6318)
 *
 * Cobertura do que o review da PR #6324 apontou como o buraco mais perigoso:
 * a paginação e o parse de envelope de `dump-worker-logs.ts` não tinham
 * teste nenhum, e é justamente onde um truncamento silencioso custaria dado
 * que expira e não volta.
 *
 * Sem rede: `fetchImpl` injetado (mesmo padrão de `test/kit-subscribers.test.ts`).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fetchAllEvents,
  extractEvents,
  ObservabilityShapeError,
  type RawLogEvent,
} from "../scripts/dump-worker-logs.ts";

const DEPS_BASE = { accountId: "acct", token: "tok" };

/** Resposta no envelope aninhado que a API devolve hoje. */
function resposta(events: RawLogEvent[]): Response {
  return new Response(JSON.stringify({ result: { events: { events } } }), { status: 200 });
}

function eventosFalsos(n: number, tsInicial: number): RawLogEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: tsInicial - i,
    source: { message: `GET https://eia.diar.ia.br/jogar?i=${i}` },
  }));
}

describe("extractEvents", () => {
  test("aceita o envelope aninhado (result.events.events)", () => {
    assert.equal(extractEvents({ result: { events: { events: [{ timestamp: 1 }] } } }, "poll").length, 1);
  });

  test("aceita o envelope plano (result.events)", () => {
    assert.equal(extractEvents({ result: { events: [{ timestamp: 1 }] } }, "poll").length, 1);
  });

  test("envelope desconhecido LANCA — nunca vira lista vazia", () => {
    // O bug que isto previne: um 200 com forma inesperada colapsando em []
    // seria lido pelo operador como "worker sem observability", quando na
    // verdade a leitura quebrou.
    assert.throws(() => extractEvents({ result: { eventos: [] } }, "poll"), ObservabilityShapeError);
    assert.throws(() => extractEvents({}, "poll"), ObservabilityShapeError);
    assert.throws(() => extractEvents(null, "poll"), ObservabilityShapeError);
  });

  test("lista genuinamente vazia continua sendo vazia, nao erro", () => {
    assert.deepEqual(extractEvents({ result: { events: { events: [] } } }, "poll"), []);
  });
});

describe("fetchAllEvents", () => {
  test("pagina ate a janela acabar e concatena tudo", async () => {
    const paginas = [eventosFalsos(1000, 5000), eventosFalsos(1000, 3000), eventosFalsos(10, 1500)];
    let chamada = 0;
    const fetchImpl = (async () => resposta(paginas[chamada++])) as unknown as typeof fetch;

    const { events, truncado } = await fetchAllEvents({ ...DEPS_BASE, fetchImpl }, "poll", 0, 6000);
    assert.equal(events.length, 2010);
    assert.equal(truncado, false, "pagina final incompleta => captura completa");
    assert.equal(chamada, 3);
  });

  test("pagina incompleta encerra sem marcar truncamento", async () => {
    const fetchImpl = (async () => resposta(eventosFalsos(10, 5000))) as unknown as typeof fetch;
    const { events, truncado } = await fetchAllEvents({ ...DEPS_BASE, fetchImpl }, "cursos", 0, 6000);
    assert.equal(events.length, 10);
    assert.equal(truncado, false);
  });

  test("MAX_PAGES esgotado com pagina ainda cheia MARCA truncado (achado P1 do review)", async () => {
    // Toda página cheia e sempre progredindo: o laço só para pelo cap.
    // Antes do fix, isto devolvia um resultado parcial com cara de completo.
    let ts = 10_000_000;
    const fetchImpl = (async () => {
      const pagina = eventosFalsos(1000, ts);
      ts -= 2000;
      return resposta(pagina);
    }) as unknown as typeof fetch;

    const { events, truncado } = await fetchAllEvents({ ...DEPS_BASE, fetchImpl }, "poll", 0, 10_000_001);
    assert.equal(truncado, true, "esgotar MAX_PAGES com dado restante precisa ser sinalizado");
    assert.equal(events.length, 60_000, "60 paginas de 1000");
  });

  test("timestamp ausente em toda a pagina para o laco em vez de girar", async () => {
    const semTs = [{ source: { message: "GET https://x/y" } }];
    let chamadas = 0;
    const fetchImpl = (async () => {
      chamadas++;
      return resposta(semTs);
    }) as unknown as typeof fetch;
    const { events, truncado } = await fetchAllEvents({ ...DEPS_BASE, fetchImpl }, "poll", 0, 6000);
    assert.equal(events.length, 1);
    assert.equal(truncado, false);
    assert.equal(chamadas, 1);
  });

  test("HTTP nao-2xx propaga erro em vez de virar captura vazia", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(
      () => fetchAllEvents({ ...DEPS_BASE, fetchImpl }, "poll", 0, 6000),
      /403/,
    );
  });
});
