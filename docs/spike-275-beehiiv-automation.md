# Spike #275 — Beehiiv automation: investigação Phase 1

**Status:** investigação completa, plano pronto pra Phase 2 (implementação).
**Issue:** [#275](https://github.com/vjpixel/diaria-studio/issues/275)
**Sessão:** 2026-04-28 (live exploration via Claude in Chrome).

## Achado-chave: NÃO é iframe

A premissa do issue body — *"editor Beehiiv usa iframe não acessível via accessibility tree sem JS"* — está **incorreta**.

O editor Beehiiv usa **TipTap (ProseMirror)** renderizado diretamente no DOM principal. Os 7 iframes presentes na página são todos analytics/tracking (Twitter, Stripe, Google Tag Manager) — nenhum é o editor.

Isso simplifica drasticamente a automação: JS injection via `mcp__claude-in-chrome__javascript_tool` opera direto na DOM.

## Selectors mapeados (draft `47a4346e-019b-48a1-b859-9ce57f2fe7bd`)

### Header
| Elemento | Selector | Notas |
|---|---|---|
| Title | `textarea.editor-title-textarea` | placeholder: "Add a title" |
| Subtitle | `textarea.editor-subtitle-textarea` | placeholder: "Add a subtitle" |
| Add thumbnail | `button` com `textContent === 'Add thumbnail'` | Trigger pra file picker |
| File input (thumbnail) | `input[type="file"][accept=".jpg,.jpeg,.png,.webp,.gif"]` | Hidden (`w-0 h-0`), 1 instance |

### Body
| Elemento | Selector | Notas |
|---|---|---|
| Editor area | `div.tiptap.ProseMirror` | contenteditable, 800×872 px |
| Stato/sync | `*` com `textContent === 'Synced'` ou `'draft'` | Indicador de save |

### Top bar
| Elemento | Selector | Notas |
|---|---|---|
| Tab Compose | `button` com `textContent === 'Compose'` | Default ativo |
| Tab Audience / Email / Web / Review | idem | Outras seções do post |
| Next | `button` com `textContent === 'Next'` | Avança pro Audience step |
| Preview | `button` com `textContent === 'Preview'` | Abre painel preview |

### Test email panel (collapsed por default)
- 2 botões "Send test email" no DOM (zero size — accordion fechado).
- Pre-fills: `vjpixel@gmail.com`, `lunaapcunha@gmail.com`.
- Trigger pra abrir: ainda **não confirmado** — provável que seja "Preview" ou um chevron na sidebar. Phase 2 valida.

## Teste de viabilidade (live, draft real)

Executei paste simulado de HTML no editor TipTap:

```js
const editor = document.querySelector('.tiptap.ProseMirror');
editor.focus();

const dt = new DataTransfer();
dt.setData('text/html', '<p><strong>SPIKE_TEST</strong> — investigação</p>');
dt.setData('text/plain', 'SPIKE_TEST — investigação');

const pasteEvent = new ClipboardEvent('paste', {
  clipboardData: dt,
  bubbles: true,
  cancelable: true,
});
editor.dispatchEvent(pasteEvent);
```

**Resultado:** ✅ HTML inserido + formatação preservada (`<strong>` mantido). TipTap adiciona `data-id` no `<p>` (tracking interno) mas estrutura semântica intacta.

## Plano de implementação (Phase 2)

### 1. Custom HTML body insertion

**Estratégia:** paste simulado via `ClipboardEvent` (validado).

```ts
async function insertHTMLBody(tabId: number, htmlPath: string) {
  const html = readFileSync(htmlPath, 'utf8');
  await javascriptTool(tabId, `
    const editor = document.querySelector('.tiptap.ProseMirror');
    editor.focus();
    const dt = new DataTransfer();
    dt.setData('text/html', ${JSON.stringify(html)});
    dt.setData('text/plain', editor.textContent || '');
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  `);
}
```

**Riscos a validar:**
- HTML pré-renderizado é `~50KB` com 5 imagens via Drive CDN URLs. Paste de string grande ainda funciona? (provável sim, TipTap não tem limite documentado.)
- Imagens via `<img src>` carregam corretamente? (provável sim — preview renderiza no Beehiiv.)
- Sanitização de algum tag específico? (testar `<script>`, `<style>` — Beehiiv pode strippar.)

### 2. Thumbnail upload

**Estratégia:** programmatic file input via `DataTransfer.files`.

```ts
async function uploadThumbnail(tabId: number, imagePath: string) {
  const buf = readFileSync(imagePath);
  const base64 = buf.toString('base64');
  await javascriptTool(tabId, `
    const input = document.querySelector('input[type="file"][accept*=".jpg"]');
    const blob = await fetch('data:image/jpeg;base64,${base64}').then(r => r.blob());
    const file = new File([blob], '04-d1-2x1.jpg', { type: 'image/jpeg' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  `);
}
```

**Riscos:**
- File input usa `webkitdirectory`? Não — accept regular `.jpg,.jpeg,.png,.webp,.gif`.
- Beehiiv pode chamar `addEventListener('drop', ...)` em vez de `change`? Validar.
- Beehiiv pode validar dimensions (mín 1000×500 etc) — `04-d1-2x1.jpg` é 1600×800, deve passar.

### 3. Send test email

**Estratégia:** click trigger pra expandir accordion → click "Send test email" no painel.

**Pendente:** identificar o trigger exato. Hipóteses:
- `button[aria-label="Email"]` na sidebar (tab "Email" no top — provavelmente abre Email step que tem o painel).
- Click "Preview" e o painel de teste vem junto.
- Chevron icon adjacente ao painel collapsed.

**Phase 2:** abrir devtools, clicar manualmente no que abre o painel, capturar selector.

### 4. Poll Trivia

**Estratégia:** slash menu (`/`) no editor → buscar "Poll" → click → preencher campos.

**Pendente:** confirmar que o slash menu existe no TipTap do Beehiiv (alguns templates podem ter customização que substitui isso).

**Plano detalhado:**
1. Posicionar cursor no fim do editor (após bloco É IA?).
2. Disparar keypress `/` → menu abre.
3. Tipar "Poll" → filtra opções.
4. Click "Poll" ou "Poll Trivia" no menu.
5. Preencher question = `Qual delas é IA?`.
6. Adicionar opções A e B.
7. Marcar A ou B como correta (do `_internal/01-eai-meta.json` `ai_side`).
8. Salvar/fechar bloco.

**Risco:** UI do Poll pode ser modal complexo, exigindo `read_page` de cada step.

## Loop de teste pra Phase 2

Cada iteração precisa de você no loop:

1. Crio um draft de teste (`Start writing` → `Blank draft`).
2. Rodo automation pra 1 dos 4 passos.
3. Você revisa visualmente no celular/desktop.
4. Confirma OK ou reporta bug.
5. Itero.

Estimativa: 4-5h pra cobrir os 4 passos com confidence.

## Limpeza pendente

**Você precisa deletar este draft de teste** quando terminarmos Phase 1:
- URL: `https://app.beehiiv.com/posts/47a4346e-019b-48a1-b859-9ce57f2fe7bd/edit`
- Conteúdo: `<p><strong>SPIKE_TEST_DELETE_ME</strong> — Phase 1 investigação #275</p>`
- Localização: Posts list → Drafts → procurar "New post" recente.

## Próximos passos

1. **Revisar este doc.** Confirma que o approach faz sentido.
2. **Decidir se Phase 2 vale agora ou depois.** Estimativa 4-5h interativo.
3. **Se sim:** crio PR fresh com:
   - `scripts/publish-newsletter-automation.ts` ou helpers em `.claude/agents/publish-newsletter.md`
   - Cobertura dos 4 passos.
   - Smoke test com edição real.

## Referencias

- Issue #275 (root).
- Issue #194 (LinkedIn JS injection — pattern similar usado pra contenteditable).
- `context/publishers/beehiiv.md` — playbook editorial atual.
- TipTap docs: https://tiptap.dev/docs/editor/api/commands (referência só — não usaremos API direto, paste event é mais robusto).
