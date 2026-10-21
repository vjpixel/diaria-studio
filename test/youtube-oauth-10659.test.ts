import { test } from "node:test";
import assert from "node:assert/strict";
import {
  YOUTUBE_OAUTH_REDIRECT_URI,
  buildYouTubeAuthUrl,
  checkAuthorizedChannel,
  explainYouTubeApiError,
  parseChannelsResponse,
} from "../scripts/lib/youtube-oauth.ts";

test("auth URL pede youtube.upload + readonly, offline, consent e state", () => {
  const u = new URL(buildYouTubeAuthUrl("cid-123", "st4te"));
  assert.equal(u.searchParams.get("client_id"), "cid-123");
  assert.equal(u.searchParams.get("redirect_uri"), YOUTUBE_OAUTH_REDIRECT_URI);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.match(u.searchParams.get("prompt") ?? "", /consent/);
  assert.equal(u.searchParams.get("state"), "st4te");
  const scopes = (u.searchParams.get("scope") ?? "").split(" ");
  assert.ok(scopes.includes("https://www.googleapis.com/auth/youtube.upload"));
  assert.ok(scopes.includes("https://www.googleapis.com/auth/youtube.readonly"));
  // nunca herda os escopos do token compartilhado (Drive/Gmail)
  assert.ok(!scopes.some((s) => /drive|gmail/.test(s)));
});

test("parseChannelsResponse tolera corpo malformado e itens sem id", () => {
  assert.deepEqual(parseChannelsResponse(null), []);
  assert.deepEqual(parseChannelsResponse({ items: "x" }), []);
  assert.deepEqual(
    parseChannelsResponse({ items: [{ snippet: { title: "sem id" } }, { id: "UC1", snippet: { title: "diar.ia.br", customUrl: "@diariabr" } }] }),
    [{ id: "UC1", title: "diar.ia.br", customUrl: "@diariabr" }],
  );
});

test("checkAuthorizedChannel aceita @diariabr sem caixa e recusa outro canal ou nenhum", () => {
  const ok = checkAuthorizedChannel([{ id: "UC1", title: "x", customUrl: "@DiariaBR" }]);
  assert.equal(ok.ok, true);
  const none = checkAuthorizedChannel([]);
  assert.equal(none.ok, false);
  const other = checkAuthorizedChannel([{ id: "UC2", title: "Pessoal", customUrl: "@vjpixel" }]);
  assert.equal(other.ok, false);
  if (!other.ok) assert.match(other.reason, /@vjpixel/);
});

test("explainYouTubeApiError reconhece API desativada", () => {
  assert.match(explainYouTubeApiError(403, '{"error":{"errors":[{"reason":"accessNotConfigured"}]}}'), /não está ativada/);
  assert.equal(explainYouTubeApiError(500, "boom"), "YouTube API respondeu 500");
});
