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
import {
  advanceBackfillGaps,
  backfillGapsFromCursor,
  backfillScannedFrontier,
  normalizeCampaignsBackfillCursor,
  BrevoRateLimitError,
  BrevoUpstreamError,
  CAMPAIGNS_BACKFILL_CURSOR_VERSION,
} from "../workers/brevo-dashboard/src/brevo-api.ts";

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

/** #9852: só conta como coberta a campanha arquivada COM `stats:{id}` — é o
 * critério de `loadMonthlyTotalsArchive` (entrada sem stats é descartada do
 * agregado mensal). Antes do #9852 bastava estar no índice, e a suíte não
 * enxergava a campanha que esgotava o 429. */
async function coverageHoles(
  account: ReturnType<typeof makeAccount>,
  kv: { get: (k: string, t?: string) => Promise<unknown> },
): Promise<number[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const archive = await readCampaignsArchiveIndex({ STATS_CACHE: kv as any });
  const withStats: number[] = [];
  for (const a of archive) if (await kv.get(`stats:${a.id}`, "json")) withStats.push(a.id);
  const covered = new Set<number>([...account.campaigns.slice(0, CAMPAIGNS_FETCH_LIMIT).map((c) => c.id), ...withStats]);
  return account.campaigns.filter((c) => !covered.has(c.id)).map((c) => c.id);
}

/** Entradas de índice + `stats:{id}` pra pré-popular o KV com campanhas já
 * arquivadas por uma varredura anterior. */
function archivedState(campaigns: ReadonlyArray<{ id: number; name: string; sentDate: string }>): Record<string, unknown> {
  const state: Record<string, unknown> = {
    "dash:campaigns:archive-index": campaigns.map((c) => ({ id: c.id, name: c.name, sentDate: c.sentDate, listIds: [1] })),
  };
  for (const c of campaigns) state[`stats:${c.id}`] = { gs: { sent: 10, delivered: 10 } };
  return state;
}

