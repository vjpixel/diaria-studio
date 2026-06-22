/**
 * test/resolve-edition-url.test.ts (#2454)
 *
 * Testa:
 *   (a) deriveEditionUrl — URL publica derivada do titulo via seoSlug
 *       bate com o formato real do Beehiiv (https://diar.ia.br/p/{slug}).
 *   (b) findUnresolvedPlaceholders — guard anti-placeholder rejeita {edition_url}
 *       mas IGNORA {outros_count} (deferred-to-dispatch, resolvido por publish-linkedin).
 *   (c) CLI resolve-edition-url.ts — integracao via spawnSync:
 *       grava 05-edition-url.txt + aborta (exit 3) quando --validate-social
 *       detecta {edition_url} nao-resolvido.
 *       Regressao #2454-finding-1: {outros_count} presente com {edition_url} resolvido -> exit 0.
 *       Regressao #2454-finding-3: --title seguido de outra flag nao crashar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { NPX, isWindows } from "./_helpers/spawn-npx.ts";

// Importar funcoes puras diretamente para testes unitarios
import { deriveEditionUrl, findUnresolvedPlaceholders, BEEHIIV_BASE_URL } from "../scripts/lib/edition-url.ts";

// ── (a) Testes unitarios: deriveEditionUrl ────────────────────────────────────

describe("#2454 deriveEditionUrl — URL publica deterministica do slug", () => {
  it("titulo simples → slug ASCII + URL correta", () => {
    const url = deriveEditionUrl("Modelos se replicam sozinhos");
    assert.equal(url, "https://diar.ia.br/p/modelos-se-replicam-sozinhos");
  });

  it("titulo com acentos PT-BR → slug sem diacriticos (mesmo algoritmo de §4a-bis)", () => {
    const url = deriveEditionUrl("Empregos e automacao: panico vs dados");
    assert.equal(url, "https://diar.ia.br/p/empregos-e-automacao-panico-vs-dados");
  });

  it("titulo com acentos manglados pelo Beehiiv (verificar diferenca antes/depois do fix)", () => {
    const url = deriveEditionUrl("Automacao de alto risco");
    assert.ok(url.includes("automacao"), `URL deve conter 'automacao', obteve: ${url}`);
    assert.ok(!url.includes("automa-o"), `URL NAO deve conter 'automa-o' (slug manglado)`);
  });

  it("URL comeca com BEEHIIV_BASE_URL + /p/", () => {
    const url = deriveEditionUrl("Qualquer titulo");
    assert.ok(url.startsWith(`${BEEHIIV_BASE_URL}/p/`));
  });

  it("titulo longo e truncado em palavra inteira (seoSlug maxLen=60)", () => {
    const longTitle = "Esta e uma frase muito longa que deve ser truncada pelo seoSlug em palavra inteira";
    const url = deriveEditionUrl(longTitle);
    const slug = url.replace(`${BEEHIIV_BASE_URL}/p/`, "");
    assert.ok(slug.length <= 60, `slug deve ter ≤60 chars, obteve ${slug.length}: "${slug}"`);
    assert.ok(!slug.endsWith("-"), `slug nao deve terminar com hifen: "${slug}"`);
  });
});

// ── (b) Testes unitarios: findUnresolvedPlaceholders ─────────────────────────

describe("#2454 findUnresolvedPlaceholders — guard anti-placeholder", () => {
  it("texto sem placeholders → array vazio (OK para dispatch)", () => {
    const text = "Edicao completa com mais 12 destaques em https://diar.ia.br/p/meu-slug";
    assert.deepEqual(findUnresolvedPlaceholders(text), []);
  });

  it("texto com {edition_url} → detectado", () => {
    const text = "Edicao completa em {edition_url}";
    const found = findUnresolvedPlaceholders(text);
    assert.ok(found.includes("{edition_url}"), `deve detectar {edition_url}: ${JSON.stringify(found)}`);
  });

  // #2454-finding-1: {outros_count} e DEFERRED (resolvido por publish-linkedin.ts
  // no dispatch). O guard NAO deve rejeitar {outros_count} — e sempre presente em
  // 03-social.md antes do dispatch e seria um exit 3 falso em toda edicao.
  it("#2454-finding-1 regressao: {outros_count} → IGNORADO pelo guard (deferred-to-dispatch)", () => {
    const text = "Mais {outros_count} destaques na edicao completa";
    const found = findUnresolvedPlaceholders(text);
    assert.deepEqual(found, [], `{outros_count} e deferred e NAO deve ser detectado: ${JSON.stringify(found)}`);
  });

  it("#2454-finding-1 regressao: {edition_url} resolvido + {outros_count} presente → vazio (OK pre-dispatch)", () => {
    // Estado real de 03-social.md antes do dispatch social:
    // {edition_url} ja substituido pela URL real, {outros_count} ainda presente.
    // Antes do fix: guard daria exit 3, bloqueando toda edicao.
    const text = "Edicao em https://diar.ia.br/p/meu-slug — mais {outros_count} destaques";
    const found = findUnresolvedPlaceholders(text);
    assert.deepEqual(found, [], `pre-dispatch valido: {edition_url} resolvido + {outros_count} deferred → deve ser []`);
  });

  it("{edition_url} detectado independentemente de {outros_count}", () => {
    const text = "Mais 12 destaques em {edition_url}";
    const found = findUnresolvedPlaceholders(text);
    assert.ok(found.includes("{edition_url}"), "{edition_url} ainda deve ser detectado");
    assert.equal(found.length, 1);
  });

  it("placeholder duplicado no texto → retorna so 1 entry (Set)", () => {
    const text = "d1: {edition_url}\nd2: {edition_url}\nd3: {edition_url}";
    const found = findUnresolvedPlaceholders(text);
    assert.equal(found.filter(f => f === "{edition_url}").length, 1);
  });

  it("URL resolvida (diar.ia.br/p/slug) nao e detectada como placeholder", () => {
    const text = "Edicao em https://diar.ia.br/p/modelos-se-replicam-sozinhos";
    assert.deepEqual(findUnresolvedPlaceholders(text), []);
  });
});

// ── (c) Testes de integracao: CLI resolve-edition-url.ts ────────────────────

function runCli(args: string[], extraFiles?: Record<string, string>): {
  stdout: string;
  stderr: string;
  exitCode: number;
  editionDir: string;
  tmp: string;
} {
  const tmp = mkdtempSync(resolve(tmpdir(), "resolve-edition-url-"));
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
    ["tsx", "scripts/resolve-edition-url.ts", "--edition-dir", editionDir, ...args],
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

describe("#2454 CLI resolve-edition-url.ts — gravar 05-edition-url.txt", () => {
  it("exit 0: grava URL correta via --title (palavra unica sem espacos)", () => {
    const { exitCode, editionDir, tmp } = runCli(["--title", "Automacao"]);
    const outPath = resolve(editionDir, "_internal", "05-edition-url.txt");
    assert.equal(exitCode, 0, `esperava exit 0`);
    assert.ok(existsSync(outPath), `05-edition-url.txt deve existir`);
    const content = readFileSync(outPath, "utf8").trim();
    assert.equal(content, "https://diar.ia.br/p/automacao");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0: grava URL correta via --slug", () => {
    const { exitCode, editionDir, tmp } = runCli(["--slug", "meu-titulo-teste"]);
    const outPath = resolve(editionDir, "_internal", "05-edition-url.txt");
    assert.equal(exitCode, 0);
    const content = readFileSync(outPath, "utf8").trim();
    assert.equal(content, "https://diar.ia.br/p/meu-titulo-teste");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0: grava URL correta via --edition-url literal", () => {
    const { exitCode, editionDir, tmp } = runCli(["--edition-url", "https://diar.ia.br/p/custom-url"]);
    const outPath = resolve(editionDir, "_internal", "05-edition-url.txt");
    assert.equal(exitCode, 0);
    const content = readFileSync(outPath, "utf8").trim();
    assert.equal(content, "https://diar.ia.br/p/custom-url");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 1: sem flags de URL → aborta com mensagem clara", () => {
    const { exitCode, stderr, tmp } = runCli([]);
    assert.equal(exitCode, 1);
    assert.match(stderr, /--title.*--slug.*--edition-url/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0: --validate-social com social MD sem placeholders → OK", () => {
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Post d1 sem placeholders.",
      "Edicao em https://diar.ia.br/p/meu-slug",
      "Mais 12 destaques na edicao.",
      "",
    ].join("\n");

    const { exitCode, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(exitCode, 0, `esperava exit 0 (social sem placeholder)`);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 3: --validate-social com {edition_url} nao-resolvido → aborta (#2454 guard)", () => {
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Post d1.",
      "Edicao completa em {edition_url}",
      "",
    ].join("\n");

    const { exitCode, stderr, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(exitCode, 3, `esperava exit 3 (placeholder detectado), obteve ${exitCode}`);
    assert.match(stderr, /\{edition_url\}/);
    assert.match(stderr, /guard anti-placeholder/);
    rmSync(tmp, { recursive: true, force: true });
  });

  // #2454-finding-1: regressao — {outros_count} e deferred, nao bloqueia dispatch.
  // ANTES do fix: este teste daria exit 3 (false positive), bloqueando toda edicao.
  it("#2454-finding-1 regressao: exit 0: {outros_count} presente + {edition_url} resolvido → PASSA", () => {
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Post d1.",
      "Edicao em https://diar.ia.br/p/meu-slug — mais {outros_count} destaques.",
      "",
    ].join("\n");

    const { exitCode, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(exitCode, 0, `{outros_count} e deferred — guard deve passar com exit 0, obteve ${exitCode}`);
    rmSync(tmp, { recursive: true, force: true });
  });

  // #2454-finding-3: regressao — --title seguido de outra flag nao deve crashar.
  // ANTES do fix: --title --validate-social definia title="--validate-social"
  // (proxima flag consumida como valor), causando comportamento inesperado.
  it("#2454-finding-3 regressao: --title seguido de --validate-social → exit 1 (nao crash)", () => {
    const socialMd = "# LinkedIn\n\n## d1\nSem placeholder.\n";
    const { exitCode, stderr, tmp } = runCli(
      ["--title", "--validate-social"],
      { "03-social.md": socialMd },
    );
    // --title sem valor → args["title"] = true (boolean), nao tratado como string valida
    // → cai no else → exit 1 com mensagem de erro de flags obrigatorias
    assert.equal(exitCode, 1, `--title sem valor deve dar exit 1, obteve ${exitCode}`);
    assert.match(stderr, /--title.*--slug.*--edition-url/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0: acentos PT-BR via --slug passado pre-processado → URL correta", () => {
    const { exitCode, editionDir, tmp } = runCli(["--slug", "automacao-e-panico-no-mercado"]);
    const outPath = resolve(editionDir, "_internal", "05-edition-url.txt");
    assert.equal(exitCode, 0);
    const content = readFileSync(outPath, "utf8").trim();
    assert.ok(content.includes("/automacao-e-panico-no-mercado"), `URL deve ter slug sem acentos: ${content}`);
    assert.ok(!content.includes("automa-o"), `slug nao deve ter 'automa-o': ${content}`);
    rmSync(tmp, { recursive: true, force: true });
  });
});
