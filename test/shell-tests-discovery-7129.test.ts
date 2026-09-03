/**
 * test/shell-tests-discovery-7129.test.ts (#7129 item c)
 *
 * Fecha o outro lado de `scripts/run-shell-tests.ts`: garante que o runner
 * ENXERGA os testes que existem, para que "0 encontrados" nunca passe como
 * sucesso silencioso.
 *
 * O defeito de origem era esse, um nível acima: `scripts/run-tests.ts` varre
 * `*.test.ts`, nenhum step de CI chamava os `*.test.sh`, e ninguém percebeu
 * porque a ausência de execução não produz saída. Um runner que varre disco
 * corrige o esquecimento humano de atualizar lista — mas se a própria varredura
 * quebrar (padrão errado, `SKIP_DIRS` engolindo demais, `readdirSync`
 * falhando), ela volta a "não roda nada" com exit 0. Este teste é o guard
 * disso.
 *
 * Também trava a regra que garante que o runner seja invocado: um step de CI
 * precisa existir chamando-o. Runner sem chamador é a mesma classe de defeito
 * que ele veio consertar — e é exatamente o que o #7299 achou em outro guard
 * ("existia só em disco: nada chamava").
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { discoverShellTests } from "../scripts/run-shell-tests.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("#7129 — descoberta dos *.test.sh", () => {
  const found = discoverShellTests(REPO_ROOT);

  it("acha os testes de shell que existem no repo", () => {
    // Piso, não igualdade: adicionar um `*.test.sh` novo não deve quebrar o
    // guard (o runner o pega sozinho — é o ponto do desenho). O que o piso
    // impede é o cenário real de falha: varredura devolvendo vazio e o CI
    // passando verde sem executar nada.
    assert.ok(
      found.length >= 10,
      `esperava >=10 arquivos *.test.sh, achei ${found.length} — se a queda foi deliberada, ajuste o piso junto`,
    );
  });

  it("cobre os três diretórios onde eles vivem hoje", () => {
    // A varredura precisa alcançar `hermes/` e `scripts/lib/`, não só `test/`
    // — o inventário original da issue só enxergava `test/` e por isso contava
    // 5 quando existem 12.
    for (const prefixo of ["test/", "hermes/scripts/", "scripts/lib/"]) {
      assert.ok(
        found.some((f) => f.startsWith(prefixo)),
        `nenhum *.test.sh descoberto sob ${prefixo} — SKIP_DIRS ou o padrão de nome regrediu`,
      );
    }
  });

  it("não devolve caminho fora do repo nem duplicata", () => {
    assert.deepEqual([...new Set(found)], found, "caminho duplicado — varredura visitou o mesmo diretório 2x");
    for (const f of found) {
      assert.ok(!f.startsWith(".."), `caminho escapa do repo: ${f}`);
      assert.ok(!f.includes("node_modules"), `node_modules não deve ser varrido: ${f}`);
      assert.ok(!f.includes(".claude/worktrees"), `worktree de agente traria cópia do próprio repo: ${f}`);
    }
  });

  it("ignora arquivo que só PARECE teste de shell", () => {
    // `foo.sh` e `test.sh` não são `*.test.sh`; casar demais faria o CI rodar
    // script de produção como se fosse teste.
    for (const f of found) assert.match(f, /\.test\.sh$/);
  });

  it("existe um step de CI que de fato chama o runner (runner sem chamador = o defeito de novo)", () => {
    const workflows = ["pr-checks.yml", "ci.yml"]
      .map((n) => {
        try {
          return readFileSync(join(REPO_ROOT, ".github", "workflows", n), "utf8");
        } catch {
          return "";
        }
      })
      .join("\n");
    // Casa a INVOCAÇÃO (`run:`), não qualquer menção. A 1ª versão deste
    // guard usava /run-shell-tests\.ts/ solto e passava mesmo com o comando
    // trocado — porque o `name:` do step cita o script e satisfazia o regex.
    // Descoberto testando o próprio guard contra um workflow adulterado: ele
    // não reprovou. Guard que não discrimina é o defeito que este arquivo
    // existe pra impedir, um nível acima.
    assert.match(
      workflows,
      /^\s*run:.*run-shell-tests\.ts/m,
      "nenhum workflow INVOCA scripts/run-shell-tests.ts num `run:` — sem isso os *.test.sh voltam a não rodar, que é o #7129 inteiro",
    );
  });
});
