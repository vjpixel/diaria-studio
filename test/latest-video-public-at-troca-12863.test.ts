/**
 * test/latest-video-public-at-troca-12863.test.ts (#12863)
 *
 * Mesma edição e mesmo link, `public_at` diferente: antes o `unchanged`
 * falhava, mas `shouldReplaceLatestVideo` só comparava `aammdd` e `url` e o
 * registro novo saía como `older` (com o log dizendo que a edição era "mais
 * nova que" ela mesma). Cenário real: o registro do upload ilegível de
 * passagem (sync do Drive) grava as 06:00 presumidas; quando fica legível, o
 * `publishAt` real (07:00) precisa entrar no KV, senão o Worker serve o vídeo
 * ainda privado das 06:00 às 07:00. Idem para registro anterior ao #12801,
 * sem `public_at`. Nenhum teste toca rede.
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
  shouldReplaceLatestVideo,
  type LatestVideoRecord,
} from "../scripts/lib/shared/latest-video-redirect.ts";
import { describeLatestVideoOutcome, updateLatestVideoRedirect, type LatestVideoKv } from "../scripts/set-latest-video-redirect.ts";

const URL_OLD = "https://youtu.be/AAAAAAAAAAA";
const URL_NEW = "https://youtu.be/BBBBBBBBBBB";
const EDITION_0600 = "2026-11-12T09:00:00.000Z"; // 06:00 BRT de 261112 (presumido)
const REAL_0700 = "2026-11-12T10:00:00.000Z"; // 07:00 BRT, o publishAt real
const NIGHT_BEFORE = new Date("2026-11-12T01:30:00Z");
const AT_0630 = new Date("2026-11-12T09:30:00Z");

function fakeKv(initial: Record<string, string> = {}): LatestVideoKv & { store: Record<string, string> } {
  const store = { ...initial };
  return { store, get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } };
}

function edition(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "latest-video-troca-12863-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "05-video-url.txt"), `${url}\n`);
  return dir;
}

function writeUpload(dir: string, content: string): void {
  writeFileSync(join(dir, "_internal", "05-youtube-published.json"), content);
}

const rec = (over: Partial<LatestVideoRecord> = {}): LatestVideoRecord => ({ url: URL_NEW, aammdd: "261112", updated_at: "", ...over });

describe("#12863: mesma edição e link, public_at novo troca o registro", () => {
  it("shouldReplaceLatestVideo: public_at diferente na mesma edição e link troca", () => {
    assert.equal(shouldReplaceLatestVideo(rec({ public_at: EDITION_0600 }), rec({ public_at: REAL_0700 })), true, "06:00 presumido → 07:00 real");
    assert.equal(shouldReplaceLatestVideo(rec(), rec({ public_at: REAL_0700 })), true, "registro pré-#12801 sem public_at");
    assert.equal(shouldReplaceLatestVideo(rec({ public_at: REAL_0700 }), rec({ public_at: REAL_0700 })), false, "nada mudou");
    assert.equal(shouldReplaceLatestVideo(rec({ aammdd: "261113" }), rec({ public_at: REAL_0700 })), false, "edição anterior segue sem voltar o link");
  });

  it("cenário da issue: registro do upload ilegível de passagem, depois legível com 07:00", async () => {
    const dir = edition(URL_NEW);
    try {
      const old: LatestVideoRecord = { url: URL_OLD, aammdd: "261111", updated_at: "2026-11-11T01:00:00.000Z" };
      const kv = fakeKv({ [LATEST_VIDEO_KV_KEY]: JSON.stringify(old) });
      writeUpload(dir, "{lixo de sync");
      const first = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(first.status, "written");
      assert.equal(parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY])?.public_at, EDITION_0600);

      writeUpload(dir, JSON.stringify({ videoId: "BBBBBBBBBBB", rereadStatus: { publishAt: REAL_0700 } }));
      const second = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(second.status, "written", "o publishAt real entra no KV, não sai como older");
      const stored = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(stored?.public_at, REAL_0700);
      assert.deepEqual(stored?.previous, old, "o anterior segue guardado para a janela até as 07:00");
      assert.equal(effectiveLatestVideoRecord(stored, AT_0630)?.url, URL_OLD, "às 06:30 o link da bio não vai para o vídeo ainda privado");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registro pré-#12801 (sem public_at) da mesma edição e link ganha o public_at", async () => {
    const dir = edition(URL_NEW);
    try {
      const legacy: LatestVideoRecord = { url: URL_NEW, aammdd: "261112", updated_at: "2026-11-12T01:00:00.000Z" };
      const kv = fakeKv({ [LATEST_VIDEO_KV_KEY]: JSON.stringify(legacy) });
      const out = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(out.status, "written");
      assert.equal(parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY])?.public_at, EDITION_0600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("log do older nunca diz que a edição é mais nova que ela mesma", () => {
    const sameEdition = describeLatestVideoOutcome({ status: "older", record: rec(), current: rec() });
    assert.doesNotMatch(sameEdition, /mais nova que 261112/);
    const olderEdition = describeLatestVideoOutcome({ status: "older", record: rec({ aammdd: "261111" }), current: rec() });
    assert.match(olderEdition, /edição 261112, mais nova que 261111/);
  });
});
