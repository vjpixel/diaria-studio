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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  applyReplacementTimes,
  planScheduledReplacements,
  replacementGrantRefusal,
  replacementPublishCommand,
  runScheduledReplacement,
  shortVideoChangeWarnings,
  type ShortReplacementTarget,
} from "../scripts/lib/diaria/short-scheduled-replace.ts";
import { readShortReplacements, readShortsRegistry, recordShortReplacement, SHORTS_REPLACED_FILE } from "../scripts/lib/diaria/shorts-published-store.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import { main as authorizeMain } from "../scripts/video-publish-authorize.ts";
import {
  bufferReplacementMarkRefusal,
  prepareBufferItem,
  publishFacebookReel,
  replaceLockBusy,
  replaceScheduledArgsError,
  SHORTS_BOOLEAN_FLAGS,
} from "../scripts/publish-shorts.ts";

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

function grant(store: VideoPublishAuthorizationStore, m: VideoPlanManifest, extra: { replacement?: boolean; isPidAlive?: (pid: number) => boolean } = {}) {
  return grantVideoPublishAuthorization(store, { manifest: m, planSha256: planSha256(m), confirmation: CONFIRM, now: T0, isPidAlive: () => false, ...extra });
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

  it("consome primeiro; consumo recusado = nenhuma exclusão", async () => {
    const calls: string[] = [];
    const deps = (consumeOk: boolean) => ({
      consume: () => {
        calls.push("consume");
        return consumeOk ? ({ ok: true } as const) : ({ ok: false, error: "plano mudou" } as const);
      },
      stillRegistered: () => true,
      cancel: async (t: ShortReplacementTarget) => {
        calls.push(`cancel:${t.destination}`);
      },
      record: (t: ShortReplacementTarget) => {
        calls.push(`record:${t.destination}`);
      },
      clearMarks: () => {},
    });
    const refused = await runScheduledReplacement(targets, deps(false));
    assert.deepEqual(refused, { refused: "plano mudou" });
    assert.deepEqual(calls, ["consume"]);
    calls.length = 0;
    const ok = await runScheduledReplacement(targets, deps(true));
    assert.equal(ok.refused, null);
    assert.deepEqual(calls, ["consume", "cancel:youtube_shorts", "record:youtube_shorts", "cancel:facebook:diaria", "record:facebook:diaria"]);
    assert.deepEqual(ok.refused === null ? ok.results.map((r) => r.outcome) : [], ["cancelled", "cancelled", "buffer"]);
  });

  it("cancelamento recusado pela plataforma: sem histórico, sem envio novo; os outros seguem", async () => {
    const recorded: string[] = [];
    const r = await runScheduledReplacement(targets, {
      consume: () => ({ ok: true }),
      stillRegistered: () => true,
      cancel: async (t) => {
        if (t.destination === "youtube_shorts") throw new Error("não está agendado com folga");
      },
      record: (t) => {
        recorded.push(t.destination);
      },
      clearMarks: () => {},
    });
    assert.equal(r.refused, null);
    const results = r.refused === null ? r.results : [];
    assert.equal(results[0].outcome, "failed");
    assert.match(results[0].error ?? "", /NÃO cancelado: não está agendado com folga/);
    assert.deepEqual(recorded, ["facebook:diaria"]);
  });

  it("registro mudou desde o plano: nada apagado nesse destino", async () => {
    let cancelled = 0;
    const r = await runScheduledReplacement(targets.slice(0, 1), {
      consume: () => ({ ok: true }),
      stillRegistered: () => false,
      cancel: async () => {
        cancelled++;
      },
      record: () => {},
      clearMarks: () => {},
    });
    assert.equal(cancelled, 0);
    assert.equal(r.refused === null ? r.results[0].outcome : "", "failed");
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

describe("#12279 Buffer: preparo pendente e --mark --replaces", () => {
  it("o preparo diz que o post ainda não existe (pending_buffer_create)", async () => {
    const r = await prepareBufferItem({ destination: "x", mode: "guided", action: "buffer", caption: "t", scheduledAt: FB_AT, detail: "" } as never, async () => "https://r2/v.mp4");
    assert.equal(r.ok, true);
    assert.equal(r.pending_buffer_create, true);
  });

  const auths = (status: string, id = "buffer:xOLD") => [{ part: "vertical", destination: "x", status, replacement: { id, at: FB_AT } }];
  const base = { destination: "x", bufferId: "xNEW", replaces: "buffer:xOLD", scheduledAt: FB_AT, entries: entries() };

  it("só depois da rodada de troca que consumiu a autorização deste post, no mesmo horário", () => {
    assert.equal(bufferReplacementMarkRefusal({ ...base, authorizations: auths("consumed") }), null);
    assert.match(bufferReplacementMarkRefusal({ ...base, authorizations: auths("active") }) ?? "", /consumiu a autorização de substituição/);
    assert.match(bufferReplacementMarkRefusal({ ...base, authorizations: auths("consumed", "buffer:outro") }) ?? "", /consumiu/);
    assert.match(bufferReplacementMarkRefusal({ ...base, scheduledAt: "2026-11-15T18:00:00.000Z", authorizations: auths("consumed") }) ?? "", /horário do antigo/);
    assert.match(bufferReplacementMarkRefusal({ ...base, replaces: "buffer:outro", authorizations: auths("consumed") }) ?? "", /registro aponta/);
    assert.match(bufferReplacementMarkRefusal({ ...base, authorizations: "ilegível" }) ?? "", /ilegível/);
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
      assert.equal(replaceLockBusy(dir), false);
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "_internal", "shorts-replace.lock"), "{}");
      assert.equal(replaceLockBusy(dir, () => null), true);
      let released = false;
      assert.equal(replaceLockBusy(dir, () => () => { released = true; }), false);
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
