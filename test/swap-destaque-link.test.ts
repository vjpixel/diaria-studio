/**
 * test/swap-destaque-link.test.ts (#5458)
 *
 * Cobre helpers puros + fluxo feliz/erro do swap-destaque-link.ts. Fluxo
 * feliz roda contra um HTTP server local sintético (mesmo padrão de
 * test/verify-accessibility-e2e.test.ts) — nunca contra rede real nem
 * contra uma edição real do repo (guard do overnight-dispatch-rules.md).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  replaceDestaqueLinkInMd,
  extractHighlightUrl,
  updateHighlightUrl,
  replaceDestaqueUrlInPromptFrontmatter,
  replaceUrlInSdPromptPositive,
  parseSwapLinkArgs,
  runSwapLink,
  type SwapLinkArgs,
} from "../scripts/swap-destaque-link.ts";

// ---------------------------------------------------------------------------
// Local HTTP server — /ok (acessível), /gone (404, inacessível)
// ---------------------------------------------------------------------------

let server: Server;
let port = 0;

function startServer(): Promise<void> {
  return new Promise((resolveStart) => {
    server = createServer((req, res) => {
      const url = req.url ?? "/";
      if (url === "/ok") {
        const filler = "<p>conteúdo legítimo do anúncio oficial</p>".repeat(50);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          `<!DOCTYPE html><html><head><title>Anúncio Oficial</title></head><body><article>${filler}</article></body></html>`,
        );
      } else if (url === "/gone") {
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html><body>not found</body></html>");
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolveStart();
    });
  });
}

before(async () => {
  await startServer();
});

after(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OLD_URL = "https://canaltech.com.br/materia-antiga";

function makeReviewedMd(): string {
  return `Intro texto.

---

**DESTAQUE 1 | 🚀 LANÇAMENTO**

**[Reglab anuncia novo modelo](${OLD_URL})**

Texto do destaque 1. Por que isso importa: relevância 1.

---

**DESTAQUE 2 | 📡 RADAR**

**[Artigo D2](https://example.com/d2)**

Texto do destaque 2. Por que isso importa: relevância 2.

---

**📡 RADAR**

[Link radar](https://example.com/r)

Descrição radar.
`;
}

function makeApprovedJson(): Record<string, unknown> {
  return {
    highlights: [
      { rank: 1, score: 90, bucket: "lancamento", url: OLD_URL, title_options: ["Reglab anuncia novo modelo"] },
      { rank: 2, score: 80, bucket: "radar", url: "https://example.com/d2", title_options: ["Artigo D2"] },
    ],
    radar: [{ url: "https://example.com/r", title: "Link radar" }],
  };
}

function makePromptMd(): string {
  return `---\ndestaque_url: ${OLD_URL}\n---\n\nCena Van Gogh impasto do anúncio oficial.\n`;
}

function makeSdPrompt(): Record<string, unknown> {
  return {
    positive:
      `---\ndestaque_url: ${OLD_URL}\n---\n\nCena Van Gogh impasto do anúncio oficial. Estilo impasto, sem resolução.`,
    negative: "blurry, low quality",
    final_width: 1600,
    final_height: 800,
  };
}

function makeTempEdition(opts: { withPrompt?: boolean; withSdPrompt?: boolean; withCapped?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "swap-destaque-link-"));
  const internalDir = join(dir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  writeFileSync(join(dir, "02-reviewed.md"), makeReviewedMd(), "utf8");
  writeFileSync(join(internalDir, "01-approved.json"), JSON.stringify(makeApprovedJson(), null, 2), "utf8");
  if (opts.withCapped !== false) {
    writeFileSync(join(internalDir, "01-approved-capped.json"), JSON.stringify(makeApprovedJson(), null, 2), "utf8");
  }
  if (opts.withPrompt !== false) {
    writeFileSync(join(internalDir, "02-d1-prompt.md"), makePromptMd(), "utf8");
  }
  if (opts.withSdPrompt !== false) {
    writeFileSync(join(internalDir, "04-d1-sd-prompt.json"), JSON.stringify(makeSdPrompt(), null, 2), "utf8");
  }
  return dir;
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe("replaceDestaqueLinkInMd", () => {
  it("substitui só a URL do título do DESTAQUE alvo, preserva título/corpo", () => {
    const md = makeReviewedMd();
    const newUrl = "https://reglab.example.com/anuncio-oficial";
    const { updated, changed } = replaceDestaqueLinkInMd(md, 1, newUrl);
    assert.equal(changed, true);
    assert.match(updated, /\*\*\[Reglab anuncia novo modelo\]\(https:\/\/reglab\.example\.com\/anuncio-oficial\)\*\*/);
    assert.doesNotMatch(updated, new RegExp(OLD_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // corpo e título preservados
    assert.match(updated, /Texto do destaque 1\. Por que isso importa: relevância 1\./);
    // DESTAQUE 2 intacto
    assert.match(updated, /\*\*\[Artigo D2\]\(https:\/\/example\.com\/d2\)\*\*/);
  });

  it("retorna changed:false se a posição não existir", () => {
    const md = makeReviewedMd();
    const { changed, reason } = replaceDestaqueLinkInMd(md, 3, "https://example.com/novo");
    assert.equal(changed, false);
    assert.match(reason ?? "", /posição pedida é 3/);
  });
});

