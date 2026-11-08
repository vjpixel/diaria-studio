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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMAGE_SOURCE_HEADER,
  R2_KV_ARCHIVE_PREFIX,
  r2ArchiveKeyForImageKey,
  serveKvImage,
  type KvImageStore,
  type R2ImageStore,
} from "../scripts/lib/shared/kv-image.ts";
import {
  DEFAULT_PRUNE_SETTLE_MS,
  KV_ARCHIVE_CANARY_BODY,
  KV_ARCHIVE_CANARY_KEY,
  KV_ARCHIVE_DATED_CANARY_KEY,
  archiveKvImages,
  archiveUploadedFileToR2,
  archiveUploadedImageToR2,
  contentTypeForImageKey,
  imageKeyReferenceDate,
  isEiaConventionKey,
  makeCloudflareKvReader,
  makeR2ArchiveStore,
  makeServedFetch,
  pruneKvImages,
  r2CopyMatches,
  type KvPruner,
  type PruneOptions,
  type R2ArchiveStore,
  type ServedFetch,
} from "../scripts/lib/public-images-archive.ts";
import { getBinaryFromWorkerKV, putBinaryToWorkerKV } from "../scripts/lib/cloudflare-kv-upload.ts";
import type { RunLogEvent } from "../scripts/lib/run-log.ts";
import { archiveExitCode, parseArchiveArgs } from "../scripts/archive-kv-public-images.ts";
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
  const kv: KvPruner & { data: Map<string, Uint8Array>; ops: string[] } = {
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
    return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), source: res.headers.get(IMAGE_SOURCE_HEADER) };
  };
}

