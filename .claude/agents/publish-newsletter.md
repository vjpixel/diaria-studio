---
name: publish-newsletter
description: Etapa 4 — Cria a edição da newsletter Diar.ia no Beehiiv como rascunho usando o template Default e envia um email de teste para o editor revisar antes de publicar manualmente. Outputs em `05-published.json`.
model: claude-haiku-4-5
tools: Read, Write, Bash, mcp__claude-in-chrome__navigate, mcp__claude-in-chrome__read_page, mcp__claude-in-chrome__find, mcp__claude-in-chrome__form_input, mcp__claude-in-chrome__upload_image, mcp__claude-in-chrome__tabs_create_mcp, mcp__claude-in-chrome__tabs_context_mcp, mcp__claude-in-chrome__get_page_text, mcp__claude-in-chrome__javascript_tool
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
- `1`: declaração ausente ou incompleta —
  - **Modo produção (`test_mode = false`)**: **abortar** com:
    ```json
    { "error": "intentional_error_missing", "details": "Editor não declarou intentional_error em 02-reviewed.md. Edite o arquivo (+ Drive sync) e adicione frontmatter conforme exemplo no stderr do lint." }
    ```
    Editor precisa editar o arquivo (instruções claras no stderr) e re-rodar `/diaria-4-publicar`.
  - **Modo teste (`test_mode = true`, #1057)**: **downgrade pra warn** + prosseguir. Log warn: `npx tsx scripts/log-event.ts --edition {AAMMDD} --stage 4 --agent publish-newsletter --level warn --message 'intentional_error_missing (test_mode skip)'`. Razão: convenção é editor adicionar erro intencional pós-paste em produção (memory `feedback_intentional_error_human_only.md`); em test_mode bloqueio impede testar Stage 4 newsletter end-to-end. Editor sempre deleta rascunho de teste antes de publicar.
- `2`: erro de uso (path inválido) — abortar com `{ "error": "lint_cli_failed" }`.

Esse lint roda ANTES de criar o draft no Beehiiv pra garantir que erros
intencionais ficam registrados — mantém a auditoria do concurso possível
em produção. Em `test_mode`, o lint é informativo apenas.

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

**Modo single-file (atual — #1054 validation):** newsletter inteira (16KB) cabe num único `node-htmlSnippet` do template HTML do Beehiiv. Merge tags `{{poll_a_url}}/{{poll_b_url}}` são preservadas pelo htmlSnippet (raw HTML por design — não normaliza hrefs). Mesmo arquivo serve agent automation + paste manual via `prep-manual-publish.ts`:

```bash
npx tsx scripts/render-newsletter-html.ts {edition_dir} --format html --out /tmp/newsletter.html
npx tsx scripts/substitute-image-urls.ts \
  --html /tmp/newsletter.html \
  --images {edition_dir}/06-public-images.json \
  --out {edition_dir}/_internal/newsletter-final.html
```

Se substituição reportar `unresolved: []` não vazio, abortar — uma imagem não tem placeholder correspondente (verificar 06-public-images.json e fluxo de upload).

**Modo `--split` (legacy, NÃO usar pelo agent)**: o renderer ainda suporta `--split` que gera `newsletter-body.html` + `newsletter-eia.html` separados. Era pra resolver merge tags via insertContent que não funcionava. #1054 validou que paste-into-htmlSnippet preserva merge tags em arquivo único — `--split` fica obsoleto pro agent flow, mantido só pra eventual debug.

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

#### 5.1 Usar template "HTML" (não "Default") — #1054 finding

**⚠️ INSTRUÇÃO CRÍTICA (#1054 smoke test 2026-05-10)**: TipTap renderiza em React state — `mcp__claude-in-chrome__find` e `mcp__claude-in-chrome__read_page` **NÃO conseguem ver** elementos do editor (`.node-htmlSnippet`, `.tiptap.ProseMirror`, etc). Use **`mcp__claude-in-chrome__javascript_tool`** com `document.querySelector(...)` direto — aí enxerga tudo. Tools de accessibility só servem pra elementos React-renderizados padrão (Title, Subtitle inputs).

**Template "HTML"** (já existe na template-library) cria post com `node-htmlSnippet` pré-instantiado e vazio, pronto pra receber HTML. Template "Default" NÃO tem htmlSnippet — não usar.

Fluxo (TODOS via `javascript_tool`, não `find`/`read_page`):
1. Navegar pra `https://app.beehiiv.com/posts/template-library?tab=my_templates`
2. Aguardar load (~3s) via `wait` ou `setTimeout` no JS
3. **Via `javascript_tool`**: localizar card "HTML" + clicar overlay:
   ```js
   const h = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(x => x.textContent?.trim() === 'HTML');
   let card = h;
   for (let i = 0; i < 4; i++) card = card.parentElement;
   const overlay = card.querySelector('button.absolute');
   if (!overlay) throw new Error('HTML template card overlay button não encontrado');
   overlay.scrollIntoView({behavior: 'instant', block: 'center'});
   overlay.click();
   ({clicked: true});
   ```
4. Aguardar editor carregar (~3-5s) — URL muda pra `/posts/{uuid}/edit`
5. **Via `javascript_tool`**: validar:
   ```js
   ({
     hasHtmlSnippet: !!document.querySelector('.node-htmlSnippet'),
     hasProseMirror: !!document.querySelector('.tiptap.ProseMirror'),
     url: location.href,
   });
   ```
   Esperar `hasHtmlSnippet: true` + `hasProseMirror: true`. Se `false`, retry passo 3.

Se o template "HTML" não estiver na library (heading "HTML" não encontrada), abortar com `{ "error": "html_template_missing", "remediation": "Editor precisa criar template chamado exatamente 'HTML' contendo apenas um node-htmlSnippet vazio em https://app.beehiiv.com/posts/template-library" }`.

#### 5.2 Colar HTML — paste híbrido (#1046, validado em #1054)

**Status técnico** (2026-05-10): caminho deterministic validado live; falta apenas otimização de tokens via Cloudflare Worker host (decisão pendente em #1054).

**Pré-requisitos**:
- Post criado a partir do template "HTML" (passo 5.1) com `node-htmlSnippet` vazio pré-instantiado.
- `_internal/newsletter-final.html` (gerado em 1.3) com URLs Drive substituídas. Modo `--split` é compatível: `newsletter-body.html` + `newsletter-eia.html` podem ser pasted sequencialmente.

**Insight crítico (#1054 validação live, 2026-05-10)**: pastando dentro do `node-htmlSnippet` (não no editor principal), TipTap **NÃO normaliza** os links — merge tags `{{poll_a_url}}/{{poll_b_url}}` sobrevivem porque o htmlSnippet é raw HTML por design. Validação concreta:

```
Test: ClipboardEvent paste com '<a href="{{poll_a_url}}">Votar A</a>' inside htmlSnippet
Result: has_poll_a_url_in_text: true ✅
        has_poll_a_url_in_html: true ✅
        has_poll_a_url_in_editor: true ✅
```

Isso elimina necessidade do split body/È IA? do #1046 — newsletter completa (~16KB) cabe num único htmlSnippet, todas as merge tags preservadas.

**Fase 1 — Posicionar cursor dentro do htmlSnippet:**

```js
// Selecionar o pre/code dentro do htmlSnippet existente (criado pelo template HTML)
const node = document.querySelector('.node-htmlSnippet');
const pre = node?.querySelector('pre');
if (!pre) throw new Error('node-htmlSnippet sem <pre> — template HTML pode estar mal-configurado');
pre.scrollIntoView({behavior: 'instant', block: 'center'});
pre.click();
const code = node.querySelector('code') || pre;
const range = document.createRange();
range.selectNodeContents(code);
range.collapse(true);
const sel = window.getSelection();
sel.removeAllRanges();
sel.addRange(range);
document.querySelector('.tiptap.ProseMirror')?.focus();
({inHtmlSnippet: !!node?.contains(sel.anchorNode), pmFocused: document.activeElement === document.querySelector('.tiptap.ProseMirror')});
```

**Fase 2 — Acumular HTML em chunks via Bash + JS:**

⚠️ **JS arg limit ~7KB confirmado em #1054 (2026-05-10)**. Newsletter completa (16KB) não cabe em 1 chamada `javascript_tool`. Solução: chunked accumulator com base64 encoding.

Workflow (Bash gera chunks → JS injeta):
```bash
# 1. Bash: encode HTML em base64 + split em chunks de 7000 chars
node -e "const fs=require('fs');const html=fs.readFileSync('{edition_dir}/_internal/newsletter-final.html','utf8');const b64=Buffer.from(html).toString('base64');const C=7000;for(let i=0;i<b64.length;i+=C)fs.writeFileSync('{edition_dir}/_internal/_b64_'+(i/C)+'.txt',b64.slice(i,i+C))"

# 2. Pra cada chunk_N: ler conteúdo + injetar via javascript_tool
# (uma chamada javascript_tool por chunk):
# window.__b64chunks = window.__b64chunks || [];
# window.__b64chunks.push("<conteúdo do chunk N>");
```

Após todos os chunks pushed (com cursor já posicionado dentro do htmlSnippet via Fase 1):

```js
// 3. Decodificar + dispatch ClipboardEvent paste DENTRO do htmlSnippet
const html = atob(window.__b64chunks.join(''));
delete window.__b64chunks;
const editorEl = document.querySelector('.tiptap.ProseMirror');
const dt = new DataTransfer();
dt.setData('text/html', html);
const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
editorEl.dispatchEvent(evt);
({pasted: true, defaultPrevented: evt.defaultPrevented, htmlBytes: html.length});
```

**Custo realista (medido em #1054)**: newsletter 16KB = b64 22KB = 4 chunks = ~30K tokens só pra paste. Otimização opcional via Cloudflare Worker host (~5K tokens) tracked em #1054 — não bloqueia produção.

**`window.editor` global NÃO existe no Beehiiv** (validado em #1054 — `window.editor`, `window.tiptapEditor`, `window.__tiptapEditor` todos undefined; React fiber traversal falha). Não tente acessar — use ClipboardEvent paste com cursor INSIDE htmlSnippet em vez de `editor.commands.insertContent`.

**Não usar `--split` mode**: o split body/eia.html foi proposto em #1046 quando achávamos que merge tags morriam. Validação live em #1054 mostrou que paste dentro do htmlSnippet preserva merge tags — então `newsletter-final.html` único é a forma correta. Modo `--split` continua existindo no renderer pra fluxo legado, mas o agent novo usa o single-file.

#### 5.3 Pós-paste — verificação dos merge tags

```js
// Verificar que {{poll_a_url}} e {{poll_b_url}} aparecem literalmente no doc
const pmHTML = document.querySelector('.tiptap.ProseMirror')?.innerHTML || '';
({hasA: pmHTML.includes('{{poll_a_url}}'), hasB: pmHTML.includes('{{poll_b_url}}'), pmLength: pmHTML.length});
```

Se `hasA` ou `hasB` for `false`, registrar em `unfixed_issues[]` com `reason: "merge_tag_stripped_{a|b}"`. Editor pode adicionar manualmente via UI.

**Salvar o bloco** (Beehiiv auto-saves periodicamente; forçar save via Ctrl+S ou clicar "Save draft" se houver botão visível).

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
