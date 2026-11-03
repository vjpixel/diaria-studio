/**
 * #12001: na última hora antes do teto de 3 h (#11996) a rodada manual do
 * corte publica sozinha os destinos do timer, e o timer de hora em hora ainda
 * pode passar e publicar o mesmo destino. Regressão: timer e rodada manual
 * concorrentes nunca publicam o mesmo destino — (1) a rodada manual toma o
 * lock do timer do corte, (2) o timer pula o destino com marca "envio em
 * curso" recente. Sem rede, sem publicar.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORTE_TIMER_LOCK_FILE as TIMER_REEXPORT_LOCK_FILE,
  corteInFlightDestinations,
  decideCorteTimerRun,
  runCorteTimerFor,
} from "../scripts/shorts-corte-timer.ts";
import {
  corteManualTimerDestinations,
  corteTimerLockBusyError,
  planShortsPublish,
  prepareCorteRun,
  recordCortePublishAuthorization,
} from "../scripts/publish-shorts.ts";
import { CORTE_SPEC_FILE, CORTE_TIMER_INTERVAL_MS, CORTE_TIMER_LOCK_FILE, parseCorteSpec, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { corteContentFingerprint } from "../scripts/lib/diaria/corte-content.ts";
import { markShortSending, type ShortSendingMark } from "../scripts/lib/diaria/shorts-sending-marker.ts";
import { persistShortEntry } from "../scripts/lib/diaria/shorts-published-store.ts";
import { acquireTimerLock } from "../scripts/lib/diaria/timer-lock.ts";
import { acquireTimerLock as linkedinTimerLock } from "../scripts/shorts-linkedin-profile-timer.ts";
import { SHORTS_TIMER_LOCK_STALE_MS } from "../scripts/lib/diaria/vertical-download-guard.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SLUG = "corte-12001";
const DATE = "261103";
const AT = "2026-11-03T11:00:00.000Z"; // 08:00 BRT
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const MIN = 60_000;
/** Última hora antes do teto: a rodada manual publica sozinha (#11996). */
const TAIL = MAX_FIRE_LATENESS_MS - CORTE_TIMER_INTERVAL_MS + 10 * MIN; // 2h10
const TIMER_DESTS = ["linkedin_profile", "threads_profile", "instagram"];
const shorts = {
  facebook_pages: ["diaria"],
  instagram: true,
  linkedin_profile: true,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  linkedin_profile_via_timer: true,
  threads_profile_via_timer: true,
  instagram_backend: "timer-300",
  instagram_api_max_seconds_by_account: { diaria: null },
  corte_via_timer: true,
};
const CONFIG = { publishing: { shorts } };
const KNOWN = new Set(["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", "threads_profile"]);
const SPEC: CorteSpec = {
  slug: SLUG,
  date: DATE,
  hhmm: "08:00",
  title: "Título",
  hook: "Gancho.",
  video: `corte-${SLUG}.mp4`,
  publish_confirmed_at: AT,
  publish_confirmed_destinations: TIMER_DESTS,
};
const mark = (destination: string, startedMs: number): ShortSendingMark => ({ destination, started_at: at(startedMs).toISOString(), pid: 1 });
const entry = (destination: string, atMs: number): ShortPublishedEntry => ({ destination, status: "published", id: `id-${destination}`, at: at(atMs).toISOString() });
const registry = (entries: ShortPublishedEntry[]) => [{ path: "06-shorts-published.json", raw: JSON.stringify({ aammdd: DATE, entries }) }];

/** Pasta de corte com vídeo e o "pode publicar" dos 3 destinos do timer. */
function corteDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "corte-12001-")), SLUG);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, SPEC.video), "mp4");
  prepareCorteRun({ slug: SLUG, dir, values: { date: DATE, at: SPEC.hhmm, title: SPEC.title, hook: SPEC.hook, video: join(dir, SPEC.video) }, positionalDate: "", log: () => {} });
  const spec = parseCorteSpec(readFileSync(join(dir, CORTE_SPEC_FILE), "utf8"), "corte.json");
  recordCortePublishAuthorization(dir, TIMER_DESTS.join(","), KNOWN, corteContentFingerprint(dir, spec), AT, () => {});
  return dir;
}

