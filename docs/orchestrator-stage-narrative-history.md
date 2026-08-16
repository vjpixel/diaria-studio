# Histórico narrativo dos playbooks de stage (#4816)

Este arquivo agrega a narrativa histórica extraída dos 7 playbooks
`.claude/agents/orchestrator-stage-{0-preflight,1-research,2,3,4,5,6}.md`
(#4816) — relatos de incidente, "caso real {data}", "achado ao vivo",
histórico de decisão e explicações de POR QUE uma regra passou a existir.
Não é lido pelo top-level durante a pipeline; existe só como referência
para quem quiser entender a origem de uma regra operacional que ficou nos
playbooks.

**O que NÃO está aqui:** instrução operacional (o que fazer, GATE-BLOCKING
vs WARN-ONLY, seletor de Chrome, exit codes, ordem de passos) — isso
permanece integralmente nos playbooks. Cada seção abaixo é referenciada de
volta pelo playbook de origem via um link `#stage-N-slug`.

---

## Stage 0 (preflight)

### stage-0-git-sync

`sync-code.ts` (#2686) nasceu porque rodadas overnight/develop mergeiam
código com frequência — sem sync no início de cada edição, o pipeline
corria com código defasado e reintroduzia bugs já corrigidos em outra
sessão. A escolha de fail-soft (qualquer falha de sync vira warning, nunca
bloqueia) veio da constatação de que um editor sem internet ou com um
conflito de stash não deveria ficar impedido de rodar a edição do dia.

### stage-0-newsletter-forward-incident

O passo de captura automática de newsletters de terceiros (0b-bis) é
canal primário de submissões do editor — pular esse passo "por economia de
contexto" já causou uma linha de cobertura errada na edição 260603 (0b-bis
pulado, 11 newsletters na janela, resumo saiu "0 submissões"), daí a
instrução explícita "NÃO PULAR" e o único skip legítimo ser Gmail MCP
indisponível.

### stage-0-raffle-example

Exemplo real do funcionamento de "1 número novo por acerto/edição, não 1
número fixo por pessoa por ciclo": um leitor (Joshu) acertou o erro
intencional em duas edições do mesmo ciclo — 260709 (recebeu o nº2) e
260716 (recebeu o nº3) — resultando em dois números de sorteio, não um
único reaproveitado.

### stage-0-clicks-enrichment-incidents

O check de validação determinística pós-dispatch do enrichment de clicks
(`verify-clicks-enrichment.ts`, #4732/regra #573) nasceu de um caso real
em 260807: o subagent Haiku alegou sucesso processando um post, mas o
mtime do cache no disco não mudou desde o dispatch — o agent e o disco
discordavam.

O segundo check (#4836), independente de mtime, veio de uma recorrência
mais sutil: 22 posts na medição de 2026-08-05, com
`unique_verified_clicks` entre 6 e 28 no agregado reportado pela Beehiiv,
mas `stats.clicks: []` gravado no cache — o mtime tinha mudado (passava no
1º check), porém o conteúdo escrito era um array vazio por cima de um
agregado positivo.

## Stage 1 (research)

### stage-1-websearch-path

O fallback Path A→Path B (BRAVE_API_KEY ausente, ou override explícito
`WEBSEARCH_BACKEND=agents`) era completamente silencioso antes do #3842 —
nenhuma entrada em `run-log.jsonl` indicava qual caminho tinha sido usado
nem por quê. A instrumentação de log nos 3 desfechos (Path A ok, Path B por
key ausente, Path B por override) fechou essa lacuna de observabilidade.

## Stage 2 (escrita)

### stage-2-translate-leak

Sem o passo de cleanup determinístico de summary EN, o prefixo `[TRADUZIR]`
somado ao texto em inglês cru vazou pro HTML final da newsletter na edição
de 260529 (seções LANÇAMENTOS + PESQUISAS).

### stage-2-erro-intencional-exemplo

Ao propor candidatos de erro intencional, a diretriz de preferir erro
cômico/leve sobre inflação de magnitude vem de um caso real (edição
260721): o editor rejeitou 2 rodadas de propostas — primeiro erros
numéricos sutis nos destaques, depois inflações de ordem de grandeza —
antes de aceitar "Craude" no lugar de "Claude": puramente ortográfico,
plantado numa menção lateral do texto.

### stage-2-double-header-incident

O lint de header de plataforma único (#3388) nasceu de um incidente real na
edição 260713: o formato legado usava `# LinkedIn` como header próprio do
agent, e quando o merge script também prependia seu header, o resultado
tinha 2 ocorrências — o parser parava no 2º header como se fosse fim de
seção, e os publishers reportavam "Destaque não encontrado" no Stage 5,
quebrando o dispatch inteiro.

### stage-2-cifra-errada-exemplo

O lint de cifras alucinadas por destaque (comparação per-destaque, não pool
inteiro) nasceu de um caso real em 260602: o post do D1 citava "US$ 965
bilhões em valuation" da Anthropic — um número real, mas ausente da fonte
específica daquele destaque (pegava o número certo no contexto errado).

### stage-2-title-picker-corruption

O guard de estrutura preservada pós-title-picker (#1205) nasceu de um caso
real em 260517, em que o agent mexeu na estrutura do arquivo (removeu um
separador `---`, moveu o bloco ERRO INTENCIONAL de lugar). O guard de schema
de `intentional-error.json` (#2553/#3222) endereçava originalmente uma
classe de corrupção diferente — o Google Docs colapsando o bloco YAML no
round-trip do sync com o Drive, caso real em 260625 — que deixou de ser
possível desde que o JSON parou de sincronizar com o Drive (#3222); hoje o
script serve só como guard de schema geral.

### stage-2-humanizer-coverage-snapshot

O check `humanizer-section-coverage` (#3929) originalmente comparava contra
o `03-social.md` FINAL (pós-Clarice) — uma reversão legítima da Clarice
(desfazer uma edição de estilo do Humanizador) fazia uma seção humanizada
parecer "não coberta", falso-positivo. O fix foi gravar um snapshot
`03-social-post-humanizador.md` logo após o humanizador rodar e ANTES da
Clarice tocar o texto, usando esse snapshot como base de comparação em vez
do arquivo final.

## Stage 3 (imagens)

### stage-3-card-4x5-rationale

Decisão editorial 260727: a arte 4:5 do card de feed é gerada NATIVAMENTE
(não recortada do 2:1) porque o card é retrato (0,8:1) e precisa da altura
que o formato 2:1 descarta — um crop do 2:1 comeria ~60% da largura e
decepava os sujeitos da imagem. Servir e-mail e feed com a mesma arte
degradava visualmente o hero do feed.

O passo de geração do card 4:5 não era originalmente óbvio como
obrigatório: antes da PR #4114 fechar esse gap, `publish-facebook.ts` e
`publish-instagram.ts` já tinham o fallback (`selectSocialCardImageFile`
usa `04-d{N}-4x5.jpg` se existir, senão cai pro `1x1`) — sem os dois
comandos de geração, o arquivo 4:5 nunca existia e o fallback disparava em
silêncio, publicando posts sociais com a imagem 1:1 de sempre, sem título
embutido. Foi exatamente esse o estado observado ao abrir a PR #4114.

A falha desse passo virou BLOQUEANTE por decisão do editor (#4090,
260728), revogando um comportamento anterior não-bloqueante.

### stage-3-eia-description-postmortem

O passo 4 de "3a-bis" (`apply-eia-description.ts`) tratava
`01-eia-compose-context.json` ausente como skip benigno, sob a premissa de
que isso só acontecia em edições anteriores ao #4258. O post-mortem de
260729 provou essa premissa falsa — uma edição pós-#4258 teve a descrição
do É IA? publicada em inglês porque o skip silencioso engoliu o erro real.
Desde o #4281, qualquer erro nesse passo é sempre halt banner.

## Stage 4 (revisão)

### stage-4-video-nao-youtube-caso-real

Caso real, edição 260709: a página oficial da OpenAI hospedando a
livestream "Introducing GPT-Live" bloqueou o bot de resolução (403) e
acabou reusada como URL do vídeo, duplicando o link de um destaque — o lint
`video-links-are-youtube` (#3202) é o backstop que garante que nada
não-YouTube sobrevive até a publicação nesse cenário.

### stage-4-xml-artifacts-caso-real

Caso real, edição 260727: 21 bytes de `</content>\n</invoke>`
sobreviveram após o último parágrafo do PARA ENCERRAR e nenhum dos outros
15 invariantes/10 lints existentes na época pegou — o gate ficou verde com
a corrupção presente, só foi achado por acaso. Motivou o lint
`no-xml-artifacts` (#4077).

### stage-4-snippet-staleness-caso-real

Caso real, edição 260727: o editor editou `encerramento-social-apoio.md`
no Studio e pediu para atualizar a edição; o orchestrator olhou o bloco
PARA ENCERRAR de `02-reviewed.md`, viu texto inalterado, e reportou
incorretamente que "a edição não chegou ao disco" — o save tinha
funcionado, só que no snippet, que já não é lido nessa altura do pipeline.
Motivou o lint warn-only `snippet-staleness` (#4076).

### stage-4-agradecimento-hardcoded-caso-real

Caso real: o placeholder `{apoiadores}` de `agradecimento-apoiadores.md`
foi trocado por um nome real ("Mônica Herculano") e sobreviveu de 260729 a
260731 sem nenhum aviso — motivou o lint irmão `agradecimento-hardcoded`
(#4359).

### stage-4-orphan-box-caso-real

Caso real, edição 260609: um box de divulgação com "cara" de box (bold-line
inteiro ou parágrafo emoji-led) foi colado dentro da seção do destaque
anterior, sem um `---` isolando-o — em vez de virar box próprio, foi
absorvido silenciosamente no corpo/why do destaque. Motivou o backstop
`orphan-box-in-gap` (#3204/#3476).

### stage-4-fact-check-caso-real

Caso real, edição 260731: o claim "é a segunda vez que a xAI recorre à
Justiça..." sobreviveu ao Stage 4 por ser tratado como só informativo — o
lint `NOT_FOUND_IN_SOURCE` não-superlativo (#4361) fechou essa classe de
claim não confirmado pela fonte primária.

### stage-4-untranslated-summary-incident

Antes do lint GATE-BLOCKING `no-untranslated-summary` (#3196), um item de
LANÇAMENTOS/RADAR/USE MELHOR podia vazar pro gate e pra publicação com a
descrição ainda em inglês (`stitch-newsletter.ts` injeta o marcador
`[TRADUZIR] ` e depende do humanizador/LLM pra traduzir, sem garantia
determinística) — incidente registrado em 260709.

### stage-4-section-links-resolve-incident

O lint `section-links-resolve` (#3821) nasceu de um caso real em 260722:
um item de VÍDEOS escrito no formato `**[Título]** — [Canal](URL)` (2 links
na mesma linha) não batia com nenhum branch reconhecido de
`parseListItems`, degradando pro fallback legado — título cru com
colchetes/asteriscos literais, sem link nenhum no HTML final. Diferente dos
lints regex anteriores (que só detectam padrões conhecidos), este roda o
parser de produção real, pegando qualquer degradação do mesmo tipo.

### stage-4-antithesis-reveal-promotion

O lint `no-antithesis-reveal` foi promovido de WARN-ONLY para GATE-BLOCKING
no #4352 depois de um caso real (edição anterior a 260731): 2 ocorrências
do tique "negar pra revelar" sobreviveram até a revisão manual do editor
porque uma correção mecânica de travessão→pontuação, aplicada DEPOIS do
humanizador já ter rodado, reintroduziu o padrão — e o warning, na época,
não travava nada.

### stage-4-pesquisa-nova-incident

A distinção entre "pedido de pesquisa nova" (conteúdo ainda inexistente) e
"edição de texto já escrito" no passo 0 do loop "ajustar" (#4990) nasceu de
um incidente na edição 260811: um pedido desse tipo, feito no meio da
sessão, corria risco de se perder em silêncio se a sessão fosse
interrompida antes da pesquisa terminar — daí a exigência de sempre
registrar o pedido, mesmo quando a busca teve sucesso.

### stage-4-xml-artifacts-loop-ajustar

O lint `no-xml-artifacts` (#4077) originalmente rodava só uma vez, na
montagem inicial do resumo do Stage 4 — nenhum passo do loop "ajustar"
(onde o próprio orchestrator aplica `Edit` diretamente em `02-reviewed.md`
e `03-social.md`) o re-executava depois de uma edição inline. Isso permitiu
que uma tag de tool-call crua (`</content>`, `</invoke>`,
`</function_calls>`) sobrevivesse até a aprovação numa recorrência real
(#4636, edição 260805) — só foi pega por um mecanismo de auto-detecção em
runtime do próprio orchestrator, não por este lint. A causa exata do
vazamento na chamada `Edit` nunca foi reproduzida (mesma conclusão do
#4077 original). Desde então, o loop "ajustar" re-audita os dois arquivos
que pode escrever.

### stage-4-tic-lints-loop-ajustar-recorrencia

Os tic-lints GATE-BLOCKING de §4c.2b/§4c.6c (no-antithesis-reveal,
no-trailing-editorial-hook) não eram re-checados depois de uma
re-humanização scoped dentro do loop "ajustar". Recorrência ao vivo em
260803 (#4505): uma correção mecânica de travessão→pontuação reintroduziu
"antítese-revelação" 3 vezes seguidas na mesma sessão — cada ocorrência só
foi notada porque o editor pediu manualmente "passa o humanizador de novo".
Sem uma re-checagem automática pós-ajuste, nada fechava esse loop sozinho.

## Stage 5 (publicação)

(Ver `context/publishers/beehiiv-playbook.md` §Fase 3 para o histórico
completo da recuperação do fetch in-page do Worker — #4816 não duplica
esse relato aqui, ele já vive na fonte única #4196.)

### stage-5-dlq-incident

O abort imediato em caso de env var crítica ausente (pre-dispatch
invariants, #1007) evita uma recorrência de DLQ (dead-letter queue)
observada no incidente 260508 (#999).

### stage-5-pending-research-incident

A regra `pending-research-unresolved` (#4990) nasceu de um incidente na
edição 260811: uma seção pedida pelo editor no gate do Stage 4 (pesquisa
nova, não integrada a tempo) sumiu da edição publicada sem nenhum aviso
até o Stage 6 — daí a exigência de logar sempre, mesmo quando o dispatch
segue em frente.

### stage-5-buffer-queue-caso-real

Caso real que motivou reverter `addToQueue` do Buffer (Twitter/X) para
`dueAt` explícito (#4103, 260727): a fila própria do Buffer não tem
relação com os horários editoriais dos demais canais e dessincronizava —
Facebook/LinkedIn/Instagram/Threads saíam 10:00/12:30/17:30 enquanto o X
da fila saiu 08:55/09:10/10:57, produzindo dois destaques quase colados e
fora de ordem de divulgação.

## Stage 6 (agendamento)

(Sem narrativa de incidente extraída nesta rodada — ver diff do PR #4816
para o que foi avaliado.)
