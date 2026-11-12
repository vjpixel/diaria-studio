/**
 * test/brevo-rate-state-kv-12841.test.ts (#12841)
 *
 * O contador da cota horária da Brevo (`brevo-rate-state.ts`) passa a ter o
 * KV da Cloudflare como estado compartilhado entre máquinas, com o arquivo
 * local como cache e fallback. Nenhum teste fala com a Cloudflare real: o KV
 * é um fake em memória injetado por `setCampaignQuotaKvOpsForTest`.
 *
 * Regressão (#633) do cenário da issue: a máquina A viu folga (80), a máquina
 * B gastou a cota depois (10). Com o arquivo replicado por máquina, A seguia
 * achando que tinha 80; com o KV, A relê a observação de B antes do assert.
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { KvOps } from "../scripts/lib/cloudflare-kv-rest.ts";
import {
  BREVO_RATE_KV_KEY,
  BrevoCampaignQuotaLowError,
  assertCampaignQuotaHeadroom,
  exitAfterCampaignQuotaKvFlush,
  flushCampaignQuotaKvWrites,
  parseCampaignQuotaState,
  pickNewerCampaignQuotaState,
  readCampaignQuotaState,
  recordCampaignQuotaRemaining,
  refreshCampaignQuotaStateFromKv,
  resolveCampaignQuotaKvOps,
  setCampaignQuotaKvOpsForTest,
  shouldPushCampaignQuotaState,
  writeCampaignQuotaState,
} from "../scripts/lib/brevo-rate-state.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface FakeKv extends KvOps {
  store: Map<string, string>;
  puts: string[];
  failGet: boolean;
  failPut: boolean;
}

function fakeKv(): FakeKv {
  const kv: FakeKv = {
    store: new Map(),
    puts: [],
    failGet: false,
    failPut: false,
    async list() {
      return [...kv.store.keys()];
    },
    async get(key) {
      if (kv.failGet) throw new Error("KV REST get falhou: HTTP 503");
      return kv.store.get(key) ?? null;
    },
    async put(key, value) {
      await new Promise((r) => setImmediate(r)); // PUT assíncrono de verdade
      if (kv.failPut) throw new Error("KV REST put falhou: HTTP 503");
      kv.puts.push(value);
      kv.store.set(key, value);
    },
    async delete(key) {
      kv.store.delete(key);
    },
    async probe() {},
  };
  return kv;
}

let dir: string;
let pathA: string;
let pathB: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brevo-rate-kv-"));
  pathA = join(dir, "maquina-a.json");
  pathB = join(dir, "maquina-b.json");
});

afterEach(async () => {
  await flushCampaignQuotaKvWrites();
  setCampaignQuotaKvOpsForTest(undefined);
  mock.timers.reset();
  rmSync(dir, { recursive: true, force: true });
});

describe("#12841 — contador da cota no KV, arquivo local como cache", () => {
  it("regressão: a máquina A enxerga a cota que a máquina B gastou depois", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-11T10:00:00.000Z") });

    recordCampaignQuotaRemaining(80, 100, undefined, pathA); // A observa folga
    await flushCampaignQuotaKvWrites();
    mock.timers.setTime(Date.parse("2026-11-11T10:20:00.000Z"));
    recordCampaignQuotaRemaining(10, 100, undefined, pathB); // B gasta a cota depois
    await flushCampaignQuotaKvWrites();

    // Sem o KV, o arquivo da máquina A segue dizendo 80 e o assert deixaria passar.
    assert.equal(readCampaignQuotaState(pathA)?.remaining, 80);
    mock.timers.setTime(Date.parse("2026-11-11T10:25:00.000Z"));
    const winner = await refreshCampaignQuotaStateFromKv(pathA);
    assert.equal(winner?.remaining, 10);
    assert.equal(readCampaignQuotaState(pathA)?.remaining, 10, "o arquivo local vira cache da observação mais nova");
    assert.throws(() => assertCampaignQuotaHeadroom(30, pathA), BrevoCampaignQuotaLowError);
  });

  it("observação local mais nova que a do KV não é sobrescrita", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    kv.store.set(BREVO_RATE_KV_KEY, JSON.stringify({ remaining: 5, updatedAt: "2026-11-11T09:00:00.000Z" }));
    writeCampaignQuotaState({ remaining: 70, updatedAt: "2026-11-11T09:30:00.000Z" }, pathA);
    const before = readFileSync(pathA, "utf8");
    const winner = await refreshCampaignQuotaStateFromKv(pathA);
    assert.equal(winner?.remaining, 70);
    assert.equal(readFileSync(pathA, "utf8"), before);
  });

  it("KV fora do ar na leitura: segue com o arquivo, nunca lança", async () => {
    const kv = fakeKv();
    kv.failGet = true;
    setCampaignQuotaKvOpsForTest(kv);
    writeCampaignQuotaState({ remaining: 50, updatedAt: new Date().toISOString() }, pathA);
    const errors = mock.method(console, "error", () => {});
    const winner = await refreshCampaignQuotaStateFromKv(pathA);
    assert.equal(winner?.remaining, 50);
    assert.doesNotThrow(() => assertCampaignQuotaHeadroom(30, pathA));
    assert.equal(errors.mock.callCount(), 1, "um aviso em stderr, não silêncio");
    errors.mock.restore();
  });

  it("KV fora do ar na escrita: o arquivo é gravado e a chamada não lança", async () => {
    const kv = fakeKv();
    kv.failPut = true;
    setCampaignQuotaKvOpsForTest(kv);
    const errors = mock.method(console, "error", () => {});
    assert.doesNotThrow(() => recordCampaignQuotaRemaining(42, 100, undefined, pathA));
    assert.equal(readCampaignQuotaState(pathA)?.remaining, 42, "gravação local é síncrona, antes da rede");
    await flushCampaignQuotaKvWrites();
    assert.equal(kv.store.size, 0);
    assert.equal(errors.mock.callCount(), 1);
    errors.mock.restore();
  });

  it("valor corrompido no KV é ignorado (fica o arquivo)", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    kv.store.set(BREVO_RATE_KV_KEY, "{não é json");
    writeCampaignQuotaState({ remaining: 60, updatedAt: new Date().toISOString() }, pathA);
    assert.equal((await refreshCampaignQuotaStateFromKv(pathA))?.remaining, 60);
  });

  it("sem KV configurado: refresh devolve o arquivo e nada vai para a rede", async () => {
    setCampaignQuotaKvOpsForTest(null);
    recordCampaignQuotaRemaining(33, undefined, undefined, pathA);
    await flushCampaignQuotaKvWrites();
    assert.equal((await refreshCampaignQuotaStateFromKv(pathA))?.remaining, 33);
  });

  it("escritas em rajada: PUTs em ordem e o KV termina com a última observação", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    for (const n of [90, 80, 70, 60]) recordCampaignQuotaRemaining(n, 100, undefined, pathA);
    await flushCampaignQuotaKvWrites();
    assert.equal(parseCampaignQuotaState(kv.store.get(BREVO_RATE_KV_KEY) ?? null)?.remaining, 60);
    const seen = kv.puts.map((p) => JSON.parse(p).remaining);
    assert.deepEqual(seen, [...seen].sort((a, b) => b - a), "nenhuma observação velha sobrescreve uma nova");
    assert.ok(seen.length <= 2, `coalesce as intermediárias (vieram ${seen.length} PUTs)`);
  });

  it("sob node --test o KV padrão fica desligado mesmo com credencial no ambiente", async () => {
    setCampaignQuotaKvOpsForTest(undefined); // resolução padrão
    assert.ok(process.env.NODE_TEST_CONTEXT, "o runner exporta NODE_TEST_CONTEXT");
    const saved = { acc: process.env.CLOUDFLARE_ACCOUNT_ID, tok: process.env.CLOUDFLARE_WORKERS_TOKEN };
    process.env.CLOUDFLARE_ACCOUNT_ID = "acc";
    process.env.CLOUDFLARE_WORKERS_TOKEN = "tok";
    const fetchMock = mock.method(globalThis, "fetch", async () => {
      throw new Error("teste não pode falar com a Cloudflare");
    });
    try {
      recordCampaignQuotaRemaining(20, 100, undefined, pathA);
      await flushCampaignQuotaKvWrites();
      await refreshCampaignQuotaStateFromKv(pathA);
      assert.equal(fetchMock.mock.callCount(), 0);
    } finally {
      fetchMock.mock.restore();
      if (saved.acc === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
      else process.env.CLOUDFLARE_ACCOUNT_ID = saved.acc;
      if (saved.tok === undefined) delete process.env.CLOUDFLARE_WORKERS_TOKEN;
      else process.env.CLOUDFLARE_WORKERS_TOKEN = saved.tok;
    }
  });
});

describe("#12841 — funções puras", () => {
  it("pickNewerCampaignQuotaState: último valor vence, ilegível perde, empate fica com o local", () => {
    const a = { remaining: 1, updatedAt: "2026-11-11T10:00:00.000Z" };
    const b = { remaining: 2, updatedAt: "2026-11-11T11:00:00.000Z" };
    assert.equal(pickNewerCampaignQuotaState(a, b), b);
    assert.equal(pickNewerCampaignQuotaState(b, a), b);
    assert.equal(pickNewerCampaignQuotaState(null, a), a);
    assert.equal(pickNewerCampaignQuotaState(a, null), a);
    const tie = { remaining: 9, updatedAt: a.updatedAt };
    assert.equal(pickNewerCampaignQuotaState(a, tie), a);
    const bad = { remaining: 3, updatedAt: "lixo" };
    assert.equal(pickNewerCampaignQuotaState(a, bad), a);
    assert.equal(pickNewerCampaignQuotaState(bad, a), a);
  });

  it("parseCampaignQuotaState valida o shape", () => {
    assert.equal(parseCampaignQuotaState(null), null);
    assert.equal(parseCampaignQuotaState("[]"), null);
    assert.equal(parseCampaignQuotaState(JSON.stringify({ remaining: "5", updatedAt: "2026-11-11T10:00:00Z" })), null);
    assert.equal(parseCampaignQuotaState(JSON.stringify({ remaining: 5, updatedAt: "ontem" })), null);
    assert.deepEqual(
      parseCampaignQuotaState(JSON.stringify({ remaining: 5, limit: 100, reset: 120, updatedAt: "2026-11-11T10:00:00Z", x: 1 })),
      { remaining: 5, limit: 100, reset: 120, updatedAt: "2026-11-11T10:00:00Z" },
    );
  });

  it("resolveCampaignQuotaKvOps: exige namespace + conta + token; opt-out por env", () => {
    const cfg = { ops_state_kv: { namespace_id: "ns" } };
    const env = { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_WORKERS_TOKEN: "tok" };
    assert.ok(resolveCampaignQuotaKvOps(cfg, env));
    assert.ok(resolveCampaignQuotaKvOps(cfg, { CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" }));
    assert.equal(resolveCampaignQuotaKvOps({}, env), null);
    assert.equal(resolveCampaignQuotaKvOps(cfg, { CLOUDFLARE_ACCOUNT_ID: "acc" }), null);
    assert.equal(resolveCampaignQuotaKvOps(cfg, { CLOUDFLARE_WORKERS_TOKEN: "tok" }), null);
    assert.equal(resolveCampaignQuotaKvOps(cfg, { ...env, BREVO_RATE_STATE_KV: "off" }), null);
  });

  it("platform.config.json declara o namespace ops_state_kv que o módulo usa", () => {
    const cfg = JSON.parse(readFileSync(join(ROOT, "platform.config.json"), "utf8"));
    assert.equal(typeof cfg.ops_state_kv?.namespace_id, "string");
    assert.ok(cfg.ops_state_kv.namespace_id.length > 0);
  });
});

describe("#12841 — leitores relêem o KV antes de decidir por cota", () => {
  // Cada consumidor que decide por cota (assert ou aviso) precisa trazer a
  // observação do KV antes; sem isso ele decide pela cópia local defasada.
  const CALLERS = [
    "scripts/clarice-consolidate-lists.ts",
    "scripts/clarice-audit-overlap.ts",
    "scripts/audit-wave-no-duplicate-sends.ts",
    "scripts/clarice-build-segment.ts",
    "scripts/clarice-plan-wave.ts",
    "scripts/clarice-backfill-campaigns.ts",
    "scripts/verify-clarice-monthly-coverage.ts",
    "scripts/studio-ui/dashboard-clarice.ts",
    "scripts/clarice-guardrail-alarm.ts",
  ];
  for (const rel of CALLERS) {
    it(rel, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const refresh = src.indexOf("await refreshCampaignQuotaStateFromKv(");
      assert.ok(refresh >= 0, `${rel} não chama refreshCampaignQuotaStateFromKv`);
      const decide = [
        src.indexOf("assertCampaignQuotaHeadroom(", refresh),
        src.indexOf("warnIfCampaignQuotaLow(", refresh),
        src.indexOf("shouldSkipForLowQuota()", refresh),
      ].filter((i) => i >= 0);
      assert.ok(decide.length > 0, `${rel}: a decisão por cota vem depois do refresh`);
    });
  }
});

describe("#12862 — PUT ao KV não se perde no intervalo do finally nem no process.exit", () => {
  it("regressão: observação gravada entre o fim do laço e o finally ainda chega ao KV", async () => {
    // O intervalo entre o `while` sair e o `.finally` zerar `kvInFlight` são
    // algumas microtasks. Varre profundidades para cair dentro dele: com o bug,
    // a observação fica em `kvPending` sem ninguém para enviá-la.
    for (let depth = 0; depth <= 12; depth++) {
      const kv = fakeKv();
      let injected = false;
      const basePut = kv.put.bind(kv);
      kv.put = async (key, value) => {
        await basePut(key, value);
        if (injected) return;
        injected = true;
        let p: Promise<void> = Promise.resolve();
        for (let i = 0; i < depth; i++) p = p.then(() => {});
        void p.then(() => recordCampaignQuotaRemaining(7, 100, undefined, pathA));
      };
      setCampaignQuotaKvOpsForTest(kv);
      recordCampaignQuotaRemaining(50, 100, undefined, pathA);
      await flushCampaignQuotaKvWrites();
      await new Promise((r) => setImmediate(r)); // drena todas as microtasks
      await flushCampaignQuotaKvWrites();
      assert.equal(
        parseCampaignQuotaState(kv.store.get(BREVO_RATE_KV_KEY) ?? null)?.remaining,
        7,
        `profundidade ${depth}: a última observação ficou presa em kvPending`,
      );
    }
  });

  it("exitAfterCampaignQuotaKvFlush espera o PUT antes de chamar process.exit", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    let storeAtExit: string | undefined;
    let exitCode: number | undefined;
    const exitMock = mock.method(process, "exit", ((code?: number) => {
      exitCode = code;
      storeAtExit = kv.store.get(BREVO_RATE_KV_KEY);
      return undefined as never;
    }) as typeof process.exit);
    try {
      recordCampaignQuotaRemaining(12, 100, undefined, pathA);
      assert.equal(kv.store.size, 0, "o PUT sai em segundo plano");
      await exitAfterCampaignQuotaKvFlush(1);
      assert.equal(exitMock.mock.callCount(), 1);
      assert.equal(exitCode, 1);
      assert.equal(parseCampaignQuotaState(storeAtExit ?? null)?.remaining, 12, "o KV já tinha a observação no exit");
    } finally {
      exitMock.mock.restore();
    }
  });

  it("KV fora do ar: exitAfterCampaignQuotaKvFlush sai com o código pedido", async () => {
    const kv = fakeKv();
    kv.failPut = true;
    setCampaignQuotaKvOpsForTest(kv);
    const errors = mock.method(console, "error", () => {});
    const exitMock = mock.method(process, "exit", (() => undefined as never) as typeof process.exit);
    try {
      recordCampaignQuotaRemaining(12, 100, undefined, pathA);
      await exitAfterCampaignQuotaKvFlush(3);
      assert.deepEqual(exitMock.mock.calls[0]?.arguments, [3]);
    } finally {
      exitMock.mock.restore();
      errors.mock.restore();
    }
  });

  // Os CLIs que gravam cota e saem por `process.exit` esperam o PUT: depois da
  // 1ª chamada à Brevo (o refresh da cota), nenhum `process.exit(` cru.
  // #12870: a lista sai de uma varredura de `scripts/` (todo arquivo fora de
  // `scripts/lib/` que chama o refresh), não de uma lista à mão — a lista à
  // mão do #12862 cobria 2 CLIs e deixou 3 de fora.
  const REFRESH_CALL = "await refreshCampaignQuotaStateFromKv(";
  const refreshCallers = (readdirSync(join(ROOT, "scripts"), { recursive: true }) as string[])
    .map((p) => `scripts/${p.split(sep).join("/")}`)
    .filter((rel) => rel.endsWith(".ts") && !rel.startsWith("scripts/lib/"))
    .filter((rel) => readFileSync(join(ROOT, rel), "utf8").includes(REFRESH_CALL))
    .sort();

  it("#12870: a varredura acha os CLIs conhecidos (não passa vazia)", () => {
    for (const rel of [
      "scripts/clarice-build-segment.ts",
      "scripts/clarice-guardrail-alarm.ts",
      "scripts/audit-wave-no-duplicate-sends.ts",
      "scripts/clarice-audit-overlap.ts",
      "scripts/clarice-consolidate-lists.ts",
    ]) {
      assert.ok(refreshCallers.includes(rel), `${rel} sumiu da varredura (vieram: ${refreshCallers.join(", ")})`);
    }
  });

  for (const rel of refreshCallers) {
    it(`${rel}: nenhum process.exit cru depois do refresh da cota`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const tail = src.slice(src.indexOf(REFRESH_CALL));
      assert.ok(!/^\s*process\.exit\(/m.test(tail), `${rel} ainda tem process.exit( depois do refresh`);
      const mainCatch = /main\(\)\.catch\(([^]*?)\n\s*\}\);/.exec(tail);
      // `process.exitCode = N` deixa o event loop drenar (o PUT termina): só o
      // catch que SAI na hora precisa do flush.
      if (mainCatch && /process\.exit\(|exitAfterCampaignQuotaKvFlush/.test(mainCatch[1])) {
        assert.match(mainCatch[1], /exitAfterCampaignQuotaKvFlush\(1\)/, `${rel}: o catch do main espera o PUT`);
      }
    });
  }
});

describe("#12895 — PUT ao KV não apaga observação mais nova de outra máquina", () => {
  it("regressão: PUT atrasado de A não sobrescreve o remaining menor que B gravou depois", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    // B (outra máquina) já gravou às 10:20 com remaining=40.
    const fromB = JSON.stringify({ remaining: 40, limit: 100, updatedAt: "2026-11-11T10:20:00.000Z" });
    kv.store.set(BREVO_RATE_KV_KEY, fromB);
    // A observou remaining=50 às 10:10, mas o push dela só sai agora.
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-11T10:10:00.000Z") });
    recordCampaignQuotaRemaining(50, 100, undefined, pathA);
    await flushCampaignQuotaKvWrites();
    assert.equal(kv.store.get(BREVO_RATE_KV_KEY), fromB, "o KV segue com a observação mais nova (B)");
    assert.equal(kv.puts.length, 0, "nenhum PUT da observação velha");
    assert.equal(readCampaignQuotaState(pathA)?.remaining, 50, "o arquivo local de A não muda por isso");
  });

  it("observação local mais nova que a do KV é gravada", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    kv.store.set(BREVO_RATE_KV_KEY, JSON.stringify({ remaining: 40, updatedAt: "2026-11-11T10:20:00.000Z" }));
    mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-11-11T10:30:00.000Z") });
    recordCampaignQuotaRemaining(30, 100, undefined, pathA);
    await flushCampaignQuotaKvWrites();
    assert.equal(parseCampaignQuotaState(kv.store.get(BREVO_RATE_KV_KEY) ?? null)?.remaining, 30);
  });

  it("valor ilegível no KV não segura o PUT", async () => {
    const kv = fakeKv();
    setCampaignQuotaKvOpsForTest(kv);
    kv.store.set(BREVO_RATE_KV_KEY, "{não é json");
    recordCampaignQuotaRemaining(25, 100, undefined, pathA);
    await flushCampaignQuotaKvWrites();
    assert.equal(parseCampaignQuotaState(kv.store.get(BREVO_RATE_KV_KEY) ?? null)?.remaining, 25);
  });

  it("leitura do KV falhou: grava às cegas (fail-soft, como antes)", async () => {
    const kv = fakeKv();
    kv.failGet = true;
    setCampaignQuotaKvOpsForTest(kv);
    recordCampaignQuotaRemaining(22, 100, undefined, pathA);
    await flushCampaignQuotaKvWrites();
    assert.equal(parseCampaignQuotaState(kv.store.get(BREVO_RATE_KV_KEY) ?? null)?.remaining, 22);
  });

  it("shouldPushCampaignQuotaState: só não grava quando o KV é estritamente mais novo", () => {
    const old = { remaining: 50, updatedAt: "2026-11-11T10:10:00.000Z" };
    const newer = { remaining: 40, updatedAt: "2026-11-11T10:20:00.000Z" };
    assert.equal(shouldPushCampaignQuotaState(old, newer), false);
    assert.equal(shouldPushCampaignQuotaState(newer, old), true);
    assert.equal(shouldPushCampaignQuotaState(old, null), true);
    assert.equal(shouldPushCampaignQuotaState(old, { remaining: 1, updatedAt: old.updatedAt }), true, "empate grava");
    assert.equal(shouldPushCampaignQuotaState(old, { remaining: 1, updatedAt: "lixo" }), true);
  });
});

