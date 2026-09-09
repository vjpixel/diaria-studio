# workers/meta-leads — Secrets manifest (#7769)

Lista declarativa dos secrets que o Worker `meta-leads` precisa em runtime.
Usada como referência quando o Worker é re-deployado/re-criado (secrets **não**
persistem após `delete + redeploy` — precisam ser re-setados via
`wrangler secret put`).

## Este worker não é fail-soft — e isso é de propósito

O padrão do repo é degradar em silêncio quando falta secret. Aqui **todos os
4 secrets são obrigatórios** e a ausência de cada um tem resposta explícita.

O motivo está no topo de `src/leadgen.ts`, e o precedente é caro: o #5504
(Meta Conversions API) é fail-soft, nunca recebeu o secret
`META_CAPI_ACCESS_TOKEN` nos 3 workers, e virou no-op silencioso — descoberto
meses depois com `server_last_fired_time` ainda em epoch 0 (ver #7776; o
token, aliás, nunca chegou a ser gerado — não existe nem no `.env` nem no
Doppler). Lá o custo foi medição degradada. Aqui seria uma pessoa que
preencheu o formulário, nunca recebeu a newsletter, e cujo clique já foi pago.

**A janela é mais apertada do que parece:** a Meta reentrega qualquer não-200
por ~**7 dias**, não pelos 90 dias de retenção do lead. Uma credencial
inválida por mais de uma semana perde os leads daquele período de vez, mesmo
com o dado ainda existindo do lado da Meta. Por isso o log distingue
`AÇÃO-NECESSÁRIA` (401/403 — token revogado, permissão retirada, key
rotacionada) de `TRANSITÓRIO`: o primeiro nunca se resolve sozinho.

## Required secrets

| Nome | Onde pegar | Sem ele |
|------|-----------|---------|
| `META_APP_SECRET` | **Já existe**: `FACEBOOK_APP_SECRET` no Doppler, do app `Vigil.ia.br` (`2461854084275909`) — é o mesmo app que publica no Facebook/Instagram hoje | **todo POST responde 403** — `verifySignature` recusa sem chave pra validar |
| `META_WEBHOOK_VERIFY_TOKEN` | Escolhido por nós; tem que ser o MESMO valor colado no painel ao criar a subscrição | **handshake responde 503** — a subscrição não chega a ser criada |
| `META_LEADS_PAGE_ACCESS_TOKEN` | Token de página com escopo `leads_retrieval` | **POST responde 500** (pede reentrega) — sem ele o `leadgen_id` não vira dado |
| `KIT_API_KEY` | Mesma chave já usada pelos outros workers (`scripts/lib/kit-config.ts`) | **POST responde 500** (pede reentrega) — o lead chega mas não vira subscriber |

```bash
cd workers/meta-leads
npx wrangler secret put META_APP_SECRET
npx wrangler secret put META_WEBHOOK_VERIFY_TOKEN
npx wrangler secret put META_LEADS_PAGE_ACCESS_TOKEN
npx wrangler secret put KIT_API_KEY
```

## Vars (não secrets)

Nomes de custom field do Kit, declarados em `wrangler.toml` `[vars]` — nome
de campo não é sensível, mesmo tratamento dos 3 workers de cadastro.

`KIT_UTM_SOURCE_FIELD`, `KIT_UTM_MEDIUM_FIELD`, `KIT_UTM_CAMPAIGN_FIELD`,
`KIT_REFERRING_SITE_FIELD`, `KIT_ORIGEM_CADASTRO_FIELD`.

Sem elas o worker calcula a atribuição e a descarta em silêncio (#6318) — o
lead entra no Kit sem origem. Já vieram configuradas no `wrangler.toml`.

`KIT_NAME_FIELD` fica de fora de propósito: os outros workers também não o
declaram hoje, e declarar aqui gravaria nome num campo que pode não existir.
Setar só depois de confirmar o campo na conta.

## Ordem de ativação

Cada passo depende do anterior:

1. Adicionar `leads_retrieval` + `pages_manage_ads` ao app **`Vigil.ia.br`**
   (`2461854084275909`) e regerar o token de página; App Review se a Meta
   exigir.

   **Medido em 09/09/2026, não presumido** — o token de página atual
   (`FACEBOOK_PAGE_ACCESS_TOKEN`, sem expiração) tem só:
   `pages_show_list, business_management, instagram_basic,
   instagram_content_publish, pages_read_engagement, pages_manage_posts,
   public_profile`. Confirmado na prática: `GET /{page}/leadgen_forms` devolve
   403 `Requires pages_manage_ads permission`, e `GET /{page}/subscribed_apps`
   devolve 403 `Requires pages_manage_metadata permission` (esta última só é
   necessária pra INSPECIONAR a subscrição, não pro fluxo em si).
2. Os 4 `wrangler secret put` acima.
3. Subscrever a Página ao campo `leadgen` apontando pra
   `https://meta-leads.<subdomínio>.workers.dev/webhook`. A Meta chama o GET
   de verificação na hora de salvar — os secrets do passo 2 precisam já estar
   no ar, senão o handshake responde 503 e a subscrição falha.
4. Publicar o rascunho `BR · conversao · sem teto — Cópia` (local de conversão
   "Site e formulário instantâneo"), decidindo se o ad set original é pausado
   ou fica em paralelo.

## Como verificar que está funcionando

Não confiar em "deployou, então está OK" — foi exatamente essa suposição que
deixou a CAPI muda por meses. Depois do passo 4, com o primeiro lead real:

```bash
npx wrangler tail meta-leads
```

Um lead processado não loga nada (só erros logam). Para confirmação positiva,
checar o subscriber no Kit com `referring_site = meta-instant-form` — é o
campo que separa lead de formulário instantâneo de quem converteu no site.