function timerDeps(now: Date) {
  const calls: string[][] = [];
  return {
    calls,
    deps: {
      config: CONFIG,
      now,
      runScript: (args: string[]) => {
        calls.push(args);
        return { status: 0, stdout: "{}", stderr: "" };
      },
      notify: { cwd: "/nao-usado" },
      alarm: async () => true,
    },
  };
}
const onlyArg = (args: string[]) => args[args.indexOf("--only") + 1];
/** Lock tomado "no instante" `ms` do relógio do teste (a idade do lock sai da mtime). */
function lockAt(dir: string, ms: number): (() => void) | null {
  const path = join(dir, CORTE_TIMER_LOCK_FILE);
  const release = acquireTimerLock(path, at(ms).getTime());
  if (release) utimesSync(path, at(ms), at(ms));
  return release;
}

describe("#12001 decideCorteTimerRun respeita a marca 'envio em curso'", () => {
  it("cenário da issue: rodada manual às 2h10 no meio do upload do linkedin_profile — o timer publica só os outros", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: [mark("linkedin_profile", TAIL - 2 * MIN)], now: at(TAIL) });
    assert.equal(d.kind, "publish");
    if (d.kind !== "publish") return;
    assert.ok(!d.pending.includes("linkedin_profile"));
    assert.deepEqual(d.pending.sort(), ["instagram", "threads_profile"]);
    assert.deepEqual(d.inFlight, ["linkedin_profile"]);
  });

  it("todos os pendentes em curso: nada a publicar nesta execução (skip, nunca publish)", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: TIMER_DESTS.map((x) => mark(x, TAIL - MIN)), now: at(TAIL) });
    assert.equal(d.kind, "skip");
    if (d.kind === "skip") assert.match(d.reason, /envio em curso por outra rodada/);
  });

  it("sem marca (antes do #12001) os três saem pelo timer", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], now: at(TAIL) });
    assert.equal(d.kind, "publish");
    if (d.kind === "publish") assert.equal(d.pending.length, 3);
  });

  it("marca velha (processo morto no meio, > 90 min) não segura o destino para sempre", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: [mark("linkedin_profile", TAIL - SHORTS_TIMER_LOCK_STALE_MS - MIN)], now: at(TAIL) });
    assert.equal(d.kind, "publish");
    if (d.kind === "publish") assert.ok(d.pending.includes("linkedin_profile"));
  });

  it("marca com entrada gravada depois dela é envio concluído: registrado, não pendente", () => {
    assert.deepEqual([...corteInFlightDestinations([mark("instagram", TAIL - 5 * MIN)], [entry("instagram", TAIL - MIN)], at(TAIL))], []);
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: registry([entry("instagram", TAIL - MIN)]), sendingMarks: [mark("instagram", TAIL - 5 * MIN)], now: at(TAIL) });
    assert.equal(d.kind, "publish");
    if (d.kind === "publish") assert.ok(!d.pending.includes("instagram"));
  });

  it("marca com data ilegível não conta como em curso (não há idade para julgar)", () => {
    assert.deepEqual([...corteInFlightDestinations([{ destination: "instagram", started_at: "ontem" }], [], at(TAIL))], []);
  });

  it("depois do teto, o destino em curso também fica fora do alarme late", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: [mark("threads_profile", MAX_FIRE_LATENESS_MS)], now: at(MAX_FIRE_LATENESS_MS + 10 * MIN) });
    assert.equal(d.kind, "late");
    if (d.kind === "late") {
      assert.ok(!d.pending.includes("threads_profile"));
      assert.deepEqual(d.inFlight, ["threads_profile"]);
    }
  });
});

