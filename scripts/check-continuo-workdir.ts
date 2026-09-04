#!/usr/bin/env npx tsx
/**
 * scripts/check-continuo-workdir.ts (#6817)
 *
 * CLI da allowlist de raízes do `hermes-diaria-continuo` — ver
 * `scripts/lib/continuo-workdir-allowlist.ts` pro critério puro/docs
 * completas. Resolve o path pedido (absolutiza `~`, normaliza `..`) e
 * chama `isPathAllowed` contra as raízes default.
 *
 * Dois modos:
 *
 *   npx tsx scripts/check-continuo-workdir.ts --path X --intent read|write
 *   npx tsx scripts/check-continuo-workdir.ts --check-self-mod --path X --active a,b,c
 *
 * O 2º modo é o guard de auto-modificação (#6817 item 4, review da PR
 * #6854 P2 — `isSelfModification` existia na lib, testada, mas sem NENHUM
 * comando que a chamasse; o SKILL.md instruía "checar isSelfModification"
 * apontando pra uma função que a delegação (que só sabe rodar `npx tsx
 * scripts/...`, nunca importar TS direto) não tinha como invocar). `--active`
 * é a lista (separada por vírgula) dos arquivos que o tick CORRENTE está
 * executando agora — cada item passa pela MESMA expansão `~`/`resolve()`
 * de `--path`, pra a comparação de string exata de `isSelfModification`
 * não falhar por um dos dois lados vir relativo/com `~` e o outro não.
 *
 * Exemplos:
 *   npx tsx scripts/check-continuo-workdir.ts --path /home/vjpixel/diaria-studio/scripts/x.ts --intent write
 *   npx tsx scripts/check-continuo-workdir.ts --path ~/hermes-agent/foo.py --intent read
 *   npx tsx scripts/check-continuo-workdir.ts --path ~/.hermes/auth.json --intent read
 *   npx tsx scripts/check-continuo-workdir.ts --check-self-mod \
 *     --path hermes/skills/hermes-diaria-continuo/SKILL.md \
 *     --active hermes/skills/hermes-diaria-continuo/SKILL.md,~/.hermes/scripts/claude-openrouter.sh
 *
 * Um 3º modo (#6817 item 5) responde "este path exige o verbo `write-
 * hermes-config.ts` em vez de escrita direta?" — só gate pra ESCRITA;
 * `--intent read` sempre libera (ler `~/.hermes/config.yaml` é legítimo e
 * não passa pelo verbo, que só existe pra escrever):
 *
 *   npx tsx scripts/check-continuo-workdir.ts --check-runtime-sensitive --path X --intent write
 *
 * Exit codes:
 *   --path/--intent (modo padrão):
 *     0 = allowed
 *     1 = denied (allowlist recusou — raiz desabilitada, fora de qualquer
 *         raiz, sufixo hard-denied, ou mode incompatível com intent)
 *   --check-self-mod:
 *     0 = NÃO é auto-modificação — seguro aplicar neste tick
 *     1 = É auto-modificação — não aplicar agora, abrir PR pro próximo tick
 *   --check-runtime-sensitive:
 *     0 = `--intent read` (sensibilidade não se aplica a leitura), OU
 *         `--intent write` sobre path NÃO runtime-sensível — Edit/Write
 *         direto OK (sujeito ainda ao gate padrão de allowlist acima)
 *     1 = `--intent write` (default se omitido) sobre path runtime-sensível
 *         — usar `scripts/write-hermes-config.ts`, nunca Edit/Write direto
 *         (#6817 item 5)
 *   Uso inválido (qualquer modo): 2
 *
 * A resposta (motivo) sempre vai pro stdout/stderr — exit code sozinho não
 * diz PORQUE, e quem for barrado precisa saber (mesma disciplina de
 * `sensitive-path-guard.ts`).
 */

import { homedir } from "node:os";
import { resolve } from "node:path";
import { hasFlag, isMainModule, parseArgs } from "./lib/cli-args.ts";
import { defaultWorkdirRoots, isPathAllowed, isSelfModification } from "./lib/continuo-workdir-allowlist.ts";
import { isHermesRuntimeSensitivePath } from "./lib/hermes-runtime-sensitive-paths.ts";

