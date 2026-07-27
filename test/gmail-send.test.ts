/**
 * #4064: scripts/lib/gmail-send.ts — envio de e-mail via Gmail API direta
 * (`users.messages.send`), usado pelo alarme de guardrail do ramp Clarice
 * (nenhum MCP Gmail disponível fora de uma sessão Claude Code viva).
 *
 * Cobre as partes puras (encoding/MIME) + `sendGmailMessage` com um
 * `_fetchImpl` mockado (nunca bate na rede/Gmail real neste teste).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { base64UrlEncode, buildMimeMessage, sendGmailMessage } from "../scripts/lib/gmail-send.ts";

test("base64UrlEncode — usa alfabeto base64url (- e _ no lugar de + e /), sem padding", () => {
  // "??>" em base64 normal produz "Pz4+" ... escolhido pra garantir presença de + e/ou / no base64 padrão de algum input.
  const input = "sub>?/+jects with weird chars ção";
  const b64url = base64UrlEncode(input);
  assert.doesNotMatch(b64url, /[+/=]/);
  // round-trip: decodifica de volta (convertendo pro alfabeto padrão) e confere.
  const standard = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = Buffer.from(standard, "base64").toString("utf-8");
  assert.equal(decoded, input);
});

test("buildMimeMessage — inclui To/Subject (encoded-word RFC 2047)/Content-Type/corpo", () => {
  const mime = buildMimeMessage("editor@example.com", "Alerta: spam alto", "corpo do alarme");
  assert.match(mime, /^To: editor@example\.com/m);
  assert.match(mime, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(mime, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(mime, /corpo do alarme/);
});

test("buildMimeMessage — Subject com acentuação sobrevive ao encoded-word (round-trip)", () => {
  const subject = "Guardrail furado — envio 8B";
  const mime = buildMimeMessage("x@y.com", subject, "corpo");
  const match = mime.match(/^Subject: =\?UTF-8\?B\?([^?]+)\?=$/m);
  assert.ok(match, "Subject deve estar no formato encoded-word");
  const decoded = Buffer.from(match![1], "base64").toString("utf-8");
  assert.equal(decoded, subject);
});

test("sendGmailMessage — monta o POST correto (raw base64url) e retorna id/threadId da resposta", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(JSON.stringify({ id: "msg123", threadId: "thread456" }), { status: 200 });
  }) as unknown as typeof fetch;

  const result = await sendGmailMessage("editor@example.com", "assunto", "corpo", fakeFetch);
  assert.equal(result.id, "msg123");
  assert.equal(result.threadId, "thread456");
  assert.match(capturedUrl, /users\/me\/messages\/send$/);
  assert.equal(capturedInit?.method, "POST");
  const parsedBody = JSON.parse(capturedInit?.body as string);
  assert.ok(typeof parsedBody.raw === "string" && parsedBody.raw.length > 0);
});

test("sendGmailMessage — resposta não-ok lança erro descritivo (nunca engole falha de envio)", async () => {
  const fakeFetch = (async () => new Response("token expirado", { status: 401 })) as unknown as typeof fetch;
  await assert.rejects(
    () => sendGmailMessage("editor@example.com", "assunto", "corpo", fakeFetch),
    /falhou \(401\)/,
  );
});
