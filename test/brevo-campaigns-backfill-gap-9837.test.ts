/**
 * test/brevo-campaigns-backfill-gap-9837.test.ts
 *
 * #9837 — o índice de arquivo (`dash:campaigns:archive-index`) não pode
 * deixar buraco quando chegam campanhas novas, nem depois de `done` nem NO
 * MEIO de uma varredura. O PR #9841 cobriu o caso "cursor done + N novas,
 * N ≤ batchSize, varridas numa chamada só". Aqui fica o resíduo:
 *
 *   - lacuna maior que o lote (varrida em várias chamadas) com campanhas
 *     novas chegando ENTRE as chamadas — cenário real: a lacuna de setembro
 *     tinha 25+ campanhas, o lote default é 20, e a cadência é de ~3
 *     envios/dia, então o deslocamento entre duas chamadas diárias é a regra;
 *   - backfill inicial (sem `done` ainda) com campanhas novas chegando no
 *     meio — o rabo (as mais antigas, empurradas além do `totalCount` velho)
 *     e as que saem da janela ao vivo durante a varredura.
 *
 * Em vez de mocks por offset fixo, um SIMULADOR de conta Brevo: lista
 * ordenada (mais recente primeiro) servida por `limit`/`offset`, com `count`
 * sempre igual ao tamanho atual da lista. A propriedade verificada é a que a
 * "Definição de feito" da issue pede: janela ao vivo (offset [0, 100)) ∪
 * arquivo = todas as campanhas imutáveis da conta.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  readCampaignsArchiveIndex,
  readCampaignsBackfillCursor,
  runCampaignsBackfillBatch,
  CAMPAIGNS_BACKFILL_CURSOR_KV_KEY,
  CAMPAIGNS_FETCH_LIMIT,
} from "../workers/brevo-dashboard/src/index.ts";
import { advanceBackfillGaps } from "../workers/brevo-dashboard/src/brevo-api.ts";

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-09-01T12:00:00Z");

function makeKv(initial: Record<string, unknown> = {}) {
  const store = new Map<string, string>(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    store,
    kv: {
      get: async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      },
      put: async (key: string, value: string) => {
        store.set(key, value);
      },
      delete: async () => {},
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

/** Conta Brevo simulada: `campaigns[0]` é a mais recente (sort=desc). */
function makeAccount(initialCount: number, nowMs: number) {
  let nextId = 1;
  const campaigns: Array<{ id: number; name: string; sentDate: string; recipients: { lists: number[] } }> = [];
  // As mais antigas primeiro (id menor), 8h entre envios — todas imutáveis.
  for (let i = 0; i < initialCount; i++) {
    const sentDate = new Date(nowMs - 30 * DAY - (initialCount - i) * 8 * HOUR).toISOString();
    campaigns.unshift({ id: nextId++, name: `c${nextId}`, sentDate, recipients: { lists: [1] } });
  }
  return {
    campaigns,
    /** Novas campanhas entram no TOPO (offset 0), empurrando o resto. As
     * datas são antigas o bastante pra serem imutáveis — o teste mira o
     * deslocamento de offset, não a regra dos 7 dias. */
    send(n: number, sentAtMs: number) {
      for (let i = 0; i < n; i++) {
        campaigns.unshift({ id: nextId++, name: `n${nextId}`, sentDate: new Date(sentAtMs + i * HOUR).toISOString(), recipients: { lists: [1] } });
      }
    },
    fetchFn: async (path: string) => {
      const limit = Number(path.match(/limit=(\d+)/)?.[1] ?? 50);
      const offset = Number(path.match(/offset=(\d+)/)?.[1] ?? 0);
      if (/emailCampaigns\/\d+\?statistics=globalStats/.test(path)) {
        return { statistics: { globalStats: { sent: 10, delivered: 10 } } };
      }
      return { campaigns: campaigns.slice(offset, offset + limit), count: campaigns.length };
    },
  };
}

async function coverageHoles(account: ReturnType<typeof makeAccount>, kv: unknown): Promise<number[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const archive = await readCampaignsArchiveIndex({ STATS_CACHE: kv as any });
  const covered = new Set<number>([
    ...account.campaigns.slice(0, CAMPAIGNS_FETCH_LIMIT).map((c) => c.id),
    ...archive.map((a) => a.id),
  ]);
  return account.campaigns.filter((c) => !covered.has(c.id)).map((c) => c.id);
}