/** Opções de poda com `apply` e a espera final registrada (nunca dorme de verdade). */
function applyOpts(extra: Partial<PruneOptions> = {}, slept: number[] = []): PruneOptions {
  return { apply: true, now: NOW, workerOrigins: ORIGINS, sleep: async (ms) => void slept.push(ms), ...extra };
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
    assert.ok(r2.data.has("img/260101/kv-archive-canary.txt"), "2º canário, no caminho datado img/{AAMMDD}/");
    assert.equal(archiveExitCode(report), 0);
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
    assert.equal(byBytes.totals.deferred, 2);
    assert.equal(byBytes.totals["too-large"], 1, "weekly-v2 (9 bytes) nunca caberia num teto de 6: outcome próprio, não deferred eterno");
    assert.equal(archiveExitCode(byBytes), 1);
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
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts());
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
    const slept: number[] = [];
    const report = await pruneKvImages(kv, r2, served, applyOpts({}, slept));
    assert.equal(report.totals.deleted, 3);
    assert.equal(report.totals["deleted-unverified"] ?? 0, 0, "toda remoção passou pela re-conferência final");
    assert.equal(report.aborted, undefined);
    assert.deepEqual(slept, [DEFAULT_PRUNE_SETTLE_MS], "uma espera só, no fim da rodada");
    assert.ok(DEFAULT_PRUNE_SETTLE_MS >= 70_000);
    assert.ok(urls.some((u) => u.includes("-final")), "re-conferência final pedida aos Workers");
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
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts({ limit: 1 }));
    assert.equal(report.totals.deleted, 1);
    assert.equal(report.totals["kept-limit"], 2);
  });

  it("apply sem canário servido (Worker sem binding/fallback) não remove nada", async () => {
    const { kv, r2 } = await archived();
    const report = await pruneKvImages(kv, r2, workerFetch(kv, null), applyOpts());
    assert.match(report.aborted!, /canário/);
    assert.ok(!kv.ops.some((o) => o.startsWith("delete:")));
    assert.equal(pruneExitCode(report), 1);
  });

  it("canário ausente do R2 (archive --apply não rodou) também bloqueia — cada um dos dois", async () => {
    for (const r2Key of [`img/kv/${KV_ARCHIVE_CANARY_KEY}`, "img/260101/kv-archive-canary.txt"]) {
      const { kv, r2 } = await archived();
      r2.data.delete(r2Key);
      const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts());
      assert.ok(report.aborted, r2Key);
      assert.equal(kv.ops.filter((o) => o.startsWith("delete:")).length, 0, r2Key);
    }
  });

  it("Worker sem o header X-Image-Source (deploy anterior): canário reprova, nada removido", async () => {
    const { kv, r2 } = await archived();
    const real = workerFetch(kv, r2);
    const report = await pruneKvImages(kv, r2, async (u) => ({ ...(await real(u)), source: null }), applyOpts());
    assert.match(report.aborted!, /canários/);
    assert.match(report.canary.find((c) => !c.ok)!.detail!, /X-Image-Source/);
    assert.ok(report.canary.some((c) => c.url.endsWith(`/img/${KV_ARCHIVE_DATED_CANARY_KEY}`)), "o canário datado é pedido");
    assert.ok(!kv.ops.some((o) => o.startsWith("delete:")));
  });

  it("Worker que não serve a key depois da remoção: a key volta ao KV e a rodada para", async () => {
    const { kv, r2 } = await archived();
    const real = workerFetch(kv, r2);
    // Canário OK, mas o Worker do apex não serve as keys podadas.
    const served: ServedFetch = async (url) => (url.startsWith("https://diar.ia.br/") && url.includes("?kv-prune=") ? { status: 404, body: new Uint8Array() } : real(url));
    const report = await pruneKvImages(kv, r2, served, applyOpts());
    assert.equal(report.totals.restored, 1);
    assert.equal(report.totals.deleted ?? 0, 0);
    assert.match(report.aborted!, /devolvida ao KV/);
    assert.equal(new TextDecoder().decode(kv.data.get(DAILY_OLD)!), "daily", "bytes restaurados");
    assert.ok(kv.data.has(WEEKLY_CARD) && kv.data.has(RETRO), "nada depois da falha foi removido");
  });

  it("sem origem de Worker para conferir, recusa", async () => {
    const { kv, r2 } = await archived();
    await assert.rejects(pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts({ workerOrigins: [] })), /workerOrigins vazio/);
  });

  // ── conferência pós-DELETE (cache de borda do KV) ──

  /**
   * Worker que lê o KV através de um cache de borda: o valor visto ANTES do
   * DELETE continua servido (com `X-Image-Source: kv`) até `expire()`.
   */
  function edgeCachedWorker(kv: ReturnType<typeof fakeKv>, r2: ReturnType<typeof fakeR2>) {
    const cache = new Map(kv.data);
    let live = false;
    const store: KvImageStore = { get: async (k) => ((live ? kv.data : cache).get(k)?.slice().buffer as ArrayBuffer) ?? null };
    const served: ServedFetch = async (url) => {
      const key = decodeURIComponent(new URL(url).pathname.slice("/img/".length));
      const res = await serveKvImage(key, store, null, r2.binding);
      return { status: res.status, body: new Uint8Array(await res.arrayBuffer()), source: res.headers.get(IMAGE_SOURCE_HEADER) };
    };
    return { served, expire: () => void (live = true) };
  }

  it("KV ainda em cache depois do DELETE e Worker sem fallback: a re-conferência final pega e restaura", async () => {
    const { kv, r2 } = await archived();
    // Worker "sem fallback" para as keys podadas, mas o cache de borda segura o valor antigo.
    const cached = new Map(kv.data);
    const served: ServedFetch = async (url) => {
      const key = decodeURIComponent(new URL(url).pathname.slice("/img/".length));
      if (key.includes("canary")) return workerFetch(kv, r2)(url);
      const v = cached.get(key);
      return v ? { status: 200, body: v, source: "kv" } : { status: 404, body: new Uint8Array(), source: null };
    };
    const report = await pruneKvImages(kv, r2, served, applyOpts());
    assert.equal(report.totals.deleted ?? 0, 0);
    assert.equal(report.totals.restored, 3, "as três removidas voltam ao KV");
    assert.match(report.aborted!, /não foi servido do R2/);
    for (const k of [DAILY_OLD, WEEKLY_CARD, RETRO]) assert.ok(kv.data.has(k), `${k} restaurada`);
    assert.equal(pruneExitCode(report), 1);
  });

  it("cache de borda que vence durante a espera: a re-conferência vê o R2 e confirma", async () => {
    const { kv, r2 } = await archived();
    const w = edgeCachedWorker(kv, r2);
    const report = await pruneKvImages(kv, r2, w.served, applyOpts({ sleep: async () => w.expire() }));
    assert.equal(report.totals.deleted, 3);
    assert.equal(report.aborted, undefined);
  });

  it("settleMs é injetável", async () => {
    const { kv, r2 } = await archived();
    const slept: number[] = [];
    await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts({ settleMs: 5 }, slept));
    assert.deepEqual(slept, [5]);
  });

  it("só o Worker poll falhando também restaura", async () => {
    const { kv, r2 } = await archived();
    const real = workerFetch(kv, r2);
    const served: ServedFetch = async (url) => (url.startsWith("https://eia.diar.ia.br/") && url.includes("?kv-prune=") ? { status: 503, body: new Uint8Array() } : real(url));
    const report = await pruneKvImages(kv, r2, served, applyOpts());
    assert.equal(report.totals.restored, 1);
    assert.match(report.entries.find((e) => e.outcome === "restored")!.detail!, /eia\.diar\.ia\.br.*HTTP 503/);
    assert.ok(kv.data.has(DAILY_OLD));
  });

  it("200 com corpo diferente restaura", async () => {
    const { kv, r2 } = await archived();
    const real = workerFetch(kv, r2);
    const served: ServedFetch = async (url) => (url.includes("?kv-prune=") ? { status: 200, body: enc("outro"), source: "r2" } : real(url));
    const report = await pruneKvImages(kv, r2, served, applyOpts());
    assert.equal(report.totals.restored, 1);
    assert.match(report.entries.find((e) => e.outcome === "restored")!.detail!, /não confere/);
  });

  it("served lançando restaura", async () => {
    const { kv, r2 } = await archived();
    const real = workerFetch(kv, r2);
    const served: ServedFetch = async (url) => {
      if (url.includes("?kv-prune=")) throw new Error("ECONNRESET");
      return real(url);
    };
    const report = await pruneKvImages(kv, r2, served, applyOpts());
    assert.equal(report.totals.restored, 1);
    assert.match(report.entries.find((e) => e.outcome === "restored")!.detail!, /ECONNRESET/);
  });

  it("Worker servindo o KV em cache + R2 sem o objeto: nada é apagado (a pré-condição é o R2)", async () => {
    const { kv, r2 } = await archived();
    for (const k of [...r2.data.keys()]) if (!k.includes("canary")) r2.data.delete(k);
    const w = edgeCachedWorker(kv, r2);
    const report = await pruneKvImages(kv, r2, w.served, applyOpts());
    assert.equal(report.totals["kept-not-archived"], 3);
    assert.ok(!kv.ops.some((o) => o.startsWith("delete:")));
  });

  it("restauração falhando depois do DELETE: rodada para, exit 1, detail com a key do R2", async () => {
    const { kv, r2 } = await archived();
    kv.put = async () => {
      throw new Error("KV PUT 500");
    };
    const real = workerFetch(kv, r2);
    const served: ServedFetch = async (url) => (url.includes("?kv-prune=") ? { status: 404, body: new Uint8Array() } : real(url));
    const report = await pruneKvImages(kv, r2, served, applyOpts());
    const bad = report.entries.find((e) => e.key === DAILY_OLD)!;
    assert.equal(bad.outcome, "error");
    assert.match(bad.detail!, /RESTAURAR FALHOU: KV PUT 500/);
    assert.match(bad.detail!, /img\/260512\/04-d1-2x1-aaaaaaaa\.jpg/);
    assert.match(report.aborted!, /restauração no KV falhou/);
    assert.ok(kv.data.has(WEEKLY_CARD) && kv.data.has(RETRO), "rodada parou");
    assert.equal(pruneExitCode(report), 1);
  });

  it("restauração cuja releitura não confere também é RESTAURAR FALHOU", async () => {
    const { kv, r2 } = await archived();
    kv.put = async (k) => void kv.data.set(k, enc("truncado"));
    const real = workerFetch(kv, r2);
    const served: ServedFetch = async (url) => (url.includes("?kv-prune=") ? { status: 404, body: new Uint8Array() } : real(url));
    const report = await pruneKvImages(kv, r2, served, applyOpts());
    assert.match(report.entries.find((e) => e.key === DAILY_OLD)!.detail!, /RESTAURAR FALHOU: releitura/);
  });

  it("kv.get e r2.head lançando: error, nada removido, a rodada segue", async () => {
    const { kv, r2 } = await archived();
    const get = kv.get;
    kv.get = async (k) => {
      if (k === DAILY_OLD) throw new Error("KV GET 500");
      return get(k);
    };
    const head = r2.head;
    r2.head = async (k) => {
      if (k === `img/kv/${WEEKLY_CARD}`) throw new Error("R2 HEAD 500");
      return head(k);
    };
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts());
    const by = Object.fromEntries(report.entries.map((e) => [e.key, e]));
    assert.equal(by[DAILY_OLD].outcome, "error");
    assert.equal(by[WEEKLY_CARD].outcome, "error");
    assert.ok(kv.data.has(DAILY_OLD) && kv.data.has(WEEKLY_CARD));
    assert.equal(by[RETRO].outcome, "deleted");
    assert.equal(pruneExitCode(report), 1);
  });

  it("KV regravado entre a conferência e o DELETE: kept-kv-changed, nada removido", async () => {
    const { kv, r2 } = await archived();
    const get = kv.get;
    const seen = new Map<string, number>();
    kv.get = async (k) => {
      seen.set(k, (seen.get(k) ?? 0) + 1);
      if (k === DAILY_OLD && seen.get(k) === 2) kv.data.set(k, enc("daily-v2"));
      return get(k);
    };
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts());
    assert.equal(report.entries.find((e) => e.key === DAILY_OLD)!.outcome, "kept-kv-changed");
    assert.equal(new TextDecoder().decode(kv.data.get(DAILY_OLD)!), "daily-v2");
  });

  it("DELETE com erro mas remoção aplicada: confere, confirma e para a rodada", async () => {
    const { kv, r2 } = await archived();
    kv.delete = async (k) => {
      kv.ops.push(`delete:${k}`);
      kv.data.delete(k);
      throw new Error("timeout");
    };
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts());
    const e = report.entries.find((x) => x.key === DAILY_OLD)!;
    assert.equal(e.outcome, "deleted", "a key sumiu e o R2 serve: conta como removida");
    assert.match(e.detail!, /DELETE devolveu erro \(timeout\)/);
    assert.match(report.aborted!, /DELETE de .* devolveu erro/);
    assert.equal(kv.ops.filter((o) => o.startsWith("delete:")).length, 1, "rodada parou depois dessa key");
    assert.equal(pruneExitCode(report), 1);
  });

  it("DELETE com erro e key ainda no KV: error, sem regravar, rodada para", async () => {
    const { kv, r2 } = await archived();
    kv.delete = async () => {
      throw new Error("KV DELETE 500");
    };
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts());
    const e = report.entries.find((x) => x.key === DAILY_OLD)!;
    assert.equal(e.outcome, "error");
    assert.match(e.detail!, /a key segue no KV/);
    assert.ok(!kv.ops.some((o) => o.startsWith("put:")));
    assert.ok(report.aborted);
    assert.ok(kv.data.has(WEEKLY_CARD) && kv.data.has(RETRO));
  });

  it("DELETE com erro e releitura falhando: regrava os bytes, por garantia", async () => {
    const { kv, r2 } = await archived();
    let deleted = false;
    const get = kv.get;
    kv.get = async (k) => {
      if (deleted && k === DAILY_OLD && !kv.ops.includes(`put:${DAILY_OLD}`)) throw new Error("KV GET 500");
      return get(k);
    };
    kv.delete = async (k) => {
      deleted = true;
      kv.data.delete(k);
      throw new Error("timeout");
    };
    const report = await pruneKvImages(kv, r2, workerFetch(kv, r2), applyOpts());
    const e = report.entries.find((x) => x.key === DAILY_OLD)!;
    assert.equal(e.outcome, "error");
    assert.match(e.detail!, /key regravada no KV/);
    assert.equal(new TextDecoder().decode(kv.data.get(DAILY_OLD)!), "daily");
    assert.ok(report.aborted);
  });

  it("dry-run com cache de borda nunca chama delete nem espera", async () => {
    const { kv, r2 } = await archived();
    const slept: number[] = [];
    await pruneKvImages(kv, r2, workerFetch(kv, r2), { apply: false, now: NOW, workerOrigins: ORIGINS, sleep: async (ms) => void slept.push(ms) });
    assert.deepEqual(slept, []);
    assert.ok(!kv.ops.some((o) => o.startsWith("delete:") || o.startsWith("put:")));
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

// ─── achados do fleet review (#12450) ──────────────────────────────────────

describe("#11412 archiveKvImages — conferência e tetos", () => {
  it("key com hash cujo HEAD não é de PUT simples (sem tamanho, ETag multipart/fraco) é baixada e comparada", async () => {
    for (const odd of [{ size: -1 }, { etag: '"0123456789abcdef0123456789abcdef-3"' }, { etag: 'W/"x"' }]) {
      const kv = fakeKv({ [DAILY_OLD]: "daily" });
      const r2 = fakeR2({ "img/260512/04-d1-2x1-aaaaaaaa.jpg": "daily" });
      const head = r2.head;
      r2.head = async (k) => {
        const h = await head(k);
        return h && k.startsWith("img/260512/") ? { ...h, ...odd } : h;
      };
      const report = await archiveKvImages(kv, r2, { apply: false, measure: true });
      assert.ok(kv.ops.includes(`get:${DAILY_OLD}`), JSON.stringify(odd));
      assert.equal(report.entries[0].outcome, "stale-would-recopy", JSON.stringify(odd));
    }
  });

  it("--verify baixa e compara também as keys com hash presentes", async () => {
    const kv = fakeKv({ [DAILY_OLD]: "daily" });
    const r2 = fakeR2({ "img/260512/04-d1-2x1-aaaaaaaa.jpg": "corrompido" });
    const plain = await archiveKvImages(kv, r2, { apply: false });
    assert.equal(plain.entries[0].outcome, "already");
    const verified = await archiveKvImages(kv, r2, { apply: false, verify: true });
    assert.equal(verified.entries[0].outcome, "stale-would-recopy");
    assert.equal(parseArchiveArgs(["--verify"]).verify, true);
  });

  it("o teto de keys conta só cópias reais: depois dele, key já arquivada sai already, não deferred", async () => {
    const kv = fakeKv({ [DAILY_OLD]: "daily", [WEEKLY_CARD]: "weekly", [RETRO]: "retro" });
    const r2 = fakeR2({ [`img/kv/${WEEKLY_CARD}`]: "weekly" });
    const report = await archiveKvImages(kv, r2, { apply: true, limit: 1 });
    const by = Object.fromEntries(report.entries.map((e) => [e.key, e.outcome]));
    assert.equal(by[DAILY_OLD], "copied");
    assert.equal(by[RETRO], "deferred");
    assert.equal(by[WEEKLY_CARD], "already");
    assert.ok(!kv.ops.includes(`get:${RETRO}`), "sem cópia e depois do teto: adiada sem baixar");
  });

  it("canário com erro: causa preservada e exit 1", async () => {
    const r2 = fakeR2();
    const head = r2.head;
    r2.head = async (k) => {
      if (k.includes("canary")) throw new Error("R2 HEAD 403");
      return head(k);
    };
    const report = await archiveKvImages(fakeKv({}), r2, { apply: true });
    assert.equal(report.canary, "error");
    assert.match(report.canaryError!, /R2 HEAD 403/);
    assert.equal(archiveExitCode(report), 1);
  });
});

describe("#11412 imageKeyReferenceDate — mensal legado", () => {
  it("img-{AAMM}-{NN}- só é ciclo quando NN é o mês seguinte", () => {
    assert.equal(imageKeyReferenceDate("img-2605-03-cover.jpg"), null, "índice, não mês: sem data");
    assert.equal(imageKeyReferenceDate("img-2605-05-cover.jpg"), null);
    assert.equal(imageKeyReferenceDate("img-2605-06-cover.jpg")?.toISOString(), "2026-07-01T00:00:00.000Z");
  });
});

describe("#11412 serveKvImage — header X-Image-Source", () => {
  it("kv no caminho do KV, r2 no fallback", async () => {
    const fromKv = await serveKvImage(WEEKLY_CARD, { get: async () => enc("kv").buffer as ArrayBuffer }, null, null);
    assert.equal(fromKv.headers.get(IMAGE_SOURCE_HEADER), "kv");
    const r2 = fakeR2({ [`img/kv/${WEEKLY_CARD}`]: "r2" });
    const fromR2 = await serveKvImage(WEEKLY_CARD, { get: async () => null }, null, r2.binding);
    assert.equal(fromR2.headers.get(IMAGE_SOURCE_HEADER), "r2");
  });
  it("makeServedFetch lê o header", async () => {
    const served = makeServedFetch((async () => new Response("x", { headers: { [IMAGE_SOURCE_HEADER]: "r2" } })) as unknown as typeof fetch);
    assert.equal((await served("https://diar.ia.br/img/x")).source, "r2");
    const bare = await makeServedFetch((async () => new Response("x")) as unknown as typeof fetch)("https://diar.ia.br/img/x");
    assert.equal(bare.source, null);
  });
});

// ─── adaptadores reais com fetch stub ──────────────────────────────────────

describe("#11412 getBinaryFromWorkerKV / putBinaryToWorkerKV", () => {
  const cfg = { accountId: "acc", token: "tok", kvNamespaceId: "ns" };
  type Call = { url: string; init?: RequestInit };
  const stub = (res: () => Response, calls: Call[] = []) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return res();
    }) as typeof fetch;

  it("404 → null; 500 lança; bytes binários exatos", async () => {
    assert.equal(await getBinaryFromWorkerKV("img-x.jpg", cfg, stub(() => new Response("nf", { status: 404 }))), null);
    await assert.rejects(getBinaryFromWorkerKV("img-x.jpg", cfg, stub(() => new Response("boom", { status: 500 }))), /500/);
    const raw = new Uint8Array([0, 255, 1, 254, 0x89, 0x50, 0x4e, 0x47]);
    const calls: Call[] = [];
    const got = await getBinaryFromWorkerKV("img-x y.jpg", cfg, stub(() => new Response(raw), calls));
    assert.deepEqual([...got!], [...raw]);
    assert.match(calls[0].url, /\/accounts\/acc\/storage\/kv\/namespaces\/ns\/values\/img-x%20y\.jpg$/);
  });

  it("sem credencial lança", async () => {
    const saved = { a: process.env.CLOUDFLARE_ACCOUNT_ID, t: process.env.CLOUDFLARE_WORKERS_TOKEN };
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_WORKERS_TOKEN;
    try {
      await assert.rejects(getBinaryFromWorkerKV("img-x.jpg", { kvNamespaceId: "ns" }, stub(() => new Response("x"))), /não definidos/);
      await assert.rejects(putBinaryToWorkerKV("img-x.jpg", enc("x"), { kvNamespaceId: "ns" }, stub(() => new Response("x"))), /não definidos/);
    } finally {
      if (saved.a !== undefined) process.env.CLOUDFLARE_ACCOUNT_ID = saved.a;
      if (saved.t !== undefined) process.env.CLOUDFLARE_WORKERS_TOKEN = saved.t;
    }
  });

  it("PUT octet-stream com os bytes; !ok lança", async () => {
    const calls: Call[] = [];
    await putBinaryToWorkerKV("img-x.jpg", enc("abc"), cfg, stub(() => new Response("{}"), calls));
    assert.equal(calls[0].init?.method, "PUT");
    assert.equal((calls[0].init?.headers as Record<string, string>)["Content-Type"], "application/octet-stream");
    assert.deepEqual([...(calls[0].init?.body as Uint8Array)], [...enc("abc")]);
    await assert.rejects(putBinaryToWorkerKV("img-x.jpg", enc("abc"), cfg, stub(() => new Response("no", { status: 403 }))), /403/);
  });

  it("makeCloudflareKvReader não expõe delete nem put", () => {
    const reader = makeCloudflareKvReader(cfg, stub(() => new Response("x")));
    assert.deepEqual(Object.keys(reader).sort(), ["get", "list"]);
  });
});

