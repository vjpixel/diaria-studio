/**
 * Toggle "Show thumbnail on top in web" do Beehiiv (#7412).
 *
 * Quando ligado, a versão web do post renderiza a capa como hero full-width no
 * topo — acima do corpo, que já abre com a MESMA imagem inline no D1. Resultado:
 * imagem duplicada + hero desproporcional. Invisível no e-mail (o Beehiiv não
 * injeta a capa no corpo), por isso nunca aparece no `review-test-email`.
 *
 * ## DOM real (verificado ao vivo 05/09/2026, post_78ed9837-bae3-41d4-ab09-84176b86f430)
 *
 * O controle NÃO é um `<input type=checkbox>` — é:
 *
 *     <label for="hide-thumbnail">Show thumbnail on top in web</label>
 *     <button role="switch" id="hide-thumbnail" type="button" aria-checked="false">
 *
 * Duas consequências que uma implementação "óbvia" erra:
 *
 * 1. `.checked` num `<button>` é `undefined` — o estado vive em `aria-checked`.
 * 2. **O id (`hide-thumbnail`) contradiz o label (`Show thumbnail…`).** Quem
 *    assumir a semântica pelo id inverte a lógica e LIGA o hero achando que
 *    está desligando. O que vale é o label: `aria-checked="true"` = hero
 *    ligado. Confirmado cruzando com as páginas públicas — o post acima, com
 *    `aria-checked="false"`, serve a capa 0× no corpo; uma edição antiga com o
 *    hero ligado serve o mesmo asset 2×.
 *
 * ## Por que tudo aqui é SÍNCRONO
 *
 * `context/publishers/beehiiv-playbook.md` (#2341) documenta que o
 * `javascript_tool` pode retornar `{}` para funções async longas, e (#1766) que
 * esperas devem ficar FORA do `javascript_tool`. Um helper `async` com
 * `setTimeout` embutido cai exatamente nessa armadilha. Por isso a leitura e o
 * clique são funções síncronas separadas: quem chama clica, espera fora, e
 * relê com `buildThumbnailToggleReadJs`.
 */

/** Estado do toggle conforme lido do DOM. */
export interface ThumbnailToggleState {
  /** O controle foi localizado e tem `aria-checked` legível. */
  found: boolean;
  /** `true` = hero ligado (duplica a imagem na web). Só significa algo se `found`. */
  enabled: boolean;
  /** Por que não foi possível determinar o estado. Presente sse `!found`. */
  reason?: string;
}

/** Resultado de uma tentativa de clique no toggle. */
export interface ThumbnailToggleClickResult {
  found: boolean;
  /** O clique foi disparado (não garante que o React já reprocessou). */
  clicked: boolean;
  /** `aria-checked` imediatamente antes do clique. */
  before?: boolean;
  reason?: string;
}

/**
 * Localiza o controle: id direto, com fallback pelo `for` do label visível
 * (caso o Beehiiv renomeie o id). Compartilhado pelos dois snippets.
 */
const LOCATE_SNIPPET = `
  var el = document.getElementById('hide-thumbnail');
  if (!el) {
    var labels = Array.prototype.slice.call(document.querySelectorAll('label'));
    var label = null;
    for (var i = 0; i < labels.length; i++) {
      var txt = labels[i].textContent || '';
      if (/show thumbnail/i.test(txt) && /web/i.test(txt)) { label = labels[i]; break; }
    }
    var forId = label && label.getAttribute('for');
    if (forId) el = document.getElementById(forId);
  }`;

/**
 * JS síncrono que LÊ o estado do toggle. Não muda nada.
 * Retorna `{found, enabled}` ou `{found:false, reason}`.
 */
