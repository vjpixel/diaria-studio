/**
 * test/hermes-command-grep-guard-6987.test.ts (#6987, duplicata #6989)
 *
 * Neste ambiente `grep` NÃO é o binário do sistema — é uma função de shell
 * que shella pro binário `claude` (`type grep` mostra a função; reproduzido
 * AO VIVO ao escrever este teste, ver 1º describe abaixo). Quando o binário
 * `claude` quebra, todo `grep` da sessão falha junto — inclusive dentro de
 * scripts/pipelines/loops de espera sem nada a ver com o Claude Code. Um
 * `grep -q` cujo resultado decide um `if`/`elif` de controle de fluxo não
 * distingue "ferramenta quebrada" de "padrão não encontrado" (os dois saem
 * não-zero) — um laço de espera de CI que lê isso como "nada pendente"
 * anuncia CI fechado com job ainda rodando; um classificador de erro do
 * `claude-openrouter.sh` que lê isso como "sem sinal" cai no ramo errado.
 *
 * `command grep` bypassa a função de shell e vai direto ao binário do
 * sistema, imune à quebra. Este arquivo trava os 4 call sites decisórios
 * corrigidos pela #6987/#6989 em `hermes/scripts/*.sh` — nenhum `grep`
 * cujo resultado alimenta um `if`/`elif`/`case` de controle de fluxo pode
 * regressar pra sem o `command`.
 *
 * Teste de parsing estático (não executa o CLI nem depende de rede) — mesma
 * técnica de test/hermes-openrouter-evidence-capture.test.ts — exceto o
 * describe de reprodução ao vivo, que só confirma o MECANISMO (não decide
 * pass/fail do resto da suíte por ele).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function readSource(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

describe("reprodução do mecanismo (#6987) — `grep` é função de shell shellando pro binário claude neste ambiente", () => {
  it("`type grep` (via bash -lc, mesmo shell de login usado pelos scripts) NÃO é o binário do sistema", () => {
    // Roda um `bash -lc` isolado (não herda funções deste processo Node) pra
    // confirmar que a função é definida pelo PRÓPRIO shell de login do
    // ambiente, não algo específico desta sessão de teste — é essa a
    // camada que os scripts de hermes/scripts/*.sh atravessam quando rodam
    // via cron/systemd com um shell de login.
    let typeOutput = "";
    try {
      typeOutput = execSync("bash -lc 'type grep'", { encoding: "utf8" });
    } catch {
      // `type` sai não-zero se grep não existir de nenhuma forma — nesse
      // caso o teste é inconclusivo sobre O MECANISMO específico desta
      // issue (função vs binário quebrado), mas não é uma falha do fix:
      // só pula a asserção de reprodução, sem afetar os testes estáticos
      // abaixo (que são a garantia real de regressão).
      return;
    }
    if (!typeOutput.includes("is a function")) {
      // Ambiente sem a função grep→claude (ex: CI sem o wrapper de shell
      // integration instalado) — mecanismo não reproduzível aqui, mas os
      // testes estáticos abaixo continuam cobrindo a regressão do código.
      return;
    }
    assert.match(
      typeOutput,
      /grep is a function/,
      "esperava confirmar que `grep` é função neste ambiente antes de testar o workaround",
    );
  });

  it("`command grep` sempre resolve pro binário do sistema, independente da função estar definida", () => {
    // Não depende do binário `claude` estar quebrado ou são — `command`
    // bypassa QUALQUER função/alias com o mesmo nome, sempre.
    const out = execFileSync("bash", ["-lc", "printf 'agulha\\npalheiro\\n' | command grep -q agulha && echo OK"], {
      encoding: "utf8",
    });
    assert.equal(out.trim(), "OK", "`command grep` não encontrou um padrão presente — workaround não funciona");
  });
});

describe("hermes/scripts/claude-openrouter.sh — 5 grep decisórios usam `command grep` (#6987/#6989)", () => {
  const source = readSource("hermes/scripts/claude-openrouter.sh");

  it("model_in_openrouter_catalog: `command grep -qF` (decide exit 4 vs retry transitório)", () => {
    assert.match(
      source,
      /if printf '%s' "\$catalog" \| command grep -qF "\\"id\\":\\"\$model\\""; then/,
      "model_in_openrouter_catalog não usa `command grep` — se `grep` quebrar aqui, um " +
        "modelo VÁLIDO é classificado como AUSENTE do catálogo, promovendo uma falha de " +
        "ferramenta a exit 4 (config permanente, correção manual pedida por engano)",
    );
  });

  it("classificador de config-inválida ('model not found'): `command grep -qiE`", () => {
    assert.match(
      source,
      /elif command grep -qiE "model not found\|invalid model\|not a valid model\|no endpoints found\|no allowed providers" "\$STDERR_ONLY_LOG"; then/,
      "classificador de config-inválida não usa `command grep`",
    );
  });

  it("classificador de rate-limit/quota: `command grep -qiE`", () => {
    assert.match(
      source,
      /elif command grep -qiE "rate\.\?limit\|too many requests\|quota exceeded/,
      "classificador de rate-limit não usa `command grep`",
    );
  });

  it("classificador de budget-exceeded: `command grep -qE`", () => {
    assert.match(
      source,
      /elif command grep -qE "Exceeded USD budget" "\$ATTEMPT_LOG"; then/,
      "classificador de budget-exceeded não usa `command grep`",
    );
  });

  it("filtro de ruído do terminal (não-decisório, mas consistente): `command grep -vE`", () => {
    assert.match(
      source,
      /command grep -vE "not a model this version\|unrecognized_model\|connectors are disabled" "\$ATTEMPT_LOG" >&2/,
      "filtro de ruído não usa `command grep`",
    );
  });

  it("nenhuma LINHA DE CÓDIGO (não-comentário) invoca `grep` sem o prefixo `command`", () => {
    // Varre linha a linha, ignorando comentários (linha cujo primeiro token
    // não-espaço é `#`) — o arquivo tem dezenas de menções em prosa a
    // "grep de classificação" etc nos comentários, que não são o alvo desta
    // regressão. Só código executável importa: bloqueia qualquer `grep`
    // novo adicionado no futuro sem o prefixo `command`.
    const codeLines = source
      .split("\n")
      .filter((line) => !/^\s*#/.test(line));
    const bareGrepLines = codeLines.filter((line) => /(?<!command )\bgrep\b/.test(line));
    assert.equal(
      bareGrepLines.length,
      0,
      `encontrei ${bareGrepLines.length} linha(s) de código com \`grep\` sem o prefixo ` +
        `\`command\` em claude-openrouter.sh: ${JSON.stringify(bareGrepLines)} — todo grep ` +
        "neste wrapper roda dentro de um checkout onde o binário `claude` quebra com " +
        "frequência medida (#6875/#6891); qualquer grep novo precisa do prefixo `command` " +
        "(#6987/#6989)",
    );
  });
});

describe("hermes/scripts/opus-daily-diff-review.sh — gate do marcador de resumo usa `command grep` (#6987/#6989)", () => {
  it("`command grep -q` decide se o marco de review avança", () => {
    const source = readSource("hermes/scripts/opus-daily-diff-review.sh");
    assert.match(
      source,
      /if ! command grep -q "RESUMO-DAILY-REVIEW:" "\$OUT_FILE"; then/,
      "o gate do marcador RESUMO-DAILY-REVIEW não usa `command grep` — aqui a direção de " +
        "falha já é segura (grep quebrado => marco NÃO avança), mas o `command` fecha o " +
        "caso mesmo assim, pra não depender de sorte de direção",
    );
  });
});

describe("hermes/scripts/continuo-pr-review.sh — confirmação de merge usa `command grep` (#6987/#6989)", () => {
  it("`command grep -q \"^MERGED\"` decide se um `gh pr merge` com rc!=0 conta como mergeado", () => {
    const source = readSource("hermes/scripts/continuo-pr-review.sh");
    assert.match(
      source,
      /if echo "\$MERGED_STATE" \| command grep -q "\^MERGED"; then/,
      "a confirmação de merge não usa `command grep`",
    );
  });
});

describe("hermes/scripts/watch-continuo-health.sh — dedup de issue usa `command grep` (#6987/#6989)", () => {
  it("`have_issue` usa `command grep -qF` — sem isso, ferramenta quebrada colapsa em 'issue não existe' e cria duplicata", () => {
    const source = readSource("hermes/scripts/watch-continuo-health.sh");
    assert.match(
      source,
      /printf '%s' "\$titles" \| command grep -qF "\$marker"/,
      "have_issue não usa `command grep` — um `grep` quebrado sai não-zero, INDISTINGUÍVEL " +
        "de 'marcador não encontrado' (o rc=1 normal desta chamada), levando file_issue a " +
        "criar uma issue possivelmente duplicada por uma causa que não tem nada a ver com " +
        "o GitHub (#6987/#6989)",
    );
  });
});
