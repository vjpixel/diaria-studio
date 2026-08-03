/**
 * beehiiv-insert-text.ts (#2550, timeout+fallback+verificação #4196)
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
 * **#4196 — fetch pendurado não disparava o fallback.** O fallback automático
 * Worker→chunked só detectava exit não-zero do `upload-html-public.ts` (Fase 2, shell).
 * O `fetch()` desta Fase 3 roda in-page — se pendurar (CSP, rede, Worker lento), a
 * Fase 2 já terminou com exit 0 e o gatilho do fallback nunca é avaliado (falha
 * silenciosa, aconteceu ao vivo em #2495/260623). O fix: `AbortController` com timeout
 * (`DEFAULT_FETCH_TIMEOUT_MS`, 25s) — abort vira `{ error: 'fetch_timeout', ... }`, que
 * `classifyInsertResult` já roteia para `retry_chunked` automaticamente (mesmo caminho
 * de qualquer outro erro reportado pelo snippet). Nenhuma mudança adicional foi
 * necessária em `classifyInsertResult` — o `r.error` truthy já cobria esse caso, só
 * faltava o snippet in-page produzir esse erro em vez de nunca resolver.
 *
 * **TESTÁVEL:** a função `buildInsertTextJs` é pura — não acessa DOM, não faz fetch.
 * Dado um fragmentHtml qualquer, produz um snippet JS determinístico. O teste unitário
 * (#633) valida que:
 *   - a string `{{email}}` é preservada literalmente no payload (`text` string).
 *   - a string `tr.insertText` aparece no snippet gerado.
 *   - o fragmentHtml é referenciado via template literal ou concatenação (não escapado).
 *   - (#4196) o snippet gerado, quando executado de fato contra um `fetch` mock que
 *     nunca resolve, retorna `{ error: 'fetch_timeout', ... }` após o timeout — o único
 *     teste desta suite que efetivamente `eval()`a o snippet gerado (os demais só
 *     inspecionam a string), porque o critério de aceite do #4196 é comportamental
 *     ("timeout dispara"), não só textual.
 *
 * **NÃO TESTÁVEL aqui:** a execução real no browser com DOM TipTap + ProseMirror
 * completo (o teste de timeout usa mocks mínimos de `document`/`fetch`, não um DOM real).
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
 * 2. javascript_tool({ code: buildInsertTextJs(rawFragmentUrl) })  // timeout embutido (#4196)
 * 3. classifyInsertResult(result) → "ok" | "retry_chunked" | "verify_only"
 *    (timeout/abort da Fase 3 já cai em "retry_chunked", igual erro HTTP)
 * 4. (pós-paste, só quando "ok") verifyBodySizePlausible(result.htmlBytes, expectedBytes)
 *    contra o tamanho do arquivo local (`readLocalFragmentBytes`) — pega paste
 *    "bem-sucedido" mas truncado/vazio, que classifyInsertResult sozinho não detecta.
 * 5. Verificar que o fragmento foi persistido via verifyFragmentPreserved()
 * ```
 *
 * ## Fallback (chunked base64 — §Apêndice do playbook)
 *
 * Acionar automaticamente quando `classifyInsertResult` retornar `"retry_chunked"`
 * (cobre erro HTTP, timeout/abort do fetch, `inserted: false` ou merge-tag ausente)
 * ou quando `verifyBodySizePlausible` retornar `ok: false` (corpo inserido mas
 * implausivelmente pequeno/vazio comparado ao arquivo local).
 */

import { readFileSync } from "node:fs";

/**
 * Timeout default do `fetch()` in-page da Fase 3 (#4196). 25s — dentro da faixa
 * 20-30s pedida pela issue: generoso o bastante pra Worker "lento, mas vivo",
 * curto o bastante pra não segurar a sessão inteira quando o fetch de fato
 * pendurou (o modo de falha real do #2495).
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Constrói o snippet JS que, quando executado via `javascript_tool` na página do Beehiiv,
 * faz fetch do fragmento HTML bruto e o insere via ProseMirror `tr.insertText`.
 *
 * O snippet é autoexecutável (IIFE async) e retorna um objeto JSON-serializável:
 * ```json
 * { "inserted": true, "htmlBytes": 28341, "docSize": 28345, "hasEmail": true }
 * ```
 *
 * **#4196:** o `fetch()` é envolvido por `AbortController` com timeout
 * (`timeoutMs`, default `DEFAULT_FETCH_TIMEOUT_MS`). Se o fetch não resolver a
 * tempo, o abort é capturado e o snippet retorna
 * `{ error: 'fetch_timeout', url, timeoutMs }` — um erro detectável, roteado por
 * `classifyInsertResult` pro fallback chunked, em vez de deixar a Promise pendurada
 * pra sempre (o modo de falha silenciosa do #2495).
 *
 * @param rawFragmentUrl URL do fragmento bruto (sem wrapper de preview).
 *   Deve ser a URL retornada por `upload-html-public.ts --no-wrap`.
 *   Exemplo: `"https://draft.diaria.workers.dev/260625-a3b2c1"`.
 * @param timeoutMs Timeout do fetch in-page em milissegundos (#4196). Default
 *   `DEFAULT_FETCH_TIMEOUT_MS` (25s). Parametrizável principalmente para teste
 *   (timeout curto simula o "fetch nunca resolve" sem esperar 25s de verdade).
 * @returns String de código JS pronto para ser passado ao `javascript_tool`.
 */
