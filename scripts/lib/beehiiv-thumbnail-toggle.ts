/**
 * Helper para verificar e desligar o toggle "Show thumbnail on top in web"
 * Issue #7412: duplicação de imagem do D1 na versão web do post
 */

export interface ThumbnailToggleState {
  found: boolean;
  enabled: boolean;
  toggled: boolean;
  error?: string;
}

/**
 * Detectar estado do toggle "Show thumbnail on top in web" e desligar se estiver ON
 * Roda no step Web do Beehiiv post editor
 */
export function buildThumbnailToggleCheckAndFixJs(): string {
  return `(async () => {
    try {
      // Procurar o toggle "Show thumbnail on top in web"
      // Padrão: label com "Show thumbnail" + switch input associado

      // Tentar 1: procurar pelo data-testid ou class específica do toggle
      let toggleInput = document.querySelector(
        '[data-testid*="show-thumbnail"], [class*="show-thumbnail"], input[type="checkbox"][aria-label*="thumbnail"]'
      );

      // Tentar 2: procurar por label contendo "Show thumbnail on top in web" e achar o input associado
      if (!toggleInput) {
        const labels = Array.from(document.querySelectorAll('label'));
        const label = labels.find(l => l.textContent.includes('Show thumbnail') && l.textContent.includes('web'));
        if (label) {
          const forAttr = label.getAttribute('for');
          if (forAttr) {
            toggleInput = document.getElementById(forAttr);
          }
          // Fallback: achar o input sibling ou dentro da label
          if (!toggleInput) {
            toggleInput = label.querySelector('input[type="checkbox"]');
          }
          // Fallback: achar o próximo input após a label
          if (!toggleInput) {
            let next = label.nextElementSibling;
            while (next && next.tagName !== 'INPUT') {
              next = next.nextElementSibling;
            }
            if (next?.tagName === 'INPUT') toggleInput = next;
          }
        }
      }

      if (!toggleInput || toggleInput.tagName !== 'INPUT') {
        // Toggle não encontrado — pode não estar no DOM ainda (Web step ainda carregando)
        return { found: false, enabled: false, toggled: false };
      }

      const wasEnabled = toggleInput.checked;

      // Se está ON (checked: true), desligar
      if (wasEnabled) {
        toggleInput.click();
        // Aguardar um tick pra React renderizar
        return await new Promise(resolve => {
          setTimeout(() => {
            const isNowOff = !toggleInput.checked;
            resolve({
              found: true,
              enabled: wasEnabled,
              toggled: isNowOff
            });
          }, 100);
        });
      }

      // Já está OFF — nada pra fazer
      return { found: true, enabled: false, toggled: false };
    } catch (e) {
      return {
        found: false,
        enabled: false,
        toggled: false,
        error: e.message || 'unknown error'
      };
    }
  })()`;
}

/**
 * Classificar resultado da verificação/fix do toggle
 */
export function classifyThumbnailToggleResult(result: any): ThumbnailToggleState {
  if (!result) {
    return { found: false, enabled: false, toggled: false };
  }

  return {
    found: result.found ?? false,
    enabled: result.enabled ?? false,
    toggled: result.toggled ?? false,
    error: result.error
  };
}

/**
 * Renderizar mensagem de status do toggle
 */
export function formatThumbnailToggleMessage(state: ThumbnailToggleState): string {
  if (!state.found) {
    return `⚠️ Toggle "Show thumbnail on top in web" não localizado na UI — verificar visualmente antes de fechar Step Web.`;
  }

  if (state.enabled && !state.toggled) {
    return `❌ Toggle "Show thumbnail on top in web" está ligado e NÃO foi possível desligar — desligar manualmente no Beehiiv.`;
  }

  if (state.enabled && state.toggled) {
    return `✅ Toggle "Show thumbnail on top in web" estava ON — automaticamente desligado.`;
  }

  // Already OFF
  return `✅ Toggle "Show thumbnail on top in web" já está OFF — sem ação necessária.`;
}
