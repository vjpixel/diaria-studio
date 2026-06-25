/**
 * beehiiv-insert-text.ts (#2550)
 *
 * Helper puro (sem side-effects) para o fluxo fetch + tr.insertText do playbook Beehiiv.
 * Encapsula a construção do snippet JS injetado via `javascript_tool` e a validação do
 * fragmento HTML bruto antes de enviá-lo ao browser.
 *
 * **Por que existe:** o paste flow do Stage 5 foi revalidado em 260625 com dois achados:
 *
 *  1. `fetch('https://draft.diaria.workers.dev/...')` funciona in-page (o bloqueio CSP do
 *     #2495 não se confirmou como permanente após re-teste).
 *  2. `tr.insertText(fragmentHtml, snippetPos + 1)` em vez de
 *     `editor.commands.insertContent({ type: 'text', text: html })` evita o congelamento
 *     da página que ocorria após inserir 34KB + imagens via insertContent.
 *
 * **TESTÁVEL:** a função `buildInsertTextJs` é pura — não acessa DOM, não faz fetch.
 * Dado um fragmentHtml qualquer, produz um snippet JS determinístico. O teste unitário
 * (#633) valida que:
 *   - a string `{{email}}` é preservada literalmente no payload (`text` string).
 *   - a string `tr.insertText` aparece no snippet gerado.
 *   - o fragmentHtml é referenciado via template literal ou concatenação (não escapado).
 *
 * **NÃO TESTÁVEL aqui:** a execução real no browser (requer DOM TipTap + ProseMirror).
 *
 * ## Pré-condições de uso (runtime, verificadas pelo orchestrator)
 *
 * - `upload-html-public.ts --no-wrap` foi executado com sucesso → `rawFragmentUrl` disponível.
 * - O htmlSnippet node existe no doc (`isEmpty: true` ou conteúdo stale limpo via `buildSnippetClearJs`).
 *
 * ## Fluxo padrão (§5.2 Fase 2 + Fase 3 do playbook)
 *
 * ```
 * 1. upload-html-public.ts --no-wrap → rawFragmentUrl
 * 2. javascript_tool({ code: buildInsertTextJs(rawFragmentUrl) })
 * 3. (pós-paste) varredura direcionada: doc.descendants → hasEmail, docSize
 * 4. Verificar que o fragmento foi persistido via verifyFragmentPreserved()
 * ```
 *
 * ## Fallback (chunked base64 — §Apêndice do playbook)
 *
 * Manter o path chunked como fallback enquanto a estabilidade do fetch+insertText
 * é validada (2-3 sessões). Acionar quando `buildInsertTextJs` retornar `inserted: false`
 * ou quando `{{email}}` não for encontrado via varredura pós-paste.
 */

/**
 * Constrói o snippet JS que, quando executado via `javascript_tool` na página do Beehiiv,
 * faz fetch do fragmento HTML bruto e o insere via ProseMirror `tr.insertText`.
 *
 * O snippet é autoexecutável (IIFE async) e retorna um objeto JSON-serializável:
 * ```json
 * { "inserted": true, "htmlBytes": 28341, "docSize": 28345, "hasEmail": true }
 * ```
 *
 * @param rawFragmentUrl URL do fragmento bruto (sem wrapper de preview).
 *   Deve ser a URL retornada por `upload-html-public.ts --no-wrap`.
 *   Exemplo: `"https://draft.diaria.workers.dev/260625-a3b2c1"`.
 * @returns String de código JS pronto para ser passado ao `javascript_tool`.
 */