export function buildThumbnailToggleReadJs(): string {
  return `(() => {
    try {${LOCATE_SNIPPET}
      if (!el) return { found: false, reason: 'controle nao encontrado (nem #hide-thumbnail nem label "Show thumbnail ... web")' };
      var aria = el.getAttribute('aria-checked');
      if (aria !== 'true' && aria !== 'false') {
        return { found: false, reason: 'aria-checked ausente ou inesperado: ' + String(aria) };
      }
      return { found: true, enabled: aria === 'true' };
    } catch (e) {
      return { found: false, reason: 'excecao: ' + ((e && e.message) || String(e)) };
    }
  })()`;
}

/**
 * JS síncrono que CLICA no toggle — só quando ele está ligado.
 *
 * Usa `.click()` (evento nativo) em vez de mexer em atributo: o controle é
 * React, e escrever `aria-checked` na mão não atualiza o estado do componente.
 *
 * Não confirma o efeito: o React reprocessa de forma assíncrona. Quem chama
 * deve esperar FORA do `javascript_tool` (#1766) e reler com
 * `buildThumbnailToggleReadJs`.
 */
export function buildThumbnailToggleClickJs(): string {
  return `(() => {
    try {${LOCATE_SNIPPET}
      if (!el) return { found: false, clicked: false, reason: 'controle nao encontrado' };
      var aria = el.getAttribute('aria-checked');
      if (aria !== 'true' && aria !== 'false') {
        return { found: false, clicked: false, reason: 'aria-checked ausente ou inesperado: ' + String(aria) };
      }
      if (aria !== 'true') {
        return { found: true, clicked: false, before: false, reason: 'ja estava OFF — clique nao disparado' };
      }
      el.click();
      return { found: true, clicked: true, before: true };
    } catch (e) {
      return { found: false, clicked: false, reason: 'excecao: ' + ((e && e.message) || String(e)) };
    }
  })()`;
}

/**
 * Normaliza o retorno do `javascript_tool` para `ThumbnailToggleState`.
 *
 * Um retorno vazio/ausente (`{}`, `null`) NUNCA vira "está OFF": vira
 * `found:false`, que o playbook trata como verificação manual obrigatória.
 * É a diferença entre degradar com segurança e afirmar um falso sucesso.
 */
export function classifyThumbnailToggleResult(result: unknown): ThumbnailToggleState {
  const r = (result ?? {}) as Record<string, unknown>;

  if (r.found !== true) {
    return {
      found: false,
      enabled: false,
      reason:
        typeof r.reason === "string" && r.reason.length > 0
          ? r.reason
          : "javascript_tool nao retornou estado legivel (resultado vazio — ver #2341)",
    };
  }

  return { found: true, enabled: r.enabled === true };
}

/** Normaliza o retorno do clique. */
export function classifyThumbnailToggleClick(result: unknown): ThumbnailToggleClickResult {
  const r = (result ?? {}) as Record<string, unknown>;

  if (r.found !== true) {
    return {
      found: false,
      clicked: false,
      reason:
        typeof r.reason === "string" && r.reason.length > 0
          ? r.reason
          : "javascript_tool nao retornou resultado legivel (ver #2341)",
    };
  }

  return {
    found: true,
    clicked: r.clicked === true,
    before: r.before === true,
    ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
  };
}

/**
 * `true` quando o Stage 5 precisa que o editor confirme o toggle na UI antes de
 * fechar o passo Web: ou o estado não pôde ser lido, ou o hero segue ligado.
 */
export function needsManualCheck(state: ThumbnailToggleState): boolean {
  return !state.found || state.enabled;
}

/** Mensagem para o log do Stage 5. Sempre carrega o `reason` quando existe. */
export function formatThumbnailToggleMessage(state: ThumbnailToggleState): string {
  const NAME = '"Show thumbnail on top in web"';

  if (!state.found) {
    return `⚠️ Toggle ${NAME}: estado NAO verificado (${state.reason ?? "motivo desconhecido"}) — confira visualmente na UI antes de "Update web".`;
  }

  if (state.enabled) {
    return `❌ Toggle ${NAME} esta LIGADO — desligue antes de "Update web", senao a versao web duplica a imagem do D1 (#7412).`;
  }

  return `✅ Toggle ${NAME} esta OFF — sem acao necessaria.`;
}
