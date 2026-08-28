---
name: diaria-desbloqueia
description: Sessão SÓ DE DESBLOQUEIO — lê a issue inteira (corpo + TODOS os comentários) antes de perguntar, faz uma bateria batchada de perguntas ao editor pra destravar issues bloqueadas/cat. C, grava a resposta como comentário durável, re-rotea a issue. Não implementa, não abre PR. Uso — `/diaria-desbloqueia [--issues N,M] [--track bloqueada|develop]`.
---

# /diaria-desbloqueia

Issue de origem: #6628. Pedido direto do editor: uma skill que **só**
pergunta o que falta pra uma issue rodar no `/diaria-overnight` ou no
`/diaria-develop` — sem abrir a sessão inteira de implementação pra isso —
e que **lê a thread inteira antes de perguntar**, pra nunca repetir uma
pergunta já respondida num comentário.

Produto desta skill: a fila fica mais gorda pro `helios` (#5751) e o editor
gasta minutos, não uma sessão inteira, destravando o backlog.

## Requisito central — ler tudo antes de perguntar QUALQUER coisa

Este projeto grava decisão durável em **comentário**, não só no corpo da
issue (`scripts/lib/issue-decisions.ts`, marcadores `decisao-editor` e
`bloqueio-execucao`, #5373). Perguntar sem ler a thread inteira é o exato
desperdício que a política "Perguntar é exceção" (#5321) manda eliminar —
e é o que motivou esta issue: `/diaria-develop`/`/diaria-overnight` já
consultam esses marcadores, mas só depois de abrir uma sessão de
implementação completa.

`npx tsx scripts/desbloqueia-scan.ts` faz essa leitura por você — nunca
pule direto pra `gh issue view` improvisado. Ele:

1. Varre issues abertas (`--issues N,M` restringe; sem flag, backlog
   inteiro) e classifica cada uma via `classifyExecTrack`
   (`scripts/lib/issue-exec-track.ts`) — só `bloqueada`/`develop` entram no
   escopo desta skill (`elegível`/`agendada`/`epica`/`fora-de-rodada` saem
   direto em `foraDoEscopo`, sem leitura de comentário — não há nada aqui
   pra desbloquear).
2. Pra cada candidata real, busca **corpo + TODOS os comentários** (não uma
   amostra, não os últimos N) e classifica em 4 grupos —
   `scripts/lib/desbloqueia-scan.ts`, testado em `test/desbloqueia-scan.test.ts`:
   - **`jaDestravadas`** — existe `decisao-editor` mais recente que o
     `updatedAt` da issue. A resposta já está na thread.
   - **`bloqueioConfirmado`** — sem decisão nova, mas existe
     `bloqueio-execucao` recente. O que falta já está documentado (token
     que não chegou, conta que não existe).
   - **`precisaPergunta`** — nem um nem outro cobre o estado atual. É a
     ÚNICA lista que vira pergunta.
   - **`erroLeitura`** — a busca de comentário FALHOU pra essa issue (`gh`
     deu erro, JSON malformado). Nunca vira `precisaPergunta` mesmo que a
     lista de comentários tenha vindo vazia — `[]` por falha de leitura é
     indistinguível de `[]` genuíno se não fosse por esse grupo separado, e
     tratar os dois igual furaria a garantia central da skill. **Nunca
     perguntar sobre issue neste grupo** — reportar o erro (`commentsFetchError`)
     no relatório final e sugerir rodar o scan de novo.

Rodar:

```bash
npx tsx scripts/desbloqueia-scan.ts                    # backlog aberto inteiro
npx tsx scripts/desbloqueia-scan.ts --issues 123,456    # só essas issues
npx tsx scripts/desbloqueia-scan.ts --track bloqueada    # só issues bloqueada (ou develop)
```

**Nenhuma pergunta é feita antes deste comando rodar e seu output ser lido
por completo.** Se `erroLeitura` não estiver vazio, rodar o scan de novo
pras issues afetadas (`--issues`) antes de seguir — não é seguro perguntar
sobre elas até a leitura funcionar.

## Passo 2 — resolver `jaDestravadas` e `bloqueioConfirmado` sem perguntar

Para cada issue em `jaDestravadas`: a decisão já registrada resolve o
trade-off (ler `decision.resposta`/`decision.pergunta` no output do scan).
Decidir o track pós-decisão do mesmo jeito que `/diaria-develop` já faz ao
fechar cat. C (`.claude/skills/diaria-develop/SKILL.md`, "Antes de
classificar como cat. C") — normalmente `develop` (se a execução em si
ainda exige julgamento/máquina do editor) ou `overnight` (se, resolvido o
trade-off, o resto é mecânico). Rotear:

```bash
npx tsx scripts/route-issue.ts --issue N --track {develop|overnight} \
  --reason "decisão já registrada em comentário anterior — reclassificando sem nova pergunta (#6628)"
```

Para cada issue em `bloqueioConfirmado`: nada muda — o bloqueio segue de
pé e já está documentado. Comentar (curto, sem `route-issue.ts` — o track
já está correto) confirmando que a sessão revisou e o estado é o mesmo:
`Revisado por /diaria-desbloqueia — bloqueio de execução de {recorded_at}
("{motivo}") segue valendo, nenhuma mudança.` **Nunca** perguntar de novo o
que o `bloqueio-execucao` já documenta.

## Passo 3 — bateria de perguntas (só `precisaPergunta`)

Agrupar por tipo, igual à Fase 0.5 do develop (#2966) — cap de 4 perguntas
× 4 opções por chamada de `AskUserQuestion`, várias chamadas sequenciais se
precisar:

1. **Credenciais/tokens** (cat. A) — uma pergunta por credencial faltando,
   pedindo confirmação de que foi colada em `.env`/Doppler (`npm run
   sync-env`) — **nunca** peça o valor do secret na pergunta nem aceite
   colar o valor na resposta; a pergunta é "já colou a chave X? (sim/ainda
   não/não sei onde pegar)". Rastrear no `.env.example` qual var cada issue
   referencia antes de perguntar.
2. **Confirmação de conta de terceiro** (cat. B) — "a conta em {plataforma}
   já existe? (sim, cola os IDs relevantes na resposta / ainda não)".
3. **Trade-offs editoriais** (cat. C) — a pergunta central desta skill.
   Resumir em 2-3 linhas o que já foi lido na thread (contexto suficiente
   pra o editor decidir sem reabrir a issue no GitHub) e apresentar as
   opções como estão na issue — nunca inventar opção não mencionada.
4. **Blast-radius/autorização de gasto real** (cat. D/E-com-custo) —
   critério 3/1 do #5321: só pergunta quando há gasto real ou ação
   irreversível envolvida.

**O que NÃO entra aqui** — tudo que a política #5321 já resolve por
default (ambiguidade trivial, deferimento vago, confirmação pós-sucesso).
Se uma issue `precisaPergunta` na verdade bate um dos defaults automáticos
da política, aplicar o default e rotear, sem gastar turno de pergunta.

## Passo 4 — gravar cada resposta

- **Decisão (cat. C, ou cat. A/B "conta confirmada")**: comentar com o
  marcador de `formatDecisionMarker` (`scripts/lib/issue-decisions.ts`) —
  usar o mesmo helper que `/diaria-develop` já usa, `sessao: "develop"` é
  aceitável mesmo fora daquela skill (o campo documenta QUE TIPO de sessão
  registrou, não literalmente qual comando rodou — não há um valor
  `SessionKind` dedicado pra esta skill e criar um só pra isso quebraria
  todo consumidor existente do enum sem ganho real).
- **Bloqueio de execução novo, descoberto durante esta sessão** (ex:
  editor confirma que a conta NÃO existe): marcador de
  `formatExecutionBlockMarker`.
- **Token colado**: nunca vai pro comentário. Só confirmar via probe
  determinístico (ex: a var existe em `.env`, um script de dry-run passa)
  e comentar o RESULTADO do probe, nunca o valor.
- Em todos os casos, depois de comentar: `npx tsx scripts/route-issue.ts
  --issue N --track {track} --reason "..."` — nunca `gh issue edit
  --add-label` cru (mesma disciplina do #5969, ver docstring de
  `route-issue.ts`).

## Passo 5 — relatório final

Terminar com um resumo, não uma lista de comandos executados:

```
/diaria-desbloqueia — resumo

Varridas: N issues candidatas (bloqueada/develop)
  {A} já destravadas pela thread — re-roteadas sem pergunta
  {B} bloqueio confirmado — sem mudança, comentário de revisão
  {C} perguntadas — {D} respondidas e destravadas, {E} seguem bloqueadas
       (editor não tinha a resposta agora / cat. B sem conta ainda)
  {F} erro de leitura — não foi possível ler a thread, ninguém foi perguntado (rodar de novo: #...)

Pronto pro helios na próxima rodada: #X, #Y, #Z
Seguem bloqueadas: #W (motivo: ...)
```

## Fronteiras

- **Não implementa nada.** Se o editor quiser seguir direto pra
  implementação, esta skill não encadeia sozinha (mesma fronteira do
  #5578, "skills `/diaria-N-*` invocadas isoladamente NUNCA encadeiam pro
  próximo stage") — imprimir `Fila destravada. Rode /diaria-develop ou
  aguarde o /diaria-overnight.` e parar.
- **Não decide trade-off real no lugar do editor.** É exatamente o que
  esta skill existe pra perguntar — critério 2 do #5321 nunca vira default
  aqui.
- **Nunca escreve segredo em issue/comentário.** Token, chave, senha —
  sempre "confirme que colou em `.env`/Doppler", nunca o valor em texto.
- **Guard de sessão concorrente do overnight/develop (#6509) se aplica.**
  Esta skill não abre worktree nem faz `git checkout`/commit — é
  leitura+comentário via `gh`, então normalmente não colide. Se em algum
  momento precisar tocar o checkout principal (não deveria), respeitar o
  mesmo guard.
