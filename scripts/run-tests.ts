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
 *
 * ## #6822 — hang silencioso vira VERDE FALSO (defeito distinto do #6495)
 *
 * Medido ao vivo 2×: (a) PR #6782, 3/3 tentativas de CI travando ~5-7min em
 * `test/alarm-issues.test.ts` sem `ERR_MODULE_NOT_FOUND` no log — sintoma de
 * hang (promise pendente / chamada sem timeout), não de crash de módulo; (b)
 * PR #6830 (`d559013d`), MESMA assinatura de hang, mas o job `test` saiu
 * `conclusion: success` **apesar de 2 `assert.equal(11, 12)` genuinamente
 * quebrados** em `test/use-melhor-curation.test.ts` — arquivo que nunca
 * chegou a rodar porque o batch morreu antes, e o exit code não-zero desse
 * batch se perdeu no caminho.
 *
 * Duas lacunas concretas, ambas fechadas abaixo:
 *
 * 1. **Nenhum timeout por batch.** `spawnSync` sem `timeout` bloqueia o
 *    processo pai indefinidamente se o `node --test` do batch travar — nada
 *    força o kill, e o único motivo dos hangs observados terem terminado
 *    (~5-7min depois, sem nenhuma linha de log no meio) foi algum mecanismo
 *    fora deste script (provavelmente do próprio runner do GH Actions).
 *    Agora `runOne` passa `timeout: batchTimeoutMs` (default
 *    `DEFAULT_BATCH_TIMEOUT_MS`, generoso vs. a duração normal observada de
 *    um batch — ~40-90s) + `killSignal: "SIGKILL"` (garante que o processo
 *    trave morre de verdade, nunca ignora SIGTERM). Antes de despachar cada
 *    batch, a lista de arquivos candidatos é logada (`stdout.write`) — não
 *    identifica qual arquivo exato travou (o `node --test` roda o batch
 *    inteiro numa única invocação), mas reduz o universo de suspeitos pra
 *    bisecção manual (#6822, ainda em aberto como Defeito B).
 *
 * 2. **Resultado ausente contava como bom.** O agregador só olhava
 *    `result.status`. Se o batch morre (kill por timeout/sinal externo) OU
 *    termina sem imprimir o sumário final do `node:test` (`# fail N` / `ℹ
 *    fail N` — ver `FAIL_SUMMARY_RE`), isso agora é FALHA DURA,
 *    independente do que `status` diga — nunca mais um "não sei" vira
 *    "passou". `runTestBatches` também soma quantos arquivos tiveram um
 *    sumário genuíno confirmado (`completedFiles`) e compara contra
 *    `files.length` (a mesma contagem que `scripts/assert-test-discovery.ts`,
 *    o `pretest`, produz via `listTestFiles` compartilhado) — cobertura
 *    incompleta é reportada e força `exitCode = 1`, mesmo que cada batch
 *    individualmente já tenha marcado sua própria falha (defesa em
 *    profundidade, não o único caminho pra pegar o caso).
 *
 * Investigação adicional pedida pela issue: `process.exit(...)` era chamado
 * imediatamente após `runTestBatches` retornar, sem esperar o flush do
 * último `stdout.write`/`stderr.write` — em pipes não-TTY (o caso da CI),
 * escritas grandes do Node podem ser assíncronas, e `process.exit()`
 * síncrono pode truncar a cauda do buffer antes dela sair. Não é a causa
 * comprovada do gap de vários minutos (o gap é tempo real de hang, não
 * output pendente), mas é um bug real e independente — corrigido trocando
 * `process.exit(code)` por `process.exitCode = code` (deixa o processo
 * sair naturalmente depois do event loop drenar as escritas pendentes, sem
 * segurar a saída se não houver mais nenhum handle ativo).
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
  /** #6822: teto de tempo por batch (ms) — default `DEFAULT_BATCH_TIMEOUT_MS`. */
  batchTimeoutMs?: number;
}

