import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, extractLinks } from "../scripts/refresh-past-editions.ts";
import { execFileSync } from "node:child_process";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  cpSync,
  mkdirSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("renderMarkdown", () => {
  it("renderiza header + edições com links extraídos do html", () => {
    const posts = [
      {
        id: "post1",
        title: "Edição A",
        web_url: "https://diaria.beehiiv.com/p/edicao-a",
        published_at: "2026-04-25T10:00:00Z",
        html: "<p>Veja https://example.com/post1 e https://other.com</p>",
      },
    ];
    const md = renderMarkdown(posts);
    assert.ok(md.includes("Últimas edições publicadas"));
    assert.ok(md.includes("**edições carregadas:** 1"));
    assert.ok(md.includes('## 2026-04-25 — "Edição A"'));
    assert.ok(md.includes("- https://example.com/post1"));
    assert.ok(md.includes("- https://other.com"));
  });

  it("usa links explícitos quando disponíveis (sem extrair do html)", () => {
    const posts = [
      {
        id: "post2",
        title: "Edição B",
        published_at: "2026-04-26T10:00:00Z",
        links: ["https://forced.com/a", "https://forced.com/b"],
        html: "<p>https://ignored.com</p>", // ignorado quando links[] presente
      },
    ];
    const md = renderMarkdown(posts);
    assert.ok(md.includes("- https://forced.com/a"));
    assert.ok(md.includes("- https://forced.com/b"));
    assert.ok(!md.includes("https://ignored.com"));
  });

  it("inclui temas se themes[] estiver presente", () => {
    const posts = [
      {
        id: "post3",
        title: "Edição C",
        published_at: "2026-04-27T10:00:00Z",
        themes: ["GPT-5.5", "regulação IA"],
      },
    ];
    const md = renderMarkdown(posts);
    assert.ok(md.includes("Temas cobertos:"));
    assert.ok(md.includes("- GPT-5.5"));
    assert.ok(md.includes("- regulação IA"));
  });

  it("array vazio gera só header", () => {
    const md = renderMarkdown([]);
    assert.ok(md.includes("**edições carregadas:** 0"));
    assert.ok(!md.includes("##"));
  });
});

describe("--regen-md-only flag (#162)", () => {
  // Usa um sandbox temporário pra não tocar no raw/MD reais do projeto.
  function setupSandbox(): { sandboxRoot: string; cleanup: () => void } {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "regen-md-"));
    // Copy script + minimal package.json structure
    cpSync(resolve(ROOT, "scripts"), join(sandboxRoot, "scripts"), {
      recursive: true,
    });
    cpSync(resolve(ROOT, "platform.config.json"), join(sandboxRoot, "platform.config.json"));
    cpSync(resolve(ROOT, "package.json"), join(sandboxRoot, "package.json"));
    cpSync(resolve(ROOT, "tsconfig.json"), join(sandboxRoot, "tsconfig.json"));
    if (existsSync(resolve(ROOT, "node_modules"))) {
      // symlinkSync com 'junction' no Windows (não precisa de admin) (#311)
      // 'dir' no Unix equivale a symlink de diretório.
      try {
        symlinkSync(
          resolve(ROOT, "node_modules"),
          join(sandboxRoot, "node_modules"),
          isWindows ? "junction" : "dir",
        );
      } catch {
        // Fallback: se symlink falhar por qualquer motivo, copiar (mais lento mas seguro)
        cpSync(resolve(ROOT, "node_modules"), join(sandboxRoot, "node_modules"), { recursive: true });
      }
    }
    mkdirSync(join(sandboxRoot, "data"));
    mkdirSync(join(sandboxRoot, "context"));
    return {
      sandboxRoot,
      cleanup: () => rmSync(sandboxRoot, { recursive: true, force: true }),
    };
  }

  it("regen-md-only regenera MD a partir do raw existente", () => {
    const { sandboxRoot, cleanup } = setupSandbox();
    try {
      const posts = [
        {
          id: "p1",
          title: "Edição teste",
          published_at: "2026-04-26T10:00:00Z",
          links: ["https://test.com"],
        },
      ];
      writeFileSync(
        join(sandboxRoot, "data/past-editions-raw.json"),
        JSON.stringify(posts),
        "utf8",
      );
      // Não cria past-editions.md (simulando git reset)
      execFileSync(
        NPX,  // #311: cross-platform
        ["tsx", "scripts/refresh-past-editions.ts", "--regen-md-only"],
        { cwd: sandboxRoot, stdio: "pipe", shell: isWindows },
      );
      const md = readFileSync(
        join(sandboxRoot, "context/past-editions.md"),
        "utf8",
      );
      assert.ok(md.includes('## 2026-04-26 — "Edição teste"'));
      assert.ok(md.includes("**edições carregadas:** 1"));
    } finally {
      cleanup();
    }
  });

  it("regen-md-only falha (exit 1) se raw não existir", () => {
    const { sandboxRoot, cleanup } = setupSandbox();
    try {
      // Não cria past-editions-raw.json
      let exitCode = 0;
      try {
        execFileSync(
          NPX,  // #311: usa npx.cmd em Windows
          ["tsx", "scripts/refresh-past-editions.ts", "--regen-md-only"],
          { cwd: sandboxRoot, stdio: "pipe" },
        );
      } catch (e) {
        exitCode = (e as { status?: number }).status ?? 1;
      }
      assert.equal(exitCode, 1);
    } finally {
      cleanup();
    }
  });
});

describe("extractLinks", () => {
  function captureWarn<T>(fn: () => T): { result: T; warnings: string[] } {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: unknown) => warnings.push(String(msg));
    try {
      return { result: fn(), warnings };
    } finally {
      console.warn = original;
    }
  }

  it("retorna URLs válidas e não emite warn", () => {
    const { result, warnings } = captureWarn(() =>
      extractLinks("Veja https://example.com/post1 e https://other.com/x"),
    );
    assert.deepEqual([...result].sort(), [
      "https://example.com/post1",
      "https://other.com/x",
    ]);
    assert.equal(warnings.length, 0);
  });

  it("descarta URLs malformadas e emite warn com a contagem (#814)", () => {
    // `http://[invalid` → `new URL()` lança; o regex inicial captura `http://[invalid`
    // até o fim da linha, então temos 1 URL malformada.
    const content = "Bom: https://example.com/ok\nRuim: http://[invalid\n";
    const { result, warnings } = captureWarn(() => extractLinks(content));
    assert.deepEqual(result, ["https://example.com/ok"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[extractLinks\] descartou 1 URL\(s\) malformada\(s\)/);
  });

  it("filtra URLs do beehiiv silenciosamente (sem warn)", () => {
    const content =
      "Real: https://example.com/x\nTracking: https://diaria.beehiiv.com/c/abc\nSubdomain: https://foo.beehiiv.com/p/y";
    const { result, warnings } = captureWarn(() => extractLinks(content));
    assert.deepEqual(result, ["https://example.com/x"]);
    assert.equal(warnings.length, 0);
  });
});
