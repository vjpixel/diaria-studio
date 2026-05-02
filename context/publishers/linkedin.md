# Playbook: LinkedIn (Stage 6 — social)

Roteiro semântico para o agente `publish-social` operar o composer do LinkedIn via Claude in Chrome. Documento vivo — atualize quando a UI mudar.

## Plataforma

- URL: `https://www.linkedin.com/`
- Pré-condição: usuário já logado no Chrome.
- Post como **pessoa** ou **página** Diar.ia (o composer pergunta no início — escolher conforme estratégia editorial; default = página Diar.ia se existir).

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

### 3. Escolher autor (uma vez por sessão)
- Se o composer mostrar dropdown de autor, escolher página **Diar.ia** se existir; senão, perfil pessoal.

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
- Capturar URL do post agendado em `https://www.linkedin.com/feed/scheduled-posts/`. Status = `"scheduled"`.

### 8. Validar e fechar
- Verificar mensagem de confirmação ("Post scheduled" ou "Draft saved").
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

- **Draft**: aparece em `https://www.linkedin.com/in/me/recent-activity/drafts/` (perfil) ou na seção Drafts da página.
- **Scheduled**: aparece em `https://www.linkedin.com/feed/scheduled-posts/` (ou similar) com data/hora.

## Erros recuperáveis

- **Login expirou** → abortar.
- **Upload falha** → tentar 2x.
- **Nem draft nem schedule funcionam** → abortar este post, registrar em `06-social-published.json` com `status: "failed"` e prosseguir para o próximo.
