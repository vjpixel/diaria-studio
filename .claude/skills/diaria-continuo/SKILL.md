---
name: diaria-continuo
description: Sessão CONTÍNUA que nunca termina sozinha (#5293) — derivada do overnight, reusa a mesma maquinaria de implementação, mas troca o critério de terminação. ATENÇÃO — esqueleto parcial (itens 1-2 de 6 da issue de origem; ver seção "Itens 3-6" abaixo). NÃO invocar em produção até o watchdog, o guard de colisão editorial, a rotação de plan.json e a instrumentação de custo fecharem. Uso — `/diaria-continuo [--dry-run] [--bugs] [--priority P0,P1,P2,P3]`.
disable-model-invocation: true
model: sonnet
effort: high
---

# /diaria-continuo

> **AVISO — esqueleto parcial (#5293).** Este arquivo foi criado numa unidade
> de escopo deliberadamente reduzido (itens 1-2 de 6 da issue #5293): a
> prosa abaixo descreve o desenho COMPLETO decidido no briefing do editor
> (14/08/2026), mas **partes críticas do mecanismo ainda não existem no
> código** — watchdog que distingue "aguardando resposta" de stall real,
> guard de colisão com a edição diária reavaliado pra sessão que nunca
> termina, rotação de `plan.json`, instrumentação de custo acumulado, e a
> confirmação de que o lote de perguntas de fato dispara Telegram + chat
> bridge do Studio (ver "Risco aceito" abaixo — achado concreto, não
> suposição). **Não invocar esta skill em produção até a issue #5293 fechar
> os itens 3-6** (ver seção dedicada no fim deste arquivo). Este SKILL.md
> existe para que a maquinaria de dispatch (`session-registry.ts`, kind
> `"continuo"`) tenha um alvo documentado — não é luz verde operacional.

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

Esta skill só roda por invocação explícita do editor
(`disable-model-invocation: true`) — o blast radius (merges autônomos em
master, incluindo cat. D depois de uma resposta do editor) exige que a
invocação seja o consentimento, mesmo padrão de `/diaria-overnight` e
`/diaria-remover-votos-pixel`.

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
  `data/continuo/{AAMMDD}/plan.json`. Ver nota sobre rotação na seção "Itens
  3-6" — o formato herdado assume uma rodada que fecha; uma sessão contínua
  precisa de uma política de rotação que ainda não existe.
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
  escopo do item 2, que tocou só `session-registry.ts`).
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
- **Guard de publicação (INVARIANTE, igual a overnight/develop):** editar
  código de publisher é ok; **executar é proibido** — nunca rodar
  `scripts/publish-*`, `clarice-schedule-sends`, `clarice-import-*`,
  `close-poll` ou qualquer script que toque Beehiiv/LinkedIn/Facebook/Brevo
  ao vivo, nem em "teste". Sem exceção — ao contrário do develop, esta skill
  não tem um coordenador supervisionando em tempo real que possa autorizar
  um `--dry-run` de validação de token.

## Loop invariável (nunca encerra por conta própria)

Seis passos, repetidos indefinidamente — a sessão só para por ação externa
(o editor mata o processo, ou o guard de colisão editorial preempta):

1. **Trabalhar a fila desbloqueada** exatamente como o overnight faz hoje
   (ver "Reuso da maquinaria" acima) — 1 merge por vez, disciplina do
   #636/#633/#2959 intacta. Prioridade P0 > P1 > P2 > P3, mesmo critério do
   overnight.
2. **Fila seca** → re-varredura (`gh issue list --state open`) pra pegar
   issue nova (de terceiro, ou criada por finding da própria rodada) — mesma
   lógica sem cap de `rescans_done` que o overnight adotou em #5272 (contador
   puro de observabilidade, nenhuma decisão de parada lê o valor).
3. **Ainda seca** → varrer o backlog **bloqueado** (issues `bloqueada-externa`
   na classificação do overnight — credencial-runtime, conta-externa,
   decisão-produto, supervisão-blast-radius, plataforma-sem-fix, mesma
   taxonomia cat. A-E do develop) e montar um lote de perguntas: para cada
   issue bloqueada, qual decisão/credencial/confirmação exata a destravaria.
4. **Perguntar** via `AskUserQuestion`, agrupado por issue, **máximo 4
   perguntas por chamada**, **sempre com a opção "decido depois (pular esta
   issue)"** — mesmo formato do briefing do overnight (Fase 0, passo 5), só
   que aqui pode se repetir a cada ciclo em vez de acontecer uma vez só no
   início.
