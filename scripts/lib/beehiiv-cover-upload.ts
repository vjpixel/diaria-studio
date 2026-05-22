/**
 * beehiiv-cover-upload.ts (#1416)
 *
 * Helper pra setar a cover image (thumbnail) do post no Beehiiv via UI
 * nativa "Upload from URL". Bypassa o erro "Not allowed" que `file_upload`
 * gera em inputs hidden do Beehiiv.
 *
 * Caminho descoberto em 260520 (issue #1416):
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
 *   - Validar via `mcp__claude_ai_Beehiiv__get_post` que `web_thumbnail_url`
 *     foi populado pós-upload
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

      // Step 8: click recently uploaded card
      const targetImg = Array.from(document.querySelectorAll('img')).find(i =>
        i.offsetParent !== null &&
        /uploads.asset.file/i.test(i.src) &&
        i.naturalWidth >= 400 &&
        !(/static_assets|publication.logo/i.test(i.src))
      );
      if (!targetImg) return { error: 'uploaded image card not found in library', steps };
      let clickTarget = targetImg;
      for (let i = 0; i < 4; i++) {
        if (clickTarget.tagName === 'BUTTON' || clickTarget.onclick) break;
        if (!clickTarget.parentElement) break;
        clickTarget = clickTarget.parentElement;
      }
      clickTarget.click();
      steps.push('clicked: uploaded image card');
      await sleep(3000);

      // Verify thumbnail was set
      const thumbnailImg = Array.from(document.querySelectorAll('img'))
        .find(i => /beehiiv-images-production.*uploads/i.test(i.src));
      return {
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
  result: { thumbnailSrc?: string | null; steps?: string[]; error?: string },
):
  | { ok: true; thumbnailUrl: string }
  | { ok: false; reason: string; lastStep?: string } {
  if (result.error) {
    return {
      ok: false,
      reason: result.error,
      lastStep: result.steps?.[result.steps.length - 1],
    };
  }
  if (!result.thumbnailSrc) {
    return {
      ok: false,
      reason: "thumbnail src ausente pós-upload — UI flow não populou",
      lastStep: result.steps?.[result.steps.length - 1],
    };
  }
  if (!/beehiiv-images-production/i.test(result.thumbnailSrc)) {
    return {
      ok: false,
      reason: `thumbnail src "${result.thumbnailSrc.slice(0, 80)}" não bate com pattern beehiiv-images-production`,
      lastStep: result.steps?.[result.steps.length - 1],
    };
  }
  return { ok: true, thumbnailUrl: result.thumbnailSrc };
}

/**
 * #1457: gera JS pra REPLACE cover existente. Detecta thumbnail existente
 * via Beehiiv S3 pattern, remove via aria-label-based selector (não regex
 * frouxa) e re-utiliza upload flow do `buildCoverUploadJs`.
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
