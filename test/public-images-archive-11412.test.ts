/**
 * #11412 fatias 3 (arquivo durável KV → R2) e 4 (poda gradual do KV).
 *
 * Sem rede: KV, R2 e os Workers são fakes em memória. O "Worker" dos testes
 * de poda é o `serveKvImage` real sobre os mesmos fakes, então o teste prova
 * que a URL `/img/{key}` de um e-mail antigo continua servindo os mesmos
 * bytes depois que a key sai do KV.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  R2_KV_ARCHIVE_PREFIX,
  r2ArchiveKeyForImageKey,
  serveKvImage,
  type KvImageStore,
  type R2ImageStore,
} from "../scripts/lib/shared/kv-image.ts";
import {
  KV_ARCHIVE_CANARY_BODY,
  KV_ARCHIVE_CANARY_KEY,
  archiveKvImages,
  archiveUploadedImageToR2,
  contentTypeForImageKey,
  imageKeyReferenceDate,
  isEiaConventionKey,
  pruneKvImages,
  type KvImageSource,
  type R2ArchiveStore,
  type ServedFetch,
} from "../scripts/lib/public-images-archive.ts";
import { parseArchiveArgs } from "../scripts/archive-kv-public-images.ts";
import { parsePruneArgs, pruneExitCode, pruneWorkerOrigins } from "../scripts/prune-kv-public-images.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const md5 = (b: Uint8Array) => createHash("md5").update(b).digest("hex");

// Keys reais de cada família (formas de cloudflareKvKey / monthlyEiaImageKey).
const DAILY_OLD = "img-260512-04-d1-2x1-aaaaaaaa.jpg"; // e-mail antigo, content-addressed
const WEEKLY_CARD = "img-unknown-weekly-260718-highlights-cover-4x5.jpg"; // card semanal, sem hash
const WEEKLY_PDF = "img-unknown-weekly-260718-highlights-carousel-0123abcd.pdf";
const RETRO = "img-2606-07-04-d1-4x5.jpg"; // Retrospectiva, ciclo AAMM-MM
const MONTHLY_LEGACY = "img-monthly-2605-cover.jpg"; // sem data derivável
const EIA_OLD = "img-260512-01-eia-A.jpg";
const RECENT = "img-261101-04-d1-2x1-bbbbbbbb.jpg";
const GAME_KEYS = ["correct:260512", "score:x@y.z", "img-260512-a:b.jpg"];

const NOW = new Date("2026-11-08T12:00:00Z");
const ORIGINS = ["https://eia.diar.ia.br", "https://diar.ia.br"];

// ─── fakes ─────────────────────────────────────────────────────────────────

function fakeKv(entries: Record<string, string>) {
  const data = new Map<string, Uint8Array>(Object.entries(entries).map(([k, v]) => [k, enc(v)]));
  const ops: string[] = [];
  const kv: KvImageSource & { data: Map<string, Uint8Array>; ops: string[] } = {
    data,
    ops,
    // Igual à API da Cloudflare: o filtro de prefixo é do servidor, mas o
    // fake devolve tudo para provar que o código filtra de novo.
    list: async () => [...data.keys()],
    get: async (k) => {
      ops.push(`get:${k}`);
      return data.get(k) ?? null;
    },
    delete: async (k) => {
      ops.push(`delete:${k}`);
      data.delete(k);
    },
    put: async (k, b) => {
      ops.push(`put:${k}`);
      data.set(k, b);
    },
  };
  return kv;
}

interface R2Obj {
  bytes: Uint8Array;
  contentType: string;
  cacheControl: string;
  etag?: string;
}

function fakeR2(initial: Record<string, string | R2Obj> = {}, opts: { corruptPut?: boolean; failPut?: boolean } = {}) {
  const data = new Map<string, R2Obj>();
  for (const [k, v] of Object.entries(initial)) {
    data.set(k, typeof v === "string" ? { bytes: enc(v), contentType: "image/jpeg", cacheControl: "x" } : v);
  }
  const puts: string[] = [];
  const store: R2ArchiveStore & { data: Map<string, R2Obj>; puts: string[]; binding: R2ImageStore } = {
    data,
    puts,
    head: async (k) => {
      const o = data.get(k);
      return o ? { size: o.bytes.length, etag: o.etag ?? `"${md5(o.bytes)}"` } : null;
    },
    put: async (k, bytes, contentType, cacheControl) => {
      puts.push(k);
      if (opts.failPut) throw new Error("R2 PUT 500");
      data.set(k, { bytes: opts.corruptPut ? enc("lixo") : bytes, contentType, cacheControl });
    },
    // Binding do Worker sobre o mesmo bucket (o que `serveKvImage` consome).
    binding: {
      head: async (k) => {
        const o = data.get(k);
        return o ? { httpEtag: `"${md5(o.bytes)}"`, httpMetadata: { contentType: o.contentType } } : null;
      },
      get: async (k) => {
        const o = data.get(k);
        return o ? { body: new Response(new Uint8Array(o.bytes)).body!, httpEtag: `"${md5(o.bytes)}"`, httpMetadata: { contentType: o.contentType } } : null;
      },
    },
  };
  return store;
}

/** "Worker" real: `serveKvImage` sobre o KV e o R2 fakes, com ou sem binding. */
function workerFetch(kv: ReturnType<typeof fakeKv>, r2: ReturnType<typeof fakeR2> | null, urls: string[] = []): ServedFetch {
  const store: KvImageStore = { get: async (k) => (kv.data.get(k)?.slice().buffer as ArrayBuffer) ?? null };
  return async (url) => {
    urls.push(url);
    const key = decodeURIComponent(new URL(url).pathname.slice("/img/".length));
    const res = await serveKvImage(key, store, null, r2 ? r2.binding : null);
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()) };
  };
}

