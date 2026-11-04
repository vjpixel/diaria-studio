/**
 * test/youtube-channel-surfaces-12081.test.ts (#12081)
 *
 * Canal do YouTube nas superfícies próprias (decisão do editor, 03/11/2026):
 * vídeo mais visto da semana no post da Stack e na newsletter semanal do
 * LinkedIn, vídeo do mês no encerramento da mensal. O "mais visto" vem das
 * views da YouTube Data API (`top-edition-video.ts`), fail-soft sem
 * credencial. Onboarding D+3 e e-mail de confirmação não têm código aqui
 * (texto em `data/snippets/` e painel do Kit).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectEditionVideos,
  fetchVideoViewCounts,
  pickTopVideo,
  resolveTopEditionVideo,
  type TopEditionVideo,
} from "../scripts/lib/top-edition-video.ts";
import { renderCircleStackPost, CIRCLE_STACK_VIDEO_LEAD, type CircleStackSelection } from "../scripts/lib/circle-stack-render.ts";
import { circleStackVideoField, parseStoredCircleStackSelection } from "../scripts/publish-circle-stack.ts";
import { renderLinkedinWeeklyHtml, LINKEDIN_WEEKLY_VIDEO_LEAD } from "../scripts/lib/weekly-linkedin-render.ts";
import { ensureWeeklyVideo } from "../scripts/render-linkedin-weekly.ts";
import { insertVideoDoMesLine, VIDEO_DO_MES_LEAD } from "../scripts/lib/mensal/monthly-video-do-mes.ts";
import { runVideoDoMes } from "../scripts/monthly-video-do-mes.ts";

const A = "aaaaaaaaaaa";
const B = "bbbbbbbbbbb";

function withEditions<T>(videos: Record<string, string>, fn: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "yt-surfaces-12081-"));
  for (const [aammdd, id] of Object.entries(videos)) {
    const dir = join(root, "data", "editions", aammdd.slice(0, 4), aammdd);
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "_internal", "05-video-url.txt"), `https://youtu.be/${id}\n`);
    writeFileSync(join(dir, "_internal", "05-youtube-published.json"), JSON.stringify({ videoId: id, title: `Vídeo ${aammdd}` }));
    writeFileSync(join(dir, "02-reviewed.md"), `**DESTAQUE 1 | X**\n\n**[D1 de ${aammdd}](https://example.com/${aammdd})**\n`);
  }
  return Promise.resolve(fn(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

const dirIn = (root: string) => (d: string) => join(root, "data", "editions", d.slice(0, 4), d);

describe("#12081 — vídeo mais visto do período", () => {
  it("pickTopVideo: mais views vence; empate fica com a edição mais recente; sem contagem não concorre", () => {
    const refs = [
      { aammdd: "261102", videoId: A, videoUrl: `https://youtu.be/${A}`, title: "a" },
      { aammdd: "261103", videoId: B, videoUrl: `https://youtu.be/${B}`, title: "b" },
    ];
    assert.equal(pickTopVideo(refs, new Map([[A, 10], [B, 9]]))?.videoId, A);
    assert.equal(pickTopVideo(refs, new Map([[A, 10], [B, 10]]))?.videoId, B);
    assert.equal(pickTopVideo(refs, new Map([[B, 0]]))?.videoId, B);
    assert.equal(pickTopVideo(refs, new Map()), null);
  });

  it("fetchVideoViewCounts: lê viewCount de videos.list?part=statistics", async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ items: [{ id: A, statistics: { viewCount: "176" } }] }), { status: 200 });
    };
    const out = await fetchVideoViewCounts(fetch, "tok", [A, B]);
    assert.equal(out.get(A), 176);
    assert.equal(out.has(B), false);
    assert.match(urls[0], /videos\?part=statistics&id=aaaaaaaaaaa,bbbbbbbbbbb$/);
  });

  it("resolveTopEditionVideo: sem credencial devolve null sem chamar a rede", async () => {
    await withEditions({ "261102": A }, async (root) => {
      const logs: string[] = [];
      const top = await resolveTopEditionVideo({
        aammdds: ["261102"],
        dirFor: dirIn(root),
        env: {},
        fetch: async () => {
          throw new Error("não deveria chamar a rede");
        },
        log: (m) => logs.push(m),
      });
      assert.equal(top, null);
      assert.match(logs.join("\n"), /GOOGLE_CLIENT_ID/);
    });
  });

  it("resolveTopEditionVideo: com credencial, token + views → o mais visto", async () => {
    await withEditions({ "261102": A, "261103": B }, async (root) => {
      const fetch = async (url: string) =>
        url.includes("oauth2")
          ? new Response(JSON.stringify({ access_token: "tok" }), { status: 200 })
          : new Response(JSON.stringify({ items: [{ id: A, statistics: { viewCount: "5" } }, { id: B, statistics: { viewCount: "50" } }] }), { status: 200 });
      const top = await resolveTopEditionVideo({
        aammdds: ["261102", "261103", "261104"],
        dirFor: dirIn(root),
        env: { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" },
        fetch,
        log: () => {},
      });
      assert.deepEqual(top, { aammdd: "261103", videoId: B, videoUrl: `https://youtu.be/${B}`, title: "Vídeo 261103", views: 50 });
      assert.equal(collectEditionVideos(["261102", "261102"], dirIn(root)).length, 1, "mesmo vídeo não repete");
    });
  });

  it("erro da API vira null (fail-soft)", async () => {
    await withEditions({ "261102": A }, async (root) => {
      const top = await resolveTopEditionVideo({
        aammdds: ["261102"],
        dirFor: dirIn(root),
        env: { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r" },
        fetch: async () => new Response("erro", { status: 500 }),
        log: () => {},
      });
      assert.equal(top, null);
    });
  });
});

const TOP: TopEditionVideo = { aammdd: "261103", videoId: B, videoUrl: `https://youtu.be/${B}`, title: "Vídeo da semana", views: 50 };

function stackSel(extra: Partial<CircleStackSelection> = {}): CircleStackSelection {
  return {
    cycle: "26w45",
    contentWindow: ["261102", "261103"],
    destaques: [{ editionDate: "261103", url: "https://example.com/d1", title: "D1", body: "Corpo.", why: "Porque." }],
    lancamentos: [],
    useMelhor: [],
    radar: [],
    weeklyEditions: [],
    ...extra,
  };
}

describe("#12081 — post semanal da Stack", () => {
  it("linha do vídeo antes do CTA final, com UTM do canal (utm_content=video), sem seta", () => {
    const video = circleStackVideoField(TOP, new Map());
    assert.ok(video);
    const md = renderCircleStackPost(stackSel({ video: video! })).markdown;
    const lines = md.split("\n\n");
    const i = lines.findIndex((l) => l.startsWith(CIRCLE_STACK_VIDEO_LEAD));
    assert.ok(i > 0, "linha do vídeo presente");
    assert.equal(i, lines.length - 2, "logo antes da última linha (CTA)");
    assert.match(lines[i], /\[Vídeo da semana\]\(https:\/\/youtu\.be\/bbbbbbbbbbb\?utm_source=stack&utm_medium=circle&utm_campaign=stack-26w45&utm_content=video\)/);
    assert.ok(!/[→←]/.test(md));
  });

  it("sem vídeo medido: post igual ao de antes", () => {
    assert.ok(!renderCircleStackPost(stackSel()).markdown.includes(CIRCLE_STACK_VIDEO_LEAD));
    assert.equal(circleStackVideoField(null, new Map()), null);
    assert.equal(
      circleStackVideoField({ ...TOP, title: null }, new Map([["261103", "Título do D1"]]))?.title,
      "Título do D1",
      "sem título do registro, usa o D1 da edição",
    );
  });

  it("seleção editável: campo video malformado recusa com mensagem", () => {
    const raw = (video: unknown) => JSON.stringify({ ...stackSel(), video });
    assert.ok(parseStoredCircleStackSelection(raw({ title: "t", url: "u", editionDate: "261103" }), "sel.json", "26w45").selection.video);
    assert.throws(() => parseStoredCircleStackSelection(raw({ title: "t" }), "sel.json", "26w45"), /campo video/);
  });
});

describe("#12081 — newsletter semanal do LinkedIn", () => {
  const base = {
    cycle: "26w45",
    headlines: [{ title: "H1", body: "Corpo.", why: "Porque.", editionDate: "261103" }],
    weeklyEditions: [],
    opening: "Abertura.",
    closing: "Fecho.",
  };

  it("linha do vídeo antes do fecho, com UTM utm_content=video", () => {
    const { html } = renderLinkedinWeeklyHtml({ ...base, video: { title: "Vídeo da semana", url: `https://youtu.be/${B}` } });
    const i = html.indexOf(LINKEDIN_WEEKLY_VIDEO_LEAD);
    assert.ok(i > 0);
    assert.ok(i < html.indexOf("<p>Fecho.</p>"), "antes do fecho");
    assert.ok(html.includes(`https://youtu.be/${B}?utm_source=linkedin&amp;utm_medium=newsletter&amp;utm_campaign=ln-26w45&amp;utm_content=video`));
    assert.ok(!renderLinkedinWeeklyHtml(base).html.includes(LINKEDIN_WEEKLY_VIDEO_LEAD), "sem vídeo, sem linha");
  });

  it("ensureWeeklyVideo grava o vídeo na seleção uma vez e reusa depois", async () => {
    const root = mkdtempSync(join(tmpdir(), "ln-video-12081-"));
    try {
      const sel = join(root, "data", "weekly", "26w45", "_internal");
      mkdirSync(sel, { recursive: true });
      writeFileSync(
        join(sel, "ln-selection.json"),
        JSON.stringify({ cycle: "26w45", contentWindow: ["261102", "261103"], headlines: [], useMelhor: null, weeklyEditions: [] }),
      );
      let calls = 0;
      const top = async (days: readonly string[]) => {
        calls++;
        assert.deepEqual(days, ["261102", "261103"]);
        return TOP;
      };
      const v = await ensureWeeklyVideo(root, "26w45", top);
      assert.deepEqual(v, { title: "Vídeo da semana", url: `https://youtu.be/${B}`, editionDate: "261103", views: 50 });
      assert.deepEqual(JSON.parse(readFileSync(join(sel, "ln-selection.json"), "utf8")).video, v);
      await ensureWeeklyVideo(root, "26w45", top);
      assert.equal(calls, 1, "re-render reusa o campo gravado");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("#12081 — vídeo do mês na mensal", () => {
  const DRAFT = "**DESTAQUE 1**\n\nTexto.\n\n**PARA ENCERRAR**\n\nQuer sugerir um tema? Responda.\n\nSiga a **diar.ia.br**: [YouTube](https://www.youtube.com/@diariabr)\n";

  it("insere como 1º parágrafo do PARA ENCERRAR; idempotente; troca se o vídeo mudou", () => {
    const r = insertVideoDoMesLine(DRAFT, { title: "Vídeo do mês", url: `https://youtu.be/${A}` });
    assert.ok(r.changed);
    assert.match(r.draft, /\*\*PARA ENCERRAR\*\*\n\nO vídeo mais assistido do mês no canal da diar\.ia\.br foi \[Vídeo do mês\]\(https:\/\/youtu\.be\/aaaaaaaaaaa\)\.\n\nQuer sugerir/);
    assert.equal(insertVideoDoMesLine(r.draft, { title: "Vídeo do mês", url: `https://youtu.be/${A}` }).changed, false);
    const swapped = insertVideoDoMesLine(r.draft, { title: "Outro", url: `https://youtu.be/${B}` });
    assert.ok(swapped.changed);
    assert.equal(swapped.draft.split(VIDEO_DO_MES_LEAD).length - 1, 1, "uma linha só");
    assert.equal(insertVideoDoMesLine("sem bloco", { title: "x", url: "u" }).changed, false);
  });

  it("runVideoDoMes: edições do mês de conteúdo, grava o registro e o draft", async () => {
    await withEditions({ "261029": A, "261103": B }, async (root) => {
      const monthly = join(root, "data", "monthly", "2610-11");
      mkdirSync(monthly, { recursive: true });
      writeFileSync(join(monthly, "draft.md"), DRAFT);
      let seen: readonly string[] = [];
      const rec = await runVideoDoMes({
        cycle: "2610-11",
        monthlyDir: monthly,
        editionsRoot: join(root, "data", "editions"),
        dryRun: false,
        env: {},
        topVideo: async (days, dirFor) => {
          seen = days;
          return { ...collectEditionVideos(days, dirFor)[0], views: 176 };
        },
        now: () => new Date("2026-11-04T00:00:00Z"),
        log: () => {},
      });
      assert.deepEqual(seen, ["261029"], "só o mês de conteúdo (2610)");
      assert.equal(rec?.title, "Vídeo 261029");
      assert.equal(JSON.parse(readFileSync(join(monthly, "_internal", "video-do-mes.json"), "utf8")).views, 176);
      assert.ok(readFileSync(join(monthly, "draft.md"), "utf8").includes(VIDEO_DO_MES_LEAD));
    });
  });
});
