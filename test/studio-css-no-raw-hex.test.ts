/**
 * test/studio-css-no-raw-hex.test.ts (#4674) — regressão pro cleanup de hex
 * crus fora do sistema de tokens (`scripts/studio-ui/public/*.css`).
 *
 * Trava a invariante: nenhum arquivo CSS de tela do Studio declara cor via
 * hex literal em `color`/`background`/`border-color`/`fill`/`stroke`, exceto
 * um allowlist explícito e documentado (hoje só `revisao.css:140` — fundo
 * branco fixo do iframe de preview de e-mail, intencional por R17 de
 * `docs/studio-ui-ux-guidelines.md`, não deve seguir `--paper` do chrome do
 * Studio). `rgba()`/`color-mix()` de sombra/overlay não são cobertos aqui
 * (não são "cor de token", são efeito translúcido — ver issue #4674).
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

/** file -> hex literals explicitamente permitidos ali (lowercase, sem #). */
const ALLOWLIST: Record<string, string[]> = {
  "revisao.css": ["fff"],
};

const HEX_COLOR_DECL = /(?:^|[^-\w])(color|background|background-color|border-color|fill|stroke)\s*:\s*[^;]*#([0-9a-fA-F]{3,8})\b/g;

describe("Studio public CSS — sem hex cru fora do allowlist (#4674)", () => {
  it("toda declaração color/background/border-color/fill/stroke usa var(--token), exceto o allowlist documentado", () => {
    const cssFiles = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".css"));
    assert.ok(cssFiles.length > 0, "esperava encontrar CSS em public/");

    const offenders: string[] = [];
    for (const file of cssFiles) {
      const content = readFileSync(join(PUBLIC_DIR, file), "utf-8");
      const allowed = new Set((ALLOWLIST[file] ?? []).map((h) => h.toLowerCase()));
      for (const match of content.matchAll(HEX_COLOR_DECL)) {
        const hex = match[2].toLowerCase();
        if (allowed.has(hex)) continue;
        offenders.push(`${file}: ${match[0].trim()}`);
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `Hex cru fora do allowlist em CSS de tela do Studio — use var(--token) ` +
        `de /tokens.generated.css (scripts/studio-ui/tokens-css.ts). Se for ` +
        `intencional, documentar e adicionar ao ALLOWLIST deste teste.\n` +
        offenders.join("\n"),
    );
  });
});
