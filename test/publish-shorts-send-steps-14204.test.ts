/**
 * #14204: as etapas por destino extraídas do laço do `--publish` de
 * `mainUnlocked` (`scripts/publish-shorts/run.ts`). Cada etapa recebe o
 * contexto da rodada explícito; aqui ela roda com dependências falsas, sem
 * rede e sem gravação real: a Buffer, a fila do Worker do Instagram, o
 * Threads pessoal, o repost da página, o arquivo do Chrome e o roteamento do
 * laço (`sendDestinationItem`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sendBufferItem } from "../scripts/publish-shorts/buffer.ts";
import { sendInstagramQueueItem, sendInstagramReelItem, type InstagramReelSendDeps } from "../scripts/publish-shorts/instagram-send.ts";
import { sendFacebookItem } from "../scripts/publish-shorts/facebook.ts";
import { sendYouTubeShortItem } from "../scripts/publish-shorts/youtube.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { prepareInstagramChromeStep } from "../scripts/publish-shorts/instagram.ts";
import { sendLinkedInProfileItem, sendPageRepostStep } from "../scripts/publish-shorts/linkedin.ts";
import { sendDestinationItem } from "../scripts/publish-shorts/run.ts";
import type { ShortsRunRegistry, ShortsSendContext } from "../scripts/publish-shorts/send-context.ts";
import { sendThreadsProfileItem, type ThreadsSendDeps } from "../scripts/publish-shorts/threads.ts";
import type { ShortPublishedEntry, ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import type { ShortsPlanItem } from "../scripts/publish-shorts/_shared.ts";

const HASH = "a".repeat(64);

function memoryRegistry(entries: ShortPublishedEntry[] = [], failPersist = false): ShortsRunRegistry & { persisted: ShortPublishedEntry[] } {
  let file: ShortsPublishedFile = { aammdd: "261127", entries } as ShortsPublishedFile;
  const persisted: ShortPublishedEntry[] = [];
  return {
    persisted,
    current: () => file,
    replace: (fresh) => {
      file = fresh;
    },
    persist: (entry) => {
      if (failPersist) throw new Error("EBUSY no registro");
      persisted.push(entry);
      file = { ...file, entries: [...file.entries.filter((e) => e.destination !== entry.destination), entry] };
    },
  };
}

/** Contexto mínimo: só o que cada etapa testada lê; o resto lança se for tocado. */
function ctx(over: Partial<ShortsSendContext> = {}): ShortsSendContext {
  const untouched = (what: string) => () => {
    throw new Error(`${what} não devia ser chamado`);
  };
  return {
    aammdd: "261127",
    dir: "/nao/existe",
    file: Buffer.from("mp4"),
    videoPath: "/nao/existe/v.mp4",
    videoHash: HASH,
    corte: null,
    writer: "main",
    plan: { youtube: { title: "Título do Short", description: "" }, horizontalLinks: {} } as unknown as ShortsSendContext["plan"],
    config: {},
    shortsCfg: { instagramCollaborators: ["vjpixel"], instagramAuthorPage: null } as unknown as ShortsSendContext["shortsCfg"],
    pages: [],
    apiVersion: "v21.0",
    igApiVersion: "v21.0",
    shortCover: { path: null, bytes: null, bufferOffsetMs: null },
    deps: { fetch: untouched("fetch") as never, sleep: async () => {}, now: () => new Date("2026-11-27T12:00:00Z"), log: () => {} },
    replaceRun: false,
    replaceTargetOf: () => undefined,
    bufferOffsetMs: null,
    forceYouTube: false,
    editionUrlArg: undefined,
    r2: { ready: false, missing: ["R2_X"] },
    r2KeysInUse: new Set(),
    uploadVideo: async () => "https://r2.example/shorts/261127.mp4",
    uploadVideoAt: untouched("uploadVideoAt") as never,
    uploadCover: async () => undefined,
    workerUrl: "",
    workerToken: "",
    igAuthor: { ready: false, reason: "autora do Instagram fora desta rodada" },
    liCreds: { ready: false, reason: "sem LINKEDIN_PERSONAL_ACCESS_TOKEN" },
    liApiVersion: "202611",
    threadsCreds: { ready: false, reason: "sem THREADS_ACCESS_TOKEN" } as ShortsSendContext["threadsCreds"],
    registry: memoryRegistry(),
    ...over,
  };
}

