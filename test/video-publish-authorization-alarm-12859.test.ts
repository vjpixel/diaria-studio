/**
 * test/video-publish-authorization-alarm-12859.test.ts (#12859)
 *
 * A task one-shot do vertical (destino adiado, dono `agent-scheduled-task`)
 * que encontra o plano mudado depois da aprovação sai exit 2 e o destino não
 * publica (#12654). Antes, nada avisava o editor: a recusa ficava só no log da
 * task. Agora a recusa da task vira alarme pelo caminho dos alarmes do vídeo
 * (`notifyEditor`, uma vez por motivo e edição), com destino, campo que mudou e
 * o comando para reaprovar. A rodada interativa (comando principal) não alarma.
 * Sem rede: `gh` e e-mail falsos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerticalManifest, planSha256, sha256Hex, type VideoPlanManifest } from "../scripts/lib/diaria/video-publish-plan.ts";
import {
  consumeBeforeExternalEffects,
  consumeVideoPublishAuthorization,
  emptyAuthorizationStore,
  grantVideoPublishAuthorization,
  updateAuthorizationStore,
  type VideoPublishAuthorizationStore,
} from "../scripts/lib/diaria/video-publish-authorization.ts";
import {
  AUTHORIZATION_ALARM_STATE_FILE,
  alarmTaskAuthorizationRefusal,
  buildAuthorizationRefusalAlarm,
  oneShotTaskRefusals,
} from "../scripts/lib/diaria/video-publish-authorization-alarm.ts";
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const ED = "261112";
const T0 = new Date("2026-11-11T22:00:00.000Z");
const TASK_CMD = `npx tsx scripts/publish-shorts.ts ${ED} --only threads_profile --publish --confirm-publish ${ED}`;
const MAIN_CMD = `npx tsx scripts/publish-shorts.ts ${ED} --publish --confirm-publish ${ED}`;
const THREADS_AT = "2026-11-12T15:00:00.000Z";
const AFTER_THREADS = new Date("2026-11-12T15:01:00.000Z");
const media = { video_sha256: sha256Hex("video"), cover_sha256: sha256Hex("capa"), captions_sha256: null };
const sources = { reviewed: sha256Hex("rev"), social: sha256Hex("soc"), roteiro: null, horizontal_link: null, edition_url: null };

function vertical(opts: { threadsAction?: "pending_schedule" | "publish"; caption?: string } = {}): VideoPlanManifest {
  const threadsAction = opts.threadsAction ?? "pending_schedule";
  return buildVerticalManifest({
    aammdd: ED,
    items: [
      { destination: "youtube_shorts", action: "publish", caption: "descrição do Short", title: "Título do Short", scheduledAt: null },
      { destination: "threads_profile", action: threadsAction, caption: opts.caption ?? "legenda do Threads", scheduledAt: threadsAction === "pending_schedule" ? THREADS_AT : null },
    ],
    owners: threadsAction === "pending_schedule" ? [{ destination: "threads_profile", by: "agent-scheduled-task", command: TASK_CMD }] : [],
    destinationAt: () => THREADS_AT,
    horizontalLink: () => null,
    metadata: { title: "Título do Short", description: "descrição do Short" },
    media,
    sources,
    publishCommand: MAIN_CMD,
  });
}

function granted(): VideoPublishAuthorizationStore {
  const m = vertical();
  const r = grantVideoPublishAuthorization(emptyAuthorizationStore(ED), { manifest: m, planSha256: planSha256(m), confirmation: "pode publicar", now: T0, isPidAlive: () => false });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.store;
}

/** A task roda depois do horário com a legenda reescrita depois da aprovação. */
function taskRefusal(store = granted()) {
  const r = consumeVideoPublishAuthorization(store, {
    edition: ED,
    manifest: vertical({ threadsAction: "publish", caption: "legenda reescrita depois da aprovação" }),
    destinations: ["threads_profile"],
    now: AFTER_THREADS,
    by: "teste",
    command: TASK_CMD,
  });
  assert.equal(r.ok, false);
  return r.ok ? [] : r.refusals ?? [];
}

function fakeGh() {
  const calls: string[][] = [];
  const issues: { number: number; url: string; title: string; body: string; state: string }[] = [];
  const ghRun = (args: string[]): GhSpawnResult => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
    if (args[0] === "issue" && args[1] === "create") {
      const n = 900 + issues.length;
      issues.push({ number: n, url: `https://github.com/vjpixel/diaria-studio/issues/${n}`, title: args[args.indexOf("--title") + 1] ?? "", body: "", state: "OPEN" });
      return { status: 0, stdout: `${issues.at(-1)!.url}\n`, stderr: "" };
    }
    if (args[0] === "issue" && ["comment", "edit", "reopen"].includes(args[1] ?? "")) return { status: 0, stdout: "", stderr: "" };
    if (args[0] === "label") return { status: 0, stdout: "", stderr: "" };
    throw new Error(`gh inesperado: ${args.join(" ")}`);
  };
  const emails: string[] = [];
  const sendPush = async (m: { subject: string }) => {
    emails.push(m.subject);
    return { ok: true };
  };
  return { calls, issues, emails, deps: { ghRun, sendPush, emailPolicy: "urgent_only" as const, log: () => true } };
}

