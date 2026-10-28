/**
 * #10772 — link do vídeo do dia no post do D1 (LinkedIn página, X, Threads,
 * Facebook diar.ia.br). Miolo puro + integração no prep do X e no helper do
 * Facebook.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  D1_VIDEO_URL_FILE,
  buildLinkedInVideoComment,
  extractYouTubeVideoId,
  injectVideoLinkWithinLimit,
  insertVideoLinkLine,
  normalizeYouTubeVideoUrl,
  parseD1VideoUrlFile,
  planD1VideoLink,
  textHasVideoLink,
  videoLinkLine,
  type D1PostEntryLike,
} from "../scripts/lib/diaria/d1-video-link.ts";
import { readD1VideoUrl } from "../scripts/lib/diaria/d1-video-link-file.ts";
import { prepTwitterPosts, computeTwitterWeightedLength, TWITTER_CHAR_LIMIT } from "../scripts/prep-twitter-posts.ts";
import { withD1VideoLink } from "../scripts/publish-facebook.ts";

const ID = "dQw4w9WgXcQ";
const VIDEO = `https://youtu.be/${ID}`;

describe("extractYouTubeVideoId / normalizeYouTubeVideoUrl", () => {
  it("aceita watch, youtu.be, shorts, live, embed e m.youtube.com", () => {
    for (const u of [
      `https://www.youtube.com/watch?v=${ID}&t=10s`,
      `https://youtu.be/${ID}?si=abc`,
      `https://youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://m.youtube.com/watch?v=${ID}`,
    ]) {
      assert.equal(extractYouTubeVideoId(u), ID, u);
      assert.equal(normalizeYouTubeVideoUrl(u), VIDEO, u);
    }
  });

  it("recusa canal, outro host e id malformado — nunca adivinha", () => {
    for (const u of [
      "https://www.youtube.com/@diariabr",
      "https://vimeo.com/123",
      "https://youtu.be/curto",
      "not a url",
      `ftp://youtu.be/${ID}`,
    ]) {
      assert.equal(extractYouTubeVideoId(u), null, u);
      assert.throws(() => normalizeYouTubeVideoUrl(u), /YouTube/);
    }
  });
});

describe("insertVideoLinkLine", () => {
  it("entra ANTES da 1ª linha com URL — vira o 1º link do texto (card do X)", () => {
    const text = "Post do D1 sobre IA.\nLeia: https://diar.ia.br/p/x?utm_source=twitter";
    const out = insertVideoLinkLine(text, VIDEO);
    assert.equal(out, `Post do D1 sobre IA.\n\n${videoLinkLine(VIDEO)}\n\nLeia: https://diar.ia.br/p/x?utm_source=twitter`);
    assert.ok(out.indexOf("youtu.be") < out.indexOf("diar.ia.br/p/x"));
  });

  it("sem URL no texto, vai pro fim", () => {
    assert.equal(insertVideoLinkLine("Só texto.\n", VIDEO), `Só texto.\n\n${videoLinkLine(VIDEO)}`);
  });

  it("idempotente, inclusive com o vídeo em outra forma de URL", () => {
    const once = insertVideoLinkLine("A https://x.com", VIDEO);
    assert.equal(insertVideoLinkLine(once, VIDEO), once);
    const other = `Veja https://www.youtube.com/watch?v=${ID}.`;
    assert.ok(textHasVideoLink(other, VIDEO));
    assert.equal(insertVideoLinkLine(other, VIDEO), other);
  });
});

describe("injectVideoLinkWithinLimit", () => {
  it("estourar o limite devolve o texto ORIGINAL com motivo (nunca derruba o post)", () => {
    const text = "x".repeat(270);
    const r = injectVideoLinkWithinLimit(text, VIDEO, TWITTER_CHAR_LIMIT, computeTwitterWeightedLength);
    assert.equal(r.injected, false);
    assert.equal(r.text, text);
  });

  it("cabendo, insere", () => {
    const r = injectVideoLinkWithinLimit("Curto.", VIDEO, 500);
    assert.deepEqual(r, { injected: true, text: `Curto.\n\n${videoLinkLine(VIDEO)}`, droppedHashtags: false });
  });
});

describe("parseD1VideoUrlFile / readD1VideoUrl", () => {
  it("1ª linha não vazia, normalizada; vazio → null", () => {
    assert.equal(parseD1VideoUrlFile(`\n  https://www.youtube.com/watch?v=${ID}  \n`), VIDEO);
    assert.equal(parseD1VideoUrlFile("\n\n"), null);
  });

  it("arquivo ausente = null sem aviso; inválido = null com aviso (fail-soft)", () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-video-"));
    try {
      assert.deepEqual(readD1VideoUrl(dir), { url: null, warning: null });
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, D1_VIDEO_URL_FILE), "https://vimeo.com/1\n");
      const r = readD1VideoUrl(dir);
      assert.equal(r.url, null);
      assert.match(r.warning ?? "", /YouTube/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("planD1VideoLink", () => {
  const now = new Date("2026-10-22T10:00:00Z");
  const entry = (platform: string, over: Partial<D1PostEntryLike> = {}): D1PostEntryLike => ({
    platform,
    destaque: "d1",
    status: "scheduled",
    scheduled_at: "2026-10-22T15:00:00Z",
    url: null,
    ...over,
  });

  it("agendado com folga: edita X/Threads/Facebook; LinkedIn sempre comentário", () => {
    const steps = planD1VideoLink({
      videoUrl: VIDEO,
      now,
      entries: [entry("linkedin"), entry("twitter"), entry("threads"), entry("facebook")],
      postTexts: { twitter: "D1 https://diar.ia.br/p/x" },
    });
    const by = Object.fromEntries(steps.map((s) => [s.destination, s]));
    assert.equal(by.linkedin.action, "comment_after");
    assert.equal(by.linkedin.text, buildLinkedInVideoComment(VIDEO));
    assert.equal(by.twitter.action, "edit_scheduled");
    assert.equal(by.twitter.text, insertVideoLinkLine("D1 https://diar.ia.br/p/x", VIDEO));
    assert.equal(by.threads.action, "edit_scheduled");
    assert.equal(by.threads.text, null, "sem texto atual, só link_line");
    assert.equal(by.facebook.action, "edit_scheduled");
  });

  it("já publicado ou a menos de 10 min do disparo: comentar/responder", () => {
    const steps = planD1VideoLink({
      videoUrl: VIDEO,
      now,
      entries: [
        entry("twitter", { scheduled_at: "2026-10-22T10:05:00Z" }),
        entry("threads", { status: "published", scheduled_at: "2026-10-22T15:00:00Z" }),
        entry("facebook", { scheduled_at: "2026-10-22T09:00:00Z" }),
      ],
    });
    const by = Object.fromEntries(steps.map((s) => [s.destination, s]));
    for (const d of ["twitter", "threads", "facebook"]) {
      assert.equal(by[d].action, "comment_after", d);
      assert.equal(by[d].text, videoLinkLine(VIDEO));
    }
    assert.equal(by.linkedin.action, "no_post");
  });

  it("ignora outras páginas do Facebook, subtipos auxiliares, d2 e falhas", () => {
    const steps = planD1VideoLink({
      videoUrl: VIDEO,
      now,
      entries: [
        entry("facebook", { page: "vjpixel" }),
        entry("linkedin", { subtype: "comment_pixel" }),
        entry("twitter", { destaque: "d2" }),
        entry("threads", { status: "failed" }),
      ],
    });
    assert.deepEqual(
      steps.map((s) => s.action),
      ["no_post", "no_post", "no_post", "no_post"],
    );
  });

  it("texto atual já com o link: already_in_post (injetado no Stage 5)", () => {
    const steps = planD1VideoLink({
      videoUrl: VIDEO,
      now,
      entries: [entry("twitter")],
      postTexts: { twitter: insertVideoLinkLine("D1", VIDEO) },
    });
    assert.equal(steps.find((s) => s.destination === "twitter")!.action, "already_in_post");
  });
});

describe("Stage 5: link entra no D1 quando _internal/05-video-url.txt existe", () => {
  const MD = "# Curto\n\n## d1\nPost d1. Leia: {edition_url}\n\n## d2\nPost d2. Leia: {edition_url}\n";
  const EDITION_URL = "https://diar.ia.br/p/edicao-teste";

  it("X: link do vídeo é o 1º link do D1; D2 intocado", () => {
    const dir = mkdtempSync(join(tmpdir(), "d1-video-x-"));
    try {
      mkdirSync(join(dir, "_internal"), { recursive: true });
      writeFileSync(join(dir, "03-social.md"), MD);
      writeFileSync(join(dir, "_internal", "05-edition-url.txt"), EDITION_URL + "\n");
      writeFileSync(join(dir, D1_VIDEO_URL_FILE), `https://www.youtube.com/watch?v=${ID}\n`);
      const r = prepTwitterPosts(dir, {
        editionDate: "271231",
        now: new Date("2027-12-01T12:00:00Z").getTime(),
      });
      const d1 = r.posts.find((p) => p.destaque === "d1")!;
      const d2 = r.posts.find((p) => p.destaque === "d2")!;
      assert.ok(d1.text.includes(VIDEO), d1.text);
      assert.ok(d1.text.indexOf(VIDEO) < d1.text.indexOf("diar.ia.br/p/edicao-teste"));
      assert.ok(!d2.text.includes("youtu"), d2.text);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Facebook: só no D1 da página diar.ia.br", () => {
    const cap = "Post D1.\n\nAssine: https://diar.ia.br";
    assert.equal(withD1VideoLink(cap, "d1", "diaria", VIDEO), insertVideoLinkLine(cap, VIDEO));
    assert.equal(withD1VideoLink(cap, "d1", "vjpixel", VIDEO), cap);
    assert.equal(withD1VideoLink(cap, "d2", "diaria", VIDEO), cap);
    assert.equal(withD1VideoLink(cap, "d1", "diaria", null), cap);
  });
});