const publishItem = (destination: string): Extract<ShortsPlanItem, { action: "publish" }> => ({
  destination,
  mode: "api",
  action: "publish",
  caption: "Título do D1\n\nGancho.",
  scheduledAt: null,
});

describe("#14204 sendBufferItem", () => {
  const item: Extract<ShortsPlanItem, { action: "buffer" }> = {
    destination: "x",
    mode: "guided",
    action: "buffer",
    caption: "texto do X",
    scheduledAt: "2026-11-27T15:00:00.000Z",
  } as Extract<ShortsPlanItem, { action: "buffer" }>;

  it("sobe o vídeo e devolve o create_post com o hash dos bytes (nada registrado)", async () => {
    const c = ctx();
    const step = await sendBufferItem(c, item);
    assert.equal(step.kind, "settled");
    const r = step.result;
    assert.ok(r.status === "handoff");
    assert.equal(r.ok, true);
    assert.equal(r.buffer.videoUrl, "https://r2.example/shorts/261127.mp4");
    assert.equal(r.buffer.videoSha256, HASH);
    assert.equal((c.registry as ReturnType<typeof memoryRegistry>).persisted.length, 0);
  });

  it("na troca leva o post antigo e os próximos passos da skill", async () => {
    const step = await sendBufferItem(ctx({ replaceTargetOf: (d) => (d === "x" ? ({ destination: "x", kind: "buffer", old_id: "buffer:OLD1", at: item.scheduledAt } as never) : undefined) }), item);
    const r = step.kind === "settled" ? (step.result as unknown as Record<string, unknown>) : assert.fail();
    assert.deepEqual(r.replaces, { id: "buffer:OLD1", at: item.scheduledAt });
    assert.ok(Array.isArray(r.next_steps) || typeof r.next_steps === "string");
  });

  it("falha no upload vira resultado de erro, sem lançar", async () => {
    const step = await sendBufferItem(ctx({ uploadVideo: async () => { throw new Error("R2 fora"); } }), item);
    const r = step.result;
    assert.ok(r.status === "failed");
    assert.equal(r.ok, false);
    assert.match(r.error, /R2 fora/);
  });
});

describe("#14204 sendInstagramQueueItem", () => {
  it("enfileira com a URL do R2 e os collabs; registro scheduled com a key da fila", async () => {
    const payloads: unknown[] = [];
    const item = { destination: "instagram", mode: "api", action: "enqueue", caption: "legenda", scheduledAt: "2026-11-28T15:00:00.000Z", igAccount: "diaria", idempotencyKey: "shorts-instagram-261127-diaria" } as const;
    const step = await sendInstagramQueueItem(ctx(), item as never, async (p) => {
      payloads.push(p);
      return { key: "q-1", scheduled_at: item.scheduledAt };
    });
    assert.equal(step.kind, "outcome");
    const o = step.kind === "outcome" ? step.outcome : assert.fail();
    assert.equal(o.entry.status, "scheduled");
    assert.equal(o.entry.id, "q-1");
    assert.equal(payloads.length, 1);
    assert.match(JSON.stringify(payloads[0]), /r2\.example\/shorts\/261127\.mp4/);
    assert.match(JSON.stringify(payloads[0]), /vjpixel/);
  });
});

