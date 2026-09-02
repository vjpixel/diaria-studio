# Histórico narrativo extraído do CLAUDE.md (#7127)

Este arquivo agrega narrativa histórica — relatos de incidente, "achado ao
vivo", "caso concreto que motivou", trajetória de decisão — extraída da
seção "Princípios operacionais invariáveis" do `CLAUDE.md` (#7127, mesmo
precedente do #4816 para os playbooks de stage: ver
`docs/orchestrator-stage-narrative-history.md`).

`CLAUDE.md` é o único arquivo de prompt carregado incondicionalmente em toda
sessão e em todo dispatch de subagente — cada bullet aqui existia ali junto
com a regra operativa que motivou. A regra em si (o que fazer, por que
importa) **permanece integralmente no CLAUDE.md**; só o relato do incidente
específico que originou a regra migrou para cá. Cada seção é referenciada de
volta pelo bullet de origem via um link `#slug`.

---

## princ-5578-encadeamento-260818

Incidente de referência: sessão 260818, `/diaria-4-revisao` encadeou
sozinho pra Etapa 5 (draft real no Beehiiv, dispatch social) e emendou na
Etapa 6 sem pausa.

## princ-5751-helios-duplicado

Caso concreto que motivou a regra: uma rodada `helios` tinha #5738 em
`claimed_issues` **enquanto** uma sessão interativa a implementava e
mergeava em paralelo (PR #5739) — o `is-claimed` mecânico evita a corrida
de escrita, não o desperdício de duas sessões atacando o mesmo trabalho.

## princ-573-publish-state-260505

Falha desse guard em 2026-05-05: orchestrator afirmou "3 edições
publicadas" baseado em `status: confirmed`, mas uma estava 16h no futuro
(agendamento, não publicação).

## princ-1172-clarice-recall-260512

Não usar memória da sessão como fonte primária — ela degrada entre
sessões: deu lista correta + horário errado em 260512 baseado em recall
(achou noturno 19h, real era manhã 06:00 BRT).

## princ-mv-throughput-260812

Achado ao vivo 260812: uma análise ad-hoc quase caracterizou a ausência de
`leads-2023h1`/`leads-2023h2` numa onda como "throughput constraint" — o
editor corrigiu: com créditos sobrando, isso é 100% uma decisão de quando
gastar, nunca uma restrição real.

## princ-4234-effort-trajetoria

Histórico do porquê de virar `low` no #3326 e depois `max` no #4234:
`git log --all --grep=4234`.

## princ-5251-merge-auto-260814

Achado que motivou a issue: PR #5250 (mudança de 1 valor de config),
review sem findings, e mesmo assim veio confirmação manual antes do merge
— comportamento agora considerado incorreto.

## princ-continuo-cron-pausado-260828

Achado #6643, 28/08/2026: o job ficou `enabled=false`/pausado ~7h por um
bug nos watchdogs que o retomam (#6646), e uma memória do Hermes chegou a
registrar "removido" por engano.

## princ-3938-askuserquestion-260723

Visto em sessão remota 260723: `AbortError: Tool permission stream closed
before response received`. Ocorrência única até 260727.

## princ-5227-boxes-studio-invisivel

Antes viviam em `context/snippets/` (git-tracked) — caixa criada/editada
localmente (pelo painel Caixas do Studio, que ESCREVE nesse diretório)
ficava invisível no checkout remoto que serve o Studio até alguém
commitar+dar push, achado ao vivo quando 4 caixas ficaram dias sem
aparecer em `studio.diar.ia.br/caixas`.
