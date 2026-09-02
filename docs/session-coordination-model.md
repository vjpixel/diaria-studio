# Camada de coordenação de sessão — modelo único (#7123)

Fatia 11 do epic #7112. Antes deste documento, "a sessão travou?" e "esta PR
pode mergear agora?" eram respondidas por mecanismos espalhados por
`scripts/lib/session-registry.ts` (5.295 linhas antes deste PR),
`scripts/overnight-watchdog.ts`, `.claude/hooks/session-beacon.mjs`,
`.claude/hooks/block-gh-pr-merge-subagent.mjs`, `hermes/scripts/watch-*` e
prosa em 3 `SKILL.md` — sem nenhum lugar único que dissesse qual camada é
AUTORIDADE, qual é FALLBACK, e o que acontece quando duas discordam. Sete
issues abertas na mesma camada (#7043, #7083, #6971, #6956, #6624, #6771,
#7089) são o sintoma dessa ausência — a mais direta, #7083, é literalmente
duas sessões chegando a conclusões opostas sobre "travou?" no mesmo turno.

Este documento não substitui a prosa operacional que já existe (a fonte
canônica de CADA mecanismo continua sendo o próprio código + o docstring que
o acompanha) — ele é o mapa que faltava por cima dela.

## Parte 1 — "A sessão travou?": 5 camadas independentes

Não é uma pergunta com uma resposta — são 5 detectores que rodam em
momentos, escopos e máquinas diferentes. Nenhum é dono exclusivo do
veredito; a garantia real é que **cada um cobre um buraco que os outros
deixam**, não que eles concordam sempre.

| # | Camada | Onde roda | O que detecta | Threshold |
|---|---|---|---|---|
| (i) | Detecção-no-wake (#2379) | Dentro do coordenador (overnight/develop), quando um evento o acorda (CI, task-notification) | >45min sem progresso na unidade em andamento — só cobre o caso em que ALGUM evento chega | `OVERNIGHT_STALL_THRESHOLD_MIN` = 45min, `scripts/lib/overnight-stall-threshold.ts` |
| (ii) | Watchdog externo por tempo (#2688) | `scripts/overnight-watchdog.ts`, processo systemd separado, roda a cada 10min | Inatividade via `max(mtime plan.json, último evento run-log agent:overnight)` — cobre o caso em que NENHUM evento chega ao coordenador | mesmos 45min; só protege se `check-watchdog-armed.ts` reportar `armed` de verdade (não `armed_but_disabled`/`armed_but_stale`/`armed_but_never_run`, #2944) |
| (iii) | Fallback wake determinístico (#2896) | Dentro do coordenador — `ScheduleWakeup(~1200s)` agendado a CADA dispatch/resume de subagente | O buraco que sobra mesmo com (i)+(ii): watchdog externo desarmado E zero eventos — o coordenador acorda sozinho e computa `elapsed` via `shouldWakeCheck`, MESMO sem ter recebido notificação nenhuma | mesmo threshold de (i), herdado — nunca refixado |
| (iv) | Staleness do `session-registry` | Lido por qualquer consumidor de `listActiveSessions`/GC — não é um "watchdog" ativo, é um predicado sobre o registro em disco | Se um REGISTRO (não a sessão em si) deve ser tratado como morto | 4 janelas distintas, ver tabela abaixo |
| (v) | `hermes/scripts/watch-continuo-health.sh` | Fora deste repo — cron do Hermes no `helios`, `--no-agent`, 1x/dia | Escopo estreito: SÓ `continuo` — review Opus diário atrasado, `failure_streak`, claim vazado (heartbeat parado >45min com claim ativo), vazamento pago | 26h (review), 2 (streak), 45min (claim), thresholds próprios do script |

**As 4 janelas de (iv), no mesmo módulo, cada uma pra uma pergunta
diferente** — a causa raiz de por que "staleness" parece uma camada só e é
na verdade quatro:

| Constante | Valor | Pergunta que responde |
|---|---|---|
| `INTERACTIVE_SOFT_STALE_MS` | 15min | Uma sessão `interactive` sem heartbeat recente é candidata a GC/re-uso do slot |
| `SOFT_STALE_MS` | 90min | Uma sessão COORDENADORA (overnight/develop/continuo) sem heartbeat é "provavelmente morta" pra efeito de `stale: true` computado — usado pelo guard de merge (#5716) pra decidir se ainda há rodada ativa |
| `MAX_SESSION_AGE_MS` | 24h | Teto absoluto — além disso, o registro é ignorado incondicionalmente por `listActiveSessions` (idade descarta liveness, mesmo com heartbeat "recente" por bug de relógio) |
| `GC_CONSERVATIVE_MAX_AGE_MS` | 7 dias | Piso conservador do GC de verdade (remoção de arquivo) — mais alto que os três acima de propósito, porque remover é irreversível e os outros três só mudam COMO o registro é LIDO, nunca o apagam |

**Autoridade vs. fallback, explícito:** (i) é a leitura mais barata e mais
frequente (roda toda vez que o coordenador acorda por qualquer motivo) —
trate como a PRIMEIRA linha. (ii) é quem cobre o silêncio total do lado do
coordenador, mas depende de arming local (#2768: já foi encontrado
desarmado numa máquina real). (iii) é o fallback do fallback — cobre
exatamente a interseção "watchdog desarmado E zero eventos", que já causou
um stall de ~8h medido ao vivo (260702-r2). (iv) não detecta stall
ativamente — é o predicado que (i)/(ii)/(iii) e todo o resto do sistema
consultam pra saber se um registro AINDA CONTA. (v) é o único que roda fora
deste processo/máquina inteiramente, e o único com escopo restrito
(`continuo`, não geral).

**Quando duas discordam:** não há resolução automática — cada camada grava
seu próprio sinal (`stall_events` em `plan.json` para i/iii; run-log
`agent:overnight` para ii; issue no GitHub para v) e um humano ou o
coordenador da PRÓXIMA rodada é quem concilia. Isso é uma lacuna real, não
uma feature — é a raiz do #7083 (duas sessões, duas conclusões, no mesmo
turno). Fechar essa lacuna de vez (um único log de eventos de stall,
consultável por todas as 5 camadas) é trabalho de execução que esta issue
delibera **não** fazer (ver "Fora de escopo" na issue original) — fica
registrado aqui como o próximo passo natural, não implementado.

## Parte 2 — Protocolos de merge: pilha, não paralelo

A leitura de "4 protocolos concorrentes" (lock, grant, anúncio+admissão,
trem) estava **estruturalmente errada**: só o lock e o grant são primitivos
de serialização; o trem é um CONSUMIDOR de ambos, não um terceiro
mecanismo; e o anúncio+admissão nunca teve consumidor de produção — foi
removido neste PR.

```
merge-train (scripts/lib/merge-train-live.ts)
    │  bissecção + branch de integração + 1 CI + squash único
    │  usa merge-lock-acquire/release por dentro, não substitui
    ▼
merge grant (#6296, session_grant field)              merge lock (data/sessions/.merge-lock.json)
    │  destrava IDENTIDADE — "quem pode mergear"          │  serializa TEMPO — "quando", TTL 2min
    │  concedida por uma coordenadora a um peer            │  todo mundo passa por aqui, inclusive
    │  (ou a si mesma via kind, nunca self-grant)          │  quem já tem grant
    └──────────────────────┬─────────────────────────────┘
                            ▼
              gh pr merge (bloqueado por padrão pelo
              guard #5716 fora do fluxo coordenador)
```

**A distinção que resolve a confusão histórica (#6296 doc original):** grant
e lock respondem perguntas DIFERENTES. Grant é "você tem permissão de
mergear ESTE PR" — decidido por combinação/conversa entre coordenadoras.
Lock é "é a sua vez AGORA" — decidido por quem consegue escrever
`.merge-lock.json` primeiro, TTL 2min, 3 subcomandos (`acquire`/`release`/
`status`). **Ter grant nunca dispensa o lock.** Isso já estava documentado
no código (`classifyMergeBlockCause`, comentário #6303 P1·a: "a concessão
destrava IDENTIDADE, nunca TEMPO") — o que faltava era dizer isso FORA do
código, num lugar que não exige ler 5.295 linhas pra achar.

**Anúncio + admissão (Parte F, #6168) — removido neste PR.** Era uma
proposta de protocolo ALTERNATIVO ao lock: duas sessões anunciam intenção
de merge, calculam sozinhas (sem round-trip) quem vence por timestamp, e
"silêncio nunca é cessão" força fallback pro lock quando não há ACK
explícito. **Nunca foi ligado a nenhum caminho de escrita real** — nada no
repo grava `merge_announcement` no registro. `MergeAdmission`,
`PeerAnnouncement`, `MergeAdmissionResult`, `decideMergeOrder`,
`resolveMergeAdmission`, o tipo `MergeAnnouncement`, e o campo
`merge_announcement` de `SessionRecord` foram removidos de
`scripts/lib/session-registry.ts` (~111 linhas) junto com os testes
correspondentes em `test/session-conflicts-and-merge-grant.test.ts` (~85
linhas). Achado explícito na auditoria do #7112: um dos 3 alarmes de
"pares se contradiziam" era exatamente aqui — a Parte F prometia substituir
o lock como mecanismo primário; o #6296 (grant) que veio depois assumiu
implicitamente que o lock CONTINUA sendo primário. Os dois não podiam ser
verdade ao mesmo tempo; o código nunca decidiu — só a Parte F nunca ganhou
um consumidor, então a decisão de fato já estava tomada pelo uso, só não
registrada em lugar nenhum. Este documento é esse registro.

**Decisão explícita (substitui a ambiguidade):** o protocolo de merge é
**lock (primário) + grant (delegação de identidade sobre o lock) + trem
(orquestração de lote sobre os dois)**. Três peças, uma pilha, sem
concorrência real entre elas. Não há necessidade de "unificar" nada — a
sedimentação real era só a Parte F morta, agora cortada.

## Parte 3 — Dois comportamentos vivos desta própria rodada (contexto #7123)

Estes dois foram observados AO VIVO durante a rodada que gerou esta issue —
registrados aqui porque a issue original exigia explicitamente que a
documentação os explicasse.

### 3a. A mensagem de bloqueio do guard #5716 lidera com o remédio errado

Quando `gh pr merge` é bloqueado (`.claude/hooks/block-gh-pr-merge-subagent.mjs`),
`BLOCK_REASON` é o texto BASE, e ele **lidera** com a instrução de renovar o
registro (`session-registry.ts register --kind ...`) — porque essa é a causa
mais comum historicamente (registro da própria coordenadora expirou por
staleness). Mas desde o #6497 existe `LOCK_CONTENTION_HINT`, um sufixo
ADITIVO que só aparece quando `classifyMergeBlockCause` determina que a
causa real é uma das três: `lock-held-other`, `contention-multi-coordinator`,
`contention-grantee`. **O hint fica no FIM da mensagem, depois de um
parágrafo inteiro sobre renovar registro/pedir grant** — uma sessão que lê só
a primeira frase (ou para de ler ao achar "isto resolve") tenta `register`,
falha de novo, tenta de novo, e só na Nª tentativa lê até o fim e encontra o
hint correto. Foi exatamente o que aconteceu nesta rodada: 2 batidas no
guard, mensagem de bloqueio mandando renovar (o que NÃO era o problema —
o registro estava saudável), motivo real (merge lock) só apareceu na 5ª
mensagem — a mesma que qualquer chamada a `classifyMergeBlockCause` direto
teria dado na 1ª tentativa.

**Leitura correta, registrada aqui pra não depender de tentativa-e-erro:**
ao bater neste guard, ler a mensagem completa até o fim ANTES de agir — se
ela contém a frase "O motivo REAL deste bloqueio agora é o MERGE LOCK", a
causa é lock, não identidade, e `register`/`grant-merge` não resolvem nada;
o passo é `merge-lock-acquire --pr N` e tentar de novo. Alternativa mais
rápida que ler a mensagem inteira: chamar
`.claude/hooks/block-gh-pr-merge-subagent.mjs`'s `classifyMergeBlockCause`
diretamente (via o mesmo import que os testes usam) pra obter a causa em
1 chamada, sem esperar o `gh pr merge` real bloquear de novo. **Não
corrigido neste PR** — reordenar `BLOCK_REASON`/`LOCK_CONTENTION_HINT` é uma
mudança de comportamento de hook ativo que merece teste de regressão
dedicado e não fazia parte do escopo de corte confirmado desta issue;
registrado aqui como achado válido para uma issue própria de follow-up.

### 3b. `register` responde "promoted from interactive-…" durante a rodada

Mecanismo, não bug isolado: `.claude/hooks/session-beacon.mjs` escreve um
heartbeat a CADA chamada de ferramenta, sob o kind `interactive` por padrão
(`BEACON_KIND`). Quando uma sessão roda `session-registry.ts register --kind
{overnight|develop|continuo}`, `registerSession` procura primeiro um
registro no path do kind ATUAL; se não achar, procura (via
`findExistingSessionFileAnyKind`) um registro pré-existente da MESMA
`sessionId` sob QUALQUER outro kind — tipicamente o `interactive-*` que o
beacon já vinha escrevendo antes do `register` explícito — e **promove**
esse registro (migra o conteúdo pro path do kind novo, remove o antigo,
resposta inclui `promoted from {path}`). Isso é o comportamento CORRETO e
esperado na 1ª chamada de `register` de uma rodada: a sessão começou como
`interactive` (todo Claude Code começa assim) e vira coordenadora.

`findExistingSessionFile` (usado pelo PRÓPRIO beacon pra decidir onde
escrever o heartbeat seguinte) prefere explicitamente kind coordenador sobre
`interactive` quando os dois existem (#6326 fleet review item 3) — então,
em teoria, depois da 1ª promoção o beacon deveria continuar escrevendo no
arquivo coordenador, e `register` nunca deveria precisar promover de novo
na mesma rodada. **O que esta rodada observou — a identidade se degradando
repetidamente, não só uma vez — não tem uma causa raiz confirmada neste
documento.** Hipóteses plausíveis, não verificadas: (a) o registro
coordenador cruzou `SOFT_STALE_MS`/`MAX_SESSION_AGE_MS` em algum ponto e um
consumidor tratou-o como ausente; (b) uma corrida entre o
`writeJsonSafeWithCas` do `register` e o write do beacon (ambos descritos
como best-effort, sem lock cross-processo — ver docstring de
`resolveWritePathAtWriteTime` em `session-beacon.mjs`) recriou o
`interactive-*` numa janela estreita. **Registrado como observação viva, não
como fix** — investigar qual das duas (ou outra causa) é a real fica como
follow-up; o sintoma em si (mensagem "promoted from interactive-…"
aparecendo mais de 1x na mesma rodada coordenadora) é o sinal a procurar
pra reproduzir.

## Parte 4 — As 7 issues, contra o modelo

| Issue | Camada/protocolo | O modelo acima já explica? |
|---|---|---|
| #7043 | Merge grant é slot único; lock advisory responde como se fosse forte | Sim — grant e lock são primitivos DIFERENTES (Parte 2); tratar um como substituto do outro é o erro de leitura que este documento corrige |
| #7083 | Ausência de arquivo lida como ausência de execução | Sim — é exatamente o caso "duas camadas discordam sem resolução automática" (fim da Parte 1) |
| #6971 | Agente read-only rodou `rm` no checkout compartilhado | Não — fora do escopo deste documento (blast-radius de permissão, não coordenação de sessão/merge) |
| #6956 | Gate de autenticidade não reconhece review de sessão interativa | Parcialmente — toca a mesma distinção kind coordenador × `interactive` da Parte 3b, mas o gate específico (`pr-review-authenticity.ts`) não foi auditado aqui |
| #6624 | Sessões coordenadoras terminam sem chamar `end` | Sim — é o motivo pelo qual (iv) (staleness) existe: se `end` fosse sempre chamado, as 4 janelas de tempo seriam desnecessárias; elas são o fallback pra sessão que nunca encerra de forma limpa |
| #6771 | 5 jobs de watchdog residuais, 2 reintroduzem bug conhecido | Toca a camada (ii)/(v) — não auditado item-a-item neste documento, mas a tabela da Parte 1 é o ponto de partida certo pra essa auditoria |
| #7089 | Harness recusa worktree alegando metadata git irresolvível | Não — infra de worktree/harness, fora do escopo de coordenação de sessão |

Quatro das 7 (#7043, #7083, #6956 parcialmente, #6624) são diretamente
explicadas pelo modelo acima — confirma a leitura da issue original de que
não são sete acidentes independentes. As outras três (#6971, #6771, #7089)
tocam infra adjacente (permissões, jobs de sistema, harness) e continuam
precisando de investigação própria — não foram "resolvidas" por este
documento, só triadas quanto a se pertencem a esta camada.
