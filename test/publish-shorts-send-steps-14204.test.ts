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
import { sendInstagramQueueItem, sendInstagramReelItem } from "../scripts/publish-shorts/instagram-send.ts";
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
    liCreds: { ok: false, reason: "sem LINKEDIN_PERSONAL_ACCESS_TOKEN" } as ShortsSendContext["liCreds"],
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
    const r = step.kind === "settled" ? step.result! : assert.fail();
    assert.equal(r.ok, true);
    assert.equal(r.buffer?.videoUrl, "https://r2.example/shorts/261127.mp4");
    assert.equal(r.buffer?.videoSha256, HASH);
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
    const r = step.kind === "settled" ? step.result! : assert.fail();
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /R2 fora/);
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
    await assert.rejects(sendThreadsProfileItem(ctx(), publishItem("threads_profile"), { clearSending: () => {} }, fakeDeps()), /sem THREADS_ACCESS_TOKEN/);
  });

  it("confere o perfil em qualquer writer, com os ids do outro lado do dia", async () => {
    for (const writer of ["main", "threads-timer"] as const) {
      const seen: unknown[] = [];
      const sameDay: unknown[] = [];
      await sendThreadsProfileItem(
        ctx({ writer, threadsCreds: ready }),
        publishItem("threads_profile"),
        { clearSending: () => {} },
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

  it("vídeo já no perfil: registra, apaga o marcador e não publica", async () => {
    const reg = memoryRegistry();
    let cleared = 0;
    let published = 0;
    const entry = { destination: "threads_profile", status: "published", id: "T1", url: "https://threads.net/p/T1", scheduled_at: null, at: "x" } as ShortPublishedEntry;
    const step = await sendThreadsProfileItem(ctx({ threadsCreds: ready, registry: reg }), publishItem("threads_profile"), { clearSending: () => cleared++ }, fakeDeps({
      preflight: (async () => ({ kind: "already", entry })) as never,
      publish: (async () => {
        published++;
        return {} as never;
      }) as never,
    }));
    assert.deepEqual(step, { kind: "settled", result: { destination: "threads_profile", ok: true, entry, alreadyRegistered: true } });
    assert.equal(cleared, 1);
    assert.equal(published, 0);
    assert.deepEqual(reg.persisted, [entry]);
  });

  it("já no perfil e o registro falha: erro de preflight e o marcador FICA", async () => {
    let cleared = 0;
    const entry = { destination: "threads_profile", status: "published", id: "T1", scheduled_at: null, at: "x" } as ShortPublishedEntry;
    const step = await sendThreadsProfileItem(ctx({ threadsCreds: ready, registry: memoryRegistry([], true) }), publishItem("threads_profile"), { clearSending: () => cleared++ }, fakeDeps({
      preflight: (async () => ({ kind: "already", entry })) as never,
    }));
    const r = step.kind === "settled" ? step.result! : assert.fail();
    assert.equal(r.ok, false);
    assert.equal(r.cause, "preflight");
    assert.match(r.error ?? "", /registro não gravado: EBUSY/);
    assert.equal(cleared, 0);
  });

  it("fora do perfil: publica com a URL do R2 e a resposta do link do horizontal", async () => {
    const args: Record<string, unknown>[] = [];
    const c = ctx({ threadsCreds: ready, plan: { youtube: { title: "t" }, horizontalLinks: { threads_profile: { replyText: "Vídeo completo: diar.ia.br/video/261127" } } } as never });
    const step = await sendThreadsProfileItem(c, publishItem("threads_profile"), { clearSending: () => {} }, fakeDeps({
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
    assert.equal(r.items[0].action, "skip_done");
    assert.equal(reg.persisted[0]?.id, "rp-1");
  });

  it("perfil desta rodada vence o do registro", async () => {
    const payloads: unknown[] = [];
    await sendPageRepostStep({
      aammdd: "261127",
      items: [guided],
      results: [{ destination: "linkedin_profile", ok: true, entry: { ...profile, id: "urn:li:share:999" } }],
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
    assert.match(r.result?.error ?? "", /--mark linkedin_page_repost=rp-1/);
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
    const io = { clearSending: () => {} };
    await assert.rejects(sendDestinationItem(c, publishItem("linkedin_profile"), io, null), /sem LINKEDIN_PERSONAL_ACCESS_TOKEN/);
    await assert.rejects(sendDestinationItem(c, publishItem("threads_profile"), io, null), /sem THREADS_ACCESS_TOKEN/);
    await assert.rejects(sendDestinationItem(c, publishItem("instagram"), io, null), /autora do Instagram fora desta rodada/);
    await assert.rejects(sendLinkedInProfileItem(c, publishItem("linkedin_profile")), /sem LINKEDIN_PERSONAL_ACCESS_TOKEN/);
    await assert.rejects(sendInstagramReelItem(c, publishItem("instagram"), io), /autora do Instagram fora desta rodada/);
  });

  it("enqueue vai para a fila do Worker antes de olhar o destino", async () => {
    let enqueued = 0;
    const item = { destination: "instagram", mode: "api", action: "enqueue", caption: "l", scheduledAt: "2026-11-28T15:00:00.000Z", igAccount: "diaria", idempotencyKey: "k" } as const;
    // Sem Worker configurado o postToWorkerQueue real recusaria; a rota é provada pelo upload do vídeo que a fila faz primeiro.
    const step = sendDestinationItem(ctx({ uploadVideo: async () => { enqueued++; throw new Error("upload da fila"); } }), item as never, { clearSending: () => {} }, null);
    await assert.rejects(step, /upload da fila/);
    assert.equal(enqueued, 1);
  });
});