const LOG_PREFIX = "[check-continuo-workdir]";

/** Raiz do repo diaria-studio — 2 níveis acima de `scripts/`. */
const DIARIA_STUDIO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

/** Mesma expansão `~`/`resolve()` usada nos dois modos — critério único
 * pra path virar path absoluto comparável (review da PR #6854, P3: antes
 * só o `--path` do modo padrão passava por isto; `--active` comparava
 * cru). Path relativo sem `~` resolve contra `process.cwd()`, não contra
 * `DIARIA_STUDIO_ROOT` — quem chama este CLI deve sempre passar path
 * absoluto ou `~`-prefixado (os únicos exemplos na docstring acima). */
function resolveInputPath(raw: string): string {
  const expanded = raw.startsWith("~") ? raw.replace(/^~/, homedir()) : raw;
  return resolve(expanded);
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const { values } = parseArgs(argv);
  const rawPath = values.path;

  if (!rawPath) {
    console.error(`${LOG_PREFIX} uso: --path <caminho> --intent read|write   OU   --check-self-mod --path <caminho> --active a,b,c`);
    process.exit(2);
  }
  const resolvedPath = resolveInputPath(rawPath);

  if (hasFlag(argv, "check-self-mod")) {
    const activeRaw = values.active;
    if (!activeRaw) {
      console.error(`${LOG_PREFIX} uso: --check-self-mod --path <caminho> --active a,b,c (lista separada por vírgula)`);
      process.exit(2);
    }
    const activePaths = activeRaw
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map(resolveInputPath);

    const isSelf = isSelfModification(resolvedPath, activePaths);
    if (isSelf) {
      console.error(`${LOG_PREFIX} self-modification — ${resolvedPath} é um dos arquivos que o tick corrente está executando (${activePaths.join(", ")}). NÃO aplicar agora — abrir PR pro próximo tick (#6059/#6060).`);
      process.exit(1);
    } else {
      console.log(`${LOG_PREFIX} não é self-modification — seguro aplicar neste tick.`);
      process.exit(0);
    }
  }

  if (hasFlag(argv, "check-runtime-sensitive")) {
    // `--intent` default = "write": a maioria das chamadas deste modo é
    // "posso ESCREVER aqui direto?" e um caller que esquecer de passar
    // `--intent` deve cair no lado mais seguro (checa), não no lado que
    // libera tudo silenciosamente.
    const sensitiveIntent = values.intent === "read" ? "read" : "write";
    if (sensitiveIntent === "read") {
      console.log(`${LOG_PREFIX} intent=read — sensibilidade de runtime não se aplica (só gate pra escrita); leitura OK (ainda sujeita ao gate de allowlist padrão).`);
      process.exit(0);
    }
    const sensitive = isHermesRuntimeSensitivePath(resolvedPath, homedir());
    if (sensitive) {
      console.error(`${LOG_PREFIX} runtime-sensitive — ${resolvedPath} exige o verbo scripts/write-hermes-config.ts (backup+validate+revert), nunca Edit/Write direto (#6817 item 5).`);
      process.exit(1);
    } else {
      console.log(`${LOG_PREFIX} não é runtime-sensitive — escrita direta OK (ainda sujeita ao gate de allowlist padrão).`);
      process.exit(0);
    }
  }

  const intent = values.intent;
  if (intent !== "read" && intent !== "write") {
    console.error(`${LOG_PREFIX} uso: --path <caminho> --intent read|write`);
    process.exit(2);
  }

  const roots = defaultWorkdirRoots(homedir(), DIARIA_STUDIO_ROOT);
  const decision = isPathAllowed(resolvedPath, intent, roots);

  if (decision.allowed) {
    console.log(`${LOG_PREFIX} allowed — ${decision.reason}`);
    process.exit(0);
  } else {
    console.error(`${LOG_PREFIX} denied — ${decision.reason}`);
    process.exit(1);
  }
}
