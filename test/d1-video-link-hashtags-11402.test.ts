/**
 * #11402 — na edição 261028 o `_internal/05-video-url.txt` existia antes do
 * Stage 5, mas o D1 do X saiu sem o link do vídeo: o texto curto, com o link,
 * ficava com 287 de 280 (peso X) e `injectVideoLinkWithinLimit` desistia do
 * link inteiro. Agora, antes de desistir, tenta sem as hashtags do fim.
 *
 * Fixture: o `# Curto` real do D1 da 261028.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  D1_VIDEO_URL_FILE,
  injectVideoLinkWithinLimit,
  stripTrailingHashtagLines,
  videoLinkLine,
} from "../scripts/lib/diaria/d1-video-link.ts";
import { prepTwitterPosts, computeTwitterWeightedLength, TWITTER_CHAR_LIMIT } from "../scripts/prep-twitter-posts.ts";

const VIDEO = "https://youtu.be/wZrR8-qKotA";
const EDITION_URL = "https://diar.ia.br/p/openai-lanca-gpt-6-1-terra-pela-metade-do-preco";

const CURTO_D1_261028 = [
  "A OpenAI lançou o GPT-6.1 Terra, feito para usar o computador: US$ 1 por milhão de tokens de entrada e US$ 5 de saída, 50% menos que o GPT-5.6 Terra. Já está no ChatGPT Work, no Codex e na API.",
  "",
  "Mais em {edition_url}",
  "",
  "#OpenAI #GPT61",
].join("\n");

const SOCIAL_MD_261028 = [
  "# Curto",
  "",
  "## d1",
  "",
  CURTO_D1_261028,
  "",
  "## d2",
  "",
  "A Siri reformulada com IA generativa passou a falar português com o iOS 27.2. Mais em {edition_url}",
  "",
  "#Siri #Apple #iOS27",
  "",
].join("\n");

describe("stripTrailingHashtagLines (#11402)", () => {
  it("tira só a(s) linha(s) de hashtags do fim, inclusive com acento", () => {
    assert.equal(stripTrailingHashtagLines("Texto.\n\nLeia: x\n\n#OpenAI #GPT61"), "Texto.\n\nLeia: x");
    assert.equal(stripTrailingHashtagLines("Texto.\n\n#OpenAI #Segurança\n#Extra\n\n"), "Texto.");
  });

  it("sem hashtag no fim, devolve o texto igual (hashtag no meio fica)", () => {
    const t = "Fala de #OpenAI no meio.\n\nLeia: x";
    assert.equal(stripTrailingHashtagLines(t), t);
    assert.equal(stripTrailingHashtagLines("Só texto.\n\n"), "Só texto.\n\n");
  });
});

describe("injectVideoLinkWithinLimit — fallback sem hashtags (#11402)", () => {
  it("o D1 curto da 261028 recebe o link no X, sem as hashtags", () => {
    const text = CURTO_D1_261028.replace("{edition_url}", EDITION_URL);
    const r = injectVideoLinkWithinLimit(text, VIDEO, TWITTER_CHAR_LIMIT, computeTwitterWeightedLength);
    assert.equal(r.injected, true, JSON.stringify(r));
    assert.ok(r.injected && r.droppedHashtags);
    assert.ok(r.text.includes(videoLinkLine(VIDEO)), r.text);
    assert.ok(r.text.indexOf(VIDEO) < r.text.indexOf(EDITION_URL), "vídeo é o 1º link (card do X)");
    assert.ok(!r.text.includes("#OpenAI"), r.text);
    assert.ok(computeTwitterWeightedLength(r.text) <= TWITTER_CHAR_LIMIT);
  });

  it("cabendo inteiro, mantém as hashtags", () => {
    const r = injectVideoLinkWithinLimit("Curto. Leia: https://diar.ia.br/p/x\n\n#OpenAI", VIDEO, 500);
    assert.ok(r.injected && !r.droppedHashtags);
    assert.ok(r.text.endsWith("#OpenAI"));
  });

  it("nem sem hashtags cabe: texto ORIGINAL intacto, com motivo", () => {
    const text = `${"x".repeat(270)}\n\n#OpenAI`;
    const r = injectVideoLinkWithinLimit(text, VIDEO, TWITTER_CHAR_LIMIT, computeTwitterWeightedLength);
    assert.equal(r.injected, false);
    assert.equal(r.text, text);
    assert.match(!r.injected ? r.reason : "", /sem as hashtags/);
  });
});

describe("Stage 5 X: fixture da 261028 com 05-video-url.txt (#11402)", () => {
  it("o post do D1 sai com o link do vídeo; D2 intocado", () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-video-11402-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "03-social.md"), SOCIAL_MD_261028);
      writeFileSync(join(dir, "_internal", "05-edition-url.txt"), EDITION_URL + "\n");
      writeFileSync(join(dir, D1_VIDEO_URL_FILE), VIDEO + "\n");
      const r = prepTwitterPosts(dir, {
        editionDate: "271231",
        now: new Date("2027-12-01T12:00:00Z").getTime(),
        logRootDir: dir,
      });
      const d1 = r.posts.find((p) => p.destaque === "d1");
      assert.ok(d1, JSON.stringify(r.skipped));
      assert.ok(d1.text.includes(VIDEO), d1.text);
      assert.ok(computeTwitterWeightedLength(d1.text) <= TWITTER_CHAR_LIMIT);
      const d2 = r.posts.find((p) => p.destaque === "d2");
      assert.ok(d2 && !d2.text.includes("youtu") && d2.text.includes("#Siri"), d2?.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
