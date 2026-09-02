/**
 * artigo-especial-gate-cta.ts (#7030)
 *
 * Bloco de convite ao fim do teaser dos Artigos Especiais — as DUAS saídas
 * que a issue #7030 pede explicitamente: quem já apoia confirma o e-mail
 * (`/gate?article=`), quem não apoia vai pro apoia.se. Nunca um 403/parede —
 * convite, não bloqueio (mesmo espírito do `workers/cursos`, ver
 * `workers/cursos/src/gate-page.ts`).
 *
 * Em `lib/shared/` (não em `workers/artigos/src/`) porque os DOIS
 * consumidores vivem em lados opostos da fronteira scripts↔workers:
 * `scripts/build-artigo-especial-teaser.ts` (Node, embute o HTML no teaser
 * committed) e, potencialmente, `workers/artigos/src/index.ts` (runtime) —
 * a convenção do repo é workers importarem de `scripts/lib/shared/`, nunca o
 * inverso (ver `workers/cursos/src/*.ts`).
 *
 * Texto do limiar ("a partir de R$10/mês") é deliberadamente vago sobre
 * QUAL(is) nível(is) do custom field `apoio_nivel` mapeiam pra isso — essa
 * correspondência é o item explicitamente deixado em aberto pela issue (ver
 * `workers/artigos/src/apoio-gate-config.ts`). O texto aqui não muda
 * dependendo da resposta.
 */
export function renderGateCta(articleSlug: string): string {
  return `
<div class="especial-gate-cta" style="max-width:42rem;margin:2.5rem auto 0;padding:1.75rem 1.5rem;border-top:1px solid #EBE5D0;background:linear-gradient(to bottom, transparent, #FBFAF6 40%);position:relative;">
  <div aria-hidden="true" style="position:absolute;top:-4.5rem;left:0;right:0;height:4.5rem;background:linear-gradient(to bottom, transparent, #FBFAF6);pointer-events:none;"></div>
  <p style="font-family:Georgia,serif;font-size:1.15rem;font-weight:600;margin:0 0 0.6rem;">O resto deste Artigo Especial é pra quem apoia a diar.ia.br.</p>
  <p style="font-size:0.95rem;line-height:1.55;margin:0 0 1.25rem;">A partir de R$10/mês de apoio, o Artigo Especial mensal sai completo — texto inteiro, mais aprofundado, com acesso a todo o histórico já publicado.</p>
  <div style="display:flex;gap:0.75rem;flex-wrap:wrap;">
    <a href="https://apoia.se/diaria" style="display:inline-block;padding:0.7rem 1.2rem;background:#00A0A0;color:#FFFFFF;border-radius:6px;font-size:0.9rem;font-weight:700;text-decoration:none;">Apoiar a partir de R$10/mês</a>
    <a href="/gate?article=${encodeURIComponent(articleSlug)}" style="display:inline-block;padding:0.7rem 1.2rem;border:1px solid #EBE5D0;color:#171411;border-radius:6px;font-size:0.9rem;font-weight:700;text-decoration:none;">Já apoio — confirmar e-mail</a>
  </div>
</div>`;
}
