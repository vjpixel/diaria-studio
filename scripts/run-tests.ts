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
 *
 * ## Retry de `ERR_MODULE_NOT_FOUND` (#6495)
 *
 * A mitigação acima (descoberta explícita, síncrona, ANTES de qualquer
 * processo filho) não eliminou o flake — reincidiu 2× DEPOIS de estar em
 * vigor (PR #6480 antes dela existir; PR #6782, `test/track-quality-
 * report.test.ts`, DEPOIS, no head sha que já tinha `run-tests.ts`). A
 * investigação ao vivo (#6495, comentário 260830) descartou a hipótese que
 * motivou a mitigação original (descoberta assíncrona do `node --test`
 * nativo) — o arquivo é encontrado pelo processo PAI (senão não seria
 * passado como argumento) e falha no `import()` do processo FILHO. Restou
 * um padrão: as únicas 2 ocorrências reais foram sempre em arquivo de teste
 * NOVO, adicionado pelo próprio PR — hipótese líder é um glitch de
 * filesystem do runner em torno de um arquivo recém-materializado pelo
 * `actions/checkout`, não confirmável sem instrumentação adicional na CI.
 *
 * Enquanto a causa raiz exata não é isolada, este wrapper aplica a
 * mitigação PRAGMÁTICA autorizada pela própria issue: é um erro de
 * INFRAESTRUTURA do runner, não um teste real falhando (o sumário do
 * `node:test` mostra `fail 0` — nenhuma asserção quebrou, só o `import()`
 * de um arquivo que existe) — então um retry automático do batch específico
 * é seguro (não mascara falha de teste real, porque só dispara quando o
 * `node:test` confirma zero falhas E a assinatura do erro bate). Critério
 * de `shouldRetryBatch` — os TRÊS precisam ser verdadeiros:
 *   1. o batch falhou (`status !== 0`);
 *   2. o stdout/stderr combinado contém `ERR_MODULE_NOT_FOUND`;
 *   3. o sumário final do `node:test` (reporter `spec`, prefixo `ℹ` — local/
 *      TTY; ou `tap`, prefixo `#` — CI/sem TTY) reporta `fail 0`.
 * Só UM retry por batch — se o 2º run falhar de novo, o batch conta como
 * falha definitiva (nunca mascarar um flake persistente/real como
 * "infraestrutura" indefinidamente).
 *
 * Efeito colateral necessário: `stdio` deixou de ser `"inherit"` e passou a
 * ser capturado (`"pipe"`) — só assim dá pra inspecionar o output ANTES de
 * decidir se retry. Pra não perder a visibilidade de progresso do `npm test`
 * (útil localmente e no log da CI), o buffer capturado é escrito em
 * `process.stdout`/`process.stderr` logo após cada batch terminar — a
 * saída para de ser char-a-char em tempo real e passa a ser por BATCH
 * (ainda long antes do fim de todos os batches, só não intercalada dentro
 * de um único batch), troca aceitável pelo ganho de poder decidir o retry.
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
  /** Injeção de saída pra teste — default `process.stdout`/`process.stderr`. */
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
}

/** Casa a assinatura de erro do #6495 — nunca uma falha de teste real, é o
 *  `import()` do processo filho do `node --test` falhando pra um arquivo
 *  que o processo PAI já confirmou existir (foi ele quem enumerou e passou
 *  como argumento). */
const ERR_MODULE_NOT_FOUND_RE = /ERR_MODULE_NOT_FOUND/;

/** Casa a linha de sumário final do `node:test` — reporter `spec` (local,
 *  TTY) usa prefixo `ℹ`; reporter `tap` (CI, sem TTY) usa `#`. Pega a
 *  ÚLTIMA ocorrência de `fail N` ancorada em início/fim de linha — nunca a
 *  palavra "fail" solta no NOME de um teste individual. */
