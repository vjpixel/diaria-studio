/**
 * test/publish-shorts-instagram-video-url-11355.test.ts
 *
 * #11355: o rupload do Reels processa de forma síncrona e a Meta encerra a
 * requisição em ~32,5 s (23 casos em 01/11/2026), o que recusa todo vertical
 * real. A rota `video_url` deu 6/6 FINISHED de 45 a 75 s na @diar.ia.br. Por
 * isso a conta deixa de ter teto e cria o container com a URL do R2. Substitui
 * a trava do teto de 30 s (#11281), revogado aqui. Nenhum teste toca rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { instagramApiMaxSecondsPremise, instagramReelUploadRoute, loadInstagramApiMaxSeconds, resolveInstagramApiMaxSeconds, shortInstagramVideoFileName, shortVideoFileName, type ShortPublishedEntry, type ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import { etagConflictsBody, R2_RETENTION_POLICIES, uploadToR2 } from "../scripts/lib/r2-object-upload.ts";
import {
  credentialSkippedItems,
  instagramPublishRecheck,
  instagramR2VideoKey,
  instagramReelRouteChoice,
  instagramReelVideoUrl,
  planShortsPublish,
  publicVideoUnavailableCause,
  publicVideoUnavailableReason,
  publishInstagramReel,
  resolveInstagramReelInputs,
  type GraphDeps,
  type ShortsPlanInput,
} from "../scripts/publish-shorts.ts";
import { alarmSeverity, alarmSuppressed, buildInstagramTimerAlarm, interpretInstagramTimerOutput } from "../scripts/shorts-instagram-timer.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const realConfig = JSON.parse(readFileSync(join(root, "platform.config.json"), "utf8"));
const realShorts = realConfig.publishing.shorts;

const SCHEDULE = { rotation_times: ["12:00", "19:00"], rotation_start: "2026-10-22", rotation_end: "2026-11-04", default_time: "12:00" };

function planDiaria(extra: Partial<ShortsPlanInput> = {}, authorPage: string | null = null) {
  return planShortsPublish({
    aammdd: "261102",
    reviewedMd: "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque. Segunda frase.\n",
    now: new Date("2026-11-02T15:05:00Z"),
    config: {
      publishing: {
        shorts: {
          schedule: SCHEDULE,
          facebook_pages: [],
          instagram: true,
          instagram_author_page: authorPage,
          instagram_collaborators: ["vjpixel"],
          instagram_api_max_seconds_by_account: realShorts.instagram_api_max_seconds_by_account,
        },
      },
    },
    pages: [],
    instagramReady: true,
    writer: "instagram-timer",
    forceNow: true,
    publicVideo: { ready: true },
    published: { aammdd: "261102", entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 181_000_000 },
    videoDurationSeconds: 75,
    editionUrl: "https://diar.ia.br/p/x",
    ...extra,
  });
}

/** Graph falsa: responde pela URL e guarda as chamadas. Qualquer rupload é erro. */
function fakeGraph(statuses: string[] = ["IN_PROGRESS", "FINISHED"]) {
  const calls: { url: string; body: Record<string, string> | null }[] = [];
  const sleeps: number[] = [];
  let poll = 0;
  const deps: GraphDeps = {
    fetch: async (url, init) => {
      assert.doesNotMatch(url, /rupload/, "a rota video_url não pode chamar o rupload");
      const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null;
      calls.push({ url, body });
      let json: unknown = {};
      if (url.includes("/media_publish")) json = { id: "m1" };
      else if (url.endsWith("/ig/media")) json = { id: "c1" };
      else if (url.includes("/c1?") || url.endsWith("/c1")) json = { status_code: statuses[poll++], status: "motivo" };
      else if (url.includes("/m1/collaborators")) json = { data: [{ username: "vjpixel", invite_status: "Pending" }] };
      else if (url.includes("/m1")) json = { permalink: "https://instagram.com/reel/m1" };
      return new Response(JSON.stringify(json), { status: 200 });
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date("2026-11-02T15:05:00Z"),
    log: () => {},
  };
  return { deps, calls, sleeps };
}

describe("#11355 plano", () => {
  it("regressão: vertical de 75 s na conta diaria planeja api, não passo guiado", () => {
    const ig = planDiaria().items.find((i) => i.destination === "instagram")!;
    assert.equal(ig.action, "publish");
    assert.equal(ig.mode, "api");
  });

  it("config real: @diar.ia.br sem teto e @vjpixel com os 40 s de sempre, e a nota registra a medição", () => {
    assert.equal(loadInstagramApiMaxSeconds(realConfig, null), null);
    assert.equal(loadInstagramApiMaxSeconds(realConfig, "vjpixel"), 40);
    assert.match(realShorts.instagram_api_max_seconds_note, /#11355/);
    assert.match(realShorts.instagram_api_max_seconds_note, /01\/11\/2026/);
  });

  it("sem R2 a conta diaria não tenta publicar: skip com o motivo, que o timer lê como alarme", () => {
    const p = planDiaria({ publicVideo: { ready: false, reason: "faltam os secrets" } });
    const ig = p.items.find((i) => i.destination === "instagram")! as { action: string; detail: string };
    assert.equal(ig.action, "skip_missing_credentials");
    assert.match(ig.detail, /video_url.*faltam os secrets/);
  });

  it("sem R2 o alarme cita o R2, não o token do Instagram, e não diz 'fica pendente'", () => {
    const reason = publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID"]);
    const cause = publicVideoUnavailableCause("timer-300", ["R2_ACCOUNT_ID"]);
    assert.match(reason, /fica pendente/, "X e Threads seguem com o aviso do #11498");
    const p = planDiaria({ publicVideo: { ready: false, reason, cause } });
    const ig = p.items.find((i) => i.destination === "instagram")!;
    assert.equal((ig as { cause?: string }).cause, "public_video");
    assert.deepEqual(credentialSkippedItems(p.items).filter((i) => i.destination === "instagram"), [], "sem R2 não é terminal (#11478)");
    const alarm = interpretInstagramTimerOutput(0, JSON.stringify({ items: p.items })) as { key: string; detail: string };
    assert.equal(alarm.key, "credentials");
    assert.match(alarm.detail, /^sem R2 no 300:/);
    assert.match(alarm.detail, /R2_\*/);
    assert.doesNotMatch(alarm.detail, /credencial do Instagram|fica pendente/);
  });

  it("sem R2, antes do horário segue esperando (não alarma cedo)", () => {
    const p = planDiaria({ forceNow: false, now: new Date("2026-11-02T12:00:00Z"), publicVideo: { ready: false, reason: "x" } });
    assert.equal(p.items.find((i) => i.destination === "instagram")!.action, "pending_schedule");
  });

  it("a @vjpixel segue com teto (acima dele, guiado) e no rupload, mesmo sem R2", () => {
    assert.equal(instagramReelUploadRoute("vjpixel"), "rupload");
    assert.equal(instagramReelUploadRoute(null), "video_url");
    assert.equal(instagramReelUploadRoute("diaria"), "video_url");
    const pages = [{ slug: "vjpixel", enabled: true, pageId: "1", token: "t", missing: [], utmContent: null }];
    const over = planDiaria({ pages }, "vjpixel");
    assert.equal(over.items.find((i) => i.destination === "instagram")!.action, "guided");
    const within = planDiaria({ pages, videoDurationSeconds: 35, publicVideo: { ready: false, reason: "x" } }, "vjpixel");
    assert.equal(within.items.find((i) => i.destination === "instagram")!.action, "publish");
  });
});

describe("#11355 container por video_url", () => {
  const source = { videoUrl: "https://r2.example/shorts/v.mp4" };

  it("regressão: cria o container com video_url e os campos do Worker, sem rupload, e publica", async () => {
    const { deps, calls, sleeps } = fakeGraph();
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda", ["vjpixel"], "https://r2.example/c.jpg");
    const body = calls[0].body!;
    assert.deepEqual(
      { ...body },
      {
        media_type: "REELS",
        video_url: source.videoUrl,
        caption: "legenda",
        share_to_feed: "true",
        access_token: "tok",
        cover_url: "https://r2.example/c.jpg",
        collaborators: JSON.stringify(["vjpixel"]),
      },
    );
    assert.equal(body.upload_type, undefined);
    assert.ok(calls.some((c) => c.url.includes("/media_publish") && c.body?.creation_id === "c1"));
    assert.equal(sleeps.length, 1, "espera entre os polls");
    assert.equal(out.entry.url, "https://instagram.com/reel/m1");
    assert.equal(out.entry.status, "published");
  });

  it("o poll aguenta o pior caso medido (72 s, 8 consultas de 10 s) sem desistir", async () => {
    const { deps } = fakeGraph([...Array(8).fill("IN_PROGRESS"), "FINISHED"]);
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "legenda");
    assert.equal(out.entry.id, "m1");
  });

  it("container ERROR não publica e aponta a rota à mão", async () => {
    const { deps, calls } = fakeGraph(["ERROR"]);
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "x"), /ERROR motivo.*video_url.*Passo B3b/);
    assert.ok(!calls.some((c) => c.url.includes("/media_publish")));
  });
});

