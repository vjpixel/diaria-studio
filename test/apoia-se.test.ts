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
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  checkBacker,
  readApoiaSeEnv,
  competenceMonth,
  defaultCacheDir,
  RateLimiter,
  ApoiaSeAuthError,
  ApoiaSeApiError,
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

  it("cache MISS bate na API e grava o resultado em disco", async () => {
    const fetchImpl = (async () =>
      jsonResponse(200, { isBacker: true, isPaidThisMonth: true, thisMonthPaidValue: 25 })) as unknown as typeof fetch;
    const now = new Date("2026-07-16T12:00:00Z");

    const cachePath = resolve(tmpDir, "2026-07.json");
    assert.equal(existsSync(cachePath), false);

    await checkBacker("miss@example.com", { env: ENV, fetchImpl, cacheDir: tmpDir, now, limiter: fastLimiter });

    assert.equal(existsSync(cachePath), true);
    const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
    assert.deepEqual(cache["miss@example.com"], {
      isBacker: true,
      isPaidThisMonth: true,
      thisMonthPaidValue: 25,
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
