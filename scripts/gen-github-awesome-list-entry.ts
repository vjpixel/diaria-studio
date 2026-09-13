#!/usr/bin/env npx tsx
/**
 * #8068 — Gera a linha de entrada Markdown pronta para colar num README de
 * lista "awesome-*" do GitHub que aceite a diar.ia.br (ver
 * docs/seo-backlinks-plan.md §"Mecanismo automatizável" e §"GitHub — listas
 * curadas 'awesome-*'").
 *
 * NÃO faz nenhuma chamada de rede, NÃO clona/faz fork de repositório, NÃO
 * abre Pull Request. Só imprime texto — a ação real (fork, editar README,
 * `gh pr create` contra o repositório de TERCEIRO) é sempre humana, feita
 * pelo editor fora desta sessão (regra "nunca execute ações reais em sites
 * de terceiros" da issue #8068 e do princípio "Nunca correr risco de ToS"
 * do CLAUDE.md — embora abrir uma PR de contribuição open-source não seja
 * risco de ToS por si só, o escopo desta sessão overnight é preparar
 * material, não executar ações externas).
 *
 * Uso:
 *   npx tsx scripts/gen-github-awesome-list-entry.ts --list
 *     # lista os alvos conhecidos (chave, nome, URL do repo)
 *   npx tsx scripts/gen-github-awesome-list-entry.ts --target randalmaia
 *     # imprime a linha de entrada + instruções pro alvo escolhido
 */
import { getArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import {
  AWESOME_LIST_TARGETS,
  buildAwesomeListEntryGuidance,
  findAwesomeListTarget,
} from "./lib/github-awesome-list-entry.ts";

export function run(argv: string[]): string {
  if (hasFlag(argv, "list")) {
    const lines = AWESOME_LIST_TARGETS.map(
      (t) => `${t.key}\t${t.name}\t${t.repoUrl}`,
    );
    return ["key\tname\trepoUrl", ...lines].join("\n");
  }

  const targetKey = getArg(argv, "target");
  if (!targetKey) {
    throw new Error(
      "uso: npx tsx scripts/gen-github-awesome-list-entry.ts --target <key> (ou --list para ver as chaves)",
    );
  }

  const target = findAwesomeListTarget(targetKey);
  if (!target) {
    const known = AWESOME_LIST_TARGETS.map((t) => t.key).join(", ");
    throw new Error(`--target "${targetKey}" desconhecido. Conhecidos: ${known}`);
  }

  return buildAwesomeListEntryGuidance(target);
}

if (isMainModule(import.meta.url)) {
  try {
    console.log(run(process.argv.slice(2)));
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  }
}
