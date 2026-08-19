/**
 * test/ping-indexnow.test.ts (#4909 item 2)
 *
 * Cobre `scripts/ping-indexnow.ts`: leitura da lista de arquivos alterados
 * (`readChangedFiles`) e o POST em si (`pingIndexNow`), sempre com `fetch`
 * INJETADO/mockado — nenhuma chamada de rede real, nunca contra o endpoint
 * verdadeiro do IndexNow (mesma disciplina do guard geral desta unidade).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readChangedFiles, readWatchPrefixes, pingIndexNow, checkKeyLocationServed } from "../scripts/ping-indexnow.ts";
import { buildIndexNowPayload } from "../scripts/lib/indexnow.ts";

describe("readChangedFiles (#4909)", () => {
  it("lê --changed-files-file, 1 path por linha, descartando linhas vazias", () => {
    const dir = mkdtempSync(join(tmpdir(), "indexnow-test-"));
    const filePath = join(dir, "changed.txt");
    writeFileSync(filePath, "workers/arquivo/src/hubs/a.generated.ts\n\nworkers/arquivo/src/hubs/b.generated.ts\n");
    try {
      assert.deepEqual(readChangedFiles(["--changed-files-file", filePath]), [
        "workers/arquivo/src/hubs/a.generated.ts",
        "workers/arquivo/src/hubs/b.generated.ts",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("aceita --changed-file repetido", () => {
    assert.deepEqual(
      readChangedFiles([
        "--changed-file",
        "workers/arquivo/src/hubs/a.generated.ts",
        "--changed-file",
        "workers/arquivo/src/hubs/b.generated.ts",
      ]),
      ["workers/arquivo/src/hubs/a.generated.ts", "workers/arquivo/src/hubs/b.generated.ts"],
    );
  });

  it("sem nenhuma das duas flags -> lista vazia", () => {
    assert.deepEqual(readChangedFiles([]), []);
  });
});

describe("readWatchPrefixes (#5703)", () => {
  it("aceita --watch-prefix repetido", () => {
    assert.deepEqual(
      readWatchPrefixes([
        "--watch-prefix",
        "workers/cursos/src/courses-full.generated.ts",
        "--watch-prefix",
        "workers/cursos/public/index.html",
      ]),
      ["workers/cursos/src/courses-full.generated.ts", "workers/cursos/public/index.html"],
    );
  });

  it("sem a flag -> lista vazia", () => {
    assert.deepEqual(readWatchPrefixes([]), []);
  });

  it("ignora outras flags misturadas no argv", () => {
    assert.deepEqual(
      readWatchPrefixes(["--host", "cursos.diar.ia.br", "--watch-prefix", "workers/cursos/public/index.html"]),
      ["workers/cursos/public/index.html"],
    );
  });
});

describe("pingIndexNow (#4909) — fetch sempre mockado, nunca rede real", () => {
  it("payload null (gate fechado) -> NO-OP, ok:true, nenhuma chamada de fetch", async () => {
    let called = false;
    const fetchStub = (async () => {
      called = true;
      throw new Error("não deveria chamar fetch");
    }) as unknown as typeof fetch;
    const result = await pingIndexNow(null, fetchStub);
    assert.equal(result.ok, true);
    assert.equal(result.status, null);
    assert.equal(called, false);
  });

  it("POST bem-sucedido (200) -> ok:true, status preservado", async () => {
    const payload = buildIndexNowPayload(["workers/arquivo/src/hubs/anthropic-claude.generated.ts"], "chave-teste");
    assert.ok(payload);
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fetchStub = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedBody = String(init?.body);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await pingIndexNow(payload, fetchStub);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.equal(capturedUrl, "https://api.indexnow.org/indexnow");
    assert.deepEqual(JSON.parse(capturedBody!), payload);
  });

  it("resposta não-ok (422) -> ok:false, status e corpo do erro preservados", async () => {
    const payload = buildIndexNowPayload(["workers/arquivo/src/hubs/anthropic-claude.generated.ts"], "chave-teste");
    assert.ok(payload);
    const fetchStub = (async () => new Response("chave inválida", { status: 422 })) as unknown as typeof fetch;

    const result = await pingIndexNow(payload, fetchStub);
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.match(result.error ?? "", /chave inválida/);
  });

  it("falha de rede (fetch lança) -> ok:false, error com a mensagem", async () => {
    const payload = buildIndexNowPayload(["workers/arquivo/src/hubs/anthropic-claude.generated.ts"], "chave-teste");
    assert.ok(payload);
    const fetchStub = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;

    const result = await pingIndexNow(payload, fetchStub);
    assert.equal(result.ok, false);
    assert.equal(result.status, null);
    assert.match(result.error ?? "", /ECONNRESET/);
  });
});

describe("pingIndexNow (#5620) — 202 não é sucesso confirmado", () => {
  it("status 202 -> ok:false, mensagem explica a validação pendente", async () => {
    const payload = buildIndexNowPayload(["workers/arquivo/src/hubs/anthropic-claude.generated.ts"], "chave-teste");
    assert.ok(payload);
    const fetchStub = (async () => new Response("", { status: 202 })) as unknown as typeof fetch;

    const result = await pingIndexNow(payload, fetchStub);
    assert.equal(result.ok, false);
    assert.equal(result.status, 202);
    assert.match(result.error ?? "", /validação de chave PENDENTE/);
  });
});

describe("checkKeyLocationServed (#5620) — confirma o arquivo de chave ANTES de pingar", () => {
  it("keyLocation responde 200 com o conteúdo exato da chave -> ok:true", async () => {
    const fetchStub = (async () => new Response("chave-teste")) as unknown as typeof fetch;
    const result = await checkKeyLocationServed("https://arquivo.diar.ia.br/chave-teste.txt", "chave-teste", fetchStub);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
  });

  it("keyLocation 404 -> ok:false (o achado real do #5620)", async () => {
    const fetchStub = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const result = await checkKeyLocationServed("https://arquivo.diar.ia.br/chave-teste.txt", "chave-teste", fetchStub);
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.match(result.error ?? "", /404/);
  });

  it("keyLocation 200 mas com corpo divergente da chave esperada -> ok:false", async () => {
    const fetchStub = (async () => new Response("outra-coisa")) as unknown as typeof fetch;
    const result = await checkKeyLocationServed("https://arquivo.diar.ia.br/chave-teste.txt", "chave-teste", fetchStub);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /não bate/);
  });

  it("falha de rede -> ok:false, error com a mensagem", async () => {
    const fetchStub = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const result = await checkKeyLocationServed("https://arquivo.diar.ia.br/chave-teste.txt", "chave-teste", fetchStub);
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /ECONNRESET/);
  });
});
