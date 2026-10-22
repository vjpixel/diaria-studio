/**
 * test/kit-engagement-cache-10514.test.ts (#10514)
 *
 * Passo 3c: o cache de engajamento de broadcasts com >= 7 dias limita as
 * leituras ao Kit por rodada (não crescem com o histórico) e a seleção é a
 * MESMA com e sem cache.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildEngagementIndex,
  selectKitSemAbertura,
  type BroadcastEngagement,
  type DiariaBroadcastRecord,
  type KitActiveCandidate,
} from "../scripts/lib/kit-sem-abertura.ts";
import {
  KIT_ENGAGEMENT_FREEZE_DAYS,
  extendKitEngagementCache,
  mergeEngagementIndexes,
  parseKitEngagementCache,
  planKitEngagementFetch,
  type KitEngagementCache,
} from "../scripts/lib/kit-engagement-cache.ts";
import {
  runKitSemAberturaSync,
  type KitSemAberturaDeps,
  type KitSemAberturaPlatformConfig,
} from "../scripts/sync-kit-sem-abertura-to-brevo.ts";
import type { BrevoDiariaStore } from "../scripts/lib/brevo-diaria-store.ts";

const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const EMAILS = Array.from({ length: 40 }, (_, i) => `p${i}@x.com`);

/** PRNG determinístico (mulberry32) — dados variados, mas reproduzíveis. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `n` broadcasts, 1 por dia terminando ontem; engajamento esparso (muitos sem abertura). */
function history(n: number, seed = 1) {
  const r = rng(seed);
  const records: DiariaBroadcastRecord[] = [];
  const data = new Map<number, BroadcastEngagement>();
  for (let i = 0; i < n; i++) {
    const id = 1000 + i;
    records.push({ broadcastId: id, sentAt: new Date(NOW - (n - i) * DAY).toISOString(), edition: `e${i}` });
    const delivered = EMAILS.filter(() => r() < 0.85);
    // Maiúsculas em parte dos e-mails: o agregado precisa normalizar igual ao índice.
    const opens = delivered.filter(() => r() < 0.03).map((e, k) => (k % 2 ? e.toUpperCase() : e));
    const clicks = delivered.filter(() => r() < 0.01);
    // Leitor fora da base: broadcast real sempre tem abertura (#10787 trata
    // entregues sem nenhuma abertura como ainda não indexado).
    data.set(id, { broadcastId: id, delivered, opens: [...opens, "leitor-fora-da-base@x.com"], clicks });
  }
  return { records, data };
}

const actives: KitActiveCandidate[] = EMAILS.map((email, i) => ({ id: i + 1, email, created_at: "2026-01-01T00:00:00.000Z", tagNames: [] }));

function cfg(): KitSemAberturaPlatformConfig {
  return {
    brevo_diaria: { api_key_env: "X", list_id: 7, daily_send_cap: 295, kit_sem_abertura: { enabled: true } },
    kit: { diaria_exclusion_segment: { enabled: true, segment_id: 99 } },
  };
}

/** Roda o Passo 3c com push (fakes) e devolve quem foi movido + ids pedidos ao Kit. */
async function run(
  records: DiariaBroadcastRecord[],
  data: Map<number, BroadcastEngagement>,
  nowMs: number,
  cacheBox?: { value: unknown },
  extra: Partial<KitSemAberturaDeps> = {},
) {
  const asked: number[] = [];
  const moved: string[] = [];
  const logs: string[] = [];
  let store: BrevoDiariaStore = { contacts: [] };
  const deps: KitSemAberturaDeps = {
    nowMs,
    log: (m) => logs.push(m),
    readRegistry: () => records,
    listKitActive: async () => actives,
    fetchEngagement: async (id) => {
      asked.push(id);
      return data.get(id)!;
    },
    engagementCache: cacheBox
      ? { read: () => cacheBox.value, write: (c) => void (cacheBox.value = JSON.parse(JSON.stringify(c))) }
      : undefined,
    findEnvioBrevoTagId: async () => 555,
    readStore: () => store,
    writeStore: (s) => void (store = s),
    rolloutPaused: () => false,
    transactionalOnSendDay: async () => 0,
    getApoioNivel: async () => null,
    isBrevoBlacklisted: async () => false,
    ingestBrevo: async (email) => void moved.push(email),
    tagKit: async () => {},
    untagKit: async () => {},
    appendLog: () => {},
    ...extra,
  };
  const result = await runKitSemAberturaSync(cfg(), { push: true }, deps);
  const selectionLog = logs.find((l) => l.includes("selecionado(s)"));
  return { result, asked, moved: moved.sort(), selectionLog, logs };
}

