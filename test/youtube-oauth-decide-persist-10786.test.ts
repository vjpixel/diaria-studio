/**
 * test/youtube-oauth-decide-persist-10786.test.ts (#10786)
 *
 * Resíduos do review do PR #10757 em `scripts/youtube-oauth-setup.ts`:
 *   - a regra de "nunca gravar" saiu de `main` (misturada com I/O) para
 *     `decidePersist`, pura, testada aqui caso a caso;
 *   - callback com `state` divergente não encerra mais o fluxo
 *     (`classifyCallback` devolve `bad-state`; o servidor responde 400 e
 *     continua esperando);
 *   - `persistSecrets`/`defaultDopplerSet` saíram do script do LinkedIn para
 *     `scripts/lib/secret-persist.ts` (nenhum script importa outro script).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  YOUTUBE_OAUTH_REDIRECT_URI,
  YOUTUBE_OAUTH_SCOPES,
  classifyCallback,
  decidePersist,
} from "../scripts/lib/youtube-oauth.ts";

const ALL_SCOPES = YOUTUBE_OAUTH_SCOPES.join(" ");
const OK_TOKENS = { access_token: "a", refresh_token: "r", scope: ALL_SCOPES };
const DIARIA_BODY = JSON.stringify({
  items: [{ id: "UC123", snippet: { title: "diar.ia.br", customUrl: "@diariabr" } }],
});

describe("decidePersist (#10786)", () => {
  it("tudo certo → persist com o canal e o refresh token", () => {
    const d = decidePersist({ tokens: OK_TOKENS, channelsStatus: 200, channelsBody: DIARIA_BODY });
    assert.equal(d.persist, true);
    if (d.persist) {
      assert.equal(d.refreshToken, "r");
      assert.equal(d.channel.id, "UC123");
    }
  });

  it("sem refresh_token → não grava", () => {
    const d = decidePersist({
      tokens: { access_token: "a", scope: ALL_SCOPES },
      channelsStatus: 200,
      channelsBody: DIARIA_BODY,
    });
    assert.equal(d.persist, false);
    if (!d.persist) assert.match(d.reason, /refresh_token/);
  });

  it("escopo youtube.upload desmarcado → não grava", () => {
    const d = decidePersist({
      tokens: { ...OK_TOKENS, scope: "https://www.googleapis.com/auth/youtube.readonly" },
      channelsStatus: 200,
      channelsBody: DIARIA_BODY,
    });
    assert.equal(d.persist, false);
    if (!d.persist) assert.match(d.reason, /youtube\.upload/);
  });

  it("channels.list com erro HTTP → não grava, com a explicação da API", () => {
    const d = decidePersist({
      tokens: OK_TOKENS,
      channelsStatus: 403,
      channelsBody: '{"error":{"errors":[{"reason":"accessNotConfigured"}]}}',
    });
    assert.equal(d.persist, false);
    if (!d.persist) assert.match(d.reason, /YouTube Data API v3 não está ativada/);
  });

  it("channels.list com corpo que não é JSON → não grava", () => {
    const d = decidePersist({ tokens: OK_TOKENS, channelsStatus: 200, channelsBody: "<html>" });
    assert.equal(d.persist, false);
    if (!d.persist) assert.match(d.reason, /não é JSON/);
  });

  it("canal errado → não grava", () => {
    const body = JSON.stringify({ items: [{ id: "UC9", snippet: { title: "Outro", customUrl: "@outro" } }] });
    const d = decidePersist({ tokens: OK_TOKENS, channelsStatus: 200, channelsBody: body });
    assert.equal(d.persist, false);
    if (!d.persist) assert.match(d.reason, /não é @diariabr/);
  });

  it("conta sem canal nenhum → não grava", () => {
    const d = decidePersist({ tokens: OK_TOKENS, channelsStatus: 200, channelsBody: "{}" });
    assert.equal(d.persist, false);
  });
});

describe("classifyCallback (#10786)", () => {
  const u = (q: string, path = "/youtube/callback") => new URL(`${path}?${q}`, YOUTUBE_OAUTH_REDIRECT_URI);

  it("state divergente → bad-state (o servidor segue esperando), nunca encerra o fluxo", () => {
    assert.deepEqual(classifyCallback(u("code=x&state=errado"), "certo"), { kind: "bad-state" });
    assert.deepEqual(classifyCallback(u("code=x"), "certo"), { kind: "bad-state" });
  });

  it("state certo + code → code", () => {
    assert.deepEqual(classifyCallback(u("code=abc&state=certo"), "certo"), { kind: "code", code: "abc" });
  });

  it("state certo + error → denied", () => {
    assert.deepEqual(classifyCallback(u("error=access_denied&state=certo"), "certo"), {
      kind: "denied",
      error: "access_denied",
      description: "",
    });
  });

  it("path errado ou sem code/error → ignore", () => {
    assert.deepEqual(classifyCallback(u("code=x&state=certo", "/favicon.ico"), "certo"), { kind: "ignore" });
    assert.deepEqual(classifyCallback(u("state=certo"), "certo"), { kind: "ignore" });
  });
});

describe("nenhum script importa os helpers de persistência de outro script (#10786)", () => {
  for (const file of ["scripts/youtube-oauth-setup.ts", "scripts/facebook-page-token-setup.ts"]) {
    it(`${file} importa persistSecrets de lib/secret-persist.ts`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), "utf8");
      assert.match(src, /from "\.\/lib\/secret-persist\.ts"/);
      assert.doesNotMatch(src, /from "\.\/linkedin-personal-oauth\.ts"/);
    });
  }
});

describe("ordem das mensagens do setup (#10786)", () => {
  it("o resultado do Doppler é impresso antes de anunciar o .env gravado", () => {
    const src = readFileSync(fileURLToPath(new URL("../scripts/youtube-oauth-setup.ts", import.meta.url)), "utf8");
    const doppler = src.indexOf("Doppler NÃO recebeu");
    const env = src.indexOf("gravado também no .env local");
    assert.ok(doppler !== -1 && env !== -1);
    assert.ok(doppler < env, "falha do Doppler precisa aparecer antes do sucesso do .env");
  });

  it("não imprime mais o aviso de expiração em 7 dias do modo Testing (#10785)", () => {
    const src = readFileSync(fileURLToPath(new URL("../scripts/youtube-oauth-setup.ts", import.meta.url)), "utf8");
    assert.doesNotMatch(src, /expira em 7 dias/);
  });
});
