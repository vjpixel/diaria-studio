# Meta Ads MCP — tools e política de escrita (#5238)

Conector conectado em claude.ai (sessão develop 260816c, 16/08/2026) — `mcp.facebook.com/ads`, OAuth via Meta Business, escopo restrito à conta de anúncios do projeto (ID `2675087492865991`).

## Correção de contagem

O material de imprensa da época do lançamento (16/07/2026) fala em "29 tools". A doc oficial (fonte abaixo), lida sessão a sessão em 16/08/2026, lista **88 tools** reais em 7 categorias — o número da imprensa estava errado ou se referia a uma versão anterior/reduzida. Contagem abaixo é a real, extraída ao vivo das 7 páginas oficiais.

## Trava de segurança nativa da Meta

Citação literal da doc oficial (categoria "Ad creation and management"): **"Write tools create entities in a paused state; your AI client asks for confirmation before activation."** — ou seja, `ads_create_campaign`/`ads_create_ad_set`/`ads_create_ad` nunca ativam gasto por si só; só `ads_activate_entity` liga o gasto, e mesmo essa exige confirmação do cliente de IA antes de rodar. Isso não substitui o gate humano deste projeto (ver regra abaixo), mas é uma segunda camada de proteção da própria Meta.

## Regra deste projeto

**Qualquer tool marcada ESCRITA abaixo é proibida fora de gate humano supervisionado** — ressalva registrada originalmente no corpo da issue #5238 (não em CLAUDE.md; o commit anterior desta doc citou CLAUDE.md por engano, corrigido aqui). Tools LEITURA são liberadas pra uso autônomo (overnight/develop) assim que o conector estiver disponível numa sessão do Claude Code — hoje ainda não está (conector adicionado via browser não propagou pra sessão já aberta; próxima sessão que tiver acesso deve confirmar via `ToolSearch`).

**Nenhuma tool foi chamada nesta sessão** — toda a lista abaixo vem da documentação pública, não de inspeção ao vivo do conector.

## 1. Comprehensive reporting / Relatórios abrangentes — 7 tools, todas LEITURA

`ads_get_ad_entities`, `ads_get_opportunity_score`, `ads_insights_advertiser_context`, `ads_insights_anomaly_signal`, `ads_insights_auction_ranking_benchmarks`, `ads_insights_industry_benchmark`, `ads_insights_performance_trend`

## 2. Ad creation and management / Criação e gerenciamento de anúncios — 26 tools

**Leitura (17):** `ads_get_ad_accounts`, `ads_get_ad_account_pages`, `ads_get_pages_for_business`, `ads_get_user_pages`, `ads_get_field_context`, `ads_get_creatives`, `ads_get_creative_ads`, `ads_get_ad_images`, `ads_get_ad_videos`, `ads_get_ad_preview`, `ads_library_search`, `ads_get_ig_accounts`, `ads_get_ig_media`, `ads_get_ad_account_custom_audiences`, `ads_get_custom_audience`, `ads_get_custom_audience_adsets` (`ads_get_ad_entities` já contado na categoria 1, reaparece aqui como tool de query)

**Escrita (9):** `ads_create_campaign`, `ads_create_ad_set`, `ads_create_ad`, `ads_update_entity`, **`ads_activate_entity`** (⚠️ única que efetivamente liga o gasto), `ads_create_creative`, `ads_boost_ig_post`, `ads_create_custom_audience`, `ads_update_custom_audience`, `ads_update_custom_audience_users`, `ads_delete_custom_audience`

## 3. Catalog creation and management / Criação e gerenciamento de catálogos — 32 tools

Fora do escopo prático deste projeto (newsletter, sem catálogo de produto/e-commerce) — documentado por completude, não por uso previsto.

