/**
 * test/workers-dev-redirect.test.ts (#5097 item D)
 *
 * Regressão pura pra `scripts/lib/shared/workers-dev-redirect.ts` —
 * `resolveWorkersDevRedirect` decide (sem I/O) se uma request pra
 * `*.workers.dev` deveria virar um 301/308 pro host canônico. Ver
 * `test/workers-dev-redirect-wiring-5097.test.ts` pro comportamento
 * exercitado nos Workers reais (fetch handler completo, sem rede).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveWorkersDevRedirect } from "../scripts/lib/shared/workers-dev-redirect.ts";

describe("resolveWorkersDevRedirect (#5097 item D)", () => {
  it("host *.workers.dev -> redireciona pro host canônico, preservando path", () => {
    const decision = resolveWorkersDevRedirect("https://arquivo.diaria.workers.dev/temas/anthropic-claude", "arquivo.diar.ia.br");
    assert.equal(decision.shouldRedirect, true);
    assert.equal(decision.location, "https://arquivo.diar.ia.br/temas/anthropic-claude");
  });

  it("preserva query string no destino", () => {
    const decision = resolveWorkersDevRedirect(
      "https://cursos.diaria.workers.dev/?email=x%40x.com",
      "cursos.diar.ia.br",
    );
    assert.equal(decision.shouldRedirect, true);
    assert.equal(decision.location, "https://cursos.diar.ia.br/?email=x%40x.com");
  });

  it("host já canônico (diar.ia.br) -> nunca redireciona", () => {
    const decision = resolveWorkersDevRedirect("https://livros.diar.ia.br/", "livros.diar.ia.br");
    assert.equal(decision.shouldRedirect, false);
    assert.equal(decision.location, null);
  });

  it("host completamente diferente (preview local, ex: localhost) -> não redireciona", () => {
    const decision = resolveWorkersDevRedirect("http://localhost:8787/", "livros.diar.ia.br");
    assert.equal(decision.shouldRedirect, false);
  });

  it("raiz sem path -> destino é a raiz do host canônico", () => {
    const decision = resolveWorkersDevRedirect("https://livros.diaria.workers.dev/", "livros.diar.ia.br");
    assert.equal(decision.location, "https://livros.diar.ia.br/");
  });

  it("URL malformada -> shouldRedirect false, nunca lança", () => {
    const decision = resolveWorkersDevRedirect("não é uma url", "arquivo.diar.ia.br");
    assert.equal(decision.shouldRedirect, false);
    assert.equal(decision.location, null);
  });

  it("qualquer subdomínio de conta .workers.dev casa (não hardcoded pra 'diaria')", () => {
    const decision = resolveWorkersDevRedirect("https://cursos.outraconta.workers.dev/gate", "cursos.diar.ia.br");
    assert.equal(decision.shouldRedirect, true);
    assert.equal(decision.location, "https://cursos.diar.ia.br/gate");
  });

  // #5104 (fleet review): `resolveWorkersDevRedirect` era cego a método HTTP
  // — um 301 numa request não-GET/HEAD vira GET sem corpo no retry do
  // cliente (RFC 9110 §15.4.2). `status` distingue os dois casos.
  it("método omitido -> default GET -> status 301", () => {
    const decision = resolveWorkersDevRedirect("https://cursos.diaria.workers.dev/", "cursos.diar.ia.br");
    assert.equal(decision.shouldRedirect, true);
    if (decision.shouldRedirect) assert.equal(decision.status, 301);
  });

  it("GET/HEAD explícitos -> status 301", () => {
    for (const method of ["GET", "HEAD", "get", "head"]) {
      const decision = resolveWorkersDevRedirect("https://cursos.diaria.workers.dev/", "cursos.diar.ia.br", method);
      assert.equal(decision.shouldRedirect, true);
      if (decision.shouldRedirect) assert.equal(decision.status, 301, `método ${method} deveria dar 301`);
    }
  });

  it("POST/PUT/DELETE/PATCH -> status 308 (preserva método+corpo no retry)", () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const decision = resolveWorkersDevRedirect(
        "https://cursos.diaria.workers.dev/gate/verify",
        "cursos.diar.ia.br",
        method,
      );
      assert.equal(decision.shouldRedirect, true);
      if (decision.shouldRedirect) assert.equal(decision.status, 308, `método ${method} deveria dar 308`);
    }
  });

  it("host já canônico + método POST -> ainda shouldRedirect false (status não se aplica)", () => {
    const decision = resolveWorkersDevRedirect("https://cursos.diar.ia.br/gate/verify", "cursos.diar.ia.br", "POST");
    assert.equal(decision.shouldRedirect, false);
    assert.equal(decision.location, null);
  });
});
