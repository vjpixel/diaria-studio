/**
 * test/youtube-description-themes-12077-12079.test.ts
 *
 * #12077: descrição com o termo do D1 e o link da edição nas 2 primeiras
 * linhas, até 3 hashtags, e playlists temáticas (OpenAI, Google, Anthropic,
 * Brasil, Segurança) pelo config. `fetch` mockado: nenhum teste toca a rede.
 *
 * #12079: o CTA do fim do horizontal pede inscrição (decisão do editor,
 * 03/11/2026); o roteiro da montagem avisa quando o `cta_yt` gravado não pede.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  YOUTUBE_DESCRIPTION_MAX_BYTES,
  YOUTUBE_MAX_HASHTAGS,
  buildYouTubeDescription,
  buildYouTubeHashtags,
  detectYouTubeD1Actor,
  youtubeD1Themes,
} from "../scripts/lib/diaria/youtube-video.ts";
import {
  addVideoToThemePlaylists,
  describeThemePlaylists,
  planThemePlaylists,
  readThemePlaylistsConfig,
} from "../scripts/lib/diaria/youtube-theme-playlists.ts";
import { YOUTUBE_API_BASE, YOUTUBE_PUBLISHED_FILE, type YouTubeUploadDeps } from "../scripts/lib/diaria/youtube-upload.ts";
import { addToThemePlaylistsAfterUpload, planYouTubePublish, type YouTubePublishedRecord } from "../scripts/publish-youtube.ts";
import { YOUTUBE_CTA_SUBSCRIBE_TEXT, youtubeCtaSubscribeWarning } from "../scripts/lib/diaria/video-montage.ts";

const OPENAI_D1 = {
  title: "ChatGPT ganha memória para todos os usuários",
  body: "A OpenAI liberou a memória do ChatGPT para a conta gratuita.\n\nA função lembra preferências entre conversas.",
  url: "https://openai.com/x",
  category: "LANÇAMENTO",
};
const BR_GOLPE_D1 = {
  title: "Golpe com deepfake usa voz de parente no Brasil",
  body: "Criminosos brasileiros clonam a voz de familiares para pedir Pix.\n\nA polícia registrou 300 casos.",
  url: "https://g1.globo.com/x",
  category: "SEGURANÇA",
};
const NO_ACTOR_D1 = {
  title: "Estudo mede quanto a IA erra em diagnóstico",
  body: "Pesquisadores compararam modelos em 2 mil casos clínicos.",
  url: "https://exemplo.com/x",
  category: "🔬 PESQUISA",
};

describe("#12077 ator, hashtags e temas", () => {
  it("ator: o título pesa antes do corpo; rótulo é o termo buscado", () => {
    assert.deepEqual(
      { key: detectYouTubeD1Actor(OPENAI_D1)?.key, label: detectYouTubeD1Actor(OPENAI_D1)?.label },
      { key: "openai", label: "ChatGPT" },
    );
    assert.equal(detectYouTubeD1Actor({ title: "Claude lê PDFs inteiros", body: "A Anthropic mudou." })?.label, "Claude");
    assert.equal(detectYouTubeD1Actor({ title: "Novidade", body: "O Gemini do Google agora resume vídeos." })?.label, "Gemini");
    assert.equal(detectYouTubeD1Actor(NO_ACTOR_D1), null);
    assert.equal(detectYouTubeD1Actor({ title: "Metade das empresas", body: "metas de IA" }), null, "'Metade'/'metas' não é a Meta");
  });

  it("até 3 hashtags, #IA primeiro, sem repetição", () => {
    assert.deepEqual(buildYouTubeHashtags(OPENAI_D1), ["#IA", "#ChatGPT", "#OpenAI"]);
    assert.deepEqual(buildYouTubeHashtags(NO_ACTOR_D1), ["#IA", "#InteligênciaArtificial", "#Pesquisa"]);
    for (const d of [OPENAI_D1, BR_GOLPE_D1, NO_ACTOR_D1]) assert.ok(buildYouTubeHashtags(d).length <= YOUTUBE_MAX_HASHTAGS);
  });

  it("temas: ator com playlist, Brasil e segurança", () => {
    assert.deepEqual(youtubeD1Themes(OPENAI_D1), ["openai"]);
    assert.deepEqual(youtubeD1Themes(BR_GOLPE_D1), ["brasil", "seguranca"]);
    assert.deepEqual(youtubeD1Themes(NO_ACTOR_D1), []);
    assert.deepEqual(youtubeD1Themes({ ...OPENAI_D1, title: "Meta lança Llama 5", body: "A Meta abriu os pesos." }), [], "Meta não tem playlist");
  });
});

describe("#12077 descrição", () => {
  const desc = (d1: typeof OPENAI_D1) => buildYouTubeDescription({ aammdd: "261104", episode: 15, editionUrl: "https://diar.ia.br/p/x", d1 });

  it("2 primeiras linhas: 1ª frase com o termo do D1 + link da edição com UTM", () => {
    const lines = desc(OPENAI_D1).split("\n");
    assert.equal(lines[0], "A OpenAI liberou a memória do ChatGPT para a conta gratuita.");
    assert.equal(lines[1], "Leia a edição completa: https://diar.ia.br/p/x?utm_source=youtube&utm_medium=video&utm_campaign=261104");
  });

  it("1ª frase sem o ator ganha o termo na frente", () => {
    const d = desc({ ...OPENAI_D1, body: "A empresa liberou a memória para a conta gratuita." });
    assert.match(d.split("\n")[0], /^ChatGPT: A empresa liberou/);
  });

  it("resto do resumo, CTA e hashtags no fim (última linha)", () => {
    const d = desc(OPENAI_D1);
    assert.match(d, /A função lembra preferências entre conversas\./);
    assert.ok(d.includes("https://diar.ia.br/?utm_source=youtube&utm_medium=video&utm_campaign=261104"));
    assert.equal(d.split("\n").at(-1), "#IA #ChatGPT #OpenAI");
  });

  it("resumo gigante sem ponto: cabe em 5000 bytes com links e hashtags", () => {
    const d = desc({ ...OPENAI_D1, body: "ação ".repeat(3000) });
    assert.ok(Buffer.byteLength(d, "utf8") <= YOUTUBE_DESCRIPTION_MAX_BYTES);
    assert.ok(d.includes("utm_campaign=261104"));
    assert.equal(d.split("\n").at(-1), "#IA #ChatGPT #OpenAI");
  });

  it("frase longa + resto longo: o resto encolhe, cabeçalho e cauda intactos", () => {
    const d = desc({ ...OPENAI_D1, body: `Primeira frase curta da OpenAI.\n\n${"palavra ".repeat(1500)}` });
    assert.ok(Buffer.byteLength(d, "utf8") <= YOUTUBE_DESCRIPTION_MAX_BYTES);
    assert.equal(d.split("\n")[0], "Primeira frase curta da OpenAI.");
    assert.match(d, /…/);
  });
});

describe("#12077 playlists temáticas", () => {
  it("config: null pula, inválido avisa, tema desconhecido avisa", () => {
    const cfg = readThemePlaylistsConfig({ publishing: { youtube: { theme_playlists: { openai: "PLopenai", google: null, brasil: "", xyz: "PL1" } } } });
    assert.deepEqual(cfg.ids, { openai: "PLopenai" });
    assert.equal(cfg.warnings.length, 2);
    assert.deepEqual(readThemePlaylistsConfig({}).ids, {});
    assert.deepEqual(planThemePlaylists(["openai", "brasil"], cfg), [
      { theme: "openai", playlistId: "PLopenai" },
      { theme: "brasil", playlistId: null },
    ]);
  });

  it("o config real traz os 5 temas, cada um com ID de playlist e nenhum aviso", () => {
    const real = JSON.parse(readFileSync(join(import.meta.dirname, "..", "platform.config.json"), "utf8"));
    assert.deepEqual(Object.keys(real.publishing.youtube.theme_playlists).sort(), ["anthropic", "brasil", "google", "openai", "seguranca"]);
    const cfg = readThemePlaylistsConfig(real);
    assert.equal(cfg.warnings.length, 0);
    for (const theme of ["anthropic", "brasil", "google", "openai", "seguranca"] as const) {
      assert.match(cfg.ids[theme] ?? "", /^PL[\w-]{11,}$/, `theme_playlists.${theme}`);
    }
  });

  function deps() {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const d: YouTubeUploadDeps = {
      now: () => new Date("2026-11-04T10:00:00Z"),
      fetch: async (url, init) => {
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url: String(url), method, body: typeof init?.body === "string" ? init.body : undefined });
        if (String(url) === "https://oauth2.googleapis.com/token") return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
        if (method === "GET" && String(url).includes("/playlistItems?")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        if (method === "POST" && String(url) === `${YOUTUBE_API_BASE}/playlistItems?part=snippet`) return new Response(JSON.stringify({ id: "PLI" }), { status: 200 });
        throw new Error(`inesperado ${method} ${url}`);
      },
    };
    return { d, calls };
  }

  it("só o tema com ID chama a API; o log diz o resto", async () => {
    const { d, calls } = deps();
    const steps = planThemePlaylists(["brasil", "seguranca"], readThemePlaylistsConfig({ publishing: { youtube: { theme_playlists: { seguranca: "PLseg" } } } }));
    const res = await addVideoToThemePlaylists(d, { creds: { clientId: "c", clientSecret: "s", refreshToken: "r", channelId: "UC" }, steps, videoId: "vid1" });
    assert.equal(res.length, 1);
    assert.equal(res[0].theme, "seguranca");
    assert.equal(res[0].ok, true);
    assert.equal(calls.filter((c) => c.method === "POST" && c.url.includes("/playlistItems")).length, 1);
    const lines = describeThemePlaylists(steps, res);
    assert.match(lines[0], /"brasil" sem ID/);
    assert.match(lines[1], /adicionado na playlist temática "seguranca"/);
  });

  it("addToThemePlaylistsAfterUpload grava o resultado no registro e não repete o tema já ok", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yt-themes-12077-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      const reviewed = `DESTAQUE 1 | SEGURANÇA\n${BR_GOLPE_D1.title}\n${BR_GOLPE_D1.url}\n\n${BR_GOLPE_D1.body}\n\nPor que isso importa:\nPorque sim.\n`;
      const plan = planYouTubePublish({
        aammdd: "261104",
        reviewedMd: reviewed,
        now: new Date("2026-11-03T20:00:00Z"),
        video: { path: "v.mp4", exists: true, sizeBytes: 1 },
        thumb: { path: "t.jpg", exists: false },
      });
      assert.deepEqual(plan.themes, ["brasil", "seguranca"]);
      const rec = { aammdd: "261104", videoId: "vid1", url: "https://youtu.be/vid1" } as unknown as YouTubePublishedRecord;
      writeFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), JSON.stringify(rec));
      const themePlaylists = readThemePlaylistsConfig({ publishing: { youtube: { theme_playlists: { brasil: "PLbr", seguranca: "PLseg" } } } });
      const env = { GOOGLE_CLIENT_ID: "c", GOOGLE_CLIENT_SECRET: "s", YOUTUBE_REFRESH_TOKEN: "r", YOUTUBE_CHANNEL_ID: "UC" };
      const { d, calls } = deps();
      const out = await addToThemePlaylistsAfterUpload(d, { plan, editionDir: dir, env, log: () => {}, themePlaylists }, { exitCode: 0, record: rec, skipped: false });
      assert.equal(out.record?.theme_playlists?.length, 2);
      const saved = JSON.parse(readFileSync(join(dir, YOUTUBE_PUBLISHED_FILE), "utf8"));
      assert.equal(saved.theme_playlists.length, 2);
      const before = calls.length;
      const again = await addToThemePlaylistsAfterUpload(d, { plan, editionDir: dir, env, log: () => {}, themePlaylists }, { exitCode: 0, record: out.record, skipped: true });
      assert.equal(calls.length, before, "temas já ok para o mesmo vídeo: nenhuma chamada");
      assert.equal(again.record?.theme_playlists?.length, 2);
      // Exit != 0 (vídeo sem confirmação): passo não roda.
      const none = await addToThemePlaylistsAfterUpload(d, { plan, editionDir: dir, env, log: () => {}, themePlaylists }, { exitCode: 1, record: rec, skipped: false });
      assert.equal(none.record?.theme_playlists, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#12079 CTA do horizontal pede inscrição", () => {
  it("CTA de like (o das 3 edições medidas) → aviso com o texto novo", () => {
    const w = youtubeCtaSubscribeWarning(["Gostou desse vídeo? Dá um like."]);
    assert.ok(w);
    assert.match(w!, /pede like/);
    assert.ok(w!.includes(YOUTUBE_CTA_SUBSCRIBE_TEXT));
  });

  it("CTA que pede inscrição → sem aviso; sem cta_yt → sem aviso", () => {
    assert.equal(youtubeCtaSubscribeWarning([YOUTUBE_CTA_SUBSCRIBE_TEXT]), null);
    assert.equal(youtubeCtaSubscribeWarning(["Inscreva-se no canal."]), null);
    assert.equal(youtubeCtaSubscribeWarning([]), null);
  });

  it("CTA sem like e sem inscrição → aviso 'não pede inscrição'", () => {
    assert.match(youtubeCtaSubscribeWarning(["Até amanhã!"])!, /não pede inscrição/);
  });
});
