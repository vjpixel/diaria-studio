/**
 * test/video-d1-link-watch-10941.test.ts (#10941, item 1)
 *
 * A task `Diaria-Video-D1-Link-Watch` precisa:
 *   - reler o estado do vídeo pela API até `published` ou o prazo, e só então
 *     gravar `_internal/05-video-url.txt` (sem `--assume-public`);
 *   - aplicar o plano no Facebook (editar agendado / comentar publicado) e
 *     deixar LinkedIn/X/Threads como `manual`;
 *   - nunca repetir um destino já aplicado, nunca sobrescrever link de outro
 *     vídeo, e não gravar nada em `--dry-run`;
 *   - estar registrada (desarmada) no inventário de tasks agendadas.
 * Toda rede é mock — nenhuma chamada real ao YouTube ou à Graph API.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VIDEO_LINK_APPLY_FILE,
  deadlineForEdition,
  runVideoD1LinkWatch,
  type VideoD1WatchDeps,
  type VideoD1WatchInput,
} from "../scripts/lib/diaria/video-d1-link-watch.ts";
import { D1_VIDEO_URL_FILE } from "../scripts/lib/diaria/d1-video-link.ts";
import { getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import { buildNotPublishedAlarm } from "../scripts/video-d1-link-watch.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_ID = "abcdefghijk";
const VIDEO_URL = `https://youtu.be/${VIDEO_ID}`;
const FB_POST_ID = "111_222";
const CREDS = { clientId: "cid", clientSecret: "sec", refreshToken: "rt", channelId: "UC1" };
const FB = { pageId: "111", token: "pagetoken", apiVersion: "v25.0" };

function makeEdition(opts: { record?: boolean; social?: unknown[]; urlFile?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "video-d1-watch-"));
  mkdirSync(join(dir, "_internal"), { recursive: true });
  if (opts.record !== false) {
    writeFileSync(
      join(dir, "_internal", "05-youtube-published.json"),
      JSON.stringify({ videoId: VIDEO_ID, url: `https://www.youtube.com/watch?v=${VIDEO_ID}`, state: "draft" }),
    );
  }
  if (opts.social) writeFileSync(join(dir, "_internal", "06-social-published.json"), JSON.stringify({ posts: opts.social }));
  if (opts.urlFile) writeFileSync(join(dir, D1_VIDEO_URL_FILE), opts.urlFile);
  return dir;
}

interface Call {
  url: string;
  method: string;
  body: string | null;
}

/**
 * fetch mock: devolve, por leitura de status, o próximo `privacyStatus` da
 * fila (o último se repete) e simula a Graph API com uma mensagem mutável.
 */
function makeFetch(privacy: string[], fbMessage: string | null = "Texto do D1\n\nLeia: https://diar.ia.br/p/x") {
  const calls: Call[] = [];
  let reads = 0;
  let message = fbMessage;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body = init?.body == null ? null : String(init.body);
    calls.push({ url, method, body });
    const json = (o: unknown, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "at" });
    if (url.includes("/youtube/v3/videos")) {
      const p = privacy[Math.min(reads, privacy.length - 1)];
      reads += 1;
      return json({ items: [{ id: VIDEO_ID, status: { uploadStatus: "processed", privacyStatus: p } }] });
    }
    if (url.includes("graph.facebook.com")) {
      if (method === "GET") return json(message == null ? { id: FB_POST_ID } : { id: FB_POST_ID, message });
      if (url.endsWith("/comments")) return json({ id: "c_1" });
      const m = new URLSearchParams(body ?? "").get("message");
      if (m) message = m;
      return json({ success: true });
    }
    throw new Error(`url inesperada no mock: ${url}`);
  };
  return { fetch, calls };
}

function makeDeps(fetch: VideoD1WatchDeps["fetch"], start = "2026-10-23T09:05:00.000Z") {
  let t = Date.parse(start);
  const logs: string[] = [];
  const deps: VideoD1WatchDeps = {
    fetch,
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
    log: (m) => logs.push(m),
  };
  return { deps, logs };
}

function input(dir: string, over: Partial<VideoD1WatchInput> = {}): VideoD1WatchInput {
  return {
    aammdd: "261023",
    editionDir: dir,
    deadline: deadlineForEdition("261023") as Date,
    intervalMs: 5 * 60 * 1000,
    youtubeCreds: CREDS,
    facebook: FB,
    ...over,
  };
}

const fbScheduled = (at: string) => ({
  platform: "facebook",
  destaque: "d1",
  status: "scheduled",
  scheduled_at: at,
  url: `https://www.facebook.com/111/posts/${FB_POST_ID}`,
  fb_post_id: FB_POST_ID,
});
const linkedinScheduled = {
  platform: "linkedin",
  destaque: "d1",
  status: "scheduled",
  scheduled_at: "2026-10-23T12:45:00.000Z",
  url: null,
};

describe("#10941 — deadlineForEdition", () => {
  it("10:00 BRT do dia da edição", () => {
    assert.equal(deadlineForEdition("261023")?.toISOString(), "2026-10-23T13:00:00.000Z");
  });
  it("entrada inválida → null", () => {
    assert.equal(deadlineForEdition("2610"), null);
    assert.equal(deadlineForEdition("261023", "10h"), null);
  });
});