// ─── mapeamento de chave ───────────────────────────────────────────────────

describe("#11412 r2ArchiveKeyForImageKey", () => {
  it("key com AAMMDD vai para o mesmo lugar dos uploads novos (img/{AAMMDD}/…)", () => {
    assert.equal(r2ArchiveKeyForImageKey(DAILY_OLD), "img/260512/04-d1-2x1-aaaaaaaa.jpg");
  });
  it("semanal, Retrospectiva e img-monthly vão para img/kv/{key}", () => {
    assert.equal(r2ArchiveKeyForImageKey(WEEKLY_CARD), `${R2_KV_ARCHIVE_PREFIX}${WEEKLY_CARD}`);
    assert.equal(r2ArchiveKeyForImageKey(RETRO), `img/kv/${RETRO}`);
    assert.equal(r2ArchiveKeyForImageKey(MONTHLY_LEGACY), `img/kv/${MONTHLY_LEGACY}`);
  });
  it("chave do jogo, `:` e barra nunca viram objeto R2", () => {
    for (const k of [...GAME_KEYS, "img-x/../../shorts/a.mp4", "img-x\\y.jpg"]) assert.equal(r2ArchiveKeyForImageKey(k), null, k);
  });
});

describe("#11412 serveKvImage — fallback img/kv/ (key podada continua servida)", () => {
  it("card semanal fora do KV é servido do img/kv/ com o Content-Type do objeto", async () => {
    const r2 = fakeR2({ [`img/kv/${WEEKLY_PDF}`]: { bytes: enc("%PDF"), contentType: "application/pdf", cacheControl: "x" } });
    const res = await serveKvImage(WEEKLY_PDF, { get: async () => null }, null, r2.binding);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "%PDF");
    assert.equal(res.headers.get("Content-Type"), "application/pdf");
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  });
  it("key ainda no KV é servida do KV (R2 não é lido)", async () => {
    let r2Reads = 0;
    const binding: R2ImageStore = { get: async () => (r2Reads++, null), head: async () => (r2Reads++, null) };
    const res = await serveKvImage(WEEKLY_CARD, { get: async () => enc("kv").buffer as ArrayBuffer }, null, binding);
    assert.equal(await res.text(), "kv");
    assert.equal(r2Reads, 0);
  });
});

// ─── puro ──────────────────────────────────────────────────────────────────