describe("#14204 sendThreadsProfileItem", () => {
  const ready = { ready: true, creds: { userId: "u", token: "t" } } as unknown as ShortsSendContext["threadsCreds"];
  const fakeDeps = (over: Partial<ThreadsSendDeps> & { calls?: string[] } = {}): ThreadsSendDeps => ({
    preflight: (async () => ({ kind: "absent" })) as never,
    publish: (async () => ({ entry: { destination: "threads_profile", status: "published", id: "T9", scheduled_at: null, at: "x" } })) as never,
    sameDayOtherIds: () => [],
    ...over,
  });

  it("sem credencial lança (o laço trata como recusa)", async () => {
    await assert.rejects(sendThreadsProfileItem(ctx(), publishItem("threads_profile"), fakeDeps()), /sem THREADS_ACCESS_TOKEN/);
  });

  it("confere o perfil em qualquer writer, com os ids do outro lado do dia", async () => {
    for (const writer of ["main", "threads-timer"] as const) {
      const seen: unknown[] = [];
      const sameDay: unknown[] = [];
      await sendThreadsProfileItem(
        ctx({ writer, threadsCreds: ready }),
        publishItem("threads_profile"),
        fakeDeps({
          preflight: (async (input: unknown) => {
            seen.push(input);
            return { kind: "absent" };
          }) as never,
          sameDayOtherIds: (slug, aammdd, dest) => {
            sameDay.push([slug, aammdd, dest]);
            return ["C1"];
          },
        }),
      );
      assert.equal(seen.length, 1, `writer ${writer} confere o perfil`);
      assert.deepEqual(sameDay, [[null, "261127", "threads_profile"]]);
    }
  });

  it("vídeo já no perfil: registra, pede ao laço para apagar o marcador e não publica", async () => {
    const reg = memoryRegistry();
    let published = 0;
    const entry = { destination: "threads_profile", status: "published", id: "T1", url: "https://threads.net/p/T1", scheduled_at: null, at: "x" } as ShortPublishedEntry;
    const step = await sendThreadsProfileItem(ctx({ threadsCreds: ready, registry: reg }), publishItem("threads_profile"), fakeDeps({
      preflight: (async () => ({ kind: "already", entry })) as never,
      publish: (async () => {
        published++;
        return {} as never;
      }) as never,
    }));
    assert.deepEqual(step, { kind: "settled", marker: "clear", result: { destination: "threads_profile", status: "already", ok: true, entry, alreadyRegistered: true } });
    assert.equal(published, 0);
    assert.deepEqual(reg.persisted, [entry]);
  });

  it("já no perfil e o registro falha: sent_unrecorded com cause record (#14327) e o marcador FICA", async () => {
    const entry = { destination: "threads_profile", status: "published", id: "T1", scheduled_at: null, at: "x" } as ShortPublishedEntry;
    const step = await sendThreadsProfileItem(ctx({ threadsCreds: ready, registry: memoryRegistry([], true) }), publishItem("threads_profile"), fakeDeps({
      preflight: (async () => ({ kind: "already", entry })) as never,
    }));
    assert.ok(step.kind === "settled");
    assert.equal(step.marker, "keep");
    const r = step.result;
    assert.ok(r.status === "sent_unrecorded");
    assert.equal(r.ok, false);
    assert.equal(r.cause, "record");
    assert.deepEqual(r.entry, entry);
    assert.match(r.error, /registro não gravado: EBUSY/);
  });

  it("fora do perfil: publica com a URL do R2 e a resposta do link do horizontal", async () => {
    const args: Record<string, unknown>[] = [];
    const c = ctx({ threadsCreds: ready, plan: { youtube: { title: "t" }, horizontalLinks: { threads_profile: { replyText: "Vídeo completo: diar.ia.br/video/261127" } } } as never });
    const step = await sendThreadsProfileItem(c, publishItem("threads_profile"), fakeDeps({
      publish: (async (a: Record<string, unknown>) => {
        args.push(a);
        return { entry: { destination: "threads_profile", status: "published", id: "T9", scheduled_at: null, at: "x" } };
      }) as never,
    }));
    assert.equal(step.kind, "outcome");
    assert.equal(args[0].videoUrl, "https://r2.example/shorts/261127.mp4");
    assert.equal(args[0].replyText, "Vídeo completo: diar.ia.br/video/261127");
  });
});

