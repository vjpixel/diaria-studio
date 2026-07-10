/**
 * test/resolve-edition-url.test.ts (#2454, write-then-validate #3223, guard nao-fatal #3277)
 *
 * Testa:
 *   (a) deriveEditionUrl — URL publica derivada do titulo via seoSlug
 *       bate com o formato real do Beehiiv (https://diar.ia.br/p/{slug}).
 *   (b) findUnresolvedPlaceholders — guard anti-placeholder DETECTA qualquer
 *       placeholder {snake_case} nao-resolvido mas IGNORA {outros_count}
 *       (deferred-to-dispatch, resolvido por publish-linkedin). Deteccao pura
 *       — nao decide se e fatal (isso e responsabilidade do caller CLI, ver (c)).
 *   (c) CLI resolve-edition-url.ts — integracao via spawnSync:
 *       grava 05-edition-url.txt + (write-then-validate, #3223) reescreve
 *       03-social.md substituindo {edition_url} pela URL real ANTES de validar,
 *       entao --validate-social sempre retorna exit 0 (#3277 — o guard nao e
 *       mais fatal para NENHUM placeholder, incluindo os genericos/desconhecidos;
 *       ele apenas avisa via stdout/stderr + data/run-log.jsonl).
 *       Regressao #2454-finding-1: {outros_count} presente com {edition_url} resolvido -> exit 0.
 *       Regressao #2454-finding-3: --title seguido de outra flag nao crashar.
 *       Regressao #3223: {edition_url} literal em 03-social.md NAO bloqueia mais o
 *       guard (bug original: main() nunca escrevia o arquivo, guard sempre exit 3).
 *       Regressao #3277: placeholder generico/desconhecido (ex: {system_prompt},
 *       plausivel como exemplo de prompt citado num post sobre IA) NAO bloqueia
 *       mais o dispatch social inteiro (bug original: exit 3 fatal travava
 *       LinkedIn+Facebook+Instagram+Threads da edicao inteira por um falso
 *       positivo — ver issue #3277).
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

  // #3223: findUnresolvedPlaceholders generalizado de literal {edition_url}
  // para qualquer placeholder {snake_case} — sem isso, apos o write-then-validate
  // sempre substituir {edition_url}, o guard ficaria toothless (nunca mais
  // detectaria nada, mesmo que sobrasse um placeholder diferente nao-resolvido).
  it("#3223: placeholder generico diferente de {edition_url}/{outros_count} -> detectado", () => {
    const text = "Post com {algum_placeholder_novo} nao resolvido";
    const found = findUnresolvedPlaceholders(text);
    assert.ok(
      found.includes("{algum_placeholder_novo}"),
      `deve detectar placeholder generico: ${JSON.stringify(found)}`,
    );
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

  // #3223 regressao (bug original da issue): main() nunca reescrevia
  // 03-social.md — o guard rodava sobre o arquivo ORIGINAL intocado, que
  // sempre contem {edition_url} literal por design (assim stitch-newsletter.ts/
  // social-linkedin geram o arquivo). Resultado: exit 3 SEMPRE, em toda edicao
  // normal. Fix (write-then-validate): reescreve o arquivo substituindo
  // {edition_url} pela URL real ANTES de validar -> guard passa (exit 0).
  it("#3223 fix: --validate-social com {edition_url} nao-resolvido → REESCREVE 03-social.md e PASSA (exit 0, nao mais exit 3)", () => {
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Post d1.",
      "Edicao completa em {edition_url}",
      "",
    ].join("\n");

    const { exitCode, stdout, editionDir, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(exitCode, 0, `esperava exit 0 (fix #3223 — {edition_url} deve ser substituido antes de validar), obteve ${exitCode}`);
    assert.match(stdout, /reescrito/, "deve logar que 03-social.md foi reescrito");

    // (a) o arquivo 03-social.md em disco deve ter sido reescrito com a URL real,
    // substituindo o placeholder {edition_url} — nao apenas 05-edition-url.txt.
    const rewrittenPath = resolve(editionDir, "03-social.md");
    const rewritten = readFileSync(rewrittenPath, "utf8");
    assert.ok(
      rewritten.includes("https://diar.ia.br/p/meu-titulo-teste"),
      `03-social.md deve conter a URL real apos o write-then-validate: ${rewritten}`,
    );
    assert.ok(
      !rewritten.includes("{edition_url}"),
      `03-social.md NAO deve mais conter o placeholder {edition_url}: ${rewritten}`,
    );
    rmSync(tmp, { recursive: true, force: true });
  });

  // #3223 requirement (c) revisado por #3277: a substituicao de {edition_url}
  // nao deve tornar o guard toothless (ele ainda DETECTA um placeholder
  // GENUINAMENTE diferente, nao deferred) — mas desde #3277 a deteccao nao
  // bloqueia mais o dispatch (exit 0, apenas warning). Antes: exit 3 fatal.
  it("#3277: placeholder OUTRO (nao {edition_url}, nao deferred) sobrevive a substituicao → exit 0 (AVISO, nao bloqueia)", () => {
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Post d1 em {edition_url} com {algum_placeholder_novo} nao resolvido",
      "",
    ].join("\n");

    const { exitCode, stderr, stdout, editionDir, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(exitCode, 0, `#3277: placeholder generico nao-deferred NAO deve mais bloquear o dispatch, obteve ${exitCode}`);
    const combined = stderr + stdout;
    assert.match(combined, /\{algum_placeholder_novo\}/);
    assert.match(combined, /AVISO/);
    assert.match(combined, /guard anti-placeholder/);
    assert.match(combined, /bloqueado/i);

    // {edition_url} ainda deve ter sido substituido (o write acontece antes da
    // validacao) — so o placeholder desconhecido permanece, mas nao bloqueia.
    const rewrittenPath = resolve(editionDir, "03-social.md");
    const rewritten = readFileSync(rewrittenPath, "utf8");
    assert.ok(!rewritten.includes("{edition_url}"), "{edition_url} deve ter sido substituido");
    assert.ok(rewritten.includes("{algum_placeholder_novo}"), "placeholder desconhecido permanece intocado");
    rmSync(tmp, { recursive: true, force: true });
  });

  // #3277 regressao direta da issue: um post citando um exemplo de campo de
  // prompt/API entre chaves (plausivel numa newsletter de IA) NAO deve travar
  // o dispatch social da edicao inteira. Antes do fix, isso dava exit 3 fatal
  // e .claude/agents/orchestrator-stage-5.md tratava exit 3 como bloqueio total
  // do dispatch (LinkedIn+Facebook+Instagram+Threads).
  it("#3277 regressao da issue: post citando {system_prompt} como exemplo de prompt → exit 0 (nao trava a edicao)", () => {
    const socialMd = [
      "# LinkedIn",
      "",
      "## d1",
      "Testamos um prompt simples: {system_prompt} define o tom da resposta.",
      `Edicao completa em {edition_url} — mais {outros_count} destaques.`,
      "",
    ].join("\n");

    const { exitCode, stdout, stderr, editionDir, tmp } = runCli(
      ["--slug", "meu-titulo-teste", "--validate-social"],
      { "03-social.md": socialMd },
    );
    assert.equal(
      exitCode,
      0,
      `#3277: prosa legitima citando {system_prompt} nao deve bloquear o dispatch social, obteve ${exitCode}`,
    );
    const combined = stderr + stdout;
    assert.match(combined, /\{system_prompt\}/, "warning deve mencionar o placeholder ambiguo encontrado");

    // {edition_url} resolvido, {outros_count} permanece (deferred), {system_prompt}
    // permanece intocado (nao e um placeholder conhecido do pipeline).
    const rewritten = readFileSync(resolve(editionDir, "03-social.md"), "utf8");
    assert.ok(!rewritten.includes("{edition_url}"));
    assert.ok(rewritten.includes("{outros_count}"), "{outros_count} e deferred, nao deve ser tocado aqui");
    assert.ok(rewritten.includes("{system_prompt}"), "prosa legitima nao deve ser alterada pelo guard");
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
