/**
 * test/failover-scheduler-lease-12982.test.ts (#12982)
 *
 * Lease anti-duplicação 300 × Neo. Só fakes: nenhum teste fala com o KV real.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireSchedulerLease,
  ARM_LEASE_BY,
  decideLease,
  DOWN_SIGNAL_KEY,
  LEASE_TTL_MS,
  makeLease,
  parseLease,
  RECLAIM_JITTER_MS,
  RECLAIM_SETTLE_MS,
  SCHEDULER_LEASE_KEY,
  serializeLease,
  type LastKnownLease,
  type LeaseKv,
  type LeaseMemory,
} from "../scripts/lib/failover/scheduler-lease.ts";
import { fileLeaseMemory, parseLastKnown } from "../scripts/lib/failover/lease-memory.ts";

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

function memMemory(initial: LastKnownLease | null = null): LeaseMemory & { value: LastKnownLease | null } {
  const m = {
    value: initial,
    load: () => m.value,
    save: (v: LastKnownLease) => {
      m.value = v;
    },
  };
  return m;
}

const broken: LeaseKv = {
  get: async () => {
    throw new Error("fetch failed");
  },
  put: async () => {
    throw new Error("fetch failed");
  },
};

const leaseOf = (host: "300" | "neo", until: Date) => serializeLease({ host, until: until.toISOString() });
const leaseObj = (host: "300" | "neo", until: Date) => ({ host, until: until.toISOString() });

describe("parseLease", () => {
  it("ausente, válido, corrompido", () => {
    assert.deepEqual(parseLease(null), { kind: "absent" });
    assert.equal(parseLease(leaseOf("neo", at(H))).kind, "ok");
    assert.equal(parseLease("{nope").kind, "invalid");
    assert.equal(parseLease(JSON.stringify({ host: "outro", until: T0.toISOString() })).kind, "invalid");
    assert.equal(parseLease(JSON.stringify({ host: "300", until: "ontem" })).kind, "invalid");
  });
});

describe("decideLease (pura)", () => {
  const base = { now: T0, by: "Diaria-Shorts-Instagram" };

  it("lease ativo do Neo: o 300 cede, o Neo age", () => {
    const read = parseLease(leaseOf("neo", at(5 * H)));
    const p = decideLease({ ...base, self: "300", read });
    assert.equal(p.outcome, "yield");
    assert.equal(p.outcome === "yield" && p.cause, "other-host-active");
    const neo = decideLease({ ...base, self: "neo", read, downSignal: { kind: "absent" } });
    assert.equal(neo.outcome, "act");
    assert.equal(neo.outcome === "act" && neo.write, null, "faltando 5h de 6h não renova");
  });

  it("lease ativo do 300: o Neo cede mesmo com sinal de queda (sinal defasado)", () => {
    const read = parseLease(leaseOf("300", at(H)));
    const d = decideLease({ ...base, self: "neo", read, downSignal: { kind: "present", since: "x" } });
    assert.equal(d.outcome, "yield");
    assert.equal(d.outcome === "yield" && d.cause, "other-host-active");
  });

  it("lease próprio com menos da metade do TTL: age e renova (renewal)", () => {
    const read = parseLease(leaseOf("neo", at(H)));
    const d = decideLease({ ...base, self: "neo", read, downSignal: { kind: "absent" } });
    assert.equal(d.outcome, "act");
    if (d.outcome !== "act") return;
    assert.ok(d.write);
    assert.equal(d.renewal, true);
    assert.equal(d.write.host, "neo");
    assert.equal(Date.parse(d.write.until), T0.getTime() + LEASE_TTL_MS);
  });

  it("lease expirado do Neo é retomado pelo 300", () => {
    const d = decideLease({ ...base, self: "300", read: parseLease(leaseOf("neo", at(-1))) });
    assert.equal(d.outcome, "act");
    assert.equal(d.outcome === "act" && d.write?.host, "300");
  });

  it("F1: lease expirado do PRÓPRIO Neo é retomado pelo Neo, sem sinal de queda, marcado como retomada", () => {
    const d = decideLease({ ...base, self: "neo", read: parseLease(leaseOf("neo", at(-7 * H))), downSignal: { kind: "absent" } });
    assert.equal(d.outcome, "act");
    assert.equal(d.outcome === "act" && d.write?.host, "neo");
    assert.equal(d.outcome === "act" && d.reclaim, true, "#12993: a retomada passa pela espera + releitura");
    const p = decideLease({ ...base, self: "300", read: parseLease(leaseOf("neo", at(-H))) });
    assert.equal(p.outcome === "act" && p.reclaim, undefined, "o 300 (dono padrão) nunca espera");
  });

  it("lease ausente: 300 assume; Neo só com sinal de queda", () => {
    const read = parseLease(null);
    assert.equal(decideLease({ ...base, self: "300", read }).outcome, "act");
    const sem = decideLease({ ...base, self: "neo", read, downSignal: { kind: "absent" } });
    assert.equal(sem.outcome, "yield");
    assert.equal(sem.outcome === "yield" && sem.cause, "no-down-signal");
    assert.equal(decideLease({ ...base, self: "neo", read, downSignal: { kind: "present", since: "x" } }).outcome, "act");
  });

  it("F8: erro ao ler o sinal de queda no Neo é fail-closed, não 'sem sinal'", () => {
    for (const read of [parseLease(null), parseLease(leaseOf("300", at(-H)))]) {
      const d = decideLease({ ...base, self: "neo", read, downSignal: { kind: "error", error: "HTTP 500" } });
      assert.equal(d.outcome, "fail-closed");
    }
  });

  it("KV ilegível: fail-open no 300, fail-closed no Neo", () => {
    const read = { kind: "error" as const, error: "HTTP 500" };
    const p = decideLease({ ...base, self: "300", read });
    assert.equal(p.outcome, "act");
    assert.equal(p.outcome === "act" && p.write, null, "fail-open não grava por cima do que não conseguiu ler");
    assert.equal(decideLease({ ...base, self: "neo", read }).outcome, "fail-closed");
  });

  it("F3: KV ilegível no 300 com último lease conhecido do Neo é fail-closed; próprio/ausente segue fail-open", () => {
    const read = { kind: "error" as const, error: "HTTP 500" };
    const neoLast: LastKnownLease = { kind: "ok", lease: leaseObj("neo", at(H)), seenAt: T0.toISOString() };
    assert.equal(decideLease({ ...base, self: "300", read, lastKnown: neoLast }).outcome, "fail-closed");
    const ownLast: LastKnownLease = { kind: "ok", lease: leaseObj("300", at(H)), seenAt: T0.toISOString() };
    assert.equal(decideLease({ ...base, self: "300", read, lastKnown: ownLast }).outcome, "act");
    assert.equal(decideLease({ ...base, self: "300", read, lastKnown: { kind: "absent", seenAt: "x" } }).outcome, "act");
  });

  it("lease corrompido: o 300 sobrescreve, o Neo não age", () => {
    const read = parseLease("{lixo");
    const p = decideLease({ ...base, self: "300", read });
    assert.equal(p.outcome, "act");
    assert.equal(p.outcome === "act" && p.write?.host, "300");
    assert.equal(decideLease({ ...base, self: "neo", read }).outcome, "fail-closed");
  });
});

describe("acquireSchedulerLease — concorrência com KV fingido", () => {
  it("dois donos com o Neo armado: só o Neo age", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(5 * H)) });
    const [p, s] = await Promise.all([
      acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 }),
      acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 }),
    ]);
    assert.equal(p.outcome, "yield");
    assert.equal(s.outcome, "act");
  });

  it("dois donos com o 300 de pé e sinal defasado: só o 300 age", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("300", at(4 * H)), [DOWN_SIGNAL_KEY]: T0.toISOString() });
    const [p, s] = await Promise.all([
      acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 }),
      acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 }),
    ]);
    assert.equal(p.outcome, "act");
    assert.equal(s.outcome, "yield");
  });

  it("lease expirado do Neo é retomado pelo 300 e o Neo passa a ceder", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(-H)) });
    assert.equal((await acquireSchedulerLease(kv, { self: "300", by: "Diaria-Clarice-Novos", now: () => T0 })).outcome, "act");
    const gravado = parseLease(kv.store.get(SCHEDULER_LEASE_KEY)!);
    assert.equal(gravado.kind === "ok" && gravado.lease.host, "300");
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "Diaria-Clarice-Novos", now: () => at(60_000) });
    assert.equal(s.outcome, "yield");
  });

  it("escrita por cima entre a gravação e a releitura: quem perdeu cede", async () => {
    const kv = fakeKv({ [DOWN_SIGNAL_KEY]: T0.toISOString() });
    const realPut = kv.put.bind(kv);
    kv.put = async (k, v) => {
      await realPut(k, v);
      if (JSON.parse(v).host === "neo") kv.store.set(SCHEDULER_LEASE_KEY, serializeLease(makeLease("300", T0, "concorrente")));
    };
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 });
    assert.equal(s.outcome, "yield");
  });

  it("releitura com o mesmo host e until diferente: posse confirmada", async () => {
    const kv = fakeKv({ [DOWN_SIGNAL_KEY]: T0.toISOString() });
    const realPut = kv.put.bind(kv);
    kv.put = async (k, v) => {
      await realPut(k, v);
      kv.store.set(SCHEDULER_LEASE_KEY, serializeLease(makeLease("neo", at(1000), "outra task do Neo")));
    };
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 });
    assert.equal(s.outcome, "act");
    assert.match(s.reason, /renovação concorrente/);
  });

  it("lease sumiu depois da gravação: 300 age (fail-open), Neo fail-closed na aquisição", async () => {
    const mk = () => {
      const kv = fakeKv({ [DOWN_SIGNAL_KEY]: T0.toISOString() });
      kv.put = async () => {
        kv.puts++; // grava "nada": a releitura vê ausente
      };
      return kv;
    };
    const p = await acquireSchedulerLease(mk(), { self: "300", by: "x", now: () => T0 });
    assert.equal(p.outcome, "act");
    assert.match(p.reason, /sumiu/);
    const s = await acquireSchedulerLease(mk(), { self: "neo", by: "x", now: () => T0 });
    assert.equal(s.outcome, "fail-closed");
  });

  it("KV fora do ar: 300 age (fail-open), Neo não (fail-closed)", async () => {
    const p = await acquireSchedulerLease(broken, { self: "300", by: "x", now: () => T0 });
    const s = await acquireSchedulerLease(broken, { self: "neo", by: "x", now: () => T0 });
    assert.equal(p.outcome, "act");
    assert.equal(s.outcome, "fail-closed");
  });

  it("F3: KV fora do ar com memória local do lease do Neo: o 300 fica fail-closed", async () => {
    const memory = memMemory({ kind: "ok", lease: leaseObj("neo", at(H)), seenAt: T0.toISOString() });
    const p = await acquireSchedulerLease(broken, { self: "300", by: "x", now: () => T0, memory });
    assert.equal(p.outcome, "fail-closed");
  });

  it("F3: a leitura bem-sucedida grava a memória local (e a releitura também)", async () => {
    const memory = memMemory();
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(5 * H)) });
    await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0, memory });
    assert.equal(memory.value?.kind === "ok" && memory.value.lease.host, "neo");
    const kv2 = fakeKv();
    await acquireSchedulerLease(kv2, { self: "300", by: "x", now: () => T0, memory });
    assert.equal(memory.value?.kind === "ok" && memory.value.lease.host, "300");
  });

  it("gravação falha na AQUISIÇÃO: 300 age, Neo fail-closed", async () => {
    const kv = fakeKv({ [DOWN_SIGNAL_KEY]: T0.toISOString() });
    kv.put = async () => {
      throw new Error("HTTP 403");
    };
    assert.equal((await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 })).outcome, "act");
    assert.equal((await acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 })).outcome, "fail-closed");
  });

  it("F7: falha na RENOVAÇÃO de lease próprio ativo é aviso e o Neo age", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(H)) });
    kv.put = async () => {
      throw new Error("HTTP 503");
    };
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0 });
    assert.equal(s.outcome, "act");
    assert.equal(s.outcome === "act" && s.warning, true);
  });

  it("F2: o 300 de pé vê o lease do Neo renovado entre duas leituras: cause other-host-renewing", async () => {
    const memory = memMemory();
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(5 * H)) });
    const first = await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0, memory });
    assert.equal(first.outcome === "yield" && first.cause, "other-host-active", "primeira vez: só cede");
    kv.store.set(SCHEDULER_LEASE_KEY, leaseOf("neo", at(8 * H)));
    const second = await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => at(H), memory });
    assert.equal(second.outcome === "yield" && second.cause, "other-host-renewing");
    assert.match(second.reason, /neo-takeover\.ts --disarm/);
  });

  it("lease próprio no meio do TTL não gera escrita (KV não é gravado a cada hora)", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("300", at(5 * H)) });
    assert.equal((await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 })).outcome, "act");
    assert.equal(kv.puts, 0);
  });

  it("lease corrompido é sobrescrito pelo 300", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: "{lixo" });
    assert.equal((await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0 })).outcome, "act");
    const back = parseLease(kv.store.get(SCHEDULER_LEASE_KEY)!);
    assert.equal(back.kind === "ok" && back.lease.host, "300");
  });
});

/**
 * KV com consistência eventual por região: cada host lê a própria escrita na
 * hora; a do outro só depois de `lagMs` no relógio virtual. É o cenário real
 * do #12993 (KV da Cloudflare, ~60 s entre regiões).
 */
