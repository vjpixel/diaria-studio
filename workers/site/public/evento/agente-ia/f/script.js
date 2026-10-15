// Botão flutuante da página /evento/agente-ia/f (cópia do da E), igual ao do guia: aparece depois
// de duas alturas de tela e some enquanto a oferta, o CTA final ou o rodapé estão
// visíveis. Checkout, eventos do pixel e rolagem ficam no script comum
// (/evento/agente-ia/script.js), que lê data-variante="f".
const floatCta = document.querySelector(".float-cta");
if (floatCta) {
  floatCta.hidden = false;
  const blockers = ["#oferta", "#cta-final", ".site-footer"].map((sel) => document.querySelector(sel)).filter(Boolean);
  const onScreen = (el) => {
    const r = el.getBoundingClientRect();
    return r.top < window.innerHeight && r.bottom > 0;
  };
  const update = () => {
    const show = window.scrollY > window.innerHeight * 2 && !blockers.some(onScreen);
    floatCta.classList.toggle("is-visible", show);
    floatCta.setAttribute("aria-hidden", show ? "false" : "true");
    floatCta.tabIndex = show ? 0 : -1;
  };
  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update, { passive: true });
  // #10217: passa pelo track() do script comum (carregado antes, também com
  // defer): o evento sai como CliqueFlutuante_F com origem/utm_campaign/
  // utm_content (#10079) e respeita o modo interno (#10080). Chamar o fbq
  // direto mandava o evento sem a origem da visita.
  floatCta.addEventListener("click", () => {
    if (typeof track === "function") track("CliqueFlutuante");
  });
  update();
}