describe("#11355 R2", () => {
  it("corte do Instagram tem chave própria; o genérico reaproveita o objeto de X e Threads", () => {
    const aammdd = "261102";
    const dir = "data/editions/2611/261102";
    const a = Buffer.from("corte A");
    assert.equal(instagramR2VideoKey(aammdd, `${dir}/${shortVideoFileName(aammdd)}`, a), `shorts/${shortVideoFileName(aammdd)}`);
    const cutKey = instagramR2VideoKey(aammdd, `${dir}/${shortInstagramVideoFileName(aammdd)}`, a);
    assert.match(cutKey, /^shorts\/diaria-comentada-261102-short-instagram-[0-9a-f]{12}\.mp4$/);
    assert.notEqual(instagramR2VideoKey(aammdd, `${dir}/${shortInstagramVideoFileName(aammdd)}`, Buffer.from("corte B")), cutKey, "corte trocado muda a URL: cache nenhum serve o velho");
    assert.notEqual(cutKey, `shorts/${shortVideoFileName(aammdd)}`);
    assert.ok(R2_RETENTION_POLICIES.some((p) => cutKey.startsWith(p.prefix)), "a chave própria continua sob a retenção de shorts/");
  });

  it("a capa sobe antes do vídeo: a poda dela não apaga um vertical já resolvido", async () => {
    const order: string[] = [];
    const out = await resolveInstagramReelInputs({
      route: "video_url",
      file: Buffer.from("v"),
      uploadCover: async () => {
        order.push("cover");
        return "https://r2.example/c.jpg";
      },
      uploadVideo: async () => {
        order.push("video");
        return "https://r2.example/v.mp4";
      },
    });
    assert.deepEqual(order, ["cover", "video"]);
    assert.deepEqual(out, { source: { videoUrl: "https://r2.example/v.mp4" }, cover: "https://r2.example/c.jpg" });
  });

  it("falha no R2 lança antes de qualquer container; a rota rupload nem chama o R2", async () => {
    await assert.rejects(
      resolveInstagramReelInputs({
        route: "video_url",
        file: Buffer.from("v"),
        uploadCover: async () => undefined,
        uploadVideo: async () => {
          throw new Error("R2 não configurado");
        },
      }),
      /R2 não configurado/,
    );
    const file = Buffer.from("v");
    const out = await resolveInstagramReelInputs({
      route: "rupload",
      file,
      uploadCover: async () => undefined,
      uploadVideo: async () => assert.fail("rupload não usa o R2"),
    });
    assert.equal(out.source, file);
  });
});

