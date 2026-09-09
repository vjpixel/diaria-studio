/**
 * test/session-id-required-subcommands.test.ts (#7836)
 *
 * Trava `scripts/lib/session-id-required-subcommands.ts` (a lista que
 * `.claude/hooks/inject-session-id.mjs` importa pra montar
 * `INJECTABLE_SUBCOMMANDS`) contra o código REAL de `main()` em
 * `scripts/lib/session-registry.ts` — sem isso, a lista compartilhada só
 * resolve o problema de "duas listas divergentes" (#6317/#6334/#7836); não
 * impede uma 4ª ocorrência em que alguém adiciona um `case` novo que chama
 * `requireSessionId(values)` e esquece de adicionar o nome também no
 * módulo compartilhado.
 *
 * Duas checagens, nas duas direções (ver docblock de
 * `session-id-required-subcommands.ts` pro porquê de não ser 100%
 * mecânico nas DUAS pontas — `is-claimed`/`conflicts` são exceções
 * documentadas, não bugs deste teste):
 *
 *   1. Todo `case "X":` do switch que chama `requireSessionId(values)`
 *      tem `"X"` presente em `SESSION_ID_REQUIRED_SUBCOMMANDS` — pega a
 *      classe de omissão da issue (subcomando novo, lista esquecida).
 *      Mecânico e sem ambiguidade: `requireSessionId(values)` é sempre
 *      "lança se faltar", nunca opcional.
 *   2. Todo membro de `SESSION_ID_REQUIRED_SUBCOMMANDS` corresponde a um
 *      `case "X":` que de fato existe no switch — pega o typo/renomeação
 *      inversa (nome sobra na lista depois que o subcomando foi removido
 *      ou renomeado em `session-registry.ts`).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SESSION_ID_REQUIRED_SUBCOMMANDS } from "../scripts/lib/session-id-required-subcommands.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const registryPath = join(__dirname, "..", "scripts", "lib", "session-registry.ts");
const registrySource = readFileSync(registryPath, "utf8");

/**
 * Extrai o corpo de `function main(): void { ... }` — restringe a busca ao
 * switch da CLI, nunca a helpers do módulo que possam mencionar
 * `requireSessionId` fora de um `case`.
 */
function extractMainBody(source: string): string {
  const start = source.indexOf("function main(): void {");
  assert.notEqual(start, -1, "main() não encontrado em session-registry.ts — arquivo mudou de forma inesperada");
  const endMarker = "\nif (isMainModule(import.meta.url)) {";
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, "fim de main() (marcador isMainModule) não encontrado");
  return source.slice(start, end);
}

/**
 * Divide o corpo de `main()` em blocos por `case "X": { ... }`, mapeando
 * cada label pro texto do seu bloco (até o próximo `case`/`default`).
 */
function splitCaseBlocks(mainBody: string): Map<string, string> {
  const caseRegex = /case\s+"([a-z0-9-]+)":/g;
  const matches: { label: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = caseRegex.exec(mainBody)) !== null) {
    matches.push({ label: m[1], index: m.index });
  }
  assert.ok(matches.length > 5, "poucos case labels encontrados — regex de extração pode estar quebrada");

  const blocks = new Map<string, string>();
  for (let i = 0; i < matches.length; i++) {
    const startIdx = matches[i].index;
    const endIdx = i + 1 < matches.length ? matches[i + 1].index : mainBody.length;
    blocks.set(matches[i].label, mainBody.slice(startIdx, endIdx));
  }
  return blocks;
}

const mainBody = extractMainBody(registrySource);
const caseBlocks = splitCaseBlocks(mainBody);

describe("SESSION_ID_REQUIRED_SUBCOMMANDS vs. session-registry.ts main() real (#7836)", () => {
  it("extraiu pelo menos os case labels conhecidos (sanity check do parser)", () => {
    for (const known of ["register", "self-authorize-merge", "merge-lock-renew", "gc"]) {
      assert.ok(caseBlocks.has(known), `case "${known}" não encontrado — parser de extração quebrado?`);
    }
  });

  it(
    "todo case que chama requireSessionId(values) está em SESSION_ID_REQUIRED_SUBCOMMANDS " +
      "(pega a classe de omissão do #6317/#6334/#7836)",
    () => {
      const missing: string[] = [];
      for (const [label, body] of caseBlocks) {
        if (body.includes("requireSessionId(values)") && !SESSION_ID_REQUIRED_SUBCOMMANDS.includes(label as any)) {
          missing.push(label);
        }
      }
      assert.deepEqual(
        missing,
        [],
        `case(s) chamando requireSessionId(values) mas ausente(s) de SESSION_ID_REQUIRED_SUBCOMMANDS: ` +
          `${missing.join(", ")} — adicione em scripts/lib/session-id-required-subcommands.ts`,
      );
    },
  );

  it(
    "todo membro de SESSION_ID_REQUIRED_SUBCOMMANDS corresponde a um case real em session-registry.ts " +
      "(pega typo/renomeação/remoção não sincronizada)",
    () => {
      const orphaned = SESSION_ID_REQUIRED_SUBCOMMANDS.filter((sub) => !caseBlocks.has(sub));
      assert.deepEqual(
        orphaned,
        [],
        `subcomando(s) na lista compartilhada sem case correspondente em session-registry.ts: ` +
          `${orphaned.join(", ")}`,
      );
    },
  );

  it("is-claimed e conflicts (exceções documentadas) continuam lendo values[\"session-id\"] como opcional", () => {
    // Não chamam requireSessionId — se algum dia passarem a chamar, a checagem
    // acima já cobre; este teste só confirma que a exceção documentada no
    // docblock do módulo compartilhado ainda descreve o código real.
    for (const label of ["is-claimed", "conflicts"]) {
      const body = caseBlocks.get(label);
      assert.ok(body, `case "${label}" não encontrado`);
      assert.ok(
        body!.includes('values["session-id"]'),
        `case "${label}" não lê mais values["session-id"] — atualizar o docblock de ` +
          "session-id-required-subcommands.ts se o comportamento mudou de propósito",
      );
      assert.ok(
        !body!.includes("requireSessionId(values)"),
        `case "${label}" passou a chamar requireSessionId(values) — deixou de ser exceção, ` +
          "o teste acima já cobriria isso automaticamente",
      );
    }
  });
});
