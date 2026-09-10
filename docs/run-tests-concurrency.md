# Concorrência e prioridade do `npm test` (#7875)

Por que `scripts/run-tests.ts` satura a máquina de propósito, por que **reduzir
a concorrência foi medido e reprovado**, e o que de fato resolve.

## O sintoma que originou

Relato do editor (09/09/2026): *"vários terminais com o node abrem em sequência,
o que deixa a máquina com 100% de processamento"* — no **Windows e no Linux**.

Duas causas distintas produzem esse mesmo sintoma. Não confundir:

| | #7753 (fechada) | #7875 (esta) |
|---|---|---|
| natureza | **vazamento** — netos do `--test-isolation=process` sobreviviam ao SIGKILL do timeout | **regime normal** — rodada saudável, sem vazamento nenhum |
| acúmulo | crescia por dias (11 órfãos de ~4,7 dias, load 20,85 no 300) | some quando o `npm test` termina |
| fix | `killProcessTree` alcança o grupo | prioridade de CPU (abaixo) |

**Discriminador de campo:** a saturação some quando o `npm test` acaba? Se sim,
é regime normal. Se persiste com nada rodando, é vazamento — e aí o fix do
#7753 não pegou tudo, o que é dado novo.

## Quantos processos a suíte roda, e por quê

Três fatores se multiplicam:

| fator | valor | onde |
|---|---|---|
| workers de batch em paralelo | `min(4, nCPU)` | `DEFAULT_WORKER_COUNT` (#6877) |
| concorrência interna de cada `node --test` | `nCPU` (default do Node) | nenhum `--test-concurrency` é passado |
| processos por arquivo | 1 | `--test-isolation=process` (default) |

Produto: **`4 × nCPU` processos em voo**. No Neo (20 cores) são ~80; no 300
(8 cores), ~32. A razão é sempre `min(4, nCPU)` — a concorrência interna
escala com o hardware e a externa é travada em 4 —, e é por isso que o sintoma
reproduz igual em máquinas diferentes.

A conta não tem branch por plataforma: o único `process.platform === "win32"`
em `run-tests.ts` está no `killProcessTree`. O que muda é a *aparência* — no
Windows cada filho aloca um `conhost` (a fila de terminais que se vê), no Linux
só o load sobe.

## O caminho que parecia certo e REPROVOU

A hipótese inicial do #7875: `4 × nCPU` é oversubscription desperdiçada, então
passar `--test-concurrency` para o produto caber em `~nCPU` resolveria.
Implementado e medido — **reprovou**.

Medição no **Neo (20 cores)** — a máquina MAIS potente do projeto; Zenbook e
300 têm bem menos (o 300 tem 8). Caminho paralelo real, 4 workers, 600
arquivos de teste reais, `batchSize` 150 (mesma forma da produção):

| processos em voo | wall clock | batches estourando `DEFAULT_BATCH_TIMEOUT_MS` (300 s) |
|---|---|---|
| 80 (regime atual, 4× cores) | **236,4 s** | 1 |
| 40 (alvo 2× cores) | **>600 s — não terminou** | **4** |

Reduzir pela metade deixou a rodada 2,5× mais lenta *e* fez todos os batches
estourarem o teto de tempo, o que dispara retry e piora ainda mais. Numa rodada
completa da suíte com esse teto, os 4 grupos perderam o batch 2/3 por
`spawn ETIMEDOUT`.

**Por quê:** a suíte é pesada em I/O (leitura de arquivo, spawn, mock de rede).
Oversubscrever compra sobreposição de I/O real — os processos passam boa parte
do tempo bloqueados, não competindo por CPU. O número de processos nunca foi o
problema.

### A medição é do Neo — o que se pode e o que NÃO se pode extrapolar

O número (2,5× mais lento) é do Neo e não deve ser citado como se valesse nas
outras máquinas. **A direção**, essa sim, extrapola com folga: o modo de falha
foi batch estourando um teto de tempo FIXO (300 s). Numa máquina mais fraca
tudo demora mais, então apertar a concorrência lá chega no teto ainda mais
fácil — a reprovação vale *a fortiori* no Zenbook e no 300, sem precisar
remedir.

O que continua **não medido** fora do Neo: qual a folga real contra os 300 s
no regime ATUAL dessas máquinas. Se um batch de 150 arquivos já estiver perto
do teto no Zenbook, isso é fragilidade latente independente deste fix — e o
sintoma seria `spawn ETIMEDOUT` em batch que ninguém mexeu. Medir antes de
mexer em `BATCH_SIZE` ou `DEFAULT_BATCH_TIMEOUT_MS`.

### Armadilha de medição (o erro que quase fechou a conclusão errada)

A primeira medição rodou `--test-concurrency=N` num `node --test` **sozinho** e
concluiu que o joelho era 10:

| `--test-concurrency` (1 worker só) | wall clock |
|---|---|
| 5 | 17,1 s |
| 10 | 11,8 s |
| 20 | 11,9 s |

Isso mede a coisa errada: com 1 worker, `--test-concurrency=5` significa **5
processos em voo numa máquina de 20 cores** — lento por subutilização, não por
teto apertado. Em produção rodam 4 workers, então o que está em voo é o
*produto*. **Medir concorrência de teste sempre no caminho paralelo real**, com
o mesmo `workerCount` da produção; um `node --test` isolado não representa o
regime.

## O que de fato resolve: prioridade, não concorrência

O problema nunca foi o número de processos — foi eles disputarem CPU **de igual
para igual** com o trabalho interativo do editor. `run-tests.ts` chama
`lowerOwnPriority()` no entrypoint, antes de qualquer fork/spawn, e toda a
árvore herda (medido: filho de processo em `BELOW_NORMAL` nasce em
`BELOW_NORMAL`; no POSIX é o `nice` herdado).

Resultado: a suíte continua usando a máquina inteira quando ela está ociosa
(**zero custo de wall clock**), mas terminal, editor e browser preemptam. É a
diferença entre "100% de CPU", que é o esperado numa suíte, e "máquina
travada", que era o relato.

| env | efeito |
|---|---|
| (nenhuma) | `BELOW_NORMAL` — default |
| `RUN_TESTS_PRIORITY=low` | desce mais |
| `RUN_TESTS_PRIORITY=normal` | desliga |
| `RUN_TESTS_WORKERS=1` | caminho single-process (menos processos, mais lento) |

`setPriority` é best-effort: lança `EACCES`/`EPERM` em container sem
`CAP_SYS_NICE`, e nesse caso a suíte roda normal, só não cede CPU.

## Antes de "otimizar" isto de novo

Reduzir concorrência já foi tentado e medido. Se for reabrir, o ônus é
apresentar medição **no caminho paralelo real** que mostre wall clock não pior
que o atual e nenhum batch estourando os 300 s — não um benchmark de `node
--test` isolado. `test/run-tests.test.ts` trava o mecanismo atual em
`describe("prioridade de CPU (#7875)")`.
