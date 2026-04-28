import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aammddFromIso,
  extractUrlsFromApproved,
  populateLinksFromApproved,
  type Post,
} from "../scripts/refresh-past-editions.ts";

/**
 * Tests do fix #238 — popular `links[]` em past-editions a partir do
 * `_internal/01-approved.json` local de cada edição produzida nesta máquina.
 * Source-of-truth completo, sem dependência de Beehiiv API.
 */

describe("aammddFromIso (#238)", () => {
  it("converte ISO completo pra AAMMDD UTC", () => {
    assert.equal(aammddFromIso("2026-04-25T10:00:00Z"), "260425");
    assert.equal(aammddFromIso("2025-12-31T23:59:59Z"), "251231");
    assert.equal(aammddFromIso("2027-01-01T00:00:00Z"), "270101");
  });

  it("aceita ISO date-only", () => {
    assert.equal(aammddFromIso("2026-04-25"), "260425");
  });

  it("retorna string vazia em ISO inválido", () => {
    assert.equal(aammddFromIso("garbage"), "");
    assert.equal(aammddFromIso(""), "");
  });

  it("usa UTC (não local timezone)", () => {
    // 2026-04-25T01:00:00Z em SP (UTC-3) seria 2026-04-24 22:00 — mas
    // queremos AAMMDD pra UTC. Resultado: 260425.
    assert.equal(aammddFromIso("2026-04-25T01:00:00Z"), "260425");
  });
});

describe("extractUrlsFromApproved (#238)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "approved-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeApproved(yymmdd: string, content: unknown) {
    const dir = join(tmpRoot, "data/editions", yymmdd, "_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-approved.json"), JSON.stringify(content), "utf8");
  }

  it("retorna [] quando arquivo não existe", () => {
    const urls = extractUrlsFromApproved("260101", tmpRoot);
    assert.deepEqual(urls, []);
  });

  it("retorna [] quando yymmdd vazio", () => {
    const urls = extractUrlsFromApproved("", tmpRoot);
    assert.deepEqual(urls, []);
  });

  it("retorna [] quando JSON é malformado (silent fallback)", () => {
    const dir = join(tmpRoot, "data/editions/260425/_internal");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-approved.json"), "{ not json", "utf8");
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.deepEqual(urls, []);
  });

  it("extrai URLs de todos os buckets + highlights + runners_up", () => {
    writeApproved("260425", {
      highlights: [
        { rank: 1, score: 92, article: { url: "https://h1.com/post" } },
        { rank: 2, score: 88, article: { url: "https://h2.com/post" } },
        { rank: 3, score: 80, article: { url: "https://h3.com/post" } },
      ],
      runners_up: [
        { article: { url: "https://r1.com/post" } },
        { article: { url: "https://r2.com/post" } },
      ],
      lancamento: [
        { url: "https://l1.com/launch" },
        { url: "https://l2.com/launch" },
      ],
      pesquisa: [{ url: "https://p1.com/paper" }],
      noticias: [
        { url: "https://n1.com/news" },
        { url: "https://n2.com/news" },
      ],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 10);
    assert.ok(urls.includes("https://h1.com/post"));
    assert.ok(urls.includes("https://r1.com/post"));
    assert.ok(urls.includes("https://l1.com/launch"));
    assert.ok(urls.includes("https://p1.com/paper"));
    assert.ok(urls.includes("https://n1.com/news"));
  });

  it("dedupa URLs presentes em múltiplos buckets", () => {
    writeApproved("260425", {
      highlights: [{ article: { url: "https://shared.com/x" } }],
      runners_up: [],
      lancamento: [{ url: "https://shared.com/x" }],
      pesquisa: [],
      noticias: [],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://shared.com/x");
  });

  it("aceita highlight com URL flat (formato pré-#229)", () => {
    writeApproved("260425", {
      highlights: [
        { url: "https://flat.com/post" }, // formato legado
        { article: { url: "https://nested.com/post" } }, // formato spec
      ],
      runners_up: [],
      lancamento: [],
      pesquisa: [],
      noticias: [],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 2);
    assert.ok(urls.includes("https://flat.com/post"));
    assert.ok(urls.includes("https://nested.com/post"));
  });

  it("ignora entries sem url", () => {
    writeApproved("260425", {
      highlights: [{ article: {} }, { article: { url: "" } }],
      runners_up: [],
      lancamento: [{ url: "https://valid.com/post" }, {}],
      pesquisa: [],
      noticias: [],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.equal(urls.length, 1);
    assert.equal(urls[0], "https://valid.com/post");
  });

  it("aceita tutorial bucket opcional (#59)", () => {
    writeApproved("260425", {
      highlights: [],
      runners_up: [],
      lancamento: [],
      pesquisa: [],
      noticias: [],
      tutorial: [{ url: "https://tut.com/aprenda" }],
    });
    const urls = extractUrlsFromApproved("260425", tmpRoot);
    assert.deepEqual(urls, ["https://tut.com/aprenda"]);
  });
});

describe("populateLinksFromApproved (#238)", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "approved-pop-"));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writeApproved(yymmdd: string, urls: string[]) {
    const dir = join(tmpRoot, "data/editions", yymmdd, "_internal");
    mkdirSync(dir, { recursive: true });
    const content = {
      highlights: [],
      runners_up: [],
      lancamento: urls.map((url) => ({ url })),
      pesquisa: [],
      noticias: [],
    };
    writeFileSync(join(dir, "01-approved.json"), JSON.stringify(content), "utf8");
  }

  function makePost(overrides: Partial<Post> = {}): Post {
    return {
      id: "p1",
      title: "Edição teste",
      published_at: "2026-04-25T10:00:00Z",
      ...overrides,
    };
  }

  it("popula post.links a partir do approved.json local", () => {
    writeApproved("260425", ["https://a.com/1", "https://b.com/2"]);
    const post = makePost();
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 2);
    assert.deepEqual(post.links, ["https://a.com/1", "https://b.com/2"]);
  });

  it("idempotente: não toca post.links já populado", () => {
    writeApproved("260425", ["https://a.com/from-approved"]);
    const post = makePost({ links: ["https://existing.com/keep"] });
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 0);
    assert.deepEqual(post.links, ["https://existing.com/keep"]);
  });

  it("no-op quando arquivo local não existe (edição produzida em outra máquina)", () => {
    const post = makePost({ published_at: "2026-04-22T10:00:00Z" });
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 0);
    assert.equal(post.links, undefined);
  });

  it("muta post.links in-place (mesmo contrato do populateLinksFromTracking)", () => {
    writeApproved("260425", ["https://a.com/1"]);
    const post = makePost();
    assert.equal(post.links, undefined);
    populateLinksFromApproved(post, tmpRoot);
    assert.ok(Array.isArray(post.links));
    assert.equal(post.links?.length, 1);
  });

  it("trata links: [] (array vazio) como missing — popula", () => {
    writeApproved("260425", ["https://a.com/1"]);
    const post = makePost({ links: [] });
    const r = populateLinksFromApproved(post, tmpRoot);
    assert.equal(r.populated, 1);
    assert.deepEqual(post.links, ["https://a.com/1"]);
  });
});
