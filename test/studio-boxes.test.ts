/**
 * test/studio-boxes.test.ts (#3924) — seção "Caixas": listar e editar os
 * snippets de caixa de divulgação (`context/snippets/*.md`).
 *
 * Duas frentes:
 *   1. Lógica PURA de `scripts/studio-ui/studio-boxes.ts` (slug validation,
 *      extração de título, slots via `platform.config.json`, dirty-vs-git
 *      fail-soft, save com guard de mtime #3729) — fixture de diretório
 *      temporário, sem repo git real (exercita o fail-soft de
 *      `checkDirtyVsGit`).
 *   2. Contrato HTTP via `startStudioServer` (mesmo padrão de
 *      `test/studio-apoios-page.test.ts`/`test/studio-review-server.test.ts`):
 *      `GET /caixas` (shell), `GET /api/boxes` (lista), `GET/PUT /api/boxes/:slug`
 *      (conteúdo + save, incluindo o conflito 409 e o retry com `force`).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudioServer, type StudioServer } from "../scripts/studio-ui/server.ts";
import {
  isValidBoxSlug,
  extractBoxTitle,
  readBoxSlotAssignments,
  checkDirtyVsGit,
  listBoxes,
  readBox,
  saveBox,
  boxFilePath,
} from "../scripts/studio-ui/studio-boxes.ts";

// ─── lógica pura ──────────────────────────────────────────────────────────

describe("isValidBoxSlug (#3924)", () => {
  it("aceita slug bem-formado (minúsculas/dígitos/hífen + .md)", () => {
    assert.equal(isValidBoxSlug("recomendacao-leitura.md"), true);
    assert.equal(isValidBoxSlug("apoio-divulgacao-2.md"), true);
  });

  it("rejeita README.md explicitamente", () => {
    assert.equal(isValidBoxSlug("README.md"), false);
  });

  it("rejeita traversal (barra, ..)", () => {
    assert.equal(isValidBoxSlug("../secrets.md"), false);
    assert.equal(isValidBoxSlug("../../etc/passwd.md"), false);
    assert.equal(isValidBoxSlug("sub/dir.md"), false);
  });

  it("rejeita extensão errada", () => {
    assert.equal(isValidBoxSlug("foo.txt"), false);
    assert.equal(isValidBoxSlug("foo"), false);
    assert.equal(isValidBoxSlug("foo.MD"), false);
  });

  it("rejeita maiúsculas em qualquer posição (não só README.md)", () => {
    assert.equal(isValidBoxSlug("Foo.md"), false);
    assert.equal(isValidBoxSlug("foo-Bar.md"), false);
  });
});

describe("extractBoxTitle (#3924)", () => {
  it("usa o primeiro heading, sem os '#'", () => {
    assert.equal(extractBoxTitle("# Recomendação de leitura\n\nTexto aqui."), "Recomendação de leitura");
    assert.equal(extractBoxTitle("## Um heading nível 2"), "Um heading nível 2");
  });

  it("usa a primeira linha não-vazia quando não é heading", () => {
    assert.equal(extractBoxTitle("\n\nOlá, leitor!\nSegunda linha."), "Olá, leitor!");
  });

  it("trunca títulos longos a ~80 chars com reticências", () => {
    const long = "A".repeat(120);
    const title = extractBoxTitle(long);
    assert.ok(title.length <= 80);
    assert.ok(title.endsWith("…"));
  });

  it("arquivo vazio (ou só linhas em branco) vira '(vazio)'", () => {
    assert.equal(extractBoxTitle(""), "(vazio)");
    assert.equal(extractBoxTitle("\n\n   \n"), "(vazio)");
  });
});

describe("readBoxSlotAssignments (#3924)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-slots-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem platform.config.json -> {} (fail-soft)", () => {
    assert.deepEqual(readBoxSlotAssignments(root), {});
  });

  it("com boxes_divulgacao -> mapa filename -> slot", () => {
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({
        boxes_divulgacao: { slot1: "a.md", slot2: "b.md", slot3: "c.md" },
      }),
    );
    assert.deepEqual(readBoxSlotAssignments(root), { "a.md": 1, "b.md": 2, "c.md": 3 });
  });

  it("JSON corrompido -> {} (fail-soft, nunca lança)", () => {
    const corruptRoot = mkdtempSync(join(tmpdir(), "studio-boxes-slots-corrupt-"));
    writeFileSync(join(corruptRoot, "platform.config.json"), "{ not json");
    assert.deepEqual(readBoxSlotAssignments(corruptRoot), {});
    rmSync(corruptRoot, { recursive: true, force: true });
  });

  it("boxes_divulgacao ausente/malformado -> {} (fail-soft)", () => {
    const otherRoot = mkdtempSync(join(tmpdir(), "studio-boxes-slots-other-"));
    writeFileSync(join(otherRoot, "platform.config.json"), JSON.stringify({ newsletter: "beehiiv" }));
    assert.deepEqual(readBoxSlotAssignments(otherRoot), {});
    rmSync(otherRoot, { recursive: true, force: true });
  });
});

describe("checkDirtyVsGit (#3924) — fail-soft sem repo git real", () => {
  it("rootDir que não é um repo git -> false, nunca lança", () => {
    const root = mkdtempSync(join(tmpdir(), "studio-boxes-nogit-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "a.md"), "# A");
    assert.equal(checkDirtyVsGit(root, "a.md"), false);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("listBoxes (#3924)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-list-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato dos snippets\n\nDocumentação.");
    writeFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "# Recomendação de leitura\n\nConteúdo A.");
    writeFileSync(join(root, "context", "snippets", "apoio-divulgacao.md"), "# Apoio\n\nConteúdo B.");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot1: "recomendacao-leitura.md" } }),
    );
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("diretório ausente -> []", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "studio-boxes-nodir-"));
    assert.deepEqual(listBoxes(emptyRoot), []);
    rmSync(emptyRoot, { recursive: true, force: true });
  });

  it("lista dinâmica exclui README.md, ordenada por slug, com título/mtime/slot/dirtyVsGit", () => {
    const boxes = listBoxes(root);
    const slugs = boxes.map((b) => b.slug);
    assert.ok(!slugs.includes("README.md"), "README.md nunca deve aparecer na lista");
    assert.deepEqual(slugs, ["apoio-divulgacao.md", "recomendacao-leitura.md"]);

    const recomendacao = boxes.find((b) => b.slug === "recomendacao-leitura.md")!;
    assert.equal(recomendacao.title, "Recomendação de leitura");
    assert.equal(recomendacao.slot, 1);
    assert.equal(recomendacao.dirtyVsGit, false); // sem repo git real no fixture
    assert.match(recomendacao.mtimeIso, /^\d{4}-\d{2}-\d{2}T/);

    const apoio = boxes.find((b) => b.slug === "apoio-divulgacao.md")!;
    assert.equal(apoio.title, "Apoio");
    assert.equal(apoio.slot, null); // não atribuído a nenhum slot no fixture
  });
});

// ─── leitura/escrita de 1 caixa (pura) ────────────────────────────────────

describe("readBox / saveBox (#3924, pure)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-rw-"));
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "doc");
    writeFileSync(join(root, "context", "snippets", "box-a.md"), "# Box A\n\nOriginal.");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("readBox: slug válido existente -> ok:true com content/modifiedAt", () => {
    const state = readBox(root, "box-a.md");
    assert.equal(state.ok, true);
    assert.match(state.content, /Original/);
    assert.ok(state.modifiedAt);
  });

  it("readBox: README.md -> ok:false (rejeitado explicitamente)", () => {
    const state = readBox(root, "README.md");
    assert.equal(state.ok, false);
  });

  it("readBox: traversal -> ok:false", () => {
    assert.equal(readBox(root, "../README.md").ok, false);
    assert.equal(readBox(root, "..%2fREADME.md").ok, false);
  });

  it("readBox: slug bem-formado mas inexistente -> ok:false", () => {
    const state = readBox(root, "nao-existe.md");
    assert.equal(state.ok, false);
    assert.match(state.error ?? "", /não encontrada/);
  });

  it("saveBox: happy path sobrescreve o conteúdo e devolve novo modifiedAt", () => {
    const loaded = readBox(root, "box-a.md");
    const result = saveBox(root, "box-a.md", "# Box A\n\nAtualizado.", { expectedModifiedAt: loaded.modifiedAt });
    assert.equal(result.ok, true);
    assert.match(readFileSync(boxFilePath(root, "box-a.md"), "utf8"), /Atualizado/);
    assert.notEqual(result.modifiedAt, undefined);
  });

  it("saveBox: expectedModifiedAt divergente -> conflict:true, NÃO sobrescreve", () => {
    const filePath = boxFilePath(root, "box-a.md");
    const staleModifiedAt = statSync(filePath).mtime.toISOString();
    // Simula outra sessão escrevendo por baixo.
    writeFileSync(filePath, "# Box A\n\nEscrita concorrente.", "utf8");

    const result = saveBox(root, "box-a.md", "minha versão local", { expectedModifiedAt: staleModifiedAt });
    assert.equal(result.ok, false);
    assert.equal(result.conflict, true);
    assert.ok(result.currentModifiedAt);
    assert.match(readFileSync(filePath, "utf8"), /Escrita concorrente/, "não deve sobrescrever em caso de conflito");
  });

  it("saveBox: force:true sobrescreve mesmo com expectedModifiedAt divergente", () => {
    const filePath = boxFilePath(root, "box-a.md");
    const staleModifiedAt = statSync(filePath).mtime.toISOString();
    writeFileSync(filePath, "# Box A\n\noutra escrita concorrente 2", "utf8");

    const result = saveBox(root, "box-a.md", "sobrescrita forçada", {
      expectedModifiedAt: staleModifiedAt,
      force: true,
    });
    assert.equal(result.ok, true);
    assert.equal(readFileSync(filePath, "utf8"), "sobrescrita forçada");
  });

  it("saveBox: sem expectedModifiedAt no corpo pula a checagem de conflito", () => {
    const result = saveBox(root, "box-a.md", "sem checagem de mtime");
    assert.equal(result.ok, true);
    assert.equal(result.conflict, undefined);
  });

  it("saveBox: README.md -> notFound:true (rejeitado, nunca escreve)", () => {
    const result = saveBox(root, "README.md", "tentativa de sobrescrever o README");
    assert.equal(result.ok, false);
    assert.equal(result.notFound, true);
    assert.equal(readFileSync(join(root, "context", "snippets", "README.md"), "utf8"), "doc");
  });

  it("saveBox: traversal -> notFound:true, nunca escreve fora de context/snippets/", () => {
    const result = saveBox(root, "../outside.md", "não deveria ir a lugar nenhum");
    assert.equal(result.ok, false);
    assert.equal(result.notFound, true);
  });

  it("saveBox: slug bem-formado mas inexistente -> notFound:true (criação está fora de escopo)", () => {
    const result = saveBox(root, "nova-caixa.md", "conteúdo novo");
    assert.equal(result.ok, false);
    assert.equal(result.notFound, true);
  });
});

// ─── contrato HTTP ─────────────────────────────────────────────────────────

describe("GET /caixas + /api/boxes + PUT (#3924)", () => {
  let root: string;
  let server: StudioServer;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "studio-boxes-http-"));
    mkdirSync(join(root, "data", "editions"), { recursive: true });
    mkdirSync(join(root, "context", "snippets"), { recursive: true });
    writeFileSync(join(root, "context", "snippets", "README.md"), "# Formato\n\nDoc.");
    writeFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "# Recomendação\n\nConteúdo.");
    writeFileSync(
      join(root, "platform.config.json"),
      JSON.stringify({ boxes_divulgacao: { slot1: "recomendacao-leitura.md" } }),
    );
    server = await startStudioServer({ port: 0, rootDir: root, pollIntervalMs: 30 });
  });

  after(async () => {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("serve o shell caixas.html", async () => {
    const res = await fetch(new URL("/caixas", server.url));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const body = await res.text();
    assert.ok(body.includes("caixas.js"));
    assert.ok(body.includes("boxes-list"));
  });

  it("aceita /caixas/ com trailing slash", async () => {
    const res = await fetch(new URL("/caixas/", server.url));
    assert.equal(res.status, 200);
  });

  it("GET /caixas.js e /caixas.css são servidos com content-type correto", async () => {
    const js = await fetch(new URL("/caixas.js", server.url));
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const css = await fetch(new URL("/caixas.css", server.url));
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") ?? "", /css/);
  });

  it("GET /api/boxes lista dinamicamente, sem README.md, com badge de slot", async () => {
    const res = await fetch(new URL("/api/boxes", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    const slugs = body.boxes.map((b: { slug: string }) => b.slug);
    assert.ok(!slugs.includes("README.md"));
    assert.ok(slugs.includes("recomendacao-leitura.md"));
    const box = body.boxes.find((b: { slug: string }) => b.slug === "recomendacao-leitura.md");
    assert.equal(box.slot, 1);
    assert.equal(box.title, "Recomendação");
  });

  it("GET /api/boxes/:slug retorna conteúdo + modifiedAt", async () => {
    const res = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.match(body.content, /Conteúdo/);
    assert.ok(body.modifiedAt);
  });

  it("GET /api/boxes/:slug com README.md -> 404", async () => {
    const res = await fetch(new URL("/api/boxes/README.md", server.url));
    assert.equal(res.status, 404);
  });

  it("GET /api/boxes/:slug com traversal -> 404", async () => {
    const res = await fetch(new URL("/api/boxes/foo.txt", server.url));
    assert.equal(res.status, 404);
  });

  it("GET /api/boxes/:slug inexistente -> 404", async () => {
    const res = await fetch(new URL("/api/boxes/nao-existe.md", server.url));
    assert.equal(res.status, 404);
  });

  let loadedModifiedAt = "";

  it("PUT /api/boxes/:slug feliz — salva e devolve novo modifiedAt", async () => {
    const getRes = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url));
    const getBody = await getRes.json();
    loadedModifiedAt = getBody.modifiedAt;

    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# Recomendação\n\nEditado via painel.", expectedModifiedAt: loadedModifiedAt }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.json();
    assert.equal(putBody.ok, true);
    assert.match(
      readFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "utf8"),
      /Editado via painel/,
    );
    loadedModifiedAt = putBody.modifiedAt;
  });

  it("PUT com expectedModifiedAt obsoleto -> 409, não sobrescreve", async () => {
    // `loadedModifiedAt` agora está obsoleto (mtime mudou no teste anterior) —
    // simula outra sessão escrevendo por baixo antes deste PUT.
    writeFileSync(
      join(root, "context", "snippets", "recomendacao-leitura.md"),
      "# Recomendação\n\nEscrita concorrente (outra aba).",
      "utf8",
    );
    const staleModifiedAt = loadedModifiedAt;

    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "minha versão", expectedModifiedAt: staleModifiedAt }),
    });
    assert.equal(put.status, 409);
    const body = await put.json();
    assert.equal(body.conflict, true);
    assert.match(
      readFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "utf8"),
      /Escrita concorrente/,
    );
  });

  it("PUT com force:true sobrescreve mesmo com expectedModifiedAt divergente", async () => {
    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "sobrescrita forçada via HTTP", expectedModifiedAt: loadedModifiedAt, force: true }),
    });
    assert.equal(put.status, 200);
    assert.equal(
      readFileSync(join(root, "context", "snippets", "recomendacao-leitura.md"), "utf8"),
      "sobrescrita forçada via HTTP",
    );
  });

  it("PUT /api/boxes/README.md -> 404, nunca escreve", async () => {
    const put = await fetch(new URL("/api/boxes/README.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "tentativa de sobrescrever o README" }),
    });
    assert.equal(put.status, 404);
    assert.equal(readFileSync(join(root, "context", "snippets", "README.md"), "utf8"), "# Formato\n\nDoc.");
  });

  it("PUT com traversal no slug -> 404", async () => {
    const put = await fetch(new URL("/api/boxes/..%2Foutside.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    assert.equal(put.status, 404);
  });

  it("PUT em slug bem-formado mas inexistente -> 404 (criação fora de escopo)", async () => {
    const put = await fetch(new URL("/api/boxes/nova-caixa.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    assert.equal(put.status, 404);
  });

  it("PUT com corpo sem 'content' -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedModifiedAt: null }),
    });
    assert.equal(put.status, 400);
  });

  it("PUT com corpo não-JSON -> 400", async () => {
    const put = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "não é json",
    });
    assert.equal(put.status, 400);
  });

  it("POST /api/boxes/recomendacao-leitura.md (método não-allowlistado) -> 405 (guard read-only)", async () => {
    const res = await fetch(new URL("/api/boxes/recomendacao-leitura.md", server.url), { method: "POST" });
    assert.equal(res.status, 405);
  });
});
