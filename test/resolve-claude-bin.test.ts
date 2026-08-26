/**
 * test/resolve-claude-bin.test.ts (#5549)
 *
 * Regressão do achado ao vivo 260817: `diaria-edicao-diaria.service` falhou
 * nos 4 disparos entre 11 e 16/08/2026 com `spawnSync claude ENOENT` porque
 * o runner invocava o binário pelo NOME e o PATH do systemd user manager não
 * inclui `~/.npm-global/bin`. O teste central aqui é
 * "PATH mínimo do systemd + claude em ~/.npm-global/bin ainda resolve".
 *
 * ## Portabilidade do teste (#6206)
 *
 * O cenário sob teste é POSIX (systemd no `helios`), mas o TESTE roda também
 * na máquina Windows do editor — e antes do #6206 falhava lá inteiro (26 das
 * 52 falhas locais), por duas premissas do próprio teste, nunca da função:
 *
 *   1. **Caminho esperado escrito à mão em formato POSIX.** `resolveClaudeBin`
 *      devolve o que `path.resolve` produz; no Windows isso é
 *      `C:\home\vjpixel\...\claude`, que nunca é `=== "/home/vjpixel/.../claude"`.
 *      Corrigido derivando o esperado com o MESMO `resolve` que a função usa
 *      (`homePath`/`pathEntry` abaixo) — o cenário continua sendo o do systemd,
 *      só deixa de assumir o separador do SO onde o teste roda.
 *   2. **PATH montado com `:` literal.** `resolveClaudeBin` divide por
 *      `path.delimiter`, que é `;` no Windows — a string inteira virava UMA
 *      entrada e a varredura de PATH nunca encontrava nada. Corrigido montando
 *      o PATH com `delimiter`.
 *
 * Nenhuma das duas é comportamento de produção: a função já era correta nas
 * duas plataformas. O que muda aqui é só o teste parar de codificar o SO.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import { resolveClaudeBin, isExecutableFile, CLAUDE_BIN_HOME_CANDIDATES } from "../scripts/lib/resolve-claude-bin.ts";

/**
 * PATH real do `systemctl --user show-environment` no helios (260817), montado
 * com o `delimiter` da plataforma — a função divide por ele, não por `:` fixo.
 */
const SYSTEMD_USER_PATH = [
  "/usr/local/sbin",
  "/usr/local/bin",
  "/usr/sbin",
  "/usr/bin",
  "/sbin",
  "/bin",
  "/usr/games",
  "/usr/local/games",
  "/snap/bin",
].join(delimiter);

const HOME = "/home/vjpixel";

/** Caminho como `resolveClaudeBin` o produz a partir de `$HOME` + candidato. */
const homePath = (home: string, relative: string) => resolvePath(home, relative);

/** Caminho como `resolveClaudeBin` o produz a partir de uma entrada do PATH. */
const pathEntry = (dir: string, name = "claude") => resolvePath(dir, name);