export function buildInsertTextJs(rawFragmentUrl: string): string {
  // Sanitize: URL não deve conter aspas simples (quebraria o template literal do snippet).
  if (rawFragmentUrl.includes("'")) {
    throw new Error(`[beehiiv-insert-text] rawFragmentUrl contém aspas simples: ${rawFragmentUrl}`);
  }

  return `(async () => {
  const res = await fetch('${rawFragmentUrl}');
  if (!res.ok) return { error: 'fetch ' + res.status, url: '${rawFragmentUrl}' };
  const html = await res.text();
  if (!html) return { error: 'empty_response', url: '${rawFragmentUrl}' };

  const pm = document.querySelector('.tiptap.ProseMirror');
  const editor = pm?.editor;
  if (!editor) return { error: 'no_editor' };

  let snippetPos = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'htmlSnippet') {
      snippetPos = pos;
      return false;
    }
  });
  if (snippetPos === null) return { error: 'no_htmlSnippet' };

  // tr.insertText insere o fragmento como texto literal — sem parsing HTML pelo TipTap.
  // Isso evita o congelamento causado por insertContent em 34KB + imagens (#2550).
  const tr = editor.state.tr;
  editor.view.dispatch(tr.insertText(html, snippetPos + 1));

  // Varredura direcionada (#1766): NÃO serializar o doc inteiro (timeout CDP 45s).
  let hasEmail = false;
  let hasPollA = false;
  let hasPollB = false;
  editor.state.doc.descendants((n) => {
    if (n.isText && n.text) {
      if (n.text.includes('{{email}}'))       hasEmail = true;
      if (n.text.includes('{{poll_a_url}}'))  hasPollA = true;
      if (n.text.includes('{{poll_b_url}}'))  hasPollB = true;
    }
  });

  return {
    inserted: true,
    htmlBytes: html.length,
    docSize: editor.state.doc.content.size,
    hasEmail,
    hasPollA,
    hasPollB,
  };
})()`;
}

/**
 * Valida que um fragmento HTML bruto preserva a merge-tag `{{email}}`.
 *
 * Essa tag é obrigatória: a URL de voto do É IA? usa `{{email}}` como identificador
 * do assinante. Se o fragmento foi gerado com `--no-wrap` mas a tag sumiu (ex: o
 * renderer substituiu incorretamente), o paste enviaria votos sem identificação.
 *
 * @param fragmentHtml Conteúdo HTML bruto do fragmento (saída do Worker).
 * @returns `null` se válido, string de erro se inválido.
 */
export function verifyFragmentPreserved(fragmentHtml: string): string | null {
  if (!fragmentHtml || fragmentHtml.length === 0) {
    return "[beehiiv-insert-text] fragmento vazio — upload falhou ou URL incorreta";
  }
  if (!fragmentHtml.includes("{{email}}")) {
    return (
      "[beehiiv-insert-text] merge-tag {{email}} ausente no fragmento — " +
      "verifique que upload-html-public.ts foi rodado com --no-wrap e que o " +
      "renderer preservou as merge-tags"
    );
  }
  return null;
}

/**
 * Descreve o resultado esperado após a execução do snippet `buildInsertTextJs`
 * via `javascript_tool`. Usado pelo orchestrator para decidir se deve acionar
 * o fallback chunked.
 */
export interface InsertTextResult {
  inserted: boolean;
  htmlBytes: number;
  docSize: number;
  hasEmail: boolean;
  hasPollA: boolean;
  hasPollB: boolean;
  error?: string;
}

/**
 * Classifica o resultado do `javascript_tool` pós-paste e decide a ação subsequente.
 *
 * @param result Objeto retornado pelo `javascript_tool` (pode ser undefined/{} em async longas).
 * @returns
 *   - `"ok"`: paste bem-sucedido, merge-tags preservadas → continuar.
 *   - `"retry_chunked"`: paste falhou ou merge-tag ausente → acionar fallback chunked.
 *   - `"verify_only"`: `javascript_tool` retornou `{}` (async longa) → verificar via varredura extra.
 */
export function classifyInsertResult(
  result: unknown,
): "ok" | "retry_chunked" | "verify_only" {
  // javascript_tool pode retornar {} em calls async longas — não é falha definitiva.
  if (
    result === null ||
    result === undefined ||
    (typeof result === "object" && Object.keys(result as object).length === 0)
  ) {
    return "verify_only";
  }

  const r = result as Partial<InsertTextResult>;

  if (r.error) return "retry_chunked";
  if (!r.inserted) return "retry_chunked";
  if (!r.hasEmail) return "retry_chunked";

  return "ok";
}
