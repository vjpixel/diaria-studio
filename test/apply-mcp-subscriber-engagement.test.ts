/**
 * apply-mcp-subscriber-engagement.test.ts (#6465)
 *
 * Cobre applyEngagement (write JSONL + manifest de cobertura), o guard de
 * replace-vazio (mesmo padrão de #4836 em apply-mcp-clicks.ts) e a
 * tolerância de shape do input. Sem rede — a extração real via MCP não
 * pode ser exercitada aqui (só chamável de dentro de uma sessão Claude).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  applyEngagement,
  extractEngagementArray,
  countExistingLines,
  readExistingRecords,
  mergeEngagementRecords,
  EmptyReplaceGuardError,
} from "../scripts/apply-mcp-subscriber-engagement.ts";
import type { EngagementManifest } from "../scripts/lib/beehiiv-engagement-manifest.ts";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "apply-mcp-engagement-"));
  return { outDir: resolve(dir, "subscriber-engagement") };
}

function readManifest(outDir: string): EngagementManifest {
  return JSON.parse(readFileSync(resolve(outDir, "manifest.json"), "utf8"));
}

describe("extractEngagementArray — tolerância de input", () => {
  it("aceita { engagement: [...] }", () => {
    assert.equal(extractEngagementArray({ engagement: [{ a: 1 }] }).length, 1);
  });
  it("aceita { data: [...] }", () => {
    assert.equal(extractEngagementArray({ data: [{ a: 1 }, { a: 2 }] }).length, 2);
  });
  it("aceita array nu", () => {
    assert.equal(extractEngagementArray([{ a: 1 }]).length, 1);
  });
  it("retorna [] pra formatos não reconhecidos", () => {
    assert.deepEqual(extractEngagementArray(null), []);
    assert.deepEqual(extractEngagementArray(undefined), []);
    assert.deepEqual(extractEngagementArray(42), []);
    assert.deepEqual(extractEngagementArray("x"), []);
    assert.deepEqual(extractEngagementArray({ foo: "bar" }), []);
  });
});

describe("applyEngagement — grava JSONL cru + manifest de cobertura", () => {
  it("write cria o .jsonl com 1 linha por registro, verbatim (sem reshape)", () => {
    const { outDir } = setup();
    const stdin = JSON.stringify({
      engagement: [
        { subscriber_id: "sub_1", opens: 3, clicks: 1 },
        { subscriber_id: "sub_2", opens: 0, clicks: 0 },
      ],
    });
    const result = applyEngagement(stdin, { postId: "post_1", title: "Título A", outDir });
    assert.equal(result.after_count, 2);
    assert.equal(result.status, "ok");

    const jsonlPath = resolve(outDir, "post_1.jsonl");
    assert.ok(existsSync(jsonlPath));
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(lines[0], { subscriber_id: "sub_1", opens: 3, clicks: 1 }, "registro gravado verbatim, sem remapear campos");
  });

  it("grava/atualiza manifest.json com status ok e count", () => {
    const { outDir } = setup();
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }), { postId: "post_1", title: "T", outDir });
    const manifest = readManifest(outDir);
    const entry = manifest.posts.find((p) => p.post_id === "post_1")!;
    assert.equal(entry.status, "ok");
    assert.equal(entry.count, 1);
    assert.equal(entry.title, "T");
    assert.ok(entry.fetched_at);
  });

  it("pages_fetched < total_pages → status partial (paginação truncada)", () => {
    const { outDir } = setup();
    const result = applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }), {
      postId: "post_1",
      pagesFetched: 1,
      totalPages: 3,
      outDir,
    });
    assert.equal(result.status, "partial");
    const entry = readManifest(outDir).posts[0];
    assert.equal(entry.status, "partial");
    assert.equal(entry.pages_fetched, 1);
    assert.equal(entry.total_pages, 3);
  });

  it("pages_fetched === total_pages → status ok mesmo passando ambos explicitamente", () => {
    const { outDir } = setup();
    const result = applyEngagement(JSON.stringify({ engagement: [] }), {
      postId: "post_1",
      pagesFetched: 2,
      totalPages: 2,
      outDir,
    });
    assert.equal(result.status, "ok");
  });

  it("upsert de um 2º post não apaga a entry do 1º no manifest", () => {
    const { outDir } = setup();
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }), { postId: "post_1", outDir });
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_2" }] }), { postId: "post_2", outDir });
    const manifest = readManifest(outDir);
    assert.equal(manifest.posts.length, 2);
  });
});

describe("applyEngagement — guard REPLACE-vazio (mesmo padrão de #4836)", () => {
  it("recusa apagar JSONL não-vazio com payload vazio, por padrão", () => {
    const { outDir } = setup();
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }), { postId: "post_1", outDir });
    assert.equal(countExistingLines(resolve(outDir, "post_1.jsonl")), 1);

    assert.throws(
      () => applyEngagement(JSON.stringify({ engagement: [] }), { postId: "post_1", outDir }),
      EmptyReplaceGuardError,
    );
    // arquivo não foi tocado pelo guard
    assert.equal(countExistingLines(resolve(outDir, "post_1.jsonl")), 1);
  });

  it("--allow-empty-replace explícito permite o replace vazio", () => {
    const { outDir } = setup();
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }), { postId: "post_1", outDir });

    const result = applyEngagement(JSON.stringify({ engagement: [] }), { postId: "post_1", outDir, allowEmptyReplace: true });
    assert.equal(result.after_count, 0);
    assert.equal(countExistingLines(resolve(outDir, "post_1.jsonl")), 0);
  });

  it("replace vazio sobre JSONL já vazio (post novo) não aciona o guard", () => {
    const { outDir } = setup();
    const result = applyEngagement(JSON.stringify({ engagement: [] }), { postId: "post_novo", outDir });
    assert.equal(result.before_count, 0);
    assert.equal(result.after_count, 0);
    assert.equal(result.status, "ok");
  });

  it("guard dispara ANTES de atualizar o manifest — post continua com o status anterior, não vira ok/error espúrio", () => {
    const { outDir } = setup();
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }), { postId: "post_1", outDir });
    const before = readManifest(outDir).posts.find((p) => p.post_id === "post_1")!;

    assert.throws(() => applyEngagement(JSON.stringify({ engagement: [] }), { postId: "post_1", outDir }), EmptyReplaceGuardError);

    const after = readManifest(outDir).posts.find((p) => p.post_id === "post_1")!;
    assert.deepEqual(after, before, "manifest não deve mudar quando o guard recusa o write");
  });
});

describe("applyEngagement — modo --append (#6733)", () => {
  it("aplicar 2 páginas em sequência via --append resulta nas duas presentes (sem sobrescrever a 1ª)", () => {
    const { outDir } = setup();
    const page1 = applyEngagement(
      JSON.stringify({ engagement: [{ subscriber_id: "sub_1", opens: 1 }, { subscriber_id: "sub_2", opens: 2 }] }),
      { postId: "post_1", pagesFetched: 1, totalPages: 2, outDir },
    );
    assert.equal(page1.after_count, 2);
    assert.equal(page1.status, "partial");

    const page2 = applyEngagement(
      JSON.stringify({ engagement: [{ subscriber_id: "sub_3", opens: 3 }] }),
      { postId: "post_1", pagesFetched: 2, totalPages: 2, append: true, outDir },
    );
    assert.equal(page2.before_count, 2);
    assert.equal(page2.after_count, 3);
    assert.equal(page2.status, "ok");

    const jsonlPath = resolve(outDir, "post_1.jsonl");
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const ids = lines.map((l) => l.subscriber_id).sort();
    assert.deepEqual(ids, ["sub_1", "sub_2", "sub_3"], "as duas páginas ficam presentes, nada foi sobrescrito");
  });

  it("dedup por subscriber_id entre páginas — incoming vence em caso de conflito", () => {
    const { outDir } = setup();
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1", opens: 1 }] }), { postId: "post_1", outDir });
    const result = applyEngagement(
      JSON.stringify({ engagement: [{ subscriber_id: "sub_1", opens: 99 }] }),
      { postId: "post_1", append: true, outDir },
    );
    assert.equal(result.after_count, 1, "mesmo subscriber_id não duplica");

    const jsonlPath = resolve(outDir, "post_1.jsonl");
    const lines = readFileSync(jsonlPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].opens, 99, "registro incoming vence sobre o já existente");
  });

  it("--append cobre a 1ª aplicação (arquivo ainda não existente)", () => {
    const { outDir } = setup();
    const result = applyEngagement(
      JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }),
      { postId: "post_novo", append: true, outDir },
    );
    assert.equal(result.before_count, 0);
    assert.equal(result.after_count, 1);
    assert.equal(countExistingLines(resolve(outDir, "post_novo.jsonl")), 1);
  });

  it("--append com payload vazio nunca aciona o guard de replace-vazio (mescla, não substitui)", () => {
    const { outDir } = setup();
    applyEngagement(JSON.stringify({ engagement: [{ subscriber_id: "sub_1" }] }), { postId: "post_1", outDir });
    // Sem --allow-empty-replace — se isto fosse REPLACE, lançaria EmptyReplaceGuardError.
    const result = applyEngagement(JSON.stringify({ engagement: [] }), { postId: "post_1", append: true, outDir });
    assert.equal(result.after_count, 1, "página vazia em --append não apaga o que já estava");
  });

  it("registros sem subscriber_id nunca são deduplicados entre si", () => {
    const merged = mergeEngagementRecords([{ note: "a" }], [{ note: "b" }]);
    assert.equal(merged.length, 2, "cada registro sem subscriber_id é tratado como único");
  });
});

describe("readExistingRecords", () => {
  it("[] quando o arquivo não existe", () => {
    const { outDir } = setup();
    assert.deepEqual(readExistingRecords(resolve(outDir, "nope.jsonl")), []);
  });

  it("faz parse de cada linha não-vazia", () => {
    const { outDir } = setup();
    mkdirSync(outDir, { recursive: true });
    const path = resolve(outDir, "manual.jsonl");
    writeFileSync(path, '{"subscriber_id":"a"}\n{"subscriber_id":"b"}\n\n');
    assert.deepEqual(readExistingRecords(path), [{ subscriber_id: "a" }, { subscriber_id: "b" }]);
  });
});

describe("countExistingLines", () => {
  it("0 quando arquivo não existe", () => {
    const { outDir } = setup();
    assert.equal(countExistingLines(resolve(outDir, "nope.jsonl")), 0);
  });

  it("ignora linhas em branco no final", () => {
    const { outDir } = setup();
    const path = resolve(outDir, "manual.jsonl");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path, '{"a":1}\n{"a":2}\n\n');
    assert.equal(countExistingLines(path), 2);
  });
});
