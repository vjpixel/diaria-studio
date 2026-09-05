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
 * BATCHES de tamanho fixo (`BATCH_SIZE`), cada um bem dentro do limite em
 * qualquer profundidade de path razoável; dentro de cada batch o `node
 * --test` ainda paraleliza normalmente (concorrência default do runner).
 * **Desde o #6877, o caminho de PRODUÇÃO (CLI) roda os batches em
 * PARALELO** — vários processos worker concorrentes, ver a seção
 * "#6877 — paralelismo de batches" mais abaixo no arquivo; a versão
 * sequencial descrita aqui (um batch de cada vez) é `runTestBatches`, ainda
 * usada como fallback e como a função que os testes deste módulo exercitam
 * diretamente. O exit code final é 1 se qualquer batch falhar; todos os
 * batches rodam até o fim (mesmo após uma falha) para reportar o quadro
 * completo, igual ao comportamento nativo de `node --test` sobre múltiplos
 * arquivos.
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
 * é seguro. Critério de `shouldRetryBatch` — os DOIS precisam ser
 * verdadeiros:
 *   1. o batch falhou (`status !== 0`);
 *   2. o stdout/stderr combinado contém `ERR_MODULE_NOT_FOUND`.
 *
 * **Havia um 3º critério (`fail 0` no sumário do `node:test`) e ele foi
 * REMOVIDO no #6857 — ver o docblock de `shouldRetryBatch` para a medição
 * que o derrubou.** Este parágrafo o descrevia como vigente até o #6783
 * (03/09/2026), afirmando que o retry "não mascara falha de teste real
 * porque só dispara quando o `node:test` confirma zero falhas". Essa
 * garantia deixou de valer no #6857 e o texto continuou aqui — quem lesse
 * este bloco (o primeiro do arquivo a explicar o retry) sairia com uma
 * garantia de segurança que o código não dá mais.
 *
 * O que de fato protege hoje, sem o `fail 0`: (a) `ERR_MODULE_NOT_FOUND` é
 * sempre o filho falhando ao resolver um import que o PAI já confirmou
 * existir, nunca uma asserção quebrada; e (b) **só UM retry por batch** —
 * se o 2º run falhar de novo, o batch conta como falha definitiva. Uma
 * falha de teste REAL e determinística no mesmo batch reprova nas duas
 * corridas — e a falha PASSA ADIANTE, não é escondida. O resíduo honesto é o caso estreito de uma falha real
 * que seja ELA MESMA intermitente e caia justo no batch que teve o crash de
 * módulo — aí o retry pode escondê-la. Risco aceito e agora escrito, em vez
 * de negado por um critério que não existe mais.
 *
 * **Marcador contável (#6783).** Quando o retry dispara, sai no stderr uma
 * linha própria antes da mensagem humana:
 *
 *     RUN_TESTS_MODULE_FLAKE batch={label} arquivos={N} modulo={caminho}
 *
 * A #6783 registrou o 2º data point do flake e pediu mais dados. O gargalo
 * nunca foi o flake ser raro — era cada ocorrência exigir que alguém
 * reparasse num log de CI e escrevesse uma issue à mão; foi assim que se
 * chegou a 2 em meses. Com o marcador, contar vira:
 *
 *     gh run list --workflow=ci.yml --limit 50 --json databaseId -q '.[].databaseId' \
 *       | while read -r id; do gh run view "$id" --log 2>/dev/null \
 *           | grep -c RUN_TESTS_MODULE_FLAKE; done
 *
 * O MÓDULO que falhou sai junto porque é o dado que separa as hipóteses: as
 * ocorrências conhecidas foram sempre em arquivo NOVO do próprio PR, e é
 * isso que sustenta a hipótese líder (glitch do `actions/checkout` em torno
 * de arquivo recém-materializado). Frequência medida vale mais que a 3ª
 * anedota.
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
 *
 * ## #7337 — sumário AGREGADO, distinto do sumário nativo por batch
 *
 * Achado ao vivo na PR #7333 (03/09/2026, mesma rodada dos #7250/#7294/
 * #7285/#7320 — "resumo que afirma saúde sem ter medido o conjunto todo"):
 * cada batch imprime o próprio sumário `node:test` (`ℹ fail N`/`# fail N`),
 * e só o do ÚLTIMO batch fica visível no rodapé do log. Quando um batch
 * ANTERIOR falha e o último passa, o rodapé mostra `fail 0` seguido de
 * `exit code 1` — o exit code está certo, mas o número que qualquer leitor
 * vê primeiro mente por ESCOPO (é verdade só pro último batch), não por
 * bug. Enganou 2 sessões independentes que leram esse rodapé e concluíram
 * "a falha está fora do node:test" — as duas hipóteses derivadas dessa
 * premissa estavam erradas.
 *
 * `processChunkedBatches` agora soma `pass`/`fail` de TODOS os batches
 * (`totalPass`/`totalFail`) e mantém `failedBatches` — o rótulo de cada
 * batch que terminou como falha, com ou sem sumário reconhecível
 * (`formatAggregateSummary` formata a linha final). `runTestBatches`
 * imprime essa linha sempre, no caminho feliz e no de falha — é a única
 * linha do log garantida a refletir a rodada inteira, nunca só o último
 * batch impresso. O caminho paralelo (`runTestBatchesParallel`) soma o
 * mesmo agregado de TODOS os workers antes de imprimir — sem isso, o
 * problema de origem continuaria, só que multiplicado por worker em vez de
 * por batch sequencial.
 */
import { spawnSync, fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listTestFiles } from "./assert-test-discovery.ts";
import { isMainModule, getArg } from "./lib/cli-args.ts";

/** Batches de 150 arquivos: bem abaixo do teto de ~32767 chars do Windows
 *  mesmo com paths absolutos longos (150 × ~150 chars ≈ 22.500), com folga
 *  suficiente pra não precisar recalibrar a cada arquivo novo no repo. */
export const BATCH_SIZE = 150;

/** #6877 (achado ao vivo, escrevendo o teste de integração real deste
 *  módulo): `node:test` marca o processo em que está rodando com
 *  `NODE_TEST_CONTEXT`/`NODE_TEST_WORKER_ID` (env vars internas do próprio
 *  Node) — `spawnSync`/`fork` herdam `process.env` por padrão, então um
 *  processo que já roda DENTRO de um `node --test` (ex: este próprio módulo
 *  sendo exercitado por `test/run-tests.test.ts`, ou qualquer wrapper de CI
 *  que algum dia rode `npm test` a partir de um contexto de teste já ativo)
 *  propaga essas vars pro GRANDCHILD que `runOne`/`bisectHangingBatch`
 *  disparam (`node --test <batch>`) — o Node detecta a marca herdada e
 *  imprime `"run() is being called recursively within a test file. skipping
 *  running files."`, e o batch/sub-lista sai sem rodar NENHUM teste (sumário
 *  ausente, tratado corretamente como falha pelo #6822 — mas silenciosa na
 *  causa: sem isto, alguém vendo "sem sumário" ia procurar hang, não
 *  herança de env). Nunca acontece no caminho de produção normal (`npm test`
 *  não roda dentro de outro `node --test`), mas o teste de integração real
 *  do #6877 (que precisa rodar `node --test` de dentro da própria suíte pra
 *  provar o `fork()`) expôs exatamente esse cenário — corrigido na fonte
 *  (nunca propagar a marca), não contornado só no teste. */
export function cleanChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _ctx, NODE_TEST_WORKER_ID: _wid, ...rest } = env;
  return rest;
}

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
  /** #6822 (Defeito B): teto por rodada de bisecção (ms) — default
   *  `DEFAULT_BISECT_TIMEOUT_MS`. */
  bisectTimeoutMs?: number;
  /** #6822 (Defeito B): orçamento total de bisecção (ms) — default
   *  `DEFAULT_BISECT_BUDGET_MS`. `0` desliga a bisecção inteiramente
   *  (volta ao comportamento anterior: só a lista crua do batch). */
  bisectBudgetMs?: number;
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

