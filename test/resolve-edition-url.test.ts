/**
 * test/resolve-edition-url.test.ts (#2454)
 *
 * Testa:
 *   (a) deriveEditionUrl — URL pública derivada do título via seoSlug
 *       bate com o formato real do Beehiiv (https://diar.ia.br/p/{slug}).
 *   (b) findUnresolvedPlaceholders — guard anti-placeholder rejeita textos
 *       com {edition_url} ou {outros_count} não-resolvidos.
 *   (c) CLI resolve-edition-url.ts — integração via spawnSync:
 *       grava 05-edition-url.txt + aborta (exit 3) quando --validate-social
 *       detecta placeholder não-resolvido.
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

// Importar funções puras diretamente para testes unitários
import { deriveEditionUrl, findUnresolvedPlaceholders, BEEHIIV_BASE_URL } from "../scripts/lib/edition-url.ts";

// ── (a) Testes unitários: deriveEditionUrl ────────────────────────────────────

describe("#2454 deriveEditionUrl — URL pública determinística do slug", () => {
  it("título simples → slug ASCII + URL correta", () => {
    const url = deriveEditionUrl("Modelos se replicam sozinhos");
    assert.equal(url, "https://diar.ia.br/p/modelos-se-replicam-sozinhos");
  });

  it("título com acentos PT-BR → slug sem diacríticos (mesmo algoritmo de §4a-bis)", () => {
    // Valida que o algoritmo é byte-idêntico ao seoSlug do beehiiv-playbook
    // 'ç' → 'c', 'ã' → 'a', 'é' → 'e', 'â' → 'a', etc.
    const url = deriveEditionUrl("Empregos e automação: pânico vs dados");
    assert.equal(url, "https://diar.ia.br/p/empregos-e-automacao-panico-vs-dados");
  });

  it("título com acentos manglados pelo Beehiiv (verificar diferença antes/depois do fix)", () => {
    // Sem o fix de slug (#1989), Beehiiv geraria "automa-o" para "automação"
    // Este teste documenta que o algoritmo correto gera "automacao"
    const url = deriveEditionUrl("Automação de alto risco");
    assert.ok(url.includes("automacao"), `URL deve conter 'automacao', obteve: ${url}`);
    assert.ok(!url.includes("automa-o"), `URL NÃO deve conter 'automa-o' (slug manglado)`);
  });

  it("URL começa com BEEHIIV_BASE_URL + /p/", () => {
    const url = deriveEditionUrl("Qualquer título");
    assert.ok(url.startsWith(`${BEEHIIV_BASE_URL}/p/`));
  });

  it("título longo é truncado em palavra inteira (seoSlug maxLen=60)", () => {
    // seoSlug trunca em ≤60 chars na última palavra inteira
    const longTitle = "Esta é uma frase muito longa que deve ser truncada pelo seoSlug em palavra inteira";
    const url = deriveEditionUrl(longTitle);
    // Extrair o slug da URL
    const slug = url.replace(`${BEEHIIV_BASE_URL}/p/`, "");
    assert.ok(slug.length <= 60, `slug deve ter ≤60 chars, obteve ${slug.length}: "${slug}"`);
    // Não deve terminar com hífen
    assert.ok(!slug.endsWith("-"), `slug não deve terminar com hífen: "${slug}"`);
  });
});

// ── (b) Testes unitários: findUnresolvedPlaceholders ─────────────────────────

describe("#2454 findUnresolvedPlaceholders — guard anti-placeholder", () => {
  it("texto sem placeholders → array vazio (OK para dispatch)", () => {
    const text = "Edição completa com mais 12 destaques em https://diar.ia.br/p/meu-slug";
    assert.deepEqual(findUnresolvedPlaceholders(text), []);
  });

  it("texto com {edition_url} → detectado", () => {
    const text = "Edição completa em {edition_url}";
    const found = findUnresolvedPlaceholders(text);
    assert.ok(found.includes("{edition_url}"), `deve detectar {edition_url}: ${JSON.stringify(found)}`);
  });

  it("texto com {outros_count} → detectado", () => {
    const text = "Mais {outros_count} destaques na edição completa";
    const found = findUnresolvedPlaceholders(text);
    assert.ok(found.includes("{outros_count}"), `deve detectar {outros_count}: ${JSON.stringify(found)}`);
  });

  it("texto com ambos os placeholders → ambos detectados", () => {
    const text = "Mais {outros_count} destaques em {edition_url}";
    const found = findUnresolvedPlaceholders(text);
    assert.ok(found.includes("{edition_url}"), "deve detectar {edition_url}");
    assert.ok(found.includes("{outros_count}"), "deve detectar {outros_count}");
    assert.equal(found.length, 2);
  });

  it("placeholder duplicado no texto → retorna só 1 entry (Set)", () => {
    // {edition_url} aparece 3× (um por destaque) — deve retornar só 1
    const text = "d1: {edition_url}\nd2: {edition_url}\nd3: {edition_url}";
    const found = findUnresolvedPlaceholders(text);
    assert.equal(found.filter(f => f === "{edition_url}").length, 1);
  });

  it("URL resolvida (diar.ia.br/p/slug) não é detectada como placeholder", () => {
    const text = "Edição em https://diar.ia.br/p/modelos-se-replicam-sozinhos";
    assert.deepEqual(findUnresolvedPlaceholders(text), []);
  });
});

// ── (c) Testes de integração: CLI resolve-edition-url.ts ────────────────────

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
  it("exit 0: grava URL correta via --title (palavra única sem espaços)", () => {
    // Usa título de palavra única para evitar problemas de quoting no shell
    // no Windows (shell:true + args array não escapa espaços). O comportamento
    // multi-palavra é testado via funções puras em (a)+(b) acima.
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
      "Edição em https://diar.ia.br/p/meu-slug",
      "Mais 12 destaques na edição.",
      "",
    ].join("\n");

    const { exitCode, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(exitCode, 0, `esperava exit 0 (social sem placeholder)`);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 3: --validate-social com {edition_url} não-resolvido → aborta (#2454 guard)", () => {
    // Simula o cenário em que o Stage 2 deixou o placeholder e o Stage 5
    // tentaria publicar com a URL não-resolvida.
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Post d1.",
      "Edição completa em {edition_url}",
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

  it("exit 3: --validate-social com {outros_count} não-resolvido → aborta (#2454 guard)", () => {
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Mais {outros_count} destaques na edição.",
      "",
    ].join("\n");

    const { exitCode, stderr, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(exitCode, 3, `esperava exit 3 (placeholder detectado), obteve ${exitCode}`);
    assert.match(stderr, /\{outros_count\}/);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("exit 0: acentos PT-BR via --slug passado pré-processado → URL correta", () => {
    // Testa o caminho --slug (acentos já removidos pelo caller).
    // Testes de remoção de acentos via --title estão nas funções puras acima (sem shell).
    const { exitCode, editionDir, tmp } = runCli(["--slug", "automacao-e-panico-no-mercado"]);
    const outPath = resolve(editionDir, "_internal", "05-edition-url.txt");
    assert.equal(exitCode, 0);
    const content = readFileSync(outPath, "utf8").trim();
    assert.ok(content.includes("/automacao-e-panico-no-mercado"), `URL deve ter slug sem acentos: ${content}`);
    assert.ok(!content.includes("automa-o"), `slug não deve ter 'automa-o' (manglaço do Beehiiv): ${content}`);
    rmSync(tmp, { recursive: true, force: true });
  });
});