describe("#12001 regressão: timer e rodada manual concorrentes na mesma pasta do corte", () => {
  it("rodada manual com o lock do timer (publicando na última hora): o timer sai sem chamar o publish-shorts", async () => {
    const dir = corteDir();
    const manual = lockAt(dir, TAIL);
    assert.ok(manual, "a rodada manual toma o lock");
    const { calls, deps } = timerDeps(at(TAIL));
    assert.equal(await runCorteTimerFor(dir, false, deps), 0);
    assert.deepEqual(calls, []);
    manual!();
    // Lock solto e o registro gravado pela rodada manual: o timer não tem mais nada a publicar.
    for (const d of TIMER_DESTS) persistShortEntry(dir, DATE, "main", entry(d, TAIL));
    const again = timerDeps(at(TAIL + 30 * MIN));
    assert.equal(await runCorteTimerFor(dir, false, again.deps), 0);
    assert.deepEqual(again.calls, []);
  });

  it("marca 'envio em curso' gravada pela rodada manual (outra máquina, sem o lock sincronizado): o timer deixa o destino de fora", async () => {
    const dir = corteDir();
    markShortSending(dir, DATE, "main", mark("linkedin_profile", TAIL - 3 * MIN));
    const { calls, deps } = timerDeps(at(TAIL));
    await runCorteTimerFor(dir, false, deps);
    assert.equal(calls.length, 1);
    assert.deepEqual(onlyArg(calls[0]).split(",").sort(), ["instagram", "threads_profile"]);
  });

  it("timer com o lock (filho publicando): a rodada manual não consegue o lock e recusa esses destinos", () => {
    const dir = corteDir();
    const timer = lockAt(dir, TAIL);
    assert.ok(timer);
    assert.equal(acquireTimerLock(join(dir, CORTE_TIMER_LOCK_FILE), at(TAIL + MIN).getTime()), null);
    assert.match(corteTimerLockBusyError(SLUG), /está publicando o corte "corte-12001" agora/);
    timer!();
    assert.equal(existsSync(join(dir, CORTE_TIMER_LOCK_FILE)), false);
  });
});

describe("#12001 quem toma o lock no publish-shorts", () => {
  const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
  const base = {
    aammdd: DATE,
    reviewedMd: "",
    config: CONFIG,
    pages: [page("diaria")],
    instagramReady: true,
    published: { aammdd: DATE, entries: [] },
    video: { path: "/videos/corte.mp4", exists: true, sizeBytes: 10 },
    videoDurationSeconds: 50,
    threadsPersonal: { ready: true } as const,
    linkedinPersonal: { ready: true } as const,
    publicVideo: { ready: true } as const,
    youtubeApi: { ready: true } as const,
    corte: { slug: SLUG, hhmm: "08:00", title: "Título", hook: "Gancho." },
  };

  it("rodada manual na última hora publica os destinos do timer: são eles que pedem o lock", () => {
    const p = planShortsPublish({ ...base, now: at(TAIL) });
    assert.deepEqual(corteManualTimerDestinations(p.items, { timerRun: false }).sort(), [...TIMER_DESTS].sort());
  });

  it("na janela delegada (skip_delegated) não há destino do timer a publicar: sem lock", () => {
    const p = planShortsPublish({ ...base, now: at(20 * MIN) });
    assert.deepEqual(corteManualTimerDestinations(p.items, { timerRun: false }), []);
  });

  it("o filho do timer (timerRun) nunca toma: quem o chamou já está com o lock", () => {
    const p = planShortsPublish({ ...base, corte: { ...base.corte, timerRun: true }, now: at(TAIL), forceNow: true });
    assert.deepEqual(corteManualTimerDestinations(p.items, { timerRun: true }), []);
    assert.deepEqual(corteManualTimerDestinations(p.items, null), []);
  });

  it("main: o lock é o mesmo arquivo do timer, tomado antes do laço de envios e solto depois (fonte)", () => {
    assert.equal(TIMER_REEXPORT_LOCK_FILE, CORTE_TIMER_LOCK_FILE);
    assert.equal(linkedinTimerLock, acquireTimerLock);
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    assert.match(src, /corteManualTimerDestinations\(plan\.items, corte \? \{ timerRun: requireCorteAuth \} : null\)/);
    assert.match(src, /acquireTimerLock\(join\(dir, CORTE_TIMER_LOCK_FILE\)\)[\s\S]*for \(const item of plan\.items\) \{\s*if \(corteLockBusy && corteLockDests\.includes\(item\.destination\)\)/);
    assert.match(src, /\n  releaseCorteLock\(\);\n  const finalItems = blockRepostOnProfileFailure/);
    const timerSrc = readFileSync(new URL("../scripts/shorts-corte-timer.ts", import.meta.url), "utf8");
    assert.match(timerSrc, /sendingMarks: readShortsSending\(dir, spec\.date\)/);
  });
});
