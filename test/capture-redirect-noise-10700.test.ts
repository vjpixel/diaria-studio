/**
 * #10700 itens 1-2 — casos de borda do #10673 em `isRedirectNoiseDestination`:
 * - Facebook: `/reel` e `/videos` sem ID passavam como conteúdo; `story_fbid`
 *   na query era aceito em qualquer path (inclusive `/profile.php`).
 * - Instagram/Threads (e páginas do Facebook): aba de perfil com 2 segmentos
 *   (`instagram.com/user/reels/`) passava como conteúdo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isRedirectNoiseDestination } from "../scripts/capture-newsletter-urls.ts";

describe("#10700 item 1 — Facebook sem ID / story_fbid fora do endpoint", () => {
  for (const u of [
    "https://www.facebook.com/reel",
    "https://www.facebook.com/reel/",
    "https://www.facebook.com/videos",
    "https://www.facebook.com/videos/",
    "https://www.facebook.com/profile.php?id=100&story_fbid=1",
    "https://www.facebook.com/diaria?story_fbid=1",
    "https://www.facebook.com/permalink.php?id=2",
    "https://www.facebook.com/photo.php",
    "https://www.facebook.com/video.php",
    "https://www.facebook.com/share/p/",
  ]) {
    it(`ruído: ${u}`, () => assert.equal(isRedirectNoiseDestination(u), true));
  }
  for (const u of [
    "https://www.facebook.com/reel/123",
    "https://www.facebook.com/videos/123/",
    "https://www.facebook.com/permalink.php?story_fbid=1&id=2",
    "https://m.facebook.com/story.php?story_fbid=1&id=2",
    "https://www.facebook.com/photo.php?fbid=1",
    "https://www.facebook.com/video.php?v=1",
    "https://www.facebook.com/share/v/AbC123/",
  ]) {
    it(`conteúdo: ${u}`, () => assert.equal(isRedirectNoiseDestination(u), false));
  }
});

describe("#10700 item 2 — aba de perfil com 2 segmentos é perfil", () => {
  for (const u of [
    "https://www.instagram.com/openai/reels/",
    "https://www.instagram.com/openai/tagged/",
    "https://www.instagram.com/openai/saved",
    "https://www.threads.net/@openai/replies",
    "https://www.threads.com/@openai/reposts",
    "https://www.threads.net/@openai/post",
    "https://www.facebook.com/diaria/videos",
    "https://www.facebook.com/diaria/reels/",
  ]) {
    it(`ruído: ${u}`, () => assert.equal(isRedirectNoiseDestination(u), true));
  }
  for (const u of [
    "https://www.instagram.com/p/abc/",
    "https://www.instagram.com/reel/abc/",
    "https://www.instagram.com/reels/abc/",
    "https://www.instagram.com/tv/abc/",
    "https://www.instagram.com/openai/p/abc/",
    "https://www.threads.net/@openai/post/abc",
    "https://www.threads.net/t/abc",
    "https://www.facebook.com/diaria/videos/123",
    "https://www.facebook.com/diaria/posts/pfbid0abc",
  ]) {
    it(`conteúdo: ${u}`, () => assert.equal(isRedirectNoiseDestination(u), false));
  }
});
