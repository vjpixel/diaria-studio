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
 *   (d) warnUnresolvedPlaceholders — unidade extraida de main() (#3277 code
 *       review): o warning REALMENTE e persistido em data/run-log.jsonl (nao
 *       so impresso), com rootDir isolado (tmpdir injetado) para nao gravar
 *       warns fabricados no log de producao real — regressao do bug achado
 *       pelo proprio code-review desta PR: a chamada original a logEvent()
 *       nao passava rootDir e poluia data/run-log.jsonl real a cada test run.
 *       Tambem cobre a regressao de ordering achada pelo sweep do code-review:
 *       "OK: ..." nao pode mais ser impresso incondicionalmente antes de um
 *       exit(1) por 03-social.md ausente (ver secao c, teste dedicado).
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
import { warnUnresolvedPlaceholders } from "../scripts/resolve-edition-url.ts";

// Importar funcoes puras diretamente para testes unitarios
import {
  deriveEditionUrl,
  findUnresolvedPlaceholders,
  substituteEditionUrl,
  BEEHIIV_BASE_URL,
} from "../scripts/lib/edition-url.ts";

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

// ── (b-bis) Testes unitarios: substituteEditionUrl (#3314) ──────────────────
//
// Regressao #3314: `text.replaceAll("{edition_url}", editionUrl)` usava
// `editionUrl` como argumento de substituicao LITERAL — mas
// `String.prototype.replaceAll` interpreta padroes especiais (`$&`, `$$`,
// `` $` ``, `$'`) dentro do argumento de substituicao (algoritmo
// GetSubstitution do ECMA-262) mesmo quando a busca e uma string simples.
// Mesmo bug corrigido em `apply-factcheck-autofix.ts` (#3292/#3275) via
// replacer function — este call site irmao ficou de fora daquele fix.
// Fix: `text.replaceAll("{edition_url}", () => editionUrl)`.

