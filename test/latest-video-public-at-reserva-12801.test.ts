/**
 * test/latest-video-public-at-reserva-12801.test.ts (#12801, resíduo)
 *
 * A PR #12822 fez o registro de `diar.ia.br/video` levar o `public_at` do
 * upload pela API. No caminho de reserva (o editor sobe o horizontal pelo
 * YouTube Studio e cola o link, `link-video-d1.ts --save`) não há
 * `_internal/05-youtube-published.json`: o registro saía sem `public_at` e o
 * link da bio ia para o vídeo ainda privado na noite de D-1. Agora, sem
 * registro do upload deste vídeo, o `public_at` presumido é 06:00 BRT do dia
 * da edição. Nenhum teste toca rede.
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
  type LatestVideoRecord,
} from "../scripts/lib/shared/latest-video-redirect.ts";
import { resolveEditionHorizontalPublicAt, updateLatestVideoRedirect, type LatestVideoKv } from "../scripts/set-latest-video-redirect.ts";

const URL_OLD = "https://youtu.be/AAAAAAAAAAA";
const URL_NEW = "https://youtu.be/BBBBBBBBBBB";
const EDITION_0600 = "2026-11-12T09:00:00.000Z"; // 06:00 BRT de 261112
const NIGHT_BEFORE = new Date("2026-11-12T01:30:00Z"); // 22:30 BRT de 261111
const AFTER_PUBLIC = new Date("2026-11-12T09:05:00Z");

function fakeKv(initial: Record<string, string> = {}): LatestVideoKv & { store: Record<string, string> } {
  const store = { ...initial };
  return { store, get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } };
}

function edition(url: string, upload?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "latest-video-reserva-12801-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "05-video-url.txt"), `${url}\n`);
  if (upload !== undefined) writeFileSync(join(dir, "_internal", "05-youtube-published.json"), typeof upload === "string" ? upload : JSON.stringify(upload));
  return dir;
}

describe("#12801 resíduo: caminho de reserva (upload pelo Studio, sem 05-youtube-published.json)", () => {
  it("cenário da issue: link colado na noite de D-1, o link da bio segue no anterior até 06:00 de D", async () => {
    const dir = edition(URL_NEW);
    try {
      const old: LatestVideoRecord = { url: URL_OLD, aammdd: "261111", updated_at: "2026-11-11T01:00:00.000Z" };
      const kv = fakeKv({ [LATEST_VIDEO_KV_KEY]: JSON.stringify(old) });
      const out = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(out.status, "written");
      const stored = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(stored?.url, URL_NEW);
      assert.equal(stored?.public_at, EDITION_0600, "sem registro do upload: 06:00 BRT da edição presumido");
      assert.deepEqual(stored?.previous, old);
      assert.equal(effectiveLatestVideoRecord(stored, NIGHT_BEFORE)?.url, URL_OLD, "antes de 06:00: o anterior, nunca o possivelmente privado");
      assert.equal(effectiveLatestVideoRecord(stored, AFTER_PUBLIC)?.url, URL_NEW, "depois de 06:00: o novo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sem horizontal anterior no KV: antes de 06:00 cai na lista do canal (null), nunca no novo", async () => {
    const dir = edition(URL_NEW);
    try {
      const kv = fakeKv();
      await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      const stored = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(effectiveLatestVideoRecord(stored, NIGHT_BEFORE), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("link colado depois das 06:00 de D: o default já passou, o novo vale na hora", async () => {
    const dir = edition(URL_NEW);
    try {
      const old: LatestVideoRecord = { url: URL_OLD, aammdd: "261111", updated_at: "" };
      const kv = fakeKv({ [LATEST_VIDEO_KV_KEY]: JSON.stringify(old) });
      await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: AFTER_PUBLIC });
      const stored = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(effectiveLatestVideoRecord(stored, AFTER_PUBLIC)?.url, URL_NEW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rodar de novo o mesmo link no caminho de reserva: unchanged (public_at determinístico)", async () => {
    const dir = edition(URL_NEW);
    try {
      const kv = fakeKv();
      await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      const again = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: AFTER_PUBLIC });
      assert.equal(again.status, "unchanged");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("resolveEditionHorizontalPublicAt: separa upload agendado, upload na hora e reserva", () => {
    const cases: Array<[string, unknown, { publicAt: string | null; source: string }]> = [
      ["upload agendado deste vídeo", { videoId: "BBBBBBBBBBB", rereadStatus: { publishAt: "2026-11-12T10:00:00.000Z" } }, { publicAt: "2026-11-12T10:00:00.000Z", source: "upload" }],
      ["upload na hora deste vídeo", { videoId: "BBBBBBBBBBB", requested: { privacyStatus: "public", publishAt: null } }, { publicAt: null, source: "upload_immediate" }],
      ["registro de outro vídeo (API subiu um, editor colou outro)", { videoId: "CCCCCCCCCCC", requested: { publishAt: "2026-11-12T09:00:00.000Z" } }, { publicAt: EDITION_0600, source: "edition_default" }],
      ["registro ilegível", "{lixo", { publicAt: EDITION_0600, source: "edition_default" }],
      ["sem registro", undefined, { publicAt: EDITION_0600, source: "edition_default" }],
    ];
    for (const [label, upload, expected] of cases) {
      const dir = edition(URL_NEW, upload);
      try {
        assert.deepEqual(resolveEditionHorizontalPublicAt(dir, URL_NEW, "261112"), expected, label);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("AAMMDD fora do calendário: sem horário a presumir, não lança", () => {
    const dir = edition(URL_NEW);
    try {
      assert.deepEqual(resolveEditionHorizontalPublicAt(dir, URL_NEW, "261131"), { publicAt: null, source: "edition_default" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
