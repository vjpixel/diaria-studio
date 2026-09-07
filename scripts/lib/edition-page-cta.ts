/**
 * scripts/lib/edition-page-cta.ts (#7576)
 *
 * Convite a assinar nas páginas de edição (`diar.ia.br/p/{slug}`): formulário
 * no rodapé + modal no meio da leitura.
 *
 * ## Por que existe
 *
 * A Beehiiv injetava um modal de assinatura no meio de cada edição publicada.
 * No cutover do apex (#467) as páginas passaram a ser servidas pelo Worker
 * `site` a partir do HTML do e-mail, e o modal ficou para trás junto com o
 * resto da camada da Beehiiv. Medido em 07/09/2026 sobre a MESMA edição nos
 * dois hosts: `diaria.beehiiv.com` servia 2 formulários, 1 campo de e-mail e
 * 106 ocorrências de "modal"; `diar.ia.br/p/{slug}` servia 0, 0 e 0.
 *
 * Isso importa mais do que parece porque essas páginas são o destino de
 * conteúdo do domínio — é onde cai quem chega de busca, de link compartilhado
 * e (desde #7575) de anúncio. Eram a superfície mais visitada sem nenhuma
 * forma de virar assinante.
 *
 * ## Gatilho: 50% de rolagem (decisão do editor, 07/09/2026)
 *
 * Modal antes de a pessoa ler qualquer coisa converte pior que modal nenhum, e
 * queima a única impressão que a página tem. 50% é a metade da leitura: quem
 * chegou ali já demonstrou interesse pelo texto, que é o argumento de venda.
 *
 * Regras que decorrem disso, e que o script implementa:
 *
 *   - **Uma vez por leitor.** Fechou (ou assinou), não volta — `localStorage`.
 *     Um modal que reaparece a cada edição transforma o acervo em armadilha.
 *   - **Nunca em página curta.** Abaixo de ~1,6 viewport de altura, 50% de
 *     rolagem acontece quase de imediato e o gatilho perde o sentido.
 *   - **Nunca sem JS.** O modal é aprimoramento progressivo puro; o formulário
 *     do rodapé é HTML nativo e funciona sozinho.
 *   - **Fechável de três jeitos** (Esc, botão, clique no fundo) e devolve o
 *     foco para onde estava. Modal que prende o leitor é pior que nenhum.
 *
 * `localStorage` pode lançar (janela privada, cookies bloqueados) — toda
 * leitura e escrita é envolvida em try/catch e o default é "mostrar", nunca
 * quebrar a página. Há um caso assimétrico conhecido e aceito: navegador que
 * PERMITE ler e BLOQUEIA escrever (cota estourada por outro uso da mesma
 * origem) fecha o modal na hora e não persiste a dispensa, então ele volta na
 * próxima edição. É raro — quase toda configuração que bloqueia escrita
 * bloqueia leitura junto, e esse caso já resolve para "mostrar" — e a
 * alternativa (insistir na escrita, ou avisar o leitor) custa mais do que o
 * incômodo que evita.
 *
 * ## Reuso, não reimplementação
 *
 * O formulário e o script de envio vêm de `site-home-page.ts`
 * (`renderSignupForm`/`signupFormScript`), o mesmo mecanismo já em produção na
 * home e em `/assinar`: honeypot, opt-in obrigatório, UTM lido da query string,
 * timeout de fetch, mensagens de status. `signupFormScript` conecta TODO
 * `form.signup` da página, então o formulário do modal é conectado sem
 * nenhuma linha extra.
 *
 * ## O CSS é escopado de propósito
 *
 * A página é HTML de e-mail: tabelas, estilos inline, `<style>` da Beehiiv.
 * Todo seletor daqui tem prefixo `diaria-cta`/`signup`, nada é global, e o
 * modal vive em `position: fixed` fora do fluxo — não há como empurrar o
 * conteúdo da edição.
 */
import { COLORS, FONTS } from "./shared/design-tokens.ts";
import { renderSignupForm, signupFormScript } from "./site-home-page.ts";

/**
 * Fração da página rolada que dispara o modal. Decisão do editor (#7576).
 * Medida sobre a altura rolável, não sobre a viewport.
 */
export const MODAL_SCROLL_TRIGGER = 0.5;

/**
 * Altura mínima da página, em viewports, para o modal fazer sentido.
 *
 * Abaixo disso 50% de rolagem chega quase junto com o carregamento, e o modal
 * volta a ser o pop-up imediato que a decisão de gatilho existe para evitar.
 */
export const MIN_PAGE_VIEWPORTS_FOR_MODAL = 1.6;

/** Chave do `localStorage`. Versionada: mudar o convite permite reapresentá-lo. */
export const MODAL_DISMISSED_KEY = "diaria:cta-modal:v1";

