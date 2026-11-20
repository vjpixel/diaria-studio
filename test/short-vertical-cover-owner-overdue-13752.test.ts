/**
 * test/short-vertical-cover-owner-overdue-13752.test.ts (#13752)
 *
 * O `defer` do Passo B3a grava um dono com `at` 15 min à frente. Até o #13752,
 * com dono do mesmo vídeo o passo pendente virava só nota, sem prazo: se a
 * task one-shot não era criada ou falhava, todo join seguinte passava com
 * "pendente com dono ... às {at}". Agora, passado `at` + 2 h com o passo
 * pendente, o dono conta como vencido e o join volta a sair 1.
 *
 * Nada publica nem chama o YouTube: registro em diretório temporário.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SHORT_VERTICAL_COVER_OWNER_GRACE_MS,
  assessShortVerticalCoverStep,
  buildShortVerticalCoverOwner,
  describeShortVerticalCoverStep,
  isShortVerticalCoverOwnerOverdue,
} from "../scripts/lib/diaria/short-vertical-cover-step.ts";
import { SHORTS_PUBLISHED_FILE, type ShortPublishedEntry, type ShortsPublishedFile } from "../scripts/lib/diaria/short-video.ts";
import { main as coverMain } from "../scripts/short-vertical-cover.ts";
import { main as phaseMain, defaultPhaseCliDeps } from "../scripts/publica-phase.ts";

const ED = "261119";
const VID = "AbCdEfGhIjK";
const DEFER_AT = new Date("2026-11-19T15:00:00.000Z");
// O dono gravado pelo defer tem at = DEFER_AT + 15 min = 15:15.
const OWNER_AT_MS = DEFER_AT.getTime() + 15 * 60_000;

function shortEntry(): ShortPublishedEntry {
  return {
    destination: "youtube_shorts",
    status: "scheduled",
    id: VID,
    url: `https://youtube.com/shorts/${VID}`,
    scheduled_at: "2026-11-20T09:30:00.000Z",
    at: "2026-11-19T14:00:00.000Z",
    cover: { method: "thumbnails_set", ok: true, vertical_feed: "manual" },
  };
}

const registry = (): ShortsPublishedFile => ({ aammdd: ED, entries: [shortEntry()] });

describe("dono do Passo B3a vence (#13752)", () => {
  const owner = buildShortVerticalCoverOwner({ aammdd: ED, videoId: VID, now: DEFER_AT });

  it("margem de 2 h", () => {
    assert.equal(SHORT_VERTICAL_COVER_OWNER_GRACE_MS, 2 * 60 * 60_000);
  });

  it("dentro de at + 2 h: nota, sem problema", () => {
    const now = new Date(OWNER_AT_MS + SHORT_VERTICAL_COVER_OWNER_GRACE_MS);
    assert.equal(isShortVerticalCoverOwnerOverdue(owner, now), false);
    const step = assessShortVerticalCoverStep(registry(), owner, now);
    assert.ok(step.state === "pending" && step.owner && !step.owner_overdue);
    const d = describeShortVerticalCoverStep(ED, step);
    assert.equal(d.problem, null);
    assert.match(d.note ?? "", /pendente com dono/);
  });

  it("passado at + 2 h com o passo pendente: problema \"dono vencido\"", () => {
    const now = new Date(OWNER_AT_MS + SHORT_VERTICAL_COVER_OWNER_GRACE_MS + 1);
    const step = assessShortVerticalCoverStep(registry(), owner, now);
    assert.ok(step.state === "pending" && step.owner && step.owner_overdue);
    const d = describeShortVerticalCoverStep(ED, step);
    assert.equal(d.note, null);
    assert.match(d.problem ?? "", /pendente com dono vencido/);
    assert.match(d.problem ?? "", /short-vertical-cover\.ts confirm 261119 --id AbCdEfGhIjK/);
    assert.match(d.problem ?? "", /short-vertical-cover\.ts defer 261119/);
  });

  it("dono de outro vídeo nunca conta como vencido (já não vale)", () => {
    const now = new Date(OWNER_AT_MS + 10 * SHORT_VERTICAL_COVER_OWNER_GRACE_MS);
    const step = assessShortVerticalCoverStep(registry(), { ...owner, video_id: "ZZZZZZZZZZZ" }, now);
    assert.ok(step.state === "pending" && !step.owner && !step.owner_overdue && step.stale_owner);
  });

  it("passo feito com dono velho: done (o prazo só vale para pendente)", () => {
    const reg: ShortsPublishedFile = { aammdd: ED, entries: [{ ...shortEntry(), cover: { method: "thumbnails_set", ok: true, vertical_feed: "studio_web" } }] };
    const step = assessShortVerticalCoverStep(reg, owner, new Date(OWNER_AT_MS + 10 * SHORT_VERTICAL_COVER_OWNER_GRACE_MS));
    assert.equal(step.state, "done");
  });
});

describe("join com dono vencido (#13752, cenário da issue)", () => {
  let dir: string;
  let errs: string[];
  const cliDeps = (now: Date) => ({ log: () => {}, err: (l: string) => errs.push(l), now: () => now });
  const join_ = (now: Date) =>
    phaseMain(["join", ED, "--edition-dir", dir], { ...defaultPhaseCliDeps, log: () => {}, err: (l) => errs.push(l), now: () => now });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "short-vcover-13752-"));
    errs = [];
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, SHORTS_PUBLISHED_FILE), JSON.stringify(registry(), null, 2));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("defer sem task armada: join passa no prazo e volta a acusar dias depois; defer de novo renova o dono", async () => {
    assert.equal(await coverMain(["defer", ED, "--edition-dir", dir], cliDeps(DEFER_AT)), 0);

    assert.equal(await join_(new Date(OWNER_AT_MS + 60 * 60_000)), 0);
    assert.match(errs.join("\n"), /pendente com dono: agent-scheduled-task/);

    errs = [];
    const daysLater = new Date(DEFER_AT.getTime() + 3 * 24 * 60 * 60_000);
    assert.equal(await join_(daysLater), 1);
    assert.match(errs.join("\n"), /pendente com dono vencido/);
    assert.equal(await coverMain(["status", ED, "--edition-dir", dir], cliDeps(daysLater)), 1);

    // O defer aceita o passo pendente com dono vencido e grava dono novo no prazo.
    errs = [];
    assert.equal(await coverMain(["defer", ED, "--edition-dir", dir], cliDeps(daysLater)), 0);
    assert.equal(await join_(new Date(daysLater.getTime() + 30 * 60_000)), 0);
  });
});
