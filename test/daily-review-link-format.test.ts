/**
 * test/daily-review-link-format.test.ts
 *
 * Guard do sed cosmético de `hermes/scripts/opus-daily-diff-review.sh`, que
 * separa os links do resumo RESUMO-DAILY-REVIEW com espaço (clientes que
 * autolinkam, como o Telegram, grudam a URL na vírgula/no `=` e produzem link
 * quebrado).
 *
 * Duas propriedades travadas, e a segunda é a que importa de verdade:
 *
 *   1. a transformação faz o que diz — extrai o comando `sed` REAL do script
 *      (não uma cópia colada aqui, que poderia divergir em silêncio) e o roda
 *      sobre uma amostra de resumo;
 *   2. o degrade fail-soft (`|| echo ... >&2`) continua lá. O script roda sob
 *      `set -euo pipefail`: sem o `||`, uma falha deste sed (arquivo
 *      read-only, disco cheio) aborta ANTES de
 *      `echo "$HEAD_SHA" > "$STATE_FILE"`, o marco não avança, e o review Opus
 *      daquele dia — já pago e concluído — é refeito sobre o mesmo range no dia
 *      seguinte. Uma correção cosmética nunca deve custar isso;
 *   3. a substituição fica ESCOPADA à linha do resumo. O OUT_FILE é o
 *      transcript inteiro do Opus: sem o endereço `/RESUMO-DAILY-REVIEW:/`, um
 *      `,https://` em prosa ou código citado no corpo do review também seria
 *      reescrito (achado do review da PR #6738).
 *
 * **Se este teste falhou:** não remova o `||` pra "propagar erros
 * corretamente". Aqui o erro é cosmético e o custo de propagá-lo é um review
 * inteiro — o caminho certo é continuar avisando em stderr, nunca abortar.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = join(ROOT, "hermes/scripts/opus-daily-diff-review.sh");

/** A linha `sed -i ...` real do script, sem depender de cópia manual. */
function sedLine(): string {
  const line = readFileSync(SCRIPT_PATH, "utf8")
    .split("\n")
    .find((l) => l.trimStart().startsWith("sed -i") && l.includes("OUT_FILE"));
  assert.ok(line, "linha `sed -i ... \"$OUT_FILE\"` não encontrada no script");
  return line!;
}

describe("opus-daily-diff-review: formatação de links do resumo", () => {
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
    rmSync(dir, { recursive: true, force: true });
  });

  it("não altera resumo que já está formatado (idempotente)", () => {
    const dir = mkdtempSync(join(tmpdir(), "daily-review-fmt-"));
    const file = join(dir, "out.txt");
    const already = "RESUMO-DAILY-REVIEW: issues_criadas= https://a/1, https://a/2 issues_falharam=0\n";
    writeFileSync(file, already);
    execFileSync("bash", ["-c", `OUT_FILE=${JSON.stringify(file)}; ${sedLine()}`]);
    assert.equal(readFileSync(file, "utf8"), already);
    rmSync(dir, { recursive: true, force: true });
  });

  it("é fail-soft e AVISA — formatação não pode abortar o avanço do marco", () => {
    const line = sedLine();
    assert.match(
      line,
      /\|\|/,
      "o sed perdeu o degrade `||`. Sob `set -euo pipefail` isso faz uma falha cosmética " +
        "abortar o script antes de gravar STATE_FILE, e o review Opus do dia (já pago) " +
        "é refeito sobre o mesmo range amanhã.",
    );
    assert.match(
      line,
      />&2/,
      "o degrade ficou SILENCIOSO. Fail-soft aqui é correto, mas sem aviso em stderr " +
        "ninguém descobre que a formatação parou de rodar — mesmo padrão do fallback " +
        "de BASE_SHA inválido neste script.",
    );
  });

  it("não toca `,https://` fora da linha do resumo (escopo)", () => {
    const dir = mkdtempSync(join(tmpdir(), "daily-review-fmt-"));
    const file = join(dir, "out.txt");
    // corpo do review citando uma lista de URLs — NÃO deve ser reescrito
    const corpo = "Finding 2: veja os links,https://exemplo/1,https://exemplo/2 no diff\n";
    writeFileSync(file, corpo + "RESUMO-DAILY-REVIEW: issues_criadas=https://a/1,https://a/2\n");
    execFileSync("bash", ["-c", `OUT_FILE=${JSON.stringify(file)}; ${sedLine()}`]);
    const out = readFileSync(file, "utf8");
    assert.ok(out.startsWith(corpo), `corpo do review foi mutado fora do escopo:\n${out}`);
    assert.match(out, /issues_criadas= https:\/\/a\/1, https:\/\/a\/2/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("cobre http:// além de https://", () => {
    const dir = mkdtempSync(join(tmpdir(), "daily-review-fmt-"));
    const file = join(dir, "out.txt");
    writeFileSync(file, "RESUMO-DAILY-REVIEW: issues_criadas=http://a/1,http://a/2\n");
    execFileSync("bash", ["-c", `OUT_FILE=${JSON.stringify(file)}; ${sedLine()}`]);
    assert.match(readFileSync(file, "utf8"), /issues_criadas= http:\/\/a\/1, http:\/\/a\/2/);
    rmSync(dir, { recursive: true, force: true });
  });
});
