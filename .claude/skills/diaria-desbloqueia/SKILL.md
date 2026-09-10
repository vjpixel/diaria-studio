---
name: diaria-desbloqueia
description: Sessão SÓ DE DESBLOQUEIO — lê a issue inteira (corpo + TODOS os comentários) antes de perguntar, pede ao editor as AÇÕES que destravam issues na hora (bloqueada + fora-de-rodada), faz uma bateria batchada de perguntas, tria o bucket `overnight ·sem sinal`, grava tudo como comentário durável e re-rotea. Não implementa, não abre PR. Uso — `/diaria-desbloqueia [--issues N,M] [--track bloqueada|develop|sem-sinal|fora-de-rodada] [--skip-sem-sinal] [--incluir-engavetadas]`.
---

# /diaria-desbloqueia

Issue de origem: #6628. Pedido direto do editor: uma skill que **só**
pergunta o que falta pra uma issue rodar no `/diaria-overnight` ou no
`/diaria-develop` — sem abrir a sessão inteira de implementação pra isso —
e que **lê a thread inteira antes de perguntar**, pra nunca repetir uma
pergunta já respondida num comentário.

Produto desta skill: a fila fica mais gorda pro `300` (#5751) e o editor
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
   inteiro) e resolve o BUCKET de cada uma via `resolveDesbloqueioEscopo`
   (`scripts/lib/desbloqueia-scan.ts`, sobre `classifyExecTrackWithRule`).
   Entram no escopo:
   - `bloqueada` e `develop` (sempre);
   - `overnight` **com `matched: "default"`** — o bucket que o painel
     Triagem pinta como `·sem sinal`: nenhuma label ou marcador classificou
     a issue, ninguém olhou (#7694);
   - `fora-de-rodada`, **menos** `on-hold`/`wontfix` (#7708).

   Saem em `foraDoEscopo`: `agendada`, `epica`, issue FECHADA, `overnight`
   já triado (`trade-off-real`, `alarm-evento`, `triada-overnight`) e as
   engavetadas — a menos de `--incluir-engavetadas`.
2. Pra cada candidata real, busca **corpo + TODOS os comentários** (não uma
   amostra, não os últimos N), resolve o estado de qualquer dependência
   declarada (#7707) e classifica em 8 grupos —
   `scripts/lib/desbloqueia-scan.ts`, testado em `test/desbloqueia-scan.test.ts`:
   - **`jaDestravadas`** — existe `decisao-editor` mais recente que o
     `updatedAt` da issue. A resposta já está na thread.
   - **`bloqueioConfirmado`** — sem decisão nova, mas existe
     `bloqueio-execucao` recente. O que falta já está documentado (token
     que não chegou, conta que não existe).
   - **`bloqueioObsoleto`** (#7707) — o bloqueio declarava depender de outra
     issue, e essa issue **já fechou**. A condição foi satisfeita; o
     bloqueio não vale mais. Nunca comentar "segue valendo" — rotear pra
     fora de `bloqueada`.
   - **`precisaPergunta`** — nem um nem outro cobre o estado atual. É a
     ÚNICA lista que vira pergunta.
   - **`semSinalNaoTriadas`** (#7694) — candidata `·sem sinal` cuja thread
     não tem marcador nenhum. **Nunca vira pergunta**: não é "falta uma
     resposta do editor", é "ninguém leu esta issue ainda". Vira TRIAGEM
     no Passo 2b — despejar dezenas de issues não-triadas numa bateria de
     `AskUserQuestion` é exatamente o que "Perguntar é exceção" (#5321)
     proíbe.
   - **`acaoImediataCandidatas`** (#7708) — vieram de `fora-de-rodada`
     (alarme de estado, decisão em prosa, sem-direção) e ninguém avaliou se
     existe uma ação do editor que as destrava AGORA. Alimentam o Passo 3b.
   - **`acaoAdiada`** (#7708) — já pedimos a ação e o editor adiou; o
     cooldown ainda vale. **Nunca vira pergunta.** É este grupo que impede a
     skill de repetir as mesmas ~22 perguntas por rodada.
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
npx tsx scripts/desbloqueia-scan.ts --track bloqueada    # 1 bucket (bloqueada|develop|sem-sinal|fora-de-rodada)
npx tsx scripts/desbloqueia-scan.ts --skip-sem-sinal     # sem o bucket ·sem sinal
npx tsx scripts/desbloqueia-scan.ts --incluir-engavetadas  # varre também on-hold/wontfix
```

O bucket `·sem sinal` entra **por default** — é o motivo de a #7694 existir,
e flag de opt-in que ninguém lembra de passar não corrige nada. O custo é
real (medição de 08/09/2026: 26 issues sem sinal contra 9 do escopo antigo,
sobre 68 abertas ⇒ ~4× mais chamadas `gh issue view` na passada 2);
`--skip-sem-sinal` desliga quando o que se quer é só a varredura barata.

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

Para cada issue em `bloqueioConfirmado` **com `escopo` ≠ `"sem-sinal"`**
(ou seja `"bloqueada"`/`"develop"`/`"fora-de-rodada"`): nada muda — o
bloqueio segue de pé e já está documentado. Comentar (curto, sem
`route-issue.ts` — o track já está correto) confirmando que a sessão revisou
e o estado é o mesmo: `Revisado por /diaria-desbloqueia — bloqueio de
execução de {recorded_at} ("{motivo}") segue valendo, nenhuma mudança.`
**Nunca** perguntar de novo O QUE o `bloqueio-execucao` já documenta.

> Isto **não** proíbe o Passo 3b de tocar o mesmo grupo. São perguntas de
> natureza diferente: aqui é *"o que falta?"* — já respondido, não se
> repergunta; lá é *"você pode agir nisso agora?"* — nunca perguntado antes.
> O que blinda contra repetição no Passo 3b é o marcador `acao-adiada`, não
> esta regra.

Para cada issue em `bloqueioConfirmado` **com `escopo: "sem-sinal"`** (#7694):
aqui o estado MUDA, e é o achado de maior valor da varredura — a thread
documenta um bloqueio e a **label está faltando**, então a issue estava
classificada `overnight` e o `300` ia tentar executá-la e falhar.
Comentar não basta: rotear.

```bash
npx tsx scripts/route-issue.ts --issue N --track bloqueada   --reason "{motivo do bloqueio-execucao já registrado na thread}"   # --motivo conta-de-terceiro | plataforma | kit | execucao — conforme a thread
```

Se `dependenciasNaoResolvidas` no relatório não estiver vazio, o estado das
dependências dessas issues **não** foi verificado (`gh` sem rede, token
expirado, issue apagada) — elas aparecem como `bloqueio-confirmado` por
segurança, não por confirmação. Não afirmar "bloqueio segue valendo" pra
elas sem rodar o scan de novo.

Para cada issue em `bloqueioObsoleto` (#7707): a condição de desbloqueio já
foi satisfeita — a issue de que ela dependia fechou. Rotear pra fora de
`bloqueada` (normalmente `overnight`, `develop` se a execução ainda exige o
editor), citando no `--reason` qual dependência fechou. **Nunca** comentar
"bloqueio segue valendo" — ele não segue.

## Passo 2b — triar `semSinalNaoTriadas` (#7694), sem perguntar

Ninguém leu estas issues ainda. Ler título + corpo (o scan já trouxe os
dois) e decidir o track, aplicando "Perguntar é exceção" (#5321) — a
resposta padrão aqui é **decidir e registrar**, não perguntar:

- **Exige a máquina do editor** (Chrome logado, ComfyUI, `data/` local) →
  `route-issue.ts --track develop` (a label `windows` é o sinal).
- **Depende de conta/credencial/plataforma de terceiro** →
  `--track bloqueada` com `--motivo` e `--reason`.
- **Tem trade-off editorial genuíno** (critério 2 do #5321: muda a
  experiência do leitor e nada documentado decide) → `--track overnight
  --motivo trade-off`, que entra na fila de perguntas do briefing (#7493).
  Se o editor já está presente NESTA sessão, é legítimo perguntar aqui em
  vez de empurrar pro briefing — nesse caso a issue migra pra bateria do
  Passo 3.
- **Nada disso: é trabalho mecânico** → `--track overnight --motivo triada`.
  A label `triada-overnight` (#7694) mantém o veredito `overnight` e só
  troca `matched: "default"` por um sinal positivo, pra a issue deixar de
  aparecer como `·sem sinal` e a próxima varredura não retriá-la do zero.

Nunca deixar uma `semSinalNaoTriadas` sem roteamento: a issue voltaria
idêntica na varredura seguinte, e o custo de ler a thread foi gasto à toa.

## Passo 3 — bateria de perguntas (só `precisaPergunta`)

Nenhum outro grupo entra aqui — `semSinalNaoTriadas` (triagem, Passo 2b) e
`acaoAdiada` (cooldown ativo) incluídos. `acaoImediataCandidatas` tem
bateria própria, no Passo 3b.

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

## Passo 3b — pedir AÇÃO IMEDIATA (#7708)

Pedido direto do editor (09/09/2026): quando existe uma ação que **ele**
executa em minutos e que destrava a issue, a skill deve **pedir que ele faça
agora** — não registrar que está bloqueada e seguir.

Vale para dois grupos: `bloqueioConfirmado` (bloqueio documentado) e
`acaoImediataCandidatas` (veio de `fora-de-rodada`). O julgamento é seu, sobre
o texto da thread — o scan não decide isto, porque distinguir "recarregar a
conta" de "a conta volta em 29/09" é leitura de prosa, não regra mecânica.

**Vira pedido de ação imediata** quando o que falta é uma ação do editor no
teclado, agora: reiniciar uma unit caída, recarregar uma conta, colar uma
chave em `.env`/Doppler, virar uma configuração num painel, aprovar algo.

**NÃO vira** — segue como está, com o comentário de revisão do Passo 2:
espera com data (conta de terceiro que retorna em D, `agendada`), plataforma
sem fix disponível, dependência de outra issue ainda aberta, ou qualquer
coisa que o editor não consegue resolver sozinho hoje.

A pergunta é imperativa, não deliberativa — *"faça isto"*, não *"o que
acha?"*. Sempre com o comando/passo exato e as 3 saídas:

> A unit `diaria-reconcile-send-audiences.service` está caída desde 05/09.
> Rodar `systemctl --user restart diaria-reconcile-send-audiences` no
> `300` destrava. Já rodou?
> ( já rodei / agora não / não é isso — o problema é outro )

**Priorização dentro do cap.** `AskUserQuestion` é 4 perguntas × 4 opções por
chamada, e o pool pode passar de 20. Ordenar e CORTAR — nunca despejar 6
chamadas sequenciais:

1. o que está quebrado AGORA e afeta produção (unit caída, sync parado,
   ingest sem execução);
2. o que bloqueia issue `P0`/`P1`;
3. o resto — que fica para a próxima rodada, sem pedido nenhum registrado.

Nunca gravar `acao-adiada` para uma issue que você **decidiu não perguntar**
por causa do cap: o marcador significa "pedi e o editor adiou", e usá-lo pra
"não deu tempo de pedir" criaria um cooldown de 7 dias sobre uma pergunta
que ninguém fez.

## Passo 4 — gravar cada resposta

- **Decisão (cat. C, ou cat. A/B "conta confirmada")**: comentar com o
  marcador de `formatDecisionMarker` (`scripts/lib/issue-decisions.ts`) —
  usar o mesmo helper que `/diaria-develop` já usa, `sessao: "develop"` é
  aceitável mesmo fora daquela skill (o campo documenta QUE TIPO de sessão
  registrou, não literalmente qual comando rodou — não há um valor
  `SessionKind` dedicado pra esta skill e criar um só pra isso quebraria
  todo consumidor existente do enum sem ganho real).
- **Bloqueio de execução novo, descoberto durante esta sessão** (ex:
  editor confirma que a conta NÃO existe): rotear direto pra `--track
  bloqueada` (ver abaixo) — desde #7270, o marcador `formatExecutionBlockMarker`
  é embutido automaticamente pelo `route-issue.ts`, não precisa (nem deve)
  ser postado à mão como comentário separado.
- **Ação imediata executada** ("já rodei"): confirmar com um probe
  determinístico quando existir (a unit está `active`, o alarme parou de
  reproduzir, a var existe) e comentar o RESULTADO do probe. Confirmado,
  rotear pra fora de `bloqueada`/`fora-de-rodada`. **Nunca** registrar
  "resolvido" só porque o editor disse que rodou — é a mesma disciplina do
  #573 (validar estado externo por caminho determinístico antes de afirmar).
- **Ação imediata adiada** ("agora não"): gravar
  `formatAcaoAdiadaMarker` (`scripts/lib/issue-decisions.ts`) com a ação
  pedida e o motivo, se ele deu um. Não rotear nada — o track não mudou. O
  marcador some sozinho depois de `ACAO_ADIADA_COOLDOWN_DAYS` (7 dias) ou
  quando um sintoma novo aparecer.
- **"Não é isso, o problema é outro"**: a ação que imaginamos estava errada.
  Isso é informação de conteúdo, não adiamento — comentar o que o editor
  disse e rotear conforme, **nunca** gravar `acao-adiada` (senão a issue
  fica 7 dias em silêncio por uma pergunta que estava mal formulada).
- **Token colado**: nunca vai pro comentário. Só confirmar via probe
  determinístico (ex: a var existe em `.env`, um script de dry-run passa)
  e comentar o RESULTADO do probe, nunca o valor.
- Em todos os casos, depois de comentar a decisão (ou como único passo,
  pro caso de bloqueio de execução): `npx tsx scripts/route-issue.ts
  --issue N --track {track} --reason "..."` (`--track bloqueada` exige
  `--reason` não-vazio desde #7270; `--sessao develop` opcional) — nunca
  `gh issue edit --add-label` cru (mesma disciplina do #5969, ver
  docstring de `route-issue.ts`).

## Passo 5 — relatório final

**Guard obrigatório antes de escrever qualquer "pronto pro 300"/"fica pro
develop": re-rodar `npx tsx scripts/desbloqueia-scan.ts` (ou, por issue,
reler o label + o comentário `route-issue` mais recente) e citar o campo
`track` retornado — nunca o recall de prosa lida antes ("decisão
registrada" ≠ "track: overnight"). Mesma classe de bug do #573
("validar afirmação sobre estado externo via TS determinístico antes de
relayar pro editor"), aqui aplicada a `classifyExecTrack` em vez de
Beehiiv/LinkedIn/Facebook: um comentário em prosa dizendo "Roteado para
overnight" pode estar desatualizado se o label que a classificação
mecânica lê (ex: `trade-off-real`) não foi removido — foi exatamente o
que aconteceu com #5125 em 260828. Ler "Roteado para develop" e escrever
"pronto pro 300" no relatório é o mesmo erro pelo lado inverso —
substituir o valor mecânico já visível por um padrão genérico
("decisão registrada = resolvido = 300 pega"). Nenhum dos dois é
aceitável: o relatório só pode nomear `300`/overnight para uma issue
cujo `track` mecânico, checado nesta mesma rodada, é `overnight`.

Terminar com um resumo, não uma lista de comandos executados:

```
/diaria-desbloqueia — resumo

Varridas: N candidatas (bloqueada/develop/·sem sinal/fora-de-rodada)
  {A} já destravadas pela thread — re-roteadas sem pergunta
  {B} bloqueio confirmado — sem mudança, comentário de revisão
  {B2} bloqueio documentado com LABEL FALTANDO — roteadas pra bloqueada (#7694)
  {B3} bloqueio OBSOLETO — a dependência já fechou, re-roteadas (#7707)
  {C} perguntadas (o que falta) — {D} respondidas e destravadas, {E} seguem bloqueadas
  {H} AÇÕES IMEDIATAS pedidas (#7708) — {H1} executadas e confirmadas por probe,
       {H2} adiadas (cooldown 7d), {H3} "não é isso" → re-roteadas
  {G} ·sem sinal triadas sem pergunta — {G1} confirmadas overnight (triada-overnight),
       {G2} viraram develop, {G3} viraram bloqueada
  {I} não perguntadas nesta rodada — cooldown de adiamento ativo, ou cortadas pelo cap
  {F} erro de leitura — não foi possível ler a thread, ninguém foi perguntado (rodar de novo: #...)

Pronto pro 300 na próxima rodada: #X, #Y, #Z
Seguem bloqueadas: #W (motivo: ...)
Esperando ação sua: #V (ação: ..., adiada em {data})
```

## Fronteiras

- **Triar não é implementar.** O Passo 2b decide o TRACK de uma issue
  `·sem sinal` e nada mais — nunca começa o trabalho da issue, mesmo quando
  ele é óbvio e pequeno. Issue triada como `overnight` fica pro `300`
  (#5751), sem exceção.
- **Não implementa nada.** Se o editor quiser seguir direto pra
  implementação, esta skill não encadeia sozinha (mesma fronteira do
  #5578, "skills `/diaria-N-*` invocadas isoladamente NUNCA encadeiam pro
  próximo stage") — imprimir `Fila destravada. Rode /diaria-develop ou
  aguarde o /diaria-overnight.` e parar.
- **Não executa a ação imediata no lugar do editor.** O Passo 3b PEDE que
  ele rode o comando; a skill não roda. Se a ação fosse executável por uma
  sessão, a issue não estaria bloqueada — e as que exigem a máquina/conta
  dele são exatamente as que ninguém mais consegue fazer.
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
