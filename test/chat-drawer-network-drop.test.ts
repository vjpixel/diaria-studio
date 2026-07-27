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

  it("o finally restaura sending=false incondicionalmente e decide el.send.disabled a partir de chatEnabled (roda mesmo com erro; #4078 sobre #3887)", () => {
    // Nota sobre fragilidade de asserção-por-texto-fonte: esta suíte inteira é
    // "contrato estático" via regex (ver docstring do topo) porque não há
    // harness de DOM aqui. Isso já mordeu uma vez (#4078): o teste original
    // assertava o texto literal `el.send.disabled = false;` no finally, e
    // quebrou quando o #4078 mudou a expressão pra `!chatEnabled` — uma
    // mudança de comportamento LEGÍTIMA (ver comentário no código-fonte),
    // não uma regressão. Em vez de voltar a fixar um texto-fonte diferente
    // (que quebraria de novo na próxima variação equivalente da expressão),
    // este teste extrai a expressão à direita do `=` e AVALIA seu resultado
    // para os dois cenários que importam — isso verifica o comportamento
    // resultante, não a forma sintática de como ele é escrito.
    const body = extractSendMessageBody();
    const finallyMatch = body.match(/\}\s*finally\s*\{([\s\S]*?)\n\}/);
    assert.ok(finallyMatch, "deveria existir um bloco finally em sendMessage");
    const finallyBody = finallyMatch![1];

    // Garantia original do network-drop (#3887): sending sempre volta a
    // false, incondicionalmente — sem isso o botão fica preso em "enviando".
    assert.match(finallyBody, /sending\s*=\s*false;/);

    // Garantia sobre el.send.disabled: precisa depender de chatEnabled (não
    // mais uma constante), pra cobrir tanto o caso antigo (chat ativo + erro
    // → reabilita) quanto o caso novo do #4078 (chat desativado pelo toggle
    // DURANTE o turno → continua desabilitado ao final).
    const disabledMatch = finallyBody.match(/el\.send\.disabled\s*=\s*([^;]+);/);
    assert.ok(
      disabledMatch,
      "deveria existir uma atribuição a el.send.disabled no finally de sendMessage",
    );
    const disabledExpr = disabledMatch![1];
    const evalDisabled = (chatEnabled: boolean): unknown =>
      new Function("chatEnabled", `return (${disabledExpr});`)(chatEnabled);

    // Caso 1 (garantia original do #3887, preservada): chat ATIVO + erro de
    // rede a meio-turno → botão precisa voltar a ficar habilitado.
    assert.equal(
      evalDisabled(true),
      false,
      "com chatEnabled=true (caso do #3887: sem toggle durante o turno), el.send.disabled deveria resolver para false",
    );

    // Caso 2 (garantia nova do #4078): chat foi DESATIVADO pelo toggle
    // durante o turno → botão precisa continuar desabilitado ao final,
    // mesmo que o finally rode (inclusive em erro).
    assert.equal(
      evalDisabled(false),
      true,
      "com chatEnabled=false (caso do #4078: toggle desativado durante o turno), el.send.disabled deveria resolver para true",
    );
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