/** Casa a linha `pass N` do sumário final do `node:test` — mesma forma de
 *  `FAIL_SUMMARY_RE` (reporter `spec` usa `ℹ`, `tap` usa `#`). #7337: usada
 *  junto com `parseFailCount` para compor o sumário AGREGADO de todos os
 *  batches — sem isto, só dava pra somar falhas, não o total de testes que
 *  de fato passaram. */
const PASS_SUMMARY_RE = /^(?:ℹ|#)\s*pass\s+(\d+)\s*$/gim;

/** Pure: extrai a contagem `pass N` do sumário final do `node:test`, mesma
 *  regra/limitações de `parseFailCount` (última ocorrência ancorada em
 *  início/fim de linha; `null` quando não reconhecido). */
export function parsePassCount(output: string): number | null {
  PASS_SUMMARY_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  let last: number | null = null;
  while ((match = PASS_SUMMARY_RE.exec(output)) !== null) {
    last = Number(match[1]);
  }
  return last;
}

/** Pure: decide se um batch que falhou merece 1 retry — critérios do #6495,
 *  alargados pelo #6857. Precisam ser verdadeiros: status != 0 e assinatura
 *  `ERR_MODULE_NOT_FOUND` presente no output combinado.
 *
 *  #6857 (achado ao vivo 31/08/2026, PR #6855, 2 tentativas consecutivas,
 *  mesmo arquivo nas duas): a versão original também exigia `fail 0` no
 *  sumário — a leitura de que o crash SEMPRE zera a contagem de falhas do
 *  batch. Falso: quando o `ERR_MODULE_NOT_FOUND` acontece no MEIO do batch
 *  (outros arquivos já rodaram e concluíram antes do crash), o node:test
 *  soma esse próprio crash como 1 falha no sumário (`ℹ fail 1`), então
 *  `fail 0` nunca bate e o retry não disparava — CI ficava vermelho por
 *  infra, exigindo `gh run rerun --failed` manual toda vez. A assinatura
 *  `ERR_MODULE_NOT_FOUND` sozinha já é suficiente: é sempre o processo
 *  filho falhando ao resolver um import de um arquivo que o PAI já
 *  confirmou existir (ele quem enumerou e passou como argumento) — nunca
 *  uma asserção de teste real, então não faz sentido gatear por `fail`. */
export function shouldRetryBatch(output: string, status: number | null): boolean {
  if ((status ?? 1) === 0) return false;
  return ERR_MODULE_NOT_FOUND_RE.test(output);
}

/** #6822 (Defeito B): teto por RODADA de bisecção — bem menor que
 *  `batchTimeoutMs` de propósito, porque uma sub-lista de N/2 arquivos deve
 *  rodar em fração do tempo normal de um batch saudável (~40-90s pra 150
 *  arquivos). Overridável via `RUN_TESTS_BISECT_TIMEOUT_MS`. Uma sub-lista
 *  perto do teto por ser genuinamente lenta (não travada) pode aparecer como
 *  falso positivo — por isso o resultado da bisecção é sempre rotulado
 *  "candidato", nunca "causa comprovada" (ver `BisectResult`). */
export const DEFAULT_BISECT_TIMEOUT_MS = (() => {
  const raw = process.env.RUN_TESTS_BISECT_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 90 * 1000;
})();

/** #6822 (Defeito B): orçamento TOTAL de tempo pra bisecção inteira de um
 *  batch travado — sem isso, um batch onde CADA arquivo trava sozinho (caso
 *  patológico, nunca observado, mas não impossível) recursaria até 2N-1
 *  spawns e multiplicaria o próprio hang que está tentando diagnosticar.
 *  Overridável via `RUN_TESTS_BISECT_BUDGET_MS`. */
export const DEFAULT_BISECT_BUDGET_MS = (() => {
  const raw = process.env.RUN_TESTS_BISECT_BUDGET_MS;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60 * 1000;
})();

/** Resultado de `bisectHangingBatch` — three-way, nunca colapsa incerteza em
 *  "limpo" ou "culpado":
 *   - `clean`: rodou com sumário válido dentro do `subTimeoutMs` reduzido —
 *     não reproduziu o problema quando isolado deste jeito.
 *   - `hanging`: já não deu pra reduzir mais (lista de 1) e AINDA ASSIM não
 *     produziu sumário — candidato forte, mas rotulado "candidato" no
 *     output porque um arquivo genuinamente lento sozinho pode bater o
 *     mesmo sintoma sem ser bug de hang.
 *   - `inconclusive`: a bisecção não terminou de isolar (orçamento total
 *     estourou antes) — pode ser reflexo de CONTENÇÃO DE RECURSO entre
 *     arquivos concorrentes (o hang só se manifesta com vizinhos certos
 *     rodando ao mesmo tempo, e bissecar reduz a concorrência junto com o
 *     tamanho da lista) — nunca reportar como "limpo" só por falta de
 *     tempo pra confirmar. */
export interface BisectResult {
  clean: string[];
  hanging: string[];
  inconclusive: string[];
}

/** #6822 (Defeito B): re-roda recursivamente metades cada vez menores do
 *  batch que travou, com um teto de tempo bem mais curto por rodada, até
 *  isolar o(s) arquivo(s) que reproduzem o hang sozinhos — ou esgotar o
 *  orçamento total tentando. Só é chamado no caminho de FALHA (batch morto
 *  por timeout/sinal, spawn com ETIMEDOUT, ou sem sumário do node:test) —
 *  nunca no caminho feliz, então o custo extra só existe quando já há CI
 *  vermelho de qualquer forma. `deadline` (epoch ms) é injetável pra teste
 *  determinístico; default é `Date.now() + budgetMs` na 1ª chamada. */
export function bisectHangingBatch(
  batch: string[],
  spawn: typeof spawnSync,
  extraArgs: string[],
  subTimeoutMs: number,
  deadline: number,
): BisectResult {
  if (batch.length === 0) return { clean: [], hanging: [], inconclusive: [] };
  if (Date.now() >= deadline) {
    return { clean: [], hanging: [], inconclusive: [...batch] };
  }
  const result = spawn(process.execPath, ["--import", "tsx", "--test", ...extraArgs, ...batch], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    timeout: subTimeoutMs,
    killSignal: "SIGKILL",
    env: cleanChildEnv(),
  });
  const out = result.stdout ? String(result.stdout) : "";
  const err = result.stderr ? String(result.stderr) : "";
  const combined = `${out}\n${err}`;
  const spawnTimedOut = Boolean(result.error) && (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  const killedBySignal = Boolean(result.signal);
  const noSummary = !result.error && !hasTestSummary(combined);
  const reproducedHere = spawnTimedOut || killedBySignal || noSummary;
  if (!reproducedHere) {
    // Sumário válido dentro do teto reduzido: esta sub-lista não reproduziu
    // o sintoma isolada — todo mundo aqui volta como "clean".
    return { clean: [...batch], hanging: [], inconclusive: [] };
  }
  if (batch.length === 1) {
    return { clean: [], hanging: [...batch], inconclusive: [] };
  }
  const mid = Math.ceil(batch.length / 2);
  const left = bisectHangingBatch(batch.slice(0, mid), spawn, extraArgs, subTimeoutMs, deadline);
  const right = bisectHangingBatch(batch.slice(mid), spawn, extraArgs, subTimeoutMs, deadline);
  return {
    clean: [...left.clean, ...right.clean],
    hanging: [...left.hanging, ...right.hanging],
    inconclusive: [...left.inconclusive, ...right.inconclusive],
  };
}

/** Formata o resultado de `bisectHangingBatch` pra uma linha de log —
 *  centraliza a mensagem pros 3 call sites de `processChunkedBatches`
 *  (#6877: extraída de `runTestBatches`, mesmos 3 call sites — spawn
 *  ETIMEDOUT, morte por sinal, sem sumário) que hoje só imprimem a lista
 *  crua do batch inteiro. */
export function formatBisectResult(result: BisectResult): string {
  const parts: string[] = [];
  if (result.hanging.length > 0) {
    parts.push(`candidato(s) forte(s) ao hang (travou mesmo isolado): ${result.hanging.join(", ")}`);
  }
  if (result.inconclusive.length > 0) {
    parts.push(
      `não isolado (orçamento de bisecção esgotado — pode ser contenção de recurso entre arquivos concorrentes, não travamento de 1 arquivo sozinho): ${result.inconclusive.join(", ")}`,
    );
  }
  if (parts.length === 0) {
    return "bisecção não reproduziu o hang em nenhuma sub-lista isolada — sintoma pode depender de concorrência/ordem que a bisecção não preserva.";
  }
  return parts.join(" | ");
}

/** Subconjunto de `RunTestsOptions` que `processChunkedBatches` precisa —
 *  tudo MENOS `files`/`batchSize` (o caller já fez o `chunk`). Extraído pro
 *  #6877: o mesmo processamento sequencial de uma lista de batches roda
 *  tanto no caminho single-process (`runTestBatches`, batches = TODOS)
 *  quanto dentro de cada worker do caminho paralelo (batches = só a fatia
 *  daquele worker) — sem duplicar a lógica de retry/timeout/bisecção. */
export interface ProcessChunkedBatchesOptions {
  extraArgs?: string[];
  spawn?: typeof spawnSync;
  stdout?: { write(chunk: string): unknown };
  stderr?: { write(chunk: string): unknown };
  batchTimeoutMs?: number;
  bisectTimeoutMs?: number;
  bisectBudgetMs?: number;
  /** #6877: rótulo do batch no log inclui "grupo N" quando rodando dentro
   *  de um worker paralelo (só pra legibilidade do log combinado — não
   *  afeta nenhuma decisão). `undefined` no caminho single-process
   *  (comportamento idêntico ao de antes do #6877). */
  labelPrefix?: string;
}

export interface ProcessChunkedBatchesResult {
  exitCode: number;
  /** Quantos arquivos tiveram um sumário GENUÍNO do node:test confirmado
   *  (batch terminou de rodar, passou ou falhou — os dois contam). Comparado
   *  pelo CALLER contra o total esperado — este função não conhece o total
   *  geral quando roda só a fatia de um worker. */
  completedFiles: number;
  /** #7337: soma de `pass N` de todo batch que produziu um sumário válido
   *  do node:test (batches sem sumário — timeout, sinal, spawn error — não
   *  contribuem, porque não há contagem confiável pra somar). */
  totalPass: number;
  /** #7337: soma de `fail N` de todo batch que produziu um sumário válido. */
  totalFail: number;
  /** #7337: rótulo (mesmo texto usado no log, ex: "batch 3/10") de cada
   *  batch que terminou como falha — inclusive quando não há sumário
   *  (timeout/sinal/spawn error/cobertura ausente). É esta lista, agregada
   *  ao final da rodada, que resolve o problema de origem: o sumário nativo
   *  do node:test só reflete o ÚLTIMO batch impresso, então um batch
   *  anterior que falhou fica invisível se o último passar. */
  failedBatches: string[];
}

/** Processa uma lista JÁ CHUNKADA de batches, sequencialmente — mesma lógica
 *  de retry (#6495/#6857), timeout+SIGKILL e bisecção de hang (#6822) que
 *  `runTestBatches` sempre teve, agora reutilizável pelo caminho paralelo do
 *  #6877 (cada worker chama isto só com a sua fatia de batches). NÃO faz o
 *  check final de `completedFiles === total esperado` — isso é
 *  responsabilidade do CALLER, que é quem sabe o total (a fatia de um
 *  worker sozinho nunca bate com `files.length` inteiro). */
export function processChunkedBatches(
  batches: string[][],
  opts: ProcessChunkedBatchesOptions = {},
): ProcessChunkedBatchesResult {
  const {
    extraArgs = [],
    spawn = spawnSync,
    stdout = process.stdout,
    stderr = process.stderr,
    batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    bisectTimeoutMs = DEFAULT_BISECT_TIMEOUT_MS,
    bisectBudgetMs = DEFAULT_BISECT_BUDGET_MS,
    labelPrefix,
  } = opts;
  /** #6822 (Defeito B): tenta isolar o(s) arquivo(s) culpado(s) de um batch
   *  que não produziu sumário — só roda se houver orçamento (`bisectBudgetMs
   *  > 0`); escreve o resultado formatado em `stderr` como uma linha extra,
   *  sem alterar `exitCode` (a falha do batch já foi decidida pelo caller).
   *  Isolado numa closure porque os 3 call sites precisam do mesmo
   *  `deadline` por CHAMADA (não por batch — um batch travado já consumiu
   *  tempo real da suíte; não vale a pena dar orçamento cheio de novo pra
   *  cada ocorrência dentro da mesma rodada de CI/worker). */
  const bisectDeadline = Date.now() + bisectBudgetMs;
  const tryBisect = (batch: string[]): string => {
    if (bisectBudgetMs <= 0) {
      return `candidatos ao hang (bisecção desligada — RUN_TESTS_BISECT_BUDGET_MS=0): ${batch.join(", ")}`;
    }
    const result = bisectHangingBatch(batch, spawn, extraArgs, bisectTimeoutMs, bisectDeadline);
    return formatBisectResult(result);
  };
  let exitCode = 0;
  let completedFiles = 0;
  // #7337: agregação distinta do sumário nativo do node:test — este arquivo
  // já rodava vários batches, mas nada somava pass/fail entre eles nem
  // nomeava quais falharam ao final; quem lesse só o rodapé do log via o
  // sumário do ÚLTIMO batch, que mente por escopo (não por bug) quando um
  // batch anterior falhou e o último passou.
  let totalPass = 0;
  let totalFail = 0;
  const failedBatches: string[] = [];

  // #7387: aceita um teto de tempo OPCIONAL distinto de `batchTimeoutMs` —
  // usado só pelo retry de spawn ETIMEDOUT abaixo, pra caber dentro do
  // orçamento de bisecção já reservado (nunca soma tempo novo ao teto do
  // worker, ver `computeWorkerTimeoutMs`). Sem argumento, comportamento
  // idêntico ao de sempre.
  const runOne = (batch: string[], timeoutMs: number = batchTimeoutMs) =>
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
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      // #6877 — ver docstring de `cleanChildEnv`: nunca propagar
      // NODE_TEST_CONTEXT/NODE_TEST_WORKER_ID herdados (processo pai já
      // rodando dentro de outro `node --test`) pro batch, senão o `--test`
      // deste grandchild se recusa a rodar ("run() called recursively").
      env: cleanChildEnv(),
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
    const label = labelPrefix ? `${labelPrefix} batch ${idx + 1}/${batches.length}` : `batch ${idx + 1}/${batches.length}`;
    // #6822 (Defeito B, instrumentação): loga os candidatos ANTES de
    // despachar — se este batch travar, o próximo hang já sai com o
    // universo de arquivos suspeitos no log, sem precisar esperar o
    // arquivo aparecer no output (que é justamente o que não acontece
    // quando o batch trava).
    stdout.write(`\nrun-tests: despachando ${label} (${batch.length} arquivos): ${batch.join(", ")}\n`);

    let result = runOne(batch);
    if (result.error) {
      // Review #6833 (P2, confiança alta): antes deste fix, `emit(result)`
      // só rodava DEPOIS deste branch — descartando qualquer stdout/stderr
      // parcial que o batch tenha produzido antes de `spawnSync` matá-lo
      // (confirmado ao vivo: um `ETIMEDOUT` ainda vem com o output emitido
      // até o momento do kill). Esse parcial é justamente o dado mais
      // valioso pra bissecar o Defeito B — reduz o universo de suspeitos do
      // batch inteiro pro(s) arquivo(s) cujo output já apareceu antes do
      // corte. Emitir ANTES de decidir a mensagem de erro preserva isso.
      emit(result);
      // Review #6833 (P3, confiança alta): checar `error.code` (propriedade
      // estruturada e estável do Node) em vez de regex sobre `error.message`
      // (string livre — `"spawnSync <path> ETIMEDOUT"` embute o path
      // resolvido do executável, formato não-contratual entre versões).
      const isTimeout = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
      // #7387 (achado ao vivo: ≥5 PRs na mesma rodada overnight 260903,
      // recorrência confirmada via #7416/#7455) — spawnSync ETIMEDOUT sempre
      // resolvido por 1 `gh run rerun --failed` manual, nunca uma falha de
      // teste real reproduzida na bisecção. Mesma assinatura de "erro de
      // infra do runner, não de teste" que #6495/#6857 já tratam pra
      // ERR_MODULE_NOT_FOUND — 1 retry automático da RODADA INTEIRA antes de
      // declarar falha dura, evitando o rerun manual quando é timing/
      // contenção transiente. Orçamento vem do MESMO `bisectDeadline` que a
      // bisecção usaria (nunca soma tempo novo ao teto do worker —
      // `computeWorkerTimeoutMs` já reserva `bisectBudgetMs` pro pior caso de
      // diagnóstico de um batch travado; isto só troca "gastar tudo
      // bissecando" por "gastar um retry primeiro, bissecar só se ele também
      // falhar"). Sem orçamento sobrando (`bisectBudgetMs` já esgotado por
      // batches anteriores do mesmo grupo): pula direto pro caminho antigo.
      const remainingBudgetMs = isTimeout ? bisectDeadline - Date.now() : 0;
      if (isTimeout && remainingBudgetMs > 1000) {
        stderr.write(
          `\nrun-tests: ${label} spawn ETIMEDOUT (${batchTimeoutMs}ms) — retentando UMA vez (#7387, erro de infra do runner, não de teste) antes de bissecar...\n`,
        );
        const retry = runOne(batch, Math.min(batchTimeoutMs, remainingBudgetMs));
        if (!retry.error) {
          // Retry limpo: segue o fluxo normal abaixo (emit + checks de
          // status/sinal/sumário) como se tivesse sido a única tentativa.
          result = retry;
        } else {
          emit(retry);
          console.error(
            `run-tests: falha ao spawnar ${label} (${batch.length} arquivos) mesmo após retry: ${retry.error.message} (timeout de ${batchTimeoutMs}ms — ${tryBisect(batch)})`,
          );
          exitCode = 1;
          failedBatches.push(`${label} (falha ao spawnar, retry esgotado)`);
          return;
        }
      } else {
        const suffix = isTimeout
          ? ` (timeout de ${batchTimeoutMs}ms — ${tryBisect(batch)})`
          : "";
        console.error(
          `run-tests: falha ao spawnar ${label} (${batch.length} arquivos): ${result.error.message}${suffix}`,
        );
        exitCode = 1;
        failedBatches.push(`${label} (falha ao spawnar)`);
        return;
      }
    }
    emit(result);

    if ((result.status ?? 1) !== 0) {
      const combined = `${toText(result.stdout)}\n${toText(result.stderr)}`;
      if (shouldRetryBatch(combined, result.status)) {
        // #6783: marcador estável e greppável — rationale e comando de
        // contagem no docblock de topo, seção "Retry de ERR_MODULE_NOT_FOUND".
        const culprit = /Cannot find module '?([^'\s]+)'?/.exec(combined)?.[1] ?? "(arquivo não identificado no output)";
        stderr.write(
          `\nRUN_TESTS_MODULE_FLAKE batch=${label} arquivos=${batch.length} modulo=${culprit}\n` +
            `run-tests: ${label} com ERR_MODULE_NOT_FOUND (#6495/#6857, erro de infra do runner, não de teste) — retentando UMA vez (${batch.length} arquivos)...\n`,
        );
        const retry = runOne(batch);
        if (retry.error) {
          // Review #6833: mesmo fix do branch acima — emitir o parcial antes
          // de reportar o erro do retry.
          emit(retry);
          console.error(`run-tests: falha ao spawnar retry do ${label}: ${retry.error.message}`);
          exitCode = 1;
          failedBatches.push(`${label} (falha ao spawnar retry)`);
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
        `\nrun-tests: ${label} MORTO por sinal ${result.signal} (timeout de ${batchTimeoutMs}ms atingido, ou kill externo) — travou antes de emitir o sumário do node:test. Arquivos candidatos ao hang (não sabemos qual exatamente, dentro deste batch): ${batch.join(", ")}. Bissecando pra isolar o(s) arquivo(s)...\n`,
      );
      stderr.write(`run-tests: ${label} bisecção: ${tryBisect(batch)}\n`);
      exitCode = 1;
      failedBatches.push(`${label} (morto por sinal)`);
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
        `\nrun-tests: ${label} (${batch.length} arquivos) NÃO produziu sumário reconhecível do node:test ("# fail N"/"ℹ fail N") — tratando como FALHA independente do exit status (${result.status}). A suíte pode ter travado no meio deste batch sem emitir o resultado final. Bissecando pra isolar o(s) arquivo(s)...\n`,
      );
      stderr.write(`run-tests: ${label} bisecção: ${tryBisect(batch)}\n`);
      exitCode = 1;
      failedBatches.push(`${label} (sem sumário)`);
      return;
    }

    // Sumário genuíno presente: o batch de fato terminou de rodar (passou
    // ou falhou de verdade — os dois casos contam como "completou").
    completedFiles += batch.length;
    // #7337: soma pass/fail deste batch no agregado da rodada inteira —
    // acontece aqui, incondicional a `status`, porque um batch que falha
    // ainda tem uma contagem `pass`/`fail` válida (é justamente o caso que
    // engana quando só o sumário do ÚLTIMO batch é visível).
    totalPass += parsePassCount(combinedFinal) ?? 0;
    totalFail += parseFailCount(combinedFinal) ?? 0;
    const status = result.status ?? 1;
    if (status !== 0) {
      // #7094 — o exit code aqui SEMPRE esteve certo (filho saiu não-zero =>
      // vermelho, direção segura). O defeito era o SILÊNCIO: esta era a única
      // atribuição de `exitCode = 1` do arquivo sem nenhuma escrita, então o
      // log terminava com `ℹ fail 0` seguido de `exit code 1` e nada entre os
      // dois. Os dois caminhos vizinhos — batch sem sumário (acima) e
      // cobertura parcial (#6822) — já gritam e nomeiam; este calava.
      //
      // Sumário válido com `fail 0` + status não-zero significa que o
      // node:test saiu não-zero SEM contabilizar falha: unhandled rejection
      // depois do sumário, `process.exitCode` setado por algum arquivo de
      // teste, ou erro de escrita em stdout. O tail do stderr é o que
      // distingue esses casos — sem ele, a leitura fica "CI mentiu" e o
      // reflexo vira re-run, que é como vermelho legítimo vira "flake".
      const failCount = parseFailCount(combinedFinal);
      const tail = toText(result.stderr).trimEnd().split("\n").slice(-12).join("\n");
      stderr.write(
        `\nrun-tests: ${label} terminou com sumário VÁLIDO (fail ${failCount ?? "?"}) mas exit status ${status} — ` +
          `o node:test saiu não-zero SEM contabilizar falha (unhandled rejection após o sumário, ` +
          `process.exitCode setado por um arquivo de teste, ou erro de escrita em stdout). ` +
          `O vermelho está CORRETO; a causa apenas não aparece na contagem de falhas.\n` +
          (tail ? `run-tests: ${label} últimas linhas do stderr:\n${tail}\n` : ""),
      );
      exitCode = 1;
      failedBatches.push(label);
    }
  });

  return { exitCode, completedFiles, totalPass, totalFail, failedBatches };
}