const entry = (extra: Partial<ShortPublishedEntry> = {}): ShortPublishedEntry => ({ destination: "instagram", status: "published", id: "m0", url: "https://instagram.com/reel/m0", scheduled_at: null, at: "2026-11-02T15:00:00Z", ...extra });

describe("#11355 null só na rota video_url", () => {
  const cfg = (shorts: object) => ({ publishing: { shorts } });

  it("null por conta: vale na diaria, vira o teto padrão com premissa na vjpixel", () => {
    const c = cfg({ instagram_api_max_seconds_by_account: { diaria: null, vjpixel: null } });
    assert.equal(loadInstagramApiMaxSeconds(c, null), null);
    assert.equal(loadInstagramApiMaxSeconds(c, "diaria"), null);
    const r = resolveInstagramApiMaxSeconds(c, "vjpixel");
    assert.equal(r.maxSeconds, 40);
    assert.match(instagramApiMaxSecondsPremise(r)!, /rupload.*#11355/);
    assert.equal(instagramApiMaxSecondsPremise(resolveInstagramApiMaxSeconds(c, null)), null);
  });

  it("null legado global também não libera a conta do rupload", () => {
    const c = cfg({ instagram_api_max_seconds: null });
    assert.equal(loadInstagramApiMaxSeconds(c, "vjpixel"), 40);
    assert.equal(loadInstagramApiMaxSeconds(c, null), null);
  });

  it("no plano: vjpixel com null e 75 s vai pro guiado, nunca pro rupload que falha", () => {
    const pages = [{ slug: "vjpixel", enabled: true, pageId: "1", token: "t", missing: [], utmContent: null }];
    const p = planDiaria(
      {
        pages,
        config: { publishing: { shorts: { schedule: SCHEDULE, facebook_pages: [], instagram: true, instagram_author_page: "vjpixel", instagram_api_max_seconds_by_account: { vjpixel: null } } } },
      },
      "vjpixel",
    );
    assert.equal(p.items.find((i) => i.destination === "instagram")!.action, "guided");
  });
});

describe("#11355 guarda de R2 igual à de X e Threads", () => {
  it("publicVideo ausente não vira publish na conta da video_url", () => {
    const ig = planDiaria({ publicVideo: undefined }).items.find((i) => i.destination === "instagram")! as { action: string; detail: string; cause?: string };
    assert.equal(ig.action, "skip_missing_credentials");
    assert.equal(ig.cause, "public_video");
    assert.match(ig.detail, /não conferido/);
  });
});

describe("#11355 falha no media_publish", () => {
  const source = { videoUrl: "https://r2.example/shorts/v.mp4" };

  /** Graph falsa em que o media_publish falha e a consulta depois dele devolve `afterPublish`. */
  function failingPublish(afterPublish: string | Error) {
    const calls: string[] = [];
    let failed = false;
    const deps: GraphDeps = {
      fetch: async (url) => {
        calls.push(url);
        if (url.includes("/media_publish")) {
          failed = true;
          throw new Error("timeout");
        }
        if (url.endsWith("/ig/media")) return new Response(JSON.stringify({ id: "c1" }), { status: 200 });
        if (failed && afterPublish instanceof Error) throw afterPublish;
        return new Response(JSON.stringify({ status_code: failed ? afterPublish : "FINISHED" }), { status: 200 });
      },
      sleep: async () => {},
      now: () => new Date("2026-11-02T15:05:00Z"),
      log: () => {},
    };
    return { deps, calls };
  }

  it("regressão: timeout com container PUBLISHED não vira falha nem publica de novo", async () => {
    const { deps, calls } = failingPublish("PUBLISHED");
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "x", ["vjpixel"]);
    assert.equal(out.entry.status, "published");
    assert.equal(out.entry.id, "c1");
    assert.equal(out.entry.url, undefined);
    assert.match(out.warnings![0], /PUBLISHED.*não reposte/);
    assert.equal(calls.filter((u) => u.includes("/media_publish")).length, 1);
    const alarm = interpretInstagramTimerOutput(0, JSON.stringify({ results: [{ destination: "instagram", ok: true, entry: out.entry, warnings: out.warnings }] })) as { kind: string; key: string };
    assert.equal(alarm.key, "check-permalink");
  });

  it("consulta também falha: grava send_unknown, e o timer alarma sem pedir repost", async () => {
    const { deps } = failingPublish(new Error("rede"));
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "x");
    assert.equal(out.entry.status, "send_unknown");
    const alarm = interpretInstagramTimerOutput(0, JSON.stringify({ results: [{ destination: "instagram", ok: true, entry: out.entry, warnings: out.warnings }] })) as { key: string; failed: boolean };
    assert.equal(alarm.key, "send-unknown");
    assert.equal(alarm.failed, false);
    assert.equal(alarmSeverity("send-unknown"), "acao");
    const body = buildInstagramTimerAlarm({ aammdd: "261102", key: "send-unknown", reason: "x", videoArg: "v.mp4" }).body;
    assert.match(body, /PODE estar no ar/);
    assert.doesNotMatch(body, /--publish/);
    assert.equal(alarmSuppressed(JSON.stringify({ aammdd: "261102", alarmed: ["send-unknown"], emailPending: [] }), "late"), true, "late não manda publicar depois dele");
  });

  it("#11774: timeout com o container ainda FINISHED não prova nada — send_unknown, não relança", async () => {
    const { deps } = failingPublish("FINISHED");
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "x");
    assert.equal(out.entry.status, "send_unknown");
  });

  it("container que não ficou PUBLISHED nem FINISHED (ERROR): a falha é real e lança", async () => {
    const { deps } = failingPublish("ERROR");
    await assert.rejects(publishInstagramReel(deps, "ig", "tok", "v25.0", source, "x"), /timeout/);
  });
});