function regionalKv(initial: Record<string, string>, lagMs = 60_000) {
  let clock = 0;
  const writes: { key: string; value: string; at: number; host: string }[] = [];
  const view = (host: "300" | "neo"): LeaseKv => ({
    async get(k) {
      const visible = writes.filter((w) => w.key === k && (w.host === host || clock - w.at >= lagMs));
      if (visible.length) return visible[visible.length - 1].value;
      return k in initial ? initial[k] : null;
    },
    async put(k, v) {
      writes.push({ key: k, value: v, at: clock, host });
    },
  });
  return { view, advance: (ms: number) => void (clock += ms) };
}

describe("#12993: retomada do lease expirado do Neo com o 300 voltando no mesmo minuto", () => {
  it("só o 300 age: o Neo espera, relê, vê o lease do 300 e cede", async () => {
    const kv = regionalKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(-H)) });
    const waits: number[] = [];
    const p300 = acquireSchedulerLease(kv.view("300"), { self: "300", by: "Diaria-Shorts-Instagram", now: () => T0 });
    const pNeo = acquireSchedulerLease(kv.view("neo"), {
      self: "neo",
      by: "Diaria-Shorts-Instagram",
      now: () => T0,
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
        await p300; // o 300 dispara no mesmo minuto e não espera
        kv.advance(ms);
      },
    });
    const [p, s] = await Promise.all([p300, pNeo]);
    assert.equal(p.outcome, "act");
    assert.equal(s.outcome, "yield", s.reason);
    assert.equal(s.outcome === "yield" && s.cause, "other-host-active");
    assert.deepEqual(waits, [RECLAIM_SETTLE_MS + RECLAIM_JITTER_MS / 2]);
    assert.ok(RECLAIM_SETTLE_MS > 60_000, "a espera passa da janela de consistência do KV");
  });

  it("sem o 300: o Neo retoma depois da espera, gravando o lease a partir do relógio de depois", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(-H)) });
    let t = T0;
    const s = await acquireSchedulerLease(kv, {
      self: "neo",
      by: "x",
      now: () => t,
      random: () => 0,
      sleep: async (ms) => {
        t = at(ms);
      },
    });
    assert.equal(s.outcome, "act", s.reason);
    const back = parseLease(kv.store.get(SCHEDULER_LEASE_KEY)!);
    assert.equal(back.kind === "ok" && back.lease.host, "neo");
    assert.equal(back.kind === "ok" && Date.parse(back.lease.until), T0.getTime() + RECLAIM_SETTLE_MS + LEASE_TTL_MS);
  });

  it("lease mudou durante a espera (sumiu): o Neo não age nesta run", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(-H)) });
    const s = await acquireSchedulerLease(kv, {
      self: "neo",
      by: "x",
      now: () => T0,
      sleep: async () => {
        kv.store.delete(SCHEDULER_LEASE_KEY);
      },
    });
    assert.equal(s.outcome, "fail-closed");
    assert.equal(kv.puts, 0);
  });

  it("renovação de lease próprio ATIVO não espera", async () => {
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("neo", at(H)) });
    let slept = 0;
    const s = await acquireSchedulerLease(kv, { self: "neo", by: "x", now: () => T0, sleep: async () => void slept++ });
    assert.equal(s.outcome, "act");
    assert.equal(slept, 0);
  });
});