/** #7337: sumário AGREGADO da rodada inteira — deliberadamente distinto da
 *  linha `ℹ fail N`/`# fail N` que o `node:test` imprime POR BATCH. Quando
 *  um batch anterior falha e o último batch passa, o rodapé do log só
 *  mostra o sumário do último — `fail 0` seguido de `exit code 1`, que
 *  enganou 2 sessões independentes na PR #7333. Esta linha soma pass/fail de
 *  TODOS os batches e nomeia explicitamente quais falharam, pra nunca mais
 *  depender de qual sumário calhou de ser o último impresso. Pura — só
 *  formata, não decide `exitCode` (isso continua sendo `finalizeExitCode`). */
export function formatAggregateSummary(
  result: Pick<ProcessChunkedBatchesResult, "totalPass" | "totalFail" | "failedBatches">,
  batchCount: number,
): string {
  const { totalPass, totalFail, failedBatches } = result;
  const header = `run-tests: RESUMO AGREGADO (todos os ${batchCount} batch(es)) — pass ${totalPass}, fail ${totalFail}`;
  if (failedBatches.length === 0) {
    return `${header} — nenhum batch falhou.`;
  }
  return `${header} — ${failedBatches.length}/${batchCount} batch(es) FALHARAM: ${failedBatches.join(", ")}`;
}

