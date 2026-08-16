# Meta Ads MCP — categorias de tools e política de escrita (#5238)

Conector conectado em claude.ai (sessão develop 260816c, 16/08/2026) — `mcp.facebook.com/ads`, OAuth via Meta Business, escopo restrito à conta de anúncios do projeto (ID `2675087492865991`).

## Estado desta documentação

**Parcial.** A doc oficial da Meta (link abaixo) descreve 29 tools agrupadas em 7 categorias, mas não expõe o nome individual de cada tool na página consultada (conteúdo truncado/não indexado pela busca). O que segue é a classificação por CATEGORIA, direto da fonte oficial — suficiente pra aplicar o guard "nunca escrita fora de gate humano" (regra do CLAUDE.md/#5238), mas **não é a lista granular** que o escopo original da issue pedia.

**Pendência real:** enumerar os 29 nomes exatos (ex: `get_insights`, `create_campaign` — nomes reais desconhecidos ainda). Isso é trivial de fechar assim que o conector aparecer disponível numa sessão do Claude Code (`ToolSearch` sobre as tools reais, muito mais confiável que qualquer doc de terceiro) — a sessão que conectou o conector não o viu disponível (conector adicionado via browser não propaga pra sessão já aberta). Próxima sessão que tiver o conector carregado deve rodar `ToolSearch("meta ads facebook", 40)` (ou equivalente) e substituir esta lista por categoria pela lista granular real.

**Cuidado ao pesquisar depois:** buscas web sobre "Meta Ads MCP" retornam majoritariamente implementações NÃO-oficiais de terceiros (pipeboard-co, gomarble-ai, David-mo, inventech-solution — todos MCP servers próprios, hospedados fora da Meta, com nomes de tool DIFERENTES do servidor oficial). Não confundir — só `mcp.facebook.com/ads` é o servidor oficial que este projeto conectou.

## Categorias (fonte oficial, 16/08/2026)

| # | Categoria | Classificação | Descrição (fonte) |
|---|---|---|---|
| 1 | Comprehensive reporting | **LEITURA** | "Gain valuable insights and pull detailed reporting" |
| 2 | Ad creation and management | **ESCRITA** | "Create and edit ads, ad sets, and campaigns" |
| 3 | Catalog creation and management | **ESCRITA** | "Create a catalog and add product data" (categoria mais pesada — 10 das 29 tools, segundo cobertura de terceiros não-oficial) |
| 4 | Signals and datasets | LEITURA | "Access signal health and quality information" |
| 5 | Help and troubleshooting | LEITURA | "Execute a search of Meta Business Help Center articles" |
| 6 | A/B tests and conversion lift studies | **ESCRITA** | "Create and manage A/B tests and conversion lift studies" |
| 7 | Activity logs | LEITURA | "Get visibility into activity log changes" |

## Regra aplicada (até a lista granular existir)

**Qualquer tool das categorias 2, 3 ou 6 (Ad creation/management, Catalog, A/B tests) é tratada como ESCRITA — proibida fora de gate humano supervisionado**, mesmo padrão já em vigor pra outros conectores com mutação (CLAUDE.md, "Nunca usar tool de escrita em rodada desassistida"). Categorias 1, 4, 5, 7 são leitura segura, liberadas pra uso autônomo (overnight/develop) assim que o conector estiver disponível na sessão.

**Nenhuma campanha foi criada, editada ou tem orçamento definido nesta sessão** — decisão explícita do editor (16/08/2026): criar campanha real é decisão de gasto, feita por ele, não pela automação.

## Fonte

- Meta for Developers — [Ads MCP Server Overview](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview)
- Meta for Developers — [blog de lançamento, 16/07/2026](https://developers.facebook.com/blog/post/2026/07/16/meta-ads-mcp-server/)

## Escopo restante da issue #5238

- [ ] Lista granular das 29 tools por nome (pendência acima)
- [ ] Script de ingestão pro `spend.csv` de #5236 — precisa de gasto real de campanha pra testar contra, ainda não existe
