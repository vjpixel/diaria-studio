/**
 * test/session-id-required-subcommands-hook-sync.test.ts (#7836 P0)
 *
 * Incidente: a 1ª versão do fix do #7836 fez `.claude/hooks/inject-
 * session-id.mjs` importar `scripts/lib/session-id-required-subcommands.ts`
 * diretamente em runtime. `.claude/settings.json` spawna este hook com o
 * binário `node` cru (não `npx tsx`, não um `node` prefixado manualmente) —
 * e nesta máquina (e potencialmente em qualquer outra sem Node 22.18+ como
 * `node` default do PATH do harness) isso é Node abaixo do piso de
 * type-stripping nativo. O `import` de `.ts` lança
 * `ERR_UNKNOWN_FILE_EXTENSION` na CARGA do módulo — antes de qualquer linha
 * do hook rodar, não capturável pelo `try/catch` interno — derrubando a
 * injeção de `--session-id` em TODA chamada `Bash` da sessão, silenciosamente
 * até os merges travarem. Revertido no mesmo dia: a lista voltou a ser um
 * literal plano dentro do `.mjs`, sem import.
 *
 * Este arquivo trava as DUAS metades da correção:
 *   1. O hook NUNCA volta a importar nenhum `.ts` (grep estático — pega a
 *      classe inteira, não só este import específico que já foi removido).
 *   2. A cópia inline do hook não diverge silenciosamente da lista
 *      canônica em `session-id-required-subcommands.ts` (mesma garantia
 *      que o import antigo dava, sem o import).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { SESSION_ID_REQUIRED_SUBCOMMANDS } from "../scripts/lib/session-id-required-subcommands.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK_PATH = join(ROOT, ".claude", "hooks", "inject-session-id.mjs");

describe("inject-session-id.mjs nunca importa .ts em runtime (#7836 P0)", () => {
  it(".claude/hooks/inject-session-id.mjs existe neste checkout", () => {
    assert.ok(existsSync(HOOK_PATH), `esperado existir: ${HOOK_PATH}`);
  });

  it("nenhuma linha `import ... from \"...\"` do hook referencia um caminho .ts", () => {
    const source = readFileSync(HOOK_PATH, "utf8");
    const importLines = source
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l));
    const tsImports = importLines.filter((l) => /["']\S*\.ts["']/.test(l));
    assert.deepEqual(
      tsImports,
      [],
      "inject-session-id.mjs importa um arquivo .ts em runtime — isso já causou uma " +
        "quebra de produção (#7836 P0): .claude/settings.json spawna este hook com " +
        "`node` cru, resolvido pelo PATH do processo do harness, não necessariamente " +
        "Node 22.18+ com type-stripping nativo. Qualquer dado que o hook precise de " +
        "outro arquivo TS tem que ser DUPLICADO como literal plano aqui (ver a lista " +
        "SESSION_ID_REQUIRED_SUBCOMMANDS inline), nunca importado.",
    );
  });

  it("o hook roda sem lançar sob um Node SEM type-stripping nativo (reprodução direta do incidente)", () => {
    // Não dá pra forçar Node <22.18 de dentro do processo de teste (que já
    // roda em Node 24 via tsx) — mas dá pra provar que o hook NÃO depende de
    // type-stripping checando que `--experimental-strip-types` desligado
    // (o comportamento default de qualquer Node, incluindo os antigos que
    // nem têm essa flag) ainda carrega o arquivo sem erro. Se o hook voltar
    // a importar .ts, este spawn falharia com ERR_UNKNOWN_FILE_EXTENSION —
    // mesmo em Node 24 — porque a flag desliga o stripping explicitamente.
    const out = execFileSync(
      process.execPath,
      ["--no-experimental-strip-types", HOOK_PATH],
      { input: "{}", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    // payload "{}" (sem tool_name/command) é um no-op válido — só precisa
    // não lançar. Saída vazia é esperada (nada a injetar).
    assert.equal(out, "");
  });
});

describe("SESSION_ID_REQUIRED_SUBCOMMANDS: cópia inline do hook não diverge da fonte canônica", () => {
  function parseHookInlineList(): string[] {
    const source = readFileSync(HOOK_PATH, "utf8");
    const match = source.match(
      /const\s+SESSION_ID_REQUIRED_SUBCOMMANDS\s*=\s*\[([\s\S]*?)\];/,
    );
    assert.ok(
      match,
      "não encontrei `const SESSION_ID_REQUIRED_SUBCOMMANDS = [...]` literal no hook — " +
        "o formato mudou; atualize o regex de extração deste teste.",
    );
    return [...match![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  }

  it("a lista inline do hook tem exatamente os mesmos membros da lista canônica (session-id-required-subcommands.ts), em qualquer ordem", () => {
    const hookList = parseHookInlineList();
    const canonical = [...SESSION_ID_REQUIRED_SUBCOMMANDS];
    assert.deepEqual(
      [...hookList].sort(),
      [...canonical].sort(),
      "a cópia inline em inject-session-id.mjs divergiu de SESSION_ID_REQUIRED_SUBCOMMANDS " +
        "(scripts/lib/session-id-required-subcommands.ts) — as duas precisam conter " +
        "exatamente os mesmos subcomandos. Atualize a lista que ficou pra trás.",
    );
  });
});
