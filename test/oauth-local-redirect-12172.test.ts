/**
 * oauth-local-redirect-12172.test.ts (#12172)
 *
 * Regressões:
 *   - o callback do OAuth pessoal escrevia "Pronto" no navegador antes de
 *     comparar o `state`: um callback rejeitado aparecia como sucesso. Agora
 *     a página sai da mesma decisão que resolve/rejeita (`waitForCode` de
 *     `scripts/lib/oauth-local-redirect.ts`), exercitado aqui com um servidor
 *     real em porta efêmera;
 *   - os dois scripts OAuth do LinkedIn usam o helper compartilhado, sem
 *     servidor HTTP próprio;
 *   - o client ID do app da página se escreve `77tlvy0623oq84` (L minúsculo).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  classifyOAuthCallback,
  openBrowser,
  renderOAuthCallbackPage,
  waitForCode,
} from "../scripts/lib/oauth-local-redirect.ts";
import { LINKEDIN_PAGE_DEFAULT_CLIENT_ID } from "../scripts/lib/linkedin-page-oauth.ts";
import { LINKEDIN_PERSONAL_REDIRECT_PATH, LINKEDIN_PERSONAL_REDIRECT_URI } from "../scripts/lib/linkedin-personal.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = "/linkedin/callback";
const u = (q: string, path = PATH) => new URL(`http://localhost:1${path}${q}`);

describe("classifyOAuthCallback (#12172)", () => {
  it("ignora outro path e requisição sem code/error", () => {
    assert.deepEqual(classifyOAuthCallback(u("?code=x&state=s", "/favicon.ico"), PATH, "s"), { kind: "ignore" });
    assert.deepEqual(classifyOAuthCallback(u(""), PATH, "s"), { kind: "ignore" });
  });

  it("aceita code com state igual", () => {
    assert.deepEqual(classifyOAuthCallback(u("?code=abc&state=s"), PATH, "s"), { kind: "code", code: "abc" });
  });

  it("rejeita code com state divergente ou ausente", () => {
    assert.equal(classifyOAuthCallback(u("?code=abc&state=outro"), PATH, "s").kind, "error");
    assert.equal(classifyOAuthCallback(u("?code=abc"), PATH, "s").kind, "error");
  });

  it("error do provedor vira erro com a descrição", () => {
    const r = classifyOAuthCallback(u("?error=user_cancelled_login&error_description=cancelou"), PATH, "s");
    assert.equal(r.kind, "error");
    assert.match((r as { message: string }).message, /consentimento negado: user_cancelled_login cancelou/);
  });
});

describe("renderOAuthCallbackPage (#12172)", () => {
  it("Pronto só no sucesso", () => {
    assert.match(renderOAuthCallbackPage(true), /Pronto/);
    assert.doesNotMatch(renderOAuthCallbackPage(false), /Pronto/);
    assert.match(renderOAuthCallbackPage(false), /Falhou/);
  });
});

function startWait(state: string, timeoutMs = 10_000) {
  const opened: string[] = [];
  let resolvePort!: (p: number) => void;
  const port = new Promise<number>((r) => (resolvePort = r));
  const result = waitForCode({
    authUrl: "https://example.test/authorize?x=1&y=2",
    state,
    port: 0,
    path: PATH,
    prompt: "teste",
    timeoutMs,
    open: (url) => opened.push(url),
    log: () => {},
    onListening: resolvePort,
  });
  return { result, port, opened };
}

describe("waitForCode — servidor real em porta efêmera (#12172)", () => {
  it("state divergente: navegador vê Falhou (nunca Pronto) e a promessa rejeita", async () => {
    const { result, port, opened } = startWait("certo");
    const rejection = assert.rejects(result, /state divergente/);
    const res = await fetch(`http://127.0.0.1:${await port}${PATH}?code=abc&state=errado`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.doesNotMatch(html, /Pronto/);
    assert.match(html, /Falhou/);
    await rejection;
    assert.deepEqual(opened, ["https://example.test/authorize?x=1&y=2"]);
  });

  it("state correto: navegador vê Pronto e a promessa resolve com o code", async () => {
    const { result, port } = startWait("certo");
    const p = await port;
    const ignored = await fetch(`http://127.0.0.1:${p}/favicon.ico`);
    assert.equal(ignored.status, 204);
    const res = await fetch(`http://127.0.0.1:${p}${PATH}?code=abc&state=certo`);
    assert.match(await res.text(), /Pronto/);
    assert.equal(await result, "abc");
  });

  it("timeout rejeita", async () => {
    const { result } = startWait("certo", 50);
    await assert.rejects(result, /timeout esperando o consentimento/);
  });
});

describe("openBrowser (#12172)", () => {
  it("passa a URL inteira como argumento, sem shell (o & não corta)", () => {
    const calls: { cmd: string; args: string[]; opts: Record<string, unknown> }[] = [];
    const fake = ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      return { unref() {} };
    }) as unknown as Parameters<typeof openBrowser>[1];
    openBrowser("https://a.test/?x=1&y=2", fake);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].args.includes("https://a.test/?x=1&y=2"));
    assert.notEqual(calls[0].opts.shell, true);
  });
});

describe("scripts OAuth do LinkedIn usam o helper (#12172)", () => {
  for (const rel of ["scripts/linkedin-personal-oauth.ts", "scripts/linkedin-page-oauth.ts"]) {
    it(`${rel} importa waitForCode do lib e não sobe servidor próprio`, () => {
      const src = readFileSync(resolve(ROOT, rel), "utf8");
      assert.match(src, /import \{ waitForCode \} from "\.\/lib\/oauth-local-redirect\.ts"/);
      assert.doesNotMatch(src, /createServer/);
      assert.doesNotMatch(src, /function (waitForCode|openBrowser)\b/);
    });
  }

  it("o path pessoal bate com a redirect URI cadastrada", () => {
    assert.ok(LINKEDIN_PERSONAL_REDIRECT_URI.endsWith(LINKEDIN_PERSONAL_REDIRECT_PATH));
  });
});

describe("client ID do app da página: 77tlvy0623oq84, L minúsculo (#12172)", () => {
  it("o default do código usa a grafia certa", () => {
    assert.equal(LINKEDIN_PAGE_DEFAULT_CLIENT_ID, "77tlvy0623oq84");
  });

  for (const rel of [
    ".env.example",
    "docs/linkedin-personal-setup.md",
    "scripts/lib/linkedin-personal.ts",
    "scripts/linkedin-personal-oauth.ts",
    "scripts/linkedin-page-oauth.ts",
    "scripts/lib/linkedin-page-oauth.ts",
  ]) {
    it(`${rel} não traz a grafia com I maiúsculo`, () => {
      assert.doesNotMatch(readFileSync(resolve(ROOT, rel), "utf8"), /77tIvy0623oq84/);
    });
  }
});