describe("#9837 — backfill não deixa buraco com campanhas novas entre chamadas", () => {
  test("cursor done + lacuna MAIOR que o lote + campanhas novas entre as chamadas", async () => {
    // Estado de produção reconstruído: backfill terminou com total=200 e
    // depois chegaram 45 campanhas (as 45 que saíram da janela nunca foram
    // arquivadas). Pré-condição: o arquivo tem exatamente [100, 200) da época.
    const now = T0 + 60 * DAY;
    const account = makeAccount(200, now);
    const archived = account.campaigns.slice(CAMPAIGNS_FETCH_LIMIT).map((c) => ({
      id: c.id, name: c.name, sentDate: c.sentDate, listIds: [1],
    }));
    account.send(45, now - 20 * DAY);
    const { kv } = makeKv({
      "dash:campaigns:archive-index": archived,
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: { offset: 200, totalCount: 200, done: true, updatedAt: new Date(now).toISOString() },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal((await coverageHoles(account, kv)).length, 45, "pré-condição: 45 buracos");

    // Cron diário com lote 20 e ~3 envios/dia entre as chamadas.
    for (let day = 0; day < 10; day++) {
      await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
      account.send(3, now - 19 * DAY + day * DAY);
    }
    // Uma chamada final sem envio novo depois dela.
    await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any

    assert.deepEqual(await coverageHoles(account, kv), []);
    const cursor = await readCampaignsBackfillCursor(env, now);
    assert.equal(cursor.done, true);
    assert.equal(cursor.totalCount, account.campaigns.length);
  });

  test("backfill inicial com campanhas novas no meio — nem o rabo nem as que saem da janela se perdem", async () => {
    const now = T0 + 60 * DAY;
    const account = makeAccount(180, now);
    const { kv } = makeKv();
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let day = 0; day < 12; day++) {
      await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 15 }); // eslint-disable-line @typescript-eslint/no-explicit-any
      account.send(4, now - 25 * DAY + day * DAY);
    }
    for (let i = 0; i < 4; i++) {
      await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 15 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    assert.deepEqual(await coverageHoles(account, kv), []);
    assert.equal((await readCampaignsBackfillCursor(env, now)).done, true);
  });

  test("campanha ainda mutável na lacuna fica pendente e entra no arquivo quando vira imutável", async () => {
    const now = T0 + 60 * DAY;
    const account = makeAccount(100, now);
    // 3 campanhas que já saíram da janela mas têm só 3 dias (cadência alta).
    account.send(3, now - 3 * DAY);
    account.send(100, now - 2 * DAY); // empurra as 3 pra [100, 103)
    const { kv } = makeKv({
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: { offset: 100, totalCount: 203, done: false, updatedAt: new Date(now).toISOString() },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const first = await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 50 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(first.cursor.done, false, "mutáveis seguram o cursor aberto");
    assert.deepEqual(first.cursor.gaps?.[0], { start: 100, end: 103 });
    // 5 dias depois, já imutáveis.
    for (let i = 0; i < 4; i++) {
      await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now + 5 * DAY, batchSize: 50 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    assert.deepEqual(await coverageHoles(account, kv), []);
    assert.equal((await readCampaignsBackfillCursor(env, now)).done, true);
  });

  test("orçamento do lote é repartido entre lacunas — a faixa pequena das que saíram da janela não monopoliza a chamada", async () => {
    const now = T0 + 60 * DAY;
    const account = makeAccount(150, now);
    const { kv } = makeKv({
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: 100, totalCount: 150, done: false, gaps: [{ start: 100, end: 103 }, { start: 130, end: 150 }],
        updatedAt: new Date(now).toISOString(),
      },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(r.scanned, 20);
    assert.deepEqual(r.cursor.gaps, [{ start: 147, end: 150 }]);
  });

  test("cursor legado com resumeAt (gravado pelo #9841) é migrado sem perder a lacuna", async () => {
    const now = T0 + 60 * DAY;
    const account = makeAccount(130, now);
    // Arquivo tem [100+30, 130+30) da época; a lacuna [100, 130) está meio
    // varrida: [100, 110) já foi, o cursor legado aponta pra 110 até 130.
    account.send(30, now - 20 * DAY);
    const archived = [
      ...account.campaigns.slice(100, 110),
      ...account.campaigns.slice(130),
    ].map((c) => ({ id: c.id, name: c.name, sentDate: c.sentDate, listIds: [1] }));
    const { kv } = makeKv({
      "dash:campaigns:archive-index": archived,
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: 110, totalCount: 160, done: false, resumeAt: 130, updatedAt: new Date(now).toISOString(),
      },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (let i = 0; i < 3; i++) {
      await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    assert.deepEqual(await coverageHoles(account, kv), []);
  });
});

describe("#9837 — advanceBackfillGaps (pura)", () => {
  const L = CAMPAIGNS_FETCH_LIMIT;

  test("sem deslocamento: só subtrai o trecho processado", () => {
    assert.deepEqual(
      advanceBackfillGaps([{ start: 100, end: 160 }], { shift: 0, processedStart: 100, processedCount: 20, total: 300, liveWindow: L }),
      [{ start: 120, end: 160 }],
    );
  });

  test("deslocamento s: lacunas pendentes andam +s e [L, L+s) entra como lacuna nova", () => {
    // Pendente [120, 160) no total velho; chegaram 3; a página foi lida em
    // [120, 140) nas coordenadas NOVAS (= [117, 137) velhas).
    assert.deepEqual(
      advanceBackfillGaps([{ start: 120, end: 160 }], { shift: 3, processedStart: 120, processedCount: 20, total: 303, liveWindow: L }),
      [{ start: 100, end: 103 }, { start: 140, end: 163 }],
    );
  });

  test("lacunas adjacentes ou sobrepostas são fundidas; tudo é cortado no total", () => {
    assert.deepEqual(
      advanceBackfillGaps([{ start: 100, end: 110 }, { start: 105, end: 400 }], { shift: 0, processedStart: 100, processedCount: 0, total: 250, liveWindow: L }),
      [{ start: 100, end: 250 }],
    );
  });

  test("total que DIMINUI (campanha removida) desloca pra trás sem atravessar a janela ao vivo", () => {
    assert.deepEqual(
      advanceBackfillGaps([{ start: 101, end: 150 }], { shift: -2, processedStart: 100, processedCount: 0, total: 200, liveWindow: L }),
      [{ start: 100, end: 148 }],
    );
  });
});
