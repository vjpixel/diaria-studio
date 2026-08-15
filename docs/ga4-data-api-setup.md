# GA4 Data API — ingestão de comportamento pós-clique (#5248)

## Por quê

`diar.ia.br` (a home hospedada) é um **custom hostname da Beehiiv** — fora da
nossa zona Cloudflare. `scripts/lib/shared/ai-referrer-log.ts` (log de
`Referer` de assistentes de IA nos Workers de curadoria, #4558 Parte C) é
barato e confiável, mas só enxerga o que passa pelos NOSSOS Workers — a home
em si fica fora do alcance. GA4 é hoje a **única fonte de comportamento
pós-clique** nessa página: o que o visitante faz depois de chegar (sessões,
pageviews, tempo de engajamento, quais outras páginas ele visita) — exatamente
onde o tráfego pago aterrissa.

**Decisão do editor (14/08/2026, #5248, repetida em 3 comentários da issue):
consertar e ingerir, não aposentar.** A Data API tem cota gratuita generosa,
o que não conflita com o princípio de custo zero do projeto.

## Escopo desta unidade (código, sem depender de painel)

Implementado nesta sessão, testável com mock, sem chamar a API real:

- `scripts/lib/ga4-client.ts` — cliente pra `properties.runReport`
  (`analyticsdata.googleapis.com/v1beta`), reusando o MESMO padrão de auth já
  usado por `postmaster-v2-client.ts`/`seo-pull.ts` (`gFetch`/`getAccessToken`
  de `scripts/google-auth.ts`, refresh_token único em
  `data/.credentials.json`) — não um mecanismo de auth novo (nada de service
  account).
- `scripts/ga4-sync.ts` — ingestão: puxa um relatório `overview` (sessions,
  pageviews, sessões engajadas, duração média por dia) e um `top-pages`
  (pageviews por `pagePath`, top 25) sobre uma janela configurável (`--days`,
  default 7), e salva o snapshot em `data/ga4-cache/{YYYY-MM-DD}.json` +
  `data/ga4-cache/latest.json` (ponteiro sempre sobrescrito, mesmo padrão de
  `data/beehiiv-cache/`).
- `test/ga4-client-5248.test.ts` — cobre as funções puras (montagem de
  request, achatamento de linhas, classificação de erro) e `runGa4Report`/
  `buildSyncRequests` com `fetchImpl` fake. Nenhum teste chama a rede.
- Scope `analytics.readonly` adicionado a `SCOPES` em `scripts/oauth-setup.ts`.

## Fail-soft: o que acontece sem a credencial/propriedade configurada

Nesta sessão não existe `GA4_PROPERTY_ID` nem token OAuth com o scope
`analytics.readonly` — isso é esperado, a criação da propriedade/tag é ação de
painel do editor (ver seção abaixo). `scripts/ga4-sync.ts`:

- `GA4_PROPERTY_ID` ausente/vazio → `Ga4ConfigError`, mensagem aponta pra
  este doc, exit code **2** (config ausente) — nunca uma stack trace genérica.
- Credencial OAuth ausente ou sem o scope novo → `GoogleAuthError`/403
  `ACCESS_TOKEN_SCOPE_INSUFFICIENT`, mensagem orienta rodar
  `npx tsx scripts/oauth-setup.ts` e reaprovar no browser, exit code **2**.
- Outros erros de API/rede → exit code **1**, mensagem de
  `describeGa4Failure` (property inexistente, API desabilitada no projeto
  GCP, 429 de cota, etc — sempre com o próximo passo, nunca uma exceção crua).

`--dry-run` monta e imprime os requests sem chamar a rede — útil pra validar
a configuração antes do 1º fetch real.

## Uso

```bash
# depois da propriedade/tag/token estarem configurados (ver abaixo):
npx tsx scripts/ga4-sync.ts                 # janela padrão, 7 dias
npx tsx scripts/ga4-sync.ts --days 30
npx tsx scripts/ga4-sync.ts --dry-run        # só monta os requests, não chama a API
```

## Passos de painel que ficam com o editor (label `local` — fora de escopo desta unidade)

Estes passos exigem acesso ao Google Tag Manager / GA4 / Google Ads — nenhum
deles foi feito por esta unidade (regra do dispatch #5248: sem depender de
painel).

1. **Checar as tags do container GTM `GTM-TC8C65ZN`** — quais existem hoje
   além da tag de conversão do LinkedIn.
2. **Publicar (ou instalar + publicar) a tag de configuração do GA4** no
   mesmo container, apontando pro Measurement ID (`G-XXXXXXX`) da
   propriedade GA4 do projeto.
3. **Confirmar que a propriedade recebe evento** — checar se há dado nos
   últimos 30 dias em GA4 → Relatórios → Tempo real / Aquisição, ou pode ficar
   zerada por a tag nunca ter sido publicada (o sinal original da issue: e-mails
   de `ads-noreply@google.com`/`analytics-noreply@google.com` avisando que
   nenhuma tag foi encontrada).
4. **Pegar o Property ID numérico** — GA4 → Admin → Detalhes da propriedade
   (NÃO é o Measurement ID `G-XXXXXXX` que aparece na tag) — e setar
   `GA4_PROPERTY_ID` no `.env`/Doppler.
5. **Reconferir a tag de conversão do Google Ads (`17790097065`, #4348)**
   antes de religar qualquer campanha — a #4348 (fechada) registrou que ela
   disparava em `All Pages` em vez de só no signup, inflando conversão;
   confirmar que o conserto está publicado.
6. **Habilitar a Google Analytics Data API** no mesmo projeto GCP do OAuth
   client (`console.cloud.google.com` → APIs → Google Analytics Data API →
   Ativar) — sem isso, `ga4-sync.ts` falha com `SERVICE_DISABLED` mesmo com
   o scope OAuth correto (mesma armadilha documentada em
   `docs/postmaster-spam-sync-setup.md`/`docs/google-ads-api-setup.md` pras
   respectivas APIs).
7. **Rodar `npx tsx scripts/oauth-setup.ts`** e reaprovar no browser — o
   refresh token existente (se houver) não ganha o scope `analytics.readonly`
   sozinho.
8. **Garantir que a conta OAuth usada tem acesso de leitura à propriedade**
   GA4 (Admin → Gerenciamento de acesso à propriedade) — 403 sem código de
   scope reconhecido geralmente é esse.

Depois desses passos: `npx tsx scripts/ga4-sync.ts --dry-run` pra validar a
config, depois sem `--dry-run` pro 1º snapshot real.

## Estado (15/08/2026)

- [x] Cliente da Data API (`scripts/lib/ga4-client.ts`)
- [x] Script de ingestão (`scripts/ga4-sync.ts`), snapshot em `data/ga4-cache/`
- [x] Testes com mock (`test/ga4-client-5248.test.ts`)
- [x] Scope `analytics.readonly` em `scripts/oauth-setup.ts`
- [x] `GA4_PROPERTY_ID` documentado em `.env.example`
- [ ] Tag de configuração GA4 publicada no GTM (`GTM-TC8C65ZN`) — **ação do editor**
- [ ] Propriedade GA4 confirmada recebendo dado nos últimos 30 dias — **ação do editor**
- [ ] Tag de conversão do Google Ads (`17790097065`, #4348) reconferida antes de religar campanha — **ação do editor**
- [ ] `GA4_PROPERTY_ID` real setado no `.env`/Doppler — **ação do editor**
- [ ] 1ª rodada real de `ga4-sync.ts` contra a API — depende de todos os itens acima

A issue #5248 permanece **aberta** (`REFS`, não `Closes`) até esses passos de
painel serem concluídos pelo editor.