describe("#12859 recusa estruturada no consumo", () => {
  it("plano mudado na hora da task: recusa plan-changed com o campo e o dono aprovado", () => {
    const refusals = taskRefusal();
    assert.equal(refusals.length, 1);
    const [r] = refusals;
    assert.equal(r!.destination, "threads_profile");
    assert.equal(r!.kind, "plan-changed");
    assert.ok(r!.changed?.some((c) => /content\.caption/.test(c)), JSON.stringify(r!.changed));
    assert.equal(r!.approved_owner?.by, "agent-scheduled-task");
  });

  it("destino nunca autorizado: missing, sem dono aprovado", () => {
    const r = consumeVideoPublishAuthorization(emptyAuthorizationStore(ED), { edition: ED, manifest: vertical(), destinations: ["youtube_shorts"], now: T0, by: "teste" });
    assert.equal(r.ok, false);
    const refusals = r.ok ? [] : r.refusals ?? [];
    assert.deepEqual(refusals.map((x) => [x.destination, x.kind, x.approved_owner]), [["youtube_shorts", "missing", undefined]]);
  });

  it("task antes do horário aprovado: timing", () => {
    const r = consumeVideoPublishAuthorization(granted(), { edition: ED, manifest: vertical({ threadsAction: "publish" }), destinations: ["threads_profile"], now: T0, by: "teste", command: TASK_CMD });
    assert.equal(r.ok, false);
    assert.equal(r.ok ? "" : r.refusals?.[0]?.kind, "timing");
  });

  it("consumeBeforeExternalEffects devolve as recusas estruturadas ao publisher", () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-alarm-12859-"));
    try {
      updateAuthorizationStore(dir, ED, () => ({ store: granted(), result: null }));
      const out = consumeBeforeExternalEffects({
        editionDir: dir,
        edition: ED,
        manifest: vertical({ threadsAction: "publish", caption: "outra" }),
        destinations: ["threads_profile"],
        now: AFTER_THREADS,
        by: "teste",
        command: TASK_CMD,
      });
      assert.equal(out.ok, false);
      assert.equal(out.ok ? "" : out.refusals?.[0]?.kind, "plan-changed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12859 só a rodada da task one-shot alarma", () => {
  it("comando da task casa com o dono aprovado; o comando principal não", () => {
    const refusals = taskRefusal();
    assert.equal(oneShotTaskRefusals(refusals, TASK_CMD).length, 1);
    assert.equal(oneShotTaskRefusals(refusals, MAIN_CMD).length, 0);
  });

  it("corpo: destino, campo que mudou e o comando para reaprovar", () => {
    const { subject, body } = buildAuthorizationRefusalAlarm({ aammdd: ED, part: "vertical", command: TASK_CMD, refusals: taskRefusal() });
    assert.match(subject, /threads_profile/);
    assert.match(subject, new RegExp(ED));
    assert.match(body, /`threads_profile`: o plano mudou depois da aprovação/);
    assert.match(body, /content\.caption/);
    assert.match(body, new RegExp(`/diaria-publica ${ED} --so vertical`));
    assert.match(body, new RegExp(`video-publish-authorize\\.ts grant ${ED} --part vertical --plan-sha256`));
    assert.match(body, /--mark \{destino\}=URL/);
  });
});

describe("#12859 publish-shorts liga o alarme na recusa", () => {
  it("o ramo de recusa da autorização chama o alarme antes do exit 2, com o comando efetivo e as recusas", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "scripts", "publish-shorts.ts"), "utf8");
    const refusal = src.slice(src.indexOf('authorizationRefusalMessage("publish-shorts", "vertical"'));
    const branch = refusal.slice(0, refusal.indexOf("return 2;"));
    assert.match(branch, /await alarmTaskAuthorizationRefusal\(\{[^}]*command: authCommand[^}]*refusals: auth\.refusals/);
    assert.match(src, /command: authCommand,\n\s*fallbackCommand: shortsMainPublishCommand/, "o alarme compara o mesmo comando que o consumo conferiu");
  });
});

describe("#12859 entrega do alarme", () => {
  it("recusa da task: abre a issue, manda o e-mail urgente e não repete na mesma edição", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-alarm-12859-"));
    try {
      const gh = fakeGh();
      const refusals = taskRefusal();
      const out = await alarmTaskAuthorizationRefusal({ editionDir: dir, aammdd: ED, part: "vertical", command: TASK_CMD, refusals, notifyDeps: gh.deps, log: () => {} });
      assert.equal(out, "delivered");
      assert.equal(gh.issues.length, 1);
      assert.match(gh.issues[0]!.title, /task one-shot recusada/);
      assert.equal(gh.emails.length, 1);
      const state = JSON.parse(readFileSync(join(dir, AUTHORIZATION_ALARM_STATE_FILE), "utf8"));
      assert.deepEqual(state.alarmed, ["vertical:threads_profile=plan-changed"]);
      const callsBefore = gh.calls.length;
      const again = await alarmTaskAuthorizationRefusal({ editionDir: dir, aammdd: ED, part: "vertical", command: TASK_CMD, refusals, notifyDeps: gh.deps, log: () => {} });
      assert.equal(again, "already");
      assert.equal(gh.calls.length, callsBefore, "não chama o gh de novo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recusa da rodada interativa (comando principal): sem alarme e sem gh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-alarm-12859-"));
    try {
      const gh = fakeGh();
      const out = await alarmTaskAuthorizationRefusal({ editionDir: dir, aammdd: ED, part: "vertical", command: MAIN_CMD, refusals: taskRefusal(), notifyDeps: gh.deps, log: () => {} });
      assert.equal(out, "not-task");
      assert.equal(gh.calls.length, 0);
      assert.equal(existsSync(join(dir, AUTHORIZATION_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gh fora do ar: failed, nada gravado (a próxima execução tenta de novo), sem lançar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-alarm-12859-"));
    try {
      const deps = { ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh offline" }), sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
      const out = await alarmTaskAuthorizationRefusal({ editionDir: dir, aammdd: ED, part: "vertical", command: TASK_CMD, refusals: taskRefusal(), notifyDeps: deps, log: () => {} });
      assert.equal(out, "failed");
      assert.equal(existsSync(join(dir, AUTHORIZATION_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