/** Roda `node --import tsx --test <batch...>` em batches sequenciais, num
 *  processo só (comportamento idêntico ao de antes do #6877 — usado pelos
 *  testes existentes deste arquivo, e como fallback do caminho paralelo
 *  quando `workerCount <= 1`). Retorna o exit code agregado (0 só se TODOS
 *  os batches saírem 0 E a cobertura bater com `files.length`). */
export function runTestBatches(opts: RunTestsOptions): number {
  const { files, batchSize = BATCH_SIZE, stderr = process.stderr } = opts;
  if (files.length === 0) {
    // Sem arquivos: deixa o guard `assert-test-discovery.ts` (pretest) ser
    // quem falha alto nesse caso — este wrapper não duplica esse julgamento.
    return 0;
  }
  const batches = chunk(files, batchSize);
  const result = processChunkedBatches(batches, opts);
  // #7337: sempre imprime o agregado, mesmo no caminho feliz — é a única
  // linha do log que garante refletir TODOS os batches, não só o último.
  stderr.write(`\n${formatAggregateSummary(result, batches.length)}\n`);
  return finalizeExitCode(result.exitCode, result.completedFiles, files.length, stderr);
}

/** #6822: confronta o que de fato completou contra o que deveria ter rodado
 *  (`totalFiles`, a mesma contagem que `listTestFiles` produz pro pretest
 *  `assert-test-discovery.ts`). Defesa em profundidade — cada batch
 *  problemático já marca sua própria falha, mas este check final é o que a
 *  issue original pediu explicitamente: nunca deixar cobertura parcial sair
 *  0. Extraído pro #6877: o caminho paralelo faz o MESMO check, mas somando
 *  `completedFiles` de TODOS os workers antes de comparar — nunca por
 *  worker isolado (a fatia de 1 worker nunca bate com o total geral). */