describe("#10941 — runVideoD1LinkWatch", () => {
  it("edição inexistente → sem-edicao, sem rede", async () => {
    const { fetch, calls } = makeFetch(["public"]);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(join(tmpdir(), "nao-existe-10941")));
    assert.equal(out.status, "sem-edicao");
    assert.equal(calls.length, 0);
  });

  it("sem registro do upload → sem-video, sem rede e sem arquivo", async () => {
    const dir = makeEdition({ record: false });
    const { fetch, calls } = makeFetch(["public"]);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir));
    assert.equal(out.status, "sem-video");
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(dir, D1_VIDEO_URL_FILE)), false);
  });

  it("credenciais do YouTube ausentes → credenciais-ausentes, nada gravado", async () => {
    const dir = makeEdition();
    const { fetch, calls } = makeFetch(["public"]);
    const out = await runVideoD1LinkWatch(
      makeDeps(fetch).deps,
      input(dir, { youtubeCreds: null, missingYoutubeCreds: ["YOUTUBE_REFRESH_TOKEN"] }),
    );
    assert.equal(out.status, "credenciais-ausentes");
    assert.match(out.detail, /YOUTUBE_REFRESH_TOKEN/);
    assert.equal(calls.length, 0);
    assert.equal(existsSync(join(dir, D1_VIDEO_URL_FILE)), false);
  });

  it("privado → público: relê até published, grava o link e edita o post agendado do Facebook", async () => {
    const dir = makeEdition({ social: [fbScheduled("2026-10-23T15:15:00.000Z"), linkedinScheduled] });
    const { fetch, calls } = makeFetch(["private", "private", "public"]);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir));
    assert.equal(out.status, "aplicado");
    if (out.status !== "aplicado") return;
    assert.equal(calls.filter((c) => c.url.includes("/youtube/v3/videos")).length, 3);
    assert.equal(readFileSync(join(dir, D1_VIDEO_URL_FILE), "utf8"), `${VIDEO_URL}\n`);
    assert.equal(out.urlFileWritten, true);

    const fb = out.results.find((r) => r.destination === "facebook");
    assert.equal(fb?.action, "edit_scheduled");
    assert.equal(fb?.status, "applied");
    const edit = calls.find((c) => c.method === "POST" && c.url.includes("graph.facebook.com"));
    assert.ok(edit && !edit.url.endsWith("/comments"), "edição vai no próprio post, não em /comments");
    assert.match(new URLSearchParams(edit!.body ?? "").get("message") ?? "", /Assista no YouTube: https:\/\/youtu\.be\/abcdefghijk/);

    const li = out.results.find((r) => r.destination === "linkedin");
    assert.equal(li?.status, "manual");
    assert.equal(li?.action, "comment_after");
    assert.equal(out.results.find((r) => r.destination === "twitter")?.status, "skipped");
    assert.deepEqual(out.pending.map((p) => p.destination), ["linkedin"]);

    const state = JSON.parse(readFileSync(join(dir, VIDEO_LINK_APPLY_FILE), "utf8"));
    assert.equal(state.video_url, VIDEO_URL);
    assert.equal(state.destinations.facebook.status, "applied");
  });

  it("vídeo nunca público até o prazo → nao-publicado, sem gravar nem chamar a Graph API", async () => {
    const dir = makeEdition({ social: [fbScheduled("2026-10-23T15:15:00.000Z")] });
    const { fetch, calls } = makeFetch(["private"]);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir));
    assert.equal(out.status, "nao-publicado");
    if (out.status !== "nao-publicado") return;
    assert.equal(out.lastState, "draft");
    // 09:05Z → 13:00Z a cada 5 min: 47 esperas + a leitura no prazo.
    assert.equal(out.attempts, 48);
    assert.equal(existsSync(join(dir, D1_VIDEO_URL_FILE)), false);
    assert.equal(calls.some((c) => c.url.includes("graph.facebook.com")), false);
    assert.match(buildNotPublishedAlarm("261023", out).body, /Publique no YouTube Studio/);
  });

  it("falha de rede numa leitura não derruba a vigília — vira nova tentativa", async () => {
    const dir = makeEdition();
    const base = makeFetch(["public"]);
    let failed = false;
    const fetch: VideoD1WatchDeps["fetch"] = async (url, init) => {
      if (!failed && url.includes("/youtube/v3/videos")) {
        failed = true;
        throw new Error("ECONNRESET");
      }
      return base.fetch(url, init);
    };
    const { deps, logs } = makeDeps(fetch);
    const out = await runVideoD1LinkWatch(deps, input(dir));
    assert.equal(out.status, "aplicado");
    assert.ok(logs.some((l) => /leitura 1: falhou/.test(l)));
  });

  it("post do Facebook já publicado → comenta; rodar de novo não comenta outra vez", async () => {
    const published = { ...fbScheduled("2026-10-23T08:00:00.000Z"), status: "published" };
    const dir = makeEdition({ social: [published] });
    const first = makeFetch(["public"]);
    const out = await runVideoD1LinkWatch(makeDeps(first.fetch).deps, input(dir));
    assert.equal(out.status, "aplicado");
    const comments = first.calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments"));
    assert.equal(comments.length, 1);
    assert.equal(new URLSearchParams(comments[0].body ?? "").get("message"), `Assista no YouTube: ${VIDEO_URL}`);

    const second = makeFetch(["public"]);
    const again = await runVideoD1LinkWatch(makeDeps(second.fetch).deps, input(dir));
    assert.equal(again.status, "aplicado");
    assert.equal(second.calls.filter((c) => c.method === "POST" && c.url.includes("graph.facebook.com")).length, 0, "destino já applied não repete");
    if (again.status === "aplicado") assert.equal(again.results.find((r) => r.destination === "facebook")?.status, "applied");
  });

  it("Graph API recusa o comentário → failed com o motivo, sem lançar", async () => {
    const published = { ...fbScheduled("2026-10-23T08:00:00.000Z"), status: "published" };
    const dir = makeEdition({ social: [published] });
    const base = makeFetch(["public"]);
    const fetch: VideoD1WatchDeps["fetch"] = async (url, init) => {
      if (url.endsWith("/comments")) {
        return new Response(JSON.stringify({ error: { message: "(#200) pages_manage_engagement" } }), { status: 403 });
      }
      return base.fetch(url, init);
    };
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir));
    assert.equal(out.status, "aplicado");
    if (out.status !== "aplicado") return;
    const fb = out.results.find((r) => r.destination === "facebook");
    assert.equal(fb?.status, "failed");
    assert.match(fb?.detail ?? "", /403.*pages_manage_engagement/);
    assert.ok(out.pending.some((p) => p.destination === "facebook"));
  });

  it("texto do post agendado já leva o link → already_in_post, sem editar", async () => {
    const dir = makeEdition({ social: [fbScheduled("2026-10-23T15:15:00.000Z")] });
    const { fetch, calls } = makeFetch(["public"], `Texto\n\nAssista no YouTube: ${VIDEO_URL}`);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir));
    assert.equal(out.status, "aplicado");
    if (out.status !== "aplicado") return;
    assert.equal(out.results.find((r) => r.destination === "facebook")?.status, "skipped");
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("graph.facebook.com")).length, 0);
  });

  it("05-video-url.txt de OUTRO vídeo → conflito, nada alterado e sem rede", async () => {
    const dir = makeEdition({ urlFile: "https://youtu.be/zzzzzzzzzzz\n" });
    const { fetch, calls } = makeFetch(["public"]);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir));
    assert.equal(out.status, "conflito");
    assert.equal(calls.length, 0);
    assert.equal(readFileSync(join(dir, D1_VIDEO_URL_FILE), "utf8"), "https://youtu.be/zzzzzzzzzzz\n");
  });

  it("--dry-run: relê, mas não grava arquivo nem chama a Graph API para escrever", async () => {
    const dir = makeEdition({ social: [fbScheduled("2026-10-23T15:15:00.000Z")] });
    const { fetch, calls } = makeFetch(["public"]);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir, { dryRun: true }));
    assert.equal(out.status, "aplicado");
    assert.equal(existsSync(join(dir, D1_VIDEO_URL_FILE)), false);
    assert.equal(existsSync(join(dir, VIDEO_LINK_APPLY_FILE)), false);
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("graph.facebook.com")).length, 0);
  });

  it("sem credencial do Facebook → facebook manual, link gravado assim mesmo", async () => {
    const dir = makeEdition({ social: [fbScheduled("2026-10-23T15:15:00.000Z")] });
    const { fetch } = makeFetch(["public"]);
    const out = await runVideoD1LinkWatch(makeDeps(fetch).deps, input(dir, { facebook: null }));
    assert.equal(out.status, "aplicado");
    if (out.status !== "aplicado") return;
    assert.equal(out.results.find((r) => r.destination === "facebook")?.status, "manual");
    assert.equal(existsSync(join(dir, D1_VIDEO_URL_FILE)), true);
  });
});

describe("#10941 — registro da task", () => {
  const task = getScheduledTaskByName("Diaria-Video-D1-Link-Watch");

  it("registrada, diária 06:05, apontando pro script, desarmada", () => {
    assert.ok(task, "task ausente de SCHEDULED_TASKS");
    assert.deepEqual(task!.schedule, { kind: "daily", hour: 6, minute: 5 });
    assert.equal(task!.steps[0].script, "scripts/video-d1-link-watch.ts");
    assert.equal(task!.enabled, false, "não armar no PR — arme é ação do editor no 300");
    assert.ok(existsSync(join(ROOT, "scripts", "video-d1-link-watch.ts")));
  });

  it("doc de arme existe e o registro em prosa cita a task", () => {
    assert.ok(existsSync(join(ROOT, "docs", "video-d1-link-watch-setup.md")));
    assert.match(readFileSync(join(ROOT, "docs", "scheduled-tasks-registry.md"), "utf8"), /Diaria-Video-D1-Link-Watch/);
  });
});
