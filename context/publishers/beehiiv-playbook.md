# Playbook: Beehiiv (Etapa 4 — newsletter daily)

Playbook semântico+operacional pra criar a newsletter Diar.ia no Beehiiv como **rascunho** usando o template configurado, e enviar um email de teste. Não publica nem agenda — o editor revisa e dispara manualmente do dashboard.

**Histórico do arquivo**: este arquivo era `.claude/agents/publish-newsletter.md` até #1114 (2026-05-12). Movido pra `context/publishers/` pra refletir o que ele é de fato: um **playbook lido pelo top-level Claude Code**, não um subagent dispatchável. Razão técnica original em #1054: `mcp__claude-in-chrome__javascript_tool` é restrito ao top-level — subagentes não conseguem chamá-la. E como o paste-into-htmlSnippet exige JS direto no DOM, nenhum subagent completaria o passo 5.

**Fluxo correto** (invocado por `/diaria-4-publicar`, orchestrator-stage-4):
- Top-level Claude Code lê este arquivo como playbook
- Executa Bash, Read, Write, Chrome MCP tools direto
- **Não tente dispatchar via `Agent({ subagent_type: "publish-newsletter" })`** — o tipo não existe mais e javascript_tool falharia em qualquer subagent

Tools disponíveis no top-level: Bash, Read, Write, todas as `mcp__claude-in-chrome__*` (incluindo `javascript_tool`).

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

**Este passo é crítico.** Gera HTML completo + sobe imagens pro Cloudflare Worker KV ANTES de qualquer interação com o browser.

> **#1119 (2026-05-11)**: Imagens pra newsletter daily agora vão pro Cloudflare Worker KV (`/img/{key}`), não pro Drive. Razão: Drive `uc?id=...` retorna HTML wrapper na 1ª request + throttle agressivo + sem Cache-Control. Cloudflare entrega JPEG direto, com `Cache-Control: public, max-age=31536000, immutable`. LinkedIn/Facebook seguem com Drive (mode `social`) — OG preview funciona melhor lá.

#### 1.1 Extrair metadata

```bash
# Título, subtítulo, destaques (JSON — ainda usado pro header do post)
npx tsx scripts/extract-destaques.ts {edition_dir}/02-reviewed.md
```

Gravar output: `title`, `subtitle` (precisam ser preenchidos no form do Beehiiv separadamente do corpo).

#### 1.2 Upload imagens pro Cloudflare Worker KV (mode newsletter)

```bash
npx tsx scripts/upload-images-public.ts --edition-dir {edition_dir} --mode newsletter
```

Faz upload de 5 imagens pro Worker KV (default `--target cloudflare` quando `--mode newsletter`):
- `04-d1-2x1.jpg` (cover, também usada inline no D1)
- `04-d2-1x1.jpg`, `04-d3-1x1.jpg` (inline D2/D3)
- `01-eia-A.jpg`, `01-eia-B.jpg` (É IA? — random A/B; mapping em `01-eia.md` frontmatter; edições antigas usam `01-eia-real.jpg`/`01-eia-ia.jpg`, detectadas em runtime)

KV keys: `img-{AAMMDD}-{filename}` (ex: `img-260512-04-d1-2x1.jpg`). URLs servidas por `https://diar-ia-poll.diaria.workers.dev/img/{key}` com `Content-Type: image/jpeg` + `Cache-Control: public, max-age=31536000, immutable`.

Output: `{edition_dir}/06-public-images.json` com mapping `{ cover, d2, d3, eia_a, eia_b: { url, file_id, filename, target: "cloudflare" } }` (edições antigas: `eia_real`/`eia_ia` no lugar de `eia_a`/`eia_b`).

Resume-aware: re-execução pula imagens já no cache, **respeitando target**. Se cache tem entries `target=drive` mas o run pede `target=cloudflare`, faz re-upload.

**Escape hatch**: passar `--target drive` força Drive (ex: pra debug ou edições antigas que dependiam de URLs Drive específicas).