export function editionCtaStyles(): string {
  return `<style>
.diaria-cta-footer {
  margin: 40px auto 0; padding: 28px 20px 32px; max-width: 620px;
  background: ${COLORS.paperAlt}; border-radius: 10px; box-sizing: border-box;
  font-family: ${FONTS.sans};
}
.diaria-cta-footer h2 {
  margin: 0 0 6px; font-family: ${FONTS.serif}; font-size: 22px; line-height: 1.25; color: ${COLORS.ink};
}
.diaria-cta-lede { margin: 0 0 16px; font-size: 15px; line-height: 1.5; color: ${COLORS.ink}; opacity: .8; }
.diaria-cta-modal[hidden] { display: none !important; }
.diaria-cta-modal {
  position: fixed; inset: 0; z-index: 2147483000;
  display: flex; align-items: center; justify-content: center; padding: 20px;
  background: rgba(23, 20, 17, .55); font-family: ${FONTS.sans};
}
.diaria-cta-modal-card {
  position: relative; width: 100%; max-width: 460px; box-sizing: border-box;
  background: ${COLORS.paper}; border-radius: 12px; padding: 28px 24px 24px;
  box-shadow: 0 18px 48px rgba(23, 20, 17, .28); max-height: 92vh; overflow-y: auto;
}
.diaria-cta-modal-card h2 {
  margin: 0 0 6px; font-family: ${FONTS.serif}; font-size: 23px; line-height: 1.25; color: ${COLORS.ink};
}
.diaria-cta-close {
  position: absolute; top: 8px; right: 8px; width: 36px; height: 36px;
  border: 0; background: transparent; cursor: pointer; font-size: 22px; line-height: 1;
  color: ${COLORS.ink}; opacity: .55; border-radius: 8px;
}
.diaria-cta-close:hover, .diaria-cta-close:focus-visible { opacity: 1; background: ${COLORS.paperAlt}; }
.signup { margin: 0; }
.signup .hp { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
.signup-label { display: block; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: ${COLORS.ink}; opacity: .65; margin-bottom: 6px; }
.signup-pill { display: flex; gap: 8px; flex-wrap: wrap; }
.signup-input {
  flex: 1 1 190px; min-width: 0; padding: 11px 13px; font-size: 15px; font-family: inherit;
  border: 1px solid ${COLORS.rule}; border-radius: 8px; background: ${COLORS.paperEmail}; color: ${COLORS.ink};
}
.signup-btn {
  flex: 0 0 auto; padding: 11px 18px; font-size: 15px; font-family: inherit; font-weight: 600;
  border: 0; border-radius: 8px; background: ${COLORS.ink}; color: ${COLORS.onInk}; cursor: pointer;
}
.signup-btn:disabled { opacity: .55; cursor: default; }
.signup-optin { display: flex; gap: 8px; align-items: flex-start; margin-top: 10px; font-size: 12.5px; line-height: 1.45; color: ${COLORS.ink}; opacity: .78; }
.signup-optin a { color: ${COLORS.brand}; }
.signup-status { margin: 8px 0 0; font-size: 12.5px; display: none; }
.signup-status.ok { color: ${COLORS.brand}; display: block; }
.signup-status.err { color: #B3261E; display: block; }
@media (max-width: 420px) { .signup-btn { flex: 1 1 100%; } }
</style>`;
}

/** Bloco do rodapé — HTML nativo, funciona sem JS. */
export function editionCtaFooter(): string {
  return `<aside class="diaria-cta-footer" aria-labelledby="diaria-cta-footer-title">
  <h2 id="diaria-cta-footer-title">Receba a próxima edição por e-mail</h2>
  <p class="diaria-cta-lede">Uma edição por dia útil, em 5 minutos de leitura. É de graça.</p>
  ${renderSignupForm({ id: "cta-rodape" })}
</aside>`;
}

/**
 * Modal. Nasce `hidden` — só o script o revela, e só depois do gatilho. Sem
 * JS ele permanece invisível para sempre, que é o comportamento correto.
 */
export function editionCtaModal(): string {
  return `<div class="diaria-cta-modal" id="diaria-cta-modal" role="dialog" aria-modal="true" aria-labelledby="diaria-cta-modal-title" hidden>
  <div class="diaria-cta-modal-card">
    <button type="button" class="diaria-cta-close" id="diaria-cta-close" aria-label="Fechar">&times;</button>
    <h2 id="diaria-cta-modal-title">Gostando da leitura?</h2>
    <p class="diaria-cta-lede">Receba a diar.ia.br todo dia útil, de graça. Cancele quando quiser.</p>
    ${renderSignupForm({ id: "cta-modal" })}
  </div>
</div>`;
}

/**
 * Script do modal. Só o GATILHO e o fechamento — o envio é do
 * `signupFormScript`, que conecta qualquer `form.signup` da página.
 */
