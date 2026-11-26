# Regras do coordenador das rodadas autônomas (overnight + develop + continuo)

Critérios e passos que só o **coordenador** top-level de `/diaria-overnight`,
`/diaria-develop` e `/diaria-continuo` executa: agrupamento em lotes,
triagem, claims, preflights antes do dispatch, contorno de worktree, gates de
relatório, merge-gate. Separado de `context/overnight-dispatch-rules.md` no
#14043: os subagentes (`dev-implementador`, `dev-fixer`) leem só aquele
arquivo; o coordenador lê os dois. A numeração é a mesma nos dois arquivos
(item N aqui = item N citado como "de `context/overnight-dispatch-rules.md`"
em skills, scripts e hooks). Itens divididos (9, 11, 32, 33, 35, 36) têm a parte
do implementador lá e a do coordenador aqui. Os incidentes e medições que
motivaram as regras estão em `docs/rodadas-autonomas-historico.md` (âncoras
`dr-*`).

---

## 9. Status ao editor: PR mergeado com `REFS` não é issue fechada (parte do coordenador)

A parte do implementador fica no item 9 de `context/overnight-dispatch-rules.md`.

**"PR mergeado com `REFS`" e "issue fechada" são estados DIFERENTES (#5327
item 2).** Antes de qualquer resumo de status ao editor que mencione uma issue
como "fechada"/"resolvida", confirmar via `gh issue view {N} --json state` —
nunca assumir a partir de "eu dispatchei um PR pra ela" (histórico: `docs/rodadas-autonomas-historico.md#dr-5327-2`).

## 11. Merge-gate, threads de self-review P2/P3 e relatório depois do último merge (parte do coordenador)

A parte do implementador fica no item 11 de `context/overnight-dispatch-rules.md`.

