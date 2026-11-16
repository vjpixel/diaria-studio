# Impressões e taxa de cliques da capa no YouTube (#13192)

Parte 1 da #13192 (épica #12072): medir quantas vezes a capa (miniatura) de cada
vídeo foi mostrada e quantas dessas viraram clique, para saber se uma capa nova
funcionou. As partes 2 (testar capas novas nos 3 horizontais mais vistos) e 3
(levar o que funcionar para o `diaria-video-roteiro`) dependem do editor.

## O que a API expõe

- **YouTube Analytics API v2** (`reports.query`, o que o snapshot já usava):
  **não expõe.** A lista de métricas
  (<https://developers.google.com/youtube/analytics/metrics>, conferida em
  16/11/2026) só tem impressões de card, de teaser de card, de anotação e de
  anúncio (`adImpressions`). Não há impressão de miniatura nem taxa de cliques.
- **YouTube Reporting API** (relatórios em lote): **expõe.** O relatório
  `channel_reach_basic_a1` traz, por dia e vídeo, `video_thumbnail_impressions`
  e `video_thumbnail_impressions_ctr`
  (<https://developers.google.com/youtube/reporting/v1/reports/channel_reports>).
  Uma impressão só conta com a capa visível por mais de 1 segundo e pelo menos
  50% dela na tela. Há também o `channel_reach_combined_a1`, com fonte de
  tráfego, sistema e dispositivo; o snapshot usa só o básico.

## Como entra no snapshot

`scripts/youtube-analytics-snapshot.ts` (task `Diaria-YouTube-Analytics-Snapshot`,
diária) chama `scripts/lib/diaria/youtube-reach.ts`:

1. Procura o job de relatório do `channel_reach_basic_a1`; na primeira execução
   sem ele, cria (`jobs.create`). É configuração de leitura da conta, não
   publica nada (remove-se com `jobs.delete`). `--dry-run` nunca cria.
2. Lista os relatórios do job e baixa os que ainda não estão em
   `data/youtube-analytics/reach-reports.jsonl`. Cada relatório é um CSV de um
   dia (fuso do Pacífico, não BRT). As linhas vão para `reach-daily.jsonl`.
3. Soma por vídeo, desde 21/10/2026, e grava na linha de `videos.jsonl`:
   `thumbnailImpressions`, `thumbnailCtr` (fração, cliques ÷ impressões) e
   `reachLastDay`. `null` quer dizer que nenhum relatório cobre o vídeo ainda.
4. `--report` mostra as colunas "Impressões da capa" e "CTR da capa" na tabela
   por vídeo.

Falha na Reporting API (API desligada no projeto GCP, escopo, rede) vira aviso
e `reach.status` na linha de `channel.jsonl`. O resto do snapshot é gravado
normalmente.

**Ação do editor, uma vez:** ativar a **YouTube Reporting API** no projeto GCP
do client OAuth (console.cloud.google.com, APIs, "YouTube Reporting API"). É
outra API, separada da YouTube Analytics API que o snapshot já usa. O escopo é
o mesmo (`yt-analytics.readonly`). Sem a ativação, o relatório do snapshot
mostra o aviso de API desligada.

### Limites que a Reporting API impõe

- O 1º relatório sai até 48h depois da criação do job.
- O YouTube gera também os **30 dias anteriores** à criação do job. Antes
  disso, o dado só existe no YouTube Studio; por isso a linha de base abaixo.
- Relatório fica disponível por 60 dias (os de histórico, 30). A task diária
  baixa todo dia, então nada se perde enquanto ela rodar.
- Relatório de reprocessamento chega com outro id e o mesmo dia; o mais novo
  (`createTime`) substitui o dia inteiro na soma.

### Premissa a conferir no 1º relatório real

A doc chama `video_thumbnail_impressions_ctr` de porcentagem e define como
cliques ÷ impressões, sem dizer a escala. A escala é FIXA, nunca inferida pelo
conteúdo do arquivo: `YOUTUBE_REACH_CTR_SCALE` em
`scripts/lib/diaria/youtube-reach.ts`, hoje percentual (0,8 = 0,8%). Inferir
por arquivo ("algum valor acima de 1 = percentual") leria como fração o dia em
que todos os vídeos ficassem abaixo de 1% e mostraria 80% (review da PR
#13202). `reach-daily.jsonl` guarda só o valor cru (`ctrRaw` e `clicksRaw`,
impressões × valor cru) e a conversão para fração acontece na leitura, então
trocar a constante corrige todo o histórico sem baixar de novo. Valor fora da
escala (acima de 100 em percentual, acima de 1 em fração, ou negativo) faz o
relatório daquele dia virar aviso e ser baixado de novo na execução seguinte.
Conferir o primeiro relatório contra o Studio: o "Só o Claude Opus 5.5 supera
a IA aberta da Mistral" tinha 0,8% na leitura de 16/11/2026. Se a taxa sair
100 vezes menor que a do Studio (0,008%), o CSV vem em fração: trocar a
constante para `"fraction"`.

## Fonte manual: export do YouTube Studio

Para o período anterior aos 30 dias de histórico da Reporting API, ou se a API
ficar indisponível:

1. YouTube Studio, Análises, **Modo avançado**.
2. Aba **Conteúdo**, filtro **Vídeos** (horizontais; Shorts não têm capa
   clicável no feed de Shorts).
3. Métricas: **Impressões** e **Taxa de cliques de impressões**, além de Views.
4. Período: desde 21/10/2026 (1º vídeo da série) ou a janela que se quer
   comparar.
5. Exportar (ícone de download, CSV) e anotar a data da leitura junto.

Para comparar antes e depois de trocar uma capa (`publish-youtube.ts
--thumbnail-only`, #12134), usar a mesma janela de dias antes e depois da troca;
o "Testar e comparar" do Studio, A/B nativo, não depende deste snapshot.

## Linha de base (YouTube Studio, 16/11/2026)

Lida do Modo avançado do Studio pela análise externa de 16/11/2026, últimos 28
dias, horizontais. É anterior à coleta pela Reporting API.

Canal todo (horizontais): 5,7 mil impressões, **2,2%** de taxa de cliques, 873
views; 55,4% do tráfego vem da página inicial.

| Vídeo | Impressões | Taxa de cliques | Retenção média |
|---|---:|---:|---:|
| Qual modelo do ChatGPT escolher e por quê | — | 12,3% | — |
| Golpe da selfie | — | 9,1% | 63,2% |
| Você já viu IA mentir. Já viu roubar? (4:16) | — | 3,8% | — |
| Só o Claude Opus 5.5 supera a IA aberta da Mistral (5:24) | 718 | 0,8% | 21,5% |
| Nvidia: CEO admite caso (4:19) | 536 | 0,6% | — |

Os 3 horizontais com mais views, candidatos do teste da parte 2: Lula promete
uma IA brasileira (209 views), Você já viu IA mentir. Já viu roubar? (153) e
Claude Code pode ter vazado suas senhas no GitHub (136). Os demais vídeos não
têm leitura de impressões nesta linha de base; os números deles passam a vir do
snapshot quando o 1º relatório de alcance chegar.