describe("#14204 sendPageRepostStep", () => {
  const guided: ShortsPlanItem = { destination: "linkedin_page_repost", mode: "guided", action: "guided", detail: "repost pela página", at: "2026-11-28T15:30:00.000Z" };
  const profile = { destination: "linkedin_profile", status: "published", id: "urn:li:share:123", scheduled_at: null, at: "x" } as ShortPublishedEntry;

  it("sem Worker nesta máquina: segue guiado, com aviso, sem resultado", async () => {
    const logs: string[] = [];
    const r = await sendPageRepostStep({ aammdd: "261127", items: [guided], results: [], registry: memoryRegistry([profile]), enqueue: null, now: new Date("2026-11-27T12:00:00Z"), log: (l) => logs.push(l) });
    assert.equal(r.result, null);
    assert.equal(r.items[0].action, "guided");
    assert.match(logs.join("\n"), /segue guiado/);
  });

  it("na fila: grava no registro e o item vira skip_done", async () => {
    const reg = memoryRegistry([profile]);
    const r = await sendPageRepostStep({
      aammdd: "261127",
      items: [guided],
      results: [],
      registry: reg,
      enqueue: async () => ({ key: "rp-1", scheduled_at: "2026-11-28T15:30:00.000Z" }),
      now: new Date("2026-11-27T12:00:00Z"),
      log: () => {},
    });
    assert.equal(r.result?.ok, true);
    assert.equal(r.result?.status, "sent");
    assert.equal(r.items[0].action, "skip_done");
    assert.equal(reg.persisted[0]?.id, "rp-1");
  });

  it("perfil desta rodada vence o do registro", async () => {
    const payloads: unknown[] = [];
    await sendPageRepostStep({
      aammdd: "261127",
      items: [guided],
      results: [{ destination: "linkedin_profile", status: "sent", ok: true, entry: { ...profile, id: "urn:li:share:999" } }],
      registry: memoryRegistry([profile]),
      enqueue: async (p) => {
        payloads.push(p);
        return { key: "rp-1", scheduled_at: "2026-11-28T15:30:00.000Z" };
      },
      now: new Date("2026-11-27T12:00:00Z"),
      log: () => {},
    });
    assert.match(JSON.stringify(payloads[0]), /urn:li:share:999/);
  });

  it("na fila e o registro falha: resultado de erro com o caminho do --mark", async () => {
    const r = await sendPageRepostStep({
      aammdd: "261127",
      items: [guided],
      results: [],
      registry: { ...memoryRegistry([profile]), persist: () => { throw new Error("EBUSY"); } },
      enqueue: async () => ({ key: "rp-1", scheduled_at: "2026-11-28T15:30:00.000Z" }),
      now: new Date("2026-11-27T12:00:00Z"),
      log: () => {},
    });
    assert.equal(r.result?.ok, false);
    assert.ok(r.result?.status === "sent_unrecorded", "o repost está na fila: não reenviar");
    assert.match(r.result.error, /--mark linkedin_page_repost=rp-1/);
  });
});

describe("#14204 prepareInstagramChromeStep", () => {
  it("sem passo guiado do Instagram (ou sem duração) devolve o mesmo plano, sem encode", () => {
    const plan = { items: [publishItem("instagram")] as ShortsPlanItem[], warnings: [] as string[] };
    const noEncode = { stat: () => { throw new Error("encode não devia rodar"); } } as never;
    assert.equal(prepareInstagramChromeStep(plan, { aammdd: "261127", dir: "/d", videoPath: "/d/v.mp4", fileSizeBytes: 3, durationSeconds: 60 }, noEncode), plan);
    const guided = { items: [{ destination: "instagram", mode: "guided", action: "guided", detail: "Reels à mão" }] as ShortsPlanItem[], warnings: [] as string[] };
    assert.equal(prepareInstagramChromeStep(guided, { aammdd: "261127", dir: "/d", videoPath: "/d/v.mp4", fileSizeBytes: 3, durationSeconds: null }, noEncode), guided);
  });

  it("compressão que falha: o passo guiado aponta pro original, com aviso no plano", () => {
    const guided = { items: [{ destination: "instagram", mode: "guided", action: "guided", detail: "Reels à mão" }] as ShortsPlanItem[], warnings: [] as string[] };
    const failing = { stat: () => null } as never; // vídeo original "ausente": prepareInstagramChromeUpload volta ok: false
    const logs: string[] = [];
    const out = prepareInstagramChromeStep(guided, { aammdd: "261127", dir: "/d", videoPath: "/d/v.mp4", fileSizeBytes: 3, durationSeconds: 60 }, failing, (l) => logs.push(l));
    const item = out.items[0] as Extract<ShortsPlanItem, { action: "guided" }>;
    assert.equal(item.upload?.path, "/d/v.mp4");
    assert.equal(item.upload?.fitsChromeUpload, false);
    assert.match(out.warnings.join("\n"), /versão comprimida não gerada/);
    assert.match(logs.join("\n"), /\[aviso\] instagram: versão comprimida não gerada/);
  });
});

