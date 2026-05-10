# Spike #1046 / #312 — paste HTML grande no TipTap (Beehiiv)

**Data**: 2026-05-09  
**Contexto**: PR #1045 mergeou wiring HMAC pro Worker, mas `publish-newsletter` agent não rodou em 12 dias por bloqueio de paste de HTML grande no TipTap. Spike testou alternativas.

## Achados (TL;DR)

✅ **`ClipboardEvent` paste FUNCIONA** pra HTML estruturado grande.  
❌ **Merge tags `{{poll_x_url}}` são strippados** — TipTap normaliza `<a href>` e tags Liquid não passam.  
✅ **`editor.commands.insertContent({type: 'htmlSnippet', ...})`** preserva HTML raw (incluindo merge tags) — mas tem limite prático de tamanho via tool input (~10KB JS arg).

## Métodos testados

### 1. `editor.commands.setContent()` direto

**Abordagem**: substituir doc inteiro com HTML em template literal grande.  
**Resultado**: ❌ tool input limit ~10KB JS arg trunca silenciosamente.

### 2. Chunked `editor.commands.insertContent()`

**Abordagem**: 4-6 chunks de 7-8KB acumulados em `window.__chunks`, depois `setContent` final.  
**Resultado**: ✅ funciona tecnicamente, ❌ custa 7-10K tokens por chunk = ~50K tokens só pra paste 28KB.

### 3. HTTP server local + browser fetch

**Abordagem**: `python -m http.server` + `fetch('http://localhost:8765/...')` no Chrome.  
**Resultado**: ❌ Beehiiv CSP bloqueia cross-origin fetch a localhost.

### 4. `ClipboardEvent` paste com `DataTransfer` ⭐ (NOVO)

**Abordagem**:
```js
const editorEl = document.querySelector('[contenteditable="true"]');
editorEl.focus();
const dt = new DataTransfer();
dt.setData('text/html', html);
const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
editorEl.dispatchEvent(evt);
```

**Resultado** (testado com HTML 6KB estruturado: table + image + buttons):

| Métrica | Valor |
|---|---|
| `dispatched_returned` | `false` (= preventDefault chamado, TipTap handled) |
| Block types após paste | 35 paragraphs, 3 tables, 34 tableCells, 1 imageBlock, 1 heading |
| Texto "Votar" preservado | ✅ |
| `<img>` virou `imageBlock` | ✅ |
| Sync Y.js | ✅ "Synced" |
| Merge tags `{{poll_a_url}}` preservadas | ❌ **strippadas** |

## Causa raiz: merge tags strippados

TipTap paste handler converte HTML → ProseMirror nodes. Pra `<a href="...">`, valida URL e cria link node. `{{poll_a_url}}` não é URL válida → link descartado, texto vira plain.

**Confirma:** o text do botão "Votar A" aparece no doc, mas perde o link.

## Solução proposta — paste híbrido

Refatorar `render-newsletter-html.ts` pra produzir 2 outputs:

1. **`newsletter-body.html`** — corpo principal (3 destaques + LANÇAMENTOS + PESQUISA + OUTRAS NOTÍCIAS + SORTEIO + PARA ENCERRAR), sem É IA?. Paste via ClipboardEvent (rápido, parseado em nodes nativos, ~25KB).

2. **`newsletter-eia-section.html`** — seção É IA? standalone com botões A/B + merge tags. Paste via `editor.commands.insertContent({type: 'htmlSnippet', ...})` (preserva merge tags, ~3KB cabe em 1 JS call).

`publish-newsletter` agent flow novo:

```ts
// Stage 4 — paste body
const bodyHtml = await fs.readFile(`${editionDir}/_internal/newsletter-body.html`);
clipboardEventPaste(editor, bodyHtml);

// Insert É IA? as raw HTML block (preserves {{poll_x_url}})
const eiaHtml = await fs.readFile(`${editionDir}/_internal/newsletter-eia-section.html`);
editor.commands.insertContent({
  type: 'htmlSnippet',
  attrs: { language: 'html' },
  content: [{ type: 'text', text: eiaHtml }],
});
```

## Estimativa implementação

- Refator renderer (`render-newsletter-html.ts`): ~1h
- Update `publish-newsletter` agent prompt: ~30min
- Tests (split outputs, paste integration): ~1h
- Validação manual ponta-a-ponta: ~30min

**Total**: ~3h

## Trade-offs

