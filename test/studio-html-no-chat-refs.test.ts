/**
 * test/studio-html-no-chat-refs.test.ts (#7050)
 *
 * O #6942 removeu o chat do Studio por inteiro (`chat-drawer.js/.css`,
 * `chat-badge.js`, `chat-hydration.js`, `gate-chat-bridge.js`,
 * `shared-event-source.js`, `studio-chat.ts`) — o gate voltou a ser só
 * terminal. A remoção corrigiu à mão as `<link>`/`<script>` das 13 páginas
 * HTML de `scripts/studio-ui/public/`, mas só `edicao.js` (via
 * `test/studio-edicao-page.test.ts`) e `revisao.js` (comentário em
 * `test/studio-review-server.test.ts`) tinham cobertura travando a
 * ausência — as outras 11 páginas dependiam só da correção manual do diff,
 * sem nada no CI pra pegar uma reintrodução acidental (merge malfeito
 * trazendo um asset velho de volta, ou um novo módulo de chat copiado por
 * engano de outro projeto).
 *
 * Este teste varre TODAS as páginas HTML do Studio de uma vez — mais barato
 * de manter que 13 asserções escritas à mão, e cobre página nova
 * automaticamente (sem precisar lembrar de adicionar o caso aqui).
 *
 * #7050 também introduziu `gate-badge.js` — o sucessor do `chat-badge.js`
 * removido, injetado via `nav.js` (não referenciado diretamente pelas
 * páginas HTML, então não precisa de allowlist aqui; se um dia passar a ser
 * referenciado direto por alguma página, o nome não bate em nenhum dos
 * padrões proibidos abaixo — `gate-badge` ≠ `chat-badge`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, "../scripts/studio-ui/public");

// Módulos do chat removidos no #6942 — nenhum deles deve ser referenciado
// por nenhuma página HTML do Studio nunca mais.
const FORBIDDEN_PATTERNS = [
  /chat-drawer(\.js|\.css)?/,
  /chat-badge/,
  /chat-hydration/,
  /gate-chat-bridge/,
  /shared-event-source/,
];

function listHtmlPages(): string[] {
  return readdirSync(PUBLIC_DIR)
    .filter((f) => f.endsWith(".html"))
    .sort();
}

describe("#7050: páginas HTML do Studio não referenciam módulos do chat removidos no #6942", () => {
  const pages = listHtmlPages();

  it("a varredura de fato encontra as páginas do Studio (guard contra path errado silenciando o teste)", () => {
    assert.ok(pages.length >= 10, `esperava >=10 páginas HTML em ${PUBLIC_DIR}, achou ${pages.length}`);
  });

  for (const page of pages) {
    it(`${page} não referencia chat-drawer/chat-badge/chat-hydration/gate-chat-bridge/shared-event-source`, () => {
      const body = readFileSync(join(PUBLIC_DIR, page), "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        assert.doesNotMatch(body, pattern, `${page} ainda referencia ${pattern} (chat removido no #6942)`);
      }
    });
  }
});
