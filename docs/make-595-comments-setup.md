# Make scenarios setup — comments LinkedIn (#595)

Setup pros 2 scenarios Make pra suportar comments LinkedIn:
1. **Estender o scenario Diar.ia existente** (`diar-ia-linkedin-post`) pra aceitar `action: "post"` ou `action: "comment"` via Router.
2. **Criar novo scenario "Pixel LinkedIn"** autenticado com vjpixel personal pra `comment_pixel` (T+8min).

Pré-requisitos:
- Login Make + LinkedIn já feito ✅ (você confirmou)
- Scenario `diar-ia-linkedin-post` existe e funciona pra posts (`action="post"`) ✅
- Worker `diaria-linkedin-cron` deployado (já existe — só falta adicionar secret novo).

---

## Parte 1 — Estender scenario Diar.ia existente

Objetivo: scenario aceita `action: "post"` (atual) **ou** `action: "comment"` (novo). Mesma webhook URL pra ambas.

### Passo 1.1 — Abrir scenario

1. [make.com](https://make.com) → scenarios → `diar-ia-linkedin-post` → **Edit**.

### Passo 1.2 — Inserir Router após webhook

1. Click no link entre **Webhooks (Custom webhook)** e **LinkedIn (Create a Post)**.
2. Click no ícone de "Add a Router" (ou: delete o link, click no `+` do webhook → busque **Tools → Router**).
3. O Router cria 2 paths. Os módulos LinkedIn ficam num path; outro path fica vazio (vamos adicionar comment).

### Passo 1.3 — Path A (existente — `action="post"`)

1. Click no path do **LinkedIn (Create a Post)** → **Set up filter**.
2. Filter:
   - **Label**: `action=post (or default)`
   - **Condition**: `{{1.action}}` **Text operators → Equal to** `post`
   - **AND fallback**: clique **OR** → adicione: `{{1.action}}` **Basic operators → Does not exist`
   - Razão do fallback: entries antigas pré-#595 não têm `action`; tratar como `post`.
3. Save.

### Passo 1.4 — Path B (novo — `action="comment"`)

No path vazio:

1. Click `+` → busque **LinkedIn → Get Latest Posts** (ou similar — varia por versão do connector). Configure:
   - **Person or Company**: a mesma Company Page Diar.ia.
   - **Limit**: `1` (só o último post).
2. Click `+` depois → **LinkedIn → Create a Post Comment** (ou **Comment on a Post**, depende do connector).
   - **Post URN**: mapeie do output do "Get Latest Posts" → primeiro item → URN/ID field.
     - O nome exato depende da resposta — em geral é `{{2.id}}` ou `{{2.[].id}}` ou `{{2.urn}}`.
     - Se "Get Latest Posts" retornar array, prefixe com `[1]` ou use `first()`.
   - **Comment text**: `{{1.text}}`
3. Click no Path B → **Set up filter**:
   - **Label**: `action=comment`
   - **Condition**: `{{1.action}}` **Text operators → Equal to** `comment`
4. Save.

### Passo 1.5 — Webhook response (mantém)

O módulo final **Webhooks → Webhook response** continua igual: `200 OK`, body `{"accepted": true}`. Aplica-se aos 2 paths (Make permite reusar; senão duplica o módulo no fim de cada path).

### Passo 1.6 — Ativar e testar

1. **Save** (Ctrl+S no scenario; depois disquete/Save no top-right do Make UI — não é o mesmo Save).
2. Toggle **ON**.
3. Teste manual:
   ```bash
   curl -X POST $MAKE_LINKEDIN_WEBHOOK_URL \
     -H "Content-Type: application/json" \
     -d '{"text":"Test comment automation","destaque":"d1","action":"comment","parent_destaque":"d1","scheduled_at":null,"image_url":null}'
   ```
   - Esperar: comment no último post Diar.ia.
   - Se ok → segue Parte 2.

---

## Parte 2 — Criar scenario "Pixel LinkedIn" novo

Objetivo: scenario autenticado com **vjpixel personal** que comenta no último post Diar.ia. Único escopo: `comment_pixel` (T+8min). Não faz post.

### Passo 2.1 — Logout/troca de account

> Importante: o **connector LinkedIn** no Make é por-conta-Make-única. Você pode ter múltiplas connections (uma Diar.ia, uma Pixel). O cuidado é selecionar a connection certa em cada scenario.

1. Em [make.com](https://make.com) → **Connections** → **Add → LinkedIn**.
2. Faça OAuth com **conta pessoal vjpixel** (faz login como Pixel no LinkedIn antes de clicar Authorize).
3. Nomeie a connection: `LinkedIn vjpixel personal`.
4. Confirme em **Connections** que existem **2 connections LinkedIn**: uma Diar.ia (existente), uma Pixel personal (nova).

### Passo 2.2 — Criar scenario

1. **Scenarios** → **Create new scenario** → nome: `Pixel LinkedIn comment`.
2. Adicione **Webhooks → Custom webhook**:
   - **Add** → nome: `pixel-linkedin-comment`.
   - **Copie a URL** gerada (`https://hook.us2.make.com/...`). Você vai precisar dela no passo 2.5.
3. Adicione **LinkedIn → Get Latest Posts** (ou o módulo equivalente):
   - **Connection**: ⚠️ selecione a `LinkedIn Diar.ia` (queremos pegar o último post da Diar.ia, não da conta Pixel).
   - **Person or Company**: Company Page Diar.ia.
   - **Limit**: 1.
4. Adicione **LinkedIn → Create a Post Comment**:
   - **Connection**: ⚠️ selecione a `LinkedIn vjpixel personal` (comment vai como Pixel).
   - **Post URN**: mapeie do output do passo 3 (mesmo padrão do scenario Diar.ia).
   - **Comment text**: `{{1.text}}`
5. Adicione **Webhooks → Webhook response**: `200 OK`, body `{"accepted": true}`.

### Passo 2.3 — Filter de safety (opcional mas recomendado)

Pra evitar abuso, filtre `action=comment` no scenario inteiro:

1. Click no link entre webhook e Get Latest Posts → **Set up filter**.
2. **Condition**: `{{1.action}}` **Text** **Equal to** `comment`.
3. Save.

### Passo 2.4 — Ativar

**Save** (no módulo) + **Save** (no scenario) + toggle **ON**.

### Passo 2.5 — Configurar Worker secret

A URL do webhook Pixel **fica só no Worker** (Worker é quem dispara). Localmente em `.env.local` é opcional — pode deixar vazio.

```bash
cd workers/linkedin-cron
echo "https://hook.us2.make.com/SEU_WEBHOOK_PIXEL_URL" | wrangler secret put MAKE_PIXEL_WEBHOOK_URL
```

> Se você não rodar isso, o Worker vê `webhook_target=pixel` items e despacha **direto pro DLQ** com `reason: MAKE_PIXEL_WEBHOOK_URL not configured`. Não há retry — é fail-fast deliberado.

### Passo 2.6 — Atualizar `platform.config.json`

```json
"publishing": {
  "social": {
    "linkedin": {
      "make_webhook_pixel_url": "https://hook.us2.make.com/SEU_WEBHOOK_PIXEL_URL"
    }
  }
}
```

(Documentário — publish-linkedin não usa a URL diretamente; é pro Worker.)

### Passo 2.7 — Atualizar `.env.local` (opcional)

```bash
MAKE_LINKEDIN_PIXEL_WEBHOOK_URL=https://hook.us2.make.com/SEU_WEBHOOK_PIXEL_URL
```

(Pra debug local. Worker é quem realmente usa.)

### Passo 2.8 — Teste manual

```bash
curl -X POST $MAKE_LINKEDIN_PIXEL_WEBHOOK_URL \
  -H "Content-Type: application/json" \
  -d '{"text":"Test Pixel comment","destaque":"d1","action":"comment","parent_destaque":"d1","scheduled_at":null,"image_url":null}'
```

Esperar: comment do **vjpixel personal** no último post Diar.ia.

---

## Parte 3 — Smoke test end-to-end

Após Parte 1 + 2 + Worker secret, num run da Diar.ia próximo:

1. Etapa 4 dispatch (`/diaria-4-publicar AAMMDD`) → 9 LinkedIn items enfileirados.
2. Worker `diaria-linkedin-cron` cron tick (cada 5min) consome:
   - 3 main → webhook Diar.ia, action=post → cria company post
   - 3 comment_diaria → webhook Diar.ia, action=comment → comenta no último post Diar.ia
   - 3 comment_pixel → webhook Pixel → vjpixel comenta no último post Diar.ia
3. Verificar no LinkedIn: cada destaque tem main + 2 comments com timing escalonado (T, T+3min, T+8min).

---

## Troubleshooting

- **Comment apareceu no post errado**: "Get Latest Posts" pegou o post anterior. Causa: timing apertado entre staggered destaques. Mitigação: aumentar gap entre destaques no `platform.config.json` > `fallback_schedule` ou adicionar delay maior nos offsets (`comment_diaria` 3min → 5min, etc).
- **Pixel comment veio como Diar.ia**: você selecionou a connection errada no scenario Pixel. Volte e revise a connection do **Create a Post Comment** module.
- **DLQ recheado de Pixel items**: Worker não tem `MAKE_PIXEL_WEBHOOK_URL` setado. Roda `wrangler secret put MAKE_PIXEL_WEBHOOK_URL` em `workers/linkedin-cron/`.
- **Make double-save**: lembre que **Save** do módulo ≠ **Save** do scenario. Sempre clica disquete/Ctrl+S no top do scenario depois de fechar módulo.
- **OAuth pessoal expirou**: LinkedIn refresh token tem TTL ~60 dias. Re-OAuth via **Connections → LinkedIn vjpixel personal → Reconnect**. Não invalida scenario.
