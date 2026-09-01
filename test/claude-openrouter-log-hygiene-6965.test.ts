/**
 * test/claude-openrouter-log-hygiene-6965.test.ts (#6965)
 *
 * Guard de regressão para as 3 lacunas do log de diagnóstico de
 * `hermes/scripts/claude-openrouter.sh` levantadas pela issue #6965 (não
 * cobertas pelas PRs #6803/#6808):
 *
 * 1. (P2) Rotação/limpeza dos logs crus em /tmp — sem isso, o STDERR_LOG
 *    ($$-escopado) sobrevive indefinidamente quando a cadeia falha inteira
 *    (o caminho de erro nunca o remove, de propósito). O job do contínuo
 *    roda a cada ~30min sem teto de disco.
 * 2. (P1) Redação de segredo — a chave do OpenRouter pode aparecer numa
 *    mensagem de erro do provedor e acabar persistida em /tmp sem filtro,
 *    inclusive no path ESTÁVEL claude-openrouter-last-failure.log.
 * 3. (P3) Tamanho em bytes de stdout/stderr — rc+duração (já capturados
 *    pelo #6666 item 1) não distinguem "morreu instantâneo sem escrever
 *    nada" de "rodou e falhou com output".
 *
 * Teste de parsing estático — não executa o CLI nem faz request de rede,
 * mesma técnica de test/hermes-openrouter-evidence-capture.test.ts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_PATH = join(ROOT, "hermes/scripts/claude-openrouter.sh");

describe("claude-openrouter.sh — item 1: rotação/limpeza dos logs crus em /tmp (#6965)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("roda uma limpeza por IDADE dos logs $$-escopados antes de qualquer tentativa", () => {
    assert.match(
      source,
      /find\s+"\$\{TMPDIR:-\/tmp\}"\s+-maxdepth\s+1\s+-type\s+f[\s\S]*-mtime\s+"\+\$\{STDERR_LOG_MAX_AGE_DAYS/,
      "não encontrei uma rotina de limpeza por idade (find ... -mtime ... -delete) — sem " +
        "ela, o job do contínuo (~30min de cadência) acumula claude-openrouter-*.log em " +
        "/tmp indefinidamente sempre que a cadeia falha inteira.",
    );
  });

  it("a limpeza cobre os 3 padrões $$-escopados (stderr, attempt, attempt-stderr)", () => {
    for (const pattern of [
      "claude-openrouter-stderr.*.log",
      "claude-openrouter-attempt.*.log",
      "claude-openrouter-attempt-stderr.*.log",
    ]) {
      assert.ok(
        source.includes(`-name '${pattern}'`),
        `padrão de rotação não cobre ${pattern}`,
      );
    }
  });

  it("NÃO tenta rotacionar claude-openrouter-last-failure.log (path estável, sobrescrito por design)", () => {
    const findBlockStart = source.indexOf("STDERR_LOG_MAX_AGE_DAYS=");
    const findBlockEnd = source.indexOf("-delete", findBlockStart);
    assert.ok(findBlockStart > -1 && findBlockEnd > findBlockStart, "bloco de rotação não encontrado");
    const block = source.slice(findBlockStart, findBlockEnd);
    assert.ok(
      !block.includes("last-failure"),
      "o path estável last-failure.log é sobrescrito a cada falha (#6666 item 1) — não " +
        "acumula, então não deve entrar no glob de rotação por idade",
    );
  });

  it("a chamada ao find é fail-soft (nunca aborta a delegação sob set -euo pipefail)", () => {
    const findIdx = source.indexOf("STDERR_LOG_MAX_AGE_DAYS=");
    const lineEnd = source.indexOf("\n", source.indexOf("-delete", findIdx));
    const line = source.slice(source.lastIndexOf("\n", source.indexOf("-delete", findIdx)), lineEnd);
    assert.match(
      line,
      /\|\|\s*true/,
      "a rotina de limpeza precisa de um `|| true`/fallback — sob set -e, uma falha do " +
        "`find` (permissão, /tmp montado read-only) abortaria a delegação inteira por " +
        "causa de higiene de log",
    );
  });
});

describe("claude-openrouter.sh — item 2: redação de segredo antes de persistir (#6965, P1)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("existe uma função de redação de segredos", () => {
    assert.match(
      source,
      /redact_secrets_in_file\s*\(\)\s*\{/,
      "função redact_secrets_in_file não encontrada",
    );
  });

  it("a função redige o valor literal de $KEY", () => {
    const fnStart = source.indexOf("redact_secrets_in_file() {");
    const fnEnd = source.indexOf("\n}", fnStart);
    assert.ok(fnStart > -1 && fnEnd > fnStart, "corpo da função não encontrado");
    const body = source.slice(fnStart, fnEnd);
    assert.match(body, /\$KEY/, "a função não referencia $KEY — não redige o segredo real desta invocação");
    assert.match(body, /REDACTED_OPENROUTER_KEY/, "a função não usa um marcador de redação reconhecível");
  });

  it("a função também redige qualquer sk-or-* como rede de segurança (chave diferente da usada nesta tentativa)", () => {
    const fnStart = source.indexOf("redact_secrets_in_file() {");
    const fnEnd = source.indexOf("\n}", fnStart);
    const body = source.slice(fnStart, fnEnd);
    assert.match(
      body,
      /sk-or-\[A-Za-z0-9_-\]/,
      "a função não tem um padrão genérico sk-or-* — não cobre uma chave DIFERENTE da " +
        "usada nesta tentativa (rotação concorrente, texto ecoado de outra invocação)",
    );
  });

  it("a redação roda ANTES do append ao STDERR_LOG persistido (não depois)", () => {
    const redactIdx = source.indexOf('redact_secrets_in_file "$ATTEMPT_LOG"');
    const persistIdx = source.indexOf('cat "$ATTEMPT_LOG" >> "$STDERR_LOG"');
    assert.ok(redactIdx > -1 && persistIdx > -1, "chamada de redação ou persistência não encontrada");
    assert.ok(
      redactIdx < persistIdx,
      "redact_secrets_in_file precisa rodar ANTES de `cat \"$ATTEMPT_LOG\" >> \"$STDERR_LOG\"` " +
        "— senão o conteúdo não-redigido já foi persistido no log cru antes da limpeza",
    );
  });

  it("a redação roda ANTES da cópia pro path ESTÁVEL last-failure.log", () => {
    const redactIdx = source.indexOf('redact_secrets_in_file "$ATTEMPT_LOG"');
    const cpLastFailureIdx = source.indexOf(
      'cp -f "$ATTEMPT_LOG" "${TMPDIR:-/tmp}/claude-openrouter-last-failure.log"',
    );
    assert.ok(redactIdx > -1 && cpLastFailureIdx > -1, "chamada de redação ou cp last-failure não encontrada");
    assert.ok(
      redactIdx < cpLastFailureIdx,
      "a chave precisa estar redigida ANTES da cópia pro path ESTÁVEL e PREVISÍVEL " +
        "last-failure.log — é justamente o path mais fácil de encontrar depois",
    );
  });

  it("a redação de STDERR_ONLY_LOG é fail-soft (sed com fallback, nunca aborta sob set -e)", () => {
    const fnStart = source.indexOf("redact_secrets_in_file() {");
    const fnEnd = source.indexOf("\n}", fnStart);
    const body = source.slice(fnStart, fnEnd);
    const sedLines = body.split("\n").filter((l) => l.includes("sed -i"));
    assert.ok(sedLines.length > 0, "nenhuma linha sed -i encontrada na função de redação");
    for (const line of sedLines) {
      assert.match(
        line,
        /\|\|\s*true/,
        `linha de redação sem fallback: ${line} — falha do sed (disco cheio, leitor ` +
          "concorrente) não pode abortar a cadeia por causa de higiene de log",
      );
    }
  });
});

describe("claude-openrouter.sh — item 3: bytes de stdout/stderr no diagnóstico (#6965, P3)", () => {
  const source = readFileSync(WRAPPER_PATH, "utf8");

  it("computa BYTES_STDOUT a partir de $OUT", () => {
    assert.match(
      source,
      /BYTES_STDOUT=\$\(printf '%s' "\$OUT" \| wc -c\)/,
      "não encontrei o cálculo de BYTES_STDOUT",
    );
  });

  it("computa BYTES_STDERR a partir do snapshot puro de stderr (STDERR_ONLY_LOG), com fallback", () => {
    assert.match(
      source,
      /BYTES_STDERR=\$\(wc -c < "\$STDERR_ONLY_LOG" 2>\/dev\/null \|\| echo 0\)/,
      "não encontrei o cálculo de BYTES_STDERR com fallback — sem `|| echo 0`, um " +
        "STDERR_ONLY_LOG ausente abortaria a linha de diagnóstico sob set -e",
    );
  });

  it("as 3 linhas de diagnóstico (stderr do terminal, STDERR_LOG persistido, ATTEMPT_LOG antes do last-failure) incluem bytes_stdout e bytes_stderr", () => {
    const diagLines = [...source.matchAll(/diagnóstico model=\$MODEL rc=\$RC duracao_s=\$ATTEMPT_DURATION_S[^"]*/g)].map(
      (m) => m[0],
    );
    assert.ok(diagLines.length >= 3, `esperava >=3 linhas de diagnóstico, achei ${diagLines.length}`);
    for (const line of diagLines) {
      assert.match(
        line,
        /bytes_stdout=\$BYTES_STDOUT bytes_stderr=\$BYTES_STDERR/,
        `linha de diagnóstico sem bytes: ${line}`,
      );
    }
  });

  it("os bytes são computados ANTES de qualquer linha de diagnóstico os referenciar", () => {
    const bytesIdx = source.indexOf("BYTES_STDOUT=$(printf");
    const firstDiagIdx = source.indexOf("diagnóstico model=$MODEL");
    assert.ok(bytesIdx > -1 && firstDiagIdx > -1, "cálculo de bytes ou linha de diagnóstico não encontrados");
    assert.ok(
      bytesIdx < firstDiagIdx,
      "BYTES_STDOUT/BYTES_STDERR precisam ser computados ANTES da primeira linha de " +
        "diagnóstico que os referencia — senão a variável está vazia quando impressa",
    );
  });
});
