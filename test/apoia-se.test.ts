/**
 * test/apoia-se.test.ts (#3500)
 *
 * Regressão para scripts/lib/apoia-se.ts — SEM rede real: `fetchImpl` é
 * sempre um mock. Cobre os 4 shapes de resposta documentados (200 pagante,
 * 200 não-pago, not-found, 401), env vars ausentes, throttle (≤5 req/s,
 * timers injetados) e cache por mês-competência (hit/miss/virada de mês).
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkBacker,
  readApoiaSeEnv,
  competenceMonth,
  defaultCacheDir,
  readMonthCache,
  RateLimiter,
  ApoiaSeAuthError,
  ApoiaSeApiError,
  isCacheEntryStale,
  CURRENT_MONTH_CACHE_TTL_HOURS,
  type ApoiaSeEnv,
  type BackerStatus,
} from "../scripts/lib/apoia-se.ts";

const ENV: ApoiaSeEnv = { apiKey: "test-key", apiSecret: "test-secret", campaign: "diaria" };

// ---------------------------------------------------------------------------
// readApoiaSeEnv
// ---------------------------------------------------------------------------

describe("readApoiaSeEnv", () => {
  it("lê as 3 vars quando presentes", () => {
    const env = readApoiaSeEnv({
      APOIA_SE_API_KEY: "k",
      APOIA_SE_API_SECRET: "s",
      APOIA_SE_CAMPAIGN: "diaria",
    } as NodeJS.ProcessEnv);
    assert.deepEqual(env, { apiKey: "k", apiSecret: "s", campaign: "diaria" });
  });

  it("erro claro citando os NOMES das vars ausentes, nunca valores", () => {
    assert.throws(
      () => readApoiaSeEnv({} as NodeJS.ProcessEnv),
      (e: Error) => {
        assert.match(e.message, /APOIA_SE_API_KEY/);
        assert.match(e.message, /APOIA_SE_API_SECRET/);
        assert.match(e.message, /APOIA_SE_CAMPAIGN/);
        return true;
      },
    );
  });

  it("lista só as vars faltantes quando parcialmente presente", () => {
    assert.throws(
      () =>
        readApoiaSeEnv({
          APOIA_SE_API_KEY: "k",
          APOIA_SE_API_SECRET: "",
          APOIA_SE_CAMPAIGN: "diaria",
        } as NodeJS.ProcessEnv),
      (e: Error) => {
        assert.match(e.message, /APOIA_SE_API_SECRET/);
        assert.doesNotMatch(e.message, /APOIA_SE_API_KEY\b.*ausente/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// competenceMonth / defaultCacheDir (pure helpers)
// ---------------------------------------------------------------------------

describe("competenceMonth", () => {
  it("formata YYYY-MM em BRT", () => {
    // 2026-07-16T02:00:00Z = 2026-07-15 23:00 BRT (UTC-3) — ainda julho.
    assert.equal(competenceMonth(new Date("2026-07-16T02:00:00Z")), "2026-07");
  });

  it("respeita virada de mês (BRT) mesmo perto da meia-noite UTC", () => {
    // 2026-08-01T02:30:00Z = 2026-07-31 23:30 BRT — ainda julho, não agosto.
    assert.equal(competenceMonth(new Date("2026-08-01T02:30:00Z")), "2026-07");
    // 2026-08-01T03:30:00Z = 2026-08-01 00:30 BRT — já agosto.
    assert.equal(competenceMonth(new Date("2026-08-01T03:30:00Z")), "2026-08");
  });
});

describe("defaultCacheDir", () => {
  it("namespaced por campanha sob data/apoia-se/", () => {
    const dir = defaultCacheDir("diaria");
    assert.match(dir.replace(/\\/g, "/"), /data\/apoia-se\/diaria$/);
  });
});

// ---------------------------------------------------------------------------
// RateLimiter — timers injetados, sem espera real
// ---------------------------------------------------------------------------

describe("RateLimiter", () => {
  it("default maxPerSecond=5 espaça em incrementos de 200ms (now fixo)", async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter({
      now: () => 0, // relógio fixo — força o limiter a sempre pedir o delta completo
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    const order: number[] = [];
    await Promise.all(
      [0, 1, 2, 3, 4].map((i) => limiter.throttle(async () => void order.push(i))),
    );
    // 1ª chamada não espera (slot 0); as seguintes esperam 200,400,600,800.
    assert.deepEqual(waits, [200, 400, 600, 800]);
    // FIFO: ordem de execução preserva ordem de submissão.
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
  });

  it("maxPerSecond customizado muda o intervalo (2/s → 500ms)", async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter({
      maxPerSecond: 2,
      now: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    await Promise.all([0, 1, 2].map(() => limiter.throttle(async () => {})));
    assert.deepEqual(waits, [500, 1000]);
  });

  it("não espera quando o relógio já avançou além do próximo slot", async () => {
    let clock = 0;
    const waits: number[] = [];
    const limiter = new RateLimiter({
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    await limiter.throttle(async () => {});
    clock += 10_000; // muito tempo depois — próxima chamada não deveria esperar
    await limiter.throttle(async () => {});
    assert.deepEqual(waits, []); // nenhuma das duas precisou esperar
  });

  it("rejeita maxPerSecond <= 0", () => {
    assert.throws(() => new RateLimiter({ maxPerSecond: 0 }));
    assert.throws(() => new RateLimiter({ maxPerSecond: -1 }));
  });

  it("retorno de fn() propaga corretamente", async () => {
    const limiter = new RateLimiter({ now: () => 0, sleep: async () => {} });
    const result = await limiter.throttle(async () => 42);
    assert.equal(result, 42);
  });
});

// ---------------------------------------------------------------------------
// checkBacker — fetch mockado, cache em tmpdir isolado
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Limiter "rápido" (real timers, minIntervalMs=1ms) — usado nos testes de
// checkBacker que NÃO estão testando o throttle em si (esses injetam o
// próprio RateLimiter com now/sleep fake). Evita que essas chamadas
// compartilhem o singleton default do módulo (real 200ms/chamada, que
// acumularia ~1-2s de espera real ao longo da suíte).
const fastLimiter = new RateLimiter({ maxPerSecond: 1000 });

describe("checkBacker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "apoia-se-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("200 apoiador pagante → shape completo com thisMonthPaidValue", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 });
    }) as unknown as typeof fetch;

    const status = await checkBacker("Paid@Example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-07-16T12:00:00Z"),
    });

    assert.deepEqual(status, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 });
    assert.equal(calls, 1);
  });

  it("200 apoiador registrado mas não-pago → isPaidThisMonth false, sem thisMonthPaidValue", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: false })) as unknown as typeof fetch;

    const status = await checkBacker("unpaid@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-07-16T12:00:00Z"),
    });

    assert.deepEqual(status, { isBacker: true, isPaidThisMonth: false } as BackerStatus);
    assert.equal("thisMonthPaidValue" in status, false);
  });

  it("200 e-mail não encontrado → { isBacker:false, isPaidThisMonth:false } sem thisMonthPaidValue", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: false, isPaidThisMonth: false })) as unknown as typeof fetch;

    const status = await checkBacker("naoexiste@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-07-16T12:00:00Z"),
    });

    assert.deepEqual(status, { isBacker: false, isPaidThisMonth: false });
    assert.equal("thisMonthPaidValue" in status, false);
  });

  it("401 → ApoiaSeAuthError distinta, nunca cacheia", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(401, { message: "não autorizado" });
    }) as unknown as typeof fetch;

    await assert.rejects(
      checkBacker("bad@example.com", {
        env: ENV,
        fetchImpl,
        cacheDir: tmpDir,
        limiter: fastLimiter,
        now: new Date("2026-07-16T12:00:00Z"),
      }),
      (e: Error) => {
        assert.ok(e instanceof ApoiaSeAuthError);
        assert.match(e.message, /401/);
        return true;
      },
    );

    // 401 não deve poluir o cache — uma 2ª tentativa deve bater na API de novo.
    await assert.rejects(
      checkBacker("bad@example.com", {
        env: ENV,
        fetchImpl,
        cacheDir: tmpDir,
        limiter: fastLimiter,
        now: new Date("2026-07-16T12:00:00Z"),
      }),
    );
    assert.equal(calls, 2);
  });

  it("outro erro HTTP (ex: 500) → ApoiaSeApiError com status", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    await assert.rejects(
      checkBacker("x@example.com", {
        env: ENV,
        fetchImpl,
        cacheDir: tmpDir,
        limiter: fastLimiter,
        now: new Date("2026-07-16T12:00:00Z"),
      }),
      (e: Error) => {
        assert.ok(e instanceof ApoiaSeApiError);
        assert.equal((e as ApoiaSeApiError).status, 500);
        return true;
      },
    );
  });

  it("erro de rede (fetch rejeita) propaga como Error legível", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await assert.rejects(
      checkBacker("x@example.com", {
        env: ENV,
        fetchImpl,
        cacheDir: tmpDir,
        limiter: fastLimiter,
        now: new Date("2026-07-16T12:00:00Z"),
      }),
      /ECONNREFUSED/,
    );
  });

  it("normaliza email (trim + lowercase) e rejeita email vazio", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 10 })) as unknown as typeof fetch;

    const status = await checkBacker("  Foo@Bar.COM  ", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-07-16T12:00:00Z"),
    });
    assert.equal(status.isBacker, true);

    // O cache deve ter sido gravado com a chave normalizada.
    const cachePath = resolve(tmpDir, "2026-07.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.ok("foo@bar.com" in cache);

    await assert.rejects(
      checkBacker("   ", { env: ENV, fetchImpl, cacheDir: tmpDir, limiter: fastLimiter }),
      /email vazio/,
    );
  });

  it("cache HIT não bate na API", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 });
    }) as unknown as typeof fetch;
    const now = new Date("2026-07-16T12:00:00Z");

    const first = await checkBacker("cached@example.com", { env: ENV, fetchImpl, cacheDir: tmpDir, now, limiter: fastLimiter });
    const second = await checkBacker("cached@example.com", { env: ENV, fetchImpl, cacheDir: tmpDir, now, limiter: fastLimiter });

    assert.deepEqual(first, second);
    assert.equal(calls, 1, "2ª chamada devia ter vindo do cache, sem novo fetch");
  });

  it("cache MISS bate na API e grava o resultado em disco (com fetchedAt, #4490)", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 })) as unknown as typeof fetch;
    const now = new Date("2026-07-16T12:00:00Z");

    const cachePath = resolve(tmpDir, "2026-07.json");
    assert.equal(existsSync(cachePath), false);

    const returned = await checkBacker("miss@example.com", { env: ENV, fetchImpl, cacheDir: tmpDir, now, limiter: fastLimiter });

    // Valor de retorno pro caller nunca inclui fetchedAt — shape público
    // estável de BackerStatus.
    assert.deepEqual(returned, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 });

    assert.equal(existsSync(cachePath), true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.deepEqual(cache["miss@example.com"], {
      isBacker: true,
      isPaidThisMonth: true,
      thisMonthPaidValue: 25,
      fetchedAt: now.toISOString(),
    });
  });

  it("virada de mês invalida o cache — mês novo sempre bate na API de novo", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, { isBacker: true, isPaidThisMonth: calls === 1, thisMonthPaidValue: calls * 10 });
    }) as unknown as typeof fetch;

    const july = await checkBacker("rollover@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-07-16T12:00:00Z"),
    });
    const august = await checkBacker("rollover@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-16T12:00:00Z"),
    });

    assert.equal(calls, 2, "cada mês-competência deve gerar sua própria chamada");
    assert.notDeepEqual(july, august);
    assert.equal(existsSync(resolve(tmpDir, "2026-07.json")), true);
    assert.equal(existsSync(resolve(tmpDir, "2026-08.json")), true);
  });

  it("throttle: usa o limiter injetado (respeita ≤5 req/s configurável)", async () => {
    const waits: number[] = [];
    const limiter = new RateLimiter({
      maxPerSecond: 5,
      now: () => 0,
      sleep: async (ms) => {
        waits.push(ms);
      },
    });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, { isBacker: false, isPaidThisMonth: false });
    }) as unknown as typeof fetch;

    // 3 emails distintos (cache miss cada) no mesmo mês → 3 chamadas throttled.
    await Promise.all(
      ["a@x.com", "b@x.com", "c@x.com"].map((email) =>
        checkBacker(email, {
          env: ENV,
          fetchImpl,
          cacheDir: tmpDir,
          now: new Date("2026-07-16T12:00:00Z"),
          limiter,
        }),
      ),
    );

    assert.equal(calls, 3);
    assert.deepEqual(waits, [200, 400]); // 1ª sem espera, 2ª e 3ª espaçadas
  });

  // ── forceRefresh (#3859 — botão "Atualizar status") ────────────────────

  it("forceRefresh:true ignora um cache HIT e bate na API de novo (cenário da issue: apoiador paga dia 15, cache tinha false do dia 1º)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // 1ª chamada (dia 1º): ainda não pagou. 2ª chamada (dia 15, force):
      // já pagou.
      return jsonResponse(200, {
        isBacker: true,
        isPaidThisMonth: calls > 1,
        ...(calls > 1 ? { thisMonthPaidValue: 30 } : {}),
      });
    }) as unknown as typeof fetch;
    const now = new Date("2026-07-16T12:00:00Z");

    const day1 = await checkBacker("late-payer@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      now,
      limiter: fastLimiter,
    });
    assert.equal(day1.isPaidThisMonth, false, "dia 1º: ainda não pagou, grava false no cache");

    // Sem forceRefresh, o cache HIT esconderia o pagamento do dia 15 até a
    // virada do mês — a regressão que a issue #3859 descreve.
    const withoutForce = await checkBacker("late-payer@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      now,
      limiter: fastLimiter,
    });
    assert.equal(withoutForce.isPaidThisMonth, false, "sem forceRefresh, cache HIT nunca bate na API de novo");
    assert.equal(calls, 1, "2ª chamada sem force não gerou request nova");

    const day15 = await checkBacker("late-payer@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      now,
      limiter: fastLimiter,
      forceRefresh: true,
    });
    assert.equal(calls, 2, "forceRefresh:true ignora o cache HIT e gera uma request nova");
    assert.equal(day15.isPaidThisMonth, true, "force-refresh corrige o status pro pagamento do dia 15");
    assert.equal(day15.thisMonthPaidValue, 30);

    // O cache em disco foi sobrescrito com o valor fresco (força não é só
    // "ignora a leitura", também precisa persistir o resultado atualizado).
    const cachePath = resolve(tmpDir, "2026-07.json");
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.deepEqual(cache["late-payer@example.com"], {
      isBacker: true,
      isPaidThisMonth: true,
      thisMonthPaidValue: 30,
      fetchedAt: now.toISOString(),
    });

    // Uma chamada seguinte SEM force volta a usar o cache (agora já correto).
    const day16 = await checkBacker("late-payer@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      now,
      limiter: fastLimiter,
    });
    assert.equal(calls, 2, "sem force, reusa o cache já atualizado — não gera 3ª request");
    assert.equal(day16.isPaidThisMonth, true);
  });

  it("forceRefresh:true em cache MISS não muda nada (já ia bater na API de qualquer forma) — não duplica request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, { isBacker: false, isPaidThisMonth: false });
    }) as unknown as typeof fetch;

    await checkBacker("nunca-visto@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-07-16T12:00:00Z"),
      forceRefresh: true,
    });
    assert.equal(calls, 1);
  });

  // ── TTL do cache do mês corrente (#4490 causa 1/2) ──────────────────────

  it("isCacheEntryStale: isPaidThisMonth true NUNCA expira, mesmo com fetchedAt muito antigo", () => {
    const now = new Date("2026-08-02T12:00:00Z");
    const veryOld = { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 30, fetchedAt: "2026-08-01T04:15:00Z" };
    assert.equal(isCacheEntryStale(veryOld, now, 8), false);
  });

  it("isCacheEntryStale: isPaidThisMonth false expira depois de ttlHours", () => {
    const now = new Date("2026-08-02T12:15:00Z");
    // fetchedAt 04:15 do dia 1º -> ~32h de idade, bem além de qualquer TTL razoável.
    const stale = { isBacker: true, isPaidThisMonth: false, fetchedAt: "2026-08-01T04:15:00Z" };
    assert.equal(isCacheEntryStale(stale, now, 8), true);
  });

  it("isCacheEntryStale: isPaidThisMonth false DENTRO da TTL não expira", () => {
    const now = new Date("2026-08-02T12:00:00Z");
    const fresh = { isBacker: true, isPaidThisMonth: false, fetchedAt: "2026-08-02T06:00:00Z" }; // 6h atrás
    assert.equal(isCacheEntryStale(fresh, now, 8), false);
  });

  it("isCacheEntryStale: sem fetchedAt (legado) é tratado como expirado", () => {
    const now = new Date("2026-08-02T12:00:00Z");
    const legacy = { isBacker: true, isPaidThisMonth: false };
    assert.equal(isCacheEntryStale(legacy, now, 8), true);
  });

  it("checkBacker: cache HIT com fetchedAt antigo (isPaidThisMonth:false) reconsulta a API (cenário #4490: cache de 01/08 04:15 lido em 02/08)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      // 1ª (escrita original, dia 1º): ninguém pagou ainda.
      // 2ª (TTL expirou, dia 2): já pagou.
      return jsonResponse(200, {
        isBacker: true,
        isPaidThisMonth: calls > 1,
        ...(calls > 1 ? { thisMonthPaidValue: 10 } : {}),
      });
    }) as unknown as typeof fetch;

    const written = await checkBacker("nicklanis@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-01T04:15:00Z"),
    });
    assert.equal(written.isPaidThisMonth, false);
    assert.equal(calls, 1);

    // Mesmo dia, poucas horas depois, DENTRO da TTL — ainda cache hit.
    const stillCached = await checkBacker("nicklanis@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-01T09:00:00Z"), // ~4h45 depois
    });
    assert.equal(stillCached.isPaidThisMonth, false);
    assert.equal(calls, 1, "dentro da TTL (default 8h) não reconsulta");

    // Dia seguinte — mais de 8h desde o fetchedAt original — TTL expirou,
    // mesmo mês-competência (agosto), reconsulta automaticamente.
    const refreshed = await checkBacker("nicklanis@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-02T12:00:00Z"),
    });
    assert.equal(calls, 2, "TTL expirada reconsulta a API sem precisar de forceRefresh");
    assert.equal(refreshed.isPaidThisMonth, true);
    assert.equal(refreshed.thisMonthPaidValue, 10);

    // Confirmado como pago — a partir daqui nunca mais expira por TTL, mesmo
    // bem mais tarde no mês.
    const later = await checkBacker("nicklanis@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-20T12:00:00Z"),
    });
    assert.equal(calls, 2, "isPaidThisMonth:true nunca expira por TTL");
    assert.equal(later.isPaidThisMonth, true);
  });

  it("checkBacker: ttlHours customizável (override curto expira mais rápido)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, { isBacker: false, isPaidThisMonth: false });
    }) as unknown as typeof fetch;
    const t0 = new Date("2026-08-01T00:00:00Z");

    await checkBacker("short-ttl@example.com", { env: ENV, fetchImpl, cacheDir: tmpDir, limiter: fastLimiter, now: t0, ttlHours: 1 });
    assert.equal(calls, 1);

    // 30min depois, dentro do TTL customizado de 1h — ainda cache hit.
    await checkBacker("short-ttl@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-01T00:30:00Z"),
      ttlHours: 1,
    });
    assert.equal(calls, 1);

    // 2h depois, além do TTL de 1h — reconsulta.
    await checkBacker("short-ttl@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-01T02:00:00Z"),
      ttlHours: 1,
    });
    assert.equal(calls, 2);
  });

  it("checkBacker: entrada legada sem fetchedAt (pré-#4490) é tratada como expirada e reconsultada", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 15 });
    }) as unknown as typeof fetch;

    // Simula um arquivo de cache escrito ANTES desta correção — sem fetchedAt.
    const cachePath = resolve(tmpDir, "2026-08.json");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(cachePath, JSON.stringify({ "legado@example.com": { isBacker: true, isPaidThisMonth: false } }));

    const status = await checkBacker("legado@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-08-02T12:00:00Z"),
    });
    assert.equal(calls, 1, "entrada sem fetchedAt nunca é assumida fresca — 1 refetch de backfill");
    assert.equal(status.isPaidThisMonth, true);

    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.ok(cache["legado@example.com"].fetchedAt, "backfill grava fetchedAt pra próximas leituras");
  });

  it("checkBacker: CURRENT_MONTH_CACHE_TTL_HOURS default é 8", () => {
    assert.equal(CURRENT_MONTH_CACHE_TTL_HOURS, 8);
  });

  it("readMonthCache lê o arquivo do mês sem rede — arquivo ausente -> {} (fail-soft)", () => {
    assert.deepEqual(readMonthCache(tmpDir, "2026-07"), {});
  });

  it("readMonthCache reflete o que checkBacker gravou (inclusive fetchedAt), sem gerar nova request", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 12 })) as unknown as typeof fetch;
    const now = new Date("2026-07-16T12:00:00Z");
    await checkBacker("lido@example.com", {
      env: ENV,
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now,
    });
    const cache = readMonthCache(tmpDir, "2026-07");
    assert.deepEqual(cache["lido@example.com"], {
      isBacker: true,
      isPaidThisMonth: true,
      thisMonthPaidValue: 12,
      fetchedAt: now.toISOString(),
    });
  });

  it("envia os headers corretos (x-api-key + authorization Bearer)", async () => {
    let seenHeaders: Headers | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenHeaders = new Headers(init?.headers);
      return jsonResponse(200, { isBacker: false, isPaidThisMonth: false });
    }) as unknown as typeof fetch;

    await checkBacker("headers@example.com", {
      env: { apiKey: "KEY123", apiSecret: "SECRET456", campaign: "diaria" },
      fetchImpl,
      cacheDir: tmpDir,
      limiter: fastLimiter,
      now: new Date("2026-07-16T12:00:00Z"),
    });

    assert.equal(seenHeaders?.get("x-api-key"), "KEY123");
    assert.equal(seenHeaders?.get("authorization"), "Bearer SECRET456");
  });
});