export function buildInsertTextJs(
  rawFragmentUrl: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): string {
  // Sanitize: URL não deve conter aspas simples (quebraria o template literal do snippet).
  if (rawFragmentUrl.includes("'")) {
    throw new Error(`[beehiiv-insert-text] rawFragmentUrl contém aspas simples: ${rawFragmentUrl}`);
  }

  return `(async () => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ${timeoutMs});
  let res;
  try {
    res = await fetch('${rawFragmentUrl}', { signal: controller.signal });
  } catch (fetchErr) {
    clearTimeout(timeoutId);
    if (fetchErr && fetchErr.name === 'AbortError') {
      // #4196: fetch pendurado (CSP, rede, Worker lento) — antes ficava pendente pra
      // sempre e o auto-fallback (que só olha exit code da Fase 2) nunca disparava.
      return { error: 'fetch_timeout', url: '${rawFragmentUrl}', timeoutMs: ${timeoutMs} };
    }
    return { error: 'fetch_exception: ' + (fetchErr && fetchErr.message ? fetchErr.message : String(fetchErr)), url: '${rawFragmentUrl}' };
  }
  clearTimeout(timeoutId);
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
  // #4487: a URL de voto passou a usar o token opaco {{poll_token}} em vez do
  // e-mail cru {{email}} — 'hasEmail' checa QUALQUER um dos dois (o legado
  // continua reconhecido, nunca um falso 'merge-tag perdida' se algum caminho
  // ainda emitir a forma antiga).
  let hasEmail = false;
  let hasPollA = false;
  let hasPollB = false;
  editor.state.doc.descendants((n) => {
    if (n.isText && n.text) {
      if (n.text.includes('{{poll_token}}') || n.text.includes('{{email}}')) hasEmail = true;
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
 * Valida que um fragmento HTML bruto preserva a merge-tag de identidade do
 * voto — `{{poll_token}}` (#4487: token opaco por assinante, substitui o
 * `{{email}}` cru que a URL de voto usava até então).
 *
 * Essa tag é obrigatória: a URL de voto do É IA? usa o token como identificador
 * do assinante. Se o fragmento foi gerado com `--no-wrap` mas a tag sumiu (ex: o
 * renderer substituiu incorretamente), o paste enviaria votos sem identificação.
 * Aceita `{{email}}` também (forma legada, pré-#4487) — nunca um falso erro se
 * algum caminho ainda não migrado emitir a forma antiga.
 *
 * @param fragmentHtml Conteúdo HTML bruto do fragmento (saída do Worker).
 * @returns `null` se válido, string de erro se inválido.
 */
export function verifyFragmentPreserved(fragmentHtml: string): string | null {
  if (!fragmentHtml || fragmentHtml.length === 0) {
    return "[beehiiv-insert-text] fragmento vazio — upload falhou ou URL incorreta";
  }
  if (!fragmentHtml.includes("{{poll_token}}") && !fragmentHtml.includes("{{email}}")) {
    return (
      "[beehiiv-insert-text] merge-tag de identidade de voto ({{poll_token}}, #4487) ausente no fragmento — " +
      "verifique que upload-html-public.ts foi rodado com --no-wrap e que o " +
      "renderer preservou as merge-tags"
    );
  }
  return null;
}

/**
 * Proporção mínima aceitável entre o corpo observado no editor (`htmlBytes`/
 * `docSize` do resultado pós-paste) e o tamanho do arquivo local que gerou o
 * upload (#4196). `.length` em JS mede unidades UTF-16, não bytes UTF-8 — por
 * isso a comparação é aproximada (`≈`, conforme a issue), não igualdade exata.
 */
export const DEFAULT_MIN_BODY_SIZE_RATIO = 0.9;

/** Resultado da verificação de tamanho pós-paste (#4196). */
export interface BodySizeVerification {
  ok: boolean;
  reason?: "empty_body" | "body_too_small" | "expected_bytes_invalid";
  observedBytes: number;
  expectedBytes: number;
  ratio: number;
}

/**
 * Verifica se o corpo inserido no editor tem tamanho plausível comparado ao
 * arquivo local que gerou o fragmento (`_internal/newsletter-final.html`).
 *
 * **Por que existe (#4196):** `classifyInsertResult` já pega erro explícito do
 * fetch (HTTP não-2xx, timeout/abort, exceção) e merge-tag ausente. Mas um paste
 * "bem-sucedido" nesses termos (`inserted: true`, `hasEmail: true`) ainda pode ter
 * inserido um corpo vazio ou truncado — ex: o Worker serviu uma resposta parcial
 * sem erro HTTP, ou o `tr.insertText` foi interrompido no meio por um erro do
 * ProseMirror não capturado. Sem este check, esse cenário "declara sucesso
 * silenciosamente" (linguagem da issue #4196) — o paste segue pro passo seguinte
 * do playbook com um corpo incompleto e ninguém percebe até o test email.
 *
 * Comparação por razão mínima (`minRatio`), não igualdade exata — ver
 * `DEFAULT_MIN_BODY_SIZE_RATIO`.
 *
 * @param observedBytes `result.htmlBytes` (ou `docSize`) do retorno de
 *   `buildInsertTextJs`/`javascript_tool` — tamanho do fragmento efetivamente
 *   baixado e inserido, medido no browser.
 * @param expectedBytes tamanho em bytes do arquivo local que gerou o upload
 *   (`readLocalFragmentBytes(newsletterFinalHtmlPath)`).
 * @param minRatio razão mínima `observedBytes / expectedBytes` para considerar
 *   plausível. Default `DEFAULT_MIN_BODY_SIZE_RATIO` (0.9).
 */
export function verifyBodySizePlausible(
  observedBytes: number,
  expectedBytes: number,
  minRatio: number = DEFAULT_MIN_BODY_SIZE_RATIO,
): BodySizeVerification {
  if (!Number.isFinite(expectedBytes) || expectedBytes <= 0) {
    return {
      ok: false,
      reason: "expected_bytes_invalid",
      observedBytes,
      expectedBytes,
      ratio: 0,
    };
  }

  const ratio = observedBytes / expectedBytes;

  if (!observedBytes || observedBytes <= 0) {
    return { ok: false, reason: "empty_body", observedBytes, expectedBytes, ratio };
  }

  if (ratio < minRatio) {
    return { ok: false, reason: "body_too_small", observedBytes, expectedBytes, ratio };
  }

  return { ok: true, observedBytes, expectedBytes, ratio };
}

/**
 * Lê o tamanho em bytes (UTF-8) do arquivo local que gerou o fragmento
 * enviado ao Worker — baseline para `verifyBodySizePlausible`. Isolado numa
 * função própria (I/O) para manter `verifyBodySizePlausible` pura/testável
 * sem tocar o filesystem.
 *
 * @param localFilePath caminho de `_internal/newsletter-final.html` (ou
 *   equivalente) — o arquivo local que `upload-html-public.ts --no-wrap` subiu.
 */
export function readLocalFragmentBytes(localFilePath: string): number {
  const content = readFileSync(localFilePath, "utf8");
  return Buffer.byteLength(content, "utf8");
}

/**
 * Descreve o resultado esperado após a execução do snippet `buildInsertTextJs`
 * via `javascript_tool`. Usado pelo orchestrator para decidir se deve acionar
 * o fallback chunked.
 */
interface InsertTextResult {
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
 * **#4196:** o timeout/abort do fetch in-page (ver `buildInsertTextJs`) produz
 * `{ error: 'fetch_timeout', ... }`, que cai no mesmo ramo `r.error` de qualquer
 * outro erro do fetch — já roteado para `"retry_chunked"` sem lógica adicional.
 *
 * **Nota:** `"ok"` aqui cobre só o que o snippet in-page consegue reportar
 * (insert sem erro + merge-tag presente). Ainda não garante que o corpo tem
 * tamanho plausível — chamar `verifyBodySizePlausible` como passo seguinte
 * (fora deste classificador) para pegar paste truncado/parcial que "declararia
 * sucesso silenciosamente" aqui.
 *
 * @param result Objeto retornado pelo `javascript_tool` (pode ser undefined/{} em async longas).
 * @returns
 *   - `"ok"`: paste bem-sucedido, merge-tags preservadas → continuar (ainda sujeito
 *     à verificação de tamanho, ver nota acima).
 *   - `"retry_chunked"`: paste falhou (inclui timeout #4196) ou merge-tag ausente →
 *     acionar fallback chunked automaticamente.
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
