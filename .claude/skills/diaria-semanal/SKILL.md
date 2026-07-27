---
name: diaria-semanal
description: Post semanal de destaques (#4101) — os 5 DESTAQUE 1 das edições de segunda a sexta, produzido na sexta e agendado pra sábado. Só social (LinkedIn, Facebook, Instagram, Threads, Twitter/X) — nunca vira edição no Beehiiv, nunca dispara e-mail. Uso — `/diaria-semanal [AAMMDD-do-sabado] [--schedule] [--no-gates] [--channels linkedin,facebook,instagram,threads,twitter]`.
disable-model-invocation: true
---

# /diaria-semanal

Monta e agenda o post semanal de recapitulação (issue #4101): o DESTAQUE 1 de
cada edição da semana (segunda a sexta), publicado no sábado. Skill própria
(recomendação da issue, mesma lógica de `/diaria-mensal` ser separada do
diário) — invocada uma vez por semana, logo depois que a edição de sexta é
escrita (Stage 2), não como etapa do pipeline diário.

Decisões do editor já tomadas (não são desta skill pra revisitar):

- **Canal: só social.** Nunca Beehiiv, nunca e-mail.
- **Seleção: os 5 D1**, sem ranking por clique, sem re-scoring, sem completar
  com D2/D3 quando uma edição falta.
- **Produção sexta, publicação sábado.**

## Argumentos

- `AAMMDD-do-sabado` — data do sábado de publicação. **Obrigatório e
  explícito** (mesmo invariante de `CLAUDE.md`: nunca inferir de `today()`).
  Se omitido, pergunte ao editor com o próximo sábado como sugestão — nunca
  assuma silenciosamente.
- `--schedule` — sem esta flag, a skill só mostra o PREVIEW (texto formatado
  por rede + horário planejado) e não agenda nada. Com a flag, agenda de
  verdade pelos caminhos agendados existentes (Worker queue / Graph API
  `scheduled_publish_time` — nunca envio imediato).
- `--no-gates` — pula a confirmação interativa do Passo 2 e já roda com
  `--schedule` (auto-aprova, mesmo padrão de `/diaria-edicao --no-gates`).
- `--channels` — CSV pra restringir os canais (default: todos). Valida contra
  a lista conhecida (`linkedin,facebook,instagram,threads`) — canal
  desconhecido/typo **falha alto** listando os válidos, nunca é ignorado em
  silêncio (self-review finding 9).
- `--force-incomplete-week` — necessário quando menos de 4 dos 5 D1 esperados
  foram encontrados (self-review finding 6). Sem a flag, o script imprime um
  aviso e ABORTA — não publica um post materialmente incompleto em silêncio.
  Passe a flag só depois de confirmar com o editor que a semana curta é
  legítima (feriado etc.).

## Pré-requisitos

- As 5 (ou menos) edições da semana precisam ter `data/editions/{AAMMDD}/02-reviewed.md`
  no disco. A issue #4101 aponta o risco de retenção: se `data/editions/{AAMMDD}/`
  for limpo/arquivado antes do sábado, o D1 daquele dia não pode mais ser
  recuperado (o disco é a ÚNICA fonte pra edição de sexta, que ainda não foi
  publicada no Beehiiv no momento da produção). Se isso acontecer com
  frequência, abrir issue pra mover a fonte pra Beehiiv nas 4 primeiras
  edições (`fetch-monthly-posts.ts` já tem o padrão de fetch usado pelo mensal).
- Credenciais (mesmas dos publishers diários): `FACEBOOK_PAGE_ID` +
  `FACEBOOK_PAGE_ACCESS_TOKEN` (Facebook, Graph API direta) e
  `DIARIA_LINKEDIN_CRON_URL` + `DIARIA_LINKEDIN_CRON_TOKEN` (Worker queue —
  LinkedIn/Instagram/Threads).
- Para o Instagram: a última edição da semana (tipicamente sexta) precisa ter
  rodado `scripts/upload-images-public.ts` (gera `06-public-images.json`) —
  sem isso o Instagram é pulado com `reason: public_image_url_missing`
  (best-effort, não bloqueia os outros canais).

## Passo 1 — Preview (sempre, sem `--schedule`)

```bash
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado}
```

Sem `--schedule`, o script nunca faz chamada de rede — só imprime:
- Quais das 5 edições foram encontradas (e quais foram puladas, com motivo).
- Os 5 D1 selecionados (data + título + URL).
- O texto formatado por rede (LinkedIn, Facebook, Instagram, Threads).
- O horário de agendamento planejado.

Se **0 edições** foram encontradas, o script já encerra aqui — nenhum
publisher é chamado, nada é agendado, e a skill deve reportar isso ao editor
sem tentar prosseguir.

Para o Twitter/X (thread — publicado via Buffer MCP, não por este script):

```bash
npx tsx scripts/prep-weekly-twitter.ts --saturday {AAMMDD-do-sabado}
```

Mostra a lista de tweets da thread (`tweets[]`, já ≤280 chars cada,
`tweets[0]` é a abertura).

## Passo 2 — Gate humano (pulado com `--no-gates`)

Mostre o preview completo (5 D1 + texto por rede + thread do X + horário) e
peça confirmação explícita antes de agendar de verdade. Se o editor não
responder ou pedir ajuste, não prossiga silenciosamente.

## Passo 3 — Agendamento real

**LinkedIn, Facebook, Instagram, Threads** — script cuida de tudo, inclusive
persistência de estado (`data/weekly/{AAMMDD}/06-weekly-published.json`,
idempotente via skip-existing):

```bash
npx tsx scripts/publish-weekly-social.ts --saturday {AAMMDD-do-sabado} --schedule
```

**Twitter/X** — como a API só é alcançável via Buffer MCP (sessão de agente,
não script puro — mesmo motivo do X diário, #3994), o ORCHESTRATOR/top-level
faz isto diretamente:

1. Rode `prep-weekly-twitter.ts` (Passo 1) e pegue `tweets[]` + `published_path`.
2. Se `tweets.length === 0` (já publicado ou nenhuma edição válida), pare —
   não chame o Buffer.
3. Para cada tweet, em ordem, chame `mcp__claude_ai_Buffer__create_post` com
   `channelId` do canal @diariabr no X e **agendamento explícito** pro
   horário planejado (nunca "publicar agora" — mesmo guard de publicação de
   todo o resto da pipeline). Encadeie como thread (reply ao tweet anterior)
   se o Buffer suportar; caso não suporte thread nativa, publique os 2+
   primeiros tweets e reporte a limitação ao editor em vez de improvisar.
4. Após cada `create_post`, registre o resultado:
   ```bash
   npx tsx scripts/append-twitter-published.ts \
     --published-path {published_path} \
     --destaque weekly-{n} \
     --status scheduled \
     [--buffer-post-id {id}]
   ```

## Casos de borda (ver #4101)

- **Semana com 4 ou 5 edições**: o post sai com o que existir — nunca
  completa com D2/D3 de outra edição.
- **Semana com 1-3 edições (< 4 de 5 — "materialmente incompleta", self-review
  finding 6)**: o script aborta com um aviso alto a menos que
  `--force-incomplete-week` seja passado explicitamente. Confirme com o
  editor que é uma semana curta legítima (feriado etc.) antes de re-rodar com
  a flag — nunca passe a flag sem essa confirmação.
- **Semana com 0 edições**: nenhum publisher é chamado; reporte isso ao
  editor em vez de publicar um post vazio.
- **Virada de mês/ano**: `computeWeekdayEditionDates` (em
  `scripts/lib/select-weekly-d1.ts`) usa aritmética de `Date` do JS — cruza
  mês/ano corretamente sem lógica de calendário manual (coberto por teste).
