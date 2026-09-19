/**
 * test/report-kind-exhaustiveness-8409.test.ts (#8409)
 *
 * Regressão do "guard que não guardava": `scripts/studio-ui/studio-reports.ts`
 * tinha um comentário prometendo que um membro novo de `ReportKind` ausente
 * de `VALID_KINDS` quebrava o build, e o mecanismo era
 * `Object.fromEntries(...) as Record<ReportKind, true>` — uma ASSERÇÃO de
 * tipo, que o TS aceita com qualquer conteúdo. O build passava, e em runtime
 * `isReportKind()` rejeitava o kind novo fazendo `registerReport` descartar
 * o relatório em silêncio.
 *
 * O teste é escrito pra DISCRIMINAR: compila com `tsc --strict` o padrão
 * ANTIGO e o padrão NOVO lado a lado, com a mesma divergência introduzida, e
 * exige que o antigo compile (o furo, reproduzido) e o novo NÃO compile. Um
 * "guard" novo que não fizesse nada falharia no caso 2 — que é o ponto.
 *
 * O caso 3 amarra o mecanismo ao arquivo REAL (kind fora da lista canônica
 * não compila contra o `ReportKind` exportado) — é uma amarra de sanidade,
 * não o discriminador: ele também passava com o código antigo, porque o kind
 * do fixture não estava em NENHUM dos dois lados. Quem discrimina o arquivo
 * real é o caso 4, que trava a forma da fonte única (o tipo é derivado da
 * lista) e falha de fato contra a versão anterior deste módulo — verificado
 * ao vivo: com o arquivo revertido, 3 passa e 4 falha.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const SOURCE = join(REPO_ROOT, "scripts/studio-ui/studio-reports.ts");

/**
 * Compila um único arquivo com `tsc --strict` isolado num tmpdir. Devolve
 * `null` se compilou limpo, ou a saída do compilador quando falhou.
 * `makeSource` recebe o diretório do fixture, pra montar import relativo.
 */
function compile(makeSource: string | ((dir: string) => string)): string | null {
  const dir = mkdtempSync(join(tmpdir(), "kind-exh-"));
  const file = join(dir, "fixture.ts");
  writeFileSync(file, typeof makeSource === "string" ? makeSource : makeSource(dir), "utf-8");
  try {
    execFileSync(
      process.execPath,
      [
        join(REPO_ROOT, "node_modules/typescript/lib/tsc.js"),
        "--noEmit",
        "--strict",
        "--target",
        "ES2022",
        "--module",
        "ESNext",
        "--moduleResolution",
        "Bundler",
        "--allowImportingTsExtensions",
        "--skipLibCheck",
        file,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return null;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}` || "tsc falhou sem saída";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("exaustividade de ReportKind (#8409)", () => {
  it("1. o padrão ANTIGO (Object.fromEntries + as) compila mesmo divergente — o furo que a issue reporta", () => {
    const out = compile(`
type ReportKind = "a" | "b" | "c";
const VALID_KINDS: ReportKind[] = ["a", "b"]; // falta "c" de propósito
const _KIND_EXHAUSTIVENESS: Record<ReportKind, true> = Object.fromEntries(
  VALID_KINDS.map((k) => [k, true]),
) as Record<ReportKind, true>;
void _KIND_EXHAUSTIVENESS;
`);
    assert.equal(
      out,
      null,
      "o padrão antigo deveria compilar apesar da divergência — se passou a falhar, este teste perdeu o poder de discriminar e precisa ser reescrito",
    );
  });

  it("2. o padrão NOVO (tipo derivado da lista) rejeita o kind que não está na lista", () => {
    const out = compile(`
const VALID_KINDS = ["a", "b"] as const;
type ReportKind = (typeof VALID_KINDS)[number];
const novo: ReportKind = "c"; // kind que alguém "adicionou" sem tocar na lista
void novo;
`);
    assert.notEqual(out, null, "divergência deveria quebrar o build sob o padrão novo");
    assert.match(String(out), /not assignable to type/);
  });

  it("3. contra o módulo REAL: kind fora da lista canônica não compila", () => {
    const out = compile((dir) => {
      const importPath = relative(dir, SOURCE).replaceAll("\\", "/");
      return `
import type { ReportKind } from ${JSON.stringify(importPath)};
const ok: ReportKind = "overnight";
const quebrado: ReportKind = "kind-que-nao-existe";
void ok;
void quebrado;
`;
    });
    assert.notEqual(out, null, "kind inexistente deveria quebrar o build contra o ReportKind real");
    assert.match(String(out), /kind-que-nao-existe/);
  });

  it("4. a fonte única continua sendo a lista — o tipo é derivado dela", () => {
    const src = readFileSync(SOURCE, "utf-8");
    assert.match(
      src,
      /const VALID_KINDS = \[[\s\S]*?\] as const;/,
      "VALID_KINDS precisa ser um array `as const` (fonte única dos kinds)",
    );
    assert.match(
      src,
      /export type ReportKind = \(typeof VALID_KINDS\)\[number\];/,
      "ReportKind precisa ser DERIVADO de VALID_KINDS — re-declarar a união como literal reabre o furo do #8409",
    );
  });
});