describe("#11412 imageKeyReferenceDate", () => {
  it("AAMMDD, sábado do semanal e ciclo da Retrospectiva", () => {
    assert.equal(imageKeyReferenceDate(DAILY_OLD)?.toISOString(), "2026-05-12T00:00:00.000Z");
    assert.equal(imageKeyReferenceDate(WEEKLY_CARD)?.toISOString(), "2026-07-18T00:00:00.000Z");
    assert.equal(imageKeyReferenceDate(RETRO)?.toISOString(), "2026-08-01T00:00:00.000Z", "1º dia depois do 2º mês do ciclo");
    assert.equal(imageKeyReferenceDate("img-2612-01-04-d1-4x5.jpg")?.toISOString(), "2027-02-01T00:00:00.000Z", "ciclo que vira o ano");
  });
  it("sem data derivável → null (nunca podada)", () => {
    for (const k of [MONTHLY_LEGACY, "img-unknown-image.jpg", "img-261399-x.jpg", "img-2613-01-x.jpg"]) assert.equal(imageKeyReferenceDate(k), null, k);
  });
});

describe("#11412 isEiaConventionKey / contentTypeForImageKey", () => {
  it("É IA? A/B, real/ia e o typo legado eai", () => {
    for (const k of [EIA_OLD, "img-260512-01-eia-B.jpg", "img-260512-01-eia-real.jpg", "img-260512-01-eai-A.jpg"]) assert.ok(isEiaConventionKey(k), k);
    assert.ok(!isEiaConventionKey(DAILY_OLD));
  });
  it("Content-Type pela extensão; desconhecida cai em image/jpeg (o que o KV servia)", () => {
    assert.equal(contentTypeForImageKey(WEEKLY_PDF), "application/pdf");
    assert.equal(contentTypeForImageKey("img-260512-x.PNG"), "image/png");
    assert.equal(contentTypeForImageKey(WEEKLY_CARD), "image/jpeg");
    assert.equal(contentTypeForImageKey("img-260512-semext"), "image/jpeg");
  });
});

// ─── fatia 3: arquivo ──────────────────────────────────────────────────────

