/**
 * Tests for scripts/refresh-dedup.ts (#895 — substitui subagente refresh-dedup-runner).
 *
 * Foco principal — regression de #162: o MD `context/past-editions.md`
 * **deve sempre ser regenerado**, mesmo quando 0 novos posts são detectados
 * no Beehiiv. Isso cobre o caso de `git pull` ter resetado o tracked file
 * enquanto o raw (gitignored) ficou intacto.
 *
 * Estratégia: importa `refreshDedup` direto, injeta paths de sandbox via
 * opts, e mocka `globalThis.fetch` pra responder Beehiiv API. Sem
 * subprocess, sem network — testa a lógica end-to-end do script.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  refreshDedup,
  type RefreshConfig,
} from "../scripts/refresh-dedup.ts";

interface BeehiivPostFixture {
  id: string;
  title?: string;
  publish_date?: number;
  status?: string;
  web_url?: string;
}

function makeMockFetch(opts: {
  posts: BeehiivPostFixture[];
  contentByPostId: Record<string, string>;
}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const u = new URL(url);
    const path = u.pathname;
    if (/\/posts$/.test(path)) {
      const page = parseInt(u.searchParams.get("page") ?? "1", 10);
      const perPage = parseInt(u.searchParams.get("per_page") ?? "50", 10);
      const slice = opts.posts.slice((page - 1) * perPage, page * perPage).map((p) => ({
        status: "confirmed",
        ...p,
      }));
      return new Response(
        JSON.stringify({
          data: slice,
          page,
          total_results: opts.posts.length,
          total_pages: Math.max(1, Math.ceil(opts.posts.length / perPage)),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const m = /\/posts\/([^\/]+)$/.exec(path);
    if (m) {
      const postId = decodeURIComponent(m[1]);
      const post = opts.posts.find((p) => p.id === postId);
      if (!post) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          data: {
            ...post,
            status: post.status ?? "confirmed",
            html: opts.contentByPostId[postId] ?? "<p>no html</p>",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

const TEST_CONFIG: RefreshConfig = {
  apiKey: "test-key",
  publicationId: "pub_test",
  dedupEditionCount: 14,
};

describe("refresh-dedup.ts (#895)", () => {
  let sandboxRoot: string;
  let originalFetch: typeof globalThis.fetch;

  before(() => {
    originalFetch = globalThis.fetch;
    sandboxRoot = mkdtempSync(join(tmpdir(), "refresh-dedup-"));
  });

  after(() => {
    globalThis.fetch = originalFetch;
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("incremental com 0 novos posts AINDA regenera o MD (#162 regression / #895)", async () => {
    const rawPath = join(sandboxRoot, "test1-past-editions-raw.json");
    const mdPath = join(sandboxRoot, "test1-past-editions.md");

    const existing = [
      {
        id: "post_known",
        title: "Edição conhecida",
        web_url: "https://diaria.beehiiv.com/p/conhecida",
        published_at: "2026-05-06T12:00:00Z",
        links: ["https://example.com/known"],
      },
    ];
    writeFileSync(rawPath, JSON.stringify(existing), "utf8");
    if (existsSync(mdPath)) rmSync(mdPath);

    // API retorna o mesmo post (sem novidades).
    const knownTs = Math.floor(new Date("2026-05-06T12:00:00Z").getTime() / 1000);
    globalThis.fetch = makeMockFetch({
      posts: [
        {
          id: "post_known",
          title: "Edição conhecida",
          publish_date: knownTs,
          web_url: "https://diaria.beehiiv.com/p/conhecida",
        },
      ],
      contentByPostId: {},
    });

    const result = await refreshDedup({
      dryRun: false,
      resolveTracking: false,
      rawPath,
      mdPath,
      configOverride: TEST_CONFIG,
    });

    assert.equal(result.mode, "incremental");
    assert.equal(result.new_posts, 0, "nenhum post novo (mesmo ID já no raw)");
    assert.equal(result.skipped, false, "skipped sempre false (#895)");
    assert.equal(result.md_regenerated, true);
    assert.ok(existsSync(mdPath), "MD deve ser regenerado mesmo sem novos posts");

    const md = readFileSync(mdPath, "utf8");
    assert.ok(md.includes("Edição conhecida"));
    assert.ok(md.includes("**edições carregadas:** 1"));
  });

  it("bootstrap: raw inexistente — busca posts e popula raw + MD", async () => {
    const rawPath = join(sandboxRoot, "test2-past-editions-raw.json");
    const mdPath = join(sandboxRoot, "test2-past-editions.md");
    if (existsSync(rawPath)) rmSync(rawPath);
    if (existsSync(mdPath)) rmSync(mdPath);

    const ts = Math.floor(new Date("2026-05-05T10:00:00Z").getTime() / 1000);
    globalThis.fetch = makeMockFetch({
      posts: [
        {
          id: "post_a",
          title: "Bootstrap A",
          publish_date: ts,
          web_url: "https://diaria.beehiiv.com/p/a",
        },
      ],
      contentByPostId: {
        post_a: "<p>Veja https://example.com/bootstrap-link</p>",
      },
    });

    const result = await refreshDedup({
      dryRun: false,
      resolveTracking: false,
      rawPath,
      mdPath,
      configOverride: TEST_CONFIG,
    });

    assert.equal(result.mode, "bootstrap");
    assert.equal(result.new_posts, 1);
    assert.equal(result.total_in_base, 1);
    assert.equal(result.skipped, false);
    assert.equal(result.md_regenerated, true);
    assert.ok(existsSync(rawPath));
    assert.ok(existsSync(mdPath));

    const md = readFileSync(mdPath, "utf8");
    assert.ok(md.includes("Bootstrap A"));
    assert.ok(md.includes("https://example.com/bootstrap-link"));
  });

  it("usa order_by=publish_date + direction=desc na listagem (#972)", async () => {
    const rawPath = join(sandboxRoot, "test-order-by-past-editions-raw.json");
    const mdPath = join(sandboxRoot, "test-order-by-past-editions.md");
    if (existsSync(rawPath)) rmSync(rawPath);
    if (existsSync(mdPath)) rmSync(mdPath);

    const seenQueryStrings: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      const u = new URL(url);
      if (/\/posts$/.test(u.pathname)) {
        seenQueryStrings.push(u.search);
        return new Response(
          JSON.stringify({ data: [], page: 1, total_results: 0, total_pages: 1 }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as typeof globalThis.fetch;

    await refreshDedup({
      dryRun: false,
      resolveTracking: false,
      rawPath,
      mdPath,
      configOverride: TEST_CONFIG,
    });

    assert.ok(seenQueryStrings.length > 0, "listPosts deve fazer ao menos 1 request");
    const firstQs = seenQueryStrings[0];
    assert.ok(
      firstQs.includes("order_by=publish_date"),
      `request deve usar order_by=publish_date (#972), recebeu: ${firstQs}`,
    );
    assert.ok(
      firstQs.includes("direction=desc"),
      `request deve usar direction=desc (#972), recebeu: ${firstQs}`,
    );
    assert.ok(
      !firstQs.includes("order_by=newest_first"),
      `nunca deve usar order_by=newest_first (bug #972), recebeu: ${firstQs}`,
    );
  });

  it("incremental com 1 post novo: merge no raw + popula MD com ambos", async () => {
    const rawPath = join(sandboxRoot, "test3-past-editions-raw.json");
    const mdPath = join(sandboxRoot, "test3-past-editions.md");

    const existing = [
      {
        id: "post_old",
        title: "Edição antiga",
        web_url: "https://diaria.beehiiv.com/p/antiga",
        published_at: "2026-05-04T12:00:00Z",
        links: ["https://example.com/antiga"],
      },
    ];
    writeFileSync(rawPath, JSON.stringify(existing), "utf8");

    const oldTs = Math.floor(new Date("2026-05-04T12:00:00Z").getTime() / 1000);
    const newTs = Math.floor(new Date("2026-05-06T12:00:00Z").getTime() / 1000);
    globalThis.fetch = makeMockFetch({
      posts: [
        {
          id: "post_new",
          title: "Edição nova",
          publish_date: newTs,
          web_url: "https://diaria.beehiiv.com/p/nova",
        },
        {
          id: "post_old",
          title: "Edição antiga",
          publish_date: oldTs,
          web_url: "https://diaria.beehiiv.com/p/antiga",
        },
      ],
      contentByPostId: {
        post_new: "<p>Veja https://example.com/nova-url</p>",
      },
    });

    const result = await refreshDedup({
      dryRun: false,
      resolveTracking: false,
      rawPath,
      mdPath,
      configOverride: TEST_CONFIG,
    });

    assert.equal(result.mode, "incremental");
    assert.equal(result.new_posts, 1, "apenas 1 post novo (post_old ficou abaixo do cutoff)");
    assert.equal(result.total_in_base, 2, "merge: antigo preservado + novo adicionado");
    assert.equal(result.most_recent_date, "2026-05-06");

    const md = readFileSync(mdPath, "utf8");
    assert.ok(md.includes("Edição antiga"));
    assert.ok(md.includes("Edição nova"));
    assert.ok(md.includes("https://example.com/nova-url"));
  });
});
