# Monitor semanal de citação por assistente de IA

Issue: [#4558](https://github.com/vjpixel/diaria-studio/issues/4558) (Parte C).

Pergunta a cada provedor de LLM com API key configurada as perguntas fixas de
`GEO_QUESTIONS` (ex: "Qual a melhor newsletter diária sobre inteligência
artificial em português?") e registra se a diar.ia.br foi citada — série de
tendência sobre GEO (Generative Engine Optimization).

## Por que a task existe

O monitor foi mergeado no #4616 e ficou sem NUNCA ter rodado — `data/geo-citations/`
não existia no disco até 07/ago, e nenhuma task agendada o invocava, enquanto
todas as outras tasks agendadas do repo já seguiam esse padrão. Sem cadência o
histórico nunca acumula.

## Baseline medido em 07/ago (histórico) — obsoleto desde 11/ago, ver abaixo

**0 de 16 consultas citaram** — 8 perguntas × OpenAI + Gemini, sendo 15
respondidas + 1 erro de rede; `ANTHROPIC_API_KEY` ausente do `.env`, provedor
pulado por fail-soft. Zero não é veredito: o hub tinha 3 dias e ficou órfão
de link interno até o #4749.

Este número fica como registro histórico do ponto de partida da série — não
recitar como veredito. Ver "Critério de decisão" abaixo pro que orienta ação
hoje.

## Baseline "zero citação" está obsoleto desde 11/ago/2026 (#5120)

`data/geo-citations/history.jsonl` tem 124 registros, dos quais **3 com
`cited: true`** — todos de 11/ago, provider `google` (`gemini-2.5-flash`),
mesma pergunta ("Existe alguma newsletter brasileira que resume as notícias
de IA todo dia?"), reamostrada 3× no mesmo dia. É **1 acerto repetido**, não
3 acertos distintos, e é **menção nominal em prosa**, não citação de fonte
com link (o painel `hubs` segue em 0). Mas "nunca fomos citados" deixou de
ser factualmente correto a partir desta data — ver Fato 7 de
`docs/seo-notes.md` para a leitura completa e os 3 snippets transcritos.

## Fix de falso negativo no provider Anthropic — 14/ago/2026 (#5305)

**Medições anteriores a esta data podem conter falsos negativos silenciosos
no provider `anthropic` — não comparar séries de antes/depois deste fix como
homogêneas.** Até 14/ago, `anthropicRequest` chamava a Messages API com
`max_tokens: 1024` e sem declarar `thinking` explicitamente. No Sonnet 5,
omitir `thinking` liga thinking adaptativo por default (mudança de default
silenciosa em relação ao Sonnet 4.6, onde omitir desligava) — e `max_tokens`
é teto de **thinking + texto de resposta somados**. 1024 tokens era curto
demais pra thinking adaptativo mais uma resposta pós-`web_search`
multi-hop: quando estourava, a resposta voltava com `stop_reason:
"max_tokens"` e possivelmente **zero blocos de texto**, `anthropicExtractText`
devolvia `""`, e o monitor registrava **"não citado"** — indistinguível do
resultado legítimo. O mesmo valia pra `stop_reason: "refusal"` (HTTP 200 com
`content` vazio, salvaguardas de cyber do Sonnet 5).

Correlação plausível (não confirmada) com sintomas já registrados na seção
"Captura de usage" abaixo: 8/8 chamadas estourando o timeout de 25s (subido
depois pra 120s), 121k tokens de INPUT numa única chamada, e a observação de
que reduzir `max_uses` de 5 pra 2 não eliminou os timeouts — turnos mais
longos são o efeito esperado de thinking adaptativo ligado por engano.

**Fix (#5305):** `max_tokens` subiu pra 4096; `thinking: {type: "adaptive"}`
passou a ser declarado explicitamente (nunca `disabled` — desligar thinking
reduz a propensão do Sonnet 5 a acionar tool use, e esta chamada depende do
`web_search`); e `queryProvider` agora checa `stop_reason` ANTES de
`extractText` — `"max_tokens"` e `"refusal"` viram `errorKind: "provider"`
(erro de provider, mesmo caminho que timeout já percorria), nunca "não
citado". Texto vazio com `stop_reason: "end_turn"` continua "não citado"
legítimo. Ver `anthropicCheckProviderError` em
`scripts/lib/geo-citation-monitor.ts`.

## Critério de decisão: acompanhamento contínuo, não gate de parada (#4901)

O comentário de 07/ago na #4558 fixava um checkpoint binário pra ~07/out:
"se em 2 meses nenhuma das 8 perguntas citar a diar.ia.br, parar de produzir
hub novo". **Retratado em 10/ago** (comentário do editor na #4558, decisão
registrada na #4901) — o próprio survey citado como base do checkpoint
(arXiv 2607.14035, 45 estudos, nov/2023–jul/2026) conclui que nenhuma técnica
de GEO revisada mostra efeito causal estável, longitudinal e cross-platform;
não dá pra validar em 2 meses o que a literatura de referência não valida em
quase 3 anos de estudos.

Critério substituto: a série semanal roda **sem data de corte**. Qualquer
decisão de pausar ou continuar a produção de hub compara a tendência
acumulada de citação contra o crescimento do acervo indexado — nunca um
snapshot isolado numa data fixa — e passa por decisão explícita do editor,
não por um script que corta produção sozinho ao bater checkpoint.

## Cadência: semanal, não diário

Citação por assistente muda em escala de semanas e a série só vale como
tendência — diário gastaria 7× pra ler ruído. Roda **domingos 07:00**
(mudou de segundas 10:30, decisão do editor 260810 — consolidar as tasks
semanais na manhã de domingo). Não colide com `Diaria-SEO-Weekly` (domingos
04:10) nem com as diárias que começam às 05:30.

Custo por execução **medido ao vivo em 11/ago/2026**, os 3 providers — ver
"Captura de usage e teto de custo" abaixo pro número completo, incluindo a
descoberta de latência variável da Anthropic que mudou o desenho do
provider (timeout e `max_uses` próprios).

## Captura de usage e teto de custo (#4904)

**Os 3 providers rodam de verdade desde 11/ago/2026** — `ANTHROPIC_API_KEY`
chegou a ficar deliberadamente ausente por decisão do editor (evitar o
setup de uma key de Console pay-as-you-go, sistema de billing separado da
assinatura do Claude Code), mas a decisão foi revertida no mesmo dia: o
editor criou a org em console.anthropic.com, comprou US$5 de crédito e
configurou um teto de gasto mensal de US$10 na própria org (independente
do `--max-monthly-usd` deste script, que é um teto adicional a nível de
aplicação).

**OpenAI/Google — medido em rodada completa dos 2 painéis (36 chamadas,
`data/geo-citations/history.jsonl`, 11/ago/2026):**

| Provider | Chamadas | Tokens in | Tokens out | Custo (PISO, só token) |
|---|---|---|---|---|
| OpenAI (`gpt-4.1`) | 18 | 278.300 | 16.353 | US$ 0,687 |
| Google (`gemini-2.5-flash`) | 18 | 246 | 12.420 | US$ 0,031 |
| **Total** | **36** | **278.546** | **28.773** | **US$ 0,719** |

Isso já responde a suspeita original da issue: o input da OpenAI é
desproporcionalmente maior (278k vs 246 tokens) porque o conteúdo retornado
pela busca server-side do `web_search` entra como token de INPUT na conta
("search content tokens billed at model rates", confirmado na doc oficial)
— o Google conta grounding à parte do `usageMetadata` lido aqui. Números
estáveis, baixa variância entre chamadas.

**Anthropic — medido, mas com variância real que não dá pra resumir num
número único.** Múltiplas chamadas isoladas com a MESMA pergunta, em
tentativas separadas no mesmo dia:

| Tentativa | Resultado | Detalhe |
|---|---|---|
| 1 | Sucesso, 25s | 3 buscas (`max_uses:5` original) |
| 2 | Timeout aos 60s | sem sucesso mesmo com 2,4x o timeout default |
| 3 | Sucesso, 25s | 3 buscas |
| Rodada completa (8 perguntas, `max_uses:5`, timeout 120s) | 3/8 sucesso, 5/8 timeout | custos dos 3 sucessos: US$0,167 / US$0,284 / US$0,065 (input 70k-121k tokens — busca retorna MUITO conteúdo) |
| 4 (após reduzir `max_uses` pra 2, esperando latência mais previsível — script de teste avulso com timeout de 180s, maior que os 120s shipados) | Timeout aos 180s | reduzir `max_uses` NÃO eliminou o timeout — não é proporcional ao número de buscas. O código de produção aborta em 120s, então esta tentativa específica (180s) não é reproduzível pelo caminho real — foi só pra confirmar que o problema não era o teto de tempo. |

**O que isso significa pra custo real:** uma chamada bem-sucedida da
Anthropic custa entre US$0,065 e US$0,284 (PISO, só token — variação de ~4x
dependendo de quanto conteúdo de busca volta). Uma chamada que dá timeout
AINDA é cobrada pelo que o servidor processou antes do corte do cliente —
medido entre US$0,02 e US$0,07 por timeout, mesmo sem produzir
`estimatedCostUsd` no registro (é dinheiro real, só não fica no campo
estruturado porque o request nunca voltou uma resposta completa pra
extrair usage). Uma rodada de 8 perguntas com metade das chamadas falhando
em timeout fica bem abaixo de US$2 mesmo no pior caso observado — dentro
do teto de US$10/mês configurado no Console, com folga.

**O PISO não é o custo total** — falta a taxa fixa da ferramenta de busca em
si, que este monitor não paga (não está no orçamento medido acima, só
projetada a partir da doc oficial, verificada ao vivo em 11/ago/2026):
- Anthropic: US$10,00/1.000 buscas — cada chamada bem-sucedida faz até 2
  (`max_uses:2`), então ≈ US$0,02/chamada adicional no pior caso.
- OpenAI: US$10,00/1.000 chamadas de `web_search` — 18 chamadas/semana ≈
  US$0,18/semana adicional.
- Google: grounding grátis até 500 (tier free) ou 1.500 (tier pago)
  requisições/dia — 18/semana fica muito abaixo dos dois limiares, então a
  omissão tende a ser exata (US$0) nesta cadência, não só piso.

**Estimativa grosseira do total mensal, com a variância da Anthropic
embutida:** OpenAI+Google ficam em ~US$3,90/mês (medido, estável — ver
tabela acima, ×4,33 semanas). A Anthropic soma algo entre ~US$2/mês (maioria
das chamadas falhando rápido e barato) e ~US$10/mês (maioria bem-sucedida a
US$0,17-0,28/chamada) — a faixa é larga de propósito, porque a variância é
real e não foi possível estreitá-la sem gastar mais em testes ao vivo.
Mesmo no topo da faixa, o total fica dentro da folga de "dezenas de dólares
por mês" do #4466 e do teto de US$10/mês da org no Console — não é preciso
reduzir cadência nem cortar pergunta, mas vale reavaliar depois de
algumas semanas de dado real acumulado.

`queryProvider` (`scripts/lib/geo-citation-monitor.ts`) chama
`provider.extractUsage` (opcional por provedor, mesmo contrato puro/
defensivo de `extractText`) e grava campos NOVOS e OPCIONAIS em cada
`GeoCitationRecord`: `inputTokens`, `outputTokens`, `searchCount` (contagem
de buscas server-side, quando o provedor expõe) e `estimatedCostUsd`.

- **Anthropic**: os 4 campos são populados **quando a chamada termina antes
  do timeout** (`GeoProviderDef.timeoutMs`, 120s pra este provider —
  bem maior que o default de 25s dos outros dois, ver docstring pro achado
  de latência) — `estimatedCostUsd` reusa
  `scripts/lib/pricing.ts::estimateCallCostUsd` (tabela de pricing do
  próprio Claude Code, não deste monitor). Chamadas que dão timeout viram
  registro de erro (`errorKind: "network"`), sem usage — mas o custo real
  foi incorrido mesmo assim (ver tabela acima).
- **OpenAI/Google** (#4904 item 4): `inputTokens`/`outputTokens`/
  `estimatedCostUsd` são populados via `GEO_NON_ANTHROPIC_TOKEN_PRICING`
  (`scripts/lib/geo-citation-monitor.ts` — tabela própria, separada da
  Claude, verificada ao vivo em 11/ago/2026 contra
  `developers.openai.com/api/docs/pricing` e
  `ai.google.dev/gemini-api/docs/pricing`). Model fora da tabela (ex:
  override via `{ENVKEY}_MODEL` pra um model não catalogado) → `undefined`,
  nunca um número inventado.
- Registros escritos ANTES do #4904 (os 40 originais) não têm nenhum destes
  campos — leitores (`summarizeGeoCitationRecords`, o alarme de staleness)
  continuam funcionando sem eles.

**Teto de gasto mensal** (`--max-monthly-usd <usd>`, CLI): antes de disparar
a 1ª chamada da rodada, soma `estimatedCostUsd` de todos os registros do MÊS
CORRENTE já em `history.jsonl` e aborta (exit 3) se o total já cruzou o
teto — independe de `--strict`. Fail-open EXPLÍCITO (nunca silencioso)
quando o mês não tem nenhum registro com `estimatedCostUsd` (ex: 1ª rodada
do mês): a rodada segue, mas com um AVISO no log — ausência de dado nunca é
tratada como "gastou zero".

**Wired na task real desde #4904** (achado do silent-failure-hunter: até
então nenhum guard de custo rodava de fato — o único freio era o teto de
US$10/mês configurado direto na org do Console, opaco pra este repo, sem
log nem registro se fosse atingido). `SCHEDULED_TASKS`
(`scripts/lib/scheduled-tasks.ts`) passa `--max-monthly-usd 8` nos dois
steps (`geral` e `hubs`) — deliberadamente ABAIXO dos US$10 do Console,
porque este guard é um PISO (não conta chamadas da Anthropic que deram
timeout mas foram cobradas mesmo assim — ver tabela acima) e precisa de
folga pra disparar ANTES do teto rígido do Console, com uma mensagem clara
em vez de um erro de pagamento cru. Com a faixa medida acima (OpenAI+Google
~US$3,90/mês estável + Anthropic ~US$2-10/mês variável), US$8 pode apertar
no pior caso observado da Anthropic — vale revisar depois de acumular mais
semanas de dado real (o próprio guard avisa via `--strict` se isso
acontecer, não falha em silêncio).

## Exit code honesto sob `--strict` (#4754)

Rodado **na mão**, o monitor continua saindo 0 mesmo sem key configurada —
"sem key" é estado válido, decisão deliberada do #4616 que não foi revertida.

Rodado **pela task** (o wrapper passa `--strict`):
- sai **2** se nenhum provider está configurado (caminho que não escreve nada
  em `history.jsonl`).
- sai **1** se 100% das consultas falham (ali o exit 0 seria mentira, a task
  marcaria verde para sempre enquanto a série congelava).
- falha **parcial** continua 0 nos dois modos (o fail-soft por provedor é
  desenhado).
- **exceção**: 100% de HTTP **429** sai 0 com aviso, não 1 — as 8 perguntas
  de um provider saem em sequência com um único retry de 1,5s, e num free
  tier de RPM baixo (o Gemini é o caso concreto) isso pode dar 429 em todas
  TODA semana sem nada estar quebrado; alarme falso recorrente treina o
  editor a ignorar o alarme.

Erro de outra natureza nomeia a causa dominante (`HTTP 401 (8)`,
`network (8)`) em vez de um genérico "verifique as keys". A decisão vive em
`resolveStrictOutcome`, função pura exportada e testada — não embutida no
`main()`, que não tem ponto de injeção.

## Log

`data/geo-citations/.monitor.log` (append-only).

## Staleness

Um guard que só confirma "a task está registrada" cobre só o registro
inicial — não checa `State`/`LastTaskResult`. Uma task registrada e depois
**desabilitada** passa nele em silêncio. O alarme que fecha essa lacuna é a
#4755 — ver `docs/geo-citation-staleness-alarm-setup.md`. (`scripts/lib/pending-scheduled-tasks.ts`,
que fazia esse tipo de checagem contra os antigos `.ps1` do Windows, foi
removido no #5115 — cutover final.)

## Painel temático, alarme de queda de provedor, aviso de conflito OneDrive (#4900)

Três defeitos achados na auditoria de 10/ago, endereçados por código nesta
issue (a documentação completa do achado — incluindo o paper que embasa a
cadência semanal — vive no corpo da própria issue, não duplicada aqui):

- **`--panel geral|hubs`** (default `geral`, comportamento inalterado). O
  painel `hubs` (`GEO_HUB_QUESTIONS`) cobre o que as páginas
  `arquivo.diar.ia.br/temas/{slug}` respondem (Anthropic/Claude, OpenAI/
  ChatGPT, Google/Gemini) — série SEPARADA de `GEO_QUESTIONS`, nunca uma
  substituição (trocar as perguntas originais depois de já ter série medida
  invalidaria o baseline de 07/ago). **Deliberadamente fora do cron por
  enquanto** — ativar antes de fechar o duplo escritor (item abaixo / épica
  #4798) multiplicaria o registro perdido a cada rodada nova.
- **Aviso de queda de provedor.** Se a rodada atual roda com menos providers
  configurados que a rodada anterior do mesmo painel (ex: `GEMINI_API_KEY`
  ficou vazia nesta máquina), o log imprime um `AVISO` explícito — antes,
  "rodou sem esse provedor" só era recuperável contando linha por linha em
  `history.jsonl` a mão. Não muda o exit code; é sinal, não alarme por
  e-mail (ver issue #4900 item b pro desenho completo do alarme, ainda não
  implementado).
- **Aviso de conflito de escrita OneDrive.** Se `data/geo-citations/`
  contiver algum arquivo `*-safeBackup-*` (padrão do cliente OneDrive Linux
  quando 2 máquinas escrevem `history.jsonl` na mesma janela — achado ao
  vivo: `history-predator-safeBackup-0001.jsonl`, 8 registros órfãos), o
  monitor avisa a cada execução. **Só detecta, não reconcilia** — mesclar o
  arquivo órfão de volta é operação manual sobre dado real de produção. A
  causa raiz (2 máquinas rodando a mesma task) fecha com a épica #4798.

## Setup (ação local one-time do editor)

`local` — precisa do junction `data/` (OneDrive) + ao menos UMA de
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`. O antigo `.ps1` do
Windows foi removido no #5115 (cutover final).

```bash
npx tsx scripts/setup-systemd-timers.ts --task Diaria-Geo-Citation-Monitor
systemctl --user daemon-reload
systemctl --user enable --now diaria-geo-citation-monitor.timer
```

Isso registra a task `Diaria-Geo-Citation-Monitor` (domingos 07:00).
Idempotente — re-executar regenera os units. Remover:
`systemctl --user disable --now diaria-geo-citation-monitor.timer`.

**Task armada e confirmada ativa (#4901, 10/ago)** — `systemctl --user
is-active diaria-geo-citation-monitor.timer` retorna `active`, com disparo
real registrado em 10/ago 13:30 UTC e próximo agendado pra 17/ago. O comando
de arme em si (`scripts/setup-systemd-timers.ts`, via o registro declarativo
`scripts/lib/scheduled-tasks.ts`) **não roda em unidade de worktree isolado**
(mesma disciplina do #4320/#4382/#4490/#4534/#4723, credencial/estado de
máquina fica fora do worktree do subagente) — mas, diferente do estado
descrito em rodadas anteriores, aqui não falta cadência: a task já existe, já
disparou e já tem histórico real acumulado nesta máquina.
