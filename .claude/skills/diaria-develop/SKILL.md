---
name: diaria-develop
description: Sessão de desenvolvimento SUPERVISIONADA. Por padrão (#4319) trabalha o backlog aberto INTEIRO em 4 ondas priorizadas (bugs → bloqueadas → P0/P1 → resto) até nenhuma issue estar aberta; `goal_policy=blocked_only` volta ao escopo original (#2636/#4297) de só o backlog BLOQUEADO. O editor está presente e desbloqueia em tempo real (cola token, confirma conta, decide trade-off, autoriza blast-radius); a skill valida o desbloqueio deterministicamente (#573) e leva a issue ao merge reusando a maquinaria do overnight, PARALELIZANDO tudo que for seguro (issues que colidem em arquivo viram 1 PR só). Uso — `/diaria-develop [AAMMDD] [--issues N,M] [--only A-E] [--bugs] [--priority P0,P1,P2,P3] [--track overnight|develop|agendada|bloqueada|fora-de-rodada] [--wave-policy auto|per_wave] [--dry-run] [--no-implement] [--serial]`.
disable-model-invocation: true
model: claude-opus-5-5
effort: medium
---

# /diaria-develop

**Preflight obrigatório de ambiente (#12307), antes de qualquer outro passo:**
rodar `npx tsx scripts/lib/exec-mode.ts --require-shared-issue-registry`.
Exit diferente de zero ou falha ao executar: exibir o motivo e encerrar a skill,
sem scan, registro, claim, roteamento, implementação ou dispatch (inclusive
`--dry-run`/`--no-implement`). Não criar `data/` nem usar REST manual para
contornar: o registro efêmero não é visto pela continuo no `300`, e os scripts
de triagem ainda dependem de GraphQL, bloqueado no cloud. Retomar numa sessão
local com `data/` sincronizado ou deixar a fila para o `300`. Este preflight
vem antes de qualquer criação de `data/` pela própria skill.

**Regras do coordenador (#14043):** além de `context/overnight-dispatch-rules.md`
(regras do subagente, que o prompt de dispatch cita), o coordenador segue
`context/overnight-coordinator-rules.md`. Os itens 9, 11, 15-18, 21, 22, 24-26,
28, 32, 33, 35 e 36 citados nesta skill como "de
`context/overnight-dispatch-rules.md`" estão nesse arquivo (inteiros ou na parte
do coordenador), com a mesma numeração. Histórico e incidentes desta skill:
`docs/rodadas-autonomas-historico.md` (âncoras `dev-*`).

Sessão de desenvolvimento **supervisionada/interativa**. Escopo **default** (#4319): o backlog aberto inteiro, trabalhado em 4 ondas priorizadas (ver "Goal de esgotamento" abaixo). Como o editor está presente, ele desbloqueia ao vivo (cola um token, confirma que criou uma conta de terceiro, decide um trade-off de produto/editorial, ou autoriza uma mudança de alto blast-radius); a skill **valida o desbloqueio deterministicamente (#573)** e leva a issue até o merge **reusando a maquinaria de implementação do overnight**, com uma diferença central: **paraleliza tudo que for seguro** (inverte o #636 — ver seção de Paralelização).

**Por padrão (#4319, `goal_policy=exhaust_all`), a sessão trabalha até nenhuma issue estar aberta** — todo o backlog, não só o bloqueado, em 4 ondas priorizadas: bugs (bloqueados ou não) → bloqueadas restantes → elegíveis P0/P1 → o resto. `goal_policy=blocked_only` volta ao alvo estreito de #2636/#4297 (só o backlog bloqueado). Não é uma garantia incondicional: o Fallback de ausência (editor sai no meio), uma **interrupção do editor no gate do grupo 3** (default auto-entra desde #5321) e o guard de colisão editorial podem encerrar a sessão com o alvo não esgotado — o Goal fica registrado como não atingido, não bloqueia o encerramento. **Sem caps mecânicos de re-varredura e de profundidade de finding no develop (#4319)** — quem segura a sessão é o editor, pelos gates que ainda bloqueiam quando disparam (Gate 1 residual cat. C/E-com-custo, Gate B — #5695) ou saindo; ver "Goal de esgotamento". `goal_policy = table_only` no briefing (ou `--no-implement`, que força o mesmo comportamento) fecha quando a tabela da Fase 0 acaba, sem re-varredura. (histórico: docs/rodadas-autonomas-historico.md#dev-4319)

**Relação com o `/diaria-overnight` (#2021, #4319):** com `exhaust_all`, o develop é um **superconjunto em escopo, mas não em modo**: ataca as mesmas issues que o overnight atacaria (e mais as bloqueadas que ele não pode), com o editor presente e com permissão de perguntar; só o overnight roda desassistido. Esta skill só roda por invocação explícita do editor (`disable-model-invocation: true`) — o blast radius (merges autônomos em master + aplicação de mudanças de alto impacto) exige que a invocação seja o consentimento, mesmo padrão de `/diaria-overnight` e `/diaria-remover-votos-pixel`.

**Modelo/effort do coordenador (#3454, #8941).** O frontmatter fixa `model: claude-opus-5-5` + `effort: medium` (decisão do editor no #8941: o develop mantém `medium`, diferente do overnight/continuo, porque media decisões de julgamento ao vivo — cat. C/D/E, Gate 1, Gate de Onda, Gate B; histórico: docs/rodadas-autonomas-historico.md#dev-3454). Mesma limitação de escopo-de-turno do overnight (o override de frontmatter vale pelo turno atual; o pin cai quando `<task-notification>`/`[Subagent hand-back]` chega com o turno já encerrado, ou numa mensagem livre do editor (#9527/#11032). No modo interativo com fork-mode ligado (contexto de uso de desbloqueia/develop), o schema do Agent remove `run_in_background` e os subagentes rodam em background; em non-interactive `-p` ou fork-mode-off o parâmetro pode existir: se exposto e o próximo passo depende do resultado, usar o booleano `run_in_background: false` e conferir o retorno real. Não aplicar essa receita ao modo interativo com fork. Referência: https://code.claude.com/docs/en/sub-agents#run-subagents-in-foreground-or-background (consultada em 23/10/2026). Regra adicional: não encerrar o turno enquanto houver Agent pendente; aguardar as notificações dentro do turno. Se houver transição de turno, a sessão volta ao modelo/effort anteriores; sonda: `npx tsx scripts/lib/effective-model-probe.ts --expect-model claude-opus-5-5 --expect-effort medium`, standalone — sem `&&`/pipe, `.claude/hooks/inject-session-id.mjs` injeta o `--session-id` desta sessão; os dois `--expect-*` são obrigatórios aqui, porque o default da sonda é o par do OVERNIGHT, `claude-sonnet-5-5`/`medium`, e sem eles um coordenador develop correto em Opus sai `exit 2` e um errado em Sonnet sai `exit 0`, #9539). `--serial` e os gates humanos não mudam com o pin.

**Premissa de transporte:** assume `gh` CLI presente, igual ao overnight — toda a maquinaria reusada (`gh issue list`, `gh pr create`, `gh pr checks --watch`, `gh pr merge --squash`, `npx tsx scripts/resolve-review-threads.ts --pr {N} --check` para o gate de threads, `gh run view --log-failed`) é construída sobre `gh`. A Fase 0 roda `gh auth status`.


**Re-roteamento após releitura (#11301/#11315).** Em TODA chamada de
`route-issue.ts` para issue existente, passar `--triaged-at "{triaged_at}"`.
Depois de postar `decisao-editor` (ou outro marcador próprio), reler corpo,
labels e TODOS os comentários (`npx tsx scripts/read-issue-thread.ts --issue N`,
pelo REST, #13285) antes de rotear. Capturar `triaged_at` em ISO
no início dessa nova leitura, após a postagem; só usá-lo quando a leitura
terminar com sucesso e o veredito estiver confirmado. Nunca reutilizar o
início da sessão nem gerar o timestamp apenas na hora da escrita. Se surgir
marcador concorrente posterior, reler e reavaliar; não usar `--override-newer`
para destravar automaticamente. Isso também vale para reclassificações
posteriores na mesma sessão e chamadas sem identidade no registry.

**Decisão do editor vigente (#12389/#12413).** Com `decisao-editor` na
thread, `route-issue.ts --track develop` e `--track fora-de-rodada` são
recusados se a `--reason` não cita a decisão. Releia-a: se ela resolve o que
a razão pede, roteie para `overnight`; se ainda falta algo depois dela, diga
na razão ("decisão do editor de DD/MM já registrada; ainda exige ...").
Roteamento que contraria a decisão leva `--override-decision "motivo"`,
nunca uma razão reescrita só para passar no regex.


## Fila obrigatória de escaladas do contínuo (#12684)

No briefing inicial, rodar `npx tsx scripts/list-continuo-escalation-queue.ts --all-open`
(#13094): triagem de TODA PR aberta, não só das escaladas do contínuo. Cada
item de `queue` é uma PR escalada (`kind: escalada`) ou só aberta
(`kind: aberta`, relógio = última atividade: o maior entre a criação, o último
commit e a label `continuo-ci-fix-tentado`) há mais de 6h: apresentar URL, `lane`,
`since`, `destination` e `reason` como pendência explícita do editor, dono da fila
`briefing overnight/develop`, e registrar destino e decisão no plano/relatório.
Fila vazia dispensa esta seção; erro do comando é bloqueio de leitura da fila,
nunca evidência de ausência de pendências. `action=merge` indica condição
transitória resolvida: revalidar os gates normais antes de qualquer ação.
Draft, `bloqueio-execucao` e retenção para editor continuam bloqueados até
liberação explícita; o briefing nunca promove draft automaticamente.
`lane: manual` (branch fora de `overnight/`, `develop/`, `continuo/`: do editor
ou de autor desconhecido) só recebe `briefing` ou `fixer` (este só passadas
6h), nunca fechamento automático. Item com `claimed: true` (issue do corpo ou
da branch reivindicada por sessão viva) é só informação: não despachar nada
para ele. `claims_check: "failed"` = registro ou corpo ilegível, não claim:
o item fica em `briefing` e o `claim_reason` diz o que falhou. PRs de bot
saem em `skipped`.

**Prazo de validade de 24h (#12765; era 48h até o #13094).** Cada item traz
`expired` e `destination`. Passadas 24h, rodar
`npx tsx scripts/list-continuo-escalation-queue.ts --all-open --apply`, que fecha as de
destino `fechar-redundante`, `fechar-para-issue` (só `kind: escalada`: draft
com `bloqueio-execucao` sem escalada nunca fecha pela idade) e
`fechar-reabrir-issue` (só com a tentativa de fixer há mais de 6h)
(comentário na PR e na issue de origem, branch preservada, `gh pr reopen`
desfaz). Destino `fixer` = `dev-fixer` na branch existente (rebase + CI;
draft verde vira ready) e `npx tsx scripts/mark-continuo-ci-fix-attempted.ts --pr {N}`;
destino `briefing` segue com o editor, inclusive PR retida (#10278) ou
reivindicada por sessão viva. `failures[]` não vazio (exit 1) = reportar.

**Teto global de PRs abertos (#12765).** Antes de compor cada onda, rodar
`npx tsx scripts/check-open-pr-cap.ts`: a onda tem no máximo
`min(6, slots)` unidades; `slots = 0` = drenar as PRs abertas antes de abrir
PR nova. `verified:false` (exit 2) = não verificado, segue com o teto da onda.

## Como difere de /diaria-overnight

| Eixo | /diaria-overnight | /diaria-develop |
|---|---|---|
| **Escopo (default #4319)** | fila DESBLOQUEADA | backlog aberto **inteiro**, em 4 ondas priorizadas (`exhaust_all`); `blocked_only` restringe à fila bloqueada (#2636/#4297) |
| **Regra 1** | `AskUserQuestion` PROIBIDO pós-briefing (não pode depender de presença) | perguntar é **permitido**, mas estreitado ao que bate um dos 4 critérios de "Perguntar é exceção" (#5695) — o briefing FRONT-LOADED (Fase 0.5, #2966) colhe o máximo no início; o que sobra mid-sessão hoje é praticamente só cat. C (trade-off editorial real) e cat. E-com-custo no Gate 1, e Gate B (blast-radius) — cat. A/B, `wave_policy`/Gate de Onda e fechamento `entregue-fora-de-codigo` viraram default+banner |
| **Paralelização** | **também paraleliza desde o #6299** — mesma análise de cluster, teto **10** desde o #10821 (era 6 desde o #8486, igual ao do develop, e 3 antes; o do develop segue 6 — ver a seção de onda no overnight). Só o MERGE é serial | **paraleliza tudo que for seguro**; issues que colidem em arquivo **fundem numa unidade só** (1 PR, `Closes` múltiplo) em vez de serializar em ondas (#4319) — teto de 6 worktrees |
| **Blast-radius** | recusa alto blast-radius não-supervisionado | **aceita**, atrás de um Gate B de pré-aplicação (único gate de composição/blast-radius que continua bloqueante por default depois do #5695) |
| **Caps de terminação (#4319, #5272)** | só `findings_depth` 2 — o cap de re-varredura (`rescans_done` K=2) saiu também do overnight em #5272; lá a parada agora vem do anti-livelock + guard de colisão editorial, sem nenhum teto de relógio (decisão do editor, 260814) | **eliminados os dois** — o editor segura a sessão pelo que ainda bloqueia (Gate 1 residual cat. C/E-com-custo, Gate B) ou saindo; Gate de Onda e o gate do grupo 3 (#5321/#5695) auto-entram por default e só param a sessão se o editor intervier |

**Viés de autoria própria e PR alheio (#5484) valem aqui também, não só no overnight.** `context/overnight-dispatch-rules.md` item 16 é critério do coordenador, não do subagente — o próprio coordenador desta skill lê e aplica: issue escrita pela própria sessão overnight/develop/continuo (inclusive herdada do `plan.json` do overnight, passo 2 da Fase 0) nunca vira cat. C "precisa mais contexto" sem bater literalmente um dos 4 critérios de "Perguntar é exceção"; e um PR alheio já aberto pra uma issue da fila só é razão pra não implementar de forma independente se passar as 3 perguntas do checklist (autor conhecido? CI rodando/verde? atualizado nas últimas ~24-48h?) — falhando qualquer uma, tratar como se o PR não existisse.

**Reuso verbatim do overnight (Fase 1 de implementação):** o prompt de cada subagente implementador **cita `context/overnight-dispatch-rules.md`** (checklist canônico compartilhado com o overnight, #3453 Rec 4 / #3454 Rec 2) em vez de reproduzir as regras, e repete o guard de publicação, o nome literal da branch (`develop/fix-NNNN`, `develop/fix-NNNN-MMMM` para unidade fundida e `develop/blast-NNNN` para cat. D) e a proibição de merge. Subagente `dev-implementador` (`claude-opus-5-5`/`medium` no frontmatter, #9081) com `isolation: worktree` → `npm ci` → **`npx tsc --noEmit` → testes afetados/novos** (**NUNCA a suíte completa `npm test` local, #2959**; item 4; histórico: docs/rodadas-autonomas-historico.md#dev-2959) → branch → PR `Closes #NNNN` com corpo conferido por `gh-pr-safe-edit.ts --verify-body --worktree {worktree da unidade}` (item 9) → self-review (#2038) → retorna ao coordenador (**PROIBIÇÃO EXPLÍCITA #6762: o subagente nunca roda `gh pr merge` em variante nenhuma — merge é EXCLUSIVO do coordenador; item 11**) → fixer 2-agentes (`dev-fixer`, #9081) → resolução de threads com carve-out FORBIDDEN → **fleet review pré-merge explícito pelo coordenador (#4383, ver Gates — NÃO é reuso verbatim, ver nota abaixo)** → **gate determinístico de 2 condições (#2210/#2222)** → squash-merge (coordenador) → verify #573; #633 (bugfix exige teste de regressão); retry GitHub 401/429 com backoff; guard de publicação no prompt do subagente; #738 fail-fast de MCP; `plan.json` como fonte de verdade pós-compaction; timeline via `scripts/render-overnight-timeline.ts` (helper fluxo-neutro `renderTimeline`, #2637 — passar `--title "Timeline da sessão" --total-label "Total da sessão"`).

**Exceção ao "verbatim" — fleet review pré-merge (#4383):** todo o resto deste parágrafo É reuso verbatim do overnight, mas o passo de fleet review não. `.claude/hooks/pr-create-review.mjs` (`resolveEffort`) resolve o effort por TAMANHO DE DIFF desde o #6393 (`docs/pr-review-effort.md`), não por branch: PR do develop (`develop/fix-*`/`develop/blast-*`, nunca `overnight/*`, e sem o marker de sessão overnight, que só o overnight grava) cai no caminho geral — diff conhecido abaixo de `EFFORT_DIFF_LINE_THRESHOLD` (500 linhas, adições+remoções) → `low` (1 agente); ≥ limiar ou tamanho desconhecido → `max` (fleet de 5 agentes). Logo, o effort do PR do develop é o que o hook resolveu para ELE, não `max` fixo (#10621). O overnight resolve por limiar PRÓPRIO (1000 linhas). Como o subagente implementador não pode dispatchar Agent (#207 — mesma razão da regra 8 do checklist), o fleet por PR é passo explícito do coordenador (ver Gates, "REVIEW DE FLEET PRÉ-MERGE"), sem depender do hook disparar nem de iniciativa ad-hoc. (histórico: docs/rodadas-autonomas-historico.md#dev-4383)

## Regra permanente: sessão interativa não faz o que o `300` faria sozinho (#5751)

O `/diaria-overnight` roda desassistido no servidor `300` e drena o backlog
desbloqueado por conta própria — toda issue que ele pegaria sozinho e que uma
sessão interativa (esta skill, ou uma sessão comum na máquina do editor)
executa no lugar dele é trabalho duplicado; o `is-claimed` mecânico (Fase 1
passo 4 abaixo) evita a corrida de escrita, não o desperdício. (histórico:
docs/rodadas-autonomas-historico.md#dev-5751)

**O que uma sessão interativa PODE trabalhar — só ela, qualquer 1 dos 4
critérios abaixo já qualifica:**

1. **Exige o editor presente** — decisão de trade-off, desbloqueio de
   credencial, autorização de blast-radius, resposta a gate. É a própria
   razão de existir das categorias A-E (tabela "Categorias de bloqueio"
   acima) — toda issue que classificar em A-E bate este critério por
   definição.
2. **Exige esta máquina** — label `windows` (Chrome logado, ComfyUI, `data/`
   via OneDrive local). Ver seção "Labels de máquina" abaixo — é
   exatamente o que `classifyExecTrack` já roteia pra Develop.
3. **O editor pediu isto nesta conversa** — pedido direto tem precedência
   sobre a fila; inclui tanto uma mensagem livre pedindo a issue quanto
   `--issues N,M` explícito na invocação (passar a flag já É o pedido
   direto). **(#7946) Esse pedido também vence o MOTIVO do bloqueio, não só
   a competição com o `300`** — ver "Escopo do Gate 1 residual" (cat. A/B
   sem front-load) e a nota após a tabela "Categorias de bloqueio" (bloqueio
   sem categoria A-E mapeada, ex: veto de priorização por funil da whitelist
   AAARRR) na Fase 1.
4. **Já reivindicada por esta mesma sessão** — trabalho em progresso
   (`unblock_status`/`status` já avançado, ou `claim-issue` já registrado
   por esta sessão) não é abandonado no meio por causa deste filtro.

**Leitura mecânica dos critérios (#5907 item c).** O critério 1 NÃO exige
triagem em prosa de cat. A-E: **`classifyExecTrack === "develop"` satisfaz o
critério 1 por si só** — é o mesmo veredito que o painel de Triagem (#5462)
grava quando a issue exige editor presente (`windows`, `develop-track`,
bloqueio que o editor destrava ao vivo — `trade-off-real` não conta desde o
#7493: é pergunta de briefing do overnight), e é o que a Fase 0 passo 6a grava
em `exec_track_painel`. Simetria: **o default "fica para o `300`"
pressupõe `exec_track_painel === "overnight"`** — issue com track gravado
`develop`/`bloqueada`/`agendada`/`fora-de-rodada` nunca é despachada pro
filtro como "elegível pro 300", e `validate-develop-plan-motivo.ts`
(#5914, gap b) recusa `deixado-para-o-300` nesses tracks. Por isso o
passo 6a é pré-condição do filtro: sem o campo gravado (gate da Fase 2,
#5907 item a), o filtro fica cego pra diferença entre "overnight de
verdade" e "nunca foi triado".

**Todo o resto fica para o `300`** — mesmo issue elegível (sem bloqueio,
sem `windows`), mesmo com `goal_policy=exhaust_all` ativo (ver tensão
resolvida abaixo). Fora de escopo, explicitamente: isto não transfere pro
`300` o que exige gate humano nem o que exige esta máquina — reduz
duplicação, não trabalho impossível.

**Tensão com `exhaust_all` — resolvida a favor desta regra.** `goal_policy`
(seção "Goal de esgotamento" abaixo) decide QUAL é o alvo — o backlog
inteiro, em 4 ondas, sob `exhaust_all` — não decide se **esta sessão** é
quem trabalha cada issue do alvo. O alvo é montado na Fase 0 (passos 1-9);
o filtro roda depois da montagem das ondas e antes de qualquer issue do tier
corrente entrar em Gate 1/implementação (Fase 1, ver "Filtro do servidor 300"
abaixo): decide, issue por issue, se ela é trabalho desta sessão ou se
fica para o `300`. Sob `exhaust_all`, uma issue elegível comum (sem cat.
A-E, sem `windows`) de 1a-bug-desbloqueada, 2 ou 3 **não é despachada por
esta sessão**. `blocked_only` já satisfaz o
filtro por construção (só cat. A-E, que já bate o critério 1) — o filtro
não remove nada de uma sessão `blocked_only`. `table_only`/uma sessão
`--issues N,M` explícita também já satisfazem o critério 3 por definição
(o editor pediu essas issues especificamente ao invocar a skill) — o filtro
nunca esvazia uma sessão assim.

**Filtro do servidor 300 — onde roda.** Fase 1, imediatamente antes do passo 1
("Diagnosticar"), pra CADA issue do tier corrente ainda sem status
terminal: bate cat. A-E (critério 1)? tem label `windows` (critério 2)? foi
pedida nesta conversa, inclusive via `--issues` (critério 3)? já está em
progresso nesta sessão (critério 4)? — qualquer um dos 4 → segue pro passo 1
normalmente. Nenhum dos 4 → status terminal `pulada` motivo
`deixado-para-o-300`, **sem** Gate 1, **sem** worktree, **sem**
comentário durável na issue (diferente de `nao-destravavel-na-sessao`: isto
não é bloqueio, é só "não é esta sessão que trabalha isto" — o `300`
pega normalmente na próxima rodada, e comentar em cada issue deferida seria
ruído sem valor quando dezenas ficam nesse status na mesma sessão). Conta
como terminal pro Goal (soma no `remaining`→0/`reached`, mesmo padrão de
`entregue-fora-de-codigo`/`nao-tentada` — ver "Nenhuma issue aberta" na
seção Goal abaixo). Registrar em `plan.json` (`status: "pulada"`,
`motivo: "deixado-para-o-300"`) e no relatório da Fase 2 como lista
agregada ("N issues elegíveis deixadas para o 300: #A, #B, ...") — não
issue a issue na resposta ao editor. **Se a issue estava reivindicada por
esta sessão (`claim-issue` rodou numa onda anterior e o trabalho não foi
adiante), soltar a claim aqui:** `npx tsx scripts/lib/session-registry.ts
unclaim-issue --kind develop --issue {N}` (standalone, `--session-id`
auto-injetado) — segurar uma issue que o próprio status diz "não é meu" é
contraditório e bloqueia o `300` por até 90min à toa (#6317). No-op
(exit 1) reason `no-op-not-claimed` — não é erro, é o caso comum (issue
nunca chegou a ser reivindicada antes de cair no filtro). **`no-op-unreadable`
é diferente e NÃO deve ser tratado como o caso comum acima:** o registro
existe mas está momentaneamente ilegível (sync do OneDrive) — a claim pode
estar ativa no disco; se aparecer, investigar (reler o registro, tentar de
novo) antes de seguir como se não houvesse nada pra soltar.

## Regra permanente: narração terminal é parada indevida, mesmo sem pergunta (#5769)

Complementa o #5751 (o quê esta sessão trabalha): esta decide **por quanto
tempo seguido** ela trabalha antes de devolver o turno. Um relatório de estado
com convite implícito no fim do turno ("o próximo passo é X, mas antes vale
dizer o estado...") tem o mesmo efeito de perguntar, mesmo sem ponto de
interrogação. (histórico: docs/rodadas-autonomas-historico.md#dev-5769)

**Teste comportamental, aplicar em TODO fim de turno:** *se o editor não
responder nada, o trabalho para?* Se sim — foi uma pergunta, mesmo escrita
como afirmação, e o turno não devia ter terminado ali.

**Anti-padrões nomeados — nunca escrever isto no fim de um turno (#5769):**

| Frase escrita | Por que é narração terminal | O que fazer em vez disso |
|---|---|---|
| "O próximo passo natural é o Google, para fechar os três painéis. Mas antes disso vale dizer o estado..." | relatório de estado + adiamento do óbvio | auditar o Google, sem anunciar antes |
| "Se você quiser que eu pegue mesmo assim, é só dizer" | devolve decisão que a sessão já podia tomar | decidir e seguir |
| "Sigo nessa ordem se você não redirecionar" | convite a redirecionar sem necessidade | seguir, sem abrir a janela |
| "Começo nela assim que este review voltar" | trata review/CI em background como bloqueio de turno | pegar a próxima unidade agora, retomar quando notificar (item 3 abaixo) |
| "Aviso quando o fleet voltar" | mesmo padrão do anterior, fim de turno em vez de log | mesma correção — continuar trabalhando, não anunciar espera |

**As 3 resoluções (o que continua parando a sessão é o parágrafo seguinte):**

1. **Default de encadeamento dentro de uma unidade reivindicada.** Terminar o
   item N de uma issue já reivindicada por esta sessão e ter item N+1 na
   mesma issue = seguir direto pro N+1 — sem relatório intermediário, sem
   confirmação, sem anunciar a transição. O relatório ao editor vai no fim da
   issue **inteira**, não entre os itens dela.
2. **Trabalho paralelo enquanto algo bloqueia.** Review de fleet rodando, CI
   rodando, um agente em background — nenhum dos três é motivo pra parar o
   turno: é motivo pra pegar a **próxima unidade** da fila e voltar quando o
   mecanismo assíncrono notificar. Nunca um turno que termina "esperando X".
3. **Escolher a próxima unidade sem consultar.** Ao esgotar uma issue, a
   seguinte sai da fila pelo critério já documentado desta skill (prioridade +
   trilha + não-reivindicada + `OPEN`) — sem apresentar opções ao editor.
   Apresentar opções **já é** perguntar, mesmo sem interrogação.

**O que continua parando a sessão — inalterado.** Os 4 critérios do #5321
(irreversível pra terceiros, trade-off editorial genuíno, gasto real acima do
trivial, resposta que muda materialmente o trabalho), os dois gates de projeto
da diária (Stage 4 revisão, Stage 6 agendamento), e os guards de infra (#738
MCP indisponível, #3938 `AskUserQuestion` falhando). Também intactos: o Gate 1
residual (cat. C/E-com-custo) e o Gate B desta skill, que seguem
`AskUserQuestion` bloqueante por design — esta seção trata só do que acontece
**depois** de um gate responder ou de uma unidade fechar. O item 2 do
"Surfacear NA HORA" (#5727) continua sendo a exceção correta pro bloqueio
tipo-editor genuíno (frase informativa sobre impedimento real, não convite).

## Regra permanente: responder ao editor não encerra o turno (#5773)

Complementa o #5751 e o #5769: **responder a uma mensagem do editor não é o
turno inteiro** — o trabalho em andamento não sai do escopo por causa da
resposta. (histórico: docs/rodadas-autonomas-historico.md#dev-5773)

**A correção, em 3 passos — responder é uma tarefa a mais dentro do turno,
não o turno:**

1. **Responder ao que foi perguntado** — completo, sem economizar.
2. **Na mesma volta, retomar o trabalho interrompido** — sem anunciar que vai
   retomar (isso seria a narração terminal do #5769 outra vez), apenas
   retomando.
3. **O turno termina quando o TRABALHO para, não quando a resposta acaba.**

**Teste operacional, verificável:** *se havia trabalho em andamento quando a
mensagem chegou, e o turno terminou sem nenhuma ferramenta de trabalho
(implementação, teste, PR, review — qualquer tool call que não seja só texto
de resposta) ter sido chamada depois da resposta, foi parada indevida.*

**Exceção única — redirecionamento explícito.** Quando a mensagem do editor
redireciona o trabalho ("pare isso", "faça aquilo primeiro", "esquece por
enquanto"), o trabalho antigo é abandonado ou reordenado **de propósito**, e
é o trabalho novo (não o antigo) que precisa continuar na mesma volta —
retomar o item errado depois de um redirecionamento explícito seria ignorar
o editor, não obedecer a esta regra.

**Caso especial — perguntas de status.** "Como está?", "quantas faltam?",
"qual o próximo passo?": responder sem continuar o trabalho transforma a
sessão numa consulta de status. **Se o editor precisa perguntar "como está?",
a sessão já parou.**

Nada nesta seção afrouxa o que já para a sessão de propósito (mesma lista do
#5769 acima); vale só para o instante logo **depois** de uma resposta
completa e sem gate pendente: se existe trabalho em voo, ele continua na
mesma volta.

## Argumentos

- **`AAMMDD` (opcional)** — data-rótulo da sessão (nomeia `data/develop/{AAMMDD}/plan.json`). **Não é data de edição** (nenhum stage editorial destrutivo depende dela; a regra D+1 não se aplica). O default é seguro (hoje = data do tick, nome do arquivo em `data/develop/`), **aplicado automaticamente com banner** (`Data assumida: {AAMMDD}. Passe AAMMDD explicitamente para outra sessão.`) — nunca pergunta por confirmação (mesma forma que #5321 impôs ao pipeline: imprimir a data assumida em destaque, com instrução de passar `AAMMDD` para outra edição). A data é fixada no `plan.json` no início da Fase 0 e relida de lá; se a sessão cruzar meia-noite, o arquivo já indica o rótulo correto para retomar.
- **`--issues N,M,…`** — restringe a issues específicas, pulando a varredura. Issue não bloqueada (trabalho de overnight) → permitir-com-aviso.
- **`--only A,B,C,D,E`** — restringe por categoria de bloqueio (minimiza a troca de contexto do editor).
- **`--bugs`** (#3375) — restringe a sessão a issues bloqueadas com label `bug`; `enhancement`/`documentation`/cleanup/etc. ficam fora mesmo que desbloqueáveis por todos os outros critérios. Compõe com `--issues`/`--only` (ex: `--bugs --only A,B` = só bugs bloqueados por credencial ou conta externa). Aplica-se na varredura (Fase 0 passo 2/3) e na herança de triagem do overnight (passo 2) — issue herdada sem label `bug` não entra na tabela. Sem a flag, comportamento atual sem mudança.
- **`--priority [P0,P1,P2,P3]`** (#3499, aceita lista) — restringe a sessão a issues bloqueadas cujo label de prioridade ∈ conjunto passado (ex: `--priority P2` ou `--priority P0,P1`); as demais ficam fora de escopo mesmo que desbloqueáveis por todos os outros critérios — não são "puladas por bloqueio", simplesmente não entram, mesmo tratamento do `--bugs`. Compõe com `--issues`/`--only`/`--bugs` (ex: `--only A,B --priority P0,P1` = só cat. A/B com prioridade P0 ou P1; `--bugs --priority P2` = só bugs P2). Aplica-se na varredura (Fase 0 passo 2/3) e na herança de triagem do overnight (passo 2) — issue herdada cuja prioridade ∉ conjunto passado não entra na tabela. Sem a flag, comportamento atual sem mudança.
- **`--track {overnight|develop|agendada|bloqueada|fora-de-rodada}`** (#5708) — restringe a sessão ao track que `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`, o MESMO módulo que a Triagem do Studio usa) atribui a cada issue — não a onda/categoria em prosa desta skill (Fase 0 passos 4-6). É o jeito de pedir literalmente "faça o que o painel chama de Develop": `--track develop` ataca só o que o painel já rotula Develop. Compõe por interseção com `--issues`/`--only`/`--bugs`/`--priority`. Sem a flag, o filtro por track de prosa (ondas 1a-3, `goal_policy`) continua sendo o comportamento padrão, sem mudança.
- **`--dry-run`** — só Fase 0 (varredura + classificação + tabela), zero side-effect.
- **`--no-implement`** — modo "só destravar": gate de desbloqueio + validação + registro durável, **sem** implementar (deixa pro overnight posterior, que então vê as issues como `elegivel`). Goal (#4297) não é avaliável neste modo — ver "Incompatibilidade estrutural com `--no-implement`" na seção "Goal de esgotamento".
- **`--serial`** — desliga a paralelização (volta ao 1-PR-por-vez do overnight). Default é **paralelo seguro**.
- **`--attack-order {a|b|c}`** (#4498) — sobrescreve o default `so_destravaveis_agora` (c) sem passar pelo briefing (a = por prioridade; b = por categoria; c = só as destraváveis agora). Só necessário quando o editor quer uma ordem diferente do default nesta sessão especificamente — a Fase 0.5 não pergunta mais isso por padrão (ver item 1).
- **`--wave-policy {auto|per_wave}`** (#5695) — sobrescreve o default `auto` (composição de onda segue sem aprovação prévia, banner só) sem passar pelo briefing; `per_wave` restaura o Gate de Onda bloqueante de antes do #5695. Mesmo padrão do `--attack-order` acima — a Fase 0.5 não pergunta mais isso por padrão (ver item 5 da Fase 0.5).

## Paralelização segura no desenvolvimento (inverte o #636)

**Não é a supervisão humana que torna o paralelo seguro (#6299)** — são mecanismos DETERMINÍSTICOS, nenhum exigindo o editor presente (histórico: docs/rodadas-autonomas-historico.md#dev-6299): worktree isolado por unidade, análise de cluster de conflito, fusão de cluster colidente (#4319), `is-claimed`/`claim-issue` check-and-set (#6236), `conflicts` por arquivo (#6168), merge lock, fleet review pré-merge obrigatório (#4383), Gate 2 determinístico (#2210/#2222) e o guard de `gh pr merge` por subagente (#5716). A supervisão humana cobre outra coisa — o Gate 1 cat. C (trade-off editorial) e o Gate B (blast-radius) —, e é isso, não o paralelismo, que continua separando esta skill do overnight.

**"Seguro" = sem colisão de arquivo entre PRs diferentes**, via análise de **cluster de conflito**:

1. Para cada issue **desbloqueada+validada** (dentro do tier corrente, ver "Goal de esgotamento"), mapear o conjunto de arquivos que toca (corpo da issue + grep dos paths/símbolos citados).
2. Issues cujos conjuntos de arquivos se **intersectam** formam um **cluster** → **fundem numa única unidade** (#4319): um worktree, um branch, um subagente implementador, **um PR só**, com `Closes #N` explícito pra CADA issue do cluster no corpo do PR. Issues cujo conjunto de arquivos não intersecta ninguém são **singletons** — cada uma vira sua própria unidade.
3. **Onda paralela = 1 unidade por cluster fundido + todos os singletons**, todas simultâneas (não há mais "próxima onda" por causa de colisão — colisão deixou de ser motivo pra adiar).
4. Cada unidade roda num **worktree isolado próprio** (`isolation: worktree`) com seu subagente implementador **concorrente**.
5. **Teto de concorrência = 6 worktrees simultâneos** (#2754; `--serial` desliga; se a máquina engasgar, baixar manualmente é seguro — é teto de throughput, não invariante de correção). **Teto é POR SESSÃO, não da máquina inteira (#5156 item 6)** — com uma sessão overnight (ou outra develop) rodando em paralelo na mesma máquina, a soma real de worktrees concorrentes pode passar de 6; `session-registry.ts list-active` expõe `active_worktrees` de cada sessão ativa pra essa decisão informar quantos abrir nesta onda (ver Fase 1 passo 4).

**Substitui o #636, não o afrouxa:** o invariante real é "nunca 2 PRs que colidem abertos ao mesmo tempo" — a fusão de clusters (#4319) satisfaz isso **por construção, eliminando o caso** em vez de resolvê-lo por serialização (o #636 fica mais satisfeito, não menos). Drafts de CI-vermelho não contam. Unidades cat. D (blast-radius) rodam **sempre solo** — nunca fundem com ninguém, mesmo colidindo em arquivo. A **Fase 1.5** (review consolidado) é a rede que enxerga interações entre unidades da mesma onda que não colidiram em arquivo mas colidem semanticamente.

**Efeitos práticos da fusão (#4319):**
- `Closes #N` por issue do cluster — nunca um `Closes` só cobrindo a issue "principal" e as demais como `Refs`; cada issue precisa fechar por si (checar `gh issue view --json state` pós-merge pra cada uma, não confiar no corpo da PR — padrão já registrado no #4203, `feedback-overnight-verify-issue-closed-after-merge`).
- **Revert é tudo-ou-nada** pras issues fundidas — reverter uma isoladamente do PR fundido já seria conflituoso de qualquer forma (elas tocam o mesmo arquivo por definição do cluster). Se uma decisão de reverter só uma parte aparecer, o PR fundido inteiro volta, e as demais issues do cluster reabrem pra próxima sessão.
- O editor **não** pediu agrupamento por tema/área sem colisão real de arquivo — só issues que genuinamente tocam o mesmo arquivo fundem. Não generalizar pra "issues parecidas".

## Categorias de bloqueio + protocolo de desbloqueio (editor faz X → coordenador faz Y)

| Cat | Bloqueio | Editor faz X | Coordenador faz Y | Validação #573 |
|---|---|---|---|---|
| **A** | credencial-runtime (ex: token Instagram/Threads) | cola o token/chave | grava em `.env` (gitignored; **se não existe num clone fresco, criar de `.env.example`**; atualizar `.env.example` com novas vars); implementa→PR→merge; remove `external-blocker` | `publish-*.ts --dry-run` exit 0 + resposta de API válida — **nunca** "válido" só por colar |
| **B** | conta-externa-de-terceiro (ex: Kit da Clarice) | confirma que a conta já existe; cola IDs/credenciais | se existe: probe real → implementa→PR→merge; se não: máximo offline (config/stubs/doc) + **aplica a label `external-blocker`** (`gh issue edit N --add-label external-blocker` — #5462/#5533 — **ressalva #6196: `route-issue` (`npx tsx scripts/route-issue.ts --triaged-at "{triaged_at}" --issue N --track bloqueada`) substitui isso quando mergeado; até lá, `gh issue edit` ainda aceitável**) + comentário do estado parcial **e grava `plan.json` status `pulada` motivo `nao-destravavel-na-sessao`** (#4297 — conta ainda não existe é o exemplo canônico de "intrinsecamente irresolvível na sessão", ver "Goal de esgotamento"). **`on-hold` deixou de ser aplicado/removido automaticamente por este fluxo (#4498)** — issue com esse label é excluída do alvo inteiro no passo 5 da Fase 0 (nunca chega no Gate 1); se o editor quiser pausar indefinidamente uma issue cat. B sem conta ainda, aplica `on-hold` manualmente no GitHub, e remove quando quiser reativar | probe real contra a conta antes de declarar pronto |
| **C** | decisão-produto/editorial (ex: design system; UX trade-off) | escolhe o trade-off (`AskUserQuestion`) | **posta a decisão como comentário durável** na issue (marcador `decisao-editor`, #5373 — **usar `route-issue`** (`npx tsx scripts/route-issue.ts --triaged-at "{triaged_at}" --issue N --track {destravado}` com `--reason` incluindo a resposta resumida, #6196: substitui `gh issue edit` direto que nunca tinha chamador no write-path), remove a ambiguidade (→ elegível — inclusive **removendo a label `trade-off-real`** se presente com `route-issue --track {destravado}`, #5462: sem isso a issue fica presa com uma pergunta já respondida na fila de PERGUNTAS do briefing do overnight (#7493; ou em Develop, se `windows`/`develop-track` também estiverem presentes, que vencem na precedência); `gh issue edit N --remove-label trade-off-real` é fallback aceitável) —, implementa a opção escolhida. **Gate mecânico obrigatório logo após postar o comentário (#5821; o mesmo gate roda no briefing do overnight, #7493):** `npx tsx scripts/check-trade-off-label-cleared.ts --issue N` — sai `exit 1` se a decisão foi registrada mas a label ainda está presente (sinal de que o `--remove-label` acima foi esquecido) e `exit 3` quando a label está lá mas os comentários não puderam ser lidos (não verificável — rodar de novo, nunca tratar como ok); rodar o comando de remoção e checar de novo antes de seguir pra implementação | a decisão postada como comentário **é** a evidência durável, mais o `exit 0` de `check-trade-off-label-cleared.ts` como confirmação de que a label foi de fato removida |
| **D** | supervisão-blast-radius (ex: refactor pervasivo / migração ~N sites; `not-this-week`) | autoriza no **Gate B** após ver o diff-walkthrough | implementa em branch, roda local primeiro, Gate B, só após "ok" aplica em escala; merge com confirmação humana | teste local + diff de amostra revisado antes da escala |
| **E** | plataforma-sem-fix (ex: CSP/plan-gated de plataforma) | decide workaround vs upgrade vs documentar (só ASK se algum caminho custa dinheiro — critério 3 do #5321, ver nota abaixo) | implementa workaround→PR→merge; OU "documentar" atualiza o doc, converte a issue p/ `elegível-documentada` (label removida — próximo overnight pega) **e grava `plan.json` status `pulada` motivo `nao-destravavel-na-sessao`** (#4297 — handoff pro overnight conta como terminal aqui, mesmo sem merge nesta sessão); OU "upgrade" confirmado → vira cat. A/B | estado de plataforma via `scripts/lib/publish-state.ts` antes de afirmar que o workaround funciona |

**"Editor faz X" da tabela acima só se aplica no front-load (#5695).** A coluna "cola o token/chave" (cat. A) / "confirma que a conta já existe" (cat. B) descreve o que acontece na Fase 0.5 (item 3/4, batchado, "colar TODOS os tokens/confirmar TODAS as contas de uma vez"). **Não** descreve mais um `AskUserQuestion` por issue no Gate 1 residual da Fase 1 — cat. A/B que chegam lá sem front-load já resolvido seguem por default pro terminal `nao-destravavel-na-sessao` sem novo pedido (ver Fase 1, "Escopo do Gate 1 residual" acima), **exceto quando a issue foi pedida explicitamente via `--issues` nesta invocação (#7946) — ver a exceção lá**. O editor colar o insumo depois disso é sempre iniciativa dele, nunca a skill perguntando de novo. Cat. C mantém `AskUserQuestion` sempre (trade-off editorial real, critério 2 do #5321, sem default seguro possível). Cat. E só pergunta quando algum caminho envolve gasto real (critério 3) — sem sinal de custo no corpo da issue, o default é "documentar" (caminho sempre seguro e reversível: converte pra `elegível-documentada`, nunca aplica um workaround não revisado sem perguntar).

**Bloqueio SEM categoria A-E mapeada (#7946).** Nem todo `bloqueada` de `classifyExecTrack` cai numa das 5 categorias acima — ex: o veto de priorização por funil da whitelist AAARRR (`matched: "label:aarrr-fora-da-whitelist"`, `scripts/lib/aarrr-whitelist.ts`) não é credencial, conta, trade-off, blast-radius nem plataforma; é só uma escolha de ONDE investir esforço de crescimento novo. Sem `--issues` citando a issue, esse bloqueio segue como está — nenhuma sessão autônoma o resolve, por design (é o próprio ponto da whitelist). **Com `--issues N,M` citando a issue nominalmente, o pedido explícito já É a decisão de prioridade**: a issue entra na fila de resolução como se elegível — sem `AskUserQuestion` — e o coordenador registra o override como comentário durável na issue (ex: "processada apesar do veto de priorização da whitelist AAARRR, por pedido explícito via `--issues` em {data}") **e imprime um banner no terminal** (`Issue #N — bloqueio de PRIORIZAÇÃO (não técnico) ignorado por pedido explícito via --issues: {matched}.`). Isto **não** desarma um bloqueio de categoria A-E mapeada coexistindo (credencial ainda ausente continua ausente) — cobre só o motivo SEM categoria, que por definição não depende de nenhum insumo que o `--issues` não supra.

Categoria inferida na Fase 0 por **labels reais** (`external-blocker`→A/B/E conforme corpo; `kit-migration`→B; `not-this-week`→D; `beehiiv`→E) + corpo (token/chave→A; "criar conta"/"aguardando terceiro"→B; "decidir entre"/"OU"→C; "blast radius"/"~N sites"/"migração"→D; "CSP"/"plan-gated"/"API limit"→E). **`on-hold` não infere categoria nenhuma** (#4498) — issue com esse label é excluída do alvo inteiro no passo 5 da Fase 0, ANTES de chegar nesta classificação (ver "Excluir do alvo, em qualquer política"). **Antes de hardcodar qualquer label, rodar `gh label list`** e confirmar o conjunto real `{ external-blocker, on-hold, kit-migration, not-this-week, beehiiv }` (usar `external-blocker` — NÃO `bloqueio-externo`, que não existe como label; `bloqueio-externo` só aparece como valor textual do campo `motivo`/`status` do `plan.json` do overnight, não como label do GitHub).

**Antes de classificar como cat. C — decisão-produto (#5373):** se a issue tem a label `decisao-registrada` (ou mesmo sem ela, como rede de segurança), rodar `npx tsx scripts/lib/issue-decisions.ts --issue N` (`scripts/lib/issue-decisions.ts`). **Comparação concreta (#6961):** a decisão vale quando é o marcador MAIS RECENTE da thread (comparada contra `execution_block`, nunca contra `updatedAt` da issue — o próprio POST do marcador bumpa `updatedAt`, tornando `decided_at >= updatedAt` insatisfazível por construção). Decisão encontrada e mais recente que um eventual bloqueio → a issue **não** é cat. C — a decisão já existe, usar como contexto e classificar pela EXECUÇÃO restante (elegível se nada mais falta; cat. A/B/E se a execução esbarra em bloqueio novo distinto da decisão em si). Só reavaliar como cat. C se existir um `execution_block` mais recente que a decisão (ver item seguinte).

**Bloqueio de execução já registrado (#5373 item 5) — não reabrir cat. C nem reclassificar como o mesmo bloqueio de sempre.** O mesmo comando acima também devolve `execution_block` (via `latestExecutionBlockFor`). Issue com label `bloqueio-execucao` (ou sem ela, rede de segurança) cujo `execution_block.recorded_at` é **posterior ou igual** a um eventual `decided_at` (#6961: os dois marcadores comparados entre si, nunca contra `updatedAt`) → a decisão já existe E o bloqueio de execução restante já está documentado: classificar direto na categoria A/B/E correspondente ao `motivo` registrado (sem nova pergunta, sem nova checagem de cat. C), usando `execution_block.motivo` como o "o-que-falta-destravar" da tabela do passo 7. Uma decisão nova, mais recente que o bloqueio → o bloqueio pode ter sido resolvido nesse meio-tempo, reavaliar normalmente (probe real antes de assumir que segue bloqueado).

**Registro do bloqueio de execução, quando distinto da decisão em si.** Ao tentar destravar uma issue no Gate 1 e a execução esbarrar num impedimento novo (acesso que esta sessão não tem, guard de publicação, feature gated por plano) — mesmo já com a decisão cat. C resolvida — `npx tsx scripts/route-issue.ts --triaged-at "{triaged_at}" --issue N --track bloqueada --reason "{motivo}" --sessao develop` — **desde #7270, embute automaticamente o marcador `bloqueio-execucao` (`{recorded_at, motivo, condicao}`) no mesmo comentário do roteamento; não construir `formatExecutionBlockMarker` à mão nem postar comentário separado**. Dependência de outra issue → `--depends-on N` (marcador `depends-on:` #7137 já precisa estar no corpo); qualquer outro impedimento → condição `externo` (default); manter/gravar `unblock_status` refletindo o bloqueio real (não "decisão pendente"). Nunca re-perguntar a decisão já tomada.

**Nenhuma issue remanescente sem cat. A-E explícita (#5376).** Toda issue
que a Fase 0 encontra no backlog bloqueado precisa sair com exatamente UMA
das 5 letras — nunca um rótulo genérico ("bloqueada"/"decisão pendente")
cobrindo issue que cabia em cat. A/B/E ou que já tinha caminho de execução
claro no corpo (→ elegível). Reler o corpo inteiro antes de rotular, nunca
classificar só pelo título/label. (histórico:
docs/rodadas-autonomas-historico.md#dev-5376)

**Issue com checklist/múltiplos itens: classificar item por item, não a
issue inteira (#5379)** — nunca jogar a issue inteira numa única letra A-E
quando só 1 item depende do bloqueio e os demais já têm caminho de execução
claro. Antes de rotular como A-E uma issue com múltiplos itens: percorrer cada item
separadamente. Itens sem decisão/credencial pendente ficam **elegíveis**
(voltam pro dispatch normal, cat. A-E vira irrelevante pra eles) mesmo que
outro item da mesma issue permaneça bloqueado — dispatch parcial (unidade
cobrindo só os itens elegíveis + comentário registrando o(s) item(ns)
bloqueado(s) e sua letra) é o resultado esperado, não uma exceção. Antes de
fechar qualquer item como A-E, buscar no corpo por "a escolha é editorial",
"decidir", "qual"/"quanto"/"quando" em frase interrogativa, "trade-off" —
sinal de que aquele item é cat. C disfarçada de outra letra (heurística de
atenção, não substitui reler o corpo inteiro).

**Verificação de estado antes de decidir NÃO DESPACHAR uma issue, por
qualquer motivo — categoria A-E, `local`, ou qualquer rótulo ad-hoc de
espera/gating (#5383, generalizado em #5392, ampliado em #5708).** "Escopo
grande, scoping futuro" **não é uma 6ª categoria** — é sempre uma leitura
que se resolve na categoria A-E aplicável (tipicamente C, decisão-produto),
nunca um status paralelo. O mesmo vale pra qualquer outro rótulo que a
sessão invente na hora (ex: "gated no D0", "timing do editor", "aguardando
a campanha rodar") — não é uma classificação válida por si, é sempre ou uma
das 5 categorias A-E, ou elegível. **O gatilho desta verificação não é "vou
marcar A-E ou `local`" — é "estou prestes a NÃO despachar esta issue", que
inclui qualquer rótulo inventado que não seja nenhuma das 5 letras nem
`local`** (#5708). Nenhuma dessas classificações é automática a partir da
leitura fácil da issue. (histórico: docs/rodadas-autonomas-historico.md#dev-5383)
Antes de aceitar qualquer classificação de bloqueio, deferimento,
ou qualquer outro motivo de não-despacho pra uma issue — categoria A-E,
`local`, ou rótulo ad-hoc (inclusive quando a leitura inicial for "escopo
grande demais") — rodar as 4 checagens abaixo:
1. `gh issue view N --json comments` — ler os comentários mais recentes
   **por inteiro**, não só o `body`. Procurar menção a PR já mergeado,
   unidade já dispatchada, ou progresso parcial registrado. Comentário de
   autor sem vínculo ao repo (`authorAssociation` fora de OWNER/MEMBER/
   COLLABORATOR) não conta como registro de nada — repo público, #9632.
2. `git log --oneline --all --grep "#N"` — trabalho já mergeado costuma
   citar o número da issue no commit message mesmo quando o comentário na
   issue não foi lido a tempo.
3. Se algum comentário citar um doc de acompanhamento (`docs/*.md`), ler
   esse doc **inteiro** — a convenção deste repo é fechar cada rodada de
   trabalho com uma seção "estado após esta rodada"/"candidatas pra próxima
   rodada" já pronta (ex real: `docs/entity-page-candidates.md`).
4. **`grep -il {palavra-chave do título/tema} docs/*.md`** — buscar um doc
   relacionado ao ASSUNTO da issue, mesmo sem link em nenhum comentário
   (ex.: `docs/seo-notes.md`, `docs/audience-source-notes.md`). Achou um doc relacionado → ler **por inteiro** antes de
   aceitar a classificação de bloqueio — ele pode conter a decisão que
   torna a issue não-bloqueada.

**Quando pular a checagem 4.** É barata o bastante pra rodar em toda
classificação de bloqueio (um `grep`, não um fleet de agentes) — o skip por
label é estreito, não vale a issue inteira: só pula quando o
`npx tsx scripts/lib/issue-decisions.ts --issue N` (parágrafo acima) confirma
que a decisão/bloqueio JÁ REGISTRADO cobre exatamente o motivo de bloqueio
sendo avaliado agora, não qualquer outro item/sub-pergunta da mesma issue.
Item isolado sem marker correspondente → roda a checagem 4 mesmo com a
issue tendo `decisao-registrada`/`bloqueio-execucao` de outro item.

Só se as 4 checagens não acharem nada (nenhum PR, nenhum comentário de
progresso, nenhum doc de acompanhamento, nenhum doc relacionado por assunto)
é legítimo classificar a issue como não-despachada por qualquer motivo (A-E,
tipicamente C decisão-produto; `local`; ou um rótulo ad-hoc de espera/gating
— inclusive quando o motivo for escopo grande demais pra esta rodada; postar
a leitura como comentário durável na issue). Um rótulo que não é nenhuma das
5 letras nem `local` **nunca é, por si, evidência de que as 4 checagens
rodaram** — se rodou, ele resolve numa categoria A-E de verdade (#5708);
se não resolve em nenhuma, é sinal de que a issue devia ter virado elegível.
Caso contrário, o próximo passo
já está documentado — dispatchar essa fatia pequena nesta mesma onda (issue
vira elegível), ou, no mínimo, reportar o próximo passo concreto na tabela
do `plan.json` em vez de aceitar a leitura de bloqueio.

**Herdar classificação de rodada anterior do MESMO DIA não dispensa esta
verificação (#5586) — vale tanto pra classificação herdada do overnight
(Fase 0 passo 2 abaixo, "Herdar a triagem do overnight") quanto pra uma
classificação herdada de uma rodada `/diaria-develop` anterior do mesmo dia.** Antes de
aceitar qualquer classificação de bloqueio herdada (categoria A-E ou `local`),
rodar uma checagem ainda mais barata que as 4 acima (não é a 5ª delas, é um
pré-filtro específico pra herança): `gh issue view N --json labels` e
conferir se a **label** citada como motivo da classificação herdada **ainda
existe** na issue (comparação de 1 campo, não uma investigação completa —
cobre o caso de motivo por label; motivo registrado só em marcador de
comentário exige reler o comentário, checagem 1 acima). Motivo batendo →
aceitar a herança sem reabrir as 4 checagens. Motivo NÃO batendo (label
removida, nunca existiu de fato, ou o
corpo mudou desde a classificação original) → tratar a issue como se
estivesse sendo classificada agora pela primeira vez e rodar a verificação
completa das 4 checagens acima — nunca propagar a classificação stale pra
mais uma onda/rodada. (histórico: docs/rodadas-autonomas-historico.md#dev-5586)

**O mesmo princípio vale pra julgamento em PROSA herdado de um relatório de
sessão anterior, não só pra label mecânica (#5596).** Prosa herdada de um
`data/{overnight,develop}/{AAMMDD}/report.md` do MESMO DIA (ou de um resumo
de turno anterior desta conversa) citando issues por número ("pausei o
cluster X até Y") nunca vale como "ainda é verdade agora": reabrir cada issue
(`gh issue view N --json comments`) e conferir se existe comentário **mais
recente que a referência usada** — uma por uma, mesmo agrupadas na mesma
frase do relatório antigo. (histórico: docs/rodadas-autonomas-historico.md#dev-5596)

**Bloqueio descoberto MID-EXECUÇÃO (não na varredura da Fase 0): estrutural vs
ação-física-rápida-do-editor (#5440, 16/08/2026).** As categorias A-E acima
cobrem o bloqueio identificado na classificação inicial. Um segundo tipo
aparece só depois, no meio da tentativa de execução em si (ex: cat. B
"confirma que a conta existe" vira, na hora de mexer de fato na conta, um
2FA/CAPTCHA que a sessão não consegue passar sozinha) — e os dois exigem
tratamento diferente:

1. **Estrutural** (comportamento atual, mantido sem mudança) — o novo
   impedimento precisa de algo que a sessão genuinamente não tem e o editor
   presente também não resolve na hora: aguardar terceiro, feature gated por
   plano, acesso/conta que não existe. Sinal: resolver exigiria dias, uma
   ação de outra pessoa, ou uma decisão que nem o editor tem pronta agora.
   → documentar via `route-issue.ts --track bloqueada --reason "..."` (embute
   o marcador `formatExecutionBlockMarker`/`bloqueio-execucao` sozinho desde
   #7270 — não construir o marcador à mão)
   e `pulada` motivo `nao-destravavel-na-sessao`, sem perguntar.
2. **Ação física de segundos que só o editor presente executa** (2FA,
   clique de confirmação numa tela que só ele vê, identificar qual das N
   contas/opções é a certa, resolver um CAPTCHA) — sinal: resolve em
   segundos com **1 ação física** do editor, sem precisar decidir nada nem
   esperar terceiro. **`AskUserQuestion` AO VIVO**, com a opção padrão
   "não consigo agora / documentar e pular" sempre disponível (mesmo padrão
   de toda opção de Gate 1) — só cai no caminho `pulada` acima se o editor
   escolher essa opção ou estiver ausente (Fallback de ausência).

Contraste: cat. B esperando o editor **criar** uma conta nova em outro
serviço é tipo 1. (histórico: docs/rodadas-autonomas-historico.md#dev-5440)

**Surfacear NA HORA, não só no fim da rodada — vale para qualquer esforço,
não só o tipo 2 de segundos acima (#5727).** Bloqueio que exige do editor
mais que segundos (preencher um formulário de cadastro, rodar 2 edições da
diária, enviar um documento, logar numa conta) descoberto mid-sessão:
**surfacear imediatamente para o editor** — nunca esperar o fim da
onda/rodada, e nunca só o comentário na issue + linha no HANDOFF.

Isto **não** é um novo `AskUserQuestion` (não há opções a escolher) nem
contradiz #5321/#5721: é um BLOQUEIO que só o editor destrava, relatado numa
frase informativa no meio do fluxo normal de texto — a sessão não trava
esperando resposta, só relata o que precisa e segue.

**Forma do pedido (não da pergunta), nunca "tem uma pendência sua" genérico:**
(a) **o que precisa** — a ação concreta, não o sintoma;
(b) **o caminho exato** — onde clicar/entrar, não "resolva isso lá";
(c) **estimativa de esforço** — segundos, minutos, "precisa logar antes";
(d) **o que a sessão faz sozinha depois** — o que já foi feito enquanto
    espera, e o que retoma assim que o editor confirmar.
(exemplo: "preciso de você, ~30s, Business Suite → Contas do Instagram →
Entrar"; histórico: docs/rodadas-autonomas-historico.md#dev-5727)

**Agrupar bloqueios da mesma onda num pedido só** — se mais de um bloqueio
deste tipo aparece na mesma onda/wave de dispatch paralelo, esperar a onda
terminar de identificar todos e emitir **1** mensagem com a lista, em vez de
interromper o fluxo a cada achado individual.

**A sessão continua trabalhando enquanto espera** — surfacear não é parar:
seguir para a próxima issue do plano e retomar a bloqueada quando o editor
responder, sem re-perguntar o que já foi surfaceado.

**Guard mecânico de fim de rodada — IMPLEMENTADO (#5919, fecha o follow-up
do #5727 item 5).** Toda entrada de `issues[]` com bloqueio tipo-editor
(`what_unblocks` preenchido) registra explicitamente o campo
`surfaced_live: boolean` (+ `surfaced_live_at` ISO quando `true`):
`true` = surfaceado ao vivo pro editor (mensagem de 4 partes ou
`AskUserQuestion`); `false` = NÃO surfaceado — registro honesto que vira
item obrigatório da Seção de HANDOFF. O gate roda na Fase 2, entre os
demais gates e a composição do relatório:
`npx tsx scripts/check-surfaced-live.ts --plan data/develop/{AAMMDD}/plan.json`
(`--edition AAMMDD` também resolve o caminho; sem argumento pega o run mais
recente; `--strict` promove `false` explícito pra falha). `exit 1`
(campo ausente ou com tipo errado) → surfacear ao vivo AGORA o que ainda dá
e preencher o campo em cada entrada listada antes de escrever o relatório.
Lógica pura em `scripts/lib/surfaced-live-gate.ts`, testes em
`test/surfaced-live-gate.test.ts`. Diferença deliberada pros gates irmãos:
este não depende de rede/`gh`, então plan.json ilegível é erro duro (`exit
2`), não fail-soft. (histórico: docs/rodadas-autonomas-historico.md#dev-5919)

## Goal de esgotamento (#4297, expandido em #4319)

Por padrão, **a sessão só encerra quando nenhuma issue do conjunto-alvo está sem status terminal.** Duas metades precisam de definição precisa, senão a propriedade vira livelock — e desde #4319 o alvo default é o backlog aberto **inteiro**, não só o bloqueado.

### `goal_policy`: três valores, `exhaust_all` é o default (#4319)

Coletado na Fase 0.5 junto de `wave_policy`/`catD_preauth`.

| Valor | Alvo | Nota |
|---|---|---|
| **`exhaust_all`** | Backlog aberto inteiro, nas 4 ondas abaixo | **default desde #4319** |
| `blocked_only` | Só o backlog bloqueado (cat. A–E) | comportamento original de #2636/#4297, era chamado `exhaust` |
| `table_only` | Fecha quando a tabela da Fase 0 acaba, sem re-varredura | inalterado desde #4297 — pra janela de tempo curta |

Nunca re-perguntado em resume. **Migração de `plan.json` legado:** plan.json anterior a #4319 tem `goal.policy: "exhaust"` — ler esse valor como **`blocked_only`**, nunca como `exhaust_all`. Uma sessão só ganha `exhaust_all` respondendo o briefing de novo (nova invocação) — nunca por herança de um `plan.json` antigo.

**Incompatibilidade estrutural com `--no-implement`:** nesse modo, TODA issue do escopo termina em `unblock_status: desbloqueada-validada` + `status: pendente` por desenho (implementação fica pro overnight seguinte) — nenhum terminal da subseção "'Nenhuma issue aberta' = estado terminal" é alcançável, porque implementar é justamente o passo que produz `mergeada`/`draft-ci-vermelho`. Por isso, **`--no-implement` força `goal_policy = table_only`** direto, sem perguntar — a Fase 2 reporta `Goal: não avaliado (--no-implement ativo)`, não "não atingido". A pergunta de `goal_policy` no briefing (item 7 da Fase 0.5, agora com 3 opções) é pulada quando `--no-implement` está ativo.

### Conjunto-alvo com `exhaust_all`: 4 ondas em ordem fixa

Ordem fixa — **um grupo só é montado depois que o anterior está esgotado**. Precedência: **`bug` ganha de tudo** (decisão do editor) — mantém cada issue numa onda só, nunca duas.

| Onda | Entra | Esgota antes de |
|---|---|---|
| **1a** | Toda issue com label `bug` — **bloqueada ou não, qualquer prioridade** | 1b ser montada |
| **1b** | Issues bloqueadas (cat. A–E, mesmo alvo de `blocked_only`) que **não** têm label `bug` | 2 ser montada |
| **2** | Elegíveis ao overnight (não-bloqueadas) com label `P0` ou `P1` | 3 ser montada |
| **3** | Demais issues abertas (P2, P3, sem label de prioridade) | — (grupo final, atrás do gate próprio) |

Um bug bloqueado vai pra **1a**, não pra 1b. Um bug P0 elegível vai pra **1a**, não pra 2. 1b fica só com bloqueado que não é bug.

**Com `goal_policy = blocked_only`:** só as ondas 1a (fatia bloqueada) e 1b existem — é literalmente o mesmo conjunto-alvo de #2636/#4297 (o complemento exato do overnight), montado como se fosse uma única onda sem a partição por tier. A tabela de origem do alvo bloqueado é a mesma de sempre:

| Entra no alvo bloqueado | Origem |
|---|---|
| `bloqueio-externo` (cat. A/B/E) | motivo do overnight + labels `external-blocker`/`kit-migration`/`beehiiv` |
| `ambigua` **quando trade-off-real** (cat. C) | **fora do alvo desde #7493**: a label `trade-off-real` classifica `overnight` e a pergunta é feita no briefing do próprio overnight. Só entra aqui se vier acompanhada de `windows`/`develop-track` (que vencem na precedência) ou se o editor a trouxer nesta sessão |
| `not-this-week` (cat. D) | label homônima |
| `requer-sessao-local` | motivo herdado do overnight no passo 2 da Fase 0 (junto dos demais, #4297); sem categoria A–E — develop roda local, então é elegível aqui |

**Não entra no alvo em NENHUMA política** — não são bloqueio nem trabalho pendente, são outra coisa, e incluí-las faria o Goal nunca fechar:

- `fora-do-escopo` — motivo herdado do overnight pra o que não é trabalho de pipeline;
- `on-hold` (#4498) — "Pausada indefinidamente pelo editor — fora dos briefings até reativar" (semântica do próprio label no GitHub). Excluída do `target_set`/`tiers` inteiramente, em qualquer política — nunca entra no briefing, nunca gera pergunta de Gate 1 cat. B. Reativação é o editor remover a label no GitHub (fora da sessão); a próxima varredura já a vê elegível de novo;
- `not-this-week` como issue-inteira-excluída (distinto da linha da tabela acima, que é sobre o MOTIVO de bloqueio cat. D) — o label existe justamente pra dizer "não agora";
- `elegivel_especial` (EPIC deliberadamente deferido, #3072) — por desenho só fecha quando a issue-filha mergeia; nunca é despachado.

`sem-resposta` deixou de ser um motivo do develop (era artefato do CAP de re-scan, eliminado — ver "Re-varredura sem cap" abaixo).

### "Nenhuma issue aberta" = estado terminal, não "mergeada"

Parte do backlog é **intrinsecamente irresolvível na sessão** (cat. B esperando terceiro criar conta, cat. A com token que o editor ainda vai gerar). Um Goal literal de "todas mergeadas" nunca fecharia. Terminal aceitável (todos já existem nesta skill):

- `mergeada`
- `draft-ci-vermelho`
- `pulada` motivo `nao-destravavel-na-sessao` (Fase 1 passo 5 — exige comentário durável explicando o que falta, com dedup; cobre tanto bloqueio cat. A/B/E não resolvido quanto **implementação de issue elegível que falha sem nunca abrir PR/chegar ao CI** — subagente trava, `npm ci`/worktree falha, exceção não tratada. Uma issue elegível pula Gate 1 direto pra composição da onda, então esse é o ÚNICO caminho terminal disponível pra ela quando a implementação não converge; sem esse caminho o tier correspondente nunca esgotaria)
- `pulada` motivo `decisao-adiada` (editor saiu no meio)
- `pulada` motivo `ja-resolvida-antes-da-sessao` (#5723 — issue verificada AO VIVO nesta sessão e o trabalho que ela pedia **já estava feito** antes da sessão começar; nada foi executado aqui. Diferente de `nao-destravavel-na-sessao` ("não deu pra resolver"). **Exige evidência, sempre**: a issue registra no `plan.json` um campo `ja_resolvida_evidencia` (string não-vazia, descrevendo COMO foi verificado — a fonte de verdade externa checada, nunca memória/cache) E um comentário durável equivalente na issue do GitHub, mesmo padrão de `unblock_evidence`/`fora_de_codigo_evidencia`. `scripts/validate-develop-plan-motivo.ts` recusa (`exit 1`) qualquer `pulada` com este motivo sem `ja_resolvida_evidencia` preenchida. Histórico: docs/rodadas-autonomas-historico.md#dev-5723)
- `pulada` motivo `fechada-durante-a-sessao` (#12105 — a issue estava aberta quando a sessão começou e foi fechada por OUTRA sessão, tipicamente a rodada do `300`, enquanto esta rodava. Não usar `ja-resolvida-antes-da-sessao`, que afirma o contrário. **Exige evidência**: campo `fechada_evidencia` no `plan.json` com o rastro de `gh issue view N --json state,closedAt,closedBy` (CLOSED, quando, quem/qual PR). `validate-develop-plan-motivo.ts` recusa sem ele. Sem comentário na issue: quem fechou já deixou o rastro. No relatório da Fase 2, sai numa linha própria do bucket (c), "fechadas por outra sessão durante a rodada", nunca misturada às não-destraváveis.)
- `entregue-fora-de-codigo` (#5441, 16/08/2026 — ver subseção própria abaixo)
- `deixado-para-o-300` (#5751, 20/08/2026 — issue elegível que não bateu nenhum dos 4 critérios da regra "sessão interativa não faz o que o 300 faria sozinho", filtrada ANTES de chegar em Gate 1/implementação; ver seção própria no topo deste arquivo)

O Goal força **encarar cada issue do alvo e classificá-la** — o que ele elimina é "a issue nem foi olhada porque não estava na tabela da Fase 0", não a exigência de resolver o irresolvível.

**`nao-tentada` (#5718) — não é um 7º status terminal.** Issue de `goal.target_set` que termina a sessão **sem nenhuma tentativa de dispatch** (nunca ganhou entrada em `issues[]`) — nunca reportar junto das `pulada` (tentadas, bloqueadas). `nao-tentada` continua contando pra `goal.remaining`/`goal.reached: false` — não resolve nada, só registra honestamente que nada foi tentado. Escrito só na Fase 2 (backfill mecânico, sem julgamento — ver gate abaixo), nunca uma escolha ativa da Fase 1. `scripts/lib/develop-target-set-coverage.ts` (`DEVELOP_NAO_TENTADA_STATUS`).

### Unidade concluída sem gerar PR (#5441, 16/08/2026)

Terceiro caminho além de código e bloqueio: a unidade conclui integralmente
por uma ação puramente OPERACIONAL, fora do repositório (deploy manual de um
Worker já defasado, export de dado de um painel de terceiro, ajuste direto
numa configuração externa) e não gera diff nenhum pra revisar/mergear.
(histórico: docs/rodadas-autonomas-historico.md#dev-5441)

**Quando se aplica:** a unidade terminou (o efeito pretendido pela issue já
existe no mundo — Worker redeployado, CSV exportado, campo atualizado no
painel) e não existe/não faz sentido existir um PR pra fechar (não houve
mudança de código versionada neste repo, ou a mudança de código que houve já
foi mergeada antes e o que faltava era só a ação operacional em si).
**Não** se aplica quando ainda falta implementar algo codável — nesse caso a
issue continua em `pendente`/segue pro Gate 1 normalmente.

**Protocolo (#5695 — default fecha, sem perguntar; fechar é reversível).** Ao concluir uma
unidade assim, o coordenador **fecha por default**: `gh issue close` +
comentário durável com a evidência da entrega (link do deploy, nome do
arquivo exportado, timestamp) — `fora_de_codigo_fechamento: "fechada"`.
Banner batchado com as demais unidades `entregue-fora-de-codigo` da mesma
onda: `{N} unidade(s) entregue(s) fora de código, fechadas por default:
{lista com evidência resumida}. Pra manter alguma aberta (ex: aguardando
validação de resultado), reabra e comente antes da próxima varredura.` O
editor que quiser manter uma aberta reabre pelo GitHub a qualquer momento —
isso não trava a sessão nem exige resposta antes de prosseguir; se a
reabertura acontecer ainda durante a sessão, a próxima re-checagem já vê a
issue aberta de novo e a reclassifica normalmente. Registrar no
`plan.json` por issue: `status: "entregue-fora-de-codigo"`,
`fora_de_codigo_evidencia` (o que foi feito, nunca um secret),
`fora_de_codigo_fechamento` (`"fechada"` — default desde #5695; `"mantida-aberta: {motivo}"` só quando o editor intervém por iniciativa própria ANTES do coordenador fechar, pedindo pra manter aberta).

### O Goal é relativo ao escopo da sessão

`--issues`, `--only`, `--bugs` (#3375) e `--priority` (#3499) restringem o conjunto-alvo — **as ondas são montadas depois desse filtro, não antes**. Uma sessão `--bugs` tem 1a populada e 1b/2/3 nascem vazias, e o Goal é atingido quando 1a esgota; uma sessão `--priority P2,P3` tem 1a/1b/2 vazias e o grupo 3 é a sessão inteira (ver o caso redundante do gate do grupo 3, abaixo). O Goal é avaliado **contra o alvo já filtrado**, nunca contra o backlog total do repositório — senão qualquer sessão `--bugs` ou `--priority P0` ficaria com Goal permanentemente inatingível. O relatório da Fase 2 sempre diz qual escopo está sendo avaliado: `Goal (escopo: --bugs --priority P0,P1): atingido`.

### Re-varredura sem cap (decisão do editor, #4319)

**O cap de 2 re-scans, que existia em #4297, foi eliminado no develop.** O status `pulada` motivo `rescan-limit` **deixou de existir no develop**. (histórico: docs/rodadas-autonomas-historico.md#dev-4319-b)

Três momentos de re-varredura, todos **sem cap** (#5907 item d acrescentou o segundo):

- **Re-checagem entre ondas** — roda **antes de montar cada onda**, sempre. Barata (`gh issue list`, sem `body`), reclassifica a fila: uma issue `bug` nova criada durante a sessão entra em 1a mesmo que a sessão já esteja na onda 3 — `current_tier` **volta** pra 1a nesse caso (não gera livelock porque status terminal nunca é re-escolhido).
- **Re-checagem ao fim de CADA unidade (#5907 item d)** — além dos dois momentos abaixo, o `gh issue list` barato roda ao fechar cada unidade (merge ou status terminal), não só quando a onda/tier esgota — label/classificação muda mid-sessão por ação de OUTRA sessão (continuo, overnight paralelo, editor no Studio). O resultado alimenta a mesma reclassificação da re-checagem entre ondas (issue que virou develop/bloqueada/agendada sai da fila corrente; novata entra pela onda certa).
- **Re-varredura de convergência** — roda quando **as 4 ondas** estão esgotadas, procurando novatas antes de declarar `reached`. Repete enquanto encontrar issue nova sem status terminal; para sozinha na primeira iteração sem novidade (caso comum). **Forcing function (#5706):** coberta pelo mesmo comando da Fase 2 (`check-state-changed-pending.ts`, ver "Gate de re-triagem pendente" abaixo) — ele faz o `gh issue list` completo e falha (`exit 1`) se achar issue aberta fora de `target_set`/`tiers`/`issues[]` e não-triangulada por `classifyExecTrack`; nunca declarar `goal.reached: true` sem essa checagem passar.

`rescans_done` vira **contador puro de observabilidade** (quantas re-varreduras a sessão fez, reportado na Fase 2) — nenhuma lógica ramifica nele. O `/diaria-overnight` seguiu o mesmo caminho em #5272 (cap K=2 removido lá também). A divergência que resta entre as duas skills é só a de `findings_depth` — ver o parágrafo seguinte. (histórico: docs/rodadas-autonomas-historico.md#dev-5272)

### Findings deixam de ser uma classe especial (decisão do editor, #4319)

`findings_depth`, a cadeia de mini-rodadas numeradas e o tratamento diferenciado de issues `session-finding` **saem do develop** (ver Fase 1.5). Um finding gerado pela própria sessão vira issue como qualquer outra, classificado no tier dele pelas mesmas regras (label `bug` → 1a; `enhancement` P2/P3 → 3) — disputa a fila com o resto, sem porta de reentrada própria. `findings_depth` **permanece no `plan.json` como contador puro** (mesmo destino de `rescans_done`), sem ramificar lógica; a Fase 2 reporta a cadeia (gerados / consumidos pela própria sessão / profundidade alcançada) como substituto do cap.

**Consequência aceita:** uma sessão pode ciclar em 1a (trabalha bug → Fase 1.5 revisa → gera bug-finding → volta pra 1a) sem passar por nenhum gate automático — **é o comportamento pedido**; quem segura é o editor. `/diaria-overnight` mantém `findings_depth` (cap 2) e o tratamento especial de `session-finding` inalterados (lá não tem editor). **Este é o único cap que ainda diverge**. (histórico: docs/rodadas-autonomas-historico.md#dev-4319-c)

### Reentrada na onda após incidente — NÃO implementado, follow-up (#5718 item 4)

A skill não modela reentrar numa onda já em andamento quando uma unidade
fica presa num ciclo de review/fix/incidente de merge; os gates de cobertura
(`nao-tentada`) só tornam o sintoma **visível e reportável**. Sem
comportamento operacional aqui. (histórico:
docs/rodadas-autonomas-historico.md#dev-5718)

### O que garante terminação sem os dois caps

1. **Anti-livelock, intacto**: issue com status terminal **nunca** é re-escolhida na mesma sessão — uma re-varredura só devolve trabalho se houver issue genuinamente nova.
2. **Gate 1 (residual cat. C/E-com-custo) e Gate B** — gates humanos bloqueantes intactos, Fallback de ausência intacto. **Gate do grupo 3 e Gate de Onda** (ver seções próprias) não entram nesta lista de bloqueio garantido — desde #5321 (grupo 3) e #5695 (onda) ambos auto-entram por default; seguram a sessão só se o editor intervier por iniciativa própria. Gate 1 residual, por sua vez, também estreitou no #5695 — cat. A/B não geram mais pergunta ali (resolvem por default determinístico), então o que sobra bloqueando de fato é só cat. C (sempre) e cat. E-com-custo; uma sessão sem nenhuma issue nessas duas categorias pode não ter NENHUM Gate 1 bloqueante disparando.
3. **O editor** — sessão supervisionada; pode encerrar a qualquer momento, com ou sem um gate no caminho.

Nenhum dos três é um contador — foi a escolha do editor.

### O limite que NÃO pode ser cruzado

**Não existe nenhum contador que encerra a sessão sozinho.** Quem encerra é o editor, pelos gates que seguem bloqueantes quando disparam (Gate 1 residual cat. C/E-com-custo, Gate B) ou simplesmente saindo, e nos dois casos a sessão para limpa com o resíduo registrado. **O gate do grupo 3 (#5321) e o Gate de Onda (#5695) não são pontos de parada garantidos** — ambos auto-entram por default (o editor PODE interromper em qualquer um). Sessão sem Gate 1/B bloqueante na fila para só pelo editor saindo ou pelo Goal esgotando — propriedade explícita do desenho pós-#5695; por isso Gate 1 (cat. C/E-com-custo)/Gate B não podem ser afrouxados MAIS ALÉM sem revisitar esta decisão.

- O **Fallback de ausência** segue intacto: `AskUserQuestion` é bloqueante quando dispara (cat. C/E-com-custo no Gate 1, Gate B, ou intervenção do editor no Gate de Onda/grupo 3); se o editor sai no meio de uma pergunta em curso, a issue corrente vira `pulada` motivo `decisao-adiada`, e **antes** de gravar `resume_state` e parar, recalcular `goal.remaining`/`goal.reached` com esse status já aplicado (mesmo recompute do passo 5 da Fase 1) — **a sessão para limpa — nunca continua autônoma**. Essa atualização acontece independente de a Fase 2 rodar ou não nesta invocação (o `plan.json` gravado é que precisa estar correto pro resume, não uma promessa de que o relatório sai agora).
- Gate 1 (cat. C/E-com-custo) e Gate B **não** viram automáticos. **O gate do grupo 3 (#5321) e o Gate de Onda (#5695) já são automáticos por padrão**; cat. A/B do Gate 1, sem pergunta desde #5695, não ganham NENHUM comportamento novo além do documentado (default determinístico, nunca "aplicar mesmo sem checar o insumo"; a única exceção documentada é a de #7946 — issue cat. A/B pedida nominalmente via `--issues` ganha `AskUserQuestion` pontual, não um afrouxamento silencioso).
- Goal não atingido é registrado com o resíduo por tier no handoff da Fase 2, pra a próxima sessão retomar. Nunca é motivo pra insistir.

## Gate do grupo 3 (revisado #5321, "Perguntar é exceção" — era `AskUserQuestion` obrigatório, #4319)

**Default: entrar no grupo 3 automaticamente**, com banner (não `AskUserQuestion`) — o critério de parada que já existe (goal de esgotamento, re-scans, guard de colisão editorial) segue valendo como sempre; o editor interrompe a sessão a qualquer momento se quiser redirecionar. (histórico: docs/rodadas-autonomas-historico.md#dev-5321)

Ao entrar, imprimir banner:
```
Entrando no grupo 3 (cauda longa: P2, P3, sem prioridade) — {N} issues: {lista}.
Custo por issue tende a ser mais alto aqui. Pra pular ou escolher um
subconjunto, interrompa a sessão agora — ela segue direto se não houver
resposta.
```

Detalhes que decidem se isto funciona:

- **Registro por disparo, não só o primeiro**: se uma re-checagem entre ondas trouxer um bug novo e a sessão voltar pro grupo 1a, ao retornar ao grupo 3 o banner é impresso **de novo** — o backlog é outro. Cada disparo é um registro **novo** em `goal.tier3_gate` (array de disparos — `decision: "auto_entered"` por padrão, `"editor_interrupted"` se o editor intervier antes do próximo tier abrir).
- **Intervenção do editor não é "fazer pergunta"** (mesma exceção do overnight/Regra 1): se o editor disser "pula o grupo 3" ou "só entra nas P2" a qualquer momento antes/durante, a sessão respeita — vira `decision: "editor_interrupted"` no registro, com o pedido como `note`, `goal.reached: false`, e as issues não-entradas vão pro resíduo do handoff **sem** marcar as issues como `pulada` (elas não foram recusadas, só não entraram nesta sessão).
- **`editor_interrupted` exige ação real do editor — nunca é o rótulo pra uma decisão do coordenador (#5439).** `decision: "editor_interrupted"` só é correto quando o editor, por iniciativa própria, pediu explicitamente pra pular/pausar/redirecionar — o pedido literal vira `note`. **Em `goal_policy=exhaust_all`, "escopo já muito extenso" (contagem de PRs mergeadas, tempo decorrido, tamanho de refactor) NÃO é motivo válido de parada** — só 3 mecanismos podem encerrar a sessão antes do goal: o Fallback de ausência, este gate do grupo 3 com resposta real do editor, e o guard de colisão editorial. Se o coordenador se pegar querendo parar por "já fiz bastante", a ação correta é **continuar trabalhando**, não encerrar a sessão e rotular o próprio encerramento como se o editor tivesse pedido. Se o coordenador genuinamente precisa parar por um limite técnico real (token budget esgotado, tempo de execução do harness), esse é um evento distinto — registrar `decision: "coordinator_self_limited"` (ver enum completo no schema `tier3_gate` mais abaixo), nunca `editor_interrupted`. (histórico: docs/rodadas-autonomas-historico.md#dev-5439)
- **Este comportamento não é afetado por `wave_policy: auto`** — `wave_policy` decide se o editor aprova a *composição* de cada onda; isto aqui decidia se uma *classe inteira de trabalho* entra, e agora entra por padrão como qualquer outro tier.
- Numa sessão `--priority P2,P3`, os grupos 1a/1b/2 nascem vazios e o grupo 3 é a sessão inteira — segue direto.

## Fase 0 — Montar e triar a fila (#4319: bugs, bloqueadas, elegíveis P0/P1, resto)

0. **Resume?** Antes de assumir que é retomada, resolver o path pelo mesmo verbo do passo 9 (#6309 — a checagem de colisão precisa valer também nesta porta de entrada, não só na 1ª escrita): rodar `npx tsx scripts/resolve-develop-plan-path.ts --aammdd {AAMMDD}` (`--session-id` auto-injetado, standalone, nunca em `&&`/`;`/pipe/heredoc — item 18 de `context/overnight-dispatch-rules.md`). `mode: "resume"` → é de fato esta sessão continuando; ler o `plan.json` no `path` devolvido e retomar a partir dos status já gravados nele. `mode: "fresh"` ou `"derived-after-collision"` → **não é resume desta sessão**, mesmo que algum `plan.json` já exista pra `{AAMMDD}` (é de outra sessão, alheia ou colidida) — seguir para o passo 1 como sessão nova; o `path` (já com sufixo, se `derived-after-collision`) é o mesmo que o passo 9 vai confirmar de novo antes da 1ª escrita — chamada idempotente, sem side effect, não há custo em resolver duas vezes.
1. **Sync:** `git checkout master && git pull`; capturar `base_sha = git rev-parse HEAD`; **registrar esta sessão no registro compartilhado (#5156):** `npx tsx scripts/lib/session-registry.ts register --kind develop` (`--session-id` sempre auto-injetado por `.claude/hooks/inject-session-id.mjs` — nunca passado manualmente, a skill não sabe o próprio `session_id`) — é o que permite ao overnight checar claim de issue antes de dispatchar, ao merge lock serializar merges cross-sessão, e ao guard de cleanup de worktree detectar esta sessão como ativa. **`lastHeartbeat` fica fresco sozinho** (#6327, `.claude/hooks/session-beacon.mjs`, `PreToolUse`, no MESMO registro) — **mas esta skill CHAMA `heartbeat` explicitamente (#8495)** para publicar `active_worktrees` na abertura do fan-out de cada onda e no fechamento pós-cleanup (ver Fase 1 e Fase 2 abaixo, e item 6 na seção "Paralelismo entre sessões"); as duas chamadas não se substituem. Não reduzir/desligar esse hook sem primeiro ler a docstring de `heartbeat` em `scripts/lib/session-registry.ts`. **capturar `started_at` = timestamp ISO 8601 REAL desta sessão AGORA** (`date -u +%Y-%m-%dT%H:%M:%SZ`, ou equivalente) — gravado em `started_at` no `plan.json` do passo 9 abaixo. **Nunca gravar a string `{AAMMDD}` nesse campo** (#3841 — `started_at` precisa ser um ISO real pro painel `/rodada` do Studio ordenar as rodadas). `gh auth status`. **Log de startup do modelo/effort do coordenador (#3454, espelha #2993 do overnight):** logar no run-log o modelo/effort **CONFIGURADO** pelo frontmatter desta skill (`claude-opus-5-5` / `medium`) — não o auto-relatado —, pra tornar o pin verificável via `/diaria-log {AAMMDD}`:
   ```bash
   npx tsx scripts/log-event.ts --edition {AAMMDD} --agent develop --level info \
     --message "coordinator_model" \
     --details '{"model": "claude-opus-5-5", "effort": "medium", "source": "skill_frontmatter"}'
   ```
2. **Herdar a triagem do overnight:** ler `data/overnight/{AAMMDD-recente}/plan.json` e extrair os `status: pulada` com motivo ∈ `{bloqueio-externo, not-this-week, ambigua, requer-sessao-local}` (#4297 — a última só aparece se aquela rodada do overnight rodou em cloud; herdar mesmo assim, porque develop roda local por natureza e a torna elegível, ver seção "Label `local`") — a triagem cara já foi feita (`source: inherited-overnight`). **Herdar não é aceitar cegamente (#5586):** antes de tratar cada motivo herdado como fato assentado, rodar a checagem barata de "Herdar classificação de rodada anterior do MESMO DIA não dispensa esta verificação" (seção "Categorias de bloqueio + protocolo de desbloqueio" acima) — `gh issue view N --json labels` pra confirmar que a label citada como motivo ainda existe. **Checar se aquela rodada ainda está EM VOO antes de herdar (#5156 item 7):** `npx tsx scripts/lib/session-registry.ts list-active` — se houver uma entrada `kind: "overnight"` ainda ativa (não stale), o `plan.json` que acabou de ser lido é um documento de PROGRESSO, não o resultado final da rodada — os `status: pulada` de agora podem virar `elegivel`/`mergeada` minutos depois, ou novas issues `pulada` podem ainda ser adicionadas. Herdar mesmo assim (não vale a pena esperar), mas gravar `source: "inherited-overnight-in-flight"` em vez de `source: "inherited-overnight"` nessas issues — sinal explícito pro editor/relatório de que a herança é parcial/não-determinística, não uma leitura de rodada já encerrada. Registro vazio ou entrada `overnight` stale → herança normal, `source: "inherited-overnight"` como sempre. **Com `--bugs` (#3375)**: descartar aqui as issues herdadas sem label `bug` — não entram na tabela nem na classificação seguinte. **Com `--priority` (#3499)**: descartar também as issues herdadas cuja prioridade ∉ conjunto passado.
3. **Varredura completa dos issues abertos** (#4319 — backlog inteiro, pra montar as 4 ondas): `npx tsx scripts/fetch-open-issues-for-triage.ts` (#7018 — mesmo CLI do overnight, sobre `scripts/lib/issue-triage-fetch.ts`; nunca `gh issue list --json ...` escrito à mão — o campo `body` vem garantido ou o comando falha alto; a resposta já traz `execTrack` via `classifyExecTrackFromListItem`, reusável no passo 6a abaixo em vez de recalcular); `updatedAt` continua no retorno por outros consumidores do JSON — a comparação de decisão do passo 4 NÃO usa esse campo, compara `decided_at`/`recorded_at` entre si — #6961; reconciliar contra o herdado do passo 2 — **fresh-scan vence o plan.json herdado em divergência**. Mesmo filtro `--bugs` se aplica ao resultado fresco (flag nativa do script). Mesmo filtro `--priority` se aplica ao resultado fresco (flag nativa do script). **Multi-repo (#10618) ligado por padrão desde a fatia 4 (decisão do editor 22/10/2026), aqui, no overnight e no contínuo:** rodar a varredura com `--repos all` (`npx tsx scripts/fetch-open-issues-for-triage.ts --repos all`), que inclui todos os repos de `platform.config.json → issue_repos` (hoje também `vjpixel/diaria-design`); `--repos a,b` restringe a uma lista validada contra essa allowlist, e sem flag o CLI varre só o `vjpixel/diaria-studio` (o que o zerar-fila usa). Com a flag, cada item traz `repo` e `ref` (`owner/repo#N`), e issue de outro repo se identifica SEMPRE pelo `ref`, nunca pelo `number` sozinho (o #21 existe nos dois repos): `plan.json` `{ ref, ... }`, `claim-issue --issue {ref}`, `route-issue.ts --triaged-at "{triaged_at}" --issue {ref}`, `check-state-changed-pending.ts --add-pending {ref}`. **Pré-requisito no início da sessão:** `npx tsx scripts/sync-issue-labels.ts --repo vjpixel/diaria-design --apply` (idempotente). **Implementar issue do design = item 32 de `context/overnight-dispatch-rules.md`**: checkout `../diaria-design` (clonar se faltar), worktree a partir de `origin/main` (branch base `main`), dispatch sem `isolation: worktree` com cwd no worktree do design, PR aberta NO design (`gh pr create -R vjpixel/diaria-design --base main`) com `Closes #N` LOCAL — nunca PR no studio fechando a studio#N; checkout indisponível → `pulada` `bloqueio-execucao` com o erro, nunca um worktree do studio. Merge fora do trem (`run-merge-train.ts` é só-studio): gates de PR com `--issue {ref}` (ou `--repo {repo}`) — `check-pr-checks-gate.ts`, `check-pr-retido-gate.ts`, `check-pr-review-authenticity.ts` —, threads resolvidas com `owner`/`name` do repo do PR (variáveis do GraphQL, bloco do Gate 2 do overnight), `gh-pr-safe-edit.ts --repo {repo}`, `merge-lock-acquire --pr N --repo {repo}` + `gh pr merge N -R {repo}`. Exit 3 = resultado parcial (um repo extra falhou; a lista do studio veio completa e o stderr nomeia o repo). `check-block-staleness.ts` (inclusive `pr-em-voo` com PR citado em outro repo: `pr: "owner/repo#N"` ou `owner/repo PR #N` na `nota`, fatia 4), `check-pr-terminal-state.ts`, `check-skipped-develop-track.ts`, `check-develop-label-cleared.ts`, `check-overnight-comment-coverage.ts`, `check-decision-label-drift-gate.ts` (os três últimos desde a fatia 4, avaliando cada repo sozinho) e a convergência + re-roteamento (#10407) de `check-state-changed-pending.ts`/`check-overnight-fila-convergence-gate.ts` (que desde a fatia 4 varrem todos os repos de `issue_repos`, mesmo sem entrada deles no plano) consultam a entrada de outro repo NO REPO DELA (`gh … -R owner/repo` ou `gh api repos/owner/repo/…`, só repos da allowlist) e a reportam como `owner/repo#N`; repo não consultado (fora da allowlist, `gh` falhou) ou entrada de identidade desconhecida vira ressalva DENTRO da linha de veredito (`ok PARCIAL — NÃO avaliados: …`/`exceto …`), nunca um "ok" limpo. `check-exec-track-coverage.ts` e `check-overnight-plan-motivo.ts` não consultam o GitHub e rotulam a entrada de outro repo como `owner/repo#N` (`validate-develop-plan-motivo.ts` idem). As labels de track/prioridade do diaria-design saem de `npx tsx scripts/sync-issue-labels.ts --repo vjpixel/diaria-design --dry-run|--apply` (lista derivada do código, idempotente).
4. **Classificar cada bloqueio em A–E** (só pras issues com sinal de bloqueio real — herdadas do passo 2 ou labels `external-blocker`/`kit-migration`/`not-this-week`/`beehiiv` do passo 3, cruzado com o corpo; `on-hold` NÃO entra aqui, #4498 — ver passo 5). Issue herdada só por `requer-sessao-local` (sem nenhuma label de categoria A–E aplicável) não força uma categoria — categoria `local` em vez de A-E (mesmo tratamento informacional da seção "Label `local`").
5. **Excluir do alvo, em qualquer política**: `fora-do-escopo`, `not-this-week` (issue inteira excluída da rodada — distinto do motivo cat. D da tabela de bloqueio), `elegivel_especial` (#3072), `on-hold` (#4498 — "Pausada indefinidamente pelo editor — fora dos briefings até reativar", semântica do próprio label; nunca entra no briefing/Gate 1, mesmo que carregue também `external-blocker`/`kit-migration`; reativação é o editor remover a label no GitHub).
6. **Montar as 4 ondas** (tabela "Conjunto-alvo com `exhaust_all`" da seção Goal de esgotamento) sobre o que sobrou do passo 5 — **bug ganha de tudo**: label `bug` (bloqueada ou não, qualquer prioridade) → 1a; bloqueada sem `bug` → 1b; elegível com `P0`/`P1` → 2; resto → 3. Essa classificação é feita **sempre**, independente de qual `goal_policy` a Fase 0.5 vai escolher — é dado barato, a decisão de qual tier a sessão de fato ataca vem depois.
6a. **Antes de classificar, reconciliar dependências entre issues (#7137, item 24 de `context/overnight-dispatch-rules.md`):** `npx tsx scripts/reconcile-issue-dependencies.ts --apply --repos all` (#10901: também as issues do diaria-design, cada `depends-on: #N` resolvido no repo da issue) — sincroniza a label `dependencia-aberta` com o marcador `depends-on:` de cada issue, antes de qualquer classificação abaixo. **Classificar cada issue via `classifyExecTrack` e reportar divergência com o track de prosa (#5708; histórico: docs/rodadas-autonomas-historico.md#dev-5708).** Pra cada issue já classificada nos passos 4-6 (labels + corpo já em mãos, sem custo adicional de rede), rodar `classifyExecTrack({ labels, body })` de `scripts/lib/issue-exec-track.ts` (puro — import direto, sem CLI) e comparar contra a onda/categoria atribuída em prosa: `bloqueada` do módulo deveria corresponder a cat. A-E aqui; `develop` do módulo (labels `windows`/`trade-off-real`/`external-blocker`+`credencial-escopo`) deveria corresponder a uma issue que a sessão de fato considera elegível-com-editor-presente; `agendada` deveria corresponder a uma issue com marcador `aguardando-ate:` futuro (excluída do alvo, ver "Agendada" abaixo); `fora-de-rodada` deveria já ter sido excluída no passo 5; `overnight` é o default residual. **Divergência não é erro automático — precisa ficar VISÍVEL (#5708).** Gravar por issue no `plan.json` (`exec_track_painel`: o valor de `classifyExecTrack`; `exec_track_divergiu`: bool) e listar as divergências na tabela do passo 7 — issue cujo track do painel diz `develop`/`overnight` mas a sessão está prestes a marcá-la bloqueada/fora do alvo é candidata natural às 4 checagens do #5383/#5392 acima (não dispara sozinha; é o mesmo sinal que já levaria lá, só que agora comparável mecanicamente em vez de só na leitura em prosa).
6b. **`agendada`** (#5682, `classifyExecTrack`) — marcador `aguardando-ate:` com data futura. Mesmo tratamento de `on-hold` no passo 5: excluída do alvo desta rodada, sem consumir tier, sem Gate 1 — o marcador desarma sozinho na data, a próxima varredura já a vê elegível de novo (ou bloqueada, se algum bloqueio real coexistir — `classifyExecTrack` já resolve essa precedência).
7. **Imprimir a tabela**, agrupada por onda (1a/1b/2/3), ordenada P0>P1>P2>P3 dentro de cada uma: `#NNNN | P? | onda | cat A-E ou — | o-que-falta-destravar ou — | título | track painel | diverge?`. As duas últimas colunas vêm do passo 6a.
8. Aplicar `--issues`/`--only`/`--bugs`/`--priority`/`--track` (filtra ANTES da onda ser fixada em `plan.json` — Goal avaliado contra o que sobrar). `--track {overnight|develop|agendada|bloqueada|fora-de-rodada}` (#5708) restringe a sessão ao que `classifyExecTrack` (não a classificação em prosa desta skill) atribuiu a cada issue — é o jeito do editor pedir literalmente "faça o que o painel chama de Develop": `--track develop` ataca só as issues que o painel já rotula Develop, mesmo que a onda/categoria em prosa desta Fase 0 as tivesse posto em outro lugar. Compõe com `--issues`/`--only`/`--bugs`/`--priority` (interseção, não união). Sem a flag, comportamento atual sem mudança — o filtro por track de prosa (ondas 1a-3) continua sendo o padrão. **Gravar o escopo no `plan.json` no mesmo passo (#6635/#6636):** `--bugs` → `bugs_only: true`; `--priority` → `priority_filter: [...]`; `--issues` → `issues_filter: [...]` (top-level, números crus) — é o que `filterIssuesByRoundScope` (`scripts/lib/state-changed-tracker.ts`) lê pra excluir issue fora do escopo explícito do ruído "novo não-triangulado" no gate de convergência da Fase 2; sem gravar, uma sessão `--issues`/`--bugs`/`--priority` vê o resto do backlog aberto inteiro como "novo" nesse gate.
9. **Antes de escrever, resolver colisão de path (#6265)**: rodar `npx tsx scripts/resolve-develop-plan-path.ts --aammdd {AAMMDD}` (`--session-id` auto-injetado, mesma convenção do item 18 de `context/overnight-dispatch-rules.md` — nunca em comando encadeado) — devolve `{ path, suffix, mode, collisions? }`. `mode: "fresh"`/`"resume"` → usar `path` normalmente (é o slot esperado, `data/develop/{AAMMDD}/plan.json`). `mode: "derived-after-collision"` → **outra sessão develop já tem um plano em voo neste mesmo dia/máquina** (`plan.json` existente com `session_id` diferente do desta sessão, ou sem `session_id` — plano legado tratado com a mesma cautela); usar o `path` com sufixo devolvido (`data/develop/{AAMMDD}{suffix}/plan.json`, ex: `260826b`) em vez de sobrescrever o alheio, e mencionar a colisão no relatório final (Seção de HANDOFF). Gravar `session_id` (via `npx tsx scripts/lib/session-registry.ts` já registrado no passo 1 — o `session_id` desta sessão) no nível raiz de `plan.json` a partir deste primeiro write, junto de `machine_id` (discriminador primário de `isForeignDevelopPlan`, `scripts/overnight-statusline.ts`, #5156 item 11). **Todo re-write subsequente do `plan.json` desta sessão usa o MESMO `path` resolvido aqui** — não re-resolver a cada write. **A checagem de colisão roda tanto aqui quanto no passo 0 (#6309)** — esta é a confirmação final antes do write (idempotente). Gravar `plan.json` no `path` resolvido, incluindo o campo `goal` inicial — `tiers` = `{ "1a": [...], "1b": [...], "2": [...], "3": [...] }` (números das issues em cada onda, já filtrados por `--issues`/`--only`/`--bugs`/`--priority` — calculado sempre, é dado barato, mesmo que a política acabe sendo `table_only` e `tiers` fique sem uso nesse caso), `current_tier` ainda **ausente** (só é gravado como `"1a"` na Fase 0.5, junto de `policy`, e só se a política escolhida for `exhaust_all`/`blocked_only` — `table_only` nunca grava esse campo), `policy` ainda `null` (coletada na Fase 0.5 — exceto com `--no-implement`, que grava `table_only` direto), `target_set`/`remaining` **ainda vazios** (só populados quando a Fase 0.5 souber a política — `blocked_only` usa só 1a-bloqueada+1b, `exhaust_all` usa as 4 ondas inteiras, `table_only` fica vazio pra sempre), `reached: false`, `rescans_done: 0`, `tier3_gate: []` (array de disparos do gate, vazio até o primeiro — ver schema). Com `--dry-run`, **parar aqui**.

## Fase 0.5 — Briefing FRONT-LOADED (colher o máximo de decisões no início, #2966)

O objetivo é **minimizar interrupções durante a sessão**: coletar na abertura TUDO que não depende de runtime, deixando só o genuinamente-adiável pra mid-sessão. Aproxima o "tudo no início" do overnight, mas SEM a Regra 1 — o develop ainda PODE perguntar depois, só que raramente PRECISA.

Montar o briefing em **múltiplas chamadas `AskUserQuestion` sequenciais** (o cap é 4 perguntas × 4 opções por chamada — front-loadar N decisões exige várias chamadas, agrupadas por categoria). Coletar, nesta ordem:

1. **Ordem de ataque** (`attack_order`) — **não é mais perguntada por padrão (#4498; histórico: docs/rodadas-autonomas-historico.md#dev-4498)**. A skill aplica `so_destravaveis_agora` (opção c) automaticamente, sem `AskUserQuestion`, e grava no `plan.json` na Fase 0.5 como se tivesse sido respondida. Editor muda via `--attack-order {a|b|c}` na invocação (a = por prioridade; b = por categoria; c = só as destraváveis agora, o default) ou pedindo explicitamente mid-sessão ("muda a ordem de ataque pra X") — só nesses 2 casos a ordem é resolvida por decisão explícita em vez do default automático. **Escopo (#4319):** a ordem ENTRE tiers é sempre fixa (1a → 1b → 2 → 3, ver "Goal de esgotamento") — `attack_order` não afeta isso. O que `attack_order` decide é a ordem de resolução do Gate 1 (desbloqueio) **dentro** do tier corrente, quando há mais de uma categoria de bloqueio pra destravar ao mesmo tempo (relevante sobretudo em 1b, onde só issues bloqueadas entram).
2. **Todas as decisões cat. C** (produto/editorial) — são decisões PURAS (não dependem de ver o código), então batchar TODAS agora, não uma a uma na Fase 1. Cada resposta → comentário durável na issue (a decisão postada É a evidência, #573) + `unblock_status: desbloqueada-validada` no `plan.json`. **Registro machine-readable (#5373):** o comentário começa com o marcador de `formatDecisionMarker` (`scripts/lib/issue-decisions.ts`, `{decided_at, pergunta, resposta, sessao: "develop"}`) antes da prosa de sempre; junto, **usar `route-issue`** (`npx tsx scripts/route-issue.ts --triaged-at "{triaged_at}" --issue N --track {track}` com `--reason` incluindo a resposta resumida, #6196 — roteia o veredito, **não substitui** `gh issue edit N --add-label decisao-registrada`, que é passo **separado**; se a decisão destrava código e a issue fica pro overnight, o track é `--track overnight --motivo triada` — `decisao-registrada` sozinha classifica `fora-de-rodada`, #9229) e apender no CORPO da issue `> Decidido em {data}: {resposta breve}` logo após o trecho da pergunta (ou no fim, se não localizável) — fecha o loop no que a próxima varredura lê primeiro.
3. **Todas as credenciais cat. A** — pedir o editor colar TODOS os tokens de uma vez (pro `.env`), validar cada um deterministicamente (#573: `publish-*.ts --dry-run`) ali mesmo. Token que o editor não tem pronto ("preciso gerar") → SÓ essa issue defere pro mid-sessão; as demais seguem validadas.
4. **Todas as confirmações cat. B** — estado das contas de terceiro de uma vez; probe real por conta confirmada.
5. **Política de onda** (`wave_policy`) — **não é mais perguntada por padrão (#5695)** (a onda é livre-de-colisão por construção e o Gate 2 é determinístico; histórico: docs/rodadas-autonomas-historico.md#dev-5695). A skill aplica `auto` automaticamente, sem `AskUserQuestion`, e grava no `plan.json` como se tivesse sido respondida — banner ao compor a 1ª onda: `Onda composta sem pedir aprovação (wave_policy=auto, default #5695) — {N} unidades: {lista}. Pra ver cada composição antes do fan-out, passe --wave-policy per_wave ou peça mid-sessão.` Editor muda via `--wave-policy {auto|per_wave}` na invocação ou pedindo explicitamente mid-sessão ("quero aprovar onda a onda") — só nesses 2 casos a política sai do default automático. `per_wave` restaura o **Gate de Onda** bloqueante de antes (ver seção Gates).
6. **Política de pré-autorização cat. D** (`catD_preauth`) — UMA pergunta: "pra blast-radius, pré-aprovo a abordagem se o teste local + diff de amostra passarem, ou quero ver CADA Gate B?". **Default = `show_each`** (ver cada Gate B) — a segurança do blast-radius NÃO se remove em silêncio; front-load aqui é OPÇÃO explícita, nunca o default.
7. **Política de esgotamento** (`goal_policy`, #4297/#4319) — UMA pergunta, agora com 3 opções: "(a) trabalhar o backlog aberto inteiro em 4 ondas priorizadas até não sobrar nenhuma issue aberta; (b) só o backlog bloqueado, como antes da #4319; (c) fechar quando a lista de hoje acabar, sem re-varredura?". **Default sugerido: `exhaust_all`** (a). `blocked_only` (b) = escopo original de #2636/#4297. `table_only` (c) = comportamento pré-#4297, pra janela de tempo curta. **Pulada se `--no-implement` está ativo** — nesse modo o Goal nunca é alcançável por desenho (ver "Incompatibilidade estrutural com `--no-implement`"), `goal.policy` grava `table_only` direto, sem perguntar.

Assim que `goal_policy` é respondida, popular `goal.target_set`/`goal.remaining` no `plan.json`: com `exhaust_all`, é a união das 4 ondas (`tiers["1a"] + tiers["1b"] + tiers["2"] + tiers["3"]`), e `goal.current_tier` é gravado como `"1a"`; com `blocked_only`, é só `tiers["1a"]` filtrada pra bloqueadas + `tiers["1b"]` (o mesmo conjunto de sempre, só que lido a partir da partição por onda em vez de recalculado), e `goal.current_tier` também é gravado como `"1a"`; com `table_only`, `target_set`/`remaining` ficam vazios (não avaliados) e `goal.current_tier` **não é gravado** (fica ausente pela sessão inteira — não existe conceito de tier nessa política). `reached` recalcula pra `target_set.length === 0` no mesmo passo.

Gravar tudo em `plan.json` (`attack_order`, `wave_policy`, `catD_preauth`, `goal.policy`, `goal.target_set`, `goal.remaining`, `goal.reached`, e por issue `unblock_status`/`unblock_evidence`). **Regra de resume:** nada coletado no briefing é re-perguntado.

**O que NÃO dá pra front-load** (fica mid-sessão, vira exceção — não o fluxo normal): Gate B cat. D quando `catD_preauth = show_each`; ambiguidade imprevista que só aparece implementando; falha de MCP (#738); input que o editor não tem pronto no briefing. Com o front-load, a maioria das sessões não para em nenhum desses.

## Fase 1 — Desbloquear → validar → implementar em ondas paralelas por tier

A maioria dos desbloqueios já foi **coletada no briefing FRONT-LOADED** (Fase 0.5, #2966): a Fase 1 processa as issues `desbloqueada-validada` direto na implementação, e só usa o **Gate 1 pro RESÍDUO** — o que não deu pra front-load (token que o editor foi gerar, ambiguidade imprevista, decisão cat. C nova de uma issue que apareceu numa re-checagem).

**Escopo do Gate 1 residual, estreitado no #5695 — cat. A/B não re-perguntam mid-sessão.** Cat. A (credencial) e cat. B (conta de terceiro) são bloqueio de INSUMO, coletado na Fase 0.5 (item 3/4). Uma issue cat. A/B que chega na Fase 1 sem `unblock_status: desbloqueada-validada` — seja porque não front-loadou, seja porque apareceu numa re-checagem entre ondas — **não gera um novo `AskUserQuestion`**: o coordenador checa deterministicamente se o insumo já existe (`.env` tem a var referenciada / a conta já foi confirmada em turno anterior) e, se sim, valida (#573) e segue pra implementação sem perguntar; se não, aplica o default direto — `pulada` motivo `nao-destravavel-na-sessao`, comentário durável explicando o que falta — com um banner (`Issue #N (cat. {A|B}) sem insumo disponível — pulada por default, sem novo pedido mid-sessão. Cole o insumo a qualquer momento pra reabrir.`), não uma pergunta bloqueante. O editor pode colar um token/confirmar uma conta espontaneamente a qualquer momento, e isso reabre a issue normalmente. **Exceção (#7946): issue cat. A/B pedida nominalmente via `--issues N,M` nesta invocação não cai no default silencioso** — ganha UM `AskUserQuestion` pontual pelo insumo faltante. **O que sobra no Gate 1 residual é cat. C (sempre), cat. E quando o workaround tem custo real (critério 3 do #5321), e cat. A/B pedida via `--issues` sem insumo (exceção acima)** — essas continuam gerando `AskUserQuestion` (batchada por categoria quando aplicável). Cat. D nunca passa por Gate 1 — vai direto pro Gate B (seção Gates).

O Gate 1 remanescente (cat. C/E-com-custo, e cat. A/B pedida via `--issues` sem insumo — exceção #7946 acima) é serial mas **agrupa desbloqueios da mesma categoria numa única `AskUserQuestion`** (até 4 perguntas). **Com `goal_policy ∈ {exhaust_all, blocked_only}`:** trabalho acontece **um tier por vez** (`goal.current_tier`, começa em `1a`) — só issues do tier corrente entram na fila de implementação; um tier só é aberto pra trabalho depois que o anterior está esgotado (todo status terminal). **Com `goal_policy = table_only`:** não existe conceito de tier — `current_tier` não é gravado (schema, seção `plan.json`), todas as issues da tabela impressa na Fase 0 formam uma fila única, sem partição nem avanço por onda; o passo 6 abaixo é pulado inteiro nesse caso. **No início de cada iteração, reler `plan.json`.** **Antes do passo 1, rodar o "Filtro do servidor 300" (#5751, ver seção própria no topo deste arquivo)** pra cada issue do tier corrente sem status terminal — só segue pro passo 1 quem bate ≥1 dos 4 critérios (cat. A-E, `windows`, pedida nesta conversa, já em progresso nesta sessão); o resto vira `pulada` motivo `deixado-para-o-300` sem consumir Gate 1.

1. **Diagnosticar cada issue bloqueada do tier corrente sem `unblock_status: desbloqueada-validada`.** Cat. A/B: checar deterministicamente se o insumo já existe (`.env`/confirmação de turno anterior) — presente → passo 3 direto; ausente **e a issue não foi pedida via `--issues` nesta invocação** → default `pulada` motivo `nao-destravavel-na-sessao` com banner (ver acima), **sem** formular pedido de `AskUserQuestion`; ausente **e pedida via `--issues` (#7946)** → formular o pedido do insumo faltante pro passo 2, como cat. C/E. Cat. C/E-com-custo: formular o pedido de desbloqueio **exato e acionável** (ex: cat. C — "escolha A ou B pra {trade-off}"; cat. E — "workaround custa {N}, aplico?") pro passo 2. **Bloqueio SEM categoria A-E mapeada** (ex: veto da whitelist AAARRR, `matched: "label:aarrr-fora-da-whitelist"`) **pedido via `--issues` (#7946):** sem pergunta — registrar o override como comentário durável na issue + banner no terminal (ver nota após a tabela "Categorias de bloqueio") e tratar como elegível, direto pro passo 3; sem `--issues`, esse bloqueio não tem protocolo aqui e a issue não deveria ter chegado ao tier corrente (ver nota após a tabela "Categorias de bloqueio"). Issues sem sinal de bloqueio (tiers 1a/2/3 elegíveis) pulam direto pro passo 3.
2. **Gate 1 — desbloqueio** (`AskUserQuestion`, formato por categoria, pras issues cat. C/E-com-custo do tier corrente e cat. A/B pedida via `--issues` sem insumo (exceção #7946) — cat. A/B **sem** esse pedido explícito já resolveram no passo 1 sem pergunta) — toda opção inclui sempre "não consigo decidir agora (documentar e pular)".
3. **Validar deterministicamente (#573)** — nunca pela palavra do editor (ver tabela A–E). Issue elegível (sem bloqueio, tiers 1a/2/3) não passa por Gate 1/validação — vai direto pra composição da onda.
4. **Compor a onda:** quando há ≥1 issue pronta (validada, ou elegível sem bloqueio) no tier corrente, rodar a análise de cluster de conflito (mapear arquivos por issue via grep no corpo + símbolos citados — puro lookup, sem escrita de código) → issues que colidem em arquivo **fundem numa unidade só** (ver "Paralelização segura", #4319). **Checar claim de outra sessão antes do fan-out (#5156 item 3):** pra CADA issue da onda, `npx tsx scripts/lib/session-registry.ts is-claimed --issue {N}` — `claimed: true` (outra sessão overnight/develop ativa já está trabalhando essa issue) remove a unidade da onda (status `pulada`, motivo `claimed-por-outra-sessao`, sem comentário — corrida evitada, não bloqueio); registro vazio nunca bloqueia. **`exit 3` em `is-claimed`, `claim-issue`, `unclaim-issue` ou `merge-lock-acquire` = registro NÃO VERIFICÁVEL (#14009):** `data/` indisponível (junction pendente, Drive desmontado). Parar a sessão com halt banner (#738, motivo = a mensagem do stderr), sem despachar nem mergear, até `data/` voltar. **`is-claimed`/`claim-issue` sempre como comando standalone, nunca em `&&`/`;`/pipe/heredoc** (`context/overnight-dispatch-rules.md` item 18, #5751) — comando encadeado quebra a injeção automática de `--session-id`, e o erro resultante ("--session-id ausente") é falha real, nunca ruído a ignorar. **Consultar `conflicts` ANTES de abrir worktree (#6168 Parte C, ponto 1):** `npx tsx scripts/lib/session-registry.ts conflicts --paths {arquivos da unidade, separados por vírgula} --branch {branch atual}` (comando **standalone**, `--session-id` auto-injetado — encadear quebra a injeção, item 18 de `context/overnight-dispatch-rules.md`). `exit 1` = sobreposição real com peer VIVO; `exit 0` = livre. Diferente do `is-claimed`, que responde por ISSUE, isto responde por ARQUIVO. **`conflicts` é CONSULTA, nunca aquisição** — não cria arquivo nem reserva nada; o que fazer com a resposta é decisão desta skill. Sobreposição com peer alcançável → avisar o peer (`SendMessage`, ver "Parte D" abaixo) antes de dispatchar; peer inalcançável → registrar a sobreposição em `plan.json` e seguir, nunca travar por silêncio.

**Preflight de duplicidade ANTES do dispatch (#7020) — obrigatório pra toda issue da onda, logo após os dois checks acima.** Antes de reivindicar/abrir worktree, rodar `npx tsx scripts/check-issue-duplicate-preflight.ts --issue N --updated-at {updatedAt da issue}` (`origin/master`, nunca `--all`; vereditos e ações completos no item 21 de `context/overnight-coordinator-rules.md`): `not-in-master` (exit 0) → dispatch normal; `closes-should-be-closed` (exit 1) → sai da onda como CLOSEOUT barato (nunca reimplementar), `pulada` motivo `ja-resolvida-antes-da-sessao` com `ja_resolvida_evidencia` citando o SHA/commit do preflight (obrigatório — `validate-develop-plan-motivo.ts`, #5723); `refs-declared-residue` (exit 1) → dispatchar só o resíduo real, se sobrar. `resolvedAfterLastUpdate: true` vai no comentário de closeout/redução de escopo. O preflight do subagente (item 14 de `context/overnight-dispatch-rules.md`) segue como rede de segurança.

**Preflight de PR ABERTA, logo em seguida (#7788)** (vereditos e casos completos no item 28 de `context/overnight-coordinator-rules.md`). Rodar `npx tsx scripts/check-issue-open-pr.ts --issue N --session-id {id}`: `no-open-pr` (exit 0) → dispatch normal; `open-pr-covers-scope` (exit 1) → PR de terceiro/manual pelo checklist de 3 perguntas do item 16; PR de lane autônoma (`overnight/`, `develop/`, `continuo/`): o `orphanAction` vale ANTES das perguntas 2 e 3 (#12950), a issue sai `pulada` motivo `pr-em-voo` e o `orphanAction` do JSON é seguido como no item 28 (merge pelos gates com `--match-head-commit <sha avaliado>`, fixer, aguardar CI ou deixar ao editor; issue reivindicada por sessão ativa sai `editor`, #12950 item 3). `cannot-verify` (exit 2) nunca vira "sem PR aberta": reter/retry.

**Checar o teto de concorrência somando TODAS as sessões ativas (#5156 item 6):** `npx tsx scripts/lib/session-registry.ts list-active` — o teto de 6 worktrees abaixo é POR SESSÃO; se outras sessões ativas nesta máquina já somam `active_worktrees` significativos, considerar abrir menos que 6 nesta onda (heurística de throughput, não trava). Depois de passar pelos dois checks: → **Gate de Onda** (banner + segue direto — **pulado por default desde #5695**, `wave_policy = auto`; bloqueante só com `wave_policy = per_wave`) → reivindicar as issues aprovadas da onda numa chamada só (`npx tsx scripts/lib/session-registry.ts claim-issue --kind develop --issues {N1,N2,...}`, uma escrita na âncora, #12010; uma linha por issue, `exit 1` se alguma não terminou reivindicada, com as outras já reivindicadas e a recusada tratada como `claimed: true`; se a unidade inteira sair da onda por causa da recusa, soltar as demais numa chamada só com `unclaim-issue --kind develop --issues {N1,N2,...}`, standalone, uma escrita na âncora, #12166/#6317) → **logo depois do `claim-issue`, gravar a claim também no GitHub e reconferir (#13154):** `npx tsx scripts/check-pre-dispatch-claim.ts --issues {N1,N2,...} --session-id {id} --kind develop --announce` (standalone, `--session-id` explícito), que junta `is-claimed`, PR aberta e o marcador de claim em comentário na issue, e grava o desta sessão nas livres. É esse comentário que o overnight do `300` lê antes de despachar quando o registro desta máquina ainda não replicou. `exit 1` com `registry`/`github-claim` → a unidade sai da onda (`claimed-por-outra-sessao`), soltando as claims dela; só `pr-aberta` → `orphanAction` como acima; `exit 2` → reter e tentar de novo. Junto de cada `unclaim-issue`, rodar `check-pre-dispatch-claim.ts --issues {...} --session-id {id} --release`, e também em todo caminho em que a unidade deixa de ser trabalhada depois do `--announce`: `pulada` (qualquer motivo), falha do implementador, PR fechada sem merge (#13172; sem isso a claim no GitHub segura a issue por 24h para as outras sessões). `exit 1` com `github-claim-race` = outra sessão anunciou antes, entre a conferência e o post; o script já gravou o release desta, falta só o `unclaim-issue` — **o `claim-issue` vale pra toda unidade que o coordenador decide trabalhar, via subagente OU DIRETAMENTE (sem fan-out — comum em unidades pequenas, Chrome-assisted, ou investigativas que não justificam worktree isolado): reivindicar antes de começar a mexer na issue em qualquer um dos dois caminhos, não só no de fan-out (#5407)** → **fan-out de até 6 implementadores concorrentes** (um worktree por unidade; branch `develop/fix-NNNN` — ou `develop/fix-NNNN-MMMM` pra unidade fundida — solo, ou `develop/blast-NNNN` p/ cat. D, sempre solo e nunca fundida). Cada PR passa pelo **review de fleet pré-merge** (#4383 — ver "Gates", "REVIEW DE FLEET PRÉ-MERGE"; o coordenador dispatcha os 5 agentes explicitamente, nunca o subagente implementador) e só então pelo **Gate 2 determinístico** (#2210/#2222), mergeando independentemente; unidade fundida fecha **todas** as issues do cluster no mesmo merge (`Closes` por issue, verificar `gh issue view --json state` pós-merge pra cada uma — **com o fechamento confirmado, soltar a claim na mesma respiração**: `npx tsx scripts/lib/session-registry.ts unclaim-issue --kind develop --issues {N1,N2,...}` com todas as issues do cluster numa chamada standalone só (uma escrita na âncora, #12166; `--issue {N}` para issue solo), #6317 — sem isso a claim só cai quando a SESSÃO INTEIRA termina). **Imediatamente após dispatchar o fan-out desta onda, publicar a contagem de worktrees (#8495 — call site de ABERTURA, obrigatório, espelha #6299 do overnight):** rodar `npx tsx scripts/lib/session-registry.ts heartbeat --kind develop --active-worktrees {N}`, onde `{N}` = worktrees desta sessão vivos agora (soma de todos os fan-outs concorrentes ainda não limpos, não só os desta onda). **Standalone, nunca em `&&`/pipe/heredoc nem dentro de um bloco de código multi-linha** (`context/overnight-dispatch-rules.md` item 18) — encadear quebra a injeção do `--session-id` e a publicação vira no-op silencioso, mesmo critério de `test/skill-chained-session-command-guard-6232.test.ts`. **Fila grande (>8 issues prontas no tier, #2754):** a análise de cluster de conflito pode ser delegada a um subagente `general-purpose` com `model: haiku` explícito (não `claude-opus-5-5` — é puro grep/leitura) em vez do coordenador rodar serialmente — só essa etapa de mapeamento, nunca a implementação em si (que continua sempre `dev-implementador` — `claude-opus-5-5`/`medium` no frontmatter, #9081).
5. Atualizar `plan.json` + `scripts/log-event.ts`; `git pull` após cada merge. **Depois do `git pull`, aplicar a seção `Escrita pendente em data/` do corpo da PR mergeada (#11780, item 35 de `context/overnight-dispatch-rules.md`; lembrete #11835):** cada linha no checkout principal, com Edit cirúrgico (#495), registrada na nota da unidade no `report.md`; o que não der pra gravar entra no relatório como pendente. **No trem de merge (#6300), ler o corpo de CADA PR ORIGINAL do lote (os números passados em `--prs`), nunca o do PR-trem** — `buildTrainPrBody` não copia os corpos e as originais terminam fechadas, então ler o PR-trem pula a escrita em silêncio. A unidade só conta como concluída quando a nota dela registra o resultado (`escrita data/: aplicada` ou `escrita data/: pendente: {motivo}`); gravar o status terminal no `plan.json` não dispensa este registro. Issue não destravável na sessão → comentário durável (com dedup) explicando o que falta, status `pulada` motivo `nao-destravavel-na-sessao` (degradação elegante para o skip do overnight, mas só após ter tentado destravar ao vivo). **Mesmo tratamento pra issue elegível cuja implementação falha sem nunca abrir PR/chegar ao CI** (#4319 — subagente travou, `npm ci`/worktree falhou, exceção não tratada durante a implementação): renderizar halt banner (`scripts/render-halt-banner.ts`, mesmo padrão do #738 pra outras paradas inesperadas), diagnosticar, e gravar `pulada` motivo `nao-destravavel-na-sessao` com o erro no comentário — nunca deixar a issue presa em `pendente` sem tentar de novo indefinidamente nem sem marcar terminal (é o único caminho terminal disponível pra uma issue que pulou Gate 1, e sem ele o tier correspondente nunca esgotaria).

   **Instrumentação de token da rodada (#3454 Rec 1):** cada unidade despachada (issue solo ou onda) gera eventos `subagent_metrics` no run-log com as mesmas 3 colunas (`subagent_tokens`, `tool_uses`, `duration_ms`), mas **NÃO ao fim da unidade**: saem uma vez só, no relatório da Fase 2 (seção "Custo em tokens"), quando nada mais está em voo (#10483 — na onda paralela o fim de uma unidade pega outros implementadores ainda rodando, e a dedup do script por `agent_id` congelaria os tokens parciais deles). **Campo `papel` obrigatório (#9875):** um evento por invocação de `Agent` da unidade, não um só somando tudo — `dev-implementador` (dispatch original), `dev-fixer` (fixer de self-review/fleet), `ci-retry` (cada tentativa de fix de CI vermelho despachada como agent NOVO — `dev-fixer` com CI no description; um retry via `SendMessage` escreve no transcript do mesmo agente e os tokens dele entram no evento do papel original, porque o script emite um evento por `agent_id`, #10547). Sem o campo o custo do implementador fica somado ao de fixer e retry, e não dá pra medir a troca de modelo de um papel só; `scripts/check-overnight-token-instrumentation.ts` quebra o total por `papel` e conta os eventos sem ele como `sem-papel`. **Sempre via `scripts/subagent-usage-metrics.ts`, nunca à mão com `log-event.ts` (#10476)** — o script lê os transcripts dos subagentes desta sessão, deriva `papel`/issues/tokens/`tool_uses`/`duration_ms` e grava com `agent_id` (comando na Fase 2, seção "Custo em tokens"; subagente sem `end_turn` é pulado como "em voo", mas isso é rede, não convite a rodar por unidade). Evento gravado: `{"unidade": "#NNNN | lote #A + #B", "issues": [123], "papel": "dev-implementador | dev-fixer | ci-retry", "subagent_tokens": N, "tool_uses": N, "duration_ms": N, "source": "subagent_transcript | unavailable", "agent_id": "..."}`.
   Análogo ao `coordinator_tokens_estimate` do overnight (#3453 Rec 1), emitir também um `coordinator_tokens_estimate` ao fim de cada onda + no relatório, sempre via `npx tsx scripts/coordinator-usage-estimate.ts --edition {AAMMDD} --agent develop --phase "onda {id} | fase_1_5 | fase_2"` (comando standalone), nunca à mão com `log-event.ts` (#9874) — o script lê o usage real do transcript local da sessão e, sem fonte, grava `unavailable` com `reason` explícito. (histórico: docs/rodadas-autonomas-historico.md#dev-3454-b)

6. **Esgotar o tier corrente → avançar (`goal_policy ∈ {exhaust_all, blocked_only}`):** quando todas as issues do `current_tier` atingem status terminal:
   - **Re-checagem entre ondas** (#4319, sempre, sem cap): antes de montar a próxima onda, re-varrer TODAS as issues abertas via `gh issue list` (sem `body` — barata) e reclassificar em tiers (mesma regra da Fase 0 passo 6). Issue nova que cai num tier **já esgotado** entra na fila mesmo assim — `goal.current_tier` **volta** pra esse tier (não gera livelock: status terminal nunca é re-escolhido, só issue genuinamente nova reabre um tier). Atualizar `goal.tiers`/`goal.target_set`/`goal.remaining` no `plan.json` a cada ciclo.
   - Repetir o tier corrente (ou o tier reaberto) até esgotar de novo, então avançar: `1a → 1b → 2 → 3` (com `blocked_only`, só `1a`-bloqueada `→ 1b`, e o Goal fecha ali — nunca entra em 2/3).
   - **Antes de montar o grupo 3**, imprimir o banner do **Gate do grupo 3** (seção própria, revisado #5321) — sempre, mesmo em reentradas. Default `auto_entered` → monta normalmente; só vira `editor_interrupted` (`goal.reached: false`, grupo 3 vai pro resíduo sem virar `pulada`, ou só o subconjunto pedido entra) se o editor intervier por iniciativa própria antes do tier abrir. "Escopo já extenso" não é intervenção do editor — não interrompe nada; se o coordenador precisa mesmo parar por limite técnico real, é `coordinator_self_limited` (#5439, ver "Gate do grupo 3" acima e schema `tier3_gate`), nunca `editor_interrupted`.
   - Quando o **tier** 3 (ou 1b, em `blocked_only`) esgota **sem** issue nova na re-checagem seguinte (não confundir "tier" — grupo de prioridade 1a/1b/2/3 — com "onda" — o lote de unidades despachadas em paralelo dentro de um tier, que pode se repetir várias vezes até o tier esgotar): rodar a **re-varredura de convergência** (mesma varredura completa, agora perguntando "achou algo novo em qualquer tier?") — repete **sem cap** enquanto achar issue nova sem status terminal; sem novidade, `goal.reached: true` (ou `false` se o gate do grupo 3 registrou `editor_interrupted` com resíduo).
   - `rescans_done` incrementa a cada ciclo de re-checagem/convergência, **como contador puro** (#4319 — sem cap, nenhuma lógica lê o valor pra decidir parar; só a Fase 2 reporta). Issue novata entra no Gate 1 normalmente (não pula direto pra implementação). **Anti-livelock idêntico ao overnight:** issue com status terminal na sessão **nunca** é re-escolhida.

   Com `goal_policy = table_only`, pular esta etapa inteira — a Fase 1 encerra assim que a tabela original acaba, `goal` fica com `policy: "table_only"` e sem avaliação de `reached`.

## Gates

**Cinco gates** (#4319 acrescenta o do grupo 3 aos quatro de #4297) — a separação limpa é o que torna seguro inverter a Regra 1 e paralelizar: **humano bloqueante no Gate 1 (cat. C/E-com-custo, ver "Categorias de bloqueio" — #5695 estreitou o escopo do que Gate 1 pergunta) e no Gate B; humano-interruptível (default automático) no Gate de Onda (#5695) e no Gate do grupo 3 (#5321); máquina sozinha no Gate 2.** **REVIEW DE FLEET PRÉ-MERGE (#4383, abaixo) não é um dos cinco** — é um passo de máquina inserido na esteira entre o self-review/fixer da unidade e o Gate 2, não um ponto de decisão/ramificação como os cinco; a contagem "cinco gates" permanece correta.

- **GATE 1 — DESBLOQUEIO** (humano, `AskUserQuestion`, permitido por design — **escopo estreitado no #5695**: cat. A/B são bloqueio de INSUMO, não decisão — só perguntadas no front-load da Fase 0.5 (colar token/confirmar conta de uma vez); residual mid-sessão (o que não front-loadou) segue por default pro terminal `nao-destravavel-na-sessao`, sem novo `AskUserQuestion`, ver Fase 1 passo 2 abaixo. **A pergunta que sobra em Gate 1 é cat. C** (trade-off editorial real, critério 2 do #5321) **e cat. E só quando o workaround envolve gasto real** (critério 3) — o resto de cat. E (workaround sem custo, ou "documentar") segue por default. Órgão central da skill continua sendo a decisão cat. C. Decisões de produto/editorial (cat. C/E-com-custo) **viram comentário durável na issue** — `plan.json` é só cache.
- **GATE DE ONDA — COMPOSIÇÃO PARALELA** (checkpoint humano-interruptível, default automático desde #5695 — mesmo desenho do Gate do grupo 3 abaixo). Compõe as unidades da onda — clusters fundidos e singletons (#4319, ver "Paralelização segura" — colisão já não serializa mais, funde) — e segue direto pro fan-out com banner, sem esperar aprovação (`wave_policy = auto`, default desde #5695). Editor pode interromper a qualquer momento pra ver/ajustar a composição antes do fan-out. **Bloqueante de volta com `--serial` OU `wave_policy = per_wave`** (`--wave-policy per_wave` na invocação, ou pedido mid-sessão — mesmo padrão do `attack_order`/#4498) — nesse caso volta a apresentar a onda e esperar aprovação explícita antes do fan-out.
- **REVIEW DE FLEET PRÉ-MERGE** (máquina, sem humano, por PR — #4383, roda entre o self-review/fixer da unidade e o Gate 2). O subagente implementador não pode dispatchar a ferramenta Agent (#207) — por isso, quando ele recebe do hook `.claude/hooks/pr-create-review.mjs` a instrução de rodar o review multi-agente, a regra 8 do checklist manda ele SÓ fazer self-review e retornar. O hook resolve o effort do PR do develop por tamanho de diff (#6393, `docs/pr-review-effort.md`): < 500 linhas → `low` (1 agente); ≥ 500 ou desconhecido → `max` (fleet de 5). O fleet deste passo **segue o effort que o hook resolveu para aquele PR** (a instrução que o hook devolve no `gh pr create` diz qual; se não der pra determinar, usar `max`, o mesmo fail-safe do hook) — nunca `max` fixo. A Fase 1.5 do develop (1 agente, ao fim da sessão) NÃO cobre o `max` a que um PR grande tem direito. Por isso, **antes do Gate 2**, o COORDENADOR (nunca o subagente) dispatcha explicitamente: PR que resolveu `low` → só `pr-review-toolkit:code-reviewer` (1 agente; `fleet_review: "done"`); PR que resolveu `max` → em paralelo, os 5 agentes do fleet — `pr-review-toolkit:code-reviewer`, `pr-review-toolkit:silent-failure-hunter`, `pr-review-toolkit:pr-test-analyzer`, `pr-review-toolkit:comment-analyzer`, `pr-review-toolkit:type-design-analyzer` (nomes PREFIXADOS pelo plugin) — cada um com `model: "opus"` explícito (#2019; alias, porque o parâmetro `model` do Agent tool só aceita `sonnet`/`opus`/`haiku`/`fable` e devolve `InputValidationError` pra ID pinado como `claude-opus-5-5`, que só vale em frontmatter de agent, #10946; o Agent tool não tem parâmetro `effort` e os agentes do plugin vêm de fora do repo, então herdam o effort do turno — `medium` no par desta skill), escopo **explícito** `git diff {merge_base}...{branch}` desta unidade (nunca o diff unstaged default do agente) e restrição **somente leitura** (sem edição de arquivo, `checkout`/`switch`/`stash`/`reset`, ou commit — o checkout pode ser compartilhado com outra sessão). **Fallback obrigatório** se `Agent type ... not found` (plugin `pr-review-toolkit` ausente — sessão cloud, clone fresco): `dev-revisor` (`claude-opus-5-5`/`medium` no frontmatter, #9081 — se o próprio `dev-revisor` também não resolver, `adhoc-opus-medium`, também dedicado; nunca `general-purpose`, que herdaria o effort do turno, #9873) com o mesmo rubrico inline usado no fallback da Fase 1.5 (correctness, simplification/efficiency, test-coverage, security) — degradar é aceitável, pular o review em silêncio não. Achados agregados vão pro mesmo agente fixer (2-agentes) já usado pro self-review, na mesma branch, antes de prosseguir pro Gate 2. Registrar no `plan.json` da unidade (`fleet_review: "done"` / `"skipped: {motivo}"`) para auditoria — mesmo padrão do campo `review` do overnight. **Instrumentação de token do fleet review (#4815):** os eventos `fleet_review_metrics` saem da mesma execução única de `scripts/subagent-usage-metrics.ts` na Fase 2 (#10476/#10483 — não rodar aqui ao fim do fleet) — um evento por agente do fleet, com `fleet_tokens` do transcript de cada um. O description do dispatch precisa citar o PR (`Review PR #N`): é isso que separa review de fleet (por PR) de review consolidado (`review_metrics`). Nunca emitir à mão com `log-event.ts`.
  É a fonte da categoria **Fleet review pré-merge** da seção "Custo em tokens" (Fase 2, mandatória desde #4815) — separada da Implementação de propósito (#4815 item 2).
- **Claims no merge (#11372):** imediatamente antes de mergear cada PR, executar
  `npx tsx scripts/check-pr-session-claims.ts --pr {N} --session-id {sessionId} [--issue {ref}]`.
  Só exit 0 permite seguir. Claim efetiva de outra sessão bloqueia e nomeia a dona;
  erro também bloqueia. Não tomar nem liberar claim alheia. O trem e o gate do
  contínuo fazem a mesma checagem automaticamente.

- **GATE 2 — IMPLEMENTAÇÃO/MERGE** (determinístico, sem humano, por PR; **Colchetes `[--issue {ref}]`/`[--repo {repo}]`/`[-R {repo}]` (#10618, fatia 4):** usar SÓ quando o PR é de issue de OUTRO repo (`{ref}` = `owner/repo#N` da issue, `{repo}` = `owner/repo` dela — hoje `vjpixel/diaria-design`); PR do studio omite os colchetes (a chamada de sempre). Sem eles, os gates leem e o merge age no PR #N do studio.): gate de 2 condições do overnight (#2210/#2222 — condição 1: `npx tsx scripts/check-pr-checks-gate.ts --pr {N} [--issue {ref}]` sai `exit 0` (ver `scripts/lib/pr-checks-gate.ts`; substitui `gh pr checks --json bucket`, que não roda no `gh` do `300`, #6225) **E** condição 2: threads não-resolvidas excluindo FORBIDDEN == 0 via `npx tsx scripts/resolve-review-threads.ts --pr {N} [--repo {repo}] --check` com `exit 0` — modo somente leitura; sem `--check` o script RESOLVE as threads e o gate viraria autoaprovação de thread que o editor deixou aberta; nunca `gh api graphql` à mão, #11235) **E condição 3 (#10278/#10294): `npx tsx scripts/check-pr-retido-gate.ts --pr {N} [--issue {ref}]` sai `exit 0`** — `exit 1` = PR retida para o editor (label `retido-para-editor` ou marcador `<!-- retido-para-editor -->` no corpo, aplicados por QUALQUER trilha): não mergear mesmo com CI verde e threads resolvidas, comentar e seguir pra próxima unidade; `exit 3` = erro, fail-closed (não mergear). Mesma condição 3 do Gate 2 do overnight — prosa de comentário não segura merge, só o sinal mecânico. Em chamada separada do `gh pr merge`, + verify #573. **Merge lock cross-sessão antes do `gh pr merge` (#5156 item 4):** `npx tsx scripts/lib/session-registry.ts merge-lock-acquire --pr {N} [--repo {repo}]` (`--session-id` auto-injetado). **`--pr` não é opcional na prática** (#7169/#7223): sem ele, o guard #5716 bloqueia `gh pr merge` mesmo com a sessão registrada como coordenadora e o lock em mãos. `denied` → outra sessão (overnight ou develop concorrente) está no meio do próprio merge+pull (TTL 2 min) — esperar ~15s e tentar de novo, poucas tentativas, escalando pra halt banner se persistir. **Nota (#6182): entre máquinas via OneDrive, o lock é advisory — `O_CREAT|O_EXCL` vê inodes diferentes.** **Mitigação adicional pós-#7169:** rodar `git fetch origin master` e conferir se o head mudou desde a última leitura antes de confiar no lock/grant cross-máquina — é sinal que vem do GitHub, não do OneDrive, e atravessa máquina de verdade mesmo com `data/sessions/` sincronizando degradado. Liberar com `merge-lock-release --pr {N} [--repo {repo}]` (mesmo `--pr {N}` do acquire, #7169/#7223) logo após o `git pull` que segue o merge — a janela protegida é só `gh pr merge` até esse `git pull`, nunca mais que isso. **O guard do #5716 agora CONSULTA o lock (#6296):** uma coordenadora que não o detém enquanto OUTRA coordenadora ativa existe é bloqueada — pegar o lock deixou de depender de a skill lembrar. Lock ausente com esta sendo a única coordenadora, ou estado do lock ilegível, nunca bloqueiam (nunca transformar falha transitória de I/O do OneDrive em bloqueio de merge legítimo).

  **Conceder janela a uma sessão que não é coordenadora (#6296).** Quando uma sessão interativa (ou qualquer sessão fora do registro) precisar mergear enquanto esta rodada está ativa, o guard do #5716 a bloqueia — corretamente, porque ela não é coordenadora e não vira uma por relabel. O caminho legítimo é esta sessão CONCEDER a janela, depois de conferir colisão por arquivo contra os PRs abertos da rodada: `npx tsx scripts/lib/session-registry.ts grant-merge --kind develop --granted-to {sessionId dela} --pr {N}` (`--session-id` auto-injetado). TTL de 10 min, **uso único**, e **ninguém concede a si mesmo** — é isso que preserva a propriedade que o #5716 protege em vez de contorná-la. **Passe `--pr` sempre:** a concessão é ESCOPADA àquele PR (#6303) — sem o flag ela vale pra qualquer merge daquela sessão durante o TTL, o que anularia a conferência de colisão que justifica concedê-la. **No `SendMessage` que avisa a beneficiária, inclua explicitamente que o `gh pr merge` dela precisa citar o número do PR** (`gh pr merge {N} [-R {repo}] ...`, nunca deixar o `gh` inferir pela branch corrente) — concessão escopada só cobre o PR exato dela (#6322): sem o número explícito, `extractGhPrMergeTargetPr` não consegue casar a chamada com a concessão e o guard bloqueia mesmo com janela válida em mãos. A sessão beneficiada pode confirmar com `check-merge-grant`, mas **não precisa consumir à mão**: o hook `PostToolUse` `.claude/hooks/consume-merge-grant-on-merge.mjs` consome a janela sozinho após o `gh pr merge`. **Nunca** destravar alguém mandando rodar `register --kind develop`: isso fabrica identidade de coordenadora e fura o guard.

  **Trem de merge (#6300, decisão do editor 26/08/2026, default ATIVO nas 3 skills — overnight/develop/contínuo).** Quando ≥2 PRs do lote/onda corrente já satisfazem o Gate 2 (condição 1 verde, condição 2 zero threads) AO MESMO TEMPO e não colidem em arquivo entre si (mesma análise de cluster de conflito de "Paralelização segura" acima), preferir `npx tsx scripts/run-merge-train.ts --session-id {sessionId desta sessão} --kind develop --prs {N1,N2,...}` a mergear 1-a-1 (**só PRs do studio** — `run-merge-train.ts` é só-studio; PR de issue do `vjpixel/diaria-design` nunca entra no trem e segue o merge isolado com `-R {repo}`, item 32 de `context/overnight-dispatch-rules.md`, #10618) — colapsa K runs de CI num só e mergeia sob o MESMO `merge-lock-acquire`/`release` já documentado acima (a chamada é interna ao script, não precisa repetir manualmente). `--session-id` é **obrigatório e explícito** aqui — diferente de uma chamada Bash direta desta sessão, o script chama `session-registry.ts` como subprocesso PRÓPRIO, fora do alcance do hook `inject-session-id.mjs`. Lote de 1 PR só (nenhum outro Gate-2-verde no momento) → não vale a pena, mergear direto como sempre. **Degrada sozinho, nunca trava**: CI do lote vermelho ou timeout (30 min, mesma convenção de sempre) bissecta automaticamente até o piso — um PR ruim isolado no meio de um lote bom nunca prende os demais. **PR retida (#10294):** o script lê o sinal `retido-para-editor` sozinho — exclui a PR do trem na descoberta com motivo explícito (`EXCLUÍDO do trem`) e relê no instante do merge, tirando só ela do lote (status `retido`, não é falha; sinal ilegível no merge vira `retido-ilegivel`, que É falha, #10299); o resto do lote segue. Commit final é **1 squash por lote com `Closes` de todas as issues** (mesma convenção da fusão de cluster colidente, #4319 — revert é tudo-ou-nada pro lote). Ver `scripts/lib/merge-train.ts`/`merge-train-live.ts` pro mecanismo completo; `scripts/plan-merge-train.ts` mostra o plano sem executar, útil pra inspecionar antes.
- **GATE B — PRÉ-APLICAÇÃO** (só cat. D): entre validar e aplicar em escala. Mostra diff-walkthrough (contagem por tipo de mudança + 1 site exemplo antes/depois + resultado do teste local) e pede confirmação explícita ("vai tocar ~N sites; testei local: {resultado}. Aplico no conjunto inteiro? s/n/subconjunto"). **Obrigatório por default (`catD_preauth = show_each`); opt-out por sessão via `catD_preauth = preapproved`** (escolhido no briefing, #2966) — aí o coordenador só aplica se o teste local + diff de amostra passarem, sem parar. O default NUNCA é pré-aprovado: a segurança do blast-radius não se remove em silêncio. **Falha de feedback VISUAL não encerra a unidade (#5907 item e):** screenshot quebrado/travado NÃO equivale a "sem verificação" — antes de declarar `nao-destravavel-na-sessao`, esgotar o feedback ESTRUTURAL (`read_page`/`find`/`get_page_text`, árvore de acessibilidade, navegação por URL parametrizada).
- **GATE DO GRUPO 3 — ENTRADA NA CAUDA LONGA** (checkpoint humano-interruptível, default automático desde #5321 — não é mais `AskUserQuestion`; ver seção própria "Gate do grupo 3"). Único gate desta lista que não trava uma unidade de trabalho, e sim uma **classe inteira** de trabalho (o tier 3). Sem opt-out por `wave_policy = auto` porque não há mais o que pular — o default já é entrar.

**Fallback de ausência:** `AskUserQuestion` é bloqueante; se o editor sair no meio, a issue corrente vira `pulada` motivo `decisao-adiada`, `resume_state` é gravado e a sessão **para limpa — nunca continua autônoma**. Todo gate de desbloqueio inclui "decido depois / pular".

## Fase 1.5 — Code-review consolidado (opcional, mais leve)

**Rede complementar, não o review primário de cada PR (#4383)** — esse é o "REVIEW DE FLEET PRÉ-MERGE" da seção Gates. Esta Fase 1.5 é 1 agente só, sobre o diff ACUMULADO da sessão inteira, pra pegar interações entre PRs que não colidiram em arquivo mas colidem semanticamente.

Roda só se houve ≥1 merge e o diff `{base_sha}..HEAD` > ~50 linhas. Forma executável (#4034 — `/code-review` deixou de ser invocável via Skill tool desde 260724, gate de plataforma `disable-model-invocation`; #4234 — dispatch via agentes do plugin `pr-review-toolkit`): dispatchar um Agent com `subagent_type: "pr-review-toolkit:code-reviewer"` (nome PREFIXADO — sem o prefixo dá `Agent type not found`) e `model: "opus"` explícito (#2019; alias, porque o parâmetro `model` do Agent tool só aceita `sonnet`/`opus`/`haiku`/`fable` — ID pinado como `claude-opus-5-5` só vale em frontmatter de agent e aqui devolve `InputValidationError`, #10946; sem `effort` — não é parâmetro do Agent tool, o agente do plugin herda o do turno), passando `git diff {base_sha}..HEAD` como escopo **explícito** no prompt (o agente revisa `git diff` unstaged por default) + restrição **somente leitura** (sem edição de arquivo, sem `git checkout`/`switch`/`stash`/`reset`, sem commit — o checkout é compartilhado, incidentes 260703/260708), sem `--comment` (mesmo racional do overnight — findings retornam ao coordenador). **Fallback obrigatório** se resolver `Agent type ... not found` (plugin ausente): `dev-revisor` (`claude-opus-5-5`/`medium` no frontmatter, #9081) + rubrico inline (correctness, simplification/efficiency, test-coverage, security); se o `dev-revisor` também não resolver, `adhoc-opus-medium` (também agent dedicado, `claude-opus-5-5`/`medium` no frontmatter) + o mesmo rubrico — nunca `general-purpose`, que herdaria o effort do turno do coordenador (#9873). Crítico-em-produção confirmado deterministicamente (`gh run list --branch master --limit 1`, #573) → hotfix imediato; demais → issues via `scripts/lib/auto-reporter-dedup.ts` (dedup, labels tipo + prioridade obrigatória). Review falhou (Agent indisponível, timeout) → fail-soft #738: `review: "skipped: {erro}"`, segue pro relatório.

**Findings não são mais classe especial no develop (#4319).** (histórico: docs/rodadas-autonomas-historico.md#dev-4319-d) O finding vira uma issue igual a qualquer outra, entra na próxima re-checagem entre ondas (Fase 1 passo 6) e é classificado no tier dele pelas mesmas regras da Fase 0 passo 6 (`bug` → 1a; `enhancement` → 2 ou 3, conforme prioridade) — disputa a fila com o resto, sem mini-rodada nem cap. `findings_depth` **permanece no `plan.json` como contador puro de observabilidade** (mesmo destino de `rescans_done`, ver "Goal de esgotamento") — incrementa a cada finding que a própria sessão consome, mas nenhuma lógica ramifica nele. A label `session-finding` continua sendo aplicada (origem/auditoria), sem tratamento estrutural diferenciado no develop; no `/diaria-overnight` o cap de profundidade 2 e o tratamento especial de `session-finding` seguem intactos.

## Fase 2 — Relatório + handoff para o overnight

**Gate de re-triagem pendente + convergência (#5476, fundido em #5706), primeiro passo antes de qualquer outra coisa nesta fase:** rodar `npx tsx scripts/check-state-changed-pending.ts --plan data/develop/{AAMMDD}/plan.json`. Desde #5706 este comando cobre DOIS casos num único gate: pendências explícitas (`--add-pending`, escopo original #5476) E a re-varredura de convergência da Fase 1 passo 6 (`gh issue list --state open` completo, comparado contra `goal.target_set`/`goal.tiers`/`issues[]` — issue nova fora desse conjunto e classificada `overnight`/`develop` por `classifyExecTrack` é reportada; `agendada`/`bloqueada`/`fora-de-rodada` não conta como ruído). Desde #10407 cobre também um terceiro caso: entrada de `issues[]` com `deixado-para-o-300`/`claimed-por-outra-sessao` cujo track ATUAL (`classifyExecTrack`, labels de agora) virou `develop`/`bloqueada` desde a gravação — outra sessão re-roteou a issue no meio desta; regravar `exec_track_painel` e levá-la ao Gate 1. `exit 1` → voltar pra Fase 1, reavaliar dispatch pra cada issue listada (ver regra em "Regras" acima; issue nova de convergência entra no Gate 1 normalmente), só então continuar. `exit 0` → seguir normalmente. Grava `goal.last_convergence_scan: {at, novas_encontradas}` no `plan.json` a cada rodada bem-sucedida do `gh`. Sem rede/`gh` indisponível: o comando degrada sozinho (avisa em stderr) para só a pendência explícita — `--skip-convergence` faz o mesmo proativamente.

**Gate de cobertura de comentário (#5816), logo em seguida:** rodar `npx tsx scripts/check-overnight-comment-coverage.ts --plan data/develop/{AAMMDD}/plan.json` — mesmo script do overnight, `--plan` aponta pro `plan.json` do develop. Confere que toda issue `pulada` (mesmo critério de motivo do gate seguinte) e toda issue `mergeada` cujo PR usou `REFS #N, NÃO CLOSES` em vez de `Closes` (#5010) de fato recebeu um comentário na issue explicando o que foi feito/o que falta. `exit 1` → comentar em cada issue listada antes de continuar. `exit 0` → seguir normalmente. Sem `gh`/rede: degrada sozinho pra warning + `exit 0` (fail-soft #738).

**Gate de estado terminal de PR (#5831), logo em seguida:** rodar `npx tsx scripts/check-pr-terminal-state.ts --plan data/develop/{AAMMDD}/plan.json` — mesmo script do overnight (histórico: docs/rodadas-autonomas-historico.md#dev-5831). O comando cruza `gh pr list --state open` contra `plan.json`: PR registrado (`issues[].pr`) que segue aberto sem status `mergeada`/`draft-ci-vermelho`/`fechada-sem-merge`/`retida-para-editor` na issue correspondente (nem label/marcador `retido-para-editor` na PR, #10278) → divergência confirmada; PR aberto em branch `develop/`/`overnight/`/`fix/` sem nenhum registro em `issues[].pr` → candidato pra revisão humana (autoria não confirmada só pelo branch, sessões concorrentes existem por design, #5156), listado separado como aviso — não reprova o gate (#10430). `exit 1` → checar cada PR listado (`gh pr view N`), mergear/fechar/atualizar `plan.json` antes de continuar. `exit 0` → seguir normalmente. Sem `gh`/rede: degrada sozinho pra warning + `exit 0` (fail-soft #738).

**Gate de motivo fora do vocabulário fechado (#5708), logo em seguida:** rodar `npx tsx scripts/validate-develop-plan-motivo.ts --plan data/develop/{AAMMDD}/plan.json`. `exit 1` → dois modos de falha possíveis: (1) pelo menos uma issue `pulada` tem `motivo` que não é `nao-destravavel-na-sessao`, `decisao-adiada`, `claimed-por-outra-sessao`, `ja-resolvida-antes-da-sessao`, `fechada-durante-a-sessao` (#12105) ou `deixado-para-o-300` (ou não tem `motivo` nenhum) — sinal de um rótulo de espera inventado ("gated no D0", "timing do editor") escapando da classificação real; (2) motivo `ja-resolvida-antes-da-sessao` sem `ja_resolvida_evidencia` (#5723), ou `fechada-durante-a-sessao` sem `fechada_evidencia` (#12105) — motivo válido, evidência obrigatória ausente. Voltar pra Fase 1, reclassificar cada issue listada num motivo de verdade (rodando as 4 checagens do #5383/#5392 acima se o que está por trás é uma leitura de bloqueio não verificada), regravar o `plan.json`, então rodar de novo até `exit 0`.

**Gate de cobertura do `target_set` (#5718), logo em seguida:** rodar `npx tsx scripts/check-develop-target-set-coverage.ts --plan data/develop/{AAMMDD}/plan.json`. `exit 1` → pelo menos uma issue de `goal.target_set` chegou até aqui sem entrada em `issues[]` (ou com entrada sem `status`) — foi triada, fazia parte do escopo da sessão, e nunca recebeu nenhuma tentativa de dispatch. Pra cada número listado: adicionar `{ number, status: "nao-tentada" }` a `issues[]` — backfill mecânico, sem julgamento (não é reclassificar a issue, é só registrar que esta sessão não a tocou), regravar o `plan.json`, rodar de novo até `exit 0`. **Se alguma dessas issues chegou a ser reivindicada** (`claim-issue` rodou numa onda anterior a este backfill — caso raro, mas possível quando o dispatch falhou logo após a claim), soltar com `unclaim-issue --kind develop --issue {N}` antes de seguir (#6317) — `status: "nao-tentada"` e uma claim ativa da própria sessão contam a mesma história contraditória que `deixado-para-o-300` conta (ver Filtro do servidor 300 acima). Este gate cobre issue conhecida que nunca foi tentada ("tentei e travei" ≠ "nunca tentei").

**Gate de cobertura do `exec_track_painel` (#5907 item a), logo em seguida:** rodar `npx tsx scripts/check-develop-exec-track-coverage.ts --plan data/develop/{AAMMDD}/plan.json`. `exit 1` → dois modos de falha: (1) entrada(s) de `issues[]` sem `exec_track_painel` — o passo 6a da Fase 0 não rodou pra ela; (2) valor gravado fora do enum de 5 tracks (`overnight|develop|agendada|bloqueada|fora-de-rodada`) — typo vira classificação que nenhum consumidor (`findDeixadoPara300Buraco` #5914, painel de Triagem #5462) reconhece. Pra cada número listado: rodar `classifyExecTrack` e gravar o campo — backfill mecânico, sem julgamento (o módulo é puro), regravar o `plan.json`, rodar de novo até `exit 0`. Complementa o gate do gap (b) (#5914), que recusa `deixado-para-o-300` em track develop/bloqueada QUANDO o campo existe.

**Gate de drift de label de decisão (#5892), logo em seguida:** rodar `npx tsx scripts/check-decision-label-drift-gate.ts --plan data/develop/{AAMMDD}/plan.json`. Mesmo script do overnight — detecta drift entre a prosa da sessão e as labels estruturais atuais (racional completo, incluindo as duas fontes de prosa do #5955 e o procedimento de resolução: `context/overnight-dispatch-rules.md` item 25). `exit 0` (nenhum drift) → seguir pro relatório. `exit 1` (drift detectado) → aplicar as labels estruturais faltantes reportadas (procedimento no item 25 citado acima) antes de continuar — o relatório NÃO compila enquanto houver achados não resolvidos.

**Lint de prosa de dependência sem marcador (#7137 item 4), logo em seguida — AUDITORIA, nunca bloqueia (diferente do gate acima).** Rodar `npx tsx scripts/check-dependency-prose-lint.ts --repos all` (#10901: todos de `issue_repos`; item 26 de `context/overnight-coordinator-rules.md`). Reporta prosa de dependência sem o marcador `<!-- depends-on: #N -->` e sai **sempre `exit 0`**: os achados entram como linha no relatório, nunca travam a compilação.

**Gate de surfacing ao vivo de bloqueios tipo-editor (#5919), logo em seguida:** rodar `npx tsx scripts/check-surfaced-live.ts --plan data/develop/{AAMMDD}/plan.json`. Confere que TODA entrada de `issues[]` com `what_unblocks` preenchido tem o campo `surfaced_live: boolean` explícito (`true` = surfaceado ao vivo no formato do #5727; `false` = não surfaceado, vira item obrigatório do HANDOFF). `exit 1` (campo ausente/tipo errado) → surfacear ao vivo AGORA cada bloqueio listado que ainda tenha editor alcançável, preencher `surfaced_live` (+ `surfaced_live_at`) em TODAS as entradas listadas, regravar o `plan.json`, rodar de novo até `exit 0`. Os `false` explícitos passam (fallback de ausência é legítimo) mas saem em warning — cada um DEVE aparecer na Seção de HANDOFF. Sem rede nenhuma envolvida: plan.json ausente/ilegível é erro duro (`exit 2`), sinal de sessão malformada, não fail-soft.

**Gate de SAÍDA do track Develop (#6271), logo em seguida:** rodar `npx tsx scripts/check-develop-label-cleared.ts --plan data/develop/{AAMMDD}/plan.json`.

**O problema que ele fecha: Develop é um sink** — issue entra no track e não sai sem ação explícita. (histórico: docs/rodadas-autonomas-historico.md#dev-6271)

`exit 1` → para cada issue listada, responder **"a razão que a trouxe pro Develop ainda existe?"**:
- **não existe mais** → `npx tsx scripts/route-issue.ts --triaged-at "{triaged_at}" --issue N --track {overnight|bloqueada} --reason "..."` (`overnight` quando o resto é trabalho comum; `bloqueada` quando passou a depender de outra issue);
- **ainda existe** (ex: parte 1 mergeada, parte 2 segue exigindo Chrome logado) → gravar o porquê em `develop_track_justificado` na entrada da issue no `plan.json`. Mesma disciplina de `unblock_evidence`/`ja_resolvida_evidencia`: o motivo é aceito, mas precisa estar escrito — **o que o gate recusa é o silêncio, não a permanência.**

Só entram na checagem issues que ESTA sessão **terminou de trabalhar** (`mergeada`, `entregue-fora-de-codigo`, ou `pulada` motivo `ja-resolvida-antes-da-sessao`). Issue `nao-tentada` ou `deixado-para-o-300` **nunca é acusada** — ela continua sendo fila legítima do Develop. O gate **não decide o track de destino**: ele detecta o resíduo e para; qual é o track verdadeiro é julgamento da sessão, registrado via `route-issue` (mesmo princípio do #5373 — julgamento feito uma vez por quem tem contexto, gravado, nunca re-derivado por heurística).

Sem `gh`/rede, **dois casos distintos** (#738): se TODAS as buscas falharem, o gate não rodou e a saída diz isso explicitamente — não é veredito de "sem resíduo"; se apenas ALGUMAS falharem, o gate roda sobre cobertura PARCIAL, e a linha de veredito carrega a ressalva com a contagem das não consultadas. Nos dois casos `exit 0` (fail-soft), mas nunca um "ok" que esconde o que não foi checado. `plan.json` ausente/ilegível é erro duro (`exit 2`), como o gate acima.

**Gate de bloqueio caducado (#6259), logo em seguida:** rodar `npx tsx scripts/check-block-staleness.ts --plan data/develop/{AAMMDD}/plan.json` — mesmo script do overnight. Cobre a mesma lacuna: um `status: pulada` com motivo `pr-em-voo`/`claimed-por-outra-sessao`/`bloqueio-execucao` pode ter caducado (PR mergeado/fechado, claim de outra sessão liberado, label removida) sem que nenhuma issue nova tenha aparecido — os gates de convergência acima (#5476/#5706) não cobrem essa transição. Motivos do vocabulário fechado do develop (`nao-destravavel-na-sessao`, `decisao-adiada`, `ja-resolvida-antes-da-sessao`) não são tocados por este gate — só os 3 motivos citados, que também aparecem em sessões develop que herdaram triagem do overnight (passo 2 da Fase 0). `exit 0` → seguir. `exit 1` (lista de issues com bloqueio caducado) → reavaliar dispatch pra cada uma (Gate 1) antes de fechar o relatório. Sem `gh`/`session-registry`, degrada sozinho pra fail-soft (#738).

**Abrir sempre com o status do Goal (#4297/#4319)**, antes de qualquer outra linha: `Goal (escopo: {descrição do escopo efetivo}, política: {exhaust_all|blocked_only}): atingido` ou `não atingido`. Escopo efetivo = `--issues`/`--only`/`--bugs`/`--priority` da invocação, resumidos (ex: `--bugs --priority P0,P1`; `nenhum filtro` se a sessão rodou sem flags de escopo). Com `goal.policy: "table_only"`, a linha vira `Goal: não avaliado (goal_policy=table_only)` — não é "não atingido", é fora de escopo por opção do editor no briefing. Com `--no-implement` ativo, a linha vira `Goal: não avaliado (--no-implement ativo)` pelo mesmo motivo (ver "Incompatibilidade estrutural com `--no-implement`").

Quando não atingido, listar o resíduo **por tier**: `1a: N issues` / `1b: N` / `2: N` / `3: N (gate: auto_entered|editor_interrupted|coordinator_self_limited — ver goal.tier3_gate)`, e dentro de cada tier o motivo POR ISSUE de não ter chegado a terminal (bloqueio cat. B ainda sem conta de terceiro, token cat. A não colado, "grupo 3 não entrou nesta sessão" quando o editor interrompeu com `editor_interrupted`, ou a sessão parou por limite técnico próprio com `coordinator_self_limited` — consultado no registro por-issue do `plan.json`, `goal.remaining` guarda só os números). É o resíduo que a Seção de HANDOFF abaixo também referencia.

**Cadeia de findings (#4319, substitui o cap de profundidade como sinal):** reportar quantos findings a sessão gerou na Fase 1.5, quantos ela mesma consumiu (voltaram pra fila via re-checagem entre ondas e foram trabalhados na mesma sessão), e `goal.findings_depth` final — é o que permite ao editor perceber "esta sessão passou N ciclos se auto-alimentando" sem que nada a tenha interrompido mecanicamente. Junto, reportar `goal.rescans_done` (quantas re-checagens/re-varreduras a sessão fez) — ambos são contadores de observabilidade agora, não motivo de a sessão ter parado.

Com `--bugs` (#3375) ativo, abrir o digest com `Modo: --bugs (só issues com label bug)`. Com `--priority` (#3499) ativo, adicionar (ou combinar na mesma linha, se `--bugs` também ativo) `Modo: --priority {lista} (só issues com label de prioridade ∈ {lista})` — inclui a contagem de issues excluídas por não baterem a prioridade. Digest de `plan.json` + run-log (filtrado por `agent: "develop"` + AAMMDD) em 5 buckets: (a) destravadas e mergeadas (agrupadas por onda); (b) destravadas mas pendentes (`--no-implement` ou CI vermelho — **prontas p/ o próximo overnight pegar como `elegivel`**); (c) não-destraváveis na sessão; (d) findings/hotfixes; (e) não alcançadas nesta sessão (#5718). **(c) e (e) NUNCA compartilham seção — são afirmações diferentes ao editor.** (c) = `status: pulada` — a sessão TENTOU destravar (Gate 1 rodou, o coordenador diagnosticou, há evidência/comentário do que falta) e não conseguiu; cada item vem com o `motivo` (`nao-destravavel-na-sessao`/`decisao-adiada`/`claimed-por-outra-sessao`/`ja-resolvida-antes-da-sessao`). As `fechada-durante-a-sessao` (#12105) saem numa sub-lista própria de (c), "fechadas por outra sessão durante a rodada", com a `fechada_evidencia` de cada uma: a sessão não tentou destravá-las, outra resolveu antes. (e) = `status: nao-tentada` — a sessão **nunca chegou** a essa issue (tempo, incidente numa outra unidade que serializou a rodada, etc.); listar sem fingir que houve diagnóstico, e citar o motivo real quando conhecido. **Seção de HANDOFF:** quais issues saíram de bloqueada→elegível (label removido + decisão postada) e quais ações fora da sessão o editor ainda precisa agendar. **Linha de coordenador (#3454/#8941):** `Coordenador: claude-opus-5-5 / medium` (valores CONFIGURADOS no frontmatter, ver evento `coordinator_model` da Fase 0); se algum `stall`/intervenção do editor mid-sessão sugerir reversão, anotar a ressalva na mesma linha.

**Seção "Custo em tokens" (#4815) — MANDATÓRIA, nunca omitida** (histórico: docs/rodadas-autonomas-historico.md#dev-4815). Esta seção **sempre** entra no relatório da sessão, com as 3 categorias sempre presentes — cada uma escreve `unavailable` explicitamente quando o dado não existe, nunca omite a linha/tabela (ausência silenciosa é indistinguível de "esqueci"). **Antes de montar as categorias, rodar o emissor — é o ÚNICO ponto da sessão em que ele roda (#10476/#10483: só aqui nada está em voo)** — e depois a mesma checagem do overnight, em dois comandos standalone; se o emissor reportar subagente "em voo", esperar terminar e rodar de novo:
```bash
npx tsx scripts/subagent-usage-metrics.ts --edition {AAMMDD} --agent develop
```
```bash
npx tsx scripts/check-overnight-token-instrumentation.ts --edition {AAMMDD} --plan data/develop/{AAMMDD}/plan.json
```
`--plan` (#11164) restringe a contagem aos eventos desta sessão (`session_id` da raiz do `plan.json`, gravado pelos dois emissores) — sem ele, outra rodada que grave a mesma edição no mesmo dia faz a checagem dizer "OK" para uma sessão que não emitiu nada. Se o plano estiver em path sufixado (`derived-after-collision`), passar esse path.
1. **Implementação** — tabela `unidade | subagent_tokens | tool_uses | duração` a partir dos eventos `subagent_metrics` (um por invocação de `Agent`, ver Fase 1 passo 5) + total da sessão. Sessão sem nenhuma unidade despachada (ex: `--dry-run`, `--no-implement`) → tabela com a nota "nenhuma unidade".
2. **Fleet review pré-merge** — tabela SEPARADA da anterior (`unidade | fleet_tokens | tool_uses`, a partir dos eventos `fleet_review_metrics`, ver Gates "REVIEW DE FLEET PRÉ-MERGE") + total. A separação em relação à Implementação é o que torna visível o rateio entre as duas categorias (#4815 item 2) — nunca agregar as duas na mesma linha/tabela.
3. **Coordenador** — linha `Coordenador (tokens estimados): ~N (fonte: {harness_usage | context_size_proxy})` a partir de `coordinator_tokens_estimate`; se todos os eventos dessa categoria vierem `unavailable` (ou não existirem na sessão), a linha vira `Coordenador (tokens): unavailable` — nunca omitida.

**Razão adição:remoção (#7113) — mesma proeminência das issues destravadas/mergeadas acima.** Rodar `npx tsx scripts/measure-round-diff-stats.ts --base {commit-base da sessão} --session-kind develop --own-shas {SHAs mergeados pela sessão, separados por vírgula}` (#13606: sem a flag, `base..origin/master` soma os merges de sessões concorrentes, como o overnight do `300`; lista vazia `--own-shas ""` = sessão sem merge = diff zero). Os SHAs saem das PRs do `plan.json` com `timeline.merged` preenchido: `gh pr view {pr} --json mergeCommit -q .mergeCommit.oid`; PR que saiu no trem fica fechada sem `mergeCommit`, e o SHA é o do commit `trem(#6300): lote ... #{pr}` em `git log {commit-base}..origin/master --format='%H %s'` (persiste em `data/run-log.jsonl`), depois `npx tsx scripts/round-diff-stats-report.ts --check-alarm` — colar a tabela `janela | rodadas | adições | remoções | razão | líquido/dia` (7d/30d/90d) impressa no digest. `--check-alarm` reconcilia sozinho uma issue de alarme (via `scripts/lib/alarm-issues.ts`) se a razão de 7d cruzar o limiar — nada a decidir aqui além de colar o output.

Timeline via `npx tsx scripts/render-overnight-timeline.ts --plan data/develop/{AAMMDD}/plan.json --title "Timeline da sessão" --total-label "Total da sessão"`.

Salvar o digest completo em `data/develop/{AAMMDD}/report.md` (mesma convenção do overnight, `data/overnight/{AAMMDD}/report.md`). **Registrar na superfície de Relatórios do Studio (#3714, decisão do editor 260720 — substitui o antigo draft de Gmail, não soma a ele):**
```bash
npx tsx scripts/register-report.ts --kind develop --id {AAMMDD} \
  --title "diar.ia.br develop {AAMMDD} — {U} unidades, {N} issues destravadas/mergeadas" \
  --html-path data/develop/{AAMMDD}/report.md
```
File-based (grava em `data/reports/index.jsonl`) — nunca depende do `npm run studio` estar no ar; o comando imprime a URL em stdout, capturar pro resumo do terminal. **O comando não manda e-mail (#7960, item 4 da #7957)** — `--no-email` é aceita por compat (no-op); o relatório develop é "Studio /relatorios, sem e-mail" na tabela de severidade do editor. **Não criar draft via `create_draft` aqui.** **Preceda a tabela de unidades do relatório com o marcador literal `<!-- unidades-mergeadas -->` (#5521)** — com ele, o número de unidades no título (`"N unidades"`/`"N PRs"`) tem que bater com as linhas da tabela e o de issues (`"N issues"`) com as issues distintas que elas cobrem; divergência sai `exit 1` sem registrar nada, e o comando imprime o sufixo correto. Sem o marcador o comando avisa em stderr que a conferência não rodou. Único ponto não fail-soft do comando, de propósito (o título vira assunto de e-mail, que não tem desfazer); rationale completo no passo equivalente de `.claude/skills/diaria-overnight/SKILL.md`. Canal primário = terminal, incluindo a linha `Relatório: {URL do Studio}`; fail-soft #738 — falha da gravação em disco (rara) nunca trava a sessão, só avisa que o relatório ficou local; o e-mail é best-effort separado, não coberto por essa garantia.

**Check de SAÍDA (#6168 Parte C, ponto 3), antes de encerrar o registro:** rodar `npx tsx scripts/lib/session-registry.ts conflicts --branch {branch atual}` uma última vez e conferir o próprio registro — cobre registro não encerrado (`end` só é chamado nesta Fase 2, então qualquer parada fora dela deixa o registro órfão) e trabalho sem commit no checkout compartilhado (histórico: docs/rodadas-autonomas-historico.md#dev-6168). Antes do `end`: `git status --porcelain` limpo? (sujo → commitar, stashar ou mover pra fora do repo — **nunca** encerrar deixando trabalho não commitado em `master` num checkout compartilhado); toda issue com PR mergeada já saiu de `claimed_issues`? `conflicts` acusando `branch-drift` (a branch registrada não é mais a do checkout) → outra sessão trocou o checkout embaixo, checar antes de encerrar. Registrar o resultado no relatório.

**Limpeza de worktrees mergeados (#4335, follow-up do #4326):** por último, depois do relatório salvo/registrado, **soltar no GitHub as claims da sessão** (`npx tsx scripts/check-pre-dispatch-claim.ts --issues {todas as issues reivindicadas na sessão} --session-id {id} --release`, standalone; idempotente, só grava onde a claim desta sessão segue ativa, #13172), **depois encerrar o registro desta sessão** (`npx tsx scripts/lib/session-registry.ts end --kind develop`, `--session-id` auto-injetado — #5156, senão esta própria sessão aparece como "outra sessão ativa" pro guard abaixo) e só então rodar `npx tsx scripts/cleanup-merged-worktrees.ts` — varre `.claude/worktrees/` (worktrees concorrentes desta sessão + sobras de rodadas anteriores), confirma via `gh pr list --head {branch} --state merged` quais branches já foram mergeadas e remove (`git worktree remove --force`) só essas. **FAIL-SOFT**: o script já nunca lança nem sai não-zero por falha de `gh`/permissão; mesmo assim, tratar qualquer stderr como warning — nunca travar o encerramento da sessão por causa desta limpeza. **Guard de sessão compartilhada embutido no próprio script (#5156 item 9):** ele consulta `session-registry.ts` e PULA a varredura inteira, sozinho, se detectar qualquer outra sessão ainda ativa nesta máquina (ex: um overnight que começou depois desta sessão develop) — não insistir com `--confirm-shared` sem certeza de que não há colisão. **Logo depois, a triagem dos preservados (#12374, ligada no #12394):** rodar `npx tsx scripts/triage-preserved-worktrees.ts` (relatório somente leitura dos worktrees que o cleanup preservou por arquivo sujo ou commit não enviado, com veredito `descartavel`/`manter` e o motivo), anexar a tabela ao fim do `report.md` da sessão (seção `## Worktrees preservados`) e mostrá-la ao editor no resumo final. O descarte com resgate (`--discard`, opcionalmente `--only nome1,nome2`) só roda se o editor pedir nesta sessão. Fail-soft como o cleanup: falha vira aviso, nunca trava o encerramento. **Em seguida, republicar a contagem (#8495 — call site de FECHAMENTO, obrigatório, par do call site de abertura na Fase 1):** rodar `npx tsx scripts/lib/session-registry.ts heartbeat --kind develop --active-worktrees {N}` com `{N}` já refletindo os worktrees removidos por `cleanup-merged-worktrees.ts` acima — nesta skill o cleanup roda em LOTE no fim da sessão (não por PR individual como no overnight), então este é o ponto real onde o número de worktrees vivos desta sessão muda de verdade. **Standalone**, mesma disciplina de injeção do call site de abertura. **Este heartbeat roda DEPOIS do `end` e é no-op por desenho (#11059):** `heartbeat` recusa auto-registrar sessão que já tem evento `ended` no log de lifecycle (imprime `heartbeat no-op (sessão já encerrada...)`, exit 0). Não reordenar `end` para depois do cleanup: o guard do `cleanup-merged-worktrees.ts` precisa que esta sessão já esteja encerrada.

## Guard de colisão editorial — aviso interativo, sem auto-preempt

Ao detectar edição em curso (`scripts/lib/find-current-edition.ts` retorna candidato ou `data/editions/` de hoje/amanhã ganhou arquivos novos), a skill **avisa o editor e pergunta** ("uma edição de hoje/amanhã está em curso — encerrar a sessão develop para liberar a pipeline editorial? s/n"). **Diferente do overnight, develop NÃO grava `preempted_*` nem auto-encerra** — como é supervisionado e nunca continua sem editor, a decisão é humana ao vivo. Se o editor não responde, o `AskUserQuestion` fica bloqueante, `resume_state` é gravado e a sessão para limpa.

## `plan.json` (`data/develop/{AAMMDD}/`, gitignored)

Reusa o schema do overnight (**inclusive `started_at` — ISO 8601 real capturado no passo 1, nunca a string `{AAMMDD}`, #3841**) + campos próprios de desbloqueio: `block_category` (A–E), `block_label` (literal real), `what_unblocks`, `unblock_status` (`pendente`|`desbloqueada-validada`|`nao-destravavel-na-sessao`), `unblock_evidence` (dry-run exit 0 / comentário #link / probe API ok — **NUNCA o valor do secret**), `editor_input_received` (bool/hash, nunca o secret), `source` (`inherited-overnight`|`fresh-scan`|`manual-issues-arg`), `wave` (id da onda paralela), `fora_de_codigo_evidencia`/`fora_de_codigo_fechamento` (#5441 — só presentes quando `status: "entregue-fora-de-codigo"`, ver subseção "Unidade concluída sem gerar PR"), `fleet_review` (#4383 — `"done"` | `"skipped: {motivo}"`, gravado pelo coordenador ao concluir o passo "REVIEW DE FLEET PRÉ-MERGE" da seção Gates, por unidade; ausente em `plan.json` de sessão anterior a #4383), `develop_track_justificado` (#6271 — string não-vazia explicando por que a issue SEGUE classificando `develop` mesmo com o trabalho desta sessão encerrado, ex: "parte 1 mergeada; parte 2 segue exigindo Chrome logado". Só necessário quando o gate de saída do track acusa; ausente é o caso normal. Mesma disciplina de `unblock_evidence`/`ja_resolvida_evidencia`: o motivo é aceito, mas precisa estar escrito — `scripts/check-develop-label-cleared.ts` recusa string vazia ou só-espaço, que seria silêncio disfarçado). **Políticas de sessão do briefing front-loaded (#2966):** `attack_order` (resolvida — default `so_destravaveis_agora` sem pergunta, ou override via `--attack-order`/pedido mid-sessão, #4498), `wave_policy` (`auto`|`per_wave`, default `auto`), `catD_preauth` (`show_each`|`preapproved`, default `show_each`) — gravadas na Fase 0.5 e relidas em todas as fases; nunca re-perguntadas em resume. **Regra crítica de resume:** nunca re-perguntar um desbloqueio já validado (`unblock_status: desbloqueada-validada` + `status: pendente` → retomar direto na implementação) nem uma política já escolhida. **Segurança:** o plan.json nunca armazena o valor de um token. Develop **não** grava `preempted_*`.

**`goal` (#4297, expandido em #4319), objeto no nível raiz:**
```json
"goal": {
  "policy": "exhaust_all",
  "tiers": { "1a": [4309, 4310], "1b": [], "2": [4295], "3": [4252, 4275] },
  "current_tier": "1a",
  "target_set": [4309, 4310, 4295, 4252, 4275],
  "remaining": [4310, 4295, 4252, 4275],
  "reached": false,
  "rescans_done": 3,
  "findings_depth": 1,
  "tier3_gate": [
    { "asked_at": "2026-07-29T20:10:03Z", "decision": "auto_entered", "selected": null }
  ],
  "last_convergence_scan": { "at": "2026-08-19T20:05:00Z", "novas_encontradas": 0 }
}
```
Exemplo: sessão já esgotou o grupo 3 uma vez (o único disparo registrado em `tier3_gate`, decisão `auto_entered` — default desde #5321); um bug novo apareceu depois numa re-checagem e reabriu o tier `1a` — por isso `current_tier` voltou pra `"1a"` mesmo já tendo passado pelo grupo 3 (regra de reabertura da seção "Re-varredura sem cap"). Se a sessão retornar ao grupo 3 depois de esgotar esse `1a` reaberto, é um disparo **novo**, que vira um segundo item no array `tier3_gate`. `last_convergence_scan` (#5706) é gravado pelo gate da Fase 2 (ver "Gate de re-triagem pendente + convergência" acima) a cada varredura bem-sucedida — timestamp + quantas issues novas a varredura achou naquela chamada; ausente até a primeira invocação do gate rodar.

`policy` ∈ `exhaust_all` (default, #4319) | `blocked_only` (escopo original #2636/#4297) | `table_only` = `goal_policy` do briefing, copiado aqui pra não precisar re-ler a Fase 0.5 — **transiente `null`** entre a escrita inicial da Fase 0 passo 9 e o preenchimento da Fase 0.5 (ou direto `table_only` se `--no-implement`); nenhuma fase entre esses dois pontos lê `goal.policy`, então o `null` nunca é observado por lógica que dependa dele.

**Migração de legado (#4319):** `policy: "exhaust"` lê-se como **`blocked_only`**, nunca como `exhaust_all`. Um `plan.json` legado também não tem `tiers`/`current_tier`/`tier3_gate` — tratar como ausentes, sem reconstruir retroativamente. **`current_tier` ausente num resume não vira `"1a"` por default** — `target_set`/`remaining` já gravados viram uma fila única sem partição por tier, e a Fase 1 passo 6 (avanço entre tiers) não roda.

`tiers` = a partição do backlog aberto em 4 ondas (Fase 0 passo 6), recalculada a cada re-checagem entre ondas (Fase 1 passo 6) — issue nova pode entrar num tier já esgotado, e nesse caso `current_tier` **volta** pra ele (não gera livelock: status terminal nunca é re-escolhido). `current_tier` = onda que a Fase 1 está trabalhando agora (`1a`|`1b`|`2`|`3`) — só existe (é gravado) com `policy: "exhaust_all"` ou `"blocked_only"` (nesta, só assume `1a`/`1b`); com `policy: "table_only"` o campo **nunca é gravado**, fica ausente a sessão inteira (mesmo tratamento explícito-vazio que `target_set`/`remaining` já recebem nessa política — ver Fase 1). `target_set` = união das issues nos tiers relevantes pra política escolhida (as 4 ondas com `exhaust_all`; só a fatia bloqueada de `1a` + `1b` com `blocked_only`), populado assim que a Fase 0.5 souber a política — **imutável durante a sessão exceto por re-scan** (novatas aceitas numa re-checagem são adicionadas tanto a `target_set` quanto a `remaining`, e ao `tiers` correspondente; issue que sai de aberto — fechada fora da sessão, manualmente ou por outra sessão concorrente, ver risco de sessões paralelas no CLAUDE.md — é removida de `target_set`/`remaining`/`tiers` no próximo ciclo de re-checagem, mesmo sem nunca ter atingido um dos 5 status terminais locais). `remaining` = `target_set` menos as issues que já atingiram status terminal (`mergeada`, `draft-ci-vermelho`, `pulada` motivo `nao-destravavel-na-sessao`, `decisao-adiada` ou `deixado-para-o-300` (#5751), `entregue-fora-de-codigo`) — recalculado a cada atualização de status (mesmo ponto do passo 5 da Fase 1). `reached` = `remaining.length === 0`, só relevante quando `policy` ∈ `{exhaust_all, blocked_only}`.

`rescans_done` e `findings_depth` = **contadores puros de observabilidade no develop desde #4319** (sem cap, nenhuma lógica de parada lê o valor) — `rescans_done` incrementa a cada ciclo de re-checagem entre ondas ou re-varredura de convergência; `findings_depth` incrementa a cada finding gerado pela própria sessão que ela mesma consome. Reportados na Fase 2, não usados pra decidir nada durante a sessão. Com `policy: "table_only"`, `reached` fica `false` e ambos os contadores ficam `0` pela sessão inteira — não são avaliados, só presentes pra manter o schema estável.

`tier3_gate` = **array de disparos** do checkpoint antes do grupo 3 (seção própria, revisado #5321 — deixou de ser um gate obrigatório) — não um objeto único sobrescrito, porque pode disparar mais de uma vez na mesma sessão (fila volta pro grupo 1a, esgota de novo, retorna ao grupo 3 — cada retorno é uma reentrada, e pode registrar decisão diferente da vez anterior). Cada item: `asked_at` (timestamp ISO do disparo — nome do campo preservado por compat, o banner não é uma pergunta), `decision` ∈ `auto_entered` (default — ninguém interveio) | `editor_interrupted` (editor pediu pra pular/escolher subconjunto antes do tier abrir **por iniciativa própria dele** — nunca uma decisão do coordenador) | `coordinator_self_limited` (#5439 — o COORDENADOR decide encerrar a sessão antes do goal por um motivo próprio, ex: token budget real esgotado, tempo de execução real do harness; SEM pedido/intervenção do editor. Distinção que importa: `editor_interrupted` registra uma AÇÃO do editor; `coordinator_self_limited` registra uma decisão do coordenador sozinho — "escopo já muito extenso"/contagem de PRs/tempo decorrido/tamanho de refactor **não é** motivo válido pra nenhum dos dois em `exhaust_all`, é motivo pra continuar trabalhando; só vira `coordinator_self_limited` quando o limite é técnico e real, nunca uma leitura subjetiva de "já fiz bastante") | `entrar`|`parar`|`escolher`|`sem-resposta` (valores legados, `plan.json` gravado por sessão anterior ao #5321 — ler `entrar` como `auto_entered`, `parar`/`escolher`/`sem-resposta` como `editor_interrupted`), `selected` (array de números escolhidos quando o editor restringiu o subconjunto, `null` nos demais casos, incluindo sempre em `coordinator_self_limited`). Array vazio (`[]`) até o primeiro disparo. Um item já registrado **não** é re-disparado dentro do mesmo ciclo em resume (reler o último item do array) — mas uma nova entrada no grupo 3 depois de uma volta a tier anterior é um disparo novo, que vira um item novo no array, não um resume do anterior.

**`machine_id` (#3033).** Ao criar/gravar `plan.json` (Fase 0 passo 9, e todo re-write subsequente), incluir o campo `machine_id` no nível raiz com o output de `npx tsx scripts/lib/machine-id.ts` (hostname desta máquina). Sem esse campo, a statusLine de outra máquina no mesmo OneDrive pode confundir o progresso desta sessão com o dela (`isForeignDevelopPlan` em `scripts/overnight-statusline.ts` filtra por esse campo; ausente = tratado como legado, não filtrado). Gravar 1x por sessão é suficiente (hostname não muda no meio de uma sessão) — não precisa reconsultar a cada write, mas preservar o campo em todo re-write do arquivo.

**`session_id` (#5156 item 11, #6265).** Discriminador PRIMÁRIO de `isForeignDevelopPlan` (`scripts/overnight-statusline.ts`) quando presente (distingue duas sessões develop na MESMA máquina); a Fase 0 passo 9 grava a partir do primeiro write, e é o mesmo campo que `scripts/resolve-develop-plan-path.ts` usa pra decidir "este plano é meu?". `plan.json` legado sem o campo cai no filtro por `machine_id`. (histórico: docs/rodadas-autonomas-historico.md#dev-6265)

## Fronteira com o overnight nas ambíguas (cat C)

**Fronteira revertida (#7493, decisão do editor 05/09/2026).** O `/diaria-overnight` voltou a levar as ambíguas de trade-off-real ao **seu próprio briefing** (Fase 0 passo 5), em vez de bounceá-las pra cá — a label `trade-off-real` classifica `overnight`, não `develop`. As DUAS famílias de ambiguidade (trivial-mas-não-documentada e trade-off real de produto/editorial) são hoje perguntas do mesmo briefing.

(histórico: docs/rodadas-autonomas-historico.md#dev-7493)

**O que sobra pro develop nas ambíguas:** a **cat. C continua existindo** como categoria de trabalho (ver a tabela A–E) — o que mudou é a via de ENTRADA. Uma issue não chega mais aqui *por carregar a label* `trade-off-real`; ela chega quando o editor a traz nesta sessão, quando a decisão exige também algo que só o develop faz (`windows`, `develop-track` — essas duas vencem `trade-off-real` na precedência de `classifyExecTrack`), ou quando o `/diaria-desbloqueia` a encaminha. Quando uma cat. C for de fato decidida aqui, o fechamento é o mesmo de sempre: comentário durável + remoção da label + `check-trade-off-label-cleared.ts`.

## Labels de máquina — `windows` / `server` (#5462 aposentou `local`)

**Não aplicar `local` a issue nova** (aposentada, #5462). `classifyExecTrack` (`scripts/lib/issue-exec-track.ts`) a **ignora**: uma issue marcada só com `local` cai no default `overnight`, não em `develop`. Aplicá-la hoje produz roteamento silenciosamente errado.

**Qual usar:**
- **`windows`** — exige a máquina Windows do editor: Chrome logado, ComfyUI, ou qualquer coisa que só existe lá. Classifica como **Develop** (o overnight roda no servidor Linux e não alcança).
- **`server`** — exige o servidor Linux 24/7: systemd, tarefas agendadas, Studio, OneDrive. **Não** tira do overnight — é exatamente a máquina onde ele já roda.
- **`external-blocker`** — não é máquina nenhuma: precisa de ação do editor numa conta de terceiro (allowlist, credencial, cadastro). Classifica como **Bloqueada**.

`/diaria-develop` roda por natureza com o editor presente, então issue `windows` é elegível aqui — é justamente o que o develop pega e o overnight não. `scripts/lib/exec-mode.ts` **não** decide isso: ele responde "esta sessão tem `data/`?", que no servidor Linux dá `local` inclusive pra uma issue que exige o Windows.

## Regras

- **Perguntar ao editor é permitido e central** (inverte a Regra 1 do overnight) — mas via os gates definidos; a sessão pressupõe editor presente e **nunca continua autônoma sem ele**.
- **Nunca** disparar a pipeline editorial ao vivo (mesmo guard do overnight) — **única exceção controlada:** `publish-*.ts --dry-run` p/ validar token recém-colado (cat. A), rodado pelo coordenador top-level, **nunca** pelo subagente implementador.
- **Nunca persistir segredo no repo:** credencial só em `.env`; o subagente recebe referência ao env var, **nunca o valor**.
- #633 (teste de regressão em bugfix) e validação determinística de estado externo (#573) valem a sessão inteira.
- Paralelização preserva o invariante de não-colisão do #636; cat. D sempre solo + Gate B.
- Toda issue **trabalhada ou bloqueada** recebe comentário com o que foi feito / o que falta (com dedup).
- `data/develop/` segue o blanket gitignore de `data/`.
- Stall passivo é inaceitável (#738): toda espera de CI usa `gh pr checks --watch` em background; timeout de CI = 30 min → tratar como CI vermelho. **Usar `scripts/lib/wait-pr-checks.sh {N} --agent develop --edition {AAMMDD}`, nunca um laço escrito à mão** (as duas flags atribuem o heartbeat `ci_wait_running` a esta rodada; sem elas o helper espera sem gravá-lo, #13744) (bloqueado mecanicamente pelo hook `block-handwritten-pr-checks-loop.mjs`, #9161, #6921) — o helper já embute os 30min desta regra no próprio processo (até 60 min enquanto houver check em execução no HEAD vigente, #13685: o job `test` leva 35-45 min; o exit 1 do helper é o timeout desta regra). Exit 7 do helper = FILA de runner do GitHub sem falha (#10578) — reaguardar, não é CI vermelho. **Teto de reaguardos por FILA (#10671): no máximo 3 reaguardos consecutivos por PR** (contador por PR, zera quando o helper sai com qualquer código diferente de 7; persistido em `plan.json` via `npx tsx scripts/lib/ci-queue-reawait.ts --plan data/develop/{AAMMDD}/plan.json --pr {N} --exit {rc}` após cada saída do helper, standalone — seguir o `action` do JSON, `give-up`/exit 3 = desistir, #10699); exit 7 de novo depois do 3º reaguardo → emitir `ci_timeout` com `"last_status": "queued"`, converter a PR em draft sem fixer (fila não é defeito do diff), registrar como `draft-ci-vermelho` com motivo `fila-github-actions`, comentar na issue e seguir — nunca reaguardar indefinidamente.
- **Ação do coordenador que muda elegibilidade de issue já conhecida da sessão vira pendência de re-triagem (#5476, mesmo mecanismo do overnight).** Aplicar `gh issue edit N --add-label {not-this-week|trade-off-real|external-blocker|...}` <!-- route-issue-exempt: define o GATILHO da regra #5476, não instrui rodar o comando --> fora do fluxo normal de decisão do Gate 1 (ex: reconciliação ad-hoc de labels da Triagem), ou encerrar/remover manualmente uma claim de `session-registry` mid-sessão, exige registrar: `npx tsx scripts/check-state-changed-pending.ts --add-pending {N} --plan data/develop/{AAMMDD}/plan.json`. Antes de escrever o relatório da Fase 2, checar `npx tsx scripts/check-state-changed-pending.ts --plan data/develop/{AAMMDD}/plan.json` — pendência (`exit 1`) → reavaliar dispatch pra essa issue (com o editor, se cair em cat. C) antes de fechar a sessão.

## Paralelismo entre sessões (#5156)

Esta skill e `/diaria-overnight` podem rodar **ao mesmo tempo** — mesma máquina (develop supervisionado numa janela, overnight drenando a fila noturna em outra) ou máquinas diferentes sincronizadas pelo mesmo junction OneDrive `data/`. Nenhuma das duas skills assume mais "sou a única sessão automatizada rodando". Mecanismo e convenção por item da auditoria original (#5156) — espelha a seção equivalente do `diaria-overnight/SKILL.md`, este lado documenta o que é específico do develop:

1. **`AskUserQuestion` negado por um overnight ativo na mesma máquina** — `.claude/hooks/block-askuserquestion-overnight-autonomous.mjs` só bloqueia quando a chamada pertence à MESMA sessão que gravou o marker overnight (`session_id`, injetado por `.claude/hooks/inject-session-id.mjs`); os gates bloqueantes desta skill (Gate 1, Gate de Onda, confirmação de colisão editorial) funcionam normalmente com um overnight autônomo em paralelo. Nenhuma ação desta skill.
2. **Effort do review por PR com overnight ativo** — `isOvernightRoundActive` session-aware em `pr-create-review.mjs`: PRs desta skill resolvem pelo limiar geral de diff (#6393; < 500 linhas → `low`, senão `max`, ver "REVIEW DE FLEET PRÉ-MERGE" na seção Gates) mesmo com overnight ativo em paralelo. (histórico dos itens 1-2, 6 e 11: docs/rodadas-autonomas-historico.md#dev-5156)
3. **Claim de issue entre sessões** — MECANIZADO via `session-registry.ts` (`is-claimed`/`claim-issue`), ver Fase 1 passo 4 acima (checado antes do fan-out, junto do Gate de Onda).
4. **Serialização de merge cross-sessão** — MECANIZADO via `session-registry.ts merge-lock-acquire`/`merge-lock-release`, ver seção Gates ("GATE 2 — IMPLEMENTAÇÃO/MERGE") acima. **Por repo (#10618):** PR de outro repo (ex: vjpixel/diaria-design) usa o lock DELE — `merge-lock-acquire|release|renew --pr N --repo owner/name` (e `--repo` também em `grant-merge`/`self-authorize-merge`); sem `--repo` = diaria-studio. Os dois repos nunca se serializam.
5. **Checkout principal compartilhado** — SEM fix de código razoável além do merge lock do item 4. `git checkout master && git pull` (Fase 0 passo 1, e após cada merge da Fase 1) continuam sem lock próprio — risco residual raro e de baixo blast-radius, mesma nota do `diaria-overnight/SKILL.md`.
6. **Teto de concorrência por sessão** — MECANIZADO (#8495, fecha o #5161 fleet review item 7): read-path (`session-registry.ts list-active` soma `active_worktrees` de outras sessões antes de decidir quantos worktrees abrir nesta onda, ver "Paralelização segura" e Fase 1 passo 4 acima) e write-path (`heartbeat --active-worktrees N`) mecanizados dos dois lados — esta skill agora tem os dois call sites obrigatórios (ao dispatchar o fan-out de cada onda, Fase 1; e após o cleanup em lote de `cleanup-merged-worktrees.ts`, Fase 2), espelhando os do `/diaria-overnight` (#6299). Esta skill decrementa uma vez por LOTE no fim da sessão, porque `cleanup-merged-worktrees.ts` só roda ali (ver Fase 2 acima). Pior caso visível: 16 worktrees (10 do overnight, #10821, + 6); a soma não é travada por código, só exposta pelo `list-active`.
7. **Herança de plano em voo** — MECANIZADO, ver Fase 0 passo 2 acima: `source: "inherited-overnight-in-flight"` quando a rodada overnight de origem ainda está ativa no `session-registry.ts`.
8. **Fase 1.5 revisa diff de sessão alheia** — já é o comportamento esperado ("findings sobre código alheio viram issue, nunca hotfix"), agora formalizado: com paralelismo isso é o CASO COMUM, não exceção — o diff acumulado da Fase 1.5 (e do "REVIEW DE FLEET PRÉ-MERGE" por unidade) pode incluir merges de uma sessão overnight concorrente.
9. **Cleanup de worktree global** — MECANIZADO, embutido no próprio `cleanup-merged-worktrees.ts` (ver Fase 2 acima).
10. **Marker overnight por-máquina vs por-sessão** — não se aplica ao develop (esta skill nunca escreveu/lê o marker do overnight, só o `plan.json` dele — item 7). Ver `diaria-overnight/SKILL.md` pro racional completo da coexistência marker antigo + registro novo.
11. **StatusLine mistura sessões da mesma máquina** — `isForeignDevelopPlan` (`scripts/overnight-statusline.ts`) usa `session_id` como discriminador mais específico que `machine_id`; a Fase 0 passo 9 popula o campo (#6265, ver a nota `session_id (#5156 item 11)` na seção `plan.json` acima).

**Risco aceito, não mecanizado:** item 5 (corrida rara no checkout compartilhado, mitigada pelo merge lock do item 4).
