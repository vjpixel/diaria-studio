/**
 * test/shorts-corte-timer-update-11795.test.ts (#11795, resíduo da PR #11825)
 *
 * Dois buracos que ficaram do agendamento manual do corte de 01/11/2026:
 *   1. os destinos que a API não agenda (LinkedIn e Threads pessoais, Instagram)
 *      dependiam de um `systemd-run` feito à mão, que não avisava em falha:
 *      agora o timer `Diaria-Shorts-Cortes` (`scripts/shorts-corte-timer.ts`)
 *      é o dono deles e alarma o editor por destino;
 *   2. trocar capa e texto de um post já agendado (YouTube, Facebook) exigiu
 *      scripts descartáveis: agora é `--update-scheduled`.
 * Sem rede: o publish-shorts e o alarme são injetados.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CORTE_TIMER_HORIZON_MS,
  buildCorteTimerAlarm,
  cortePublishArgs,
  decideCorteTimerRun,
  interpretCorteTimerOutput,
  listCorteDirs,
  runCorteTimerFor,
  type CorteTimerAlarmKey,
} from "../scripts/shorts-corte-timer.ts";
import { CORTE_SPEC_FILE, CORTE_TIMER_TASK, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { assignShortsDestinationOwners, executeScheduledUpdates, planShortsPublish } from "../scripts/publish-shorts.ts";
import { planScheduledUpdates } from "../scripts/lib/diaria/short-scheduled-update.ts";
import { updateScheduledVideo } from "../scripts/lib/diaria/youtube-upload.ts";
import { SCHEDULED_TASKS, getScheduledTaskByName } from "../scripts/lib/scheduled-tasks.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

// #11912: com o "pode publicar" gravado (o timer não age sem ele; o caso sem autorização está em
// shorts-corte-timer-authorization-11912), com a impressão digital do vídeo "mp4" que corteDir grava, sem capa.
const SPEC: CorteSpec = {
  slug: "tratar-ia-como-humano", date: "261102", hhmm: "08:00", title: "Tratar IA como humano", hook: "Por que dar nome ao chatbot muda o jeito que você usa.", video: "corte-tratar-ia-como-humano.mp4",
  publish_confirmed_at: "2026-11-01T20:00:00.000Z",
  publish_confirmed_destinations: ["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", "threads_profile"],
  publish_confirmed_content: { video_sha256: createHash("sha256").update("mp4").digest("hex"), cover_sha256: null },
};
const AT = "2026-11-02T11:00:00.000Z"; // 08:00 BRT
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
const reg = (entries: Partial<ShortPublishedEntry>[]) => [{ path: "/c/_internal/06-shorts-published.json", raw: JSON.stringify({ aammdd: SPEC.date, entries }) }];
const at = (ms: number) => new Date(Date.parse(AT) + ms);

describe("#11795 decideCorteTimerRun", () => {
  it("config desligado não faz nada (a skill segue com a task one-shot)", () => {
    const d = decideCorteTimerRun({ config: { publishing: { shorts: { ...shorts, corte_via_timer: false } } }, spec: SPEC, registryRaws: [], now: at(60_000) });
    assert.equal(d.kind, "skip");
  });

  it("antes do --at espera; até 3 h publica só os pendentes; depois alarma late; depois de 48 h ignora", () => {
    assert.equal(decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], now: at(-60_000) }).kind, "wait");
    const d = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: reg([{ destination: "instagram", status: "send_unknown", id: "m1", at: AT }]), now: at(30 * 60_000) });
    assert.equal(d.kind, "publish");
    if (d.kind === "publish") assert.deepEqual(d.pending, ["linkedin_profile", "threads_profile"], "send_unknown conta como feito (nunca re-posta)");
    const late = decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], now: at(4 * 3_600_000) });
    assert.equal(late.kind, "late");
    assert.equal(decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [], now: at(CORTE_TIMER_HORIZON_MS + 60_000) }).kind, "skip");
  });

  it("tudo registrado: nada a fazer; registro ilegível lança (nunca vira 'nada publicado')", () => {
    const all = reg(["linkedin_profile", "threads_profile", "instagram"].map((destination) => ({ destination, status: "published", id: destination, at: AT })));
    assert.equal(decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: all, now: at(60_000) }).kind, "skip");
    assert.throws(() => decideCorteTimerRun({ config: CONFIG, spec: SPEC, registryRaws: [{ path: "/x.json", raw: "{" }], now: at(60_000) }));
  });

  it("args: --corte, --only com os pendentes, --publish --now e a confirmação com a data do corte (#11741), e o filho só confere o 'pode publicar' (#11912)", () => {
    assert.deepEqual(cortePublishArgs(SPEC, ["linkedin_profile", "instagram"]), [
      "scripts/publish-shorts.ts", "--corte", SPEC.slug, "--only", "linkedin_profile,instagram", "--publish", "--now", "--confirm-publish", "261102", "--require-corte-authorization",
    ]);
  });
});

describe("#11795 interpretCorteTimerOutput: cada falha vira alarme por destino", () => {
  const pending = ["linkedin_profile", "threads_profile", "instagram"];
  it("publicado, ambíguo, falha e credencial", () => {
    const stdout = JSON.stringify({
      results: [
        { destination: "linkedin_profile", ok: true, entry: { status: "published", id: "urn:1", url: "https://li/1" } },
        { destination: "threads_profile", ok: true, entry: { status: "send_unknown", id: "t1" } },
        { destination: "instagram", ok: false, error: "media_publish 500" },
      ],
      items: [],
    });
    const out = interpretCorteTimerOutput(1, stdout, pending);
    assert.equal(out[0].kind, "done");
    assert.deepEqual([out[1].kind, (out[1] as any).key], ["alarm", "send-unknown"]);
    assert.deepEqual([out[2].kind, (out[2] as any).key], ["alarm", "publish-failed"]);
  });

  it("pulo por credencial/R2 e saída sem JSON", () => {
    const stdout = JSON.stringify({ results: [], items: [{ destination: "linkedin_profile", action: "skip_missing_credentials", detail: "sem token" }, { destination: "threads_profile", action: "skip_missing_credentials", detail: "sem R2", cause: "public_video" }, { destination: "instagram", action: "skip_done" }] });
    const out = interpretCorteTimerOutput(0, stdout, pending);
    assert.deepEqual(out.map((o) => (o.kind === "alarm" ? o.key : o.kind)), ["credentials", "public-video", "done"]);
    const none = interpretCorteTimerOutput(1, "boom", ["instagram"], "stack");
    assert.equal((none[0] as any).key, "no-output");
  });

  it("o alarme cita o corte, o destino e os comandos do corte; o ambíguo nunca manda postar sem conferir", () => {
    const a = buildCorteTimerAlarm({ spec: SPEC, destination: "instagram", key: "publish-failed", reason: "x" });
    assert.match(a.subject, /tratar-ia-como-humano.*instagram/);
    assert.match(a.body, /--corte tratar-ia-como-humano --only instagram --publish --now --confirm-publish 261102/);
    const b = buildCorteTimerAlarm({ spec: SPEC, destination: "threads_profile", key: "send-unknown", reason: "x" });
    assert.match(b.body, /NÃO poste de novo sem conferir/);
  });
});

describe("#11795 runCorteTimerFor (I/O injetado)", () => {
  function corteDir(withVideo: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "corte-timer-"));
    const dir = join(root, SPEC.slug);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, CORTE_SPEC_FILE), JSON.stringify(SPEC));
    if (withVideo) writeFileSync(join(dir, SPEC.video), "mp4");
    return dir;
  }
  const alarms: Array<{ destination: string; key: CorteTimerAlarmKey }> = [];
  const deps = (stdout: string, calls: string[][]) => ({
    config: CONFIG,
    now: at(10 * 60_000),
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

  it("publica os pendentes e alarma o que falhou (exit 1)", async () => {
    alarms.length = 0;
    const calls: string[][] = [];
    const stdout = JSON.stringify({
      results: [
        { destination: "linkedin_profile", ok: true, entry: { status: "published", id: "u" } },
        { destination: "threads_profile", ok: true, entry: { status: "published", id: "t" } },
        { destination: "instagram", ok: false, error: "falhou" },
      ],
    });
    const code = await runCorteTimerFor(corteDir(true), false, deps(stdout, calls));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][calls[0].indexOf("--only") + 1], "linkedin_profile,threads_profile,instagram");
    assert.deepEqual(alarms, [{ destination: "instagram", key: "publish-failed" }]);
    assert.equal(code, 1);
  });

  it("vídeo ausente na máquina: não chama o publish e alarma cada destino", async () => {
    alarms.length = 0;
    const calls: string[][] = [];
    const code = await runCorteTimerFor(corteDir(false), false, deps("{}", calls));
    assert.equal(calls.length, 0);
    assert.deepEqual(alarms.map((a) => a.key), ["missing-video", "missing-video", "missing-video"]);
    assert.equal(code, 0);
  });

  it("dry-run não publica nem alarma; listCorteDirs só pega pasta com corte.json", async () => {
    alarms.length = 0;
    const calls: string[][] = [];
    const dir = corteDir(true);
    assert.equal(await runCorteTimerFor(dir, true, deps("{}", calls)), 0);
    assert.equal(calls.length + alarms.length, 0);
    const root = join(dir, "..");
    mkdirSync(join(root, "sem-spec"));
    assert.deepEqual(listCorteDirs(root), [dir]);
    assert.deepEqual(listCorteDirs(join(root, "nao-existe")), []);
  });
});

describe("#11795 dono dos destinos do corte e registro da task", () => {
  const page = (slug: string): ResolvedFacebookPage => ({ slug, enabled: true, pageId: `id-${slug}`, token: "tok", missing: [], utmContent: null });
  it("com corte_via_timer, o plano do corte dá os três destinos ao timer-300 (Diaria-Shorts-Cortes)", () => {
    const p = planShortsPublish({
      aammdd: SPEC.date,
      reviewedMd: "",
      config: CONFIG,
      pages: [page("diaria")],
      instagramReady: true,
      published: { aammdd: SPEC.date, entries: [] },
      video: { path: "/v.mp4", exists: true, sizeBytes: 1 },
      videoDurationSeconds: 50,
      threadsPersonal: { ready: true },
      linkedinPersonal: { ready: true },
      publicVideo: { ready: true },
      youtubeApi: { ready: true },
      corte: { slug: SPEC.slug, hhmm: SPEC.hhmm, title: SPEC.title, hook: SPEC.hook },
      now: new Date("2026-11-02T03:00:00Z"),
    });
    for (const d of ["linkedin_profile", "threads_profile", "instagram"]) {
      const o = p.owners.find((x) => x.destination === d)!;
      assert.equal(o.by, "timer-300", d);
      assert.equal(o.task, CORTE_TIMER_TASK);
      assert.match((p.items.find((i) => i.destination === d) as any).detail, /Diaria-Shorts-Cortes/);
    }
  });

  it("sem o corte, o mesmo pending_schedule segue com a task one-shot (regressão da edição)", () => {
    const [o] = assignShortsDestinationOwners([{ destination: "linkedin_profile", mode: "api", action: "pending_schedule", caption: "t", scheduledAt: AT, detail: "" }], { aammdd: "261102", now: at(-3_600_000), instagramViaTimer: false });
    assert.equal(o.by, "agent-scheduled-task");
  });

  it("a task está registrada, de hora em hora, rodando o timer do corte", () => {
    const t = SCHEDULED_TASKS.find((x) => x.name === CORTE_TIMER_TASK)!;
    assert.ok(t);
    assert.deepEqual(t.schedule, { kind: "interval", hours: 1 });
    assert.equal(t.steps[0].script, "scripts/shorts-corte-timer.ts");
    assert.notEqual(t.enabled, false);
  });
});

describe("#11795 --update-scheduled", () => {
  const D1 = { title: "Tratar IA como humano (novo)", body: "Gancho novo. Resto." };
  const NOW = new Date("2026-11-02T03:00:00Z");
  const entries: ShortPublishedEntry[] = [
    { destination: "youtube_shorts", status: "scheduled", id: "yt1", scheduled_at: AT, at: "t" },
    { destination: "facebook:diaria", status: "scheduled", id: "fb1", scheduled_at: AT, at: "t" },
    { destination: "facebook:vjpixel", status: "published", id: "fb2", scheduled_at: null, at: "t" },
    { destination: "x", status: "scheduled", id: "buffer:bx", scheduled_at: AT, at: "t" },
    { destination: "linkedin_profile", status: "send_unknown", id: "li", at: "t" },
  ];

  it("plano: troca só o que segue agendado; publicado e ambíguo ficam de fora com o motivo", () => {
    const items = planScheduledUpdates({ entries, d1: D1, now: NOW, coverPresent: true });
    const by = Object.fromEntries(items.map((i) => [i.destination, i]));
    assert.equal(by["youtube_shorts"].action, "update_youtube");
    assert.equal((by["youtube_shorts"] as any).title, "Tratar IA como humano (novo) #Shorts");
    assert.match((by["youtube_shorts"] as any).description, /^Gancho novo\./);
    assert.equal(by["facebook:diaria"].action, "update_facebook");
    assert.equal((by["facebook:diaria"] as any).slug, "diaria");
    assert.equal(by["facebook:vjpixel"].action, "skip");
    assert.equal(by["x"].action, "buffer_edit");
    assert.equal(by["linkedin_profile"].action, "skip");
    // Depois do horário, nada mais é "agendado".
    assert.ok(planScheduledUpdates({ entries, d1: D1, now: at(60_000), coverPresent: true }).every((i) => i.action === "skip"));
  });

  it("aplica YouTube e Facebook com a capa, grava updated_at; falha de um não para o outro", async () => {
    const items = planScheduledUpdates({ entries, d1: D1, now: NOW, coverPresent: true, only: ["youtube_shorts", "facebook:diaria", "x"] });
    const persisted: ShortPublishedEntry[] = [];
    const yt: unknown[] = [];
    const results = await executeScheduledUpdates(items, entries, Buffer.from("jpg"), {
      youtube: async (id, u) => {
        yt.push({ id, title: u.title, thumb: u.thumbnail !== null });
        return { thumbnail: { attempted: true, ok: true, error: null } };
      },
      facebook: async () => {
        throw new Error("o vídeo fb1 já está publicado na página");
      },
      persist: (e) => persisted.push(e),
      now: () => NOW,
    });
    assert.deepEqual(yt, [{ id: "yt1", title: "Tratar IA como humano (novo) #Shorts", thumb: true }]);
    const r = Object.fromEntries(results.map((x) => [x.destination, x]));
    assert.equal(r["youtube_shorts"].ok, true);
    assert.equal(r["facebook:diaria"].ok, false);
    assert.match(r["facebook:diaria"].error!, /já está publicado/);
    assert.equal(r["x"].buffer!.bufferId, "bx");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].destination, "youtube_shorts");
    assert.equal(persisted[0].updated_at, NOW.toISOString());
    assert.deepEqual(persisted[0].cover, { method: "thumbnails_set", ok: true });
  });
});

describe("review do PR #11894", () => {
  const entries: ShortPublishedEntry[] = [{ destination: "youtube_shorts", status: "scheduled", id: "yt1", scheduled_at: AT, at: "t" }];
  const D1 = { title: "T", body: "G. R." };
  const NOW = new Date("2026-11-02T03:00:00Z");

  it("--update-scheduled --only com destino desconhecido lança, em vez de plano vazio", () => {
    const known = new Set(["youtube_shorts", "facebook:diaria"]);
    assert.throws(() => planScheduledUpdates({ entries, d1: D1, now: NOW, coverPresent: false, only: ["youtube_short"], known }), /--only com destino desconhecido: youtube_short/);
    // Destino registrado vale mesmo fora do config atual; conhecido sem registro dá plano vazio sem erro.
    assert.equal(planScheduledUpdates({ entries, d1: D1, now: NOW, coverPresent: false, only: ["youtube_shorts"], known: new Set() }).length, 1);
    assert.deepEqual(planScheduledUpdates({ entries, d1: D1, now: NOW, coverPresent: false, only: ["facebook:diaria"], known }), []);
  });

  it("videos.update manda só os campos graváveis do snippet", async () => {
    const puts: unknown[] = [];
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return json({ access_token: "tok" });
      if (url.includes("/channels")) return json({ items: [{ id: "CH" }] });
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return json({});
      }
      return json({
        items: [
          {
            id: "yt1",
            snippet: { title: "velho", description: "d", categoryId: "22", tags: ["a"], defaultLanguage: "pt-BR", publishedAt: "x", channelId: "CH", channelTitle: "c", thumbnails: {}, localized: {} },
            status: { privacyStatus: "private", publishAt: AT },
          },
        ],
      });
    };
    await updateScheduledVideo({ fetch, now: () => NOW }, { clientId: "i", clientSecret: "s", refreshToken: "r", channelId: "CH" }, "yt1", { title: "novo", description: "nova", thumbnail: null });
    assert.equal(puts.length, 1);
    assert.deepEqual(puts[0], { id: "yt1", snippet: { title: "novo", description: "nova", categoryId: "22", tags: ["a"], defaultLanguage: "pt-BR" } });
  });

  it("corte_via_timer ligado só com a task do timer declarada e ativa (armada no 300 em 02/11/2026)", () => {
    // Antes da ativação este teste exigia `false` ("armar a task antes de ligar").
    // A task foi armada e conferida com --dry-run em 02/11/2026 (#11795) e o timer
    // passou a exigir o "pode publicar" (#11912). Flag `true` com a task fora do
    // registro, ou desativada, deixaria o corte sem dono.
    const real = JSON.parse(readFileSync(new URL("../platform.config.json", import.meta.url), "utf8"));
    if (real.publishing.shorts.corte_via_timer === true) {
      const task = getScheduledTaskByName(CORTE_TIMER_TASK);
      assert.ok(task, `${CORTE_TIMER_TASK} precisa estar declarada em SCHEDULED_TASKS`);
      assert.notEqual(task.enabled, false, `${CORTE_TIMER_TASK} não pode estar desativada com a flag ligada`);
    } else {
      assert.equal(real.publishing.shorts.corte_via_timer, false);
    }
  });
});
