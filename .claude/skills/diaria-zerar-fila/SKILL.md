---
name: diaria-zerar-fila
description: Rodada de EXAUSTÃO da fila de issues, com o editor acordado só no começo (#7289). Briefing em 2 rodadas enquanto ele está disponível, depois trabalho autônomo até toda issue aberta ter desfecho — fechada por PR mergeado, ou aberta com bloqueio nomeado e rota corrigida. Topologia de 1 coordenadora + N executoras conversando por SendMessage. Esta skill é o CONTRATO; o motor é o `/goal` embutido, que faz a sessão continuar entre turnos — invocar como `/goal Siga a skill /diaria-zerar-fila. Condição: ...`, em auto mode. Ver seção "Como invocar".
disable-model-invocation: true
model: opus
effort: high
---

# /diaria-zerar-fila

Rodada de exaustão: o editor está acordado só no início. Você faz **todas** as perguntas de uma vez, e depois trabalha a noite inteira sozinho.

Derivada da rodada ad-hoc de 02–03/09/2026, que fechou 166 issues. As correções aplicadas aqui, e a evidência de cada uma, estão na **#7289** — leia se for mudar o contrato.

---

## Como invocar — esta skill é o CONTRATO, o `/goal` é o MOTOR

**Não invoque esta skill sozinha para uma rodada noturna.** Ela descreve o que fazer; ela não faz a sessão continuar trabalhando entre turnos.

`/goal` é comando **embutido** do Claude Code: um Stop hook de escopo de sessão que, ao fim de cada turno, manda a condição e a conversa a um modelo avaliador. Se ele julgar a condição não cumprida, **Claude começa outro turno em vez de devolver o controle**. Quem decide o fim é um avaliador separado, não o modelo que está trabalhando — e é isso que uma skill não reproduz.

Invocação correta, em **auto mode**:

```
/goal Siga a skill /diaria-zerar-fila. Condição: rodar
`npx tsx scripts/fetch-open-issues-for-triage.ts` e toda issue aberta ter
desfecho (a) fechada por PR mergeado em master ou (b) aberta com comentário
DESTA rodada nomeando o bloqueio concreto. Ou parar após N turnos.
```

Três coisas que a mecânica do `/goal` impõe ao contrato desta skill:

1. **O avaliador não roda comandos nem lê arquivos** — julga só o que apareceu na conversa. Por isso a varredura final (`fetch-open-issues-for-triage.ts`) não é formalidade: **é o que torna a condição verificável**. Sem ela no transcript, o avaliador não tem como confirmar o fim.
2. **`/goal` não muda o modo de permissão.** Em modo manual ele continua pedindo aprovação a cada tool call, o que inviabiliza a noite desassistida. Rodar em **auto mode**.
3. **Incluir cláusula de parada** (`ou parar após N turnos`) — o avaliador a julga pela conversa, e ela é o freio quando a condição se revela inalcançável.

**Quatro falhas limpam o goal** e exigem `/goal` de novo: falha de autenticação, **crédito esgotado**, estouro de contexto que a auto-compactação não resolveu, e modelo indisponível. Rate limit e servidor sobrecarregado **não** limpam — a rodada sobrevive a eles.

"Crédito esgotado" aqui é a **cota da própria sessão Claude Code**, que por invariante do projeto (#5608) autentica sempre pela assinatura claude.ai. **Não confundir com as contas Codex OAuth do Hermes (#7250)** — sistema de delegação separado, consumido por cron externo, sem relação mecânica com o `/goal` desta sessão. São dois subsistemas distintos e o mecanismo de um não explica o outro.

**Trabalho em background adia a avaliação:** enquanto subagente ou shell em background estiver rodando, o turno não é avaliado. Há check-in automático após 30min parado, depois 1h, depois a cada 2h. Isso é a favor da rodada — foi o que a sustentou em 02–03/09 —, mas significa que **subagente travado prolonga a rodada em vez de encerrá-la**. Daí a regra de cobrar silêncio prolongado (ver "Protocolo de marcos").

---

## Contrato

### TERMINAL — o que conta como fim

Cada issue aberta termina em:

- **(a) FECHADA** por PR mergeado em master (CI verde + review sem finding de alta confiança), ou
- **(b) ABERTA** com comentário durável **desta rodada** nomeando o bloqueio concreto, e rota corrigida via `npx tsx scripts/route-issue.ts`.

**Fim da rodada** = rodar `npx tsx scripts/fetch-open-issues-for-triage.ts` do zero e toda issue aberta ter um dos dois desfechos. Varredura limpa inteira é o fim; qualquer issue sem desfecho reabre a rodada.

### ALVO VIVO

Issue criada **durante** a rodada — por você, por finding, por alarme ou pelo editor — entra no alvo. Não existe "fica pra próxima".

Finding trivial num arquivo que você já abriu se conserta no próprio PR; não vira issue.

### BRIEFING — só no início, enquanto o editor está acordado

**Rodada 1**, nos primeiros minutos, sem esperar a triagem terminar: os bloqueios já enumeráveis por label e título.

**Rodada 2**, assim que a triagem completa fechar: tudo que a leitura revelou e a rodada 1 não cobriu.

Regras:
- consolidar ao mínimo — agrupar decisões da mesma família numa pergunta só, multi-select quando não forem exclusivas;
- **nunca gastar pergunta com o que dá pra decidir sozinho**;
- a recomendação é sempre a 1ª opção, marcada `(Recomendada)`;
- pedir também o que não é escolha: token, credencial, confirmação de conta, autorização de blast-radius — e **validar credencial na hora** (#573);
- se o editor parar de responder, assumir a recomendada, registrar a premissa e seguir.

Ao fechar o briefing, imprimir o que ficou decidido e o que ficou em (b) por depender dele. É a última coisa que ele lê antes de dormir.

### DEPOIS DO BRIEFING — `AskUserQuestion` proibido

O critério que substitui a pergunta é **reversibilidade**:

| | |
|---|---|
| **Reversível** — código, config versionada, rascunho, label, agendamento 24h+ | decidir, declarar a premissa, seguir |
| **Irreversível pra terceiros** — envio de e-mail/campanha, post publicado, dado apagado sem backup, edição em curso em `data/editions/` | nunca sozinho; vira (b) |

**Exceção explícita ao #738, e SÓ a ele:** MCP offline, CI ou GitHub falhando **não param a rodada**. Registram (b) e seguem, sem halt banner. Exceção consciente para rodada desassistida — não vale fora dela.

**O #3938 continua valendo integralmente, sem exceção.** Ele cobre falha do `AskUserQuestion` — e essa falha só pode acontecer **durante o briefing**, que é justamente a janela em que o editor está presente. Halt banner ali faz mais sentido, não menos: se a pergunta não chegou a ele, seguir com o default significa decidir por ele sem que ele soubesse que havia decisão. CLAUDE.md trata #738 e #3938 como gates de segurança que a política "Perguntar é exceção" não afeta; só o #738 tem exceção sancionada aqui (#7289).

### CLASSIFICAÇÃO NÃO É VEREDITO — e é o passo de maior alavancagem da rodada

**Reclassificar vem ANTES de despachar, e rende mais que qualquer outra coisa.** Numa rodada cujo objetivo é esgotar a fila, o maior ganho não é implementar mais rápido — é descobrir que metade do que parecia inexecutável era executável o tempo todo.

**Taxas medidas, não estimadas** (rodada de 02–03/09/2026):

| track | revisadas | sobreviveram à releitura | erro | auditoria |
|---|---|---|---|---|
| `agendada` | 20 | 9 | **55%** | #7288 |
| `bloqueada` | 12 | 5 | **58%** | #7270 |

**Mais da metade, nos dois.** Isso não é ruído de borda — é viés sistemático do categorizador para o lado errado: ele produz falso "não dá" com muito mais frequência que falso "dá". Toda rodada que aceitar as tracks como veredito deixa metade do alvo na mesa.

**Portanto: trate todo track que não seja `overnight` como SUSPEITO por padrão.** O ônus da prova é de quem afirma que não dá, não de quem quer executar. Ler a issue **inteira** (`gh issue view N --comments` — corpo + TODOS os comentários) e julgar pelo conteúdo antes de aceitar qualquer "não dá agora".

**O categorizador também é alvo.** Se uma track erra sistematicamente, isso é bug, não fato da vida — e entra no alvo vivo como qualquer outro. **#7270** cobre `bloqueada` (label sem razão durável nem reavaliação) e **#7288** cobre `agendada` (marcador `aguardando-ate` usado como estacionamento). Se a releitura desta rodada revelar padrão equivalente em `fora-de-rodada` ou `epica`, abra a issue correspondente em vez de só corrigir caso a caso.

Suspeitas por construção:
- **`fora-de-rodada`** — muitas caem ali só pela label `alarm`, sob a premissa "alarme de estado normaliza sozinho". Condição que persiste há dias e tem remediação de código é bug real.
- **`agendada`** — só data futura viva justifica. Onde só a **medição** depende da data, o código sai hoje.
- **`bloqueada`** — verificar se o bloqueio **ainda existe**: conta já criada, credencial já no Doppler, decisão já respondida em comentário anterior (`scripts/lib/issue-decisions.ts` — nunca repetir pergunta já respondida).

> **Medido em 03/09/2026:** das 12 issues bloqueadas, **7 não estavam bloqueadas** — e em 4 casos a correção já estava escrita em comentário, sem a label ter sido removida. Uma delas teve o bloqueio errado **reafirmado por duas rodadas consecutivas**, cada uma lendo a label em vez do histórico. Ver #7270.

#### A classificação envelhece DURANTE a rodada — reavalie, não só na triagem

Triar uma vez no início não basta: a rodada **muda o próprio estado que a classificação descreve**. Toda issue fechada pode destravar outra, e toda descoberta pode travar uma.

**Gatilhos de reavaliação — sempre que um destes acontecer, revise quem ele afeta:**

| gatilho | o que revisar |
|---|---|
| **issue fechada nesta rodada** | quem a citava como dependência ou pré-requisito |
| **PR mergeado** | issues cujo bloqueio era "o código não existe" |
| **resposta do editor no briefing** | issues em `bloqueada` por decisão pendente |
| **credencial/conta destravada** | issues em `external-blocker` que dependiam dela |
| **descoberta de bloqueio novo** | a issue em execução passa a (b), com o bloqueio nomeado |

**Ao reavaliar, corrigir o MECANISMO, não só a prosa.** Comentário explicando que o bloqueio caiu **não desbloqueia nada** — `classifyExecTrack` lê a label. Remover a label e rodar `npx tsx scripts/route-issue.ts` é o que muda o estado.

> **É a falha mais cara da rodada anterior.** A #7124 teve a dependência (#6798) fechada às 22:14 **no meio da rodada**, e a label ficou — a issue virou mecanicamente invisível enquanto uma sessão já a implementava. Em quatro outros casos a correção estava escrita em comentário e a label continuou posta. **Prosa corrige, mecanismo não** — ver #7270, que pede marcador obrigatório e revisão periódica justamente por isso.

Na varredura final, antes de declarar o fim: **reconferir as bloqueadas uma última vez.** Uma rodada que fecha 100 issues quase certamente destravou alguma que ficou marcada como (b) por um bloqueio que já não existe.

### VERIFICAÇÃO — meça na origem

> **Antes de afirmar um fato que vai gerar issue, decisão ou mensagem a outra sessão: meça na fonte — e prefira a fonte que o SUJEITO ESCREVE, não a que você lê. Ausência de sinal numa fonte não é ausência de sinal.**

Esta cláusula existe porque a rodada de 02–03/09 produziu **cinco afirmações falsas**, incluindo uma **P1 aberta sobre defeito inexistente** (#7238, retratada). Todas do mesmo tipo — inferir de fonte parcial:

| armadilha | o certo |
|---|---|
| `2>/dev/null` esconde `fatal:` e o vazio vira "não existe" | não silenciar stderr quando o resultado vai virar afirmação |
| `.body[0:100]` corta o fim do comentário, onde ficam marcadores | buscar o padrão no corpo inteiro |
| `git grep -l` casa comentário e docstring | confirmar que é chamada, não menção |
| regex de acento contando `-a-`/`-e-`/`-o-` (palavras legítimas em pt) | revisar a lista candidata item a item |
| contar diretório local **untracked** como publicado | `git ls-tree origin/master` |
| ler `run-log.jsonl` e concluir "morreu em silêncio" | pedir o stdout a quem o tem |

Quando outra sessão tem a fonte e você não, **peça** — é mais barato que deduzir, e foi assim que 3 dos 5 erros acima foram descobertos.

### VELOCIDADE — agrupar é o maior acelerador

Cada PR extra custa uma rodada de CI e uma vaga na fila serial de merge.

1. Montar o mapa **arquivo→issue** de todo o alvo antes de despachar. Issues que se intersectam fundem numa unidade só: 1 worktree, 1 branch, 1 PR, `Closes #N` pra cada.
2. Ir além da colisão de arquivo: agrupar por **subsistema** quando teste e review são os mesmos.
3. **Passe de fechamento em lote sem PR**: varrer o que se resolve por verificação ou prosa — alarme já normalizado, checkpoint de data, duplicata já resolvida por PR anterior — e fechar com a evidência. Tira dezenas do alvo sem gastar CI.
4. Unidade de blast-radius alto roda solo, nunca funde.

Worktrees concorrentes acima de 6 até a máquina engasgar. **Só o merge é serial.**

```bash
npx tsx scripts/lib/session-registry.ts claim-issue --kind develop --issue N
```

Antes de abrir worktree, e como comando **STANDALONE** — encadeado com `&&`/pipe/multi-linha, o hook não injeta `--session-id` e a chamada falha (#7212).

**`--kind` é obrigatório e não é auto-injetado.** Só o `--session-id` vem do hook; `requireKind` roda antes de o handler sequer ler `--issue`, então a forma sem `--kind` sai com `exit 1` na hora.

### LIVRO-CAIXA — grave na hora, nunca reconstrua no fim

Toda decisão com trade-off real — duas opções que mudam a experiência de quem lê/usa — vai **na hora** para `data/develop/{AAMMDD}/trade-offs.jsonl` **e** como comentário na issue: o que foi decidido, a alternativa recusada, por quê, como reverter.

> **Isto falhou na rodada anterior: o `.jsonl` nunca foi criado.** A instrução em prosa não basta — é a mesma lição do #6168 ("o que depende de skill lembrar, não acontece"). Se houver helper que grave nos dois lugares numa chamada, use-o; se não houver, **grave o comentário na issue primeiro** e derive o `.jsonl` a partir deles no fim. O relatório final ABRE por esta seção: vazia, ela denuncia a própria rodada.

### RELATÓRIO FINAL — nesta ordem

1. **Decisões com trade-off real**, do livro-caixa, ordenadas pelo que mais muda a experiência de quem lê/usa. Cada uma: issue e PR, a pergunta que teria sido feita ao editor (escrita como pergunta), o que foi decidido, a alternativa recusada, por quê, o que muda na prática, e **como reverter em uma linha**. Incluir as perguntas do briefing que saíram pelo default. Lista vazia se declara explicitamente.
2. Tabela: issue, track original, track final, desfecho (a)/(b), PR — marcando as **criadas durante a rodada**.
3. Total de reclassificações, com as mais surpreendentes nomeadas.
4. O que ficou em (b) e o bloqueio de cada uma.
5. **"Perguntas que ficaram"** — bloqueios novos que o briefing não previu.

Registrar na superfície de Relatórios do Studio (#3714) e notificar o editor por e-mail.

---

## Topologia — uma coordenadora, N executoras, todas conversando

**Este é o núcleo da rodada, não um detalhe de organização.** Na rodada de 02–03/09 foi a conversa entre sessões que impediu os erros mais caros.

**Coordenadora (esta sessão), e só ela:** triar, agrupar em unidades, rotear, manter o estado da rodada, decidir trade-off.

**Executora:** recebe um lote fechado, `claim-issue` do que pegou, implementa em worktree isolado, abre PR, reporta. **Nunca inventa escopo, nunca reclassifica issue alheia, nunca roda `gh pr merge`** (#6762).

### Protocolo de marcos — a executora fala sem ser perguntada

Uma mensagem curta por marco, sempre nomeando a issue:

```
claimed (peguei #N, worktree aberto)
  → pr-aberto (PR #M, Closes quais)
  → ci-verde | ci-vermelho (com o erro)
  → bloqueada (o que falta, em uma frase)
  → entregue | desisti
```

**Silêncio prolongado num lote é sinal de travamento, não de progresso** — a coordenadora cobra por `SendMessage` antes de considerar a unidade perdida e redistribuir.

### Colisão entre lotes

Executora que esbarra em algo fora do seu lote — arquivo que outra unidade toca, issue vizinha que precisaria do mesmo fix, finding maior que o escopo — **avisa a coordenadora e para ali**, nunca invade. A coordenadora decide: funde, redistribui, ou vira issue nova (que entra no alvo vivo).

### Peer corrige peer — e isso é para acontecer

Uma sessão que discorda de um fato afirmado por outra **deve dizer**, com a medição. Da rodada anterior:

- uma peer **recusou aprovação por relay** — *"o coordenador diz que o editor aprovou"* é exatamente o caso que a regra exclui, senão o eco vira consenso;
- refutou um lost update afirmado pela coordenadora, medindo o lado que **escreve**;
- corrigiu um destino de arquivo que a coordenadora tinha relatado errado ao editor;
- alertou que **merge não é deploy** — as URLs seguiriam 404 com o PR mergeado.

**Aprovação do editor não atravessa sessão.** Se um gate exige decisão dele, ela vem dele, direto, na sessão que tem o gate — nunca por relay de outra sessão.

---

## Posse da janela — você é a dona do estado enquanto roda

**O problema que esta seção resolve não é "há coordenadoras demais". É que nada arbitra entre elas.**

Na rodada de 02–03/09 havia três coordenadoras vivas e nenhuma dona do estado. O custo foi medido: merge lock cego entre máquinas (#7169), claim expirando sob trabalho ativo (#7194/#7227), e duas rodadas consecutivas reafirmando um bloqueio errado por lerem a label em vez do histórico (#7270).

Encerrar as outras sessões **não** é a saída — e não está disponível:

- `overnight` e `contínuo` rodam por **cron no helios**, desassistidos. Esta skill roda numa sessão que morre quando o editor fecha o terminal; matá-los deixa a janela noturna descoberta.
- O `contínuo` tem **consumidor externo a este repo** (cron do Hermes). Removê-lo já quebrou produção uma vez (#6059) e teve de ser revertido (#6060).
- Máquinas diferentes têm capacidades diferentes: `data/` e Chrome logado só no Neo; systemd e os crons só no helios.

Então a skill não elimina as outras — ela **declara posse enquanto roda**.

### Passo de abertura: anunciar

1. **Registrar-se com kind coordenador**: `npx tsx scripts/lib/session-registry.ts register --kind develop` (comando STANDALONE). Isso é o que torna o merge possível — sem ele, o guard do #5716 recusa `gh pr merge`, corretamente.
2. **Descobrir quem está vivo**: `list-active` (o registro, com claims) e `ListAgents` (as sessões endereçáveis). Um não substitui o outro — o registro diz quem reivindicou o quê, o `ListAgents` diz para quem dá pra mandar mensagem.
3. **Anunciar** por `SendMessage`, uma mensagem curta a cada sessão viva: *"estou coordenando a rodada de exaustão; me reporte marcos pelo protocolo, e não abra worktree sem `claim-issue`."*

> **Nota sobre o kind:** `develop` é reusado porque o guard do #5716 só reconhece `overnight`/`develop`/`continuo` — não há kind próprio para esta rodada. Funciona, mas significa que nada distingue esta sessão de uma `/diaria-develop` genuína rodando em paralelo na mesma máquina: dashboards, atribuição de `claimed_issues` e mensagens de erro vão tratar as duas como iguais. Se isso virar problema, é kind novo, não relabel.

### Durante a janela

- **Todo merge passa por você, serial.** É a correção do que hoje é "cada sessão mergeia e torce". Uma fila, uma dona.
- **Não duplicar o helios.** O filtro do #5751 **vale** — issue que o `overnight`/`contínuo` já reivindicou é deles; `is-claimed` decide, e você segue em frente. (O goal ad-hoc de 02/09 revogou esse filtro; a revogação era daquela rodada, não desta skill.)
- **Sessão que não responde ao anúncio fica fora da coordenação** — não se presume cooperação, e também não se assume que ela morreu (ver #7194: silêncio não é morte).

### Na saída

Ao encerrar, **devolver o estado**: `end` do registro, e uma mensagem final às sessões vivas dizendo o que ficou em voo e quem continua. Rodada que morre sem devolver deixa claim órfã e PR sem dono — foi o que produziu dois resgates de trabalho órfão numa noite (#7157, #7247).

### Mecânica do merge

```
merge-lock-acquire --pr N   →   gh pr merge N --squash   →   merge-lock-release --pr N
```

**Antes de cada merge, `git fetch origin master` e confira o head.** O merge lock é advisory entre máquinas (#6182) e fica cego quando o sync do `data/` cai (#7169) — o estado do GitHub é o único sinal que atravessa máquina de verdade.

**Se precisar conceder janela a outra sessão** (`grant-merge --kind develop --granted-to {id} --pr N`): quem recebe **nunca** roda `consume-merge-grant` antes do merge — o gate ignora concessão com `consumedAt`, e o comando responde `ok`, então a falha é silenciosa (#7171). O carimbo é do merge.

---

## Passo 0 — antes de qualquer coisa

1. `npx tsx scripts/sync-code.ts` — a rodada não pode começar com código defasado.
2. **Registrar posse da janela** — `register --kind develop`, e anunciar às sessões vivas (ver "Posse da janela"). Sem isso você não mergeia, e o contrato desta skill não se cumpre.
3. `npx tsx scripts/fetch-open-issues-for-triage.ts` — o snapshot de partida, já com `execTrack` por issue. **Nunca fixar números de issue nesta skill**: eles envelhecem em horas e viram desinformação (mesmo erro que o #6928 corrigiu na cadência do contínuo, registrada errada duas vezes).
4. `npx tsx scripts/lib/session-registry.ts list-active` — quem mais está trabalhando, e o que já reivindicou. Se `is-claimed` disser que o `helios` pegou, pular e seguir.
5. **Verificar se master está vermelho.** Com o merge quebrado, nada anda — é P0 de fato, independente da label.
6. **Passe de reclassificação, antes de despachar qualquer coisa.** Ler por inteiro toda issue fora de `overnight` — em subagentes paralelos, é 100% paralelizável — e reclassificar o que a leitura destravar (remover label + `route-issue.ts`). Historicamente **mais da metade** de `agendada` e de `bloqueada` volta a ser executável; ver "CLASSIFICAÇÃO NÃO É VEREDITO". Despachar antes deste passe é despachar metade do alvo.

---

## Referências

- **#7289** — a issue que criou esta skill, com a evidência de cada correção
- **#7270** — bloqueio sem razão durável; por que reler a issue inteira
- **#7171** — a armadilha do `consume-merge-grant`
- **#7169 / #7170** — merge lock cego entre máquinas
- **#7212** — `--session-id` em comando encadeado
- `context/overnight-dispatch-rules.md` — regras de dispatch compartilhadas
- `.claude/skills/diaria-overnight/SKILL.md` — a maquinaria de implementação que esta skill reusa
