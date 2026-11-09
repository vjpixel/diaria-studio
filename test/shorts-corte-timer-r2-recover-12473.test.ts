/**
 * test/shorts-corte-timer-r2-recover-12473.test.ts (#12473)
 *
 * Em 08/11/2026 o mp4 do corte `modelos-chatgpt-261108` não sincronizou pelo
 * OneDrive até o 300 (o `corte.json`, a capa e o registro sim) e o timer só
 * alarmou `missing-video`, embora o vídeo aprovado já estivesse no R2
 * (`shorts/cortes/{slug}.mp4`). Agora o timer baixa o objeto, confere o sha256
 * do "pode publicar" e publica; só alarma se o R2 não tiver o arquivo ou se o
 * hash divergir. Sem rede (fetch injetado), sem publicar nada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCorteTimerFor, type CorteTimerAlarmKey } from "../scripts/shorts-corte-timer.ts";
import { CORTE_SPEC_FILE, corteR2Key, parseCorteSpec, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "../scripts/lib/diaria/corte-content.ts";
import { recoverCorteFilesFromR2, type CorteR2RecoverDeps } from "../scripts/lib/diaria/corte-r2-recover.ts";
import { SHORT_COVER_FILE } from "../scripts/lib/diaria/short-cover.ts";
import { prepareCorteRun, recordCortePublishAuthorization } from "../scripts/publish-shorts.ts";

const BASE: CorteSpec = { slug: "modelos-chatgpt-261108", date: "261108", hhmm: "18:00", title: "Modelos do ChatGPT", hook: "Gancho.", video: "corte-modelos-chatgpt-261108.mp4" };
const AT = "2026-11-08T21:00:00.000Z"; // 18:00 BRT
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const CONFIG = {
  publishing: {
    shorts: {
      facebook_pages: ["diaria"],
      instagram: true,
      linkedin_profile: true,
      linkedin_page_repost: false,
      x: false,
      threads_profile: true,
      linkedin_profile_via_timer: true,
      threads_profile_via_timer: true,
      instagram_backend: "timer-300",
      instagram_api_max_seconds_by_account: { diaria: null },
      corte_via_timer: true,
    },
  },
};
const KNOWN = new Set(["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", "threads_profile"]);
const VIDEO = "mp4-aprovado";
const COVER = "jpg-aprovado";

/** Corte com vídeo e capa, autorizado no Neo; depois o "OneDrive" não traz o mp4 (apagado aqui). */
function corteSemVideo(opts: { cover?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "corte-12473-"));
  const dir = join(root, BASE.slug);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, BASE.video), VIDEO);
  if (opts.cover) writeFileSync(join(dir, SHORT_COVER_FILE), COVER);
  prepareCorteRun({ slug: BASE.slug, dir, values: { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) }, positionalDate: "", log: () => {} });
  recordCortePublishAuthorization(dir, "instagram,threads_profile", KNOWN, corteContentFingerprint(dir, readSpec(dir)), "2026-11-08T20:54:00.000Z", () => {});
  rmSync(join(dir, BASE.video));
  return dir;
}
const readSpec = (dir: string) => parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json");

