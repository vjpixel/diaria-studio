/**
 * test/serie-video-renomeada-13317.test.ts (#13317)
 *
 * Em 16/11/2026 o editor renomeou o podcast do YouTube de "diar.ia.br
 * comentada" para "diar.ia.br: notícias de IA", e a série de vídeos passou a
 * usar o mesmo nome. Trava as superfícies públicas que o pipeline gera: a tag
 * fixa do upload no YouTube, a página `/videos` do site (gerada e
 * commitada) e o texto das skills que escolhem a playlist da tela final.
 *
 * Fora de escopo, de propósito (corpo da issue): nomes de sequência/export do
 * Premiere (`Diaria comentada horizontal_V{n}`, `Diaria comentada_Vertical_V{n}`)
 * e o nome de arquivo `diaria-comentada-{AAMMDD}.mp4`, que o fetch do Drive
 * reconhece nos exports antigos.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  YOUTUBE_BASE_TAGS,
  YOUTUBE_SERIES_NAME,
  YOUTUBE_TAGS_MAX_CHARS,
  buildYouTubeTags,
} from "../scripts/lib/diaria/youtube-video.ts";
import { buildVideosPageHtml } from "../scripts/lib/site-videos-page.ts";
import { buildVideoDoMesHtml } from "../scripts/lib/mensal/clarice-video-do-mes.ts";

const ROOT = join(import.meta.dirname, "..");
const OLD_NAME = /diar\.ia\.br comentada/i;

describe("#13317: série de vídeos renomeada para \"diar.ia.br: notícias de IA\"", () => {
  it("nome da série é o do podcast", () => {
    assert.equal(YOUTUBE_SERIES_NAME, "diar.ia.br: notícias de IA");
  });

  it("tags do upload levam o nome novo e nenhuma o antigo", () => {
    assert.ok((YOUTUBE_BASE_TAGS as readonly string[]).includes(YOUTUBE_SERIES_NAME));
    const tags = buildYouTubeTags("SEGURANÇA");
    assert.ok(tags.includes(YOUTUBE_SERIES_NAME), JSON.stringify(tags));
    for (const t of tags) assert.doesNotMatch(t, OLD_NAME);
    // Nenhum caractere que a API recusa, e o orçamento de 500 segue valendo.
    for (const t of tags) assert.doesNotMatch(t, /[<>,]/);
    const total = tags.reduce((s, t) => s + t.length + (/\s/.test(t) ? 2 : 0), 0) + tags.length - 1;
    assert.ok(total <= YOUTUBE_TAGS_MAX_CHARS, `tags somam ${total}`);
  });

  it("página /videos (com e sem vídeos) não diz o nome antigo", () => {
    for (const html of [buildVideosPageHtml([]), buildVideosPageHtml([
      {
        slug: "x",
        url: "https://diar.ia.br/p/x",
        videoId: "abcDEF12345",
        title: "Título",
        date: "2026-11-16",
        uploadDate: "2026-11-16",
        description: "Descrição.",
      },
    ])]) {
      assert.doesNotMatch(html, OLD_NAME);
      assert.match(html, /diar\.ia\.br: notícias de IA/);
    }
  });

  it("página /videos commitada não diz o nome antigo", () => {
    const html = readFileSync(join(ROOT, "workers", "site", "public", "videos", "index.html"), "utf8");
    assert.doesNotMatch(html, OLD_NAME);
    assert.match(html, /diar\.ia\.br: notícias de IA/);
  });

  it("título do YouTube com o nome novo não vira autolink no e-mail da Clarice", () => {
    const html = buildVideoDoMesHtml({ cycle: "2611-12", videoId: "abcDEF12345", title: YOUTUBE_SERIES_NAME, frase: "Frase." });
    const h2 = html.match(/<h2[^>]*>(.*?)<\/h2>/)![1];
    assert.ok(!h2.includes("diar.ia.br"), h2);
  });

  it("skills e fact-checker descrevem a série com o nome novo", () => {
    const files = [
      ".claude/skills/diaria-publica/SKILL.md",
      ".claude/skills/diaria-video-montagem/SKILL.md",
      ".claude/skills/diaria-video-roteiro/SKILL.md",
      ".claude/agents/fact-checker.md",
    ];
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), "utf8");
      // O nome antigo só pode sobrar como histórico explícito ("até 16/11/2026").
      for (const line of text.split("\n")) {
        if (!OLD_NAME.test(line)) continue;
        assert.match(line, /até 16\/11\/2026/, `${f}: nome antigo fora de contexto histórico: ${line.slice(0, 160)}`);
      }
      // O `description:` do frontmatter não aceita ": " sem aspas (YAML), por
      // isso as skills citam a série como `série "notícias de IA"`.
      assert.match(text, /diar\.ia\.br: notícias de IA|série "notícias de IA"/, f);
    }
  });
});