describe("extractHighlightUrl / updateHighlightUrl", () => {
  it("extrai e atualiza url flat", () => {
    const data = makeApprovedJson();
    const highlights = data.highlights as Record<string, unknown>[];
    assert.equal(extractHighlightUrl(highlights[0]), OLD_URL);

    const res = updateHighlightUrl(data, 0, "https://novo.example.com/x");
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.oldUrl, OLD_URL);
    assert.equal((data.highlights as Record<string, unknown>[])[0].url, "https://novo.example.com/x");
  });

  it("também atualiza article.url aninhado quando presente", () => {
    const data = {
      highlights: [{ url: OLD_URL, article: { url: OLD_URL, title: "x" } }],
    };
    updateHighlightUrl(data, 0, "https://novo.example.com/y");
    const h = (data.highlights as Record<string, unknown>[])[0];
    assert.equal(h.url, "https://novo.example.com/y");
    assert.equal((h.article as Record<string, unknown>).url, "https://novo.example.com/y");
  });

  it("falha com reason quando índice fora de range", () => {
    const data = makeApprovedJson();
    const res = updateHighlightUrl(data, 5, "https://x.com");
    assert.equal(res.ok, false);
  });
});

describe("replaceDestaqueUrlInPromptFrontmatter", () => {
  it("substitui destaque_url no frontmatter, preserva resto do arquivo", () => {
    const md = makePromptMd();
    const { updated, changed } = replaceDestaqueUrlInPromptFrontmatter(md, "https://novo.example.com/z");
    assert.equal(changed, true);
    assert.match(updated, /destaque_url: https:\/\/novo\.example\.com\/z/);
    assert.match(updated, /Cena Van Gogh impasto do anúncio oficial\./);
  });

  it("changed:false se frontmatter não tiver destaque_url", () => {
    const md = "---\nfoo: bar\n---\n\nSem destaque_url aqui.\n";
    const { changed } = replaceDestaqueUrlInPromptFrontmatter(md, "https://x.com");
    assert.equal(changed, false);
  });
});

