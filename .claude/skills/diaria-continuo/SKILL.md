---
name: diaria-continuo
description: Sessão CONTÍNUA que nunca termina sozinha (#5293) — derivada do overnight, reusa a mesma maquinaria de implementação, mas troca o critério de terminação. Itens 1-6 da issue de origem implementados (kind dedicado no session-registry, watchdog phase-aware, guard de colisão editorial pausa-não-encerra, rotação diária de plan.json, instrumentação de custo acumulado, notificação Telegram do AskUserQuestion pendente) — ver "Itens 3-6" abaixo pro estado exato de cada um antes de rodar em produção pela 1ª vez. Toda invocação se auto-envolve em `/loop` (#5332) — ver "Como usar". Uso — `/diaria-continuo [--dry-run] [--bugs] [--priority P0,P1,P2,P3]`.
model: sonnet
effort: high
---

# /diaria-continuo

> **Estado (#5293, atualizado 14/08/2026): itens 1-6 implementados.** A
> primeira unidade desta issue entregou só o esqueleto (itens 1-2 — este
> SKILL.md + o kind `"continuo"` em `session-registry.ts`). Esta unidade
> fechou os quatro itens restantes: watchdog phase-aware (distingue "parada
> de propósito" de stall real, e agora vigia `data/continuo/` além de
> `data/overnight/`), o guard de colisão com a edição diária reavaliado pra
> PAUSAR em vez de ENCERRAR, rotação diária de `plan.json`, instrumentação de
> custo acumulado através de dias, e — achado concreto registrado na unidade
> anterior, não parte da lista original de 6 itens — um hook novo que fecha
> a lacuna de notificação do `AskUserQuestion` bloqueante rodando num
> terminal comum (ver "Risco aceito" abaixo). **Ainda assim, esta é a
> primeira vez que a skill roda de ponta a ponta em produção** — nenhuma
> invocação real aconteceu até agora. Ler a seção "Itens 3-6" no fim deste
> arquivo antes da 1ª invocação: cada item lista o mecanismo, o arquivo que
> implementa, e qualquer limitação residual conhecida.

`/diaria-continuo` é uma skill **derivada de `/diaria-overnight`** que
preenche o buraco entre os dois modos existentes: o overnight é autônomo mas
**termina** quando a fila desbloqueada seca; o develop trabalha o backlog
inteiro (incluindo o bloqueado) mas **pressupõe o editor presente o tempo
todo**. Esta skill nunca esgota e nunca pressupõe presença contínua — ela
trabalha a fila desbloqueada como o overnight, e quando a fila seca, varre o
backlog **bloqueado**, monta um lote de perguntas, pergunta via
`AskUserQuestion` **bloqueante**, e continua vivo esperando resposta —
implementando o que a resposta destrava e voltando ao passo 1. Ver "Loop
invariável" abaixo.

## Como usar

**Toda invocação se auto-envolve em `/loop` (#5332, 15/08/2026) — o editor
só digita `/diaria-continuo`, sem o wrapper explícito.** Histórico: o #5329
tentou isso documentando `/loop /diaria-continuo` como forma recomendada, e
o #5332 (correção anterior, 14/08/2026) achou ao vivo que isso não
funcionava — `disable-model-invocation: true`, que esta skill tinha até
agora, bloqueia **toda** chamada à ferramenta `Skill` sobre
`/diaria-continuo`, incondicionalmente, mesmo vinda de dentro do `/loop`. A
correção de 14/08 apenas documentou a limitação (não recomendar mais o
caminho quebrado). **Decisão do editor em 15/08/2026, confirmada via
`AskUserQuestion` sabendo do trade-off completo:** remover a flag e
implementar auto-envolvimento, aceitando que isso também libera, em
princípio, qualquer sessão minha (não só via `/loop`) a decidir invocar
`/diaria-continuo` por conta própria — não só quando o `/loop` mecanicamente
reinvoca o prompt num wake. **Nenhuma trava de instrução contra invocação
espontânea foi adicionada de propósito** — o editor escolheu explicitamente
não incluir essa mitigação extra ao ser perguntado; o limite atual é só o
meu próprio julgamento de quando é apropriado invocar, não um requisito
estrutural do harness.

### Mecanismo de auto-envolvimento

Primeira ação do coordenador, antes de qualquer outra coisa, ao processar
este `SKILL.md`:

1. **Detectar como fui invocado — sinal primário é um marker determinístico,
   não inferência sobre a estrutura da mensagem (#5336, achado do fleet
   review: a versão original desta seção usava só a presença/ausência de um
   bloco `<command-name>` como sinal, sem nenhum backstop verificável — uma
   leitura errada do modelo causaria recursão real).** Checar se os
   argumentos com que EU MESMO fui invocado (a `args` da chamada `Skill`
   que me trouxe aqui, quando a invocação veio por essa via — ou a ausência
   de qualquer `args` de wrapper, quando veio de digitação direta) contêm o
   marker sentinela `--via-loop`:
   - **`--via-loop` ausente → entrada fresca**, ainda não envolvida em
     `/loop` — é o caso de o editor ter digitado `/diaria-continuo`
     diretamente (reconhecível também pelo bloco
     `<command-name>/diaria-continuo</command-name>` na mensagem, sinal
     corroborante mas não mais o único).
   - **`--via-loop` presente → reentrada de dentro do próprio `/loop`** (seu
     passo "run the parsed prompt now", ou o resume via `ScheduleWakeup`) —
     o marker só chega aí porque EU o incluí no passo 2 abaixo; ninguém
     mais o produz, então sua presença é autoverificável, não uma inferência
     sobre formato de mensagem.
2. **Entrada fresca → auto-envolver, sem exceção.** Chamar
   `Skill("loop", {args: "/diaria-continuo --via-loop {flags originais, se
   houver}"})` imediatamente — antes de ler
   `context/overnight-dispatch-rules.md`, antes de checar a fila, antes de
   qualquer passo do "Loop invariável" abaixo. Preservar os flags reais da
   invocação original verbatim (`--dry-run`, `--bugs`, `--priority ...`)
   junto do marker, pra não perdê-los na reentrada — `--via-loop` em si
   **nunca** é um argumento real da skill (não aparece em "Argumentos" mais
   abaixo), é só o sentinel deste mecanismo; ignorar/descartar ao processar
   os flags de verdade. Isso entrega o controle pro `/loop`, que roda em
   modo dinâmico (sem intervalo — ver `Skill("loop", ...)` na lista de
   skills disponíveis pro comportamento exato) e, no seu próprio passo 1,
   invoca `/diaria-continuo` de novo — desta vez via `Skill` tool, chamada
   que agora funciona porque a flag não bloqueia mais, e chega com
   `--via-loop` no `args`.
3. **Reentrada via `/loop` (`--via-loop` presente) → pular este bloco,
   seguir direto pro "Loop invariável".** Não chamar `Skill("loop", ...)` de
   novo — isso causaria recursão (o `/loop` reinvocando `/diaria-continuo`,
   que reinvoca `/loop`, indefinidamente). É o `/loop`, não
   `/diaria-continuo`, quem decide quando chamar `ScheduleWakeup` pro
   próximo wake (ver "Integração com `/loop` e `ScheduleWakeup`" abaixo) — o
   coordenador desta skill só executa o "Loop invariável" normalmente a
   partir daqui.

**Não validado ao vivo ainda (mesma disciplina de honestidade do resto deste
arquivo).** O marker `--via-loop` é um sinal determinístico (presença/
ausência é um fato verificável no `args` da própria invocação, não uma
inferência de estrutura de mensagem como a versão anterior desta seção) —
mas o CAMINHO em si (`Skill("loop", {args: "...--via-loop..."})` → `/loop`
repassando esse `args` verbatim pro seu próprio passo "run the parsed
prompt now" → `Skill("diaria-continuo", {args: "...--via-loop..."})`) nunca
foi testado numa invocação real. Duas coisas específicas a confirmar na 1ª
invocação em produção: (a) que `/loop` de fato preserva o `args` completo
(incluindo `--via-loop`) ao invocar o prompt parseado, sem reformatá-lo de
um jeito que perca o marker; (b) que o auto-wrap dispara uma vez só (não
recursa) e a reentrada de fato pula o bloco 2. Se `--via-loop` se perder no
caminho por (a), o sintoma seria recursão infinita — não há teste
automatizado possível pra isso (é comportamento do harness em tempo de
execução, não algo que roda em CI); se acontecer, reportar como achado e
reverter pro sinal `<command-name>` como fallback enquanto se investiga.

### Integração com `/loop` e `ScheduleWakeup` (#5329, agora funcional via auto-envolvimento)

`/loop` (sem intervalo — "modo dinâmico") roda o prompt agora e, ao final de
cada turno em que o loop deve continuar, chama a ferramenta `ScheduleWakeup`
com um `delaySeconds` de fallback e um `prompt` que reinvoca `/loop
/diaria-continuo --via-loop {flags}` na próxima ativação — é assim que a
sessão "acorda" sem depender de mensagem do editor. O marker `--via-loop`
(ver "Mecanismo de auto-envolvimento" acima) persiste automaticamente
através dos wakes sem esforço extra do coordenador desta skill: `/loop`
reusa seu próprio `prompt` original **verbatim** a cada `ScheduleWakeup`
(mecânica documentada da própria ferramenta `/loop`), então o que foi
passado na 1ª chamada (`/diaria-continuo --via-loop {flags}`) volta
idêntico em toda reentrada — é `/loop`, não `/diaria-continuo`, quem garante
essa persistência. O sentinel de resume do `ScheduleWakeup` é mecânica
interna do modo dinâmico de `/loop` — funciona porque, com a flag removida,
o passo 1 de `/loop` consegue completar a chamada `Skill` (diferente do
estado documentado pelo #5332 original, que travava ali).

**Cadência do wake em modo ocioso (passo 6, fila seca sem resposta
pendente):** a doc do `/loop` só documenta um número fixo (1200-1800s,
20-30min) pro caso em que um Monitor está armado — ali é o fallback
heartbeat, "quanto esperar se nenhum evento disparar". O passo 6 não arma
Monitor (não há um evento de baixa latência esperando pra ser capturado),
então cai no outro caso da mesma doc: "sem Monitor, é a cadência — escolha
com base no que foi observado", sem número específico. Adotamos 1200-1800s
aqui mesmo assim, por analogia conservadora ao valor do caso com Monitor —
o passo 6 já é estritamente passivo (só re-varre e dorme, nunca gera
trabalho especulativo), e um intervalo maior só atrasaria a detecção de
issue nova/resposta do editor sem ganho real de custo. Ao reentrar via
`/loop /diaria-continuo` em modo ocioso, passar `delaySeconds` nesse
intervalo ao chamar `ScheduleWakeup`.

**Os dois estados de espera já existentes e corretos são preservados,
independente do `/loop`:**
- **Passo 4 (`AskUserQuestion` bloqueante).** O wake do `/loop` **nunca**
  deve reenviar ou reformular uma pergunta já pendente — `AskUserQuestion`
  bloqueia de verdade dentro do turno em que foi chamado; um wake de
  `ScheduleWakeup` só deveria disparar a próxima re-varredura quando **não**
  há pergunta bloqueada no momento (heartbeat `--phase
  aguardando-resposta` sinaliza esse estado pro watchdog, ver "Reuso da
  maquinaria" abaixo — o mesmo sinal serve pra não duplicar a pergunta num
  wake seguinte).
- **Notificação assíncrona de subagente terminando.** Continua funcionando
  exatamente como hoje, via `<task-notification>`, independente de a sessão
  estar rodando através de `/loop` ou não — as duas fontes de despertar
  (evento de subagente e `ScheduleWakeup`) coexistem sem conflito.

**Heartbeat durante wakes ociosos é obrigatório (#5329 item 5).** Cada
re-entrada via `/loop` que só re-varre a fila e não acha nada novo (passo 6
voltando ao passo 2, sem trabalho) deve continuar gravando o heartbeat
(`npx tsx scripts/lib/session-registry.ts heartbeat --kind continuo --phase
{fase-corrente}`) descrito em "Reuso da maquinaria" abaixo — sem isso, o
watchdog (`scripts/overnight-watchdog.ts`) perde visibilidade da sessão
entre wakes e pode alarmar falso-positivo de stall, exatamente o cenário que
o mecanismo de `HEALTHY_IDLE_PHASES` existe pra evitar. O heartbeat não é
opcional só porque o wake "não achou nada" — é justamente esse caso que o
watchdog precisa distinguir de uma sessão travada.

**Consentimento (revisado #5332, 15/08/2026 — não é mais
`disable-model-invocation`).** O gate de consentimento original — a flag no
frontmatter — foi removido pra viabilizar o auto-envolvimento. O
consentimento agora é: o editor digitou `/diaria-continuo` **uma vez** pra
iniciar a cadeia (sinal `<command-name>` do passo 1 acima); a partir daí, o
`/loop` reentra automaticamente via `Skill` tool sem exigir nova digitação a
cada wake. Isso é uma mudança real de superfície de risco em relação ao
padrão de `/diaria-overnight`/`/diaria-remover-votos-pixel` (que mantêm a
flag) — aceita explicitamente pelo editor pra esta skill especificamente, não
generalizada às demais. O blast radius em si (merges autônomos em master,
incluindo cat. D depois de uma resposta do editor) não mudou — o que mudou
é só o mecanismo de consentimento de entrada.

**Modelo/effort do coordenador.** `model: sonnet` + `effort: high` —
paridade explícita com `/diaria-overnight` (#3453) e `/diaria-develop`
(#3454), mesma decisão registrada na tabela do briefing do #5293. Mesma
limitação de escopo-de-turno documentada nos dois SKILL.md irmãos: o override
de frontmatter vale "pelo resto do turno atual" — não há mecanismo de hook
que force o modelo/effort programaticamente entre prompts.

## Reuso da maquinaria do overnight — por citação, nunca duplicado

Esta skill **não reescreve** o mecanismo de implementação — ele já está
documentado e testado em `.claude/skills/diaria-overnight/SKILL.md` e em
`context/overnight-dispatch-rules.md`. O coordenador desta skill:

- **Lê `context/overnight-dispatch-rules.md` no início da sessão** (mesmo
  checklist canônico que todo subagente implementador do overnight/develop
  lê) e o cita — não reproduz — no prompt de dispatch de cada subagente
  implementador.
- **Reusa o formato de `plan.json`** descrito em
  `.claude/skills/diaria-overnight/SKILL.md` (Fase 0, passo 7) — mesmos
  campos (`issues[]`, `timeline`, `stall_events`, `resume_state`, etc.) sob
  `data/continuo/{AAMMDD}/plan.json`. **Rotação diária (#5293 item 5,
  `scripts/lib/continuo-plan-rotation.ts`):** rodar
  `npx tsx scripts/lib/continuo-plan-rotation.ts check` no início de CADA
  re-varredura (passo 2 do loop, abaixo) — idempotente, no-op na maior parte
  das chamadas (só age quando o dia civil BRT mudou desde o último
  `{AAMMDD}` ativo). Quando rotaciona, cria `data/continuo/{novoAAMMDD}/
  plan.json` com `continued_from: {AAMMDD anterior}` (a cadeia inteira é
  reconstruível seguindo esse campo pra trás) e apenda uma linha em
  `data/continuo/history.jsonl`; o `plan.json` do dia anterior fica intocado
  (nunca é destrutivo). `bugs_only`/`priority_filter` (config de SESSÃO, não
  de dia) são carregados adiante automaticamente pela rotação. `findActiveRun`
  do watchdog (`scripts/overnight-watchdog.ts`, item 3) já assume essa
  rotação — ele trata "ativa" como "plan.json existe no `{AAMMDD}` mais
  recente", sem depender de `report.md` (que `continuo` nunca escreve).
- **Reusa a Fase 1 de implementação** do overnight, **verbatim**: subagente
  `general-purpose`, `isolation: "worktree"`, `model: sonnet` explícito
  (#2019) → `npm ci` → `npx tsc --noEmit` + testes afetados (nunca a suíte
  completa local, #2959) → branch → PR com `Closes #NNNN` (ou
  `REFS #NNNN, NÃO CLOSES`, #5010) → self-review (#2038) → agente fixer se
  houver findings acionáveis → review leve do coordenador → `gh pr checks
  --watch` → gate de 2 condições → squash-merge. **Convenção de branch,
  análoga a overnight/develop:** `continuo/fix-{issue}-{slug}` (solo) ou
  `continuo/batch-{slug}` (lote) — necessário mesmo sem código novo, porque
  `.claude/hooks/pr-create-review.mjs` (`resolveEffort`) só reconhece
  prefixo `overnight/*` ou o marker de sessão overnight ativa
  (`isOvernightRoundActive`, que lê `data/overnight/.active-session-*.json`,
  **não** `session-registry.ts`) — nenhum dos dois é verdadeiro para uma
  sessão `continuo`. **Consequência aceita, mesma situação do develop:** todo
  PR desta skill resolve `max` (fleet de 5 agentes) no hook por padrão, salvo
  diff pequeno o bastante pro heurístico de tamanho — não há desconto `low`
  automático como no overnight, e isto NÃO foi mudado nesta unidade (fora de
  escopo do item 2, que tocou só `session-registry.ts`). **Toda citação desta
  Fase que envolva `npx tsx scripts/log-event.ts` troca `--agent overnight`
  por `--agent continuo`** — a citação "verbatim" é da MECÂNICA (worktree →
  tsc → testes → PR → merge), não do valor literal do agent tag; copiar o
  `--agent overnight` ao pé da letra faria os eventos desta skill virarem
  invisíveis pra `getLastRunLogActivity(..., "continuo")`
  (`scripts/overnight-watchdog.ts`) e pra `continuo-cost-summary.ts` (ambos
  filtram por `agent === "continuo"` especificamente).
- **Reusa a Fase 1.5 de review consolidado** do overnight (1 agente,
  `pr-review-toolkit:code-reviewer` via `Agent` com `model: sonnet`
  explícito, sobre o diff acumulado desde `base_sha`) — mesma cadência de
  `findings_depth` (cap 2) documentada lá.
- **Registra-se em `session-registry.ts` com `kind: "continuo"`** (novo
  nesta unidade, #5293 item 2) — `npx tsx scripts/lib/session-registry.ts
  register --kind continuo` (session-id auto-injetado pelo hook
  `inject-session-id.mjs`, mesmo mecanismo do overnight/develop). Isso
  habilita **claim de issue** (`claim-issue --kind continuo --issue N`) e
  **merge lock** (`acquireMergeLock`/`releaseMergeLock`) — os dois
  mecanismos que evitam corrida com uma rodada overnight/develop rodando em
  paralelo na mesma máquina ou em máquinas diferentes sincronizadas por
  `data/` (OneDrive). Nunca reusar `kind: "overnight"` — a decisão do #5293
  foi criar um kind dedicado precisamente porque misturar no bucket do
  overnight enfraqueceria guards que dependem de "overnight nunca pergunta"
  (`.claude/hooks/block-askuserquestion-overnight-autonomous.mjs` filtra por
  `phase: "autonomous"` do marker `data/overnight/.active-session-*.json` —
  uma sessão `continuo` **não** grava esse marker, então esse hook nunca a
  bloqueia; é isso que permite o `AskUserQuestion` do passo 4 do loop
  abaixo).
- **Heartbeat de `phase` é OBRIGATÓRIO, não cosmético (#5293 item 3).**
  `npx tsx scripts/lib/session-registry.ts heartbeat --kind continuo --phase
  {valor}` a cada transição de estado do loop abaixo — `scripts/
  overnight-watchdog.ts` (que agora vigia `data/continuo/` além de
  `data/overnight/`) só evita alarme falso de stall quando encontra uma
  sessão `continuo` ativa com `phase` em `HEALTHY_IDLE_PHASES`
  (`"aguardando-resposta"` | `"pausado-edicao"`). **Sem o heartbeat, o
  watchdog não tem como distinguir "parada de propósito" de "travada" e vai
  disparar halt banner + Telegram a cada ciclo do watchdog agendado enquanto
  a sessão ficar parada** — os passos 3, 4 e 6 do loop, e o guard de colisão
  editorial no passo 1, dizem exatamente qual `phase` gravar em cada
  transição.
- **Emissão de `coordinator_tokens_estimate` é OBRIGATÓRIA, não opcional
  (#5293 item 6 — achado do fleet review desta unidade: o item 6 original só
  entregou a AGREGAÇÃO, `scripts/continuo-cost-summary.ts`; sem esta linha o
  script sempre reportaria zero, silenciosamente).** Reusar literalmente a
  instrução de `.claude/skills/diaria-overnight/SKILL.md` (Fase 0, passo 1,
  "Instrumentação de token do coordenador") — emitir, ao fim de cada
  transição de fase relevante do loop abaixo (ao esgotar a fila no passo 2,
  ao montar o lote de perguntas no passo 3, ao dormir no passo 6, e a cada
  rotação de dia no passo 2):
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD-do-dia-corrente} --agent continuo --level info \
    --message "coordinator_tokens_estimate" \
    --details '{"phase": "{nome-da-transição}", "tokens": N, "source": "harness_usage | context_size_proxy"}'
  ```
  **`--agent continuo`, nunca `--agent overnight`** — mesma troca obrigatória
  documentada no bullet da Fase 1 acima; `continuo-cost-summary.ts` filtra
  estritamente por esse valor. Se o harness não expuser nada estimável, logar
  `{"tokens": null, "source": "unavailable"}` uma vez por dia rotacionado
  (não repetir a cada transição) — mesma semântica do overnight.
- **Guard de publicação (INVARIANTE, igual a overnight/develop):** editar
  código de publisher é ok; **executar é proibido** — nunca rodar
  `scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`,
  `close-poll` ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo
  ao vivo, nem em "teste". Sem exceção — ao contrário do develop, esta skill
  não tem um coordenador supervisionando em tempo real que possa autorizar
  um `--dry-run` de validação de token.

## Loop invariável (nunca encerra por conta própria)

Seis passos, repetidos indefinidamente — a sessão só para por ação externa
(o editor mata o processo). O guard de colisão editorial (passo 1) **PAUSA**,
nunca encerra — diferente do overnight, que preempta a rodada inteira ao
detectar a edição diária em curso.

**Mudança de config de sessão nunca é sinal de pausa (#5327 item 1, achado
ao vivo 260814).** Comandos como `/effort medium`, `/fast`, ou qualquer outro
ajuste de config de sessão (profundidade de raciocínio, velocidade) são
**eixos completamente independentes** da decisão de continuidade do loop.
Só os dois gatilhos já documentados legitimam parar de trabalhar a fila:
fila desbloqueada seca de verdade (passo 2) ou decisão bloqueante genuína via
`AskUserQuestion` (passos 3-4). **Nunca** interpretar uma mudança de config
como pedido implícito pra desacelerar, e nunca perguntar em prosa solta
("quer que eu continue... ou prefere pausar aqui?") fora desses dois casos —
isso viola o próprio título desta seção. Incidente de referência: na 1ª
rodada em produção (260814), o editor rodou `/effort medium` no meio da
sessão e o coordenador leu isso como sinal de pausa, perguntando se devia
continuar com a fila ainda não seca — comportamento incorreto, corrigido
aqui.

1. **Trabalhar a fila desbloqueada** exatamente como o overnight faz hoje
   (ver "Reuso da maquinaria" acima) — 1 merge por vez, disciplina do
   #636/#633/#2959 intacta. Prioridade P0 > P1 > P2 > P3, mesmo critério do
   overnight. **Guard de colisão com a edição diária (#5293 item 4 — PAUSA,
   não encerra):** antes de dispatchar cada unidade, checar
   `npx tsx scripts/lib/find-current-edition.ts` (mesmo guard que o overnight
   usa) — se uma edição estiver em curso, **não** gravar `preempted_by`/
   encerrar como o overnight faz; em vez disso, heartbeat `--phase
   pausado-edicao` e ir direto pro passo 6 (dormir), sem consumir a fila.
   Voltar a checar este guard a cada acordar (passo 6) — quando a edição
   terminar (guard não acha mais candidato), heartbeat de volta pra uma phase
   de trabalho e retomar o passo 1 normalmente. O merge lock existente
   (`acquireMergeLock`/`releaseMergeLock`, session-registry.ts) já serializa
   qualquer `gh pr merge` que colida em cima disso — este guard evita
   consumir CI/worktrees durante a janela da edição, não é a única linha de
   defesa contra colisão.
2. **Fila seca** → re-varredura (`gh issue list --state open`) pra pegar
   issue nova (de terceiro, ou criada por finding da própria rodada) — mesma
   lógica sem cap de `rescans_done` que o overnight adotou em #5272 (contador
   puro de observabilidade, nenhuma decisão de parada lê o valor). **Antes de
   varrer, rodar `npx tsx scripts/lib/continuo-plan-rotation.ts check`**
   (#5293 item 5 — rotaciona `plan.json` pro dia civil corrente se ele mudou
   desde a última chamada; no-op na maioria das vezes).
3. **Ainda seca** → heartbeat `--phase varrendo-bloqueadas`, varrer o backlog
   **bloqueado** (issues `bloqueada-externa` na classificação do overnight —
   credencial-runtime, conta-externa, decisão-produto,
   supervisão-blast-radius, plataforma-sem-fix, mesma taxonomia cat. A-E do
   develop) e montar um lote de perguntas: para cada issue bloqueada, qual
   decisão/credencial/confirmação exata a destravaria.
4. **Perguntar** → heartbeat `--phase aguardando-resposta` **ANTES** de
   chamar `AskUserQuestion` (não depois — o watchdog pode rodar entre os dois
   passos; o heartbeat precisa estar gravado antes que a chamada bloqueie),
   agrupado por issue, **máximo 4 perguntas por chamada**, **sempre com a
   opção "decido depois (pular esta issue)"** — mesmo formato do briefing do
   overnight (Fase 0, passo 5), só que aqui pode se repetir a cada ciclo em
   vez de acontecer uma vez só no início. O hook
   `.claude/hooks/notify-continuo-askuserquestion.mjs` (#5293, achado do
   "Risco aceito" abaixo) dispara Telegram automaticamente nesta chamada —
   não precisa de nenhuma ação extra do coordenador além do heartbeat já
   estar gravado (o hook lê a sessão registrada, não o heartbeat em si, mas
   sem sessão registrada — passo omitido por engano — não há como o hook
   saber que é uma sessão `continuo`).
5. **Resposta recebida** → heartbeat de volta pra uma phase de trabalho,
   postar como **comentário durável na issue**
   (`gh issue comment` — `plan.json` é cache, o comentário é a fonte de
   verdade, mesmo princípio do overnight), promover a issue a elegível, **e
   implementar** (volta ao passo 1). Blast radius da implementação: **tudo
   que a resposta destravar, inclusive cat. D (blast radius alto), sem gate
   adicional** — a resposta do editor É o consentimento, mesmo princípio do
   consentimento de entrada via `<command-name>` (ver "Como usar" acima,
   #5332) e da regra de auto-merge em sessão interativa (#5251).
6. **Sem resposta** → heartbeat `--phase aguardando-resposta` (se ainda não
   estava nessa phase — idempotente repetir) e dormir; ao acordar, re-checar
   primeiro o guard de colisão editorial do passo 1 (se uma edição entrou em
   curso enquanto dormia, heartbeat `--phase pausado-edicao` e continuar
   dormindo) e então re-varrer periodicamente (a fila desbloqueada pode ter
   crescido nesse meio-tempo — voltar ao passo 1 se sim). Nunca "termina": a
   sessão fica viva esperando ou fila nova, ou resposta a uma pergunta
   pendente. **Custo acumulado (#5293 item 6):** ao acordar de um período de
   sono longo (ordem de horas) ou a cada rotação de dia (passo 2), rodar
   `npx tsx scripts/continuo-cost-summary.ts` e considerar o número reportado
   — não há teto (mandato "sem limites", #2039/#5293), mas o editor pode
   perguntar a qualquer momento e a resposta deve vir desse script, nunca de
   memória/estimativa do coordenador (mesma disciplina do #1172).

**Modo ocioso é estritamente passivo (decisão do briefing):** quando a fila
desbloqueada seca e não há resposta pendente, a skill **só re-varre issues e
dorme** — nunca vira geradora de trabalho especulativo (nada de auditar o
repo proativamente pra inflar o backlog). Se a fila secou e ninguém
respondeu, dorme.

## Decisões já tomadas (briefing com o editor, 14/08/2026)

| Eixo | Decisão | Nota |
|---|---|---|
| **Canal das perguntas** | `AskUserQuestion` **bloqueante**, no terminal | Sem fila assíncrona paralela. Ver "Risco aceito" abaixo. |
| **Forma** | **Skill nova** (`/diaria-continuo`), não flag `--forever` do overnight | Mantém a Regra 1 do overnight literal e sem exceção condicional. |
| **Ocioso** | **Só re-varre issues e dorme** | Não vira geradora de trabalho — ver "Loop invariável" acima. |
| **Blast radius** | **Tudo que a resposta destravar**, inclusive cat. D | A resposta do editor é o consentimento — sem gate adicional pós-resposta. |
| **Kind no `session-registry.ts`** | **`"continuo"`, dedicado** (#5293 item 2) | Não reusa `"overnight"` — preserva o guard `block-askuserquestion-overnight-autonomous.mjs`, que depende de "overnight nunca pergunta". |
| **Guard de colisão editorial** | **PAUSA, nunca encerra** (#5293 item 4) | Diferente do overnight (preempta a rodada inteira) — heartbeat `--phase pausado-edicao`, dorme, retoma quando a edição termina. |
| **Rotação de `plan.json`** | **Diária, por dia civil BRT** (#5293 item 5) | `continued_from` encadeia os dias; config de sessão (`bugs_only`/`priority_filter`) carrega adiante, dados do dia não. |

## Risco aceito: `AskUserQuestion` bloqueante numa sessão que roda o tempo todo

Registrado explicitamente porque contraria a regra mais dura do overnight
(Regra 1, "zero perguntas pós-briefing"), e o editor decidiu assim mesmo com
o trade-off na mesa:

- **Incidente de referência 260706/07 (#3037/#3038):** um `AskUserQuestion`
  sobre uma decisão trivial travou uma rodada overnight por ~8h porque o
  editor estava dormindo. Foi esse incidente que produziu a Regra 1 do
  overnight.
- **Por que é tolerável aqui, e não lá:** no overnight, travar significa
  perder a janela de trabalho autônomo da noite inteira. Aqui, travar
  acontece **só depois que a fila desbloqueada já esgotou** — não há
  trabalho autônomo sendo desperdiçado, por definição (passo 3 do loop só
  roda quando o passo 1 não tem mais nada pra fazer). A skill parada
  esperando resposta e a skill dormindo (passo 6) são estados equivalentes
  em produtividade.
- **Mitigação — status investigado numa unidade anterior, FECHADO nesta.** A
  issue original citava `scripts/lib/telegram-notify.ts` e o
  `gate-chat-bridge.js` do Studio (#3557/#3617/#3804) como já existentes e
  suficientes. Achado da unidade anterior (leitura direta do código):
  - **`scripts/studio-ui/studio-telegram-notify.ts`** só dispara pra
    `AskUserQuestion` pendente em `chatPermissionsPending`
    (`studio-chat.ts`) — populado só por sessões abertas **através do
    drawer do Studio**, não por uma sessão de terminal comum.
  - **`scripts/studio-ui/public/gate-chat-bridge.js`** cobre gates
    **editoriais** (`gatesPending`, Stage 4/6 de uma edição), não
    `AskUserQuestion` genérico de uma sessão de backlog de issues.
  - **Nenhum dos dois cobre o caminho que esta skill de fato usa** (decisão
    do briefing: "no terminal", tabela acima) — ficou registrado como
    pendência explícita, não resolvida naquela unidade.
  - **Fechado nesta unidade (#5293 item 3, achado adjacente):**
    `.claude/hooks/notify-continuo-askuserquestion.mjs`, um `PreToolUse`
    hook novo registrado no MESMO matcher `AskUserQuestion` que
    `block-askuserquestion-overnight-autonomous.mjs` já usa
    (`.claude/settings.json`). Lê `session_id` do payload do hook, varre
    `data/sessions/` por um registro `continuo-*-{session_id}.json` ativo
    (`session-registry.ts`) e, se encontrar, dispara a Bot API do Telegram
    diretamente (mesma credencial `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` de
    `telegram-notify.ts` — reimplementada, não importada, por ser um hook
    self-contained, mesma convenção do hook irmão). **NUNCA bloqueia** — é
    observação pura, roda em paralelo ao hook que decide bloquear/permitir.
    Testado em `test/notify-continuo-askuserquestion.test.ts`. **Limitação
    residual honesta:** funciona só se `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
    estiverem configurados na máquina (mesmo requisito de todo o resto do
    projeto que usa Telegram — `docs/telegram-setup.md`) — sem eles, o hook
    é um no-op silencioso e o risco aceito original (travar sem aviso) volta
    a valer integralmente. Confirmar `echo $TELEGRAM_BOT_TOKEN` antes da 1ª
    invocação em produção desta skill. **Credenciais presentes mas
    rejeitadas** (token revogado, `chat_id` errado, rate limit) — diferente
    de credenciais AUSENTES — loga em stderr (`resp.status`+corpo, ou a
    exceção de rede) em vez de descartar silenciosamente (#5293 fleet
    review, achado 4); ainda assim nunca bloqueia o `AskUserQuestion`. stderr
    de hook não tem superfície de alerta própria neste repo — só aparece se
    alguém estiver olhando o terminal/journalctl no momento, o que é
    exatamente a situação que este hook existe pra não depender. Fechar essa
    lacuna (ex: um segundo canal de alerta pra falha do PRÓPRIO alerta) é
    follow-up, não bloqueio desta unidade.

## Argumentos

Mesmos aceitos por `/diaria-overnight`, mesma semântica (aplicam-se à
varredura de issues, não ao loop de terminação — que não é opcional):
`--dry-run`, `--bugs`, `--priority P0,P1,P2,P3`. Ver
`.claude/skills/diaria-overnight/SKILL.md` seção "Argumentos" pro
comportamento exato de cada um.

---

## Itens 3-6 — estado (#5293)

A 1ª unidade implementou só os itens 1-2 (este SKILL.md + o kind
`"continuo"` em `scripts/lib/session-registry.ts`). Esta unidade fechou os
quatro restantes — cada um com código + testes, não só prosa:

1. **Watchdog — RESOLVIDO.** `scripts/overnight-watchdog.ts` agora vigia
   `data/continuo/` além de `data/overnight/` na mesma invocação
   (`WATCHED_KINDS`), e `findActiveRun(rootDir, "continuo")` trata "ativa"
   como "`plan.json` existe no `{AAMMDD}` mais recente" — nunca depende de
   `report.md` (que `continuo` nunca escreve, ao contrário do overnight).
   Antes de declarar stall, `hasHealthyIdleSession` consulta
   `session-registry.ts` por uma sessão `continuo` ativa com `phase` em
   `HEALTHY_IDLE_PHASES` (`"aguardando-resposta"` | `"pausado-edicao"`) — se
   encontrar, o diagnóstico vira `healthy_idle` (não `stall`), sem
   halt banner nem alerta Telegram. **Depende do heartbeat de fase estar
   sendo gravado pelo coordenador** (ver bullet "Heartbeat de phase é
   OBRIGATÓRIO" em "Reuso da maquinaria" acima) — o mecanismo é fail-safe no
   sentido de nunca mascarar um stall genuíno, mas não é mágico: sem
   heartbeat, o watchdog não tem como saber que a parada é saudável. Testado
   em `test/overnight-watchdog.test.ts` (`findActiveRun com kind=continuo`,
   `hasHealthyIdleSession`, `diagnoseWatchdogActivity` com `isHealthyIdle`).
   **Isolamento por kind (corrigido no fleet review):** o loop de `main()`
   agora envolve cada kind (`overnight`, `continuo`) no próprio try/catch —
   uma exceção ao processar um kind não aborta mais o loop antes de checar o
   outro; o processo ainda sai com código != 0 se algum kind falhou.
2. **Interação com `Diaria-Edicao-Diaria` — RESOLVIDO (decisão: PAUSA, não
   fim).** Diferente do overnight (que preempta a rodada inteira e grava
   `preempted_by: "edicao_editorial"`), o passo 1 do "Loop invariável" agora
   especifica: guard de colisão detectado → heartbeat `--phase
   pausado-edicao` → pular pro passo 6 (dormir) sem consumir a fila →
   re-checar o guard a cada acordar → heartbeat de volta pra phase de
   trabalho quando a edição terminar. O merge lock existente
   (`acquireMergeLock`/`releaseMergeLock`) continua como a última linha de
   defesa contra colisão de `gh pr merge` — este guard evita gastar
   CI/worktrees durante a janela da edição, não é redundante com o lock.
3. **Rotação de `plan.json` — RESOLVIDO.**
   `scripts/lib/continuo-plan-rotation.ts` — rotação por dia CIVIL BRT
   (`todayAammdd`/`shouldRotatePlan`). `rotateContinuoPlanIfNeeded` cria
   `data/continuo/{novoAAMMDD}/plan.json` com `continued_from: {AAMMDD
   anterior}` quando o dia muda, carrega adiante `bugs_only`/
   `priority_filter` (config de sessão, não de dia), apenda uma linha em
   `data/continuo/history.jsonl`, e NUNCA toca o `plan.json` do dia anterior
   (só adiciona, nunca edita/apaga). Chamado pelo coordenador no início de
   cada re-varredura (passo 2 do loop) — idempotente, no-op na maioria das
   chamadas. Testado em `test/continuo-plan-rotation.test.ts` (17 casos,
   incluindo bootstrap, idempotência, virada de dia/mês, e falha de I/O no
   `history.jsonl` não impedindo a rotação do `plan.json` em si).
   **Leitura do `plan.json` anterior (corrigida no fleet review):** usa
   `readPlanFromDir` (mesma função com retry-em-JSON-truncado do #3353 que
   `overnight-watchdog.ts` já reusava) em vez de um `JSON.parse(readFileSync
   (...))` cru — a 1ª versão desta unidade tinha reintroduzido exatamente o
   bug que #3353 corrigiu, só que num 3º leitor do mesmo `plan.json`. Falha
   de leitura/parse (depois do retry) é logada em stderr, não silenciosa —
   `listContinuoDays` já confirmou que o arquivo existe, então um `null`
   aqui é sempre falha genuína, nunca "ausente".
4. **Instrumentação de custo acumulado — RESOLVIDO (2 partes, a 2ª corrigida
   depois do fleet review).** `scripts/continuo-cost-summary.ts` — soma
   `details.tokens` de todos os eventos `coordinator_tokens_estimate`
   (`agent: "continuo"`) em `data/run-log.jsonl`, através de TODOS os dias
   rotacionados de `data/continuo/` (não só o dia corrente — usa
   `listContinuoDays` de `continuo-plan-rotation.ts`). Suporta `--since
   {AAMMDD}` pra bounds, e `--json` pra saída estruturada. Eventos com
   `tokens: null` (harness não expôs `usage`) são contados à parte
   (`unavailableCount`), nunca somados como 0. Complementa (não substitui)
   `scripts/check-overnight-token-instrumentation.ts` (#5009), que checa só
   PRESENÇA por edição isolada — este script soma o VALOR através do ciclo
   inteiro. Testado em `test/continuo-cost-summary.test.ts`. **A 1ª versão
   desta unidade entregou só essa AGREGAÇÃO — a EMISSÃO (o coordenador de
   fato rodando `log-event.ts --agent continuo --message
   coordinator_tokens_estimate`) nunca foi instruída em lugar nenhum do
   `SKILL.md`, o que faria o script sempre reportar zero em silêncio**
   (achado do comment-analyzer no fleet review desta PR). Corrigido: bullet
   dedicado em "Reuso da maquinaria" acima ("Emissão de
   coordinator_tokens_estimate é OBRIGATÓRIA") agora instrui explicitamente
   quando e como emitir. **Ainda sem um checker mecânico equivalente a
   `check-overnight-token-instrumentation.ts`** que confirme que o
   coordenador de fato seguiu essa instrução numa rodada real — mesma classe
   de gap, ainda aberta, ver `computeContinuoCostSummary`'s docblock.

**Achado adjacente, fechado nesta mesma unidade (não fazia parte dos 6 itens
originais, mas do "Risco aceito" registrado acima):**
`.claude/hooks/notify-continuo-askuserquestion.mjs` — hook `PreToolUse` que
dispara Telegram quando um `AskUserQuestion` pendente pertence a uma sessão
`continuo` ativa, cobrindo especificamente o caminho "sessão de terminal
comum" que `studio-telegram-notify.ts`/`gate-chat-bridge.js` não cobrem. Ver
detalhe completo na seção "Risco aceito" acima.

**Residual, honestamente não resolvido:** nenhuma invocação real desta
skill aconteceu ainda em produção — todo o mecanismo acima foi validado por
teste unitário/isolado (tmpdir, sem tocar `data/` real), não por uma rodada
de ponta a ponta. A 1ª invocação em produção deve ser tratada como o
primeiro teste de integração real do conjunto — acompanhar de perto
(heartbeats sendo gravados, watchdog não alarmando falso-positivo, rotação
acontecendo na virada do dia) antes de considerar o mecanismo
operacionalmente maduro.
