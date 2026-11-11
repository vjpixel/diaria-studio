/**
 * test/latest-video-public-at-12801.test.ts (#12801)
 *
 * `diar.ia.br/video` (link fixo da bio) apontava para o horizontal da edição
 * assim que o `publish-shorts --publish` rodava na noite de D-1, mas o
 * horizontal sobe `private` com `publishAt` às 06:00 BRT de D: por ~8h o link
 * levava a "vídeo privado". Agora o registro guarda `public_at` e o
 * horizontal anterior (`previous`), e o Worker só serve o novo depois do
 * `public_at`. Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LATEST_VIDEO_FALLBACK_URL,
  LATEST_VIDEO_KV_KEY,
  effectiveLatestVideoRecord,
  parseLatestVideoRecord,
  type LatestVideoRecord,
} from "../scripts/lib/shared/latest-video-redirect.ts";
import { previousForNewRecord, readEditionHorizontalPublicAt, updateLatestVideoRedirect, type LatestVideoKv } from "../scripts/set-latest-video-redirect.ts";
import worker from "../workers/site/src/index.ts";
import type { Env } from "../workers/site/src/index.ts";

const URL_OLD = "https://youtu.be/AAAAAAAAAAA";
const URL_NEW = "https://youtu.be/BBBBBBBBBBB";
const PUBLIC_AT = "2026-11-12T09:00:00.000Z"; // 06:00 BRT de 261112
const NIGHT_BEFORE = new Date("2026-11-12T01:30:00Z"); // 22:30 BRT de 261111
const AFTER_PUBLIC = new Date("2026-11-12T09:05:00Z");

function fakeKv(initial: Record<string, string> = {}): LatestVideoKv & { store: Record<string, string> } {
  const store = { ...initial };
  return { store, get: async (k) => store[k] ?? null, put: async (k, v) => { store[k] = v; } };
}

function edition(url: string, upload?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "latest-video-12801-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, "_internal", "05-video-url.txt"), `${url}\n`);
  if (upload !== undefined) writeFileSync(join(dir, "_internal", "05-youtube-published.json"), typeof upload === "string" ? upload : JSON.stringify(upload));
  return dir;
}

const scheduledUpload = (videoId: string) => ({
  videoId,
  requested: { privacyStatus: "private", publishAt: PUBLIC_AT },
  rereadStatus: { privacyStatus: "private", publishAt: PUBLIC_AT },
});

describe("#12801 diar.ia.br/video não aponta para horizontal ainda privado", () => {
  it("cenário da issue: gravado na noite de D-1, o link segue no horizontal anterior até 06:00 de D", async () => {
    const dir = edition(URL_NEW, scheduledUpload("BBBBBBBBBBB"));
    try {
      const old: LatestVideoRecord = { url: URL_OLD, aammdd: "261111", updated_at: "2026-11-11T01:00:00.000Z" };
      const kv = fakeKv({ [LATEST_VIDEO_KV_KEY]: JSON.stringify(old) });
      const out = await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      assert.equal(out.status, "written");
      const stored = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(stored?.url, URL_NEW);
      assert.equal(stored?.public_at, PUBLIC_AT);
      assert.deepEqual(stored?.previous, old);
      assert.equal(effectiveLatestVideoRecord(stored, NIGHT_BEFORE)?.url, URL_OLD, "antes de 06:00: o anterior, nunca o privado");
      assert.equal(effectiveLatestVideoRecord(stored, AFTER_PUBLIC)?.url, URL_NEW, "depois de 06:00: o novo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Worker: antes do public_at redireciona pro anterior; sem anterior, pra lista do canal", async () => {
    const env = (record: unknown): Env =>
      ({
        ASSETS: { fetch: async () => new Response("asset") },
        POLL: { get: async (k: string) => (k === LATEST_VIDEO_KV_KEY ? (new TextEncoder().encode(JSON.stringify(record)).buffer as ArrayBuffer) : null) },
      }) as unknown as Env;
    const far = "2999-01-01T09:00:00.000Z";
    const withPrev = { url: URL_NEW, aammdd: "261112", updated_at: "", public_at: far, previous: { url: URL_OLD, aammdd: "261111", updated_at: "" } };
    let res = await worker.fetch(new Request("https://diar.ia.br/video?utm_source=tiktok"), env(withPrev));
    assert.equal(res.status, 302);
    const loc = new URL(res.headers.get("Location") ?? "");
    assert.equal(loc.origin + loc.pathname, URL_OLD);
    assert.equal(loc.searchParams.get("utm_source"), "tiktok");
    res = await worker.fetch(new Request("https://diar.ia.br/video"), env({ url: URL_NEW, aammdd: "261112", updated_at: "", public_at: far }));
    assert.equal(res.headers.get("Location"), LATEST_VIDEO_FALLBACK_URL);
    res = await worker.fetch(new Request("https://diar.ia.br/video"), env({ ...withPrev, public_at: "2020-01-01T09:00:00.000Z" }));
    assert.equal(res.headers.get("Location"), URL_NEW, "public_at no passado: o novo");
  });

  it("readEditionHorizontalPublicAt: só o publishAt do registro DESTE vídeo", () => {
    const cases: Array<[unknown, string | null]> = [
      [scheduledUpload("BBBBBBBBBBB"), PUBLIC_AT],
      [{ videoId: "BBBBBBBBBBB", requested: { publishAt: PUBLIC_AT } }, PUBLIC_AT],
      [{ videoId: "BBBBBBBBBBB", requested: { privacyStatus: "public", publishAt: null } }, null],
      [scheduledUpload("CCCCCCCCCCC"), null],
      ["{lixo", null],
    ];
    for (const [upload, expected] of cases) {
      const dir = edition(URL_NEW, upload);
      try {
        assert.equal(readEditionHorizontalPublicAt(dir, URL_NEW), expected, JSON.stringify(upload));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    const semRegistro = edition(URL_NEW);
    try {
      assert.equal(readEditionHorizontalPublicAt(semRegistro, URL_NEW), null);
    } finally {
      rmSync(semRegistro, { recursive: true, force: true });
    }
  });

  it("previousForNewRecord: um nível só; atual ainda privado cede o próprio anterior; mesma edição mantém", () => {
    const older = { url: URL_OLD, aammdd: "261110", updated_at: "" };
    const pending: LatestVideoRecord = { url: URL_NEW, aammdd: "261111", updated_at: "", public_at: PUBLIC_AT, previous: older };
    assert.equal(previousForNewRecord(null, "261112", NIGHT_BEFORE), null);
    assert.deepEqual(previousForNewRecord(pending, "261112", NIGHT_BEFORE), older, "atual ainda privado não vira anterior");
    const prevAfter = previousForNewRecord(pending, "261112", AFTER_PUBLIC);
    assert.equal(prevAfter?.url, URL_NEW);
    assert.equal("previous" in (prevAfter ?? {}), false, "sem previous aninhado");
    assert.deepEqual(previousForNewRecord(pending, "261111", AFTER_PUBLIC), older, "reupload da mesma edição");
  });

  it("parseLatestVideoRecord: public_at ilegível e previous inválido são descartados sem invalidar o registro", () => {
    const r = parseLatestVideoRecord(JSON.stringify({ url: URL_NEW, aammdd: "261112", updated_at: "", public_at: "amanhã", previous: { url: "https://evil.example/x", aammdd: "261111" } }));
    assert.deepEqual(r, { url: URL_NEW, aammdd: "261112", updated_at: "" });
    assert.equal(effectiveLatestVideoRecord(r, NIGHT_BEFORE)?.url, URL_NEW);
  });

  it("upload na hora (sem publishAt): grava sem public_at, o link vale já", async () => {
    const dir = edition(URL_NEW, { videoId: "BBBBBBBBBBB", requested: { privacyStatus: "public", publishAt: null } });
    try {
      const kv = fakeKv();
      await updateLatestVideoRedirect({ editionDir: dir, aammdd: "261112", kv, apply: true, now: NIGHT_BEFORE });
      const stored = parseLatestVideoRecord(kv.store[LATEST_VIDEO_KV_KEY]);
      assert.equal(stored?.public_at, undefined);
      assert.equal(effectiveLatestVideoRecord(stored, NIGHT_BEFORE)?.url, URL_NEW);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