5. **Resposta recebida** → postar como **comentário durável na issue**
   (`gh issue comment` — `plan.json` é cache, o comentário é a fonte de
   verdade, mesmo princípio do overnight), promover a issue a elegível, **e
   implementar** (volta ao passo 1). Blast radius da implementação: **tudo
   que a resposta destravar, inclusive cat. D (blast radius alto), sem gate
   adicional** — a resposta do editor É o consentimento, mesmo princípio de
   `disable-model-invocation: true` e da regra de auto-merge em sessão
   interativa (#5251).
6. **Sem resposta** → dormir e re-varrer periodicamente (a fila desbloqueada
   pode ter crescido nesse meio-tempo — voltar ao passo 1 se sim). Nunca
   "termina": a sessão fica viva esperando ou fila nova, ou resposta a uma
   pergunta pendente.

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
| **Kind no `session-registry.ts`** | **`"continuo"`, dedicado** (#5293 item 2, implementado nesta unidade) | Não reusa `"overnight"` — preserva o guard `block-askuserquestion-overnight-autonomous.mjs`, que depende de "overnight nunca pergunta". |

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
- **Mitigação PRETENDIDA — status real investigado nesta unidade, NÃO
  assumido:** a issue original cita `scripts/lib/telegram-notify.ts` e o
  `gate-chat-bridge.js` do Studio (#3557/#3617/#3804) como já existentes e
  suficientes. Achado desta unidade (leitura direta do código, não suposição):
  - **`scripts/studio-ui/studio-telegram-notify.ts`** já dispara notificação
    Telegram sempre que há um `AskUserQuestion`/decisão de tool pendente em
    `chatPermissionsPending` (`studio-chat.ts`), **genérico por natureza —
    não checa de onde veio a pergunta**. **Mas** `chatPermissionsPending` só
    é populado por sessões de chat abertas **através do próprio drawer do
    Studio** (`studio-chat.ts`, via SDK com um `canUseTool` customizado
    ligado àquela sessão específica) — **não** é um hook global que observe
    qualquer sessão arbitrária do Claude Code rodando num terminal comum.
  - **`scripts/studio-ui/public/gate-chat-bridge.js`** correlaciona um
    gate pendente do cockpit (`gatesPending`, de `GET /api/editions/:aammdd`
    — Stage 4/Stage 6 de uma **edição**) com um card pendente no chat — é
    especificamente sobre gates **editoriais**, não sobre uma
    `AskUserQuestion` genérica de uma sessão de backlog de issues.
  - **Conclusão, registrada como pendência explícita (não resolvida nesta
    unidade):** a decisão do briefing foi rodar `/diaria-continuo` **no
    terminal** (ver tabela acima). Se a sessão for de fato invocada num
    terminal comum (não através do chat drawer do Studio), **nem
    `telegram-notify.ts` nem `gate-chat-bridge.js` disparam automaticamente**
    para o `AskUserQuestion` do passo 4 do loop — os dois mecanismos cobrem
    um caminho diferente (chat drawer + gates editoriais), não o caminho que
    esta skill de fato usa. Fechar esta lacuna requer OU (a) rodar
    `/diaria-continuo` através do chat drawer do Studio em vez do terminal
    (contradiz a decisão "no terminal" da tabela acima — precisaria de nova
    decisão do editor), OU (b) wiring novo — algum sinal que a sessão de
    terminal emita e que `studio-telegram-notify.ts` (ou um watcher
    equivalente) consiga observar. **Nenhuma das duas foi implementada nesta
    unidade** — ver "Itens 3-6" abaixo, item watchdog (mais próximo, mas não
    idêntico).

## Argumentos

Mesmos aceitos por `/diaria-overnight`, mesma semântica (aplicam-se à
varredura de issues, não ao loop de terminação — que não é opcional):
`--dry-run`, `--bugs`, `--priority P0,P1,P2,P3`. Ver
`.claude/skills/diaria-overnight/SKILL.md` seção "Argumentos" pro
comportamento exato de cada um.

---

## Itens 3-6 — PENDENTES, não implementados nesta unidade (#5293)

Esta unidade implementou **só os itens 1 e 2** da issue #5293 (este
SKILL.md + o kind `"continuo"` em `scripts/lib/session-registry.ts`). Os
quatro itens abaixo são trabalho de implementação real, TODO explícito —
**não fingir que estão resolvidos só porque este arquivo os descreve em
prosa**:

1. **Watchdog (`Diaria-Overnight-Watchdog`, `scripts/overnight-watchdog.ts`)
   precisa distinguir "parada esperando resposta do editor" (passo 4/6 do
   loop — saudável) de stall real (subagente travado, CI que nunca resolve,
   sessão morta). Sem isso, uma sessão `/diaria-continuo` saudável parada no
   passo 6 (dormindo, aguardando resposta a uma pergunta) dispara alarme de
   stall como se fosse o incidente que o watchdog existe pra pegar.
   Direção provável (não implementada): um estado explícito no heartbeat do
   registry (`phase: "aguardando-resposta"`, análogo ao `phase: "autonomous"`
   já usado pelo marker do overnight) que o watchdog trate como não-stall.
2. **Interação com `Diaria-Edicao-Diaria`** (task dom-qui 16:00 BRT, roda
   `/diaria-edicao {D+1} --skip newsletter,linkedin,facebook`). Definir se a
   sessão contínua pausa merges durante a janela da edição, ou se o merge
   lock existente (`acquireMergeLock`/`releaseMergeLock`, já reusado por esta
   skill — ver "Reuso da maquinaria" acima) já basta. O guard de colisão
   editorial do overnight (`find-current-edition.ts`, que preempta a Fase 1
   quando uma edição está em curso) precisa ser reavaliado especificamente
   pra uma sessão que **nunca encerra** — o overnight trata preempção como
   fim de rodada (`preempted_by: "edicao_editorial"`); uma sessão contínua
   precisaria decidir se isso é "fim" ou "pausa temporária que retoma depois".
3. **Rotação de `plan.json`.** O formato herdado do overnight
   (`data/continuo/{AAMMDD}/plan.json`, ver "Reuso da maquinaria" acima)
   assume uma rodada que fecha num dia. Uma sessão que nunca termina cruza
   múltiplos dias — definir política de rotação (por dia? por N issues
   processadas?) e como o rótulo `{AAMMDD}` do diretório se comporta quando a
   sessão segue viva além da meia-noite (o overnight já lida com "cruza a
   meia-noite" fixando `{AAMMDD}` uma vez no início da rodada; aqui não há
   "início da rodada" — a sessão é, por desenho, sempre "em andamento").
4. **Instrumentação de custo acumulado.** "Sem limites" é o mandato (mesmo
   principle do overnight, #2039), mas um coordenador `sonnet`/`high` rodando
   indefinidamente é o maior consumidor de token por rodada de qualquer fluxo
   deste repo (#3453 já identificou isso pro overnight, que ao menos tem fim).
   Reusar `coordinator_tokens_estimate` (já emitido pelo overnight ao fim de
   cada fase, ver `.claude/skills/diaria-overnight/SKILL.md` passo 1) e expor
   consumo acumulado **por ciclo** (não só por fase) — pra o editor ter o
   número real antes de decidir se quer impor um teto explícito a esta skill
   (que hoje não tem nenhum).

**Nenhum destes quatro itens bloqueia a existência deste arquivo** — a issue
#5293 pediu explicitamente escopo reduzido pra esta unidade. Eles bloqueiam,
sim, **rodar esta skill em produção** (ver aviso no topo do arquivo).
