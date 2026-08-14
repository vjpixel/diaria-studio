---
name: diaria-atualiza-audiencia
description: Regera `context/audience-profile.md` combinando CTR comportamental com respostas de survey do Beehiiv. O glue determinístico ao redor da leitura de survey delega para `scripts/audience-run.ts` (#5192); listar/paginar a survey em si continua MCP (Beehiiv não expõe isso na API REST pública).
---

# /diaria-atualiza-audiencia

Atualiza o perfil de audiência a partir das respostas mais recentes do survey no Beehiiv.

**Desde #5192, `scripts/audience-run.ts` é o *glue* determinístico** — mesmo padrão do #4941 (`clarice-novos-run.ts`): esta skill nunca reimplementa o fluxo, extrai valor de um passo e injeta no próximo à mão; ela invoca o script, que faz a resolução de config, a validação fail-soft das respostas, a gravação de `data/audience-raw.json` no formato certo e o disparo de `update-audience.ts`.

**Por que não é 100% script (achado #5192).** `refresh-dedup.ts` prova que POSTS saem por REST com `BEEHIIV_API_KEY` — mas surveys não são o mesmo recurso. Verificado sem tocar credencial real (doc pública + sondagem HTTP sem key: rotas conhecidas como `GET /publications`, `.../custom_fields`, `.../polls` devolvem 401 — existem, só falta auth; toda variante de rota pra surveys devolve 404 — não existe). `mcp__claude_ai_Beehiiv__list_surveys`/`list_survey_responses` não têm equivalente REST público — são MCP-only, mesma classe de `list_post_clicks`/`list_post_subscriber_engagement` (`beehiiv-clicks-enricher`). Por isso o fluxo tem exatamente 2 chamadas MCP que **precisam** continuar sendo feitas por uma sessão com acesso ao conector — o script cuida de tudo em volta.

## Execução

**Fase 1 — resolver publicationId + survey (o script tenta sozinho o que der por REST):**

```bash
npx tsx scripts/audience-run.ts --resolve-only
```

- `beehiiv.publicationId`: se já está em `platform.config.json`, o script só confirma. Se ausente, ele mesmo chama `GET /publications` (REST, existe de verdade) e persiste — sem MCP.
- `beehiiv.profileSurveyId`: se já está em `platform.config.json`, o script só confirma (fonte de verdade, resolvida uma vez). Se ausente, **o script sozinho não consegue** — abortará pedindo `--surveys-json <arquivo>`. Nesse caso:
  1. Chame `mcp__claude_ai_Beehiiv__list_surveys` com `publication_id` (visto no erro do passo acima, ou em `platform.config.json`).
  2. Salve o array retornado num arquivo (ex: `data/_tmp/surveys.json`).
  3. Rode de novo: `npx tsx scripts/audience-run.ts --resolve-only --surveys-json data/_tmp/surveys.json`. Com exatamente 1 survey, o script resolve e persiste sozinho. Com mais de 1, ele aborta listando os candidatos — **decida com o usuário e escreva `beehiiv.profileSurveyId` manualmente em `platform.config.json`** (nunca adivinhar).

O comando acima imprime `{"publicationId": "...", "profileSurveyId": "..."}` em stdout quando resolve com sucesso — esses são os IDs pra Fase 2.

**Fase 2 — coletar as respostas via MCP (não tem como ser REST, ver achado acima):**

Chame `mcp__claude_ai_Beehiiv__list_survey_responses` com o `survey_id` da Fase 1, paginando com `per_page = 100` até esgotar. Concatene TODAS as páginas num único array JSON e salve num arquivo (ex: `data/_tmp/audience-responses.json`).

**Fase 3 — delegar o resto pro script:**

```bash
npx tsx scripts/audience-run.ts --responses data/_tmp/audience-responses.json
```

O script:
- Valida cada resposta (item malformado é logado e pulado — fail-soft, nunca trava o lote).
- Grava `data/audience-raw.json` no formato que `scripts/update-audience.ts` espera.
- Roda `update-audience.ts` (spawn), que arquiva o profile atual em `docs/audience-history/{YYYY-MM-DD}.md` e gera o novo `context/audience-profile.md` com pesos por content_type, sector, themes.
- Imprime o topo do arquivo gerado (stdout) para confirmação.

`--dry-run` roda a validação e mostra o que faria, sem gravar nada nem chamar `update-audience.ts` — útil pra conferir a normalização antes de aplicar de verdade.

## Exit codes

- `0` — sucesso (resolve-only, dry-run, ou fluxo completo).
- `1` — erro duro: ambiguidade não resolvida (publicações/surveys múltiplas), `--responses` ausente fora de `--resolve-only`, arquivo inválido, `update-audience.ts` falhou, ou 0 respostas válidas após normalização.
- `2` — config/env inválida: `platform.config.json` ilegível, ou `publicationId` ausente sem `BEEHIIV_API_KEY` pra resolver via REST.

## Notas

- Fail-soft é do script, não da skill: uma resposta malformada individual nunca trava a rodada inteira — é logada e pulada, o resto segue normal.
- Respostas inativas/bounce continuam filtradas dentro de `update-audience.ts` (`status !== "active"`), não no script novo.
- Este fluxo é manual/ad-hoc — não está (e não deve entrar, #5192) na registry de tasks agendadas (`scripts/lib/scheduled-tasks.ts`).
