import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  chunkBase64,
  encodeHtmlBase64,
  chunkHtmlFile,
  writeChunks,
} from "../scripts/chunk-html-base64.ts";

describe("chunkBase64 (#1054 playbook chunked paste)", () => {
  it("split exato em chunks de tamanho fixo", () => {
    const chunks = chunkBase64("aaaabbbbcccc", 4);
    assert.deepEqual(chunks, ["aaaa", "bbbb", "cccc"]);
  });

  it("último chunk pode ser menor que chunkSize", () => {
    const chunks = chunkBase64("aaaabbbbccc", 4);
    assert.deepEqual(chunks, ["aaaa", "bbbb", "ccc"]);
  });

  it("string menor que chunkSize → 1 chunk único", () => {
    const chunks = chunkBase64("ab", 100);
    assert.deepEqual(chunks, ["ab"]);
  });

  it("string vazia → 0 chunks", () => {
    const chunks = chunkBase64("", 100);
    assert.deepEqual(chunks, []);
  });

  it("chunkSize=0 lança", () => {
    assert.throws(() => chunkBase64("abc", 0), /chunkSize/);
  });

  it("chunkSize negativo lança", () => {
    assert.throws(() => chunkBase64("abc", -5), /chunkSize/);
  });

  it("concatenação reconstrói original", () => {
    const original = "the quick brown fox jumps over the lazy dog 0123456789";
    const chunks = chunkBase64(original, 7);
    assert.equal(chunks.join(""), original);
  });
});

describe("encodeHtmlBase64", () => {
  it("encoda HTML ASCII corretamente", () => {
    const html = "<p>hello</p>";
    const b64 = encodeHtmlBase64(html);
    assert.equal(Buffer.from(b64, "base64").toString("utf8"), html);
  });

  it("preserva UTF-8 com acentos PT-BR", () => {
    const html = "<p>ação inteligência artificial</p>";
    const b64 = encodeHtmlBase64(html);
    assert.equal(Buffer.from(b64, "base64").toString("utf8"), html);
  });

  it("preserva merge tags Liquid intactas", () => {
    const html = '<a href="{{poll_a_url}}">Votar A</a>';
    const b64 = encodeHtmlBase64(html);
    const decoded = Buffer.from(b64, "base64").toString("utf8");
    assert.ok(decoded.includes("{{poll_a_url}}"));
  });
});

describe("writeChunks", () => {
  it("escreve cada chunk em _b64_{i}.txt", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chunk-test-"));
    const files = writeChunks(dir, ["aaa", "bbb", "ccc"]);
    assert.deepEqual(files, ["_b64_0.txt", "_b64_1.txt", "_b64_2.txt"]);
    assert.equal(readFileSync(resolve(dir, "_b64_0.txt"), "utf8"), "aaa");
    assert.equal(readFileSync(resolve(dir, "_b64_1.txt"), "utf8"), "bbb");
    assert.equal(readFileSync(resolve(dir, "_b64_2.txt"), "utf8"), "ccc");
  });

  it("limpa _b64_*.txt antigos antes de escrever os novos", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chunk-test-"));
    // Pre-existing stale chunk de execução anterior (5 chunks)
    writeFileSync(resolve(dir, "_b64_0.txt"), "stale0", "utf8");
    writeFileSync(resolve(dir, "_b64_1.txt"), "stale1", "utf8");
    writeFileSync(resolve(dir, "_b64_2.txt"), "stale2", "utf8");
    writeFileSync(resolve(dir, "_b64_3.txt"), "stale3", "utf8");
    writeFileSync(resolve(dir, "_b64_4.txt"), "stale4", "utf8");
    // Nova execução produz só 2 chunks
    writeChunks(dir, ["new0", "new1"]);
    assert.equal(readFileSync(resolve(dir, "_b64_0.txt"), "utf8"), "new0");
    assert.equal(readFileSync(resolve(dir, "_b64_1.txt"), "utf8"), "new1");
    // Os stale 2-4 devem ter sido apagados
    assert.equal(existsSync(resolve(dir, "_b64_2.txt")), false);
    assert.equal(existsSync(resolve(dir, "_b64_3.txt")), false);
    assert.equal(existsSync(resolve(dir, "_b64_4.txt")), false);
  });

  it("não toca em arquivos não-_b64_*.txt", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chunk-test-"));
    writeFileSync(resolve(dir, "newsletter-final.html"), "html-content", "utf8");
    writeFileSync(resolve(dir, "other.json"), "{}", "utf8");
    writeChunks(dir, ["chunk0"]);
    assert.equal(readFileSync(resolve(dir, "newsletter-final.html"), "utf8"), "html-content");
    assert.equal(readFileSync(resolve(dir, "other.json"), "utf8"), "{}");
  });
});

describe("chunkHtmlFile — integração", () => {
  it("encoda + chunka HTML real e reconstrói via concat", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chunk-test-"));
    const internalDir = resolve(dir, "_internal");
    mkdirSync(internalDir);
    const html = '<a href="{{poll_a_url}}">Votar</a>'.repeat(500); // ~17KB
    const htmlPath = resolve(internalDir, "newsletter-final.html");
    writeFileSync(htmlPath, html, "utf8");

    const result = chunkHtmlFile(htmlPath, internalDir, 6500);
    assert.equal(result.htmlBytes, Buffer.byteLength(html, "utf8"));
    assert.ok(result.chunkCount >= 4); // 17KB+ b64 → multiple chunks of 6500
    assert.equal(result.chunkSize, 6500);
    assert.equal(result.files.length, result.chunkCount);

    // Reconstruir
    const concat = result.files
      .map((f) => readFileSync(resolve(internalDir, f), "utf8"))
      .join("");
    assert.equal(concat.length, result.totalBase64Bytes);
    const decoded = Buffer.from(concat, "base64").toString("utf8");
    assert.equal(decoded, html);
  });

  it("aborta se HTML não existe", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chunk-test-"));
    assert.throws(
      () => chunkHtmlFile(resolve(dir, "missing.html"), dir, 6500),
      /não encontrado/,
    );
  });

  it("preserva merge tags na reconstrução", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "chunk-test-"));
    const internalDir = resolve(dir, "_internal");
    mkdirSync(internalDir);
    const html = `
      <a href="{{poll_a_url}}">Votar A</a>
      <a href="{{poll_b_url}}">Votar B</a>
      <img src="{{IMG:01-eia-A.jpg}}">
    `;
    const htmlPath = resolve(internalDir, "newsletter-final.html");
    writeFileSync(htmlPath, html, "utf8");

    const result = chunkHtmlFile(htmlPath, internalDir, 50);
    const concat = result.files
      .map((f) => readFileSync(resolve(internalDir, f), "utf8"))
      .join("");
    const decoded = Buffer.from(concat, "base64").toString("utf8");
    assert.ok(decoded.includes("{{poll_a_url}}"));
    assert.ok(decoded.includes("{{poll_b_url}}"));
    assert.ok(decoded.includes("{{IMG:01-eia-A.jpg}}"));
  });
});
