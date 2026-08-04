/**
 * test/clarice-check-semaphore-4347.test.ts (#4347 Etapa 4, D4)
 *
 * Guard de semáforo da skill /diaria-clarice-novos — decisão pura sobre o
 * resultado de `deriveRampVolumes` (já testado em test/clarice-schedule-ramp.test.ts;
 * aqui só a política "vermelho aborta, resto passa").
 */
import { test, describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideSemaphoreGuard, checkSemaphore, main } from "../scripts/clarice-check-semaphore.ts";

test("decideSemaphoreGuard: semáforo 'red' -> ok=false (aborta)", () => {
  const result = decideSemaphoreGuard({ ok: true, plan: { volumes: [10, 10, 10], semaphore: "red", flagged: [], baseVolume: 30 } });
  assert.equal(result.ok, false);
  assert.equal(result.semaphore, "red");
});

test("decideSemaphoreGuard: semáforo 'yellow' -> ok=true (passa)", () => {
  const result = decideSemaphoreGuard({ ok: true, plan: { volumes: [10, 10, 10], semaphore: "yellow", flagged: [], baseVolume: 30 } });
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "yellow");
});

test("decideSemaphoreGuard: semáforo 'green' -> ok=true (passa)", () => {
  const result = decideSemaphoreGuard({ ok: true, plan: { volumes: [10, 10, 10], semaphore: "green", flagged: [], baseVolume: 30 } });
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "green");
});

test("decideSemaphoreGuard: deriveRampVolumes indeterminado (ok:false) -> passa com aviso, NÃO é 'red'", () => {
  const result = decideSemaphoreGuard({ ok: false, reason: "Nenhum envio maduro (>48h) ainda." });
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "indeterminate");
  assert.match(result.reason ?? "", /maduro/);
});

// ---------------------------------------------------------------------------
// checkSemaphore — GET falhou (não-2xx) é categoria DIFERENTE de
// "indeterminado": trata como falha (lança), não como "seguro prosseguir".
// Simetria com erro de rede (fetch rejeitado), que já propagava como exceção.
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4347): checkSemaphore com GET não-2xx (5xx) LANÇA — não degrada pra indeterminate/passa", async () => {
  const fetchImpl = (async () =>
    new Response("erro interno", { status: 500 })) as typeof fetch;
  await assert.rejects(() => checkSemaphore("https://fake-dashboard", 50, fetchImpl), /falhou \(500\)/);
});

test("checkSemaphore: erro de rede (fetch rejeita) também propaga (simétrico com o 5xx acima)", async () => {
  const fetchImpl = (async () => { throw new Error("network down"); }) as typeof fetch;
  await assert.rejects(() => checkSemaphore("https://fake-dashboard", 50, fetchImpl), /network down/);
});

test("checkSemaphore: GET 2xx bem-formado mas sem envio maduro -> indeterminate/passa (não lança)", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/campaigns")) return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify(null), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const result = await checkSemaphore("https://fake-dashboard", 50, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(result.semaphore, "indeterminate");
});

// ---------------------------------------------------------------------------
// #4544 (achado pr-test-analyzer): este arquivo cobre o guard D4 — mesmo
// subsistema do #4541 (recordedAt fresco não é suficiente pra confiar numa
// leitura do Postmaster, `date` também precisa estar fresco) — e um
// consumidor real de produção (`/diaria-clarice-novos`) — mas não tinha
// nenhum caso exercitando o path de spam do Postmaster de ponta a ponta
// (parecia cair sempre no `.catch(() => null)` de `fetchPostmasterSpamEntry`
// dentro de `checkSemaphore`). Reproduz o cenário exato do incidente 260803
// através de `checkSemaphore`, confirmando que o guard trata a leitura como
// indeterminate/não-confiável (semáforo nunca escalona a verde às cegas),
// não como se fosse dado fresco só porque `recordedAt` é recente.
// ---------------------------------------------------------------------------

