/**
 * backup-beehiiv.test.ts (#1742)
 *
 * Cobre os helpers puros do backup full do Beehiiv: enumeração de endpoints
 * (garante que o escopo declarado na issue está coberto), sumarização do
 * manifest e helpers de path/data. Sem rede — a parte de IO/fetch é exercida
 * manualmente via `--dry-run` / `--posts-limit`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  publicationEndpoints,
  summarizeManifest,
  backupDir,
  isoDate,
  resolveTotalPages,
  hasMorePages,
  backupBeehiiv,
  MCP_ONLY_GAPS,
  type ManifestEntry,
} from "../scripts/backup-beehiiv.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("publicationEndpoints (#1742)", () => {
  const eps = publicationEndpoints("pub_123");

  it("inclui as categorias do escopo da issue", () => {
    const keys = new Set(eps.map((e) => e.key));
    for (const required of ["publication", "custom_fields", "segments", "automations", "tiers", "referral_program"]) {
      assert.ok(keys.has(required), `falta endpoint: ${required}`);
    }
  });

  it("embute o publicationId em todos os paths", () => {
    for (const e of eps) {
      assert.ok(e.path.includes("pub_123"), `${e.key} não tem pubId: ${e.path}`);
    }
  });

  it("custom_fields é paginado e não-opcional (poll_sig é crítico)", () => {
    const cf = eps.find((e) => e.key === "custom_fields")!;
    assert.equal(cf.paginated, true);
    assert.notEqual(cf.optional, true);
  });

  it("endpoints de plano-dependente são opcionais (404 tolerado)", () => {
    for (const key of ["automations", "email_blasts", "tiers", "referral_program"]) {
      const ep = eps.find((e) => e.key === key)!;
      assert.equal(ep.optional, true, `${key} deveria ser optional`);
    }
  });

  it("publication expande stats", () => {
    const pub = eps.find((e) => e.key === "publication")!;
    assert.ok(pub.path.includes("expand[]=stats"));
  });
});

describe("summarizeManifest (#1742)", () => {
  const endpoints: ManifestEntry[] = [
    { key: "publication", file: "publication.json", status: "ok", count: 1 },
    { key: "custom_fields", file: "custom-fields.json", status: "ok", count: 3 },
    { key: "automations", file: "automations.json", status: "skipped" },
    { key: "email_blasts", file: "email-blasts.json", status: "error", error: "boom" },
  ];
  const m = summarizeManifest({
    generatedAt: "2026-06-03T00:00:00.000Z",
    publicationId: "pub_123",
    apiBase: "https://api.beehiiv.com/v2",
    options: { subscribers: true, content: true, posts_limit: null, dry_run: false },
    endpoints,
    posts: { fetched: 10, errors: 1 },
    subscribers: { fetched: 4200 },
  });

  it("conta totals por status", () => {
    assert.deepEqual(m.totals, { ok: 2, skipped: 1, error: 1 });
  });

  it("preserva contagens de posts e subscribers", () => {
    assert.equal(m.posts.fetched, 10);
    assert.equal(m.posts.errors, 1);
    assert.equal(m.subscribers?.fetched, 4200);
  });

  it("sinaliza os gaps MCP-only pra não dar falsa sensação de exaustivo", () => {
    assert.deepEqual(m.mcp_only_gaps, MCP_ONLY_GAPS);
    assert.ok(m.mcp_only_gaps.length >= 2);
  });

  it("carimba api_base e generated_at", () => {
    assert.equal(m.api_base, "https://api.beehiiv.com/v2");
    assert.equal(m.generated_at, "2026-06-03T00:00:00.000Z");
  });
});

describe("resolveTotalPages (#1742) — anti-truncamento silencioso", () => {
  it("respeita total_pages quando presente e > 0", () => {
    assert.equal(resolveTotalPages(100, 5, 1, 100), 5);
    assert.equal(resolveTotalPages(0, 3, 2, 100), 3);
  });

  it("estende quando total_pages ausente mas a página veio cheia (mais dados)", () => {
    // Bug original: `total_pages ?? 1` pastartia em 1 e gravava só 100 subscribers.
    assert.equal(resolveTotalPages(100, undefined, 1, 100), 2);
    assert.equal(resolveTotalPages(100, undefined, 7, 100), 8);
  });

  it("estende quando total_pages é 0 (envelope com bug) e página cheia", () => {
    assert.equal(resolveTotalPages(100, 0, 1, 100), 2);
  });

  it("para na página atual quando veio incompleta (fim real)", () => {
    assert.equal(resolveTotalPages(42, undefined, 3, 100), 3);
    assert.equal(resolveTotalPages(0, undefined, 1, 100), 1);
  });
});

describe("hasMorePages (#1897) — drena por total_results, robusto a per_page ignorado", () => {
  it("para imediatamente em página vazia (guard anti-loop-infinito)", () => {
    assert.equal(hasMorePages({ collected: 0, gotLength: 0, totalResults: 1253, requestedPerPage: 100 }), false);
    assert.equal(hasMorePages({ collected: 1253, gotLength: 0, totalResults: 1253, requestedPerPage: 100 }), false);
  });

  it("drena até total_results, ignorando total_pages inflado", () => {
    // Bug #1897: API responde limit=10 mesmo com per_page=100. Mesmo que cada
    // página venha "incompleta" vs o per_page pedido, total_results manda continuar.
    assert.equal(hasMorePages({ collected: 10, gotLength: 10, totalResults: 1253, effectiveLimit: 10, requestedPerPage: 100 }), true);
    assert.equal(hasMorePages({ collected: 1200, gotLength: 100, totalResults: 1253, effectiveLimit: 100, requestedPerPage: 100 }), true);
  });

  it("para quando collected alcança total_results (não estoura o offset cap)", () => {
    assert.equal(hasMorePages({ collected: 1253, gotLength: 53, totalResults: 1253, effectiveLimit: 100, requestedPerPage: 100 }), false);
    assert.equal(hasMorePages({ collected: 1300, gotLength: 100, totalResults: 1253, effectiveLimit: 100, requestedPerPage: 100 }), false);
  });

  it("sem total_results, usa o limit REAL do envelope pra heurística de página cheia", () => {
    // API ignorou per_page=100 e devolveu limit=10: página de 10 está "cheia" → há mais.
    assert.equal(hasMorePages({ collected: 10, gotLength: 10, effectiveLimit: 10, requestedPerPage: 100 }), true);
    // página de 7 com limit real 10 → fim.
    assert.equal(hasMorePages({ collected: 47, gotLength: 7, effectiveLimit: 10, requestedPerPage: 100 }), false);
  });

  it("sem total_results nem limit do envelope, cai no per_page pedido", () => {
    assert.equal(hasMorePages({ collected: 100, gotLength: 100, requestedPerPage: 100 }), true);
    assert.equal(hasMorePages({ collected: 42, gotLength: 42, requestedPerPage: 100 }), false);
  });
});

describe("backupBeehiiv subscribers (#1897) — usa limit, drena base inteira", () => {
  let saved: typeof globalThis.fetch;
  const outDir = resolve(HERE, "_tmp_backup_beehiiv_1897");
  // Flags pra provar que a request usa `limit=` (respeitado) e nunca `per_page=`
  // (ignorado pela Beehiiv em /subscriptions).
  let sawLimit = false;
  let sawPerPage = false;
  let maxPage = 0;
  let subRequests = 0;

  // Parâmetros do mock, ajustados por teste.
  // `reportedTotal`: o que o envelope diz em `total_results`.
  // `available`: quantas linhas REALMENTE existem (offset além disso → página vazia,
  //   pra simular truncamento). Por padrão = reportedTotal (base coerente).
  // `PAGE_CAP`: o cap REAL da Beehiiv é por NÚMERO DE PÁGINA (~100), não por offset
  //   de registro — confirmado no dado real (limit=100 drenou 1253/1253, offsets
  //   até 1200, sem cap; o run antigo morreu "na página 101" com limit=10).
  let reportedTotal = 1253;
  let available = 1253;
  const PAGE_CAP = 100;

  beforeEach(() => {
    saved = globalThis.fetch;
    sawLimit = false;
    sawPerPage = false;
    maxPage = 0;
    subRequests = 0;
    reportedTotal = 1253;
    available = 1253;
    rmSync(outDir, { recursive: true, force: true });
  });
  afterEach(() => {
    globalThis.fetch = saved;
    rmSync(outDir, { recursive: true, force: true });
  });

  function mockFetch(url: string): Response {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.includes("/subscriptions")) {
      subRequests++;
      const limitMatch = url.match(/[?&]limit=(\d+)/);
      const perPageMatch = url.match(/[?&]per_page=(\d+)/);
      if (limitMatch) sawLimit = true;
      if (perPageMatch) sawPerPage = true;
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? "1");
      maxPage = Math.max(maxPage, page);
      // Beehiiv respeita `limit`; se só vier `per_page`, IGNORA (cap default 10).
      const effLimit = limitMatch ? Number(limitMatch[1]) : 10;
      // Cap REAL por número de página: estoura → HTTP 400 (o sintoma do #1897 no
      // run antigo com limit=10, que precisava de ~126 páginas).
      if (page > PAGE_CAP) return json({ error: "page cap" }, 400);
      const start = (page - 1) * effLimit;
      const slice = Array.from({ length: Math.max(0, Math.min(effLimit, available - start)) }, (_, i) => ({
        id: `sub_${start + i}`,
        email: `s${start + i}@example.com`,
      }));
      return json({
        data: slice,
        page,
        limit: effLimit,
        total_results: reportedTotal,
        total_pages: Math.ceil(reportedTotal / effLimit),
      });
    }
    // posts list
    if (/\/posts(\?|$)/.test(url)) return json({ data: [], total_pages: 1 });
    // publication (não-paginado) + referral_program (não-paginado, opcional)
    if (url.includes("referral_program")) return json({ data: {} });
    if (/\/publications\/[^/]+\?/.test(url) && url.includes("expand")) return json({ data: { id: "pub_test" } });
    // demais endpoints paginados (custom_fields, segments, automations, ...)
    return json({ data: [], total_pages: 1 });
  }

  function installMock() {
    globalThis.fetch = (async (input: string | URL | Request) =>
      mockFetch(typeof input === "string" ? input : input.toString())) as typeof fetch;
  }

  const baseOpts = {
    outDir,
    subscribers: true,
    content: false,
    postsLimit: null,
    dryRun: false,
    configOverride: { apiKey: "test-key", publicationId: "pub_test" },
  } as const;

  it("usa limit= e drena os 1253 subscribers em ~13 páginas, sem bater no page cap", async () => {
    // Base > offset antigo (1253) com cap por-página em 100. O código ANTIGO
    // (per_page ignorado → limit efetivo 10) precisaria de 126 páginas e morreria
    // na página 101 (HTTP 400). O novo (limit=100) drena em 13 páginas. Esta é a
    // asserção que de fato distingue o fix do bug (#633).
    installMock();
    const manifest = await backupBeehiiv({ ...baseOpts, date: "2026-06-05" });

    assert.equal(sawLimit, true, "deve paginar /subscriptions com limit=");
    assert.equal(sawPerPage, false, "nunca deve usar per_page= em /subscriptions (é ignorado)");
    assert.equal(subRequests, Math.ceil(1253 / 100), "limit=100 → 13 requests (não ~126 do per_page ignorado)");
    assert.ok(maxPage <= PAGE_CAP, `não deve cruzar o page cap (${PAGE_CAP}); chegou a ${maxPage}`);

    const subsEntry = manifest.endpoints.find((e) => e.key === "subscribers")!;
    assert.equal(subsEntry.status, "ok");
    assert.equal(subsEntry.count, 1253);
    assert.equal(manifest.subscribers?.fetched, 1253);

    const lines = readFileSync(resolve(outDir, "subscribers.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1253, "subscribers.jsonl deve ter 1 linha por subscriber");
    assert.ok(!existsSync(resolve(outDir, "subscribers.jsonl.partial")), "não deixa .partial órfão");
  });

  it("marca status error (não ok) quando o loop encerra antes de drenar total_results", async () => {
    // Simula hiccup: API informa total_results=300 mas só entrega 150 linhas
    // (página vazia em offset ≥ 150). A reconciliação anti-truncamento-silencioso
    // deve falhar barulhento em vez de gravar um backup parcial como "ok" (#1897).
    reportedTotal = 300;
    available = 150;
    installMock();
    const manifest = await backupBeehiiv({ ...baseOpts, date: "2026-06-05" });

    const subsEntry = manifest.endpoints.find((e) => e.key === "subscribers")!;
    assert.equal(subsEntry.status, "error", "truncamento não pode ser gravado como ok");
    assert.match(subsEntry.error ?? "", /truncado: 150\/300/);
    assert.notEqual(manifest.subscribers?.fetched, 150, "não conta a base truncada como completa");
    // .jsonl não é gerado (renameSync pulado); só o .partial sobra como sinal.
    assert.ok(!existsSync(resolve(outDir, "subscribers.jsonl")), "não grava .jsonl truncado");
    assert.ok(existsSync(resolve(outDir, "subscribers.jsonl.partial")), "preserva .partial como sinal");
  });
});

describe("path/date helpers (#1742)", () => {
  it("backupDir aninha a data sob o root", () => {
    const d = backupDir("/tmp/bk", "2026-06-03");
    assert.ok(d.replaceAll("\\", "/").endsWith("/tmp/bk/2026-06-03".replace("/tmp", "/tmp")));
    assert.ok(d.includes("2026-06-03"));
  });

  it("isoDate formata YYYY-MM-DD em UTC", () => {
    assert.equal(isoDate(new Date("2026-06-03T14:25:00.000Z")), "2026-06-03");
    assert.equal(isoDate(new Date("2026-12-31T23:59:59.000Z")), "2026-12-31");
  });
});
