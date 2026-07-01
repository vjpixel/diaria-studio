/**
 * beehiiv-cover-upload.ts (#1416, #1801, #2341)
 *
 * Helper pra setar a cover image (thumbnail) do post no Beehiiv.
 *
 * ✅ MÉTODO PRIMÁRIO (#1801 / #1500 / #2341): `buildCoverDataTransferJs` —
 *    DataTransfer no `input[type=file]` do editor + `.click()` na img subida
 *    (aplica auto). Validado ao vivo em 260602/260604.
 *    É o que se deve usar TANTO para cover nova QUANTO para REPLACE de cover
 *    existente (#2341). Não requer remover a cover antes — #1500 substitui
 *    diretamente. O 2-step remove (buildCoverReplaceStep1 + Step2) só como
 *    fallback se #1500 retornar applied:false (input[type=file] ausente).
 *
 *    INVARIANTE (#2341): NUNCA escrever cover_status:stale_pending_manual ou
 *    cover_replace_failed sem ter chamado buildCoverDataTransferJs e recebido
 *    applied:false. Ver beehiiv-playbook §4b para o fluxo completo.
 *
 * ✅ VERIFICAÇÃO VIA API (#2341): `get_post.thumbnail_url` (READ-only, não
 *    plan-gated) muda a cada replace — útil pra confirmar persistência no
 *    backend após apply via DOM. Comparar thumbnail_url antes e depois.
 *
 * ⚠️ #1705 / #2340: o campo `thumbnail_image_url` em `edit_post`/`save_post`
 *    existe no schema MCP mas está gated por plano pago (plano atual = Launch/
 *    free). Por enquanto, cover só pode ser SETADA via Chrome/#1500. Ver #2340.
 *
 * ⚠️ DEPRECATED (#1705): o fluxo "Upload from URL" abaixo (`buildCoverUploadJs`
 *    + `buildCoverApplyLocateJs`) sobe pro media library mas NÃO aplica como
 *    thumbnail na UI atual (clicar o card abre preview). Mantido só como
 *    fallback histórico — não usar como primário. Ver beehiiv-playbook §4b.
 *
 * Caminho legado "Upload from URL", descoberto em 260520 (issue #1416):
 *   1. Click button "Add thumbnail" (top do post editor)
 *   2. Click "Use from library" (segundo botão no overlay)
 *   3. Click tab "Upload" (top toolbar do media library)
 *   4. Click "Upload from URL" (subdropdown do Upload)
 *   5. Set value de `textarea[name="media-url"]` via React-aware setter
 *   6. Click "Upload N media" button
 *   7. Aguardar upload (~3-5s) — Beehiiv baixa + armazena no S3 próprio
 *   8. Click no card da imagem recém-uploadada no media library
 *
 * Caller deve:
 *   - Hospedar a imagem publicamente acessível (Cloudflare Worker KV ou Drive)
 */

/**
 * Gera JS string async pra dispatch via `javascript_tool`. Resolve com:
 *   { thumbnailSrc: string | null, steps: string[], error?: string }
 *
 * `steps` é trail de debug (qual botão clicou em cada step). Útil pra
 * triage quando upload falha mid-flight.
 *
 * @param imageUrl URL pública da imagem (deve resolver fora do Beehiiv —
 *                 Cloudflare Worker /img/ por convenção)
 */
import { readFileSync } from "node:fs";
import { buildLocateRectJs } from "./beehiiv-real-click.ts";

/**
 * #2714 item 2: guard de blob compartilhado entre `buildCoverDataTransferJs`
 * (upload direto/#1500) e `buildCoverReplaceStep2_UploadJs` (Etapa 2 do replace
 * em 2 chamadas/#2283). Antes deste extract, o mesmo bloco `if (blob.size < 5000
 * ...)` existia LITERALMENTE duplicado nas duas funções — risco de as duas cópias
 * divergirem numa mudança futura do guard (ex: ajustar o threshold, adicionar
 * outro MIME check) e só uma das duas ser atualizada.
 *
 * Assume que a variável `blob` (resultado de `await res.blob()`) e o array
 * `steps` já estão no escopo onde este trecho é interpolado — não é uma função
 * JS standalone, é um fragmento de código pra colar dentro do IIFE async gerado
 * por cada builder (via template literal `${COVER_BLOB_GUARD_JS}`).
 *
 * #2680: rejeita blob inválido antes de subir lixo silenciosamente. URL canônica
 * (sem md5 hash) retorna 9 bytes text/plain 'Not Found' no KV. Usar SEMPRE
 * `images.cover.url` de `06-public-images.json` (URL versionada com md5).
 * `size < 5000` é o guard primário (pega o 'Not Found' de 9 bytes); o check de
 * MIME só rejeita quando `type` ESTÁ presente e não é `image/*` — assim um JPEG
 * válido servido sem Content-Type (`blob.type === ''`) não é rejeitado por engano.
 */
const COVER_BLOB_GUARD_JS = `
      if (blob.size < 5000 || (blob.type && !blob.type.startsWith('image/'))) {
        return { error: 'cover blob inválido (#2680): size=' + blob.size + ' bytes, type="' + blob.type + '" — use images.cover.url de 06-public-images.json (URL md5-versionada), não a URL canônica sem hash', steps };
      }`;