export function finalizeExitCode(
  exitCode: number,
  completedFiles: number,
  totalFiles: number,
  stderr: { write(chunk: string): unknown } = process.stderr,
): number {
  if (completedFiles !== totalFiles) {
    stderr.write(
      `\nrun-tests: cobertura incompleta — ${completedFiles}/${totalFiles} arquivos *.test.ts confirmados via sumário do node:test (mesma contagem que scripts/assert-test-discovery.ts, o pretest, produz via listTestFiles). ${
        totalFiles - completedFiles
      } arquivo(s) nunca produziram um resultado válido — pelo menos 1 batch/worker travou ou falhou ao terminar. Nunca sai 0 com cobertura parcial (#6822).\n`,
    );
    return 1;
  }
  return exitCode;
}

// ─────────────────────────────────────────────────────────────────────────
// #6877 — paralelismo de batches
// ─────────────────────────────────────────────────────────────────────────
//
// Medição da issue: em 12 runs de CI (7 sucessos + 5 falhas), a soma dos
// `duration_ms` que o próprio `node:test` reporta por batch bate com a
// duração do step inteiro (diff <1%) — não é hang (#6822 continua dona
// dessa pergunta, separada), é custo SEQUENCIAL genuíno: 10 batches de
// ~150 arquivos cada, um de cada vez, ~444s de trabalho real.
//
// Caminho escolhido (opção 1 da issue — "paralelismo dentro do runner"):
// processo pai divide os batches (já chunkados por `BATCH_SIZE`, mesma
// regra de sempre) em `workerCount` grupos e usa `child_process.fork` pra
// rodar cada grupo num PROCESSO Node separado — não `worker_threads`.
// Correção de uma alegação anterior deste comentário (achado do review da
// PR #6909, P3): `worker_threads` TAMBÉM têm heap/isolate V8 próprios e
// conseguem paralelismo real de CPU — não é essa a razão da escolha. A
// razão real é REUSO: o script já é um executável CLI que se re-invoca via
// `spawnSync(process.execPath, [...])` pra cada BATCH; `fork()` estende o
// MESMO padrão (processo re-invoca a si mesmo, `node --import tsx`, IPC
// automático) pro nível de GRUPO, sem precisar de um segundo mecanismo de
// carregamento de módulo/comunicação (`worker_threads` exigiria adaptar
// como `tsx` registra o loader dentro de uma thread, e um canal
// `postMessage`/`SharedArrayBuffer` novo em vez do IPC de `fork` que já
// serve). Processos separados também isolam falhas de verdade — um worker
// que crasha (SIGSEGV, OOM) nunca derruba os outros nem o pai, o que um
// worker_thread quebrando PODE fazer dependendo do tipo de erro. A lógica
// de retry/timeout/bisecção existente (`processChunkedBatches`, extraída
// acima) roda IDÊNTICA nos dois caminhos — replicar essa mesma lógica em N
// processos via `fork()` foi a mudança que preservou 100% dela sem reescrita.
//
// Cada worker é uma re-invocação deste MESMO script com `--worker <payload>`
// — o payload (grupo de batches + config) vai por ARQUIVO temporário, nunca
// por argv (razão original do próprio batching: o teto de ~32767 chars do
// `CreateProcessW` do Windows; um grupo pode ter várias centenas de
// arquivos, argv de novo seria arriscado). Comunicação do resultado de
// volta ao pai é por IPC (`fork` estabelece o canal automaticamente,
// `process.send`/`on("message")`) — nunca por parsing de stdout (frágil
// com múltiplos workers escrevendo ao mesmo tempo).
//
// Cuidados que a issue pediu, endereçados:
//   - Guard de sumário (#6833/#6822) nunca regride: `processChunkedBatches`
//     é a MESMA função nos dois caminhos, sem bifurcação de lógica.
//   - Worker que morre/crasha SEM mandar o `message` de resultado conta como
//     falha dura, `completedFiles` fica em 0 pra aquele grupo — mesmo
//     princípio do #6822 ("resultado ausente nunca é sucesso"), agora
//     também no nível de worker, não só de batch.
//   - `finalizeExitCode` (extraído acima) faz o mesmo check de cobertura
//     completa, agora somando `completedFiles` de TODOS os workers antes de
//     comparar com o total — nunca por worker isolado.
//   - Testes que dependem de recurso compartilhado sob concorrência: fora
//     de escopo consertar aqui (a issue já avisa) — se aparecer flake novo,
//     a causa provável é essa, tratado em issue própria.

