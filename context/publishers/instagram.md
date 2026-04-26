# Playbook: Instagram (Stage 5 — social, #49)

Roteiro semântico para o agente `publish-social` operar o composer do Instagram via Claude in Chrome (Meta Business Suite). Documento vivo — atualize quando a UI mudar.

> **Status (abril/2026)**: roteiro em **standby**. Conta Instagram da Diar.ia ainda não foi criada/conectada à Página Facebook (issue #49 bloqueada nesse setup). Quando a conta estiver pronta:
> 1. Editor cria conta IG (preferência: IG Business, não Personal).
> 2. Conecta IG → Página FB Diar.ia via Meta Business Suite (Settings → Linked accounts).
> 3. Adiciona `"instagram"` em `platform.config.json > socials`.
> 4. Adiciona bloco `publishing.social.fallback_schedule.instagram` no config.
> 5. publish-social passa a iterar Instagram automaticamente seguindo este playbook.

## Plataforma

- URL: `https://business.facebook.com/` (Meta Business Suite — mesma UI do Facebook).
- Pré-condição: usuário logado, com acesso à página Diar.ia + conta Instagram conectada.
- **Não usar** `instagram.com/web/` direto: web do IG não suporta agendamento nativo; Meta Business Suite suporta.

## Diferenças vs Facebook

- **1 post por edição** (não 3 — diferente de LinkedIn/Facebook). A caption é única, gerada por `social-instagram` agent.
- **Sem links clicáveis no corpo** — sempre referenciar "link na bio" pra direcionar leitor pro post da newsletter.
- **Imagem obrigatória** (sem post text-only).
- **Hashtags** — usar 3-6 contextualmente relevantes (já no template).

## Objetivo

Criar **1 post** na conta Diar.ia Instagram com texto (caption) + imagem (1:1 ou 4:5). Tentar salvar como rascunho primeiro; se a UI não oferecer, agendar conforme `publishing.social.fallback_schedule.instagram`.

## Fluxo

### 1. Abrir Meta Business Suite
- Navegar para `https://business.facebook.com/`.
- Se cair em login, abortar com `"Facebook login expirado — IG depende do FB login"`.
- Selecionar página **Diar.ia** no seletor de contas (canto superior esquerdo).
- Confirmar que conta IG está conectada (deve aparecer ícone IG no painel).

### 2. Abrir composer
- Barra lateral → **Content** → **Create post**.
- No selector de canal/destination, **desmarcar Facebook** e **marcar apenas Instagram**.
- Aparecerá variante do composer com restrições do IG (sem links clicáveis, etc).

### 3. Colar caption
- Colar conteúdo da seção `# Instagram` em `03-social.md` (o `publish-social` extrai sem heading/comentários HTML).
- Não adicionar nada — caption vem pronta com hashtags incluídas.
- **Validar limite**: caption ≤ 2200 chars (Instagram hard limit). Se passou, abortar com erro acionável.

### 4. Anexar imagem
- Seção **Media** → **Add photo/video** → **Upload from computer**.
- Upload `04-d1-2x1.jpg` (capa, mesma da newsletter) **OU** variante quadrada `04-d1-1x1.jpg` se preferir crop sem ajuste do IG.
- Aguardar preview carregar.
- IG aceita 2:1, 1:1, 4:5 — todos viram crop visual no feed. **1:1 é mais seguro** pra evitar crop indesejado.

### 5. Tentar salvar como rascunho
- Botão **Save as draft** (mesma posição do FB).
- Confirmar.
- Drafts ficam em **Content** → **Posts** → filtro **Instagram** + tab **Drafts**.
- Capturar URL do draft. Status = `"draft"`.

### 6. Fallback: agendar
- Se rascunho não disponível:
  - No composer, dropdown ao lado de **Publish** → **Schedule post**.
  - Data = hoje + `publishing.social.fallback_schedule.instagram.day_offset` dias.
  - Hora = `publishing.social.fallback_schedule.instagram.time` (timezone = `publishing.social.timezone`).
  - Confirmar **Schedule**.
  - Capturar URL do post agendado. Status = `"scheduled"`.

### 7. Validar e fechar
- Verificar mensagem de confirmação ("Draft saved" ou "Post scheduled").
- Capturar URL/ID.
- Append em `06-social-published.json` com `platform: "instagram"`.

## Modo rascunho

**Suportado** via Meta Business Suite. Mesmo path do Facebook.

## Gotchas conhecidos

- **Sem links clicáveis no caption** — IG remove ou desativa qualquer URL no body. Sempre "link na bio".
- **Caption hard limit**: 2200 chars. Template já respeita, mas o agente deve validar antes de colar.
- **Hashtags**: o IG conta hashtags como parte do caption length. 3-6 hashtags = ~50-100 chars.
- **First comment trick**: alguns creators colocam hashtags no first comment em vez do caption pra UX mais clean. Não estamos fazendo isso por simplicidade — hashtags vão no caption.
- **Carrossel**: issue #49 menciona carrossel (1 slide por destaque) como follow-up possível. Este playbook cobre só single-image post. Carrossel vira issue separada.
- **Stories**: fora do escopo deste playbook.

## Validação de sucesso

- URL final em `https://business.facebook.com/.../posts/{id}` ou similar (capturar mesmo se for IG-specific URL).
- Confirmação "Draft saved" / "Post scheduled" visível.

## Erros recuperáveis

- **Login expirou** → abortar com mensagem clara.
- **Conta IG não conectada** → abortar com `"Conta IG não está conectada à página FB Diar.ia. Conectar em Meta Business Suite → Settings → Linked accounts."`.
- **Upload de imagem falha** → tentar 2x; se persistir, abortar.
- **Caption excede 2200 chars** → abortar com diff (chars excedidos).

## Output JSON

Append em `06-social-published.json`:
```json
{
  "platform": "instagram",
  "destaque": "single",
  "url": "https://business.facebook.com/.../posts/{id}",
  "status": "draft" | "scheduled",
  "scheduled_at": "2026-04-27T11:00:00-03:00" (se scheduled)
}
```

## Config necessária pra ativar

`platform.config.json`:
```json
{
  "socials": ["linkedin", "facebook", "instagram"],
  "publishing": {
    "social": {
      "fallback_schedule": {
        "instagram": { "time": "11:00", "day_offset": 0 }
      }
    }
  }
}
```

Sem essas entradas, o `publish-social` pula Instagram silenciosamente.
