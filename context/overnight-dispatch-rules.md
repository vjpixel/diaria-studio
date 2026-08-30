# Regras obrigatórias de dispatch (overnight + develop)

Checklist canônico das regras que **todo subagente implementador** de
`/diaria-overnight` e `/diaria-develop` deve seguir. Extraído do boilerplate
que os dois `SKILL.md` reproduziam em cada prompt de dispatch (#3453 Rec 4 /
#3454 Rec 2, análises `docs/overnight-token-analysis-3327.md` §4 e
`docs/develop-token-analysis-3328.md` §5).

**Como usar:** o coordenador **cita este path** no prompt de dispatch e instrui
o subagente a lê-lo no início da própria sessão (`Read context/overnight-dispatch-rules.md`),
em vez de reproduzir o texto completo das regras a cada dispatch. O ganho de
token é do lado do **coordenador** (prompt de dispatch mais curto, menos texto
crescendo na conversa do coordenador ao longo da noite) — o subagente ainda
carrega o conteúdo via `Read`, mas uma vez, da fonte única. Fonte da verdade
única também reduz a classe de incidente #3321 (convenção seguida só porque
estava em prosa narrativa, não em checklist acionável no ponto de uso).

> Nota de sincronia: alguns destes itens também aparecem em prosa nos dois
> `SKILL.md` (e alguns são travados por `test/overnight-skill-npm-test-scope.test.ts`).
> Ao editar uma regra aqui, conferir se a versão do `SKILL.md` correspondente
> precisa acompanhar — este arquivo é o checklist canônico; o `SKILL.md` é a
> instrução ao coordenador.

---

## 1. Guard de publicação (INVARIANTE)

Editar código de publisher **é ok**; **EXECUTAR é proibido**. Nunca rodar
`scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`, `close-poll`
ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo ao vivo — nem em
"teste". (Exceção controlada, só no `/diaria-develop` e só pelo coordenador
top-level, nunca pelo subagente: `publish-*.ts --dry-run` para validar token
recém-colado, cat. A.)

## 2. Convenção de branch (#3321 — instrução literal, não implícita)

