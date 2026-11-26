/**
 * test/shorts-replace-scheduled-12279.test.ts (#12279)
 *
 * Troca do vídeo de um vertical JÁ AGENDADO (V1 por V2) com a exceção
 * explícita no grant (decisão do editor de 15/11/2026): o grant
 * `--replace-scheduled` é o único caminho de nova autorização para destino já
 * registrado; a autorização de substituição carrega o post antigo, o hash dos
 * bytes novos e o horário preservado; a rodada de substituição a consome ANTES
 * da 1ª exclusão. Nenhuma API é chamada: dependências injetadas e diretórios
 * temporários.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildReplacementManifest,
  buildVerticalManifest,
  hasReplacementDestination,
  isReplacementManifest,
  planSha256,
  sha256Hex,
  writeVideoPlanManifest,
  type VideoPlanManifest,
} from "../scripts/lib/diaria/video-publish-plan.ts";
import {
  consumeVideoPublishAuthorization,
  emptyAuthorizationStore,
  grantVideoPublishAuthorization,
  readAuthorizationStore,
  recordRegistryCheck,
  type VideoPublishAuthorizationStore,
} from "../scripts/lib/diaria/video-publish-authorization.ts";
import {
  afterCancelMessage,
  applyReplacementTimes,
  bufferReplaceNextSteps,
  planScheduledReplacements,
  replacementSurvivors,
  replacementUploadRefusal,
  type ReplacementPhaseDeps,
  replacementGrantRefusal,
  replacementPublishCommand,
  runScheduledReplacement,
  shortVideoChangeWarnings,
  type ShortReplacementTarget,
} from "../scripts/lib/diaria/short-scheduled-replace.ts";
import { readShortReplacements, readShortsRegistry, recordShortReplacement, SHORTS_REPLACED_FILE } from "../scripts/lib/diaria/shorts-published-store.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import { main as authorizeMain } from "../scripts/video-publish-authorize.ts";
import { matchEditionVideo } from "../scripts/lib/diaria/youtube-upload.ts";
import { shortsSendingPath } from "../scripts/lib/diaria/shorts-sending-marker.ts";
import {
  applyBufferReplacementMark,
  bufferDeletedRefusal,
  bufferReplacementMarkRefusal,
  cancelFacebookScheduledVideo,
  replacedYouTubeIds,
  prepareBufferItem,
  publishFacebookReel,
  replaceLockBusy,
  replaceScheduledArgsError,
  SHORTS_BOOLEAN_FLAGS,
} from "../scripts/publish-shorts.ts";
import { publishShortsSource } from "./_helpers/publish-shorts-source.ts"; // #14054

const ED = "261115";
const T0 = new Date("2026-11-15T10:00:00.000Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const CONFIRM = "pode publicar a troca";
/** Horário dos posts agendados (V1): 6 h depois de T0. */
const YT_AT = "2026-11-15T16:00:00.000Z";
const FB_AT = "2026-11-15T17:00:00.000Z";
const V1 = sha256Hex("bytes do V1");
const V2 = sha256Hex("bytes do V2");
const MAIN_CMD = `npx tsx scripts/publish-shorts.ts ${ED} --publish --confirm-publish ${ED}`;
const REPLACE_CMD = replacementPublishCommand(ED, { video: "/tmp/v2.mp4" });


const entries = (over: Partial<Record<string, Partial<ShortPublishedEntry>>> = {}): ShortPublishedEntry[] => [
  { destination: "youtube_shorts", status: "scheduled", id: "ytOLD", scheduled_at: YT_AT, at: at(-600).toISOString(), video_sha256: V1, ...over.youtube_shorts },
  { destination: "facebook:diaria", status: "scheduled", id: "fbOLD", scheduled_at: FB_AT, at: at(-600).toISOString(), ...over["facebook:diaria"] },
  { destination: "x", status: "scheduled", id: "buffer:xOLD", scheduled_at: FB_AT, at: at(-600).toISOString(), ...over.x },
  { destination: "instagram", status: "published", id: "igID", scheduled_at: null, at: at(-600).toISOString(), ...over.instagram },
];

/** O plano normal do vertical que publicou o V1 (consumido na rodada original). */
function originalManifest(): VideoPlanManifest {
  return buildVerticalManifest({
    aammdd: ED,
    items: [
      { destination: "youtube_shorts", action: "publish", caption: "descrição", title: "Título", scheduledAt: YT_AT },
      { destination: "facebook:diaria", action: "publish", caption: "legenda", scheduledAt: FB_AT },
    ],
    owners: [],
    destinationAt: (id) => (id === "youtube_shorts" ? YT_AT : FB_AT),
    horizontalLink: () => null,
    metadata: { title: "Título", description: "descrição" },
    media: { video_sha256: V1, cover_sha256: null, captions_sha256: null },
    sources: { reviewed: sha256Hex("rev") },
    publishCommand: MAIN_CMD,
  });
}

/** O manifesto da troca: mídia nova (V2), horário preservado, post antigo por destino. */
function replacementManifest(opts: { video?: string; ytOld?: string; ytAt?: string } = {}): VideoPlanManifest {
  const ytAt = opts.ytAt ?? YT_AT;
  const base = buildVerticalManifest({
    aammdd: ED,
    items: [
      { destination: "youtube_shorts", action: "publish", caption: "descrição", title: "Título", scheduledAt: ytAt },
      { destination: "facebook:diaria", action: "publish", caption: "legenda", scheduledAt: FB_AT },
    ],
    owners: [],
    destinationAt: (id) => (id === "youtube_shorts" ? ytAt : FB_AT),
    horizontalLink: () => null,
    metadata: { title: "Título", description: "descrição" },
    media: { video_sha256: opts.video ?? V2, cover_sha256: null, captions_sha256: null },
    sources: { reviewed: sha256Hex("rev") },
    publishCommand: MAIN_CMD,
  });
  return buildReplacementManifest(
    base,
    [
      { destination: "youtube_shorts", old_id: opts.ytOld ?? "ytOLD", at: ytAt },
      { destination: "facebook:diaria", old_id: "fbOLD", at: FB_AT },
    ],
    REPLACE_CMD,
  );
}