export function buildCoverUploadJs(imageUrl: string): string {
  return `
    (async () => {
      const steps = [];
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const buttons = () =>
        Array.from(document.querySelectorAll('button, [role="menuitem"]')).filter(b => b.offsetParent !== null);

      // Step 1-2: open media library
      let useLib = buttons().find(b => b.textContent?.trim() === 'Use from library');
      if (!useLib) {
        const addThumb = buttons().find(b => /add thumbnail/i.test(b.textContent || ''));
        if (!addThumb) return { error: 'Add thumbnail button not found', steps };
        addThumb.click();
        steps.push('clicked: Add thumbnail');
        await sleep(1500);
        useLib = buttons().find(b => b.textContent?.trim() === 'Use from library');
      }
      if (!useLib) return { error: 'Use from library button not found', steps };
      useLib.click();
      steps.push('clicked: Use from library');
      await sleep(2500);

      // Step 3-4: open Upload from URL
      const uploadBtn = buttons().find(b => b.textContent?.trim() === 'Upload');
      if (!uploadBtn) return { error: 'Upload tab not found', steps };
      uploadBtn.click();
      steps.push('clicked: Upload tab');
      await sleep(1500);

      const fromUrlBtn = buttons().find(b => /upload from url/i.test(b.textContent || ''));
      if (!fromUrlBtn) return { error: 'Upload from URL button not found', steps };
      fromUrlBtn.click();
      steps.push('clicked: Upload from URL');
      await sleep(2500);

      // Step 5-6: paste URL in textarea via React-aware setter
      const ta = document.querySelector('textarea[name="media-url"]');
      if (!ta) return { error: 'media-url textarea not found', steps };
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, ${JSON.stringify(imageUrl)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      steps.push('set: media-url value');
      await sleep(1000);

      // Step 7: submit
      const submitBtn = buttons().find(b => /^upload \\d+ media/i.test(b.textContent?.trim() || ''));
      if (!submitBtn) return { error: 'Upload N media button not found', steps };
      submitBtn.click();
      steps.push('clicked: Upload N media');
      await sleep(6000);

      // Step 8 (#1705): confirmar que a imagem chegou no library. NÃO clicar no
      // card aqui — APLICAR como thumbnail é clique REAL separado
      // (buildCoverApplyLocateJs). O sucesso do *upload* = imagem no library;
      // aplicar/confirmar é o passo seguinte (buildCoverVerifyJs).
      const targetImg = Array.from(document.querySelectorAll('img')).find(i =>
        i.offsetParent !== null &&
        /uploads.asset.file/i.test(i.src) &&
        i.naturalWidth >= 400 &&
        !(/static_assets|publication.logo/i.test(i.src))
      );
      if (!targetImg) return { error: 'uploaded image card not found in library', steps };
      steps.push('found: uploaded card in library');
      // thumbnailSrc só fica não-null se o Beehiiv auto-aplicar (raro) — informativo.
      const thumbnailImg = Array.from(document.querySelectorAll('img'))
        .find(i => /beehiiv-images-production.*uploads/i.test(i.src));
      return {
        librarySrc: targetImg.src,
        thumbnailSrc: thumbnailImg?.src ?? null,
        steps,
      };
    })()
  `;
}

/**
 * Pure: classifica o resultado do dispatch. Sucesso = thumbnailSrc não-null
 * E contém pattern beehiiv-images-production (Beehiiv copiou pro S3 deles).
 *
 * Caller dispatchou o JS e recebeu `{ thumbnailSrc?, steps?, error? }`.
 */
export function classifyUploadResult(
  result:
    | { librarySrc?: string | null; thumbnailSrc?: string | null; steps?: string[]; error?: string }
    | null
    | undefined,
):
  | { ok: true; libraryUrl: string }
  | { ok: false; reason: string; lastStep?: string } {
  // #1640: o `javascript_tool` do claude-in-chrome às vezes retorna vazio/null
  // (sintoma de disconnect intermitente — "empty returns after cover upload" na
  // 260601). Sem este guard, `result.error` lançaria TypeError e derrubaria o
  // stage em vez de o retry loop (§4b) tratar como falha. Tratamos como falha
  // retryable; se persistir, não bloqueia (cover é cosmético).
  if (!result || typeof result !== "object") {
    return {
      ok: false,
      reason:
        "resultado vazio/null do MCP — provável disconnect do claude-in-chrome (#1640); retry",
    };
  }
  if (result.error) {
    return {
      ok: false,
      reason: result.error,
      lastStep: result.steps?.[result.steps.length - 1],
    };
  }
  // #1705: sucesso do UPLOAD = imagem chegou no library (`librarySrc`). APLICAR
  // como thumbnail é passo separado (clique real) — não gatear o upload nisso,
  // senão o loop gastava os 3 retries toda vez antes do apply. `thumbnailSrc`
  // (auto-apply do Beehiiv) é aceito como fallback de back-compat.
  const inLibrary = result.librarySrc || result.thumbnailSrc;
  if (!inLibrary) {
    return {
      ok: false,
      reason: "imagem não apareceu no library pós-upload — UI flow não completou",
      lastStep: result.steps?.[result.steps.length - 1],
    };
  }
  return { ok: true, libraryUrl: inLibrary };
}

/**
 * #1705: localiza o card da imagem recém-uploadada no media library pra clique
 * REAL (computer.left_click). O `.click()` sintético do step 8 do
 * `buildCoverUploadJs` virou no-op na UI atual (abre preview, não aplica como
 * thumbnail). O upload pro library funciona; aplicar precisa de clique real.
 * Caller: dispatch este JS, `resolveClickPoint`, clicar de verdade, depois
 * confirmar com `buildCoverVerifyJs` + `classifyCoverVerify`.
 */
export function buildCoverApplyLocateJs(): string {
  return buildLocateRectJs(
    "uploaded_cover_card",
    `
      const img = Array.from(document.querySelectorAll('img')).find(i =>
        i.offsetParent !== null && /uploads.asset.file/i.test(i.src) &&
        i.naturalWidth >= 400 && !(/static_assets|publication.logo/i.test(i.src)));
      if (!img) return null;
      let t = img;
      for (let i = 0; i < 4 && t.parentElement; i++) {
        if (t.tagName === 'BUTTON' || t.getAttribute('role') === 'button') break;
        t = t.parentElement;
      }
      return t;
    `,
  );
}

