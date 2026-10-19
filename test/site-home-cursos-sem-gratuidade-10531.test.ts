/**
 * test/site-home-cursos-sem-gratuidade-10531.test.ts (#10531)
 *
 * A #10506 removeu a promessa de gratuidade dos cursos (badge, lede, FAQ,
 * link da confirmação), mas o card "Cursos sobre IA" da home seguiu dizendo
 * "a maioria gratuita" — ao lado do link da aula paga da diar.ia.br.
 * Decisão do editor (briefing 261019d): remover a frase.
 *
 * Trava os dois lados: o gerador (`buildIndexHtml`) e o `index.html`
 * COMMITTED, que é o que de fato vai pro ar (deploy automático em push de
 * `workers/site/**`). Gerador certo com o arquivo servido desatualizado
 * serviria a home velha.
 *
 * Escopo: só o card de cursos. "Gratuita" sobre a NEWSLETTER (FAQ "É
 * realmente gratuita?", aria-label do formulário) é outra promessa,
 * verdadeira, e fica.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndexHtml } from "../scripts/lib/site-home-page.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const INDEX_PATH = resolve(ROOT, "workers", "site", "public", "index.html");

const FEATURE = {
  slug: "exemplo",
  title: "Título de exemplo",
  description: "Descrição de exemplo",
  url: "https://diar.ia.br/p/exemplo",
  date: "2026-08-28",
  image: null,
};

/** Recorta o card de cursos (do título até o botão "Ver todos os cursos"). */
function cursosCard(html: string): string {
  const start = html.indexOf("Cursos <span");
  const end = html.indexOf("Ver todos os cursos", start);
  assert.ok(start >= 0 && end > start, "card de cursos não encontrado na home");
  return html.slice(start, end);
}

const SOURCES: Array<[string, () => string]> = [
  ["gerador (buildIndexHtml)", () => buildIndexHtml({ feature: FEATURE, archive: [] })],
  ["index.html committed", () => readFileSync(INDEX_PATH, "utf8")],
];

describe("home — card de cursos sem promessa de gratuidade (#10531)", () => {
  for (const [label, load] of SOURCES) {
    it(`${label}: não diz "a maioria gratuita"`, () => {
      const html = load();
      assert.ok(!/maioria gratuit/i.test(html), `${label} ainda contém "a maioria gratuita"`);
    });

    it(`${label}: card de cursos não promete gratuidade`, () => {
      const card = cursosCard(load());
      assert.ok(!/gratuit|gr[aá]tis/i.test(card), `${label}: card de cursos promete gratuidade`);
      // A frase sobrevivente segue no card (remoção cirúrgica, não do parágrafo).
      assert.ok(card.includes("Selecionados entre os melhores cursos sobre IA. Atualizamos toda semana."));
    });
  }
});
