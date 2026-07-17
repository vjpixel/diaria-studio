/**
 * test/diaria-dashboard-studio-snapshot-3565.test.ts (#3565)
 *
 * Cobre a rota NOVA do worker `diaria-dashboard` — espelho read-only do
 * Studio local:
 *   - renderStudioSnapshotHtml: sem dado (KV vazio), snapshot fresco, e
 *     snapshot velho ("PC offline?"); PURO READ-ONLY (nenhum <button>/<form>
 *     de ação — aceite #2 da issue "Zero ações no modo espelho").
 *   - GET /api/studio-snapshot: JSON cru do KV (200 com dado, 404 sem dado).
 *   - GET /studio: HTML renderizado a partir do MESMO KV (200 sempre — com
 *     dado ou com a mensagem "não inicializado").
 *
 * Mock de KV + polyfill de `caches` no mesmo padrão de test/dashboard-auth.test.ts
 * (o fetch handler acessa `caches.default` incondicionalmente antes de
 * rotear, mesmo pras rotas novas que não usam cache de borda).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { Env, StudioSnapshot } from "../workers/diaria-dashboard/src/types.ts";
import { STUDIO_SNAPSHOT_KV_KEY } from "../scripts/studio-snapshot-push.ts";

// Import dinâmico (mesmo padrão do resto da suíte de diaria-dashboard, ver
// test/diaria-dashboard-tab-saude-3075.test.ts: o package.json do worker não
// declara "type": "module", então `node --import tsx` faz interop CJS/ESM
// nesse arquivo de forma peculiar). A maioria dos testes abaixo chama os
// handlers NOMEADOS (handleStudioSnapshotJson/Html) diretamente — mais
// simples e evita depender da forma exata do default export. O teste de
// ROTEAMENTO no fim do arquivo ainda quer exercitar o dispatcher real
// (`default.fetch`); sob esse interop específico o objeto `{fetch}` do
// worker aparece aninhado em `mod.default.default` (não `mod.default`) —
// resolvido de forma tolerante abaixo em vez de hardcodar o nível de
// aninhamento (que já variou entre node/tsx versions neste repo).
const mod = await import("../workers/diaria-dashboard/src/index.ts");
const { renderStudioSnapshotHtml, handleStudioSnapshotJson, handleStudioSnapshotHtml } = mod;

/** Resolve o objeto `{fetch}` do default export tolerando o nível de
 * aninhamento do interop CJS/ESM (varia — às vezes `mod.default`, às vezes
 * `mod.default.default`, ver comentário acima). */
function resolveWorker(m: Record<string, unknown>): { fetch: (req: Request, env: Env) => Promise<Response> } {
  const level1 = m.default as { fetch?: unknown; default?: unknown } | undefined;
  if (level1 && typeof level1.fetch === "function") {
    return level1 as { fetch: (req: Request, env: Env) => Promise<Response> };
  }
  const level2 = level1?.default as { fetch?: unknown } | undefined;
  if (level2 && typeof level2.fetch === "function") {
    return level2 as { fetch: (req: Request, env: Env) => Promise<Response> };
  }
  throw new Error("resolveWorker: não achou {fetch} nem em mod.default nem em mod.default.default");
}
const worker = resolveWorker(mod);

// Polyfill de Cache API (mesmo padrão de dashboard-auth.test.ts) — o fetch
// handler chama `caches.default` incondicionalmente antes de rotear.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let origCaches: any;
before(() => {
  origCaches = (globalThis as unknown as { caches?: unknown }).caches;
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: async () => null,
      put: async () => {},
    },
  };
});
after(() => {
  (globalThis as unknown as { caches: unknown }).caches = origCaches;
});

function makeSnapshot(overrides: Partial<StudioSnapshot> = {}): StudioSnapshot {
  return {
    generated_at: new Date().toISOString(),
    current_edition: "260716",
    current_stage: 4,
    stage_label: "Revisão",
    gates_pending_count: 2,
    chat_gates_pending_count: 1,
    overnight: { sessionId: "260715", totalIssues: 5, counts: { merged: 3, draft: 1, pulada: 1 } },
    develop: null,
    ...overrides,
  };
}