/**
 * #1705: verifica via DOM se a capa foi APLICADA — sinal confiável, já que o
 * MCP `get_post` não expõe `web_thumbnail_url`. Sucesso = botão "Add thumbnail"
 * sumiu E há img de thumbnail (beehiiv-images-production). Gera JS pra
 * `javascript_tool`; classificar com `classifyCoverVerify`.
 */
export function buildCoverVerifyJs(): string {
  return `
    (() => {
      const visible = (el) => el && el.offsetParent !== null;
      const addThumb = Array.from(document.querySelectorAll('button'))
        .find(b => visible(b) && /add thumbnail/i.test(b.textContent || ''));
      const thumb = Array.from(document.querySelectorAll('img'))
        .find(i => visible(i) && /beehiiv-images-production.*uploads/i.test(i.src));
      return { addThumbnailPresent: !!addThumb, thumbnailSrc: thumb ? thumb.src : null };
    })()
  `;
}

export interface CoverVerifyRaw {
  addThumbnailPresent?: boolean;
  thumbnailSrc?: string | null;
  error?: string;
}

/**
 * Pure: capa aplicada = botão "Add thumbnail" AUSENTE E thumbnail presente.
 * Resposta vazia/null do `javascript_tool` (#1640) → não-aplicada (não declarar
 * sucesso silencioso, #1705). Caller emite "⚠️ cover NÃO confirmada" se false.
 */
export function classifyCoverVerify(
  r: CoverVerifyRaw | null | undefined,
): { applied: true; thumbnailUrl: string } | { applied: false; reason: string } {
  if (!r || typeof r !== "object" || r.error) {
    return { applied: false, reason: r?.error ?? "sem resposta do verify (javascript_tool vazio, #1640)" };
  }
  if (r.addThumbnailPresent) {
    return { applied: false, reason: 'botão "Add thumbnail" ainda presente — capa NÃO aplicada' };
  }
  if (!r.thumbnailSrc) {
    return { applied: false, reason: "sem imagem de thumbnail no editor" };
  }
  return { applied: true, thumbnailUrl: r.thumbnailSrc };
}

/**
 * #1801 / #1500 / #2341: método PRIMÁRIO de cover — DataTransfer no
 * `input[type=file]`. **PRIMÁRIO TANTO PARA COVER NOVA QUANTO PARA REPLACE.**
 *
 * Substitui o fluxo "Upload from URL" (#1416/#1705), que sobe pro library mas
 * NÃO aplica como thumbnail na UI atual (clicar o card abre preview). Validado
 * ao vivo em 260602/260604: o `.click()` na img recém-subida aqui APLICA
 * automático (sem botão Insert), porque o upload veio do próprio input do
 * editor (user-activation context), não do media-picker do workspace.
 *
 * Para replace (#2341): não é necessário remover a cover existente antes de
 * chamar buildCoverDataTransferJs — o DataTransfer substitui diretamente. O
 * 2-step remove (buildCoverReplaceStep1 + Step2) só deve ser usado como
 * fallback se esta função retornar applied:false (input[type=file] ausente).
 *
 * NOTA (#2341): `javascript_tool` pode retornar `{}` para funções async longas.
 * `{}` NÃO significa falha — verificar estado via DOM re-scan ou `get_post`.
 *
 * Fluxo:
 *   1. garantir `input[type=file]` (se ausente, abrir 'Add thumbnail')
 *   2. fetch(imageUrl) → Blob → File → DataTransfer → `input.files` + change
 *   3. aguardar ~5s, clicar na img recém-subida (aplica automático)
 *   4. verificar via DOM: 'Add thumbnail' sumiu + thumbnail beehiiv-images presente
 *
 * Retorna o shape `CoverVerifyRaw` → classificar direto com `classifyCoverVerify`.
 *
 * Verificação adicional via API: `get_post.thumbnail_url` muda em cada replace
 * (campo READ-only disponível no plano free). Comparar antes/depois para
 * confirmar persistência no backend além da verificação DOM.
 *
 * @param imageUrl URL pública da cover (Cloudflare Worker /img/ — precisa CORS *)
 * @param filename nome do File (informativo pro Beehiiv; default 04-d1-2x1.jpg)
 */
export function buildCoverDataTransferJs(
  imageUrl: string,
  filename = "04-d1-2x1.jpg",
): string {
  return `
    (async () => {
      const steps = [];
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const visible = (el) => el && el.offsetParent !== null;
      const buttons = () =>
        Array.from(document.querySelectorAll('button, [role="menuitem"]')).filter(visible);

      // 1) garantir input[type=file] — se ausente, abrir 'Add thumbnail'
      let fileInput = document.querySelector('input[type="file"]');
      if (!fileInput) {
        const addThumb = buttons().find(b => /add thumbnail/i.test(b.textContent || ''));
        if (addThumb) { addThumb.click(); steps.push('clicked: Add thumbnail'); await sleep(1500); }
        fileInput = document.querySelector('input[type="file"]');
      }
      if (!fileInput) return { error: 'input[type=file] não encontrado (nem após Add thumbnail)', steps };

      // 2) fetch da imagem → File → DataTransfer (método #1500)
      let blob;
      try {
        const res = await fetch(${JSON.stringify(imageUrl)});
        if (!res.ok) return { error: 'fetch da cover falhou: HTTP ' + res.status, steps };
        blob = await res.blob();
      } catch (e) {
        return { error: 'fetch da cover lançou (CORS no /img?): ' + (e && e.message), steps };
      }
      // #2680 / #2714 item 2: guard de blob compartilhado — ver COVER_BLOB_GUARD_JS.
      ${COVER_BLOB_GUARD_JS}
      const file = new File([blob], ${JSON.stringify(filename)}, { type: blob.type || 'image/jpeg' });
      const dt = new DataTransfer(); dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      steps.push('dispatched: change via DataTransfer');
      await sleep(5000);

      // 3) clicar na img recém-subida → aplica automático (sem botão Insert)
      const uploaded = Array.from(document.querySelectorAll('img')).find(i =>
        visible(i) &&
        /(media\\.beehiiv|beehiiv-images-production.*uploads)/i.test(i.src) &&
        !(/static_assets|publication.logo/i.test(i.src)));
      if (uploaded) { uploaded.click(); steps.push('clicked: uploaded img (apply)'); await sleep(3000); }
      else steps.push('uploaded img não localizada (pode ter auto-aplicado)');

      // 4) verificar via DOM: 'Add thumbnail' sumiu + thumbnail beehiiv-images presente
      const addThumbAfter = buttons().find(b => /add thumbnail/i.test(b.textContent || ''));
      const thumb = Array.from(document.querySelectorAll('img'))
        .find(i => visible(i) && /beehiiv-images-production.*uploads/i.test(i.src));
      return { addThumbnailPresent: !!addThumbAfter, thumbnailSrc: thumb ? thumb.src : null, steps };
    })()
  `;
}