describe("#3314 substituteEditionUrl — editionUrl com padroes especiais de replacement preservado como literal", () => {
  it("substituicao simples sem padroes especiais continua funcionando", () => {
    const text = "Edicao completa em {edition_url}";
    const result = substituteEditionUrl(text, "https://diar.ia.br/p/meu-slug");
    assert.equal(result, "Edicao completa em https://diar.ia.br/p/meu-slug");
  });

  it("editionUrl contendo $& (match completo) preservado como literal, nao expandido", () => {
    const text = "Edicao em {edition_url} — confira";
    const editionUrl = "https://diar.ia.br/p/edicao-$&-especial";
    const result = substituteEditionUrl(text, editionUrl);
    assert.equal(
      result,
      "Edicao em https://diar.ia.br/p/edicao-$&-especial — confira",
      `$& deve ser preservado literal, nao expandido para o match: ${result}`,
    );
  });

  it("editionUrl contendo $$ (escape de $) preservado como literal, nao colapsado", () => {
    const text = "Link: {edition_url}";
    const editionUrl = "https://diar.ia.br/p/preco-$$-desconto";
    const result = substituteEditionUrl(text, editionUrl);
    assert.equal(
      result,
      "Link: https://diar.ia.br/p/preco-$$-desconto",
      `$$ deve permanecer como dois cifroes literais, nao colapsar para 1: ${result}`,
    );
  });

  it("editionUrl contendo $` (prefixo antes do match) preservado como literal", () => {
    const text = "Antes {edition_url} depois";
    const editionUrl = "https://diar.ia.br/p/slug-$`-x";
    const result = substituteEditionUrl(text, editionUrl);
    assert.equal(
      result,
      "Antes https://diar.ia.br/p/slug-$`-x depois",
      `$\` deve ser preservado literal, nao expandido para o prefixo: ${result}`,
    );
  });

  it("editionUrl contendo $' (sufixo apos o match) preservado como literal", () => {
    const text = "Antes {edition_url} depois";
    const editionUrl = "https://diar.ia.br/p/slug-$'-y";
    const result = substituteEditionUrl(text, editionUrl);
    assert.equal(
      result,
      "Antes https://diar.ia.br/p/slug-$'-y depois",
      `$' deve ser preservado literal, nao expandido para o sufixo: ${result}`,
    );
  });

  it("multiplas ocorrencias de {edition_url} no texto — todas substituidas corretamente com $& no valor", () => {
    const text = "d1: {edition_url}\nd2: {edition_url}\nd3: {edition_url}";
    const editionUrl = "https://diar.ia.br/p/$&-slug";
    const result = substituteEditionUrl(text, editionUrl);
    assert.equal(
      result,
      "d1: https://diar.ia.br/p/$&-slug\nd2: https://diar.ia.br/p/$&-slug\nd3: https://diar.ia.br/p/$&-slug",
    );
  });

  it("texto sem {edition_url} retorna identico ao original, mesmo com editionUrl contendo padroes especiais", () => {
    const text = "Nenhum placeholder aqui.";
    const result = substituteEditionUrl(text, "https://diar.ia.br/p/$&-$$-slug");
    assert.equal(result, text);
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

  // #3277 code-review (PR #3310): --log-root-dir aponta o warn do guard
  // anti-placeholder pro PRÓPRIO tmpdir do teste, não pro data/run-log.jsonl
  // real do repo. Sem isso, main() sempre resolve ROOT (script location,
  // cwd-independente por design) pro repo real, então nenhum cwd override
  // do spawnSync ajudaria — só a flag explícita isola de fato. Passado em
  // TODA chamada (não só nos testes que disparam o warning) — inofensivo
  // quando não usado, e cobre qualquer teste futuro que passe a disparar o
  // guard sem precisar lembrar de adicionar a flag manualmente.
  const result = spawnSync(
    NPX,
    ["tsx", "scripts/resolve-edition-url.ts", "--edition-dir", editionDir, "--log-root-dir", tmp, ...args],
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
    try {
      assert.equal(exitCode, 0, `#3277: placeholder generico nao-deferred NAO deve mais bloquear o dispatch, obteve ${exitCode}`);
      const combined = stderr + stdout;
      assert.match(combined, /\{algum_placeholder_novo\}/);
      assert.match(combined, /AVISO/);
      assert.match(combined, /guard anti-placeholder/);
      // #3277 sweep finding: /bloqueado/i sozinho passaria mesmo se "NÃO foi
      // bloqueado" virasse "foi bloqueado" por engano (regex nao pinava a
      // negacao). Fixado pra exigir a negacao adjacente à palavra.
      assert.match(combined, /n[ãa]o\s+foi\s+bloqueado/i, "deve afirmar explicitamente que NAO foi bloqueado, nao so conter a palavra 'bloqueado'");

      // {edition_url} ainda deve ter sido substituido (o write acontece antes da
      // validacao) — so o placeholder desconhecido permanece, mas nao bloqueia.
      const rewrittenPath = resolve(editionDir, "03-social.md");
      const rewritten = readFileSync(rewrittenPath, "utf8");
      assert.ok(!rewritten.includes("{edition_url}"), "{edition_url} deve ter sido substituido");
      assert.ok(rewritten.includes("{algum_placeholder_novo}"), "placeholder desconhecido permanece intocado");

      // #3277 code-review (PR #3310), regressao direta: ANTES desta PR, o
      // warn deste caminho (spawnSync via CLI real, nao chamada direta da
      // funcao) sempre gravava em {ROOT-do-repo}/data/run-log.jsonl mesmo
      // com rootDir sendo passado internamente — porque ROOT em si (nao o
      // cwd do processo) ja era resolvido pro repo real, e nao havia flag
      // pra sobrescrever isso a partir de fora. Confirmado empiricamente
      // pelo proprio code-review: dezenas de entries fabricadas com edition
      // "260999" apareciam no run-log real a cada rodada de teste. Com
      // --log-root-dir (passado por runCli() acima), o warn deve gravar
      // SOMENTE no tmpdir isolado deste teste — nunca no repo real.
      const isolatedLogPath = resolve(tmp, "data", "run-log.jsonl");
      assert.ok(existsSync(isolatedLogPath), "warn deveria gravar em data/run-log.jsonl DENTRO do tmpdir isolado (--log-root-dir)");
      const isolatedLog = readFileSync(isolatedLogPath, "utf8");
      assert.match(isolatedLog, /guard anti-placeholder \(#3277\)/, "entry do guard deveria estar no log isolado");

      // #3479: a comparação de snapshot contra data/run-log.jsonl REAL do
      // repo (antes/depois) foi removida daqui — a assertion positiva acima
      // já prova a intenção (write isolado via --log-root-dir), e o
      // snapshot era flaky sob concorrência com outros testes da suíte que
      // gravam no run-log real durante a janela do snapshot.
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // #3277 sweep finding (code review desta PR): numa iteracao anterior deste
  // fix, mover o "OK: ..." pra logo apos o write fez ele imprimir mesmo
  // quando --validate-social ia abortar com exit(1) por 03-social.md ausente
  // — o sentinel de sucesso mentindo sobre o resultado real do processo.
  // Este teste prova que isso NAO acontece mais: com 03-social.md ausente,
  // "OK:" nunca deve aparecer no stdout, so o erro + exit 1.
  it("#3277 sweep: --validate-social com 03-social.md ausente → exit 1 SEM imprimir 'OK:' antes do erro", () => {
    const tmp = mkdtempSync(resolve(tmpdir(), "resolve-edition-url-"));
    const editionDir = resolve(tmp, "260999");
    mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
    // Nao cria 03-social.md de propósito.
    try {
      const result = spawnSync(
        NPX,
        ["tsx", "scripts/resolve-edition-url.ts", "--edition-dir", editionDir, "--slug", "x", "--validate-social"],
        { encoding: "utf8", stdio: "pipe", shell: isWindows },
      );
      assert.equal(result.status, 1, "03-social.md ausente deve abortar com exit 1");
      assert.match(result.stderr ?? "", /03-social\.md não encontrado/);
      assert.ok(
        !(result.stdout ?? "").includes("OK:"),
        `"OK:" NAO deve aparecer no stdout quando o processo termina em exit 1: ${result.stdout}`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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
    try {
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
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
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

// ── (d) warnUnresolvedPlaceholders — o warning REALMENTE e persistido ───────
//
// #3277 code review (achado num code-review max-effort desta PR): a
// implementacao inicial chamava logEvent() sem rootDir, entao caia no
// default process.cwd() — em producao normalmente == raiz do repo
// (inofensivo), mas nos testes da secao (c) acima, que spawnam o CLI via
// spawnSync SEM cwd override, isso gravava warns FABRICADOS (edition
// "260999") direto em data/run-log.jsonl real do worktree. Corrigido:
// main() agora sempre passa ROOT explicitamente pra logEvent (nunca confia
// em process.cwd() implicito, mesma filosofia ja usada pra resolver
// --edition-dir contra ROOT). Este bloco testa a funcao extraida
// diretamente, com rootDir isolado (tmpdir), pra provar que o side-effect
// (nao so o texto impresso) esta correto.
describe("warnUnresolvedPlaceholders (#3277 — o warning REALMENTE e persistido, rootDir isolado)", () => {
  it("persiste warn em data/run-log.jsonl com os campos corretos", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "resolve-edition-url-warn-"));
    try {
      warnUnresolvedPlaceholders(
        ["{system_prompt}"],
        "260623",
        "https://diar.ia.br/p/titulo-d1",
        "/fake/edition/03-social.md",
        dir,
      );

      const logPath = resolve(dir, "data", "run-log.jsonl");
      assert.ok(existsSync(logPath), "data/run-log.jsonl deveria existir apos o warning");
      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[lines.length - 1]);
      assert.equal(entry.level, "warn");
      assert.equal(entry.edition, "260623");
      assert.equal(entry.stage, 5);
      assert.equal(entry.agent, "resolve-edition-url");
      assert.match(entry.message, /guard anti-placeholder \(#3277\)/);
      assert.deepEqual(entry.details.unresolved, ["{system_prompt}"]);
      assert.equal(entry.details.edition_url, "https://diar.ia.br/p/titulo-d1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("editionId null → grava edition:null e a dica impressa nao repete o placeholder {edition} literal", () => {
    const dir = mkdtempSync(resolve(tmpdir(), "resolve-edition-url-warn-noedition-"));
    const originalWarn = console.warn;
    let printed = "";
    console.warn = (msg: string) => { printed = msg; };
    try {
      warnUnresolvedPlaceholders(
        ["{campo_novo}"],
        null,
        "https://diar.ia.br/p/titulo-d1",
        "/fake/edition/03-social.md",
        dir,
      );

      const logPath = resolve(dir, "data", "run-log.jsonl");
      const entry = JSON.parse(readFileSync(logPath, "utf8").trim());
      assert.equal(entry.edition, null);
      // #3277 finding (angle A do code-review): antes do fix, a dica impressa
      // citava literalmente "/diaria-log {edition} warn" (placeholder nao
      // substituido) quando editionId era null — confuso, parece um bug
      // igual ao que o proprio guard esta reportando. Agora deve orientar
      // por agent em vez de citar um {edition} nao-resolvido.
      assert.ok(!printed.includes("{edition} warn"), `dica nao deve conter placeholder literal: ${printed}`);
      assert.match(printed, /resolve-edition-url/);
    } finally {
      console.warn = originalWarn;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