describe("#11355 alarme de registro sem permalink", () => {
  it("published sem url não é done silencioso; com url segue done", () => {
    const run = (e: ShortPublishedEntry) => interpretInstagramTimerOutput(0, JSON.stringify({ results: [{ destination: "instagram", ok: true, entry: e }] }));
    const noUrl = run(entry({ url: undefined })) as { kind: string; key: string; failed: boolean };
    assert.equal(noUrl.kind, "alarm");
    assert.equal(noUrl.key, "check-permalink");
    assert.equal(noUrl.failed, false);
    assert.equal(run(entry()).kind, "done");
  });
});

describe("#11355 reconferência antes do media_publish", () => {
  const source = { videoUrl: "https://r2.example/shorts/v.mp4" };
  const file = (entries: ShortPublishedEntry[]): ShortsPublishedFile => ({ aammdd: "261102", entries });

  it("destino registrado durante o processamento: não publica e devolve o registro", async () => {
    const { deps, calls } = fakeGraph();
    let fresh: ShortsPublishedFile | null = null;
    const registered = file([entry()]);
    const beforePublish = instagramPublishRecheck("d", "261102", (f) => (fresh = f), () => registered);
    const out = await publishInstagramReel(deps, "ig", "tok", "v25.0", source, "x", [], undefined, { beforePublish });
    assert.equal(out.alreadyRegistered, true);
    assert.equal(out.entry.id, "m0");
    assert.equal(fresh, registered);
    assert.ok(!calls.some((c) => c.url.includes("/media_publish")));
  });

  it("registro ilegível não publica; sem registro segue", async () => {
    const a = fakeGraph();
    const broken = instagramPublishRecheck("d", "261102", () => {}, () => {
      throw new Error("json quebrado");
    });
    await assert.rejects(publishInstagramReel(a.deps, "ig", "tok", "v25.0", source, "x", [], undefined, { beforePublish: broken }), /registro ilegível/);
    assert.ok(!a.calls.some((c) => c.url.includes("/media_publish")));
    const b = fakeGraph();
    const empty = instagramPublishRecheck("d", "261102", () => assert.fail("nada a atualizar"), () => file([]));
    const out = await publishInstagramReel(b.deps, "ig", "tok", "v25.0", source, "x", [], undefined, { beforePublish: empty });
    assert.equal(out.entry.id, "m1");
  });
});

