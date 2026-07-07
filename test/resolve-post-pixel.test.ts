/**
 * test/resolve-post-pixel.test.ts (#3052)
 *
 * Testa:
 *   (a) substitutePostPixelPlaceholders / extractPostPixelText — funções puras.
 *   (b) CLI resolve-post-pixel.ts via spawnSync:
 *       - resolve {edition_url} + {outros_count} e imprime o texto em stdout
 *       - precedência --edition-url flag > 05-edition-url.txt > fallback raiz
 *       - exit 1 quando 03-social.md ou seção post_pixel ausentes
 *       - exit 2 (mas ainda imprime texto best-effort) quando outros_count
 *         não pode ser resolvido — nunca lança, nunca bloqueia silenciosamente
 *       - diagnostics vão pro stderr, NUNCA pro stdout (#2153 — o caller faz
 *         `POST_PIXEL_TEXT="$(...)"`; qualquer log em stdout corromperia o texto)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";
import { substitutePostPixelPlaceholders, extractPostPixelText } from "../scripts/resolve-post-pixel.ts";

// ── (a) Testes unitários: funções puras ────────────────────────────────────

describe("#3052 substitutePostPixelPlaceholders", () => {
  it("substitui ambos os placeholders quando ambos os valores são fornecidos", () => {
    const text = "Mais {outros_count} destaques em {edition_url}. Segue o resto.";
    const out = substitutePostPixelPlaceholders(text, "https://diar.ia.br/p/slug", 9);
    assert.equal(out, "Mais 9 destaques em https://diar.ia.br/p/slug. Segue o resto.");
  });

  it("editionUrl null: {edition_url} permanece literal", () => {
    const text = "Mais {outros_count} destaques em {edition_url}.";
    const out = substitutePostPixelPlaceholders(text, null, 9);
    assert.match(out, /\{edition_url\}/);
    assert.doesNotMatch(out, /\{outros_count\}/);
  });

  it("outrosCount null: {outros_count} permanece literal", () => {
    const text = "Mais {outros_count} destaques em {edition_url}.";
    const out = substitutePostPixelPlaceholders(text, "https://diar.ia.br/p/slug", null);
    assert.match(out, /\{outros_count\}/);
    assert.doesNotMatch(out, /\{edition_url\}/);
  });

  it("texto sem placeholders → retorna intacto (backward-compat pré-#3052)", () => {
    const text = "Post pessoal sem placeholders nenhum.";
    const out = substitutePostPixelPlaceholders(text, "https://diar.ia.br/p/slug", 9);
    assert.equal(out, text);
  });

  it("outrosCount=0 é um valor válido (não deve ser tratado como null)", () => {
    const text = "Mais {outros_count} destaques.";
    const out = substitutePostPixelPlaceholders(text, null, 0);
    assert.equal(out, "Mais 0 destaques.");
  });
});

describe("#3052 extractPostPixelText", () => {
  it("extrai o corpo de ## post_pixel, removendo comentários HTML", () => {
    const md = [
      "# LinkedIn",
      "",
      "## d1",
      "Post d1.",
      "",
      "## post_pixel",
      "",
      "<!-- destaque: d1 -->",
      "Mais {outros_count} destaques em {edition_url}. Opinião do Pixel aqui.",
      "",
    ].join("\n");
    const text = extractPostPixelText(md);
    assert.ok(text?.includes("Mais {outros_count} destaques em {edition_url}."));
    assert.doesNotMatch(text ?? "", /destaque: d1/);
  });

  it("seção LinkedIn ausente → null", () => {
    const md = "# Facebook\n\n## d1\nApenas FB.\n";
    assert.equal(extractPostPixelText(md), null);
  });

  it("## post_pixel ausente → null", () => {
    const md = "# LinkedIn\n\n## d1\nPost d1.\n";
    assert.equal(extractPostPixelText(md), null);
  });
});

// ── (b) Testes de integração: CLI resolve-post-pixel.ts ─────────────────────

function runCli(args: string[], extraFiles?: Record<string, string>): {
  stdout: string;
  stderr: string;
  exitCode: number;
  editionDir: string;
  tmp: string;
} {
  const tmp = mkdtempSync(resolve(tmpdir(), "resolve-post-pixel-"));
  const editionDir = resolve(tmp, "260999");
  const internalDir = resolve(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });

  if (extraFiles) {
    for (const [relativePath, content] of Object.entries(extraFiles)) {
      const fullPath = resolve(editionDir, relativePath);
      mkdirSync(resolve(fullPath, ".."), { recursive: true });
      writeFileSync(fullPath, content, "utf8");
    }
  }

  const result = spawnSync(
    NPX,
    ["tsx", "scripts/resolve-post-pixel.ts", "--edition-dir", editionDir, ...args],
    { encoding: "utf8", stdio: "pipe", shell: isWindows },
  );

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
    editionDir,
    tmp,
  };
}

const SOCIAL_MD_WITH_POST_PIXEL = [
  "# LinkedIn",
  "",
  "## d1",
  "Post d1 principal.",
  "",
  "### comment_diaria",
  "",
  "Edição completa em {edition_url}",
  "",
  "## post_pixel",
  "",
  "<!-- destaque: d1 -->",
  "Hoje saíram mais {outros_count} novidades de IA — reuni tudo na edição em {edition_url}. Mas o que me fez parar foi isto:",
  "",
  "Opinião pessoal do Pixel sobre o D1 aqui.",
  "",
  "Siga a Diar.ia em linkedin.com/company/diar.ia.br",
  "",
].join("\n");

const APPROVED_CAPPED = JSON.stringify({
  highlights: [{ article: { title: "D1" } }],
  lancamento: [{ title: "L1" }, { title: "L2" }],
  radar: [{ title: "R1" }, { title: "R2" }, { title: "R3" }],
  use_melhor: [],
  video: [],
});
// outros = lancamento(2) + radar(3) = 5

describe("#3052 CLI resolve-post-pixel.ts", () => {
  it("exit 0: resolve {edition_url} via 05-edition-url.txt + {outros_count} via approved-capped.json", () => {
    const { exitCode, stdout, stderr, tmp } = runCli([], {
      "03-social.md": SOCIAL_MD_WITH_POST_PIXEL,
      "_internal/05-edition-url.txt": "https://diar.ia.br/p/meu-slug",
      "_internal/01-approved-capped.json": APPROVED_CAPPED,
    });
    assert.equal(exitCode, 0, `esperava exit 0, stderr: ${stderr}`);
    assert.match(stdout, /reuni tudo na edição em https:\/\/diar\.ia\.br\/p\/meu-slug/);
    assert.match(stdout, /Hoje saíram mais 5 novidades de IA/);
    assert.doesNotMatch(stdout, /\{edition_url\}/);
    assert.doesNotMatch(stdout, /\{outros_count\}/);
    // Diagnostics NUNCA vazam pro stdout (#2153 — POST_PIXEL_TEXT="$(...)")
    assert.doesNotMatch(stdout, /#3052:/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0: --edition-url flag tem precedência sobre 05-edition-url.txt", () => {
    const { exitCode, stdout, tmp } = runCli(["--edition-url", "https://diar.ia.br/p/override"], {
      "03-social.md": SOCIAL_MD_WITH_POST_PIXEL,
      "_internal/05-edition-url.txt": "https://diar.ia.br/p/nao-deve-usar",
      "_internal/01-approved-capped.json": APPROVED_CAPPED,
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /https:\/\/diar\.ia\.br\/p\/override/);
    assert.doesNotMatch(stdout, /nao-deve-usar/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0: sem 05-edition-url.txt → fallback raiz (com warn em stderr, não stdout)", () => {
    const { exitCode, stdout, stderr, tmp } = runCli([], {
      "03-social.md": SOCIAL_MD_WITH_POST_PIXEL,
      "_internal/01-approved-capped.json": APPROVED_CAPPED,
    });
    assert.equal(exitCode, 0);
    assert.match(stdout, /https:\/\/diar\.ia\.br(?!\/p\/)/, "deve usar fallback raiz (sem /p/)");
    assert.match(stderr, /fallback/i);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 1: 03-social.md ausente — stdout ainda traz '(nao encontrado)' pro gate do Stage 6", () => {
    const { exitCode, stdout, stderr, tmp } = runCli([]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /03-social\.md não encontrado/);
    // #3052 self-review: sem isso, POST_PIXEL_TEXT="$(...)" capturaria "" em vez
    // do fallback literal que orchestrator-stage-6.md documenta exibir no lembrete.
    assert.equal(stdout.trim(), "(nao encontrado)");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 1: seção ## post_pixel ausente em 03-social.md — stdout ainda traz '(nao encontrado)'", () => {
    const { exitCode, stdout, stderr, tmp } = runCli([], {
      "03-social.md": "# LinkedIn\n\n## d1\nSó main, sem post_pixel.\n",
      "_internal/01-approved-capped.json": APPROVED_CAPPED,
    });
    assert.equal(exitCode, 1);
    assert.match(stderr, /post_pixel.*não encontrada/);
    assert.equal(stdout.trim(), "(nao encontrado)");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 2: outros_count não resolvível → texto ainda impresso (com {outros_count} literal), não bloqueia", () => {
    const { exitCode, stdout, stderr, tmp } = runCli([], {
      "03-social.md": SOCIAL_MD_WITH_POST_PIXEL,
      "_internal/05-edition-url.txt": "https://diar.ia.br/p/meu-slug",
      // Sem 01-approved-capped.json nem 01-approved.json
    });
    assert.equal(exitCode, 2, `esperava exit 2 (soft-fail), stderr: ${stderr}`);
    // Texto ainda sai em stdout — {edition_url} resolvido, {outros_count} literal
    assert.match(stdout, /reuni tudo na edição em https:\/\/diar\.ia\.br\/p\/meu-slug/);
    assert.match(stdout, /\{outros_count\}/, "outros_count deve permanecer literal quando não-resolvível");
    assert.match(stderr, /outros_count não pôde ser resolvido/i);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 1: sem --edition-dir", () => {
    const result = spawnSync(NPX, ["tsx", "scripts/resolve-post-pixel.ts"], {
      encoding: "utf8",
      stdio: "pipe",
      shell: isWindows,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr ?? "", /--edition-dir obrigatório/);
  });
});