/**
 * #2283 / §5.1: detecta se o node-htmlSnippet do template já tem conteúdo
 * (isEmpty: false — template salvou edição anterior). Se tiver, limpa via
 * ProseMirror `tr.delete` antes do paste da nova edição.
 *
 * Retorna `{ isEmpty, cleared, docSizeAfter, error? }`.
 *   - `isEmpty: true`  → snippet já estava vazio, nada feito.
 *   - `cleared: true`  → conteúdo stale removido (era isEmpty: false).
 *   - `error`          → editor não encontrado ou outra falha.
 *
 * Caller deve usar via `javascript_tool` ANTES de `buildCoverDataTransferJs`
 * ou do paste do HTML. Não contém sleeps longos — adequado pra chamada única
 * sem risco de CDP timeout.
 */
export function buildSnippetClearJs(): string {
  return `
    (() => {
      const pm = document.querySelector('.tiptap.ProseMirror');
      const editor = pm?.editor;
      if (!editor) return { error: 'editor TipTap não encontrado (.tiptap.ProseMirror)', isEmpty: null, cleared: false };

      // Localizar o node htmlSnippet no doc ProseMirror
      // Guarda no topo: return false poda sub-árvore mas NÃO para iteração de
      // irmãos — sem o guard, 2 nodes htmlSnippet sobrescrevem snippetPos/snippetNode
      // e o ÚLTIMO é limpo, não o PRIMEIRO (#2283 fix #8).
      let snippetPos = null;
      let snippetNode = null;
      editor.state.doc.descendants((node, pos) => {
        if (snippetPos !== null) return false; // já encontrado — parar traversal
        if (node.type.name === 'htmlSnippet') {
          snippetPos = pos;
          snippetNode = node;
          return false;
        }
      });
      if (snippetPos === null || !snippetNode) {
        return { error: 'htmlSnippet não encontrado no doc (template errado?)', isEmpty: null, cleared: false };
      }

      // Checar se vazio via classe CSS is-empty OU content.size === 0
      const snippetEl = document.querySelector('.node-htmlSnippet');
      const cssEmpty = snippetEl?.classList.contains('is-empty') ?? false;
      // content.size == 0 também indica vazio (para o node filho que armazena texto)
      const contentEmpty = snippetNode.content.size === 0;
      const isEmpty = cssEmpty || contentEmpty;

      if (isEmpty) {
        return { isEmpty: true, cleared: false, docSizeAfter: editor.state.doc.content.size };
      }

      // Snippet tem conteúdo stale — limpar via tr.delete sobre o range do node
      // (snippetPos+1 a snippetPos+1+content.size apaga o conteúdo interno)
      const from = snippetPos + 1;
      const to = snippetPos + 1 + snippetNode.content.size;
      const tr = editor.state.tr.delete(from, to);
      editor.view.dispatch(tr);

      return {
        isEmpty: false,
        cleared: true,
        docSizeAfter: editor.state.doc.content.size,
        bytesCleared: to - from,
      };
    })()
  `;
}

/**
 * #2283: Etapa 1 do replace de cover em 2 chamadas separadas — REMOÇÃO da
 * cover existente. Faz hover + localiza remove button via aria-label canonical
 * + clica + aguarda confirmação modal. Máximo ~5s de sleep total (seguro
 * frente ao limite de 45s do CDP).
 *
 * Retorna `{ existingSrc, removed, steps, error? }`.
 *   - `existingSrc`  → URL da cover removida (string vazia se não havia cover).
 *   - `removed: true` → cover removida com sucesso.
 *   - `removed: false` → não havia cover existente (caller pode prosseguir com upload direto).
 *   - `error`  → remove button não encontrado; caller deve abortar ou tratar.
 *
 * @see buildCoverReplaceStep2_UploadJs — Etapa 2: upload da nova cover via DataTransfer.
 * NUNCA combinar as duas etapas num único javascript_tool (total >20s → CDP timeout #2283).
 *
 * Pre-fix (caso 260522): heurística inline procurava remove button via
 * regex `remove|delete|trash|×|x` no aria-label/text. \"x\" casou \"X
 * (previously Twitter)\" no nav tab → clique navegou pra settings em vez
 * de remover cover. Fix: selector específico por aria-label canonical do
 * Beehiiv UI (Remove/Clear thumbnail). Mantido nesta refatoração.
 */