**Leitura (18):** `ads_catalog_get_catalogs`, `ads_catalog_get_details`, `ads_catalog_get_diagnostics`, `ads_catalog_get_dynamic_ads_health`, `ads_catalog_get_data_sources`, `ads_catalog_get_product_details`, `ads_catalog_get_product_product_sets`, `ads_catalog_search_product`, `ads_catalog_get_product_sets`, `ads_catalog_get_product_set_details`, `ads_catalog_get_product_set_products`, `ads_catalog_get_product_feed_details`, `ads_catalog_get_product_feed_upload_sessions`, `ads_catalog_get_feed_rules`, `ads_catalog_event_source_get`, `ads_catalog_event_source_get_catalogs`, `ads_catalog_event_source_get_health`, `ads_catalog_event_source_get_recommendations`

**Escrita (14):** `ads_catalog_create`, `ads_catalog_update_catalog`, `ads_catalog_product_create`, `ads_catalog_update_product`, `ads_catalog_delete_product`, `ads_catalog_create_product_set`, `ads_catalog_update_product_set`, `ads_catalog_product_set_delete`, `ads_catalog_create_product_feed`, `ads_catalog_update_product_feed`, `ads_catalog_create_product_feed_upload_session`, `ads_catalog_product_feed_delete`, `ads_catalog_create_feed_rule`, `ads_catalog_product_feed_delete_rule`, `ads_catalog_event_source_connect`, `ads_catalog_event_source_disconnect`

## 4. Signals and datasets / Sinais e conjuntos de dados — 13 tools

**Não é categoria pura-leitura** (correção vs. versão anterior desta doc, que tinha classificado por rótulo de marketing sem checar a granular).

**Leitura (7):** `ads_get_datasets`, `ads_get_dataset_details`, `ads_get_dataset_stats`, `ads_get_dataset_quality`, `ads_pixel_event_read`, `ads_pixel_parameter_read`, `ads_get_customconversions`

**Escrita (6):** `ads_pixel_event_create`, `ads_pixel_event_update`, `ads_pixel_event_delete`, `ads_pixel_parameter_create`, `ads_pixel_parameter_update`, `ads_pixel_parameter_delete`

## 5. Help and troubleshooting / Ajuda e solução de problemas — 2 tools, todas LEITURA

`ads_get_errors`, `ads_get_help_article`

## 6. A/B tests and conversion lift studies / Testes A/B — 7 tools

**Leitura (4):** `ads_experiment_list_tests`, `ads_experiment_check_eligibility`, `ads_experiment_abtest_get_test`, `ads_experiment_lift_get_test`

**Escrita (3):** `ads_experiment_abtest_create_test`, `ads_experiment_abtest_update_test`, `ads_experiment_lift_create_test`

## 7. Activity logs / Registros de atividades — 1 tool, LEITURA

`ads_account_get_activity_logs`

## Fonte

- Meta for Developers — [Ads MCP Server Overview](https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-mcp-server/ads-mcp-server-overview) (visão geral + tabela de categorias)
- Meta for Developers — páginas individuais por categoria, todas sob `ads-mcp-server-tools-{slug}` (ex: `.../ads-mcp-server-tools-ad-creation-and-management`), acessadas ao vivo em 16/08/2026, `Updated: 14-24 jul 2026` em cada uma
- Meta for Developers — [blog de lançamento, 16/07/2026](https://developers.facebook.com/blog/post/2026/07/16/meta-ads-mcp-server/)

**Cuidado ao pesquisar depois:** buscas web sobre "Meta Ads MCP" retornam majoritariamente implementações NÃO-oficiais de terceiros (pipeboard-co, gomarble-ai, David-mo, inventech-solution — MCP servers próprios, hospedados fora da Meta, nomes de tool DIFERENTES). Só `mcp.facebook.com/ads` é o servidor oficial que este projeto conectou; os nomes `ads_*` acima vêm todos da doc oficial da Meta, não de terceiros.

## Escopo restante da issue #5238

- [x] ~~Lista granular das 29 tools por nome~~ — feito acima (88 tools reais, não 29)
- [ ] Script de ingestão pro `spend.csv` de #5236 — precisa de gasto real de campanha pra testar contra, ainda não existe (nenhuma campanha foi criada nesta sessão — decisão de gasto é do editor)
