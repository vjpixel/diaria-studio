/**
 * #12604: a página de obrigado com os resultados publicados prometia "Também
 * mando o link para o seu e-mail.", mas o e-mail `form_resultados` não sai para
 * parte de quem responde (resposta anterior ao envio, pessoa fora de
 * `followup.people`, tag `envio-brevo`). O Worker não sabe qual é o caso, então
 * a página não promete e-mail nenhum; o link da edição especial fica na página.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderThanksHtml } from "../workers/onboarding-form/src/render.ts";

/** Só o texto visível: o CSS da página tem `input[type=email]`. */
function mainText(html: string): string {
  const m = html.match(/<main>([\s\S]*)<\/main>/);
  assert.ok(m, "página sem <main>");
  return m[1];
}

const RESULTS = { url: "https://x.example/especial", published_at: "2026-11-09T12:00:00.000Z" };

describe("#12604 copy da página de obrigado", () => {
  it("com resultados: mostra o link e não promete e-mail", () => {
    const html = mainText(renderThanksHtml(RESULTS));
    assert.ok(html.includes(`<a href="https://x.example/especial">Leia a edição especial</a>.`));
    assert.doesNotMatch(html, /e-?mail/i);
    assert.doesNotMatch(html, /\bmand(o|arei|amos)\b/i);
  });

  it("sem resultados: também não promete e-mail", () => {
    assert.doesNotMatch(mainText(renderThanksHtml(null)), /e-?mail/i);
  });
});
