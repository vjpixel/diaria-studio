# Facebook Graph API Setup (Stage 4)

Setup do publisher Facebook do Stage 4 (`scripts/publish-facebook.ts`) para agendar/publicar posts via Graph API.

## Variáveis de ambiente

Adicionar em `.env` (preferido) ou em `data/.fb-credentials.json` (legacy, fallback):

```bash
FACEBOOK_PAGE_ID=839717705901271
FACEBOOK_PAGE_ACCESS_TOKEN=<token de página long-lived>
FACEBOOK_API_VERSION=v25.0
```

`scripts/publish-facebook.ts` lê env vars primeiro, com fallback para o JSON legado.

## Gerar Page Access Token (60 dias)

1. Abrir https://developers.facebook.com/tools/explorer
2. No dropdown de aplicativo, selecionar o app Diar.ia (ou criar se não existe)
3. No dropdown de tokens, selecionar **Page Access Token** → escolher Page Diar.ia
4. Permissões necessárias:
   - `pages_manage_posts` (criar/agendar posts)
   - `pages_read_engagement` (ler estatísticas)
   - `pages_show_list` (listar pages do usuário)
5. Click "Generate Access Token" → copiar o token (~204 chars)

### Trocar por long-lived token (60 dias)

Token gerado pelo Explorer dura ~1 hora. Trocar via endpoint OAuth:

```bash
curl -G "https://graph.facebook.com/v25.0/oauth/access_token" \
  -d "grant_type=fb_exchange_token" \
  -d "client_id=$FACEBOOK_APP_ID" \
  -d "client_secret=$FACEBOOK_APP_SECRET" \
  -d "fb_exchange_token=$SHORT_LIVED_TOKEN"
```

Resposta tem `access_token` long-lived (60 dias). Atualizar `.env`.

### Page ID

Encontrar em https://www.facebook.com/diaria.br → **Sobre** → **ID da página**, ou via Graph API Explorer (`/me/accounts`).

## Validação

```bash
node -e "
  require('dotenv').config();
  console.log('PAGE_ID:', !!process.env.FACEBOOK_PAGE_ID);
  console.log('TOKEN length:', (process.env.FACEBOOK_PAGE_ACCESS_TOKEN||'').length);
"
```

Esperado: `PAGE_ID: true` e `length` ~200.

## Edge cases conhecidos

### `(#100) Tried accessing nonexisting field (is_published)`

Resolvido em #600. Campo `is_published` foi deprecated em Graph API v18+; `verify-facebook-posts.ts` agora infere via `created_time` + `scheduled_publish_time`.

### Token expirado (60 dias)

Sintoma: `(#190) Invalid OAuth access token`. Solução: regenerar via passos acima.

### Posts agendados não aparecem na timeline

Verificar `scheduled_publish_time` (Unix seconds) está no futuro e a Page ID bate com o token. Posts agendados ficam invisíveis na timeline pública até a hora marcada.

## Migração credentials (#608)

Histórico: até #608, credentials ficavam em `data/.fb-credentials.json` (gitignored). Migração mantém esse arquivo como fallback durante transição. Após N edições estáveis com env-only, deletar o arquivo.
