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
  MISSING_VIDEO_ALARM_AFTER_MS,
  alarmSeverity,
  alreadyAlarmed,
  buildInstagramTimerAlarm,
  chooseInstagramVideo,
  decideInstagramTimerRun,
  interpretInstagramCutLookup,
  interpretInstagramTimerOutput,
  parseCutSidecar,
  shouldAlarmMissingVideo,
  type InstagramCutLookup,
} from "../scripts/shorts-instagram-timer.ts";
import {
  INSTAGRAM_TIMER_DETAIL,
  SHORTS_BOOLEAN_FLAGS,
  credentialSkippedItems,
  instagramTimerGate,
  instagramTimerPreflight,
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
  it("sem R2, X/Threads dizem que o R2 não será habilitado em vez de cobrar os secrets", () => {
    assert.doesNotMatch(publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID"]), /R2_ACCOUNT_ID/);
    assert.match(publicVideoUnavailableReason("timer-300", ["R2_ACCOUNT_ID"]), /#11265/);
    assert.match(publicVideoUnavailableReason("worker-r2", ["R2_ACCOUNT_ID"]), /falta R2_ACCOUNT_ID/);
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
    const p = planShortsPublish({ ...base, instagramTimer: true, now: new Date("2026-10-27T10:00:00Z") });
    assert.equal(ig(p).action, "pending_schedule");
    assert.equal((ig(p) as { scheduledAt: string }).scheduledAt, AT);
    assert.ok(p.premises.some((x) => x.startsWith(`instagram: timer do 300 publica depois de ${AT}`)));
  });
  it("rodada do timer depois do horário: publish na hora (upload resumível, sem URL pública)", () => {
    const p = planShortsPublish({ ...base, instagramTimer: true, now: new Date("2026-10-27T11:05:00Z") });
    assert.equal(ig(p).action, "publish");
  });
  it("rodada do timer: até 3 h exatas publica; 1 ms depois vira skip_late (--now publica)", () => {
    const limit = new Date(Date.parse(AT) + MAX_FIRE_LATENESS_MS);
    assert.equal(ig(planShortsPublish({ ...base, instagramTimer: true, now: limit })).action, "publish");
    const late = new Date(limit.getTime() + 1);
    assert.equal(ig(planShortsPublish({ ...base, instagramTimer: true, now: late })).action, "skip_late");
    assert.equal(ig(planShortsPublish({ ...base, instagramTimer: true, forceNow: true, now: late })).action, "publish");
  });
  it("rodada do timer com o vertical acima do teto: passo guiado (o timer avisa o editor)", () => {
    const p = planShortsPublish({ ...base, instagramTimer: true, videoDurationSeconds: 50, now: new Date("2026-10-27T11:05:00Z") });
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
    const p = planShortsPublish({ ...base, aammdd, published: { aammdd, entries: [] }, grid, instagramTimer: true, now });
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
    assert.equal(instagramTimerScopeError({ instagramTimer: false, only: null }), null);
    assert.equal(instagramTimerScopeError({ instagramTimer: true, only: ["instagram"] }), null);
    assert.equal(instagramTimerScopeError({ instagramTimer: true, backend: "timer-300", only: ["instagram"] }), null);
    assert.match(instagramTimerScopeError({ instagramTimer: true, backend: "worker-r2", only: ["instagram"] })!, /timer-300/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: null })!, /exige --only instagram/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: ["instagram", "facebook:diaria"] })!, /exige --only instagram/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, linkedinTimer: true, only: ["instagram"] })!, /não combina com --linkedin-timer/);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: ["instagram"], confirmInstagram: true })!, /não combina com --confirm-instagram/);
    assert.equal(instagramTimerScopeError({ instagramTimer: true, only: null, markDestination: "instagram" }), null);
    assert.match(instagramTimerScopeError({ instagramTimer: true, only: null, markDestination: "x" })!, /só aceita instagram/);
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
    const c = chooseInstagramVideo({ ...paths, instagramCutExists: true, cutSidecar: null, genericExists: true, lookup: { kind: "needs-editor", reason: "ambiguous" } });
    assert.deepEqual(c, { kind: "wait", reason: "ambiguous", alarm: "drive-needs-editor" });
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
  it("instagramTimerGate: Reel já no ar → grava e NÃO publica", async () => {
    const persisted: ShortPublishedEntry[] = [];
    const r = await instagramTimerGate({ decide: async () => ({ kind: "register", entry, candidates: [], matchedBy: "time-window" }), persist: (e) => persisted.push(e) });
    assert.equal(r.kind, "already");
    assert.deepEqual(persisted, [entry]);
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
});

describe("#11265 alarme", () => {
  it("o mesmo motivo não repete na mesma edição; estado ilegível avisa de novo", () => {
    assert.equal(alreadyAlarmed(null, "late"), false);
    assert.equal(alreadyAlarmed(JSON.stringify({ alarmed: ["late"] }), "late"), true);
    assert.equal(alreadyAlarmed(JSON.stringify({ alarmed: ["late"] }), "guided"), false);
    assert.equal(alreadyAlarmed("{", "late"), false);
  });
  it("Reels que não saiu no dia é urgente (e-mail sob urgent_only); Reels no ar pedindo conferência é ação", () => {
    for (const k of ["late", "guided", "missing-video", "drive-needs-editor", "drive-error", "credentials", "publish-failed", "no-output", "crash"] as const) {
      assert.equal(alarmSeverity(k), "urgente", k);
    }
    assert.equal(alarmSeverity("published-unregistered"), "acao");
    assert.equal(alarmSeverity("check-permalink"), "acao");
  });
  it("late: diz que o timer não publica mais e o comando manual passa --video com o caminho do corte (edição interpolada)", () => {
    const a = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "late", reason: "08:00 passou", cutPath: "/data/editions/2610/261027/diaria-comentada-261027-short-instagram.mp4" });
    assert.match(a.subject, new RegExp(AAMMDD));
    assert.match(a.body, /NÃO publica mais/);
    assert.match(a.body, /--confirm-instagram/);
    assert.match(a.body, /--instagram-timer --publish --now --video \/data\/editions\/2610\/261027\/diaria-comentada-261027-short-instagram\.mp4/);
    assert.doesNotMatch(a.body, /\{AAMMDD\}/);
  });
  it("missing-video interpola a pasta da edição; published-unregistered nunca manda repostar", () => {
    const m = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "missing-video", reason: "sem corte", cutPath: "/x.mp4" });
    assert.match(m.body, /261027\/Final\//);
    assert.doesNotMatch(m.body, /\{AAMMDD\}/);
    const p = buildInstagramTimerAlarm({ aammdd: AAMMDD, key: "published-unregistered", reason: "no ar", cutPath: "/x.mp4" });
    assert.match(p.body, /NÃO reposte/);
    assert.doesNotMatch(p.body, /--publish --now/);
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
  it("X/Threads pulados por falta de URL pública: terminais só quando o R2 está fora de cogitação (timer-300 sem R2)", () => {
    const items = [{ destination: "x", mode: "guided" as const, action: "skip_missing_credentials" as const, detail: "sem URL pública", cause: "public_video" as const }];
    assert.deepEqual(credentialSkippedItems(items), []);
    assert.deepEqual(credentialSkippedItems(items, { publicVideoTerminal: true }), [{ destination: "x", detail: "sem URL pública" }]);
  });
});
