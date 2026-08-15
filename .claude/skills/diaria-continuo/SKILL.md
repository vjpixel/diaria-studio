---
name: diaria-continuo
description: Sessão CONTÍNUA que nunca termina sozinha (#5293) — derivada do overnight, reusa a mesma maquinaria de implementação, mas troca o critério de terminação. Itens 1-6 da issue de origem implementados (kind dedicado no session-registry, watchdog phase-aware, guard de colisão editorial pausa-não-encerra, rotação diária de plan.json, instrumentação de custo acumulado, notificação Telegram do AskUserQuestion pendente) — ver "Itens 3-6" abaixo pro estado exato de cada um antes de rodar em produção pela 1ª vez. Toda invocação se auto-envolve em `/loop` (#5332) — ver "Como usar". Uso — `/diaria-continuo [--dry-run] [--bugs] [--priority P0,P1,P2,P3]`.
model: sonnet
effort: medium
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

**Modelo/effort do coordenador.** `model: sonnet` + `effort: medium` —
paridade explícita com `/diaria-overnight` (#3453) e `/diaria-develop`
(#3454), mesma decisão registrada na tabela do briefing do #5293. Mesma
limitação de escopo-de-turno documentada nos dois SKILL.md irmãos: o override
de frontmatter vale "pelo resto do turno atual" — não há mecanismo de hook
que force o modelo/effort programaticamente entre prompts.

**EXPERIMENTO em curso (#5306, 15/08/2026): `effort` baixado de `high` →
`medium`, em paridade com a mesma troca em `/diaria-overnight`.** Hipótese:
o guia de migração do Sonnet 5 indica que `medium` no Sonnet 5 é comparável
em inteligência ao `high` do Sonnet 4.6 — geração em que o racional acima
(#3453) foi calibrado. **Esta troca vale só a partir da PRÓXIMA invocação
desta skill** (escopo-de-turno, ver parágrafo acima) — uma sessão já em
andamento continua no `effort` com que começou. Medição pendente: comparar
`coordinator_tokens_estimate` (normalizado por unidade trabalhada) de
rodadas futuras em `medium` contra as últimas rodadas em `high`, mais
avaliação pós-hoc da qualidade da triagem/gate/review consolidado —
protocolo completo e resultado a registrar em #5306 antes de tornar a
mudança permanente. `.claude/skills/diaria-develop/SKILL.md` foi deixado de
fora de propósito (fica em `high` como controle — editor presente lá, sinal
de qualidade mais fácil de ler).

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
- **Emissão de `subagent_metrics` é OBRIGATÓRIA aqui também, tornada
  explícita (#5344 Parte B0 — achado: era coberta só implicitamente pela
  frase "verbatim" do bullet "Reusa a Fase 1 de implementação" acima, o que
  bastava pra emissão em si mas deixava `continuo-cost-summary.ts` sem um
  ponto claro de onde vem o dado que ele soma).** Este é o mesmo evento que
  o overnight emite ao fim de cada unidade de implementação
  (`.claude/skills/diaria-overnight/SKILL.md`, Fase 1 passo 5,
  "Instrumentação de token por unidade #4815") — é o grosso do gasto real de
  uma sessão `continuo`, maior que o do próprio coordenador. Ao dispatchar
  cada unidade via a Fase 1 reusada, emitir no mesmo ponto que o overnight já
  documenta (unidade atingiu status terminal — merged/draft/pulada):
  ```bash
  npx tsx scripts/log-event.ts --edition {AAMMDD-do-dia-corrente} --agent continuo --level info \
    --message "subagent_metrics" \
    --details '{"unidade": "#NNNN | lote {slug}", "issues": [123], "subagent_tokens": N, "tool_uses": N, "duration_ms": N, "source": "harness_usage | unavailable"}'
  ```
  `continuo-cost-summary.ts` (#5344 Parte B0) soma `details.subagent_tokens`
  destes eventos como categoria "Implementação", separada da categoria
  "Coordenador" (`coordinator_tokens_estimate` acima) — as duas somadas
  formam `totalTokens`. `scripts/check-continuo-token-instrumentation.ts`
  (#5344 Parte B0) checa a PRESENÇA de ambos os tipos por dia rotacionado —
  ausência de qualquer um dos dois é `warning`, nunca falha silenciosa.
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

   **Agrupamento em lotes (#5344 Parte A — lacuna fechada nesta unidade).**
   `/diaria-continuo` reusa a Fase 1 do overnight verbatim ("Reuso da
   maquinaria" acima), e essa Fase opera sobre "unidade de trabalho = issue
   solo **ou lote**" — mas os critérios de QUANDO formar um lote e a
   aprovação dele moram na Fase 0 do overnight (briefing único no início da
   rodada), que a `continuo` não tem. Antes de dispatchar cada unidade,
   avaliar se a issue de maior prioridade se agrupa com outra(s) já
   elegível(is) na fila usando os mesmos dois critérios do overnight
   (`context/overnight-dispatch-rules.md`, seção 14 — #5344 Parte B3, nunca
   mais abrir o `SKILL.md` grande do overnight só por isto): **(a)
   coesão de subsistema** — mesmo subsistema/arquivos, mesma natureza (#2024)
   — ou **(b) baixo-risco + baixo-blast-radius** — issues pequenas e de
   baixo blast radius compartilham 1 subagente mesmo sem relação temática,
   pelo bootstrap amortizado (#3453 Rec 3). Teto do lote é o mesmo do
   overnight: **cabe sem forçar compaction de contexto do subagente
   implementador, não um número fixo de issues** (#2754) — sinal prático de
   estourado é o subagente reportar compaction ou a lista de arquivos
   tocados passar de ~15-20; issues grandes/arriscadas (P1, blast radius
   alto, migrações) ficam solo. **Aqui o agrupamento vale mais que no
   overnight, não menos:** `continuo` não pega o desconto `low` do hook de
   review (ver "Reuso da maquinaria" acima — todo PR desta skill resolve
   `max` por padrão), então cada PR paga o fleet de 5 agentes quando o diff
   passa do heurístico de tamanho; amortizar isso sobre mais issues por lote
   é ganho direto de custo, não só de bootstrap.

   `batch_approval` é gravado em `plan.json` no mesmo campo que o overnight
   já usa, mas com um único valor possível e permanente nesta skill:
   **`"default_proposed"`** — nunca `"editor_approved"`/`"editor_adjusted"`.
   Diferente do overnight, a `continuo` não tem briefing único no início da
   rodada onde encaixar essa pergunta sem custo extra de interação (#2612), e
   o passo 4 abaixo já reserva o único `AskUserQuestion` do loop pra
   destravar issues bloqueadas — **o agrupamento nunca vira um
   `AskUserQuestion` novo**, é decisão mecânica do coordenador a cada
   dispatch, não do editor (mesmo princípio do "Perguntar é exceção" do
   CLAUDE.md — não há trade-off editorial genuíno em como agrupar issues
   técnicas). Se o editor discordar de um agrupamento já despachado, o canal
   é o mesmo dos passos 3-5 abaixo: comentar na issue.
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
   memória/estimativa do coordenador (mesma disciplina do #1172). **Checagem
   de instrumentação (#5344 Parte B0):** na mesma rotina, rodar também
   `npx tsx scripts/check-continuo-token-instrumentation.ts --edition
   {AAMMDD-do-dia-corrente}` — se vier `warning`, é sinal de que o
   coordenador esqueceu os checkpoints de emissão (não que a sessão não
   gastou nada); registrar o `warning` explicitamente se o editor perguntar
   pelo custo, em vez de reportar o número de `continuo-cost-summary.ts`
   como se fosse completo.

**Modo ocioso é estritamente passivo (decisão do briefing):** quando a fila
desbloqueada seca e não há resposta pendente, a skill **só re-varre issues e
dorme** — nunca vira geradora de trabalho especulativo (nada de auditar o
repo proativamente pra inflar o backlog). Se a fila secou e ninguém
respondeu, dorme.

## Decisões e histórico

Rationale das decisões do briefing (14/08/2026), o risco aceito de
`AskUserQuestion` bloqueante e a mitigação (hook Telegram), e o histórico de
implementação dos itens 3-6 do #5293 foram movidos para
`docs/continuo-decisoes.md` (#5344 Parte B4 — não-operacional, não precisa
ser relido a cada wake do coordenador). Nada foi perdido, só realocado.

## Argumentos

Mesmos aceitos por `/diaria-overnight`, mesma semântica (aplicam-se à
varredura de issues, não ao loop de terminação — que não é opcional):
`--dry-run`, `--bugs`, `--priority P0,P1,P2,P3`. Ver
`.claude/skills/diaria-overnight/SKILL.md` seção "Argumentos" pro
comportamento exato de cada um.

---

## Itens 3-6 — estado (#5293)

Histórico de implementação dos itens 3-6 (watchdog, interação com
`Diaria-Edicao-Diaria`, rotação de `plan.json`, instrumentação de custo
acumulado) movido para `docs/continuo-decisoes.md` (#5344 Parte B4 —
histórico de implementação, não operacional, não precisa ser relido a cada
wake do coordenador). Nada foi perdido, só realocado.