describe("#14204 sendDestinationItem (roteamento do laço)", () => {
  it("cada destino vai para a sua etapa (a recusa de credencial de cada uma prova a rota)", async () => {
    const c = ctx();
    await assert.rejects(sendDestinationItem(c, publishItem("linkedin_profile"), null), /sem LINKEDIN_PERSONAL_ACCESS_TOKEN/);
    await assert.rejects(sendDestinationItem(c, publishItem("threads_profile"), null), /sem THREADS_ACCESS_TOKEN/);
    await assert.rejects(sendDestinationItem(c, publishItem("instagram"), null), /autora do Instagram fora desta rodada/);
    await assert.rejects(sendLinkedInProfileItem(c, publishItem("linkedin_profile")), /sem LINKEDIN_PERSONAL_ACCESS_TOKEN/);
    await assert.rejects(sendInstagramReelItem(c, publishItem("instagram")), /autora do Instagram fora desta rodada/);
  });

  it("enqueue vai para a fila do Worker antes de olhar o destino", async () => {
    let enqueued = 0;
    const item = { destination: "instagram", mode: "api", action: "enqueue", caption: "l", scheduledAt: "2026-11-28T15:00:00.000Z", igAccount: "diaria", idempotencyKey: "k" } as const;
    // Sem Worker configurado o postToWorkerQueue real recusaria; a rota é provada pelo upload do vídeo que a fila faz primeiro.
    const step = sendDestinationItem(ctx({ uploadVideo: async () => { enqueued++; throw new Error("upload da fila"); } }), item as never, null);
    await assert.rejects(step, /upload da fila/);
    assert.equal(enqueued, 1);
  });
});

