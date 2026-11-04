import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VIDEO_DO_MES_END,
  VIDEO_DO_MES_START,
  buildVideoDoMesHtml,
  contentMonthOfCycle,
  defaultVideoDoMesFrase,
  injectVideoDoMes,
  isShortVideo,
  parseIsoDurationSeconds,
  pickVideoDoMes,
  videoDoMesUrl,
  type YouTubeVideoItem,
} from "../scripts/lib/mensal/clarice-video-do-mes.ts";
import { fetchMonthVideos } from "../scripts/clarice-video-do-mes.ts";
import { renderEncerramento, renderIntro, renderKicker } from "../scripts/lib/mensal/monthly-render.ts";
import type { YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";

const vid = (over: Partial<YouTubeVideoItem> & { id: string; views: number; at: string; dur?: string; title?: string }): YouTubeVideoItem => ({
  id: over.id,
  snippet: { title: over.title ?? `video ${over.id}`, publishedAt: over.at, description: "" },
  contentDetails: { duration: over.dur ?? "PT9M30S" },
  statistics: { viewCount: String(over.views) },
  status: over.status ?? { privacyStatus: "public" },
});

test("contentMonthOfCycle: 2610-11 é outubro de 2026 (o mês passado do envio de 04/11)", () => {
  assert.deepEqual(contentMonthOfCycle("2610-11"), { year: 2026, month: 10, label: "outubro" });
  assert.throws(() => contentMonthOfCycle("2610"), /ciclo inválido/);
  assert.throws(() => contentMonthOfCycle("2613-01"), /ciclo inválido/);
});

test("parseIsoDurationSeconds", () => {
  assert.equal(parseIsoDurationSeconds("PT9M30S"), 570);
  assert.equal(parseIsoDurationSeconds("PT1H"), 3600);
  assert.equal(parseIsoDurationSeconds("PT59S"), 59);
  assert.ok(Number.isNaN(parseIsoDurationSeconds("")));
  assert.ok(Number.isNaN(parseIsoDurationSeconds("PT")));
});

test("isShortVideo: até 3 min, #shorts ou duração ilegível ficam de fora", () => {
  assert.equal(isShortVideo(vid({ id: "a", views: 1, at: "2026-10-05T12:00:00Z", dur: "PT58S" })), true);
  assert.equal(isShortVideo(vid({ id: "a", views: 1, at: "2026-10-05T12:00:00Z", dur: "PT3M" })), true);
  assert.equal(isShortVideo(vid({ id: "a", views: 1, at: "2026-10-05T12:00:00Z", dur: "PT10M", title: "x #shorts" })), true);
  assert.equal(isShortVideo(vid({ id: "a", views: 1, at: "2026-10-05T12:00:00Z", dur: "bogus" })), true);
  assert.equal(isShortVideo(vid({ id: "a", views: 1, at: "2026-10-05T12:00:00Z", dur: "PT8M" })), false);
});

test("pickVideoDoMes: horizontal público de outubro (BRT) com mais views", () => {
  const videos = [
    vid({ id: "short1", views: 9000, at: "2026-10-10T12:00:00Z", dur: "PT45S" }),
    vid({ id: "private", views: 8000, at: "2026-10-10T12:00:00Z", status: { privacyStatus: "private" } }),
    vid({ id: "nov", views: 7000, at: "2026-11-01T03:00:00Z" }), // 01/11 00:00 BRT: já é novembro
    vid({ id: "set", views: 6000, at: "2026-10-01T02:59:59Z" }), // 30/09 23:59 BRT: ainda setembro
    vid({ id: "top", views: 500, at: "2026-10-20T12:00:00Z", title: "O mais visto" }),
    vid({ id: "low", views: 100, at: "2026-10-02T12:00:00Z" }),
    vid({ id: "first", views: 50, at: "2026-10-01T03:00:00Z" }), // 01/10 00:00 BRT conta
  ];
  const pick = pickVideoDoMes(videos, 2026, 10);
  assert.equal(pick?.videoId, "top");
  assert.equal(pick?.views, 500);
  assert.equal(pick?.title, "O mais visto");
  assert.equal(pickVideoDoMes(videos.filter((v) => v.id === "first"), 2026, 10)?.videoId, "first");
  assert.equal(pickVideoDoMes([], 2026, 10), null);
});

test("pickVideoDoMes: empate em views escolhe o mais antigo", () => {
  const pick = pickVideoDoMes(
    [vid({ id: "late", views: 10, at: "2026-10-20T12:00:00Z" }), vid({ id: "early", views: 10, at: "2026-10-05T12:00:00Z" })],
    2026,
    10,
  );
  assert.equal(pick?.videoId, "early");
});

test("videoDoMesUrl: UTM do corpo da issue", () => {
  const u = new URL(videoDoMesUrl("abcDEF12345", "2610-11"));
  assert.equal(u.origin + u.pathname, "https://www.youtube.com/watch");
  assert.equal(u.searchParams.get("v"), "abcDEF12345");
  assert.equal(u.searchParams.get("utm_source"), "clarice");
  assert.equal(u.searchParams.get("utm_medium"), "email");
  assert.equal(u.searchParams.get("utm_campaign"), "video-do-mes-2610-11");
  assert.throws(() => videoDoMesUrl("a b", "2610-11"), /videoId inválido/);
});

test("buildVideoDoMesHtml: título linkado com UTM, frase, inscrição e sem seta", () => {
  const html = buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: "IA & <eleições>", frase: defaultVideoDoMesFrase("2610-11") });
  assert.ok(html.startsWith(VIDEO_DO_MES_START) && html.endsWith(VIDEO_DO_MES_END));
  assert.ok(html.includes(renderKicker("O vídeo do mês")));
  assert.ok(html.includes("utm_campaign=video-do-mes-2610-11"));
  // href com &amp;, como o resto do render (#12053)
  assert.ok(html.includes("watch?v=abcDEF12345&amp;utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=video-do-mes-2610-11"));
  assert.ok(html.includes('href="https://www.youtube.com/@diariabr?sub_confirmation=1"'));
  assert.ok(html.includes("IA &amp; &lt;eleições&gt;"));
  assert.ok(html.includes("mais assistido de outubro"));
  assert.ok(!/[→←]/.test(html));
  assert.throws(() => buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: "Veja →", frase: "x" }), /seta/);
  assert.throws(() => buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: " ", frase: "x" }), /título/);
});

