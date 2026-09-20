/**
 * test/test-runner-import-guard.test.ts (#7807)
 *
 * Guard estático: todo arquivo de teste deste repo usa `node:test`, nunca
 * outro runner, e importa os símbolos que usa.
 *
 * ## Por que existe
 *
 * Três ocorrências medidas do mesmo erro, todas em arquivo de teste
 * RECÉM-CRIADO, todas virando PR vermelha que ocupa a fila até alguém
 * diagnosticar à mão:
 *
 * 1. `test/lib/kit-subscriber-state-transition-alarm.test.ts` (#7660) — a 1ª
 *    versão importava de `vitest`; o próprio topo daquele arquivo documenta o
 *    episódio.
 * 2. PR #7783 (#7746) — `test/lib/continuo-pr-cap.test.ts` com
 *    `import { describe, it, expect } from "vitest"`. Derrubou 3 checks de
 *    uma vez: `knip` (unlisted dependency), `Typecheck ratchet` (TS2307) e
 *    `test`.
 * 3. PR #7771 (#7765) — `test/clarice-novos-html-state-4347.test.ts` com
 *    TS2304/TS2582 (`Cannot find name 'describe'`): faltava o import de
 *    `node:test`.
 *
 * Não é distração pontual, é armadilha de ambiente: o modelo mental default
 * de "teste em TypeScript" é o do vitest/jest, e `test/lib/` é diretório novo
 * com poucos vizinhos por perto pra copiar o padrão certo.
 *
 * O custo assimétrico é o que justifica o guard: escrever o import errado
 * leva segundos, descobrir por que a CI ficou vermelha leva uma rodada de
 * diagnóstico — e enquanto isso a PR fica na fila (foi o achado do #7807,
 * 8 de 8 PRs abertas vermelhas, nenhuma esperando merger).
 *
 * ## #8526 — camada rápida movida pra ANTES de `gh pr create`
 *
 * Este teste continua como rede de CI (a suíte inteira roda de qualquer
 * forma antes do merge), mas a lógica de detecção em si foi extraída para
 * `scripts/lib/test-runner-import-guard.ts` e é reusada por
 * `.claude/hooks/block-pr-create-test-runner-import.mjs`, que bloqueia
 * `gh pr create` em segundos em vez de esperar ~6min de CI. Ver
 * `test/block-pr-create-test-runner-import.test.ts` para o hook.
 *
 * ## Escopo deliberado
 *
 * Só olha `test/**\/*.test.ts`. Não valida ordem de import, não exige
 * `assert`, não opina sobre estilo — apenas as duas condições cuja violação
 * quebra o CI de forma mecânica e diagnosticável.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listarArquivosDeTeste, checkTestRunnerImports } from "../scripts/lib/test-runner-import-guard.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "test");

describe("guard: todo teste usa node:test como runner (#7807)", () => {
  const arquivos = listarArquivosDeTeste(TEST_DIR);
  const resultado = checkTestRunnerImports(TEST_DIR, ROOT);

  it("descobriu arquivos de teste — se falhar, o parser quebrou antes do guard valer", () => {
    assert.ok(arquivos.length > 100, `esperava centenas de testes, achei ${arquivos.length}`);
  });

  it("nenhum arquivo de teste importa runner que não seja node:test", () => {
    assert.deepEqual(
      resultado.runnerProibido,
      [],
      `arquivo(s) de teste importando runner proibido: ${resultado.runnerProibido.join(", ")} — ` +
        `este repo roda node:test (ver scripts/run-tests.ts). Troque por ` +
        `import { describe, it } from "node:test" + import assert from "node:assert/strict".`,
    );
  });

  it("todo arquivo que usa describe()/it() importa esses símbolos de node:test", () => {
    assert.deepEqual(
      resultado.importAusenteNodeTest,
      [],
      `arquivo(s) usando describe()/it() sem importar de node:test: ${resultado.importAusenteNodeTest.join(", ")} — ` +
        `é o TS2304/TS2582 que derrubou a PR #7771. Adicione ` +
        `import { describe, it } from "node:test".`,
    );
  });
});