/** Registro de autorização depois da rodada original: os dois destinos consumidos e a releitura acusando-os como saídos. */
function afterOriginalPublish(): VideoPublishAuthorizationStore {
  const m = originalManifest();
  const g = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: m, planSha256: planSha256(m), confirmation: "pode publicar", now: at(-700), isPidAlive: () => false });
  assert.ok(g.ok);
  const c = consumeVideoPublishAuthorization(g.store, { edition: ED, manifest: m, destinations: ["youtube_shorts", "facebook:diaria"], now: at(-650), pid: 777, by: "teste" });
  assert.ok(c.ok, c.ok ? "" : c.error);
  return recordRegistryCheck(c.store, { now: at(-10), since: at(-651).toISOString(), verdict: "registered-since", registered: ["youtube_shorts", "facebook:diaria"] });
}

function grant(store: VideoPublishAuthorizationStore, m: VideoPlanManifest, extra: { replacement?: boolean; isPidAlive?: (pid: number) => boolean; registry?: ShortPublishedEntry[] } = {}) {
  const { registry, ...rest } = extra;
  return grantVideoPublishAuthorization(store, {
    manifest: m, planSha256: planSha256(m), confirmation: CONFIRM, now: T0, isPidAlive: () => false, ...rest,
    ...(rest.replacement ? { replacementRegistry: { entries: registry ?? entries(), openMarks: [] } } : {}),
  });
}

describe("#12279 grant: exceção explícita só com --replace-scheduled", () => {
  it("sem a flag, a reautorização de destino já registrado continua recusada (plano normal e plano de troca)", () => {
    const store = afterOriginalPublish();
    const normal = grant(store, originalManifest());
    assert.equal(normal.ok, false);
    assert.match(normal.ok ? "" : normal.error, /acusou o destino como saído/);
    const swapNoFlag = grant(store, replacementManifest());
    assert.equal(swapNoFlag.ok, false);
    assert.match(swapNoFlag.ok ? "" : swapNoFlag.error, /exige --replace-scheduled/);
  });

  it("com a flag e o manifesto de troca, autoriza e grava o post antigo e o horário na autorização", () => {
    const g = grant(afterOriginalPublish(), replacementManifest(), { replacement: true });
    assert.ok(g.ok, g.ok ? "" : g.error);
    const yt = g.value.find((a) => a.destination === "youtube_shorts")!;
    assert.deepEqual(yt.replacement, { id: "ytOLD", at: YT_AT });
    assert.equal(yt.effective_at, YT_AT, "horário efetivo aprovado = o do post antigo");
  });

  it("a flag não serve a um plano que não troca nada", () => {
    const g = grant(afterOriginalPublish(), originalManifest(), { replacement: true });
    assert.equal(g.ok, false);
    assert.match(g.ok ? "" : g.error, /manifesto de substituição/);
  });

  it("as outras barreiras seguem: processo que consumiu vivo, evento sem releitura", () => {
    assert.equal(grant(afterOriginalPublish(), replacementManifest(), { replacement: true, isPidAlive: (pid) => pid === 777 }).ok, false);
    const m = originalManifest();
    const g = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: m, planSha256: planSha256(m), confirmation: "ok", now: at(-700), isPidAlive: () => false });
    assert.ok(g.ok);
    const c = consumeVideoPublishAuthorization(g.store, { edition: ED, manifest: m, destinations: ["youtube_shorts", "facebook:diaria"], now: at(-650), pid: 777, by: "teste" });
    assert.ok(c.ok);
    const noReread = grant(c.store, replacementManifest(), { replacement: true });
    assert.equal(noReread.ok, false);
    assert.match(noReread.ok ? "" : noReread.error, /sem releitura do registro/);
  });

  it("isReplacementManifest/hasReplacementDestination", () => {
    assert.equal(isReplacementManifest(replacementManifest()), true);
    assert.equal(hasReplacementDestination(originalManifest()), false);
  });
});

describe("#12279 consumo: só a rodada de troca, só com o mesmo vídeo e o mesmo post", () => {
  const granted = () => {
    const g = grant(afterOriginalPublish(), replacementManifest(), { replacement: true });
    assert.ok(g.ok);
    return g.store;
  };
  const consume = (store: VideoPublishAuthorizationStore, m: VideoPlanManifest, replacement: boolean) =>
    consumeVideoPublishAuthorization(store, { edition: ED, manifest: m, destinations: ["youtube_shorts", "facebook:diaria"], now: at(5), pid: 888, by: "teste", replacement, command: REPLACE_CMD });

  it("a rodada de troca consome com o manifesto recalculado igual", () => {
    const r = consume(granted(), replacementManifest(), true);
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.ok(r.value.every((a) => a.status === "consumed" && a.replacement));
  });

  it("hash dos bytes divergente recusa (nada consumido)", () => {
    const r = consume(granted(), replacementManifest({ video: sha256Hex("um V3 qualquer") }), true);
    assert.equal(r.ok, false);
    assert.ok(!r.ok && r.refusals?.every((x) => x.kind === "plan-changed"));
    assert.match(r.ok ? "" : r.error, /media\.video_sha256/);
  });

  it("outro post antigo (ID) ou outro horário recusam", () => {
    assert.equal(consume(granted(), replacementManifest({ ytOld: "ytOUTRO" }), true).ok, false);
    assert.equal(consume(granted(), replacementManifest({ ytAt: "2026-11-15T18:00:00.000Z" }), true).ok, false);
  });

  it("autorização de troca não serve a uma rodada normal, e a normal não serve à troca", () => {
    const normalRun = consume(granted(), replacementManifest(), false);
    assert.equal(normalRun.ok, false);
    assert.match(normalRun.ok ? "" : normalRun.error, /só a rodada --replace-scheduled a consome/);
    const m = originalManifest();
    const g = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: m, planSha256: planSha256(m), confirmation: "ok", now: T0, isPidAlive: () => false });
    assert.ok(g.ok);
    const swapRun = consumeVideoPublishAuthorization(g.store, { edition: ED, manifest: m, destinations: ["youtube_shorts"], now: at(1), by: "teste", replacement: true });
    assert.equal(swapRun.ok, false);
    assert.match(swapRun.ok ? "" : swapRun.error, /só consome autorização de substituição/);
  });
});

