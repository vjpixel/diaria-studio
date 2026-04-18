---
name: diaria-atualiza-audiencia
description: Regera `context/audience-profile.md` puxando respostas de survey via Beehiiv MCP.
---

# /diaria-atualiza-audiencia

Atualiza o perfil de audiência a partir das respostas mais recentes do survey no Beehiiv.

## Execução

1. Ler `platform.config.json` → `beehiiv.publicationId` (formato `pub_<uuid>`). Se ausente, chamar `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_publications` e persistir o id.
2. Chamar `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_surveys` com `publication_id = beehiiv.publicationId`.
3. Identificar a survey principal de perfil da Diar.ia (ou perguntar ao usuário se houver mais de uma).
4. Chamar `mcp__ed929847-ab29-43d9-a6ba-60b687b65702__list_survey_responses` com `survey_id` dessa survey, paginando com `per_page = 100` até esgotar.
5. Salvar respostas brutas em `data/audience-raw.json` (array JSON no formato que `scripts/update-audience.ts` espera — ver comentário no topo do script).
6. Rodar: `npx tsx scripts/update-audience.ts data/audience-raw.json`.
7. O script:
   - Arquiva `context/audience-profile.md` atual em `context/audience-history/{YYYY-MM-DD}.md`.
   - Gera novo `context/audience-profile.md` com pesos por content_type, sector, themes.
8. Mostrar ao usuário o topo do arquivo gerado para confirmação.

## Notas

- Se uma resposta não tiver campos esperados, loggar e seguir — não trave.
- Respostas inativas/bounce já são filtradas pelo `status !== "active"` no script.
