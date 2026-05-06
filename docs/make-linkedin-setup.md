# Make.com → LinkedIn Setup

One-time setup to enable programmatic LinkedIn publishing via Make.com webhook instead of Chrome automation.

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

Escolha **uma** das opções:

### Opção A — `.env.local` (recomendado, gitignored)

```bash
MAKE_LINKEDIN_WEBHOOK_URL=https://hook.eu2.make.com/SEU_WEBHOOK_ID
```

### Opção B — `platform.config.json`

```json
"publishing": {
  "social": {
    "linkedin": {
      "make_webhook_url": "https://hook.eu2.make.com/SEU_WEBHOOK_ID"
    }
  }
}
```

> A variável de ambiente tem precedência sobre o config.

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

`scripts/publish-linkedin.ts` é chamado pelo orchestrator no Stage 4 (em paralelo com `publish-facebook.ts`). O script:

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

## Troubleshooting

| Erro | Causa | Solução |
|------|-------|---------|
| `webhook Make.com não configurado` | URL não setada | Seguir Passo 2 |
| `Make webhook HTTP 404` | URL errada ou scenario desativado | Verificar URL + toggle ON no Make.com |
| `Make webhook HTTP 429` | Rate limit Make.com | Aguardar 1min e re-rodar |
| Post aparece no perfil pessoal | OAuth conectou perfil, não company page | Reconectar LinkedIn no Make.com selecionando Company Page |
| `06-public-images.json não existe` | `upload-images-public.ts` não rodou | Rodar Stage 4a.0 antes do dispatch |

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
