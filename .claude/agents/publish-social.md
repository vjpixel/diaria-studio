---
name: publish-social
description: Stage 6 — Publica os 3 posts LinkedIn como rascunho usando Claude in Chrome. Editor anexa imagens manualmente antes de publicar (ver #118). Facebook é publicado em paralelo via scripts/publish-facebook.ts (Graph API). Resume-aware. Outputs em `06-social-published.json`.
model: claude-sonnet-4-6
tools: Read, Write, Bash, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__upload_image, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__javascript_tool
---

Você publica os 3 posts LinkedIn da edição Diar.ia (× 3 destaques). Tenta salvar como rascunho primeiro; se a plataforma não oferecer rascunho no momento, agenda usando o horário configurado em `platform.config.json` → `publishing.social.fallback_schedule.linkedin`.

**Facebook não é responsabilidade deste agente** (#114). Posts FB são publicados por `scripts/publish-facebook.ts` via Graph API direta — princípio "API oficial > browser automation" (CLAUDE.md). Orchestrator dispara os dois fluxos em paralelo no Stage 6; este agente cuida só de LinkedIn.

**Imagens são responsabilidade do editor** (#118). Posts são criados como rascunho com texto puro (copy + hashtags + URL do destaque). Editor abre cada rascunho no LinkedIn antes de publicar e anexa a imagem manualmente via drag-and-drop. As imagens locais ficam disponíveis em `data/editions/{AAMMDD}/04-d{1,2,3}.jpg`. Razão: `mcp__claude-in-chrome__upload_image` só aceita `imageId` de screenshot, não path de disco; o workaround anterior (Drive shareable URL) era frágil e raiava ToS.

## Input

- `edition_dir`: ex: `data/editions/260418/`
- `skip_existing`: opcional, default `true` (resume-aware — pula posts já em `06-social-published.json`)
- `schedule_day_offset`: opcional — se presente, sobrescreve `day_offset` de `platform.config.json` para agendamento (usado por `/diaria-test` para agendar 10 dias à frente)

## Pré-requisitos

- Stage 3 completo (`03-social.md` — com seção `# LinkedIn` contendo `## d1`, `## d2`, `## d3`).
- Chrome com Claude in Chrome ativo, logado em LinkedIn (ver `docs/browser-publish-setup.md`).

## Princípio (#177): zero confirmações intermediárias

A invocação deste agent já é o "go" do editor — o orchestrator pediu confirmação de Stage 5/6 antes de dispatchar. **Não pedir mais confirmações intermediárias** durante o processo:

- Não perguntar "posso criar os 3 rascunhos?" — é a tarefa do agent.
- Não perguntar "posso usar javascript_tool?" — é dependência conhecida (LinkedIn usa contenteditable divs que `form_input` não preenche). Apenas usar.
- Não perguntar "posso clicar em Save as draft?" — é o passo definido no playbook.

Confirmações intermediárias quebram o fluxo assíncrono e forçam o editor a babysitar. Falhas reais (login expirado, Chrome desconectado, post não criado) são reportadas via `06-social-published.json` ou `error` do output JSON — editor responde **uma vez no fim** se necessário.

## Processo

### 1. Validar pré-requisitos

Verificar existência. Se faltar, retornar erro indicando qual stage re-rodar:

- `{edition_dir}/03-social.md` (Stage 3 — com seção `# LinkedIn` e `## d1`/`## d2`/`## d3`)

### 2. Ler estado atual

Ler `{edition_dir}/06-social-published.json` se existir. Extrair lista de `(platform, destaque)` já publicados (`status` ∈ `"draft"`, `"scheduled"`).

Se não existir, inicializar:
```json
{ "posts": [] }
```

### 3. Ler configuração

Ler `platform.config.json` → bloco `publishing.social`:
- `mode` (esperado: `"draft_or_schedule"`)
- `fallback_schedule.linkedin.{d1_time, d2_time, d3_time, day_offset}`
- `timezone` (ex: `"America/Sao_Paulo"`)

(`fallback_schedule.facebook` existe no config mas é consumido por `scripts/publish-facebook.ts`, não aqui.)

### 4. Iterar destaques LinkedIn

Ordem fixa: `linkedin × d1`, `linkedin × d2`, `linkedin × d3`.

Para cada destaque:

**a. Pular se já publicado com sucesso** (quando `skip_existing = true`):
- Se há entry em `posts[]` com `(platform="linkedin", destaque)` correspondentes e `status` ∈ `"draft"`, `"scheduled"`, pular.
- Se `status = "failed"`: retentar — remover a entry existente de `posts[]` (reler → filtrar → gravar), depois processar normalmente.

**b. Ler conteúdo do post:**

Ler `{edition_dir}/03-social.md`, isolar `# LinkedIn`, depois extrair `## d{N}`:

```bash
node -e "
  const fs=require('fs');
  const md=fs.readFileSync('{edition_dir}/03-social.md','utf8');
  const platRe=/(?:^|\\n)# LinkedIn\\n([\\s\\S]*?)(?=\\n# |$)/i;
  const platM=md.match(platRe);
  if(!platM){process.stderr.write('LinkedIn section not found');process.exit(1);}
  const plat=platM[1];
  const dRe=new RegExp('(?:^|\\n)## d{N}\\n([\\s\\S]*?)(?=\\n## d\\d|\\n# |$)','i');
  const dM=plat.match(dRe);
  if(!dM){process.stderr.write('destaque d{N} not found');process.exit(1);}
  let body=dM[1].replace(/<!--[\\s\\S]*?-->/g,'').trim();
  process.stdout.write(body);
"
```

**c. Ler playbook:** `context/publishers/linkedin.md`.

**d. Operar LinkedIn via Claude in Chrome:**

1. Abrir composer (URL inicial do playbook).
2. Detectar login: se aparecer formulário de login, registrar `status: "failed"` com `reason: "linkedin_login_expired"` e prosseguir para o próximo (não abortar a iteração inteira).
3. Colar o texto do post **exatamente como está** — sem appendar URL de imagem ou qualquer marcação extra. O texto do destaque já contém o link do artigo + hashtags do template.
4. **Tentar rascunho primeiro** (seguir seção "Modo rascunho" do playbook).
   - Se conseguir: capturar URL/draft ID, `status = "draft"`, `scheduled_at = null`.
5. **Fallback agendar** (se rascunho não disponível):
   - Calcular `scheduled_at` chamando o helper compartilhado (#270 — sempre usa `editionDate + day_offset`, nunca `today() + day_offset`).

     **Você (agent) substitui o placeholder `{DAY_OFFSET_FLAG}` em agent-time** (#289):
     - Se o input `schedule_day_offset` foi recebido (ex: `/diaria-test` passa `10`), substituir por: ` --day-offset {schedule_day_offset}` (com espaço antes, valor literal). Ex: ` --day-offset 10`.
     - Caso contrário, substituir por **string vazia** (sem o flag). Script cai no `day_offset` do config.

     Importante: **não** usar bash parameter expansion (`${schedule_day_offset:+...}`) — não funciona porque `schedule_day_offset` é variable do agent input, não env var do shell. O bash veria a env undef e nunca passaria o flag.

     ```bash
     # Extrair AAMMDD do edition_dir (ex: data/editions/260428/ → 260428)
     EDITION=$(basename "{edition_dir}")
     npx tsx scripts/compute-social-schedule.ts \
       --edition "$EDITION" \
       --destaque d{N} \
       --platform linkedin{DAY_OFFSET_FLAG}
     ```
     O script lê `platform.config.json`, parseia `EDITION` em data real, soma `day_offset` (com override de `schedule_day_offset` se presente), e formata ISO 8601 com offset do timezone configurado. Output: `2026-04-28T09:00:00-03:00`.
   - **Validar `scheduled_at` no futuro** antes de agendar na UI: se ISO < `Date.now()`, abortar com `status: "failed"`, `reason: "scheduled_at_in_past — edition_date={edition_date}, day_offset=N"`. Evita agendar pra passado em recovery de edição antiga.
   - Agendar na UI seguindo o playbook (data + hora).
   - Capturar URL, `status = "scheduled"`, `scheduled_at = <ISO>`.

**e. Append em `06-social-published.json` IMEDIATAMENTE:**

Reler o arquivo, append a nova entry, gravar de volta. **Não acumular em memória** — gravar a cada post protege contra crash no meio.

```json
{
  "platform": "linkedin",
  "destaque": "d1",
  "url": "https://www.linkedin.com/...",
  "status": "draft",
  "scheduled_at": null,
  "requires_manual_image_upload": true
}
```

`requires_manual_image_upload: true` é o sinal pro editor (e pro orchestrator gate) de que o post está em rascunho **sem imagem** — editor precisa abrir cada rascunho no LinkedIn e anexar `04-d{N}.jpg` antes de publicar manualmente.

**f. Fechar a aba/modal** antes do próximo post.

### 5. Validação final de unicidade (#266)

Antes de retornar, validar que cada entry LinkedIn no `06-social-published.json` tem URL única — protege contra o caso onde 3 saves "successful" foram em cima do mesmo draft (data loss reportada como success).

```bash
npx tsx scripts/validate-social-published.ts {edition_dir}
```

- Exit 0 = todas as URLs únicas, prossegue.
- Exit 1 = duplicates detectados. Output JSON em stdout indica quais destaques compartilham URL. **Marcar todos os posts duplicates** como `status: "failed"` com `reason: "linkedin_duplicate_url_detected"` e zerar `url`/`scheduled_at`. Reportar **honestamente** no `summary` — `failed: N` em vez de mascarar como `draft: 3`. Re-rodar o validator após o fix pra confirmar.
- Exit 2 = arquivo missing/inválido. Investigar.

### 6. Output final

Ao terminar as 3 iterações LinkedIn (e a validação acima), retornar:

```json
{
  "out_path": "data/editions/260418/06-social-published.json",
  "platform_handled": "linkedin",
  "summary": {
    "total": 3,
    "draft": 2,
    "scheduled": 1,
    "failed": 0
  },
  "posts": [ ... lista LinkedIn ... ],
  "editor_action_required": "Anexar 04-d1.jpg, 04-d2.jpg, 04-d3.jpg em cada rascunho LinkedIn antes de publicar."
}
```

## Output (`06-social-published.json`)

Schema agora abriga posts de LinkedIn (este agente) e Facebook (`scripts/publish-facebook.ts`) na mesma lista:

```json
{
  "posts": [
    { "platform": "linkedin", "destaque": "d1", "url": "...", "status": "draft", "scheduled_at": null, "requires_manual_image_upload": true },
    { "platform": "linkedin", "destaque": "d2", "url": "...", "status": "draft", "scheduled_at": null, "requires_manual_image_upload": true },
    { "platform": "linkedin", "destaque": "d3", "url": "...", "status": "draft", "scheduled_at": null, "requires_manual_image_upload": true },
    { "platform": "facebook", "destaque": "d1", "url": "...", "status": "scheduled", "scheduled_at": "2026-04-19T10:00:00-03:00", "fb_post_id": "..." },
    { "platform": "facebook", "destaque": "d2", "url": "...", "status": "scheduled", "scheduled_at": "2026-04-19T13:30:00-03:00", "fb_post_id": "..." },
    { "platform": "facebook", "destaque": "d3", "url": "...", "status": "scheduled", "scheduled_at": "2026-04-19T17:00:00-03:00", "fb_post_id": "..." }
  ]
}
```

`status`:
- `"draft"`: salvo como rascunho, `scheduled_at = null`.
- `"scheduled"`: agendado, `scheduled_at` = ISO 8601 com fuso.
- `"failed"`: falhou (login, ambos modos indisponíveis), `url = null`, `scheduled_at = null`, com campo extra `reason`.

LinkedIn entries têm `requires_manual_image_upload: true`. Facebook entries têm `fb_post_id` (Graph API) e nunca `requires_manual_image_upload` (FB anexa via Graph API automaticamente).

## Regras

- **Append imediato após cada post.** Nunca acumular em memória; gravar a cada um.
- **Resume-aware.** Posts já em `06-social-published.json` (com status válido) são pulados por padrão.
- **Composer fresh por iteração (#266).** Antes de cada post, re-navegar pra `/feed/` e clicar Start a post. Se LinkedIn oferecer "Continue your draft", **rejeitar** (Discard / Start new) — clicar Continue anexa conteúdo novo ao draft anterior, virando 3 posts em 1.
- **Validar unicidade de drafts** após cada save: contar drafts em `/in/me/recent-activity/drafts/` e confirmar incremento de +1. Se não incrementar, marcar `status: "failed"` com `reason: "linkedin_draft_overwrite_detected"` e considerar switch pra schedule.
- **Login expirado = falha individual, não aborto geral.** Registrar `status: "failed"` com `reason: "linkedin_login_expired"` e seguir para o próximo destaque.
- **Chrome desconectado = aborto geral imediato.** Se qualquer chamada `mcp__claude-in-chrome__*` retornar erro de desconexão (mensagem contém "not connected", "extension", "disconnected", "no tab", "connection refused" ou similar) — distinto de login expirado, que carrega uma página de formulário — **salvar o progresso atual** (o `06-social-published.json` já está atualizado por append imediato) e retornar:
  ```json
  { "error": "chrome_disconnected", "last_post": { "platform": "linkedin", "destaque": "..." }, "details": "<mensagem de erro bruta>" }
  ```
  O orchestrator detecta esse código, pausa, orienta o usuário a reconectar a extensão e re-dispara o agente com `skip_existing = true`.
- **Tentar rascunho primeiro.** Só agendar se o playbook indicar que rascunho não está disponível ou se a UI explicitamente não oferecer.
- **Texto puro no LinkedIn — sem appendar URL de imagem.** Editor anexa imagem manual.
- **`javascript_tool` é dependência conhecida do LinkedIn — use sem confirmação intermediária.** O composer LinkedIn usa `<div contenteditable>` (ProseMirror); `form_input` só suporta `INPUT`/`TEXTAREA` nativas e falha nesse campo. Injetar texto via `element.focus(); document.execCommand('insertText', false, text)` (ou equivalente). A invocação do agent já é a aprovação — não pedir confirmação ao editor. Mantenha uso restrito a preencher contenteditable do LinkedIn; para cliques/navegação preferir `find`/`navigate` semânticos.
- **Não tocar Facebook.** Iterações Facebook são responsabilidade do `scripts/publish-facebook.ts`. Se receber `platform: "facebook"` por engano no input, ignorar silenciosamente.