describe("#12279 fase destrutiva: consumo ANTES da 1ª exclusão", () => {
  const targets: ShortReplacementTarget[] = [
    { destination: "youtube_shorts", kind: "api", old_id: "ytOLD", at: YT_AT },
    { destination: "facebook:diaria", kind: "api", old_id: "fbOLD", at: FB_AT },
    { destination: "x", kind: "buffer", old_id: "buffer:xOLD", at: FB_AT },
  ];
  type Over = Partial<ReplacementPhaseDeps>;
  const phaseDeps = (calls: string[], over: Over = {}): ReplacementPhaseDeps => ({
    consume: () => {
      calls.push("consume");
      return { ok: true };
    },
    stillRegistered: () => true,
    markCancelling: (t) => {
      calls.push(`mark:${t.destination}`);
    },
    clearCancelling: (d) => {
      calls.push(`unmark:${d}`);
    },
    cancel: async (t, onBeforeWrite) => {
      onBeforeWrite();
      calls.push(`cancel:${t.destination}`);
    },
    record: (t) => {
      calls.push(`record:${t.destination}`);
    },
    clearMarks: (d) => {
      calls.push(`clear:${d}`);
    },
    warn: (m) => {
      calls.push(`warn:${m}`);
    },
    ...over,
  });

  it("consome primeiro; consumo recusado = nenhuma marca e nenhuma exclusão", async () => {
    const calls: string[] = [];
    const refused = await runScheduledReplacement(targets, phaseDeps(calls, { consume: () => (calls.push("consume"), { ok: false, error: "plano mudou" }) }));
    assert.deepEqual(refused, { refused: "plano mudou" });
    assert.deepEqual(calls, ["consume"]);
  });

  it("ordem por alvo: marca cancelando ANTES da plataforma, depois histórico e limpeza; Buffer não é tocada", async () => {
    const calls: string[] = [];
    const ok = await runScheduledReplacement(targets, phaseDeps(calls));
    assert.equal(ok.refused, null);
    assert.deepEqual(calls, [
      "consume",
      "mark:youtube_shorts", "cancel:youtube_shorts", "record:youtube_shorts", "clear:youtube_shorts",
      "mark:facebook:diaria", "cancel:facebook:diaria", "record:facebook:diaria", "clear:facebook:diaria",
    ]);
    assert.deepEqual(ok.refused === null ? ok.results.map((r) => r.outcome) : [], ["cancelled", "cancelled", "buffer"]);
    assert.deepEqual([...replacementSurvivors(ok.refused === null ? ok.results : [])].sort(), ["facebook:diaria", "x", "youtube_shorts"]);
  });

  it("recusa ANTES da escrita: NÃO cancelado, marca retirada, sem histórico, sem envio novo", async () => {
    const calls: string[] = [];
    const r = await runScheduledReplacement(targets.slice(0, 1), phaseDeps(calls, { cancel: async () => { throw new Error("não está agendado com folga"); } }));
    const res = r.refused === null ? r.results : [];
    assert.equal(res[0].outcome, "failed");
    assert.match(res[0].outcome === "failed" ? res[0].error : "", /NÃO cancelado: não está agendado com folga/);
    assert.deepEqual(calls, ["consume", "mark:youtube_shorts", "unmark:youtube_shorts"]);
    assert.equal(replacementSurvivors(res).size, 0);
  });

  it("falha DEPOIS da escrita (timeout/5xx do PUT ou DELETE): incerto, marca fica, sem histórico, sem envio novo", async () => {
    const calls: string[] = [];
    const r = await runScheduledReplacement(targets.slice(0, 1), phaseDeps(calls, {
      cancel: async (_t, onBeforeWrite) => {
        onBeforeWrite();
        throw new Error("HTTP 503");
      },
    }));
    const res = r.refused === null ? r.results : [];
    assert.equal(res[0].outcome, "uncertain");
    assert.match(res[0].outcome === "uncertain" ? res[0].error : "", /PODE ter sido cancelado.*Confira a conta/);
    assert.deepEqual(calls, ["consume", "mark:youtube_shorts"], "marca cancelando fica, nada gravado");
    assert.equal(replacementSurvivors(res).size, 0);
  });

  it("histórico que não grava depois de cancelar: falha (phase record), V2 não sobe", async () => {
    const calls: string[] = [];
    const r = await runScheduledReplacement(targets.slice(0, 1), phaseDeps(calls, { record: () => { throw new Error("EBUSY"); } }));
    const res = r.refused === null ? r.results : [];
    assert.equal(res[0].outcome, "failed");
    assert.equal(res[0].outcome === "failed" ? res[0].phase : "", "record");
    assert.equal(replacementSurvivors(res).size, 0);
  });

  it("marca não gravada: nada chamado na plataforma; limpeza que falha só avisa", async () => {
    const calls: string[] = [];
    const r = await runScheduledReplacement(targets.slice(0, 1), phaseDeps(calls, { markCancelling: () => { throw new Error("disco"); } }));
    assert.equal(r.refused === null ? r.results[0].outcome : "", "failed");
    assert.ok(!calls.some((c) => c.startsWith("cancel:")));
    const calls2: string[] = [];
    const r2 = await runScheduledReplacement(targets.slice(0, 1), phaseDeps(calls2, { clearMarks: () => { throw new Error("lock"); } }));
    assert.equal(r2.refused === null ? r2.results[0].outcome : "", "cancelled");
    assert.ok(calls2.some((c) => c.startsWith("warn:youtube_shorts: marcas de envio não apagadas")));
  });

  it("registro mudou desde o plano: nada marcado nem cancelado", async () => {
    const calls: string[] = [];
    const r = await runScheduledReplacement(targets.slice(0, 1), phaseDeps(calls, { stillRegistered: () => false }));
    assert.deepEqual(calls, ["consume"]);
    assert.equal(r.refused === null ? r.results[0].outcome : "", "failed");
  });

  it("as mensagens depois do cancelamento citam o post antigo cancelado (só alvo de API)", () => {
    assert.match(afterCancelMessage(targets[0], "registro ilegível"), /post antigo ytOLD já cancelado.*registro ilegível/);
    assert.equal(afterCancelMessage(targets[2], "x"), "x");
    assert.equal(afterCancelMessage(undefined, "x"), "x");
  });
});

