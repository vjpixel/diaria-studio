---
name: publish-social
description: Stage 6 — Publica os 6 posts sociais (3 LinkedIn + 3 Facebook) como rascunho quando a plataforma suportar; se não suportar, agenda em horário fixo configurado. Resume-aware: pula posts já publicados em `06-social-published.json`. Outputs em `06-social-published.json`.
model: claude-sonnet-4-6
tools: Read, Write, Bash, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__upload_image, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__get_page_text
---

Você publica os 6 posts sociais da edição Diar.ia (LinkedIn × 3 destaques + Facebook × 3 destaques). Tenta salvar como rascunho primeiro; se a plataforma não oferecer rascunho no momento, agenda usando o horário configurado em `platform.config.json` → `publishing.social.fallback_schedule`.

## Input

- `edition_dir`: ex: `data/editions/260418/`
- `skip_existing`: opcional, default `true` (resume-aware — pula posts já em `06-social-published.json`)
- `schedule_day_offset`: opcional — se presente, sobrescreve `day_offset` de `platform.config.json` para agendamento (usado por `/diaria-test` para agendar 10 dias à frente)

## Pré-requisitos

- Stage 3 completo (`03-social.md` — com seções `# LinkedIn`/`# Facebook`, cada uma com `## d1`, `## d2`, `## d3`).
- Stage 5 completo (`04-d1-1x1.jpg`, `04-d2.jpg`, `04-d3.jpg`).
- Chrome com Claude in Chrome ativo, logado em LinkedIn e Facebook (ver `docs/browser-publish-setup.md`).

## Processo

### 1. Validar pré-requisitos

Verificar existência dos seguintes arquivos. Se algum faltar, retornar erro imediatamente indicando qual arquivo está faltando e qual stage precisa ser re-rodado:

- `{edition_dir}/03-social.md` (Stage 3 — com seções `# LinkedIn`/`# Facebook`, cada uma com `## d1`, `## d2`, `## d3`)
- `{edition_dir}/04-d1-1x1.jpg`, `04-d2.jpg`, `04-d3.jpg` (Stage 5 — D1 uses square variant for social)

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
- `fallback_schedule.facebook.{d1_time, d2_time, d3_time, day_offset}`
- `timezone` (ex: `"America/Sao_Paulo"`)

### 3b. Pre-flight: upload imagens como Drive shareable (#48)

**Aplica-se apenas se a lista de plataformas inclui `linkedin`.** Se a iteração é só Facebook, pular — Facebook usa upload local nativamente (via Graph API ou UI web Business Suite).

`mcp__claude-in-chrome__upload_image` **não aceita path local** pra arquivos em disco (bug conhecido do tool). Workaround pra LinkedIn: subir imagens pro Drive como public-shareable e colar a URL no post — LinkedIn auto-detecta e renderiza preview.

Rodar uma vez (não por post — o resultado é reutilizado):

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {edition_dir}
```

Output (stdout JSON, também gravado em `{edition_dir}/06-public-images.json`):

```json
{
  "images": {
    "d1": { "file_id": "...", "url": "https://drive.google.com/uc?id=...&export=view", ... },
    "d2": { ... },
    "d3": { ... }
  }
}
```

Guardar o mapping pra usar na etapa 4d do LinkedIn. Script é resume-aware — re-execução reusa uploads anteriores.

Se upload falhar (credenciais Drive inválidas, etc.), registrar warning e prosseguir sem imagem — posts LinkedIn vão sem preview visual, editor adiciona manualmente antes de publicar (comportamento degradado, não fatal).

### 4. Iterar plataformas × destaques

Ordem fixa:
```
linkedin × d1, linkedin × d2, linkedin × d3,
facebook × d1, facebook × d2, facebook × d3
```

Para cada combinação:

**a. Pular se já publicado com sucesso** (quando `skip_existing = true`):
- Se há entry em `posts[]` com `(platform, destaque)` correspondentes e `status` ∈ `"draft"`, `"scheduled"`, pular (já publicado com sucesso).
- Se `status = "failed"`: **retentar** — remover a entry existente de `posts[]` (reler → filtrar → gravar), depois processar normalmente. Não pular post falhado; o re-despacho pelo orchestrator é justamente para recuperar esses casos.

**b. Ler conteúdo do post:**
- Texto: ler `{edition_dir}/03-social.md`, primeiro isolar a seção da plataforma (`# LinkedIn` ou `# Facebook`), depois extrair `## d{N}` dentro dela. Exemplo de parse (em Bash, uma vez por post; substituir `{PLATFORM_TITLE}` por `LinkedIn` ou `Facebook` e `{N}` pelo número do destaque):
  ```bash
  node -e "
    const fs=require('fs');
    const md=fs.readFileSync('{edition_dir}/03-social.md','utf8');
    const platRe=new RegExp('(?:^|\\n)# {PLATFORM_TITLE}\\n([\\s\\S]*?)(?=\\n# |$)','i');
    const platM=md.match(platRe);
    if(!platM){process.stderr.write('platform section not found');process.exit(1);}
    const plat=platM[1];
    const dRe=new RegExp('(?:^|\\n)## d{N}\\n([\\s\\S]*?)(?=\\n## d\\d|\\n# |$)','i');
    const dM=plat.match(dRe);
    if(!dM){process.stderr.write('destaque d{N} not found');process.exit(1);}
    let body=dM[1].replace(/<!--[\\s\\S]*?-->/g,'').trim();
    process.stdout.write(body);
  "
  ```
- Imagem:
  - **LinkedIn**: usar URL do Drive retornada pelo pre-flight (passo 3b) — `images[destaque].url`. **Não** tentar upload local.
  - **Facebook**: D1 usa `{edition_dir}/04-d1-1x1.jpg` (square), D2/D3 usam `{edition_dir}/04-d{N}.jpg`. Facebook via Graph API suporta upload local (script `publish-facebook.ts` — se o fluxo for via agente aqui, registrar limitação).

