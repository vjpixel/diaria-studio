/**
 * test/gitignore-runtime-tmp-dirs-6691.test.ts (#6691)
 *
 * Guard de COMPORTAMENTO das regras de `.gitignore` que protegem diretórios
 * temporários de runtime (`scripts/_tmp_*`, `test/_tmp_*`).
 *
 * ## Por que testar comportamento, e não a presença da linha
 *
 * O #6541 já tinha adicionado a regra `scripts/_tmp_<star>/` — e ela viveu inerte
 * até 29/08/2026, porque foi escrita como:
 *
 *     scripts/_tmp_<star>/  # #6541: runtime temp dirs created by overnight/...
 *
 * (`<star>` acima = asterisco literal; escrito assim porque a sequência
 * asterisco-barra fecharia este próprio bloco de comentário.)
 *
 * `.gitignore` **não suporta comentário inline**: `#` só inicia comentário no
 * começo da linha. O padrão real virou a string inteira (com os dois espaços e
 * o texto do comentário), que não casa com nada. Um `grep` por
 * `scripts/_tmp_` no arquivo teria passado — a linha ESTAVA lá. Só
 * `git check-ignore` revela que ela não fazia efeito.
 *
 * Custo do modo de falha: um artefato de runtime com e-mail, status e
 * engajamento de 100 assinantes foi commitado em `f107aa08` e ficou público
 * (#6691 — o repositório é público).
 *
 * Por isso este teste chama `git check-ignore` de verdade, em vez de inspecionar
 * o texto do `.gitignore`. Uma regra que existe mas não casa é exatamente o bug
 * que ele precisa pegar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** `git check-ignore -q` sai 0 se o caminho é ignorado, 1 se não é. Caminho
 *  não precisa existir em disco — a checagem é sobre as REGRAS. */
function isIgnored(relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", relPath], { cwd: repoRoot, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("#6691 — diretórios temporários de runtime são de fato ignorados", () => {
  for (const p of [
    "scripts/_tmp_engagement_backup3/b29f6620_p1.json",
    "scripts/_tmp_qualquer/a.json",
    "scripts/_tmp_x/sub/dir/b.txt",
    "test/_tmp_intentional_error/x.json",
  ]) {
    it(`ignora ${p}`, () => {
      assert.equal(isIgnored(p), true, `${p} NÃO está sendo ignorado — regra de .gitignore inerte (ver docstring: comentário inline quebra o padrão)`);
    });
  }

  it("nenhum arquivo sob scripts/_tmp_* ou test/_tmp_* está RASTREADO", () => {
    const tracked = execFileSync("git", ["ls-files", "scripts/_tmp_*", "test/_tmp_*"], { cwd: repoRoot, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(
      tracked,
      [],
      `artefato(s) de runtime versionado(s) — podem conter PII de assinante em repo PÚBLICO (#6691): ${tracked.join(", ")}`,
    );
  });

  /**
   * Estreitado após review do PR #6707: a versão anterior recusava QUALQUER `#`
   * numa linha de padrão, o que é mais estrito que a regra real do gitignore e
   * geraria falso-positivo em dois casos legítimos:
   *
   *   - `#` no meio do padrão (`notes#draft/`) — só o `#` na PRIMEIRA coluna
   *     inicia comentário, então `#` no miolo é sintaxe válida;
   *   - hash inicial escapado (`\#foo`) — padrão para arquivo que começa com
   *     `#`; não casa `startsWith("#")`, e seria acusado à toa.
   *
   * O bug do #6691 é especificamente ESPAÇO EM BRANCO seguido de `#` — a forma
   * que produz "padrão + comentário inline". É só isso que se recusa aqui.
   * Um guard mais estrito que a regra que ele protege vira, ele mesmo, a
   * próxima armadilha.
   */
  it("não regride pro bug do comentário inline: nenhuma linha de padrão do .gitignore tem espaço seguido de '#'", () => {
    const lines = readFileSync(resolve(repoRoot, ".gitignore"), "utf8").split("\n");
    const offenders = lines.filter((l) => {
      const t = l.trim();
      if (!t || t.startsWith("#")) return false; // linha vazia ou comentário legítimo
      // Só acusa espaço-em-branco seguido de `#`: a assinatura do comentário
      // inline. `#` colado no padrão é válido (ver docstring acima).
      return /\s#/.test(t);
    });
    assert.deepEqual(
      offenders,
      [],
      `comentário inline em .gitignore não é suportado — o padrão vira a linha inteira e casa com nada: ${offenders.join(" | ")}`,
    );
  });
});
