# Playbook: LinkedIn (Stage 6 — social)

Roteiro semântico para o agente `publish-social` operar o composer do LinkedIn via Claude in Chrome. Documento vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://www.linkedin.com/`
- Pré-condição: usuário já logado no Chrome.
- Post sempre como **página Diar.ia** (ID: 110742958) — nunca como perfil pessoal (ver Passo 3).

## Objetivo

Para cada destaque (d1/d2/d3), criar um post com texto + imagem. **Tentar salvar como rascunho primeiro**; se a UI não oferecer rascunho no momento OU se houver overwrite detectado, agendar conforme `publishing.social.fallback_schedule.linkedin`.

## Fluxo (por post)

### 1. Abrir composer **fresh** (#266 — crítico)

LinkedIn reusa o composer entre invocações e oferece "Continue your draft" que faz o agent EDITAR um draft existente em vez de criar um novo. Resultado: 3 posts viraram 1 só draft (data loss reportada como success). Cada post precisa de composer isolado.

- Navegar para `https://www.linkedin.com/feed/` (re-navegar **sempre**, mesmo entre iterações).
- Se cair em login, abortar com `"LinkedIn login expirado"`.
- Clicar em **Start a post** (no topo do feed).
- **Se aparecer prompt "Continue your draft"**: clicar em **Discard** / **Start new** / fechar overlay e clicar Start a post de novo. **NUNCA** clicar Continue — anexa conteúdo novo ao draft anterior.
- Modal de composer abre vazio.
- **Validar via `javascript_tool`**: o `<div contenteditable>` deve ter `textContent.trim() === ""`. Se não estiver vazio, fechar e reabrir.

### 2. Capturar baseline draft count (uma vez por sessão, antes do d1)

Antes de criar o primeiro post (d1), registrar quantos drafts já existem na conta — usado pra validar unicidade de cada save (passo 6).

<!-- Se count sempre retornar 0, verificar a estrutura HTML atual da página de drafts e atualizar os seletores aqui. -->

```javascript
// Via javascript_tool em https://www.linkedin.com/in/me/recent-activity/drafts/
// Tentativa 1: seletores específicos de draft
let count = document.querySelectorAll('[data-test-id*="draft"], [data-urn*="draft"]').length;
// Fallback: seletor genérico de itens de lista (se seletores específicos retornarem 0)
if (count === 0) {
  count = document.querySelectorAll('.scaffold-finite-scroll__content > li').length;
}
return {
  count,
  warn: count === 0 ? 'Seletores de draft não encontraram nada — possível mudança de UI' : null
};
// O agente lê: const baseline = result.count; if (result.warn) registrar no output
```

O agente deve:
1. Ler `result.count` como `baseline_draft_count`.
2. Se `result.warn !== null`, incluir `warn: result.warn` no JSON de output (não bloquear).

Após cada save subsequente, recontar com a mesma lógica de fallback — count deve incrementar de exatamente +1 por iteração. Se não incrementar, save sobrescreveu draft existente → falha de dados.

**Se nenhum seletor funcionar após 2 tentativas**, continuar com `baseline = 0` — nunca bloquear o pipeline por conta de seletor frágil.

### 3. Escolher autor (uma vez por sessão) — OBRIGATÓRIO

O composer abre por padrão no contexto do perfil pessoal. É obrigatório trocar para a página Diar.ia (configurada em `publishing.social.linkedin.company_page_name`) antes de postar.

- Localizar o dropdown de autor (avatar/nome no topo do composer).
- Clicar e selecionar **Diar.ia** (página da empresa, ID: 110742958).
- **Verificar troca via `javascript_tool`** — não confiar só no visual. A verificação tem que olhar o seletor de autor ativo, não o `textContent` inteiro do dialog (a string "Diar.ia" também aparece nas opções do dropdown e em sugestões, gerando falso positivo):
  ```javascript
  // Tentativa em ordem: aria-label do botão de autor → data-test-id → fallback.
  const composer = document.querySelector('[role="dialog"]') || document.body;
  const authorBtn =
    composer.querySelector('[aria-label*="author" i]') ||
    composer.querySelector('[data-test-id*="actor" i]') ||
    composer.querySelector('button[id*="post-as"]') ||
    composer.querySelector('header [role="button"]');
  const authorText = (authorBtn?.textContent || authorBtn?.getAttribute('aria-label') || '').trim();
  // Match pelo nome configurado em platform.config.json → company_page_name.
  return {
    has_company_name: authorText.includes('Diar.ia'),
    author_text: authorText.slice(0, 100),
    selector_found: !!authorBtn,
  };
  ```
  Interpretação:
  - `has_company_name: true` → tudo certo, prosseguir.
  - `has_company_name: false` + `selector_found: true` → autor ainda é perfil pessoal, retry.
  - `selector_found: false` → seletor de autor mudou (UI shift), retry mas registrar warn no output.
