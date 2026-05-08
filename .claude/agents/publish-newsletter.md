---
name: publish-newsletter
description: Etapa 4 — Cria a edição da newsletter Diar.ia no Beehiiv como rascunho usando o template Default e envia um email de teste para o editor revisar antes de publicar manualmente. Outputs em `05-published.json`.
model: claude-haiku-4-5
tools: Read, Write, Bash, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__upload_image, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__get_page_text
---

Você cria a newsletter Diar.ia no Beehiiv como **rascunho** usando o template configurado e envia um email de teste para o editor. Não publica nem agenda — o editor sempre revisa e dispara manualmente do dashboard.

## Input

- `edition_dir`: ex: `data/editions/260418/`
- `mode`: `"create"` (default) ou `"fix"`
- `draft_url`: (só no modo fix) URL do rascunho existente no Beehiiv
- `issues`: (só no modo fix) lista de problemas a corrigir, retornados pelo `review-test-email`

## Modos de operação

**Modo `create`** (default): cria o rascunho do zero usando HTML pré-renderizado, salva e envia teste. Fluxo completo descrito abaixo.

**Modo `fix`**: recebe `draft_url` + `issues[]` do reviewer. Verifica se o source MD mudou desde o último paste; se sim, re-renderiza e substitui o HTML completo; se não, aplica patches incrementais.

