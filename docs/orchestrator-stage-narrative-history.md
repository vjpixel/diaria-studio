# Histórico narrativo dos playbooks de stage (#4816)

Este arquivo agrega a narrativa histórica extraída dos 7 playbooks
`.claude/agents/orchestrator-stage-{0-preflight,1-research,2,3,4,5,6}.md`
(#4816) — relatos de incidente, "caso real {data}", "achado ao vivo",
histórico de decisão e explicações de POR QUE uma regra passou a existir.
Não é lido pelo top-level durante a pipeline; existe só como referência
para quem quiser entender a origem de uma regra operacional que ficou nos
playbooks.

**Desde #7128, também recebe narrativa extraída de
`.claude/skills/diaria-overnight/SKILL.md`** — mesmo precedente, mesmo
formato de âncora, arquivo diferente do orchestrator mas mesma família de
"prompt lido por sessão/subagente que não deveria carregar a história do
incidente que originou cada regra". Ver a seção dedicada no fim deste
arquivo.

**O que NÃO está aqui:** instrução operacional (o que fazer, GATE-BLOCKING
vs WARN-ONLY, seletor de Chrome, exit codes, ordem de passos) — isso
permanece integralmente nos playbooks/skills de origem. Cada seção abaixo
é referenciada de volta pela fonte via um link `#stage-N-slug` (playbooks)
ou `#overnight-slug` (skill overnight).

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
`no-xml-artifacts` (#4077). `saveReviewFile`
(`scripts/studio-ui/studio-review.ts`) já tira esse padrão antes de gravar
em disco (rede de segurança na origem); o lint é o backstop independente da
causa (Studio, edição manual, merge malformado).

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

### stage-4-erro-intencional-safety-filter-gap

O Filtro de segurança ao PROPOR candidatos (#3808, `context/editorial-rules.md`
§10) só era referenciado explicitamente no fluxo do Stage 2, onde o erro
intencional normalmente nasce. Na edição 260818, o Stage 2 tinha pulado essa
declaração e o gate humano do Stage 4 precisou propor um candidato sozinho
para não travar — sem nenhuma instrução no playbook lembrando de consultar o
filtro, a proposta violou as duas regras invariáveis de §10 (um número
plausível-mas-falso, só verificável saindo do e-mail e capaz de "vazar" como
desinformação real se não pego). O editor pegou o problema (#5566) antes de
aprovar o gate; a correção adiciona a mesma referência explícita ao caminho
`erro-intencional-placeholder` do Stage 4.

### stage-4-pesquisa-nova-sincrona

Movido do §4d.1 no #14033. A issue #8123 também pedia que o passo 0 do
`ajustar` (pesquisa nova via `discovery-searcher`) rodasse em background sem
travar outros ajustes, condicionado a "se #4990 já existir". O #4990 está
fechado, mas resolveu um incidente específico (seção ausente por pesquisa não
completada, ver `check-pending-research.ts` no passo 0) e não criou
infraestrutura de dispatch assíncrono de Agent: o `discovery-searcher` é uma
chamada `Agent`, que bloqueia o turno do orchestrator até voltar, ao contrário
de `image-generate.ts`/`gen-carousel-cards.ts`, que são scripts TS rodáveis
via `Bash(..., run_in_background: true)`. Tornar isso não bloqueante exigiria
uma arquitetura de dispatch assíncrono de subagente que o orchestrator não
tem. O passo 0 seguiu como melhor esforço síncrono.

### stage-4-fronteira-pos-gate-6171

Movido da seção "Fluxo pós-gate" no #14033. O gate do Stage 4 é o mais longo
do pipeline por natureza (433 turnos/1h49 numa edição real, #5414): é o editor
iterando, e isso não deve ser encurtado. O problema era o que vinha depois:
numa sessão `/diaria-edicao` contínua, as Etapas 5 e 6 herdavam esses 433
turnos de contexto e os reliam a cada chamada de tool, 268M tokens de
`cache_read` medidos numa edição só (260826), a maior fatia do custo total. O
#5744 já tinha cortado o problema para os Stages 1→4 (cada um roda num
processo `claude` próprio, spawnado por `run-edition-stages.ts`); o Stage 4
não entra nesse laço porque o gate humano precisa da sessão do editor. A
fronteira depois do gate nenhum laço automático cruza (Stage 5 nunca é
spawnado headless: `STAGE_PLAN` exclui os Stages 5/6 de propósito). A saída
foi a mesma do #5578 para as demais transições: sessão nova, contexto limpo.

**Pré-gate da Etapa 4, narrativa movida no #14195.** As seções a seguir saíram de `orchestrator-stage-4.md` (§4a–§4c) no #14195,
para abrir folga no teto de bytes de
`test/stage-playbook-byte-budget-14033.test.ts`. A instrução operacional
ficou no playbook; aqui fica só o porquê e o caso real.

### stage-4-edition-lock-10309

A trava da edição entre sessões (#10309) nasceu de um fork do gate na
edição 261016: duas sessões no mesmo gate editaram `02-reviewed.md` e
`03-social.md` e republicaram os Artifacts, uma por cima da outra. A
liberação da trava em todo ramo terminal (#10326) existe porque, sem ela, um
relançamento dentro dos 45 min do TTL recebe exit 3 e o halt
`edition_lock_held_by_other` esconde a causa real do halt anterior (ex.:
`image-starry-night-detected`).

### stage-4-preview-local-3546

O #3420 tinha revertido o preview da revisão para o Worker
(`upload-html-public.ts`) porque o Artifact da época (#3214) quebrava por
CSP: bloqueia imagem remota, só aceita `data:` URI. O #3546 resolveu sem
depender nem do Worker (cota do Workers KV, rede) nem do Artifact (CSP):
o HTML é servido em loopback com as imagens embutidas em `data:` URI por
`embed-images-base64.ts`, e um servidor local próprio não tem CSP nem faz
requisição de rede para imagem. O Artifact voltou depois (#6003) só como
publicação aditiva da mesma variante embedded.

### stage-4-watch-8123

O `--watch` do `serve-preview.ts` liga o live-reload entregue na Fatia 1 do
#8123. A flag ficou fora das invocações do playbook até o residual do
#8123: a Fatia 1 entregou a flag, o playbook nunca a ligou, e por isso
nenhum critério de aceite da issue foi observado em produção.

### stage-4-preview-detach-9678

Na edição 261006 os dois servidores de preview, rodando como background
task do harness, morreram no teto de tempo com o editor ainda revisando, e
os links `127.0.0.1` do gate pararam de abrir. Na mesma edição só a
newsletter tinha Artifact publicado: o social ficou sem fallback nenhum.
Daí o `--detach` em foreground e os dois Artifacts obrigatórios (#9678).

### stage-4-docs-export-unico-10078

O export do Claude Docs chega ao disco uma vez só, no `sim` do gate
(decisão do editor de 13/10/2026), porque o conector só devolve o export
inline (base64 no resultado da tool, sem caminho de arquivo): cada ida ao
disco é retranscrever o doc inteiro, cerca de 15k tokens de saída.

### stage-4-carousel-cards-missing-6740

Achado ao vivo do #6740: um `/diaria-3-imagens --no-gates` headless
reportou OK sem gerar os 12 slides do carrossel, e os três checks
`carousel-cards-stale`, `carousel-upload-incomplete` e
`carousel-upload-stale` passaram limpos porque cada um, isolado, sai cedo
com "nada a comparar" quando o destaque não tem nenhum slide. O
`carousel-cards-missing` cobre a ausência total.

### stage-4-meta-description-5101

O preview text da Beehiiv (teaser do e-mail, em geral sobre D2/D3) também
alimentava `description`/`og:description`/`twitter:description` da página
web publicada. Funciona como preheader, mas gera um snippet de busca e um
card social que descrevem as outras matérias, não a do título da página
(D1). Daí a sugestão de meta description derivada do D1 no §4c.1c.

### stage-4-lint-agregador-5416

O #5416 trocou as 15 invocações separadas de `lint-newsletter-md.ts` do
§4c.2 (um processo Node por check) e as 4 de `lint-social-md.ts` do §4c.2b
(`post_pixel-matches-d1`, `no-xml-artifacts`, `no-antithesis-reveal`,
`no-trailing-editorial-hook`) por uma chamada agregadora cada (`--stage 4
--json`): mesmas funções, mesmo veredito por check, menos overhead de
processo.

### stage-4-recorrencia-casos-11763-11897

Casos reais dos avisos de recorrência do §4c.2: `study-source-recurrence`
(#11763), cobertura da CNN ("seis vezes") de relatório da Anthropic que já
tinha sido o D1 de 261020; `story-continuation` (#11897), edição 261103,
pesos abertos do Mistral Large 4 depois do anúncio no D3 de 261007.

### stage-4-domain-diversity-5813

Antes da exclusão de hosts não editoriais (`isNonEditorialHost`) no
`validate-domain-diversity.ts`, toda edição acusava violação em `ia.br` por
causa dos 6-8 links de rodapé para subdomínios próprios. Tornar o check
GATE-BLOCKING (#5813) sem a exclusão travaria o Stage 4 permanentemente.

### stage-4-stacked-intro-callouts-severity

Achado ao vivo do #5416: `stacked-intro-callouts` está documentado no
playbook como WARN-ONLY, mas o modo `--check stacked-intro-callouts` sempre
saiu com `process.exit(1)` quando o check falha, e o agregador preservou esse
comportamento por design (a mudança não alterou veredito de nenhum check).
A divergência doc × código é anterior e não foi corrigida ali. O motivo do
lint (#2729): `extractIntroCallout` (#2727) é guloso e funde dois blocos
`**(🎉|📣)…**` da intro num só, vazando `**` internos como texto literal e
perdendo o separador "Divulgação" do bloco patrocinado.
`inject-champions-callout.ts` (Stage 3) já pula a auto-injeção quando um
callout preexiste, mas isso não cobre a colagem manual de dois blocos pelo
editor.

### stage-4-banned-lexicon-7260

"Agentivo" reincidiu em 7 edições ao longo de 4 meses (#7260) apesar da
forma correta já ser dominante no corpo publicado, o padrão que atenção
humana não resolve sozinha. Por isso `banned-lexicon` é GATE-BLOCKING,
enquanto `title-mentions-ia` (com exceções legítimas) é WARN-ONLY.

### stage-4-snippet-staleness-para-encerrar-4274

Reescopo do gate do `/diaria-develop` de 260729 (#4274): o slot A
(apoio+ferramentas) e o slot B (convite social) do PARA ENCERRAR ganharam
override editável em `platform.config.json` → `para_encerrar.{slot_a,slot_b}`
(painel Caixas, texto direto, não um pool de snippets). O lint
`snippet-staleness` ainda só compara `encerramento-social-apoio.md` (o
default, usado quando um slot não tem override): o `02-reviewed.md` já foi
escrito com o valor daquele momento, e se o editor trocar o texto no painel
Caixas depois do stitch o guard não avisa. Limitação conhecida, mesma
filosofia "prefira errar pro lado de avisar menos" das demais imprecisões
documentadas em `scripts/lib/lint-checks/snippet-staleness.ts`.

### stage-4-no-trailing-ellipsis-3196

Diferente do irmão mais antigo `truncated-secondary-item-summary` (#2596,
com exceções para idiomas de suspense ou fechamento intencional),
`no-trailing-ellipsis` é deliberadamente estrito: qualquer descrição
terminando em reticência é flagrada, sem exceção, e os dois podem disparar
juntos na mesma linha. O #3196 passou a ignorar o sufixo `(N min)` do USE
MELHOR: antes, "Então... (5 min)" terminava em "(5 min)", não em "…", e
escapava.

### stage-4-orphan-box-marcador-agnostico

`newsletter-parse.ts` (`locateBoxInGap`/`locateBoxAfterLastDestaque`,
chamado pelo `render-newsletter-html.ts` no pré-render) detecta o box de
divulgação numa lacuna D1/D2, D2/D3 ou na região depois do último destaque
(a do antigo slot 3, entre D3/D2 e USE MELHOR/É IA?) por POSIÇÃO, qualquer
bloco isolado por `---` depois do destaque, e não por uma lista de
marcadores emoji: um marcador novo (📖, 🎥, 🎁, 🔧…) não pede mudança de
código. O slot 3 foi eliminado no #6748 (29/08/2026): `stitch-newsletter.ts`
nunca mais escreve nessa região em edição nova, e o lint segue varrendo-a
como rede de segurança para o box colado à mão ali.

### stage-4-erro-intencional-propostas-5566-5742

Edição 260818 (#5566): o Stage 4 propôs um candidato de erro intencional
sem aplicar o filtro, comparando um número do corpo com a fonte externa
(Exame/FT), o que violava as duas regras de `context/editorial-rules.md`
§10 ao mesmo tempo. Edição 260820 (#5742): três propostas numéricas, de
data ou de nome próprio externo (contagem só verificável na fonte, ano de
evento real, coautor de livro) foram rejeitadas na mesma revisão; o erro
ortográfico em entidade muito conhecida passou a ser o padrão de maior
aceite.

### stage-4-trailing-hook-2715

Antes da chamada explícita no §4c.2b (#2715), `no-trailing-editorial-hook`
só rodava como invariante do Stage 2, sem ponto de apresentação ao editor,
e o campo `trailing_hook_matches` de `check-humanizer-social.ts` só era
impresso no caminho raro de hash divergente depois do humanizador. Agora
roda sempre, no caminho comum.

### stage-4-tic-lint-informativo-4352

O tic lint que `check-humanizer-social.ts --check` roda no exit 2 é
informativo de propósito: o exit 2 já é GATE-BLOCKING por si (o hash
divergiu). O bloqueio dos tiques vem das chamadas explícitas e
incondicionais do §4c.2b (`no-antithesis-reveal` e
`no-trailing-editorial-hook`), que rodam com ou sem hash divergente e pegam
o cenário do #4352: tique que sobrevive com o sentinel batendo, porque foi
introduzido antes do `--write` final.

### stage-4-4c8-rampa-gmail-removida

O antigo §4c.8 (achado de review do #7403) exibia
`kit-gmail-ramp-proposal.json`, a proposta de onda do aquecimento Gmail
(passo `0o.2` de `scripts/stage-0-run.ts`), que saiu em 04/09/2026 porque a
coorte esgotou (#7402; histórico no cabeçalho de `scripts/stage-0-run.ts`).
O Stage 0 não escreve mais esse arquivo e não há substituto: a medição que
sobrou (`0o.1`, `kit-provider-split.ts`) grava
`_internal/kit-delivery-split.json` da edição ANTERIOR com Kit, não da
corrente. Sem arquivo para ler, a linha "Rampa Gmail" e a variável do
resumo consolidado (§4d) saíram também.

## Stage 5 (publicação)

(Ver `docs/archive/beehiiv-playbook.md` §Fase 3 para o histórico
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

---

## `.claude/skills/diaria-overnight/SKILL.md` (#7128)

### overnight-3037-ctr-anomaly-260706

Incidente de referência: 260706/07 (#3037/#3038) — um `AskUserQuestion`
sobre "criar uma issue pra essa anomalia de CTR?" travou a rodada por ~8h
porque o editor estava dormindo; o watchdog externo registrou 9 stall
events falsos-positivos até ele acordar e responder.

### overnight-5831-pr-terminal-260820

Achado ao vivo que motivou o gate 0.7 (rodada `/diaria-develop` 260820):
PR #5823 (issue #5815) ficou ~4h aberto, CI verde, 0 reviews, nunca
mergeado — sem sinal de erro, sem timeout, sem ninguém notar até o editor
perguntar.

### overnight-6259-bloqueio-caducado-260826

Achado ao vivo que motivou o gate 0.9 (rodada 260826): 4 de 5 issues
`pulada` motivo `pr-em-voo` já tinham o PR citado MERGED havia horas
quando a rodada declarou convergência.

### overnight-observability-eventos-260811

Achado que motivou a checagem de instrumentação do relatório (rodada
260811): 0 eventos `subagent_metrics`/`coordinator_tokens_estimate` e só
1 `review_metrics`, sem nenhum sinal disso no relatório final até uma
auditoria manual.

### overnight-5521-titulo-divergente-260816e

Achado que originou o guard de contagem do título do relatório (#5521): a
rodada 260816e anunciou "10 unidades, 13 issues fechadas" para uma tabela
de 13 linhas cobrindo 17 issues — e `plan.json` trazia uma TERCEIRA
contagem (11 mergeadas/8 PRs), por ter parado de ser atualizado no meio
da rodada; a tabela do relatório é a fonte que bate com o git, então é
contra ela que o título é conferido.
