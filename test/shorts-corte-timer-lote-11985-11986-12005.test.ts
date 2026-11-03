/**
 * Lote shorts-timer (#11985, #11986, #12005). Regressões, sem rede e sem publicar:
 *
 * - #11985: depois de um `child-timeout` (filho morto pelo teto de 75 min), a
 *   execução seguinte do timer do corte, ainda dentro das 3 h e com a marca
 *   "envio em curso" já mais velha que 90 min, publicava o `linkedin_profile`
 *   de novo (ele não confere a conta antes de publicar). Agora a marca velha
 *   sem desfecho segura o destino, alarma `sending-orphan` e só sai com
 *   `--clear-sending` (ou `--mark`).
 * - #11986: com o timer do corte parado, a janela delegada passava sem alarme.
 *   Agora o timer grava heartbeat; a vigia dos cortes alarma e a rodada manual
 *   avisa.
 * - #12005: o release do lock era um `rm` cego e apagava o lock de outro dono.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORTE_ACCOUNT_RECHECK_DESTINATIONS,
  buildCorteTimerAlarm,
  clearCorteSending,
  corteAlarmSeverity,
  corteClearSendingCommand,
  corteOrphanSendingMarks,
  decideCorteTimerRun,
  runCorteTimerFor,
  type CorteTimerAlarmKey,
} from "../scripts/shorts-corte-timer.ts";
import { corteTimerStaleWarning, planShortsPublish } from "../scripts/publish-shorts.ts";
import { CORTE_SPEC_FILE, CORTE_TIMER_LOCK_FILE, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { markShortSending, readShortsSending, shortsSendingPath, type ShortSendingMark } from "../scripts/lib/diaria/shorts-sending-marker.ts";
import { SHORTS_TIMER_LOCK_STALE_MS } from "../scripts/lib/diaria/vertical-download-guard.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import {
  CORTE_TIMER_HEARTBEAT_FILE,
  CORTE_TIMER_HEARTBEAT_STALE_MS,
  corteTimerHeartbeatStale,
  readCorteTimerHeartbeat,
  writeCorteTimerHeartbeat,
} from "../scripts/lib/diaria/corte-timer-heartbeat.ts";
import { buildCorteWatchAlarm, findCortesWithStaleTimer, findCortesWithoutOwner, watchCortesWithoutOwner, type CorteWatchInput } from "../scripts/lib/diaria/corte-owner-watch.ts";
import { acquireTimerLock, timerLockToken } from "../scripts/lib/diaria/timer-lock.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";

const SLUG = "corte-lote";
const DATE = "261103";
const AT = "2026-11-03T11:00:00.000Z"; // 08:00 BRT
const at = (ms: number) => new Date(Date.parse(AT) + ms);
const MIN = 60_000;
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
const SPEC: CorteSpec = {
  slug: SLUG,
  date: DATE,
  hhmm: "08:00",
  title: "Título",
  hook: "Gancho.",
  video: "corte.mp4",
  publish_confirmed_at: "2026-11-02T20:00:00.000Z",
  publish_confirmed_destinations: TIMER_DESTS,
  publish_confirmed_content: { video_sha256: createHash("sha256").update("mp4").digest("hex"), cover_sha256: null },
};
const mark = (destination: string, startedMs: number): ShortSendingMark => ({ destination, started_at: at(startedMs).toISOString(), pid: 1 });

function corteDir(spec: CorteSpec = SPEC): string {
  const dir = join(mkdtempSync(join(tmpdir(), "corte-lote-")), SLUG);
  mkdirSync(join(dir, "_internal"), { recursive: true });
  writeFileSync(join(dir, CORTE_SPEC_FILE), JSON.stringify(spec));
  writeFileSync(join(dir, spec.video), "mp4");
  return dir;
}

describe("#11985 timeout seguido de nova rodada não reenvia o LinkedIn", () => {
  it("cenário da issue: filho morto com o linkedin_profile no meio; a rodada 100 min depois não o publica de novo e alarma", async () => {
    const dir = corteDir();
    const calls: string[][] = [];
    const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
    const deps = (now: Date) => ({
      config: CONFIG,
      now,
      notify: { cwd: "/nao-usado" },
      runScript: (args: string[]) => {
        calls.push(args);
        if (calls.length === 1) {
          // O filho começa o envio do LinkedIn e é morto pelo teto antes de registrar.
          markShortSending(dir, DATE, "main", { destination: "linkedin_profile", started_at: at(12 * MIN).toISOString() });
          return { status: null, stdout: "", stderr: "", timedOut: true };
        }
        const only = args[args.indexOf("--only") + 1].split(",");
        return { status: 0, stdout: JSON.stringify({ results: only.map((d) => ({ destination: d, ok: true, entry: { destination: d, status: "published", id: `id-${d}`, at: now.toISOString() } })) }), stderr: "" };
      },
      alarm: async (_d: string, _s: CorteSpec, destination: string, key: CorteTimerAlarmKey) => {
        alarms.push({ destination, key });
        return true;
      },
    });
    assert.equal(await runCorteTimerFor(dir, false, deps(at(10 * MIN))), 1);
    assert.deepEqual(alarms.map((a) => a.key), ["child-timeout", "child-timeout", "child-timeout"]);
    // 1ª execução seguinte em que a marca já não conta como "em curso" (> 90 min), dentro das 3 h.
    const next = at(12 * MIN + SHORTS_TIMER_LOCK_STALE_MS + 8 * MIN);
    assert.ok(next.getTime() - Date.parse(AT) < MAX_FIRE_LATENESS_MS);
    alarms.length = 0;
    await runCorteTimerFor(dir, false, deps(next));
    assert.equal(calls.length, 2);
    const only = calls[1][calls[1].indexOf("--only") + 1].split(",").sort();
    assert.deepEqual(only, ["instagram", "threads_profile"], "o LinkedIn não volta ao --only (sairia em dobro)");
    assert.deepEqual(alarms, [{ destination: "linkedin_profile", key: "sending-orphan" }]);
  });

  it("só o LinkedIn pendente e preso: skip, nenhum publish, alarme sending-orphan", async () => {
    const dir = corteDir({ ...SPEC, publish_confirmed_destinations: ["linkedin_profile"] });
    markShortSending(dir, DATE, "main", { destination: "linkedin_profile", started_at: at(12 * MIN).toISOString() });
    let calls = 0;
    const alarms: string[] = [];
    const code = await runCorteTimerFor(dir, false, {
      config: CONFIG,
      now: at(2 * 3_600_000),
      notify: { cwd: "/nao-usado" },
      runScript: () => {
        calls++;
        return { status: 0, stdout: "{}", stderr: "" };
      },
      alarm: async (_d, _s, _dest, key) => {
        alarms.push(key);
        return true;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 0);
    assert.deepEqual(alarms, ["sending-orphan"]);
  });

  it("puro: marca velha segura o linkedin_profile; Instagram e Threads (conferem a conta) seguem pendentes", () => {
    const old = TIMER_DESTS.map((d) => mark(d, 0));
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: old, now: at(SHORTS_TIMER_LOCK_STALE_MS + 10 * MIN) });
    assert.equal(d.kind, "publish");
    if (d.kind !== "publish") return;
    assert.deepEqual(d.pending.sort(), ["instagram", "threads_profile"]);
    assert.deepEqual(d.alarms?.map((a) => `${a.destination}:${a.key}`), ["linkedin_profile:sending-orphan"]);
    assert.deepEqual([...CORTE_ACCOUNT_RECHECK_DESTINATIONS].sort(), ["instagram", "threads_profile"]);
  });

  it("puro: marca recente é 'em curso' (sem alarme); marca com registro depois dela não segura; data ilegível segura (fail-closed)", () => {
    const recent = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: [mark("linkedin_profile", 50 * MIN)], now: at(60 * MIN) });
    assert.equal(recent.kind, "publish");
    if (recent.kind === "publish") {
      assert.deepEqual(recent.inFlight, ["linkedin_profile"]);
      assert.equal(recent.alarms, undefined);
    }
    const entry: ShortPublishedEntry = { destination: "linkedin_profile", status: "published", id: "x", at: at(20 * MIN).toISOString() };
    assert.deepEqual(corteOrphanSendingMarks([mark("linkedin_profile", 10 * MIN)], [entry], at(3 * 3_600_000)), []);
    assert.equal(corteOrphanSendingMarks([{ destination: "linkedin_profile", started_at: "ontem" }], [], at(60 * MIN)).length, 1);
  });

  it("depois do teto, o destino preso não vira late (o alarme sending-orphan já cobre)", () => {
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: [mark("linkedin_profile", 0)], now: at(MAX_FIRE_LATENESS_MS + 10 * MIN) });
    assert.equal(d.kind, "late");
    if (d.kind === "late") {
      assert.ok(!d.pending.includes("linkedin_profile"));
      assert.deepEqual(d.alarms?.map((a) => a.key), ["sending-orphan"]);
    }
  });

  it("alarme sending-orphan: conferir a conta, liberar com --clear-sending (rodar o timer não adianta)", () => {
    assert.equal(corteAlarmSeverity("sending-orphan"), "acao");
    const { body, subject } = buildCorteTimerAlarm({ spec: SPEC, destination: "linkedin_profile", key: "sending-orphan", reason: "x" });
    assert.match(subject, /conferir a conta \(sending-orphan\)/);
    assert.match(body, /NÃO poste de novo sem conferir/);
    assert.ok(body.includes(corteClearSendingCommand(SLUG, "linkedin_profile")));
    assert.doesNotMatch(body, /publique com `npx tsx scripts\/shorts-corte-timer\.ts --corte/);
  });

  it("--clear-sending apaga a marca do destino em todos os arquivos (escritores e cópia de conflito) e libera o timer", () => {
    const dir = corteDir();
    markShortSending(dir, DATE, "main", { destination: "linkedin_profile", started_at: at(0).toISOString() });
    markShortSending(dir, DATE, "main", { destination: "instagram", started_at: at(0).toISOString() });
    markShortSending(dir, DATE, "linkedin-timer", { destination: "linkedin_profile", started_at: at(0).toISOString() });
    const conflict = shortsSendingPath(dir, "main").replace(/\.json$/, "-neo.json");
    writeFileSync(conflict, JSON.stringify({ aammdd: DATE, marks: [{ destination: "linkedin_profile", started_at: at(0).toISOString() }] }));
    const lines: string[] = [];
    assert.equal(clearCorteSending(dir, "linkedin_profile", (l) => lines.push(l)), 0);
    assert.match(lines[0], /3 marca\(s\)/);
    assert.deepEqual(readShortsSending(dir, DATE).map((m) => m.destination), ["instagram"]);
    assert.equal(existsSync(conflict), false, "arquivo sem marca é removido");
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], sendingMarks: readShortsSending(dir, DATE), now: at(2 * 3_600_000) });
    assert.equal(d.kind, "publish");
    if (d.kind === "publish") assert.ok(d.pending.includes("linkedin_profile"));
  });

  it("main: --clear-sending sem valor nunca cai na execução normal (fonte)", () => {
    const src = readFileSync(new URL("../scripts/shorts-corte-timer.ts", import.meta.url), "utf8");
    assert.match(src, /flags\.has\("clear-sending"\)/);
    assert.match(src, /if \(clearDest !== undefined\) return clearCorteSending\(dirs\[0\], clearDest\);/);
  });
});

describe("#11986 timer do corte parado na janela delegada", () => {
  const input = (dir: string, spec: CorteSpec = SPEC, registry: CorteWatchInput["registryRaws"] = []): CorteWatchInput => ({ dir, spec, registryRaws: registry });

  it("heartbeat: grava, lê, e conta como velho ausente/ilegível/mais de duas cadências", () => {
    const cortes = mkdtempSync(join(tmpdir(), "cortes-hb-"));
    assert.equal(readCorteTimerHeartbeat(cortes).ranAt, null);
    assert.equal(corteTimerHeartbeatStale(readCorteTimerHeartbeat(cortes), at(0)), true);
    writeCorteTimerHeartbeat(cortes, at(0), "start");
    const hb = readCorteTimerHeartbeat(cortes);
    assert.equal(hb.ranAt, at(0).toISOString());
    assert.equal(corteTimerHeartbeatStale(hb, at(CORTE_TIMER_HEARTBEAT_STALE_MS)), false);
    assert.equal(corteTimerHeartbeatStale(hb, at(CORTE_TIMER_HEARTBEAT_STALE_MS + MIN)), true);
    writeFileSync(join(cortes, CORTE_TIMER_HEARTBEAT_FILE), "{quebrado");
    const bad = readCorteTimerHeartbeat(cortes);
    assert.equal(bad.ranAt, null);
    assert.ok(bad.error);
  });

  it("cenário da issue: horário passou, destino autorizado sem registro e timer sem heartbeat → finding por destino", () => {
    const f = findCortesWithStaleTimer({ config: CONFIG, destination: "linkedin_profile", cortes: [input("/c")], heartbeat: { ranAt: null }, now: at(20 * MIN) });
    assert.equal(f.length, 1);
    assert.equal(f[0].kind, "timer-stale");
    assert.match(f[0].reason, /Diaria-Shorts-Cortes/);
    const { subject, body } = buildCorteWatchAlarm(f[0], "Diaria-Shorts-LinkedIn-Profile");
    assert.match(subject, /não roda/);
    assert.match(body, /--mark linkedin_profile=URL/);
    // Sem corte_via_timer, a vigia antiga (#11911) é quem cobre: nada de timer-stale.
    assert.deepEqual(findCortesWithoutOwner({ config: CONFIG, destination: "linkedin_profile", cortes: [input("/c")], now: at(20 * MIN) }), []);
  });

  it("não alarma: heartbeat recente, antes do horário, sem autorização do destino, já registrado, corte_via_timer desligado", () => {
    const base = { config: CONFIG, destination: "linkedin_profile", heartbeat: { ranAt: null } as const, now: at(20 * MIN) };
    assert.deepEqual(findCortesWithStaleTimer({ ...base, cortes: [input("/c")], heartbeat: { ranAt: at(-10 * MIN).toISOString() } }), []);
    assert.deepEqual(findCortesWithStaleTimer({ ...base, cortes: [input("/c")], now: at(-5 * MIN) }), []);
    assert.deepEqual(findCortesWithStaleTimer({ ...base, cortes: [input("/c", { ...SPEC, publish_confirmed_destinations: ["instagram"] })] }), []);
    const reg = [{ path: "06-shorts-published.json", raw: JSON.stringify({ aammdd: DATE, entries: [{ destination: "linkedin_profile", status: "published", id: "x", at: at(5 * MIN).toISOString() }] }) }];
    assert.deepEqual(findCortesWithStaleTimer({ ...base, cortes: [input("/c", SPEC, reg)] }), []);
    assert.deepEqual(findCortesWithStaleTimer({ ...base, config: { publishing: { shorts: { ...shorts, corte_via_timer: false } } }, cortes: [input("/c")] }), []);
  });

  it("a vigia dos timers da edição lê o heartbeat em data/cortes/ (dry-run: só log, nenhum e-mail)", async () => {
    const cortes = mkdtempSync(join(tmpdir(), "cortes-watch-"));
    const dir = join(cortes, SLUG);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, CORTE_SPEC_FILE), JSON.stringify(SPEC));
    const lines: string[] = [];
    const deps = { config: CONFIG, now: at(30 * MIN), cortesDir: cortes, notify: { cwd: "/nao-usado" }, checkTask: "Diaria-Shorts-LinkedIn-Profile", log: (l: string) => lines.push(l) };
    assert.equal(await watchCortesWithoutOwner("linkedin_profile", true, deps), true);
    assert.equal(lines.filter((l) => /não roda/.test(l)).length, 1);
    lines.length = 0;
    writeCorteTimerHeartbeat(cortes, at(25 * MIN), "end");
    assert.equal(await watchCortesWithoutOwner("linkedin_profile", true, deps), true);
    assert.deepEqual(lines, []);
  });

  it("a rodada manual que delega ao timer parado avisa em warnings; com heartbeat recente, não", () => {
    const page: ResolvedFacebookPage = { slug: "diaria", enabled: true, pageId: "id", token: "tok", missing: [], utmContent: null };
    const base = {
      aammdd: DATE,
      reviewedMd: "",
      config: CONFIG,
      pages: [page],
      instagramReady: true,
      published: { aammdd: DATE, entries: [] },
      video: { path: "/videos/corte.mp4", exists: true, sizeBytes: 10 },
      videoDurationSeconds: 50,
      threadsPersonal: { ready: true } as const,
      linkedinPersonal: { ready: true } as const,
      publicVideo: { ready: true } as const,
      youtubeApi: { ready: true } as const,
      corte: { slug: SLUG, hhmm: "08:00", title: "Título", hook: "Gancho." },
      now: at(20 * MIN),
    };
    const stale = planShortsPublish({ ...base, corteTimerHeartbeat: { ranAt: null } });
    const w = stale.warnings.find((x) => /timer do corte \(Diaria-Shorts-Cortes\) sem execução recente/.test(x));
    assert.ok(w, stale.warnings.join("\n"));
    for (const d of TIMER_DESTS) assert.ok(w!.includes(d), d);
    const fresh = planShortsPublish({ ...base, corteTimerHeartbeat: { ranAt: at(10 * MIN).toISOString() } });
    assert.ok(!fresh.warnings.some((x) => /sem execução recente/.test(x)));
    assert.match(corteTimerStaleWarning(["instagram"], { ranAt: null }, at(0)), /nenhuma execução registrada/);
  });

  it("o timer grava o heartbeat no início e no fim de toda execução fora do dry-run (fonte)", () => {
    const src = readFileSync(new URL("../scripts/shorts-corte-timer.ts", import.meta.url), "utf8");
    assert.match(src, /beat\("start"\);\s*try \{\s*return await runCortes\(dirs, cortesDir, dryRun\);\s*\} finally \{\s*beat\("end"\);/);
    assert.match(src, /if \(dryRun\) return;\s*try \{\s*writeCorteTimerHeartbeat\(cortesDir/);
    const ps = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    assert.match(ps, /corte && !requireCorteAuth \? \{ corteTimerHeartbeat: readCorteTimerHeartbeat\(join\(ROOT, CORTES_REL_DIR\)\) \}/);
  });
});

describe("#12005 timer-lock: o release só apaga o lock do próprio dono", () => {
  const lockPath = () => join(mkdtempSync(join(tmpdir(), "timer-lock-12005-")), "_internal", CORTE_TIMER_LOCK_FILE.split("/").pop()!);
  const age = (path: string, ms: number) => {
    const t = (Date.now() - ms) / 1000;
    utimesSync(path, t, t);
  };

  it("cenário da issue: rodada manual > 90 min tem o lock tomado pelo timer; o release dela não apaga o lock do timer", () => {
    const path = lockPath();
    const manual = acquireTimerLock(path);
    assert.ok(manual);
    age(path, SHORTS_TIMER_LOCK_STALE_MS + MIN);
    const timer = acquireTimerLock(path);
    assert.ok(timer, "lock velho é retomado");
    const timerToken = timerLockToken(readFileSync(path, "utf8"));
    assert.ok(timerToken);
    manual!();
    assert.ok(existsSync(path), "o release da rodada manual não pode apagar o lock do timer");
    assert.equal(timerLockToken(readFileSync(path, "utf8")), timerToken);
    assert.equal(acquireTimerLock(path), null, "um terceiro processo não pega o lock enquanto o timer publica");
    timer!();
    assert.equal(existsSync(path), false);
  });

  it("lock de antes do #12005 (arquivo vazio, sem token): velho é retomado; release de quem perdeu o arquivo não apaga", () => {
    const path = lockPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
    assert.equal(acquireTimerLock(path), null, "lock legado recente segura");
    age(path, SHORTS_TIMER_LOCK_STALE_MS + MIN);
    const r = acquireTimerLock(path);
    assert.ok(r);
    writeFileSync(path, "");
    r!();
    assert.ok(existsSync(path));
  });

  it("heartbeat: a rodada longa renova o lock e ele não fica velho; o release para a renovação e solta", async () => {
    const path = lockPath();
    const release = acquireTimerLock(path, Date.now(), { heartbeatMs: 20 });
    assert.ok(release);
    age(path, SHORTS_TIMER_LOCK_STALE_MS + MIN);
    await new Promise((r) => setTimeout(r, 120));
    assert.ok(Date.now() - statSync(path).mtimeMs < SHORTS_TIMER_LOCK_STALE_MS, "mtime renovada");
    assert.equal(acquireTimerLock(path), null, "lock renovado não é tomado como velho");
    assert.ok(JSON.parse(readFileSync(path, "utf8")).beat_at);
    release!();
    assert.equal(existsSync(path), false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(existsSync(path), false, "a renovação parou com o release (não recria o arquivo)");
  });

  it("a rodada manual do corte toma o lock com heartbeat (fonte)", () => {
    const src = readFileSync(new URL("../scripts/publish-shorts.ts", import.meta.url), "utf8");
    assert.match(src, /acquireTimerLock\(join\(dir, CORTE_TIMER_LOCK_FILE\), Date\.now\(\), \{ heartbeatMs: TIMER_LOCK_HEARTBEAT_MS \}\)/);
  });
});