describe("replaceUrlInSdPromptPositive", () => {
  it("substitui a URL antiga por dentro do campo positive quando presente", () => {
    const sdPrompt = makeSdPrompt();
    const { updated, changed } = replaceUrlInSdPromptPositive(sdPrompt, OLD_URL, "https://novo.example.com/w");
    assert.equal(changed, true);
    assert.match(updated.positive as string, /https:\/\/novo\.example\.com\/w/);
    assert.doesNotMatch(updated.positive as string, new RegExp(OLD_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("changed:false se a URL antiga não aparecer no campo", () => {
    const sdPrompt = { positive: "cena sem referência de url alguma" };
    const { changed } = replaceUrlInSdPromptPositive(sdPrompt, OLD_URL, "https://novo.example.com/w");
    assert.equal(changed, false);
  });
});

describe("parseSwapLinkArgs", () => {
  it("rejeita --url sem esquema http(s)", () => {
    const originalExit = process.exit;
    let exitCode: number | undefined;
    // @ts-expect-error — stub temporário
    process.exit = (code?: number) => {
      exitCode = code;
      throw new Error("exit");
    };
    try {
      assert.throws(() =>
        parseSwapLinkArgs(["--edition", "260817", "--destaque", "d1", "--url", "not-a-url"]),
      );
      assert.equal(exitCode, 2);
    } finally {
      process.exit = originalExit;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: fluxo feliz (URL válida → todos os arquivos atualizados)
// ---------------------------------------------------------------------------

describe("runSwapLink — fluxo feliz", () => {
  it("verifica a nova URL, atualiza os 5 arquivos, preserva título/corpo", async () => {
    const dir = makeTempEdition();
    try {
      const newUrl = `http://127.0.0.1:${port}/ok`;
      const args: SwapLinkArgs = {
        edition: "260817",
        editionDir: dir,
        destaque: "d1",
        url: newUrl,
        dryRun: false,
      };
      const result = await runSwapLink(args);

      assert.equal(result.old_url, OLD_URL);
      assert.equal(result.new_url, newUrl);
      // md, approved, capped, hash, prompt.md, sd-prompt.json
      assert.equal(result.modified.length, 6);

      // 02-reviewed.md
      const md = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.match(md, new RegExp(`\\*\\*\\[Reglab anuncia novo modelo\\]\\(${newUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\*\\*`));
      assert.match(md, /Texto do destaque 1\. Por que isso importa: relevância 1\./);

      // 01-approved.json + capped
      const approved = JSON.parse(readFileSync(join(dir, "_internal/01-approved.json"), "utf8"));
      assert.equal(approved.highlights[0].url, newUrl);
      const capped = JSON.parse(readFileSync(join(dir, "_internal/01-approved-capped.json"), "utf8"));
      assert.equal(capped.highlights[0].url, newUrl);

      // .social-source-hash.json — recomputado
      const hashFile = JSON.parse(readFileSync(join(dir, "_internal/.social-source-hash.json"), "utf8"));
      assert.equal(typeof hashFile.hash, "string");
      assert.ok(hashFile.hash.length > 0);

      // 02-d1-prompt.md frontmatter
      const promptMd = readFileSync(join(dir, "_internal/02-d1-prompt.md"), "utf8");
      assert.match(promptMd, new RegExp(`destaque_url: ${newUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

      // 04-d1-sd-prompt.json — positive atualizado
      const sdPrompt = JSON.parse(readFileSync(join(dir, "_internal/04-d1-sd-prompt.json"), "utf8"));
      assert.match(sdPrompt.positive, new RegExp(newUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      cleanup(dir);
    }
  });

  it("dry-run não escreve nenhum arquivo", async () => {
    const dir = makeTempEdition();
    try {
      const newUrl = `http://127.0.0.1:${port}/ok`;
      const before = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const result = await runSwapLink({
        edition: "260817",
        editionDir: dir,
        destaque: "d1",
        url: newUrl,
        dryRun: true,
      });
      assert.equal(result.dry_run, true);
      const after = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      assert.equal(before, after);
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Integration: fail-fast (URL inacessível → nenhum arquivo tocado)
// ---------------------------------------------------------------------------

describe("runSwapLink — fail-fast em URL inacessível", () => {
  it("rejeita antes de tocar qualquer arquivo quando a nova URL não é acessível", async () => {
    const dir = makeTempEdition();
    try {
      const badUrl = `http://127.0.0.1:${port}/gone`;
      const mdBefore = readFileSync(join(dir, "02-reviewed.md"), "utf8");
      const approvedBefore = readFileSync(join(dir, "_internal/01-approved.json"), "utf8");
      const promptBefore = readFileSync(join(dir, "_internal/02-d1-prompt.md"), "utf8");
      const sdPromptBefore = readFileSync(join(dir, "_internal/04-d1-sd-prompt.json"), "utf8");
      const hashPathBefore = existsSync(join(dir, "_internal/.social-source-hash.json"));

      await assert.rejects(
        () =>
          runSwapLink({
            edition: "260817",
            editionDir: dir,
            destaque: "d1",
            url: badUrl,
            dryRun: false,
          }),
        /URL inacessível/,
      );

      // nenhum arquivo tocado
      assert.equal(readFileSync(join(dir, "02-reviewed.md"), "utf8"), mdBefore);
      assert.equal(readFileSync(join(dir, "_internal/01-approved.json"), "utf8"), approvedBefore);
      assert.equal(readFileSync(join(dir, "_internal/02-d1-prompt.md"), "utf8"), promptBefore);
      assert.equal(readFileSync(join(dir, "_internal/04-d1-sd-prompt.json"), "utf8"), sdPromptBefore);
      assert.equal(existsSync(join(dir, "_internal/.social-source-hash.json")), hashPathBefore);
    } finally {
      cleanup(dir);
    }
  });
});