export function buildCoverReplaceStep1_RemoveExistingJs(): string {
  return `
    (async () => {
      const steps = [];
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const buttons = () =>
        Array.from(document.querySelectorAll('button, [role="menuitem"]')).filter(b => b.offsetParent !== null);

      // Step 0: detectar cover existente (Beehiiv S3 src)
      const existing = Array.from(document.querySelectorAll('img'))
        .find(i => i.offsetParent !== null && /beehiiv-images-production.*uploads/i.test(i.src));

      if (!existing) {
        steps.push('no existing cover — skip remove');
        return { existingSrc: '', removed: false, steps };
      }

      // #1457 review fix: capturar existingSrc ANTES do remove (existing.src
      // pode estar stale após detach do DOM)
      const existingSrc = existing.src;
      steps.push('found existing cover: ' + existingSrc.slice(60, 110));

      // #1457 review fix: hover via múltiplos event types — React onMouseEnter
      // não dispara em mouseover; precisa de pointerenter ou mouseenter.
      for (const evtType of ['pointerenter', 'mouseenter', 'mouseover']) {
        const evt = evtType.startsWith('pointer')
          ? new PointerEvent(evtType, { bubbles: false, cancelable: true })
          : new MouseEvent(evtType, { bubbles: false, cancelable: true });
        existing.dispatchEvent(evt);
      }
      await sleep(800);

      // Procurar remove button via aria-label canonical (NUNCA via regex frouxa
      // de texto, que casava 'X (previously Twitter)' no caso 260522)
      const removeSelectors = [
        'button[aria-label*="Remove thumbnail" i]',
        'button[aria-label*="Delete thumbnail" i]',
        'button[aria-label*="Clear thumbnail" i]',
        'button[aria-label*="Remove cover" i]',
        'button[aria-label*="Remove image" i]',
      ];
      let removeBtn = null;
      for (const sel of removeSelectors) {
        try {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            removeBtn = el;
            steps.push('found remove btn via selector: ' + sel);
            break;
          }
        } catch {
          // CSS4 case-insensitive attribute selector pode falhar em runtimes
          // antigos — fall back pra exact aria-label sem flag
          const fallbackSel = sel.replace(/" i\\]$/, '"]');
          const el = document.querySelector(fallbackSel);
          if (el && el.offsetParent !== null) {
            removeBtn = el;
            steps.push('found remove btn via fallback selector: ' + fallbackSel);
            break;
          }
        }
      }

      // Fallback: search APENAS no immediate parent container do thumbnail
      // (level 0 = parent direto). Walking 5 levels podia capturar 'Delete
      // draft' ou outros remove buttons de seções vizinhas.
      if (!removeBtn) {
        const container = existing.parentElement;
        if (container) {
          const candidates = Array.from(container.querySelectorAll('button')).filter(b => {
            const al = (b.getAttribute('aria-label') || '').toLowerCase();
            const txt = (b.textContent || '').trim().toLowerCase();
            // Skip distractors no botão e em ancestors (impede 'Delete draft'
            // dentro de panel de settings que tenha aria 'Settings').
            if (/twitter|share|navigate|tab|settings|preview|publish|schedule|save|draft|account|user|publication/i.test(al + ' ' + txt)) return false;
            // Skip se algum ancestor próximo é um modal/menu não relacionado a thumbnail
            let p = b.parentElement;
            for (let k = 0; k < 3 && p; k++) {
              const pal = (p.getAttribute('aria-label') || '').toLowerCase();
              if (/twitter|share|navigate|tab|settings|preview|publish|schedule|account|user|publication|toast/i.test(pal)) return false;
              p = p.parentElement;
            }
            // Aceitar SOMENTE remove/trash/delete words completas (\\b boundaries
            // pra evitar 'x' bare match — fonte do bug original do #1457).
            return /\\b(remove|delete|trash)\\b/i.test(al) ||
                   /\\b(remove|delete|trash)\\b/i.test(txt);
          });
          if (candidates.length > 0) {
            removeBtn = candidates[0];
            steps.push('found remove btn via parent-only fallback');
          }
        }
      }

      if (!removeBtn) {
        return { error: 'remove button not found — replace requires manual remove', existingSrc, removed: false, steps };
      }
      removeBtn.click();
      steps.push('clicked remove');
      await sleep(1500);

      // Confirmação modal (Beehiiv às vezes pergunta "Are you sure?")
      // Aceitar variantes "Yes, remove" / "Confirm deletion" — não exigir
      // exact match. Excluir o removeBtn já clicado — regex Remove/Delete casaria
      // com o próprio botão se React re-renderizá-lo em 1500ms (#2283 fix #7).
      const confirmBtn = buttons().find(b => {
        if (b === removeBtn) return false; // evitar double-click no remove button
        const txt = b.textContent?.trim() || '';
        return /^(Confirm|Yes|Remove|Delete)(\\b|,|\\.|\\s|$)/i.test(txt);
      });
      if (confirmBtn) {
        confirmBtn.click();
        steps.push('confirmed modal');
        await sleep(1000);
      }

      return { existingSrc, removed: true, steps };
    })()
  `;
}

/**
 * #2283: Etapa 2 do replace de cover em 2 chamadas separadas — UPLOAD da nova
 * cover via DataTransfer (método primário #1801). Análogo a `buildCoverDataTransferJs`
 * mas pensado para o contexto de replace (chamado após a Etapa 1 já ter removido
 * a cover existente).
 *
 * Máximo ~8s de sleep total — seguro frente ao limite de 45s do CDP.
 *
 * Retorna o shape `CoverVerifyRaw` → classificar com `classifyCoverVerify`.
 *
 * @param imageUrl URL pública da nova cover (Cloudflare Worker /img/ — precisa CORS *)
 * @param filename nome do File (informativo pro Beehiiv; default 04-d1-2x1.jpg)
 *
 * FLUXO DE USO CORRETO (#2283):
 *   1. javascript_tool → buildCoverReplaceStep1_RemoveExistingJs() [≤5s]
 *   2. computer.wait({ seconds: 2 }) — fora do javascript_tool
 *   3. javascript_tool → buildCoverReplaceStep2_UploadJs(url) [≤15s]
 *   4. classifyCoverVerify(result)
 *
 * NUNCA combinar Step1 + Step2 num único javascript_tool: total >20s → CDP timeout.
 *
 * @see buildCoverReplaceStep1_RemoveExistingJs — Etapa 1: remove cover existente.
 */