describe("#14204 sendInstagramReelItem (deps falsas)", () => {
  const author = { ready: true, igUserId: "IG1", token: "tokIG", username: "diar.ia.br", source: "env" } as const;
  const reel = (id: string) => ({ destination: "instagram", status: "published", id, url: `https://www.instagram.com/reel/${id}/`, scheduled_at: null, at: "x" }) as ShortPublishedEntry;
  const corte = { slug: "corte-x", date: "261127", hhmm: "18:00", title: "Título do corte", hook: "Gancho do corte bem longo para o marcador.", video: "v.mp4" } as never;

  /** `decisions`: o que a leitura do /media devolve a cada chamada do gate (a última se repete). */
  function igDeps(opts: { decisions?: unknown[]; collab?: string[]; calls: string[] }): InstagramReelSendDeps {
    let n = 0;
    return {
      publishInstagramReel: (async (_d: unknown, _id: string, _t: string, _v: string, _s: unknown, _c: string, _co: string[], _cv: unknown, o: { beforePublish?: () => Promise<ShortPublishedEntry | null> | ShortPublishedEntry | null }) => {
        opts.calls.push("publish");
        const already = (await o.beforePublish?.()) ?? null;
        if (already) return { entry: already, alreadyRegistered: true };
        return { entry: reel("NOVO") };
      }) as never,
      resolveInstagramReelInputs: (async () => ({ source: { videoUrl: "https://r2.example/v.mp4" }, cover: undefined })) as never,
      instagramPublishRecheck: (() => () => null) as never,
      instagramConfirmContext: (() => ({ markers: ["Título do D1"], sinceIso: "2026-11-27T03:00:00.000Z", expectedAtIso: null, d1Title: "Título do D1" })) as never,
      sameDayOtherRegisteredIds: () => {
        opts.calls.push("sameDay");
        return [];
      },
      resolveChromeAuthorReader: (async () => {
        opts.calls.push("chrome");
        return { reader: null, unavailable: "é a mesma conta da API", sameAccount: true };
      }) as never,
      readAndDecideInstagramConfirm: (async () => {
        opts.calls.push("read");
        const list = opts.decisions ?? [{ kind: "refuse", reason: "nada", candidates: [], cause: "none" }];
        return list[Math.min(n++, list.length - 1)];
      }) as never,
      instagramTimerAlreadyCollabWarnings: (async () => {
        opts.calls.push("collab");
        return opts.collab ?? [];
      }) as never,
    };
  }

  it("rodada principal sem corte: sem gate da conta (nenhuma leitura do /media), publica", async () => {
    const calls: string[] = [];
    const step = await sendInstagramReelItem(ctx({ igAuthor: author }), publishItem("instagram"), igDeps({ calls }));
    assert.equal(step.kind, "outcome");
    assert.deepEqual(calls, ["publish"]);
  });

  it("timer do Instagram: gate antes, Reels já na conta → registra, pede para apagar o marcador, avisos de collab, não publica", async () => {
    const calls: string[] = [];
    const reg = memoryRegistry();
    const step = await sendInstagramReelItem(
      ctx({ igAuthor: author, writer: "instagram-timer", registry: reg }),
      publishItem("instagram"),
      igDeps({ calls, decisions: [{ kind: "register", entry: reel("MAO"), candidates: [], matchedBy: "marker" }], collab: ["falta o convite da @vjpixel"] }),
    );
    assert.ok(!calls.includes("publish"), "não publica de novo");
    assert.deepEqual(step, {
      kind: "settled",
      marker: "clear",
      result: { destination: "instagram", status: "already", ok: true, entry: reel("MAO"), alreadyRegistered: true, matchedBy: "marker", warnings: ["falta o convite da @vjpixel"] },
    });
    assert.deepEqual(reg.persisted.map((e) => e.id), ["MAO"]);
  });

  it("timer: nada no 1º gate, Reels achado na reconferência antes do media_publish → já registrado", async () => {
    const calls: string[] = [];
    const step = await sendInstagramReelItem(
      ctx({ igAuthor: author, writer: "instagram-timer" }),
      publishItem("instagram"),
      igDeps({ calls, decisions: [{ kind: "refuse", reason: "nada", candidates: [], cause: "none" }, { kind: "register", entry: reel("MAO2"), candidates: [], matchedBy: "marker" }] }),
    );
    assert.deepEqual(calls.filter((c) => c === "read").length, 2, "gate antes e reconferência");
    assert.ok(step.kind === "settled");
    assert.equal(step.marker, "clear");
    const r = step.result;
    assert.ok(r.status === "already");
    assert.equal(r.alreadyRegistered, true);
    assert.equal(r.matchedBy, "marker");
    assert.equal(r.entry.id, "MAO2");
  });

  it("timer: nada na conta → publica pelo gate (outcome) sem apagar o marcador aqui", async () => {
    const calls: string[] = [];
    const step = await sendInstagramReelItem(ctx({ igAuthor: author, writer: "instagram-timer" }), publishItem("instagram"), igDeps({ calls }));
    assert.equal(step.kind, "outcome");
    assert.deepEqual(calls, ["sameDay", "chrome", "read", "publish", "read"]);
  });

  it("corte avulso na rodada principal também passa pelo gate da conta", async () => {
    const calls: string[] = [];
    await sendInstagramReelItem(ctx({ igAuthor: author, writer: "main", corte }), publishItem("instagram"), igDeps({ calls }));
    assert.ok(calls.includes("read"), "o corte confere a conta");
  });
});

