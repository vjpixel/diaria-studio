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
 * ## Escopo deliberado
 *
 * Só olha `test/**\/*.test.ts`. Não valida ordem de import, não exige
 * `assert`, não opina sobre estilo — apenas as duas condições cuja violação
 * quebra o CI de forma mecânica e diagnosticável.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIR = join(ROOT, "test");

/** Runners que este repo NÃO usa. Importar qualquer um deles é erro de
 *  ambiente, não escolha — `node:test` é o runner único (ver `npm test` →
 *  `scripts/run-tests.ts`). */
const RUNNERS_PROIBIDOS = ["vitest", "jest", "@jest/globals", "mocha", "ava"];

function listarTestes(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listarTestes(full, acc);
    } else if (entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/** Remove comentários de bloco e de linha antes de procurar uso de símbolo —
 *  senão a própria docstring deste arquivo (que CITA `describe(`) contaria
 *  como uso. */
function semComentarios(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

describe("guard: todo teste usa node:test como runner (#7807)", () => {
  const arquivos = listarTestes(TEST_DIR);

  it("descobriu arquivos de teste — se falhar, o parser quebrou antes do guard valer", () => {
    assert.ok(arquivos.length > 100, `esperava centenas de testes, achei ${arquivos.length}`);
  });

  it("nenhum arquivo de teste importa runner que não seja node:test", () => {
    const infratores: string[] = [];
    for (const arquivo of arquivos) {
      const src = semComentarios(readFileSync(arquivo, "utf8"));
      for (const runner of RUNNERS_PROIBIDOS) {
        const re = new RegExp(`from\\s+["']${runner.replace("/", "\\/")}["']`);
        if (re.test(src)) infratores.push(`${relative(ROOT, arquivo)} → ${runner}`);
      }
    }
    assert.deepEqual(
      infratores,
      [],
      `arquivo(s) de teste importando runner proibido: ${infratores.join(", ")} — ` +
        `este repo roda node:test (ver scripts/run-tests.ts). Troque por ` +
        `import { describe, it } from "node:test" + import assert from "node:assert/strict".`,
    );
  });

  it("todo arquivo que usa describe()/it() importa esses símbolos de node:test", () => {
    const infratores: string[] = [];
    for (const arquivo of arquivos) {
      const src = semComentarios(readFileSync(arquivo, "utf8"));
      const usa = /\b(describe|it)\s*\(/.test(src);
      if (!usa) continue;
      const importaDoNodeTest = /from\s+["']node:test["']/.test(src);
      if (!importaDoNodeTest) infratores.push(relative(ROOT, arquivo));
    }
    assert.deepEqual(
      infratores,
      [],
      `arquivo(s) usando describe()/it() sem importar de node:test: ${infratores.join(", ")} — ` +
        `é o TS2304/TS2582 que derrubou a PR #7771. Adicione ` +
        `import { describe, it } from "node:test".`,
    );
  });
});
