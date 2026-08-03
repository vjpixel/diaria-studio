/**
 * test/verify-pending-emails-mv-4476.test.ts (#4476 item 8)
 *
 * Verificação em lote do pool Pending via MillionVerifier — reimplementação
 * standalone (não acoplada ao store da Clarice, ver header do módulo).
 * Cobre: classificação de resultado, URL da API, guard de custo, parse do
 * CSV de candidatos, e a chamada HTTP com retry (fetch mockado — nunca rede
 * real, nunca espera de verdade).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyResult,
  buildVerifyUrl,
  checkMvCostGuard,
  estimateMvCostUsd,
  readCandidateEmails,
  verifyOne,
  loadCheckpoint,
  saveCheckpoint,
  MV_COST_GUARD_THRESHOLD,
} from "../scripts/verify-pending-emails-mv.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("classifyResult — mapeia result da MV pro bucket de ação (#4476 item 8)", () => {
  it("ok | catch_all → verified", () => {
    assert.equal(classifyResult("ok"), "verified");
    assert.equal(classifyResult("catch_all"), "verified");
  });
  it("invalid | disposable → rejected", () => {
    assert.equal(classifyResult("invalid"), "rejected");
    assert.equal(classifyResult("disposable"), "rejected");
  });
  it("unknown | reverify | vazio | undefined → unknown", () => {
    assert.equal(classifyResult("unknown"), "unknown");
    assert.equal(classifyResult("reverify"), "unknown");
    assert.equal(classifyResult(""), "unknown");
    assert.equal(classifyResult(undefined), "unknown");
    assert.equal(classifyResult(null), "unknown");
  });
  it("case-insensitive", () => {
    assert.equal(classifyResult("OK"), "verified");
    assert.equal(classifyResult("Invalid"), "rejected");
  });
});

describe("buildVerifyUrl — URL da single-verification API (#4476 item 8)", () => {
  it("monta com api key, email e timeout", () => {
    const url = buildVerifyUrl("key123", "a@b.com", 20);
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, "https://api.millionverifier.com/api/v3");
    assert.equal(u.searchParams.get("api"), "key123");
    assert.equal(u.searchParams.get("email"), "a@b.com");
    assert.equal(u.searchParams.get("timeout"), "20");
  });
});

describe("checkMvCostGuard / estimateMvCostUsd — guard de custo (#4476 item 8)", () => {
  it("estimateMvCostUsd: US$1,90 por 1000", () => {
    assert.ok(Math.abs(estimateMvCostUsd(1000) - 1.9) < 1e-9);
    assert.ok(Math.abs(estimateMvCostUsd(627) - 1.1913) < 1e-3);
  });

  it(`<= ${MV_COST_GUARD_THRESHOLD} sem --confirm → ok`, () => {
    assert.deepEqual(checkMvCostGuard(MV_COST_GUARD_THRESHOLD, false), { ok: true });
  });

  it(`> ${MV_COST_GUARD_THRESHOLD} sem --confirm → bloqueia com mensagem de custo`, () => {
    const result = checkMvCostGuard(627, false);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /627.*US\$ 1\.19.*--confirm/);
  });

  it(`> ${MV_COST_GUARD_THRESHOLD} com --confirm → ok`, () => {
    assert.deepEqual(checkMvCostGuard(627, true), { ok: true });
  });
});

describe("readCandidateEmails — parse do CSV de score, dedup (#4476 item 8)", () => {
  it("lê a coluna email, normaliza (lowercase/trim), dedup", () => {
    const csv = "email,origin,score\n  Foo@Bar.COM  ,x,10\nbaz@qux.com,y,5\nfoo@bar.com,x,10\n";
    assert.deepEqual(readCandidateEmails(csv), ["foo@bar.com", "baz@qux.com"]);
  });

  it("linha sem email → ignorada", () => {
    const csv = "email,score\n,10\na@b.com,5\n";
    assert.deepEqual(readCandidateEmails(csv), ["a@b.com"]);
  });

  it("CSV de 1 coluna só (achado ao vivo 260802: auto-detect de delimitador falha sem vírgula no arquivo) → parseia certo", () => {
    const csv = "email\r\nfoo@bar.com\r\nbaz@qux.com\n";
    assert.deepEqual(readCandidateEmails(csv), ["foo@bar.com", "baz@qux.com"]);
  });
});

describe("verifyOne — chamada HTTP com retry em erro transitório (#4476 item 8, fetch mockado)", () => {
  it("sucesso na 1ª tentativa → devolve o JSON, sem retry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes(200, { email: "a@b.com", result: "ok", resultcode: 1 });
    }) as typeof fetch;
    const res = await verifyOne("key", "a@b.com", 20, fetchImpl, async () => {});
    assert.equal(res.result, "ok");
    assert.equal(calls, 1);
  });

  it("429 → retry (transitório), sucede na 2ª", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429 });
      return jsonRes(200, { result: "invalid" });
    }) as typeof fetch;
    let sleptMs: number[] = [];
    const res = await verifyOne("key", "a@b.com", 20, fetchImpl, async (ms) => {
      sleptMs.push(ms);
    });
    assert.equal(res.result, "invalid");
    assert.equal(calls, 2);
    assert.deepEqual(sleptMs, [1000]);
  });

  it("5xx → retry (transitório)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls <= 2) return new Response(null, { status: 503 });
      return jsonRes(200, { result: "ok" });
    }) as typeof fetch;
    const res = await verifyOne("key", "a@b.com", 20, fetchImpl, async () => {});
    assert.equal(res.result, "ok");
    assert.equal(calls, 3);
  });

  it("4xx não-429 (ex: 401 key inválida) → lança IMEDIATAMENTE, nunca retry", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("unauthorized", { status: 401 });
    }) as typeof fetch;
    await assert.rejects(() => verifyOne("key", "a@b.com", 20, fetchImpl, async () => {}), /HTTP 401/);
    assert.equal(calls, 1, "erro fatal de config nunca faz retry");
  });

  it('erro "not enough credits" no corpo (200 mas error field) → lança imediatamente (fatal)', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonRes(200, { error: "Not enough credits" });
    }) as typeof fetch;
    await assert.rejects(() => verifyOne("key", "a@b.com", 20, fetchImpl, async () => {}), /credit/i);
    assert.equal(calls, 1);
  });

  it("erro genérico no corpo (não fatal) → retry, esgota tentativas → lança com contexto", async () => {
    const fetchImpl = (async () => jsonRes(200, { error: "temporary glitch" })) as typeof fetch;
    await assert.rejects(
      () => verifyOne("key", "a@b.com", 20, fetchImpl, async () => {}),
      /falha ao verificar a@b\.com após 4 tentativas/,
    );
  });

  it("resposta não-JSON → retry como transitório", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("<html>error</html>", { status: 200 });
      return jsonRes(200, { result: "ok" });
    }) as typeof fetch;
    const res = await verifyOne("key", "a@b.com", 20, fetchImpl, async () => {});
    assert.equal(res.result, "ok");
    assert.equal(calls, 2);
  });
});

describe("loadCheckpoint / saveCheckpoint — resumível, atômico (#4476 item 8)", () => {
  it("arquivo ausente → checkpoint vazio", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-pending-test-"));
    try {
      assert.deepEqual(loadCheckpoint(resolve(dir, "nao-existe.json")), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("save + load round-trip", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-pending-test-"));
    try {
      const path = resolve(dir, "cache.json");
      saveCheckpoint(path, { "a@b.com": { result: "ok", resultcode: 1, quality: "good" } });
      assert.deepEqual(loadCheckpoint(path), { "a@b.com": { result: "ok", resultcode: 1, quality: "good" } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checkpoint corrompido (JSON inválido) → vazio, nunca lança", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "mv-pending-test-"));
    try {
      const path = resolve(dir, "corrupt.json");
      writeFileSync(path, "{not valid json");
      assert.deepEqual(loadCheckpoint(path), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