export function buildCoverReplaceStep2_UploadJs(
  imageUrl: string,
  filename = "04-d1-2x1.jpg",
  existingSrc = "",
): string {
  return `
    (async () => {
      const steps = [];
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const visible = (el) => el && el.offsetParent !== null;
      const buttons = () =>
        Array.from(document.querySelectorAll('button, [role="menuitem"]')).filter(visible);
      // existingSrc capturado pela Etapa 1 — excluir da busca da img subida (#2283 fix #6)
      const existingSrcSnapshot = ${JSON.stringify(existingSrc)};

      // 1) garantir input[type=file] — se ausente, abrir 'Add/Change thumbnail'
      let fileInput = document.querySelector('input[type="file"]');
      if (!fileInput) {
        const addThumb = buttons().find(b => /add thumbnail|change thumbnail/i.test(b.textContent || ''));
        if (addThumb) { addThumb.click(); steps.push('clicked: Add/Change thumbnail'); await sleep(1500); }
        fileInput = document.querySelector('input[type="file"]');
      }
      if (!fileInput) return { error: 'input[type=file] não encontrado após Add/Change thumbnail', steps };

      // 2) fetch da imagem → File → DataTransfer (método primário #1500/#1801)
      let blob;
      try {
        const res = await fetch(${JSON.stringify(imageUrl)});
        if (!res.ok) return { error: 'fetch da cover falhou: HTTP ' + res.status, steps };
        blob = await res.blob();
      } catch (e) {
        return { error: 'fetch da cover lançou (CORS no /img?): ' + (e && e.message), steps };
      }
      // #2680 / #2714 item 2: guard de blob compartilhado — ver COVER_BLOB_GUARD_JS.
      ${COVER_BLOB_GUARD_JS}
      const file = new File([blob], ${JSON.stringify(filename)}, { type: blob.type || 'image/jpeg' });
      const dt = new DataTransfer(); dt.items.add(file);
      fileInput.files = dt.files;
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));
      steps.push('dispatched: change via DataTransfer');
      await sleep(5000);

      // 3) clicar na img recém-subida → aplica automático (sem botão Insert)
      // Excluir existingSrcSnapshot — DOM pode ainda ter a old cover (async detach) (#2283 fix #6)
      const uploaded = Array.from(document.querySelectorAll('img')).find(i =>
        visible(i) &&
        /(media\\.beehiiv|beehiiv-images-production.*uploads)/i.test(i.src) &&
        !(/static_assets|publication.logo/i.test(i.src)) &&
        (existingSrcSnapshot ? i.src !== existingSrcSnapshot : true));
      if (uploaded) { uploaded.click(); steps.push('clicked: uploaded img (apply)'); await sleep(3000); } // 3000ms = mesmo do buildCoverDataTransferJs validado (#2283 fix #5)
      else steps.push('uploaded img não localizada (pode ter auto-aplicado)');

      // 4) verificar via DOM: 'Add thumbnail' sumiu + thumbnail beehiiv-images presente
      const addThumbAfter = buttons().find(b => /add thumbnail/i.test(b.textContent || ''));
      const thumb = Array.from(document.querySelectorAll('img'))
        .find(i => visible(i) && /beehiiv-images-production.*uploads/i.test(i.src));
      return { addThumbnailPresent: !!addThumbAfter, thumbnailSrc: thumb ? thumb.src : null, steps };
    })()
  `;
}

/**
 * #1457 / #2283: gera JS pra REPLACE cover existente num único call.
 *
 * @deprecated (#2283) Este helper combina remoção + upload num único
 * `javascript_tool`, o que ultrapassa o limite de 45s do CDP quando há
 * cover existente (remove ~3-4s + upload via DataTransfer ~8s + sleeps
 * intermediários → total >15s, com margem ruim). Use a versão em 2 etapas:
 *
 *   1. `buildCoverReplaceStep1_RemoveExistingJs()` — remove (≤5s)
 *   2. `computer.wait({ seconds: 2 })` — fora do javascript_tool
 *   3. `buildCoverReplaceStep2_UploadJs(url)` — DataTransfer upload (≤15s)
 *
 * Mantido para back-compat com testes existentes e como fallback pra situações
 * onde não há cover existente (single-call é suficientemente curto). Se `removed`
 * vier `false` da Etapa 1, pode-se saltar direto para a Etapa 2.
 *
 * Pre-fix (caso 260522): heurística inline procurava remove button via
 * regex `remove|delete|trash|×|x` no aria-label/text. \"x\" casou \"X
 * (previously Twitter)\" no nav tab → clique navegou pra settings em vez
 * de remover cover. Fix: selector específico por aria-label canonical do
 * Beehiiv UI (Remove/Clear thumbnail).
 *
 * @param imageUrl URL pública da nova imagem
 */