describe("#12279 horário preservado e escolha dos alvos", () => {
  it("o plano do envio novo sai no horário do post antigo", () => {
    const items = [
      { destination: "youtube_shorts", action: "publish", scheduledAt: "2026-11-16T09:30:00.000Z" },
      { destination: "x", action: "buffer", scheduledAt: null as string | null },
    ];
    const r = applyReplacementTimes(items, [
      { destination: "youtube_shorts", kind: "api", old_id: "ytOLD", at: YT_AT },
      { destination: "x", kind: "buffer", old_id: "buffer:xOLD", at: FB_AT },
    ]);
    assert.ok(r.ok);
    assert.deepEqual(r.ok ? r.items.map((i) => i.scheduledAt) : [], [YT_AT, FB_AT]);
    const m = replacementManifest();
    assert.equal(m.destinations.find((d) => d.id === "youtube_shorts")!.effective_at, YT_AT);
  });

  it("alvo que não sairia nesta rodada recusa a troca inteira", () => {
    const r = applyReplacementTimes([{ destination: "youtube_shorts", action: "skip_missing_credentials" }], [{ destination: "youtube_shorts", kind: "api", old_id: "ytOLD", at: YT_AT }]);
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /nada apagado/);
  });

  it("só post agendado, com folga, sem marca aberta e com bytes diferentes", () => {
    const sel = planScheduledReplacements(
      entries({ "facebook:diaria": { scheduled_at: at(20).toISOString() } }),
      { now: T0, only: null, videoSha256: V2, openMarks: [{ destination: "x", started_at: at(-1).toISOString(), pid: 1 }] as never },
    );
    assert.deepEqual(sel.targets.map((t) => t.destination), ["youtube_shorts"]);
    const reasons = Object.fromEntries(sel.skipped.map((s) => [s.destination, s.reason]));
    assert.match(reasons["facebook:diaria"], /30 min ou menos/);
    assert.match(reasons.x, /marca de envio aberta/);
    assert.match(reasons.instagram, /sem caminho de troca|só post AGENDADO/);
    const same = planScheduledReplacements(entries(), { now: T0, only: ["youtube_shorts"], videoSha256: V1 });
    assert.equal(same.targets.length, 0);
    assert.match(same.skipped[0].reason, /mesmo video_sha256/);
    assert.throws(() => planScheduledReplacements(entries(), { now: T0, only: ["tiktok"], videoSha256: V2 }), /sem registro/);
    const unknown = planScheduledReplacements(entries({ youtube_shorts: { status: "send_unknown" } }), { now: T0, only: ["youtube_shorts"], videoSha256: V2 });
    assert.equal(unknown.targets.length, 0);
  });

  it("o grant confere o plano contra o registro: mesmo ID, mesmo horário, agendado", () => {
    assert.equal(replacementGrantRefusal(replacementManifest(), entries(), T0), null);
    assert.match(replacementGrantRefusal(replacementManifest(), entries({ youtube_shorts: { id: "ytNOVO" } }), T0) ?? "", /não o ytOLD/);
    assert.match(replacementGrantRefusal(replacementManifest(), entries({ youtube_shorts: { scheduled_at: "2026-11-15T19:00:00.000Z" } }), T0) ?? "", /horário do plano/);
    assert.match(replacementGrantRefusal(replacementManifest(), entries({ youtube_shorts: { status: "published" } }), T0) ?? "", /não está agendado/);
    assert.match(replacementGrantRefusal(replacementManifest(), entries(), new Date(Date.parse(YT_AT) - 20 * 60_000)) ?? "", /30 min ou menos/);
  });

  it("dry-run normal avisa quando o vídeo local não é o registrado", () => {
    const w = shortVideoChangeWarnings(entries(), V2);
    assert.equal(w.length, 1);
    assert.match(w[0], /youtube_shorts.*--replace-scheduled/);
    assert.deepEqual(shortVideoChangeWarnings(entries(), V1), []);
  });
});

