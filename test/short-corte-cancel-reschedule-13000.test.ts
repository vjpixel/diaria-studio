/**
 * #13000: `publish-shorts.ts --corte SLUG --cancel` / `--reschedule --date
 * AAMMDD --at HH:MM`. Em 13/11/2026 o editor pediu os dois e tudo saiu à mão
 * (Buffer, YouTube `videos.update`, Graph `DELETE`/`scheduled_publish_time`,
 * edição de corte.json e do registro); o ajuste manual esqueceu o `aammdd` do
 * registro e o timer do corte quebrou de hora em hora. Tudo aqui roda com
 * fetch falso: nenhuma chamada de rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  CORTE_LIFECYCLE_MIN_LEAD_MS,
  executeCorteLifecycle,
  planCorteLifecycle,
  type CorteLifecycleDeps,
} from "../scripts/lib/diaria/short-corte-lifecycle.ts";
import { parseCorteSpec, withCorteCancellation, withCortePublishAuthorization, type CorteSpec } from "../scripts/lib/diaria/short-corte.ts";
import { planScheduledUpdates } from "../scripts/lib/diaria/short-scheduled-update.ts";
import { rescheduleScheduledVideo } from "../scripts/lib/diaria/youtube-upload.ts";
import {
  cancelFacebookScheduledVideo,
  corteLifecycleArgsError,
  facebookScheduledMs,
  parseShortsCliArgs,
  rescheduleFacebookScheduledVideo,
  type GraphDeps,
} from "../scripts/publish-shorts.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const SHA = createHash("sha256").update("mp4").digest("hex");
const SPEC: CorteSpec = {
  slug: "automacao-261111",
  date: "261114",
  hhmm: "18:00",
  title: "Automação",
  hook: "Um gancho.",
  video: "corte-automacao-261111.mp4",
  publish_confirmed_at: "2026-11-12T20:00:00.000Z",
  publish_confirmed_destinations: ["youtube_shorts", "facebook:diaria", "instagram", "linkedin_profile", "threads_profile", "x"],
  publish_confirmed_content: { video_sha256: SHA, cover_sha256: null },
};
const AT = "2026-11-14T21:00:00.000Z"; // 18:00 BRT de 261114
const NOW = new Date("2026-11-13T15:00:00.000Z");
const ENTRIES: ShortPublishedEntry[] = [
  { destination: "youtube_shorts", status: "scheduled", id: "yt1", scheduled_at: AT, at: "t" },
  { destination: "facebook:diaria", status: "scheduled", id: "fb1", scheduled_at: AT, at: "t" },
  { destination: "x", status: "scheduled", id: "buffer:bx1", scheduled_at: AT, at: "t" },
  { destination: "threads_profile", status: "published", id: "th1", url: "https://threads/x", at: "t" },
];

describe("#13000 planCorteLifecycle", () => {
  it("cancelar: API para YouTube/Facebook, Buffer para a skill, já publicado recusado, timer pendente segue o corte.json", () => {
    const plan = planCorteLifecycle({ op: { kind: "cancel" }, spec: SPEC, entries: ENTRIES, openMarks: [], now: NOW });
    assert.deepEqual(plan.blockers, []);
    const by = Object.fromEntries(plan.items.map((i) => [i.destination, i.action]));
    assert.deepEqual(by, {
      youtube_shorts: "youtube",
      "facebook:diaria": "facebook",
      x: "buffer",
      threads_profile: "refuse",
      instagram: "corte_timer",
      linkedin_profile: "corte_timer",
    });
  });

  it("nunca toca post a menos da folga mínima do horário (pode estar indo ao ar)", () => {
    const near = new Date(Date.parse(AT) - CORTE_LIFECYCLE_MIN_LEAD_MS + 60_000);
    const plan = planCorteLifecycle({ op: { kind: "cancel" }, spec: SPEC, entries: ENTRIES, openMarks: [], now: near });
    assert.ok(plan.items.filter((i) => i.destination !== "instagram" && i.destination !== "linkedin_profile").every((i) => i.action === "refuse"));
    // Timer pendente com o horário do corte perto: bloqueia tudo.
    assert.match(plan.blockers.join(" "), /timer do 300 pode estar publicando/);
  });

  it("envio em curso bloqueia a operação inteira", () => {
    const plan = planCorteLifecycle({ op: { kind: "cancel" }, spec: SPEC, entries: ENTRIES, openMarks: [{ destination: "instagram", started_at: NOW.toISOString() }], now: NOW });
    assert.match(plan.blockers.join(" "), /envio em curso de instagram/);
  });

  it("corte já cancelado: cancelar de novo e reagendar são bloqueados", () => {
    const cancelled = withCorteCancellation(SPEC, NOW.toISOString(), ["instagram"]);
    assert.match(planCorteLifecycle({ op: { kind: "cancel" }, spec: cancelled, entries: [], openMarks: [], now: NOW }).blockers.join(" "), /já foi cancelado/);
    assert.match(planCorteLifecycle({ op: { kind: "reschedule", date: "261115", hhmm: "12:00" }, spec: cancelled, entries: [], openMarks: [], now: NOW }).blockers.join(" "), /--publish --confirm-publish/);
  });

  it("reagendar: horário novo no passado ou malformado bloqueia; já no horário novo vira noop", () => {
    assert.match(planCorteLifecycle({ op: { kind: "reschedule", date: "261113", hhmm: "12:05" }, spec: SPEC, entries: ENTRIES, openMarks: [], now: NOW }).blockers.join(" "), /no futuro/);
    assert.match(planCorteLifecycle({ op: { kind: "reschedule", date: "26111", hhmm: "25:00" }, spec: SPEC, entries: ENTRIES, openMarks: [], now: NOW }).blockers.join(" "), /AAMMDD/);
    const plan = planCorteLifecycle({ op: { kind: "reschedule", date: "261114", hhmm: "18:00" }, spec: { ...SPEC, date: "261115", hhmm: "09:00" }, entries: ENTRIES, openMarks: [], now: NOW });
    assert.equal(plan.newAt, AT);
    assert.equal(plan.items.find((i) => i.destination === "youtube_shorts")?.action, "noop");
  });

  it("tudo já publicado: nada a cancelar", () => {
    const entries: ShortPublishedEntry[] = [{ destination: "youtube_shorts", status: "published", id: "yt1", at: "t" }];
    const plan = planCorteLifecycle({ op: { kind: "cancel" }, spec: { ...SPEC, publish_confirmed_destinations: ["youtube_shorts"] }, entries, openMarks: [], now: NOW });
    assert.match(plan.blockers.join(" "), /nada a cancelar/);
  });
});

describe("#13000 executeCorteLifecycle", () => {
  const fakeDeps = () => {
    const calls: string[] = [];
    const persisted: ShortPublishedEntry[] = [];
    const deps: CorteLifecycleDeps = {
      youtube: async (id, at) => void calls.push(`yt ${id} ${at}`),
      facebookCancel: async (slug, id) => void calls.push(`fb-del ${slug} ${id}`),
      facebookReschedule: async (slug, id, at) => void calls.push(`fb-move ${slug} ${id} ${at}`),
      persist: (e) => void persisted.push(e),
      now: () => NOW,
    };
    return { calls, persisted, deps };
  };

  it("cancelar grava cancelled_at só no que foi aplicado e devolve o delete_post da Buffer", async () => {
    const { calls, persisted, deps } = fakeDeps();
    const plan = planCorteLifecycle({ op: { kind: "cancel" }, spec: SPEC, entries: ENTRIES, openMarks: [], now: NOW });
    const results = await executeCorteLifecycle(plan, ENTRIES, deps);
    assert.deepEqual(calls, ["yt yt1 null", "fb-del diaria fb1"]);
    assert.deepEqual(persisted.map((e) => [e.destination, e.cancelled_at]), [["youtube_shorts", NOW.toISOString()], ["facebook:diaria", NOW.toISOString()]]);
    assert.equal(results.find((r) => r.destination === "x")?.buffer?.tool, "delete_post");
    assert.equal(results.find((r) => r.destination === "threads_profile")?.outcome, "refused");
  });

  it("reagendar move YouTube e Facebook e grava o scheduled_at novo; falha de um não para o outro", async () => {
    const { calls, persisted, deps } = fakeDeps();
    deps.youtube = async () => {
      throw new Error("token sem escopo");
    };
    const plan = planCorteLifecycle({ op: { kind: "reschedule", date: "261115", hhmm: "12:00" }, spec: SPEC, entries: ENTRIES, openMarks: [], now: NOW });
    const results = await executeCorteLifecycle(plan, ENTRIES, deps);
    assert.deepEqual(calls, ["fb-move diaria fb1 2026-11-15T15:00:00.000Z"]);
    assert.deepEqual(persisted.map((e) => [e.destination, e.scheduled_at]), [["facebook:diaria", "2026-11-15T15:00:00.000Z"]]);
    assert.equal(results.find((r) => r.destination === "youtube_shorts")?.outcome, "failed");
    assert.equal(results.find((r) => r.destination === "x")?.buffer?.dueAt, "2026-11-15T15:00:00.000Z");
  });

  it("plano com bloqueio nunca executa", async () => {
    const { calls, deps } = fakeDeps();
    const plan = planCorteLifecycle({ op: { kind: "cancel" }, spec: SPEC, entries: ENTRIES, openMarks: [{ destination: "x", started_at: "t" }], now: NOW });
    await assert.rejects(executeCorteLifecycle(plan, ENTRIES, deps), /bloqueio/);
    assert.deepEqual(calls, []);
  });
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

describe("#13000 YouTube: rescheduleScheduledVideo (fetch falso)", () => {
  const creds = { clientId: "i", clientSecret: "s", refreshToken: "r", channelId: "CH" };
  const fake = (statuses: Array<Record<string, unknown>>) => {
    const puts: any[] = [];
    let reads = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return json({ access_token: "tok" });
      if (url.includes("/channels")) return json({ items: [{ id: "CH" }] });
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return json({});
      }
      return json({ items: [{ id: "yt1", status: statuses[Math.min(reads++, statuses.length - 1)] }] });
    };
    return { puts, fetch };
  };

  it("reagenda preservando os campos graváveis do status", async () => {
    const before = { privacyStatus: "private", publishAt: AT, embeddable: true, license: "youtube", selfDeclaredMadeForKids: false, uploadStatus: "processed" };
    const { puts, fetch } = fake([before, { ...before, publishAt: "2026-11-15T15:00:00Z" }]);
    await rescheduleScheduledVideo({ fetch, now: () => NOW } as any, creds, "yt1", "2026-11-15T15:00:00.000Z", CORTE_LIFECYCLE_MIN_LEAD_MS);
    assert.deepEqual(puts, [{ id: "yt1", status: { privacyStatus: "private", embeddable: true, license: "youtube", selfDeclaredMadeForKids: false, publishAt: "2026-11-15T15:00:00.000Z" } }]);
  });

  it("cancela deixando private sem publishAt", async () => {
    const before = { privacyStatus: "private", publishAt: AT };
    const { puts, fetch } = fake([before, { privacyStatus: "private" }]);
    await rescheduleScheduledVideo({ fetch, now: () => NOW } as any, creds, "yt1", null, CORTE_LIFECYCLE_MIN_LEAD_MS);
    assert.deepEqual(puts, [{ id: "yt1", status: { privacyStatus: "private" } }]);
  });

  it("vídeo já público: recusa sem PUT", async () => {
    const { puts, fetch } = fake([{ privacyStatus: "public", publishAt: null }]);
    await assert.rejects(rescheduleScheduledVideo({ fetch, now: () => NOW } as any, creds, "yt1", null, CORTE_LIFECYCLE_MIN_LEAD_MS), /não está agendado com folga/);
    assert.equal(puts.length, 0);
  });

  it("releitura que não bate lança (não declara sucesso sem conferir)", async () => {
    const before = { privacyStatus: "private", publishAt: AT };
    const { fetch } = fake([before, before]);
    await assert.rejects(rescheduleScheduledVideo({ fetch, now: () => NOW } as any, creds, "yt1", null, CORTE_LIFECYCLE_MIN_LEAD_MS), /releitura/);
  });
});

describe("#13000 Facebook (fetch falso)", () => {
  const page: ResolvedFacebookPage = { slug: "diaria", enabled: true, pageId: "P", token: "TOK", missing: [], utmContent: null };
  const fake = (reads: Array<Record<string, unknown>>) => {
    const calls: string[] = [];
    let n = 0;
    const deps: GraphDeps = {
      fetch: async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.split("?")[0].replace(/^.*\/v\d+\.\d+\//, "")}${method === "POST" ? ` ${String(init?.body)}` : ""}`);
        if (method === "DELETE") return json({ success: true });
        if (method === "POST") return json({ success: true });
        return json(reads[Math.min(n++, reads.length - 1)]);
      },
      sleep: async () => {},
      now: () => NOW,
      log: () => {},
    };
    return { calls, deps };
  };
  const sched = Math.floor(Date.parse(AT) / 1000);

  it("cancelar: relê published=false com folga e só então DELETE", async () => {
    const { calls, deps } = fake([{ published: false, scheduled_publish_time: sched }]);
    await cancelFacebookScheduledVideo(deps, page, "v21.0", "fb1");
    assert.deepEqual(calls.map((c) => c.split(" ").slice(0, 2).join(" ")), ["GET fb1", "DELETE fb1"]);
  });

  it("cancelar: vídeo já publicado NUNCA é apagado", async () => {
    const { calls, deps } = fake([{ published: true, scheduled_publish_time: sched }]);
    await assert.rejects(cancelFacebookScheduledVideo(deps, page, "v21.0", "fb1"), /nada alterado/);
    assert.ok(!calls.some((c) => c.startsWith("DELETE")));
  });

  it("cancelar: a menos da folga do horário não apaga", async () => {
    const { calls, deps } = fake([{ published: false, scheduled_publish_time: Math.floor((NOW.getTime() + 5 * 60_000) / 1000) }]);
    await assert.rejects(cancelFacebookScheduledVideo(deps, page, "v21.0", "fb1"), /folga/);
    assert.ok(!calls.some((c) => c.startsWith("DELETE")));
  });

  it("reagendar: POST scheduled_publish_time e confere na releitura", async () => {
    const next = Math.floor(Date.parse("2026-11-15T15:00:00Z") / 1000);
    const { calls, deps } = fake([{ published: false, scheduled_publish_time: sched }, { published: false, scheduled_publish_time: String(next) }]);
    await rescheduleFacebookScheduledVideo(deps, page, "v21.0", "fb1", "2026-11-15T15:00:00.000Z");
    assert.ok(calls.some((c) => c.startsWith("POST fb1") && c.includes(`scheduled_publish_time=${next}`)));
  });

  it("reagendar: releitura com outro horário lança", async () => {
    const { deps } = fake([{ published: false, scheduled_publish_time: sched }, { published: false, scheduled_publish_time: sched }]);
    await assert.rejects(rescheduleFacebookScheduledVideo(deps, page, "v21.0", "fb1", "2026-11-15T15:00:00.000Z"), /releitura/);
  });

  it("facebookScheduledMs aceita segundos, string numérica e ISO", () => {
    assert.equal(facebookScheduledMs(10), 10_000);
    assert.equal(facebookScheduledMs("10"), 10_000);
    assert.equal(facebookScheduledMs(AT), Date.parse(AT));
    assert.equal(facebookScheduledMs(undefined), null);
  });
});

describe("#13000 CLI e corte.json", () => {
  it("flags: --cancel/--reschedule só com --corte, sem misturar plano, --confirm repete o slug", () => {
    const err = (argv: string[]) => {
      const p = parseShortsCliArgs(argv);
      assert.ok(p.ok, JSON.stringify(p));
      return corteLifecycleArgsError(p.flags, p.values);
    };
    assert.equal(err(["--corte", "automacao-261111", "--cancel"]), null);
    assert.equal(err(["--corte", "automacao-261111", "--cancel", "--confirm", "automacao-261111"]), null);
    assert.equal(err(["--corte", "automacao-261111", "--reschedule", "--date", "261115", "--at", "12:00"]), null);
    assert.match(err(["--corte", "automacao-261111", "--reschedule", "--date", "261115"])!, /--at/);
    assert.match(err(["--corte", "automacao-261111", "--cancel", "--confirm", "outro"])!, /repetir o slug/);
    assert.match(err(["--corte", "automacao-261111", "--cancel", "--publish"])!, /não combina com --publish/);
    assert.match(err(["--corte", "automacao-261111", "--cancel", "--title", "x"])!, /--title/);
    assert.match(err(["261114", "--cancel"])!, /só vale com --corte/);
  });

  it("withCorteCancellation tira o \"pode publicar\" e o registro de derrubada; novo pode-publicar reativa", () => {
    const c = withCorteCancellation({ ...SPEC, publish_revoked_at: "2026-11-12T00:00:00.000Z", publish_revoked_destinations: ["tiktok"], publish_revoked_reason_kind: "content" }, NOW.toISOString(), ["instagram"]);
    assert.equal(c.publish_confirmed_at, undefined);
    assert.equal(c.publish_revoked_at, undefined);
    assert.equal(c.cancelled_at, NOW.toISOString());
    // Válido no parser (nada de autorização junto do cancelamento).
    parseCorteSpec(JSON.stringify(c), "corte.json");
    assert.throws(() => parseCorteSpec(JSON.stringify({ ...c, publish_confirmed_at: SPEC.publish_confirmed_at, publish_confirmed_destinations: ["x"], publish_confirmed_content: SPEC.publish_confirmed_content }), "corte.json"), /não convivem/);
    const again = withCortePublishAuthorization(c, ["instagram"], { video_sha256: SHA, cover_sha256: null }, NOW.toISOString());
    assert.equal(again.spec.cancelled_at, undefined);
    assert.deepEqual(again.spec.publish_confirmed_destinations, ["instagram"]);
  });

  it("--update-scheduled não mexe em destino cancelado", () => {
    const items = planScheduledUpdates({ entries: [{ ...ENTRIES[0], cancelled_at: NOW.toISOString() }], d1: { title: "T", body: "G." }, now: NOW, coverPresent: false });
    assert.equal(items[0].action, "skip");
  });
});
