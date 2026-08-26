/**
 * test/edition-cache-reader.test.ts (#6187 item 3)
 *
 * Cobre a camada de leitura unificada Beehiiv → Kit: normalização de cada
 * origem pro shape comum, merge ordenado por data (inclusive quando as duas
 * origens têm edições no mesmo dia — determinismo, não uma "ordem certa"
 * que não existe), e os dois modos de diretório ausente (Beehiiv = erro
 * real; Kit = `[]`, estado esperado hoje).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeBeehiivPost,
  normalizeKitBroadcast,
  mergeEditionsByDate,
  loadBeehiivCache,
  loadKitCache,
  loadUnifiedEditionCache,
  KIT_STATUS_TO_BEEHIIV_STATUS,
  type UnifiedCachedPost,
} from "../scripts/lib/shared/edition-cache-reader.ts";

describe("normalizeBeehiivPost", () => {
  it("passthrough dos campos já no vocabulário certo + origin", () => {
    const raw = {
      slug: "post-x",
      title: "Título",
      subtitle: "Sub",
      subject: "Assunto",
      web_url: "https://diar.ia.br/p/post-x",
      publish_date: 1_700_000_000,
      status: "confirmed",
      thumbnail_url: "https://img/x.jpg",
      content: { free: { web: "<p>corpo</p>" } },
    };
    const got = normalizeBeehiivPost(raw);
    assert.deepEqual(got, { origin: "beehiiv", ...raw });
  });

  it("campos ausentes viram undefined, não lança", () => {
    const got = normalizeBeehiivPost({});
    assert.equal(got.origin, "beehiiv");
    assert.equal(got.slug, undefined);
    assert.equal(got.publish_date, undefined);
  });
});

describe("normalizeKitBroadcast", () => {
  const baseSummary = {
    id: 42,
    subject: "Assunto Kit",
    send_at: null,
    status: "completed" as const,
    public: true,
    published_at: "2026-08-20T09:00:00Z",
    created_at: "2026-08-20T08:00:00Z",
    preview_text: null,
    description: "Prévia curta",
    thumbnail_alt: null,
    thumbnail_url: "https://img/kit.jpg",
    publication_id: 1,
  };

  it("mapeia status completed -> confirmed (achado central da normalização)", () => {
    const got = normalizeKitBroadcast(baseSummary);
    assert.equal(got.status, "confirmed");
  });

  it("preserva status não-completed sem alterar", () => {
    for (const s of ["draft", "scheduled", "sending", "aborted"] as const) {
      const got = normalizeKitBroadcast({ ...baseSummary, status: s });
      assert.equal(got.status, s);
    }
  });

  it("public_url presente vira web_url + slug derivado do path", () => {
    const got = normalizeKitBroadcast({ ...baseSummary, public_url: "https://diar.ia.br/kit/algum-slug" });
    assert.equal(got.web_url, "https://diar.ia.br/kit/algum-slug");
    assert.equal(got.slug, "algum-slug");
  });

  it("public_url AUSENTE nunca lança e deixa web_url/slug undefined (#6096)", () => {
    const got = normalizeKitBroadcast(baseSummary); // sem public_url
    assert.equal(got.web_url, undefined);
    assert.equal(got.slug, undefined);
  });

  it("public_url vazio/inválido não lança, slug fica undefined", () => {
    const got = normalizeKitBroadcast({ ...baseSummary, public_url: "" });
    assert.equal(got.slug, undefined);
    const got2 = normalizeKitBroadcast({ ...baseSummary, public_url: "not a url" });
    assert.equal(got2.slug, undefined);
  });

  it("published_at ISO vira publish_date em Unix seconds", () => {
    const got = normalizeKitBroadcast(baseSummary);
    assert.equal(got.publish_date, Math.floor(Date.parse("2026-08-20T09:00:00Z") / 1000));
  });

  it("published_at ausente cai pro send_at", () => {
    const got = normalizeKitBroadcast({ ...baseSummary, published_at: null, send_at: "2026-08-21T12:00:00Z" });
    assert.equal(got.publish_date, Math.floor(Date.parse("2026-08-21T12:00:00Z") / 1000));
  });

  it("published_at e send_at ausentes -> publish_date undefined, nunca NaN", () => {
    const got = normalizeKitBroadcast({ ...baseSummary, published_at: null, send_at: null });
    assert.equal(got.publish_date, undefined);
  });

  it("content string vira content.free.web; content null/ausente vira undefined", () => {
    const got = normalizeKitBroadcast({ ...baseSummary, content: "<p>oi</p>" });
    assert.equal(got.content?.free?.web, "<p>oi</p>");
    const got2 = normalizeKitBroadcast({ ...baseSummary, content: null });
    assert.equal(got2.content, undefined);
  });

  it("KIT_STATUS_TO_BEEHIIV_STATUS cobre os 5 status documentados da API", () => {
    assert.deepEqual(Object.keys(KIT_STATUS_TO_BEEHIIV_STATUS).sort(), [
      "aborted",
      "completed",
      "draft",
      "scheduled",
      "sending",
    ]);
  });
});

describe("mergeEditionsByDate", () => {
  const p = (over: Partial<UnifiedCachedPost>): UnifiedCachedPost => ({ origin: "beehiiv", ...over });

  it("ordena por publish_date descendente, cruzando as duas origens", () => {
    const beehiiv = [p({ slug: "b-old", publish_date: 1000 }), p({ slug: "b-new", publish_date: 3000 })];
    const kit = [p({ origin: "kit", slug: "k-mid", publish_date: 2000 })];
    const merged = mergeEditionsByDate(beehiiv, kit);
    assert.deepEqual(
      merged.map((e) => e.slug),
      ["b-new", "k-mid", "b-old"],
    );
  });

  it("mesmo dia, origens diferentes: determinístico independente da ordem de input", () => {
    const beehiiv = [p({ slug: "same-day", publish_date: 5000 })];
    const kit = [p({ origin: "kit", slug: "same-day", publish_date: 5000 })];
    const a = mergeEditionsByDate(beehiiv, kit);
    const b = mergeEditionsByDate([...beehiiv], [...kit]); // mesma entrada, novo array
    assert.deepEqual(
      a.map((e) => e.origin),
      b.map((e) => e.origin),
    );
    // beehiiv antes de kit no desempate alfabético declarado
    assert.deepEqual(
      a.map((e) => e.origin),
      ["beehiiv", "kit"],
    );
  });

  it("publish_date ausente vai sempre por último, nunca tratado como 0/mais recente", () => {
    const beehiiv = [p({ slug: "sem-data" }), p({ slug: "antiga", publish_date: 1 })];
    const merged = mergeEditionsByDate(beehiiv, []);
    assert.deepEqual(
      merged.map((e) => e.slug),
      ["antiga", "sem-data"],
    );
  });

  it("array vazio de um dos lados não quebra o merge", () => {
    const merged = mergeEditionsByDate([p({ slug: "x", publish_date: 1 })], []);
    assert.equal(merged.length, 1);
  });
});

describe("loadBeehiivCache / loadKitCache / loadUnifiedEditionCache (I/O real, dirs temporárias)", () => {
  it("loadBeehiivCache lança se o diretório não existir (fonte primária, erro real)", () => {
    const missing = join(tmpdir(), "diaria-6187-missing-beehiiv-never-created");
    assert.throws(() => loadBeehiivCache(missing), /ausente/);
  });

  it("loadKitCache devolve [] se o diretório não existir (Kit ainda não populado, não é erro)", () => {
    const missing = join(tmpdir(), "diaria-6187-missing-kit-never-created");
    assert.deepEqual(loadKitCache(missing), []);
  });

  it("loadBeehiivCache lê e normaliza os arquivos do diretório, ignora index.json, isola falha por-arquivo", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-6187-beehiiv-"));
    try {
      writeFileSync(
        join(dir, "post_1.json"),
        JSON.stringify({ slug: "a", publish_date: 100, status: "confirmed" }),
      );
      writeFileSync(join(dir, "post_2.json"), "{ isto não é json válido");
      writeFileSync(join(dir, "index.json"), JSON.stringify([{ id: "x" }])); // deve ser ignorado
      const posts = loadBeehiivCache(dir);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].slug, "a");
      assert.equal(posts[0].origin, "beehiiv");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadKitCache lê e normaliza os arquivos do diretório", () => {
    const dir = mkdtempSync(join(tmpdir(), "diaria-6187-kit-"));
    try {
      writeFileSync(
        join(dir, "broadcast_1.json"),
        JSON.stringify({
          id: 1,
          subject: "Edição Kit",
          status: "completed",
          published_at: "2026-08-25T09:00:00Z",
          public_url: "https://diar.ia.br/kit/edicao-kit",
        }),
      );
      const posts = loadKitCache(dir);
      assert.equal(posts.length, 1);
      assert.equal(posts[0].origin, "kit");
      assert.equal(posts[0].status, "confirmed");
      assert.equal(posts[0].slug, "edicao-kit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadUnifiedEditionCache funde os dois caches reais e ordena por data cruzando o cutover", () => {
    const beehiivDir = mkdtempSync(join(tmpdir(), "diaria-6187-unified-beehiiv-"));
    const kitDir = mkdtempSync(join(tmpdir(), "diaria-6187-unified-kit-"));
    try {
      // 3 edições Beehiiv "antigas" (pré-cutover)
      writeFileSync(
        join(beehiivDir, "post_1.json"),
        JSON.stringify({ slug: "beehiiv-antiga-1", publish_date: 1_690_000_000, status: "confirmed" }),
      );
      writeFileSync(
        join(beehiivDir, "post_2.json"),
        JSON.stringify({ slug: "beehiiv-antiga-2", publish_date: 1_695_000_000, status: "confirmed" }),
      );
      // 1 edição Kit "nova" (pós-cutover), mais recente que as duas Beehiiv
      writeFileSync(
        join(kitDir, "broadcast_1.json"),
        JSON.stringify({
          id: 9,
          subject: "Edição pós-cutover",
          status: "completed",
          published_at: "2026-08-25T09:00:00Z",
          public_url: "https://diar.ia.br/kit/pos-cutover",
        }),
      );
      const merged = loadUnifiedEditionCache({ beehiivPostsDir: beehiivDir, kitBroadcastsDir: kitDir });
      assert.deepEqual(
        merged.map((e) => e.slug),
        ["pos-cutover", "beehiiv-antiga-2", "beehiiv-antiga-1"],
      );
      assert.deepEqual(
        merged.map((e) => e.origin),
        ["kit", "beehiiv", "beehiiv"],
      );
      // todas confirmadas — nenhum consumidor filtrando status==="confirmed" perde a edição Kit
      assert.ok(merged.every((e) => e.status === "confirmed"));
    } finally {
      rmSync(beehiivDir, { recursive: true, force: true });
      rmSync(kitDir, { recursive: true, force: true });
    }
  });

  it("loadUnifiedEditionCache com só Beehiiv (Kit ainda não populado) devolve só as edições Beehiiv, sem erro", () => {
    const beehiivDir = mkdtempSync(join(tmpdir(), "diaria-6187-unified-beehiiv-only-"));
    const kitDirNeverCreated = join(tmpdir(), "diaria-6187-kit-never-created-for-this-test");
    try {
      writeFileSync(
        join(beehiivDir, "post_1.json"),
        JSON.stringify({ slug: "x", publish_date: 1, status: "confirmed" }),
      );
      const merged = loadUnifiedEditionCache({
        beehiivPostsDir: beehiivDir,
        kitBroadcastsDir: kitDirNeverCreated,
      });
      assert.equal(merged.length, 1);
      assert.equal(merged[0].origin, "beehiiv");
    } finally {
      rmSync(beehiivDir, { recursive: true, force: true });
    }
  });
});