describe("#11412 makeR2ArchiveStore (API S3 com fetch stub)", () => {
  const access = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b" };
  const store = (res: () => Response) => makeR2ArchiveStore({ fetch: async () => res(), now: () => new Date("2026-11-08T00:00:00Z") }, access);
  const bytes = enc("daily");
  const md5Tag = `"${md5(bytes)}"`;

  it("HEAD: 404 → null; 403 e 500 lançam", async () => {
    assert.equal(await store(() => new Response(null, { status: 404 })).head("img/x"), null);
    for (const status of [403, 500]) await assert.rejects(store(() => new Response(null, { status })).head("img/x"), new RegExp(String(status)));
  });

  it("HEAD sem content-length → size -1, que nunca casa", async () => {
    const info = await store(() => new Response(null, { status: 200, headers: { etag: md5Tag } })).head("img/x");
    assert.equal(info!.size, -1);
    assert.equal(r2CopyMatches(info, bytes), false);
  });

  it("ETag multipart ou fraco (W/) → não confere; MD5 forte com tamanho → confere", async () => {
    const mk = (etag: string) => store(() => new Response(null, { status: 200, headers: { etag, "content-length": String(bytes.length) } })).head("img/x");
    assert.equal(r2CopyMatches(await mk(`"${md5(bytes)}-2"`), bytes), false);
    assert.equal(r2CopyMatches(await mk(`W/${md5Tag}`), bytes), false);
    assert.equal(r2CopyMatches(await mk(md5Tag), bytes), true);
  });

  it("PUT !ok lança", async () => {
    await assert.rejects(store(() => new Response("denied", { status: 403 })).put("img/x", bytes, "image/jpeg", "x"), /R2 PUT img\/x: HTTP 403/);
  });
});

