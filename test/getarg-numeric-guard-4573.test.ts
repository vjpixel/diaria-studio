/**
 * test/getarg-numeric-guard-4573.test.ts (#4573)
 *
 * Fronteira lint-enforced (mesmo molde de `test/lib-boundary.test.ts`, #2747:
 * grep estrutural sobre os arquivos do repo, sem executar nada) contra o
 * padrão que já causou 3 incidentes de produção (ver docstring de
 * `getArg` em `scripts/lib/cli-args.ts`): `getArg` devolve `""` tanto quando a
 * flag está AUSENTE quanto quando está PRESENTE mas vazia/sem valor — passar
 * esse `""` direto pra `Number(...)`/`parseInt(...)`/`parseFloat(...)` sem
 * nenhuma proteção produz `0`/`NaN` em silêncio.
 *
 * Escopo desta issue (decisão do editor, comentário 260804): só barrar o
 * padrão NUMÉRICO desprotegido — não migrar os 118 call sites de `getArg`
 * existentes, nem barrar todo uso futuro de `getArg` em geral (esse último
 * ficou registrado na issue como direção futura, mas o mecanismo CONCRETO
 * pedido — e o único implementado aqui — é este grep).
 *
 * Allowlist: os 4 call sites já identificados no levantamento da issue como
 * "protegidos por acidente" pelo `||` (o `""` cai no branch falsy do `||` e
 * vira o default numérico declarado) — ficam de fora do escopo de migração
 * desta issue, mas não podem quebrar este teste. Qualquer OUTRA ocorrência
 * do padrão (nova ou pré-existente não catalogada) falha o teste — força a
 * migração pra `getIntArg` (que distingue ausente de inválido, #4497) ou uma
 * adição CONSCIENTE + justificada a esta allowlist.
 *
 * Não cobre `workers/` — `getArg`/`cli-args.ts` é um parser de CLI args
 * (`process.argv`), não usado em Workers (sem argv de shell no runtime
 * Cloudflare); confirmado por grep antes de escrever este teste.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");

/** Lista .ts recursivamente sob um diretório (retorna [] se não existe). */
function tsFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: false })
    .map(String)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
}

/** Padrão perigoso: Number/parseInt/parseFloat envolvendo getArg( diretamente. */
const DANGEROUS_RE = /\b(?:Number|parseInt|parseFloat)\(\s*getArg\(/g;

export interface DangerousMatch {
  /** Path relativo ao root do repo, POSIX (/ sempre, mesmo no Windows — allowlist estável entre SOs). */
  file: string;
  line: number;
}

/**
 * Substitui todo comentário de bloco (`/* ... *\/`, inclusive JSDoc `/** ... *\/`)
 * por espaços (preserva quebras de linha — cada `\n` interno vira `\n`, o
 * resto vira ` ` — pra números de linha do restante do arquivo não
 * desalinharem). Usado ANTES do scan de linha — várias docstrings do repo
 * citam o padrão perigoso em prosa histórica dentro de bloco JSDoc (ex: a
 * própria docstring `@deprecated` de `getArg`), sem ser código de verdade.
 */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (block) =>
    block
      .split("\n")
      .map((line) => " ".repeat(line.length))
      .join("\n"),
  );
}

/**
 * Pura — varre `dir` recursivamente e devolve toda ocorrência do padrão
 * perigoso, IGNORANDO ocorrências dentro de comentário de bloco (`/* *\/`,
 * `/** *\/`) e de comentário de linha (`//`) — várias docstrings do repo
 * citam o padrão antigo em prosa histórica ("antes: Number(getArg(...)) || 0")
 * sem ser código de verdade. Heurística pra `//`: se aparece na linha ANTES
 * do início do match, é comentário.
 */
export function findDangerousGetArgUsages(dir: string): DangerousMatch[] {
  const found: DangerousMatch[] = [];
  for (const file of tsFilesUnder(dir)) {
    const rawSrc = readFileSync(file, "utf8");
    const src = stripBlockComments(rawSrc);
    const lines = src.split("\n");
    const relFile = file.slice(ROOT.length + 1).split("\\").join("/");
    lines.forEach((lineText, idx) => {
      DANGEROUS_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = DANGEROUS_RE.exec(lineText))) {
        const commentIdx = lineText.indexOf("//");
        if (commentIdx !== -1 && commentIdx < m.index) continue; // dentro de comentário de linha — não é código real
        found.push({ file: relFile, line: idx + 1 });
      }
    });
  }
  return found;
}

