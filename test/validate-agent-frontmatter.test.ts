import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractFrontmatter,
  findFrontmatterIssues,
  validateFile,
} from "../scripts/validate-agent-frontmatter.ts";
import { mkdtempSync, writeFileSync, rmSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

describe("extractFrontmatter (#122)", () => {
  it("extrai frontmatter entre os --- delimiters", () => {
    const md = `---
name: foo
description: bar
---

# Body
content`;
    assert.equal(extractFrontmatter(md), "name: foo\ndescription: bar");
  });

  it("retorna null quando não há frontmatter", () => {
    assert.equal(extractFrontmatter("# Just a heading"), null);
    assert.equal(extractFrontmatter(""), null);
  });

  it("retorna null quando o segundo --- está faltando", () => {
    const md = `---
name: foo
no closing
`;
    assert.equal(extractFrontmatter(md), null);
  });

  it("aceita whitespace nos --- delimiters", () => {
    const md = `--- \nname: x\n--- \nbody`;
    assert.equal(extractFrontmatter(md), "name: x");
  });
});

describe("findFrontmatterIssues — unquoted-colon detector (#122)", () => {
  it("flag ': ' não-quoted em description", () => {
    const fm = `name: x
description: Roda no Stage 1: faz tudo`;
    const issues = findFrontmatterIssues(fm);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].key, "description");
    assert.match(issues[0].reason, /unquoted scalar/);
  });

  it("aceita description com colon dentro de aspas duplas", () => {
    const fm = `name: x
description: "Roda no Stage 1: faz tudo"`;
    assert.deepEqual(findFrontmatterIssues(fm), []);
  });

  it("aceita description com colon dentro de aspas simples", () => {
    const fm = `name: x
description: 'Roda no Stage 1: faz tudo'`;
    assert.deepEqual(findFrontmatterIssues(fm), []);
  });

  it("aceita colon sem espaço (URL, time)", () => {
    // 'http://x' tem ':' mas não ': ' (sem espaço) — YAML aceita
    const fm = `name: x
description: See http://example.com for details`;
    assert.deepEqual(findFrontmatterIssues(fm), []);
  });

  it("flag múltiplas ocorrências em linhas separadas", () => {
    const fm = `name: x
description: Stage 1: do this
notes: Stage 2: do that`;
    const issues = findFrontmatterIssues(fm);
    assert.equal(issues.length, 2);
  });

  it("aceita keys com - underscore (publish-social, claude-haiku-4-5-20251001)", () => {
    const fm = `model: claude-haiku-4-5-20251001
tools: Read, Write
description: simple text without colon`;
    assert.deepEqual(findFrontmatterIssues(fm), []);
  });

  it("ignora linhas em branco e comentários", () => {
    const fm = `# this is a comment
name: x
# another comment

description: simple`;
    assert.deepEqual(findFrontmatterIssues(fm), []);
  });
});

describe("validateFile — integração com fs", () => {
  function mkFile(content: string): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), "diaria-validate-"));
    const path = join(dir, "agent.md");
    writeFileSync(path, content);
    return { dir, path };
  }

  it("frontmatter limpo: ok=true", () => {
    const { dir, path } = mkFile(`---
name: foo
description: simple
---
body`);
    try {
      const r = validateFile(path);
      assert.equal(r.ok, true);
      assert.equal(r.issues.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("frontmatter com colon não-quoted: ok=false + issue", () => {
    const { dir, path } = mkFile(`---
name: foo
description: Stage 1: trouble
---
body`);
    try {
      const r = validateFile(path);
      assert.equal(r.ok, false);
      assert.equal(r.issues.length, 1);
      assert.equal(r.issues[0].key, "description");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo sem frontmatter: ok=false + error", () => {
    const { dir, path } = mkFile(`# Just a heading\nno frontmatter`);
    try {
      const r = validateFile(path);
      assert.equal(r.ok, false);
      assert.match(r.error ?? "", /missing or malformed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("arquivo inexistente: ok=false + error read_failed", () => {
    const r = validateFile("/path/that/does/not/exist/xyz.md");
    assert.equal(r.ok, false);
    assert.match(r.error ?? "", /read_failed/);
  });
});

describe("smoke: real .claude/agents and .claude/skills (#122)", () => {
  it("todos os frontmatters do projeto passam validação", () => {
    const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const targets: string[] = [];
    const agentsDir = join(ROOT, ".claude/agents");
    if (existsSync(agentsDir)) {
      for (const f of readdirSync(agentsDir)) {
        if (f.endsWith(".md")) targets.push(join(agentsDir, f));
      }
    }
    const skillsDir = join(ROOT, ".claude/skills");
    if (existsSync(skillsDir)) {
      for (const skill of readdirSync(skillsDir)) {
        const skillPath = join(skillsDir, skill);
        if (!statSync(skillPath).isDirectory()) continue;
        const skillFile = join(skillPath, "SKILL.md");
        if (existsSync(skillFile)) targets.push(skillFile);
      }
    }

    assert.ok(targets.length > 0, "expected at least one agent or skill file");

    const failures: string[] = [];
    for (const path of targets) {
      const r = validateFile(path);
      if (!r.ok) {
        const detail = r.error
          ? `error: ${r.error}`
          : r.issues.map((i) => `line ${i.line} key '${i.key}'`).join(" | ");
        failures.push(`${path}: ${detail}`);
      }
    }

    assert.equal(
      failures.length,
      0,
      `Frontmatter validation failed:\n  ${failures.join("\n  ")}`,
    );
  });
});
