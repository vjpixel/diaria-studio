/**
 * #10978 itens 3 e 4 do `--confirm-instagram`:
 *  - item 3: `--confirm-instagram 261022` (data depois da flag) caía no usage;
 *    as duas ordens agora confirmam.
 *  - item 4: a leitura do `/media` pegava só as 15 mídias mais recentes;
 *    agora segue `paging.next` (com teto) e para quando acha.
 * Fetch falso: nada aqui toca a Graph API de verdade.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideInstagramConfirm,
  fetchInstagramRecentMedia,
  instagramEditionMarkers,
  instagramMediaPagingDone,
  INSTAGRAM_CONFIRM_MAX_PAGES,
  parseShortsCliArgs,
  readAndDecideInstagramConfirm,
} from "../scripts/publish-shorts.ts";
import type { ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";

describe("#10978 item 3: ordem dos argumentos do --confirm-instagram", () => {
  for (const argv of [
    ["261022", "--confirm-instagram"],
    ["--confirm-instagram", "261022"],
  ]) {
    it(`${argv.join(" ")} confirma a edição 261022`, () => {
      const r = parseShortsCliArgs(argv);
      assert.equal(r.ok, true, JSON.stringify(r));
      const ok = r as Extract<typeof r, { ok: true }>;
      assert.equal(ok.aammdd, "261022");
      assert.ok(ok.flags.has("confirm-instagram"));
      assert.equal(ok.values["confirm-instagram"], undefined);
    });
  }

  it("data depois da flag com outras opções junto", () => {
    const r = parseShortsCliArgs(["--confirm-instagram", "261022", "--media-id", "179", "--since", "2026-10-22T03:00:00Z"]);
    assert.equal(r.ok, true);
    const ok = r as Extract<typeof r, { ok: true }>;
    assert.equal(ok.aammdd, "261022");
    assert.ok(ok.flags.has("confirm-instagram"));
    assert.equal(ok.values["media-id"], "179");
    assert.equal(ok.values["since"], "2026-10-22T03:00:00Z");
  });

  it("vale também pras outras flags booleanas (--publish 261022)", () => {
    const r = parseShortsCliArgs(["--publish", "261022", "--only", "instagram"]);
    assert.equal(r.ok, true);
    const ok = r as Extract<typeof r, { ok: true }>;
    assert.equal(ok.aammdd, "261022");
    assert.ok(ok.flags.has("publish"));
    assert.equal(ok.values["only"], "instagram");
  });

  it("mesma data duas vezes não é ambígua", () => {
    const r = parseShortsCliArgs(["261022", "--confirm-instagram", "261022"]);
    assert.equal(r.ok, true);
  });

  it("duas edições diferentes: erro, nunca adivinha", () => {
    const r = parseShortsCliArgs(["261021", "--confirm-instagram", "261022"]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /ambígua/);
  });

  it("valor que não é data numa flag booleana: erro de uso", () => {
    const r = parseShortsCliArgs(["261022", "--confirm-instagram", "sim"]);
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /não leva valor/);
  });

  it("sem edição: erro de uso", () => {
    assert.equal(parseShortsCliArgs(["--confirm-instagram"]).ok, false);
  });

  for (const argv of [
    ["--now", "261022"],
    ["261022", "--publish"],
  ]) {
    it(`${argv.join(" ")} vale como edição 261022`, () => {
      const r = parseShortsCliArgs(argv);
      assert.equal(r.ok, true, JSON.stringify(r));
      const ok = r as Extract<typeof r, { ok: true }>;
      assert.equal(ok.aammdd, "261022");
      assert.ok(ok.flags.has(argv.includes("--now") ? "now" : "publish"));
    });
  }

  it("posicional que não é data: argumento não reconhecido, nunca 'edição ambígua'", () => {
    const r = parseShortsCliArgs(["261022", "publish"]);
    assert.equal(r.ok, false);
    const err = (r as { error: string }).error;
    assert.match(err, /argumento não reconhecido: publish/);
    assert.doesNotMatch(err, /ambígua/);
  });

  it("--edition continua valendo", () => {
    const r = parseShortsCliArgs(["--edition", "261022", "--confirm-instagram"]);
    assert.equal(r.ok, true);
    assert.equal((r as { aammdd: string }).aammdd, "261022");
  });
});

describe("#10978 item 4: paginação do /media", () => {
  const markers = instagramEditionMarkers({ aammdd: "261022", d1Title: "Título do D1" });
  const empty: ShortsPublishedFile = { aammdd: "261022", entries: [] };
  const now = "2026-10-23T16:00:00.000Z";
  const NEXT = (n: number) => `https://graph.facebook.com/v25.0/1784/media?after=c${n}&access_token=tok&limit=15`;

  function filler(prefix: string, startIso: string, count: number) {
    const t0 = Date.parse(startIso);
    return Array.from({ length: count }, (_, i) => ({
      id: `${prefix}${i}`,
      media_product_type: "FEED",
      media_type: "IMAGE",
      timestamp: new Date(t0 - i * 60_000).toISOString().replace(".000Z", "+0000"),
      caption: "post qualquer",
    }));
  }

  function fetchPages(pages: unknown[]) {
    const urls: string[] = [];
    return {
      deps: {
        fetch: async (url: string) => {
          urls.push(url);
          const p = pages[urls.length - 1];
          if (!p) throw new Error(`chamada inesperada: ${url}`);
          return new Response(JSON.stringify(p), { status: 200 });
        },
      },
      urls,
    };
  }

  const reel = {
    id: "reel-p2",
    media_product_type: "REELS",
    media_type: "VIDEO",
    timestamp: "2026-10-22T12:00:00+0000",
    permalink: "https://www.instagram.com/reel/p2/",
    caption: "Título do D1\n\nCorpo.",
  };

  it("o Reels da edição está na 2ª página: segue paging.next e registra", async () => {
    // 15 mídias mais novas (fotos de hoje), o Reels de ontem só na 2ª página.
    const p1 = { data: filler("f", "2026-10-23T15:00:00Z", 15), paging: { next: NEXT(1) } };
    const p2 = { data: [reel, ...filler("g", "2026-10-21T10:00:00Z", 3)], paging: { next: NEXT(2) } };
    const f = fetchPages([p1, p2]);
    const since = "2026-10-22T03:00:00.000Z";
    const media = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: since });
    // Parou na 2ª: ela já chegou a mídias anteriores ao corte.
    assert.equal(f.urls.length, 2);
    assert.equal(f.urls[1], NEXT(1));
    assert.equal(media.pages, 2);
    assert.equal(media.data.length, 19);
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, nowIso: now });
    assert.equal(d.kind, "register", JSON.stringify(d));
    assert.equal((d as { entry: { id: string } }).entry.id, "reel-p2");
  });

  it("antes do fix (só a 1ª página) o mesmo cenário recusava", () => {
    const p1 = { data: filler("f", "2026-10-23T15:00:00Z", 15) };
    const d = decideInstagramConfirm({ published: empty, media: p1, sinceIso: "2026-10-22T03:00:00.000Z", markers, nowIso: now });
    assert.equal(d.kind, "refuse");
  });

  it("--media-id na 2ª página: para assim que acha", async () => {
    const p1 = { data: filler("f", "2026-10-23T15:00:00Z", 15), paging: { next: NEXT(1) } };
    const p2 = { data: [reel], paging: { next: NEXT(2) } };
    const f = fetchPages([p1, p2]);
    const media = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-23T03:00:00Z", mediaId: "reel-p2" });
    assert.equal(f.urls.length, 2);
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: "2026-10-23T03:00:00Z", markers, mediaId: "reel-p2", nowIso: now });
    assert.equal(d.kind, "register");
  });

  it("1ª página já cobre o corte: não pede a 2ª", async () => {
    const p1 = { data: [reel, ...filler("g", "2026-10-21T10:00:00Z", 14)], paging: { next: NEXT(1) } };
    const f = fetchPages([p1]);
    const media = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-22T03:00:00Z" });
    assert.equal(f.urls.length, 1);
    assert.equal(media.more, true);
  });

  it("respeita o teto de páginas", async () => {
    const pages = Array.from({ length: INSTAGRAM_CONFIRM_MAX_PAGES + 2 }, (_, i) => ({
      data: filler(`p${i}-`, "2026-10-23T15:00:00Z", 15),
      paging: { next: NEXT(i + 1) },
    }));
    const f = fetchPages(pages);
    const media = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-01T00:00:00Z" });
    assert.equal(f.urls.length, INSTAGRAM_CONFIRM_MAX_PAGES);
    assert.equal(media.data.length, INSTAGRAM_CONFIRM_MAX_PAGES * 15);
    assert.equal(media.more, true);
  });

  it("sem paging.next: uma chamada só", async () => {
    const f = fetchPages([{ data: [] }]);
    const media = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-22T03:00:00Z" });
    assert.equal(f.urls.length, 1);
    assert.equal(media.more, false);
  });

  it("paging.next fora do Graph: recusa seguir (o token vai na URL)", async () => {
    const f = fetchPages([{ data: filler("f", "2026-10-23T15:00:00Z", 2), paging: { next: "https://evil.example/x?access_token=tok" } }]);
    await assert.rejects(fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-01T00:00:00Z" }), /fora do Graph/);
    assert.equal(f.urls.length, 1);
  });

  it("erro na 2ª página propaga (nunca decide com leitura parcial em silêncio)", async () => {
    const urls: string[] = [];
    const deps = {
      fetch: async (url: string) => {
        urls.push(url);
        if (urls.length === 1) return new Response(JSON.stringify({ data: filler("f", "2026-10-23T15:00:00Z", 15), paging: { next: NEXT(1) } }), { status: 200 });
        return new Response(JSON.stringify({ error: { message: "rate limit" } }), { status: 400 });
      },
    };
    await assert.rejects(fetchInstagramRecentMedia(deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-01T00:00:00Z" }), /página 2.*rate limit/);
  });

  it("paging.next com outra versão da API no graph.facebook.com é seguido", async () => {
    const other = "https://graph.facebook.com/v26.0/1784/media?after=c1&access_token=tok&limit=15";
    const f = fetchPages([
      { data: filler("f", "2026-10-23T15:00:00Z", 15), paging: { next: other } },
      { data: [reel, ...filler("g", "2026-10-21T10:00:00Z", 2)] },
    ]);
    const media = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-22T03:00:00Z" });
    assert.equal(f.urls.length, 2);
    assert.equal(f.urls[1], other);
    assert.equal(media.windowCovered, true);
  });

  it("maxPages NaN cai no teto padrão (nunca sem limite)", async () => {
    const pages = Array.from({ length: INSTAGRAM_CONFIRM_MAX_PAGES + 2 }, (_, i) => ({
      data: filler(`p${i}-`, "2026-10-23T15:00:00Z", 15),
      paging: { next: NEXT(i + 1) },
    }));
    const f = fetchPages(pages);
    await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: "2026-10-01T00:00:00Z", maxPages: Number.NaN });
    assert.equal(f.urls.length, INSTAGRAM_CONFIRM_MAX_PAGES);
  });

  it("teto de páginas sem cobrir o --since: match único NÃO registra, pede --media-id", async () => {
    // O Reels da edição está na 1ª página, mas a janela continua além do teto.
    const pages = [
      { data: [{ ...reel, timestamp: "2026-10-23T15:30:00+0000" }, ...filler("f", "2026-10-23T15:00:00Z", 14)], paging: { next: NEXT(1) } },
      { data: filler("g", "2026-10-23T12:00:00Z", 15), paging: { next: NEXT(2) } },
    ];
    const f = fetchPages(pages);
    const since = "2026-10-01T00:00:00Z";
    const media = await fetchInstagramRecentMedia(f.deps, "1784", "tok", "v25.0", { sinceIso: since, maxPages: 2 });
    assert.equal(media.windowCovered, false);
    const d = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, nowIso: now });
    assert.equal(d.kind, "refuse", JSON.stringify(d));
    assert.match((d as { reason: string }).reason, /teto de páginas.*--media-id/);
    // Com a janela coberta, o mesmo dado registraria.
    const ok = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, nowIso: now, windowCovered: true });
    assert.equal(ok.kind, "register");
    // --media-id explícito continua valendo mesmo sem cobrir a janela.
    const byId = decideInstagramConfirm({ published: empty, media, sinceIso: since, markers, mediaId: "reel-p2", nowIso: now });
    assert.equal(byId.kind, "register");
  });

  it("readAndDecideInstagramConfirm repassa { sinceIso, mediaId } ao fetch e decide", async () => {
    const p1 = { data: filler("f", "2026-10-23T15:00:00Z", 15), paging: { next: NEXT(1) } };
    const p2 = { data: [reel], paging: { next: NEXT(2) } };
    const f = fetchPages([p1, p2]);
    const d = await readAndDecideInstagramConfirm(f.deps, {
      igUserId: "1784", token: "tok", apiVersion: "v25.0", published: empty,
      sinceIso: "2026-10-23T03:00:00Z", markers, mediaId: "reel-p2", nowIso: now,
    });
    // mediaId repassado: parou na página em que achou (sem ele, o corte de
    // 03:00 de hoje só pararia na 2ª também, mas o since sozinho não acharia o Reels de ontem).
    assert.equal(f.urls.length, 2);
    assert.equal(d.kind, "register");
    const f2 = fetchPages([{ data: [reel, ...filler("g", "2026-10-21T10:00:00Z", 2)], paging: { next: NEXT(1) } }]);
    const d2 = await readAndDecideInstagramConfirm(f2.deps, {
      igUserId: "1784", token: "tok", apiVersion: "v25.0", published: empty,
      sinceIso: "2026-10-22T03:00:00Z", markers, nowIso: now,
    });
    // sinceIso repassado: a 1ª página já passa do corte, então não pede a 2ª.
    assert.equal(f2.urls.length, 1);
    assert.equal(d2.kind, "register");
  });

  it("readAndDecideInstagramConfirm: --since inválido falha ANTES de qualquer fetch", async () => {
    const f = fetchPages([]);
    await assert.rejects(
      readAndDecideInstagramConfirm(f.deps, { igUserId: "1784", token: "tok", apiVersion: "v25.0", published: empty, sinceIso: "ontem", markers, nowIso: now }),
      /--since inválido/,
    );
    assert.equal(f.urls.length, 0);
  });

  it("instagramMediaPagingDone: com mediaId só para quando acha; sem corte válido nunca para", () => {
    assert.equal(instagramMediaPagingDone({ lastPage: [], all: [{ id: "a" }], mediaId: "b" }), false);
    assert.equal(instagramMediaPagingDone({ lastPage: [], all: [{ id: "b" }], mediaId: "b" }), true);
    assert.equal(instagramMediaPagingDone({ lastPage: [{ timestamp: "2026-10-01T00:00:00+0000" }], all: [], sinceIso: null }), false);
    assert.equal(instagramMediaPagingDone({ lastPage: [{ timestamp: "2026-10-01T00:00:00+0000" }], all: [], sinceIso: "2026-10-02T00:00:00Z" }), true);
  });
});
