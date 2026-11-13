/**
 * #12936: `publish-shorts.ts (AAMMDD | --corte SLUG) --update-published`. Em
 * 12/11/2026 o editor trocou o texto do corte `jensen-huang-261112` já no ar
 * e tudo saiu à mão (YouTube `videos.update`, Graph `POST /{video-id}`,
 * LinkedIn `PARTIAL_UPDATE`, Instagram/Threads pela UI), porque o
 * `--update-scheduled` recusa destino publicado por desenho. Tudo aqui roda
 * com fetch falso: nenhuma chamada de rede.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  THREADS_EDIT_WINDOW_MS,
  corteTextChangeBlockers,
  executePublishedTextUpdates,
  planPublishedTextUpdates,
  type PublishedUpdateDeps,
} from "../scripts/lib/diaria/short-published-update.ts";
import { updatePublishedVideoText } from "../scripts/lib/diaria/youtube-upload.ts";
import { updatePersonalPostCommentary } from "../scripts/lib/linkedin-personal.ts";
import { parseShortsCliArgs, updateFacebookPublishedVideoText, updatePublishedArgsError, type GraphDeps } from "../scripts/publish-shorts.ts";
import type { ShortPublishedEntry } from "../scripts/lib/diaria/short-video.ts";
import type { ResolvedFacebookPage } from "../scripts/lib/facebook-pages.ts";

const NOW = new Date("2026-11-13T15:00:00.000Z");
const D1 = { title: "Jensen Huang diz que a IA vai virar infraestrutura", body: "O CEO da Nvidia comparou a IA à eletricidade. Outra frase." };
const PAST = "2026-11-12T21:00:00.000Z";
const ENTRIES: ShortPublishedEntry[] = [
  { destination: "youtube_shorts", status: "scheduled", id: "yt1", scheduled_at: PAST, at: "t" },
  { destination: "facebook:diaria", status: "scheduled", id: "fb1", scheduled_at: PAST, at: "t" },
  { destination: "facebook:vjpixel", status: "published", id: "fb2", scheduled_at: null, at: PAST },
  { destination: "linkedin_profile", status: "published", id: "urn:li:share:123", url: "https://www.linkedin.com/feed/update/urn:li:share:123/", scheduled_at: null, at: PAST },
  { destination: "instagram", status: "published", id: "ig1", url: "https://instagram.com/reel/x", at: PAST },
  { destination: "threads_profile", status: "published", id: "th1", at: PAST },
  { destination: "x", status: "scheduled", id: "buffer:bx1", scheduled_at: PAST, at: "t" },
  { destination: "tiktok", status: "scheduled", id: "buffer:bt1", scheduled_at: PAST, at: "t" },
  { destination: "linkedin_page_repost", status: "scheduled", id: "q1", scheduled_at: PAST, at: "t" },
];

describe("#12936 planPublishedTextUpdates", () => {
  it("cenário do jensen-huang-261112: API em YouTube/Facebook/LinkedIn, UI no Instagram, X/TikTok/Threads fora da janela não editam", () => {
    const items = planPublishedTextUpdates({ entries: ENTRIES, d1: D1, now: NOW });
    const by = Object.fromEntries(items.map((i) => [i.destination, i.action]));
    assert.deepEqual(by, {
      youtube_shorts: "api_youtube",
      "facebook:diaria": "api_facebook",
      "facebook:vjpixel": "api_facebook",
      linkedin_profile: "api_linkedin",
      instagram: "ui",
      threads_profile: "not_editable",
      x: "not_editable",
      tiktok: "not_editable",
      linkedin_page_repost: "skip",
    });
    const yt = items.find((i) => i.action === "api_youtube");
    assert.ok(yt && yt.action === "api_youtube" && yt.title.includes("Jensen Huang"));
    const fb = items.find((i) => i.destination === "facebook:vjpixel");
    assert.ok(fb && fb.action === "api_facebook" && fb.description.includes("Siga a diar.ia.br"), "a página VJ Pixel cita a diar.ia.br como no publish (#12465)");
  });

  it("ainda agendado, envio ambíguo e cancelado ficam fora com o motivo", () => {
    const future = "2026-11-14T21:00:00.000Z";
    const items = planPublishedTextUpdates({
      entries: [
        { destination: "youtube_shorts", status: "scheduled", id: "yt1", scheduled_at: future, at: "t" },
        { destination: "linkedin_profile", status: "send_unknown", id: "send_unknown-t", at: "t" },
        { destination: "facebook:diaria", status: "scheduled", id: "fb1", scheduled_at: future, at: "t", cancelled_at: "c" },
      ],
      d1: D1,
      now: NOW,
    });
    assert.deepEqual(items.map((i) => [i.destination, i.action]), [["youtube_shorts", "skip"], ["linkedin_profile", "skip"], ["facebook:diaria", "skip"]]);
    assert.match((items[0] as { reason: string }).reason, /--update-scheduled/);
  });

  it("Threads dentro dos 15 min vira passo de UI; LinkedIn registrado por --mark (URL) também", () => {
    const at = new Date(NOW.getTime() - THREADS_EDIT_WINDOW_MS + 60_000).toISOString();
    const items = planPublishedTextUpdates({
      entries: [
        { destination: "threads_profile", status: "published", id: "th1", at },
        { destination: "linkedin_profile", status: "published", id: "https://www.linkedin.com/posts/x", at: PAST },
      ],
      d1: D1,
      now: NOW,
    });
    assert.deepEqual(items.map((i) => i.action), ["ui", "ui"]);
  });

  it("--only com destino desconhecido lança", () => {
    assert.throws(() => planPublishedTextUpdates({ entries: ENTRIES, d1: D1, now: NOW, only: ["youtbe"], known: new Set(["youtube_shorts"]) }), /desconhecido/);
  });
});

describe("#12936 executePublishedTextUpdates", () => {
  const fakeDeps = (fail: string[] = []) => {
    const calls: string[] = [];
    const persisted: ShortPublishedEntry[] = [];
    const deps: PublishedUpdateDeps = {
      youtube: async (id) => {
        calls.push(`yt ${id}`);
        if (fail.includes("yt")) throw new Error("boom yt");
      },
      facebook: async (slug, id) => {
        calls.push(`fb ${slug} ${id}`);
        if (fail.includes(slug)) throw new Error(`boom ${slug}`);
      },
      linkedin: async (urn) => {
        calls.push(`li ${urn}`);
      },
      persist: (e) => persisted.push(e),
      now: () => NOW,
    };
    return { calls, persisted, deps };
  };

  it("aplica por API, grava updated_at só em YouTube/Facebook, LinkedIn sai como não relido, UI e não-editável listados", async () => {
    const { calls, persisted, deps } = fakeDeps();
    const items = planPublishedTextUpdates({ entries: ENTRIES, d1: D1, now: NOW });
    const results = await executePublishedTextUpdates(items, ENTRIES, deps);
    assert.deepEqual(calls, ["yt yt1", "fb diaria fb1", "fb vjpixel fb2", "li urn:li:share:123"]);
    assert.deepEqual(persisted.map((e) => [e.destination, e.updated_at]), [
      ["youtube_shorts", NOW.toISOString()],
      ["facebook:diaria", NOW.toISOString()],
      ["facebook:vjpixel", NOW.toISOString()],
    ]);
    const by = Object.fromEntries(results.map((r) => [r.destination, r.outcome]));
    assert.equal(by.linkedin_profile, "done_unverified");
    assert.equal(by.instagram, "ui");
    assert.equal(by.x, "not_editable");
    assert.ok(results.every((r) => r.ok));
  });

  it("falha de um destino não para os outros e volta com a causa", async () => {
    const { calls, deps } = fakeDeps(["diaria"]);
    const items = planPublishedTextUpdates({ entries: ENTRIES, d1: D1, now: NOW });
    const results = await executePublishedTextUpdates(items, ENTRIES, deps);
    assert.ok(calls.includes("fb vjpixel fb2") && calls.includes("li urn:li:share:123"));
    const f = results.find((r) => r.destination === "facebook:diaria");
    assert.deepEqual([f?.ok, f?.outcome, f?.error], [false, "failed", "boom diaria"]);
  });
});

describe("#12936 corteTextChangeBlockers", () => {
  const timer = ["linkedin_profile", "threads_profile", "instagram"];
  it("tudo no ar: título/gancho podem ir ao corte.json sem mexer no \"pode publicar\"", () => {
    assert.deepEqual(corteTextChangeBlockers({ authorizedDestinations: ["youtube_shorts", ...timer], timerDestinations: timer, entries: ENTRIES, now: NOW }), []);
  });
  it("destino do timer ainda por sair ou post ainda agendado bloqueia", () => {
    const entries = ENTRIES.filter((e) => e.destination !== "instagram").concat({ destination: "youtube_shorts", status: "scheduled", id: "yt1", scheduled_at: "2026-11-14T21:00:00.000Z", at: "t" });
    const b = corteTextChangeBlockers({ authorizedDestinations: timer, timerDestinations: timer, entries, now: NOW });
    assert.equal(b.length, 2);
    assert.match(b[0], /instagram ainda não saiu/);
    assert.match(b[1], /youtube_shorts ainda está agendado/);
  });
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

describe("#12936 YouTube: updatePublishedVideoText (fetch falso)", () => {
  const creds = { clientId: "i", clientSecret: "s", refreshToken: "r", channelId: "CH" };
  const fake = (reads: Array<{ snippet: Record<string, unknown>; status: Record<string, unknown> }>) => {
    const puts: any[] = [];
    let n = 0;
    const fetch = async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return json({ access_token: "tok" });
      if (url.includes("/channels")) return json({ items: [{ id: "CH" }] });
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return json({});
      }
      return json({ items: [{ id: "yt1", ...reads[Math.min(n++, reads.length - 1)] }] });
    };
    return { puts, fetch };
  };
  const input = { title: "Novo", description: "Desc nova" };

  it("vídeo público: troca título/descrição preservando os campos graváveis e confere na releitura", async () => {
    const before = { snippet: { title: "Velho", description: "d", categoryId: "28", tags: ["ia"], publishedAt: "x" }, status: { privacyStatus: "public" } };
    const { puts, fetch } = fake([before, { snippet: { ...before.snippet, ...input }, status: before.status }]);
    await updatePublishedVideoText({ fetch, now: () => NOW } as any, creds, "yt1", input);
    assert.deepEqual(puts, [{ id: "yt1", snippet: { title: "Novo", description: "Desc nova", categoryId: "28", tags: ["ia"] } }]);
  });

  it("vídeo ainda agendado (private): recusa sem PUT", async () => {
    const { puts, fetch } = fake([{ snippet: { title: "Velho" }, status: { privacyStatus: "private", publishAt: "2026-11-14T21:00:00Z" } }]);
    await assert.rejects(updatePublishedVideoText({ fetch, now: () => NOW } as any, creds, "yt1", input), /--update-scheduled/);
    assert.equal(puts.length, 0);
  });

  it("releitura com outro texto lança (não declara sucesso sem conferir)", async () => {
    const before = { snippet: { title: "Velho", description: "d", categoryId: "28" }, status: { privacyStatus: "public" } };
    const { fetch } = fake([before, before]);
    await assert.rejects(updatePublishedVideoText({ fetch, now: () => NOW } as any, creds, "yt1", input), /releitura/);
  });
});

describe("#12936 Facebook: updateFacebookPublishedVideoText (fetch falso)", () => {
  const page: ResolvedFacebookPage = { slug: "diaria", enabled: true, pageId: "P", token: "TOK", missing: [], utmContent: null };
  const fake = (reads: Array<Record<string, unknown>>) => {
    const calls: string[] = [];
    let n = 0;
    const deps: GraphDeps = {
      fetch: async (url: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url.split("?")[0].replace(/^.*\/v\d+\.\d+\//, "")}`);
        if (method === "POST") return json({ success: true });
        return json(reads[Math.min(n++, reads.length - 1)]);
      },
      sleep: async () => {},
      now: () => NOW,
      log: () => {},
    };
    return { calls, deps };
  };

  it("publicado: POST da descrição e releitura que confere", async () => {
    const { calls, deps } = fake([{ published: true }, { description: "nova" }]);
    await updateFacebookPublishedVideoText(deps, page, "v21.0", "fb1", "nova");
    assert.deepEqual(calls, ["GET fb1", "POST fb1", "GET fb1"]);
  });

  it("ainda agendado (published=false): nada é escrito", async () => {
    const { calls, deps } = fake([{ published: false }]);
    await assert.rejects(updateFacebookPublishedVideoText(deps, page, "v21.0", "fb1", "nova"), /--update-scheduled/);
    assert.ok(!calls.some((c) => c.startsWith("POST")));
  });

  it("releitura com outra descrição lança", async () => {
    const { deps } = fake([{ published: true }, { description: "velha" }]);
    await assert.rejects(updateFacebookPublishedVideoText(deps, page, "v21.0", "fb1", "nova"), /releitura/);
  });
});

describe("#12936 LinkedIn: updatePersonalPostCommentary (fetch falso)", () => {
  it("PARTIAL_UPDATE no post com o commentary em little text; 204 é sucesso", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    await updatePersonalPostCommentary({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return new Response(null, { status: 204 });
      },
      accessToken: "tok",
      apiVersion: "202609",
      postUrn: "urn:li:share:123",
      text: "Título (novo) #IA",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.linkedin.com/rest/posts/urn%3Ali%3Ashare%3A123");
    const headers = calls[0].init?.headers as Record<string, string>;
    assert.equal(headers["X-RestLi-Method"], "PARTIAL_UPDATE");
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { patch: { $set: { commentary: "Título \\(novo\\) {hashtag|\\#|IA}" } } });
  });

  it("4xx lança com o status", async () => {
    await assert.rejects(
      updatePersonalPostCommentary({ fetchFn: async () => new Response("bad", { status: 422 }), accessToken: "t", apiVersion: "202609", postUrn: "urn:li:share:1", text: "x" }),
      /HTTP 422/,
    );
  });
});

describe("#12936 flags do --update-published", () => {
  const parse = (argv: string[]) => {
    const p = parseShortsCliArgs(argv);
    assert.ok(p.ok);
    return p;
  };
  it("corte: --confirm repete o slug; título/gancho aceitos", () => {
    const p = parse(["--corte", "jensen-huang-261112", "--update-published", "--title", "T", "--hook", "H", "--confirm", "jensen-huang-261112"]);
    assert.equal(updatePublishedArgsError(p.flags, p.values, p.aammdd), null);
    const q = parse(["--corte", "jensen-huang-261112", "--update-published", "--confirm", "outro"]);
    assert.match(updatePublishedArgsError(q.flags, q.values, q.aammdd) ?? "", /slug do corte/);
  });
  it("edição: --confirm repete a edição; --title recusado", () => {
    const p = parse(["261112", "--update-published", "--confirm", "261112"]);
    assert.equal(updatePublishedArgsError(p.flags, p.values, p.aammdd), null);
    const q = parse(["261112", "--update-published", "--title", "T"]);
    assert.match(updatePublishedArgsError(q.flags, q.values, q.aammdd) ?? "", /só valem com --corte/);
  });
  it("não combina com --publish, --update-scheduled, --cancel nem --video", () => {
    const p = parse(["261112", "--update-published", "--publish", "--update-scheduled", "--video", "v.mp4"]);
    const err = updatePublishedArgsError(p.flags, p.values, p.aammdd) ?? "";
    for (const f of ["--publish", "--update-scheduled", "--video"]) assert.ok(err.includes(f), err);
  });
});
