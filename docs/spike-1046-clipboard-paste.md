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
