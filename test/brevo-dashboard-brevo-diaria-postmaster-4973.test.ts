/**
 * test/brevo-dashboard-brevo-diaria-postmaster-4973.test.ts (#4973)
 *
 * A aba `brevo_diaria` (#4515) ganha a leitura do Google Postmaster Tools pro
 * domínio `diar.ia.br` (produzida por `scripts/postmaster-spam-sync.ts`,
 * generalizado pra N domínios no mesmo #4973 — ver
 * `test/postmaster-spam-sync.test.ts`). Este arquivo cobre o lado
 * CONSUMIDOR (dashboard):
 *
 *   1. `renderBrevoDiariaPostmasterSpam` — função pura que decide o texto do
 *      painel: leitura presente vs. "aguardando publicação" (NUNCA célula
 *      vazia, mesmo padrão de estado explícito do #4970).
 *   2. `fetchBrevoDiariaTabData` — a leitura do KV é buscada INDEPENDENTE do
 *      resultado do fetch de campanhas da Brevo (sucesso, stale, erro).
 *   3. `renderBrevoDiariaTabPanel` — integração ponta a ponta: o painel
 *      aparece na aba renderizada nos 2 estados.
 *
 * Nenhuma chamada à API Postmaster real — leituras vêm de fixtures diretas
 * no KV mock (mesmo padrão de `makeKVMock` do #4515).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  renderBrevoDiariaPostmasterSpam,
  fetchBrevoDiariaTabData,
  renderBrevoDiariaTabPanel,
  BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY,
  BREVO_DIARIA_POSTMASTER_DOMAIN,
  type BrevoDiariaTabData,
} from "../workers/brevo-dashboard/src/index.ts";
import { additionalPostmasterSpamKvKey } from "../scripts/lib/dashboard-kv-types.ts";
import { POSTMASTER_SPAM_KV_KEY } from "../scripts/postmaster-spam-entry.ts";
import type { PostmasterSpamEntry } from "../scripts/lib/dashboard-kv-types.ts";

function makeKVMock(initialData: Record<string, string> = {}) {
  const store = new Map(Object.entries(initialData));
  return {
    kv: {
      get: async (key: string, type?: string) => {
        const val = store.get(key);
        if (val === undefined) return null;
        if (type === "json") return JSON.parse(val);
        return val;
      },
      put: async (key: string, value: string) => { store.set(key, value); },
      delete: async () => {},
      list: async () => ({ keys: [], cursor: "", list_complete: true }),
      getWithMetadata: async () => ({ value: null, metadata: null }),
    } as unknown as KVNamespace,
  };
}

function mkEntry(overrides: Partial<PostmasterSpamEntry> = {}): PostmasterSpamEntry {
  return {
    date: "2026-08-06",
    spamRatePct: 0,
    recordedAt: "2026-08-06T12:30:00.000Z",
    producedBy: "auto",
    daysWithData: 3,
    daysProbed: 21,
    ...overrides,
  };
}

// ─── chave KV — fonte única com o produtor ───────────────────────────────────

test("BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY — mesma função/valor que o produtor usa pra diar.ia.br, nunca a chave legada de clarice.ai (#4973)", () => {
  assert.equal(BREVO_DIARIA_POSTMASTER_DOMAIN, "diar.ia.br");
  assert.equal(BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY, additionalPostmasterSpamKvKey("diar.ia.br"));
  assert.notEqual(BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY, POSTMASTER_SPAM_KV_KEY);
});

// ─── renderBrevoDiariaPostmasterSpam ──────────────────────────────────────────

describe("renderBrevoDiariaPostmasterSpam (#4973)", () => {
  test("entry null → 'aguardando publicação' explícito, nunca string vazia/omitida", () => {
    const html = renderBrevoDiariaPostmasterSpam(null);
    assert.ok(html.includes("aguardando publicação"));
    assert.ok(html.includes("diar.ia.br"));
    assert.notEqual(html.trim(), "");
  });

  test("entry undefined (schema pré-#4973 / literal de teste sem o campo) tratado igual a null", () => {
    const html = renderBrevoDiariaPostmasterSpam(undefined);
    assert.ok(html.includes("aguardando publicação"));
  });

  test("entry presente → mostra o spamRatePct e a cobertura, sem 'aguardando publicação'", () => {
    const html = renderBrevoDiariaPostmasterSpam(mkEntry({ spamRatePct: 0.137, date: "2026-08-03", daysWithData: 3, daysProbed: 21 }));
    assert.ok(html.includes("0.137%"));
    assert.ok(html.includes("2026-08-03"));
    assert.ok(html.includes("3/21"));
    assert.ok(!html.includes("aguardando publicação"));
  });

  test("entry presente sem daysWithData/daysProbed (entry manual, #4063) não lança e omite a cobertura", () => {
    const html = renderBrevoDiariaPostmasterSpam(mkEntry({ daysWithData: undefined, daysProbed: undefined }));
    assert.ok(html.includes("%"));
    assert.ok(!html.includes("undefined"));
  });
});

// ─── fetchBrevoDiariaTabData — leitura do Postmaster é independente do fetch de campanhas ───

describe("fetchBrevoDiariaTabData — postmasterSpam (#4973)", () => {
  test("sucesso no fetch de campanhas + KV com leitura do Postmaster → postmasterSpam populado", async () => {
    const entry = mkEntry({ spamRatePct: 0.2 });
    const { kv } = makeKVMock({ [BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY]: JSON.stringify(entry) });
    const mockFetch = async <T>(path: string): Promise<T> => {
      if (path.includes("emailCampaigns?status=sent")) return { campaigns: [] } as T;
      throw new Error("path inesperado: " + path);
    };
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, false, mockFetch as any);
    assert.ok(result !== null);
    assert.equal(result!.postmasterSpam?.spamRatePct, 0.2);
  });

  test("KV sem a chave (cobertura rala / 1ª execução antes do sync) → postmasterSpam:null, nunca lança", async () => {
    const { kv } = makeKVMock();
    const mockFetch = async <T>(): Promise<T> => ({ campaigns: [] }) as T;
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, false, mockFetch as any);
    assert.ok(result !== null);
    assert.equal(result!.postmasterSpam, null);
  });

  test("fetch de campanhas FALHA (sem stale) → postmasterSpam ainda populado a partir do KV (independente da falha da Brevo)", async () => {
    const entry = mkEntry({ spamRatePct: 0.05 });
    const { kv } = makeKVMock({ [BREVO_DIARIA_POSTMASTER_SPAM_KV_KEY]: JSON.stringify(entry) });
    const mockFetch = async <T>(): Promise<T> => {
      throw new Error("network error simulado");
    };
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: kv }, false, mockFetch as any);
    assert.ok(result !== null);
    assert.deepEqual(result!.campaigns, []);
    assert.ok(result!.error?.includes("network error simulado"));
    assert.equal(result!.postmasterSpam?.spamRatePct, 0.05, "leitura do Postmaster não depende do sucesso do fetch Brevo");
  });

  test("sem STATS_CACHE → postmasterSpam:null (fail-soft, sem lançar)", async () => {
    const mockFetch = async <T>(): Promise<T> => ({ campaigns: [] }) as T;
    const result = await fetchBrevoDiariaTabData({ BREVO_DIARIA_API_KEY: "k", STATS_CACHE: undefined }, false, mockFetch as any);
    assert.ok(result !== null);
    assert.equal(result!.postmasterSpam, null);
  });
});

// ─── renderBrevoDiariaTabPanel — integração ponta a ponta ────────────────────

describe("renderBrevoDiariaTabPanel — painel do Postmaster integrado (#4973)", () => {
  test("data.postmasterSpam ausente (literal de teste pré-#4973) → painel mostra 'aguardando publicação', não quebra o render existente", () => {
    const data: BrevoDiariaTabData = { campaigns: [], generatedAt: new Date().toISOString() };
    const html = renderBrevoDiariaTabPanel(data);
    assert.ok(html.includes("aguardando publicação"));
  });

  test("data.postmasterSpam presente → painel mostra a leitura dentro da aba", () => {
    const data: BrevoDiariaTabData = {
      campaigns: [],
      generatedAt: new Date().toISOString(),
      postmasterSpam: mkEntry({ spamRatePct: 0.137, date: "2026-08-03" }),
    };
    const html = renderBrevoDiariaTabPanel(data);
    assert.ok(html.includes("0.137%"));
    assert.ok(!html.includes("aguardando publicação"));
  });
});