describe("#11412 archiveUploadedFileToR2 — avisa e registra todo skip com a flag ligada", () => {
  function tmpRoot(enabled: boolean) {
    const root = mkdtempSync(join(tmpdir(), "kv-archive-12450-"));
    writeFileSync(join(root, "platform.config.json"), JSON.stringify({ public_images_r2: { enabled } }));
    writeFileSync(join(root, "card.jpg"), "card");
    return root;
  }
  const capture = () => {
    const warns: string[] = [];
    const logs: RunLogEvent[] = [];
    return { warns, logs, deps: { warn: (m: string) => void warns.push(m), log: (e: RunLogEvent) => void logs.push(e) } };
  };

  it("flag desligada: silêncio", async () => {
    const root = tmpRoot(false);
    try {
      const c = capture();
      const r = await archiveUploadedFileToR2(join(root, "card.jpg"), WEEKLY_CARD, root, { ...c.deps, env: {} });
      assert.equal(r.status, "skipped");
      assert.deepEqual([c.warns, c.logs], [[], []]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flag ligada e env do R2 incompleto: aviso + run-log", async () => {
    const root = tmpRoot(true);
    try {
      const c = capture();
      const r = await archiveUploadedFileToR2(join(root, "card.jpg"), WEEKLY_CARD, root, { ...c.deps, env: {} });
      assert.equal(r.status, "skipped");
      assert.match(c.warns[0], /env do R2 incompleto/);
      assert.equal(c.logs[0].level, "warn");
      assert.equal(c.logs[0].agent, "public-images-archive");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flag ligada e key fora da allowlist: aviso + run-log", async () => {
    const root = tmpRoot(true);
    try {
      const c = capture();
      const r = await archiveUploadedFileToR2(join(root, "card.jpg"), "correct:260512", root, { ...c.deps, env: {}, store: fakeR2() });
      assert.equal(r.status, "skipped");
      assert.match(c.warns[0], /fora da allowlist/);
      assert.equal(c.logs.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("arquivo ausente vira failed com aviso (nunca lança); sucesso não avisa", async () => {
    const root = tmpRoot(true);
    try {
      const c = capture();
      const r = await archiveUploadedFileToR2(join(root, "nao-existe.jpg"), WEEKLY_CARD, root, { ...c.deps, store: fakeR2() });
      assert.equal(r.status, "failed");
      assert.equal(c.logs.length, 1);
      const ok = capture();
      assert.equal((await archiveUploadedFileToR2(join(root, "card.jpg"), WEEKLY_CARD, root, { ...ok.deps, store: fakeR2() })).status, "archived");
      assert.deepEqual([ok.warns, ok.logs], [[], []]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
