/**
 * test/kv-image-binding-smoke-7663.test.ts (#7663)
 *
 * Regressão do bug descrito na issue: binding KV `POLL` de `workers/site`
 * declarado corretamente no `wrangler.toml` (id confere com `workers/poll`,
 * já coberto por `test/site-img-same-origin-7657.test.ts`) mas MORTO no
 * Worker deployado (deploy parcial, drift preview/produção, namespace
 * renomeado do lado da Cloudflare) — `env.POLL.get(key)` devolve `null`
 * pra TODA key, e o resultado observável (404 com CORS) é indistinguível
 * de "esta imagem específica não existe".
 *
 * O que este arquivo trava:
 *   1. 200 + `image/jpeg` na key estável → `ok` (fetch injetado, sem rede real);
 *   2. 404 na key estável → `binding-morto` (é sinal de queda, alarma);
 *   3. erro de rede / timeout / 5xx → `cannot-verify`, NUNCA `ok` nem
 *      `binding-morto` — regra inegociável da issue: falha de rede/DNS/
 *      Cloudflare não pode virar falso alarme nem falso negativo;
 *   4. dedup do alarme: só a TRANSIÇÃO pra `binding-morto` alarma, não toda
 *      execução enquanto a queda persiste; `cannot-verify` nunca alarma nem
 *      reseta o estado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";

import {
  classifyKvImageSmokeOutcome,
  runKvImageSmokeCheck,
  KV_IMAGE_SMOKE_KEY,
  KV_IMAGE_SMOKE_URL,
  KV_IMAGE_SMOKE_USER_AGENT,
  type FetchLike,
} from "../scripts/lib/kv-image-smoke.ts";
import { shouldAlarmNow, emptyState, loadState, saveState } from "../scripts/check-kv-image-binding.ts";

describe("KV_IMAGE_SMOKE_KEY/URL (#7663)", () => {
  it("é uma key de convenção fixa do É IA? (img-{AAMMDD}-01-eia-{A|B}.jpg)", () => {
    assert.match(KV_IMAGE_SMOKE_KEY, /^img-\d{6}-01-eia-[AB]\.jpg$/);
  });

  it("a URL aponta pro apex (mesma origem do documento, #7657), não pro host do É IA?", () => {
    assert.equal(KV_IMAGE_SMOKE_URL, `https://diar.ia.br/img/${KV_IMAGE_SMOKE_KEY}`);
    assert.ok(!KV_IMAGE_SMOKE_URL.includes("eia.diar.ia.br"));
  });
});

describe("classifyKvImageSmokeOutcome — os 3 estados exigidos pela #7663", () => {
  it("200 + Content-Type image/jpeg → ok", () => {
    const result = classifyKvImageSmokeOutcome({
      ok: true,
      response: { status: 200, contentType: "image/jpeg" },
    });
    assert.equal(result.status, "ok");
    assert.match(result.detail, /200/);
  });

  it("404 na key estável → binding-morto (alarma)", () => {
    const result = classifyKvImageSmokeOutcome({
      ok: true,
      response: { status: 404, contentType: "text/plain;charset=UTF-8" },
    });
    assert.equal(result.status, "binding-morto");
    assert.match(result.detail, /404/);
  });

  it("erro de rede (DNS, conexão recusada, etc) → cannot-verify, NUNCA ok nem binding-morto", () => {
    const result = classifyKvImageSmokeOutcome({ ok: false, error: new Error("ENOTFOUND diar.ia.br") });
    assert.equal(result.status, "cannot-verify");
    assert.match(result.detail, /ENOTFOUND/);
  });

  it("timeout (AbortError) → cannot-verify", () => {
    const result = classifyKvImageSmokeOutcome({ ok: false, error: new DOMException("aborted", "AbortError") });
    assert.equal(result.status, "cannot-verify");
  });

  it("500/502/503 do lado do Cloudflare → cannot-verify, nunca binding-morto (falso alarme)", () => {
    for (const status of [500, 502, 503]) {
      const result = classifyKvImageSmokeOutcome({ ok: true, response: { status, contentType: "text/html" } });
      assert.equal(result.status, "cannot-verify", `status ${status} deveria ser cannot-verify`);
    }
  });

  it("200 com Content-Type inesperado → cannot-verify (nem confirma nem indica queda)", () => {
    const result = classifyKvImageSmokeOutcome({
      ok: true,
      response: { status: 200, contentType: "text/html" },
    });
    assert.equal(result.status, "cannot-verify");
  });

  it("status HTTP fora do esperado (ex: 403) → cannot-verify", () => {
    const result = classifyKvImageSmokeOutcome({ ok: true, response: { status: 403, contentType: null } });
    assert.equal(result.status, "cannot-verify");
  });
});

describe("runKvImageSmokeCheck — orquestra fetch injetado, nunca lança", () => {
  it("propaga ok quando o fetch injetado devolve 200 image/jpeg", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      assert.equal(url, KV_IMAGE_SMOKE_URL);
      assert.equal(init?.headers?.["User-Agent"], KV_IMAGE_SMOKE_USER_AGENT);
      return { status: 200, headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "image/jpeg" : null) } };
    };
    const result = await runKvImageSmokeCheck(fetchImpl);
    assert.equal(result.status, "ok");
  });

  it("propaga binding-morto quando o fetch injetado devolve 404", async () => {
    const fetchImpl: FetchLike = async () => ({
      status: 404,
      headers: { get: () => "text/plain;charset=UTF-8" },
    });
    const result = await runKvImageSmokeCheck(fetchImpl);
    assert.equal(result.status, "binding-morto");
  });

  it("fetch injetado que LANÇA (rede real indisponível) vira cannot-verify, não sobe a exceção", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network unreachable");
    };
    const result = await runKvImageSmokeCheck(fetchImpl);
    assert.equal(result.status, "cannot-verify");
    assert.match(result.detail, /network unreachable/);
  });
});

describe("shouldAlarmNow — dedup do alarme (#7663)", () => {
  it("1ª detecção de binding-morto (estado anterior null) → alarma", () => {
    assert.equal(shouldAlarmNow(null, "binding-morto"), true);
  });

  it("binding-morto → binding-morto (queda persiste) → NÃO realarma", () => {
    assert.equal(shouldAlarmNow("binding-morto", "binding-morto"), false);
  });

  it("ok → binding-morto (queda nova após período saudável) → alarma", () => {
    assert.equal(shouldAlarmNow("ok", "binding-morto"), true);
  });

  it("cannot-verify NUNCA alarma, seja qual for o estado anterior", () => {
    assert.equal(shouldAlarmNow(null, "cannot-verify"), false);
    assert.equal(shouldAlarmNow("ok", "cannot-verify"), false);
    assert.equal(shouldAlarmNow("binding-morto", "cannot-verify"), false);
  });

  it("ok nunca alarma", () => {
    assert.equal(shouldAlarmNow("binding-morto", "ok"), false);
    assert.equal(shouldAlarmNow(null, "ok"), false);
  });
});

describe("estado (load/save) — dedup persiste entre execuções", () => {
  it("loadState em path inexistente devolve estado vazio", () => {
    const state = loadState("/tmp/kv-image-smoke-nao-existe-7663/state.json");
    assert.deepEqual(state, emptyState());
  });

  it("save + load round-trip preserva status e timestamp", () => {
    const path = `/tmp/kv-image-smoke-test-7663-${Date.now()}/state.json`;
    saveState({ lastStatus: "binding-morto", lastCheckedAt: "2026-09-09T12:00:00.000Z" }, path);
    const reloaded = loadState(path);
    assert.deepEqual(reloaded, { lastStatus: "binding-morto", lastCheckedAt: "2026-09-09T12:00:00.000Z" });
  });

  it("loadState em JSON corrompido não lança — devolve estado vazio", () => {
    const dir = `/tmp/kv-image-smoke-corrupt-7663-${Date.now()}`;
    const path = `${dir}/state.json`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "{ nao e json valido", "utf8");
    assert.deepEqual(loadState(path), emptyState());
  });
});