describe("#12279 registro: o post trocado deixa de contar", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shorts-replace-12279-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: ED, entries: entries() }));
    // Cópia de conflito do OneDrive com o mesmo ID antigo: não pode ressuscitá-lo.
    writeFileSync(join(dir, "_internal", "06-shorts-published-Neo.json"), JSON.stringify({ aammdd: ED, entries: entries().slice(0, 1) }));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("histórico gravado tira o par destino/ID de todos os arquivos; idempotente", () => {
    const rec = { destination: "youtube_shorts", id: "ytOLD", scheduled_at: YT_AT, replaced_at: T0.toISOString(), new_video_sha256: V2 };
    recordShortReplacement(dir, rec);
    recordShortReplacement(dir, rec);
    assert.equal(readShortReplacements(dir).length, 1);
    const view = readShortsRegistry(dir, ED);
    assert.equal(view.entries.find((e) => e.destination === "youtube_shorts"), undefined);
    assert.ok(view.entries.find((e) => e.destination === "facebook:diaria"));
  });

  it("histórico ilegível lança (nunca ressuscita às cegas)", () => {
    writeFileSync(join(dir, SHORTS_REPLACED_FILE), "{ quebrado");
    assert.throws(() => readShortsRegistry(dir, ED), /JSON inválido/);
  });
});

describe("#12279 Buffer: preparo pendente, --mark-replaced e --mark --replaces", () => {
  it("o preparo diz que o post ainda não existe (pending_buffer_create)", async () => {
    const r = await prepareBufferItem({ destination: "x", mode: "guided", action: "buffer", caption: "t", scheduledAt: FB_AT, detail: "" } as never, async () => "https://r2/v.mp4");
    assert.equal(r.ok, true);
    assert.equal(r.pending_buffer_create, true);
  });

  const store = (status: string, id = "buffer:xOLD", hash: string | null = V2) => ({
    authorizations: [{ part: "vertical", destination: "x", status, plan_sha256: "p1", replacement: { id, at: FB_AT } }],
    approved_manifests: { p1: { media: { video_sha256: hash } } },
  });
  const base = { destination: "x", bufferId: "xNEW", replaces: "buffer:xOLD", scheduledAt: FB_AT, videoSha256: V2, entries: entries(), replaced: [] };

  it("só depois da rodada de troca que consumiu a autorização deste post, no mesmo horário e com o hash aprovado", () => {
    assert.equal(bufferReplacementMarkRefusal({ ...base, store: store("consumed") }), null);
    assert.match(bufferReplacementMarkRefusal({ ...base, store: store("active") }) ?? "", /consumiu a autorização de substituição/);
    assert.match(bufferReplacementMarkRefusal({ ...base, store: store("consumed", "buffer:outro") }) ?? "", /consumiu/);
    assert.match(bufferReplacementMarkRefusal({ ...base, scheduledAt: "2026-11-15T18:00:00.000Z", store: store("consumed") }) ?? "", /horário do antigo/);
    assert.match(bufferReplacementMarkRefusal({ ...base, replaces: "buffer:outro", store: store("consumed") }) ?? "", /registro aponta/);
    assert.match(bufferReplacementMarkRefusal({ ...base, store: "ilegível" }) ?? "", /ilegível/);
  });

  it("--video-sha256 obrigatório e igual ao V2 aprovado no manifesto de troca", () => {
    assert.match(bufferReplacementMarkRefusal({ ...base, videoSha256: undefined, store: store("consumed") }) ?? "", /exige --video-sha256/);
    assert.match(bufferReplacementMarkRefusal({ ...base, videoSha256: V1, store: store("consumed") }) ?? "", /não é o do V2 aprovado/);
    assert.match(bufferReplacementMarkRefusal({ ...base, store: store("consumed", "buffer:xOLD", null) }) ?? "", /sem hash no plano aprovado/);
  });

  it("depois do --mark-replaced (o antigo já no histórico), o --mark --replaces confere o horário pelo histórico", () => {
    const noX = entries().filter((e) => e.destination !== "x");
    const replaced = [{ destination: "x", id: "buffer:xOLD", scheduled_at: FB_AT }];
    assert.equal(bufferReplacementMarkRefusal({ ...base, entries: noX, replaced, store: store("consumed") }), null);
    assert.match(bufferReplacementMarkRefusal({ ...base, entries: noX, replaced: [], store: store("consumed") }) ?? "", /nem o registro nem o histórico/);
  });

  it("--mark-replaced: só o post antigo agendado, só depois do consumo da troca dele", () => {
    assert.equal(bufferDeletedRefusal({ mark: "x=buffer:xOLD", entries: entries(), store: store("consumed") }).ok, true);
    assert.equal(bufferDeletedRefusal({ mark: "x=buffer:xOLD", entries: entries(), store: store("active") }).ok, false);
    assert.equal(bufferDeletedRefusal({ mark: "x=buffer:outro", entries: entries(), store: store("consumed", "buffer:outro") }).ok, false);
    assert.equal(bufferDeletedRefusal({ mark: "youtube_shorts=buffer:x", entries: entries(), store: store("consumed") }).ok, false);
  });

  it("ordem do --mark --replaces: registro novo primeiro; persist falhando = nada arquivado", () => {
    const calls: string[] = [];
    const failed = applyBufferReplacementMark({ persist: () => { throw new Error("EBUSY"); }, record: () => { calls.push("record"); }, warn: () => {} });
    assert.equal(failed.ok, false);
    assert.deepEqual(calls, [], "o histórico não é gravado sem o registro novo");
    const order: string[] = [];
    assert.equal(applyBufferReplacementMark({ persist: () => { order.push("persist"); }, record: () => { order.push("record"); }, warn: () => {} }).ok, true);
    assert.deepEqual(order, ["persist", "record"]);
    const warns: string[] = [];
    assert.equal(applyBufferReplacementMark({ persist: () => {}, record: () => { throw new Error("lock"); }, warn: (m) => { warns.push(m); } }).ok, true);
    assert.equal(warns.length, 1);
  });
});