describe("#14204 sendYouTubeShortItem (fetch falso)", () => {
  const SLOT = "2026-11-28T09:30:00.000Z";
  const ENV = { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UC1" };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sobe o arquivo preparado, grava o send_unknown com o hash antes do PUT e devolve o outcome", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = ENV[k as keyof typeof ENV];
    }
    try {
      const reg = memoryRegistry();
      let putBody: unknown = null;
      let persistedBeforePut = -1;
      const deps: YouTubeUploadDeps = {
        now: () => new Date("2026-11-27T12:00:00Z"),
        fetch: async (url, init) => {
          if (url === "https://oauth2.googleapis.com/token") return json(200, { access_token: "tok" });
          if (url.includes("/youtube/v3/channels")) return json(200, { items: [{ id: "UC1" }] });
          if (url.includes("uploadType=resumable")) return new Response(null, { status: 200, headers: { Location: "https://up/sess" } });
          if (url === "https://up/sess") {
            putBody = init?.body ?? null;
            persistedBeforePut = reg.persisted.length;
            return json(200, { id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } });
          }
          if (url.includes("/youtube/v3/videos?part=status")) return json(200, { items: [{ id: "s1", status: { uploadStatus: "uploaded", privacyStatus: "private", publishAt: SLOT } }] });
          throw new Error(`rota não mockada: ${url}`);
        },
      };
      const prepared = { file: Buffer.from("mp4-com-capa"), firstFrame: null };
      const step = await sendYouTubeShortItem(ctx({ forceYouTube: true, registry: reg }), { ...publishItem("youtube_shorts"), scheduledAt: SLOT }, prepared, deps);
      assert.equal(step.kind, "outcome");
      assert.equal(persistedBeforePut, 1, "o send_unknown vai ao registro antes do PUT dos bytes");
      assert.equal(reg.persisted[0].status, "send_unknown");
      assert.equal(reg.persisted[0].video_sha256, HASH);
      assert.ok(putBody !== null && Buffer.from(putBody as Uint8Array).equals(prepared.file), "sobe o arquivo preparado, não o original");
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("#14204 sendFacebookItem (fetch falso)", () => {
  const page = { slug: "diaria", enabled: true, pageId: "179", token: "tok", missing: [] as string[], utmContent: "page-diaria" };
  function shortMp4(seconds: number): Buffer {
    const p = Buffer.alloc(100);
    p.writeUInt32BE(1000, 12);
    p.writeUInt32BE(seconds * 1000, 16);
    const mvhd = Buffer.concat([Buffer.from([0, 0, 0, 108, 0x6d, 0x76, 0x68, 0x64]), p]);
    return Buffer.concat([Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70]), Buffer.from([0, 0, 0, 116, 0x6d, 0x6f, 0x6f, 0x76]), mvhd]);
  }

  it("página não resolvida lança com o destino (recusa do laço)", async () => {
    await assert.rejects(sendFacebookItem(ctx(), publishItem("facebook:outra")), /facebook: página não resolvida para facebook:outra/);
  });

  it("publica o Reel da página do destino com a legenda e o horário do item", async () => {
    const replies = [{ video_id: "v1" }, { success: true }, { success: true }, { status: { video_status: "ready" } }];
    const bodies: Array<Record<string, string> | null> = [];
    let i = 0;
    const deps = {
      fetch: async (_url: string, init?: RequestInit) => {
        bodies.push(init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : null);
        return new Response(JSON.stringify(replies[i++] ?? {}), { status: 200 });
      },
      sleep: async () => {},
      now: () => new Date("2026-11-27T12:00:00Z"),
      log: () => {},
    };
    const step = await sendFacebookItem(ctx({ pages: [page] as never, deps, file: shortMp4(60) }), { ...publishItem("facebook:diaria"), scheduledAt: "2026-11-28T15:00:00.000Z" });
    const o = step.kind === "outcome" ? step.outcome : assert.fail();
    assert.equal(o.entry.destination, "facebook:diaria");
    assert.equal(o.entry.status, "scheduled");
    assert.equal(bodies[2]?.description, "Título do D1\n\nGancho.");
  });
});