function makeEnv(kvValue: string | null): Env {
  return {
    DASHBOARD_DATA: {
      get: async (key: string) => (key === STUDIO_SNAPSHOT_KV_KEY ? kvValue : null),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// ─── renderStudioSnapshotHtml ─────────────────────────────────────────────────

describe("renderStudioSnapshotHtml (#3565)", () => {
  it("snapshot null → mensagem 'não inicializado', sem lançar", () => {
    const html = renderStudioSnapshotHtml(null);
    assert.match(html, /não inicializado/);
    assert.match(html, /<html/);
  });

  it("snapshot fresco (idade < 10min) → banner verde, sem aviso de offline", () => {
    const now = new Date("2026-07-16T12:10:00.000Z");
    const snapshot = makeSnapshot({ generated_at: "2026-07-16T12:05:00.000Z" }); // 5min atrás
    const html = renderStudioSnapshotHtml(snapshot, now);
    assert.doesNotMatch(html, /PC offline/);
    assert.match(html, /260716/);
    assert.match(html, /Revisão/);
  });

  it("snapshot velho (idade > 10min) → aviso 'PC offline?' visível", () => {
    const now = new Date("2026-07-16T13:00:00.000Z");
    const snapshot = makeSnapshot({ generated_at: "2026-07-16T12:00:00.000Z" }); // 60min atrás
    const html = renderStudioSnapshotHtml(snapshot, now);
    assert.match(html, /PC offline/);
    assert.match(html, /há 60min/);
  });

  it("timestamp do snapshot está sempre presente no HTML (bem visível — aceite #1)", () => {
    const snapshot = makeSnapshot({ generated_at: "2026-07-16T12:00:00.000Z" });
    const html = renderStudioSnapshotHtml(snapshot, new Date("2026-07-16T12:01:00.000Z"));
    // fmtTimeBRT formata em pt-BR — só garante que ALGUM rótulo de horário aparece.
    assert.match(html, /Dados de/);
  });

  it("PURO READ-ONLY — nenhum <button> ou <form> de ação (aceite #2: zero ações no modo espelho)", () => {
    const html = renderStudioSnapshotHtml(makeSnapshot());
    assert.doesNotMatch(html, /<button/i);
    assert.doesNotMatch(html, /<form/i);
    // Nenhum atributo de mutação HTTP (a página é 100% estática/read-only).
    assert.doesNotMatch(html, /method=["']?(post|put|delete)/i);
  });

  it("resumo overnight/develop mostra contagens, não issues individuais", () => {
    const html = renderStudioSnapshotHtml(
      makeSnapshot({
        overnight: { sessionId: "260715", totalIssues: 7, counts: { merged: 4, draft: 2, pulada: 1 } },
      }),
    );
    assert.match(html, /7 issues/);
    assert.match(html, /4 merged/);
    assert.doesNotMatch(html, /<li/i); // não lista item-a-item
  });
});

// ─── handleStudioSnapshotJson (GET /api/studio-snapshot) ──────────────────────

describe("handleStudioSnapshotJson — GET /api/studio-snapshot (#3565)", () => {
  it("200 com o JSON cru do snapshot quando o KV tem dado", async () => {
    const snapshot = makeSnapshot();
    const env = makeEnv(JSON.stringify(snapshot));
    const res = await handleStudioSnapshotJson(env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/json");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const body = (await res.json()) as StudioSnapshot;
    assert.equal(body.current_edition, "260716");
  });

  it("404 com error=no_data quando o KV está vazio", async () => {
    const env = makeEnv(null);
    const res = await handleStudioSnapshotJson(env);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "no_data");
  });

  it("KV com JSON malformado → tratado como ausente (404), não lança", async () => {
    const env = makeEnv("{ isso não é json válido");
    const res = await handleStudioSnapshotJson(env);
    assert.equal(res.status, 404);
  });
});

// ─── handleStudioSnapshotHtml (GET /studio) ────────────────────────────────────

describe("handleStudioSnapshotHtml — GET /studio (#3565)", () => {
  it("200 HTML com o snapshot quando o KV tem dado", async () => {
    const env = makeEnv(JSON.stringify(makeSnapshot()));
    const res = await handleStudioSnapshotHtml(env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    const html = await res.text();
    assert.match(html, /260716/);
  });

  it("200 HTML 'não inicializado' quando o KV está vazio (nunca 500)", async () => {
    const env = makeEnv(null);
    const res = await handleStudioSnapshotHtml(env);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /não inicializado/);
  });

  it("não colide com a chave 'dashboard' existente (namespaces de chave isolados)", async () => {
    // KV mock que só responde à chave "dashboard" (payload do dashboard
    // normal) — /studio não deve acidentalmente renderizar esses dados.
    const env: Env = {
      DASHBOARD_DATA: {
        get: async (key: string) => (key === "dashboard" ? JSON.stringify({ fake: "dashboard-data" }) : null),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    };
    const res = await handleStudioSnapshotHtml(env);
    const html = await res.text();
    assert.match(html, /não inicializado/);
    assert.doesNotMatch(html, /fake/);
  });
});

// ─── Roteamento no fetch handler real (path → handler) ────────────────────────

describe("default.fetch — roteamento (#3565)", () => {
  it("GET /api/studio-snapshot despacha pro handler JSON", async () => {
    const env = makeEnv(JSON.stringify(makeSnapshot()));
    const res = await worker.fetch(new Request("https://x/api/studio-snapshot"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "application/json");
  });

  it("GET /studio despacha pro handler HTML", async () => {
    const env = makeEnv(JSON.stringify(makeSnapshot()));
    const res = await worker.fetch(new Request("https://x/studio"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
  });

  it("GET /studio/ (barra final) roteia pro mesmo painel HTML", async () => {
    const env = makeEnv(JSON.stringify(makeSnapshot()));
    const res = await worker.fetch(new Request("https://x/studio/"), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
  });

  it("não regride a rota /api/data existente (continua indo pro handler ORIGINAL, não pro novo)", async () => {
    const env = makeEnv(null); // mock só responde a STUDIO_SNAPSHOT_KV_KEY; "dashboard" sempre null aqui
    const res = await worker.fetch(new Request("https://x/api/data"), env);
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: string; hint?: string };
    assert.equal(body.error, "no_data");
    // hint do handler ORIGINAL de /api/data (distinto do hint do handler novo,
    // que menciona studio-snapshot-push.ts) — prova que a rota pré-existente
    // não foi acidentalmente capturada pelas novas.
    assert.match(body.hint ?? "", /build-diaria-dashboard-data/);
  });
});
