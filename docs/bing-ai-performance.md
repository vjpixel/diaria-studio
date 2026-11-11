# Bing AI Performance e Topics Portfolio — investigação #12241

Verificado em **07/11/2026 (UTC)**. Resultado: **não foi localizado contrato
público oficial para obter AI Performance/Topics Portfolio pela API JSON
usada no projeto**. A coleta fica pendente de ação manual no Windows;
a issue #12241 deve permanecer aberta com a label `windows`.

## Evidência oficial e limites da conclusão

- O [catálogo oficial IWebmasterApi](https://learn.microsoft.com/en-us/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi?view=bing-webmaster-dotnet)
  lista os métodos de estatísticas de busca, links, palavras-chave e cadastro,
  mas não oferece método de citações de IA, tópicos ou opportunity queries.
- A [documentação da API](https://learn.microsoft.com/en-us/bingwebmaster/)
  descreve estatísticas de busca/indexação. A retirada anunciada de SOAP/POX
  não implica retirada da API JSON usada aqui, validada abaixo.
- A [ajuda oficial de AI Performance](https://www.bing.com/webmasters/help/ai-performance-9f8e7d6c)
  confirma exportação CSV/Excel de queries, páginas citadas e séries temporais.
  O conteúdo foi consultado pelo índice público de busca; a abertura direta
  da página de ajuda retornou apenas o shell JavaScript. Não houve login.
- O [anúncio oficial de Topics Portfolio](https://blogs.bing.com/webmaster/2026/10/introducing-topics-portfolio-beta-in-ai-performance/)
  descreve acesso pelo painel e condiciona a exibição a dados suficientes.
  Não documenta API nem confirma exportação das opportunity queries dessa aba.

Ausência de contrato publicado é o limite desta investigação, não prova de
inexistência de endpoints internos. Não foram adivinhados nomes de métodos,
inspecionados endpoints privados nem automatizada a interface logada.

## Chamadas reais, sem credenciais no registro

Foram feitas cinco requisições GET somente de leitura, usando
`BING_API_BASE` de `scripts/lib/bing.ts` e a `BING_WEBMASTER_API_KEY`
existente, carregada pelo `loadProjectEnv()` canônico. Nenhum serviço pago
foi acionado. Não registrar URLs autenticadas, chave, códigos DNS ou a
resposta bruta de `GetUserSites` (ela contém códigos de verificação).

`GetUserSites`, em `2026-11-07T00:29:27.962Z`: HTTP 200, quatro propriedades
com `IsVerified=true`, correspondentes às quatro linhas abaixo.

`GetQueryStats`, entre `00:29:49.893Z` e `00:29:51.521Z` do mesmo dia:

| Propriedade | HTTP | Linhas retornadas |
| --- | --- | --- |
| `https://diar.ia.br/` | 200 | 209 |
| `https://arquivo.diar.ia.br/` | 200 | 36 |
| `https://livros.diar.ia.br/` | 200 | 129 |
| `https://cursos.diar.ia.br/` | 200 | 19 |

Os campos de cada linha foram `AvgClickPosition`, `AvgImpressionPosition`,
`Clicks`, `Date`, `Impressions`, `Query` e `__type`. São estatísticas de
busca tradicional, sem métricas de citação/tópicos. Essas chamadas confirmam
acesso funcional à API nas quatro propriedades; não são um snapshot de IA
nem permitem deduzir ausência ou volume de citações.

## Continuação manual permitida

1. Na máquina Windows do editor, abrir pessoalmente
   [AI Performance](https://www.bing.com/webmasters/aiperformance) e selecionar
   cada propriedade verificada. Usar o mesmo intervalo explícito para todas,
   anotando início, fim, filtros e instante da coleta.
2. Exportar manualmente o CSV oferecido para queries, páginas e série
   temporal. Preservar os arquivos originais em `data/seo/`, ao lado dos
   pulls existentes, com nomes distintos por propriedade, relatório e data
   de coleta. Registrar os nomes efetivos na issue. Não há escrita em
   `data/` pendente desta PR: nenhum dado de IA foi coletado nesta execução.
3. Conferir pessoalmente se Topics Portfolio aparece e se oferece exportação
   própria. A exportação CSV de AI Performance está documentada; a de
   Topics Portfolio/opportunity queries ainda precisa dessa confirmação.
   Se não houver export, transcrever manualmente o resumo na issue,
   identificando propriedade, janela, tópicos e oportunidades observados.
   Distinguir relatório vazio de aba indisponível por volume insuficiente.
4. Com os dados reais, comentar o snapshot na #12241 e cruzar oportunidades
   com #8350 e hubs #4558. Comparar com o monitor sintético apenas no sinal
   e ecossistema cobertos. Não retirar provedor pago sem essa avaliação;
   métricas agregadas de citação não equivalem automaticamente ao teste de
   perguntas fixas do monitor.

Nenhum `--mode ai`, parser de CSV ou snapshot fictício foi adicionado.
Reavaliar automação somente quando o Bing publicar um contrato oficial;
nesse caso validar a resposta real antes de definir formato, testes e pull.
