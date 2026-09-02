/**
 * test/coordinator-context-proxy.test.ts (#6634)
 *
 * Cobre `scripts/lib/coordinator-context-proxy.ts` — a estimativa mecânica
 * de tokens do coordenador via `context_size_proxy` (fallback quando o
 * harness não expõe `usage`, #6634 Direction 2).
 *
 * Testa as functions PURAS (sem filesystem) + a coleta de arquivos via
 * injeção de fsShims, nunca toca `data/` real do repo.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  BYTES_PER_TOKEN,
  measureContextFromContents,
  collectContextFiles,
  estimateCoordinatorTokensFromContents,
} from "../scripts/lib/coordinator-context-proxy.ts";

describe("bytesToTokens (#6634)", () => {
  it("usa ratio padrão de 4 bytes/token", () => {
    const result = measureContextFromContents([
      { name: "test.ts", content: "a".repeat(4000) },
    ]);
    assert.equal(result.estimatedTokens, 1000);
    assert.equal(result.totalBytes, 4000);
  });

  it("floor — nunca arredonda pra cima", () => {
    const result = measureContextFromContents([
      { name: "test.ts", content: "a".repeat(4001) },
    ]);
    assert.equal(result.estimatedTokens, 1000);
  });

  it("ratio customizável via opts", () => {
    const result = estimateCoordinatorTokensFromContents({
      contextFiles: [{ name: "CLAUDE.md", content: "x".repeat(300) }],
      bytesPerToken: 3,
    });
    assert.equal(result.estimatedTokens, 100);
    assert.equal(result.totalBytes, 300);
  });
});

describe("measureContextFromContents (#6634)", () => {
  it("soma bytes e tokens de múltiplos componentes", () => {
    const result = measureContextFromContents([
      { name: "CLAUDE.md", content: "a".repeat(4000) },
      { name: "context/rules.md", content: "b".repeat(8000) },
    ]);
    assert.equal(result.totalBytes, 12000);
    assert.equal(result.estimatedTokens, 3000);
    assert.equal(result.components.length, 2);
    assert.equal(result.components[0].name, "CLAUDE.md");
    assert.equal(result.components[0].tokens, 1000);
    assert.equal(result.components[1].tokens, 2000);
  });

  it("conteúdo vazio → 0 tokens, 0 bytes, components vazio", () => {
    const result = measureContextFromContents([]);
    assert.equal(result.totalBytes, 0);
    assert.equal(result.estimatedTokens, 0);
    assert.deepEqual(result.components, []);
  });

  it("utf8 multibyte conta bytes reais, não caracteres", () => {
    // "ñ" = 2 bytes em UTF-8; "a" = 1 byte
    const content = "a".repeat(3998) + "ñ"; // 4000 bytes
    const result = measureContextFromContents([
      { name: "test.md", content },
    ]);
    assert.equal(result.totalBytes, 4000);
    assert.equal(result.estimatedTokens, 1000);
    assert.equal(result.components[0].bytes, 4000);
  });
});

describe("estimateCoordinatorTokensFromContents (#6634)", () => {
  it("combina contextFiles + planContent + runLogLines", () => {
    const result = estimateCoordinatorTokensFromContents({
      contextFiles: [
        { name: "CLAUDE.md", content: "a".repeat(4000) }, // 1000 tokens
      ],
      planContent: JSON.stringify({ edition: "260827", issues: [] }), // ~35 bytes
      runLogLines: [
        JSON.stringify({ agent: "overnight", edition: "260827", message: "subagent_metrics", details: { subagent_tokens: 50000 } }),
        JSON.stringify({ agent: "overnight", edition: "260827", message: "coordinator_tokens_estimate", details: { tokens: 10000, source: "unavailable" } }),
      ],
    });

    assert.ok(result.components.some((c) => c.name === "plan.json"));
    assert.ok(result.components.some((c) => c.name === "run-log.jsonl (this round)"));
    assert.ok(result.totalBytes > 4000);
    assert.ok(result.estimatedTokens > 1000);
  });

  it("sem planContent nem runLogLines → usa só contextFiles", () => {
    const result = estimateCoordinatorTokensFromContents({
      contextFiles: [{ name: "CLAUDE.md", content: "a".repeat(4000) }],
    });
    assert.equal(result.components.length, 1);
    assert.equal(result.components[0].name, "CLAUDE.md");
  });

  it("runLogLines vazio → não adiciona componente de run-log", () => {
    const result = estimateCoordinatorTokensFromContents({
      contextFiles: [{ name: "CLAUDE.md", content: "a".repeat(4000) }],
      runLogLines: [],
    });
    assert.equal(result.components.length, 1);
  });
});

describe("collectContextFiles (#6634)", () => {
  it("lê CLAUDE.md quando existe", () => {
    const fsShims = {
      readFileSync: (_p: string, _e: string) => "conteúdo CLAUDE.md",
      existsSync: (p: string) => p.endsWith("CLAUDE.md"),
      readdirSync: (_p: string, _o: { withFileTypes: true }) => [],
    };

    const result = collectContextFiles("/fake/root", fsShims);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "CLAUDE.md");
    assert.equal(result[0].content, "conteúdo CLAUDE.md");
  });

  it("lê arquivos .md e .json de context/ recursivamente", () => {
    const fsShims = {
      readFileSync: (p: string) => `conteúdo de ${p}`,
      existsSync: (p: string) => !p.endsWith("/nonexistent"),
      readdirSync: (p: string, _o: { withFileTypes: true }) => {
        if (p === "/fake/root/context") {
          return [
            { name: "editorial-rules.md", isDirectory: () => false },
            { name: "templates", isDirectory: () => true },
          ];
        }
        if (p === "/fake/root/context/templates") {
          return [
            { name: "newsletter.md", isDirectory: () => false },
            { name: "config.json", isDirectory: () => false },
            { name: "image.png", isDirectory: () => false }, // skip
          ];
        }
        return [];
      },
    };

    const result = collectContextFiles("/fake/root", fsShims);
    const names = result.map((r) => r.name);
    assert.ok(names.includes("CLAUDE.md"));
    assert.ok(names.includes("context/editorial-rules.md"));
    assert.ok(names.includes("context/templates/newsletter.md"));
    assert.ok(names.includes("context/templates/config.json"));
    assert.ok(!names.includes("context/templates/image.png")); // .png skipado
  });

  it("skipa arquivos unreadable sem lançar (fail-soft)", () => {
    const fsShims = {
      readFileSync: (_p: string) => { throw new Error("EACCES"); },
      existsSync: () => true,
      readdirSync: (p: string, _o: { withFileTypes: true }) => {
        if (p === "/fake/root/context") {
          return [{ name: "broken.md", isDirectory: () => false }];
        }
        return [];
      },
    };

    const result = collectContextFiles("/fake/root", fsShims);
    // CLAUDE.md existe mas readFileSync falha → é pulado silenciosamente
    assert.equal(result.length, 0);
  });

  it("context/ inexistente → não lança, retorna só CLAUDE.md", () => {
    const fsShims = {
      readFileSync: (_p: string, _e: string) => "x",
      existsSync: (p: string) => p.endsWith("CLAUDE.md"),
      readdirSync: () => [],
    };

    const result = collectContextFiles("/fake/root", fsShims);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "CLAUDE.md");
  });

  it("não lê mais de 2 níveis de profundidade em context/", () => {
    const fsShims = {
      readFileSync: (p: string) => `conteúdo ${p}`,
      existsSync: () => true,
      readdirSync: (p: string, _o: { withFileTypes: true }) => {
        if (p === "/fake/root/context") {
          return [
            { name: "level0.md", isDirectory: () => false },
            { name: "level1", isDirectory: () => true },
          ];
        }
        if (p === "/fake/root/context/level1") {
          return [
            { name: "deep.md", isDirectory: () => false },
            { name: "nested", isDirectory: () => true },
          ];
        }
        if (p === "/fake/root/context/level1/nested") {
          return [{ name: "toodeep.md", isDirectory: () => false }];
        }
        return [];
      },
    };

    const result = collectContextFiles("/fake/root", fsShims);
    const names = result.map((r) => r.name);
    assert.ok(names.includes("context/level0.md"));
    assert.ok(names.includes("context/level1/deep.md"));
    // level1/nested/toodeep.md está a depth 2 > MAX_CONTEXT_DEPTH(1) → skipado
    assert.ok(!names.some((n) => n.includes("toodeep")));
    // também skipa diretórios que não contêm .md/.json
    assert.ok(!names.some((n) => n.includes("toodeep")));
  });
});
