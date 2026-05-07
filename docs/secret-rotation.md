# Rotação de credenciais e playbook de emergência

Este doc é o ponto único de consulta quando alguma credencial expira, é revogada, ou precisa rotação proativa. Cobre todas as 7 credenciais usadas pela pipeline da Diar.ia.

> Em emergência (edição em produção e algo está quebrando agora): pula direto pro [Playbook emergencial](#playbook-emergencial) no fim deste doc.

---

## Inventário

| Credencial | Onde mora | Expiração típica | Sinal típico de falha |
|---|---|---|---|
| `CLARICE_API_KEY` | env var (`.env` + shell + `claude_desktop_config.json`) | Sem expiração nativa | `mcp__clarice__correct_text` retorna 401/403 |
| `GEMINI_API_KEY` | env var (`.env`) | Sem expiração nativa | `scripts/gemini-image.js` retorna 401/`PERMISSION_DENIED` |
| Google OAuth (`refresh_token`) | `data/.credentials.json` | Raramente expira (revogação manual ou 6 meses sem uso) | `google-auth.ts` retorna `invalid_grant` |
| Facebook Page token | `data/.fb-credentials.json` (`page_access_token`) | 60 dias se short-lived; nunca se long-lived com renew | `publish-facebook.ts` retorna 190 (`OAuthException`) |
| `CLOUDFLARE_API_TOKEN` | env var (`.env`) | Sem expiração nativa (até revogação) | `cloudflare-image.js` retorna 401 / `Authentication error` |
| Beehiiv MCP OAuth | `claude.ai/settings/connectors` | Desconhecido (gerenciado pela claude.ai) | Subagentes que usam Beehiiv MCP retornam erro de auth |
| Gmail MCP OAuth | `claude.ai/settings/connectors` | Desconhecido (gerenciado pela claude.ai) | `inbox-drain.ts` retorna `gmail_mcp_error` ou 401 |

---

## Por credencial

### `CLARICE_API_KEY`

- **Para que serve:** revisão linguística no Stage 2 (`mcp__clarice__correct_text`).
- **Onde gerar:** painel da Clarice (entrar em contato com o operador da API; chave hoje vem por canal manual).
- **Onde atualizar:**
  1. `.env` local — substituir o valor de `CLARICE_API_KEY=`.
  2. Shell ambiente persistente:
     ```powershell
     [Environment]::SetEnvironmentVariable("CLARICE_API_KEY", "NOVO_TOKEN", "User")
     ```
     ou no `.zshrc`/`.bashrc` no Linux/macOS.
  3. `claude_desktop_config.json` (mesmo token) — chaves do MCP Clarice local declaradas em `mcpServers.clarice.env.CLARICE_API_KEY`.
- **Como testar:**
  ```bash
  npx tsx -e 'console.log(process.env.CLARICE_API_KEY?.slice(0,8))'
  ```
  e depois rodar Stage 2 manualmente em uma edição de teste.
- **Downtime esperado durante rotação:** ~1 min (reabrir terminal pra carregar env nova).
- **Cadência sugerida:** rotacionar a cada 6 meses ou imediatamente se houver vazamento.

### `GEMINI_API_KEY`

- **Para que serve:** geração de imagens Stage 4 + versão IA do É IA? (Stage 1b).
- **Onde gerar:** [Google AI Studio → Get API key](https://aistudio.google.com/app/apikey).
- **Onde atualizar:** `.env` local.
- **Como testar:**
  ```bash
  curl -H "x-goog-api-key: $GEMINI_API_KEY" \
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"
  ```
  esperado: HTTP 200 com lista de modelos.
- **Downtime esperado:** ~30 segundos.
- **Cadência sugerida:** a cada 90 dias ou se houver suspeita de vazamento.
- **Fallback temporário:** alternar `platform.config.json > image_generator` para `"cloudflare"` enquanto rotaciona (requer `CLOUDFLARE_*` configurados).

### Google OAuth (`data/.credentials.json`)

- **Para que serve:** Drive sync (Stage 0/1/2/3/4 entre gates) + Gmail inbox drain (Stage 1).
- **Onde gerar:**
  1. [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials) — criar OAuth 2.0 Client ID tipo "Desktop app" (caso `GOOGLE_CLIENT_ID`/`SECRET` estejam faltando).
  2. Rodar setup único:
     ```bash
     npx tsx scripts/oauth-setup.ts
     ```
     Abre browser → consent screen → grava `data/.credentials.json` com `access_token` + `refresh_token`.
- **Onde atualizar:** o arquivo `data/.credentials.json` (gitignored).
- **Como testar:**
  ```bash
  npx tsx -e 'import("./scripts/google-auth.ts").then(m => m.getAccessToken()).then(t => console.log("ok", t.slice(0,12)))'
  ```
  esperado: prefixo de access_token válido (`ya29.`...).
- **Sinais de revogação:** `invalid_grant` no log → o refresh_token foi revogado (manual ou inatividade). Re-rodar `oauth-setup.ts`.
- **Downtime esperado:** ~3-5 minutos (re-consent no browser).
- **Cadência sugerida:** sem rotação ativa necessária; só após revogação ou suspeita de comprometimento.

### Facebook Page token (`data/.fb-credentials.json`)

- **Para que serve:** publicação Stage 6 dos posts no Facebook (Page) via Graph API.
- **Onde gerar:**
  1. [Meta for Developers → Tools → Graph API Explorer](https://developers.facebook.com/tools/explorer/).
  2. Selecionar app Diar.ia → `Get User Access Token` com permissões `pages_show_list` + `pages_manage_posts` + `pages_read_engagement`.
  3. Trocar o User token short-lived por **long-lived Page token** (não expira) seguindo o fluxo:
     ```
     GET /oauth/access_token?grant_type=fb_exchange_token&
         client_id={app_id}&
         client_secret={app_secret}&
         fb_exchange_token={short_lived_user_token}
     ```
     Depois `GET /me/accounts` retorna o `access_token` da Page.
- **Onde atualizar:** `data/.fb-credentials.json` (gitignored), no campo `page_access_token`. Manter `page_id` e `api_version` inalterados se ainda válidos.
- **Como testar:**
  ```bash
  npx tsx scripts/verify-facebook-posts.ts \
    --post-id $(jq -r '.page_id' data/.fb-credentials.json)_TESTE \
    --check-access-only
  ```
  ou simplesmente rodar `npx tsx scripts/publish-facebook.ts --dry-run` se houver flag.
- **Sinais de expiração:** Graph API retorna `code: 190 OAuthException — Error validating access token`. Aparece no `06-social-published.json` como `status: "failed"` com `reason` mencionando `OAuth`.
- **Downtime esperado:** 5-10 minutos (Graph API Explorer + token exchange manual).
- **Cadência sugerida:** mesmo com long-lived, rotacionar **a cada 90 dias** por higiene + verificar permissões da app.

### `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`

- **Para que serve:** alternativa gratuita ao Gemini pra geração de imagens (Stage 4) quando `platform.config.json > image_generator = "cloudflare"`.
- **Onde gerar:**
  - Account ID: visível em qualquer URL `dash.cloudflare.com/{account_id}/...`.
  - Token: [Cloudflare → My Profile → API Tokens](https://dash.cloudflare.com/profile/api-tokens) → "Create Token" com scope **Workers AI**.
- **Onde atualizar:** `.env` local.
- **Como testar:**
  ```bash
  curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/models/search?per_page=1"
  ```
  esperado: HTTP 200 com lista paginada de modelos.
- **Downtime esperado:** ~30 segundos.
- **Cadência sugerida:** a cada 6 meses ou após qualquer suspeita. Free tier não tem limite que mude com idade do token.

### Beehiiv MCP OAuth

- **Para que serve:** survey audience refresh (`/diaria-atualiza-audiencia`). Nota: dedup de edições passadas (Stage 0) hoje usa `scripts/refresh-dedup.ts` via Beehiiv REST API (`BEEHIIV_API_KEY`), não o MCP — a credencial MCP só é necessária pra audience refresh.
- **Onde gerar / re-conectar:** [claude.ai → Settings → Connectors](https://claude.ai/settings/connectors) → "Beehiiv" → reauthorize.
- **Onde atualizar:** dentro da claude.ai (não há arquivo local).
- **Como testar:** dentro do Claude Code, rodar `/mcp` — lista deve incluir `claude.ai Beehiiv` como conectado. Em seguida `/diaria-refresh-dedup` deve completar sem erro.
- **Sinais de expiração:** `/diaria-atualiza-audiencia` retorna erro de auth ou timeout repetido nas chamadas Beehiiv MCP.
- **Downtime esperado:** 2-3 minutos (re-auth no browser).

### Gmail MCP OAuth

- **Para que serve:** drenagem do inbox editorial (`scripts/inbox-drain.ts` quando rodar via MCP — o caminho atual usa Google OAuth direto via `google-auth.ts`, mas o conector MCP existe e é usado por `/diaria-inbox` quando ativado).
- **Onde gerar / re-conectar:** [claude.ai → Settings → Connectors](https://claude.ai/settings/connectors) → "Gmail" → reauthorize.
- **Onde atualizar:** dentro da claude.ai.
- **Como testar:** `/diaria-inbox` deve retornar JSON com `skipped: false` (ou `skipped: true` mas sem `reason: "gmail_mcp_error"`).
- **Sinais de expiração:** `DrainResult.reason = "gmail_mcp_error"` ou erro 401.
- **Downtime esperado:** 2-3 minutos.

---

## Playbook emergencial

> Use quando uma edição está em produção (algum `/diaria-edicao` rodando) e algo de auth quebrou.

### 1. Identifique qual credencial falhou

Olhe o último erro:
- `data/run-log.jsonl` — filtre por `level: "error"` ou `level: "warn"` recente.
- Output do stage que falhou (gate ainda ativo).

Tabela de mapeamento erro → credencial:

| Mensagem de erro | Credencial provável | Ação |
|---|---|---|
| `OAuthException` ou `code: 190` | Facebook Page token | Rotação seção FB acima |
| `invalid_grant` | Google OAuth refresh_token | Re-rodar `oauth-setup.ts` |
| `Gmail API error (401)` ou `gmail_mcp_error` | Gmail (depende do caminho) | Conector MCP ou Google OAuth |
| `PERMISSION_DENIED` em image gen | Gemini API key | Rotação seção Gemini |
| `Authentication error` em Cloudflare | `CLOUDFLARE_API_TOKEN` | Rotação seção CF |
| Clarice retorna 401/403 | `CLARICE_API_KEY` | Rotação seção Clarice |
| `/diaria-atualiza-audiencia` falha auth | Beehiiv MCP | Re-conectar em claude.ai |
| `scripts/refresh-dedup.ts` falha auth | `BEEHIIV_API_KEY` (env var) | Gerar novo token no dashboard Beehiiv → atualizar `.env` |

### 2. Avalie o impacto e decida fallback

| Credencial quebrada | Pior consequência | Fallback humano |
|---|---|---|
| Facebook Page token | Posts FB não saem da janela ideal de horário | Editor publica manual via Meta Business Suite (texto + imagem `04-d{N}.jpg`) |
| Google OAuth | Drive sync para; revisão pelo celular não funciona | Continuar a edição sem sync; revisar no terminal |
| Gemini API key | Imagens da edição não geram | Setar `image_generator: "cloudflare"` (se CF estiver válido) ou pular Stage 4 |
| Cloudflare token | Idem (se Gemini também falhou) | Reusar imagens de outra edição como placeholder |
| Clarice | Stage 2 trava no diff | Pular revisão Clarice e seguir com texto bruto do writer |
| Beehiiv MCP | Dedup base não atualiza | Aceitar risco de repetir 1-2 links da última edição (ou aguardar) |
| Gmail MCP | Inbox não drena | Continuar com URLs já em `data/inbox.md` (drain ficou stale) |

### 3. Aplique fallback OU rotacione a credencial

- **Se urgente** (edição precisa sair em < 30 min): aplicar fallback humano da tabela acima e continuar.
- **Se houver tempo** (> 30 min antes do horário de envio): rotacionar a credencial (seções acima). Cada uma tem o downtime esperado documentado.

### 4. Re-rode o stage que falhou

A pipeline é **resume-aware** — basta rodar `/diaria-edicao {AAMMDD}` novamente que ela retoma de onde parou.

### 5. Pós-incidente

Se a falha foi recorrente ou silenciosa, abrir uma issue (`P1` ou `P0` conforme severidade) em `vjpixel/diaria-studio` documentando:
- Qual credencial falhou.
- Sinal pelo qual foi detectada.
- Fallback usado.
- Sugestão de detecção pró-ativa (assertion no início do stage, healthcheck periódico, etc.).

---

## Cadência proativa de rotação

Calendário sugerido — colar no calendário do editor:

| Frequência | Credencial | Razão |
|---|---|---|
| 30 dias | Facebook Page token (se short-lived) | Margem antes do prazo de 60 dias |
| 90 dias | Facebook Page token (se long-lived) | Higiene + revisar permissões da app |
| 90 dias | Gemini API key | Best practice |
| 6 meses | Clarice API key | Sem expiração nativa, mas higiene |
| 6 meses | Cloudflare API token | Idem |
| Sem cadência | Google OAuth refresh_token | Não rotaciona ativamente; só após revogação |
| Sem cadência | Beehiiv / Gmail MCP OAuth | Gerenciado pela claude.ai |

---

## Inventário de arquivos sensíveis

Todos gitignored (verificar `.gitignore`):

- `.env` / `.env.local` — env vars locais.
- `data/.credentials.json` — Google OAuth.
- `data/.fb-credentials.json` — Facebook Page token.
- `data/inbox.md` / `data/inbox-cursor.json` — pode conter PII (#102).
- `data/run-log.jsonl` — pode citar URLs/headers em traces de erro.

Se algum destes for commitado por acidente: `git rm --cached <arquivo>`, sanitizar o working tree, força a ROTAÇÃO IMEDIATA da credencial vazada (não basta remover o commit — assumir comprometimento).

---

## Histórico de rotações

> Editor: anote aqui datas de cada rotação manual pra rastrear cadência real.

```
- 2026-04-XX — FB Page token (long-lived) — gerado via Graph API Explorer
- 2026-04-XX — Google OAuth — re-consent após install em nova máquina
```
