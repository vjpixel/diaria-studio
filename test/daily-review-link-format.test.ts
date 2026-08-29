/**
 * test/daily-review-link-format.test.ts
 *
 * Guard do sed cosmético de `hermes/scripts/daily-consolidated-review.sh`, que
 * separa os links do resumo RESUMO-DAILY-REVIEW com espaço (clientes que
 * autolinkam, como o Telegram, grudam a URL na vírgula/no `=` e produzem link
 * quebrado).
 *
 * Duas propriedades travadas, e a segunda é a que importa de verdade:
 *
 *   1. a transformação faz o que diz — extrai o comando `sed` REAL do script
 *      (não uma cópia colada aqui, que poderia divergir em silêncio) e o roda
 *      sobre uma amostra de resumo;
 *   2. o `|| true` continua lá. O script roda sob `set -euo pipefail`: sem o
 *      `|| true`, uma falha deste sed (arquivo read-only, disco cheio) aborta
 *      ANTES de `echo "$HEAD_SHA" > "$STATE_FILE"`, o marco não avança, e o
 *      review Opus daquele dia — já pago e concluído — é refeito sobre o mesmo
 *      range no dia seguinte. Uma correção cosmética nunca deve custar isso.
 *
 * **Se este teste falhou:** não remova o `|| true` pra "propagar erros
 * corretamente". Aqui o erro é cosmético e o custo de propagá-lo é um review
 * inteiro. Se precisar mesmo saber que o sed falhou, logue em stderr — não
 * aborte.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "hermes/scripts/daily-consolidated-review.sh");

/** A linha `sed -i ...` real do script, sem depender de cópia manual. */
function sedLine(): string {
  const line = readFileSync(SCRIPT_PATH, "utf8")
    .split("\n")
    .find((l) => l.trimStart().startsWith("sed -i") && l.includes("OUT_FILE"));
  assert.ok(line, "linha `sed -i ... \"$OUT_FILE\"` não encontrada no script");
  return line!;
}

describe("daily-consolidated-review: formatação de links do resumo", () => {
  it("separa os links da vírgula e do `=` (sed real do script)", () => {
    const dir = mkdtempSync(join(tmpdir(), "daily-review-fmt-"));
    const file = join(dir, "out.txt");
    writeFileSync(
      file,
      "RESUMO-DAILY-REVIEW: commits=5 findings=2 issues_criadas=https://a/1,https://a/2 issues_falharam=0\n",
    );
    // roda a linha real, com OUT_FILE apontando pro arquivo de amostra
    execFileSync("bash", ["-c", `OUT_FILE=${JSON.stringify(file)}; ${sedLine()}`]);
    const out = readFileSync(file, "utf8");
    assert.match(out, /issues_criadas= https:\/\/a\/1, https:\/\/a\/2/);
  });

  it("não altera resumo que já está formatado (idempotente)", () => {
    const dir = mkdtempSync(join(tmpdir(), "daily-review-fmt-"));
    const file = join(dir, "out.txt");
    const already = "RESUMO-DAILY-REVIEW: issues_criadas= https://a/1, https://a/2 issues_falharam=0\n";
    writeFileSync(file, already);
    execFileSync("bash", ["-c", `OUT_FILE=${JSON.stringify(file)}; ${sedLine()}`]);
    assert.equal(readFileSync(file, "utf8"), already);
  });

  it("é fail-soft (`|| true`) — formatação não pode abortar o avanço do marco", () => {
    assert.match(
      sedLine(),
      /\|\|\s*true\s*$/,
      "o sed perdeu o `|| true`. Sob `set -euo pipefail` isso faz uma falha cosmética " +
        "abortar o script antes de gravar STATE_FILE, e o review Opus do dia (já pago) " +
        "é refeito sobre o mesmo range amanhã.",
    );
  });
});
