/**
 * test/hermes-key-not-in-cmdline.test.ts (#6718)
 *
 * Guard de regressão do vazamento de credencial medido ao vivo em 29/08/2026:
 * `hermes/scripts/claude-openrouter.sh` passava `ANTHROPIC_AUTH_TOKEN` como
 * argumento de `env VAR=valor`, e argumentos de processo são world-readable
 * em `/proc/<pid>/cmdline` (0444) — um `ps -eo args` trivial, sem privilégio
 * nenhum, imprimia a chave inteira (`sk-or-v1-...`) durante TODA a duração da
 * delegação (`--timeout 2400` = até 40 min por tick, a cada 30 min). Foi um
 * `ps` rodado para outro fim que descobriu o vazamento.
 *
 * O fix move a chave pra `export` dentro do subshell que envolve o `claude`:
 * `/proc/<pid>/environ` é 0400 (só o dono lê), e o subshell preserva o escopo
 * que o `env` garantia — as vars morrem com ele, nunca escapam pro shell que
 * chamou o wrapper (regra #5608: sequestrariam sessões da assinatura claude.ai).
 *
 * Por que parse de script e não teste de execução: o wrapper dispara o CLI
 * real contra o OpenRouter (rede + key); o que este teste trava é a FORMA da
 * invocação — a mesma abordagem de `test/hermes-background-model-pin.test.ts`
 * e `test/hermes-model-chain-drift.test.ts`.
 *
 * O padrão é multi-linha com continuação `\` e por isso ESCAPA de grep de
 * linha única (a própria issue #6718 aponta isso) — o teste junta continuações
 * em linhas lógicas antes de asserir, e um dos testes prova que a junção
 * aconteceu (a linha do `claude -p` tem que conter flags de linhas seguintes).
 *
 * **Se você chegou aqui porque este teste falhou:** não relaxe a asserção —
 * a chave voltou pro cmdline. O caminho certo é o que o fix do #6718 faz:
 * `export` dentro do subshell do `OUT=$(... | ( ... ))`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");
const VAR = "ANTHROPIC_AUTH_TOKEN";

/**
 * Remove `# ...` no fim da linha, respeitando aspas — cópia local do
 * `stripInlineComment` de test/hermes-background-model-pin.test.ts (que o
 * exporta). Duplicado de propósito: importar o arquivo de teste registraria
 * os testes do pin uma segunda vez no runner deste arquivo.
 */
function stripInlineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== "\\") quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Linhas LÓGICAS do wrapper em código: sem comentário (o docblock do script
 * cita a var em prosa — casar com isso daria falso verde) e com continuações
 * `\` JUNTAS — sem a junção, o `env \` multi-linha que a issue descreve
 * escapa de qualquer asserção linha a linha.
 */
function logicalCodeLines(): string[] {
  const physical = readFileSync(WRAPPER_PATH, "utf8")
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map(stripInlineComment);
  const out: string[] = [];
  let pending: string | null = null;
  for (const line of physical) {
    const piece = line.trimEnd();
    pending = pending === null ? piece : `${pending} ${piece.trim()}`;
    if (pending.endsWith("\\")) {
      pending = pending.slice(0, -1);
    } else {
      out.push(pending);
      pending = null;
    }
  }
  if (pending !== null) out.push(pending);
  return out;
}

describe("claude-openrouter.sh — chave fora do cmdline (#6718)", () => {
  it("toda ocorrência de ANTHROPIC_AUTH_TOKEN= em código é `export`", () => {
    const lines = logicalCodeLines().filter((l) => l.includes(`${VAR}=`));
    assert.ok(
      lines.length >= 1,
      "ANTHROPIC_AUTH_TOKEN desapareceu do código do wrapper. Duas leituras, " +
        "as duas acionáveis: (a) a entrega da chave foi removida de verdade — " +
        "a delegação quebra em auth; (b) a entrega trocou de mecanismo (ex: " +
        "`claude --api-key \"$KEY\"`) — que REINTRODUZ o vazamento da #6718, " +
        "pois flags também são argumentos de processo (cmdline 0444). Nenhuma " +
        "das duas é o caminho: a chave entra por export no subshell.",
    );
    for (const line of lines) {
      assert.match(
        line.trim(),
        new RegExp(`^export ${VAR}=`),
        `ANTHROPIC_AUTH_TOKEN só pode entrar no ambiente via export (environ é ` +
          `0400, legível só pelo dono do processo). Como argumento de \`env\`/` +
          `comando ela vira /proc/<pid>/cmdline (0444, legível por qualquer ` +
          `processo da máquina) — o vazamento da #6718. Linha: ${line.trim()}`,
      );
    }
  });

  it("nenhum env/timeout recebe a chave como argumento", () => {
    const offenders = logicalCodeLines().filter(
      (l) => /(^|\s)(env|timeout)\s/.test(l) && l.includes(`${VAR}=`),
    );
    assert.deepEqual(
      offenders,
      [],
      "a chave voltou pro cmdline via `env VAR=valor` — ver #6718: `ps -eo args` " +
        "imprime a chave inteira durante toda a delegação.",
    );
  });

  it("a exportação acontece no mesmo subshell que invoca o claude (chega ao CLI, não vaza pro shell chamador)", () => {
    const lines = logicalCodeLines();
    const iSub = lines.findIndex((l) => l.includes(`OUT=$(printf '%s' "$PROMPT" | (`));
    const iExport = lines.findIndex((l) => l.trim().startsWith(`export ${VAR}=`));
    const iClaude = lines.findIndex((l) => l.includes("claude -p"));
    const iClose = lines.findIndex((l, i) => i > iSub && l.trim() === "))");
    const iRc = lines.findIndex((l) => l.trim() === "RC=$?");
    assert.ok(iSub >= 0, "subshell do OUT=$(printf ... | ( não encontrado — a estrutura do fix #6718 mudou");
    assert.ok(iExport > iSub, "ANTHROPIC_AUTH_TOKEN exportado FORA do bloco do wrapper: se este trecho for colado/fonteado num shell interativo (o padrão do incidente #5608), a var sequestra sessões da assinatura claude.ai — o export tem que ficar dentro do subshell do OUT=$(...)");
    assert.ok(iClaude > iExport, "o claude -p roda ANTES do export da chave — a delegação sobe sem auth");
    assert.ok(iClose > iExport && iClose > iClaude, "export e claude -p não estão contidos no MESMO subshell (fechamento )) antes de ambos): a chave pode não chegar ao CLI ou o escopo do wrapper se rompe — preservar o bloco OUT=$(printf ... | ( ... )) do fix #6718");
    assert.ok(iRc > iClaude, "âncora RC=$? não encontrada depois da invocação — estrutura do loop de tentativas mudou");
  });

  it("a junção de continuações cobre o padrão multi-linha (o guard não pode passar vazio)", () => {
    // O padrão do vazamento era multi-linha com `\` — se a junção parar de
    // funcionar, as asserções acima podiam passar sem nunca ver a invocação
    // inteira. A linha lógica do claude tem que conter flags de linhas seguintes.
    const claudeLine = logicalCodeLines().find((l) => l.includes("claude -p"));
    assert.ok(claudeLine, "linha lógica do claude -p não encontrada");
    assert.match(claudeLine, /--max-budget-usd "\$BUDGET"/, "continuações \\ não foram juntadas — o guard deste arquivo ficou cego ao padrão multi-linha da #6718");
  });
});
