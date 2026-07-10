/**
 * lint-newsletter-md-video-links-are-youtube.test.ts (#3202)
 *
 * Regressão: item da seção VÍDEOS com URL fora de youtube.com/youtu.be deve
 * disparar o check `--check video-links-are-youtube` (GATE-BLOCKING).
 *
 * Caso real (260709): a página oficial da OpenAI hospedando a livestream
 * "Introducing GPT-Live" bloqueou o bot (403) e acabou usada como URL do
 * vídeo — mesma URL de um destaque, gerando duplicação. Este lint é o
 * backstop que pega esse caso mesmo se a resolução automática (Stage 1,
 * `scripts/resolve-video-youtube.ts`) for pulada ou o editor colar um link
 * não-YouTube manualmente no Drive.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkVideoLinksAreYoutube } from "../scripts/lint-newsletter-md.ts";

function videoSection(items: string): string {
  return `**📺 VÍDEOS**\n\n${items}\n---\n`;
}

describe("checkVideoLinksAreYoutube — CENÁRIO REAL #3202", () => {
  it("acusa item VÍDEOS com URL da página oficial (bloqueio de bot, não-YouTube)", () => {
    const md = videoSection(
      `**Introducing GPT-Live** — [OpenAI]\n\nhttps://openai.com/index/introducing-gpt-live/\n\nApresentação ao vivo do novo modelo multimodal.\n`,
    );
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].url, "https://openai.com/index/introducing-gpt-live/");
  });

  it("passa quando o item VÍDEOS já usa a URL do YouTube (youtu.be)", () => {
    const md = videoSection(
      `**Introducing GPT-Live** — [OpenAI]\n\nhttps://youtu.be/EAN5Cj347PY\n\nApresentação ao vivo do novo modelo multimodal.\n`,
    );
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });
});

describe("checkVideoLinksAreYoutube — formatos de URL do YouTube aceitos", () => {
  it("aceita youtube.com/watch?v=", () => {
    const md = videoSection(
      `**Título** — [Canal]\n\nhttps://www.youtube.com/watch?v=EAN5Cj347PY\n\nDescrição.\n`,
    );
    assert.ok(checkVideoLinksAreYoutube(md).ok);
  });

  it("aceita youtu.be", () => {
    const md = videoSection(
      `**Título** — [Canal]\n\nhttps://youtu.be/EAN5Cj347PY\n\nDescrição.\n`,
    );
    assert.ok(checkVideoLinksAreYoutube(md).ok);
  });

  it("rejeita vimeo.com (regra #3202 exige especificamente YouTube)", () => {
    const md = videoSection(
      `**Título** — [Canal]\n\nhttps://vimeo.com/123456\n\nDescrição.\n`,
    );
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].url, "https://vimeo.com/123456");
  });

  it("rejeita youtube.com sem /watch (ex: canal, não vídeo)", () => {
    const md = videoSection(
      `**Título** — [Canal]\n\nhttps://www.youtube.com/@OpenAI\n\nDescrição.\n`,
    );
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, false);
  });
});

describe("checkVideoLinksAreYoutube — múltiplos itens e boundary cases", () => {
  it("acusa só o item não-YouTube quando há 2 vídeos (1 ok + 1 não-ok)", () => {
    const md = videoSection(
      `**Vídeo A** — [Canal A]\n\nhttps://youtu.be/AAAA\n\nDescrição A.\n\n` +
        `**Vídeo B** — [Canal B]\n\nhttps://blog.example.com/live-b\n\nDescrição B.\n`,
    );
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].url, "https://blog.example.com/live-b");
  });

  it("ok=true quando a seção VÍDEOS está ausente do MD (seção opcional)", () => {
    const md = `**🚀 LANÇAMENTOS**\n\n**[Ferramenta X](https://x.com/release)**\nLançamento.\n\n---\n`;
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("não confunde URL não-YouTube em RADAR com a seção VÍDEOS (escopo isolado por seção)", () => {
    const md =
      `**📡 RADAR**\n\n**[Artigo sobre vídeo](https://blog.example.com/nao-e-video-de-verdade)**\nAnálise.\n\n---\n\n` +
      videoSection(`**Vídeo A** — [Canal]\n\nhttps://youtu.be/BBBB\n\nDescrição.\n`);
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("dedup: URL repetida na mesma linha (markdown link) conta 1 erro só", () => {
    const md = videoSection(
      `[Introducing GPT-Live](https://openai.com/index/introducing-gpt-live/)\n\nDescrição.\n`,
    );
    const result = checkVideoLinksAreYoutube(md);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
  });
});
