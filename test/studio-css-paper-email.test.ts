/**
 * test/studio-css-paper-email.test.ts — regressão do bug de dark mode em que
 * superfícies de "chrome" do Studio (`.panel`, `.contact-card`, `.chat-drawer`)
 * pintavam o fundo com `--paper-email` (#FFFFFF, o token do fundo de E-MAIL,
 * deliberadamente NÃO invertido no bloco `@media (prefers-color-scheme: dark)`
 * de tokens-css.ts — ver #3876). Em dark mode o fundo ficava branco enquanto
 * `--ink` virava claro → texto claro sobre fundo claro = invisível.
 *
 * `--paper-email` é exclusivo do render de e-mail (newsletter), NÃO das telas
 * do Studio. Qualquer fundo de superfície do Studio deve usar um token
 * dark-aware (`--paper` / `--paper-alt`), que o bloco @media inverte. Este
 * teste trava isso: nenhum CSS servido em `scripts/studio-ui/public/` pode
 * referenciar `--paper-email`.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PUBLIC_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "scripts",
  "studio-ui",
  "public",
);

describe("Studio public CSS — dark mode (#3876)", () => {
  it("nenhum CSS de tela usa --paper-email (token de e-mail, não invertido no dark)", () => {
    const cssFiles = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".css"));
    assert.ok(cssFiles.length > 0, "esperava encontrar CSS em public/");

    const offenders: string[] = [];
    for (const file of cssFiles) {
      const content = readFileSync(join(PUBLIC_DIR, file), "utf-8");
      if (content.includes("--paper-email")) offenders.push(file);
    }

    assert.deepEqual(
      offenders,
      [],
      `--paper-email não deve aparecer em CSS de tela do Studio (quebra o dark ` +
        `mode: fundo branco fixo + texto claro). Use --paper/--paper-alt. ` +
        `Arquivos infratores: ${offenders.join(", ")}`,
    );
  });
});