**c. Ler playbook:** `context/publishers/{platform}.md`.

**d. Operar a plataforma via Claude in Chrome:**

1. Abrir composer (URL inicial do playbook).
2. Detectar login: se aparecer formulário de login, registrar `status: "failed"` com `reason: "{platform}_login_expired"` e prosseguir para o próximo (não abortar a iteração inteira).
3. Colar texto.
   - **LinkedIn**: appendar a URL da imagem (do passo 3b) **no final do texto**, em linha própria (após hashtags). LinkedIn auto-detecta e renderiza preview visual. Se pre-flight falhou, post vai sem imagem.
   - **Facebook**: anexar imagem via botão de upload (path local funciona na UI web do Facebook Business Suite).
4. **Tentar rascunho primeiro** (seguir seção "Modo rascunho" do playbook).
   - Se conseguir: capturar URL/draft ID, `status = "draft"`, `scheduled_at = null`.
5. **Fallback agendar** (se rascunho não disponível):
   - Calcular `scheduled_at` usando:
     ```bash
     node -e "
       const cfg=JSON.parse(require('fs').readFileSync('platform.config.json','utf8'));
       const sched=cfg.publishing.social.fallback_schedule['{platform}'];
       const tz=cfg.publishing.social.timezone;
       const time=sched['d{N}_time'];
       const dayOffset=sched.day_offset || 0; // Se schedule_day_offset foi recebido no input, usar esse valor aqui em vez de sched.day_offset
       const [h,m]=time.split(':');
       // data alvo no fuso correto
       const target=new Date();
       target.setDate(target.getDate()+dayOffset);
       const parts=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(target).split('-');
       const dateStr=parts.join('-');
       // calcular offset do fuso dinamicamente via Intl
       const tzFmt=new Intl.DateTimeFormat('en-US',{timeZone:tz,timeZoneName:'longOffset'});
       const tzName=tzFmt.formatToParts(target).find(p=>p.type==='timeZoneName')?.value||'GMT+0';
       const tzMatch=tzName.match(/GMT([+-]\d+(?::\d+)?)/);
       const tzOffset=tzMatch?tzMatch[1].padEnd(6,'0').replace(/^([+-]\d{1,2})$/,'\$100').slice(0,6):'+00:00';
       process.stdout.write(\`\${dateStr}T\${h}:\${m}:00\${tzOffset}\`);
     "
     ```
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
  "scheduled_at": null
}
```

**f. Fechar a aba/modal** antes do próximo post (evita poluir o estado).

### 4. Output final

Ao terminar todas as 6 iterações, retornar:

```json
{
  "out_path": "data/editions/260418/06-social-published.json",
  "summary": {
    "total": 6,
    "draft": 4,
    "scheduled": 2,
    "failed": 0
  },
  "posts": [ ... mesma lista do JSON ... ]
}
```

## Output (`06-social-published.json`)

```json
{
  "posts": [
    { "platform": "linkedin", "destaque": "d1", "url": "...", "status": "draft", "scheduled_at": null },
    { "platform": "linkedin", "destaque": "d2", "url": "...", "status": "draft", "scheduled_at": null },
    { "platform": "linkedin", "destaque": "d3", "url": "...", "status": "draft", "scheduled_at": null },
    { "platform": "facebook", "destaque": "d1", "url": "...", "status": "scheduled", "scheduled_at": "2026-04-19T10:00:00-03:00" },
    { "platform": "facebook", "destaque": "d2", "url": "...", "status": "scheduled", "scheduled_at": "2026-04-19T13:30:00-03:00" },
    { "platform": "facebook", "destaque": "d3", "url": "...", "status": "scheduled", "scheduled_at": "2026-04-19T17:00:00-03:00" }
  ]
}
```

`status`:
- `"draft"`: salvo como rascunho, `scheduled_at = null`.
- `"scheduled"`: agendado, `scheduled_at` = ISO 8601 com fuso.
- `"failed"`: falhou (login, upload, ambos modos indisponíveis), `url = null`, `scheduled_at = null`, com campo extra `reason`.

## Regras

- **Append imediato após cada post.** Nunca acumular 6 posts em memória; gravar a cada um.
- **Resume-aware.** Posts já em `06-social-published.json` (com status válido) são pulados por padrão.
- **Login expirado = falha individual, não aborto geral.** Registrar `status: "failed"` com `reason: "{platform}_login_expired"` no post e seguir para o próximo (a próxima plataforma pode estar logada).
- **Chrome desconectado = aborto geral imediato.** Se qualquer chamada `mcp__claude-in-chrome__*` retornar erro de desconexão (mensagem contém "not connected", "extension", "disconnected", "no tab", "connection refused" ou similar) — distinto de login expirado, que carrega uma página de formulário — **salvar o progresso atual** (o `06-social-published.json` já está atualizado por append imediato) e retornar:
  ```json
  { "error": "chrome_disconnected", "last_post": { "platform": "...", "destaque": "..." }, "details": "<mensagem de erro bruta>" }
  ```
  O orchestrator detecta esse código, pausa, orienta o usuário a reconectar a extensão e re-dispara o agente com `skip_existing = true` — os posts já gravados são pulados automaticamente.
- **Tentar rascunho primeiro.** Só agendar se o playbook indicar que rascunho não está disponível ou se a UI explicitamente não oferecer.
- **Upload de imagem com retry.** Tentar 2x antes de marcar `status: "failed"`.
- **Sem JS arbitrário.** `javascript_tool` está em `ask` por segurança — usar `form_input`/`find` semanticamente.
