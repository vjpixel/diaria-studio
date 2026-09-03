#!/usr/bin/env node
/**
 * scripts/run-shell-tests.ts (#7129 item c)
 *
 * Roda TODOS os `*.test.sh` do repo. Existe porque eles não rodavam em lugar
 * nenhum: `scripts/run-tests.ts` varre só `*.test.ts`, e nenhum step de CI os
 * invocava — ~862 LOC de teste que existiam e nunca eram executados.
 *
 * **Por que isso é P2 e não higiene.** Teste que não roda não é rede de
 * segurança; é a aparência de uma. E a área coberta por estes é justamente
 * `hermes/` + o fluxo do contínuo — o consumidor externo no `helios`, onde
 * este repo já reverteu uma remoção por ter quebrado o loop de produção
 * (#6059/#6060). O lugar de maior risco de regressão era o que tinha
 * cobertura decorativa.
 *
 * **Descoberta, não lista.** O runner varre o disco em vez de manter um
 * inventário fixo: uma lista precisaria ser atualizada por quem adicionasse
 * um `*.test.sh` novo, e é exatamente esse passo esquecido que produz o
 * defeito de origem. Quem esquecer de rodar o teste novo não tem como
 * esquecer — ele entra sozinho.
 *
 * `test/shell-tests-discovery-7129.test.ts` fecha o outro lado: garante que
 * este runner de fato acha os arquivos, para que "0 testes encontrados" nunca
 * passe como sucesso.
 *
 * Uso:
 *   npx tsx scripts/run-shell-tests.ts [--list]
 *
 * `--list` imprime os arquivos descobertos e sai 0 sem executar nada.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Diretórios que nunca contêm teste nosso e que tornariam a varredura lenta. */
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".claude", // worktrees de agente vivem aqui — varrer traria cópias do próprio repo
  "data", // junction do OneDrive; conteúdo não é código
]);

/** Timeout por arquivo. Os atuais rodam em segundos; o teto é anti-trava de CI. */
export const SHELL_TEST_TIMEOUT_MS = 180_000;

/**
 * Varre `root` recursivamente e devolve os caminhos relativos de todo
 * `*.test.sh`, ordenados. Pura o suficiente para ser testada apontando para
 * um diretório de fixture.
 */
export function discoverShellTests(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // diretório ilegível não derruba a varredura
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(".test.sh")) found.push(relative(root, full).replace(/\\/g, "/"));
    }
  };
  walk(root);
  return found.sort();
}

function main(): number {
  const listOnly = process.argv.includes("--list");
  const files = discoverShellTests(REPO_ROOT);

  if (files.length === 0) {
    // Zero arquivos NUNCA é sucesso: ou a varredura quebrou, ou os testes
    // sumiram — as duas coisas exigem olhar humano. Falhar aqui é a mesma
    // disciplina de "indeterminado nunca vira ok" que os guards deste repo
    // seguem.
    console.error(
      "[run-shell-tests] nenhum *.test.sh encontrado — a varredura quebrou ou os testes foram removidos. " +
        "Se a remoção foi deliberada, remova também este runner e o step de CI que o chama.",
    );
    return 1;
  }

  if (listOnly) {
    for (const f of files) console.log(f);
    return 0;
  }

  console.log(`[run-shell-tests] ${files.length} arquivo(s) *.test.sh encontrado(s).`);
  let failed = 0;
  for (const file of files) {
    const started = Date.now();
    const result = spawnSync("bash", [file], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      timeout: SHELL_TEST_TIMEOUT_MS,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (result.status === 0) {
      console.log(`  ok   ${file} (${secs}s)`);
      continue;
    }
    failed++;
    const why =
      result.error?.message ??
      (result.signal ? `morto por sinal ${result.signal} (timeout de ${SHELL_TEST_TIMEOUT_MS / 1000}s?)` : `exit ${result.status}`);
    console.error(`  FALHOU ${file} (${secs}s) — ${why}`);
    // Saída completa do que falhou: em CI, o log do runner é a única
    // evidência disponível depois.
    if (result.stdout) console.error(result.stdout);
    if (result.stderr) console.error(result.stderr);
  }

  console.log(`[run-shell-tests] fim: ${files.length - failed} ok, ${failed} falha(s).`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