describe("#12279 CLI e lock", () => {
  it("--replace-scheduled é flag; não combina com publicação na hora, timers, corte nem --mark", () => {
    assert.ok((SHORTS_BOOLEAN_FLAGS as readonly string[]).includes("replace-scheduled"));
    assert.equal(replaceScheduledArgsError(new Set(["replace-scheduled", "publish"]), { video: "v.mp4" }), null);
    for (const f of ["now", "linkedin-timer", "update-scheduled", "force-youtube"]) {
      assert.match(replaceScheduledArgsError(new Set(["replace-scheduled", f]), {}) ?? "", new RegExp(`--${f}`));
    }
    assert.match(replaceScheduledArgsError(new Set(["replace-scheduled"]), { corte: "s" }) ?? "", /--corte/);
    assert.match(replaceScheduledArgsError(new Set(["replace-scheduled"]), { mark: "x=buffer:1" }) ?? "", /--mark/);
    assert.match(replaceScheduledArgsError(new Set(), { replaces: "buffer:1" }) ?? "", /só vale com --mark/);
  });

  it("lock vivo da troca segura o --publish (sem flag que o contorne); lock velho é reaproveitado", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-replace-lock-12279-"));
    try {
      assert.equal(replaceLockBusy(dir), "free");
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "shorts-replace.lock"), "{}");
      assert.equal(replaceLockBusy(dir, () => null), "busy");
      let released = false;
      assert.equal(replaceLockBusy(dir, () => () => { released = true; }), "free");
      assert.equal(released, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Facebook da troca nunca cai em 'na hora': horário perto recusa antes de qualquer chamada", async () => {
    let fetched = 0;
    const deps = { fetch: async () => { fetched++; throw new Error("não deveria chamar"); }, sleep: async () => {}, now: () => T0, log: () => {} };
    await assert.rejects(
      publishFacebookReel(deps as never, { slug: "diaria", token: "t", missing: [] } as never, "v21.0", Buffer.from("x"), "legenda", at(5).toISOString(), null, true),
      /não publica na hora/,
    );
    assert.equal(fetched, 0);
  });
});

describe("#12279 grant pela CLI confere o registro local", () => {
  let dir: string;
  const io = () => {
    const err: string[] = [];
    return { err, io: { log: () => {}, err: (l: string) => err.push(l), now: () => T0 } };
  };
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shorts-replace-cli-12279-"));
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeVideoPlanManifest(dir, replacementManifest(), { replacement: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const argv = (extra: string[] = []) => ["grant", ED, "--part", "vertical", "--plan-sha256", planSha256(replacementManifest()), "--confirmation", CONFIRM, "--edition-dir", dir, ...extra];

  it("registro batendo: grava a autorização de substituição", () => {
    writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: ED, entries: entries() }));
    const o = io();
    assert.equal(authorizeMain(argv(["--replace-scheduled"]), o.io), 0, o.err.join("\n"));
    const store = readAuthorizationStore(dir, ED);
    assert.ok(store.authorizations.every((a) => a.status === "active" && a.replacement));
  });

  it("post antigo já trocado no registro: recusa; sem a flag o manifesto de troca não é lido", () => {
    writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: ED, entries: entries({ youtube_shorts: { id: "ytNOVO" } }) }));
    const o = io();
    assert.equal(authorizeMain(argv(["--replace-scheduled"]), o.io), 1);
    assert.match(o.err.join("\n"), /não o ytOLD/);
    const o2 = io();
    assert.equal(authorizeMain(argv(), o2.io), 1);
    assert.match(o2.err.join("\n"), /sem o manifesto do dry-run do vertical/);
  });
});

