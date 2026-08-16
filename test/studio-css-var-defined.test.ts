/**
 * test/studio-css-var-defined.test.ts (#5480)
 *
 * Trava a invariante: **todo `var(--token)` usado no CSS de tela do Studio
 * referencia um token que existe de fato.**
 *
 * **Por que existe.** O badge "Fora de rodada" da Triagem shipou ilegível
 * (contraste medido de 1,22:1, contra 4,5:1 do mínimo WCAG AA pra texto
 * pequeno) porque a regra era
 * `color: var(--fg-dim, var(--rule))` — e `--fg-dim` **nunca existiu neste
 * repo**. A única ocorrência do nome era essa própria linha. Como CSS não
 * reclama de variável indefinida, o fallback `--rule` (cor de linha
 * divisória, #EBE5D0) valia 100% das vezes, e o resultado foi texto
 * quase invisível sobre o papel.
 *
 * Esse é o modo de falha mais traiçoeiro do CSS custom property: um typo ou
 * um nome inventado não quebra nada — degrada em silêncio, e só aparece
 * quando alguém olha a tela e diz "está difícil de ler". `tsc` não vê CSS,
 * `studio-css-no-raw-hex` só proíbe hex literal (a linha ruim passava nele,
 * justamente por usar `var()`), e não há linter de CSS no repo.
 *
 * **O fallback não é desculpa.** Um `var(--x, algo)` com `--x` inexistente é
 * indistinguível de código morto: o fallback é o único caminho que roda. Se a
 * intenção é usar `algo`, escreva `algo`. Por isso o teste checa o nome
 * PRINCIPAL mesmo quando há fallback.
 *
 * @see scripts/studio-ui/public/triagem.css (`.dispatch-fora-de-rodada`)
 * @see test/studio-css-no-raw-hex.test.ts (invariante irmã, #4674)
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stripCssComments as stripComments } from "./helpers/css.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = join(ROOT, "scripts", "studio-ui", "public");

/** Tokens gerados em runtime por `tokens-css.ts` e servidos como
 * `/tokens.generated.css` — não existem como arquivo em `public/`, então
 * precisam ser lidos da fonte. */
function generatedTokenNames(): Set<string> {
  const src = readFileSync(join(ROOT, "scripts", "studio-ui", "tokens-css.ts"), "utf8");
  return new Set([...src.matchAll(/--([a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]));
}

/** Tokens definidos em RUNTIME pelo JS do painel, via
 * `element.style.setProperty("--x", …)`. São tão reais quanto os do CSS — o
 * `--chat-viewport-height` (#3851) é o caso vivo: só existe enquanto o
 * `visualViewport` está disponível, e o CSS declara fallback pro resto. */
function setViaJs(): Set<string> {
  const names = new Set<string>();
  for (const f of readdirSync(PUBLIC_DIR).filter((n) => n.endsWith(".js"))) {
    const js = readFileSync(join(PUBLIC_DIR, f), "utf8");
    for (const m of js.matchAll(/setProperty\(\s*["'`]--([a-zA-Z0-9-]+)/g)) names.add(m[1]);
  }
  return names;
}

/** Tokens declarados diretamente em qualquer CSS de `public/` (`:root`,
 * `[data-theme]`, ou escopados numa classe). */
function declaredInCss(files: string[]): Set<string> {
  const names = new Set<string>();
  for (const f of files) {
    const css = stripComments(readFileSync(join(PUBLIC_DIR, f), "utf8"));
    for (const m of css.matchAll(/(^|[;{\s])--([a-zA-Z0-9-]+)\s*:/g)) names.add(m[2]);
  }
  return names;
}

/** Nome PRINCIPAL de cada `var(...)` — o que vem antes da vírgula do
 * fallback. É exatamente o que precisa existir: se só o fallback funciona, o
 * nome principal é ficção. */
function usedTokens(css: string): Array<{ name: string; line: number }> {
  const out: Array<{ name: string; line: number }> = [];
  stripComments(css).split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/var\(\s*--([a-zA-Z0-9-]+)/g)) {
      out.push({ name: m[1], line: i + 1 });
    }
  });
  return out;
}

describe("CSS do Studio — todo var(--token) referencia token existente (#5480)", () => {
  const files = readdirSync(PUBLIC_DIR).filter((f) => f.endsWith(".css"));

  it("há arquivos CSS pra checar (guarda contra o teste virar no-op)", () => {
    assert.ok(files.length > 0, "nenhum .css encontrado em public/ — o teste não estaria checando nada");
  });

  it("nenhum token indefinido em nenhum arquivo", () => {
    const defined = new Set([...generatedTokenNames(), ...declaredInCss(files), ...setViaJs()]);
    assert.ok(defined.has("ink"), "sanity: --ink deveria estar entre os tokens conhecidos");

    const orfaos: string[] = [];
    for (const f of files) {
      const css = readFileSync(join(PUBLIC_DIR, f), "utf8");
      for (const { name, line } of usedTokens(css)) {
        if (!defined.has(name)) orfaos.push(`${f}:${line} → var(--${name})`);
      }
    }

    assert.deepEqual(
      orfaos,
      [],
      `token(s) referenciado(s) mas nunca declarado(s) — CSS não reclama, degrada em silêncio:\n  ${orfaos.join("\n  ")}`,
    );
  });
});