describe("#9837 — backfill não deixa buraco com campanhas novas entre chamadas", () => {
  test("cursor done + lacuna MAIOR que o lote + campanhas novas entre as chamadas", async () => {
    // Estado de produção reconstruído: backfill terminou com total=200 e
    // depois chegaram 45 campanhas (as 45 que saíram da janela nunca foram
    // arquivadas). Pré-condição: o arquivo tem exatamente [100, 200) da época.
    const now = T0 + 60 * DAY;
    const account = makeAccount(200, now);
    const archived = account.campaigns.slice(CAMPAIGNS_FETCH_LIMIT);
    account.send(45, now - 20 * DAY);
    const { kv } = makeKv({
      ...archivedState(archived),
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: 200, totalCount: 200, done: true, version: CAMPAIGNS_BACKFILL_CURSOR_VERSION, updatedAt: new Date(now).toISOString(),
      },
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
    const archived = [...account.campaigns.slice(100, 110), ...account.campaigns.slice(130)];
    const { kv } = makeKv({
      ...archivedState(archived),
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

describe("#9837 — rate-limit com várias lacunas (achado de self-review)", () => {
  test("429 esgotado na 1ª página encerra o laço: nenhuma 2ª listagem, lacunas restantes ficam pendentes", async () => {
    const now = T0 + 60 * DAY;
    const account = makeAccount(150, now);
    // A 2ª campanha da 1ª lacuna esgota o retry de rate-limit
    // (retryAfterSecs=0 → sem sleep real).
    const rateLimitedId = account.campaigns[101].id;
    const listings: string[] = [];
    const fetchFn = async (path: string) => {
      if (path.includes(`emailCampaigns/${rateLimitedId}?`)) throw new BrevoRateLimitError(0);
      if (path.includes("offset=")) listings.push(path);
      return account.fetchFn(path);
    };
    const { kv } = makeKv({
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: 100, totalCount: 150, done: false, gaps: [{ start: 100, end: 103 }, { start: 130, end: 150 }],
        updatedAt: new Date(now).toISOString(),
      },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await runCampaignsBackfillBatch(env, { _fetchFn: fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal(listings.length, 1, "o laço de páginas para no rate-limit — a 2ª lacuna não é listada nesta chamada");
    assert.equal(r.scanned, 2, "1ª campanha + a que bateu o 429; a 3ª nunca foi examinada");
    assert.equal(r.cursor.done, false);
    // #9852: a 101 (bateu o 429) volta pras lacunas — antes do fix o cursor
    // dava [{102,103},…] e ela ficava no índice sem stats pra sempre.
    assert.deepEqual(r.cursor.gaps, [{ start: 101, end: 103 }, { start: 130, end: 150 }]);
  });
});

describe("#9852 — campanha sem stats por 429/erro de rede volta às lacunas pendentes", () => {
  function setup(failure: () => Error, failTimes: number) {
    const now = T0 + 60 * DAY;
    const account = makeAccount(130, now);
    const failingId = account.campaigns[101].id;
    let failures = 0;
    const statsCalls: number[] = [];
    const fetchFn = async (path: string) => {
      const m = path.match(/emailCampaigns\/(\d+)\?statistics/);
      if (m) statsCalls.push(Number(m[1]));
      if (path.includes(`emailCampaigns/${failingId}?`) && failures < failTimes) {
        failures++;
        throw failure();
      }
      return account.fetchFn(path);
    };
    const { kv } = makeKv({
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: {
        offset: 100, totalCount: 130, done: false, version: CAMPAIGNS_BACKFILL_CURSOR_VERSION, gaps: [{ start: 100, end: 130 }],
        updatedAt: new Date(now).toISOString(),
      },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const run = () => runCampaignsBackfillBatch(env, { _fetchFn: fetchFn as any, nowMs: now, batchSize: 50 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    return { account, kv, failingId, statsCalls, run };
  }

  test("429 esgotado: a posição continua pendente e é relida (com stats) na chamada seguinte", async () => {
    // `withRateLimitRetry` tenta 3x; 3 falhas = 429 esgotado nesta chamada.
    const { account, kv, failingId, statsCalls, run } = setup(() => new BrevoRateLimitError(0), 3);
    const first = await run();
    assert.equal(first.cursor.done, false);
    assert.deepEqual(first.cursor.gaps, [{ start: 101, end: 130 }]);
    assert.ok((await coverageHoles(account, kv)).includes(failingId), "pré-condição: sem stats, a 101 é buraco");

    const second = await run();
    assert.equal(statsCalls.filter((id) => id === failingId).length, 4, "3 tentativas com 429 + a releitura da 2ª chamada");
    assert.equal(second.cursor.done, true);
    assert.deepEqual(await coverageHoles(account, kv), []);
  });

  test("erro de rede (fetch lança) e 5xx: posição pendente, relida na chamada seguinte", async () => {
    for (const failure of [() => new TypeError("fetch failed"), () => new BrevoUpstreamError(503, "down")]) {
      const { account, kv, failingId, run } = setup(failure, 1);
      const first = await run();
      assert.equal(first.scanned, 30, "erro de rede não interrompe o lote (só o 429 interrompe)");
      assert.deepEqual(first.cursor.gaps, [{ start: 101, end: 102 }]);
      assert.ok((await coverageHoles(account, kv)).includes(failingId));
      const second = await run();
      assert.equal(second.cursor.done, true);
      assert.deepEqual(await coverageHoles(account, kv), []);
    }
  });

  test("4xx não-transitório (404) não segura o cursor aberto pra sempre", async () => {
    const { run } = setup(() => new BrevoUpstreamError(404, "not found"), Infinity);
    assert.equal((await run()).cursor.done, true);
  });
});

describe("#9851 — cursor ANTIGO (sem `gaps`/`version`) é relido inteiro", () => {
  /** Reproduz a varredura do #8115: total medido 1x (200) e nunca
   * atualizado, cada página lida no offset ATUAL da conta. [100, 130) foi
   * arquivado, chegaram 10 campanhas, e [130, 150) foi lido já nas
   * coordenadas novas. */
  function legacyMidScan(now: number) {
    const account = makeAccount(200, now);
    const before = account.campaigns.slice(100, 130);
    account.send(10, now - 20 * DAY);
    const beforeIds = new Set(before.map((c) => c.id));
    const after = account.campaigns.slice(130, 150).filter((c) => !beforeIds.has(c.id));
    return { account, archived: [...before, ...after] };
  }

  test("cursor antigo no meio da varredura + campanhas novas durante ela — sem buraco no meio do histórico", async () => {
    const now = T0 + 60 * DAY;
    const { account, archived } = legacyMidScan(now);
    const { kv } = makeKv({
      ...archivedState(archived),
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: { offset: 150, totalCount: 200, done: false, updatedAt: new Date(now).toISOString() },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    // Pré-condição: [100, 110) (saíram da janela) e o rabo [150, 210).
    assert.equal((await coverageHoles(account, kv)).length, 70);

    const first = await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    // Deslocar o offset antigo por fresh − total (210 − 200) daria
    // [100, 110) + [160, 210) e pularia [150, 160) pra sempre.
    assert.equal(first.cursor.version, CAMPAIGNS_BACKFILL_CURSOR_VERSION);
    assert.deepEqual(first.cursor.gaps, [{ start: 120, end: 210 }]);
    for (let i = 0; i < 6; i++) {
      await runCampaignsBackfillBatch(env, { _fetchFn: account.fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    assert.deepEqual(await coverageHoles(account, kv), []);
    assert.equal((await readCampaignsBackfillCursor(env, now)).done, true);
  });

  test("cursor antigo já done com total velho — o rabo empurrado além dele é lido", async () => {
    const now = T0 + 60 * DAY;
    const { account } = legacyMidScan(now);
    // A varredura antiga deu `done` com total=200 tendo lido [100, 200) nas
    // coordenadas NOVAS: as 10 mais antigas ([200, 210)) nunca vieram.
    const { kv } = makeKv({
      ...archivedState(account.campaigns.slice(100, 200)),
      [CAMPAIGNS_BACKFILL_CURSOR_KV_KEY]: { offset: 200, totalCount: 200, done: true, updatedAt: new Date(now).toISOString() },
    });
    const env = { BREVO_API_KEY: "x", STATS_CACHE: kv } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    assert.equal((await coverageHoles(account, kv)).length, 10, "pré-condição: o rabo [200, 210)");
    let statsGets = 0;
    const fetchFn = async (path: string) => {
      if (/statistics=globalStats/.test(path)) statsGets++;
      return account.fetchFn(path);
    };
    for (let i = 0; i < 6; i++) {
      await runCampaignsBackfillBatch(env, { _fetchFn: fetchFn as any, nowMs: now, batchSize: 20 }); // eslint-disable-line @typescript-eslint/no-explicit-any
    }
    assert.deepEqual(await coverageHoles(account, kv), []);
    assert.equal(statsGets, 10, "reler o que já tem `stats:{id}` custa só listagem");
    assert.equal((await readCampaignsBackfillCursor(env, now)).done, true);
  });

  test("backfillGapsFromCursor: antigo (offset/resumeAt/done) vira [LIMIT, total); versionado não muda", () => {
    const L = CAMPAIGNS_FETCH_LIMIT;
    const v = CAMPAIGNS_BACKFILL_CURSOR_VERSION;
    assert.deepEqual(backfillGapsFromCursor({ offset: 150, totalCount: 200, done: false, updatedAt: "x" }), [{ start: L, end: 200 }]);
    assert.deepEqual(
      backfillGapsFromCursor({ offset: 110, totalCount: 200, done: false, resumeAt: 130, updatedAt: "x" }),
      [{ start: L, end: 200 }],
    );
    assert.deepEqual(backfillGapsFromCursor({ offset: 200, totalCount: 200, done: true, updatedAt: "x" }), [{ start: L, end: 200 }]);
    assert.deepEqual(backfillGapsFromCursor({ offset: 200, totalCount: 200, done: true, version: v, updatedAt: "x" }), []);
    assert.deepEqual(
      backfillGapsFromCursor({ offset: 150, totalCount: 200, done: false, version: v, updatedAt: "x" }),
      [{ start: 150, end: 200 }],
    );
    // `gaps` sem `version` (gravado pelo #9850) já está nas coordenadas certas.
    assert.deepEqual(
      backfillGapsFromCursor({ offset: 150, totalCount: 200, done: false, gaps: [{ start: 150, end: 160 }], updatedAt: "x" }),
      [{ start: 150, end: 160 }],
    );
  });

  test("normalizeCampaignsBackfillCursor preserva `version`", () => {
    const c = normalizeCampaignsBackfillCursor({ offset: 100, totalCount: 5, done: true, version: 2, updatedAt: "x" });
    assert.equal(c?.version, 2);
  });
});

describe("#9837 — backfillScannedFrontier (pura, achado de self-review)", () => {
  test("done reaberto: lacuna pequena perto da janela não puxa o N pra 100", () => {
    assert.equal(
      backfillScannedFrontier({ offset: 100, totalCount: 400, done: false, gaps: [{ start: 100, end: 103 }], updatedAt: "x" }),
      400,
    );
  });

  test("varredura em curso: N é o início da lacuna do rabo", () => {
    assert.equal(
      backfillScannedFrontier({
        offset: 100, totalCount: 400, done: false, gaps: [{ start: 100, end: 103 }, { start: 250, end: 400 }], updatedAt: "x",
      }),
      250,
    );
  });

  test("cursor legado (só offset) e cursor default mantêm o offset", () => {
    assert.equal(backfillScannedFrontier({ offset: 130, totalCount: 500, done: false, updatedAt: "x" }), 130);
    assert.equal(backfillScannedFrontier({ offset: 100, totalCount: null, done: false, updatedAt: "x" }), 100);
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
