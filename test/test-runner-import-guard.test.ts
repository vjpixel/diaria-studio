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

/**
 * Escapa metacaracteres de regex — `@jest/globals` tem `/`, e um `.` num nome
 * futuro casaria qualquer caractere. (A 1ª versão usava
 * `replace("/", "\\/")`, que escapa só a PRIMEIRA ocorrência — achado P4 do
 * review da PR #7808.)
 */
function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Analisa LINHA A LINHA, em posição de statement, em vez de remover
 * comentários do arquivo inteiro.
 *
 * A 1ª versão fazia `src.replace(/\/\*[\s\S]*?\*\//g, " ")` pra que a própria
 * docstring deste arquivo (que CITA `describe(`) não contasse como uso. O
 * review da PR #7808 mostrou que isso cria um **falso NEGATIVO** — o pior
 * defeito possível num guard, porque some justamente com o que ele existe pra
 * pegar: um template literal contendo uma sequência parecida com `/*`,
 * seguido mais adiante no MESMO arquivo por um JSDoc real, faz a regex comer
 * tudo entre os dois — inclusive um `import ... from "vitest"` legítimo no
 * meio. O revisor reproduziu, e confirmou que o padrão (`/*` dentro de
 * string) já existe em arquivos reais do repo.
 *
 * Ancorar em posição de statement resolve os dois lados de uma vez: linha de
 * comentário começa com `*` ou `//`, e menção dentro de string não começa a
 * linha com `import`. Sem regex de comentário, sem esse modo de falha.
 */
function linhasDeCodigo(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
  });
}

describe("guard: todo teste usa node:test como runner (#7807)", () => {
  const arquivos = listarTestes(TEST_DIR);

  it("descobriu arquivos de teste — se falhar, o parser quebrou antes do guard valer", () => {
    assert.ok(arquivos.length > 100, `esperava centenas de testes, achei ${arquivos.length}`);
  });

  it("nenhum arquivo de teste importa runner que não seja node:test", () => {
    const infratores: string[] = [];
    for (const arquivo of arquivos) {
      const linhas = linhasDeCodigo(readFileSync(arquivo, "utf8"));
      for (const runner of RUNNERS_PROIBIDOS) {
        const alvo = escaparRegex(runner);
        // Só posição de statement: `import ... from "runner"` ou
        // `require("runner")`. Uma STRING que apenas contenha o texto
        // `from "vitest"` (um teste SOBRE este guard, uma fixture de mensagem
        // de erro) deixa de ser acusada — falso positivo P3 do review.
        const re = new RegExp(
          `^\\s*import\\b[^;]*from\\s*["']${alvo}["']|require\\(\\s*["']${alvo}["']`,
        );
        if (linhas.some((l) => re.test(l))) {
          infratores.push(`${relative(ROOT, arquivo)} → ${runner}`);
        }
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
      const src = readFileSync(arquivo, "utf8");
      // `import ... from "node:test"` OU `await import("node:test")` — o
      // dinâmico é uso legítimo do runner certo e era acusado pela 1ª versão
      // (falso positivo P3 do review).
      const importaDoNodeTest =
        /from\s*["']node:test["']/.test(src) || /import\(\s*["']node:test["']/.test(src);
      if (importaDoNodeTest) continue;
      // Uso em posição de statement — linha de docstring (` * describe(`) não
      // conta, e por isso este arquivo não se acusa.
      const usa = linhasDeCodigo(src).some((l) => /^\s*(describe|it)\s*\(/.test(l));
      if (usa) infratores.push(relative(ROOT, arquivo));
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