const FAIL_SUMMARY_RE = /^(?:ℹ|#)\s*fail\s+(\d+)\s*$/gim;

/** Pure: extrai a contagem `fail N` do sumário final do `node:test` no
 *  output combinado de um batch. `null` quando nenhum sumário reconhecível
 *  é encontrado (formato de reporter inesperado — trata como "não sei",
 *  nunca como fail 0). */
export function parseFailCount(output: string): number | null {
  FAIL_SUMMARY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: number | null = null;
  while ((match = FAIL_SUMMARY_RE.exec(output)) !== null) {
    last = Number(match[1]);
  }
  return last;
}

/** Pure: decide se um batch que falhou merece 1 retry — os TRÊS critérios
 *  do #6495 precisam ser verdadeiros (ver docstring do módulo): status !=
 *  0, assinatura `ERR_MODULE_NOT_FOUND` presente, e sumário do `node:test`
 *  confirmando `fail 0` (nenhuma falha de teste real, só o erro de
 *  infraestrutura do runner). */
export function shouldRetryBatch(output: string, status: number | null): boolean {
  if ((status ?? 1) === 0) return false;
  if (!ERR_MODULE_NOT_FOUND_RE.test(output)) return false;
  return parseFailCount(output) === 0;
}

/** Roda `node --import tsx --test <batch...>` em batches sequenciais.
 *  Retorna o exit code agregado (0 só se TODOS os batches saírem 0). */
export function runTestBatches(opts: RunTestsOptions): number {
  const {
    files,
    extraArgs = [],
    batchSize = BATCH_SIZE,
    spawn = spawnSync,
    stdout = process.stdout,
    stderr = process.stderr,
  } = opts;
  if (files.length === 0) {
    // Sem arquivos: deixa o guard `assert-test-discovery.ts` (pretest) ser
    // quem falha alto nesse caso — este wrapper não duplica esse julgamento.
    return 0;
  }
  const batches = chunk(files, batchSize);
  let exitCode = 0;

  const runOne = (batch: string[]) =>
    spawn(process.execPath, ["--import", "tsx", "--test", ...extraArgs, ...batch], {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "pipe"],
      // Review #6807 (P1, confiança alta): sem isto, o default de 1 MB do
      // Node estoura fácil com BATCH_SIZE=150 e 200+ console.log já na
      // suíte — o spawn falha com result.error ANTES do retry (#6495) ter
      // chance de rodar, transformando um batch 100% verde num falso
      // "falha ao spawnar". maxBuffer generoso (não Infinity — string de
      // tamanho ilimitado ainda pode estourar heap em runner com pouca
      // RAM); 256 MB é folga larga sobre qualquer batch observado até hoje.
      maxBuffer: 256 * 1024 * 1024,
    });

  /** `spawn` está tipado como `typeof spawnSync` (assinatura genérica) —
   *  na prática, com `encoding: "utf8"` sempre passado em `runOne`, o
   *  runtime devolve `string`, mas o TS não estreita o overload através da
   *  variável injetada. `String(...)` normaliza sem custo (já é string em
   *  produção; só formaliza o tipo). */
  const toText = (v: string | Buffer | null | undefined): string => (v ? String(v) : "");

  const emit = (result: ReturnType<typeof spawnSync>) => {
    const out = toText(result.stdout);
    const err = toText(result.stderr);
    if (out) stdout.write(out);
    if (err) stderr.write(err);
  };

  for (const batch of batches) {
    let result = runOne(batch);
    if (result.error) {
      console.error(`run-tests: falha ao spawnar batch (${batch.length} arquivos): ${result.error.message}`);
      exitCode = 1;
      continue;
    }
    emit(result);

    if ((result.status ?? 1) !== 0) {
      const combined = `${toText(result.stdout)}\n${toText(result.stderr)}`;
      if (shouldRetryBatch(combined, result.status)) {
        stderr.write(
          `\nrun-tests: batch com ERR_MODULE_NOT_FOUND e fail 0 (#6495, erro de infra do runner, não de teste) — retentando UMA vez (${batch.length} arquivos)...\n`,
        );
        const retry = runOne(batch);
        if (retry.error) {
          console.error(
            `run-tests: falha ao spawnar retry do batch (${batch.length} arquivos): ${retry.error.message}`,
          );
          exitCode = 1;
          continue;
        }
        emit(retry);
        result = retry;
      }
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