/** Pura: distribui `batches` em `groupCount` grupos por ROUND-ROBIN (item i
 *  vai pro grupo `i % groupCount`) — não contíguo. Batches têm duração
 *  parecida entre si (mesmo `BATCH_SIZE`), mas qualquer ponto sistematicamente
 *  mais lento do repo (ex: um arquivo pesado que sempre cai no mesmo batch,
 *  já aconteceu com `alarm-issues.test.ts` no #6822) fica espalhado entre
 *  workers diferentes em vez de concentrado num grupo contíguo só — reduz a
 *  chance de UM worker carregar desproporcionalmente mais trabalho que os
 *  outros. Grupos vazios (mais workers que batches) são removidos do
 *  resultado — nunca faz sentido pagar overhead de `fork()` pra um grupo
 *  sem nada pra processar. */
export function splitIntoWorkerGroups<T>(batches: T[], groupCount: number): T[][] {
  if (groupCount <= 0) throw new Error(`splitIntoWorkerGroups: groupCount deve ser > 0, recebeu ${groupCount}`);
  const groups: T[][] = Array.from({ length: groupCount }, () => []);
  batches.forEach((batch, i) => {
    groups[i % groupCount].push(batch);
  });
  return groups.filter((g) => g.length > 0);
}

/** Payload que o processo PAI escreve num arquivo temporário e o WORKER lê —
 *  nunca passado via argv (mesma razão do teto do Windows que motivou o
 *  batching original). */
interface WorkerPayload {
  batches: string[][];
  extraArgs: string[];
  batchTimeoutMs: number;
  bisectTimeoutMs: number;
  bisectBudgetMs: number;
  /** Rótulo pro log combinado (ex: "grupo 1/4") — só legibilidade. */
  label: string;
}

/** Resultado que o WORKER manda de volta ao pai via IPC (`process.send`).
 *  #7337: carrega `totalPass`/`totalFail`/`failedBatches` também — o
 *  sumário agregado do caminho paralelo precisa somar esses campos de
 *  TODOS os workers, igual ao caminho sequencial faz por batch. */
interface WorkerResult {
  exitCode: number;
  completedFiles: number;
  totalPass: number;
  totalFail: number;
  failedBatches: string[];
}

/** Default de workers concorrentes — min(4, CPUs disponíveis), nunca mais
 *  que o hardware tem (oversubscrever CPU move o gargalo de I/O sequencial
 *  pra contenção de scheduler, sem ganho real). `4` é o teto porque o ganho
 *  marginal do 5º worker em diante é pequeno frente ao overhead de spawnar
 *  mais um processo Node (~100-200ms de startup do V8/tsx cada) pra um job
 *  de ~8min total. Overridável via `RUN_TESTS_WORKERS` (`1` desliga o
 *  paralelismo inteiro — cai no caminho single-process de sempre). */
export const DEFAULT_WORKER_COUNT = (() => {
  const raw = process.env.RUN_TESTS_WORKERS;
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  try {
    return Math.max(1, Math.min(4, availableParallelism()));
  } catch {
    // `availableParallelism` pode lançar em sandbox/container restrito —
    // fail-soft pro caminho single-process (workerCount=1 desliga o
    // paralelismo em `runTestBatchesParallel`, nunca lança).
    return 1;
  }
})();

/** Margem fixa somada ao teto do worker (ver `runWorker`) além da soma dos
 *  timeouts de cada batch e do orçamento de bisecção — cobre overhead de
 *  startup do processo (V8/tsx) e do I/O de leitura do payload, nunca zero
 *  (#6822: teto sempre finito, nunca "confiar que os batches internos
 *  bastam"). */
const WORKER_TIMEOUT_MARGIN_MS = 2 * 60 * 1000;

/** Pure (#6939): calcula o teto de tempo do worker — extraída de `runWorker`
 *  pra ser testável de forma determinística, sem precisar de um worker real
 *  dormindo minutos. Soma os timeouts de TODOS os batches do grupo (pior
 *  caso: todos travam em sequência) + o orçamento de bisecção (pior caso: a
 *  última chamada a `tryBisect`, dentro de `processChunkedBatches`, gasta o
 *  orçamento inteiro) + a margem fixa de startup. Ver docstring de
 *  `runWorker` pro cenário de falha que motivou incluir `bisectBudgetMs`
 *  aqui — antes do #6939 ele não entrava nesta conta. */
export function computeWorkerTimeoutMs(payload: Pick<WorkerPayload, "batches" | "batchTimeoutMs" | "bisectBudgetMs">): number {
  return payload.batches.length * payload.batchTimeoutMs + payload.bisectBudgetMs + WORKER_TIMEOUT_MARGIN_MS;
}

/** #7448: guarda de idempotência pro listener de erro do DESTINO do pipe
 *  (`process.stdout`/`process.stderr`, ou o stream mock injetado em teste) —
 *  ver o porquê no comentário dentro de `pipeWorkerStream`. `WeakSet` não
 *  impede GC do stream quando não há mais referências. */
const destinationErrorLoggersAttached = new WeakSet<NodeJS.WritableStream>();

/** #7448: encana um stream do worker (`child.stdout`/`child.stderr`) pro
 *  stream correspondente do processo pai (`process.stdout`/`process.stderr`),
 *  logando qualquer `error` — tanto na ORIGEM (o stream do child) quanto no
 *  DESTINO do pipe (o stream do pai). São eventos distintos: `.pipe()`
 *  propaga 'error' do destino separadamente do 'error' da origem, e sem um
 *  listener no destino um erro de escrita (ex: EPIPE no stdout do processo
 *  pai) vira uma exceção não tratada (stack cru, sem a mensagem diagnóstica
 *  que todo outro caminho de falha deste arquivo tem) em vez de um log
 *  limpo. Isto é a hipótese remanescente do flake #7430 ("fail:0 + exit 1"
 *  sem causa visível no stderr) — instrumentação de diagnóstico, não
 *  corrige a causa raiz (se for essa mesmo): torna a hipótese verificável
 *  na próxima ocorrência. Extraído como função pura/exportada pra ser
 *  testável com streams mock (produção sempre chama com
 *  `child.stdout`/`process.stdout` reais).
 *
 *  #7448 (achado do review da PR #7472, P2 confiança alta): o DESTINO
 *  (`process.stdout`/`process.stderr`) é COMPARTILHADO por todos os workers
 *  concorrentes (`runTestBatchesParallel` despacha até `DEFAULT_WORKER_COUNT`
 *  ao mesmo tempo, cada um chamando `runWorker` → esta função). Anexar um
 *  listener de erro no destino A CADA CHAMADA faria um único erro de
 *  escrita (ex: 1 EPIPE) disparar em TODOS os listeners acumulados — cada
 *  um "culpando" o `label` do SEU worker, produzindo N linhas de log
 *  atribuindo o mesmo erro a N workers diferentes (todos exceto no máximo
 *  1 estariam errados). Por isso o listener no DESTINO é anexado UMA ÚNICA
 *  VEZ por objeto de stream (guarda `destinationErrorLoggersAttached`),
 *  nunca por worker — a mensagem não atribui o erro a nenhum worker
 *  específico (não dá pra saber qual, de forma correta, numa escrita
 *  intercalada), só confirma que HOUVE erro de escrita no destino
 *  compartilhado. O listener na ORIGEM continua por chamada/por worker —
 *  `child.stdout` é exclusivo de cada processo filho, então a atribuição
 *  ali É correta. */
