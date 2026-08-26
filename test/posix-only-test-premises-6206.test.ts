/**
 * test/posix-only-test-premises-6206.test.ts (#6206)
 *
 * Guard mecânico contra as duas premissas POSIX que custaram 52 falhas na
 * máquina Windows do editor — nenhuma delas defeito de produção, todas do
 * próprio teste assumindo o SO onde roda.
 *
 * O #6206 consertou as ocorrências existentes. Este arquivo impede que voltem:
 * o custo real não foi consertar, foi as 52 falhas terem tornado `npm test`
 * inútil como sinal por semanas (exit code sempre 1, "quebrei algo" e "é o de
 * sempre" indistinguíveis).
 *
 * Escopo deliberadamente estreito — só os dois padrões com causa raiz medida e
 * conserto mecânico óbvio. Não é um lint de portabilidade geral: um guard que
 * acusa demais vira ruído e alguém o desliga.
 *
 * @see test/clarice-via-links.test.ts — mesma forma de varredura repo-wide
 * @see test/_helpers/spawn-npx.ts — a terceira causa (`npx` no Windows), que
 *   tem helper próprio em vez de guard aqui
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Este arquivo se exclui da varredura: as regexes de `PREMISES` contêm, por
 * necessidade, os próprios padrões que procuram. Sem isso o guard acusa a si
 * mesmo e nunca fica verde.
 */
const SELF = relative(ROOT, fileURLToPath(import.meta.url));

/** Árvores varridas — onde código nosso vive. */
const ROOTS = ["test", "scripts", "workers"];

/** Nunca contêm código nosso. */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".wrangler"]);

/** Podado por CAMINHO, não por nome — mesmo racional de `clarice-via-links`. */
const SKIP_PATHS = new Set([join(".claude", "worktrees")]);

interface Premise {
  /** Nome curto do padrão, usado na mensagem de falha. */
  readonly nome: string;
  readonly pattern: RegExp;
  /** O que fazer em vez disso. */
  readonly conserto: string;
  /** Por que o padrão quebra — vai junto na mensagem, pra não exigir arqueologia. */
  readonly porque: string;
}

const PREMISES: readonly Premise[] = [
  {
    nome: "new URL(import.meta.url).pathname",
    pattern: /new URL\(\s*import\.meta\.url\s*\)\.pathname/,
    conserto: "fileURLToPath(import.meta.url)",
    porque:
      "no Windows o pathname de uma file URL vem com barra ANTES da letra do drive " +
      "(`/C:/Users/...`); `resolve` sobre isso produz caminho inexistente e o spawn " +
      "falha em silêncio, com o teste comparando o `status: null` do spawn frustrado " +
      "contra o exit code esperado",
  },
  {
    nome: 'PATH fatiado/juntado por ":" fixo',
    pattern: /\bPATH\b[^\n]{0,40}?\.(?:split|join)\(\s*":"\s*\)/,
    conserto: 'path.delimiter (`;` no Windows, `:` em POSIX)',
    porque:
      "fatiar o PATH por `:` no Windows devolve UMA entrada gigante — filtros não " +
      "removem nada e varreduras não encontram nada; em `sync-env` isso fazia o " +
      "subprocesso rodar a sincronização REAL (rede + escrita de `.env`) num teste " +
      "que existia justamente pra impedir isso",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (SKIP_PATHS.has(join(dir, e.name))) continue;
      out.push(...walk(join(dir, e.name)));
    } else if (extname(e.name) === ".ts") {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

describe("premissas POSIX-only não voltam pro repo (#6206)", () => {
  const arquivos = ROOTS.flatMap(walk);

  // Sanity: se um ROOT sumir num refactor, a varredura não pode virar conjunto
  // vazio silencioso — um guard que não varre nada passa para sempre.
  it("a varredura de fato encontra arquivos (guard não vira no-op)", () => {
    assert.ok(
      arquivos.length > 500,
      `esperava centenas de .ts nas ROOTS ${ROOTS.join(", ")}, achei ${arquivos.length} — ` +
        "ROOT renomeado? o guard estaria passando sem varrer nada",
    );
  });

  for (const premise of PREMISES) {
    it(`nenhum arquivo usa ${premise.nome}`, () => {
      const violacoes = arquivos
        .filter((f) => f !== SELF)
        .filter((f) => premise.pattern.test(readFileSync(join(ROOT, f), "utf8")));

      assert.deepEqual(
        violacoes.map((f) => relative(".", f)),
        [],
        `${premise.nome}: use ${premise.conserto} — ${premise.porque}. ` +
          `Se este caso for genuinamente POSIX-only, declare \`skip\` com o motivo ` +
          `em vez de deixar falhar (direção 1 do #6206).`,
      );
    });
  }
});