test("checkSemaphore: recordedAt fresco mas date stale (#4541) -> semáforo trata leitura como indeterminate, nunca confia nela cegamente", async () => {
  const now = new Date();
  const matureSentDate = new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(); // >48h maduro
  const staleDate = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // 10 dias atrás, além de POSTMASTER_DATA_STALE_MS (5d)
  const healthyCampaign = {
    name: "cold 4541-test",
    subject: "x",
    status: "sent",
    sentDate: matureSentDate,
    scheduledAt: null,
    createdAt: matureSentDate,
    recipients: { lists: [1] },
    statistics: {
      globalStats: {
        sent: 1000, delivered: 990, hardBounces: 2, softBounces: 1, uniqueViews: 300, viewed: 300,
        trackableViews: 300, uniqueClicks: 50, clickers: 40, unsubscriptions: 1, complaints: 0, appleMppOpens: 10,
      },
    },
  };
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/campaigns")) {
      return new Response(JSON.stringify([healthyCampaign]), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/api/postmaster-spam")) {
      // Reproduz o estado exato do incidente 260803: gravado AGORA
      // (recordedAt), mas medindo um dia de 10 dias atrás (date).
      return new Response(
        JSON.stringify({ entry: { spamRatePct: 0.02, recordedAt: now.toISOString(), date: staleDate } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await checkSemaphore("https://fake-dashboard", 50, fetchImpl);
  assert.equal(result.ok, true);
  // saúde boa em tudo (campanha saudável) + spam indeterminate (date stale)
  // → o teto é "yellow" (mantém volume, nunca escalona à cegas) — se o guard
  // tivesse voltado a confiar em `recordedAt` fresco sozinho, isto teria
  // resolvido "green" (spamRatePct=0,02% é bem abaixo do breaker).
  assert.equal(result.semaphore, "yellow");
});

// ---------------------------------------------------------------------------
// #4543 — dashboard pode servir HTTP 200 com dado STALE (ver docstring de
// extractDashboardStaleInfo em clarice-schedule-ramp.ts pra causas reais).
// Decisão do editor: fail-open com visibilidade — nunca tratar como falha,
// mas nunca silencioso (resultado carrega `stale` pra quem consumir o JSON).
// ---------------------------------------------------------------------------

test("REGRESSÃO (#4543): checkSemaphore com X-Dashboard-Stale presente -> resultado carrega `stale`, NÃO lança nem vira 'red'", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/campaigns")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "X-Dashboard-Stale": "upstream-error",
          "X-Dashboard-Upstream-Status": "503",
        },
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await checkSemaphore("https://fake-dashboard", 50, fetchImpl);
  assert.equal(result.ok, true);
  assert.deepEqual(result.stale, { kind: "upstream-error", upstreamStatus: "503" });
});

test("checkSemaphore: sem X-Dashboard-Stale -> `stale` fica ausente (resultado não fica poluído em toda chamada)", async () => {
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/api/campaigns")) {
      return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await checkSemaphore("https://fake-dashboard", 50, fetchImpl);
  assert.equal(result.stale, undefined);
});

// #4568 — o guard pedia `?limit=0` em toda invocação sem flags e o Worker
// respondia 502, então ele abortava SEMPRE, sem nunca avaliar entregabilidade.
// Causa HISTÓRICA: `getArg` devolve "" (não undefined) e
// `resolveDashboardLimit("")` = 0. O caminho ATUAL deste arquivo não passa mais
// por `resolveDashboardLimit` — `main()` chama `getIntArg` direto —, então
// estes testes andam sobre o código novo, não sobre o antigo.
//
// CUIDADO ao reusar `urlPedida`: ele só captura REJEIÇÃO. Caminhos que saem por
// `process.exit` (ex: semáforo vermelho) não rejeitam e passariam batido.
describe("main(): limite pedido ao dashboard (#4568)", () => {
  async function urlPedida(argv: string[]): Promise<string> {
    let capturada = "";
    const prevFetch = globalThis.fetch;
    const prevLog = console.log;
    const prevErr = console.error;
    globalThis.fetch = (async (u: string | URL | Request) => {
      const s = String(u);
      if (s.includes("/api/campaigns")) capturada = s;
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    console.log = () => {};
    console.error = () => {};
    try {
      // `main` vem do import estático no topo — nada de `import()` dinâmico
      // aqui (review #4571: reimportar só re-busca o mesmo namespace de módulo
      // e adiciona uma janela de corrida sem ganho nenhum).
      await main(argv);
    } finally {
      globalThis.fetch = prevFetch;
      console.log = prevLog;
      console.error = prevErr;
    }
    return capturada;
  }

  it("SEM flags pede o default (50), nunca limit=0", async () => {
    const url = await urlPedida([]);
    assert.match(url, /[?&]limit=50\b/);
    assert.doesNotMatch(url, /[?&]limit=0\b/, "limit=0 faz o Worker devolver 502");
  });

  it("--dashboard-limit explícito é respeitado", async () => {
    assert.match(await urlPedida(["--dashboard-limit", "5"]), /[?&]limit=5\b/);
  });

  it("--dashboard-limit 0 ABORTA com erro de CLI legível, em vez de virar 502 do Worker", async () => {
    await assert.rejects(() => urlPedida(["--dashboard-limit", "0"]), /inteiro ≥ 1/);
  });

  it("--dashboard-limit sem valor ABORTA (mesma classe de bug)", async () => {
    await assert.rejects(() => urlPedida(["--dashboard-limit"]), /sem valor/);
  });
});

// #4571 review: negativo toma outro ramo da checagem do getIntArg
// (`!Number.isInteger(v) || v < min`), mesma rejeição. Grátis de cobrir.
test("--dashboard-limit negativo ABORTA", async () => {
  const prevFetch = globalThis.fetch;
  const prevLog = console.log;
  const prevErr = console.error;
  globalThis.fetch = (async () => new Response("[]", { status: 200 })) as typeof fetch;
  console.log = () => {};
  console.error = () => {};
  try {
    await assert.rejects(() => main(["--dashboard-limit", "-1"]), /inteiro ≥ 1/);
  } finally {
    globalThis.fetch = prevFetch;
    console.log = prevLog;
    console.error = prevErr;
  }
});
