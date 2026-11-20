/**
 * test/shorts-corte-repost-registro-13731-13733.test.ts (#13731, #13733)
 *
 * #13733: no modo corte o vídeo do perfil do LinkedIn sai pelo timer do 300
 * (`Diaria-Shorts-Cortes`), então na rodada `--publish` a URN dele não existe e
 * o repost pela página ficava "guiado" com dono `agent`, sem task: os reposts
 * dos guias 261116-261119 ficaram sem dono. Agora o repost é do timer do corte,
 * que o leva junto (`companions`) na execução que publica o perfil.
 *
 * #13731: o corte nvidia-261110 ficou com 5 de 9 destinos autorizados no
 * registro. Os 3 do timer alarmaram `late`; o repost não alarmou nada. Agora
 * destino autorizado fora do timer sem registro 3 h depois do horário vira o
 * alarme `unregistered`. Sem rede, sem publicar nada.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORTE_TIMER_REPOST_DESTINATION,
  buildCorteTimerAlarm,
  corteAlarmSeverity,
  cortePublishArgs,
  decideCorteTimerRun,
  interpretCorteTimerOutput,
  runCorteTimerFor,
  type CorteTimerAlarmKey,
} from "../scripts/shorts-corte-timer.ts";
import { CORTE_SPEC_FILE, parseCorteSpec, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "../scripts/lib/diaria/corte-content.ts";
import { delegateCorteRepostToTimer, planShortsPublish, prepareCorteRun, recordCortePublishAuthorization } from "../scripts/publish-shorts.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const REPOST = "linkedin_page_repost";
const shorts = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: true,
  linkedin_page_repost: true,
  x: false,
  threads_profile: true,
  linkedin_profile_via_timer: true,
  threads_profile_via_timer: true,
  instagram_backend: "timer-300",
  instagram_api_max_seconds_by_account: { diaria: null },
  corte_via_timer: true,
  schedule: { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" },
};
const CONFIG = { publishing: { shorts } };

// ── #13733: a rodada manual entrega o repost ao timer do corte ──────────────
const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
const CORTE = { slug: "guia-261116", hhmm: "12:00", title: "Novo Gemini: 3 dicas pra usar melhor", hook: "A IA do Google mudou. Aqui vão três dicas." };
const planBase = {
  aammdd: "261122",
  reviewedMd: "",
  config: CONFIG,
  pages: [page("diaria")],
  instagramReady: true,
  published: { aammdd: "261122", entries: [] },
  video: { path: "/videos/corte-guia-261116.mp4", exists: true, sizeBytes: 10 },
  videoDurationSeconds: 50,
  threadsPersonal: { ready: true } as const,
  linkedinPersonal: { ready: true } as const,
  publicVideo: { ready: true } as const,
  youtubeApi: { ready: true } as const,
  corte: CORTE,
};
const BEFORE = new Date("2026-11-19T15:00:00Z"); // dias antes do corte (22/11 12:00 BRT)

describe("#13733 planShortsPublish: repost do corte com o perfil no timer", () => {
  it("perfil pending_schedule do timer do corte: o repost vira skip_delegated com dono Diaria-Shorts-Cortes (antes: guiado, dono agent, sem task)", () => {
    const p = planShortsPublish({ ...planBase, now: BEFORE });
    assert.equal(p.items.find((i) => i.destination === "linkedin_profile")?.action, "pending_schedule");
    const repost = p.items.find((i) => i.destination === REPOST) as { action: string; detail?: string };
    assert.equal(repost.action, "skip_delegated");
    assert.match(repost.detail ?? "", /Diaria-Shorts-Cortes/);
    assert.match(repost.detail ?? "", /Não repostar à mão/);
    const owner = p.owners.find((o) => o.destination === REPOST)!;
    assert.equal(owner.by, "timer-300");
    assert.equal(owner.task, "Diaria-Shorts-Cortes");
    assert.match(owner.note, /#13733/);
  });

  it("sem corte_via_timer o repost segue como antes (guiado)", () => {
    const off = { publishing: { shorts: { ...shorts, corte_via_timer: false } } };
    const p = planShortsPublish({ ...planBase, config: off, now: BEFORE });
    assert.equal(p.items.find((i) => i.destination === REPOST)?.action, "guided");
  });

  it("delegateCorteRepostToTimer só troca o par perfil pending_schedule + repost guiado", () => {
    const guided = { destination: REPOST, mode: "guided", action: "guided", detail: "Chrome", at: "2026-11-22T15:30:00.000Z" } as const;
    const profileDone = [{ destination: "linkedin_profile", mode: "api", action: "skip_done" } as const, guided];
    assert.equal(delegateCorteRepostToTimer([...profileDone], "guia-261116", "261122")[1].action, "guided", "perfil já registrado: o --publish reposta pela fila do Worker");
    const out = delegateCorteRepostToTimer(
      [{ destination: "linkedin_profile", mode: "api", action: "pending_schedule", caption: "x", scheduledAt: "2026-11-22T15:00:00.000Z", detail: "d" }, guided],
      "guia-261116",
      "261122",
    );
    assert.equal(out[1].action, "skip_delegated");
    assert.match((out[1] as { detail: string }).detail, /--only linkedin_page_repost --publish --confirm-publish 261122/);
  });
});

// ── #13733: o timer leva o repost junto com o perfil ────────────────────────
const BASE: CorteSpec = { slug: "guia-261116", date: "261122", hhmm: "12:00", title: CORTE.title, hook: CORTE.hook, video: "corte-guia-261116.mp4" };
const AT = "2026-11-22T15:00:00.000Z"; // 12:00 BRT
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const ALL = ["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", REPOST, "threads_profile"];
const KNOWN = new Set(ALL);
const authorized = (dests: string[]): CorteSpec => ({
  ...BASE,
  publish_confirmed_at: "2026-11-19T15:10:51.638Z",
  publish_confirmed_destinations: dests,
  publish_confirmed_content: { video_sha256: "a".repeat(64), cover_sha256: null },
});
const registry = (...dests: string[]) => [
  { path: "/c/_internal/06-shorts-published.json", raw: JSON.stringify({ aammdd: BASE.date, entries: dests.map((d) => ({ destination: d, status: "scheduled", id: `id-${d}`, at: AT, scheduled_at: AT })) }) },
];

describe("#13733 decideCorteTimerRun: companions", () => {
  it("perfil pendente no horário e repost autorizado: o repost vai junto no --only", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: authorized(ALL), registryRaws: registry("youtube_shorts", "facebook:diaria"), now: at(10 * 60_000) });
    assert.equal(d.kind, "publish");
    assert.ok(d.kind === "publish");
    assert.deepEqual(d.companions, [REPOST]);
    assert.ok(!d.pending.includes(REPOST), "o repost não é pendente do timer (não alarma late/missing-video sozinho)");
    const args = cortePublishArgs(authorized(ALL), [...d.pending, ...(d.companions ?? [])]);
    assert.ok(args[args.indexOf("--only") + 1].split(",").includes(REPOST));
  });

  it("sem companions: repost fora do 'pode publicar', já registrado, ou perfil já registrado", () => {
    const noRepost = decideCorteTimerRun({ config: CONFIG, spec: authorized(ALL.filter((x) => x !== REPOST)), registryRaws: [], now: at(10 * 60_000) });
    assert.ok(noRepost.kind === "publish" && noRepost.companions === undefined);
    const repostDone = decideCorteTimerRun({ config: CONFIG, spec: authorized(ALL), registryRaws: registry(REPOST), now: at(10 * 60_000) });
    assert.ok(repostDone.kind === "publish" && repostDone.companions === undefined);
    const profileDone = decideCorteTimerRun({ config: CONFIG, spec: authorized(ALL), registryRaws: registry("linkedin_profile"), now: at(10 * 60_000) });
    assert.ok(profileDone.kind === "publish" && profileDone.companions === undefined, "o perfil não sai nesta execução: sem URN nova");
  });
});

describe("#13733 interpretCorteTimerOutput: desfecho do repost", () => {
  const run = ["linkedin_profile", REPOST];
  const profileOk = { destination: "linkedin_profile", ok: true, entry: { destination: "linkedin_profile", status: "published", id: "urn:li:share:1", at: AT } };
  const outcome = (out: unknown) => interpretCorteTimerOutput(0, JSON.stringify(out), run).find((o) => o.destination === REPOST)!;

  it("repost na fila do Worker: done", () => {
    const o = outcome({ results: [profileOk, { destination: REPOST, ok: true, entry: { destination: REPOST, status: "scheduled", id: "q1", at: AT } }], items: [] });
    assert.equal(o.kind, "done");
  });

  it("perfil saiu e a fila recusou (o item segue guiado): alarme repost-failed com o motivo", () => {
    const o = outcome({ results: [profileOk], items: [{ destination: REPOST, action: "guided", detail: "repost ... (fila do Worker: Worker sem o token da página)" }] });
    assert.equal(o.kind, "alarm");
    assert.ok(o.kind === "alarm" && o.key === "repost-failed");
    assert.match(o.detail, /token da página/);
  });

  it("perfil falhou nesta execução (sem entrada): o repost espera a próxima", () => {
    const o = outcome({ results: [{ destination: "linkedin_profile", ok: false, error: "500" }], items: [{ destination: REPOST, action: "skip_invalid", detail: "o vídeo do perfil falhou" }] });
    assert.equal(o.kind, "wait");
  });

  it("perfil em send_unknown: o repost alarma (o perfil sai da fila do timer e ninguém mais o levaria)", () => {
    const o = outcome({
      results: [{ destination: "linkedin_profile", ok: true, entry: { destination: "linkedin_profile", status: "send_unknown", id: "send_unknown-x", at: AT } }],
      items: [{ destination: REPOST, action: "skip_invalid", detail: "send_unknown" }],
    });
    assert.ok(o.kind === "alarm" && o.key === "repost-failed");
  });

  it("o alarme repost-failed não promete nova tentativa do timer e dá o comando do repost", () => {
    const { body, subject } = buildCorteTimerAlarm({ spec: BASE, destination: REPOST, key: "repost-failed", reason: "x" });
    assert.match(subject, /repost/);
    assert.match(body, /--only linkedin_page_repost --publish --confirm-publish 261122/);
    assert.doesNotMatch(body, /volta a tentar sozinho/);
    assert.equal(corteAlarmSeverity("repost-failed"), "urgente");
  });
});

// ── #13733: wiring no runCorteTimerFor ───────────────────────────────────────
type Alarm = { destination: string; key: CorteTimerAlarmKey };
function corteDir(): string {
  const root = mkdtempSync(join(tmpdir(), "corte-13733-"));
  const dir = join(root, BASE.slug);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, BASE.video), "mp4");
  prepareCorteRun({ slug: BASE.slug, dir, values: { date: BASE.date, at: BASE.hhmm, title: BASE.title, hook: BASE.hook, video: join(dir, BASE.video) }, positionalDate: "", log: () => {} });
  const spec = parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json");
  recordCortePublishAuthorization(dir, ALL.join(","), KNOWN, corteContentFingerprint(dir, spec), "2026-11-19T15:10:51.638Z", () => {});
  return dir;
}
const deps = (now: Date, calls: string[][], alarms: Alarm[], stdout: string) => ({
  config: CONFIG,
  now,
  runScript: (args: string[]) => {
    calls.push(args);
    return { status: 0, stdout, stderr: "" };
  },
  notify: { cwd: "/nao-usado" },
  alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey) => {
    alarms.push({ destination, key });
    return true;
  },
});

describe("#13733 runCorteTimerFor: o repost entra no --only e tem desfecho próprio", () => {
  it("a execução que publica o perfil passa o repost ao publish-shorts e alarma se a fila recusar", async () => {
    const dir = corteDir();
    const calls: string[][] = [];
    const alarms: Alarm[] = [];
    const stdout = JSON.stringify({
      results: [
        { destination: "linkedin_profile", ok: true, entry: { destination: "linkedin_profile", status: "published", id: "urn:li:share:1", at: AT } },
        { destination: "instagram", ok: true, entry: { destination: "instagram", status: "published", id: "ig1", at: AT } },
        { destination: "threads_profile", ok: true, entry: { destination: "threads_profile", status: "published", id: "th1", at: AT } },
      ],
      items: [{ destination: REPOST, action: "guided", detail: "repost (fila do Worker: sem Worker nesta máquina)" }],
    });
    assert.equal(await runCorteTimerFor(dir, false, deps(at(10 * 60_000), calls, alarms, stdout)), 1);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][calls[0].indexOf("--only") + 1].split(","), ["linkedin_profile", "threads_profile", "instagram", REPOST]);
    assert.deepEqual(alarms, [{ destination: REPOST, key: "repost-failed" }]);
  });
});

// ── #13731: destino autorizado fora do timer sem registro ───────────────────
describe("#13731 decideCorteTimerRun: alarme unregistered", () => {
  // Caso real (nvidia-261110): 9 autorizados, registro com youtube_shorts, facebook:*, x e tiktok.
  const spec = authorized(ALL);
  const raws = registry("youtube_shorts", "facebook:diaria");

  it("3 h depois do horário: o repost sem registro alarma, os do timer seguem com o late", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec, registryRaws: raws, now: at(4 * 3_600_000) });
    assert.equal(d.kind, "late");
    assert.ok(d.kind === "late");
    assert.deepEqual(d.alarms?.filter((a) => a.key === "unregistered").map((a) => a.destination), [REPOST]);
    assert.match(d.alarms!.find((a) => a.key === "unregistered")!.reason, /depende do vídeo do perfil/);
  });

  it("todos os do timer registrados: o skip ainda leva o alarme do destino fora do timer sem registro", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec, registryRaws: registry("instagram", "linkedin_profile", "threads_profile", "facebook:diaria"), now: at(4 * 3_600_000) });
    assert.equal(d.kind, "skip");
    assert.deepEqual(d.kind === "skip" ? d.alarms?.map((a) => `${a.destination}:${a.key}`).sort() : [], [`${REPOST}:unregistered`, "youtube_shorts:unregistered"]);
  });

  it("antes das 3 h, fora do 'pode publicar', destino desconhecido na config ou além das 48 h: nada", () => {
    const early = decideCorteTimerRun({ config: CONFIG, spec, registryRaws: raws, now: at(2 * 3_600_000) });
    assert.ok(early.kind === "publish" && !(early.alarms ?? []).some((a) => a.key === "unregistered"));
    const notAuth = decideCorteTimerRun({ config: CONFIG, spec: authorized(["linkedin_profile"]), registryRaws: registry("linkedin_profile"), now: at(4 * 3_600_000) });
    assert.ok(!("alarms" in notAuth) || !(notAuth.alarms ?? []).some((a) => a.key === "unregistered"));
    const off = { publishing: { shorts: { ...shorts, linkedin_page_repost: false } } };
    const offD = decideCorteTimerRun({ config: off, spec: authorized(["linkedin_profile", REPOST]), registryRaws: registry("linkedin_profile"), now: at(4 * 3_600_000) });
    assert.ok(!(("alarms" in offD ? offD.alarms : undefined) ?? []).some((a) => a.key === "unregistered"), "destino desligado já é unknown-destination");
    const old = decideCorteTimerRun({ config: CONFIG, spec, registryRaws: raws, now: at(49 * 3_600_000) });
    assert.equal(old.kind, "skip");
    assert.ok(!(("alarms" in old ? old.alarms : undefined) ?? []).some((a) => a.key === "unregistered"));
  });

  it("o alarme unregistered é ação (pode ter saído sem registro) e não manda rodar o timer", () => {
    assert.equal(corteAlarmSeverity("unregistered"), "acao");
    const { body } = buildCorteTimerAlarm({ spec: BASE, destination: "youtube_shorts", key: "unregistered", reason: "x" });
    assert.match(body, /--mark youtube_shorts=URL/);
    assert.match(body, /--only youtube_shorts --publish --now --confirm-publish 261122/);
    assert.doesNotMatch(body, /shorts-corte-timer\.ts --corte/);
    const repost = buildCorteTimerAlarm({ spec: BASE, destination: REPOST, key: "unregistered", reason: "x" }).body;
    assert.match(repost, /fila do Worker/);
  });

  it("a constante do repost é a do plano", () => {
    assert.equal(CORTE_TIMER_REPOST_DESTINATION, REPOST);
  });
});
