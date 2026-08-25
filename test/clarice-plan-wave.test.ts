/**
 * test/clarice-plan-wave.test.ts (#5058)
 *
 * `clarice-plan-wave.ts` é invocado como SUBPROCESSO por `clarice-envio-run.ts`
 * (spawnSync). Antes deste fix, uma falha 429/503 do dashboard `/api/campaigns`
 * (rate limit da Brevo, transitório por natureza — o próprio dashboard devolve
 * `Retry-After`/`retryAfterSecs`) virava um `Error` genérico indistinguível de
 * qualquer erro de lógica: o chamador nunca sabia que valia a pena retentar.
 * Achado ao vivo: 260811, a task `Diaria-Clarice-Envio` das 19:00 morreu na
 * 1ª falha (`retryAfterSecs: 258`) sem nenhum retry — a onda de 12/08 só
 * existiu porque um humano montou à mão.
 *
 * Este arquivo cobre a metade "propagar o sinal" do fix (`TransientDashboardError`
 * + o parse de `Retry-After`); a metade "esperar e repetir" mora no
 * orquestrador e é coberta por `test/clarice-envio-run.test.ts`
 * (`stepWithTransientRetry`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planWave, TransientDashboardError, parseTargetVolumeArg, type PlanWaveOptions } from "../scripts/clarice-plan-wave.ts";

const BASE_OPTS: Omit<PlanWaveOptions, "fetchImpl"> = {
  cycle: "2607-08",
  dates: ["2026-08-12"],
  dbPath: ":memory:", // nunca alcançado — o fetch falha antes de abrir o DB
  dashboardUrl: "https://clarice-dashboard.diaria.workers.dev",
  lockedSubject: null,
};

describe("planWave: falha TRANSITÓRIA do dashboard (#5058)", () => {
  it("503 com Retry-After => TransientDashboardError com retryAfterSecs extraído do header", async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ error: "brevo_rate_limit", retryAfterSecs: 258 }), {
        status: 503,
        headers: { "Retry-After": "258", "Content-Type": "application/json" },
      })) as typeof fetch;

    await assert.rejects(
      planWave({ ...BASE_OPTS, fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof TransientDashboardError, `esperado TransientDashboardError, veio ${err}`);
        assert.equal(err.retryAfterSecs, 258);
        assert.equal(err.status, 503);
        assert.equal(err.transient, true);
        return true;
      },
    );
  });

  it("429 (defensivo — a Brevo/dashboard normalmente usam 503, mas 429 é aceito) => também TransientDashboardError", async () => {
    const fetchImpl = (async () =>
      new Response("", { status: 429, headers: { "Retry-After": "10" } })) as typeof fetch;

    await assert.rejects(
      planWave({ ...BASE_OPTS, fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof TransientDashboardError);
        assert.equal((err as TransientDashboardError).retryAfterSecs, 10);
        assert.equal((err as TransientDashboardError).status, 429);
        return true;
      },
    );
  });

  it("503 SEM header Retry-After => retryAfterSecs null, nunca inventa um valor", async () => {
    const fetchImpl = (async () => new Response("", { status: 503 })) as typeof fetch;

    await assert.rejects(
      planWave({ ...BASE_OPTS, fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof TransientDashboardError);
        assert.equal((err as TransientDashboardError).retryAfterSecs, null);
        return true;
      },
    );
  });

  it("502/outro status NÃO-transitório => Error genérico, NUNCA TransientDashboardError (não é retentável às cegas)", async () => {
    const fetchImpl = (async () => new Response("boom", { status: 502 })) as typeof fetch;

    await assert.rejects(
      planWave({ ...BASE_OPTS, fetchImpl }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok(!(err instanceof TransientDashboardError), "502 não é rate limit — não deve sinalizar retry");
        assert.match((err as Error).message, /502/);
        return true;
      },
    );
  });
});

describe("parseTargetVolumeArg — regressão #6144 (getArg() nunca é undefined)", () => {
  it("--target-volume ausente => undefined (não trata getArg(...)===\"\" como presente)", () => {
    assert.equal(parseTargetVolumeArg(["--cycle", "2607-08", "--dates", "2026-08-26", "--json"]), undefined);
  });

  it("argv vazio => undefined", () => {
    assert.equal(parseTargetVolumeArg([]), undefined);
  });

  it("--target-volume 5000 => 5000", () => {
    assert.equal(parseTargetVolumeArg(["--target-volume", "5000"]), 5000);
  });

  it("--target-volume 0 => lança (não é positivo)", () => {
    assert.throws(() => parseTargetVolumeArg(["--target-volume", "0"]));
  });

  it("--target-volume -10 => lança (não é positivo)", () => {
    assert.throws(() => parseTargetVolumeArg(["--target-volume", "-10"]));
  });

  it("--target-volume abc => lança (não é inteiro)", () => {
    assert.throws(() => parseTargetVolumeArg(["--target-volume", "abc"]));
  });

  it("--target-volume sem valor (flag pendurada) => lança, nunca vira undefined silencioso", () => {
    assert.throws(() => parseTargetVolumeArg(["--target-volume"]));
  });
});
