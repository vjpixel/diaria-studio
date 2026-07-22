# Make.com → LinkedIn Setup

One-time setup to enable programmatic LinkedIn publishing via Make.com webhook instead of Chrome automation.

> **Pra agendar posts pra horários futuros**, este doc cobre só o "fire-now" (Make → LinkedIn imediato). Pra agendamento real (post X às 09:00), siga **`linkedin-cron-worker-setup.md`** — Cloudflare Worker que enfileira e fira pro webhook Make na hora certa.

## Pré-requisitos

- Conta Make.com (free tier basta — 1.000 ops/mês, ~270 usadas por mês)
- LinkedIn autorizado no Make.com (OAuth one-time)
- Acesso ao `platform.config.json` ou `.env.local`

---

## Passo 1 — Criar scenario no Make.com

1. Acesse [make.com](https://make.com) e faça login.
2. Clique **Create a new scenario**.
3. Clique no círculo central `+` e adicione o módulo **Webhooks → Custom webhook**.
   - Clique em **Add** para criar um novo webhook.
   - Nomeie: `diar-ia-linkedin-post`.
   - Copie a URL gerada (ex: `https://hook.eu2.make.com/abc123...`). Você vai usar depois.
   - Clique **Save**.
4. Adicione o segundo módulo: clique no `+` depois do webhook.
   - Busque **LinkedIn** → selecione **Create a Post**.
   - Conecte sua conta LinkedIn (OAuth). Autorize o app Make.com.
   - Configure:
     - **Person or Company**: selecione a Company Page **Diar.ia**
     - **Visibility**: `PUBLIC`
     - **Text**: mapeie o campo `text` do webhook payload
     - **Share Media Category**: `ARTICLE` (ou deixar vazio para texto simples)
5. *(Opcional)* Se quiser postar com imagem: adicione um módulo **LinkedIn → Upload Media** antes do Create Post, mapeie `image_url` do payload.
6. Adicione o módulo final: **Webhooks → Webhook response**.
   - **Status**: `200`
   - **Body**: `{"accepted": true}`
7. Clique **Save** e ative o scenario (toggle para ON).

---

## Passo 2 — Configurar a Diar.ia

> **(#3903) A URL do webhook NUNCA vai commitada em texto puro.** A postura anterior deste doc ("URL pública é aceitável", já que a defesa primária seria o token `X-Diaria-Token` do Worker) se provou errada na prática: bots que monitoram commits do GitHub encontraram a URL commitada em `platform.config.json` e passaram a visitá-la periodicamente — um POST bem-formado direto no webhook Make posta na company page **sem passar pelo Worker nem pelo token** (o Make webhook em si nunca teve auth). `platform.config.json` → `publishing.social.linkedin.make_webhook_url` fica **sempre `""`** em código versionado.

### Opção A — `.env.local` (recomendado)

```bash
MAKE_LINKEDIN_WEBHOOK_URL=https://hook.eu2.make.com/SEU_WEBHOOK_ID
```

`.env.local` é gitignored e tem precedência sobre `platform.config.json` (ver `scripts/publish-linkedin.ts` ~L652).

### Opção B — Worker secret (caminho real de scheduling)

```bash
cd workers/linkedin-cron
echo "https://hook.eu2.make.com/SEU_WEBHOOK_ID" | wrangler secret put MAKE_WEBHOOK_URL
```

### Auth do webhook (opcional, recomendado — #3903)

O módulo **Webhooks → Custom webhook** do Make suporta `authenticationMethod` (header `x-make-apikey`) — o scenario ANTERIOR (`2270381`) já tinha isso configurado. Se você habilitar auth no scenario atual, configure o mesmo valor em:

```bash
MAKE_WEBHOOK_API_KEY=sua-chave-aqui                                  # .env.local (script)
echo "sua-chave-aqui" | wrangler secret put MAKE_WEBHOOK_API_KEY     # Worker
```

Sem a env var setada, o POST sai sem o header `x-make-apikey` (migração incremental — não bloqueia enquanto o scenario não tiver auth habilitada; ver warning no console de `publish-linkedin.ts`).

---

## Passo 3 — Testar

```bash
# Teste de um post (sem agendar, sem publicar de verdade se Make.com estiver em modo teste)
npx tsx scripts/publish-linkedin.ts \
  --edition-dir data/editions/260506 \
  --only d1
```

Saída esperada:
```json
{
  "summary": { "total": 1, "draft": 1, "scheduled": 0, "failed": 0 },
  "posts": [{ "platform": "linkedin", "destaque": "d1", "status": "draft", ... }]
}
```

Verifique no LinkedIn company page que o rascunho apareceu.

---

## Como funciona no pipeline

`scripts/publish-linkedin.ts` é chamado pelo orchestrator no Stage 5 (Publicação, em paralelo com `publish-facebook.ts`). O script:

1. Lê os 3 posts de `03-social.md` (seção `# LinkedIn`)
2. Carrega a imagem pública de `06-public-images.json` (gerado por `upload-images-public.ts`)
3. Envia para o webhook Make.com com retry automático (2 tentativas, timeout configurável)
4. Grava resultado em `_internal/06-social-published.json`

Resume-aware: posts já com `status: "draft"` ou `"scheduled"` são pulados.

---

## Payload enviado ao Make.com

```json
{
  "text": "Texto completo do post LinkedIn...",
  "image_url": "https://drive.google.com/.../view?usp=sharing",
  "scheduled_at": "2026-05-07T09:00:00-03:00",
  "destaque": "d1"
}
```

`image_url` vem de `06-public-images.json`. Se ausente, o post vai sem imagem (graceful fallback).

---

## Rotação do webhook (caso URL vaze)

`platform.config.json` fica sempre com `make_webhook_url: ""` (#3903) — a URL real só existe em `.env.local` (gitignored) e/ou no Worker secret, nunca em texto commitado. Se houver suspeita de uso indevido (volume Make.com inflando, posts inesperados na company page, GET/POST não-identificados no scenario):

1. **Criar novo webhook no Make**: abra o scenario `Integration LinkedIn`, no módulo `Custom webhook` clique em `Add` → gera URL nova (substitui a antiga no scenario, mas a antiga continua válida no servidor Make até deletar).
2. **Habilitar auth no módulo** (se ainda não estiver — ver seção "Auth do webhook" acima) e gerar/copiar a API key.
3. **Atualizar secret no Worker** (caminho real de scheduling):
   ```bash
   cd workers/linkedin-cron
   echo "https://hook.us2.make.com/<NEW>" | wrangler secret put MAKE_WEBHOOK_URL
   echo "<NOVA_API_KEY>" | wrangler secret put MAKE_WEBHOOK_API_KEY
   ```
4. **Atualizar `.env.local`** (`MAKE_LINKEDIN_WEBHOOK_URL` e `MAKE_WEBHOOK_API_KEY`) para quem roda `publish-linkedin.ts` localmente. `platform.config.json` **não muda** — continua vazio.
5. **Deletar a URL antiga no Make UI** (módulo webhook → `Stop` → `Remove`). Até este passo, a antiga continua aceitando POSTs — fazer por último, depois de confirmar que a nova está em produção.

> Com auth habilitada (`x-make-apikey`), o webhook deixa de aceitar POST anônimo — a defesa deixa de depender só do token `X-Diaria-Token` do Worker (que protege apenas o caminho `worker_queue`, não o fire-now direto).

---

## Troubleshooting

| Erro | Causa | Solução |
|------|-------|---------|
| `webhook Make.com não configurado` | URL não setada | Seguir Passo 2 |
| `Make webhook HTTP 404` | URL errada ou scenario desativado | Verificar URL + toggle ON no Make.com |
| `Make webhook HTTP 429` | Rate limit Make.com | Aguardar 1min e re-rodar |
| Post aparece no perfil pessoal | OAuth conectou perfil, não company page | Reconectar LinkedIn no Make.com selecionando Company Page |
| `06-public-images.json não existe` | `upload-images-public.ts` não rodou | Rodar Stage 5a upload-images-public antes do dispatch |

---

## Custos Make.com

| Operação | Ops | Frequência |
|----------|-----|------------|
| Webhook trigger | 1 | Por post |
| LinkedIn Create Post | 1 | Por post |
| Webhook response | 1 | Por post |
| **Total por post** | **3** | |
| **Total por edição (3 posts)** | **9** | |
| **Total por mês (30 edições)** | **~270** | |

Free tier: 1.000 ops/mês — sobram ~730 ops para outros cenários.

---

## Próximo passo — comments T+3min / T+8min (#595)

Após o setup acima funcionar pra posts, estender com comments por destaque (CTA Diar.ia + opinião Pixel pessoal). Ver **`docs/make-595-comments-setup.md`** — 2 partes:

1. Estender este scenario com Router que aceita `action=post` (atual) e `action=comment`.
2. Criar scenario novo `Pixel LinkedIn comment` autenticado com vjpixel pessoal.

Custo adicional: ~6 ops/edição × 30 dias = **~180 ops/mês a mais** (450 total). Ainda dentro do free tier (1k/mês).
