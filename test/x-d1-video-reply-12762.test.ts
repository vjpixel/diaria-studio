/**
 * #12762 — na edição 261111 o link do vídeo não coube no D1 do X (317 chars,
 * 300 sem as hashtags) e `prep-twitter-posts.ts` avisou "link fica para
 * depois", mas nenhum passo postava essa resposta. Agora o post do D1 sai com
 * `videoReply`, que o Stage 5 (passo 5c-3b) põe como 2º item da thread do
 * mesmo `create_post` da Buffer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { D1_VIDEO_URL_FILE, buildTwitterVideoReplyText, videoLinkLine } from "../scripts/lib/diaria/d1-video-link.ts";
import { prepTwitterPosts, computeTwitterWeightedLength, TWITTER_CHAR_LIMIT } from "../scripts/prep-twitter-posts.ts";

const VIDEO = "https://youtu.be/wZrR8-qKotA";
const EDITION_URL = "https://diar.ia.br/p/d1-longo";

/** Texto curto do D1 que cabe sozinho, mas não com a linha do vídeo. */
const LONG_D1 = `${"Texto longo do destaque. ".repeat(9).trim()} Mais em {edition_url}\n\n#IA`;

function socialMd(d1: string): string {
  return ["# Curto", "", "## d1", "", d1, "", "## d2", "", "D2 curto. Mais em {edition_url}", ""].join("\n");
}

function run(d1: string, withVideo = true) {
  const dir = mkdtempSync(join(tmpdir(), "x-video-reply-12762-"));
  try {
    mkdirSync(join(dir, "_internal"), { recursive: true });
    writeFileSync(join(dir, "03-social.md"), socialMd(d1));
    writeFileSync(join(dir, "_internal", "05-edition-url.txt"), EDITION_URL + "\n");
    if (withVideo) writeFileSync(join(dir, D1_VIDEO_URL_FILE), VIDEO + "\n");
    return prepTwitterPosts(dir, {
      editionDate: "271231",
      now: new Date("2027-12-01T12:00:00Z").getTime(),
      logRootDir: dir,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("D1 do X: link do vídeo que não cabe vira resposta (#12762)", () => {
  it("o texto do D1 fica intacto e o post leva videoReply com o link", () => {
    const r = run(LONG_D1);
    const d1 = r.posts.find((p) => p.destaque === "d1");
    assert.ok(d1, JSON.stringify(r.skipped));
    assert.ok(!d1.text.includes("youtu"), "link não entrou no texto");
    assert.ok(computeTwitterWeightedLength(d1.text) <= TWITTER_CHAR_LIMIT);
    assert.deepEqual(d1.videoReply, { text: videoLinkLine(VIDEO) });
    assert.ok(computeTwitterWeightedLength(d1.videoReply!.text) <= TWITTER_CHAR_LIMIT);
  });

  it("D2 nunca leva resposta", () => {
    const d2 = run(LONG_D1).posts.find((p) => p.destaque === "d2");
    assert.ok(d2);
    assert.equal(d2.videoReply ?? null, null);
  });

  it("link coube no texto: sem resposta (nunca duplica o link)", () => {
    const d1 = run("Curto. Mais em {edition_url}").posts.find((p) => p.destaque === "d1");
    assert.ok(d1 && d1.text.includes(VIDEO), d1?.text);
    assert.equal(d1.videoReply, null);
  });

  it("texto já cita o vídeo: sem resposta", () => {
    const d1 = run(`Veja ${VIDEO} e mais em {edition_url}`).posts.find((p) => p.destaque === "d1");
    assert.ok(d1);
    assert.equal(d1.videoReply, null);
  });

  it("sem vídeo do dia: sem resposta", () => {
    const d1 = run(LONG_D1, false).posts.find((p) => p.destaque === "d1");
    assert.ok(d1);
    assert.equal(d1.videoReply, null);
  });

  it("buildTwitterVideoReplyText usa a mesma linha dos outros destinos", () => {
    assert.equal(buildTwitterVideoReplyText(VIDEO), `Assista no YouTube: ${VIDEO}`);
  });
});