describe("#12993: alarme other-host-renewing não dispara com memória de outro episódio", () => {
  it("memória com lease do Neo já expirado + lease novo do --arm: só cede, sem anomalia", async () => {
    const memory = memMemory({ kind: "ok", lease: leaseObj("neo", at(-2 * H)), seenAt: at(-8 * H).toISOString() });
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: serializeLease(makeLease("neo", T0, ARM_LEASE_BY)) });
    const r = await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => at(60_000), memory });
    assert.equal(r.outcome === "yield" && r.cause, "other-host-active", r.reason);
  });

  it("memória com lease do Neo ainda ativo + lease atual gravado pelo --arm: armação nova, sem anomalia", async () => {
    const memory = memMemory({ kind: "ok", lease: leaseObj("neo", at(2 * H)), seenAt: at(-H).toISOString() });
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: serializeLease(makeLease("neo", T0, ARM_LEASE_BY)) });
    const r = await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0, memory });
    assert.equal(r.outcome === "yield" && r.cause, "other-host-active", r.reason);
  });

  it("renovação de verdade (lease lembrado ainda ativo, renovado por task) segue alarmando", async () => {
    const memory = memMemory({ kind: "ok", lease: leaseObj("neo", at(2 * H)), seenAt: at(-H).toISOString() });
    const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: serializeLease(makeLease("neo", T0, "Diaria-Shorts-Instagram")) });
    const r = await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0, memory });
    assert.equal(r.outcome === "yield" && r.cause, "other-host-renewing", r.reason);
  });
});

