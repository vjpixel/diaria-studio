/**
 * test/shorts-threads-profile-timer-11410.test.ts (#11410)
 *
 * O vertical no Threads PESSOAL sai pelo timer do 300 no horário do vertical
 * (a Threads API não agenda): config, delegação no plano do
 * `/diaria-publica-video`, escopo do `--threads-timer`, registro próprio do
 * timer, decisão "age agora?", leitura da saída do publish-shorts, conferência
 * do perfil antes de publicar, reaproveitamento do objeto no R2, alarme sem
 * repetir, execução de ponta a ponta com I/O falso e o par horário do teste ↔
 * tasks (registradas, não armadas). Sem rede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  THREADS_TIMER_ALARM_STATE_FILE,
  THREADS_TIMER_LOCK_FILE,
  buildThreadsTimerAlarm,
  decideThreadsTimerRun,
  interpretThreadsTimerOutput,
  interpretThreadsVerticalLookup,
  runThreadsTimer,
  threadsAlarm,
  threadsAlarmId,
  threadsAlarmSeverity,
  threadsAlarmSuppressed,
  threadsPublishArgs,
  verticalDownloadInProgress,
  type ThreadsTimerRunDeps,
} from "../scripts/shorts-threads-profile-timer.ts";
import { THREADS_TIMER_DETAIL, SHORTS_BOOLEAN_FLAGS, planShortsPublish, threadsEditionMarkers, type ShortsPlanInput } from "../scripts/publish-shorts.ts";
import { loadShortsConfig, shortVideoFileName, type ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import {
  SHORTS_THREADS_TIMER_LEDGER_FILE,
  listShortsRegistryFiles,
  persistShortEntry,
  readShortsRegistry,
  shortsRegistryWriterFor,
  threadsTimerScopeError,
} from "../scripts/lib/diaria/shorts-published-store.ts";
import {
  ThreadsTimerGateError,
  decideThreadsProfileDuplicate,
  listThreadsProfilePosts,
  threadsProfilePreflight,
  type ThreadsPersonalCreds,
  type ThreadsProfilePost,
} from "../scripts/lib/threads-personal-video.ts";
import { reuseOrUploadToR2, type R2UploadConfig } from "../scripts/lib/r2-object-upload.ts";
import { MAX_FIRE_LATENESS_MS } from "../scripts/lib/linkedin-personal.ts";
import { SCHEDULED_TASKS } from "../scripts/lib/scheduled-tasks.ts";
import platformConfig from "../platform.config.json" with { type: "json" };
import type { GhSpawnResult } from "../scripts/lib/shared/gh-run.ts";

const SCHEDULE = { rotation_times: ["06:30", "08:00", "12:00"], rotation_start: "2026-10-26", rotation_end: "2026-11-13", default_time: "12:00" };
const SHORTS = {
  facebook_pages: [],
  instagram: false,
  linkedin_profile: false,
  linkedin_page_repost: false,
  x: false,
  threads_profile: true,
  threads_profile_via_timer: true,
  facebook_profile: false,
  youtube_shorts_api: false,
  schedule: SCHEDULE,
};
const CFG = { publishing: { shorts: SHORTS } };
const CFG_OFF = { publishing: { shorts: { ...SHORTS, threads_profile_via_timer: false } } };
// 261027 (terça): 2º dia do teste → 08:00 BRT = 11:00Z.
const AAMMDD = "261027";
const AT = "2026-10-27T11:00:00.000Z";
const REVIEWED = "DESTAQUE 1 | X\n\n[Título do D1](https://a.com/x)\n\nCorpo do destaque com uma frase. Outra frase.\n";
const CREDS: ThreadsPersonalCreds = { accessToken: "tok", userId: "123", apiVersion: "v1.0" };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "shorts-threads-timer-"));
}
function reg(entries: ShortPublishedEntry[]): string {
  return JSON.stringify({ aammdd: AAMMDD, entries });
}
const entry = (destination: string, status: ShortPublishedEntry["status"] = "published"): ShortPublishedEntry => ({ destination, status, id: "1", scheduled_at: null, at: "2026-10-27T11:05:00Z" });
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("#11410 config publishing.shorts.threads_profile_via_timer", () => {
  it("default false no código e no platform.config.json (registrado, não armado)", () => {
    assert.equal(loadShortsConfig({}).threadsProfileViaTimer, false);
    assert.equal(loadShortsConfig(platformConfig).threadsProfileViaTimer, false);
    assert.equal(loadShortsConfig(CFG).threadsProfileViaTimer, true);
  });
  it("não-boolean lança", () => {
    assert.throws(() => loadShortsConfig({ publishing: { shorts: { ...SHORTS, threads_profile_via_timer: "sim" } } }), /threads_profile_via_timer/);
  });
});

describe("#11410 plano: o timer é o dono do threads_profile", () => {
  const base: Omit<ShortsPlanInput, "now"> = {
    aammdd: AAMMDD,
    reviewedMd: REVIEWED,
    config: CFG,
    pages: [],
    instagramReady: false,
    threadsPersonal: { ready: true },
    publicVideo: { ready: true },
    published: { aammdd: AAMMDD, entries: [] },
    video: { path: "v.mp4", exists: true, sizeBytes: 10 },
    editionUrl: "https://diar.ia.br/p/x",
  };
  const th = (p: ReturnType<typeof planShortsPublish>) => p.items.find((i) => i.destination === "threads_profile")!;
  const after = new Date("2026-10-27T11:10:00Z");

  it("rodada do /diaria-publica-video com o timer ligado: skip_delegated com o caminho do timer", () => {
    const item = th(planShortsPublish({ ...base, now: after }));
    assert.equal(item.action, "skip_delegated");
    assert.match((item as { detail: string }).detail, /Diaria-Shorts-Threads-Profile/);
    assert.match(THREADS_TIMER_DETAIL, /--only threads_profile --threads-timer --publish/);
  });
  it("rodada do timer (--threads-timer): publica depois do horário, pending antes", () => {
    assert.equal(th(planShortsPublish({ ...base, now: after, writer: "threads-timer" })).action, "publish");
    assert.equal(th(planShortsPublish({ ...base, now: new Date("2026-10-27T10:00:00Z"), writer: "threads-timer" })).action, "pending_schedule");
  });
  it("timer desligado no config: a rodada normal segue publicando como antes", () => {
    assert.equal(th(planShortsPublish({ ...base, config: CFG_OFF, now: after })).action, "publish");
  });
  it("a delegação não esconde a falta de credencial na rodada do timer", () => {
    const item = th(planShortsPublish({ ...base, now: after, writer: "threads-timer", threadsPersonal: { ready: false, reason: "sem token" } }));
    assert.equal(item.action, "skip_missing_credentials");
  });
  it("--threads-timer é flag booleana do CLI", () => {
    assert.ok((SHORTS_BOOLEAN_FLAGS as readonly string[]).includes("threads-timer"));
  });
});

describe("#11410 escopo do --threads-timer e registro próprio", () => {
  it("só --only threads_profile (ou --mark threads_profile), só com o config ligado, nunca com outro timer", () => {
    const ok = { threadsTimer: true, viaTimer: true as const, only: ["threads_profile"] };
    assert.equal(threadsTimerScopeError(ok), null);
    assert.equal(threadsTimerScopeError({ ...ok, threadsTimer: false, only: null }), null);
    assert.match(threadsTimerScopeError({ ...ok, only: ["threads_profile", "x"] })!, /exige --only threads_profile/);
    assert.match(threadsTimerScopeError({ ...ok, only: null })!, /sem --only/);
    assert.match(threadsTimerScopeError({ ...ok, viaTimer: false })!, /threads_profile_via_timer = true/);
    assert.match(threadsTimerScopeError({ ...ok, viaTimer: "unreadable" })!, /não carregou/);
    assert.match(threadsTimerScopeError({ ...ok, otherTimer: true })!, /outro timer/);
    assert.match(threadsTimerScopeError({ ...ok, confirmInstagram: true })!, /confirm-instagram/);
    assert.equal(threadsTimerScopeError({ ...ok, only: null, markDestination: "threads_profile" }), null);
    assert.match(threadsTimerScopeError({ ...ok, only: null, markDestination: "x" })!, /só aceita threads_profile/);
  });
  it("shortsRegistryWriterFor: threads-timer, e recusa junto de outro timer", () => {
    assert.equal(shortsRegistryWriterFor(false, false, true), "threads-timer");
    assert.throws(() => shortsRegistryWriterFor(true, false, true), /--threads-timer não combina/);
    assert.throws(() => shortsRegistryWriterFor(false, true, true), /--threads-timer não combina/);
    assert.equal(shortsRegistryWriterFor(false, false), "main");
  });
  it("grava só threads_profile no registro do timer, e a leitura unida o enxerga", () => {
    const dir = tmp();
    try {
      assert.throws(() => persistShortEntry(dir, AAMMDD, "threads-timer", entry("x")), /só aceita threads_profile/);
      persistShortEntry(dir, AAMMDD, "threads-timer", entry("threads_profile"));
      assert.ok(existsSync(join(dir, SHORTS_THREADS_TIMER_LEDGER_FILE)));
      assert.equal(readShortsRegistry(dir, AAMMDD).entries.find((e) => e.destination === "threads_profile")?.status, "published");
      persistShortEntry(dir, AAMMDD, "main", entry("facebook:diaria"));
      const files = listShortsRegistryFiles(dir).map((p) => p.split(/[\\/]/).pop());
      assert.deepEqual(files, ["06-shorts-published.json", "06-shorts-published.threads-timer.json"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11410 decideThreadsTimerRun", () => {
  const base = { config: CFG, reviewedExists: true, registryRaws: [] as { path: string; raw: string }[], aammdd: AAMMDD, videoSeen: true };
  const at = (iso: string) => decideThreadsTimerRun({ ...base, now: new Date(iso) });

  it("config desligado, destino desligado ou dia sem edição: nada a fazer", () => {
    assert.equal(decideThreadsTimerRun({ ...base, config: CFG_OFF, now: new Date(AT) }).kind, "skip");
    assert.equal(decideThreadsTimerRun({ ...base, config: { publishing: { shorts: { ...SHORTS, threads_profile: false } } }, now: new Date(AT) }).kind, "skip");
    assert.equal(decideThreadsTimerRun({ ...base, reviewedExists: false, now: new Date(AT) }).kind, "skip");
  });
  it("registrado em qualquer arquivo (inclusive send_unknown e cópia de conflito): nada a fazer", () => {
    for (const path of ["_internal/06-shorts-published.json", "_internal/06-shorts-published.threads-timer.json", "_internal/06-shorts-published-Neo.json"]) {
      const d = decideThreadsTimerRun({ ...base, registryRaws: [{ path, raw: reg([entry("threads_profile", "send_unknown")]) }], now: new Date(AT) });
      assert.equal(d.kind, "skip", path);
      assert.match((d as { reason: string }).reason, /já registrado/);
    }
  });
  it("registro ilegível lança (nunca vira 'nada publicado')", () => {
    assert.throws(() => decideThreadsTimerRun({ ...base, registryRaws: [{ path: "x.json", raw: "{" }], now: new Date(AT) }));
  });
  it("antes do horário espera; na janela publica; depois de 3 h alarma (só se o dia teve vertical)", () => {
    assert.equal(at("2026-10-27T10:59:00Z").kind, "wait");
    assert.equal(at(AT).kind, "publish");
    assert.equal(decideThreadsTimerRun({ ...base, now: new Date(Date.parse(AT) + MAX_FIRE_LATENESS_MS) }).kind, "publish");
    assert.equal(decideThreadsTimerRun({ ...base, now: new Date(Date.parse(AT) + MAX_FIRE_LATENESS_MS + 60_000) }).kind, "late");
    assert.equal(decideThreadsTimerRun({ ...base, videoSeen: false, now: new Date(Date.parse(AT) + MAX_FIRE_LATENESS_MS + 60_000) }).kind, "skip");
  });
});

describe("#11410 leituras puras do timer", () => {
  it("download em curso: .part recente ou lock do timer do LinkedIn", () => {
    const now = Date.parse(AT);
    assert.equal(verticalDownloadInProgress({ partMtimeMs: null, linkedinLockMtimeMs: null, nowMs: now }), null);
    assert.match(verticalDownloadInProgress({ partMtimeMs: now - 60_000, linkedinLockMtimeMs: null, nowMs: now })!, /\.part/);
    assert.equal(verticalDownloadInProgress({ partMtimeMs: now - 2 * 3_600_000, linkedinLockMtimeMs: null, nowMs: now }), null);
    assert.match(verticalDownloadInProgress({ partMtimeMs: null, linkedinLockMtimeMs: now - 60_000, nowMs: now })!, /LinkedIn/);
  });
  it("saída do fetch-drive-video", () => {
    assert.deepEqual(interpretThreadsVerticalLookup(0, JSON.stringify({ action: "print-id", file: { id: "abcdefghijk", name: "v.mp4" } })), { kind: "found", fileId: "abcdefghijk", name: "v.mp4" });
    assert.equal(interpretThreadsVerticalLookup(0, JSON.stringify({ action: "none", reason: "vazio" })).kind, "none");
    assert.equal(interpretThreadsVerticalLookup(0, JSON.stringify({ action: "needs-editor", selection: "multiple" })).kind, "needs-editor");
    assert.equal(interpretThreadsVerticalLookup(0, JSON.stringify({ action: "exists" })).kind, "exists");
    assert.equal(interpretThreadsVerticalLookup(1, "boom").kind, "error");
  });
  it("argumentos do publish: só o destino, --threads-timer e --now", () => {
    assert.deepEqual(threadsPublishArgs(AAMMDD, null), ["scripts/publish-shorts.ts", AAMMDD, "--only", "threads_profile", "--publish", "--threads-timer", "--now"]);
    assert.deepEqual(threadsPublishArgs(AAMMDD, "abcdefghijk").slice(-2), ["--from-drive", "abcdefghijk"]);
  });
  it("marcadores da edição: utm_campaign e o título sem reticências", () => {
    assert.deepEqual(threadsEditionMarkers(AAMMDD, "Título **longo** cortad…"), [`utm_campaign=${AAMMDD}`, "Título longo cortad"]);
  });
});

describe("#11410 interpretThreadsTimerOutput", () => {
  const out = (results: unknown[], items: unknown[] = []) => JSON.stringify({ items, results });
  it("publicado ou já no perfil: done", () => {
    assert.equal(interpretThreadsTimerOutput(0, out([{ destination: "threads_profile", ok: true, entry: { ...entry("threads_profile"), url: "https://threads.net/x" } }])).kind, "done");
    const already = interpretThreadsTimerOutput(0, out([{ destination: "threads_profile", ok: true, alreadyRegistered: true, entry: entry("threads_profile") }]));
    assert.equal(already.kind, "done");
    assert.match((already as { detail: string }).detail, /já estava/);
  });
  it("send_unknown: alarme acao, sem exit 1", () => {
    const o = interpretThreadsTimerOutput(0, out([{ destination: "threads_profile", ok: true, entry: entry("threads_profile", "send_unknown"), warnings: ["ambíguo"] }]));
    assert.deepEqual([o.kind, (o as { key: string }).key, (o as { failed: boolean }).failed], ["alarm", "send-unknown", false]);
    assert.equal(threadsAlarmSeverity("send-unknown"), "acao");
  });
  it("conferência do perfil: blocked → acao; read-failed → urgente", () => {
    const blocked = interpretThreadsTimerOutput(1, out([{ destination: "threads_profile", ok: false, cause: "preflight", preflight: "blocked", error: "vídeo do dia" }]));
    assert.equal((blocked as { key: string }).key, "preflight-blocked");
    assert.equal(threadsAlarmSeverity("preflight-blocked"), "acao");
    const read = interpretThreadsTimerOutput(1, out([{ destination: "threads_profile", ok: false, cause: "preflight", preflight: "read-failed", error: "HTTP 500" }]));
    assert.equal((read as { key: string }).key, "preflight-read-failed");
    assert.equal(threadsAlarmSeverity("preflight-read-failed"), "urgente");
  });
  it("no ar sem registro, falha e saída ilegível", () => {
    assert.equal((interpretThreadsTimerOutput(1, out([{ destination: "threads_profile", ok: false, entry: entry("threads_profile"), error: "disco" }])) as { key: string }).key, "published-unregistered");
    assert.equal((interpretThreadsTimerOutput(1, out([{ destination: "threads_profile", ok: false, error: "container ERROR" }])) as { key: string }).key, "publish-failed");
    assert.equal((interpretThreadsTimerOutput(1, "não é json", "stack") as { key: string }).key, "no-output");
  });
  it("itens do plano: late, sem R2, sem credencial, delegado", () => {
    const item = (i: object) => interpretThreadsTimerOutput(0, out([], [{ destination: "threads_profile", ...i }])) as { kind: string; key?: string };
    assert.equal(item({ action: "skip_late", detail: "passou" }).key, "late");
    assert.equal(item({ action: "skip_missing_credentials", detail: "R2", cause: "public_video" }).key, "public-video");
    assert.equal(item({ action: "skip_missing_credentials", detail: "token" }).key, "credentials");
    assert.equal(item({ action: "skip_delegated", detail: "?" }).key, "publish-failed");
    assert.equal(item({ action: "skip_done" }).kind, "done");
    assert.equal(item({ action: "pending_schedule" }).kind, "wait");
  });
});

describe("#11410 alarme: não repete, late não sai depois de 'pode estar no ar'", () => {
  it("dedup por id; e-mail pendente reenvia; late suprimido depois de send-unknown/preflight-blocked", () => {
    const state = (alarmed: string[], emailPending: string[] = []) => JSON.stringify({ aammdd: AAMMDD, alarmed, emailPending });
    assert.equal(threadsAlarmSuppressed(null, "late"), false);
    assert.equal(threadsAlarmSuppressed(state(["late"]), "late"), true);
    assert.equal(threadsAlarmSuppressed(state([], ["late"]), "late"), false);
    assert.equal(threadsAlarmSuppressed(state(["send-unknown"]), "late"), true);
    assert.equal(threadsAlarmSuppressed(state([], ["preflight-blocked"]), "late"), true);
    const id = threadsAlarmId("publish-failed", "container 42 ERROR");
    assert.equal(id, threadsAlarmId("publish-failed", "container 77 ERROR"), "dígitos normalizados");
    assert.notEqual(id, threadsAlarmId("publish-failed", "outra causa"));
  });
  it("corpo: 'pode estar no ar' nunca manda postar à mão sem conferir; late manda registrar", () => {
    const b = buildThreadsTimerAlarm({ aammdd: AAMMDD, key: "send-unknown", reason: "x", at: AT });
    assert.match(b.body, /NÃO reposte/);
    assert.match(b.body, /--mark threads_profile=URL/);
    const late = buildThreadsTimerAlarm({ aammdd: AAMMDD, key: "late", reason: "passou", at: AT });
    assert.match(late.body, /3 h/);
    assert.match(late.subject, /não saiu/);
  });
  it("entregue uma vez, não repete; issue que não abre não grava estado", async () => {
    const dir = tmp();
    try {
      const issues: { number: number; url: string; body: string; state: string }[] = [];
      const ghRun = (args: string[]): GhSpawnResult => {
        if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
        if (args[0] === "issue" && args[1] === "create") {
          const n = 900 + issues.length;
          issues.push({ number: n, url: `https://github.com/vjpixel/diaria-studio/issues/${n}`, body: args[args.indexOf("--body") + 1] ?? "", state: "OPEN" });
          return { status: 0, stdout: `${issues.at(-1)!.url}\n`, stderr: "" };
        }
        throw new Error(`gh inesperado: ${args.join(" ")}`);
      };
      const sent: string[] = [];
      const deps = { ghRun, sendPush: async (m: { subject: string }) => (sent.push(m.subject), { ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
      assert.equal(await threadsAlarm(dir, AAMMDD, "late", "passou", AT, deps), true);
      assert.equal(await threadsAlarm(dir, AAMMDD, "late", "passou de novo", AT, deps), true);
      assert.equal(issues.length, 1);
      assert.equal(sent.length, 1);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, THREADS_TIMER_ALARM_STATE_FILE), "utf8")).alarmed, ["late"]);

      const dir2 = tmp();
      try {
        const offline = { ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "gh offline" }), sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true };
        assert.equal(await threadsAlarm(dir2, AAMMDD, "crash", "boom", null, offline), false);
        assert.equal(existsSync(join(dir2, THREADS_TIMER_ALARM_STATE_FILE)), false);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#11410 conferência do perfil antes de publicar", () => {
  const SINCE = "2026-10-27T03:00:00.000Z"; // 00:00 BRT
  const post = (p: Partial<ThreadsProfilePost>): ThreadsProfilePost => ({ id: "9", mediaType: "VIDEO", text: "", timestamp: "2026-10-27T11:02:00+00:00", permalink: "https://www.threads.net/@vjpixel/post/A", ...p });
  const markers = threadsEditionMarkers(AAMMDD, "Título do D1");

  it("vídeo com o marcador da edição: found; texto e vídeo de ontem não contam", () => {
    assert.equal(decideThreadsProfileDuplicate([post({ text: `Título do D1\n\nEdição completa: https://diar.ia.br/p/x?utm_campaign=${AAMMDD}` })], { sinceIso: SINCE, markers }).kind, "found");
    assert.equal(decideThreadsProfileDuplicate([post({ text: "título do d1 em minúscula" })], { sinceIso: SINCE, markers }).kind, "found");
    assert.equal(decideThreadsProfileDuplicate([post({ mediaType: "TEXT_POST", text: `utm_campaign=${AAMMDD}` })], { sinceIso: SINCE, markers }).kind, "none");
    assert.equal(decideThreadsProfileDuplicate([post({ timestamp: "2026-10-26T20:00:00+00:00", text: "outro" })], { sinceIso: SINCE, markers }).kind, "none");
    assert.equal(decideThreadsProfileDuplicate([], { sinceIso: SINCE, markers }).kind, "none");
  });
  it("vídeo do dia sem marcador bloqueia (timestamp ilegível conta como do dia)", () => {
    assert.equal(decideThreadsProfileDuplicate([post({ text: "outro vídeo" })], { sinceIso: SINCE, markers }).kind, "blocked");
    assert.equal(decideThreadsProfileDuplicate([post({ text: "outro", timestamp: null })], { sinceIso: SINCE, markers }).kind, "blocked");
  });
  it("lista o perfil com since, segue paginação e normaliza +0000", async () => {
    const urls: string[] = [];
    const fetch = async (u: string) => {
      urls.push(u);
      if (urls.length === 1) return jsonRes({ data: [{ id: "1", media_type: "TEXT_POST", text: "a", timestamp: "2026-10-27T10:00:00+0000" }], paging: { next: "https://graph.threads.net/next" } });
      return jsonRes({ data: [{ id: "2", media_type: "VIDEO", text: "b", timestamp: "2026-10-27T11:00:00+0000", permalink: "https://t/2" }] });
    };
    const posts = await listThreadsProfilePosts({ creds: CREDS, sinceIso: SINCE, fetch });
    assert.equal(posts.length, 2);
    assert.match(urls[0], /\/v1\.0\/123\/threads\?/);
    assert.match(urls[0], new RegExp(`since=${Date.parse(SINCE) / 1000}`));
    assert.equal(posts[1].timestamp, "2026-10-27T11:00:00+00:00");
    assert.equal(Date.parse(posts[1].timestamp!), Date.parse("2026-10-27T11:00:00Z"));
  });
  it("leitura que falha lança (HTTP, corpo ilegível, error, sem data, paginação sem fim)", async () => {
    const cases: Array<() => Promise<Response>> = [
      async () => new Response("x", { status: 500 }),
      async () => new Response("não json", { status: 200 }),
      async () => jsonRes({ error: { code: 190 } }),
      async () => jsonRes({ nada: true }),
      async () => jsonRes({ data: [], paging: { next: "https://graph.threads.net/next" } }),
    ];
    for (const f of cases) await assert.rejects(listThreadsProfilePosts({ creds: CREDS, sinceIso: SINCE, fetch: f }));
  });
  it("preflight: already com a entrada; blocked e read-failed como ThreadsTimerGateError; vazio publica", async () => {
    const now = () => new Date(AT);
    const found = await threadsProfilePreflight({ creds: CREDS, sinceIso: SINCE, markers, now, fetch: async () => jsonRes({ data: [{ id: "7", media_type: "VIDEO", text: `x utm_campaign=${AAMMDD}`, timestamp: "2026-10-27T11:01:00+0000", permalink: "https://t/7" }] }) });
    assert.equal(found.kind, "already");
    assert.deepEqual((found as { entry: ShortPublishedEntry }).entry, { destination: "threads_profile", status: "published", id: "7", url: "https://t/7", scheduled_at: null, at: "2026-10-27T11:01:00+00:00" });
    assert.deepEqual(await threadsProfilePreflight({ creds: CREDS, sinceIso: SINCE, markers, now, fetch: async () => jsonRes({ data: [] }) }), { kind: "publish" });
    await assert.rejects(
      threadsProfilePreflight({ creds: CREDS, sinceIso: SINCE, markers, now, fetch: async () => jsonRes({ data: [{ id: "8", media_type: "VIDEO", text: "outro", timestamp: "2026-10-27T11:01:00+0000" }] }) }),
      (e: unknown) => e instanceof ThreadsTimerGateError && e.failure === "blocked",
    );
    await assert.rejects(
      threadsProfilePreflight({ creds: CREDS, sinceIso: SINCE, markers, now, fetch: async () => { throw new Error("rede"); } }),
      (e: unknown) => e instanceof ThreadsTimerGateError && e.failure === "read-failed",
    );
  });
});

describe("#11410 R2: reaproveita o objeto do dia", () => {
  const cfg: R2UploadConfig = { accountId: "acc", accessKeyId: "k", secretAccessKey: "s", bucket: "b", publicBase: "https://media.diar.ia.br" };
  const body = Buffer.from("0123456789");
  it("HEAD 200 com o mesmo tamanho: reaproveita, sem PUT", async () => {
    const calls: string[] = [];
    const fetch = async (_u: string, i?: RequestInit) => (calls.push(i?.method ?? "GET"), new Response(null, { status: 200, headers: { "content-length": "10" } }));
    const r = await reuseOrUploadToR2({ fetch, now: () => new Date(AT) }, cfg, "shorts/v.mp4", body, "video/mp4");
    assert.deepEqual(r, { url: "https://media.diar.ia.br/shorts/v.mp4", reused: true });
    assert.deepEqual(calls, ["HEAD"]);
  });
  it("404 ou tamanho diferente: sobe de novo", async () => {
    for (const first of [new Response(null, { status: 404 }), new Response(null, { status: 200, headers: { "content-length": "3" } })]) {
      const calls: string[] = [];
      let n = 0;
      const fetch = async (_u: string, i?: RequestInit) => {
        calls.push(i?.method ?? "GET");
        n++;
        if (n === 1) return first;
        if (i?.method === "PUT") return new Response(null, { status: 200 });
        if (i?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": "10" } });
        return new Response("<ListBucketResult></ListBucketResult>", { status: 200 });
      };
      const r = await reuseOrUploadToR2({ fetch, now: () => new Date(AT), warn: () => {} }, cfg, "shorts/v.mp4", body, "video/mp4");
      assert.equal(r.reused, false);
      assert.ok(calls.includes("PUT"));
    }
  });
});

describe("#11410 runThreadsTimer de ponta a ponta (I/O falso)", () => {
  function edition(): string {
    const dir = tmp();
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "02-reviewed.md"), REVIEWED);
    return dir;
  }
  function deps(over: Partial<ThreadsTimerRunDeps> & { now: Date }): ThreadsTimerRunDeps & { scripts: string[][]; lookups: number } {
    const scripts: string[][] = [];
    const d = {
      config: CFG,
      lookupVertical: () => {
        d.lookups++;
        return { kind: "found", fileId: "abcdefghijk", name: "v.mp4" } as const;
      },
      runScript: (args: string[]) => {
        scripts.push(args);
        return { status: 0, stdout: JSON.stringify({ items: [], results: [{ destination: "threads_profile", ok: true, entry: entry("threads_profile") }] }), stderr: "" };
      },
      notify: { ghRun: (): GhSpawnResult => ({ status: 1, stdout: "", stderr: "não deveria abrir issue" }), sendPush: async () => ({ ok: true }), emailPolicy: "urgent_only" as const, log: () => true },
      scripts,
      lookups: 0,
      ...over,
    };
    return d;
  }

  it("na janela, com o vertical no disco: publica sem Drive e solta o lock", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "v");
      const d = deps({ now: new Date("2026-10-27T11:05:00Z") });
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 0);
      assert.deepEqual(d.scripts, [threadsPublishArgs(AAMMDD, null)]);
      assert.equal(d.lookups, 0);
      assert.equal(existsSync(join(dir, THREADS_TIMER_LOCK_FILE)), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("sem o vertical no disco: baixa do Drive pelo --from-drive", async () => {
    const dir = edition();
    try {
      const d = deps({ now: new Date("2026-10-27T11:05:00Z") });
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 0);
      assert.deepEqual(d.scripts, [threadsPublishArgs(AAMMDD, "abcdefghijk")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("download em curso (.part recente): espera sem consultar o Drive nem publicar", async () => {
    const dir = edition();
    try {
      const part = join(dir, `${shortVideoFileName(AAMMDD)}.part`);
      writeFileSync(part, "meio");
      const d = deps({ now: new Date(Date.parse(AT) + 60_000) });
      utimesSync(part, d.now, d.now); // .part "de agora" na hora simulada

      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 0);
      assert.equal(d.lookups, 0);
      assert.deepEqual(d.scripts, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("já registrado: não publica; antes do horário: espera; config desligado: nada", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, SHORTS_THREADS_TIMER_LEDGER_FILE), reg([entry("threads_profile")]));
      const d = deps({ now: new Date("2026-10-27T11:05:00Z") });
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 0);
      assert.deepEqual(d.scripts, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const dir2 = edition();
    try {
      const early = deps({ now: new Date("2026-10-27T10:00:00Z") });
      assert.equal(await runThreadsTimer(AAMMDD, dir2, false, early), 0);
      const off = deps({ now: new Date("2026-10-27T11:05:00Z"), config: CFG_OFF });
      assert.equal(await runThreadsTimer(AAMMDD, dir2, false, off), 0);
      assert.deepEqual([...early.scripts, ...off.scripts], []);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
  it("falha do publish: alarma (urgente) e sai 1; a 2ª execução com a mesma causa não repete o alarme", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "v");
      const issues: { number: number; url: string; body: string; state: string }[] = [];
      const ghRun = (args: string[]): GhSpawnResult => {
        if (args[0] === "issue" && args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
        if (args[0] === "issue" && args[1] === "create") {
          issues.push({ number: 1, url: "https://github.com/vjpixel/diaria-studio/issues/1", body: args[args.indexOf("--body") + 1] ?? "", state: "OPEN" });
          return { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/1\n", stderr: "" };
        }
        throw new Error(`gh inesperado: ${args.join(" ")}`);
      };
      const sent: string[] = [];
      const d = deps({
        now: new Date("2026-10-27T11:05:00Z"),
        runScript: () => ({ status: 1, stdout: JSON.stringify({ items: [], results: [{ destination: "threads_profile", ok: false, error: "container 1 ERROR" }] }), stderr: "" }),
        notify: { ghRun, sendPush: async (m: { subject: string }) => (sent.push(m.subject), { ok: true }), emailPolicy: "urgent_only" as const, log: () => true },
      });
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 1);
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 1);
      assert.equal(sent.length, 1, "mesma causa, um e-mail só");
      assert.match(sent[0], /não saiu pelo timer/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("depois de 3 h com vertical: alarma late uma vez; sem vertical no dia: nada", async () => {
    const dir = edition();
    try {
      writeFileSync(join(dir, shortVideoFileName(AAMMDD)), "v");
      const sent: string[] = [];
      const issues: unknown[] = [];
      const ghRun = (args: string[]): GhSpawnResult => {
        if (args[1] === "list") return { status: 0, stdout: JSON.stringify(issues), stderr: "" };
        issues.push({ number: 2, url: "https://github.com/vjpixel/diaria-studio/issues/2", body: args[args.indexOf("--body") + 1] ?? "", state: "OPEN" });
        return { status: 0, stdout: "https://github.com/vjpixel/diaria-studio/issues/2\n", stderr: "" };
      };
      const late = new Date(Date.parse(AT) + MAX_FIRE_LATENESS_MS + 60_000);
      const d = deps({ now: late, notify: { ghRun, sendPush: async (m: { subject: string }) => (sent.push(m.subject), { ok: true }), emailPolicy: "urgent_only" as const, log: () => true } });
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 0);
      assert.equal(await runThreadsTimer(AAMMDD, dir, false, d), 0);
      assert.equal(sent.length, 1);
      assert.deepEqual(d.scripts, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const dir2 = edition();
    try {
      const d = deps({ now: new Date(Date.parse(AT) + MAX_FIRE_LATENESS_MS + 60_000) });
      assert.equal(await runThreadsTimer(AAMMDD, dir2, false, d), 0);
      assert.equal(existsSync(join(dir2, THREADS_TIMER_ALARM_STATE_FILE)), false);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("#11410 tasks do 300: registradas, não armadas, cobrindo os horários do vertical", () => {
  const daily = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-Threads-Profile");
  const hourly = SCHEDULED_TASKS.find((t) => t.name === "Diaria-Shorts-Threads-Profile-Catchup");
  it("as duas existem com enabled:false (armar é do editor), rodando o script do timer, com guard da junction data/", () => {
    for (const t of [daily, hourly]) {
      assert.ok(t);
      assert.equal(t!.enabled, false);
      assert.deepEqual(t!.steps.map((s) => s.script), ["scripts/shorts-threads-profile-timer.ts"]);
      assert.equal(t!.guard?.requiredFile, "editions");
    }
    assert.deepEqual(hourly!.schedule, { kind: "interval", hours: 1 });
  });
  it("todo horário do teste fora da hora cheia cai na diária em até 3 min (o resto, na de hora em hora)", () => {
    const times: string[] = (platformConfig as any).publishing.shorts.schedule.rotation_times;
    const d = daily!.schedule as { kind: "daily"; hour: number; minute: number };
    for (const t of times) {
      const [h, m] = t.split(":").map(Number);
      if (m === 0) continue;
      const delta = d.hour * 60 + d.minute - (h * 60 + m);
      assert.ok(delta >= 0 && delta <= 3, `${t} BRT sem execução logo depois (diária às ${d.hour}:${d.minute})`);
    }
  });
  it("o registro em prosa documenta o comando de arme", () => {
    const doc = readFileSync(new URL("../docs/scheduled-tasks-registry.md", import.meta.url), "utf8");
    assert.match(doc, /arm-systemd-timers\.ts --task Diaria-Shorts-Threads-Profile/);
  });
});
