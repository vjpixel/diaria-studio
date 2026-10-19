/**
 * #10543 — o decode de redirect genérico (#10467) devolvia QUALQUER destino
 * http(s) de outro host: "Share on X", perfil do LinkedIn no rodapé e
 * redirect de login viravam artigos `inbox_newsletter:` sintéticos; e, com
 * `trackerDecoded=true`, o `isTrackingUrl` era pulado — um destino que é ele
 * mesmo um tracker (`link.mail.beehiiv.com`) passava. Os 3 casos são os do
 * probe da issue.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { processThreads, isRedirectNoiseDestination } from "../scripts/capture-newsletter-urls.ts";

const enc = encodeURIComponent;

function urlsFrom(urls: string[], sender = "AlphaSignal <news@alphasignal.ai>"): string[] {
  const { articles } = processThreads(
    [{ thread_id: "t1", sender, subject: "s", date: "2026-10-18T14:59:00Z", body: "sem links", urls_extraidas: urls }],
    { processed_thread_ids: [] },
  );
  return articles.map((a) => a.url);
}

describe("#10543: destino de redirect que é rodapé/share/login não vira candidato", () => {
  it("os 3 casos do probe da issue caem; o artigo do mesmo wrapper passa", () => {
    const got = urlsFrom([
      `https://link.alphasignal.ai/c?url=${enc("https://twitter.com/intent/tweet?text=hi")}`,
      `https://link.alphasignal.ai/c?url=${enc("https://www.linkedin.com/company/alphasignal/")}`,
      `https://alphasignal.ai/login?redirect=${enc("https://accounts.google.com/o")}`,
      `https://link.alphasignal.ai/c?url=${enc("https://arxiv.org/abs/2610.00001")}`,
    ]);
    assert.deepEqual(got, ["https://arxiv.org/abs/2610.00001"]);
  });

  it("wrapper de login cai mesmo com destino que parece artigo", () => {
    assert.deepEqual(urlsFrom([`https://alphasignal.ai/login?redirect=${enc("https://arxiv.org/abs/1")}`]), []);
  });

  it("destino decodificado que é ele mesmo um tracker conhecido cai", () => {
    assert.deepEqual(
      urlsFrom([`https://link.alphasignal.ai/c?url=${enc("https://link.mail.beehiiv.com/ss/c/abc")}`]),
      [],
    );
  });

  it("post de rede social decodificado continua candidato", () => {
    const got = urlsFrom([
      `https://link.alphasignal.ai/c?url=${enc("https://x.com/OpenAI/status/1890000000000000000")}`,
      `https://link.alphasignal.ai/c?url=${enc("https://www.linkedin.com/posts/fulano_ai-activity-123")}`,
    ]);
    assert.equal(got.length, 2);
  });

  it("link social DIRETO (sem wrapper) segue a regra antiga", () => {
    assert.equal(urlsFrom(["https://www.linkedin.com/company/alphasignal/"]).length, 1);
  });
});

describe("isRedirectNoiseDestination", () => {
  for (const u of [
    "https://twitter.com/intent/tweet?text=x",
    "https://x.com/intent/post?text=x",
    "https://www.facebook.com/sharer/sharer.php?u=x",
    "https://www.linkedin.com/sharing/share-offsite/?url=x",
    "https://www.linkedin.com/shareArticle?url=x",
    "https://www.linkedin.com/in/fulano",
    "https://x.com/alphasignalai",
    "https://www.instagram.com/alphasignal/",
    "https://www.youtube.com/@alphasignal",
    "https://bsky.app/profile/alpha.bsky.social",
    "https://wa.me/?text=x",
    "https://accounts.google.com/o/oauth2/auth",
    "https://example.com/oauth/authorize?client_id=1",
  ]) {
    it(`ruído: ${u}`, () => assert.equal(isRedirectNoiseDestination(u), true));
  }
  for (const u of [
    "https://arxiv.org/abs/1",
    "https://x.com/OpenAI/status/1",
    "https://www.youtube.com/watch?v=abc",
    "https://www.instagram.com/p/abc/",
    "https://bsky.app/profile/alpha.bsky.social/post/3k",
    "https://example.com/blog/login-com-passkeys",
    "https://example.com/how-to-share-prompts",
    "nao-e-url",
  ]) {
    it(`conteúdo: ${u}`, () => assert.equal(isRedirectNoiseDestination(u), false));
  }
});