describe("#11412 archiveKvImages", () => {
  const kvEntries = () => ({
    [DAILY_OLD]: "daily",
    [WEEKLY_CARD]: "weekly-v2",
    [WEEKLY_PDF]: "pdf",
    [RETRO]: "retro",
    ...Object.fromEntries(GAME_KEYS.map((k) => [k, "jogo"])),
  });

  it("dry-run (padrão) não escreve nada e não baixa o que falta", async () => {
    const kv = fakeKv(kvEntries());
    const r2 = fakeR2();
    const report = await archiveKvImages(kv, r2, { apply: false });
    assert.equal(report.mode, "dry-run");
    assert.deepEqual(r2.puts, []);
    assert.deepEqual(kv.ops, [], "sem measure, nenhuma leitura de valor do KV");
    assert.equal(report.totals["would-copy"], 4);
    assert.equal(report.canary, "would-write");
    assert.equal(report.listed, 4, "chaves do jogo nem entram na lista");
  });

  it("dry-run --measure soma os bytes, só lendo", async () => {
    const kv = fakeKv(kvEntries());
    const report = await archiveKvImages(kv, fakeR2(), { apply: false, measure: true });
    assert.equal(report.bytesPlanned, "daily".length + "weekly-v2".length + "pdf".length + "retro".length);
    assert.ok(kv.ops.every((o) => o.startsWith("get:img-") && !GAME_KEYS.some((g) => o.endsWith(g))));
  });

  it("apply copia, confere, grava o canário e nunca muta o KV", async () => {
    const kv = fakeKv(kvEntries());
    const r2 = fakeR2();
    const report = await archiveKvImages(kv, r2, { apply: true });
    assert.equal(report.totals.copied, 4);
    assert.equal(report.canary, "written");
    assert.deepEqual(new TextDecoder().decode(r2.data.get(`img/kv/${WEEKLY_CARD}`)!.bytes), "weekly-v2");
    assert.equal(r2.data.get(`img/kv/${WEEKLY_PDF}`)!.contentType, "application/pdf");
    assert.equal(r2.data.get("img/260512/04-d1-2x1-aaaaaaaa.jpg")!.cacheControl, "public, max-age=31536000, immutable");
    assert.equal(r2.data.get(`img/kv/${WEEKLY_CARD}`)!.cacheControl, "public, max-age=3600", "key sem hash não é immutable");
    assert.deepEqual(new TextDecoder().decode(r2.data.get(`img/kv/${KV_ARCHIVE_CANARY_KEY}`)!.bytes), new TextDecoder().decode(KV_ARCHIVE_CANARY_BODY));
    assert.ok(!kv.ops.some((o) => o.startsWith("delete:") || o.startsWith("put:")));
    for (const g of GAME_KEYS) assert.ok(kv.data.has(g));
  });

  it("idempotente: 2ª rodada não copia nada; content-addressed presente nem é baixado", async () => {
    const kv = fakeKv(kvEntries());
    const r2 = fakeR2();
    await archiveKvImages(kv, r2, { apply: true });
    kv.ops.length = 0;
    r2.puts.length = 0;
    const again = await archiveKvImages(kv, r2, { apply: true });
    assert.equal(again.totals.already, 4);
    assert.deepEqual(r2.puts, []);
    assert.ok(!kv.ops.includes(`get:${DAILY_OLD}`) && !kv.ops.includes(`get:${WEEKLY_PDF}`));
    assert.equal(again.canary, "present");
  });

  it("key de convenção fixa com cópia velha no R2 é recopiada", async () => {
    const kv = fakeKv({ [WEEKLY_CARD]: "weekly-v2" });
    const r2 = fakeR2({ [`img/kv/${WEEKLY_CARD}`]: "weekly-v1" });
    const dry = await archiveKvImages(kv, r2, { apply: false });
    assert.equal(dry.totals["stale-would-recopy"], 1);
    const report = await archiveKvImages(kv, r2, { apply: true });
    assert.equal(report.totals.recopied, 1);
    assert.equal(new TextDecoder().decode(r2.data.get(`img/kv/${WEEKLY_CARD}`)!.bytes), "weekly-v2");
  });

  it("teto de bytes e de keys adia o resto para a próxima rodada", async () => {
    const kv = fakeKv(kvEntries());
    const byBytes = await archiveKvImages(kv, fakeR2(), { apply: true, maxBytes: 6 });
    assert.equal(byBytes.totals.copied, 1);
    assert.ok(byBytes.bytesCopied <= 6);
    assert.equal(byBytes.totals.deferred, 3);
    const byLimit = await archiveKvImages(fakeKv(kvEntries()), fakeR2(), { apply: true, limit: 2 });
    assert.equal(byLimit.totals.copied, 2);
    assert.equal(byLimit.totals.deferred, 2);
  });

  it("cópia que não confere depois do PUT vira error (e a rodada segue)", async () => {
    const report = await archiveKvImages(fakeKv({ [DAILY_OLD]: "daily", [RETRO]: "retro" }), fakeR2({}, { corruptPut: true }), { apply: true });
    assert.equal(report.totals.error, 2);
    assert.match(report.entries[0].error!, /não confere/);
  });
});

// ─── fatia 4: poda ─────────────────────────────────────────────────────────

