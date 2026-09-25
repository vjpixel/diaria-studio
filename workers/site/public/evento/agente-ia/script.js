const checkoutUrl = window.EVENT_CHECKOUT_URL?.trim();
if (checkoutUrl && /^https:\/\//i.test(checkoutUrl)) {
  document.querySelectorAll(".checkout-link").forEach((link) => {
    link.href = checkoutUrl;
    link.hidden = false;
  });
  document.querySelectorAll(".checkout-pending").forEach((note) => {
    note.hidden = true;
  });
  const heroLink = document.querySelector(".hero-cta .button");
  if (heroLink) {
    heroLink.href = checkoutUrl;
    heroLink.innerHTML = 'Quero garantir meu ingresso <span aria-hidden="true">→</span>';
  }
}