describe("#12279 review da PR #13107: grant sob o lock, folga do YouTube, histórico e canal", () => {
  it("o grant de troca confere o registro DENTRO de grantVideoPublishAuthorization (sem registro = recusa)", () => {
    const m = replacementManifest();
    const noRegistry = grantVideoPublishAuthorization(afterOriginalPublish(), { manifest: m, planSha256: planSha256(m), confirmation: CONFIRM, now: T0, isPidAlive: () => false, replacement: true });
    assert.equal(noRegistry.ok, false);
    assert.match(noRegistry.ok ? "" : noRegistry.error, /sem o registro do vertical/);
    const moved = grant(afterOriginalPublish(), m, { replacement: true, registry: entries({ youtube_shorts: { id: "ytNOVO" } }) });
    assert.equal(moved.ok, false);
    assert.match(moved.ok ? "" : moved.error, /não o ytOLD/);
  });

  it("folga de 10 min vale para qualquer destino da troca, YouTube incluso", () => {
    const now = new Date(Date.parse(YT_AT) - 9 * 60_000);
    assert.match(replacementUploadRefusal(YT_AT, now) ?? "", /não publica na hora/);
    assert.equal(replacementUploadRefusal(YT_AT, new Date(Date.parse(YT_AT) - 11 * 60_000)), null);
    assert.match(replacementUploadRefusal(null, T0) ?? "", /nenhum/);
  });

  it("o histórico esconde só a entrada AGENDADA antiga; send_unknown com o mesmo ID fica visível", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-replace-hist-12279-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "06-shorts-published.json"), JSON.stringify({ aammdd: ED, entries: entries({ youtube_shorts: { status: "send_unknown" } }) }));
      recordShortReplacement(dir, { destination: "youtube_shorts", id: "ytOLD", scheduled_at: YT_AT, replaced_at: T0.toISOString(), new_video_sha256: V2 });
      assert.equal(readShortsRegistry(dir, ED).entries.find((e) => e.destination === "youtube_shorts")?.status, "send_unknown");
      assert.deepEqual(replacedYouTubeIds(dir), ["ytOLD"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a conferência do canal ignora o Short trocado (sem o loop da recuperação)", () => {
    const v1 = { id: "ytOLD", snippet: { title: `Título ${ED} #Shorts`, description: "", tags: [] }, status: { privacyStatus: "private" } };
    assert.equal(matchEditionVideo([v1] as never, { aammdd: ED, title: "Título", kind: "short" })?.videoId, "ytOLD");
    assert.equal(matchEditionVideo([v1] as never, { aammdd: ED, title: "Título", kind: "short", ignoreVideoIds: ["ytOLD"] }), null);
  });

  it("--from-drive não combina com a troca (sobrescreveria o vertical dos outros destinos)", () => {
    assert.match(replaceScheduledArgsError(new Set(["replace-scheduled"]), { "from-drive": "abcdefghijk" }) ?? "", /--from-drive.*--video PATH/);
    assert.equal(replacementPublishCommand(ED, { video: "/v2.mp4" }), `npx tsx scripts/publish-shorts.ts ${ED} --replace-scheduled --video /v2.mp4 --publish --confirm-publish ${ED}`);
  });

  it("lock ilegível conta como troca em curso (falha fechada)", () => {
    const dir = mkdtempSync(join(tmpdir(), "shorts-replace-lock2-12279-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "shorts-replace.lock"), "{}");
      const st = replaceLockBusy(dir, () => { throw new Error("EACCES"); });
      assert.ok(typeof st === "object", "ilegível segue fechando");
      assert.match(typeof st === "object" ? st.unreadable : "", /shorts-replace\.lock ilegível \(EACCES\).*remova-o/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12279 fiação do main(): a troca não passa pelo consumo normal nem pelo KV/repost", () => {
  const src = publishShortsSource();
  it("consumo normal, KV do /video e repost ficam fora da rodada de troca", () => {
    assert.match(src, /if \(planGated && !replaceRun\) \{/);
    assert.match(src, /shouldUpdateLatestVideoOnPublish\(\{ corte: !!corte, writer \}\) && !replaceRun &&/);
    assert.match(src, /const repostAuthorized = !replaceRun && \(/);
  });
  it("o cancelamento só existe dentro do runScheduledReplacement, depois do consume", () => {
    const phase = src.indexOf("const phase = await runScheduledReplacement(replaceTargets, {");
    const consume = src.indexOf("consumeBeforeExternalEffects({", phase);
    const yt = src.indexOf("rescheduleScheduledVideo(defaultYouTubeUploadDeps, ytCreds(), t.old_id");
    const fb = src.indexOf("cancelFacebookScheduledVideo(defaultGraphDeps, page, apiVersion, t.old_id");
    const end = src.indexOf("if (phase.refused !== null) {", phase);
    assert.ok(phase > 0 && consume > phase && yt > consume && fb > consume && end > yt && end > fb);
    assert.equal(src.split("t.old_id, null, REPLACE_MIN_LEAD_MS").length, 2, "um único cancelamento do YouTube na troca");
    assert.equal(src.split("apiVersion, t.old_id, REPLACE_MIN_LEAD_MS").length, 2, "um único cancelamento do Facebook na troca");
  });
});

describe("#12279 --replace-scheduled por processo real (sem rede)", () => {
  const ROOT = join(import.meta.dirname, "..");
  // Edição de amanhã: o slot do Facebook ainda está à frente e o post antigo agendado a 20 h.
  const tomorrow = new Date(Date.now() + 24 * 3600_000);
  const SED = `${String(tomorrow.getUTCFullYear()).slice(2)}${String(tomorrow.getUTCMonth() + 1).padStart(2, "0")}${String(tomorrow.getUTCDate()).padStart(2, "0")}`;
  const OLD_AT = new Date(Date.now() + 20 * 3600_000).toISOString();
  const REVIEWED = "DESTAQUE 1 | SEGURANÇA\n\n[IA ladra? O cofre que o modelo abriu](https://fonte.exemplo.com/artigo)\n\nPesquisadores mostraram que um agente abriu o cofre.\n\nPor que isso importa: porque sim.\n";
  const env = {
    ...process.env,
    DIARIA_LINKEDIN_CRON_URL: "", DIARIA_LINKEDIN_CRON_TOKEN: "", FACEBOOK_PAGE_ID: "123", FACEBOOK_PAGE_ACCESS_TOKEN: "fake",
    INSTAGRAM_BUSINESS_ACCOUNT_ID: "", INSTAGRAM_ACCESS_TOKEN: "", YOUTUBE_REFRESH_TOKEN: "", YOUTUBE_CHANNEL_ID: "",
    R2_ACCOUNT_ID: "", R2_ACCESS_KEY_ID: "", R2_SECRET_ACCESS_KEY: "", R2_BUCKET: "", LINKEDIN_PERSONAL_ACCESS_TOKEN: "",
  };
  const box = (type: string, payload: Buffer) => {
    const h = Buffer.alloc(8);
    h.writeUInt32BE(8 + payload.length, 0);
    h.write(type, 4, "latin1");
    return Buffer.concat([h, payload]);
  };
  const mp4 = (tag: string) => {
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(1000, 12);
    mvhd.writeUInt32BE(30_000, 16);
    return Buffer.concat([box("ftyp", Buffer.alloc(16)), box("free", Buffer.from(tag)), box("moov", box("mvhd", mvhd))]);
  };
  let dir: string;
  let v2: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ps-12279-"));
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(
      join(dir, "_internal", "06-shorts-published.json"),
      JSON.stringify({ aammdd: SED, entries: [{ destination: "facebook:diaria", status: "scheduled", id: "fbOLD", scheduled_at: OLD_AT, at: new Date().toISOString(), video_sha256: sha256Hex("V1") }] }),
    );
    v2 = join(dir, "v2.mp4");
    writeFileSync(v2, mp4("V2"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const cli = (args: string[]) =>
    spawnSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "publish-shorts.ts"), SED, "--edition-dir", dir, "--allow-unwatched-dir", "--replace-scheduled", "--video", v2, ...args], { encoding: "utf8", cwd: ROOT, env });
  const untouched = () => {
    assert.ok(!existsSync(join(dir, "_internal", "06-shorts-replaced.json")), "nenhum histórico: nada cancelado");
    const reg = JSON.parse(readFileSync(join(dir, "_internal", "06-shorts-published.json"), "utf8"));
    assert.equal(reg.entries[0].id, "fbOLD");
  };

  it("--publish sem grant de troca: exit 2 antes de qualquer cancelamento, sem marca nem histórico", () => {
    const r = cli(["--publish", "--confirm-publish", SED]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /substituição recusada pela autorização do plano/);
    untouched();
    assert.ok(!existsSync(shortsSendingPath(dir, "main")), "nenhuma marca cancelando");
  });

  it("dry-run → grant --replace-scheduled → V2 trocado depois: o --publish recusa pelo hash, nada cancelado", () => {
    const dry = cli([]);
    assert.equal(dry.status, 0, dry.stderr);
    const out = JSON.parse(dry.stdout) as { plan_sha256: string; targets: Array<{ destination: string; at: string }> };
    assert.equal(out.targets[0].destination, "facebook:diaria");
    assert.equal(out.targets[0].at, OLD_AT, "horário preservado");
    const io = { log: () => {}, err: () => {}, now: () => new Date() };
    assert.equal(authorizeMain(["grant", SED, "--part", "vertical", "--replace-scheduled", "--plan-sha256", out.plan_sha256, "--confirmation", CONFIRM, "--edition-dir", dir], io), 0);
    writeFileSync(v2, mp4("V3"));
    const r = cli(["--publish", "--confirm-publish", SED]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /media\.video_sha256/);
    untouched();
    assert.equal(readAuthorizationStore(dir, SED).authorizations.at(-1)?.status, "active", "recusa não consome");
  });
});

describe("#12279 re-review: P3 do delta", () => {
  it("next_steps da Buffer inclui o --mark-replaced logo depois do delete_post", () => {
    const t = bufferReplaceNextSteps("x", "buffer:xOLD", FB_AT, V2);
    assert.match(t, /delete_post, logo em seguida --mark-replaced x=buffer:xOLD, create_post/);
    assert.match(t, new RegExp(`--mark x=buffer:NOVO --replaces buffer:xOLD --scheduled-at ${FB_AT} --video-sha256 ${V2}$`));
    const src = publishShortsSource();
    assert.match(src, /next_steps: bufferReplaceNextSteps\(item\.destination, bufferReplace\.old_id, bufferReplace\.at, videoHash\)/);
  });

  it("registro ilegível na releitura não vira 'marca não gravada' e nada é marcado", async () => {
    const calls: string[] = [];
    const r = await runScheduledReplacement([{ destination: "youtube_shorts", kind: "api", old_id: "ytOLD", at: YT_AT }], {
      consume: () => ({ ok: true }),
      stillRegistered: () => { throw new Error("JSON inválido"); },
      markCancelling: () => { calls.push("mark"); },
      clearCancelling: () => {},
      cancel: async () => { calls.push("cancel"); },
      record: () => {},
      clearMarks: () => {},
      warn: () => {},
    });
    const res = r.refused === null ? r.results[0] : null;
    assert.equal(res?.outcome, "failed");
    assert.match(res?.outcome === "failed" ? res.error : "", /registro ilegível na releitura \(JSON inválido\)/);
    assert.doesNotMatch(res?.outcome === "failed" ? res.error : "", /marca de cancelamento/);
    assert.deepEqual(calls, []);
  });

  it("histórico que não grava: a mensagem diz que a marca fica, trava as rodadas e como limpá-la", async () => {
    const r = await runScheduledReplacement([{ destination: "youtube_shorts", kind: "api", old_id: "ytOLD", at: YT_AT }], {
      consume: () => ({ ok: true }),
      stillRegistered: () => true,
      markCancelling: () => {},
      clearCancelling: () => {},
      cancel: async (_t, w) => { w(); },
      record: () => { throw new Error("EBUSY"); },
      clearMarks: () => {},
      warn: () => {},
    });
    const err = r.refused === null && r.results[0].outcome === "failed" ? r.results[0].error : "";
    assert.match(err, /marca "cancelando" de youtube_shorts FICA e trava as próximas rodadas/);
    assert.match(err, /Registre o histórico à mão .*id ytOLD.*e só então tire a marca/);
  });

  it("Facebook relido em outro horário: recusa própria citando o esperado e o lido, sem DELETE", async () => {
    const readAt = Math.floor(Date.parse("2026-11-15T19:00:00.000Z") / 1000);
    let deletes = 0;
    const deps = {
      fetch: async (_u: string, init?: { method?: string }) => {
        if (init?.method === "DELETE") { deletes++; return new Response(JSON.stringify({ success: true }), { status: 200 }); }
        return new Response(JSON.stringify({ published: false, scheduled_publish_time: readAt }), { status: 200 });
      },
      sleep: async () => {}, now: () => T0, log: () => {},
    };
    await assert.rejects(
      cancelFacebookScheduledVideo(deps as never, { slug: "diaria", token: "t", missing: [] } as never, "v21.0", "fbOLD", 30 * 60_000, { expectedAt: FB_AT }),
      new RegExp(`agendado na página para 2026-11-15T19:00:00\\.000Z, não para o horário esperado ${FB_AT.replace(/\./g, "\\.")}`),
    );
    assert.equal(deletes, 0);
  });
});