describe("#11355 escolha de rota e objeto", () => {
  const aammdd = "261102";
  const file = Buffer.from("corte");
  const dir = "data/editions/2611/261102";

  it("autora diaria: video_url; corte tem hash e aponta o genérico, genérico não duplica", () => {
    const cut = instagramReelRouteChoice({ authorPage: null, aammdd, videoPath: `${dir}/${shortInstagramVideoFileName(aammdd)}`, file });
    assert.equal(cut.route, "video_url");
    if (cut.route !== "video_url") return;
    assert.match(cut.key, /short-instagram-[0-9a-f]{12}\.mp4$/);
    assert.equal(cut.genericKey, `shorts/${shortVideoFileName(aammdd)}`);
    const generic = instagramReelRouteChoice({ authorPage: null, aammdd, videoPath: `${dir}/${shortVideoFileName(aammdd)}`, file });
    assert.deepEqual(generic, { route: "video_url", key: `shorts/${shortVideoFileName(aammdd)}`, genericKey: null });
  });

  it("autora vjpixel: rupload, sem chave no R2", () => {
    assert.deepEqual(instagramReelRouteChoice({ authorPage: "vjpixel", aammdd, videoPath: "v.mp4", file }), { route: "rupload" });
  });

  it("corte idêntico ao genérico reaproveita o objeto; diferente sobe na própria chave", async () => {
    const choice = { route: "video_url" as const, key: "shorts/cut-abc.mp4", genericKey: "shorts/gen.mp4" };
    const same = await instagramReelVideoUrl(choice, { urlIfSameContent: async (k) => `https://r2/${k}`, upload: async () => assert.fail("não sobe") });
    assert.equal(same, "https://r2/shorts/gen.mp4");
    const uploaded: string[] = [];
    const other = await instagramReelVideoUrl(choice, {
      urlIfSameContent: async () => null,
      upload: async (k) => {
        uploaded.push(k);
        return `https://r2/${k}`;
      },
    });
    assert.equal(other, "https://r2/shorts/cut-abc.mp4");
    assert.deepEqual(uploaded, ["shorts/cut-abc.mp4"]);
  });
});

describe("#11355 ETag depois do PUT", () => {
  const cfg = { accountId: "a", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://media.example" };
  const body = Buffer.from("video");
  const md5 = createHash("md5").update(body).digest("hex");
  const put = (etag: string | null) => ({
    now: () => new Date("2026-11-02T15:05:00Z"),
    warn: () => {},
    fetch: async (_u: string, init?: RequestInit) =>
      init?.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": String(body.length), ...(etag ? { etag } : {}) } }) : new Response("", { status: 200 }),
  });

  it("mesmo tamanho com ETag de outro conteúdo lança", async () => {
    await assert.rejects(uploadToR2(put(`"${"0".repeat(32)}"`), cfg, "img/a.mp4", body, "video/mp4"), /outro conteúdo/);
  });

  it("ETag certo, fraco, ausente ou fora do formato MD5 não bloqueia", async () => {
    for (const etag of [`"${md5}"`, `W/"${md5}"`, null, '"abc-2"']) {
      assert.equal(await uploadToR2(put(etag), cfg, "img/a.mp4", body, "video/mp4"), "https://media.example/img/a.mp4");
    }
    assert.equal(etagConflictsBody(null, body), false);
  });
});