/** #6822: teto por batch — bem acima da duração normal observada (~40-90s
 *  por batch de 150 arquivos), mas finito: sem isso, um batch travado
 *  bloqueia `spawnSync` (e portanto o processo pai inteiro) indefinidamente.
 *  Overridável via `RUN_TESTS_BATCH_TIMEOUT_MS` (ms) sem precisar editar
 *  código — útil pra apertar o teto ao bissecar o Defeito B (#6822). */
export const DEFAULT_BATCH_TIMEOUT_MS = (() => {
  const raw = process.env.RUN_TESTS_BATCH_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 60 * 1000;
})();

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

/** Pure (#6822): `true` só quando o output contém um sumário final
 *  reconhecível do `node:test` (mesma regra de `parseFailCount` — `null`
 *  vira `false`). Um batch sem isso NUNCA terminou de rodar de verdade,
 *  mesmo que `status` volte 0 — ver "Defeito A" na docstring do módulo. */
export function hasTestSummary(output: string): boolean {
  return parseFailCount(output) !== null;
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
    batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
  } = opts;
  if (files.length === 0) {
    // Sem arquivos: deixa o guard `assert-test-discovery.ts` (pretest) ser
    // quem falha alto nesse caso — este wrapper não duplica esse julgamento.
    return 0;
  }
  const batches = chunk(files, batchSize);
  let exitCode = 0;
  // #6822: quantos arquivos tiveram um sumário GENUÍNO do node:test
  // confirmado (batch rodou até o fim, passou ou falhou — não importa,
  // desde que tenha terminado de verdade). Comparado contra `files.length`
  // no final — a mesma contagem que o pretest (`assert-test-discovery.ts`)
  // produz via `listTestFiles` compartilhado.
  let completedFiles = 0;

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
      // #6822: sem isto, um batch travado (hang sem crash, ver docstring do
      // módulo) bloqueia `spawnSync` — e portanto o processo pai — pra
      // sempre. SIGKILL (não o SIGTERM default) porque um processo já preso
      // numa promise pendente pode ignorar SIGTERM.
      timeout: batchTimeoutMs,
      killSignal: "SIGKILL",
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

  batches.forEach((batch, idx) => {
    const label = `batch ${idx + 1}/${batches.length}`;
    // #6822 (Defeito B, instrumentação): loga os candidatos ANTES de
    // despachar — se este batch travar, o próximo hang já sai com o
    // universo de arquivos suspeitos no log, sem precisar esperar o
    // arquivo aparecer no output (que é justamente o que não acontece
    // quando o batch trava).
    stdout.write(`\nrun-tests: despachando ${label} (${batch.length} arquivos): ${batch.join(", ")}\n`);

    let result = runOne(batch);
    if (result.error) {
      // #6822: `ETIMEDOUT` é o `spawnSync` matando o batch por ter estourado
      // `batchTimeoutMs` — o caso real observado ao vivo (testado com um
      // arquivo que trava de propósito). Nomeia os arquivos do batch
      // diretamente na mensagem de erro (não só na linha "despachando"
      // anterior), pra quem só grep a mensagem de falha achar o candidato
      // sem precisar rolar o log pra cima.
      const isTimeout = /ETIMEDOUT/.test(result.error.message);
      const suffix = isTimeout
        ? ` (timeout de ${batchTimeoutMs}ms — candidatos ao hang: ${batch.join(", ")})`
        : "";
      console.error(
        `run-tests: falha ao spawnar ${label} (${batch.length} arquivos): ${result.error.message}${suffix}`,
      );
      exitCode = 1;
      return;
    }
    emit(result);

    if ((result.status ?? 1) !== 0) {
      const combined = `${toText(result.stdout)}\n${toText(result.stderr)}`;
      if (shouldRetryBatch(combined, result.status)) {
        stderr.write(
          `\nrun-tests: ${label} com ERR_MODULE_NOT_FOUND e fail 0 (#6495, erro de infra do runner, não de teste) — retentando UMA vez (${batch.length} arquivos)...\n`,
        );
        const retry = runOne(batch);
        if (retry.error) {
          console.error(`run-tests: falha ao spawnar retry do ${label}: ${retry.error.message}`);
          exitCode = 1;
          return;
        }
        emit(retry);
        result = retry;
      }
    }

    // #6822 — Defeito A: batch morto por timeout/sinal externo (spawnSync
    // seta `signal` quando mata o processo) é falha dura, sempre — nunca
    // deixa um `status` ambíguo (às vezes null, às vezes um código
    // acidental da plataforma) escapar como sucesso.
    if (result.signal) {
      stderr.write(
        `\nrun-tests: ${label} MORTO por sinal ${result.signal} (timeout de ${batchTimeoutMs}ms atingido, ou kill externo) — travou antes de emitir o sumário do node:test. Arquivos candidatos ao hang (não sabemos qual exatamente, dentro deste batch): ${batch.join(", ")}\n`,
      );
      exitCode = 1;
      return;
    }

    // #6822 — Defeito A, o achado central da escalada: um batch cujo output
    // não contém o sumário final do node:test NUNCA terminou de rodar de
    // verdade, mesmo que `status` volte 0 (medido ao vivo: PR #6830 saiu
    // `success` com 2 asserções quebradas porque o arquivo que continha
    // essas asserções nunca chegou a rodar). Resultado ausente é sempre
    // falha — nunca "não sei, deve estar ok".
    const combinedFinal = `${toText(result.stdout)}\n${toText(result.stderr)}`;
    if (!hasTestSummary(combinedFinal)) {
      stderr.write(
        `\nrun-tests: ${label} (${batch.length} arquivos) NÃO produziu sumário reconhecível do node:test ("# fail N"/"ℹ fail N") — tratando como FALHA independente do exit status (${result.status}). A suíte pode ter travado no meio deste batch sem emitir o resultado final. Arquivos deste batch: ${batch.join(", ")}\n`,
      );
      exitCode = 1;
      return;
    }

    // Sumário genuíno presente: o batch de fato terminou de rodar (passou
    // ou falhou de verdade — os dois casos contam como "completou").
    completedFiles += batch.length;
    if ((result.status ?? 1) !== 0) exitCode = 1;
  });

  // #6822: confronta o que de fato completou contra o que deveria ter
  // rodado (`files.length`, a mesma contagem que `listTestFiles` produz
  // pro pretest `assert-test-discovery.ts`). Defesa em profundidade — cada
  // batch problemático já marca `exitCode = 1` sozinho acima, mas este
  // check final é o que a issue pede explicitamente: nunca deixar cobertura
  // parcial sair 0, mesmo que o motivo específico do gap não tenha sido
  // capturado por nenhum dos ramos acima.
  if (completedFiles !== files.length) {
    exitCode = 1;
    stderr.write(
      `\nrun-tests: cobertura incompleta — ${completedFiles}/${files.length} arquivos *.test.ts confirmados via sumário do node:test (mesma contagem que scripts/assert-test-discovery.ts, o pretest, produz via listTestFiles). ${
        files.length - completedFiles
      } arquivo(s) nunca produziram um resultado válido — pelo menos 1 batch travou ou falhou ao terminar. Nunca sai 0 com cobertura parcial (#6822).\n`,
    );
  }

  return exitCode;
}

// CLI guard (#cli-guard): só roda como main; importável em testes sem disparar.
if (isMainModule(import.meta.url)) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const files = listTestFiles(root);
  const extraArgs = process.argv.slice(2);
  // #6822: `process.exit(code)` síncrono, chamado logo após o último
  // `stdout.write`/`stderr.write` de `runTestBatches`, pode truncar a
  // cauda do buffer se a escrita ainda não drenou — `process.stdout` é
  // ASSÍNCRONO quando conectado a um pipe não-TTY (o caso normal da CI).
  // `process.exitCode` deixa o processo sair sozinho depois que o event
  // loop esvaziar (inclusive as escritas pendentes), sem segurar a saída
  // caso não sobre nenhum handle ativo (não há nenhum aqui — todo o
  // trabalho de `runTestBatches` é síncrono via `spawnSync`).
  process.exitCode = runTestBatches({ files, extraArgs });
}