test("buildVideoDoMesHtml: imagem do destaque linkada para o vídeo, antes do título", () => {
  const img = "https://eia.diar.ia.br/img/img-261029-04-d1-2x1-play-a5826e6f.jpg";
  const html = buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: "Vídeo A", frase: "Frase.", imageUrl: img });
  const iImg = html.indexOf(`<img src="${img}"`);
  assert.ok(iImg > 0, "img com a URL do destaque");
  assert.ok(iImg < html.indexOf("Vídeo A</a></p>"), "imagem vem antes do título");
  assert.ok(html.slice(0, iImg).endsWith('<a href="https://www.youtube.com/watch?v=abcDEF12345&amp;utm_source=clarice&amp;utm_medium=email&amp;utm_campaign=video-do-mes-2610-11" style="text-decoration:none;">'));
  assert.ok(!buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: "Vídeo A", frase: "Frase." }).includes("<img"));
  assert.throws(() => buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: "A", frase: "x", imageUrl: "data/x.jpg" }), /https/);
});

const realPage = () => {
  const encerramento = renderEncerramento("Quer sugerir um tema? Responda a este e-mail.");
  const spacer = `<div style="line-height:28px;font-size:0;">&nbsp;</div>`;
  return `<html><body><p>Apresentação</p>${spacer}${renderIntro("Outubro foi um mês de contas a acertar.")}${spacer}${renderKicker("BRASIL")}<p>D1</p>${spacer}<p>É IA?</p>${spacer}${encerramento}</body></html>`;
};

