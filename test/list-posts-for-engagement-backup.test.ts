/**
 * list-posts-for-engagement-backup.test.ts (#6465)
 *
 * Cobre `latestBackupDateDir` (escolha do backup mais recente) e
 * `discoverPostsFromDir` (scan + tolerância de shape + resiliência a
 * arquivos corrompidos) — os 2 helpers puros/injetáveis do script de
 * enumeração de posts pendentes.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { latestBackupDateDir, discoverPostsFromDir } from "../scripts/list-posts-for-engagement-backup.ts";

describe("latestBackupDateDir", () => {
  it("escolhe a data mais recente entre vários dirs YYYY-MM-DD", () => {
    assert.equal(latestBackupDateDir(["2026-08-01", "2026-08-27", "2026-08-15"]), "2026-08-27");
  });
  it("ignora entries que não batem o padrão YYYY-MM-DD", () => {
    assert.equal(latestBackupDateDir(["subscriber-engagement", "2026-08-10", "README.md"]), "2026-08-10");
  });
  it("null quando não há nenhum dir de data", () => {
    assert.equal(latestBackupDateDir(["subscriber-engagement", ".gitkeep"]), null);
  });
  it("null pra lista vazia", () => {
    assert.equal(latestBackupDateDir([]), null);
  });
});

describe("discoverPostsFromDir", () => {
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "list-posts-engagement-"));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("lê posts em shape plano e aninhado misturados no mesmo diretório", () => {
    const dir = setup();
    writeFileSync(resolve(dir, "post_1.json"), JSON.stringify({ id: "post_1", title: "Plano" }));
    writeFileSync(resolve(dir, "post_2.json"), JSON.stringify({ data: { id: "post_2", title: "Aninhado" } }));
    const posts = discoverPostsFromDir(dir);
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.find((p) => p.id === "post_1"), { id: "post_1", title: "Plano" });
    assert.deepEqual(posts.find((p) => p.id === "post_2"), { id: "post_2", title: "Aninhado" });
  });

  it("ignora arquivos JSON corrompidos sem abortar o scan inteiro", () => {
    const dir = setup();
    writeFileSync(resolve(dir, "post_1.json"), JSON.stringify({ id: "post_1" }));
    writeFileSync(resolve(dir, "post_corrompido.json"), "{ isso não é json válido");
    const posts = discoverPostsFromDir(dir);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, "post_1");
  });

  it("ignora arquivos sem id reconhecível", () => {
    const dir = setup();
    writeFileSync(resolve(dir, "manifest.json"), JSON.stringify({ generated_at: "x" }));
    const posts = discoverPostsFromDir(dir);
    assert.equal(posts.length, 0);
  });

  it("ignora arquivos não-.json no diretório", () => {
    const dir = setup();
    writeFileSync(resolve(dir, "post_1.json"), JSON.stringify({ id: "post_1" }));
    writeFileSync(resolve(dir, "notes.txt"), "não é json");
    const posts = discoverPostsFromDir(dir);
    assert.equal(posts.length, 1);
  });
});
