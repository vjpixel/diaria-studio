/**
 * test/failover-scheduler-lease-12982.test.ts (#12982)
 *
 * Lease anti-duplicação 300 × Neo. Só fakes: nenhum teste fala com o KV real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acquireSchedulerLease,
  decideLease,
  DOWN_SIGNAL_KEY,
  LEASE_TTL_MS,
  makeLease,
  parseLease,
  SCHEDULER_LEASE_KEY,
  serializeLease,
  type LeaseKv,
} from "../scripts/lib/failover/scheduler-lease.ts";

const T0 = new Date("2026-11-13T12:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const H = 60 * 60 * 1000;

/** KV em memória compartilhado entre os "hosts" do teste. */
function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const kv: LeaseKv & { store: Map<string, string>; puts: number } = {
    store,
    puts: 0,
    async get(k) {
      return store.has(k) ? store.get(k)! : null;
    },
    async put(k, v) {
      kv.puts++;
      store.set(k, v);
    },
  };
  return kv;
}

const leaseOf = (host: "300" | "neo", until: Date) => serializeLease({ host, until: until.toISOString() });

describe("parseLease", () => {
  it("ausente, válido, ilegível", () => {
    assert.deepEqual(parseLease(null), { kind: "absent" });
    const ok = parseLease(leaseOf("neo", at(H)));
    assert.equal(ok.kind, "ok");
    assert.equal(parseLease("{nope").kind, "error");
    assert.equal(parseLease(JSON.stringify({ host: "outro", until: T0.toISOString() })).kind, "error");
    assert.equal(parseLease(JSON.stringify({ host: "300", until: "ontem" })).kind, "error");
  });
});

describe("decideLease (pura)", () => {
  const base = { now: T0, by: "Diaria-Shorts-Instagram", downSignal: false };

  it("lease ativo do Neo: o 300 cede, o Neo age", () => {
    const read = parseLease(leaseOf("neo", at(5 * H)));
    assert.equal(decideLease({ ...base, self: "300", read }).act, false);
    assert.equal(decideLease({ ...base, self: "300", read }).outcome, "yield");
    const neo = decideLease({ ...base, self: "neo", read });
    assert.equal(neo.act, true);
    assert.equal(neo.write, null, "faltando 5h de 6h não renova");
  });

  it("lease ativo do 300: o Neo cede mesmo com sinal de queda (sinal defasado)", () => {
    const read = parseLease(leaseOf("300", at(H)));
    const d = decideLease({ ...base, self: "neo", read, downSignal: true });
    assert.equal(d.act, false);
    assert.equal(d.outcome, "yield");
  });

  it("lease próprio com menos da metade do TTL: age e renova", () => {
    const read = parseLease(leaseOf("neo", at(H)));
    const d = decideLease({ ...base, self: "neo", read });
    assert.equal(d.act, true);
    assert.ok(d.write);
    assert.equal(d.write.host, "neo");
    assert.equal(Date.parse(d.write.until), T0.getTime() + LEASE_TTL_MS);
  });

  it("lease expirado do Neo é retomado pelo 300", () => {
    const read = parseLease(leaseOf("neo", at(-1)));
    const d = decideLease({ ...base, self: "300", read });
    assert.equal(d.act, true);
    assert.equal(d.write?.host, "300");
  });

  it("lease ausente: 300 assume; Neo só com sinal de queda", () => {
    const read = parseLease(null);
    assert.equal(decideLease({ ...base, self: "300", read }).act, true);
    assert.equal(decideLease({ ...base, self: "neo", read }).act, false);
    assert.equal(decideLease({ ...base, self: "neo", read, downSignal: true }).act, true);
  });

  it("lease ilegível: fail-open no 300, fail-closed no Neo", () => {
    const read = { kind: "error" as const, error: "HTTP 500" };
    const p = decideLease({ ...base, self: "300", read });
    assert.equal(p.act, true);
    assert.equal(p.write, null, "fail-open não grava por cima do que não conseguiu ler");
    const s = decideLease({ ...base, self: "neo", read });
    assert.equal(s.act, false);
    assert.equal(s.outcome, "fail-closed");
  });
});

describe("acquireSchedulerLease — concorrência com KV fingido", () => {
  it("dois donos com o Neo armado: só o Neo age", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(5 * H)) });
    const [p, s] = await Promise.all([
      acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 }),
      acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 }),
    ]);
    assert.equal(p.act, false);
    assert.equal(s.act, true);
    assert.equal([p, s].filter((r) => r.act).length, 1);
  });

  it("dois donos com o 300 de pé e sinal defasado: só o 300 age", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("300", at(4 * H)), [DOWN_SIGNAL_KEY]: T0.toISOString() });
    const [p, s] = await Promise.all([
      acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 }),
      acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 }),
    ]);
    assert.equal(p.act, true);
    assert.equal(s.act, false);
  });

  it("lease expirado do Neo é retomado pelo 300 e o Neo passa a ceder", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(-H)) });
    const p = await acquireSchedulerLease(kv, { self: "300", by: "Diaria-Clarice-Novos", now: () => T0 });
    assert.equal(p.act, true);
    const gravado = parseLease(kv.store.get(SCHEDULER_LEASE_KEY)!);
    assert.equal(gravado.kind === "ok" && gravado.lease.host, "300");
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "Diaria-Clarice-Novos", now: () => at(60_000) });
    assert.equal(s.act, false);
  });

  it("escrita por cima entre a gravação e a releitura: quem perdeu cede", async () => {
    // O Neo grava, mas antes da releitura o 300 grava o próprio lease ativo.
    const kv = fakeKv({ [DOWN_SIGNAL_KEY]: T0.toISOString() });
    const realPut = kv.put.bind(kv);
    kv.put = async (k, v) => {
      await realPut(k, v);
      if (JSON.parse(v).host === "neo") kv.store.set(SCHEDULER_LEASE_KEY, serializeLease(makeLease("300", T0, "concorrente")));
    };
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 });
    assert.equal(s.act, false);
    assert.equal(s.outcome, "yield");
  });

  it("KV fora do ar: 300 age (fail-open), Neo não (fail-closed)", async () => {
    const broken: LeaseKv = {
      get: async () => {
        throw new Error("fetch failed");
      },
      put: async () => {
        throw new Error("fetch failed");
      },
    };
    const p = await acquireSchedulerLease(broken, { self: "300", by: "x", now: () => T0 });
    const s = await acquireSchedulerLease(broken, { self: "neo", by: "x", now: () => T0 });
    assert.equal(p.act, true);
    assert.equal(s.act, false);
    assert.equal(s.outcome, "fail-closed");
  });

  it("gravação falha com a leitura ok: 300 age, Neo não", async () => {
    const kv = fakeKv({ [DOWN_SIGNAL_KEY]: T0.toISOString() });
    kv.put = async () => {
      throw new Error("HTTP 403");
    };
    assert.equal((await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 })).act, true);
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 });
    assert.equal(s.act, false);
    assert.equal(s.outcome, "fail-closed");
  });

  it("lease próprio no meio do TTL não gera escrita (KV não é gravado a cada hora)", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("300", at(5 * H)) });
    const r = await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 });
    assert.equal(r.act, true);
    assert.equal(kv.puts, 0);
  });
});