**Credenciais Cloudflare**: `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_WORKERS_TOKEN` no `.env`. Namespace ID lido de `platform.config.json → poll.kv_namespace_id`.

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

**⚠️ Title autosave latency** (#1198, 2026-05-12): inputs Title/Subtitle do Beehiiv não persistem no backend imediatamente — UI e `document.title` atualizam, mas `GET /posts/{id}` via API pode retornar `"New post"` por minutos. Antes de avançar pra Audience/Email steps: (a) `Tab` away pra trigar blur+autosave, (b) chamar `mcp__claude_ai_Beehiiv__get_post` e confirmar `title === expected`, (c) se stale, re-focar o campo + retype + blur. Sem esse guard, Audience/Review steps usam título errado e o Subject line default herda `"New post"`.

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

**Fase 1 — Validar acesso ao TipTap editor + htmlSnippet existem:**

⚠️ **Nota arquitetural (#1054 validação E2E, 2026-05-10)**: o paste real precisa atualizar **ProseMirror state** (não só DOM). `document.execCommand('insertText')` modifica DOM mas Beehiiv autosave serializa do `editor.state.doc`, então conteúdo via execCommand **não persiste após reload**. Validação concreta: paste de 16KB via execCommand → DOM tinha 16K → reload → só 78 chars persistiram.

A path correta é via TipTap commands API. O editor TipTap está acessível diretamente via `document.querySelector('.tiptap.ProseMirror').editor` (NÃO `window.editor` — esse não existe).

```js
const pm = document.querySelector('.tiptap.ProseMirror');
const editor = pm?.editor;
const node = document.querySelector('.node-htmlSnippet');
({
  hasEditor: !!editor,
  hasCommands: !!editor?.commands,
  hasNode: !!node,
  isEmpty: node?.classList.contains('is-empty'),
});
```

Esperar `hasEditor: true`, `hasCommands: true`, `hasNode: true`, `isEmpty: true`. Se editor for undefined, esperar 1-2s e retentar (TipTap pode estar inicializando).

**Fase 2 — Upload HTML pro Cloudflare Worker (#1178)** — caminho recomendado.

Em vez de chunkar + pushar via `javascript_tool` (consome ~80K tokens por edição), hospedar o HTML no Worker existente (`diar-ia-poll.diaria.workers.dev/html/{edition}`). Browser fetcha direto. Custo total ~5K tokens.

```bash
npx tsx scripts/upload-html-public.ts --edition {AAMMDD}
```

Stdout (JSON):
```json
{
  "edition": "260514",
  "url": "https://diar-ia-poll.diaria.workers.dev/html/260514",
  "bytes": 28341,
  "ttl_seconds": 604800
}
```

Pré-requisitos:
- `ADMIN_SECRET` (ou `POLL_ADMIN_SECRET`) no env — Worker valida HMAC do PUT.
- `_internal/newsletter-final.html` (gerado em 1.3).

TTL 7 dias no KV — suficiente pra paste de edição + retries. Re-rodar sobrescreve sem duplicar.

**Fallback legacy (#1177)**: se Worker indisponível ou ADMIN_SECRET ausente, ainda existe o flow chunk-html-base64 + javascript_tool push com hash check. Não recomendado (~80K tokens). Pra usar: `npx tsx scripts/chunk-html-base64.ts --edition-dir {edition_dir}` e seguir Fases 3/4 legacy do PR #1194 (visíveis no git log).

**Fase 3 — Fetch + paste via TipTap `editor.commands.insertContent` (#1178)**:

Browser baixa HTML direto do Worker e cola no editor TipTap. Single javascript_tool call (~5K tokens vs ~80K do chunked flow).

```js
// (1 chamada javascript_tool — fetch + decode + insertContent)
(async () => {
  const res = await fetch('https://diar-ia-poll.diaria.workers.dev/html/260514');
  if (!res.ok) return { error: `fetch ${res.status}` };
  const html = await res.text();

  const pm = document.querySelector('.tiptap.ProseMirror');
  const editor = pm?.editor;
  if (!editor) return { error: 'no editor' };

  let htmlSnippetPos = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'htmlSnippet') {
      htmlSnippetPos = pos;
      return false;
    }
  });
  if (htmlSnippetPos === null) return { error: 'no htmlSnippet' };

  const tr = editor.state.tr;
  const $pos = editor.state.doc.resolve(htmlSnippetPos + 1);
  tr.setSelection(editor.state.selection.constructor.near($pos));
  editor.view.dispatch(tr);

  const ok = editor.commands.insertContent({ type: 'text', text: html });
  return { inserted: ok, htmlBytes: html.length, docSize: editor.state.doc.content.size };
})()
```

**Fallback legacy Fase 4 (chunks decode) — não recomendado:**

⚠️ **Crítico (#1054 validação E2E, 2026-05-10)**: o ÚNICO método validado que persiste após autosave + reload é `editor.commands.insertContent({ type: 'text', text: html })`. Métodos descartados:

- ❌ `ClipboardEvent` synthetic dispatch — `defaultPrevented: false`, content nem entra no DOM
- ❌ `document.execCommand('insertText', false, html)` — atualiza DOM (codeLen=16K) mas NÃO atualiza ProseMirror state. Autosave captura state → reload mostra apenas 78 chars (estado pré-paste)
- ❌ `editor.commands.insertContent(htmlString)` — TipTap parseia como HTML, falha em `RangeError: Invalid content for node tableCell` por causa do schema

A solução validada: passar como **text node literal** (`{ type: 'text', text: ... }`) — TipTap não parseia, htmlSnippet armazena raw HTML como texto puro:

```js
(() => {
  // Decodificar base64 → HTML (UTF-8 safe)
  const b64 = window.__b64chunks.join('');
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const html = new TextDecoder('utf-8').decode(bytes);

  const pm = document.querySelector('.tiptap.ProseMirror');
  const editor = pm?.editor;
  if (!editor) return { error: 'no editor' };

  // Achar posição do htmlSnippet no doc + posicionar cursor dentro dele
  let htmlSnippetPos = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'htmlSnippet') {
      htmlSnippetPos = pos;
      return false;
    }
  });
  if (htmlSnippetPos === null) return { error: 'no htmlSnippet in doc' };

  const tr = editor.state.tr;
  const $pos = editor.state.doc.resolve(htmlSnippetPos + 1);
  tr.setSelection(editor.state.selection.constructor.near($pos));
  editor.view.dispatch(tr);

  // Insert como TEXT NODE (NÃO como HTML parseado)
  const ok = editor.commands.insertContent({ type: 'text', text: html });

  // Cleanup
  delete window.__b64chunks;

  const newJSON = JSON.stringify(editor.getJSON());
  return {
    inserted: ok,
    htmlBytes: html.length,
    docSize: editor.state.doc.content.size,
    hasPollA: newJSON.includes('{{poll_a_url}}'),
    hasPollB: newJSON.includes('{{poll_b_url}}'),
    hasImgA: newJSON.includes('14e0Acht-c0wRH7geqSBZ_kkYtQdlL3aK'),
    hasImgB: newJSON.includes('1NHj3Mlb0WEwtngfhZ3S9ycLKK2ZkQb55'),
  };
})()
```

Resultado esperado (validado em #1054):
- `inserted: true`
- `docSize` ≈ `htmlBytes + 4` (overhead do nó)
- Todos os markers críticos = `true`

Se `inserted: false` ou markers críticos forem `false`, registrar em `unfixed_issues[]` com `reason: "paste_failed"` e abortar antes do save (passo 6).

**Aguardar autosave**: após `insertContent`, esperar ~8s para Beehiiv autosave persistir. Validação opcional via reload + getJSON: deve manter `docSize` constante.

**Custo realista (medido em #1054)**: newsletter 16KB = b64 22KB = 4 chunks = ~30K tokens só pra paste. Otimização via Cloudflare Worker host (~5K tokens) tracked em #1054 — não bloqueia produção.

**`window.editor` global NÃO existe no Beehiiv** (`window.editor`, `window.tiptapEditor`, `window.__tiptapEditor` todos undefined). O editor TipTap está acessível diretamente em `document.querySelector('.tiptap.ProseMirror').editor` — esse path foi validado em E2E #1054.

**Não usar `--split` mode**: o split body/eia.html foi proposto em #1046 quando achávamos que merge tags morriam. Validação live em #1054 mostrou que paste-into-htmlSnippet preserva merge tags — então `newsletter-final.html` único é a forma correta. Modo `--split` continua existindo no renderer pra fluxo legado, mas o agent novo usa o single-file.

#### 5.3 Pós-paste — verificação dos merge tags via ProseMirror state

```js
// Verificar via getJSON (ProseMirror state, não DOM) — esse é o que persiste
const editor = document.querySelector('.tiptap.ProseMirror')?.editor;
const json = JSON.stringify(editor.getJSON());
({
  hasA: json.includes('{{poll_a_url}}'),
  hasB: json.includes('{{poll_b_url}}'),
  jsonLen: json.length,
  docSize: editor.state.doc.content.size
});
```

Se `hasA` ou `hasB` for `false`, registrar em `unfixed_issues[]` com `reason: "merge_tag_stripped_{a|b}"`. Editor pode adicionar manualmente via UI.

**Salvar o bloco**: Beehiiv auto-saves após ~5s do último input. Aguardar 8s antes de prosseguir pra próximos passos. Validação opcional: reload da page e re-checar `getJSON()` — `docSize` e markers críticos devem permanecer iguais. Se docSize voltar pro valor pré-paste, autosave não capturou — investigar (timing, transação rolled back, schema rejection).

#### 5.4 Verificação pós-paste — preview

- Beehiiv não renderiza preview do htmlSnippet **dentro do editor** (htmlSnippet é raw HTML armazenado como texto, não preview visual). A verificação visual completa só acontece via "Email preview" / "Web preview" do Beehiiv ou via test email recebido (passo 7).
- **Verificação programática suficiente**: o passo 5.3 já validou via `editor.getJSON()` que merge tags + image URLs estão preservados na ProseMirror state. Se passou, o conteúdo está correto e o preview do email vai renderizar.
- **Validação visual opcional**: editor pode clicar em "Preview" no Beehiiv após o agent completar; URLs de imagens vêm do Cloudflare Worker KV (#1119), disponibilidade quase imediata (KV é eventually consistent, ~1-2s). Se imagem aparecer quebrada no preview, verificar (a) que upload retornou 2xx, (b) que GET na URL retorna JPEG válido (`curl -so /tmp/test.jpg <url> && file /tmp/test.jpg`), (c) re-upload via `upload-images-public.ts --mode newsletter --no-cache` se necessário.
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

**Por que o playbook para no draft (não tenta Schedule via automação)** (#1198, 2026-05-12): testado 5 mecanismos pra clicar "Publish on..." no modal Schedule do Beehiiv — `computer.left_click` por coord, `find` + ref, `btn.click()` via JS, `PointerEvent` dispatch synthetic, `props.onClick(fakeEvent)` direto no React fiber. Todos foram silenciosamente rejeitados (modal não fecha, status permanece `draft`, `scheduled_at` null). Provável guard de user-activation (gesto humano real) no Beehiiv pra ações de blast radius alto (publicação real pra audiência). Conclusão: **Schedule é sempre manual**, mesmo se o resto do flow rodar 100% automático — não vale gastar mais ciclos tentando contornar.

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
- **JS direto via `javascript_tool` é obrigatório no passo 5** (cursor positioning + chunked paste + verify). Use `find`/`read_page` apenas pra elementos React-padrão (Title, Subtitle inputs, botões "Save draft").
- **Não fechar a aba do Chrome ao final** — o editor pode querer revisar diretamente.