test("injectVideoDoMes: entra logo depois do 'Resumo do mês' real do render, antes da 1ª seção, e é idempotente", () => {
  const page = realPage();
  const block = buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: "Vídeo A", frase: "Frase." });
  const first = injectVideoDoMes(page, block);
  assert.equal(first.replaced, false);
  const iBlock = first.html.indexOf(VIDEO_DO_MES_START);
  assert.ok(iBlock > first.html.indexOf("contas a acertar"), "depois do texto do resumo");
  assert.ok(iBlock < first.html.indexOf("&nbsp;BRASIL</td>"), "antes da 1ª seção");
  assert.equal(first.html.lastIndexOf("<table", first.html.indexOf("&nbsp;BRASIL</td>")), iBlock + block.length + 1, "o kicker seguinte fica inteiro");
  assert.equal(first.html.indexOf(VIDEO_DO_MES_START, iBlock + 1), -1);

  const again = injectVideoDoMes(first.html, block);
  assert.equal(again.replaced, true);
  assert.equal(again.html, first.html);

  const block2 = buildVideoDoMesHtml({ cycle: "2610-11", videoId: "zzzZZZ12345", title: "Vídeo B", frase: "Outra." });
  const swapped = injectVideoDoMes(first.html, block2).html;
  assert.ok(swapped.includes("Vídeo B") && !swapped.includes("Vídeo A"));
  assert.equal(swapped.split(VIDEO_DO_MES_START).length, 2);
});

test("injectVideoDoMes: bloco que estava antes do 'Para encerrar' (1ª versão) é MOVIDO para depois do resumo", () => {
  const page = realPage();
  const old = buildVideoDoMesHtml({ cycle: "2610-11", videoId: "abcDEF12345", title: "Vídeo A", frase: "Frase." });
  const iEnc = page.lastIndexOf("<table", page.indexOf("&nbsp;Para encerrar</td>"));
  const legacy = page.slice(0, iEnc) + old + "\n" + page.slice(iEnc);
  const moved = injectVideoDoMes(legacy, old);
  assert.equal(moved.replaced, true);
  assert.equal(moved.html, injectVideoDoMes(page, old).html, "igual a injetar do zero na página limpa");
});

test("injectVideoDoMes: sem o kicker do resumo, ou marcador quebrado, para em vez de chutar", () => {
  assert.throws(() => injectVideoDoMes("<p>sem resumo</p>", "x"), /Resumo do mês/);
  assert.throws(() => injectVideoDoMes(renderIntro("só o resumo"), "x"), /nenhuma seção depois/);
  assert.throws(() => injectVideoDoMes(`${VIDEO_DO_MES_START}<p>`, "x"), /sem o de fim/);
});

test("fetchMonthVideos: pagina os uploads até passar do início do mês", async () => {
  const calls: string[] = [];
  const pages: Record<string, unknown> = {
    p1: { items: [{ contentDetails: { videoId: "n1", videoPublishedAt: "2026-11-02T12:00:00Z" } }, { contentDetails: { videoId: "o1", videoPublishedAt: "2026-10-20T12:00:00Z" } }], nextPageToken: "T2" },
    p2: { items: [{ contentDetails: { videoId: "o2", videoPublishedAt: "2026-10-02T12:00:00Z" } }, { contentDetails: { videoId: "s1", videoPublishedAt: "2026-09-29T12:00:00Z" } }], nextPageToken: "T3" },
  };
  const deps: YouTubeUploadDeps = {
    now: () => new Date(),
    fetch: async (url: string) => {
      calls.push(url);
      let body: unknown;
      if (url.includes("/playlistItems")) body = url.includes("pageToken=T2") ? pages.p2 : pages.p1;
      else body = { items: [vid({ id: "o1", views: 30, at: "2026-10-20T12:00:00Z" }), vid({ id: "o2", views: 40, at: "2026-10-02T12:00:00Z" })] };
      return new Response(JSON.stringify(body), { status: 200 });
    },
  };
  const videos = await fetchMonthVideos(deps, "tok", "UCabc", 2026, 10);
  assert.equal(calls.filter((c) => c.includes("/playlistItems")).length, 2, "não pede a 3ª página: já passou de setembro");
  assert.ok(calls[0].includes("playlistId=UUabc"));
  const videosCall = calls.find((c) => c.includes("/videos?"))!;
  assert.ok(videosCall.includes("part=snippet,contentDetails,statistics,status"));
  assert.ok(videosCall.includes("id=n1,o1,o2,s1"));
  assert.equal(pickVideoDoMes(videos, 2026, 10)?.videoId, "o2");
});
