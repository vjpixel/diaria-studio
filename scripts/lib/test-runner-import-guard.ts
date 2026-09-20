/**
 * scripts/lib/test-runner-import-guard.ts (#8526)
 *
 * Lógica PURA de detecção extraída de `test/test-runner-import-guard.test.ts`
 * (#7807) — reusada tanto pelo teste original (rede de CI) quanto pelo hook
 * `.claude/hooks/block-pr-create-test-runner-import.mjs` (camada rápida,
 * pre-`gh pr create`).
 *
 * ## Por que a extração (#8526)
 *
 * O guard do #7807 só disparava DEPOIS de `gh pr create` — a suíte inteira
 * (~6min) rodava na CI antes do veredito, a PR já estava aberta ocupando
 * fila e disparando review automatizado, e o diagnóstico ainda exigia abrir
 * o log da CI. O guard converteu "falha misteriosa" em "falha nomeada", mas
 * não evitou nenhum dos custos que a própria issue #7807 listava como
 * justificativa. #8526 move a detecção pra ANTES de `gh pr create`, no mesmo
 * ponto de extensão de `block-pr-create-tsc-failure.mjs` (#8482).
 *
 * ## Escopo (idêntico ao guard original)
 *
 * Só olha `test/**\/*.test.ts`. Não valida ordem de import, não exige
 * `assert`, não opina sobre estilo — apenas as duas condições cuja violação
 * quebra o CI de forma mecânica e diagnosticável: runner proibido
 * (`vitest`/`jest`/etc.) e uso de `describe`/`it` sem importar de
 * `node:test`.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Runners que este repo NÃO usa. Importar qualquer um deles é erro de
 *  ambiente, não escolha — `node:test` é o runner único (ver `npm test` →
 *  `scripts/run-tests.ts`). */
export const RUNNERS_PROIBIDOS = ["vitest", "jest", "@jest/globals", "mocha", "ava"];

/** Lista recursivamente todo `*.test.ts` sob `dir`. */
export function listarArquivosDeTeste(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listarArquivosDeTeste(full, acc);
    } else if (entry.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Escapa metacaracteres de regex — `@jest/globals` tem `/`, e um `.` num
 * nome futuro casaria qualquer caractere.
 */
export function escaparRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/**
 * Filtra linhas de código real (exclui comentário de linha/bloco) — ancorado
 * em posição de statement, nunca via regex que "come" comentários do
 * arquivo inteiro (esse modo de falha, descoberto no review da PR #7808,
 * criava um falso NEGATIVO ao redor de um `/*` dentro de string).
 */
export function linhasDeCodigo(src: string): string[] {
  return src.split("\n").filter((l) => {
    const t = l.trimStart();
    return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
  });
}

/**
 * Devolve os arquivos (path relativo a `baseDir`, formatado
 * `{arquivo} → {runner}`) que importam um runner de `RUNNERS_PROIBIDOS` em
 * posição de statement (`import ... from "runner"` ou `require("runner")`).
 */
export function detectarRunnerProibido(arquivos: string[], baseDir: string): string[] {
  const infratores: string[] = [];
  for (const arquivo of arquivos) {
    const linhas = linhasDeCodigo(readFileSync(arquivo, "utf8"));
    for (const runner of RUNNERS_PROIBIDOS) {
      const alvo = escaparRegex(runner);
      const re = new RegExp(
        `^\\s*import\\b[^;]*from\\s*["']${alvo}["']|require\\(\\s*["']${alvo}["']`,
      );
      if (linhas.some((l) => re.test(l))) {
        infratores.push(`${relative(baseDir, arquivo)} → ${runner}`);
      }
    }
  }
  return infratores;
}

/**
 * Devolve os arquivos (path relativo a `baseDir`) que usam `describe()`/
 * `it()` sem importar esses símbolos de `node:test` (estático ou dinâmico).
 */
export function detectarImportAusenteNodeTest(arquivos: string[], baseDir: string): string[] {
  const infratores: string[] = [];
  for (const arquivo of arquivos) {
    const src = readFileSync(arquivo, "utf8");
    const importaDoNodeTest =
      /from\s*["']node:test["']/.test(src) || /import\(\s*["']node:test["']/.test(src);
    if (importaDoNodeTest) continue;
    const usa = linhasDeCodigo(src).some((l) => /^\s*(describe|it)\s*\(/.test(l));
    if (usa) infratores.push(relative(baseDir, arquivo));
  }
  return infratores;
}

export type TestRunnerImportGuardResult = {
  runnerProibido: string[];
  importAusenteNodeTest: string[];
};

/**
 * Checagem completa: varre `testDir` e devolve as duas listas de infratores.
 * `ok` (sem violações) quando ambas estão vazias.
 */
export function checkTestRunnerImports(testDir: string, baseDir: string): TestRunnerImportGuardResult {
  const arquivos = listarArquivosDeTeste(testDir);
  return {
    runnerProibido: detectarRunnerProibido(arquivos, baseDir),
    importAusenteNodeTest: detectarImportAusenteNodeTest(arquivos, baseDir),
  };
}
