# Monitor semanal de citação por assistente de IA

Issue: [#4558](https://github.com/vjpixel/diaria-studio/issues/4558) (Parte C).

Pergunta a cada provedor de LLM com API key configurada as perguntas fixas de
`GEO_QUESTIONS` (ex: "Qual a melhor newsletter diária sobre inteligência
artificial em português?") e registra se a diar.ia.br foi citada — série de
tendência sobre GEO (Generative Engine Optimization).

## Por que a task existe

O monitor foi mergeado no #4616 e ficou sem NUNCA ter rodado — `data/geo-citations/`
não existia no disco até 07/ago, e nenhum `.ps1`/workflow/task o invocava,
enquanto todas as outras tasks agendadas do repo já seguiam esse padrão. Sem
cadência o histórico nunca acumula.

## Baseline medido em 07/ago (histórico)

**0 de 16 consultas citaram** — 8 perguntas × OpenAI + Gemini, sendo 15
respondidas + 1 erro de rede; `ANTHROPIC_API_KEY` ausente do `.env`, provedor
pulado por fail-soft. Zero não é veredito: o hub tinha 3 dias e ficou órfão
de link interno até o #4749.

Este número fica como registro histórico do ponto de partida da série — não
recitar como veredito. Ver "Critério de decisão" abaixo pro que orienta ação
hoje.

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

Custo por execução **medido ao vivo em 11/ago/2026** (rodada real, os dois
painéis — `geral` 8 perguntas + `hubs` 10 perguntas = 18 perguntas × 2
provedores = 36 chamadas, a MESMA carga de uma semana normal da task): ver
"Captura de usage e teto de custo" abaixo pro número e pra decisão sobre
Anthropic.

## Captura de usage e teto de custo (#4904)

**Decisão do editor (11/ago/2026): a Anthropic não entra nesta medição.**
`ANTHROPIC_API_KEY` fica deliberadamente ausente do `.env` — não é mais um
gap temporário esperando credencial, é a configuração pretendida (ver
docstring do módulo, `scripts/lib/geo-citation-monitor.ts`). O provider
`anthropic` continua no código, fail-soft, pulado sem key como sempre foi.
Item 4 original desta issue pedia medir com as 3 keys; o caminho
alternativo abaixo mede as 2 que rodam de fato.

**Rodada real, 11/ago/2026, `data/geo-citations/history.jsonl` (36 registros,
35 com `estimatedCostUsd`, 1 erro de rede sem usage):**

| Provider | Chamadas | Tokens in | Tokens out | Custo (PISO, só token) |
|---|---|---|---|---|
| OpenAI (`gpt-4.1`) | 18 | 278.300 | 16.353 | US$ 0,687 |
| Google (`gemini-2.5-flash`) | 18 | 246 | 12.420 | US$ 0,031 |
| **Total (1 rodada = 1 semana)** | **36** | **278.546** | **28.773** | **US$ 0,719** |

Isso já responde a suspeita original da issue: o input da OpenAI é
desproporcionalmente maior (278k vs 246 tokens) porque o conteúdo retornado
pela busca server-side do `web_search` entra como token de INPUT na conta
("search content tokens billed at model rates", confirmado na doc oficial)
— o Google conta grounding à parte do `usageMetadata` lido aqui.

**O PISO não é o custo total** — falta a taxa fixa da ferramenta de busca em
si, que este monitor não paga (não está no orçamento medido acima, só
projetada a partir da doc oficial, verificada ao vivo em 11/ago/2026):
- OpenAI: US$10,00/1.000 chamadas de `web_search` — 18 chamadas/semana ≈
  US$0,18/semana adicional.
- Google: grounding grátis até 500 (tier free) ou 1.500 (tier pago)
  requisições/dia — 18/semana fica muito abaixo dos dois limiares, então a
  omissão tende a ser exata (US$0) nesta cadência, não só piso.

**Estimativa total por rodada semanal (as 2 chamadas do `SCHEDULED_TASKS`,
`geral` + `hubs`): ~US$0,90** (US$0,719 medido + US$0,18 taxa fixa OpenAI
projetada) → **~US$3,90/mês** (×4,33 semanas). Bem dentro da folga de
"dezenas de dólares por mês" do #4466 — não é preciso reduzir cadência nem
cortar pergunta.

`queryProvider` (`scripts/lib/geo-citation-monitor.ts`) chama
`provider.extractUsage` (opcional por provedor, mesmo contrato puro/
defensivo de `extractText`) e grava campos NOVOS e OPCIONAIS em cada
`GeoCitationRecord`: `inputTokens`, `outputTokens`, `searchCount` (contagem
de buscas server-side, quando o provedor expõe) e `estimatedCostUsd`.

- **Anthropic**: os 4 campos seriam populados — `estimatedCostUsd` reusa
  `scripts/lib/pricing.ts::estimateCallCostUsd` (tabela de pricing do
  próprio Claude Code, não deste monitor) — **mas na prática nunca roda**
  (decisão acima).
- **OpenAI/Google** (#4904 item 4, caminho alternativo): `inputTokens`/
  `outputTokens`/`estimatedCostUsd` são populados via
  `GEO_NON_ANTHROPIC_TOKEN_PRICING` (`scripts/lib/geo-citation-monitor.ts`
  — tabela própria, separada da Claude, verificada ao vivo em 11/ago/2026
  contra `developers.openai.com/api/docs/pricing` e
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
tratada como "gastou zero". Com o número real acima (~US$3,90/mês
projetado), um teto de US$10/mês dá folga de ~2,5× sem travar a cadência
normal — mas `SCHEDULED_TASKS` (`scripts/lib/scheduled-tasks.ts`) ainda
**não** passa `--max-monthly-usd`; se/quando o teto virar argumento fixo da
task `Diaria-Geo-Citation-Monitor`, ele se declara em `steps[].args` (fonte
única, `scripts/run-task.ts` resolve em runtime).

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

O guard `test/pending-scheduled-tasks.test.ts` descobre esta task pelo nome,
mas cobre só o registro inicial — não checa `State`/`LastTaskResult`. Uma
task registrada e depois **desabilitada** passa nele em silêncio. O alarme
que fecha essa lacuna é a #4755 — ver `docs/geo-citation-staleness-alarm-setup.md`.

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
`ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GEMINI_API_KEY`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-geo-citation-monitor-schedule.ps1
```

Isso registra a task `Diaria-Geo-Citation-Monitor` (domingos 07:00).
Idempotente — re-executar atualiza a task. Remover: mesmo comando com
`-Unregister`.

**Task armada e confirmada ativa (#4901, 10/ago)** — `systemctl --user
is-active diaria-geo-citation-monitor.timer` retorna `active`, com disparo
real registrado em 10/ago 13:30 UTC e próximo agendado pra 17/ago. O comando
de arme em si (`setup-geo-citation-monitor-schedule.ps1` no Windows,
`scripts/setup-systemd-timers.ts` no Linux, via o registro declarativo
`scripts/lib/scheduled-tasks.ts`) **não roda em unidade de worktree isolado**
(mesma disciplina do #4320/#4382/#4490/#4534/#4723, credencial/estado de
máquina fica fora do worktree do subagente) — mas, diferente do estado
descrito em rodadas anteriores, aqui não falta cadência: a task já existe, já
disparou e já tem histórico real acumulado nesta máquina.
