/**
 * test/latest-video-public-at-fonte-12869.test.ts (#12869)
 *
 * O #12863 deixou `shouldReplaceLatestVideo` trocar o registro sempre que o
 * `public_at` difere como texto. Na ordem inversa do cenário dele (registro
 * do upload legível primeiro, ilegível depois — o `--publish` do vertical,
 * um `--apply` manual ou outra máquina com a cópia do Drive atrasada), as
 * 06:00 presumidas (`edition_default`) sobrescreviam o `publishAt` real
 * (07:00) e o link da bio ia para o vídeo ainda privado das 06:00 às 07:00.
 * E o mesmo instante com e sem milissegundos contava como "mudou". Nenhum
 * teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LATEST_VIDEO_KV_KEY,
  effectiveLatestVideoRecord,
  parseLatestVideoRecord,
  sameLatestVideoPublicAt,
  shouldReplaceLatestVideo,
  type LatestVideoRecord,
} from "../scripts/lib/shared/latest-video-redirect.ts";
import { updateLatestVideoRedirect, type LatestVideoKv } from "../scripts/set-latest-video-redirect.ts";

const URL_OLD = "https://youtu.be/AAAAAAAAAAA";
const URL_NEW = "https://youtu.be/BBBBBBBBBBB";
const EDITION_0600 = "2026-11-12T09:00:00.000Z"; // 06:00 BRT de 261112 (presumido, `toISOString()`)
const API_0600 = "2026-11-12T09:00:00Z"; // o mesmo instante como a YouTube API devolve
const REAL_0700 = "2026-11-12T10:00:00Z"; // 07:00 BRT, o publishAt real (sem milissegundos)
const NIGHT_BEFORE = new Date("2026-11-12T01:30:00Z");
const AT_0630 = new Date("2026-11-12T09:30:00Z");

function fakeKv(initial: Record<string, string> = {}): LatestVideoKv & { store: Record<string, string>; puts: number } {
  const store = { ...initial };
  const kv = {
    store,
    puts: 0,
    get: async (k: string) => store[k] ?? null,
    put: async (k: string, v: string) => {
      kv.puts += 1;
      store[k] = v;
    },
  };
  return kv;
}

function edition(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "latest-video-fonte-12869-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "05-video-url.txt"), `${url}\n`);
  return dir;
}

function writeUpload(dir: string, content: string): void {
  writeFileSync(join(dir, "_internal", "05-youtube-published.json"), content);
}

const rec = (over: Partial<LatestVideoRecord> = {}): LatestVideoRecord => ({ url: URL_NEW, aammdd: "261112", updated_at: "", ...over });

describe("#12869: o public_at do upload nunca é rebaixado pelo presumido da edição", () => {
  it("ordem inversa: upload legível primeiro, ilegível depois → o 07:00 real fica no KV", async () => {
    const dir = edition(URL_NEW);
    try {
      const old: LatestVideoRecord = { url: URL_OLD, aammdd: "261111", updated_at: "2026-11-11T01:00:00.000Z" };
      const kv = fakeKv({ [LATEST_VIDEO_KV_KEY]: JSON.stringify(old) });
      writeUpload(dir, JSON.stringify({ videoId: "BBBBBBBBBBB", rereadStatus: { publishAt: REAL_0700 } }));
      const first = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(first.status, "written");
      const afterFirst = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(afterFirst?.public_at, REAL_0700);
      assert.equal(afterFirst?.public_at_source, "upload");

      writeUpload(dir, "{lixo de sync");
      const second = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(second.status, "unchanged", "o presumido não sobrescreve o real");
      assert.equal(kv.puts, 1, "nenhuma escrita na 2ª execução");
      const stored = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(stored?.public_at, REAL_0700);
      assert.equal(effectiveLatestVideoRecord(stored, AT_0630)?.url, URL_OLD, "às 06:30 o link da bio segue no anterior público");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upload na hora (sem publishAt) também não ganha as 06:00 presumidas depois", async () => {
    const dir = edition(URL_NEW);
    try {
      const kv = fakeKv();
      writeUpload(dir, JSON.stringify({ videoId: "BBBBBBBBBBB", rereadStatus: {} }));
      const first = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(first.status, "written");
      assert.equal(parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY])?.public_at_source, "upload_immediate");

      writeUpload(dir, "{lixo de sync");
      const second = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(second.status, "unchanged");
      assert.equal(parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY])?.public_at, undefined, "segue público na hora");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registro anterior ao #12869 (public_at sem fonte) não é rebaixado pelo presumido", async () => {
    const dir = edition(URL_NEW);
    try {
      const legacy: LatestVideoRecord = { url: URL_NEW, aammdd: "261112", updated_at: "", public_at: REAL_0700 };
      const kv = fakeKv({ [LATEST_VIDEO_KV_KEY]: JSON.stringify(legacy) });
      const out = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(out.status, "unchanged");
      assert.equal(kv.puts, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shouldReplaceLatestVideo: a fonte só sobe", () => {
    const def = rec({ public_at: EDITION_0600, public_at_source: "edition_default" });
    const up = rec({ public_at: REAL_0700, public_at_source: "upload" });
    assert.equal(shouldReplaceLatestVideo(up, def), false, "presumido não troca o do upload");
    assert.equal(shouldReplaceLatestVideo(def, up), true, "o do upload troca o presumido");
    assert.equal(shouldReplaceLatestVideo(rec({ public_at_source: "upload_immediate" }), def), false);
    assert.equal(shouldReplaceLatestVideo(rec(), def), true, "registro pré-#12801 (sem public_at) ganha o presumido");
    assert.equal(shouldReplaceLatestVideo(up, rec({ url: URL_OLD, aammdd: "261113", public_at_source: "edition_default" })), true, "edição nova não depende da fonte");
  });
});

describe("#12869: public_at compara como instante, não como texto", () => {
  it("sameLatestVideoPublicAt", () => {
    assert.equal(sameLatestVideoPublicAt(EDITION_0600, API_0600), true);
    assert.equal(sameLatestVideoPublicAt(EDITION_0600, REAL_0700), false);
    assert.equal(sameLatestVideoPublicAt(undefined, undefined), true);
    assert.equal(sameLatestVideoPublicAt(EDITION_0600, undefined), false);
  });

  it("mesmo instante com e sem milissegundos, mesma fonte: não troca", () => {
    const a = rec({ public_at: EDITION_0600, public_at_source: "upload" });
    const b = rec({ public_at: API_0600, public_at_source: "upload" });
    assert.equal(shouldReplaceLatestVideo(a, b), false);
    assert.equal(shouldReplaceLatestVideo(b, a), false);
  });

  it("mesmo instante, fonte melhor: grava para o registro proteger o valor", () => {
    const def = rec({ public_at: EDITION_0600, public_at_source: "edition_default" });
    const up = rec({ public_at: API_0600, public_at_source: "upload" });
    assert.equal(shouldReplaceLatestVideo(def, up), true);
  });

  it("upload com 06:00 sem milissegundos depois do presumido 06:00 .000Z: grava só a fonte, sem alternar", async () => {
    const dir = edition(URL_NEW);
    try {
      const kv = fakeKv();
      writeUpload(dir, "{lixo de sync");
      await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      writeUpload(dir, JSON.stringify({ videoId: "BBBBBBBBBBB", rereadStatus: { publishAt: API_0600 } }));
      const second = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(second.status, "written");
      assert.equal(parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY])?.public_at_source, "upload");
      const third = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(third.status, "unchanged", "o mesmo instante não conta como mudança");
      writeUpload(dir, "{lixo de sync");
      const fourth = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(fourth.status, "unchanged", "e o presumido não volta a gravar");
      assert.equal(kv.puts, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parseLatestVideoRecord descarta fonte desconhecida", () => {
    const raw = JSON.stringify({ url: URL_NEW, aammdd: "261112", updated_at: "", public_at: REAL_0700, public_at_source: "chute" });
    assert.equal(parseLatestVideoRecord(raw)?.public_at_source, undefined);
    const ok = JSON.stringify({ url: URL_NEW, aammdd: "261112", updated_at: "", public_at: REAL_0700, public_at_source: "upload" });
    assert.equal(parseLatestVideoRecord(ok)?.public_at_source, "upload");
  });
});