export function pipeWorkerStream(
  source: NodeJS.ReadableStream | null | undefined,
  destination: NodeJS.WritableStream,
  streamName: string,
  label: string,
): void {
  source?.on("error", (err: Error) => {
    console.error(`run-tests: erro no stream ${streamName} do worker (${label}): ${err.message}`);
  });
  source?.pipe(destination);
  if (!destinationErrorLoggersAttached.has(destination)) {
    destinationErrorLoggersAttached.add(destination);
    destination.on("error", (err: Error) => {
      console.error(
        `run-tests: erro de escrita em ${streamName} no DESTINO compartilhado por todos os workers (não dá pra atribuir a um worker específico): ${err.message}`,
      );
    });
  }
}

/** Roda um único worker (processo `fork`ado) até o fim — resolve com o
 *  `WorkerResult` recebido via IPC, ou com `{exitCode:1, completedFiles:0}`
 *  se o processo morrer sem mandar mensagem (crash, OOM, kill externo, OU
 *  timeout deste nível — nunca deixa "resultado ausente" virar sucesso,
 *  mesmo princípio do #6822 aplicado ao nível de worker).
 *
 *  Teto de tempo PRÓPRIO deste nível (`fork()` não tem timeout nativo,
 *  diferente de `spawnSync`) — achado do review da PR #6909 (P2, confiança
 *  média): cada BATCH dentro do worker já tem `batchTimeoutMs`+SIGKILL
 *  (dentro de `processChunkedBatches`), mas nada limitava o WORKER inteiro
 *  se ele travasse fora de um `spawnSync` (ex: lendo o payload, entre
 *  batches) — teto = soma dos timeouts de todos os batches do grupo mais
 *  uma margem fixa de startup, nunca infinito.
 *
 *  #6939: a conta acima esquecia o `bisectBudgetMs` — `processChunkedBatches`
 *  roda DENTRO deste worker e pode gastar até esse orçamento inteiro (default
 *  10min, `DEFAULT_BISECT_BUDGET_MS`) numa única chamada a `tryBisect` quando
 *  um batch do grupo trava (Defeito A/B do #6822). Sem somar esse tempo, o
 *  teto do worker estourava e matava (`SIGKILL`) o processo NO MEIO da
 *  bisecção — perdendo o diagnóstico que o #6822 existe pra produzir E
 *  descartando os resultados de batches saudáveis já concluídos no mesmo
 *  grupo (o worker morre sem IPC, `runWorker` devolve
 *  `{exitCode:1, completedFiles:0}` pro grupo inteiro).
 *
 *  stdout/stderr do worker são encanados pro processo pai em tempo real
 *  (`pipe`, forwarded) — múltiplos workers escrevendo ao mesmo tempo
 *  interlaçam no log combinado; tradeoff aceito da opção 1 da issue
 *  (paralelismo dentro de UM processo/job de CI, não shards separados —
 *  decisão nossa ao escolher essa opção, a issue em si não discute
 *  interlaçamento de log explicitamente). Listener de `error` nos streams
 *  (achado do review, P3): sem ele, um erro de stream (ex: EPIPE) derrubaria
 *  o processo PAI inteiro sem a mensagem diagnóstica que todo outro caminho
 *  de falha deste arquivo tem. */
function runWorker(payload: WorkerPayload, scriptPath: string, payloadPath: string): Promise<WorkerResult> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const settle = (result: WorkerResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    const child: ChildProcess = fork(scriptPath, ["--worker", payloadPath], {
      execArgv: ["--import", "tsx"],
      stdio: ["inherit", "pipe", "pipe", "ipc"],
    });
    pipeWorkerStream(child.stdout, process.stdout, "stdout", payload.label);
    pipeWorkerStream(child.stderr, process.stderr, "stderr", payload.label);

    const workerTimeoutMs = computeWorkerTimeoutMs(payload);
    const timer = setTimeout(() => {
      console.error(
        `run-tests: worker (${payload.label}) excedeu o teto de ${workerTimeoutMs}ms sem completar — matando (SIGKILL) e tratando como falha dura.`,
      );
      child.kill("SIGKILL");
      settle({ exitCode: 1, completedFiles: 0, totalPass: 0, totalFail: 0, failedBatches: [`${payload.label} (timeout do worker)`] });
    }, workerTimeoutMs);
    timer.unref?.();

    child.on("message", (msg: unknown) => {
      const m = msg as Partial<WorkerResult> | null;
      if (m && typeof m.exitCode === "number" && typeof m.completedFiles === "number") {
        clearTimeout(timer);
        settle({
          exitCode: m.exitCode,
          completedFiles: m.completedFiles,
          totalPass: typeof m.totalPass === "number" ? m.totalPass : 0,
          totalFail: typeof m.totalFail === "number" ? m.totalFail : 0,
          failedBatches: Array.isArray(m.failedBatches) ? m.failedBatches : [],
        });
      }
    });
    child.on("exit", () => {
      if (!settled) {
        console.error(
          `run-tests: worker (${payload.label}) terminou SEM enviar resultado via IPC (crash, OOM, ou kill externo antes de completar) — tratando como falha dura, 0 arquivos completados neste grupo.`,
        );
      }
      clearTimeout(timer);
      settle({ exitCode: 1, completedFiles: 0, totalPass: 0, totalFail: 0, failedBatches: [`${payload.label} (worker terminou sem enviar resultado)`] });
    });
    child.on("error", (err) => {
      console.error(`run-tests: falha ao iniciar worker (${payload.label}): ${err.message}`);
      clearTimeout(timer);
      settle({ exitCode: 1, completedFiles: 0, totalPass: 0, totalFail: 0, failedBatches: [`${payload.label} (falha ao iniciar worker)`] });
    });
  });
}

/** `spawn`/`stdout`/`stderr` de `RunTestsOptions` ficam de fora do tipo
 *  PÚBLICO aqui — produção nunca os injeta (o caminho `fork()` não tem como
 *  cruzar uma função `spawn` pela fronteira de processo/IPC; só o payload
 *  JSON atravessa). Achado do review da PR #6909 (P3, confiança alta):
 *  isto é só a fronteira do TIPO, não do runtime — a checagem de excesso de
 *  propriedade do TS não se aplica a uma variável já tipada sendo repassada
 *  (só a literais), então um objeto que TENHA essas chaves em runtime ainda
 *  as propaga corretamente pro fallback sequencial (`runTestBatches(opts)`
 *  quando `workerCount<=1`, que aceita `RunTestsOptions` de verdade) — é
 *  assim que `test/run-tests.test.ts` injeta `spawn` fake nesse caminho
 *  de teste, via cast. **Comportamento diverge deliberadamente entre os
 *  dois caminhos**: o fallback sequencial HONRA um `spawn` injetado (não
 *  tem fork nenhum de por meio); o caminho `fork()` real IGNORA
 *  silenciosamente (funções não atravessam IPC) — por isso os 2 testes de
 *  integração real deste módulo usam `scriptPath` (o único hook que o
 *  caminho paralelo de fato aceita) pra apontar pra um script de teste
 *  real, em vez de tentar injetar `spawn`. */
export interface RunTestBatchesParallelOptions extends Omit<RunTestsOptions, "spawn" | "stdout" | "stderr"> {
  /** Quantos processos worker concorrentes — default `DEFAULT_WORKER_COUNT`.
   *  `<= 1` (ou batches insuficientes pra valer a pena) cai no caminho
   *  single-process de sempre (`runTestBatches`), sem overhead de fork. */
  workerCount?: number;
  /** Path absoluto DESTE script — usado pra `fork()`. Injetável pra teste;
   *  default resolve via `import.meta.url` no caller de produção. */
  scriptPath?: string;
}

