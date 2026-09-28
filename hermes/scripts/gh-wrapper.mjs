#!/usr/bin/env node
// hermes/scripts/gh-wrapper.mjs (#8884)
//
// Wrapper de `gh` instalado no PATH do `300` NA FRENTE do binário real (ex.:
// `~/.local/bin/gh` -> este arquivo, ver `hermes/README.md`). Fecha as duas
// brechas que `.claude/hooks/block-gh-comment-secrets.mjs` (#8827) deixou
// conhecidas e documentadas:
//
//   1. Corpo dinâmico (`--body "$VAR"`, `--body "$(cmd | ...)"`) — o hook do
//      Claude Code só vê o TEXTO do comando antes da expansão do shell; este
//      wrapper recebe o argv já expandido, então o valor real chega aqui.
//   2. Agente Hermes (GLM) fora do Claude Code — hooks do harness não se
//      aplicam a esse processo; um wrapper no PATH intercepta QUALQUER
//      processo que rode `gh`, seja Hermes, cron ou script solto.
//
// A lógica de decisão (o quê é "publica texto", quais argumentos carregam o
// texto final, se algum tem formato de segredo) é toda em
// `lib/gh-wrapper-core.mjs`, puro e testável sem spawnar nada — ver
// `test/gh-wrapper.test.ts`. Este arquivo só: acha o `gh` real no PATH
// (pulando a si mesmo, pra nunca recursar), lê stdin quando o comando
// declara precisar dele, chama o core, e ou recusa ou repassa pro `gh` real
// sem alterar nada.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateGhInvocation, requiresStdin } from "./lib/gh-wrapper-core.mjs";

/**
 * Acha o primeiro `gh` executável no PATH que NÃO seja este próprio wrapper
 * (comparando realpath — cobre tanto symlink quanto stub-com-exec apontando
 * pra este arquivo). `null` se não achar nenhum outro.
 */
export function findRealGh(pathEnv, selfRealPath, deps = {}) {
  const { exists = existsSync, realpath = realpathSync } = deps;
  const dirs = (pathEnv ?? "").split(":").filter(Boolean);
  for (const dir of dirs) {
    const candidate = join(dir, "gh");
    if (!exists(candidate)) continue;
    try {
      if (realpath(candidate) === selfRealPath) continue; // é este mesmo wrapper
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  let selfRealPath;
  try {
    selfRealPath = realpathSync(fileURLToPath(import.meta.url));
  } catch {
    selfRealPath = fileURLToPath(import.meta.url);
  }

  const realGh = findRealGh(process.env.PATH, selfRealPath);
  if (!realGh) {
    process.stderr.write(
      "gh-wrapper: não achei o `gh` real no PATH (fora do diretório deste wrapper). " +
        "Confirme a instalação em hermes/README.md.\n",
    );
    process.exit(127);
  }

  const needsStdin = requiresStdin(argv);
  let stdinText;
  if (needsStdin) {
    try {
      stdinText = readFileSync(0, "utf8");
    } catch {
      stdinText = "";
    }
  }

  const result = evaluateGhInvocation(argv, {
    readFileSync: (p) => readFileSync(p, "utf8"),
    stdinText,
  });

  if (result.blocked) {
    process.stderr.write(
      `gh-wrapper: bloqueado (#8884) — o texto que este comando publicaria no GitHub contém ` +
        `o que parece um segredo (${result.secrets.join(", ")}). O repositório é público e o ` +
        `provedor revoga a chave ao detectá-la. Remova o valor do corpo (cite só o nome da ` +
        `variável) e rode de novo.\n`,
    );
    process.exit(1);
  }

  // `stdio[0]` precisa ser `"pipe"` quando `input` é passado — `"inherit"`
  // nos dois ao mesmo tempo faz o Node ignorar silenciosamente o `input`
  // (confirmado ao vivo: sem isso o texto nunca chega ao `gh` real quando
  // `needsStdin` é true).
  const child = spawnSync(realGh, argv, {
    stdio: [needsStdin ? "pipe" : "inherit", "inherit", "inherit"],
    input: needsStdin ? stdinText : undefined,
  });
  if (child.error) {
    process.stderr.write(`gh-wrapper: falha ao executar \`gh\` real: ${child.error.message}\n`);
    process.exit(1);
  }
  process.exit(child.status ?? 1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
const isMain =
  import.meta.url === `file://${_argv1}` || import.meta.url === `file:///${_argv1.replace(/^\//, "")}`;
if (isMain) main();