describe("#11412 pruneKvImages", () => {
  /** KV com uma key de cada família + R2 já arquivado (como depois de archive --apply). */
  async function archived(extraKv: Record<string, string> = {}) {
    const kv = fakeKv({
      [DAILY_OLD]: "daily",
      [WEEKLY_CARD]: "weekly",
      [RETRO]: "retro",
      [MONTHLY_LEGACY]: "monthly",
      [EIA_OLD]: "eia",
      [RECENT]: "recent",
      ...Object.fromEntries(GAME_KEYS.map((k) => [k, "jogo"])),
      ...extraKv,
    });
    const r2 = fakeR2();
    await archiveKvImages(kv, r2, { apply: true });
    kv.ops.length = 0;
    return { kv, r2 };
  }

  it("dry-run (padrão) só lista o que seria podado; nada sai do KV", async () => {
    const { kv, r2 } = await archived();
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), { apply: false, now: NOW, workerOrigins: ORIGINS });
    assert.ok(!kv.ops.some((o) => o.startsWith("delete:")));
    const by = Object.fromEntries(report.entries.map((e) => [e.key, e.outcome]));
    assert.equal(by[DAILY_OLD], "would-delete");
    assert.equal(by[WEEKLY_CARD], "would-delete");
    assert.equal(by[RETRO], "would-delete");
    assert.equal(by[MONTHLY_LEGACY], "kept-no-date");
    assert.equal(by[EIA_OLD], "kept-eia");
    assert.equal(by[RECENT], "kept-too-recent");
    for (const g of GAME_KEYS) assert.equal(by[g], undefined, "chave do jogo nunca aparece");
    assert.ok(report.canary.every((c) => c.ok));
  });

  it("nunca remove key sem cópia no R2 ou com cópia diferente do KV", async () => {
    const { kv, r2 } = await archived();
    r2.data.delete("img/260512/04-d1-2x1-aaaaaaaa.jpg");
    r2.data.set(`img/kv/${WEEKLY_CARD}`, { bytes: enc("outra"), contentType: "image/jpeg", cacheControl: "x" });
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), { apply: true, now: NOW, workerOrigins: ORIGINS });
    const by = Object.fromEntries(report.entries.map((e) => [e.key, e.outcome]));
    assert.equal(by[DAILY_OLD], "kept-not-archived");
    assert.equal(by[WEEKLY_CARD], "kept-archive-mismatch");
    assert.ok(kv.data.has(DAILY_OLD) && kv.data.has(WEEKLY_CARD));
    assert.equal(by[RETRO], "deleted");
  });

  it("apply: remove, e /img/{key} continua servindo os mesmos bytes pelo R2", async () => {
    const { kv, r2 } = await archived();
    const urls: string[] = [];
    const served = workerFetch(kv, r2, urls);
    const report = await pruneKvImages(kv, r2, served, { apply: true, now: NOW, workerOrigins: ORIGINS });
    assert.equal(report.totals.deleted, 3);
    assert.equal(report.aborted, undefined);
    for (const k of [DAILY_OLD, WEEKLY_CARD, RETRO]) {
      assert.ok(!kv.data.has(k), `${k} saiu do KV`);
      const res = await served(`https://eia.diar.ia.br/img/${encodeURIComponent(k)}`);
      assert.equal(res.status, 200);
    }
    assert.equal(new TextDecoder().decode((await served(`https://diar.ia.br/img/${WEEKLY_CARD}`)).body), "weekly");
    for (const k of [MONTHLY_LEGACY, EIA_OLD, RECENT, ...GAME_KEYS]) assert.ok(kv.data.has(k), `${k} fica no KV`);
    assert.ok(urls.some((u) => u.startsWith("https://diar.ia.br/img/") && u.includes("?kv-prune=")), "confere os dois Workers, sem cache");
    assert.equal(pruneExitCode(report), 0);
  });

  it("--include-eia e --min-age-days entram no critério", async () => {
    const { kv, r2 } = await archived();
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), { apply: false, now: NOW, workerOrigins: ORIGINS, includeEia: true, minAgeDays: 1 });
    const by = Object.fromEntries(report.entries.map((e) => [e.key, e.outcome]));
    assert.equal(by[EIA_OLD], "would-delete");
    assert.equal(by[RECENT], "would-delete");
  });

  it("teto da rodada: o resto vira kept-limit sem nem ler o KV", async () => {
    const { kv, r2 } = await archived();
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), { apply: true, now: NOW, workerOrigins: ORIGINS, limit: 1 });
    assert.equal(report.totals.deleted, 1);
    assert.equal(report.totals["kept-limit"], 2);
  });

  it("apply sem canário servido (Worker sem binding/fallback) não remove nada", async () => {
    const { kv, r2 } = await archived();
    const report = await pruneKvImages(kv, r2, workerFetch(kv, null), { apply: true, now: NOW, workerOrigins: ORIGINS });
    assert.match(report.aborted!, /canário/);
    assert.ok(!kv.ops.some((o) => o.startsWith("delete:")));
    assert.equal(pruneExitCode(report), 1);
  });

  it("canário ausente do R2 (archive --apply não rodou) também bloqueia", async () => {
    const { kv, r2 } = await archived();
    r2.data.delete(`img/kv/${KV_ARCHIVE_CANARY_KEY}`);
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), { apply: true, now: NOW, workerOrigins: ORIGINS });
    assert.ok(report.aborted);
    assert.equal(kv.ops.filter((o) => o.startsWith("delete:")).length, 0);
  });

  it("Worker que não serve a key depois da remoção: a key volta ao KV e a rodada para", async () => {
    const { kv, r2 } = await archived();
    const real = workerFetch(kv, r2);
    // Canário OK, mas o Worker do apex não serve as keys podadas.
    const served: ServedFetch = async (url) => (url.startsWith("https://diar.ia.br/") && url.includes("?kv-prune=") ? { status: 404, body: new Uint8Array() } : real(url));
    const report = await pruneKvImages(kv, r2, served, { apply: true, now: NOW, workerOrigins: ORIGINS });
    assert.equal(report.totals.restored, 1);
    assert.equal(report.totals.deleted ?? 0, 0);
    assert.match(report.aborted!, /devolvida ao KV/);
    assert.equal(new TextDecoder().decode(kv.data.get(DAILY_OLD)!), "daily", "bytes restaurados");
    assert.ok(kv.data.has(WEEKLY_CARD) && kv.data.has(RETRO), "nada depois da falha foi removido");
  });

  it("sem origem de Worker para conferir, recusa", async () => {
    const { kv, r2 } = await archived();
    await assert.rejects(pruneKvImages(kv, r2, workerFetch(kv, r2), { apply: true, now: NOW, workerOrigins: [] }), /workerOrigins vazio/);
  });
});

