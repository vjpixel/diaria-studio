/**
 * test/resolve-claude-bin.test.ts (#5549)
 *
 * Regressão do achado ao vivo 260817: `diaria-edicao-diaria.service` falhou
 * nos 4 disparos entre 11 e 16/08/2026 com `spawnSync claude ENOENT` porque
 * o runner invocava o binário pelo NOME e o PATH do systemd user manager não
 * inclui `~/.npm-global/bin`. O teste central aqui é
 * "PATH mínimo do systemd + claude em ~/.npm-global/bin ainda resolve".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveClaudeBin, CLAUDE_BIN_HOME_CANDIDATES } from "../scripts/lib/resolve-claude-bin.ts";

/** PATH real do `systemctl --user show-environment` no predator (260817). */
const SYSTEMD_USER_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin";

/** `fileExists` de mentira: só os caminhos listados existem. */
const only = (...paths: string[]) => (p: string) => paths.includes(p);

describe("resolveClaudeBin (#5549)", () => {
  it("REGRESSÃO: PATH mínimo do systemd + claude em ~/.npm-global/bin -> resolve o caminho absoluto", () => {
    const resolved = resolveClaudeBin({
      env: { PATH: SYSTEMD_USER_PATH, HOME: "/home/vjpixel" },
      fileExists: only("/home/vjpixel/.npm-global/bin/claude"),
    });

    assert.equal(resolved, "/home/vjpixel/.npm-global/bin/claude");
  });

  it("REGRESSÃO: nunca devolve o literal 'claude' — o nome cru é exatamente o que dava ENOENT", () => {
    const resolved = resolveClaudeBin({
      env: { PATH: SYSTEMD_USER_PATH, HOME: "/home/vjpixel" },
      fileExists: only("/home/vjpixel/.npm-global/bin/claude"),
    });

    assert.notEqual(resolved, "claude");
    assert.ok(resolved.startsWith("/"), `esperava caminho absoluto, veio ${resolved}`);
  });

  it("CLAUDE_BIN explícito vence o PATH", () => {
    const resolved = resolveClaudeBin({
      env: { CLAUDE_BIN: "/opt/claude/bin/claude", PATH: "/usr/bin", HOME: "/home/vjpixel" },
      fileExists: only("/opt/claude/bin/claude", "/usr/bin/claude"),
    });

    assert.equal(resolved, "/opt/claude/bin/claude");
  });

  it("CLAUDE_BIN apontando pra caminho inexistente cai pro PATH em vez de falhar", () => {
    const resolved = resolveClaudeBin({
      env: { CLAUDE_BIN: "/opt/nao-existe/claude", PATH: "/usr/bin", HOME: "/home/vjpixel" },
      fileExists: only("/usr/bin/claude"),
    });

    assert.equal(resolved, "/usr/bin/claude");
  });

  it("shell do editor (claude no PATH) continua resolvendo pelo PATH", () => {
    const resolved = resolveClaudeBin({
      env: { PATH: `/home/vjpixel/.npm-global/bin:${SYSTEMD_USER_PATH}`, HOME: "/home/vjpixel" },
      fileExists: only("/home/vjpixel/.npm-global/bin/claude"),
    });

    assert.equal(resolved, "/home/vjpixel/.npm-global/bin/claude");
  });

  it("todos os candidatos de $HOME são tentados", () => {
    for (const relative of CLAUDE_BIN_HOME_CANDIDATES) {
      const expected = `/home/vjpixel/${relative}`;
      const resolved = resolveClaudeBin({
        env: { PATH: SYSTEMD_USER_PATH, HOME: "/home/vjpixel" },
        fileExists: only(expected),
      });
      assert.equal(resolved, expected);
    }
  });

  it("nenhum candidato existe -> LANÇA com mensagem acionável (nunca fallback silencioso)", () => {
    assert.throws(
      () =>
        resolveClaudeBin({
          env: { PATH: SYSTEMD_USER_PATH, HOME: "/home/vjpixel" },
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
    const resolved = resolveClaudeBin({
      env: { HOME: "/home/vjpixel" },
      fileExists: only("/home/vjpixel/.local/bin/claude"),
    });

    assert.equal(resolved, "/home/vjpixel/.local/bin/claude");
  });
});