- **Retry até 3×** se a verificação falhar (#506):
  - Tentativa 1: clicar dropdown, esperar 1s, selecionar Diar.ia, verificar.
  - Tentativa 2: fechar composer, reabrir (Passo 1), repetir.
  - Tentativa 3: fechar composer, navegar pra `publishing.social.linkedin.company_page_url` (admin dashboard da página) e procurar o botão "Start a post" no header. Se não achar o botão, considerar tentativa falha.
- **Se as 3 tentativas falharem:** ABORTAR com erro `"linkedin_page_not_found: página Diar.ia não disponível no composer após 3 tentativas — verificar acesso à página"`. **NUNCA continuar como perfil pessoal** — `status: "failed"`, `reason: "linkedin_page_not_found"`. Posts seguintes do mesmo run também abortam (sem retry novo) porque a sessão claramente não tem acesso à página.

### 4. Inserir texto
- O composer usa `<div contenteditable>` (ProseMirror) — `form_input` não funciona aqui. Usar `javascript_tool` para injetar o texto:
  ```javascript
  const el = document.querySelector('.ql-editor') || document.querySelector('[contenteditable="true"]');
  el.focus();
  document.execCommand('insertText', false, "<texto do post>");
  ```
- Conteúdo: seção `## d{N}` dentro de `# LinkedIn` em `03-social.md`, com heading e comentários HTML removidos.
- Não adicionar nada — o conteúdo já vem pronto e revisado por Clarice.

### 5. Imagem via URL pública (Drive) — #48

**Mudança**: em vez de upload do arquivo local (que não funciona via `mcp__claude-in-chrome__upload_image`), **colar a URL pública** retornada pelo pre-flight do agent (`scripts/upload-images-public.ts`). LinkedIn auto-detecta e renderiza preview visual.

- No campo do composer, **appendar em linha separada no fim do texto** (depois de hashtags):
  ```
  (texto do post)

  (hashtags)

  https://drive.google.com/uc?id={file_id}&export=view
  ```
- LinkedIn detecta a URL em 1-2s e renderiza card de preview com a imagem inline.
- Se o preview não renderizar (rare — Drive a vezes demora), aguardar 5s e re-verificar.
- Se não renderizar mesmo assim, tentar URL alternativa: `https://drive.google.com/file/d/{file_id}/view` (HTML wrapper com og:image).
- **Não** clicar em ícone de Photo (📷) — upload local não funciona no Claude in Chrome.

**Trade-off vs upload nativo**:
- Preview do LinkedIn mostra card de link em vez de imagem fullscreen.
- Engagement **tipicamente menor** que native image (diferença concreta não medida — vale A/B se virar preocupação editorial).
- Mas é o único approach 100% automatizado sem custo recorrente (ver #48 pra análise completa).

### 6. Tentar salvar como rascunho **com validação de unicidade** (#266)
- LinkedIn salva drafts automaticamente quando você fecha o composer com conteúdo. Procurar o **X** (fechar) → modal pergunta "Save as draft?" → confirmar.
- **Após confirmar**, navegar imediatamente para `https://www.linkedin.com/in/me/recent-activity/drafts/` e:
  1. Recontar drafts via `javascript_tool` (mesma lógica de fallback do passo 2).
  2. Se `count == baseline + iteration_number`, draft NOVO foi criado ✅. Capturar URL do primeiro draft visível usando seletores com fallback:
     ```javascript
     let url = document.querySelector('a[href*="/feed/update/urn:li:fsd_share:"]')?.href;
     if (!url) url = document.querySelector('a[href*="/feed/update/"]')?.href;
     return { url: url ?? null, warn: !url ? 'URL do draft não encontrada' : null };
     // O agente lê: result.url como draft_url; se result.warn !== null, incluir no output
     ```
     O agente deve: ler `result.url` como `draft_url`; se `result.warn !== null`, incluir `warn: result.warn` no JSON de output.
  3. Se `count <= baseline + (iteration_number - 1)`, save **sobrescreveu** draft anterior. Marcar este post como `status: "failed"` com `reason: "linkedin_draft_overwrite_detected"`.
  4. Se 2 saves consecutivos detectarem overwrite, switch para schedule no próximo (passo 7) — drafts viraram inviáveis nessa sessão.
- Drafts ficam em **Posts** → **Drafts** (acessível pelo perfil/página).

### 7. Fallback: agendar
- Triggers:
  - Opção de rascunho não aparecer (UI mudou ou só disponível pra certos tipos de conta).
  - Validação do passo 6 detectou overwrite duas vezes consecutivas (drafts não estão funcionando nessa sessão).
- Schedule é mais robusto que draft pra automation — não tem o problema de overwrite single-instance.
- Voltar ao composer (não fechar).
- Clicar no ícone de **clock/Schedule** (🕐) ao lado do botão Post.
- Selecionar data = hoje + `publishing.social.fallback_schedule.linkedin.day_offset` dias.
- Selecionar hora = `publishing.social.fallback_schedule.linkedin.d{N}_time` (timezone = `publishing.social.timezone`).
- Confirmar **Schedule**.
- Capturar URL do post agendado navegando pra `publishing.social.linkedin.scheduled_posts_url` (página da empresa). Status = `"scheduled"`.

### 8. Validar e fechar — verificação em 2 etapas (#506)

A mensagem "Post scheduled" pode aparecer mesmo quando o post foi parar no contexto errado (perfil pessoal em vez da página). Fazer verificação ativa em 2 passos:

1. **Confirmação UI**: ler mensagem ("Post scheduled" ou "Draft saved").
2. **Verificação de contexto via navegação** — navegar pra `publishing.social.linkedin.scheduled_posts_url` (página da empresa, NÃO `linkedin.com/feed/scheduled-posts/` do perfil pessoal):
   - Para scheduled: ir pra `scheduled_posts_url` do config e via `javascript_tool` confirmar que o texto do post (primeiros 50 chars) aparece nessa página.
   - Para draft: ir pra Drafts da página da empresa (acessível via composer da página) e idem.
   - Se o texto **não** aparecer na página da empresa, o post foi pro lugar errado → marcar `status: "failed"` com `reason: "linkedin_published_to_wrong_context"`. NÃO incluir URL pessoal no output como se fosse sucesso.
- Capturar URL ou ID **único** (passo 6 garante unicidade pra drafts; scheduled posts são naturalmente únicos).
- Fechar modal/aba antes do próximo post — re-navegar para `/feed/` no início da próxima iteração (passo 1).

## Modo rascunho

**Suportado** (com ressalva). LinkedIn tem drafts mas a feature varia por tipo de conta (pessoal vs página) e tem limites (~ 100 drafts). Se não detectar a opção, cair no fallback.

## Modo agendamento (fallback)

**Suportado.** LinkedIn permite agendar posts pessoais e de página com até 3 meses de antecedência.

## Gotchas conhecidos

- Composer pode demorar 2–5s para abrir após clicar "Start a post" — esperar.
- Upload de imagem grande (>5MB) pode levar 30s+ — aguardar barra de progresso.
- LinkedIn às vezes sugere "Add a hashtag" — ignorar (já estão no texto).
- Modal de "Are you sure you want to leave?" ao fechar sem postar = boa indicação que o draft NÃO foi salvo. Confirmar "Save as draft" se aparecer.
- O ícone de schedule (clock) só aparece **depois** de adicionar conteúdo (texto + imagem).

## Validação de sucesso

- **Draft**: aparece na seção Drafts da **página Diar.ia** (acessível via composer da página). Drafts do perfil pessoal **não** contam — são sinal de erro no Passo 3.
- **Scheduled**: aparece em `publishing.social.linkedin.scheduled_posts_url` (página da empresa) com data/hora. Capturar a URL aqui — `linkedin.com/feed/scheduled-posts/` é do perfil pessoal e nunca deve ser registrada como sucesso (#504, #506).

## Erros recuperáveis

- **Login expirou** → abortar.
- **Upload falha** → tentar 2x.
- **Nem draft nem schedule funcionam** → abortar este post, registrar em `06-social-published.json` com `status: "failed"` e prosseguir para o próximo.
