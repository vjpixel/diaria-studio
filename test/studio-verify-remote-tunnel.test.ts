/**
 * test/studio-verify-remote-tunnel.test.ts (#3560)
 *
 * Cobre a lógica de classificação de `scripts/studio/verify-remote-tunnel.ts`:
 * confirma que uma requisição sem credenciais contra o hostname público NUNCA
 * é lida como "protegido" a menos que haja evidência positiva de bloqueio
 * (redirect Access, 401/403, página de login), e que o vazamento (conteúdo
 * real servido sem auth) é sempre detectado como `leaked`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyResponse,
  checkRemoteTunnel,
  type HeadersLike,
} from "../scripts/studio/verify-remote-tunnel.ts";

function headers(map: Record<string, string> = {}): HeadersLike {
  return {
    get(name: string) {
      const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
      return key ? map[key] : null;
    },
  };
}

describe("classifyResponse (#3560)", () => {
  it("classifica redirect 302 para cloudflareaccess.com como blocked", () => {
    const result = classifyResponse(
      302,
      headers({ Location: "https://diaria.cloudflareaccess.com/cdn-cgi/access/login/studio.diar.ia.br" }),
      "",
      "Diar.ia Studio",
    );
    assert.equal(result.state, "blocked");
  });

  it("classifica 401 como blocked", () => {
    const result = classifyResponse(401, headers(), "", "Diar.ia Studio");
    assert.equal(result.state, "blocked");
  });

  it("classifica 403 como blocked", () => {
    const result = classifyResponse(403, headers(), "", "Diar.ia Studio");
    assert.equal(result.state, "blocked");
  });

  it("classifica 200 com página de login do Access no corpo como blocked", () => {
    const result = classifyResponse(
      200,
      headers(),
      "<html><body>Faça login via Cloudflare Access — insira seu e-mail</body></html>",
      "Diar.ia Studio",
    );
    assert.equal(result.state, "blocked");
  });

  it("classifica 200 com o marcador do Studio real no corpo como leaked (VAZAMENTO)", () => {
    const result = classifyResponse(
      200,
      headers(),
      "<html><head><title>Diar.ia Studio</title></head><body>Edição corrente</body></html>",
      "Diar.ia Studio",
    );
    assert.equal(result.state, "leaked");
  });

  it("marcador é case-insensitive", () => {
    const result = classifyResponse(200, headers(), "<title>DIAR.IA STUDIO</title>", "Diar.ia Studio");
    assert.equal(result.state, "leaked");
  });

  it("classifica 200 sem marcador reconhecido e sem sinal de Access como unknown (falha por segurança)", () => {
    const result = classifyResponse(200, headers(), "<html><body>algo inesperado</body></html>", "Diar.ia Studio");
    assert.equal(result.state, "unknown");
  });

  it("redirect 302 para outro host (não Access) não é lido como blocked", () => {
    const result = classifyResponse(302, headers({ Location: "https://example.com/other" }), "", "Diar.ia Studio");
    assert.notEqual(result.state, "blocked");
  });

  it("500 sem corpo reconhecido é unknown, não blocked nem leaked", () => {
    const result = classifyResponse(500, headers(), "", "Diar.ia Studio");
    assert.equal(result.state, "unknown");
  });
});

describe("checkRemoteTunnel (#3560) — com fetchFn mockado", () => {
  it("detecta bloqueio via Access (redirect) fim-a-fim", async () => {
    const fetchFn = (async () =>
      new Response(null, {
        status: 302,
        headers: { Location: "https://diaria.cloudflareaccess.com/cdn-cgi/access/login/x" },
      })) as unknown as typeof fetch;

    const result = await checkRemoteTunnel("https://studio.diar.ia.br", { fetchFn });
    assert.equal(result.state, "blocked");
  });

  it("detecta vazamento fim-a-fim quando o fetch retorna o Studio real sem auth", async () => {
    const fetchFn = (async () =>
      new Response("<title>Diar.ia Studio</title><div id=timeline></div>", { status: 200 })) as unknown as typeof fetch;

    const result = await checkRemoteTunnel("https://studio.diar.ia.br", { fetchFn });
    assert.equal(result.state, "leaked");
  });

  it("erro de rede (hostname ainda não ativado) retorna unknown, não lança", async () => {
    const fetchFn = (async () => {
      throw new Error("ENOTFOUND studio.diar.ia.br");
    }) as unknown as typeof fetch;

    const result = await checkRemoteTunnel("https://studio.diar.ia.br", { fetchFn });
    assert.equal(result.state, "unknown");
    assert.match(result.reason, /erro de rede/);
  });

  it("usa o marcador customizado passado via opts", async () => {
    const fetchFn = (async () =>
      new Response("<title>Custom Marker Here</title>", { status: 200 })) as unknown as typeof fetch;

    const result = await checkRemoteTunnel("https://studio.diar.ia.br", {
      fetchFn,
      marker: "Custom Marker Here",
    });
    assert.equal(result.state, "leaked");
  });
});
