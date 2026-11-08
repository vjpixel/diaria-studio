# Rotação de credenciais e playbook de emergência

Este doc é o ponto único de consulta quando alguma credencial expira, é revogada, ou precisa rotação proativa. Cobre as credenciais usadas pela pipeline da diar.ia.br.

> As 3 credenciais desta tabela que moram em env var (`CLARICE_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_TOKEN`) agora sincronizam entre máquinas via Doppler — ao rotacionar, atualizar o valor no vault e rodar `npm run sync-env` em cada máquina em vez de editar `.env` à mão em cada uma. Google OAuth e Facebook Page token são arquivos de credencial (`data/.credentials.json`, `data/.fb-credentials.json`), não `.env` vars — continuam fora do Doppler de propósito. Detalhes: `docs/doppler-env-sync.md` (#5149).

> Em emergência (edição em produção e algo está quebrando agora): pula direto pro [Playbook emergencial](#playbook-emergencial) no fim deste doc.

---

## Inventário

| Credencial | Onde mora | Expiração típica | Sinal típico de falha |
|---|---|---|---|
| `CLARICE_API_KEY` | env var (`.env` + shell + `claude_desktop_config.json`) | Sem expiração nativa | `mcp__clarice__correct_text` retorna 401/403 |
| `GEMINI_API_KEY` | env var (`.env`) | Sem expiração nativa | `scripts/gemini-image.js` retorna 401/`PERMISSION_DENIED` (só quando o fallback do Codex dispara), tradução do É IA? falha |
| Login Codex (ChatGPT) | `~/.codex/auth.json` por máquina | Sessão pode expirar | preflight do Stage 0 (`codex login status`, #9093) marca `expired`; `codex-image.js` falha e o fallback assume |
| Google OAuth (`refresh_token`) | `data/.credentials.json` | Raramente expira (revogação manual ou 6 meses sem uso) | `google-auth.ts` retorna `invalid_grant` |
| Facebook Page token | `data/.fb-credentials.json` (`page_access_token`) | 60 dias se short-lived; nunca se long-lived com renew | `publish-facebook.ts` retorna 190 (`OAuthException`) |
| `INSTAGRAM_ACCESS_TOKEN` | Doppler + `.env` (Neo e 300) + secret do Worker `diaria-linkedin-cron` | Sem expiração (token de usuário do sistema) | Itens `channel="instagram"` vão pra DLQ no Worker; `publish-instagram.ts` retorna 190 (`OAuthException`) |
| `CLOUDFLARE_API_TOKEN` | env var (`.env`) | Sem expiração nativa (até revogação) | `cloudflare-image.js` retorna 401 / `Authentication error` |
| `CLOUDFLARE_WORKERS_TOKEN` | Doppler + `.env` + **secret do GitHub** (deploy dos Workers no CI) | Sem expiração nativa (até revogação) | `wrangler deploy` no CI falha com `Authentication error [code: 10000]` |
| Beehiiv MCP OAuth | `claude.ai/settings/connectors` | Desconhecido (gerenciado pela claude.ai) | Subagentes que usam Beehiiv MCP retornam erro de auth |
| Gmail MCP OAuth | `claude.ai/settings/connectors` | Desconhecido (gerenciado pela claude.ai) | `review-test-email` (Etapas 5/6) falha com erro de auth do Gmail MCP |

---

## Por credencial

### `CLARICE_API_KEY`

- **Para que serve:** revisão linguística no Stage 2 (`mcp__clarice__correct_text`).
- **Onde gerar:** painel da Clarice (entrar em contato com o operador da API; chave hoje vem por canal manual).
- **Onde atualizar:**
  1. `.env` local — substituir o valor de `CLARICE_API_KEY=`. É dele que o MCP lê a key desde o #11251 (`headersHelper` `scripts/mcp/clarice-headers.mjs`). O Claude Code tira do ambiente do helper toda var com `KEY` no nome, então a key do ambiente (passo 2) **não** chega ao helper: ela só conta pelo header estático `${CLARICE_API_KEY}` do `.mcp.json`, usado quando o helper não roda (pasta sem trust aceito) ou devolve `{}` (key ausente no `.env`). Atualize os dois lugares.
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

- **Para que serve:** fallback de imagem quando o Codex (gerador padrão desde #9088) falha — `platform.config.json > codex.fallback = "gemini"` —, tradução do É IA? e embeddings do topic-cluster. Com `image_generator = "gemini"`, volta a ser o gerador principal.
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

### `INSTAGRAM_ACCESS_TOKEN` (usuário do sistema) (#11804)

- **Para que serve:** publicação no Instagram da @diar.ia.br pela Graph API — agendada pelo Worker `diaria-linkedin-cron` (Stage 5, carrossel/Reels e o 1º comentário do 4º post) e direta por `scripts/publish-instagram.ts` sem `--schedule`. `scripts/social-followers-collect.ts` e `scripts/probe-instagram-comment-scope.ts --source local` também leem do `.env`.
- **Qual token é o de produção:** token de **usuário do sistema** (`SYSTEM_USER`), usuário `vjpixel`, app **Vigil.ia.br**, **sem expiração**. Conferido na renovação da #11731 (02/11/2026).
- **Onde NÃO gerar:** no Graph API Explorer. O Explorer devolve token de usuário comum, que expira em horas — o Instagram para de publicar no dia seguinte, sem aviso antes do disparo.
- **Onde gerar:**
  1. [Meta Business Settings](https://business.facebook.com/settings): a página pede para escolher o portfólio (**Diar.ia**) e redireciona para `business.facebook.com/latest/settings/system_users` → **Usuários do sistema** → `vjpixel` (caminho conferido na renovação da #12348, 08/11/2026).
  2. **Gerar novo token** → app **Vigil.ia.br** → expiração **Nunca**.
  3. Permissões exigidas: `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments` (sem esta o 1º comentário do 4º post não sai e o post usa a linha da bio, #11731), `instagram_manage_insights` e `read_insights` (sem estas duas a métrica `follower_count` do IG Insights responde `(#10) Application does not have permission for this action`, Fase 2 da #8260). Na tela de permissões, as `pages_*` e as de publicação já vêm marcadas; as duas de insights não: buscar cada uma pelo nome no seletor e marcar à mão. A Meta pede para **adicionar ao app** as permissões que o app ainda não tinha antes de liberar o **Gerar**. Antes de gerar, colar o token atual no [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/) e marcar no novo pelo menos os mesmos escopos que ele lista (os `pages_*` que vierem junto são o caminho do token até a conta do Instagram, pela Página vinculada).
  4. **O token só aparece uma vez.** Copiar com o botão **Copiar** da própria tela, antes de fechar o diálogo, e colar direto no Doppler; fechou sem copiar, é gerar outro.
  5. Conferir que o usuário do sistema tem a Página da diar.ia.br e a conta do Instagram atribuídas como ativos (mesma tela, **Atribuir ativos**); sem isso o token sai válido mas sem acesso à conta.
- **Onde atualizar (os 3 destinos, sempre juntos):**
  1. **Doppler** — `INSTAGRAM_ACCESS_TOKEN` no vault, depois `npm run sync-env` em cada máquina (`docs/doppler-env-sync.md`).
  2. **`.env` do Neo e do 300** — confirmar que o `sync-env` levou o valor novo às duas máquinas (o `.env` atrasa em relação ao vault quando o sync não roda). O `sync-env` aborta (`LocalOnlyEnvKeysError`, sem escrever nada) quando o `.env` da máquina tem chave que não está no vault e não está em `MACHINE_LOCAL_ENV_KEYS` (`scripts/sync-env.ts`; hoje `GOOGLE_APPLICATION_CREDENTIALS`, `DOPPLER_MCP_TOKEN` e `DIARIA_VIDEO_CACHE_DIR`, esta desde a #12430). O `.env` do 300 é o candidato mais provável a cair nisso. A mensagem lista as chaves; subir a chave pro vault ou, se ela é mesmo local daquela máquina, incluí-la em `MACHINE_LOCAL_ENV_KEYS`. `--force` sobrescreve e tira a chave do `.env` (fica só no `.env.bak`).
  3. **Secret do Worker** — `cd workers/linkedin-cron && npx wrangler secret put INSTAGRAM_ACCESS_TOKEN`. O Worker não lê o `.env`: esquecer este passo deixa o agendamento (o caminho padrão do Stage 5) com o token velho.
- **Como testar (só leitura, não publica nada):**
  ```bash
  npx tsx scripts/probe-instagram-comment-scope.ts --edition-dir data/editions/{AAMMDD}/ --source local   # token do .env
  npx tsx scripts/probe-instagram-comment-scope.ts --edition-dir data/editions/{AAMMDD}/ --source worker  # token do Worker
  ```
  esperado: `granted: true` nas duas origens em `_internal/instagram-comment-scope.json`. Para conferir tipo e expiração, colar o token no [Access Token Debugger](https://developers.facebook.com/tools/debug/accesstoken/): `Type: System User` e `Expires: Never`.

  Pela API, sem colar o token em página nenhuma (o `debug_token` aceita o próprio token como `access_token`; ler o token do `.env`/Doppler numa variável de shell, nunca escrevê-lo em arquivo ou comando salvo):
  ```bash
  curl -s "https://graph.facebook.com/v25.0/debug_token?input_token=$INSTAGRAM_ACCESS_TOKEN&access_token=$INSTAGRAM_ACCESS_TOKEN"
  curl -s -o /dev/null -w "%{http_code}\n" "https://graph.facebook.com/v25.0/$INSTAGRAM_BUSINESS_ACCOUNT_ID/insights?metric=follower_count&period=day&access_token=$INSTAGRAM_ACCESS_TOKEN"
  ```
  esperado: no `debug_token`, `is_valid: true`, `type: "SYSTEM_USER"`, `expires_at: 0` e os 5 escopos do passo 3 em `scopes`; no `follower_count`, `200`. Erro `#10` no segundo = faltou `instagram_manage_insights`/`read_insights`.
- **Sinais de expiração/token errado:** DLQ do Worker com `OAuthException`/`code: 190` em itens `channel="instagram"`; `granted: false` no probe do Stage 4.
- **Downtime esperado:** 5-10 minutos (gerar + Doppler + `wrangler secret put`).
- **Cadência sugerida:** sem rotação ativa (token não expira); rotacionar se houver vazamento, se a app mudar ou se o usuário do sistema perder um ativo.

### `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`

- **Para que serve:** alternativa gratuita ao Codex/Gemini pra geração de imagens (Stage 3) quando `platform.config.json > image_generator = "cloudflare"`.
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

### `CLOUDFLARE_WORKERS_TOKEN` (deploy dos Workers no CI) (#12119)

- **Qual token é:** o token da Cloudflare chamado **"Edit Cloudflare Workers"**, ID começando com `2f71911b` (o valor nunca vai para o repo). Tem, entre outras, a permissão **Workers R2 Storage Write**, que o deploy de Worker com binding R2 exige (#11412).
- **Onde mora:** em **dois** lugares, que precisam ter o **mesmo valor**:
  1. Doppler/`.env` (`CLOUDFLARE_WORKERS_TOKEN`), lido por dezenas de scripts locais (escrita em KV, `worker-drift-check.ts`, `eia-compose.ts`, `publish-daily-brevo.ts` etc.; `grep -rl CLOUDFLARE_WORKERS_TOKEN scripts/` lista todos).
  2. Secret de repo do GitHub `CLOUDFLARE_WORKERS_TOKEN`, que os workflows de deploy (`.github/workflows/deploy-worker.yml` e os `deploy-*.yml` standalone) passam ao `wrangler` como `CLOUDFLARE_API_TOKEN`.
- **Por que isto está escrito:** a #11412 ficou bloqueada de 28/10 a 04/11/2026 com `Authentication error [code: 10000]` no R2, diagnosticada como "o token não tem permissão R2". O token do `.env`/Doppler já tinha a permissão; o secret do GitHub, gravado em 01/07, guardava **outro** token. Em 04/11 o secret foi trocado pelo valor do `.env`. Antes de concluir "falta permissão", conferir se os dois lugares têm o mesmo token.
- **Como conferir qual token está em uso** (devolve o ID, nunca o valor):
  ```bash
  curl -s -H "Authorization: Bearer $CLOUDFLARE_WORKERS_TOKEN" \
    "https://api.cloudflare.com/client/v4/user/tokens/verify"
  ```
  esperado: `"success": true` e `result.id` começando com `2f71911b`. O secret do GitHub não pode ser lido de volta: para conferir o do CI, rodar o mesmo `curl` num step temporário de workflow (imprime só o `result.id`) ou regravar o secret com o valor do `.env` (`gh secret set CLOUDFLARE_WORKERS_TOKEN`).
- **Onde atualizar ao rotacionar:** Doppler (e `npm run sync-env` em cada máquina) **e** `gh secret set CLOUDFLARE_WORKERS_TOKEN` no repo. Atualizar só um dos dois é a divergência do incidente acima.
- **Não confundir com `CLOUDFLARE_API_TOKEN`** (seção acima): aquele é o token de Workers AI da geração de imagens, outro token.

### Beehiiv MCP OAuth

- **Para que serve:** survey audience refresh (`/diaria-atualiza-audiencia`). Nota: dedup de edições passadas (Stage 0) hoje usa `scripts/refresh-dedup.ts` via Beehiiv REST API (`BEEHIIV_API_KEY`), não o MCP — a credencial MCP só é necessária pra audience refresh.
- **Onde gerar / re-conectar:** [claude.ai → Settings → Connectors](https://claude.ai/settings/connectors) → "Beehiiv" → reauthorize.
- **Onde atualizar:** dentro da claude.ai (não há arquivo local).
- **Como testar:** dentro do Claude Code, rodar `/mcp` — lista deve incluir `claude.ai Beehiiv` como conectado. Em seguida `/diaria-refresh-dedup` deve completar sem erro.
- **Sinais de expiração:** `/diaria-atualiza-audiencia` retorna erro de auth ou timeout repetido nas chamadas Beehiiv MCP.
- **Downtime esperado:** 2-3 minutos (re-auth no browser).

### Gmail MCP OAuth

- **Para que serve:** leitura do e-mail de teste da newsletter pelo agent `review-test-email` (loop verify→fix das Etapas 5/6). **Não** é usado pelo drain do inbox editorial — `scripts/inbox-drain.ts` (e `/diaria-inbox`) falam com a Gmail REST API via Google OAuth (`data/.credentials.json`, seção acima), nunca MCP (#10026).
- **Onde gerar / re-conectar:** [claude.ai → Settings → Connectors](https://claude.ai/settings/connectors) → "Gmail" → reauthorize.
- **Onde atualizar:** dentro da claude.ai.
- **Como testar:** dentro do Claude Code, `/mcp` deve listar `claude.ai Gmail` como conectado.
- **Sinais de expiração:** `review-test-email` retorna erro de auth nas chamadas `mcp__claude_ai_Gmail__*`.
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
| `OAuthException`/`code: 190` em item `channel="instagram"` (DLQ do Worker) ou em `publish-instagram.ts` | `INSTAGRAM_ACCESS_TOKEN` | Rotação seção Instagram acima (usuário do sistema, nunca Graph Explorer) |
| `invalid_grant` | Google OAuth refresh_token | Re-rodar `oauth-setup.ts` |
| `Gmail API error (401)` ou `reason: "auth_expired"` no inbox drain | Google OAuth refresh_token | `npx tsx scripts/check-google-token.ts`; re-rodar `oauth-setup.ts` |
| `reason: "local_error"` (legado `gmail_mcp_error`) no inbox drain | Nenhuma — falha local (config, gravação de `data/inbox.md`/cursor) | Ler o campo `error` e corrigir a causa local |
| Erro de auth em `mcp__claude_ai_Gmail__*` (`review-test-email`) | Gmail MCP | Re-conectar em claude.ai |
| `PERMISSION_DENIED` em image gen | Gemini API key | Rotação seção Gemini |
| `Authentication error` em Cloudflare | `CLOUDFLARE_API_TOKEN` | Rotação seção CF |
| Clarice retorna 401/403 | `CLARICE_API_KEY` | Rotação seção Clarice |
| `/diaria-atualiza-audiencia` falha auth | Beehiiv MCP | Re-conectar em claude.ai |
| `scripts/refresh-dedup.ts` falha auth | `BEEHIIV_API_KEY` (env var) | Gerar novo token no dashboard Beehiiv → atualizar `.env` |

### 2. Avalie o impacto e decida fallback

| Credencial quebrada | Pior consequência | Fallback humano |
|---|---|---|
| Facebook Page token | Posts FB não saem da janela ideal de horário | Editor publica manual via Meta Business Suite (texto + imagem `04-d{N}.jpg`) |
| Google OAuth | Drive sync para; revisão pelo celular não funciona; inbox editorial não drena (`auth_expired`) | Continuar a edição sem sync; revisar no terminal |
| Login Codex expirado | Imagens caem no fallback (`codex.fallback`, Gemini) — legenda reflete o gerador efetivo (#9095) | `codex login` na máquina; se o Gemini também falhar, setar `image_generator: "cloudflare"` |
| Gemini API key | Fallback do Codex e tradução do É IA? falham (imagens só quebram se o Codex também cair) | Rotacionar; ou `codex.fallback: "cloudflare"` (se CF estiver válido) |
| Cloudflare token | Idem (se Gemini também falhou) | Reusar imagens de outra edição como placeholder |
| Clarice | Stage 2 trava no diff | Pular revisão Clarice e seguir com texto bruto do writer |
| Beehiiv MCP | Dedup base não atualiza | Aceitar risco de repetir 1-2 links da última edição (ou aguardar) |
| Gmail MCP | `review-test-email` não lê o e-mail de teste | Editor confere o e-mail de teste à mão na parada de agendamento (Etapa 6) |

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
| Sem cadência | `INSTAGRAM_ACCESS_TOKEN` (usuário do sistema) | Não expira; só após vazamento ou mudança de app/ativos |
| Sem cadência | Beehiiv / Gmail MCP OAuth | Gerenciado pela claude.ai |

---

## Inventário de arquivos sensíveis

Todos gitignored (verificar `.gitignore`):

- `.env` — env vars locais (`.env.local` gitignored mas não mais lido, #4820 — migrar conteúdo pra `.env` se ainda existir localmente).
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
- 2026-11-04 — CLOUDFLARE_WORKERS_TOKEN (secret do GitHub) — trocado pelo valor do .env/Doppler ("Edit Cloudflare Workers", 2f71911b…), #12119
```