/** Caminho de produção do #6877: divide os batches entre `workerCount`
 *  processos concorrentes. Cai automaticamente no caminho single-process
 *  (`runTestBatches`, comportamento idêntico a antes do #6877) quando
 *  `workerCount <= 1` ou há batches demais pouco pra valer o overhead de
 *  fork (1 batch só). Assíncrona (fork+IPC são inerentemente async) — o
 *  caminho single-process continua 100% síncrono e é o que os testes deste
 *  arquivo exercitam diretamente. */
export async function runTestBatchesParallel(opts: RunTestBatchesParallelOptions): Promise<number> {
  const {
    files,
    extraArgs = [],
    batchSize = BATCH_SIZE,
    batchTimeoutMs = DEFAULT_BATCH_TIMEOUT_MS,
    bisectTimeoutMs = DEFAULT_BISECT_TIMEOUT_MS,
    bisectBudgetMs = DEFAULT_BISECT_BUDGET_MS,
    workerCount = DEFAULT_WORKER_COUNT,
    scriptPath = fileURLToPath(import.meta.url),
  } = opts;
  if (files.length === 0) return 0;
  const batches = chunk(files, batchSize);
  if (workerCount <= 1 || batches.length <= 1) {
    // Nada a paralelizar (ou paralelismo desligado) — caminho de sempre.
    return runTestBatches(opts);
  }
  const groups = splitIntoWorkerGroups(batches, workerCount);
  const tmpDir = mkdtempSync(join(tmpdir(), "run-tests-workers-"));
  // Review #6909 (P3, confiança média): escrever TODOS os payloads ANTES de
  // dar fork em qualquer worker — se `writeFileSync` lançar no meio do loop
  // (disco cheio, permissão), a versão anterior (escreve+fork intercalados
  // dentro do MESMO `.map`) já tinha disparado `fork()` pros grupos
  // anteriores, que ficariam órfãos (nunca mortos, nunca aguardados) quando
  // a exceção escapasse do `Promise.all`. Separar em duas fases — escrever
  // tudo, DEPOIS forkar tudo — garante que um erro de escrita nunca deixa
  // processo filho nenhum no ar.
  const payloads = groups.map((groupBatches, i): { payload: WorkerPayload; payloadPath: string } => {
    const label = `grupo ${i + 1}/${groups.length}`;
    const payload: WorkerPayload = {
      batches: groupBatches,
      extraArgs,
      batchTimeoutMs,
      bisectTimeoutMs,
      bisectBudgetMs,
      label,
    };
    const payloadPath = join(tmpDir, `worker-${i}.json`);
    writeFileSync(payloadPath, JSON.stringify(payload));
    return { payload, payloadPath };
  });
  try {
    const results = await Promise.all(
      payloads.map(({ payload, payloadPath }) => runWorker(payload, scriptPath, payloadPath)),
    );
    const exitCode = results.some((r) => r.exitCode !== 0) ? 1 : 0;
    const completedFiles = results.reduce((sum, r) => sum + r.completedFiles, 0);
    // #7337: agregado do caminho PARALELO — soma pass/fail e junta os
    // rótulos de batch falho de TODOS os workers, mesmo tratamento do
    // caminho sequencial em `runTestBatches`. Sem isto, o caminho paralelo
    // (produção — `RUN_TESTS_WORKERS` > 1) continuaria com o mesmo problema
    // de origem, só que multiplicado por worker em vez de por batch.
    const totalPass = results.reduce((sum, r) => sum + r.totalPass, 0);
    const totalFail = results.reduce((sum, r) => sum + r.totalFail, 0);
    const failedBatches = results.flatMap((r) => r.failedBatches);
    process.stderr.write(`\n${formatAggregateSummary({ totalPass, totalFail, failedBatches }, batches.length)}\n`);
    return finalizeExitCode(exitCode, completedFiles, files.length, process.stderr);
  } finally {
    // Review #6909 (P2, confiança alta): sem o try/catch PRÓPRIO aqui, uma
    // exceção de `rmSync` (Windows EBUSY/EPERM, glitch de FS) dentro do
    // `finally` OBSCURECE o valor já computado no `try` — o processo sairia
    // reportando "erro inesperado no orquestrador paralelo" (via o `.catch`
    // do caller no CLI) em vez do resultado REAL dos testes, mandando quem
    // depura pro lugar errado. Falha de cleanup nunca deve mascarar/
    // sobrescrever um resultado de teste já decidido — só loga e segue.
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {
      console.error(`run-tests: falha ao limpar diretório temporário ${tmpDir} (não afeta o resultado dos testes): ${(e as Error).message}`);
    }
  }
}

/** Modo worker do CLI — invocado só internamente por `runTestBatchesParallel`
 *  via `fork()`, nunca diretamente por um humano/CI. Lê o payload do
 *  arquivo, processa a fatia de batches com `spawnSync` REAL (não injetado —
 *  produção, não teste), e manda o resultado de volta ao pai via
 *  `process.send`. */
function runAsWorker(payloadPath: string): void {
  const payload = JSON.parse(readFileSync(payloadPath, "utf8")) as WorkerPayload;
  const { exitCode, completedFiles, totalPass, totalFail, failedBatches } = processChunkedBatches(payload.batches, {
    extraArgs: payload.extraArgs,
    batchTimeoutMs: payload.batchTimeoutMs,
    bisectTimeoutMs: payload.bisectTimeoutMs,
    bisectBudgetMs: payload.bisectBudgetMs,
    labelPrefix: payload.label,
  });
  const result: WorkerResult = { exitCode, completedFiles, totalPass, totalFail, failedBatches };
  if (process.send) {
    process.send(result);
  } else {
    // `fork()` sempre estabelece o canal IPC — `process.send` ausente
    // significaria que este processo foi iniciado de outro jeito (nunca
    // deveria acontecer no uso normal). Fail loud, não silencioso.
    console.error("run-tests: modo --worker sem canal IPC (process.send ausente) — inesperado, saindo com falha.");
    process.exitCode = 1;
    return;
  }
  process.exitCode = exitCode;
}

// CLI guard (#cli-guard): só roda como main; importável em testes sem disparar.
if (isMainModule(import.meta.url)) {
  const workerPayloadPath = getArg(process.argv.slice(2), "worker");
  if (workerPayloadPath) {
    // #6877: este processo é um WORKER — despachado internamente por
    // `runTestBatchesParallel` via `fork()`, processa só a sua fatia e
    // reporta de volta via IPC. Nunca invocado assim por um humano/CI.
    runAsWorker(workerPayloadPath);
  } else {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = listTestFiles(root);
    const extraArgs = process.argv.slice(2);
    // #6822: `process.exit(code)` síncrono, chamado logo após o último
    // `stdout.write`/`stderr.write`, pode truncar a cauda do buffer se a
    // escrita ainda não drenou — `process.stdout` é ASSÍNCRONO quando
    // conectado a um pipe não-TTY (o caso normal da CI). `process.exitCode`
    // deixa o processo sair sozinho depois que o event loop esvaziar
    // (inclusive as escritas pendentes e os workers `fork`ados do #6877).
    //
    // #6877: `runTestBatchesParallel` (não mais `runTestBatches` direto)
    // é o caminho de produção — divide em `DEFAULT_WORKER_COUNT` processos
    // concorrentes, com fallback automático pro caminho single-process de
    // sempre quando não há paralelismo a ganhar (`RUN_TESTS_WORKERS=1`,
    // ou 1 batch só). `.catch` nunca deveria disparar (a função só rejeita
    // se `fork()`/IPC lançarem de um jeito não previsto pelos handlers
    // `error`/`exit` de `runWorker`) — mas um wrapper síncrono que decidiu
    // nunca deixar uma rejeição não-tratada sair como crash sem contexto.
    runTestBatchesParallel({ files, extraArgs }).then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        console.error(`run-tests: erro inesperado no orquestrador paralelo: ${(err as Error).message}`);
        process.exitCode = 1;
      },
    );
  }
}
