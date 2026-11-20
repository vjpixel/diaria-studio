/**
 * test/short-vertical-cover-step-13708.test.ts (#13708)
 *
 * A capa vertical do Short (Passo B3a do `/diaria-publica`, Studio web via
 * Chrome, #12254) é obrigatória. Na edição 261119 o Short subiu pela API, o
 * Chrome não estava conectado e o B3a ficou como pendência em prosa: o
 * `publica-phase.ts join` saía 0 com `vertical_feed: "manual"` no registro.
 *
 * Agora: o join sai 1 com a capa pendente sem dono; `short-vertical-cover.ts
 * defer` registra o dono automático (task one-shot, #11550) e o join passa
 * relatando o dono; `confirm` (persistência no Studio e/ou a saída do
 * `check-short-feed-cover.ts`) troca só o `vertical_feed` para `studio_web`.
 *
 * Nada publica nem chama o YouTube: registro em diretório temporário.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORT_VERTICAL_COVER_OWNER_FILE,
  assessShortVerticalCoverStep,
  buildShortVerticalCoverOwner,
  confirmedVerticalCover,
  describeShortVerticalCoverStep,
  parseFeedCheck,
  youtubeVideoIdOf,
} from "../scripts/lib/diaria/short-vertical-cover-step.ts";
import { keepStudioWebVerticalFeed, type ShortCoverRecord } from "../scripts/lib/diaria/short-cover.ts";
import { SHORTS_PUBLISHED_FILE, type ShortPublishedEntry, type ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import { main as coverMain } from "../scripts/short-vertical-cover.ts";
import { main as phaseMain, defaultPhaseCliDeps } from "../scripts/publica-phase.ts";
import { buildMarkEntry, parseMarkArg } from "../scripts/publish-shorts.ts";

const ED = "261119";
const VID = "AbCdEfGhIjK";
const NOW = new Date("2026-11-19T15:00:00.000Z");

function shortEntry(over: Partial<ShortPublishedEntry> = {}): ShortPublishedEntry {
  return {
    destination: "youtube_shorts",
    status: "scheduled",
    id: VID,
    url: `https://youtube.com/shorts/${VID}`,
    scheduled_at: "2026-11-20T09:30:00.000Z",
    at: "2026-11-19T14:00:00.000Z",
    cover: { method: "thumbnails_set", ok: true, vertical_feed: "manual" },
    video_sha256: "a".repeat(64),
    ...over,
  };
}

function registry(...entries: ShortPublishedEntry[]): ShortsPublishedFile {
  return { aammdd: ED, entries };
}

describe("assessShortVerticalCoverStep (#13708)", () => {
  it("sem youtube_shorts no registro: não se aplica", () => {
    assert.equal(assessShortVerticalCoverStep(registry(), null).state, "not-applicable");
    assert.equal(assessShortVerticalCoverStep(null, null).state, "not-applicable");
  });

  it("cancelado: não se aplica", () => {
    assert.equal(assessShortVerticalCoverStep(registry(shortEntry({ cancelled_at: "2026-11-19T15:00:00Z" })), null).state, "not-applicable");
  });

  it("vertical_feed manual (o caso de 261119): pendente sem dono, e o join acusa", () => {
    const step = assessShortVerticalCoverStep(registry(shortEntry()), null);
    assert.equal(step.state, "pending");
    const d = describeShortVerticalCoverStep(ED, step);
    assert.match(d.problem ?? "", /capa vertical do Short AbCdEfGhIjK pendente \(vertical_feed: manual\)/);
    assert.match(d.problem ?? "", /short-vertical-cover\.ts defer 261119/);
  });

  it("first_frame_cover e cover ausente também ficam pendentes", () => {
    for (const cover of [{ method: "thumbnails_set", ok: true, vertical_feed: "first_frame_cover", first_frame_ms: 1000 } as ShortCoverRecord, undefined]) {
      assert.equal(assessShortVerticalCoverStep(registry(shortEntry({ cover })), null).state, "pending");
    }
  });

  it("studio_web: feito", () => {
    const step = assessShortVerticalCoverStep(registry(shortEntry({ cover: { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" } })), null);
    assert.equal(step.state, "done");
    assert.equal(describeShortVerticalCoverStep(ED, step).problem, null);
  });

  it("dono do mesmo vídeo vale; dono de outro vídeo não", () => {
    const owner = buildShortVerticalCoverOwner({ aammdd: ED, videoId: VID, now: NOW });
    const ok = assessShortVerticalCoverStep(registry(shortEntry()), owner);
    assert.ok(ok.state === "pending" && ok.owner);
    assert.equal(describeShortVerticalCoverStep(ED, ok).problem, null);
    const stale = assessShortVerticalCoverStep(registry(shortEntry()), { ...owner, video_id: "ZZZZZZZZZZZ" });
    assert.ok(stale.state === "pending" && !stale.owner && stale.stale_owner);
    assert.match(describeShortVerticalCoverStep(ED, stale).problem ?? "", /outro vídeo/);
  });
});

describe("youtubeVideoIdOf (#13708)", () => {
  it("id cru, /shorts/, watch?v=, youtu.be", () => {
    assert.equal(youtubeVideoIdOf({ id: VID }), VID);
    assert.equal(youtubeVideoIdOf({ id: `https://www.youtube.com/shorts/${VID}?feature=share` }), VID);
    assert.equal(youtubeVideoIdOf({ id: `https://www.youtube.com/watch?v=${VID}&t=1` }), VID);
    assert.equal(youtubeVideoIdOf({ id: `https://youtu.be/${VID}` }), VID);
    assert.equal(youtubeVideoIdOf({ id: "send-unknown" }), null);
  });
});

describe("buildShortVerticalCoverOwner (#13708)", () => {
  it("agent-scheduled-task, at default agora + 15 min, comando da skill", () => {
    const o = buildShortVerticalCoverOwner({ aammdd: ED, videoId: VID, now: NOW });
    assert.equal(o.by, "agent-scheduled-task");
    assert.equal(o.at, "2026-11-19T15:15:00.000Z");
    assert.equal(o.command, `/diaria-publica ${ED} --so vertical`);
  });
  it("sem id de vídeo recusa", () => {
    assert.throws(() => buildShortVerticalCoverOwner({ aammdd: ED, videoId: null, now: NOW }), /sem id de vídeo/);
  });
});

describe("parseFeedCheck (#13708)", () => {
  const out = (over: Record<string, unknown> = {}) =>
    JSON.stringify({ verdict: "capa", distance: 0.05, threshold: 0.2, image: "sardefault", feed_url: `https://i.ytimg.com/vi/${VID}/sardefault.jpg`, ...over });
  it("sardefault do mesmo vídeo vale", () => {
    const r = parseFeedCheck(out(), VID, NOW);
    assert.deepEqual(r, { verdict: "capa", distance: 0.05, threshold: 0.2, checked_at: NOW.toISOString() });
  });
  it("oar2, outro vídeo ou medição offline recusam", () => {
    assert.throws(() => parseFeedCheck(out({ image: "oar2", feed_url: `https://i.ytimg.com/vi/${VID}/oar2.jpg` }), VID, NOW), /oar2/);
    assert.throws(() => parseFeedCheck(out({ feed_url: "https://i.ytimg.com/vi/ZZZZZZZZZZZ/sardefault.jpg" }), VID, NOW), /outro vídeo/);
    assert.throws(() => parseFeedCheck(JSON.stringify({ verdict: "capa", distance: 0.1, feed_image: "/tmp/x.jpg" }), VID, NOW), /outro vídeo ou offline/);
  });
});

describe("confirmedVerticalCover (#13708)", () => {
  const prior: ShortCoverRecord = { method: "thumbnails_set", ok: true, vertical_feed: "manual" };
  it("sem prova recusa", () => {
    assert.throws(() => confirmedVerticalCover(prior, { studioPersisted: false, feedCheck: null }), /sem prova/);
  });
  it("só a medição, com o feed mostrando outro frame, recusa", () => {
    assert.throws(
      () => confirmedVerticalCover(prior, { studioPersisted: false, feedCheck: { verdict: "frame-automatico", distance: 0.4, checked_at: NOW.toISOString() } }),
      /não mostra a capa/,
    );
  });
  it("persistência no Studio fecha; medição divergente fica registrada", () => {
    const fc = { verdict: "frame-automatico" as const, distance: 0.21, checked_at: NOW.toISOString() };
    const r = confirmedVerticalCover(prior, { studioPersisted: true, feedCheck: fc });
    assert.deepEqual(r, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web", feed_check: fc });
  });
  it("medição com a capa fecha sozinha", () => {
    const r = confirmedVerticalCover(prior, { studioPersisted: false, feedCheck: { verdict: "capa", distance: 0.02, checked_at: NOW.toISOString() } });
    assert.equal(r.vertical_feed, "studio_web");
  });
  it("Short sem cover (guiado) ganha registro thumbnails_set com ok false", () => {
    const r = confirmedVerticalCover(undefined, { studioPersisted: true, feedCheck: null });
    assert.equal(r.method, "thumbnails_set");
    assert.equal(r.ok, false);
    assert.equal(r.vertical_feed, "studio_web");
  });
  it("re-execução (--update-scheduled) preserva feed_check junto do studio_web", () => {
    const fc = { verdict: "capa" as const, distance: 0.02, checked_at: NOW.toISOString() };
    const kept = keepStudioWebVerticalFeed({ method: "thumbnails_set", ok: true, vertical_feed: "manual" }, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web", feed_check: fc });
    assert.deepEqual(kept, { method: "thumbnails_set", ok: true, vertical_feed: "studio_web", feed_check: fc });
  });
});

describe("CLI + publica-phase join (#13708)", () => {
  let dir: string;
  let out: string[];
  let errs: string[];
  const deps = () => ({ log: (l: string) => out.push(l), err: (l: string) => errs.push(l), now: () => NOW });
  const join_ = () => phaseMain(["join", ED, "--edition-dir", dir], { ...defaultPhaseCliDeps, log: (l) => out.push(l), err: (l) => errs.push(l) });
  const writeRegistry = (...entries: ShortPublishedEntry[]) => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, SHORTS_PUBLISHED_FILE), JSON.stringify(registry(...entries), null, 2));
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "short-vcover-13708-"));
    out = [];
    errs = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("sem registro do vertical o join não muda (só horizontal)", async () => {
    assert.equal(await join_(), 0);
  });

  // #13726: o join (não só o assess puro) acusa os dois outros estados pendentes.
  it("#13726: vertical_feed first_frame_cover: join 1 com a capa pendente", async () => {
    writeRegistry(shortEntry({ cover: { method: "thumbnails_set", ok: true, vertical_feed: "first_frame_cover", first_frame_ms: 1000 } }));
    assert.equal(await join_(), 1);
    assert.match(errs.join("\n"), /capa vertical do Short AbCdEfGhIjK pendente \(vertical_feed: first_frame_cover\)/);
  });

  it("#13726: entrada gravada pelo --mark youtube_shorts=URL (sem cover): join 1 com a capa pendente", async () => {
    const built = buildMarkEntry(parseMarkArg(`youtube_shorts=https://youtube.com/shorts/${VID}`), undefined, "2026-11-19T14:00:00.000Z");
    assert.ok(built.ok);
    assert.equal(built.entry.cover, undefined, "o --mark não grava cover");
    writeRegistry(built.entry);
    assert.equal(await join_(), 1);
    assert.match(errs.join("\n"), /capa vertical do Short AbCdEfGhIjK pendente \(vertical_feed: ausente\)/);
  });

  it("pendente sem dono: join 1; defer: join 0 com o dono; confirm: studio_web e join 0", async () => {
    const other: ShortPublishedEntry = { destination: "facebook:diaria", status: "scheduled", id: "fb1", at: "2026-11-19T14:01:00.000Z" };
    writeRegistry(shortEntry(), other);

    assert.equal(await join_(), 1);
    assert.match(errs.join("\n"), /capa vertical do Short AbCdEfGhIjK pendente/);

    assert.equal(await coverMain(["status", ED, "--edition-dir", dir], deps()), 1);

    out = [];
    errs = [];
    assert.equal(await coverMain(["defer", ED, "--edition-dir", dir], deps()), 0);
    assert.ok(existsSync(join(dir, SHORT_VERTICAL_COVER_OWNER_FILE)));
    assert.equal(await join_(), 0);
    assert.match(errs.join("\n"), /pendente com dono: agent-scheduled-task/);

    // --id de outro vídeo recusa e não grava nada
    assert.equal(await coverMain(["confirm", ED, "--id", "ZZZZZZZZZZZ", "--studio-persisted", "--edition-dir", dir], deps()), 1);

    const feedFile = join(dir, "feed-13708.json");
    writeFileSync(feedFile, JSON.stringify({ verdict: "capa", distance: 0.03, threshold: 0.2, image: "sardefault", feed_url: `https://i.ytimg.com/vi/${VID}/sardefault.jpg` }));
    assert.equal(await coverMain(["confirm", ED, "--id", VID, "--studio-persisted", "--feed-check", feedFile, "--edition-dir", dir], deps()), 0);

    const saved = JSON.parse(readFileSync(join(dir, SHORTS_PUBLISHED_FILE), "utf8")) as ShortsPublishedFile;
    const yt = saved.entries.find((e) => e.destination === "youtube_shorts")!;
    assert.equal(yt.cover?.vertical_feed, "studio_web");
    assert.equal(yt.cover?.ok, true);
    assert.equal(yt.cover?.feed_check?.verdict, "capa");
    assert.equal(yt.video_sha256, "a".repeat(64));
    assert.equal(yt.at, "2026-11-19T14:00:00.000Z");
    assert.deepEqual(saved.entries.find((e) => e.destination === "facebook:diaria"), other);

    assert.equal(await coverMain(["status", ED, "--edition-dir", dir], deps()), 0);
    out = [];
    errs = [];
    assert.equal(await join_(), 0);
    assert.match(errs.join("\n"), /studio_web \(feed: capa/);
  });

  it("#13723: cópia de conflito com at mais novo vence a união: confirm avisa o arquivo e sai 1; join segue 1", async () => {
    writeRegistry(shortEntry());
    // Cópia de conflito do sync do Drive com a mesma entrada, at mais novo e sem studio_web.
    const conflict = join(dir, "_internal", "06-shorts-published (conflito).json");
    writeFileSync(conflict, JSON.stringify(registry(shortEntry({ at: "2026-11-19T14:30:00.000Z" })), null, 2));
    const feedFile = join(dir, "feed-13723.json");
    writeFileSync(feedFile, JSON.stringify({ verdict: "capa", distance: 0.03, threshold: 0.2, image: "sardefault", feed_url: `https://i.ytimg.com/vi/${VID}/sardefault.jpg` }));
    assert.equal(await coverMain(["confirm", ED, "--id", VID, "--studio-persisted", "--feed-check", feedFile, "--edition-dir", dir], deps()), 1);
    assert.match(errs.join("\n"), /06-shorts-published \(conflito\)\.json/);
    assert.match(errs.join("\n"), /#13723/);
    // O principal ficou gravado (nada se perde); a leitura unida é que segue pendente.
    const saved = JSON.parse(readFileSync(join(dir, SHORTS_PUBLISHED_FILE), "utf8")) as ShortsPublishedFile;
    assert.equal(saved.entries.find((e) => e.destination === "youtube_shorts")?.cover?.vertical_feed, "studio_web");
    assert.equal(await join_(), 1);
    // Sem a cópia, o mesmo confirm passa.
    rmSync(conflict);
    errs = [];
    assert.equal(await coverMain(["confirm", ED, "--id", VID, "--studio-persisted", "--edition-dir", dir], deps()), 0);
  });

  it("#13723: empate de at fica com o principal: confirm passa mesmo com a cópia", async () => {
    writeRegistry(shortEntry());
    writeFileSync(join(dir, "_internal", "06-shorts-published (conflito).json"), JSON.stringify(registry(shortEntry()), null, 2));
    assert.equal(await coverMain(["confirm", ED, "--id", VID, "--studio-persisted", "--edition-dir", dir], deps()), 0);
  });

  it("registro ilegível: o join não dá a capa por feita", async () => {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, SHORTS_PUBLISHED_FILE), "{quebrado");
    assert.equal(await join_(), 1);
    assert.match(errs.join("\n"), /capa vertical do Short não verificável/);
  });

  it("defer com o passo já feito recusa", async () => {
    writeRegistry(shortEntry({ cover: { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" } }));
    assert.equal(await coverMain(["defer", ED, "--edition-dir", dir], deps()), 1);
    assert.ok(!existsSync(join(dir, SHORT_VERTICAL_COVER_OWNER_FILE)));
  });
});