**Merge-gate: resolver review threads antes de `gh pr merge` (#5327 item 4).** Isto é trabalho do COORDENADOR (não do subagente implementador, que nunca chega perto de `gh pr merge`). `gh pr merge --squash` pode
falhar com "base branch policy prohibits the merge" mesmo com CI verde e sem
exigência de aprovação (`required_approving_review_count: 0` no ruleset) —
a causa real é `required_review_thread_resolution: true`: comentários de
review inline (self-review do subagente, findings do review consolidado)
ficam como threads não-resolvidas e bloqueiam o merge até alguém resolver
via GraphQL. Antes de `gh pr merge`, resolver todos os review threads
pendentes com o helper, nunca com `gh api graphql` à mão (#11235: o overnight
agendado roda em `acceptEdits` e o allow list não libera `gh api graphql`,
que permitiria qualquer mutation). O repo é o DO PR (`--repo
vjpixel/diaria-design` para PR de issue do design, #10618 fatia 4; sem
`--repo`, o diaria-studio); `owner`/`name`/`pr` vão como variável do GraphQL
dentro do script:
```
npx tsx scripts/resolve-review-threads.ts --pr N [--repo owner/name] --list
npx tsx scripts/resolve-review-threads.ts --pr N [--repo owner/name]
```
O segundo resolve as não-resolvidas da automação (`resolveReviewThread`), relê
numa query fresca e sai `0` só sem thread bloqueante (FORBIDDEN de revisor
externo não conta, sai listada em `forbidden`). "Da automação" (#11269) = todos
os comentários da thread carregam o marcador `<!-- diaria-auto-review -->`, que
`gh-pr-review-api.ts comment|reply` acrescenta sozinho; thread do editor (ou
em que ele respondeu) sai em `skipped`, continua aberta e o helper sai `1`.
O login do autor não serve de filtro: a rodada posta com o token do dono. É passo de RESOLUÇÃO, pós-fixer. O gate
de merge é outra chamada, somente leitura: `npx tsx
scripts/resolve-review-threads.ts --pr N [--repo owner/name] --check` (sai
`1` se sobrar thread não resolvida que não seja de revisor externo). Nunca
usar o modo de resolução como gate: ele apagaria a thread que o editor deixou
aberta e aprovaria o PR sozinho.

**Threads de self-review P2/P3 sem fixer (#11461).** Sem isso, threads P3 do self-review deixam PRs com CI verde em `BLOCKED` (histórico: `docs/rodadas-autonomas-historico.md#dr-11461`). Quando a unidade não passa por fixer, o
coordenador resolve com `npx tsx scripts/resolve-review-threads.ts --pr N
--low-severity-only`: só as threads da automação com finding P2/P3 sem
confiança alta saem resolvidas; P0/P1, confiança alta e finding sem
severidade reconhecível ficam em `held`, abertas. O JSON traz
`resolvedFindings` (trecho de cada finding resolvido) para o resíduo ir ao
relatório ou a uma issue de follow-up. O trem faz o mesmo com
`run-merge-train.ts --resolve-low-severity-threads`. Por isso o self-review
(item 7) tagueia cada finding com confiança e severidade ("Confiança média,
P3: ..."): finding sem tag é retido, nunca resolvido às cegas.

**Relatório depois do último merge (#11461).** O `report.md` é escrito num
instante e o trem pode mergear depois. `npx tsx
scripts/reconcile-overnight-report.ts --report data/overnight/{AAMMDD}/report.md`
grava no fim do arquivo o estado real de cada PR da rodada (bloco
idempotente); `run-merge-train.ts --report <path>` roda o mesmo ao terminar.

## 15. Critérios de agrupamento em lotes (#2024, #3453 Rec 3, teto #2754)

**Escopo diferente dos itens 1-13 acima**: estes não são regras que o
subagente implementador segue — são o critério que o **coordenador**
(overnight/develop/continuo) usa para decidir se agrupa issues numa única
unidade de trabalho *antes* de dispatchar. Colocado aqui, e não só na Fase 0
do `.claude/skills/diaria-overnight/SKILL.md` (107KB), porque `continuo`
(que não tem Fase 0/briefing único) e `develop` precisam do mesmo critério
sem pagar o custo de abrir o SKILL.md inteiro do overnight (#5344 Parte B3).
A versão do overnight (Fase 0, passo 6) segue sendo a autoritativa para o
formato do briefing/exemplo de plano — esta seção é o critério em si,
citável por qualquer coordenador desta linha de skills.

Uma **unidade de trabalho** pode ser uma issue solo ou um **lote coeso** de
várias issues. Dois critérios de agrupamento, ambos válidos (não
excludentes):

- **(a) Coesão de subsistema** — mesmas issues tocam o mesmo
  subsistema/arquivos, mesma natureza (ex: "DS/email", "playbooks Stage 4",
  "validator").
- **(b) Baixo-risco + baixo-blast-radius (#3453 Rec 3)** — issues pequenas e
  de baixo blast radius podem compartilhar 1 subagente **mesmo sem relação
  temática**: docs-only, comment-only, mudança isolada em 1
  `.claude/agents/*.md`, tweak de 1 config. O ganho vem do **bootstrap
  amortizado** (`npm ci`, exploração de convenções), não da coesão
  editorial — "não são do mesmo subsistema" **não** é motivo pra deixar
  solo se as duas são seguras e pequenas. (histórico: `docs/rodadas-autonomas-historico.md#dr-3453-3`)

**Critérios comuns a (a) e (b):** o lote inteiro cabe numa revisão de diff
única; nenhuma issue do lote conflita com outra (arquivos disjuntos).
**Teto = cabe sem forçar compaction de contexto do subagente implementador,
não um número fixo de issues** (#2754 — o objetivo é otimizar tokens, não
tempo; um subagente maior amortiza custo fixo de bootstrap sobre mais
itens, saindo mais barato por item do que N subagentes solo repetindo esse
bootstrap (histórico: `docs/rodadas-autonomas-historico.md#dr-2754`)). Sinal
prático de teto estourado: o subagente reportar compaction no meio da
sessão, ou a lista de arquivos tocados ultrapassar ~15-20. Issues
grandes/arriscadas (P1, blast radius alto, migrações) ficam **solo** — o
batching é só pras pequenas/médias. Cada lote vira 1 PR (`Closes #A,
closes #B, ...`); como o merge fecha todas as issues do lote, o review leve
do coordenador confere que o diff cobre de fato **todas** elas.

**O agrupamento é decisão autônoma do coordenador em toda skill, nunca `AskUserQuestion` (#8907, 28/09/2026)** — overnight gravava `batch_approval: "editor_approved" | "editor_adjusted" | "default_proposed"` até #8907; hoje grava sempre `"autonomous"` (valores antigos só em planos legados). `continuo` já seguia esse modelo antes (nunca teve briefing, sempre `"default_proposed"`) — os dois convergem no mesmo comportamento: o coordenador decide pelos critérios acima e informa, sem opção de resposta (ver `.claude/skills/diaria-continuo/SKILL.md`, "Loop invariável" passo 1).

## 16. Viés de autoria e confiança em PR alheio (#5484)

**Escopo diferente dos itens 1-14**: este item, como o 15, é critério do
**coordenador** (overnight/develop/continuo) — quem decide se dispatcha ou
adia uma issue — não do subagente implementador. Dois padrões (histórico: `docs/rodadas-autonomas-historico.md#dr-5484`):

**(a) Issue de autoria da própria sessão nunca recebe tratamento mais
permissivo que issue de terceiro.** Ter escrito a issue (overnight, develop
ou continuo — inclusive com sugestão de implementação já no corpo) não é
motivo pra adiar — se algo, é o oposto: mais contexto prévio é menos
justificativa pra adiar, não mais. "Exige decisão de design", "melhor numa
rodada com mais contexto dedicado" ou equivalente só valem como razão pra
não dispatchar se batem **literalmente** um dos 4 critérios de "Perguntar é
exceção" do `CLAUDE.md` (irreversível pra terceiros; trade-off editorial
genuíno que muda a experiência do leitor; gasto real acima do trivial; a
resposta muda materialmente o trabalho) — os mesmos critérios usados pra
issue de terceiro, sem exceção implícita de "precisa amadurecer". Sem
nenhum dos 4 batendo: dispatchar, não anotar pra depois.

**(b) "Já existe PR aberto" não é bloqueio por si só — exige checagem
antes de virar razão pra não agir.** Ver a existência de um PR de outro
autor cobrindo a issue e concluir "não é meu, deixo pro editor" sem checar
nada é o mesmo erro do item 14 em sentido inverso — lá o preflight existe
pra evitar duplicar trabalho; aqui, sem esse mesmo preflight aplicado com
julgamento, um PR alheio vira desculpa pra não entregar. Antes de aceitar
"já existe PR" como razão pra pular a issue, checar as 3 perguntas — **as
3 juntas** justificam esperar; falhando qualquer uma, tratar como se o PR
não existisse e avaliar implementação independente na mesma respiração:

1. **Autor é o editor ou colaborador conhecido do projeto?** (`gh pr view N
   --json author` — um handle nunca visto antes, ex. contribuidor externo
   de primeira contribuição, falha este ponto.)
2. **CI está rodando ou verde?** (`gh pr checks N` — "aprovação de workflow
   pendente" em PR de fork de primeira vez, típico de contribuidor
   desconhecido, falha este ponto.)
3. **Atualizado nas últimas ~24-48h?** (`gh pr view N --json updatedAt` —
   PR parado há dias é sinal de abandono, falha este ponto.)

**Exceção: PR das lanes autônomas (`overnight/`, `develop/`, `continuo/`) segue
o `orphanAction` ANTES das perguntas 2 e 3 (#12950).** CI vermelho ou PR parada
1-2 dias não viram reimplementação: viram `despachar-fixer`, `merge-via-gate2`
ou `editor` (item 28). Este checklist segue valendo inteiro para PR de terceiro
ou manual.

**Nota:** um gate mecânico de re-triagem (item do #5476 relacionado) não
cobre este item — reavaliar a MESMA issue com o MESMO critério errado
produz a MESMA conclusão errada. O que fecha a lacuna é aplicar o checklist
acima **antes** de decidir adiar, não repetir a decisão depois.

## 17. Fim de turno: nunca pergunte se deve continuar (#5721)

Mesmo espírito da regra 11 (nenhum subagente espera confirmação pra mergear),
mas para o **coordenador**, no texto de resposta ao editor: ao terminar uma
unidade de trabalho com outras ainda pendentes no `target_set`/plano da
rodada, **continue e informe depois** — nunca feche o turno com uma pergunta
pedindo permissão pra seguir. "Quer que eu siga nelas agora?", "posso
prosseguir?", "devo atacar as demais?" são a mesma confirmação pós-sucesso já
proibida pelo CLAUDE.md (seção "Perguntar é exceção", #5321) — nenhum dos 4
critérios que justificam parar (irreversível pra terceiros, trade-off
editorial genuíno, gasto real acima do trivial, resposta muda materialmente
o trabalho) se aplica a "seguir para a próxima issue já aprovada no plano".

**Forma correta — substituição, não só proibição:** informar o que vai ser
feito, não perguntar se pode ("Sigo para #5419 e #5692" no lugar de "quer que
eu siga nelas agora?"). Não há ponto de interceptação mecânico (é texto livre) (histórico: `docs/rodadas-autonomas-historico.md#dr-5721`).

**Mesma regra vale ao responder uma mensagem ESPONTÂNEA do editor no meio da
rodada, não só ao terminar uma unidade de trabalho (#7886).** Uma pergunta de
status do editor ("como está?") é legítima de responder a qualquer momento —
o que NÃO é legítimo é a resposta terminar oferecendo continuar como se fosse
uma decisão em aberto. **Antes de formular a resposta, reconsultar
`plan.json` → `loop_estendido`** (e, em plano legado anterior a #8907,
`batch_approval`): se `loop_estendido: true` (ou o legado `batch_approval`
já registrava aprovação), "quer que eu retome despachando mais issues, ou
prefere que eu pare por aqui?" já tem resposta gravada — não
é pergunta nova, é a mesma pergunta pós-sucesso da regra acima, só que
disparada por uma interrupção do editor em vez de pelo fim de uma unidade.
Responder com "Sigo despachando X e Y" (informar, retomando de fato), nunca
com uma pergunta que reabre algo já decidido (histórico: `docs/rodadas-autonomas-historico.md#dr-7886`).

## 18. `session-registry.ts claim-issue`/`is-claimed` — nunca em comando encadeado (#5751)

**Escopo diferente dos itens 1-14**: como os itens 15-17, este é critério do
**coordenador** (overnight/develop/continuo) — é ele quem chama
`session-registry.ts`, não o subagente implementador. `.claude/hooks/
inject-session-id.mjs` só injeta `--session-id` em comando **NÃO-encadeado**
(`isChainedCommand` rejeita qualquer `&&`/`;`/`|`/newline, de propósito — ver
o comentário do próprio hook) — chamar `claim-issue`/`is-claimed` dentro de
um pipe (`... | head`), com `&&`/`;`, ou dentro de um heredoc/bloco composto
faz a injeção **não acontecer**. O script já falha alto quando isso acontece
(`requireSessionId` em `scripts/lib/session-registry.ts` lança erro
explícito + `process.exitCode = 1` — avaliado e decidido **não** endurecer
mais que isso, #5751: a mensagem já explica a causa raiz e já não tem
workaround silencioso possível), mas um comando composto pode devolver esse
erro num ponto onde o coordenador não olha o exit code (ex: só lê o
`stdout` truncado por `| head`, sem checar `stderr`/exit code) — e se o erro
for ignorado, a reivindicação nunca aconteceu, mas o fluxo segue como se
tivesse reivindicado, reabrindo exatamente a corrida entre sessões que
`claim-issue` existe pra evitar (histórico: `docs/rodadas-autonomas-historico.md#dr-5751`).

**Regra:** chamar `session-registry.ts is-claimed`/`claim-issue` sempre como
comando **standalone** — nunca dentro de `&&`/`;`/pipe/heredoc. Se o comando
retornar erro (`session-registry: erro — --session-id ausente...` no
stderr, ou `exit 1`), tratar como **falha real da reivindicação**, nunca
como ruído a ignorar — parar e diagnosticar antes de seguir pro dispatch,
mesma disciplina de qualquer outro `exit 1` inesperado.

**Onda inteira num claim só (#12010):** para reivindicar as issues de uma
onda antes do fan-out, usar `npx tsx scripts/lib/session-registry.ts
claim-issue --kind {kind} --issues A,B,C` (também standalone), nunca N
`claim-issue --issue` seguidos ou em paralelo: cada escrita é um rename na âncora sincronizada, e a rajada de renames vira `-safeBackup-NNNN` no OneDrive (histórico: `docs/rodadas-autonomas-historico.md#dr-12010`). O `--issues`
grava a onda numa escrita, imprime uma linha por issue e sai `exit 1` se
alguma não terminou reivindicada (as outras ficam reivindicadas; tratar a
recusada como no `--issue`).

**E solta num unclaim só (#12166):** para soltar as issues de uma onda (as
mergeadas no trem, ou as que saíram da onda por uma recusa), `npx tsx
scripts/lib/session-registry.ts unclaim-issue --kind {kind} --issues A,B,C`,
standalone, uma escrita na âncora pelo mesmo motivo; uma linha por issue,
`exit 1` se alguma não estava reivindicada por esta sessão (as outras saem
liberadas mesmo assim). Nunca N `unclaim-issue --issue` seguidos.

**Claim que atravessa máquina (#13154):** o registro vive em `data/sessions/`
e só chega à outra máquina quando o sync replica (histórico: `docs/rodadas-autonomas-historico.md#dr-13154`).
Por isso, logo depois do `claim-issue` e imediatamente antes do dispatch, o
coordenador roda `npx tsx scripts/check-pre-dispatch-claim.ts --issues A,B,C
--session-id {id} --kind {kind} --announce` (standalone): reconfere
`is-claimed`, PR aberta (mesma lógica do item 28) e o marcador de claim
gravado como comentário na issue (`scripts/lib/github-claim-marker.ts`), e
grava o marcador desta sessão nas livres. `exit 1` = ocupada (`reasons`
diz por quem), `exit 2` = não verificável (nunca tratar como livre). Ao soltar,
`--release` junto do `unclaim-issue`.

**`--release` em todo caminho de saída, não só no merge (#13172).** A claim
no GitHub vale 24h e só o `--release` a cancela na hora. Rodar
`check-pre-dispatch-claim.ts --issues {...} --session-id {id} --release`
(standalone) quando a unidade sai `pulada` depois do `--announce` (qualquer
motivo), quando o implementador falha, quando a PR fecha sem merge e, no
encerramento da rodada, ANTES do `session-registry.ts end`, com todas as
issues reivindicadas na rodada (idempotente: só grava onde a claim desta
sessão segue ativa). Sem isso o `/diaria-develop --issues N` da manhã recebe
`github-claim` de uma sessão já encerrada e pula a issue até a claim expirar.
Rede de segurança: o script ignora a claim cuja sessão
`data/session-lifecycle.jsonl` mostra encerrada depois do `at` dela, mas o log
só chega à outra máquina quando o sync replica.

**Rotear para fora do track solta a claim (#13605).** `route-issue.ts` solta
sozinho, depois de um roteamento validado, a claim da PRÓPRIA sessão que
roteia quando o kind dela não é do track de destino (`overnight` mantém
`overnight`/`continuo`, `develop` mantém `develop`/`interactive`, os demais
soltam todas): release no GitHub e `unclaim` no registro desta máquina. Sem
isso, o overnight que roteava uma issue para develop deixava a sessão develop
com `github-claim` por até 24h. Claim de OUTRA sessão viva nunca sai (#13671:
o overnight triando a issue soltava a claim de uma `/diaria-develop` que a
implementava, e o dispatch seguinte saía duplicado). A identidade vem do
`--session-id` que o hook `inject-session-id.mjs` injeta na chamada
standalone; encadeada ou sem a flag, o roteamento vale e nenhuma claim sai.
Um `unclaim-issue` posterior dessa issue pela sessão que roteou devolve
`no-op-not-claimed` (esperado); `--keep-claim` desliga o passo.

**Corrida entre dois `--announce` (#13172).** Depois de postar, o script relê
os comentários. Se outra sessão postou uma claim mais antiga entre a
conferência e o post, esta cede: grava o próprio release e sai `exit 1` com
`github-claim-race` em `reasons` (tratar como `claimed-por-outra-sessao`,
soltando a claim do registro com `unclaim-issue`). Releitura que falha sai
`exit 2`, também com release da claim recém-postada.

## 21. Preflight de duplicidade do lado do COORDENADOR — antes do dispatch (#7020)

**Escopo diferente do item 14 acima**: aquele é regra do subagente
implementador (roda DEPOIS do dispatch, como rede de segurança). Este é
critério do **coordenador** (overnight, develop, continuo) — roda ANTES de
abrir worktree/dispatchar, pra nunca pagar um subagente inteiro só para
descobrir que a issue já estava resolvida em `master`.

`git log --all --grep` inclui refs de PR fechada/branch nunca mergeada: nunca usar `--all` para concluir que algo está em `master` (histórico: `docs/rodadas-autonomas-historico.md#dr-7020`).

**Mecanismo:** `npx tsx scripts/check-issue-duplicate-preflight.ts --issue N
[--updated-at {updatedAt da issue}]` — CLI fino sobre
`scripts/lib/issue-duplicate-preflight.ts` (`assessDuplicatePreflight`,
puro) + `scripts/lib/master-commit-fetch.ts` (fetch real via `git log
origin/master --grep "#N"` — **sempre `origin/master`, nunca `--all`**,
esse é o detalhe que evita reproduzir o erro que o preflight existe pra
prevenir). Custa um `git log`, não um subagente.

Três vereditos exclusivos:

- **`not-in-master`** (exit 0) — nenhum commit em `origin/master` cita a
  issue. Sem indício de duplicidade, dispatch normal.
- **`closes-should-be-closed`** (exit 1) — algum commit em `origin/master`
  já usa `Closes #N` pra essa issue e ela segue aberta. Sinal forte de "já
  resolvida por completo": não dispatchar o escopo cheio — tratar como
  unidade de **CLOSEOUT barata** (confirmar que o commit de fato cobre o
  pedido, comentar e fechar, sem abrir worktree/subagente pra reimplementar
  o que já está em master).
- **`refs-declared-residue`** (exit 1) — commit já cita `#N` sem `Closes`
  (resíduo declarado via `Refs #N, NÃO CLOSES`, ou marcador ausente/
  incidental). Reler o corpo da issue contra o diff desse commit e
  dispatchar só o **resíduo real** que falta — nunca o escopo original
  inteiro.

`resolvedAfterLastUpdate: true` no resultado (o commit mais recente que cita
a issue é posterior ao `updatedAt` dela) é sinal reforçado de "resolvida
depois, ninguém reavaliou" — citar isso no comentário de closeout/redução de
escopo.

**Onde plugar:** logo depois de classificar uma issue como candidata a
dispatch (overnight: Fase 0 passo 4, "Classificar", pra toda issue que sai
`elegivel`; develop: Fase 1 passo 4, "Compor a onda", pra cada issue da onda
antes do fan-out; continuo: passo 1 do "Loop invariável", "Trabalhar a fila
desbloqueada", antes de dispatchar cada unidade — ver o `SKILL.md` de cada
skill pro texto exato). O preflight do subagente (item 14) **continua como
rede de segurança** — não é substituído por este passo, só deixa de ser a
primeira linha de defesa.

## 22. `isolation: worktree` recusado alegando metadata git irresolvível — não é corrupção (#7089)

**Sintoma:** dispatch de subagente com `isolation: worktree` falha com uma
mensagem que soa como corrupção de `.git`:

```
Refusing to use <path>\.claude\worktrees\agent-<id> as an isolation worktree:
the protected checkout <path> has git metadata that could not be resolved,
so its git identity could not be verified. Isolation is refused rather than
assumed — recreate the worktree (or remove the corrupt .git entry) and retry.
```

O texto da mensagem manda procurar `.git` corrompido; na prática o git do checkout está saudável (histórico: `docs/rodadas-autonomas-historico.md#dr-7089`).

**Discriminador — confirme em segundos antes de investigar corrupção:**

```
git rev-parse --git-dir          # deve resolver limpo (ex: .git)
git worktree list                # não deve travar/errar
git worktree prune --dry-run -v  # vazio = nada órfão a podar
```

Se os três rodam limpo, o `.git` **não** está corrompido — a recusa do
harness é conservadora por desenho ("Isolation is refused rather than
assumed") e a causa mais provável é contenção sob concorrência alta (dezenas
de worktrees registradas + múltiplos subagentes lendo/escrevendo metadata do
mesmo repositório ao mesmo tempo), não dano real. A causa raiz é do harness,
fora deste repo — não tentar consertar aqui.

**Contorno:** criar o worktree à mão, fora do caminho que o harness recusou,
e dispatchar o subagente **sem** `isolation`, com o `cd` explícito nele:

```
git worktree add -b <branch> .claude/worktrees/<nome> origin/master
```

seguido de dispatch normal (`Agent`, sem `isolation`) instruindo o subagente
a rodar todo `git`/build/teste com cwd dentro de
`.claude/worktrees/<nome>` e **proibindo explicitamente** que ele toque no
checkout principal compartilhado. Se nem o `git worktree add` à mão serve
(a plataforma não cria worktree nenhum), ver o item 33: clone próprio por
unidade.

**O que NÃO fazer:** não rodar `git worktree prune` nem qualquer reparo
agressivo (recriar `.git`, `git worktree remove --force` de entradas
alheias) no checkout COMPARTILHADO por causa desse erro. O git está
saudável — reparar o que não está quebrado é o que arrisca corromper
trabalho de OUTRA sessão que estiver usando o mesmo checkout ao mesmo tempo
(mesma classe de risco do item 20 acima, só que via comando de reparo em vez
de `rm`).

## 24. Reconciliar `depends-on:` antes de classificar (#7137)

**Escopo diferente da maioria dos itens acima**: como os itens 15/21, este é
critério do **coordenador** (overnight, develop, continuo) — roda ANTES da
classificação via `classifyExecTrack` (mesmo ponto de invocação do item 21,
Fase 0 passo 4/4a do overnight, Fase 1 passo 4 do develop, passo 1 do "Loop
invariável" do continuo).

`classifyExecTrack` só lê labels/marcadores, nunca prosa (histórico: `docs/rodadas-autonomas-historico.md#dr-7137-depends`). O marcador `<!-- depends-on: #N -->` (`scripts/lib/issue-depends-on.ts`)
resolve a declaração; a label `dependencia-aberta`
(`DEPENDS_ON_BLOCK_LABEL`, `scripts/lib/issue-exec-track.ts`) resolve a
classificação — mas as duas só ficam sincronizadas se algo RODAR a
reconciliação antes de qualquer sessão classificar o backlog.

**Mecanismo:** `npx tsx scripts/reconcile-issue-dependencies.ts --apply --repos all`
(#10901: `--repos all` reconcilia também as issues do diaria-design, cada
`depends-on: #N` resolvido no repo da própria issue; sem `--repos`, só o studio)
(dry-run sem `--apply` — nunca rodar sem a flag numa rodada automatizada,
senão nenhuma label muda). Varre o backlog aberto, lê `depends-on:` de cada
issue, consulta o estado real de cada dependência via `gh`, e
aplica/remove `dependencia-aberta` — nunca remove por falha de consulta
(dependência com estado indeterminado é tratada como ainda aberta,
`scripts/lib/issue-depends-on.ts`).

Custa uma varredura de `gh issue list` + 1 `gh issue view` por dependência
única referenciada — não um subagente. Rodar 1× por rodada, no início da
classificação, é suficiente (o mecanismo é idempotente — reconciliar de novo
sem nada ter mudado não produz nenhum `gh issue edit`).

## 25. Gate de drift de label de decisão (#5892) — consolidado overnight/develop (#7128)

Antes de compilar o relatório (mesma filosofia dos demais gates acima),
rodar `npx tsx scripts/check-decision-label-drift-gate.ts --plan
{plan_path}` — ver "Onde plugar" no fim deste item pro `{plan_path}` de
cada skill.

Usa a lógica de `scripts/lib/decision-label-drift.ts` (#5589) pra detectar
drift entre a prosa da rodada/sessão e as labels estruturais atuais (ex:
comentário diz "aguardando pré-requisito" mas `not-this-week` ausente;
"trade-off-real" em prosa mas label `trade-off-real` ausente; "bloqueio
externo" mas `external-blocker` ausente; **prosa de guard de execução —
"guard de publicação", "fora do escopo do overnight", "envio real" — mas
nem `develop-track` nem `bloqueio-execucao` aplicada, #5955**).

**Duas fontes de prosa, com alcances diferentes (#5955):** comentários das
issues `in_round: true`, como sempre; e os campos `motivo`/`scope_note` do
`plan.json` de **todas** as issues do plano, **inclusive `in_round:
false`** — que são justamente as excluídas antes do despacho
(`bloqueada-externa`, `fora-do-escopo`, `ambígua/trade-off-real`), ou
seja, as mais propensas a carregar um veredito que nunca virou label. A
coluna `fonte` no output diz de qual das duas veio cada achado.

**Só bloqueia por issue que AINDA classifica como `overnight`** (#5955):
se a issue já está roteada pra outro track — `on-hold`,
`external-blocker`, marcador `aguardando-ate:` — a label que falta não
muda o roteamento, então não trava a compilação (o CLI de auditoria
`check-decision-label-drift.ts` continua reportando esses casos).

`exit 0` (nenhum drift) → seguir para o próximo passo normal da skill.
`exit 1` (drift detectado) → listar achados com issue, padrão, labels
esperadas e trecho do comentário; **aplicar as labels estruturais
faltantes** (`gh issue edit N --add-label ...` — reconciliação de
auditoria sobre labels arbitrárias apontadas pelo script, não roteamento
de track desta sessão) nas issues reportadas antes de continuar — o gate
é auditoria (heurística por regex, não NLP), então a decisão final de
aplicar é humana, mas o relatório NÃO compila enquanto houver achados não
resolvidos. Sem `gh`/rede, o comando degrada sozinho pra warning + `exit 0`
(fail-soft #738); `--skip-gh-checks` faz o mesmo proativamente.

**Onde plugar:** mesmo script, mesmo comportamento nas duas skills — só o
`{plan_path}` e o "próximo passo normal" mudam:
- **Overnight** (passo 0.8 da Fase 2): `{plan_path}` =
  `data/overnight/{AAMMDD}/plan.json`; próximo passo = passo 1 da mesma
  fase.
- **Develop**: `{plan_path}` = `data/develop/{AAMMDD}/plan.json`; próximo
  passo = compilação do relatório.

## 26. Lint de prosa de dependência sem marcador (#7137 item 4) — AUDITORIA, nunca gate

Roda logo depois do item 25 (gate de drift de label), mesma fase, mas com
uma diferença deliberada: **nunca bloqueia** — sempre `exit 0`, mesmo com
achados. `npx tsx scripts/check-dependency-prose-lint.ts --repos all` (sem `--plan`;
varre o backlog aberto inteiro via `gh issue list`, não o `plan.json` da
rodada) reporta issues que citam prosa de dependência ("pré-requisito",
"depende do #N", "depois que #N", "só depois") sem carregar o marcador
`<!-- depends-on: #N -->` (item 24 acima, `reconcile-issue-dependencies.ts`).

Histórico: `docs/rodadas-autonomas-historico.md#dr-7137-lint`.

**Por que não bloqueia, ao contrário do item 25:** a correção de um achado
do gate de drift (item 25) é mecânica — aplicar a label estrutural que o
próprio padrão já nomeia. Aqui a correção exige JULGAMENTO: decidir se a
prosa casada é dependência genuína (e, se for, qual `#N` vai no marcador)
ou frase comum sem relação nenhuma ("antes de publicar", que não referencia
issue alguma mas ainda pode casar um padrão frouxo). Forçar bloqueio sobre
uma heurística de baixa precisão trocaria "issue presa sem marcador" pelo
problema pior de "rodada presa por causa de uma frase comum". Os achados
entram como linha informativa no relatório da rodada — nunca travam nada,
nunca voltam a Fase 1. Falso positivo revisado: gravar
`<!-- dependency-prose-ok -->` no corpo (#12084) para não repetir a triagem
nas próximas rodadas. Ao introduzir nova prosa de dependência, remover o
marcador e revisar novamente. O marcador só dispensa este lint; não altera
dependências estruturadas nem a classificação de execução. Racional completo: `scripts/lib/dependency-prose-lint.ts`.

**Onde plugar:** passo 0.95 da Fase 2 do overnight (logo após o item 25);
mesma posição, sem numeração formal, no develop (`.claude/skills/diaria-develop/SKILL.md`,
logo após a linha do gate de drift de label). `continuo` não chama isto,
mesmo critério do item 25 acima (a skill não tem a Fase 2 de relatório
onde os outros gates rodam).

## 28. Preflight de duplicidade contra PR ABERTA — companion do item 21 (#7788)

**Escopo:** mesmo lugar do item 21 (roda ANTES de abrir worktree/dispatchar,
do lado do coordenador), cobrindo um estado que o item 21 **não vê por
desenho**: o item 21 só enxerga trabalho já MERGEADO
(`git log origin/master --grep "#N"`). Uma **PR aberta** cobrindo a mesma
issue — trabalho em voo, cuja sessão que a abriu já pode ter terminado — é
invisível pra ele. É o estado mais comum numa lane que abre PR a cada ~60min
e drena a cada ~120min (`/diaria-continuo`): a claim (`is-claimed`) caduca
junto com a sessão, mas a PR segue aberta (histórico: `docs/rodadas-autonomas-historico.md#dr-7788`).

**Mecanismo:** `npx tsx scripts/check-issue-open-pr.ts --issue N` — CLI fino
sobre `scripts/lib/issue-open-pr-check.ts` (`assessOpenPrCoverage`, puro) +
`scripts/lib/gh-open-pr-fetch.ts` (fetch real via `gh pr list --state open`,
1 chamada, sem paginar por issue). Mira **duas vias** de match, porque cada
uma sozinha tem ponto cego: número da issue (`#N`, boundary de dígito — `#77`
nunca casa com `#7788`) no título/corpo da PR, **e** padrão de branch
(`*fix-{N}*`, `*feat-{N}*` — a convenção das lanes autônomas; as duas PRs
que motivaram a issue só casavam por esta via, sem `#N` no título).

Três vereditos exclusivos:

- **`no-open-pr`** (exit 0) — nenhuma PR aberta cobre o escopo (inclui o
  caso de uma PR só MENCIONAR a issue em prosa — `matchKind: "mention-only"`
  fica visível no resultado mas não eleva o veredito: citação incidental não
  é prova de que a PR resolve a issue).
- **`open-pr-covers-scope`** (exit 1) — marcador de fechamento explícito
  (`closes`/`fixes`/`resolves #N`) ou branch na convenção `fix-N`/`feat-N`.
  PR de terceiro/manual: aplicar o checklist de 3 perguntas do item 16
  acima (autor conhecido? CI verde/rodando? atualizada nas últimas
  ~24-48h?) — as 3 juntas justificam esperar; falhando qualquer uma, tratar
  como se a PR não existisse e avaliar implementação independente. **PR de
  lane autônoma (`overnight/`, `develop/`, `continuo/`): o `orphanAction`
  vale ANTES das perguntas 2 e 3** (#12950) — CI vermelho ou PR parada não
  vira reimplementação duplicada. A issue sai `pulada` motivo `pr-em-voo` e
  a rodada executa o `orphanAction` do JSON (passo 4 da Fase 0 do
  `/diaria-overnight`; passo 4 do `/diaria-develop`): `merge-via-gate2`
  (CI verde, sem draft, sem retenção por label ou marcador no corpo,
  `evaluatePrRetido`) → gates do pickup 2b e merge com
  `gh pr merge --match-head-commit <sha avaliado>`, nunca o HEAD de um
  push posterior; `despachar-fixer` (CI vermelho) → `dev-fixer` no branch;
  `aguardar-ci` (CI pendente, PR atualizada há até 6h) → reavaliar no
  próximo re-scan (`check-block-staleness.ts` acusa a entrada com
  `orphan_action: "aguardar-ci"` assim que o CI da PR termina, verde ou
  vermelho, #13003); `editor` → não tocar. Vira `editor`: draft,
  `bloqueio-execucao`, retenção (inclusive labels ilegíveis), branch fora
  das lanes, issue reivindicada por sessão ativa no `session-registry`
  (dono vivo; o CLI consulta a mesma lógica do `is-claimed`, aceita
  `--session-id` para excluir a própria sessão, e falha de consulta conta
  como reivindicada), CI pendente há mais de 6h (`updatedAt`), e
  `check-pr-review-authenticity.ts` `exit 3` no caminho do merge (estado
  ambíguo, como no pickup 2b).
- **`cannot-verify`** (exit 2) — `gh` indisponível, sem auth, JSON
  malformado ou rate limit. **Regra inegociável desta issue:** isto NUNCA
  vira `no-open-pr` — transformaria uma falha de consulta em sinal verde e
  reintroduziria o desperdício em silêncio (mesma classe do #7776, achado
  na mesma rodada). Reter/retry antes de dispatchar.

`ciState` (`green`/`pending`/`failing`/`unknown`) e `updatedAt` acompanham
cada match — o suficiente pro checklist do item 16 sem uma 2ª chamada `gh`
por PR candidata (o custo desta checagem inteira é 1 `gh pr list`, contra um
dispatch de subagente inteiro).

**Onde plugar:** logo depois do item 21 (mesmo passo — overnight: Fase 0
passo 4; develop: Fase 1 passo 4; continuo: passo 1 do "Loop invariável" —
ver o `SKILL.md` de cada skill pro texto exato). Não substitui o item 21 nem
o item 14 (preflight do subagente) — os três cobrem estados diferentes da
mesma pergunta ("essa issue já está sendo/foi resolvida?"): merged, em voo,
e rede de segurança pós-dispatch.

## 32. Issue de outro repo (`vjpixel/diaria-design`): pré-requisito, worktree, preflight e merge (parte do coordenador)

A parte do implementador fica no item 32 de `context/overnight-dispatch-rules.md`.

**Pré-requisito do coordenador (idempotente, rodar no início da rodada):**
`npx tsx scripts/sync-issue-labels.ts --repo vjpixel/diaria-design --apply`
— cria no design as labels de track/prioridade que o roteamento usa (lista
derivada do código). Sem elas, `route-issue.ts --issue vjpixel/diaria-design#N`
falha ao aplicar label.

**Coordenador, antes do dispatch:**
1. Checkout do design: `../diaria-design`, ao lado do checkout do studio.
   Ausente → `gh repo clone vjpixel/diaria-design ../diaria-design`. Branch
   base: `main` (não `master`).
2. Worktree do design, NUNCA do studio: `git -C ../diaria-design fetch origin`
   e `git -C ../diaria-design worktree add -b {branch} .claude/worktrees/{nome}
   origin/main` (caminho relativo ao checkout do design). Branch com a mesma
   convenção do item 2 (`overnight/fix-N-slug`, `develop/fix-N`,
   `continuo/fix-N-slug`), com o `N` LOCAL do design. Dispatch sem
   `isolation: worktree` (essa isolação cria worktree do studio), com o cwd
   explícito no worktree do design.
3. **Salvaguarda:** se o checkout do design não existe e não pode ser criado
   (clone falhou, sem rede, sem acesso), ou o worktree não sobe, a issue é
   **pulada** com `motivo: "bloqueio-execucao"` e nota "checkout do
   vjpixel/diaria-design indisponível nesta máquina: {erro}" no `plan.json` —
   nunca implementada num worktree do studio "por enquanto".
4. Preflight com a ref: `check-issue-duplicate-preflight.ts --issue
   vjpixel/diaria-design#N` e `check-issue-open-pr.ts --issue
   vjpixel/diaria-design#N`.

**Merge (coordenador), fora do trem:** `run-merge-train.ts` é só-studio — PR
de outro repo nunca entra no trem. Gate 2 com o repo do PR:
`check-pr-checks-gate.ts`, `check-pr-retido-gate.ts`,
`check-pr-review-authenticity.ts --pr P --issue vjpixel/diaria-design#N` (o
repo do PR sai da issue; `--repo vjpixel/diaria-design` também serve),
threads resolvidas com `owner=vjpixel name=diaria-design` (item 11), guard de
`Closes` com `gh pr view P -R vjpixel/diaria-design --json body`, depois
`session-registry.ts merge-lock-acquire --pr P --repo vjpixel/diaria-design`
(o lock é POR REPO: não serializa com o studio), o merge com `-R
vjpixel/diaria-design --squash` e a confirmação com `gh pr view P -R
vjpixel/diaria-design --json state,mergedAt`.

## 33. Plataforma não cria worktree nenhum: clone próprio por unidade (#11166)

**Sintoma (histórico: `docs/rodadas-autonomas-historico.md#dr-11166`):** todo dispatch com `isolation:
"worktree"` falha com `Could not read the repository git config to
neutralize filter drivers`, embora `git config --list` rode normalmente no
checkout. É outro caso do item 22: a recusa vem do harness, fora deste repo,
e o `.git` não está quebrado. Não tentar reparar o checkout compartilhado.

**Ordem do contorno (coordenador):**
1. Primeiro o contorno do item 22: `git worktree add -b {branch}
   .claude/worktrees/{nome} origin/master` à mão e dispatch sem `isolation`.
   Se o `git worktree add` funciona, para aqui.
2. Se nem isso serve, cada unidade ganha um **clone próprio**, criado pelo
   coordenador antes do dispatch:
   - **Caminho curto e fora do scratchpad.** O scratchpad do Windows fica
     fundo em `%TEMP%` e o `git clone` estoura `Filename too long` em alguns
     arquivos do repo. Use algo como `C:/dw/{N}` no Windows ou `~/dw/{N}` no
     Unix, com `{N}` = issue da unidade (lote: a menor). Nos comandos de
     shell (Git Bash, o shell do Claude Code no Windows) o caminho vai com
     barra normal: sem aspas, `C:\dw\123` vira `C:dw123`. Barra invertida
     só dentro dos comandos de `cmd` (`mklink`/`rmdir`, abaixo).
   - **`core.longpaths` já no clone:** `git clone -c core.longpaths=true
     https://github.com/vjpixel/diaria-studio.git C:/dw/{N}`. Clonar do
     GitHub, não do checkout local: um clone do caminho local deixa `origin`
     apontando para o checkout compartilhado, e o `git push` do subagente
     iria para lá em vez do GitHub. Se clonar do local para poupar banda,
     rodar logo depois `git -C C:/dw/{N} remote set-url origin
     https://github.com/vjpixel/diaria-studio.git` e conferir com `git
     remote -v`.
   - **Branch:** `git -C C:/dw/{N} checkout -b {branch} origin/master`, com a
     convenção do item 2.
   - **`node_modules`:** `npm ci` dentro do clone, como no item 3. Nunca
     symlink/junction de `node_modules` para o checkout principal.
   - **`data/` só quando a unidade roda eval de agent (#8144)** ou outro
     script que leia `data/` de verdade: junction para o `data/` real
     (`cmd //c "mklink /J C:\dw\{N}\data {data real}"` a partir do Git
     Bash no Windows, `ln -s` no Unix). `mklink` é comando interno do
     `cmd`: chamado direto no bash dá `command not found`.
     Sem eval, sem junction: menos superfície para um `rm` errado alcançar
     dado de produção.
3. Dispatch sem `isolation`, com o caminho do clone como cwd explícito de
   todo `git`/build/teste e a proibição explícita de tocar o checkout
   principal (mesmo texto do item 22). As regras 1-14 valem iguais no
   clone.

A recusa do `gh pr create` pelo hook de typecheck no clone é a parte do implementador: item 33 de `context/overnight-dispatch-rules.md`.

**Limpeza é do coordenador, nunca do subagente** (o `rm -rf` do clone é negado ao subagente). `cleanup-merged-worktrees.ts` não enxerga clones (não são
worktrees deste repo), então o coordenador anota no `plan.json` o caminho do
clone de cada unidade (nota da issue) e limpa depois que a PR da unidade foi
mergeada ou fechada:
1. **Primeiro desfazer a junction de `data/`, se houver**, sem seguir o
   alvo: `cmd //c "rmdir C:\dw\{N}\data"` a partir do Git Bash (remove só
   a junction) ou `rm
   ~/dw/{N}/data` no Unix (sem `-r`, remove só o symlink). Um `rm -rf` no
   clone com a junction ainda lá pode descer nela e apagar o `data/` real.
2. Conferir que a junction sumiu (`ls -la C:/dw/{N}` / `ls -la ~/dw/{N}`).
3. Só então remover o diretório do clone.

Clone de PR ainda aberta no fim da rodada fica em disco e entra no relatório
com o caminho, para a próxima rodada ou o editor limparem. Helper que crie e
limpe esses clones: fora do escopo desta regra, que é só o procedimento.

## 35. Escrita em `data/`: aplicar a seção `Escrita pendente em data/` depois do merge (parte do coordenador)

A parte do implementador fica no item 35 de `context/overnight-dispatch-rules.md`.

**Regra para o coordenador:** antes de declarar a unidade concluída, ler o
corpo da PR mergeada (`gh pr view N --json body`) e aplicar cada linha da
seção `Escrita pendente em data/`, no checkout principal, com o Edit
(cirúrgico, #495), depois do merge e nunca antes: a escrita pertence ao estado
pós-merge. Registrar a aplicação no relatório da rodada (`report.md`, coluna
de nota da unidade). Pendência que o coordenador também não consegue gravar
(máquina sem `data/`, item 23) entra no relatório como pendente, com o texto
da linha, para o editor ou a próxima rodada.

**Lado mecânico (#12026, #12034).** No trem de merge a PR mergeada é o
PR-trem e as originais terminam fechadas: `run-merge-train.ts` lê a seção de
cada original (`scripts/lib/pending-data-writes.ts`), replica no corpo do
PR-trem e imprime no fim do run o bloco `run-merge-train: ESCRITA PENDENTE em
data/` (mais uma linha `escrita-pendente-json` por PR). No contínuo, quem
mergeia é o `hermes/scripts/continuo-pr-review.sh`: depois do merge
confirmado ele roda `scripts/register-pending-data-writes.ts`, que abre uma
issue de alarme (`alarm-evento`, P2) com as linhas e avisa no resumo do tick.
Nenhum dos dois aplica a escrita: o formato é prosa, e a aplicação segue com
o coordenador, como acima.

## 36. PR com `requer agent-eval:`: rodar o eval e reconciliar o relatório (parte do coordenador)

A parte do implementador fica no item 36 de `context/overnight-dispatch-rules.md`.

**Coordenador:** a PR com essa linha (ou com o check do gate vermelho) segue
o procedimento #11616 do `.claude/skills/diaria-overnight/SKILL.md` (Fase 1,
Gate 2): `npx tsx scripts/run-agent-eval-for-pr.ts --pr N --live` no
worktree da PR, que aplica a label ao registrar o resultado. Decisão do
editor de 10/11/2026 (#12678): é o coordenador quem roda, na própria rodada.
Desde o #12830 o script também reexecuta o check do gate depois da label
(rerun pela API; recusado, tira e repõe a label) e só sai `0` com ele verde
no head da PR: sem `gh run rerun` à mão. Saída `1` depois de "Label e
comentário já estão na PR" é o check que não ficou verde no prazo
(`--check-timeout-sec`, default 600).

**Relatório:** `scripts/reconcile-overnight-report.ts` marca a PR aberta
retida no gate como `aberta, aguarda agent-eval` e lista as retidas numa
linha `Pendência:` abaixo da tabela de estado (lógica em
`isAwaitingAgentEval`, `scripts/lib/overnight-report-reconcile.ts`). Critério:
sem a label e com o check vermelho; enquanto o check não concluiu, vale a
linha `requer agent-eval:` do corpo. Check verde nunca retém. Assim a PR que
o coordenador não conseguiu avaliar (eval saiu `1` por falta de edição de
referência, sessão sem assinatura) chega ao editor como pendência explícita,
não como CI vermelho a ser descoberto.