export function editionCtaScript(): string {
  return `<script>
(function () {
  var modal = document.getElementById("diaria-cta-modal");
  if (!modal) return;

  // localStorage lança em janela privada / cookies bloqueados. O default em
  // QUALQUER erro é mostrar o modal — nunca deixar a página quebrar, e nunca
  // silenciar o convite por um detalhe de armazenamento.
  function jaDispensou() {
    try { return window.localStorage.getItem(${JSON.stringify(MODAL_DISMISSED_KEY)}) === "1"; }
    catch (e) { return false; }
  }
  function marcarDispensado() {
    try { window.localStorage.setItem(${JSON.stringify(MODAL_DISMISSED_KEY)}, "1"); } catch (e) {}
  }
  if (jaDispensou()) return;

  var focoAnterior = null;
  var aberto = false;

  function abrir() {
    if (aberto || jaDispensou()) return;
    aberto = true;
    focoAnterior = document.activeElement;
    modal.hidden = false;
    var input = modal.querySelector('input[type="email"]');
    if (input && typeof input.focus === "function") input.focus();
  }

  function fechar() {
    if (!aberto) return;
    aberto = false;
    modal.hidden = true;
    marcarDispensado();
    if (focoAnterior && typeof focoAnterior.focus === "function") focoAnterior.focus();
  }

  var botao = document.getElementById("diaria-cta-close");
  if (botao) botao.addEventListener("click", fechar);
  // Clique no fundo escuro fecha; clique DENTRO do card não.
  modal.addEventListener("click", function (ev) { if (ev.target === modal) fechar(); });
  document.addEventListener("keydown", function (ev) { if (ev.key === "Escape") fechar(); });

  // Assinou pelo modal: fecha sozinho e não volta. O envio é assíncrono, então
  // observa o status que o signupFormScript escreve, em vez do submit.
  var formModal = modal.querySelector("form.signup");
  var status = formModal && formModal.querySelector(".signup-status");
  if (status && typeof window.MutationObserver === "function") {
    new window.MutationObserver(function () {
      if (status.className.indexOf("ok") >= 0 && status.textContent.indexOf("Enviando") < 0) {
        setTimeout(fechar, 2500);
      }
    }).observe(status, { attributes: true, childList: true, subtree: true });
  }
  // Assinou pelo RODAPÉ antes de chegar aos 50%: não faz sentido pedir de novo.
  document.querySelectorAll("form.signup").forEach(function (f) {
    if (f === formModal) return;
    var st = f.querySelector(".signup-status");
    if (!st || typeof window.MutationObserver !== "function") return;
    new window.MutationObserver(function () {
      // A MESMA guarda de "Enviando" do observer do modal, e pela mesma razão:
      // signupFormScript chama setStatus("Enviando…", true) no INÍCIO do
      // envio, e esse true já grava a classe ok. Sem a guarda, clicar em
      // enviar marcava a dispensa na hora — mesmo que o envio falhasse por
      // rede, timeout ou 4xx. O leitor não assinava E perdia o convite para
      // sempre naquele navegador, em silêncio: é a falha desta PR inteira,
      // reproduzida no escopo de um visitante.
      if (st.className.indexOf("ok") >= 0 && st.textContent.indexOf("Enviando") < 0) marcarDispensado();
    }).observe(st, { attributes: true, childList: true, subtree: true });
  });

  function alturaRolavel() {
    var d = document.documentElement;
    var b = document.body;
    return Math.max(d.scrollHeight || 0, b ? b.scrollHeight || 0 : 0);
  }

  function verificar() {
    var vh = window.innerHeight || 0;
    var total = alturaRolavel();
    // Página curta: 50% chegaria quase junto com o load, e o modal voltaria a
    // ser o pop-up imediato que o gatilho existe para evitar.
    if (!vh || total < vh * ${MIN_PAGE_VIEWPORTS_FOR_MODAL}) return;
    var y = window.pageYOffset || document.documentElement.scrollTop || 0;
    if ((y + vh) / total >= ${MODAL_SCROLL_TRIGGER}) {
      abrir();
      window.removeEventListener("scroll", verificar);
    }
  }

  window.addEventListener("scroll", verificar, { passive: true });
  verificar();
})();
</script>`;
}

/**
 * Bloco completo pronto para injetar antes de `</body>` da página de edição.
 *
 * Ordem importa: estilos, rodapé, modal, script de envio, script do gatilho —
 * os dois scripts vêm por último para encontrarem os formulários já no DOM
 * (não há `DOMContentLoaded` em nenhum dos dois).
 */
export function editionCtaBlock(): string {
  return [
    editionCtaStyles(),
    editionCtaFooter(),
    editionCtaModal(),
    signupFormScript(),
    editionCtaScript(),
  ].join("\n");
}