/**
 * Allowlist EXPLÍCITA (#4573) — os 4 call sites já catalogados como
 * protegidos por acidente pelo `||` no levantamento da issue. Fora de escopo
 * migrar agora; não devem quebrar este teste. Qualquer entrada nova aqui
 * precisa de justificativa equivalente (grep confirma que o `||` realmente
 * protege o caso `""`).
 */
const ALLOWLIST: readonly DangerousMatch[] = [
  { file: "scripts/clarice-sync-brevo.ts", line: 422 }, // #4722: linha deslocada de novo (união discriminada + limit/transaction de OpensCatchupDeps inseriram código acima)
  { file: "scripts/clarice-engagement-cohorts.ts", line: 552 },
  // #4451 follow-up (fleet review #4479 achado 4): a entrada da linha 648
  // (--refetch-window-days) foi MIGRADA pra getIntArg neste PR — "se sumiu,
  // ótimo, remova a entrada" (comentário original desta allowlist). Só
  // --concurrency (abaixo) continua no padrão antigo, fora de escopo aqui —
  // linha deslocada de 639→671 pelo comentário/import novos acima dela.
  { file: "scripts/clarice-engagement-cohorts-v2.ts", line: 671 },
] as const;

function isAllowlisted(m: DangerousMatch): boolean {
  return ALLOWLIST.some((a) => a.file === m.file && a.line === m.line);
}

describe("guard estrutural: Number/parseInt/parseFloat(getArg(...)) sem proteção (#4573)", () => {
  it("scripts/ não introduz NENHUMA ocorrência nova do padrão perigoso fora da allowlist", () => {
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    const unlisted = found.filter((m) => !isAllowlisted(m));
    assert.deepEqual(
      unlisted,
      [],
      `Number/parseInt/parseFloat(getArg(...)) sem proteção fora da allowlist — migre pra getIntArg ` +
        `(distingue ausente de inválido, #4497) ou adicione à ALLOWLIST em test/getarg-numeric-guard-4573.test.ts ` +
        `com justificativa (o \`||\` protege de verdade o caso ""):\n  ${unlisted.map((m) => `${m.file}:${m.line}`).join("\n  ")}`,
    );
  });

  it("sanity: a allowlist inteira ainda é encontrada pelo scan (senão o regex/heurística de comentário quebrou e o guard ficou cego)", () => {
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    for (const allowed of ALLOWLIST) {
      assert.ok(
        found.some((m) => m.file === allowed.file && m.line === allowed.line),
        `allowlist espera achar ${allowed.file}:${allowed.line} — se o código mudou de linha, atualize a allowlist; se sumiu, ótimo, remova a entrada`,
      );
    }
  });

  it("sanity: comentários de LINHA (//) que citam o padrão em prosa (histórico) NÃO contam como violação", () => {
    // Confirma que a heurística de comentário funciona de verdade (não é só
    // sorte de nenhum comentário existir hoje) — os 2 arquivos abaixo citam
    // o padrão antigo em comentário `//`, sem ser código real.
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    assert.ok(
      !found.some((m) => m.file === "scripts/clarice-build-waves-store.ts"),
      "comentário histórico em clarice-build-waves-store.ts não deveria contar",
    );
    assert.ok(
      !found.some((m) => m.file === "scripts/cohort-order-dryrun.ts"),
      "comentário histórico em cohort-order-dryrun.ts não deveria contar",
    );
  });

  it("sanity: comentário de BLOCO/JSDoc que cita o padrão em prosa NÃO conta — ex: a própria docstring @deprecated de getArg", () => {
    // scripts/lib/cli-args.ts tem a docstring @deprecated de getArg (#4573)
    // citando literalmente "Number(getArg(...))"/"parseInt(getArg(...))" em
    // prosa — sem stripBlockComments, o próprio guard se auto-violaria.
    const found = findDangerousGetArgUsages(SCRIPTS_DIR);
    assert.ok(
      !found.some((m) => m.file === "scripts/lib/cli-args.ts"),
      "docstring JSDoc de getArg (block comment) não deveria contar como violação",
    );
  });
});
