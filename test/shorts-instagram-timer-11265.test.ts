/**
 * test/shorts-instagram-timer-11265.test.ts (#11265, #10940)
 *
 * O Reels do Instagram sai pelo timer do 300 no horário do vertical, sem URL
 * pública (decisão do editor 27/10/2026: túnel descartado, R2 não habilitado):
 * config, delegação no plano do `/diaria-shorts`, horário fixo fora da grade,
 * escopo do `--instagram-timer`, registro próprio do timer, decisão "age
 * agora?", escolha do arquivo (Drive sempre consultado), leitura da saída do
 * publish-shorts, conferência da conta antes de publicar, alarme, limpeza e o
 * par horário do teste ↔ tasks. Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTAGRAM_TIMER_ALARM_STATE_FILE,
  MISSING_VIDEO_ALARM_AFTER_MS,
  alarm,
  alarmId,
  alarmKeyOf,
  alarmSeverity,
  alarmDelivery,
  alarmSuppressed,
  alreadyAlarmed,
  buildInstagramTimerAlarm,
  chooseInstagramVideo,
  decideInstagramTimerRun,
  driveShowsVertical,
  instagramTimerDeadlineHhmm,
  interpretInstagramCutLookup,
  interpretInstagramTimerOutput,
  parseCutSidecar,
  shouldAlarmMissingVideo,
  type InstagramCutLookup,
} from "../scripts/shorts-instagram-timer.ts";
import {
  INSTAGRAM_TIMER_DETAIL,
  InstagramTimerGateError,
  SHORTS_BOOLEAN_FLAGS,
  credentialSkippedItems,
  instagramTimerGate,
  instagramTimerPreflight,
  instagramTimerPublishStep,
  parseShortsCliArgs,
  planShortsPublish,
  publicVideoUnavailableReason,
  type ShortsPlanInput,
} from "../scripts/publish-shorts.ts";
import {
  loadShortsConfig,
  shortDestinationAccount,
  shortInstagramVideoFileName,
  shortVideoFileName,
  type ShortPublishedEntry,
} from "../scripts/lib/diaria/short-video.ts";
import {
  SHORTS_INSTAGRAM_TIMER_LEDGER_FILE,
  instagramTimerScopeError,
  persistShortEntry,
  readShortsRegistry,
  shortsRegistryPath,
  shortsRegistryWriterFor,
} from "../scripts/lib/diaria/shorts-published-store.ts";
import { cleanupPublishedVideo } from "../scripts/lib/diaria/published-video-cleanup.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";
import platformConfig from "../platform.config.json" with { type: "json" };
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";
import type { NotifyEditorResult } from "../scripts/lib/editor-notify.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const SHORTS = { facebook_pages: [], instagram: true, instagram_collaborators: ["vjpixel"], linkedin_profile: false, linkedin_page_repost: false, x: false, threads_profile: false, schedule: SCHEDULE };
const CFG = { publishing: { shorts: SHORTS } };
// 261027 (terça): 2º dia do teste → 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";
const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque com uma frase. Outra frase.\n";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "shorts-ig-timer-"));
}

describe("#11265 config publishing.shorts.instagram_backend", () => {
  it("default é timer-300 (no código e no platform.config.json)", () => {
    assert.equal(loadShortsConfig({}).instagramBackend, "timer-300");
    assert.equal(loadShortsConfig(CFG).instagramBackend, "timer-300");
    assert.equal(loadShortsConfig(platformConfig).instagramBackend, "timer-300");
  });
  it("worker-r2 continua aceito; valor desconhecido lança", () => {
    assert.equal(loadShortsConfig({ publishing: { shorts: { ...SHORTS, instagram_backend: "worker-r2" } } }).instagramBackend, "worker-r2");
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...SHORTS, instagram_backend: "tunnel" } } }), /instagram_backend/);
  });
  it("sem R2 no host, X/Threads listam o secret que falta e apontam o sync-env (R2 habilitado desde 27/10)", () => {
    const reason = publicVideoUnavailableReason(["R2_ACCOUNT_ID", "SHORTS_R2_BUCKET"]);
    assert.match(reason, /falta ou inválido: R2_ACCOUNT_ID, SHORTS_R2_BUCKET/);
    assert.match(reason, /sync-env/);
    assert.doesNotMatch(reason, /não será habilitado/);
  });
});

describe("#11265 plano: o timer é o dono do Instagram", () => {
  const pages: ResolvedFacebookPage[] = [];
  const base: Omit<ShortsPlanInput, "now"> = {
    aammdd: AAMMDD,
    reviewedMd: REVIEWED,
    config: CFG,
    pages,
    instagramReady: true,
    published: { aammdd: AAMMDD, entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    videoDurationSeconds: 20,
    editionUrl: "https://diar.ia.br/p/x",
  };
  const ig = (p: ReturnType<typeof planShortsPublish>) => p.items.find((i) => i.destination === "instagram")!;

  it("rodada do /diaria-shorts (sem --instagram-timer): skip_delegated, nunca fila do Worker nem R2", () => {
    const p = planShortsPublish({ ...base, now: new Date("2026-10-27T03:00:00Z") });
    assert.equal(ig(p).action, "skip_delegated");
    assert.equal((ig(p) as { detail: string }).detail, INSTAGRAM_TIMER_DETAIL);
    assert.ok(!p.warnings.some((w) => /R2|fila do Worker/.test(w)));
  });
  it("também depois do horário e acima do teto: quem publica (ou avisa) é o timer", () => {
    assert.equal(ig(planShortsPublish({ ...base, now: new Date("2026-10-27T12:00:00Z") })).action, "skip_delegated");
    assert.equal(ig(planShortsPublish({ ...base, now: new Date("2026-10-27T12:00:00Z"), videoDurationSeconds: 50 })).action, "skip_delegated");
  });
  it("rodada do timer antes do horário: pending_schedule (nada sai)", () => {
    const p = planShortsPublish({ ...base, writer: "instagram-timer", now: new Date("2026-10-27T10:00:00Z") });
    assert.equal(ig(p).action, "pending_schedule");
    assert.equal((ig(p) as { scheduledAt: string }).scheduledAt, AT);
    assert.ok(p.premises.some((x) => x.startsWith(`instagram: timer do 300 publica depois de ${AT}`)));
  });
  it("rodada do timer depois do horário: publish na hora (upload resumível, sem URL pública)", () => {
    const p = planShortsPublish({ ...base, writer: "instagram-timer", now: new Date("2026-10-27T11:05:00Z") });
    assert.equal(ig(p).action, "publish");
  });
  it("rodada do timer: até 3 h exatas publica; 1 ms depois vira skip_late (--now publica)", () => {
    const limit = new Date(Date.parse(AT) + MAX_FIRE_LATENESS_MS);
    assert.equal(ig(planShortsPublish({ ...base, writer: "instagram-timer", now: limit })).action, "publish");
    const late = new Date(limit.getTime() + 1);
    assert.equal(ig(planShortsPublish({ ...base, writer: "instagram-timer", now: late })).action, "skip_late");
    assert.equal(ig(planShortsPublish({ ...base, writer: "instagram-timer", forceNow: true, now: late })).action, "publish");
  });
  it("rodada do timer com o vertical acima do teto: passo guiado (o timer avisa o editor)", () => {
    const p = planShortsPublish({ ...base, writer: "instagram-timer", videoDurationSeconds: 50, now: new Date("2026-10-27T11:05:00Z") });
    assert.equal(ig(p).action, "guided");
  });
  it("backend worker-r2: o caminho antigo (fila do Worker) segue igual", () => {
    const cfg = { publishing: { shorts: { ...SHORTS, instagram_backend: "worker-r2" } } };
    const p = planShortsPublish({ ...base, config: cfg, now: new Date("2026-10-27T03:00:00Z"), instagramQueue: { ready: true, account: "diaria" } });
    assert.equal(ig(p).action, "enqueue");
  });

  it("fora da rotação com a grade cheia: o slot do Instagram é o horário do vertical, o mesmo do timer (261117)", () => {
    // 261117 (terça) está depois de rotation_end: default_time 12:00 BRT = 15:00Z.
    const aammdd = "261117";
    const at = "2026-11-17T15:00:00.000Z";
    const cfg = loadShortsConfig(CFG);
    const igAccount = shortDestinationAccount({ id: "instagram", kind: "instagram", mode: "api" }, cfg)!;
    // A grade da conta tem post às 12:00 — antes do #11265 o planner empurrava o Reels pra 19:30.
    const grid = [{ account: igAccount, at, label: "post diário" }];
    const now = new Date("2026-11-17T15:05:00Z");
    const p = planShortsPublish({ ...base, aammdd, published: { aammdd, entries: [] }, grid, writer: "instagram-timer", now });
    const slot = p.slots.find((s) => s.destination === "instagram")!;
    assert.equal(slot.at, at);
    assert.equal(slot.rule, "timer-300");
    assert.equal(ig(p).action, "publish");
    const decision = decideInstagramTimerRun({ config: CFG, reviewedExists: true, registryRaws: [], aammdd, now, videoSeen: true });
    assert.equal(decision.kind, "publish");
    assert.equal((decision as { at: string }).at, at);
  });
});

describe("#11265 escopo do --instagram-timer e registro próprio", () => {
  it("só --only instagram (ou --mark instagram=URL); nunca com --linkedin-timer, --confirm-instagram nem backend worker-r2", () => {
    const T = "timer-300" as const;
    assert.equal(instagramTimerScopeError({ instagramTimer: false, backend: T, only: null }), null);
    assert.equal(instagramTimerScopeError({ instagramTimer: true, backend: T, only: ["instagram"] }), null);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: "worker-r2", only: ["instagram"] })!, /timer-300/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: T, only: null })!, /exige --only instagram/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: T, only: ["instagram", "facebook:diaria"] })!, /exige --only instagram/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: T, linkedinTimer: true, only: ["instagram"] })!, /não combina com --linkedin-timer/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: T, only: ["instagram"], confirmInstagram: true })!, /não combina com --confirm-instagram/);
    assert.equal(instagramTimerScopeError({ instagramTimer: true, backend: T, only: null, markDestination: "instagram" }), null);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: T, only: null, markDestination: "x" })!, /só aceita instagram/);
  });
  it("config ilegível (backend unreadable) recusa, inclusive no --mark (#11368: o campo opcional pulava a regra)", () => {
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: "unreadable", only: ["instagram"] })!, /não carregou/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: "unreadable", only: null, markDestination: "instagram" })!, /não carregou/);
    assert.equal(instagramTimerScopeError({ instagramTimer: false, backend: "unreadable", only: null }), null);
  });
  it("os dois timers juntos não são um escritor: shortsRegistryWriterFor lança (#11368)", () => {
    assert.throws(() => shortsRegistryWriterFor(true, true), /não combina com --linkedin-timer/);
    assert.equal(shortsRegistryWriterFor(true, false), "linkedin-timer");
    assert.equal(shortsRegistryWriterFor(false, false), "main");
  });
  it("--instagram-timer é flag booleana do CLI", () => {
    assert.ok((SHORTS_BOOLEAN_FLAGS as readonly string[]).includes("instagram-timer"));
    const r = parseShortsCliArgs([AAMMDD, "--only", "instagram", "--publish", "--instagram-timer"]);
    assert.ok(r.ok && r.flags.has("instagram-timer"));
  });
  it("o timer grava no arquivo próprio; a leitura une os registros; outro destino ali é recusado", () => {
    const dir = tmp();
    try {
      assert.equal(shortsRegistryWriterFor(false, true), "instagram-timer");
      assert.equal(shortsRegistryPath(dir, "instagram-timer"), join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE));
      const entry = { destination: "instagram", status: "published" as const, id: "m1", url: "https://www.instagram.com/reel/m1/", scheduled_at: null, at: AT };
      persistShortEntry(dir, AAMMDD, "instagram-timer", entry);
      assert.ok(readShortsRegistry(dir, AAMMDD).entries.some((e) => e.destination === "instagram" && e.id === "m1"));
      assert.throws(() => persistShortEntry(dir, AAMMDD, "instagram-timer", { ...entry, destination: "facebook:diaria" }), /registro do timer só aceita instagram/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11265 decideInstagramTimerRun (age agora?)", () => {
  const base = { config: CFG, reviewedExists: true, registryRaws: [] as Array<{ path: string; raw: string }>, aammdd: AAMMDD, videoSeen: true };
  const raw = (dest: string, status: string) => JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: dest, status, id: "x", at: "t" }] });

  it("antes do horário do vertical: espera", () => {
    assert.equal(decideInstagramTimerRun({ ...base, now: new Date("2026-10-27T10:59:00Z") }).kind, "wait");
  });
  it("no horário e até 3 h exatas depois: publica; 1 ms depois: late", () => {
    assert.deepEqual(decideInstagramTimerRun({ ...base, now: new Date(AT) }), { kind: "publish", at: AT, hhmm: "08:00" });
    const limit = Date.parse(AT) + MAX_FIRE_LATENESS_MS;
    assert.equal(decideInstagramTimerRun({ ...base, now: new Date(limit) }).kind, "publish");
    assert.equal(decideInstagramTimerRun({ ...base, now: new Date(limit + 1) }).kind, "late");
  });
  it("passou de 3 h num dia SEM vertical (Etapa 5 seguiu sem vídeo): não alarma", () => {
    const d = decideInstagramTimerRun({ ...base, videoSeen: false, now: new Date("2026-10-27T14:01:00Z") });
    assert.equal(d.kind, "skip");
  });
  it("passou de 3 h sem vertical LOCAL: o skip marca unseenLate (o timer confere o Drive e redecide como late)", () => {
    const d = decideInstagramTimerRun({ ...base, videoSeen: false, now: new Date("2026-10-27T14:01:00Z") });
    assert.equal((d as { unseenLate?: boolean }).unseenLate, true);
    assert.equal(decideInstagramTimerRun({ ...base, videoSeen: true, now: new Date("2026-10-27T14:01:00Z") }).kind, "late");
    const other = decideInstagramTimerRun({ ...base, reviewedExists: false, videoSeen: false, now: new Date("2026-10-27T14:01:00Z") });
    assert.equal((other as { unseenLate?: boolean }).unseenLate, undefined);
  });
  it("instagram registrado em qualquer arquivo (principal, do timer, cópia de conflito), inclusive send_unknown: nada a fazer", () => {
    for (const path of ["_internal/06-shorts-published.json", SHORTS_INSTAGRAM_TIMER_LEDGER_FILE, "_internal/06-shorts-published-Neo.json"]) {
      for (const status of ["published", "send_unknown", "scheduled"]) {
        const d = decideInstagramTimerRun({ ...base, registryRaws: [{ path, raw: raw("instagram", status) }], now: new Date("2026-10-27T11:05:00Z") });
        assert.equal(d.kind, "skip", `${path} ${status}`);
      }
    }
  });
  it("outro destino registrado não conta", () => {
    const d = decideInstagramTimerRun({ ...base, registryRaws: [{ path: "x.json", raw: raw("linkedin_profile", "published") }], now: new Date("2026-10-27T11:05:00Z") });
    assert.equal(d.kind, "publish");
  });
  it("registro ilegível lança (nunca vira 'nada publicado')", () => {
    assert.throws(() => decideInstagramTimerRun({ ...base, registryRaws: [{ path: "x.json", raw: "{" }], now: new Date("2026-10-27T11:05:00Z") }));
  });
  it("dia sem edição, Instagram desligado ou backend worker-r2: nada a fazer", () => {
    const now = new Date("2026-10-27T11:05:00Z");
    assert.equal(decideInstagramTimerRun({ ...base, reviewedExists: false, now }).kind, "skip");
    assert.equal(decideInstagramTimerRun({ ...base, config: { publishing: { shorts: { ...SHORTS, instagram: false } } }, now }).kind, "skip");
    assert.equal(decideInstagramTimerRun({ ...base, config: { publishing: { shorts: { ...SHORTS, instagram_backend: "worker-r2" } } }, now }).kind, "skip");
  });
  it("corte faltando alarma 1 h depois do horário, só se o dia teve vertical", () => {
    assert.equal(shouldAlarmMissingVideo(new Date(Date.parse(AT) + MISSING_VIDEO_ALARM_AFTER_MS - 1), AT, true), false);
    assert.equal(shouldAlarmMissingVideo(new Date(Date.parse(AT) + MISSING_VIDEO_ALARM_AFTER_MS), AT, true), true);
    assert.equal(shouldAlarmMissingVideo(new Date(Date.parse(AT) + MISSING_VIDEO_ALARM_AFTER_MS), AT, false), false);
  });
});

describe("#11265 leitura do Drive e escolha do arquivo", () => {
  const paths = { instagramCutPath: "/e/ig.mp4", genericPath: "/e/short.mp4" };
  const found: InstagramCutLookup = { kind: "found", fileId: "abcdefghijk", name: "Diaria comentada_Instagram_V3.mp4", modifiedTime: "2026-10-27T09:00:00.000Z" };

  it("interpretInstagramCutLookup: print-id/none/needs-editor/exists/erro", () => {
    assert.deepEqual(
      interpretInstagramCutLookup(0, JSON.stringify({ action: "print-id", file: { id: "abcdefghijk", name: "n.mp4", modifiedTime: "2026-10-27T09:00:00.000Z" } })),
      { kind: "found", fileId: "abcdefghijk", name: "n.mp4", modifiedTime: "2026-10-27T09:00:00.000Z" },
    );
    assert.equal(interpretInstagramCutLookup(0, JSON.stringify({ action: "none", reason: "nada" })).kind, "none");
    assert.equal(interpretInstagramCutLookup(0, JSON.stringify({ action: "exists" })).kind, "none");
    for (const selection of ["ambiguous", "orientation-unknown", "duplicate-edition-folder"]) {
      assert.equal(interpretInstagramCutLookup(3, JSON.stringify({ action: "needs-editor", selection })).kind, "needs-editor");
    }
    assert.equal(interpretInstagramCutLookup(1, JSON.stringify({ action: "error", error: "401" })).kind, "error");
    assert.equal(interpretInstagramCutLookup(1, "boom").kind, "error");
  });
  it("corte no Drive igual ao baixado: usa o local; id ou modifiedTime diferente: rebaixa", () => {
    const sidecar = { fileId: found.kind === "found" ? found.fileId : "", modifiedTime: "2026-10-27T09:00:00.000Z" };
    assert.deepEqual(chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: sidecar, genericExists: true, lookup: found }), { kind: "use-local", path: "/e/ig.mp4", source: "instagram-cut" });
    assert.equal(chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: { ...sidecar, modifiedTime: "2026-10-26T09:00:00.000Z" }, genericExists: true, lookup: found }).kind, "download");
    assert.equal(chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: { ...sidecar, fileId: "outroidxxxxx" }, genericExists: true, lookup: found }).kind, "download");
    assert.equal(chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: null, genericExists: true, lookup: found }).kind, "download");
    assert.deepEqual(chooseInstagramVideo({ ...paths, instagramCutExists: false, cutSidecar: null, genericExists: true, lookup: found }), {
      kind: "download", path: "/e/ig.mp4", fileId: "abcdefghijk", name: "Diaria comentada_Instagram_V3.mp4", modifiedTime: "2026-10-27T09:00:00.000Z",
    });
  });
  it("Drive ambíguo (needs-editor) espera e alarma, NUNCA cai no genérico (nem no corte antigo)", () => {
    const c = chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: null, genericExists: true, lookup: { kind: "needs-editor", reason: "ambiguous", immediate: true } });
    assert.deepEqual(c, { kind: "wait", reason: "ambiguous", alarm: "drive-needs-editor", alarmNow: true });
  });
  it("proporção ainda desconhecida no Drive (orientation-unknown) espera e só alarma depois de 1 h; ambiguous/duplicate-edition-folder alarmam já", () => {
    const lk = (selection: string) => interpretInstagramCutLookup(3, JSON.stringify({ action: "needs-editor", selection }));
    assert.deepEqual([lk("orientation-unknown").kind, (lk("orientation-unknown") as { immediate: boolean }).immediate], ["needs-editor", false]);
    assert.equal((lk("ambiguous") as { immediate: boolean }).immediate, true);
    assert.equal((lk("duplicate-edition-folder") as { immediate: boolean }).immediate, true);
    const c = chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: null, genericExists: true, lookup: lk("orientation-unknown") });
    assert.equal(c.kind, "wait");
    assert.equal((c as { alarmNow: boolean }).alarmNow, false);
    assert.equal((c as { alarm: string }).alarm, "drive-needs-editor");
    // Sem corte: também espera 1 h antes de alarmar.
    assert.equal((chooseInstagramVideo({ ...paths, instagramCutExists: false, cutSidecar: null, genericExists: false, lookup: { kind: "none", reason: "nada" } }) as { alarmNow: boolean }).alarmNow, false);
  });
  it("o Drive mostra o vertical da edição (achado ou ambíguo) conta como dia com vertical; none/erro não", () => {
    assert.equal(driveShowsVertical(found), true);
    assert.equal(driveShowsVertical({ kind: "needs-editor", reason: "r", immediate: false }), true);
    assert.equal(driveShowsVertical(interpretInstagramCutLookup(0, JSON.stringify({ action: "print-id", file: { id: "abcdefghijk", name: "Diaria comentada_Outras redes_V3.mp4" } }))), true);
    assert.equal(driveShowsVertical({ kind: "none", reason: "nada" }), false);
    assert.equal(driveShowsVertical({ kind: "error", reason: "401" }), false);
  });
  it("Drive sem corte: corte já baixado > genérico no disco > espera (alarme de vídeo faltando)", () => {
    const none: InstagramCutLookup = { kind: "none", reason: "nada" };
    assert.equal((chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: null, genericExists: true, lookup: none }) as { source: string }).source, "instagram-cut");
    assert.deepEqual(
      { ...chooseInstagramVideo({ ...paths, instagramCutExists: false, cutSidecar: null, genericExists: true, lookup: none }), note: undefined },
      { kind: "use-local", path: "/e/short.mp4", source: "generic", note: undefined },
    );
    const w = chooseInstagramVideo({ ...paths, instagramCutExists: false, cutSidecar: null, genericExists: false, lookup: none });
    assert.equal(w.kind, "wait");
    assert.equal((w as { alarm: string }).alarm, "missing-video");
  });
  it("erro do Drive: usa o corte já baixado; sem ele é erro (nunca o genérico em silêncio)", () => {
    const err: InstagramCutLookup = { kind: "error", reason: "401" };
    assert.equal(chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: null, genericExists: true, lookup: err }).kind, "use-local");
    assert.equal(chooseInstagramVideo({ ...paths, instagramCutExists: false, cutSidecar: null, genericExists: true, lookup: err }).kind, "error");
  });
  it("sidecar ilegível = desconhecido (rebaixa)", () => {
    assert.equal(parseCutSidecar(null), null);
    assert.equal(parseCutSidecar("{"), null);
    assert.deepEqual(parseCutSidecar(JSON.stringify({ fileId: "a", modifiedTime: "t" })), { fileId: "a", modifiedTime: "t" });
  });
});

describe("#11265 interpretInstagramTimerOutput", () => {
  const out = (o: object) => JSON.stringify({ dry_run: false, ...o });
  const item = (action: string, detail = "d") => out({ items: [{ destination: "instagram", action, detail }], results: [] });
  it("publicado → done", () => {
    const r = interpretInstagramTimerOutput(0, out({ items: [{ destination: "instagram", action: "publish" }], results: [{ destination: "instagram", ok: true, entry: { status: "published", id: "m1", url: "https://i/m1" } }] }));
    assert.equal(r.kind, "done");
  });
  it("já na conta pelo marcador → done; só pela janela de horário → alarme check-permalink (registrado)", () => {
    const r = interpretInstagramTimerOutput(0, out({ items: [], results: [{ destination: "instagram", ok: true, alreadyRegistered: true, matchedBy: "marker", entry: { status: "published", id: "m1" } }] }));
    assert.equal(r.kind, "done");
    const w = interpretInstagramTimerOutput(0, out({ items: [], results: [{ destination: "instagram", ok: true, alreadyRegistered: true, matchedBy: "time-window", entry: { status: "published", id: "m1", url: "https://i/m1" } }] }));
    assert.deepEqual([w.kind, (w as { key: string }).key, (w as { failed: boolean }).failed], ["alarm", "check-permalink", false]);
  });
  it("publicado mas registro não gravado → published-unregistered (nunca 'não saiu', pra não repostar)", () => {
    const r = interpretInstagramTimerOutput(1, out({ items: [], results: [{ destination: "instagram", ok: false, entry: { status: "published", id: "m1", url: "https://i/m1" }, error: "registro não gravado: EBUSY" }] }));
    assert.equal(r.kind, "alarm");
    assert.equal((r as { key: string }).key, "published-unregistered");
    assert.match(r.detail, /ESTÁ NO AR/);
    assert.match(r.detail, /--mark instagram=https:\/\/i\/m1/);
  });
  it("falha do publish → publish-failed", () => {
    const r = interpretInstagramTimerOutput(1, out({ items: [], results: [{ destination: "instagram", ok: false, error: "rupload 400" }] }));
    assert.equal((r as { key: string }).key, "publish-failed");
  });
  it("gate da conta bloqueou (cause preflight, blocked) → preflight-blocked (acao), nunca publish-failed", () => {
    const r = interpretInstagramTimerOutput(1, out({ items: [], results: [{ destination: "instagram", ok: false, cause: "preflight", preflight: "blocked", error: "a conta pode já ter o Reels" }] }));
    assert.equal((r as { key: string }).key, "preflight-blocked");
    assert.equal(alarmSeverity("preflight-blocked"), "acao");
  });
  it("leitura da conta falhou (cause preflight, read-failed: token expirado, 5xx) → preflight-read-failed URGENTE (o Reels não sai; e-mail sob urgent_only)", () => {
    const r = interpretInstagramTimerOutput(1, out({ items: [], results: [{ destination: "instagram", ok: false, cause: "preflight", preflight: "read-failed", error: "a leitura da conta do Instagram falhou (OAuth 190)" }] }));
    assert.equal((r as { key: string }).key, "preflight-read-failed");
    assert.equal((r as { failed: boolean }).failed, true);
    assert.equal(alarmSeverity("preflight-read-failed"), "urgente");
  });
  it("gate ACHOU o Reels mas o registro falhou (preflight persist-failed com entry) → published-unregistered", () => {
    const r = interpretInstagramTimerOutput(1, out({ items: [], results: [{ destination: "instagram", ok: false, cause: "preflight", preflight: "persist-failed", entry: { status: "published", id: "m1", url: "https://i/m1" }, error: "registro não gravado: EBUSY" }] }));
    assert.equal((r as { key: string }).key, "published-unregistered");
  });
  it("cada ação do plano tem destino certo", () => {
    assert.equal(interpretInstagramTimerOutput(0, item("pending_schedule")).kind, "wait");
    assert.equal(interpretInstagramTimerOutput(0, item("skip_done")).kind, "done");
    const k = (a: string) => (interpretInstagramTimerOutput(0, item(a)) as { key?: string }).key;
    assert.equal(k("guided"), "guided");
    assert.equal(k("skip_late"), "late");
    assert.equal(k("skip_missing_credentials"), "credentials");
    assert.equal(k("skip_invalid"), "publish-failed");
    assert.equal(k("skip_delegated"), "publish-failed");
    assert.equal(k("enqueue"), "publish-failed");
    assert.equal(k("ação-nova"), "publish-failed");
  });
  it("plano sem instagram ou sem JSON → alarme (com a cauda do stderr)", () => {
    assert.equal((interpretInstagramTimerOutput(0, out({ items: [], results: [] })) as { key: string }).key, "publish-failed");
    const r = interpretInstagramTimerOutput(2, "publish-shorts: uso", "publish-shorts: --instagram-timer só vale com timer-300");
    assert.equal((r as { key: string }).key, "no-output");
    assert.match(r.detail, /só vale com timer-300/);
  });
});

describe("#11265 conferência da conta antes de publicar", () => {
  const entry: ShortPublishedEntry = { destination: "instagram", status: "published", id: "m1", scheduled_at: null, at: AT };
  it("instagramTimerPreflight: achado → already; nada → proceed; ambíguo/leitura incompleta → block", () => {
    assert.deepEqual(instagramTimerPreflight({ kind: "register", entry, candidates: [], matchedBy: "marker" }), { kind: "already", entry, matchedBy: "marker" });
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "none" }).kind, "proceed");
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "no-match" }).kind, "proceed");
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "ambiguous" }).kind, "block");
    assert.equal(instagramTimerPreflight({ kind: "refuse", reason: "r", candidates: [], cause: "window" }).kind, "block");
  });
  it("instagramTimerGate: Reel já no ar (marcador) → grava e NÃO publica", async () => {
    const persisted: ShortPublishedEntry[] = [];
    const r = await instagramTimerGate({ decide: async () => ({ kind: "register", entry, candidates: [], matchedBy: "marker" }), persist: (e) => persisted.push(e) });
    assert.equal(r.kind, "already");
    assert.deepEqual(persisted, [entry]);
  });
  it("instagramTimerGate: achado SÓ pela janela de horário → blocked, sem gravar nem publicar (#11368: pode ser Reels de outra edição)", async () => {
    const persisted: ShortPublishedEntry[] = [];
    await assert.rejects(
      instagramTimerGate({ decide: async () => ({ kind: "register", entry, candidates: [], matchedBy: "time-window" }), persist: (e) => persisted.push(e) }),
      (e: unknown) => e instanceof InstagramTimerGateError && e.failure === "blocked" && /--media-id m1/.test(e.message),
    );
    assert.equal(persisted.length, 0);
  });
  it("ordem gate→publish na rodada do timer: Reels já na conta ou gate que lança ⇒ zero uploads (#11368)", async () => {
    let uploads = 0;
    const publish = async () => {
      uploads++;
      return "ok";
    };
    const already = await instagramTimerPublishStep({ gate: async () => ({ kind: "already", entry, matchedBy: "marker" }), publish });
    assert.equal(already.kind, "already");
    await assert.rejects(instagramTimerPublishStep({ gate: async () => { throw new InstagramTimerGateError("bloqueado", "blocked"); }, publish }), /bloqueado/);
    assert.equal(uploads, 0);
    const done = await instagramTimerPublishStep({ gate: async () => ({ kind: "publish" }), publish });
    assert.deepEqual(done, { kind: "published", outcome: "ok" });
    assert.equal(uploads, 1);
  });
  it("instagramTimerGate: ambíguo → lança (não publica, vira falha + alarme); nada na conta → publica", async () => {
    const persisted: ShortPublishedEntry[] = [];
    await assert.rejects(
      instagramTimerGate({ decide: async () => ({ kind: "refuse", reason: "2 Reels", candidates: [], cause: "ambiguous" }), persist: (e) => persisted.push(e) }),
      /o timer não publica/,
    );
    assert.deepEqual(await instagramTimerGate({ decide: async () => ({ kind: "refuse", reason: "nada", candidates: [], cause: "none" }), persist: (e) => persisted.push(e) }), { kind: "publish" });
    assert.equal(persisted.length, 0);
  });
  it("instagramTimerGate: erro da leitura da conta lança (fail-closed)", async () => {
    await assert.rejects(instagramTimerGate({ decide: async () => { throw new Error("GET /media 500"); }, persist: () => {} }), /500/);
  });
  it("instagramTimerGate: todo erro é InstagramTimerGateError com o motivo (read-failed/blocked/persist-failed + o Reels achado)", async () => {
    const failureOf = async (p: Promise<unknown>) => {
      try {
        await p;
      } catch (e) {
        assert.ok(e instanceof InstagramTimerGateError);
        return { failure: e.failure, entry: e.entry };
      }
      assert.fail("não lançou");
    };
    assert.deepEqual(await failureOf(instagramTimerGate({ decide: async () => { throw new Error("500"); }, persist: () => {} })), { failure: "read-failed", entry: undefined });
    for (const cause of ["ambiguous", "window", "media-id"] as const) {
      assert.deepEqual(await failureOf(instagramTimerGate({ decide: async () => ({ kind: "refuse", reason: "r", candidates: [], cause }), persist: () => {} })), { failure: "blocked", entry: undefined });
    }
    const r = await failureOf(
      instagramTimerGate({ decide: async () => ({ kind: "register", entry, candidates: [], matchedBy: "marker" }), persist: () => { throw new Error("EBUSY"); } }),
    );
    assert.deepEqual(r, { failure: "persist-failed", entry });
  });
});

describe("#11265 alarme", () => {
  it("o mesmo motivo não repete na mesma edição; estado ilegível avisa de novo", () => {
    assert.equal(alreadyAlarmed(null, "late"), false);
    assert.equal(alreadyAlarmed(JSON.stringify({ alarmed: ["late"] }), "late"), true);
    assert.equal(alreadyAlarmed(JSON.stringify({ alarmed: ["late"] }), "guided"), false);
    assert.equal(alreadyAlarmed("{", "late"), false);
  });
  it("Reels que não saiu no dia é urgente (e-mail sob urgent_only); Reels no ar pedindo conferência é ação", () => {
    for (const k of ["late", "guided", "missing-video", "drive-needs-editor", "drive-error", "credentials", "publish-failed", "no-output", "crash", "preflight-read-failed"] as const) {
      assert.equal(alarmSeverity(k), "urgente", k);
    }
    assert.equal(alarmSeverity("published-unregistered"), "acao");
    assert.equal(alarmSeverity("check-permalink"), "acao");
  });
  it("late: diz que o timer não publica mais e o comando manual passa --video RELATIVO (edição interpolada), só no 300", () => {
    const a = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "late", reason: "08:00 passou", videoArg: "data/editions/2610/261027/diaria-comentada-261027-short-instagram.mp4" });
    assert.match(a.subject, new RegExp(AAMMDD));
    assert.match(a.body, /NÃO publica mais/);
    assert.match(a.body, /--confirm-instagram/);
    assert.match(a.body, /--instagram-timer --publish --now --video data\/editions\/2610\/261027\/diaria-comentada-261027-short-instagram\.mp4/);
    assert.match(a.body, /SÓ NO 300/);
    assert.match(a.body, /lock do timer não cruza máquina/);
    assert.doesNotMatch(a.body, /\{AAMMDD\}/);
  });
  it("missing-video interpola a pasta da edição; published-unregistered nunca manda repostar", () => {
    const m = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "missing-video", reason: "sem corte", videoArg: "x.mp4" });
    assert.match(m.body, /261027\/Final\//);
    assert.doesNotMatch(m.body, /\{AAMMDD\}/);
    const p = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "published-unregistered", reason: "no ar", videoArg: "x.mp4" });
    assert.match(p.body, /NÃO reposte/);
    assert.doesNotMatch(p.body, /--publish/);
  });
  it("preflight-blocked: 'confira a conta antes; não reposte', nunca --publish", () => {
    const b = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "preflight-blocked", reason: "2 Reels na janela", videoArg: "x.mp4", deadlineHhmm: "11:00" });
    assert.match(b.body, /Confira a conta antes; não reposte/);
    assert.match(b.body, /--confirm-instagram/);
    assert.doesNotMatch(b.body, /--publish/);
    assert.doesNotMatch(b.body, /instagram\.com/);
    assert.match(b.subject, /conferir a conta/);
  });
  it("preflight-read-failed: confira a conta e a credencial antes de qualquer repost, nunca --publish nem 'postar no instagram.com' direto", () => {
    const b = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "preflight-read-failed", reason: "OAuth 190", videoArg: "x.mp4", deadlineHhmm: "11:00" });
    assert.match(b.body, /confira a conta e a credencial do Instagram no 300 antes de qualquer repost/);
    assert.match(b.body, /--confirm-instagram/);
    assert.match(b.body, /de hora em hora, até 11:00 BRT/);
    assert.doesNotMatch(b.body, /--publish/);
    assert.doesNotMatch(b.body, /Postar no instagram\.com/);
    assert.match(b.subject, /não saiu/);
  });
  it("opção 'publicar pela API' só em late/publish-failed/no-output/crash; nunca em guided/credentials/missing-video/drive-needs-editor", () => {
    const body = (key: Parameters<typeof buildInstagramTimerAlarm>[0]["key"]) => buildInstagramTimerAlarm({ aammdd: AAMMDD, key, reason: "r", videoArg: "x.mp4", deadlineHhmm: "11:00" }).body;
    for (const k of ["late", "publish-failed", "no-output", "crash"] as const) assert.match(body(k), /--publish --now --video x\.mp4/, k);
    for (const k of ["guided", "credentials", "missing-video", "drive-needs-editor", "drive-error", "preflight-blocked", "preflight-read-failed", "published-unregistered", "check-permalink"] as const) {
      assert.doesNotMatch(body(k), /--publish/, k);
    }
  });
  it("publish-failed/credentials: o timer volta a tentar de hora em hora até horário + 3 h (late não)", () => {
    for (const k of ["publish-failed", "credentials"] as const) {
      assert.match(buildInstagramTimerAlarm({ aammdd: AAMMDD, key: k, reason: "r", videoArg: "x.mp4", deadlineHhmm: "11:00" }).body, /volta a tentar sozinho de hora em hora até 11:00 BRT/, k);
    }
    assert.doesNotMatch(buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "late", reason: "r", videoArg: "x.mp4", deadlineHhmm: "11:00" }).body, /volta a tentar/);
    assert.equal(instagramTimerDeadlineHhmm(AT), "11:00"); // 08:00 BRT + 3 h
  });
  it("--from-drive entra no comando manual quando o id do corte é conhecido", () => {
    const b = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "publish-failed", reason: "r", videoArg: "x.mp4", driveFileId: "abcdefghijk" }).body;
    assert.match(b, /--video x\.mp4 --from-drive abcdefghijk/);
  });
  it("late não sai quando a edição já teve guided (mesmo problema, 2º e-mail urgente); o resto segue a dedup por motivo", () => {
    const guided = JSON.stringify({ alarmed: ["guided"] });
    assert.equal(alarmSuppressed(guided, "late"), true);
    assert.equal(alarmSuppressed(guided, "guided"), true);
    assert.equal(alarmSuppressed(guided, "publish-failed"), false);
    assert.equal(alarmSuppressed(null, "late"), false);
  });
  it("late (que manda publicar) não sai depois de um motivo que diz 'não reposte' — entregue ou com o e-mail pendente", () => {
    for (const k of ["preflight-blocked", "published-unregistered", "check-permalink"]) {
      assert.equal(alarmSuppressed(JSON.stringify({ alarmed: [k] }), "late"), true, k);
      assert.equal(alarmSuppressed(JSON.stringify({ alarmed: [], emailPending: [k] }), "late"), true, `${k} pendente`);
    }
    // Leitura da conta que falhou não diz que o Reels está no ar: late segue.
    assert.equal(alarmSuppressed(JSON.stringify({ alarmed: ["preflight-read-failed", "publish-failed"] }), "late"), false);
  });
  it("e-mail pendente do mesmo motivo não é suprimido (reenvia); entregue, é", () => {
    assert.equal(alarmSuppressed(JSON.stringify({ alarmed: [], emailPending: ["publish-failed"] }), "publish-failed"), false);
    assert.equal(alarmSuppressed(JSON.stringify({ alarmed: ["publish-failed"] }), "publish-failed"), true);
  });
  it("alarmDelivery: issue falha = retry; e-mail devido que falhou = email-pending; política suprimiu (acao) ou e-mail saiu = delivered", () => {
    const base = { severity: "urgente", emailPolicy: "urgent_only" } as const;
    const issue = { issueNumber: 7, url: "https://github.com/x/y/issues/7", action: "created" } as const;
    assert.equal(alarmDelivery({ ...base, issue, emailSent: true } as NotifyEditorResult).kind, "delivered");
    assert.equal(alarmDelivery({ ...base, severity: "acao", issue, emailSent: false } as NotifyEditorResult).kind, "delivered");
    const pending = alarmDelivery({ ...base, issue, emailSent: false, emailError: "resend 500" } as NotifyEditorResult);
    assert.equal(pending.kind, "email-pending");
    assert.match((pending as { error: string }).error, /resend 500/);
    assert.equal(alarmDelivery({ ...base, issue: { action: "failed", error: "gh 502" }, emailSent: false } as NotifyEditorResult).kind, "retry");
  });
  it("sequência real sob urgent_only: 1ª execução cria a issue e o e-mail falha → 2ª reenvia o e-mail (issue reused) → 3ª não repete", async () => {
    const dir = tmp();
    try {
      // `gh` falso com estado: a issue criada na 1ª execução é achada pelo marcador nas seguintes.
      const issues: { number: number; url: string; body: string; state: string }[] = [];
      const ghRun = (args: string[]): GhSpawnResult => {
        if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
        if (args[0] === "issue" && args[1] === "create") {
          const body = args[args.indexOf("--body") + 1] ?? "";
          const n = 900 + issues.length;
          issues.push({ number: n, url: `https://github.com/vjpixel/diaria-studio/issues/${n}`, body, state: "OPEN" });
          return { status: 0, stdout: `${issues.at(-1)!.url}\n`, stderr: "" };
        }
        throw new Error(`gh inesperado: ${args.join(" ")}`);
      };
      const sent: string[] = [];
      let pushOk = false;
      const sendPush = async (m: { subject: string }) => {
        if (!pushOk) return { ok: false, error: "resend 500" };
        sent.push(m.subject);
        return { ok: true };
      };
      const deps = { ghRun, sendPush, emailPolicy: "urgent_only" as const, log: () => true };
      const statePath = join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE);

      assert.equal(await alarm(dir, AAMMDD, "publish-failed", "rupload 400", { at: AT }, deps), false);
      assert.equal(issues.length, 1);
      const id = alarmId("publish-failed", "rupload 400");
      assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { aammdd: AAMMDD, alarmed: [], emailPending: [id] });

      pushOk = true;
      assert.equal(await alarm(dir, AAMMDD, "publish-failed", "rupload 400", { at: AT }, deps), true);
      assert.equal(issues.length, 1, "a 2ª execução reaproveita a issue");
      assert.equal(sent.length, 1, "o e-mail que falhou sai na 2ª execução");
      assert.deepEqual(JSON.parse(readFileSync(statePath, "utf8")), { aammdd: AAMMDD, alarmed: [id], emailPending: [] });

      assert.equal(await alarm(dir, AAMMDD, "publish-failed", "rupload 400", { at: AT }, deps), true);
      assert.equal(sent.length, 1, "entregue, não repete");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("issue que não abre não grava nada (a próxima execução tenta tudo de novo)", async () => {
    const dir = tmp();
    try {
      const deps = { ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh offline" }), sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
      assert.equal(await alarm(dir, AAMMDD, "crash", "boom", {}, deps), false);
      assert.equal(existsSync(join(dir, INSTAGRAM_TIMER_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11265 tasks do 300 cobrem os horários do vertical", () => {
  const daily = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-Instagram");
  const hourly = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-Instagram-Catchup");
  it("as duas tasks existem, armáveis, rodando o script do timer, com guard da junction data/", () => {
    for (const t of [daily, hourly]) {
      assert.ok(t);
      assert.notEqual(t!.enabled, false);
      assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/shorts-instagram-timer.ts"]);
      assert.equal(t!.guard?.requiredFile, "editions");
    }
    assert.deepEqual(hourly!.schedule, { kind: "interval", hours: 1 });
  });
  it("todo horário do teste fora da hora cheia cai na diária em até 2 min (o resto, na de hora em hora)", () => {
    const times: string[] = (platformConfig as any).publishing.shorts.schedule.rotation_times;
    const d = daily!.schedule as { kind: "daily"; hour: number; minute: number };
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      if (m === 0) continue;
      const delta = d.hour * 60 + d.minute - (h * 60 + m);
      assert.ok(delta >= 0 && delta <= 2, `${t} BRT sem execução logo depois (diária às ${d.hour}:${d.minute})`);
    }
  });
});

describe("#11265/#10978 roteiro da skill", () => {
  const skill = readFileSync(new URL("../.claude/skills/diaria-publica-video/SKILL.md", import.meta.url), "utf8");
  it("INSTAGRAM_TIMER_DETAIL e o SKILL.md mandam rodar com --only instagram --instagram-timer --publish", () => {
    assert.match(INSTAGRAM_TIMER_DETAIL, /--only instagram --instagram-timer --publish/);
    assert.match(skill, /--only instagram --publish --instagram-timer/);
    assert.match(skill, /Diaria-Shorts-Instagram/);
  });
  it("o diálogo de proporção aceita as duas nomenclaturas, sem afirmar qual aparece (#10978 item 2)", () => {
    const step = skill.split("\n").find((l) => l.startsWith("3. **Propor"))!;
    assert.ok(step, "passo 3 do B3b presente");
    assert.match(step, /"9:16"/);
    assert.match(step, /"Original"/);
    assert.doesNotMatch(step, /escolher 9:16\./);
  });
});

describe("#11265 limpeza do vertical", () => {
  const cfg = loadShortsConfig(CFG); // só o Instagram ligado
  function edition(): string {
    const dir = tmp();
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, shortInstagramVideoFileName(AAMMDD)), "ig");
    writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "short");
    return dir;
  }
  it("Reels registrado no registro do timer: o corte do Instagram é apagado; o vertical fica enquanto outro destino espera por ele", () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "instagram", status: "published", id: "m", at: AT }] }));
      cleanupPublishedVideo({ dir, edition: AAMMDD, kind: "vertical", config: cfg, log: () => {} });
      assert.equal(existsSync(join(dir, shortInstagramVideoFileName(AAMMDD))), false);
      // youtube_shorts e facebook_profile (ligados no default) ainda não saíram.
      assert.equal(existsSync(join(dir, shortVideoFileName(AAMMDD))), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("send_unknown mantém o corte (pra conferir antes de repostar)", () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, SHORTS_INSTAGRAM_TIMER_LEDGER_FILE), JSON.stringify({ aammdd: AAMMDD, entries: [{ destination: "instagram", status: "send_unknown", id: "m", at: AT }] }));
      cleanupPublishedVideo({ dir, edition: AAMMDD, kind: "vertical", config: cfg, log: () => {} });
      assert.equal(existsSync(join(dir, shortInstagramVideoFileName(AAMMDD))), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("X/Threads pulados por falta de URL pública nunca são terminais (R2 habilitado: o retry depois do sync-env precisa do vertical)", () => {
    const items = [
      { destination: "x", mode: "guided" as const, action: "skip_missing_credentials" as const, detail: "sem URL pública", cause: "public_video" as const },
      { destination: "threads_profile", mode: "api" as const, action: "skip_missing_credentials" as const, detail: "sem URL pública", cause: "public_video" as const },
      { destination: "linkedin_profile", mode: "api" as const, action: "skip_missing_credentials" as const, detail: "sem token" },
    ];
    assert.deepEqual(credentialSkippedItems(items), [{ destination: "linkedin_profile", detail: "sem token" }]);
  });
});