export function buildCoverReplaceJs(imageUrl: string): string {
  return `
    (async () => {
      const steps = [];
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      const buttons = () =>
        Array.from(document.querySelectorAll('button, [role="menuitem"]')).filter(b => b.offsetParent !== null);

      // Step 0: detectar cover existente (Beehiiv S3 src)
      const existing = Array.from(document.querySelectorAll('img'))
        .find(i => i.offsetParent !== null && /beehiiv-images-production.*uploads/i.test(i.src));

      // #1457 review fix: capturar existingSrc ANTES do remove (existing.src
      // pode estar stale após detach do DOM)
      const existingSrcSnapshot = existing ? existing.src : '';

      if (existing) {
        steps.push('found existing cover: ' + existing.src.slice(60, 110));

        // #1457 review fix: hover via múltiplos event types — React onMouseEnter
        // não dispara em mouseover; precisa de pointerenter ou mouseenter.
        for (const evtType of ['pointerenter', 'mouseenter', 'mouseover']) {
          const evt = evtType.startsWith('pointer')
            ? new PointerEvent(evtType, { bubbles: false, cancelable: true })
            : new MouseEvent(evtType, { bubbles: false, cancelable: true });
          existing.dispatchEvent(evt);
        }
        await sleep(800);

        // Procurar remove button via aria-label canonical (NUNCA via regex frouxa
        // de texto, que casava 'X (previously Twitter)' no caso 260522)
        const removeSelectors = [
          'button[aria-label*="Remove thumbnail" i]',
          'button[aria-label*="Delete thumbnail" i]',
          'button[aria-label*="Clear thumbnail" i]',
          'button[aria-label*="Remove cover" i]',
          'button[aria-label*="Remove image" i]',
        ];
        let removeBtn = null;
        for (const sel of removeSelectors) {
          try {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) {
              removeBtn = el;
              steps.push('found remove btn via selector: ' + sel);
              break;
            }
          } catch {
            // CSS4 case-insensitive attribute selector pode falhar em runtimes
            // antigos — fall back pra exact aria-label sem flag
            const fallbackSel = sel.replace(/" i\]$/, '"]');
            const el = document.querySelector(fallbackSel);
            if (el && el.offsetParent !== null) {
              removeBtn = el;
              steps.push('found remove btn via fallback selector: ' + fallbackSel);
              break;
            }
          }
        }

        // Fallback: search APENAS no immediate parent container do thumbnail
        // (level 0 = parent direto). Walking 5 levels podia capturar 'Delete
        // draft' ou outros remove buttons de seções vizinhas.
        if (!removeBtn) {
          const container = existing.parentElement;
          if (container) {
            const candidates = Array.from(container.querySelectorAll('button')).filter(b => {
              const al = (b.getAttribute('aria-label') || '').toLowerCase();
              const txt = (b.textContent || '').trim().toLowerCase();
              // Skip distractors no botão e em ancestors (impede 'Delete draft'
              // dentro de panel de settings que tenha aria 'Settings').
              if (/twitter|share|navigate|tab|settings|preview|publish|schedule|save|draft|account|user|publication/i.test(al + ' ' + txt)) return false;
              // Skip se algum ancestor próximo é um modal/menu não relacionado a thumbnail
              let p = b.parentElement;
              for (let k = 0; k < 3 && p; k++) {
                const pal = (p.getAttribute('aria-label') || '').toLowerCase();
                if (/twitter|share|navigate|tab|settings|preview|publish|schedule|account|user|publication|toast/i.test(pal)) return false;
                p = p.parentElement;
              }
              // Aceitar SOMENTE remove/trash/delete words completas (\\b boundaries
              // pra evitar 'x' bare match — fonte do bug original do #1457).
              return /\\b(remove|delete|trash)\\b/i.test(al) ||
                     /\\b(remove|delete|trash)\\b/i.test(txt);
            });
            if (candidates.length > 0) {
              removeBtn = candidates[0];
              steps.push('found remove btn via parent-only fallback');
            }
          }
        }

        if (!removeBtn) {
          return { error: 'remove button not found — replace requires manual remove', steps };
        }
        removeBtn.click();
        steps.push('clicked remove');
        await sleep(2000);

        // Confirmação modal (Beehiiv às vezes pergunta "Are you sure?")
        // Aceitar variantes "Yes, remove" / "Confirm deletion" — não exigir
        // exact match.
        const confirmBtn = buttons().find(b => {
          const txt = b.textContent?.trim() || '';
          return /^(Confirm|Yes|Remove|Delete)(\\b|,|\\.|\\s|$)/i.test(txt);
        });
        if (confirmBtn) {
          confirmBtn.click();
          steps.push('confirmed modal');
          await sleep(1500);
        }
      }

      // Step 1+: re-usa upload flow do buildCoverUploadJs
      let useLib = buttons().find(b => b.textContent?.trim() === 'Use from library');
      if (!useLib) {
        const addThumb = buttons().find(b => /add thumbnail|change thumbnail/i.test(b.textContent || ''));
        if (!addThumb) return { error: 'Add/Change thumbnail button not found after remove', steps };
        addThumb.click();
        steps.push('clicked: Add/Change thumbnail');
        await sleep(1500);
        useLib = buttons().find(b => b.textContent?.trim() === 'Use from library');
      }
      if (!useLib) return { error: 'Use from library button not found', steps };
      useLib.click();
      steps.push('clicked: Use from library');
      await sleep(2500);

      const uploadBtn = buttons().find(b => b.textContent?.trim() === 'Upload');
      if (!uploadBtn) return { error: 'Upload tab not found', steps };
      uploadBtn.click();
      steps.push('clicked: Upload tab');
      await sleep(1500);

      const fromUrlBtn = buttons().find(b => /upload from url/i.test(b.textContent || ''));
      if (!fromUrlBtn) return { error: 'Upload from URL button not found', steps };
      fromUrlBtn.click();
      steps.push('clicked: Upload from URL');
      await sleep(2500);

      const ta = document.querySelector('textarea[name="media-url"]');
      if (!ta) return { error: 'media-url textarea not found', steps };
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, ${JSON.stringify(imageUrl)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      steps.push('set: media-url value');
      await sleep(1000);

      const submitBtn = buttons().find(b => /^upload \\d+ media/i.test(b.textContent?.trim() || ''));
      if (!submitBtn) return { error: 'Upload N media button not found', steps };
      submitBtn.click();
      steps.push('clicked: Upload N media');
      await sleep(6000);

      // Click na nova imagem uploadada (usa existingSrcSnapshot capturado
      // pre-remove pra evitar stale .src de DOM detached). naturalWidth check
      // removido — imagem pode não ter completed decode em 6s; tolerar 0.
      const targetImg = Array.from(document.querySelectorAll('img')).find(i =>
        i.offsetParent !== null &&
        /uploads.asset.file/i.test(i.src) &&
        i.src !== existingSrcSnapshot &&
        !(/static_assets|publication.logo/i.test(i.src))
      );
      if (!targetImg) return { error: 'new uploaded image card not found in library', steps };
      let clickTarget = targetImg;
      for (let i = 0; i < 4; i++) {
        if (clickTarget.tagName === 'BUTTON' || clickTarget.onclick) break;
        if (!clickTarget.parentElement) break;
        clickTarget = clickTarget.parentElement;
      }
      clickTarget.click();
      steps.push('clicked: new uploaded image card');
      await sleep(3000);

      // Re-detect thumbnail — primeira tentativa: img com src diferente do
      // existingSrc snapshot. Se a nova imagem tiver mesmo S3 URL (cache,
      // re-upload idêntico), aceitar a 1ª img Beehiiv S3 visível.
      const allBeehiivImgs = Array.from(document.querySelectorAll('img'))
        .filter(i => /beehiiv-images-production.*uploads/i.test(i.src));
      let thumbnailImg = allBeehiivImgs.find(i => i.src !== existingSrcSnapshot);
      if (!thumbnailImg && allBeehiivImgs.length > 0) {
        // Edge case: re-upload com mesma S3 URL → aceitar a única visible
        thumbnailImg = allBeehiivImgs[0];
      }
      return {
        thumbnailSrc: thumbnailImg?.src ?? null,
        steps,
        replaced: !!existing,
      };
    })()
  `;
}