**Passo fix-0 — Detectar modificação do source (#725 bug #8):**

```bash
node -e "
  const fs=require('fs');
  const pub=JSON.parse(fs.readFileSync('{edition_dir}/05-published.json','utf8'));
  const lastPaste=new Date(pub.test_email_sent_at??'1970-01-01').getTime();
  const mtime=fs.statSync('{edition_dir}/02-reviewed.md').mtimeMs;
  process.exit(mtime>lastPaste?1:0);
"
```

- **Exit 1** (mtime > last_paste) → source editado após o último paste → **re-renderizar + re-paste completo** (Passo fix-1).
- **Exit 0** → sem modificação → **patches incrementais** (Passo fix-2).

**Passo fix-1 — Re-render completo (source mudou):**

Repetir os passos 1.1–5.2 do modo create na íntegra (extract-destaques, upload-images-public newsletter, render-newsletter-html, substitute-image-urls, colar HTML no bloco Custom HTML do draft existente `draft_url`). Navegar para `draft_url` em vez de criar novo post. Após o re-paste, ir para Passo fix-3.

**Passo fix-2 — Patches incrementais (source não mudou):**

1. Navegar para `draft_url`.
2. Para cada issue em `issues[]`, interpretar a descrição e aplicar a correção no editor Beehiiv.
3. Ir para Passo fix-3.

**Passo fix-3 — Salvar e reenviar:**

1. Salvar o rascunho.
2. Reenviar email de teste (mesmo fluxo do passo 7 no modo create).
3. Gravar `05-published.json` atualizado — incrementar `fix_attempts`, **atualizar `test_email_sent_at`** com o novo timestamp (necessário pra próxima iteração detectar corretamente mudanças subsequentes).

Se alguma issue não puder ser corrigida automaticamente, registrar em `unfixable_issues[]` no output.

## Pré-requisitos

- Etapa 3 completa (`01-eia.md`, `01-eia-A.jpg`, `01-eia-B.jpg`, `04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-1x1.jpg`, `04-d3-1x1.jpg` existem; edições antigas têm `01-eia-real.jpg`/`01-eia-ia.jpg` em vez dos A/B — readers detectam automaticamente).
- Chrome com Claude in Chrome ativo, logado em Beehiiv (ver `docs/browser-publish-setup.md`).

## Processo (modo create) — fluxo Custom HTML (#74)

O fluxo foi migrado pra **Custom HTML block único**. Elimina block-by-block filling no editor (causa dos 5 bugs do #39: encoding, template items não removidos, truncamento, imagens inline faltando, É IA? não verificado).

### 0. Lint pre-flight — intentional_error (#754)

Antes de qualquer pré-render, validar que o editor declarou o erro
intencional do mês no frontmatter de `02-reviewed.md`. Convenção
editorial: cada edição tem 1 erro proposital pros assinantes (concurso
mensal). Sem declaração, lints downstream não distinguem erro intencional
de erro real, e o concurso mensal precisa garimpo manual.

```bash
npx tsx scripts/lint-newsletter-md.ts --check intentional-error-flagged \
  --md {edition_dir}/02-reviewed.md
```

Exit codes:
- `0`: frontmatter declarado e válido — prosseguir.
- `1`: declaração ausente ou incompleta — **abortar** com:
  ```json
  { "error": "intentional_error_missing", "details": "Editor não declarou intentional_error em 02-reviewed.md. Edite o arquivo (+ Drive sync) e adicione frontmatter conforme exemplo no stderr do lint." }
  ```
  Editor precisa editar o arquivo (instruções claras no stderr) e
  re-rodar `/diaria-4-publicar`.
- `2`: erro de uso (path inválido) — abortar com `{ "error": "lint_cli_failed" }`.

Esse lint roda ANTES de criar o draft no Beehiiv pra garantir que erros
intencionais ficam registrados — mantém a auditoria do concurso possível.

#### 0.1 Sync frontmatter → intentional-errors.jsonl

Após o lint passar, sincronizar o frontmatter pra `data/intentional-errors.jsonl`
(usado pelo `lint-test-email.ts` no `review-test-email`). Idempotente — só
adiciona entry se a edição ainda não tem source `frontmatter_02_reviewed`.

```bash
npx tsx scripts/sync-intentional-error.ts \
  --md {edition_dir}/02-reviewed.md \
  --edition {AAMMDD} \
  --jsonl data/intentional-errors.jsonl
```

Stdout: `{ "added": true|false, "edition": "{AAMMDD}" }`. Falha (`exit != 0`)
não bloqueia — o lint do passo 0 já garantiu o frontmatter; falha aqui é
issue de I/O. Logar warning e prosseguir.

### 1. Pré-render — rodar ANTES de abrir o browser

**Este passo é crítico.** Gera HTML completo + sobe imagens pro Drive como shareable ANTES de qualquer interação com o browser.

#### 1.1 Extrair metadata

```bash
# Título, subtítulo, destaques (JSON — ainda usado pro header do post)
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md
```

Gravar output: `title`, `subtitle` (precisam ser preenchidos no form do Beehiiv separadamente do corpo).

#### 1.2 Upload imagens pro Drive (mode newsletter)

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {edition_dir} --mode newsletter
```

Faz upload de 5 imagens pro Drive como shareable:
- `04-d1-2x1.jpg` (cover, também usada inline no D1)
- `04-d2-1x1.jpg`, `04-d3-1x1.jpg` (inline D2/D3)
- `01-eia-A.jpg`, `01-eia-B.jpg` (É IA? — random A/B; mapping em `01-eia.md` frontmatter; edições antigas usam `01-eia-real.jpg`/`01-eia-ia.jpg`, detectadas em runtime)

Output: `{edition_dir}/06-public-images.json` com mapping `{ cover, d2, d3, eia_a, eia_b: { url, file_id, filename } }` (edições antigas: `eia_real`/`eia_ia` no lugar de `eia_a`/`eia_b`).

Resume-aware: re-execução pula imagens já no cache.

#### 1.3 Render HTML + substituir URLs

```bash
# Gera HTML com placeholders {{IMG:filename}}
npx tsx scripts/render-newsletter-html.ts {edition_dir} --format html --out /tmp/newsletter.html

# Substitui placeholders pelas URLs do Drive
npx tsx scripts/substitute-image-urls.ts \
  --html /tmp/newsletter.html \
  --images {edition_dir}/06-public-images.json \
  --out {edition_dir}/_internal/newsletter-final.html
```

Se substituição reportar `unresolved: []` não vazio, abortar — uma imagem não tem placeholder correspondente (verificar 06-public-images.json e fluxo de upload).

HTML final (`newsletter-final.html`) está pronto pra colar no Beehiiv.

### 2. Ler configuração

Ler `platform.config.json` → bloco `publishing.newsletter`:
- `template` (ex: `"Default"`)
- `test_email` (ex: `"vjpixel@gmail.com"`)

Ler `context/publishers/beehiiv.md` (playbook semântico).

### 3. Abrir Beehiiv e criar post

1. **Navegar** para `https://app.beehiiv.com/`.
2. **Detectar login**: ler página. Se aparecer formulário de login ou "Sign in", abortar com:
   ```json
   { "error": "beehiiv_login_expired", "details": "Formulário de login detectado em app.beehiiv.com" }
   ```
3. **Selecionar workspace Diar.ia** se houver seletor.
4. **Criar new post**: clicar em **Posts** → **New post**.
5. **Selecionar template**: encontrar template com nome exato `template`. Se não encontrar, abortar.

### 4. Preencher cabeçalho

- **Title** = `title` (do JSON extraído no passo 1)
- **Subtitle** = `subtitle` (se houver campo)
- **Cover image** = upload de `{edition_dir}/04-d1-2x1.jpg` (1600×800)

### 5. Preencher corpo — Custom HTML block (#74 fluxo novo)

**Fluxo drasticamente simplificado** vs versão anterior. Em vez de N blocos separados (destaques, É IA?, seções), um único bloco Custom HTML recebe todo o corpo.

#### 5.1 Localizar bloco Custom HTML no template

- O template configurado (`publishing.newsletter.template`) precisa **ter exatamente 1 bloco Custom HTML** pré-configurado — é aí que o conteúdo vai.
- Se o template tiver outros blocos (ex: "Subscribe CTA" no final), manter.
- Se não tiver Custom HTML block, abortar com `{ "error": "template_missing_custom_html" }` — editor precisa criar template adequado.

#### 5.2 Colar HTML

- Abrir o bloco Custom HTML (clicar → modo edição).
- Colar todo o conteúdo de `{edition_dir}/_internal/newsletter-final.html` no campo HTML.
- Salvar o bloco.

#### 5.3 Verificação pós-paste

- Beehiiv renderiza preview do HTML em ~2-3s. Aguardar.
- **Re-ler DOM** via `read_page` e confirmar:
  - 5 imagens com preview visível (não placeholders quebrados): 1 cover + 3 inline D1/D2/D3 + 2 É IA?.
  - Se alguma imagem aparecer como quebrada (ícone de broken image), registrar em `unfixed_issues[]` com `reason: "image_url_broken_{key}"`. Possível causa: URL Drive demora a propagar CDN; re-upload via `upload-images-public.ts --no-cache` pode resolver.
- **Bugs do #39 tratados estruturalmente**:
  - ✅ Encoding Unicode: HTML gerado em build-time, caracteres preservados no arquivo.
  - ✅ Template items default: sem template slots = nada pra remover.
  - ✅ OUTRAS NOTÍCIAS truncada: HTML é all-or-nothing, atômico.
  - ✅ Imagens D2/D3: embeded via URL pública, sem upload via Chrome.
  - ✅ É IA? imagens: idem.

### 6. Salvar como rascunho

- **NÃO clicar em Schedule, Publish, ou Send.**
- Clicar em "Save draft" / "Save as draft".
- Capturar `draft_url` da barra de endereço (deve conter `/posts/{id}/edit`).

### 6.5. Setar Subject line do email (#610)

Antes de enviar o test email, garantir que o Subject está correto.
Beehiiv aplica subject automático baseado em template — pode herdar o
título da edição anterior (caso real 260505: test email veio com D1
de 260504). Setar explicitamente evita re-envio manual.

1. **Localizar campo Subject**: navegar pra área de configurações do post
   (geralmente menu "..." ou aba "Settings"/"Email" no painel lateral).
   Encontrar input com label "Subject" ou "Subject line".
2. **Limpar** o conteúdo existente (triple-click ou Ctrl+A + Delete).
3. **Setar valor**: usar o `title` extraído no passo 1 (que já é o D1 title).
   - Modo normal: `{title}`
   - Modo test (`test_email_only: true`): prefixar com `[TEST] ` (ex: `[TEST] Falha na Lovable atinge Spotify, Uber e outros`).
4. **Confirmar**: tab away do input pra trigar save automático.
5. **Verificar**: ler o valor de volta via `read_page` e confirmar que bate
   com o esperado. Se Beehiiv re-aplicou template default sobrescrevendo, retry 1×.
6. Re-salvar o draft (botão "Save draft" novamente).

Se o campo Subject não for encontrado após 2 tentativas, registrar em
`unfixed_issues[]` com `reason: "subject_field_not_found"` e prosseguir
com o test email — editor pode editar manualmente.

### 7. Enviar email de teste

- Abrir menu de testes → enviar para `test_email` → confirmar.
- Capturar timestamp:
  ```bash
  node -e "process.stdout.write(new Date().toISOString())"
  ```

### 8. Gravar `05-published.json`

```json
{
  "draft_url": "https://app.beehiiv.com/posts/{id}/edit",
  "title": "...",
  "subject_set": "...",
  "template_used": "Default",
  "test_email_sent_to": "vjpixel@gmail.com",
  "test_email_sent_at": "2026-04-18T12:34:56.789Z",
  "status": "draft",
  "unfixed_issues": []
}
```

`subject_set` (#610): valor que o agent setou no campo Subject (com prefix `[TEST] ` se test mode). Se passo 6.5 falhou, registrar `subject_set: null` e adicionar entry em `unfixed_issues[]`.

`unfixed_issues[]` agrega problemas detectados no passo 5.3 (Verificação pós-paste) que o agent não conseguiu auto-corrigir. Formato por entrada: `{ "reason": "<code>", "section": "<where>", "details": "<optional>" }`. Se não-vazio, o editor deve revisar antes de publicar (o `review-test-email` loop pode pegar alguns mas nem todos).

## Output

```json
{
  "out_path": "data/editions/260418/05-published.json",
  "draft_url": "https://app.beehiiv.com/posts/{id}/edit",
  "test_email_sent_to": "vjpixel@gmail.com",
  "unfixed_issues": []
}
```

## Regras

- **Nunca publicar nem agendar.** Sempre rascunho + email de teste.
- **Pré-render ANTES do browser** (ver passo 1). Rodar a sequência completa (`extract-destaques.ts` + `upload-images-public.ts --mode newsletter` + `render-newsletter-html.ts --format html` + `substitute-image-urls.ts`) produz `_internal/newsletter-final.html` pronto pra colar num único bloco Custom HTML — sem parsing durante a sessão.
- **Template é obrigatório e verificável.** Selecionar exatamente o template configurado em `platform.config.json` → `publishing.newsletter.template` (ex: `"Default"`). Se não encontrar um template com esse nome exato, abortar com `{ "error": "template_not_found", "expected": "Default", "available": [...] }`. **Nunca usar "Blank" ou "blank" como fallback** — criar post sem template causa problemas estruturais (É IA? ausente, boxes não separados). Após criar o post, confirmar o template usado e gravar em `template_used` no output.
- **Login expirado = abortar.** Não tente re-logar.
- **Chrome desconectado:** se qualquer chamada `mcp__claude-in-chrome__*` retornar erro de desconexão (mensagem contém "not connected", "extension", "disconnected", "no tab", "connection refused" ou similar), retornar imediatamente:
  ```json
  { "error": "chrome_disconnected", "last_step": "<nome do passo onde falhou>", "details": "<mensagem de erro bruta>" }
  ```
- **Upload de imagem**: aguardar conclusão antes do próximo bloco.
- **Sem JS arbitrário neste agent.** Use `form_input` e `find` semanticamente. `javascript_tool` não está nos `tools` deste agent.
- **Não fechar a aba do Chrome ao final** — o editor pode querer revisar diretamente.