// ─── fatia 3 na geração ────────────────────────────────────────────────────

describe("#11412 archiveUploadedImageToR2 (cópia junto do upload semanal/mensal)", () => {
  const body = enc("card");
  it("flag desligada: não toca no R2", async () => {
    const r2 = fakeR2();
    const r = await archiveUploadedImageToR2({ body, kvKey: WEEKLY_CARD, settings: { enabled: false }, env: {}, store: r2 });
    assert.equal(r.status, "skipped");
    assert.deepEqual(r2.puts, []);
  });
  it("flag ligada: grava em img/kv/ e confere", async () => {
    const r2 = fakeR2();
    const r = await archiveUploadedImageToR2({ body, kvKey: WEEKLY_CARD, settings: { enabled: true }, env: {}, store: r2 });
    assert.deepEqual(r, { status: "archived", r2Key: `img/kv/${WEEKLY_CARD}` });
  });
  it("falha do R2 vira failed, nunca exceção (o upload pro KV já deu certo)", async () => {
    const r = await archiveUploadedImageToR2({ body, kvKey: WEEKLY_PDF, settings: { enabled: true }, env: {}, store: fakeR2({}, { failPut: true }) });
    assert.equal(r.status, "failed");
  });
  it("sem env do R2 (e sem store injetado): skipped", async () => {
    const r = await archiveUploadedImageToR2({ body, kvKey: WEEKLY_CARD, settings: { enabled: true }, env: {} });
    assert.equal(r.status, "skipped");
    assert.match((r as { reason: string }).reason, /env do R2/);
  });
});

// ─── CLIs ──────────────────────────────────────────────────────────────────

describe("#11412 CLIs — dry-run é o padrão", () => {
  it("archive: sem flag não aplica; --max-mb converte; argumento desconhecido falha", () => {
    assert.equal(parseArchiveArgs([]).apply, false);
    assert.equal(parseArchiveArgs(["--apply", "--max-mb", "2"]).maxBytes, 2 * 1024 * 1024);
    assert.throws(() => parseArchiveArgs(["--aply"]), /desconhecido/);
    assert.throws(() => parseArchiveArgs(["--limit", "0"]), /positivo/);
  });
  it("prune: sem flag não aplica; defaults 90 dias / 50 keys / sem É IA?", () => {
    assert.deepEqual(parsePruneArgs([]), { apply: false, limit: 50, minAgeDays: 90, includeEia: false });
    assert.throws(() => parsePruneArgs(["--delete"]), /desconhecido/);
  });
  it("prune confere o Worker poll e o apex, sem repetir", () => {
    assert.deepEqual(pruneWorkerOrigins("https://eia.diar.ia.br/"), ["https://eia.diar.ia.br", "https://diar.ia.br"]);
    assert.deepEqual(pruneWorkerOrigins("https://diar.ia.br"), ["https://diar.ia.br"]);
  });
});