/**
 * #2680: lê `images.cover.url` de `06-public-images.json` — a URL md5-versionada
 * correta para usar como argumento de `buildCoverDataTransferJs`.
 *
 * Nunca construir a URL canônica manualmente (`img-{AAMMDD}-04-d1-2x1.jpg`) —
 * desde #1418 o KV usa keys md5-versionadas; a canônica retorna 9 bytes 'Not Found'
 * em vez do JPEG, o que o guard de blob em `buildCoverDataTransferJs` agora rejeita
 * explicitamente.
 *
 * #2714 item 1 — edge case `target: "drive"`: desde #2147 o default de
 * `upload-images-public.ts` é SEMPRE `cloudflare` para todos os modes (Drive só
 * é alcançável via `--target drive` explícito, override manual raro). Quando o
 * entry `cover` foi de fato uploadado com `target: "drive"`, `images.cover.url`
 * é uma URL `https://drive.google.com/uc?id=...&export=view` — NÃO a URL
 * Cloudflare Worker md5-versionada que os callers (`buildCoverDataTransferJs` /
 * `buildCoverReplaceStep2_UploadJs`) esperam. Diferenças relevantes:
 *   - Drive `uc?id=` não é garantidamente fetch()-ável em CORS cross-origin a
 *     partir do domínio do Beehiiv (Google não seta `Access-Control-Allow-Origin:
 *     *` de forma confiável nesse endpoint) — o fetch dentro do IIFE async pode
 *     lançar, e o catch existente já produz um erro genérico ("CORS no /img?")
 *     que hoje presume (incorretamente, nesse caso) que a fonte é o Worker.
 *   - Drive URLs não carregam sufixo md5 de cache-bust — não há garantia de que
 *     o blob servido reflita a imagem local mais recente (#1418 drift).
 * Fail-fast aqui: se o entry aponta pra `target: "drive"`, lança um erro claro
 * ANTES do caller tentar usar a URL no browser, em vez de deixar o erro de CORS
 * genérico (potencialmente confuso) surgir só no fetch() in-page. Recuperação:
 * re-rodar `upload-images-public.ts --mode newsletter --target cloudflare
 * --force-reupload` pra recriar o entry `cover` no Worker antes do cover upload.
 *
 * @param publicImagesPath Caminho absoluto para `{edition_dir}/06-public-images.json`
 * @returns URL md5-versionada ex: "https://poll.diaria.workers.dev/img/img-260630-04-d1-2x1-3692a95a.jpg"
 * @throws Error se images.cover.url estiver ausente (upload-images-public.ts não rodou)
 * @throws Error se o entry cover foi uploadado com target=drive (não Cloudflare Worker)
 */
export function readCoverImageUrl(publicImagesPath: string): string {
  let data: { images?: { cover?: { url?: string; target?: "drive" | "cloudflare" } } };
  try {
    data = JSON.parse(readFileSync(publicImagesPath, "utf8"));
  } catch (e) {
    // ENOENT (arquivo ausente — Stage 3 não rodou) ou SyntaxError (write
    // interrompido) chegam aqui sem o hint #2680; re-throw com o caminho de
    // recuperação para não deixar o operador no escuro (#2680 self-review).
    throw new Error(
      `não foi possível ler ${publicImagesPath} (${(e as Error).message}) — verifique se upload-images-public.ts --mode newsletter rodou (#2680)`,
    );
  }
  const cover = data?.images?.cover;
  const url = cover?.url;
  if (!url) {
    throw new Error(
      `images.cover.url não encontrado em ${publicImagesPath} — verifique se upload-images-public.ts --mode newsletter rodou (#2680)`,
    );
  }
  // #2714 item 1: target=drive não é a fonte esperada pelos builders de cover
  // upload — ver docstring acima para o porquê (CORS + sem cache-bust md5).
  if (cover?.target === "drive") {
    throw new Error(
      `images.cover.url em ${publicImagesPath} aponta pra target=drive (${url}), não Cloudflare Worker (#2714) — ` +
        `Drive não garante CORS pro fetch() in-page nem cache-bust md5. Re-rode ` +
        `'upload-images-public.ts --mode newsletter --target cloudflare --force-reupload' antes do cover upload.`,
    );
  }
  return url;
}