- Overnight: `overnight/fix-{issue}-{slug}` (solo) ou `overnight/batch-{slug}` (lote).
- Develop: `develop/fix-NNNN` (solo) ou `develop/blast-NNNN` (cat. D, sempre solo). A sessão CONTINUO usa `continuo/fix-NNNN-{slug}` (#6446 v0.5.0) — é o prefixo que a Triagem do Studio (`deriveTrackFromBranch`) usa pra rotular o PR como `continuo`; sem ele o PR cai em `other`.

O prefixo é o sinal que `.claude/hooks/pr-create-review.mjs` (`resolveEffort`)
usa pra dar `low` effort no `/code-review` pós-`gh pr create`, e é o que o
cleanup de fim de rodada usa pra deletar a branch remota corretamente.

## 3. Bootstrap do worktree

Primeiro passo é **`npm ci`** — worktree novo não tem `node_modules/` nem a
junction `data/`.

**`npm ci`/`npm install` só dentro do worktree, NUNCA no checkout principal
compartilhado (#5571).** O checkout principal é usado concorrentemente por
outras sessões/tasks (Diaria-Studio-Server, outras sessões locais) — dois
processos `npm install`/`npm ci` escrevendo no MESMO `node_modules` do
checkout principal ao mesmo tempo já corrompeu `node_modules` num symlink
AUTO-REFERENTE ao vivo (achado overnight 260817c), quebrando todo `npx tsx`
nesse checkout com `FilesystemLoop`/"Too many levels of symbolic links" até
alguém rodar `rm node_modules && npm ci` manualmente. Cada worktree isolado
já tem seu próprio `node_modules/` — nunca há motivo pra reinstalar no
checkout principal a partir de dentro de um worktree.

## 4. Disciplina de testes (#2959) — NUNCA a suíte completa local

Testes locais = **`npx tsc --noEmit`** (typecheck) **+ só os arquivos de teste
afetados/novos** (`npx tsx --test test/<arquivo-tocado>.test.ts test/lib-boundary.test.ts`).
**NUNCA `npm test` completo local** — o CI já roda a suíte inteira como gate
autoritativo antes do merge (#636/#633); repetir os ~11k testes/~3min no
worktree é redundante e é justamente o comando que dispara o auto-background do
harness (subagente entra em Monitor-loop e não retorna → stall).

`npx tsc --noEmit` e os testes afetados rodam **SEMPRE em FOREGROUND**,
aguardando o resultado antes de retornar — nunca em background. Se um full-run
local for genuinamente necessário (raro), pipe por `| tail -40` pra forçar o
resultado a voltar na própria chamada.

**Subagente que tocar QUALQUER arquivo listado em `ORCHESTRATOR_FILES` no topo
de `test/orchestrator-prompt.test.ts` roda `NODE_TEST_SNAPSHOTS=1 npx tsx --test test/orchestrator-prompt.test.ts`
antes do push (#634).** Não confiar em enumerar os caminhos à mão aqui — foi
exatamente essa enumeração manual (só `.claude/agents/orchestrator-*.md`,
citando o glob e esquecendo que ele nem cobre `orchestrator.md` na raiz, sem
hífen) que causou o gap do #6767 (2 ocorrências na mesma rodada overnight
260829b: editar `.claude/skills/diaria-3-imagens/SKILL.md` e
`.claude/skills/diaria-artigo-especial/SKILL.md` exigiu sincronizar as
menções correspondentes em `.claude/agents/orchestrator-stage-3.md`/
`orchestrator-stage-4.md`/`orchestrator-stage-2.md` — é essa 2ª edição, no
arquivo do orchestrator, que quebra o snapshot; nenhum subagente rodou o
comando de fix porque a regra citava só o padrão de nome, não a lista real
do teste). Ler o array `ORCHESTRATOR_FILES` do teste é sempre a fonte
correta — hoje ele inclui `orchestrator.md` e `orchestrator-stage-{0-preflight,
1-research,2,3,4,5,6}.md`, mas o array pode crescer sem que esta prosa
acompanhe. Regra prática: se o diff toca **qualquer** arquivo dentro de
`.claude/agents/` cujo nome comece com `orchestrator`, rodar o comando acima
antes do push — inclusive quando a mudança nasceu de sincronizar um
`.claude/skills/*/SKILL.md` com o playbook (não é preciso ter editado o
arquivo do orchestrator "de propósito" para o guard se aplicar).

## 5. Teste de regressão em bugfix (#633)

Fix de bug **exige teste novo** demonstrando que o bug não voltaria. Sem teste →
não merge. Se não for testável (ex: prompt de agent), justificar explicitamente
no PR body.

## 6. Marcador `no-regression-test` proativo para PRs sem código executável (#3327 Rec 7)

Se a unidade é **só docs/comentário/prompt sem código executável**, incluir
desde o início no PR body o marcador literal `no-regression-test: <razão>` — não
esperar o hook `check-pr-bugfix.ts` reclamar (ele pegou o coordenador de
surpresa 2× na rodada 260711). Reduz latência, não tokens; praticamente
gratuito.

## 7. Self-review obrigatório antes de retornar (#2038) — tratado como ETAPA DE LISTAGEM

Após o `gh pr create`, o subagente faz UMA passada adversarial no próprio
`git diff` contra a(s) issue(s) + briefing: o diff cobre TODOS os pontos (não só
os fáceis)? Sobrou referência órfã de refactor? O arquivo carrega? O cenário
REAL da issue tem teste? **O output esperado são os findings listados como
comentários inline no PR** (não fixes imediatos). Retornar: o número do PR **+ a
linha "self-review: N findings"**.

## 8. Não executar review multi-agente pós-`gh pr create`

Se um hook pós-`gh pr create` exigir code-review multi-agente, **não executar** —
o self-review acima é a resposta; anotar no body do PR e retornar (subagente não
pode dispatchar Agent, #207; o review pesado roda UMA vez, consolidado, na
Fase 1.5). Ver regra 11 abaixo — "retornar" aqui significa literalmente parar,
não seguir sozinho até o merge.

## 9. Convenções de commit/PR do repo

Seguir as convenções de commit/PR do `CLAUDE.md`. PR abre com `Closes #NNNN` (um
`closes` por issue do lote). Título com `(#NNNN)` / `(#A, #B, ...)`.

**`Closes` é obrigatório POR ISSUE totalmente resolvida — nunca ambíguo (#5010).**
Confirmado ao vivo na rodada 260811: 4 de ~13 PRs saíram sem nenhum `Closes` no
body, deixando issues já resolvidas presas abertas até triagem manual na rodada
seguinte. Para CADA issue do lote, o PR body precisa conter OU `Closes #NNNN`
(issue totalmente resolvida por este diff) OU a declaração explícita
`REFS #NNNN, NÃO CLOSES ({motivo})` (escopo genuinamente parcial). Nunca deixar
a ausência do `Closes` ambígua entre "esqueci" e "decidi que não fecha" — o
padrão correto já existe no repo (PR #4969, lote geo-baratos): seguir esse
exemplo.

**"PR mergeado com `REFS`" e "issue fechada" são estados DIFERENTES (#5327
item 2).** Antes de qualquer resumo de status ao editor que mencione uma issue
como "fechada"/"resolvida", confirmar via `gh issue view {N} --json state` —
nunca assumir a partir de "eu dispatchei um PR pra ela". Incidente de
referência: na rodada `/diaria-continuo` de 260814, o coordenador reportou
"#5316 fechado" numa tabela de status quando a issue continuava aberta (o PR
usou `REFS #5316, NÃO CLOSES` porque só parte do escopo foi implementada) — o
editor teve que perguntar pra a imprecisão ser corrigida.

## 10. Nunca `git stash` dentro do worktree (#4459)

`git worktree add` isola a working tree e o índice, mas **não** isola
`refs/stash` — é uma lista única, compartilhada por TODO o repositório
(diretório principal + todos os worktrees + qualquer outra sessão/agente
rodando em paralelo). Rodar `git stash`/`git stash pop`/`git stash apply`
dentro do worktree de um subagente pode consumir ou misturar a stash de
OUTRA sessão (incidente 260802: um `pop` trouxe de volta uma stash rotulada
"leave alone" de uma sessão `/diaria-develop` concorrente — sem sinal de
erro além de um conflito de merge que por sorte denunciou o problema).

Pra investigar ou reverter estado local **dentro do próprio worktree**, usar
em vez disso: `git diff`/`git show` (inspecionar sem mexer em nada), `git
checkout -- <arquivo>` (reverter arquivo específico), ou um commit temporário
(`git commit --no-verify -m wip` seguido de `git reset --soft HEAD~1` quando
quiser desfazer) — nenhum desses toca a lista de stash compartilhada.

## 11. Parar no self-review — nunca mergear sozinho (#4740, incidente 260806b)

**PROIBIÇÃO EXPLÍCITA (#6762): NUNCA rode `gh pr merge`, `gh pr merge --auto`,
nem qualquer variante — merge é ação EXCLUSIVA do coordenador, mesmo com CI
já verde.** Após o `gh pr create` + self-review (regra 7), o passo seguinte é
**retornar ao coordenador** — não esperar CI, não checar `gh pr checks`, não
mergear. Registrado aqui de forma explícita porque uma 3ª ocorrência do
mesmo incidente (PR #6759, rodada `/diaria-overnight` 260829b) aconteceu com
CI verde e diff correto — o mecanismo de segurança foi contornado por sorte,
não por design; a proibição precisa ser lida sem exigir inferência a partir
do texto abaixo.

O passo final do subagente implementador é `gh pr create` + self-review
(#2038, regra 7) + retorno ao coordenador. **"Retornar" é literal: nenhum
subagente implementador espera CI, roda fleet review, ou chama `gh pr merge`
por conta própria** — isso é trabalho do coordenador top-level (fleet review
pré-merge #4383, Gate 2 determinístico #2210/#2222, só então o merge), e
existe fora do worktree do subagente de propósito: o coordenador precisa ver
o diff FINAL antes de qualquer coisa virar master, e o próprio review multi-
agente (regra 8 acima) depende de rodar depois que o subagente parou, não
em paralelo com ele ainda ativo.

Incidente registrado (`/diaria-develop 260806b`): um subagente implementador
seguiu além do self-review — self-review → fixer interno → esperou CI →
**mergeou e fechou a issue sozinho**, sem o coordenador nunca ver o diff
antes do merge. O fleet review pré-merge de 5 agentes nunca rodou; só foi
recuperado porque o coordenador rodou o mesmo fleet **retroativamente**
contra o commit já mergeado — e achou um problema real e ativo (testes e2e
escrevendo em diretório de dado de produção sincronizado por OneDrive) que,
se exercitado antes da checagem retroativa rodar, já teria causado dano.
Revisão pós-merge é rede de segurança, não substituto do gate — o dano só
não aconteceu porque ninguém rodou os testes localmente entre o merge e a
checagem.

**Sinal de que o subagente está indo longe demais:** qualquer chamada a
`gh pr checks --watch`, `gh pr merge`, ou um loop de espera por CI/review
DEPOIS do `gh pr create` — nenhuma dessas pertence ao escopo do subagente
implementador, mesmo que o prompt de dispatch não repita isso explicitamente
toda vez (citar este arquivo já deveria bastar; registrar aqui a regra
explícita fecha a lacuna que permitiu o incidente).

**Guard mecânico (#5716, 2ª ocorrência do incidente acima — PR #5713, sessão
`/diaria-develop 260819d`).** A regra 11 sendo só prosa não impediu uma 2ª
violação, com dano mensurável desta vez (fix mergeado sem o teste de
regressão que o fleet review tinha apontado como bloqueante, commit do teste
órfão numa branch já deletada). `.claude/hooks/block-gh-pr-merge-subagent.mjs`
(`PreToolUse` sobre `Bash`) nega `gh pr merge` quando a chamada não pertence à
sessão coordenadora registrada de uma rodada overnight/develop/continuo ativa
(`data/sessions/*.json`, escrito por `scripts/lib/session-registry.ts
register`) — mesmo padrão de identidade de sessão de
`block-askuserquestion-overnight-autonomous.mjs`/`inject-session-id.mjs`.
Nenhuma rodada ativa registrada → nunca bloqueia (sessão interativa comum,
#5251). Sessão cujo `session_id` bate com o coordenador registrado → permite
(é o próprio coordenador mergeando). Qualquer outra chamada, com rodada ativa
→ bloqueia (subagente implementador, ou — trade-off aceito, documentado no
próprio hook — outra sessão interativa não-relacionada rodando em paralelo).
Itens 2 ("expor subagente ainda vivo") e 3 (auditoria via `gh pr view --json
mergedBy`) da issue seguem como follow-up, não implementados neste guard.

**Merge-gate: resolver review threads antes de `gh pr merge` (#5327 item 4,
achado ao vivo 260814).** Isto é trabalho do COORDENADOR (não do subagente
implementador, que nunca chega perto de `gh pr merge` — ver acima), mas
documentado aqui por ser o mesmo ponto do fluxo. `gh pr merge --squash` pode
falhar com "base branch policy prohibits the merge" mesmo com CI verde e sem
exigência de aprovação (`required_approving_review_count: 0` no ruleset) —
a causa real é `required_review_thread_resolution: true`: comentários de
review inline (self-review do subagente, findings do review consolidado)
ficam como threads não-resolvidas e bloqueiam o merge até alguém resolver
via GraphQL. Antes de `gh pr merge`, resolver todos os review threads
pendentes:
```
gh api graphql -f query='query { repository(owner: "vjpixel", name: "diaria-studio") { pullRequest(number: N) { reviewThreads(first: 20) { nodes { id isResolved path } } } } }'
gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "ID"}) { thread { isResolved } } }'
```

## 12. Matar processo próprio: sempre por PID, nunca por nome de imagem (#5432)

**Nunca** `taskkill /IM <nome>` (Windows) nem `pkill -f <nome>`/`killall <nome>`
(Unix) para encerrar um processo que você mesmo iniciou (ex: script de
diagnóstico em background). Esses comandos casam por **nome de imagem/padrão
de linha de comando**, não por PID/árvore do chamador — matam TODO processo
com esse nome na máquina, incluindo os de **outras sessões concorrentes**
(overnight, develop, continuo, sessão interativa do editor — múltiplas
sessões coexistem na mesma máquina por design, #5156), o Studio server,
scheduled tasks, ou o próprio harness do Claude Code.

Incidente de referência (#5432): um subagente investigando o #5401 rodou
`taskkill //F //IM node.exe //T` pra parar um script de diagnóstico próprio
— comando sem escopo, mataria todo `node.exe` da máquina. Dano visível foi
nulo nessa ocorrência (sorte de timing), mas o blast radius potencial é
alto e o padrão é fácil de repetir.

**Correto:** guardar o PID do processo que você mesmo iniciou (`$!` no
shell, ou o retorno de `spawn`/`exec`) e matar só ele —
`taskkill //F //PID {pid}` no Windows, `kill {pid}` no Unix — ou, se
disponível, usar o mecanismo de kill do próprio harness em vez de um
comando de shell solto. Nunca `/IM {nome-de-processo}` ou `-f {padrão}` sem
escopo ao PID/árvore do chamador.

## 13. Tocou `invariant-checks/*.ts`? Regenerar `docs/editorial-invariants.md` (#4877)

Se você adicionar, editar ou remover uma invariante em
`scripts/lib/invariant-checks/stage-*.ts`, rode
`npx tsx scripts/list-invariants.ts --out docs/editorial-invariants.md`
**antes de abrir o PR** — esse arquivo é derivado e travado por
`test/list-invariants.test.ts`; abrir o PR sem regenerá-lo dá CI vermelho
("arquivo committed bate com registry atual") e exige um fix-iteration extra
do coordenador (2 ocorrências na mesma rodada overnight 260810: PRs #4864 e
#4876). Commitar o `docs/editorial-invariants.md` regenerado junto com a
mudança em `invariant-checks/`.

## 14. Preflight de duplicidade — checklist obrigatório (#5327 item 3)

**Antes de implementar**, todo subagente implementador roda `gh pr list
--state open` e `gh issue view {N} --json state` para a(s) issue(s) do lote.
Se já houver PR/trabalho aberto cobrindo o mesmo escopo, ou a issue já
estiver fechada, **parar e reportar ao coordenador** em vez de implementar —
não seguir adiante assumindo que o próprio trabalho ainda é necessário.
Aplica-se a **todo dispatch desta linha de skills** (overnight, develop,
continuo), não só ao `/diaria-continuo`, onde foi identificado como gap.

Incidente de referência: o 1º dispatch da rodada `/diaria-continuo` de
260814 (issue #5304) colidiu com um PR já aberto por uma sessão interativa
paralela do editor no mesmo checkout (#5308), gerando um PR duplicado
(#5312) que teve que ser fechado. A checagem só foi adicionada aos prompts
de dispatch **depois** desse incidente, ad-hoc — isto formaliza o preflight
como checklist canônico, não uma correção manual repetida a cada rodada.
Esperado sobretudo em `/diaria-continuo` (roda em paralelo a sessões
interativas comuns do mesmo editor por design), mas vale igualmente em
overnight/develop contra qualquer sessão concorrente.

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
  solo se as duas são seguras e pequenas. Evidência (rodada 260711): 5
  issues solo desse perfil somaram ~630k tokens; agrupadas à taxa de lote
  observada teriam custado ~443k — lote saiu ~2,1× mais barato por item que
  solo (magnitude varia por rodada; a direção é sólida).

**Critérios comuns a (a) e (b):** o lote inteiro cabe numa revisão de diff
única; nenhuma issue do lote conflita com outra (arquivos disjuntos).
**Teto = cabe sem forçar compaction de contexto do subagente implementador,
não um número fixo de issues** (#2754 — o objetivo é otimizar tokens, não
tempo; um subagente maior amortiza custo fixo de bootstrap sobre mais
itens, saindo mais barato por item do que N subagentes solo repetindo esse
bootstrap. Medido na 260630: lote de 16 sub-itens em 3 issues saiu ~26k
tokens/item vs. ~114k tokens/item numa issue solo comparável). Sinal
prático de teto estourado: o subagente reportar compaction no meio da
sessão, ou a lista de arquivos tocados ultrapassar ~15-20. Issues
grandes/arriscadas (P1, blast radius alto, migrações) ficam **solo** — o
batching é só pras pequenas/médias. Cada lote vira 1 PR (`Closes #A,
closes #B, ...`); como o merge fecha todas as issues do lote, o review leve
do coordenador confere que o diff cobre de fato **todas** elas.

**Onde a aprovação do agrupamento é registrada varia por skill** — overnight
tem Fase 0/briefing único (`batch_approval: "editor_approved" |
"editor_adjusted" | "default_proposed"`); `continuo` não tem briefing e usa
sempre `"default_proposed"` como default permanente, decisão mecânica do
coordenador a cada dispatch (nunca vira `AskUserQuestion` novo — ver
`.claude/skills/diaria-continuo/SKILL.md`, "Loop invariável" passo 1).

## 16. Viés de autoria e confiança em PR alheio (#5484)

**Escopo diferente dos itens 1-14**: este item, como o 15, é critério do
**coordenador** (overnight/develop/continuo) — quem decide se dispatcha ou
adia uma issue — não do subagente implementador. Dois padrões concretos
observados ao vivo na rodada 260816e, ambos corrigidos só depois de o
editor perguntar 4× "por que essas issues elegíveis ficaram sem dispatch?":

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

Incidente de referência (#5484, rodada 260816e): #5427 tinha o PR #5428
aberto por um fork de autor desconhecido (`emre155`), sem CI rodado e sem
review — nenhuma das 3 perguntas foi checada antes de concluir "deixo pro
editor". O diff da causa raiz já tinha sido verificado ao vivo pelo próprio
coordenador; dava pra reimplementar de forma independente na mesma
respiração, sem esperar o editor perguntar.

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
eu siga nelas agora?"). Incidente de referência: sessão `/diaria-develop
260819d`, o coordenador fechou o turno com essa pergunta depois de entregar a
#5700, e o editor corrigiu ao vivo ("você nem deveria me perguntar") — a
regra já existia em prosa no CLAUDE.md e foi violada assim mesmo, porque não
havia ponto de interceptação mecânico (é texto livre, não uma chamada de
ferramenta) — só o registro explícito no ponto de uso, aqui e no CLAUDE.md,
reduz a chance de recorrência.

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
`claim-issue` existe pra evitar (achado ao vivo #5751: overnight com #5738
em `claimed_issues` enquanto uma sessão interativa a implementava e
mergeava em paralelo, PR #5739).

**Regra:** chamar `session-registry.ts is-claimed`/`claim-issue` sempre como
comando **standalone** — nunca dentro de `&&`/`;`/pipe/heredoc. Se o comando
retornar erro (`session-registry: erro — --session-id ausente...` no
stderr, ou `exit 1`), tratar como **falha real da reivindicação**, nunca
como ruído a ignorar — parar e diagnosticar antes de seguir pro dispatch,
mesma disciplina de qualquer outro `exit 1` inesperado.

## 19. Nunca montar corpo de issue/PR via `printf`/`echo -e` (#6004)

`printf` do Bash trata `%` como format specifier no primeiro argumento — um
texto com `%a`/`%s`/`%d` (percentuais são comuns neste domínio: taxas de spam,
CTR, cliques) é corrompido **silenciosamente** (`1,923% ainda` virou
`1,923 0x0p+0inda` ao vivo no corpo da issue #5140, achado 260824). `echo -e`
tem classe análoga de risco com escapes.

**Regra:** para montar texto dinâmico que vai virar `--body`/`--body-file` de
`gh issue edit`/`gh issue comment`/`gh pr create`:

- preferir a ferramenta `Write` (nunca interpreta `%`);
- ou heredoc com delimitador entre aspas simples (`cat <<'EOF' > body.md`);
- ou, quando existir, o helper dedicado — `scripts/lib/wait-until-sync.ts`
  (`upsertWaitUntilMarker` e vizinhos, via `spawnGhSync`) é fonte única pra
  marcadores machine-readable no corpo de issues; usar em vez de shell.

Verificação barata pós-write: `cat -A body.md` (ou reler o arquivo) antes do
`gh ... --body-file`.
