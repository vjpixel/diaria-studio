/**
 * test/worker-public-hosts.test.ts (#4782)
 *
 * Testes unitários dos 2 helpers de `scripts/lib/worker-public-hosts.ts`
 * que o fleet review pré-merge do #4781 (issue #4782) achou frágeis —
 * cobrindo achados 1 e 3 diretamente contra a função, sem depender de fixar
 * um `workers/*` real no repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  hasRobotsRouteDispatch,
  parseWranglerTomlCustomDomainHosts,
} from "../scripts/lib/worker-public-hosts.ts";

describe("hasRobotsRouteDispatch (#4782 achado 1)", () => {
  it("NÃO casa substring solta dentro de comentário — regressão concreta do achado", () => {
    const src = `
      // TODO: add /robots.txt
      export function handleFetch() {
        return new Response("not implemented yet");
      }
    `;
    assert.equal(
      hasRobotsRouteDispatch(src),
      false,
      "um comentário mencionando /robots.txt sem rota real não deveria contar como handler",
    );
  });

  it("casa dispatch real via === (idioma usado em workers/artigo-mensal e workers/arquivo)", () => {
    const src = `if (url.pathname === "/robots.txt") { return robotsResponse(); }`;
    assert.equal(hasRobotsRouteDispatch(src), true);
  });

  it("casa dispatch real via === com 'path' em vez de 'pathname' (idioma usado em workers/poll)", () => {
    const src = `if (path === "/robots.txt" && request.method === "GET") return handleRobotsTxt();`;
    assert.equal(hasRobotsRouteDispatch(src), true);
  });

  it("casa dispatch real via case (switch de rotas)", () => {
    const src = `switch (url.pathname) {\n  case "/robots.txt":\n    return robotsResponse();\n}`;
    assert.equal(hasRobotsRouteDispatch(src), true);
  });

  it("NÃO casa string solta sem operador de dispatch (ex: log, comentário de docstring)", () => {
    const src = `console.log("serving /robots.txt now");`;
    assert.equal(hasRobotsRouteDispatch(src), false);
  });
});

describe("parseWranglerTomlCustomDomainHosts (#4782 achado 3 — corte de bloco [[routes]])", () => {
  it("extrai o host de um [[routes]] com custom_domain = true (caso normal)", () => {
    const toml = `
[[routes]]
pattern = "exemplo.diar.ia.br"
custom_domain = true
`;
    assert.deepEqual(parseWranglerTomlCustomDomainHosts(toml), ["exemplo.diar.ia.br"]);
  });

  it("NÃO trata uma rota SEM custom_domain = true como pública, mesmo com essa string aparecendo numa seção seguinte", () => {
    // Regressão concreta: cortar o bloco só no próximo `[[routes]]` (em vez
    // do próximo `[` de qualquer tipo) fazia o texto de `[some_section]`
    // vazar pro bloco anterior — e como o teste de custom_domain era feito
    // sobre o bloco inteiro (não escopado), uma rota clássica SEM
    // `custom_domain = true` passava a ser incluída por engano.
    const toml = `
[[routes]]
pattern = "classic-route.example.com"

[some_section]
notes = "custom_domain = true (mencionado num comentário/valor, não é config real desta rota)"
`;
    assert.deepEqual(
      parseWranglerTomlCustomDomainHosts(toml),
      [],
      "rota sem custom_domain = true não deveria virar host público só porque uma seção seguinte contém essa string",
    );
  });

  it("corta corretamente entre duas rotas quando uma seção de outro tipo separa as duas", () => {
    const toml = `
[[routes]]
pattern = "first.example.com"
custom_domain = true

[triggers]
crons = ["0 * * * *"]

[[routes]]
pattern = "second.example.com"
custom_domain = true
`;
    assert.deepEqual(
      parseWranglerTomlCustomDomainHosts(toml).sort(),
      ["first.example.com", "second.example.com"].sort(),
    );
  });
});