**Pró**:
- Destrava `/diaria-4-publicar` (agent flow funciona end-to-end)
- Elimina necessidade de `prep-manual-publish.ts` no fluxo agent (mas script continua útil pra publish manual ad-hoc)
- Editor não precisa lembrar de paste manual

**Contra**:
- Renderer fica mais complexo (2 outputs em vez de 1)
- Body via ClipboardEvent perde controle exato sobre HTML rendered (TipTap normaliza)
- Imagens viram `imageBlock` Beehiiv (ok pra preview, mas perde controle visual fino)

## Recomendação

**Implementar** após validar 1 ponto adicional: `editor.commands.insertContent` com htmlSnippet de ~3KB de uma vez (já provei pra ~1.5KB no PR #1045). Se cabe em 1 JS call (~10KB limit), solução híbrida viável sem chunked paste.

Issue de tracking: #1046 (e #312 como predecessor).

---

## Implementação (2026-05-09)

**Status**: renderer split implementado + agent prompt atualizado, **falta validação end-to-end** numa edição real.

**Mudanças em código:**

1. **`scripts/render-newsletter-html.ts`** — flag `--split` produz 2 arquivos em `_internal/`:
   - `newsletter-body.html` (~12KB testado em 260508): destaques + LANÇAMENTOS + PESQUISA + OUTRAS NOTÍCIAS + SORTEIO + PARA ENCERRAR. Sem È IA?, sem merge tags.
   - `newsletter-eia.html` (~5KB): È IA? standalone com `{{poll_a_url}}/{{poll_b_url}}` preservados, wrapped em outer table própria.
   - Funções exportadas: `renderHTML(content, { excludeEia })` + `renderEiaStandalone(content)`. 8 tests novos cobrem split sem perda de conteúdo, tamanhos dentro dos limites, eia null quando não configurada.
   - Modo legado (`--out --format html`) **inalterado** pra backward-compat com `prep-manual-publish.ts` (paste manual editor segue usando `newsletter-final.html` único).

2. **`.claude/agents/publish-newsletter.md`** — passo 5.2 substituído com paste híbrido em 2 fases:
   - Fase 1: `ClipboardEvent` paste do body via `mcp__claude-in-chrome__javascript_tool`. Fallback chunked acumulator se body >10KB JS-encoded.
   - Fase 2: `editor.commands.insertContent({type: 'htmlSnippet', ...})` da È IA?. Fallback `editor.chain().insertContent(html, parseOptions...)`.
   - Pós-paste verifica que `{{poll_a_url}}` e `{{poll_b_url}}` aparecem no `editor.getHTML()`. Re-tenta 1× se stripped.

**Falta:**

- Validação manual ponta-a-ponta numa edição real (executar agent contra Beehiiv staging). Sem isso, paste híbrido em produção é primeiro contato.
- Confirmar nome global da TipTap editor instance (`window.editor` vs `window.__tiptapEditor` vs outro). Spike usou `editor.commands` direto na inspeção mas não documentou onde encontrá-lo.
- Confirmar limite real de `htmlSnippet` content text (testado ~1.5KB no #1045; precisa testar 5KB do È IA?).

---

## Validação live em #1054 (2026-05-10)

Em `/diaria-test 260510 --with-publish`, validei manualmente via Chrome MCP. Findings que invalidam parte do design original:

### ❌ `window.editor` global NÃO existe

`window.editor`, `window.tiptapEditor`, `window.__tiptapEditor` — todos `undefined`. React fiber traversal não acha editor instance via memoizedProps/stateNode. Beehiiv encapsula o editor em React state inacessível externamente.

**Impacto**: caminho `editor.commands.insertContent({type: 'htmlSnippet', ...})` proposto na "Solução paste híbrido" **não funciona**. Precisa usar ClipboardEvent paste sintético em vez disso.

### ✅ Template "HTML" é o caminho correto (não "Default")

Beehiiv tem template chamado **"HTML"** na template-library que cria post com `node-htmlSnippet` pré-instantiado vazio. Template "Default" não tem isso — tentar localizar Custom HTML block via accessibility API falha (TipTap renderiza em Shadow DOM).

Workflow validado:
1. Navegar pra `https://app.beehiiv.com/posts/template-library?tab=my_templates`
2. Clicar overlay button do card "HTML"
3. Post criado em `/posts/{uuid}/edit` com `<div class="node-htmlSnippet is-empty">` pronto

### ✅ TipTap node `htmlSnippet` confirmado em runtime

`document.querySelector('.node-htmlSnippet')` retorna o nó. Schema interno tem o tipo. Mas inserção via `editor.commands.insertContent({type:'htmlSnippet',...})` impossível sem o `editor` global.

### ✅ Cursor positioning via Selection API funciona

```js
const pre = document.querySelector('.node-htmlSnippet pre');
const code = pre.querySelector('code');
const range = document.createRange();
range.selectNodeContents(code);
range.collapse(true);
window.getSelection().removeAllRanges();
window.getSelection().addRange(range);
```

### 🔴 JS arg limit ~7KB (real, não ~10KB)

Tool input `javascript_tool` aceita ~7KB de string literal antes de truncar. Newsletter completa (16KB) precisa de **4 chunks** via base64 + accumulator pattern. Custo realista: ~30K tokens só pra paste de 1 newsletter.

### Novo path forward proposto

1. **Cloudflare Worker host pra HTML render** — Worker serve `_internal/newsletter-final.html` em URL pública (HTTPS). Browser faz `fetch(workerUrl)` em 1 JS call. Custo: ~5K tokens em vez de 30K.
2. **localStorage cross-tab** — fragil, requer 2 abas no mesmo origin.
3. **Aceitar chunked + custo de tokens** — funciona, valida design, mas inviável em produção diária.

Issue #1054 mantém aberta pra implementação do (1) Worker host.

---

## Validação live #2 (2026-05-10) — paste DENTRO do htmlSnippet preserva merge tags ⭐

**Insight crítico que reframe todo o spike**: a hipótese original era que TipTap normalizaria `<a href>` e mataria `{{poll_a_url}}` em qualquer paste. Verdade pra paste no editor principal. Mas paste **DENTRO do `node-htmlSnippet` block** preserva merge tags porque o htmlSnippet é raw HTML por design (não parseia hrefs).

### Test concreto

```js
// Cursor positioned inside .node-htmlSnippet pre/code via Selection API
const testHtml = '<a href="{{poll_a_url}}" style="...">Votar A</a>';
const dt = new DataTransfer();
dt.setData('text/html', testHtml);
const evt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
editorEl.dispatchEvent(evt);
```

Resultado: `code.textContent.includes('{{poll_a_url}}') === true`. Merge tag preservada.

### Implicação no design

- ❌ Não precisa split body/eia (#1046 design original)
- ❌ Não precisa `editor.commands.insertContent` (não existe + não funciona)
- ✅ Precisa só: cursor positioning via Selection API + ClipboardEvent paste com chunked accumulator
- ✅ Newsletter completa (~16KB) cabe num único htmlSnippet

### Custo final

- **Sem Worker host**: 4 chunks × ~7K tokens = ~30K tokens/edição (~$0.09)
- **Com Worker host**: 1 fetch + 1 paste = ~5K tokens/edição (~$0.015)

Diferença ~$28/ano. Worker host é otimização, não bloqueador.

`.claude/agents/publish-newsletter.md` atualizado com fluxo paste-into-htmlSnippet em commit pós-validação.

---

## Validação live #3 (2026-05-10) — `execCommand('insertText')` é o método canônico

**Reframe novamente**: ClipboardEvent dispatch falha em produção. `document.execCommand('insertText', false, html)` é o único método que funciona consistentemente.

### O que falhou

ClipboardEvent paste com `target = code` (elemento dentro do htmlSnippet):
```
{ defaultPrevented: false, codeNowLength: 0, dispatched: true }
```
Evento foi disparado mas TipTap/ProseMirror não interceptou. Bubbling pra `.tiptap.ProseMirror` também não acionou handler. `defaultPrevented: false` confirma que ProseMirror nunca processou.

### O que funcionou

```js
// 1. Localizar inner editable DIV dentro de code (não code direto)
const node = document.querySelector('.node-htmlSnippet');
const pre = node.querySelector('pre');
const code = pre.querySelector('code');
const innerDiv = code.querySelector('div');

// 2. Click + Selection API + focus editor
pre.click();
const range = document.createRange();
range.selectNodeContents(innerDiv);
range.collapse(true);
const sel = window.getSelection();
sel.removeAllRanges();
sel.addRange(range);
document.querySelector('.tiptap.ProseMirror').focus();

// 3. execCommand insertText — passa o HTML como texto literal
document.execCommand('insertText', false, html);
```

Resultado em paste de 16384 bytes:

| Métrica | Valor |
|---|---|
| `execCommand` returned | `true` |
| `code.textContent.length` | 16213 (99% — diff é normalização de whitespace) |
| `{{poll_a_url}}` preservado | ✅ |
| `{{poll_b_url}}` preservado | ✅ |
| `{{IMG:01-eia-A.jpg}}` preservado | ✅ |
| `{{IMG:01-eia-B.jpg}}` preservado | ✅ |
| 13 markers de conteúdo (URLs, secções, créditos) | ✅ todos |
| `is-empty` class removida | ✅ (ProseMirror sincronizou state) |

### Por que `execCommand` funciona e `ClipboardEvent` não

`execCommand('insertText')` usa o caminho de input nativo do contenteditable, que TipTap/ProseMirror escutam via `beforeinput`/`input` events. ClipboardEvent sintético não passa pela mesma pipeline porque navegadores modernos isolam clipboard events do editor pipeline (anti-XSS).

### Implicação no design

- ✅ Método canônico: `execCommand('insertText', false, html)` após cursor positioning + focus
- ❌ ClipboardEvent (mesmo com DataTransfer) não funciona consistentemente em produção
- ⚠️ `execCommand` é deprecated mas ainda suportado; alternativa moderna seria `InputEvent` sintético com `inputType: 'insertText'` mas requer mais boilerplate e não foi testado

Próximo passo: atualizar `.claude/agents/publish-newsletter.md` substituindo ClipboardEvent por execCommand no step 5.2. Ou — dado que `javascript_tool` só está disponível ao top-level (não a subagentes), refatorar o agent pra playbook executado pelo orchestrator.

---

## Validação E2E #4 (2026-05-10) — `editor.commands.insertContent({type:'text'})` é o método canônico ⭐⭐⭐

**Validação #3 estava parcialmente errada.** O E2E completo (paste + autosave + reload) revelou que `execCommand('insertText')` atualiza apenas o DOM, NÃO o ProseMirror state. Como o autosave Beehiiv serializa do `editor.state.doc`, o conteúdo via execCommand **não persiste** após reload.

### Reprodução do bug

1. Paste 16KB via execCommand → `code.textContent.length === 16213` ✅
2. Wait 5s → autosave fires
3. Reload page → `editor.state.doc.content.size === 4`, apenas 78 chars persistiram (estado pré-paste)

### Métodos descartados

| Método | Status | Razão |
|---|---|---|
| `ClipboardEvent` synthetic dispatch | ❌ | `defaultPrevented: false`, content nem entra no DOM |
| `document.execCommand('insertText')` | ❌ | DOM atualizado mas ProseMirror state não — autosave perde conteúdo |
| `editor.commands.insertContent(htmlString)` | ❌ | TipTap parseia como HTML, falha em `RangeError: Invalid content for node tableCell` |
| `navigator.clipboard.writeText` | ❌ | "Document not focused" via Chrome MCP |

### Método canônico

```js
const editor = document.querySelector('.tiptap.ProseMirror').editor;
// Posicionar cursor dentro do htmlSnippet
let pos;
editor.state.doc.descendants((node, p) => {
  if (node.type.name === 'htmlSnippet') { pos = p; return false; }
});
const tr = editor.state.tr;
tr.setSelection(editor.state.selection.constructor.near(editor.state.doc.resolve(pos + 1)));
editor.view.dispatch(tr);
// Insert TEXT NODE (não HTML parseado)
editor.commands.insertContent({ type: 'text', text: html });
```

### Insights chave

1. **TipTap editor é acessível em `document.querySelector('.tiptap.ProseMirror').editor`** — não em `window.editor` (esse não existe). Spike doc anterior afirmava que era impossível.
2. **htmlSnippet armazena raw HTML como text node** — passing `{type:'text', text:html}` evita parsing/validação de schema.
3. **DOM ≠ ProseMirror state** — autosave serializa state, não DOM. Validar via `editor.getJSON()`, não `code.textContent`.
4. **`is-empty` class é cosmético** — não correlaciona com state real. Use `editor.state.doc.content.size` e `editor.getJSON()` pra validar.

### Validação concreta E2E

- Pré-paste: `docSize: 4` (htmlSnippet vazio + paragraph)
- Pós-paste: `docSize: 16500`, `jsonLen: 17422`
- Wait 8s
- **Reload page** + getJSON: `docSize: 16500`, `jsonLen: 17422` ✅
- Markers persistidos: `{{poll_a_url}}`, `{{poll_b_url}}`, image URLs (14e0Acht..., 1NHj3Mlb...), domínios editoriais

Confirma E2E: paste persiste após reload. Implementação atualizada em PR #1065.
