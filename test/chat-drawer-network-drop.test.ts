/**
 * test/chat-drawer-network-drop.test.ts (#3887) — cobertura estrutural do
 * fix client-side de `chat-drawer.js`: `sendMessage()` precisa sobreviver a
 * uma queda de rede a meio-turno (o `fetch`/`reader.read()` dentro de
 * `streamChat()` rejeitando) sem deixar o botão Enviar morto pra sempre.
 *
 * Mesmo precedente de `chat-drawer-mobile.test.ts`/`studio-review-server.test.ts`
 * ("GET /chat-drawer.js expõe prefillMessage..."): este projeto não tem
 * harness de DOM (sem jsdom/happy-dom), então a cobertura possível daqui é
 * "contrato estático" — buscar o asset servido via HTTP (mesmo static-serve.ts
 * de produção) e afirmar estrutura via regex no corpo, não render/clique
 * simulado. O comportamento de runtime do `try/catch/finally` em si é
 * garantido pela semântica do próprio JavaScript (uma promise rejeitada
 * propaga do `await` interno pro `catch` externo) — o que shows este teste é
 * que o `catch`/`finally` genuinamente ENVOLVEM a chamada de `streamChat` e
 * restauram o estado certo, não que a engine de JS funciona.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";

describe("chat-drawer.js: sendMessage sobrevive a queda de rede a meio-turno (#3887)", () => {
  let root: string;
  let server: StudioServer;
  let jsBody: string;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "chat-drawer-network-drop-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });

    const jsRes = await fetch(new URL("/chat-drawer.js", server.url));
    assert.equal(jsRes.status, 200);
    jsBody = await jsRes.text();
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** Recorta o corpo de `sendMessage` inteiro (da assinatura até o fechamento
   * da função, marcado pelo comentário `#3556 self-review` que já vem logo
   * depois dela) — as asserções abaixo checam ORDEM/aninhamento dentro deste
   * recorte, não o arquivo inteiro (evita falso-positivo casando texto de
   * outro lugar do arquivo). */
  function extractSendMessageBody(): string {
    const start = jsBody.indexOf("async function sendMessage(text) {");
    assert.ok(start > -1, "sendMessage deveria existir em chat-drawer.js");
    const end = jsBody.indexOf("// #3556 self-review", start);
    assert.ok(end > start, "marcador de fim do recorte (comentário logo após sendMessage) não encontrado");
    return jsBody.slice(start, end);
  }

  it("await streamChat(...) está dentro de um try — não mais uma chamada desprotegida", () => {
    const body = extractSendMessageBody();
    const tryIndex = body.indexOf("try {");
    const streamChatIndex = body.indexOf("await streamChat(");
    const catchIndex = body.indexOf("} catch {");
    assert.ok(tryIndex > -1, "deveria existir um bloco try em sendMessage");
    assert.ok(streamChatIndex > tryIndex, "await streamChat(...) deveria estar DENTRO do try");
    assert.ok(catchIndex > streamChatIndex, "o catch deveria vir DEPOIS da chamada de streamChat (a envolve)");
  });

  it("o catch mostra a nota de erro de conexão perdida (sem isto, queda de rede ficava muda)", () => {
    const body = extractSendMessageBody();
    const catchMatch = body.match(/\}\s*catch\s*\{([\s\S]*?)\}\s*finally\s*\{/);
    assert.ok(catchMatch, "deveria existir um bloco catch { ... } finally { ... } em sendMessage");
    const catchBody = catchMatch![1];
    assert.match(catchBody, /finalizeAssistantMessage\(\);/);
    assert.match(catchBody, /appendErrorNote\("conexão perdida — tente reenviar"\);/);
    assert.match(catchBody, /setToggleStatus\("down"\);/);
  });

  it("o finally restaura sending=false e el.send.disabled=false INCONDICIONALMENTE (roda mesmo com erro)", () => {
    const body = extractSendMessageBody();
    const finallyMatch = body.match(/\}\s*finally\s*\{([\s\S]*?)\n\}/);
    assert.ok(finallyMatch, "deveria existir um bloco finally em sendMessage");
    const finallyBody = finallyMatch![1];
    assert.match(finallyBody, /sending\s*=\s*false;/);
    assert.match(finallyBody, /el\.send\.disabled\s*=\s*false;/);
  });

  it("regressão: sending/el.send.disabled NÃO são restaurados soltos fora do finally (não sobrou o código antigo duplicado)", () => {
    const body = extractSendMessageBody();
    // pré-#3887 o restore vinha solto no final da função, fora de
    // qualquer try/finally — garante que não sobrou uma 2ª cópia órfã
    // depois do fechamento do finally (o `}` final da função vem logo após).
    const finallyCloseIndex = body.search(/\}\s*finally\s*\{[\s\S]*?\n\}/);
    assert.ok(finallyCloseIndex > -1);
    const afterFinally = body.slice(body.indexOf("finally {") + "finally {".length);
    const restOfFile = afterFinally.slice(afterFinally.indexOf("\n}") + 2);
    assert.doesNotMatch(restOfFile, /sending = false;/);
    assert.doesNotMatch(restOfFile, /el\.send\.disabled = false;/);
  });

  it("regressão: onEvent/onError do streamChat continuam com a mesma lógica (chat-delta, chat-done, chat-error, etc.)", () => {
    const body = extractSendMessageBody();
    assert.match(body, /onEvent\(eventName, data\)\s*\{/);
    assert.match(body, /eventName === "chat-delta"/);
    assert.match(body, /eventName === "chat-done"/);
    assert.match(body, /eventName === "chat-error"/);
    assert.match(body, /onError\(message\)\s*\{/);
    assert.match(body, /appendErrorNote\(message\);/);
  });
});
