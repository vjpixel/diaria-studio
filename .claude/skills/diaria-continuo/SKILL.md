---
name: diaria-continuo
description: Sessão CONTÍNUA que nunca termina sozinha (#5293) — derivada do overnight, reusa a mesma maquinaria de implementação, mas troca o critério de terminação. Itens 1-6 da issue de origem implementados (kind dedicado no session-registry, watchdog phase-aware, guard de colisão editorial pausa-não-encerra, rotação diária de plan.json, instrumentação de custo acumulado, notificação por e-mail — canal definido em #5341 — do AskUserQuestion pendente) — ver "Itens 3-6" abaixo pro estado exato de cada um antes de rodar em produção pela 1ª vez. Toda invocação se auto-envolve em `/loop` (#5332) — ver "Como usar". Uso — `/diaria-continuo [--dry-run] [--bugs] [--priority P0,P1,P2,P3]`.
model: sonnet
effort: medium
---

# /diaria-continuo

> **ANTES DE DELETAR ESTA SKILL OU A INFRA DELA, LEIA (#6056/#6059/#6060,
> 24/08/2026).** A infraestrutura que este arquivo documenta (kind `continuo`
> no `session-registry`, `continuo-plan-rotation.ts`,
> `continuo-cost-summary.ts`, `check-continuo-token-instrumentation.ts`, o hook
> `notify-continuo-askuserquestion.mjs`, `COORDINATOR_KINDS`) é consumida por
> uma skill que **não vive neste repo**: a `hermes-diaria-continuo` (mora em
> `/home/vjpixel/.hermes/skills/productivity/hermes-diaria-continuo/`, **não**
> em `~/.claude/skills/`, onde só existe o `humanizador`), disparada por um
> cron **do Hermes** (`~/.hermes/cron/jobs.json`, job `5d791ef6fc2c`,
> `every 60m` — **não** é um cron do Claude Code) a cada 60min DENTRO deste
> checkout. O #6059 deletou tudo isso junto com a skill e quebrou o loop de
> produção dela — revertido no #6060. Guard mecânico:
> `test/continuo-infra-consumidor-externo.test.ts`. Remover ESTE arquivo
> (o pedido original do #6056) segue possível, mas só depois de confirmar no
> `helios` que a `hermes-diaria-continuo` duplica o conteúdo em vez de
> CITÁ-LO — o padrão deste repo é citar, não duplicar.

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

**Cadência do wake em modo ocioso (passo 6, fila seca sem resposta pendente)
— revisada em #5390, 15/08/2026: 4 horas, não mais 20-30min.** O valor
antigo (1200-1800s, adotado por analogia conservadora ao fallback do
`/loop` com Monitor armado) gerava re-varredura a cada 20-30min mesmo numa
fila seca de verdade — bootstrap de contexto repetido sem gerar trabalho
real (issue nova ou resposta do editor tolera latência de horas, não
minutos). Decisão do editor: alongar o wake ocioso pra **4 horas**.

**Restrição do harness: `ScheduleWakeup` clampa `delaySeconds` em
[60, 3600]** — 4h (14400s) não cabe numa única chamada. Duas formas de
chegar lá foram avaliadas: (a) persistir um contador de "quantas horas
faltam" em `plan.json` e encadear 4 wakes de 3600s, os 3 primeiros
no-op puro; (b) manter o wake **sempre horário** (3600s, o próprio teto do
clamp) e mover o corte de "vale a pena re-varrer de verdade" pro **início
do passo 6**, comparando contra o campo `last_scan_at` já existente em
`plan.json`. Adotamos **(b)** — mesmo efeito de custo (3 de cada 4 wakes
não fazem trabalho algum), mecanismo mais simples (não precisa de contador
dedicado nem de lógica de "quantas horas faltam", só uma comparação de
timestamp já disponível) e sem estado extra pra manter consistente entre
rotação de dia e cadeia de wakes.

**Mecanismo:** todo wake de `ScheduleWakeup` em modo ocioso agenda o
próximo com `delaySeconds: 3600` (fixo — não varia; não há mais backoff
progressivo, ver nota logo abaixo). Ao acordar, ANTES de re-varrer (passo
2):
- `now() - last_scan_at < 4h` → **wake no-op**: não re-varre nada, não toca
  a fila, só grava heartbeat (obrigatório em todo wake, inclusive este —
  #5329 item 5, não afrouxado por esta mudança) e volta a dormir
  (`ScheduleWakeup` de novo, mais 3600s).
- `now() - last_scan_at >= 4h` (ou `last_scan_at` ausente/vazio — 1ª
  varredura do dia) → **wake de varredura**: segue o "Loop invariável"
  normalmente a partir do passo 2, que já grava `last_scan_at = now()` ao
  fim da varredura (mecanismo preexistente, #5344 Parte B6 — nenhuma
  mudança nesse ponto).

Ao reentrar via `/loop /diaria-continuo` em modo ocioso, o `delaySeconds`
passado ao `ScheduleWakeup` é sempre `3600` — o corte de 4h vive na decisão
de re-varrer ou não no início do próximo wake, nunca no valor do delay em
si.

**`idle_scan_streak`/backoff progressivo (#5344 Parte B5) — superado por
esta mudança, não mais lido/escrito pelo loop.** O backoff
20min→30min→45min→60min existia pra alongar gradualmente o wake ocioso até
o teto de 3600s do `ScheduleWakeup`, degrau por degrau, conforme a fila
seguia seca. Com o wake ocioso agora fixo em 3600s desde o primeiro ciclo
(o teto do clamp virou o próprio valor de todo wake — não sobra intervalo
abaixo dele pra progredir), o backoff fica redundante: o corte de 4h já
faz o trabalho que o backoff fazia (reduzir a frequência de re-varredura
de verdade numa fila seca), por um mecanismo mais simples. O campo
`idle_scan_streak` continua declarado como opcional em
`plan.json`/`scripts/overnight-statusline.ts`/
`scripts/lib/continuo-plan-rotation.ts` — custo de remover o tipo é maior
que o de deixar órfão, mesmo raciocínio aplicado ao `WATCHED_KINDS` do
watchdog (ver seção B do #5390) — mas o "Loop invariável" abaixo **não** o
lê nem incrementa mais; é dado morto, não consultado por nenhuma decisão de
cadência. Se precisar reverter, é esta seção que volta a ler/escrever o
campo.

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

**Consulta de `conflicts` nos 3 pontos + fim de tick (#6168 Partes C/E).**
Esta skill compartilha o checkout com overnight e develop, e é a que mais
colide na prática (em 26/08 disputou a #6232 com o overnight às 11:20 × 11:27,
e os DOIS claims sucederam — foi o achado que gerou #6236/#6242). Três
consultas, todas com `npx tsx scripts/lib/session-registry.ts conflicts ...`
como comando **standalone** (encadear quebra a injeção de `--session-id`,
item 18 de `context/overnight-dispatch-rules.md`):

1. **antes de abrir worktree** — `conflicts --paths {arquivos da unidade}
   --branch {atual}`. Responde por ARQUIVO, não por issue: é o caso de duas
   sessões em issues diferentes, sem colisão de claim nenhuma, editando o
   mesmo arquivo (buraco 2 da #6168). `exit 1` = sobreposição com peer VIVO.
2. **antes de `git commit`** — `conflicts --branch $(git branch --show-current)`.
   `branch-drift` significa que outra sessão trocou o checkout embaixo (o
   `sync-code.ts` faz `git checkout master` quando a branch não é master, e é
   o Passo 0 de toda edição/rodada). É a checagem mais barata das três e a que
   pega o incidente em que `commit` e `push` reportam SUCESSO e o commit foi
   parar em `master`.
3. **na SAÍDA, antes de encerrar o tick** — junto do `end` obrigatório abaixo.

**Encerrar o registro ao fim de CADA tick — não é opcional (#6168).** A skill
externa `hermes-diaria-continuo` (no `helios`, fora deste repo) registra com um
`session-id` ESTÁVEL entre ticks. Sem `end` no fechamento, o registro sobrevive
carregando `claimed_issues` de trabalho já encerrado, e nada distingue "tick
rodando agora" de "tick que terminou há 50 min" — na prática, overnight e
develop pulam issues por até 90 minutos por causa de claims de um tick morto.
Ao fechar o tick: `git status --porcelain` limpo (sujo → commitar, stashar ou
mover pra fora do repo; **nunca** encerrar deixando trabalho não commitado em
`master` no checkout compartilhado — aconteceu 2×, 26/08 e de novo em 01/09
com a #6952 — 498 linhas nunca commitadas, sem PR — ambas relatadas como
"concluído", ver #6922), depois `npx tsx scripts/lib/session-registry.ts end
--kind continuo` (standalone).

**Desde o #6922 esse `git status` deixou de depender só de o modelo lembrar
de rodar** — o próprio `end` recusa (`exit 1`, mensagem nomeando o(s)
arquivo(s) sujo(s)) quando `repoRoot` tem mudanças não commitadas, antes de
remover o registro da sessão. `--allow-dirty` bypassa quando a sujeira for
confirmadamente de OUTRA sessão concorrente no mesmo checkout compartilhado
(#6168) — nunca usar por padrão, só depois de checar `git status
--porcelain` manualmente e reconhecer que os arquivos listados não são
trabalho desta sessão.

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
- **Trem de merge (#6300, decisão do editor 26/08/2026, default ATIVO):**
  o parágrafo "Trem de merge" do Gate 2 do overnight (`.claude/skills/
  diaria-overnight/SKILL.md`) se aplica aqui por citação, igual ao resto
  desta seção — única diferença é `--kind continuo` em vez de `--kind
  overnight` na chamada de `scripts/run-merge-train.ts`. Mesmo gatilho
  (≥2 unidades Gate-2-verde sem colisão de arquivo ao mesmo tempo), mesma
  degradação automática (bissecta até o piso se o lote vier vermelho).
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
- **NÃO mergeia PR que toca caminho de publicação/render público** (#6277).
  Antes de abrir a PR e de novo antes do merge, rodar `npx tsx
  scripts/lib/sensitive-path-guard.ts --base origin/master --json`.
  `"sensitive": true` → deixar a PR aberta, comentar o veredito nela e
  encaminhar pro review consolidado (Fase 1.5) ou pra sessão com o editor;
  seguir pra próxima unidade no mesmo ciclo (encaminhar não é parar).
  **Fail-closed obrigatório:** se o comando sair com exit ≠ 0, imprimir
  nada, ou emitir JSON que não parseia, tratar como **SENSÍVEL** e não
  mergear — "não consegui determinar" nunca vira "pode seguir". (O script já
  falha fechado do seu lado: em erro de git ele escreve em stderr, sai 1 e
  **não** imprime veredito nenhum; esta linha existe porque quem lê é um
  agente seguindo prosa, não um shell checando `$?`.) A lista de paths
  vive em `SENSITIVE_RULES` (`scripts/lib/sensitive-path-guard.ts`, coberta
  por `test/sensitive-path-guard.test.ts`) — nunca decidir "isso é
  sensível?" por julgamento do ciclo. **Motivo:** em 260826 o PR #6214
  tocou `scripts/lib/site-archive-pages.ts`, passou pelo review por PR e
  **quebrou a geração do acervo público inteiro** (hotfix `4b16a195`,
  #6255); o defeito era interação entre o guard novo e um sanitize
  pré-existente — invisível pra review que só vê o diff, e sem teste que o
  pegasse. Nesses caminhos o custo do ponto cego é superfície pública
  quebrada, não CI vermelho. Não confundir com a outra quebra do mesmo dia
  (#6237 → master vermelho, fix `eac20369`/#6261): teste desatualizado, o
  CI pega sozinho e não precisa deste guard.
- **Não reivindica issue nova enquanto houver rodada overnight ativa**
  (#6277). No início de cada ciclo, antes de qualquer `claim-issue`: `npx
  tsx scripts/lib/session-registry.ts active-of-kind --kind overnight`.
  `active: true` → o ciclo trabalha só a própria fila de PRs abertos
  (review/merge) e reporta "overnight ativo: N sessão(ões), fila nova não
  tocada". **`uncertain: true` no mesmo JSON conta como `active: true`** —
  significa que `data/sessions/` existe mas não pôde ser lido (I/O
  transitório do OneDrive), então `active: false` ali quer dizer "não deu
  pra saber", não "não há overnight"; fail-CLOSED. Sempre reportar também o
  array `stale` quando não-vazio ("não há overnight ativo, mas há N registro
  stale de X") — registro órfão nunca some em silêncio. O check-and-set do
  #6236 fecha a corrida de ESCRITA no claim,
  mas não evita duas sessões ANALISANDO a mesma fila. Em 260826 o overnight
  reivindicou a #6232 às 11:20 com subagente já implementando e o contínuo
  reivindicou às 11:27 — **os dois claims sucederam**, porque `claimIssue`
  escrevia só no próprio arquivo de sessão sem nunca consultar os das
  outras; foi esse achado que motivou o check-and-set (#6242). O
  check-and-set faz a 2ª tentativa ser recusada hoje, mas a recusa chega
  DEPOIS de a sessão já ter lido, classificado e planejado a issue: o
  trabalho de análise se perde igual. Por isso a exclusão precisa acontecer
  ANTES do claim, não nele. Sessão overnight com heartbeat morto
  (> `SOFT_STALE_MS`, 90 min) **não** conta como ativa — o helper já
  filtra, então overnight que morreu sem chamar `end` nunca trava o
  contínuo.
- **Registra-se em `session-registry.ts` com `kind: "continuo"`** (novo
  nesta unidade, #5293 item 2) — `npx tsx scripts/lib/session-registry.ts
  register --kind continuo` (session-id auto-injetado pelo hook
  `inject-session-id.mjs`, mesmo mecanismo do overnight/develop — **sempre
  como comando standalone, nunca em `&&`/`;`/pipe/heredoc**, senão a
  injeção não acontece; `context/overnight-dispatch-rules.md` item 18,
  #5751). Isso habilita **claim de issue** (`claim-issue --kind continuo --issue N`) e
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
  disparar halt banner + push por e-mail a cada ciclo do watchdog agendado enquanto
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

Um passo 0 de sync + seis passos, repetidos indefinidamente — a sessão só
para por ação externa (o editor mata o processo). O guard de colisão
editorial (passo 1) **PAUSA**, nunca encerra — diferente do overnight, que
preempta a rodada inteira ao detectar a edição diária em curso.

0. **Sync de master (#5397)** — no início de CADA reentrada neste loop
   (entrada fresca da sessão e cada retomada via wake `/loop`/
   `ScheduleWakeup`), rodar `npx tsx scripts/sync-code.ts` (mesmo wrapper
   fail-soft do #2686 usado no Passo 0 de `/diaria-edicao`: fetch + `git
   checkout master && git pull --ff-only`). **Fail-soft invariável**:
   qualquer falha de sync (offline, divergência, conflito de stash) vira
   warning no log e o loop segue normalmente — nunca bloqueia. Cobre o
   cenário em que outra máquina/sessão mergeou algo enquanto esta sessão
   dormia entre ciclos do loop — sem este passo, um wake abriria worktree a
   partir de um `master` local defasado até o próprio loop mergear algo
   (passo 1, item 6, reusado do overnight), reintroduzindo bugs já corrigidos
   alhures. Não substitui o `git pull` pós-merge do passo 1 (item 6) — este
   passo 0 cobre a janela ANTES do primeiro merge de cada reentrada.

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
   overnight. **`claim-issue` vale pra toda unidade, com ou sem fan-out
   (#5407):** o `claim de issue` citado em "Reuso da maquinaria" acima
   (`claim-issue --kind continuo --issue N`) não é exclusivo do caminho de
   subagente/worktree — a `continuo` tem a mesma estrutura de
   coordenador-resolve-direto pra unidades pequenas que o develop tem
   (mesma correção aplicada lá); reivindicar a issue antes de começar a
   mexer nela vale igualmente quando o coordenador resolve a unidade
   DIRETAMENTE, sem dispatchar subagente/worktree. **Guard de colisão com a
   edição diária (#5293 item 4 — PAUSA,
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
2. **Fila seca** → re-varredura pra pegar issue nova (de terceiro, ou criada
   por finding da própria rodada) — mesma lógica sem cap de `rescans_done`
   que o overnight adotou em #5272 (contador puro de observabilidade, nenhuma
   decisão de parada lê o valor). **Antes de varrer, rodar
   `npx tsx scripts/lib/continuo-plan-rotation.ts check`** (#5293 item 5 —
   rotaciona `plan.json` pro dia civil corrente se ele mudou desde a última
   chamada; no-op na maioria das vezes).

   **Varredura incremental, não full-rescan (#5344 Parte B6, 15/08/2026).**
   Em vez de `gh issue list --state open` do zero a cada ciclo (31 issues
   abertas reclassificadas do zero toda vez, medição de 15/08/2026), usar
   `gh issue list --state open --json number,title,labels,updatedAt --search
   "updated:>={last_scan_at}"` — `{last_scan_at}` é o campo novo em
   `plan.json` (ISO 8601, gravado ao fim de cada varredura bem-sucedida,
   ausente/vazio na 1ª rodada do dia = tratar como full-scan). Issues que não
   mudaram desde `last_scan_at` reusam a classificação já cacheada em
   `plan.json` (o mesmo cache que o `batch_approval`/`batch` do passo 1 já
   usa) — só o delta retornado pela busca é reclassificado. Issue fechada
   entre varreduras não aparece no `--search` incremental por não ter
   `updated:>=`; o passo 2 já lida com isso indiretamente (issue fechada não
   volta a ser candidata a dispatch, então não precisa de tratamento
   especial aqui). Gravar `last_scan_at = now()` ao fim da varredura, mesmo
   quando o delta veio vazio (idempotente — evita re-scan do mesmo intervalo
   no próximo ciclo).
3. **Ainda seca** → heartbeat `--phase varrendo-bloqueadas`, varrer o backlog
   **bloqueado** (issues `bloqueada-externa` na classificação do overnight —
   credencial-runtime, conta-externa, decisão-produto,
   supervisão-blast-radius, plataforma-sem-fix, mesma taxonomia cat. A-E do
   develop) e montar um lote de perguntas: para cada issue bloqueada, qual
   decisão/credencial/confirmação exata a destravaria.

   **Checklist obrigatório de classificação, issue por issue (#5376,
   15/08/2026) — nunca agrupar em prosa vaga.** Antes de decidir ir pro passo
   6 (ocioso), CADA issue que sobrou na fila desbloqueada precisa ser
   classificada explicitamente numa das 3 categorias abaixo — "não sei o que
   fazer com isso agora" **não é** sinônimo de "está bloqueada"; ler o corpo
   da issue inteiro antes de rotular, o atalho barato que causou o #5376 foi
   rotular pelo título/label sem checar se o corpo já descreve um caminho de
   execução:
   - **(a) Acionável agora** — nenhuma decisão nem credencial falta (mesmo
     que pareça só "investigação"/"scoping": se o corpo da issue já descreve
     os passos, é trabalho, não pergunta). Volta pro passo 1 (dispatch)
     imediatamente — **nunca** descartada silenciosamente nem empurrada pro
     lote de perguntas.
   - **(b) Decisão de produto pendente** — critério 2 do "Perguntar é
     exceção" (CLAUDE.md): duas opções que mudam a experiência do leitor e
     cuja escolha não está documentada em lugar nenhum. Vai pro lote de
     `AskUserQuestion` do passo 4.
   - **(c) Bloqueio genuíno não-decisão** — credencial-runtime, conta
     externa, ação humana fora do repo (inclusive prospecção/contato com
     terceiros no mundo real). **Aplicar a label `external-blocker`**
     (`gh issue edit N --add-label external-blocker`, se ainda ausente — #5462 — **ressalva #6196: `route-issue` (`npx tsx scripts/route-issue.ts --issue N --track bloqueada`) substitui isso quando mergeado; até lá, `gh issue edit` ainda aceitável**)
     #5462/#5533: sem ela a Triagem do Studio não enxerga a issue como
     Bloqueada, mesmo racional do `trade-off-real` no lote de perguntas do
     passo 4) na mesma respiração do comentário na issue registrando
     exatamente o que falta; categoria **distinta** de (b) em qualquer
     comunicação —
     nunca o mesmo rótulo vago ("bloqueada") cobrindo as duas.

   Só entra no lote de perguntas do passo 4 quem foi classificado em (b).
   Quem foi classificado em (c) recebe comentário aqui mesmo, no passo 3, e
   não aparece no `AskUserQuestion`. Uma issue mal-classificada em (b)/(c)
   quando na verdade era (a) é o próprio bug do #5376 — na dúvida entre (a) e
   as outras duas, reler o corpo antes de desistir dela.

   **Issue com checklist/múltiplos itens: classificar item por item, nunca a
   issue inteira de uma vez (#5379, 15/08/2026)** — o #5376 corrigiu
   classificação issue-a-issue; o #5379 achou o mesmo atalho um nível abaixo,
   *dentro* de uma issue só. Duas issues reais (#4555, #5237) foram jogadas
   inteiras em (c) porque continham 1 item genuinamente bloqueado misturado
   com itens (a)/(b) independentes. Antes de rotular uma issue com corpo em
   lista/checklist como (c): percorrer cada item separadamente e classificar
   cada um nas mesmas 3 categorias acima. Itens sem decisão nem credencial
   pendente **voltam pra (a)** e são dispatchados normalmente — nunca ficam
   presos ao rótulo do item bloqueado. Só os itens que de fato dependem do
   bloqueio ficam em (c). O resultado normal é dispatch **parcial**: unidade
   cobrindo só os itens (a) da issue, mais comentário registrando o(s)
   item(ns) (c) que segue(m) faltando — não é preciso esperar o bloqueio
   resolver pra fazer a parte que já dá. Mesmo tratamento vale se um item
   isolado (não em lista) for, na verdade, dois problemas colados: separar
   antes de rotular.

   **Grep textual antes de classificar em (c) (#5379) — heurística de
   atenção, não substitui ler o corpo.** Antes de fechar um item como (c),
   buscar no corpo daquele item por sinais de decisão embutida: "a escolha é editorial",
   "decidir", frase interrogativa com "qual"/"quanto"/"quando", "trade-off".
   Qualquer acerto é motivo pra reler aquele trecho com atenção — pode ser
   (b) disfarçado de (c), como o #4555 (perfil de parceiro + orçamento de
   slot editorial, ambos decisão pendente, classificados como "só ação
   humana"). Isto é um lembrete de dupla-checagem pro coordenador, não um
   parser automático — não dispensa a leitura do corpo inteiro.

   **Verificação de estado antes de classificar qualquer item como
   bloqueado — (b) decisão de produto pendente ou (c) bloqueio genuíno
   (#5383, generalizado em #5392).** "Escopo grande, scoping futuro" **não é
   uma 4ª categoria** — é sempre uma leitura que se resolve em (c), nunca um
   status paralelo a (a)/(b)/(c). Nenhuma dessas leituras é automática a
   partir da leitura fácil do item — o #5383 original restringia a
   verificação só ao caso "escopo grande, scoping futuro"; o #5392 achou o
   mesmo atalho em qualquer classificação de bloqueio (achado concreto:
   #5255 classificada como bloqueio (`local`) sem checar
   `docs/audience-source-notes.md`, que já tinha a decisão completa
   registrada 2 dias antes da issue existir). Antes de aceitar qualquer
   classificação de bloqueio pra um item — (b) ou (c) (inclusive quando a
   leitura inicial for "escopo grande demais") — rodar as 4 checagens
   abaixo:
   1. `gh issue view N --json comments` — ler os comentários mais recentes
      **por inteiro**, não só o `body`. Procurar menção a PR já mergeado,
      unidade já dispatchada, ou progresso parcial registrado.
   2. `git log --oneline --all --grep "#N"` — trabalho já mergeado costuma
      citar o número da issue no commit message mesmo quando o comentário na
      issue não foi lido a tempo.
   3. Se algum comentário citar um doc de acompanhamento (`docs/*.md`), ler
      esse doc **inteiro** — a convenção deste repo é fechar cada rodada de
      trabalho com uma seção "estado após esta rodada"/"candidatas pra
      próxima rodada" já pronta (ex real: `docs/entity-page-candidates.md`).
   4. **`grep -il {palavra-chave do título/tema} docs/*.md`** — buscar um
      doc relacionado ao ASSUNTO do item, mesmo sem link em nenhum
      comentário (o #5255 nunca citou `docs/audience-source-notes.md`).
      CLAUDE.md já documenta esse padrão de doc como "registro de decisão
      que evita reabrir investigação já concluída" (`docs/seo-notes.md`,
      `docs/audience-source-notes.md`). Achou um doc relacionado → ler **por
      inteiro** antes de aceitar a classificação de bloqueio — ele pode
      conter a decisão que torna o item não-bloqueado.

   **Quando pular a checagem 4.** É barata o bastante pra rodar em toda
   classificação de bloqueio (um `grep`, não um fleet de agentes) — o skip
   por label é estreito, não vale a issue inteira: só pula quando o
   `issue-decisions.ts --issue N` (passo seguinte, abaixo) confirma que a
   decisão/bloqueio JÁ REGISTRADO cobre exatamente o motivo de bloqueio
   sendo avaliado agora, não qualquer outro item/sub-pergunta da mesma
   issue. Item isolado sem marker correspondente → roda a checagem 4 mesmo
   com a issue tendo `decisao-registrada`/`bloqueio-execucao` de outro item.

   Só se as 4 checagens não acharem nada (nenhum PR, nenhum comentário de
   progresso, nenhum doc de acompanhamento, nenhum doc relacionado por
   assunto) é legítimo classificar o item como (b) ou (c) — inclusive
   quando o motivo for escopo grande demais pra esta rodada. Caso
   contrário, o próximo passo já está documentado
   — volta pra (a) e dispatcha essa fatia pequena nesta mesma rodada, ou, no
   mínimo, reporta o próximo passo concreto na tabela obrigatória do passo 5
   em vez de aceitar a leitura de bloqueio.

   **Antes de incluir qualquer issue no lote de perguntas (#5373):** rodar
   `npx tsx scripts/lib/issue-decisions.ts --issue N` (`scripts/lib/issue-decisions.ts`)
   — se a issue tem a label `decisao-registrada` ela quase certamente tem
   marcador, mas checar mesmo sem a label (rede de segurança: label pode
   faltar em decisão gravada por outra skill antes deste PR). **Comparação
   concreta, não estimativa:** "última mudança observável" = o campo
   `updatedAt` da issue — o mesmo já buscado pela varredura incremental do
   passo 2 (`gh issue list ... --json number,title,labels,updatedAt`); se
   esta issue não veio nesse fetch (ex: varredura full-scan sem `updatedAt`
   no field-list), rodar `gh issue view N --json updatedAt` antes de
   comparar. Decisão encontrada com `decided_at` **posterior** a `updatedAt`
   → **não** entra no lote — a decisão já existe; usar como
   contexto e tratar a issue pelo que falta de fato (elegível se só faltava a
   decisão; segue bloqueada se a execução esbarra em algo novo e distinto da
   decisão em si, sem reabrir a pergunta). Corpo/labels mudaram genuinamente
   depois de `decided_at` → decisão pode estar desatualizada, incluir no
   lote normalmente. Isto vale tanto pra varredura completa quanto pra
   incremental do passo 2 — issue que não mudou desde `last_scan_at` e já
   tem decisão registrada nunca deveria ter voltado ao lote de qualquer
   forma.

   **Bloqueio de execução já registrado (#5373 item 5) — separar "falta
   decisão" de "falta execução".** O mesmo comando acima também devolve
   `execution_block` (via `latestExecutionBlockFor`). Issue com label
   `bloqueio-execucao` (ou sem ela, rede de segurança) cujo
   `execution_block.recorded_at` é **posterior ou igual** a `updatedAt` →
   **nunca** entra no lote de perguntas nem é reclassificada como (b)
   decisão-produto — a decisão já existe (se houver `decision` também no
   retorno) e o que falta é só a execução: classificar como (c) bloqueio de
   execução/ação humana, reportando "bloqueada por execução:
   {execution_block.motivo}" na tabela do passo 5, com a decisão preservada
   no contexto pra quando o bloqueio for resolvido fora da sessão. Corpo/
   labels mudaram genuinamente depois de `recorded_at` → o bloqueio pode ter
   sido resolvido, reavaliar normalmente antes de assumir que segue preso.
3a. **Classificar cada issue via `classifyExecTrack` e reportar divergência (#6204, mesmo desenho do passo 4a do overnight/#5708 do develop) — consome o módulo canônico em vez de manter julgamento próprio.** A taxonomia a/b/c acima **não** é o mesmo vocabulário do overnight — é mais enxuta (3 categorias contra os 6-7 status em prosa do overnight), porque `continuo` resolve (b) direto via `AskUserQuestion` no mesmo ciclo em vez de bounce pro develop (é sessão sempre-presente-ou-notificada, não overnight desassistido). A correspondência com `ExecTrack` usa a MESMA tabela do overnight (`scripts/lib/overnight-prose-track-map.ts`) sob este mapeamento: **(a) Acionável agora → `elegivel`** (`expectedTracksForProseStatus("elegivel")` = `overnight`); **(b) Decisão de produto pendente → `precisa-resposta`** (efêmera igual — `tracks: []`, nunca compara enquanto a pergunta está pendente; comparar de novo depois que o passo 5 gravar `decisao-registrada`, quando ela vira `elegivel`); **(c) Bloqueio genuíno não-decisão → `bloqueada-externa`** (`bloqueada`, via `external-blocker`). Pra cada issue já classificada em (a)/(b)/(c), rodar `classifyExecTrack({ labels, body, state })` de `scripts/lib/issue-exec-track.ts` (puro) e comparar contra o `ExecTrack` esperado pela categoria via `isProseTrackConsistent`. Gravar `exec_track_painel`/`exec_track_divergiu` por issue em `issues[]` do `plan.json` (o mesmo campo, mesmo formato do overnight — `continuo` reusa o schema dele). **Gate de cobertura antes de dormir (passo 5, junto do gate de re-triagem):** `npx tsx scripts/check-exec-track-coverage.ts --plan data/continuo/{AAMMDD}/plan.json` — `exit 1` lista issues sem o campo ou com valor fora do enum; backfill mecânico até `exit 0`. **Isto fecha o item 3 do #5376 citado acima como "deliberadamente fora de escopo"** — não porque `plan.json` ganhou um schema NOVO pra a/b/c (continua sem), mas porque `exec_track_painel` já é o enum estruturado que faltava: qualquer divergência entre a categoria a/b/c em prosa e o veredito mecânico de `classifyExecTrack` agora é auditável campo-a-campo, sem depender só da tabela textual do passo 5 abaixo.
4. **Perguntar** → heartbeat `--phase aguardando-resposta` **ANTES** de
   chamar `AskUserQuestion` (não depois — o watchdog pode rodar entre os dois
   passos; o heartbeat precisa estar gravado antes que a chamada bloqueie),
   agrupado por issue, **máximo 4 perguntas por chamada**, **sempre com a
   opção "decido depois (pular esta issue)"** — mesmo formato do briefing do
   overnight (Fase 0, passo 5), só que aqui pode se repetir a cada ciclo em
   vez de acontecer uma vez só no início. O hook
   `.claude/hooks/notify-continuo-askuserquestion.mjs` (#5293, achado do
   "Risco aceito" abaixo) dispara e-mail automaticamente nesta chamada (canal
   definido em #5341) — não precisa de nenhuma ação extra do coordenador além do heartbeat já
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

   **Registro machine-readable da decisão (#5373).** O comentário começa com
   o marcador de `formatDecisionMarker` (`scripts/lib/issue-decisions.ts`,
   `{decided_at, pergunta, resposta, sessao: "continuo"}`) antes da prosa de
   sempre — a prosa não muda, o marcador é só o prefixo. Junto: `gh issue
   edit N --add-label decisao-registrada`; e apender no CORPO da issue `>
   Decidido em {data}: {resposta breve}` logo após o trecho que fazia a
   pergunta (ou no fim do corpo, se não houver trecho localizável) — é o
   corpo que a próxima varredura (desta ou de outra sessão) lê primeiro, e
   fechar o loop ali é o que evita a mesma pergunta reaparecer mesmo se o
   parsing do marcador falhar por algum motivo.

   **Registro do bloqueio de execução, quando distinto da decisão em si
   (#5373 item 5).** Se, ao implementar (passo 5 acima) uma issue já
   decidida, a execução esbarrar num impedimento novo que esta sessão não
   controla (acesso a painel de terceiro, guard de publicação da `continuo`
   proibindo envio real, feature gated por plano de plataforma), gravar
   isso como estado durável em vez de deixar a issue voltar pra fila com
   cara de "decisão pendente": comentário começando com o marcador de
   `formatExecutionBlockMarker` (`scripts/lib/issue-decisions.ts`,
   `{recorded_at, motivo, sessao: "continuo"}`) seguido de prosa explicando
   o que falta; **usar `route-issue`** (`npx tsx scripts/route-issue.ts --issue N --track bloqueada --reason "bloqueio-execucao"` — #6196: substitui `gh issue edit N --add-label bloqueio-execucao` que nunca tinha chamador no write-path das SKILLs; até #6196 mergear, `gh issue edit` ainda aceitável); classificar
   como (c) bloqueio de execução na tabela do passo 5 abaixo, nunca reabrir
   a pergunta da decisão em si.
   **Tabela obrigatória antes de dormir (#5376 fleet review — forcing
   function análoga ao passo 4.5 do overnight).** Um checklist em prosa,
   sozinho, é exatamente o tipo de instrução sem rastro auditável que causou
   o #5376 — o coordenador segue em prosa até a pressão de tempo/contexto
   fazer ele pular. Antes de ir pro passo 6, imprimir uma tabela linha-a-
   linha (issue → categoria (a)/(b)/(c) → ação tomada) cobrindo TODA issue
   remanescente da fila — não um resumo agregado. Uma issue sem linha na
   tabela é, por definição, uma issue não classificada — não pode existir.
   Isto não substitui `plan.json` (que não tem hoje um enum estruturado pra
   isso, item 3 do #5376, deliberadamente fora de escopo), é o artefato
   textual mínimo que dá ao editor algo pra auditar depois, sem o custo de
   desenhar um schema novo.

   **Gate de re-triagem pendente antes de dormir (#5476).** `continuo` nunca
   fecha uma "rodada" com relatório final como overnight/develop — o
   equivalente aqui é o momento logo antes de ir pro passo 6 (dormir): rodar
   `npx tsx scripts/check-state-changed-pending.ts --plan data/continuo/{AAMMDD}/plan.json`.
   Qualquer `route-issue` (`npx tsx scripts/route-issue.ts --issue N --track {agendada|destravada}` — #6196: substitui `gh issue edit N --add-label ...` direto que nunca tinha chamador no write-path das SKILLs; até #6196 mergear, `gh issue edit` ainda aceitável como fallback)
   aplicado fora do fluxo normal de decisão (passo 5 acima), ou claim de
   `session-registry` encerrada/removida manualmente durante o ciclo, deve já
   ter sido registrada na hora com `--add-pending {N}` — este é só o ponto
   onde a pendência é COBRADA antes de dormir. Desde #5706 o mesmo comando
   também roda a re-varredura de convergência: `gh issue list` completo
   contra o `issues[]` já conhecido pelo plano (`continuo` reusa o schema
   do overnight — não grava `goal.target_set`/`goal.tiers`, exclusivos do
   develop; `issues[]` é a ÚNICA fonte de "já conhecido" aqui) — `exit 1` →
   reavaliar dispatch pra cada issue listada (pendência explícita ou nova
   de convergência, mesma tabela linha-a-linha acima) antes de prosseguir
   pro passo 6; resolver com `--remove-pending {N}` só depois de reavaliar,
   nunca antes. Cada varredura bem-sucedida grava `goal.last_convergence_scan:
   {at, novas_encontradas}` no `plan.json` — como `goal` não existe no
   schema herdado do overnight, a primeira varredura de cada dia CRIA esse
   objeto só com esse campo (a rotação diária, `scripts/lib/continuo-plan-rotation.ts`,
   não carrega `goal` adiante — só `bugs_only`/`priority_filter`/
   `idle_scan_streak`/`last_scan_at`, ver `SESSION_SCOPED_FIELDS` — então
   `goal.last_convergence_scan` reseta a cada rotação de dia, mesmo em
   sessão contínua). Sem `gh`/rede, degrada sozinho pra só a pendência
   explícita (fail-soft #738) — o stdout de sucesso nesse caso é explícito
   que a re-varredura NÃO rodou, nunca afirma "nenhuma issue nova fora da
   varredura" sem ter checado.
6. **Sem resposta** → heartbeat `--phase aguardando-resposta` (se ainda não
   estava nessa phase — idempotente repetir) e dormir (`ScheduleWakeup` com
   `delaySeconds: 3600`, ver "Cadência do wake em modo ocioso" acima); ao
   acordar, re-checar primeiro o guard de colisão editorial do passo 1 (se
   uma edição entrou em curso enquanto dormia, heartbeat `--phase
   pausado-edicao` e continuar dormindo) e então aplicar o corte de 4h
   descrito acima: `now() - last_scan_at < 4h` → wake no-op (heartbeat +
   dormir de novo, sem tocar a fila); `>= 4h` → volta ao passo 1/2 pra
   re-varrer de verdade (a fila desbloqueada pode ter crescido nesse
   meio-tempo). Nunca "termina": a sessão fica viva esperando ou fila nova,
   ou resposta a uma pergunta pendente.

   **Cadência fixa de 3600s + corte de 4h (#5390, 15/08/2026) — substitui o
   backoff progressivo `idle_scan_streak` que existia aqui (#5344 Parte
   B5).** Mecanismo completo, rationale e o clamp `[60, 3600]` do
   `ScheduleWakeup` já estão documentados em "Cadência do wake em modo
   ocioso" (acima, na seção "Integração com `/loop` e `ScheduleWakeup`") —
   não duplicar aqui. Resumo: todo wake ocioso dorme 3600s (fixo, sem
   variação); o que muda com o tempo não é o delay do wake, é se ele faz
   trabalho (varredura de verdade, quando `now() - last_scan_at >= 4h`) ou
   nada (heartbeat + volta a dormir). Ganho equivalente ao backoff antigo —
   numa janela ociosa longa, a maioria dos wakes não paga bootstrap de
   contexto de re-varredura — só que sem contador dedicado nem degraus
   intermediários. O guard de colisão editorial (`pausado-edicao`) não usa
   este corte — cadência de repolling da edição em curso é assunto
   separado, não tratado aqui. **Custo acumulado (#5293 item 6):** ao acordar de um período de
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

**Entrada no modo ocioso exige o checklist do passo 3 completo (#5376) —
nunca por omissão.** Só faz sentido dormir depois que TODA issue
remanescente do backlog bloqueado foi classificada explicitamente em (b)
Decisão de produto pendente ou (c) Bloqueio genuíno — nunca deixada sem
classificação, e nunca as duas categorias fundidas num "decisão de produto,
conta externa, ou ação manual do editor" genérico no resumo/prosa final.
Issue classificada (a) Acionável que não foi dispatchada é bug, não
justificativa válida pra dormir — voltar ao passo 1 antes de considerar a
fila seca.

## Decisões e histórico

Rationale das decisões do briefing (14/08/2026), o risco aceito de
`AskUserQuestion` bloqueante e a mitigação (hook de notificação por e-mail,
canal definido em #5341), e o histórico de
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