/** R2 falso: responde o GET assinado pela chave do objeto. */
function fakeR2(objects: Record<string, string | number>): { deps: CorteR2RecoverDeps; urls: string[] } {
  const urls: string[] = [];
  const deps: CorteR2RecoverDeps = {
    config: { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "diaria-shorts" },
    now: () => new Date(AT),
    fetch: async (url, init) => {
      urls.push(url);
      assert.equal(init?.method, "GET");
      const key = decodeURIComponent(new URL(url).pathname.replace(/^\/diaria-shorts\//, ""));
      const obj = objects[key];
      if (obj === undefined) return new Response("NoSuchKey", { status: 404 });
      if (typeof obj === "number") return new Response("erro", { status: obj });
      return new Response(obj, { status: 200 });
    },
  };
  return { deps, urls };
}

type Alarm = { destination: string; key: CorteTimerAlarmKey; reason: string };
const runDeps = (r2: CorteR2RecoverDeps | { missing: string[] } | null, calls: string[][], alarms: Alarm[]) => ({
  config: CONFIG,
  now: at(10 * 60_000),
  runScript: (args: string[]) => {
    calls.push(args);
    const only = args[args.indexOf("--only") + 1].split(",");
    const results = only.map((destination) => ({ destination, ok: true, entry: { destination, status: "published", id: "p", at: AT } }));
    return { status: 0, stdout: JSON.stringify({ results }), stderr: "" };
  },
  notify: { cwd: "/nao-usado" },
  alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey, reason: string) => {
    alarms.push({ destination, key, reason });
    return true;
  },
  r2,
});

describe("#12473: o timer do corte recupera do R2 o vídeo que o OneDrive não trouxe", () => {
  it("cenário da issue: mp4 ausente, R2 com o aprovado → grava o arquivo e chama o publish-shorts, sem alarme", async () => {
    const dir = corteSemVideo();
    const { deps, urls } = fakeR2({ [corteR2Key(BASE.slug, "video")]: VIDEO });
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    const code = await runCorteTimerFor(dir, false, runDeps(deps, calls, alarms));
    assert.deepEqual(alarms, []);
    assert.equal(calls.length, 1, "publica depois de recuperar");
    assert.equal(readFileSync(join(dir, BASE.video), "utf8"), VIDEO);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/acc\.r2\.cloudflarestorage\.com\/diaria-shorts\/shorts\/cortes\/modelos-chatgpt-261108\.mp4$/, "API S3 assinada, nunca a URL pública");
    assert.equal(code, 0);
  });

  it("R2 com outro conteúdo (hash diverge): nada gravado, alarma missing-video com o motivo", async () => {
    const dir = corteSemVideo();
    const { deps } = fakeR2({ [corteR2Key(BASE.slug, "video")]: "mp4-de-outro-export" });
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, runDeps(deps, calls, alarms));
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(dir, BASE.video)), false, "bytes não aprovados nunca vão para a pasta do corte");
    assert.deepEqual(alarms.map((a) => a.key), ["missing-video", "missing-video"]);
    assert.match(alarms[0].reason, /não é o arquivo aprovado/);
  });

  it("objeto ausente no R2 (404) ou erro HTTP: alarma missing-video, como antes", async () => {
    for (const objects of [{}, { [corteR2Key(BASE.slug, "video")]: 503 }]) {
      const dir = corteSemVideo();
      const calls: string[][] = [];
      const alarms: Alarm[] = [];
      await runCorteTimerFor(dir, false, runDeps(fakeR2(objects).deps, calls, alarms));
      assert.equal(calls.length, 0);
      assert.deepEqual(alarms.map((a) => a.key), ["missing-video", "missing-video"]);
      assert.match(alarms[0].reason, /R2 shorts\/cortes\/modelos-chatgpt-261108\.mp4: (objeto não está no R2|R2 respondeu HTTP 503)/);
    }
  });

  it("sem os R2_* no .env: alarma missing-video dizendo o que falta", async () => {
    const dir = corteSemVideo();
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, runDeps({ missing: ["R2_ACCOUNT_ID"] }, [], alarms));
    assert.deepEqual(alarms.map((a) => a.key), ["missing-video", "missing-video"]);
    assert.match(alarms[0].reason, /sem acesso ao R2 para recuperar \(R2_ACCOUNT_ID\)/);
  });

  it("dry-run não baixa nada", async () => {
    const dir = corteSemVideo();
    const { deps, urls } = fakeR2({ [corteR2Key(BASE.slug, "video")]: VIDEO });
    await runCorteTimerFor(dir, true, runDeps(deps, [], []));
    assert.equal(urls.length, 0);
    assert.equal(existsSync(join(dir, BASE.video)), false);
  });

  it("capa aprovada ausente também sai do R2; vídeo presente não é baixado", async () => {
    const dir = corteSemVideo({ cover: true });
    writeFileSync(join(dir, BASE.video), VIDEO);
    rmSync(join(dir, SHORT_COVER_FILE));
    const { deps, urls } = fakeR2({ [corteR2Key(BASE.slug, "cover")]: COVER });
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, runDeps(deps, calls, alarms));
    assert.deepEqual(alarms, []);
    assert.equal(calls.length, 1);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /modelos-chatgpt-261108-cover\.jpg$/);
    assert.equal(readFileSync(join(dir, SHORT_COVER_FILE), "utf8"), COVER);
  });

  it("arquivo presente e diferente do aprovado nunca é sobrescrito pelo R2 (fica para o content-changed)", async () => {
    const dir = corteSemVideo();
    writeFileSync(join(dir, BASE.video), "re-export");
    const { deps, urls } = fakeR2({ [corteR2Key(BASE.slug, "video")]: VIDEO });
    const out = await recoverCorteFilesFromR2(dir, readSpec(dir), deps);
    assert.deepEqual([out, urls], [[], []]);
    assert.equal(readFileSync(join(dir, BASE.video), "utf8"), "re-export");
  });

  it("sem deps.r2 (os testes antigos e quem não passa acesso): comportamento de antes, sem rede", async () => {
    const dir = corteSemVideo();
    const alarms: Alarm[] = [];
    await runCorteTimerFor(dir, false, runDeps(null, [], alarms));
    assert.deepEqual(alarms.map((a) => a.key), ["missing-video", "missing-video"]);
    assert.doesNotMatch(alarms[0].reason, /R2/);
  });
});
