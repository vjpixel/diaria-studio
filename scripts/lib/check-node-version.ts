/**
 * check-node-version.ts (#4823)
 *
 * O projeto usa `node:sqlite` (`scripts/lib/clarice-db.ts`) — builtin só a
 * partir do Node ≥22.5 (docstring de `clarice-db.ts`: "Node ≥22.5 / 24").
 * Node do sistema/distro (ex: Ubuntu via `apt`) costuma vir mais antigo — o
 * achado ao vivo do #4823 foi Node 20.20.2 derrubando o Studio server em
 * `predator` com `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in
 * module: node:sqlite`, um erro nativo opaco sem nenhum sinal do requisito
 * real. CI nunca bateu nisso: todo `.github/workflows/*.yml` fixa
 * `node-version: '24'` explicitamente.
 *
 * Este módulo isola a lógica PURA de comparação de versão — testável com uma
 * string de versão injetada, sem depender do Node real da máquina que roda os
 * testes (ver test/check-node-version.test.ts).
 *
 * `assertSupportedNodeVersion` é consumida por `clarice-db.ts` dentro de
 * `openClariceDb`, ANTES do `require("node:sqlite")` lazy (via
 * `createRequire`). Um `import { DatabaseSync } from "node:sqlite"` estático
 * não dá pra guardar assim: falha na fase de LINK do grafo ES module — antes
 * de qualquer corpo de módulo rodar, então nenhum guard escrito no corpo do
 * arquivo consumidor (nem um import posicionado antes) intercepta o erro
 * opaco `ERR_UNKNOWN_BUILTIN_MODULE`. Só um `require()` lazy dentro de uma
 * função, resolvido em runtime, dá o ponto de interceptação (ver comentário
 * no import de `node:sqlite` em `clarice-db.ts`).
 *
 * Uso como CLI (preflight manual, ex: hook de bootstrap):
 *   npx tsx scripts/lib/check-node-version.ts
 *   # → exit 0 e silêncio se a versão for suportada; exit 1 + mensagem clara
 *   #   em stderr caso contrário.
 */

import { isMainModule } from "./cli-args.ts";

/** Mínimo real que `node:sqlite` suporta (ver docstring de clarice-db.ts). */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 5;

export interface NodeVersionCheckResult {
  ok: boolean;
  /** Presente só quando `ok === false` — mensagem pronta pra exibir ao usuário. */
  message?: string;
}

/**
 * Compara `version` (formato `vMAJOR.MINOR.PATCH`, com ou sem o `v` inicial)
 * contra o mínimo requerido. Formato inesperado (não deveria acontecer com
 * `process.version` real, mas cobre input malformado em teste/injeção) não
 * bloqueia — fail-soft, mesma disciplina de `detectExecMode`.
 */
export function checkNodeVersion(
  version: string = process.version,
): NodeVersionCheckResult {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) {
    return { ok: true };
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const ok =
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR);
  if (ok) {
    return { ok: true };
  }
  return {
    ok: false,
    message:
      `Node ${version} detectado, mas este projeto requer Node >=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 ` +
      `(node:sqlite é builtin só a partir dessa versão — ver scripts/lib/clarice-db.ts). ` +
      `Use nvm/fnm/asdf com o .nvmrc do repo ('nvm use') ou instale Node 24 (mesma versão do CI) antes de continuar.`,
  };
}

/**
 * Mesma checagem que `checkNodeVersion`, mas lança em vez de retornar um
 * resultado — uso como guard de import-time (ver
 * `assert-node-sqlite-support.ts`) ou em qualquer ponto onde o chamador só
 * quer "aborte com mensagem clara se a versão não servir".
 */
export function assertSupportedNodeVersion(
  version: string = process.version,
): void {
  const result = checkNodeVersion(version);
  if (!result.ok) {
    throw new Error(result.message);
  }
}

// CLI guard: só executa como main module, importável sem efeito colateral.
if (isMainModule(import.meta.url)) {
  const result = checkNodeVersion();
  if (!result.ok) {
    console.error(`\n${result.message}\n`);
    process.exit(1);
  }
}