describe("cache de engajamento do Passo 3c (#10514)", () => {
  it("seleção idêntica com e sem cache, ao longo de vários dias", async () => {
    const full = history(45);
    const box = { value: null as unknown };
    for (let d = 0; d < 10; d++) {
      // Um broadcast novo por dia: o registro cresce entre as rodadas.
      const n = 35 + d;
      const records = full.records.slice(0, n);
      const now = NOW - (45 - n) * DAY;
      const sem = await run(records, full.data, now);
      const com = await run(records, full.data, now, box);
      assert.deepEqual(com.moved, sem.moved, `dia ${d}: movidos divergem`);
      assert.equal(com.selectionLog, sem.selectionLog, `dia ${d}: contagem de exclusões diverge`);
      assert.equal(com.result.selected, sem.result.selected);
      assert.equal(sem.asked.length, n, "sem cache relê tudo");
      if (d > 0) {
        // Com cache aquecido: só os broadcasts com < 7 dias + o que acabou de cruzar os 7 dias.
        assert.ok(com.asked.length <= KIT_ENGAGEMENT_FREEZE_DAYS + 1, `dia ${d}: ${com.asked.length} leituras`);
      }
    }
    // Sanidade: o cenário exercita os dois lados (alguém movido, alguém excluído por abrir).
    const last = await run(full.records.slice(0, 44), full.data, NOW - DAY);
    assert.ok(last.moved.length > 0 && last.moved.length < EMAILS.length);
    assert.match(last.selectionLog ?? "", /abriu=[1-9]/);
  });

  it("nº de leituras por rodada não cresce com o histórico", async () => {
    const counts: number[] = [];
    for (const n of [30, 120, 400]) {
      const h = history(n, n);
      const box = { value: null as unknown };
      await run(h.records, h.data, NOW, box); // aquece
      const warm = await run(h.records, h.data, NOW + DAY, box);
      counts.push(warm.asked.length);
    }
    assert.equal(new Set(counts).size, 1, `leituras variaram com o histórico: ${counts}`);
    assert.ok(counts[0] <= KIT_ENGAGEMENT_FREEZE_DAYS + 1);
  });

  it("cache ilegível/inválido ⇒ fail-soft: relê tudo e a seleção não muda", async () => {
    const h = history(20);
    const sem = await run(h.records, h.data, NOW);
    for (const bad of [{ version: 99 }, "lixo", { version: 1, frozen_ids: [1], subscribers: { "a@x.com": [1, "x", 0] } }]) {
      const r = await run(h.records, h.data, NOW, { value: bad });
      assert.equal(r.asked.length, 20);
      assert.deepEqual(r.moved, sem.moved);
      assert.ok(r.logs.some((l) => /cache de engajamento descartado/.test(l)));
    }
    const throwing = await run(h.records, h.data, NOW, undefined, {
      engagementCache: {
        read: () => {
          throw new Error("EACCES");
        },
        write: () => {
          throw new Error("ENOSPC");
        },
      },
    });
    assert.equal(throwing.result.code, 0);
    assert.deepEqual(throwing.moved, sem.moved);
    assert.ok(throwing.logs.some((l) => /ilegível \(EACCES\)/.test(l)));
    assert.ok(throwing.logs.some((l) => /falha ao gravar o cache.*ENOSPC/.test(l)));
  });

  it("broadcast congelado que saiu do registro ⇒ cache descartado inteiro", async () => {
    const h = history(20);
    const box = { value: null as unknown };
    await run(h.records, h.data, NOW, box);
    const frozen = (box.value as KitEngagementCache).frozen_ids;
    assert.ok(frozen.length > 0);
    const without = h.records.filter((r) => r.broadcastId !== frozen[0]);
    const sem = await run(without, h.data, NOW);
    const com = await run(without, h.data, NOW, box);
    assert.equal(com.asked.length, without.length);
    assert.deepEqual(com.moved, sem.moved);
  });

  it("broadcast com < 7 dias nunca congela (é relido toda rodada)", () => {
    const h = history(10);
    const sentIds = h.records.map((r) => r.broadcastId);
    const plan = planKitEngagementFetch({ records: h.records, sentIds, nowMs: NOW, cacheRaw: null });
    const next = extendKitEngagementCache(plan, sentIds.map((id) => h.data.get(id)!));
    assert.ok(next);
    const young = h.records.filter((r) => NOW - Date.parse(r.sentAt) < KIT_ENGAGEMENT_FREEZE_DAYS * DAY).map((r) => r.broadcastId);
    assert.ok(young.length > 0);
    for (const id of young) assert.ok(!next.frozen_ids.includes(id));
    assert.ok(parseKitEngagementCache(JSON.parse(JSON.stringify(next))));
  });

  it("agregado congelado + relidos = índice do registro inteiro (pura)", () => {
    const h = history(25, 7);
    const all = h.records.map((r) => h.data.get(r.broadcastId)!);
    const matureIds = new Set(h.records.filter((r) => NOW - Date.parse(r.sentAt) >= 2 * DAY).map((r) => r.broadcastId));
    const whole = buildEngagementIndex(all, matureIds);
    const sentIds = h.records.map((r) => r.broadcastId);
    const cache = extendKitEngagementCache(planKitEngagementFetch({ records: h.records, sentIds, nowMs: NOW, cacheRaw: null }), all);
    const plan = planKitEngagementFetch({ records: h.records, sentIds, nowMs: NOW, cacheRaw: cache });
    const fetched = plan.toFetch.map((id) => h.data.get(id)!);
    const merged = mergeEngagementIndexes(plan.cachedIndex, buildEngagementIndex(fetched, matureIds));
    assert.deepEqual(new Map([...merged].sort()), new Map([...whole].sort()));
    const sel = (engagement: typeof whole) => selectKitSemAbertura({ subscribers: actives, engagement, storeEmails: [], seedEmails: [] });
    assert.deepEqual(sel(merged), sel(whole));
  });
});