/** `fileExists` de mentira: só os caminhos listados existem. */
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe("resolveClaudeBin (#5549)", () => {
  it("REGRESSÃO: PATH mínimo do systemd + claude em ~/.npm-global/bin -> resolve o caminho absoluto", () => {
    const expected = homePath(HOME, ".npm-global/bin/claude");
    const resolved = resolveClaudeBin({
      env: { PATH: SYSTEMD_USER_PATH, HOME },
      fileExists: only(expected),
    });

    assert.equal(resolved, expected);
  });

  it("REGRESSÃO: nunca devolve o literal 'claude' — o nome cru é exatamente o que dava ENOENT", () => {
    const resolved = resolveClaudeBin({
      env: { PATH: SYSTEMD_USER_PATH, HOME },
      fileExists: only(homePath(HOME, ".npm-global/bin/claude")),
    });

    assert.notEqual(resolved, "claude");
    assert.ok(isAbsolute(resolved), `esperava caminho absoluto, veio ${resolved}`);
  });

  it("CLAUDE_BIN explícito vence o PATH", () => {
    const explicit = resolvePath("/opt/claude/bin/claude");
    const resolved = resolveClaudeBin({
      env: { CLAUDE_BIN: "/opt/claude/bin/claude", PATH: "/usr/bin", HOME },
      fileExists: only(explicit, pathEntry("/usr/bin")),
    });

    assert.equal(resolved, explicit);
  });

  it("CLAUDE_BIN apontando pra caminho inexistente cai pro PATH em vez de falhar", () => {
    const expected = pathEntry("/usr/bin");
    const resolved = resolveClaudeBin({
      env: { CLAUDE_BIN: "/opt/nao-existe/claude", PATH: "/usr/bin", HOME },
      fileExists: only(expected),
    });

    assert.equal(resolved, expected);
  });

  it("shell do editor (claude no PATH) continua resolvendo pelo PATH", () => {
    const expected = pathEntry("/home/vjpixel/.npm-global/bin");
    const resolved = resolveClaudeBin({
      env: { PATH: `/home/vjpixel/.npm-global/bin${delimiter}${SYSTEMD_USER_PATH}`, HOME },
      fileExists: only(expected),
    });

    assert.equal(resolved, expected);
  });

  it("todos os candidatos de $HOME são tentados", () => {
    for (const relative of CLAUDE_BIN_HOME_CANDIDATES) {
      const expected = homePath(HOME, relative);
      const resolved = resolveClaudeBin({
        env: { PATH: SYSTEMD_USER_PATH, HOME },
        fileExists: only(expected),
      });
      assert.equal(resolved, expected);
    }
  });

  it("nenhum candidato existe -> LANÇA com mensagem acionável (nunca fallback silencioso)", () => {
    assert.throws(
      () =>
        resolveClaudeBin({
          env: { PATH: SYSTEMD_USER_PATH, HOME },
          fileExists: () => false,
        }),
      (err: Error) => {
        assert.match(err.message, /CLAUDE_BIN/, "a mensagem deve dizer como consertar");
        assert.match(err.message, /npm-global/, "a mensagem deve citar o caso real do systemd");
        assert.match(err.message, /Tentados:/, "a mensagem deve enumerar o que foi tentado");
        return true;
      },
    );
  });

  it("PATH ausente/vazio não quebra a varredura — cai nos candidatos de $HOME", () => {
    const expected = homePath(HOME, ".local/bin/claude");
    const resolved = resolveClaudeBin({
      env: { HOME },
      fileExists: only(expected),
    });

    assert.equal(resolved, expected);
  });

  it("HOME e PATH ausentes, sem CLAUDE_BIN -> lança limpo, sem TypeError", () => {
    assert.throws(
      () => resolveClaudeBin({ env: {}, fileExists: () => false }),
      (err: Error) => {
        assert.doesNotMatch(err.message, /undefined|TypeError/);
        assert.match(err.message, /CLAUDE_BIN/);
        return true;
      },
    );
  });

  it("REGRESSÃO #5790: só claude.exe existe no PATH (sem claude sem sufixo) -> resolve o .exe", () => {
    const expected = pathEntry("/home/vjpix/.local/bin", "claude.exe");
    const resolved = resolveClaudeBin({
      env: { PATH: "/home/vjpix/.local/bin", HOME: "/home/vjpix" },
      fileExists: only(expected),
    });

    assert.equal(resolved, expected);
  });

  it("REGRESSÃO #5790: só claude.exe existe em CLAUDE_BIN_HOME_CANDIDATES (caso real da issue: C:\\Users\\vjpix\\.local\\bin\\claude.exe) -> resolve o .exe", () => {
    const expected = homePath("/home/vjpix", ".local/bin/claude.exe");
    const resolved = resolveClaudeBin({
      env: { PATH: "", HOME: "/home/vjpix" },
      fileExists: only(expected),
    });

    assert.equal(resolved, expected);
  });

  it("entrada RELATIVA no PATH ainda produz caminho absoluto", () => {
    const relativeCandidate = join(process.cwd(), "bin", "claude");
    const resolved = resolveClaudeBin({
      env: { PATH: "bin", HOME },
      fileExists: only(relativeCandidate),
    });

    assert.equal(resolved, relativeCandidate);
    assert.ok(isAbsolute(resolved), `esperava absoluto, veio ${resolved}`);
  });
});

describe("isExecutableFile — predicado default (#5549)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "resolve-claude-bin-test-"));

  after(() => rmSync(tmp, { recursive: true, force: true }));

  it("arquivo com bit de execução -> true", () => {
    const p = join(tmp, "exec-ok");
    writeFileSync(p, "#!/bin/sh\n");
    chmodSync(p, 0o755);
    assert.equal(isExecutableFile(p), true);
  });

  // POSIX-only de verdade (#6206): o Windows não tem bit de execução. `chmod`
  // 0o644 lá só mexe no atributo somente-leitura, e `accessSync(p, X_OK)`
  // responde OK pra qualquer arquivo legível — não existe o estado que este
  // teste verifica, então declará-lo `skipped` com o motivo é mais honesto que
  // deixá-lo falhar como se fosse defeito. O comportamento sob POSIX (onde o
  // caso real acontece: `claude` sem `+x` no PATH do systemd) segue coberto.
  it("arquivo SEM bit de execução -> false (existsSync diria true e explodiria com EACCES)", { skip: process.platform === "win32" ? "sem bit de execução no Windows" : false }, () => {
    const p = join(tmp, "sem-exec");
    writeFileSync(p, "nao sou executavel\n");
    chmodSync(p, 0o644);
    assert.equal(isExecutableFile(p), false);
  });

  it("DIRETÓRIO chamado claude -> false (existsSync diria true e explodiria com EISDIR)", () => {
    const p = join(tmp, "claude");
    mkdirSync(p, { recursive: true });
    assert.equal(isExecutableFile(p), false);
  });

  it("caminho inexistente -> false, sem lançar", () => {
    assert.equal(isExecutableFile(join(tmp, "nao-existe")), false);
  });

  it("um diretório no PATH não é aceito como binário", () => {
    mkdirSync(join(tmp, "claude"), { recursive: true });
    assert.throws(() => resolveClaudeBin({ env: { PATH: tmp }, fileExists: isExecutableFile }), /não encontrado/);
  });
});
