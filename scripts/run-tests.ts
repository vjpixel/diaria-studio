/**
 * run-tests.ts (#6495)
 *
 * Wrapper em torno de `node --import tsx --test`. Em vez de deixar o runner
 * nativo descobrir os arquivos de teste sozinho (a chamada `node --import tsx
 * --test`, sem paths, dispara a varredura recursiva assíncrona embutida do
 * Node), este script enumera os arquivos de forma SÍNCRONA e determinística
 * (`listTestFiles`, mesma função usada pelo guard `assert-test-discovery.ts`)
 * e passa a lista já resolvida — caminhos absolutos, ordem estável — como
 * argumentos explícitos.
 *
 * Motivação (#6495): 3/3 falhas consecutivas em CI (Ubuntu/GH Actions, nunca
 * reproduzido localmente — inclusive em Linux com Node 24 idêntico ao da CI)
 * com `Error [ERR_MODULE_NOT_FOUND] ... imported from
 * {cwd-do-projeto}/` apontando pra um arquivo de teste (`test/token-usage-
 * summary.test.ts`, PR #6480) que genuinamente existia no commit testado.
 *
 * Investigação: a hipótese inicial (issue #6495) era um `process.chdir()`
 * concorrente — 3 arquivos do repo usam `process.chdir()` em testes async
 * (`test/git-sync.test.ts`, `test/clarice-2798-observability.test.ts`,
 * `test/pr-create-review-hook.test.ts`) — corrompendo a resolução relativa
 * de OUTRO arquivo de teste rodando na mesma janela. Essa hipótese foi
 * TESTADA E DESCARTADA: reproduzido localmente (Linux, Node 24.19.0, mesma
 * versão da CI) um sandbox com ~60 arquivos de teste concorrentes, um deles
 * fazendo `process.chdir()` para um tmpdir e segurando por 800ms — todos os
 * `process.cwd()` capturados no module-load e no corpo do `test()` de TODOS
 * os arquivos batem com o cwd original do projeto, em qualquer combinação de
 * `--test-concurrency` e `--test-isolation` testada (`process` — o default —
 * e `none`). O default de isolamento por processo (`--test-isolation=process`)
 * já impede esse tipo de vazamento entre arquivos: cada arquivo roda num
 * child process próprio, então `process.chdir()` num deles não é visível
 * para os outros.
 *
 * A causa raiz exata (provavelmente uma condição de corrida no mecanismo de
 * descoberta *assíncrona* embutido do `node --test` — que resolve cada
 * especificador de arquivo descoberto em runtime contra `process.cwd()` no
 * momento da importação, e não num instante fixo e único — combinada com a
 * pressão de I/O mais alta do runner compartilhado do GH Actions, que este
 * repo não conseguiu replicar num ambiente de desenvolvimento com recursos
 * dedicados) **não foi confirmada com certeza determinística**. Isto
 * implementa a mitigação que a própria issue #6495 autoriza como aceitável
 * nesse cenário: eliminar a dependência da descoberta implícita/assíncrona
 * do runner, substituindo por uma lista de arquivos explícita e resolvida de
 * uma vez só, ANTES de qualquer processo de teste subir. Se a causa real for
 * outra (ex.: um glitch de filesystem do runner da CI em torno de um arquivo
 * recém-criado pelo `actions/checkout`), isto não resolve a causa, mas muda
 * o mecanismo de resolução de módulo por completo — o `import()` que falhou
 * na CI resolvia um especificador relativo contra um `parentURL` de
 * diretório (`imported from {cwd}/`); aqui, cada arquivo é um path absoluto
 * já resolvido no processo pai, nunca precisando desse tipo de resolução.
 *
 * NÃO usa argv com todos os ~1400 arquivos numa única invocação de `node
 * --test` — o command-line do Windows (`CreateProcessW`) tem um teto de
 * ~32767 caracteres, e caminhos absolutos * ~1400 arquivos estoura essa
 * margem em máquinas de desenvolvimento (o editor roda localmente no
 * Windows, ver `CLAUDE.md`). Em vez disso, os arquivos são despachados em
 * BATCHES sequenciais de tamanho fixo (`BATCH_SIZE`), cada um bem dentro do
 * limite em qualquer profundidade de path razoável; dentro de cada batch o
 * `node --test` ainda paraleliza normalmente (concorrência default do
 * runner). O exit code final é 1 se qualquer batch falhar; todos os batches
 * rodam até o fim (mesmo após uma falha) para reportar o quadro completo,
 * igual ao comportamento nativo de `node --test` sobre múltiplos arquivos.
 *
 * Args extras de CLI (`npm test -- --test-name-pattern X --update-snapshots`,
 * usado por `test/orchestrator-prompt.test.ts` e `test/ds-golden-*.test.ts`
 * pra regravar goldens) são repassados a TODOS os batches — funciona porque
 * `--test-name-pattern` filtra por nome de teste, não por arquivo, e roda
 * igual em cada invocação.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listTestFiles } from "./assert-test-discovery.ts";
import { isMainModule } from "./lib/cli-args.ts";

/** Batches de 150 arquivos: bem abaixo do teto de ~32767 chars do Windows
 *  mesmo com paths absolutos longos (150 × ~150 chars ≈ 22.500), com folga
 *  suficiente pra não precisar recalibrar a cada arquivo novo no repo. */
export const BATCH_SIZE = 150;

/** Pure: parte uma lista em batches de tamanho `size` (último pode ser menor). */
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error(`chunk: size deve ser > 0, recebeu ${size}`);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export interface RunTestsOptions {
  /** Arquivos de teste já resolvidos (paths absolutos). */
  files: string[];
  /** Args extras repassados a cada invocação de `node --test` (ex: `--test-name-pattern`). */
  extraArgs?: string[];
  /** Tamanho do batch — default `BATCH_SIZE`. */
  batchSize?: number;
  /** Injeção de dependência pra teste — default `child_process.spawnSync`. */
  spawn?: typeof spawnSync;
}

/** Roda `node --import tsx --test <batch...>` em batches sequenciais.
 *  Retorna o exit code agregado (0 só se TODOS os batches saírem 0). */
export function runTestBatches(opts: RunTestsOptions): number {
  const { files, extraArgs = [], batchSize = BATCH_SIZE, spawn = spawnSync } = opts;
  if (files.length === 0) {
    // Sem arquivos: deixa o guard `assert-test-discovery.ts` (pretest) ser
    // quem falha alto nesse caso — este wrapper não duplica esse julgamento.
    return 0;
  }
  const batches = chunk(files, batchSize);
  let exitCode = 0;
  for (const batch of batches) {
    const result = spawn(process.execPath, ["--import", "tsx", "--test", ...extraArgs, ...batch], {
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`run-tests: falha ao spawnar batch (${batch.length} arquivos): ${result.error.message}`);
      exitCode = 1;
      continue;
    }
    if ((result.status ?? 1) !== 0) exitCode = 1;
  }
  return exitCode;
}

// CLI guard (#cli-guard): só roda como main; importável em testes sem disparar.
if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = listTestFiles(root);
  const extraArgs = process.argv.slice(2);
  process.exit(runTestBatches({ files, extraArgs }));
}