describe("#12993: memória local do lease que falha avisa com caminho e erro", () => {
  it("gravação impossível (pai é arquivo): WARN com o caminho; a decisão não muda", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-mem-warn-12993-"));
    try {
      writeFileSync(join(dir, "arquivo"), "x");
      const path = join(dir, "arquivo", "sub", "last.json");
      const warns: string[] = [];
      const kv = fakeKv({ [SCHEDULER_LEASE_KEY]: leaseOf("300", at(5 * H)) });
      const r = await acquireSchedulerLease(kv, { self: "300", by: "x", now: () => T0, memory: fileLeaseMemory(path), warn: (m) => void warns.push(m) });
      assert.equal(r.outcome, "act");
      assert.ok(warns.some((w) => w.includes(path) && /WARN/.test(w)), warns.join("\n"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leitura com erro que não é ENOENT (caminho é diretório) lança com o caminho; ausente segue null", () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-mem-read-12993-"));
    try {
      const asDir = join(dir, "last.json");
      mkdirSync(asDir);
      assert.throws(() => fileLeaseMemory(asDir).load(), (e: Error) => e.message.includes(asDir));
      assert.equal(fileLeaseMemory(join(dir, "nao-existe.json")).load(), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fileLeaseMemory", () => {
  it("grava e relê; arquivo ausente ou corrompido vira null", () => {
    const dir = mkdtempSync(join(tmpdir(), "lease-mem-12982-"));
    try {
      const path = join(dir, "sub", "last.json");
      const m = fileLeaseMemory(path);
      assert.equal(m.load(), null);
      m.save({ kind: "ok", lease: leaseObj("neo", at(H)), seenAt: T0.toISOString() });
      assert.equal(m.load()?.kind, "ok");
      writeFileSync(path, "{nope");
      assert.equal(m.load(), null);
      assert.equal(parseLastKnown(JSON.stringify({ kind: "absent", seenAt: "x" }))?.kind, "absent");
      assert.equal(parseLastKnown(JSON.stringify({ kind: "ok", lease: { host: "z" }, seenAt: "x" })), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
