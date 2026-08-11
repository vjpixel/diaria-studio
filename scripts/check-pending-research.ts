#!/usr/bin/env npx tsx
/**
 * check-pending-research.ts (#4990)
 *
 * CLI fino sobre `scripts/lib/pending-research.ts` — ver docstring do lib
 * pro racional completo (incidente #4990: pesquisa pedida pelo editor no
 * gate do Stage 4 nunca completada, `use_melhor` seguiu `[]`, a seção
 * sumiu da edição publicada sem nenhum aviso em stage nenhum).
 *
 * Modos:
 *   --write --edition-dir <dir> --bucket <bucket> --request "<texto>"
 *       Grava/sobrescreve `_internal/pending-research.json` com
 *       status "pending". Chamado pelo orchestrator (Stage 4 §4d.1,
 *       loop "ajustar") quando reconhece que o editor pediu conteúdo NOVO
 *       pra um bucket (não edição de texto já escrito). Exit 0.
 *
 *   --resolve --edition-dir <dir> [--reason "<texto>"]
 *       Marca o marker existente como "resolved" manualmente (editor
 *       decidiu não perseguir a pesquisa, ou o resultado foi integrado à
 *       mão). No-op se não houver marker pendente. Exit 0 sempre
 *       (idempotente — resolver 2x, ou resolver sem marker, não é erro).
 *
 *   --check --edition-dir <dir> [--approved-json <path>]
 *       Lê o marker. Sem marker, ou já resolvido → exit 0 (nada pendente).
 *       Com marker pending E bucket alvo já populado em 01-approved.json →
 *       auto-resolve, imprime info, exit 0. Com marker pending E bucket
 *       ainda vazio → imprime WARNING explícito (motivo do #4990) e
 *       **exit 1** — não fatal para o caller (o orchestrator trata como
 *       warning, nunca bloqueia — ver orchestrator-stage-5.md §5a e
 *       orchestrator-stage-4.md §4d.1), mas o exit não-zero garante que
 *       nenhum caller trata isso como "tudo certo" por acidente.
 *
 * Uso:
 *   npx tsx scripts/check-pending-research.ts --write \
 *     --edition-dir data/editions/AAMMDD/ --bucket use_melhor \
 *     --request "mais 2 tutoriais de RAG, pedido pelo editor no gate"
 *   npx tsx scripts/check-pending-research.ts --check --edition-dir data/editions/AAMMDD/
 *   npx tsx scripts/check-pending-research.ts --resolve --edition-dir data/editions/AAMMDD/ --reason "editor desistiu do pedido"
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import {
  writePendingResearch,
  resolvePendingResearch,
  checkPendingResearch,
} from "./lib/pending-research.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function usage(): never {
  console.error(
    "Uso:\n" +
      "  check-pending-research.ts --write --edition-dir <dir> --bucket <bucket> --request \"<texto>\"\n" +
      "  check-pending-research.ts --resolve --edition-dir <dir> [--reason \"<texto>\"]\n" +
      "  check-pending-research.ts --check --edition-dir <dir> [--approved-json <path>]",
  );
  process.exit(2);
}

function main(): void {
  const { values, flags } = parseArgs(process.argv.slice(2));
  const editionDirArg = values["edition-dir"];
  if (!editionDirArg) usage();
  const editionDir = resolve(ROOT, editionDirArg);

  if (flags.has("write")) {
    const bucket = values["bucket"];
    const request = values["request"];
    if (!bucket || !request) {
      console.error("[check-pending-research] --write requer --bucket e --request.");
      process.exit(2);
    }
    const path = writePendingResearch(editionDir, bucket, request);
    console.log(JSON.stringify({ ok: true, sentinel_path: path, bucket, request }));
    process.exit(0);
  }

  if (flags.has("resolve")) {
    const changed = resolvePendingResearch(editionDir, values["reason"]);
    console.log(JSON.stringify({ ok: true, changed }));
    process.exit(0);
  }

  if (flags.has("check")) {
    const approvedJsonPath = values["approved-json"]
      ? resolve(ROOT, values["approved-json"])
      : undefined;
    const result = checkPendingResearch(editionDir, approvedJsonPath);

    if (!result.pending) {
      if (result.reason === "auto-resolved") {
        console.error(
          `[check-pending-research] ℹ️  Pesquisa pendente auto-resolvida — bucket "${result.marker.bucket}" ` +
            `já tem ${result.bucketCount} item(ns) (pedido original: "${result.marker.request}", ${result.marker.requestedAt}).`,
        );
      }
      console.log(JSON.stringify({ ok: true, ...result }));
      process.exit(0);
    }

    // pending: true — GATE-WARNING (nunca fatal para o caller; exit 1 só
    // sinaliza "há algo a mostrar ao editor", ver docstring acima).
    console.error(
      `[check-pending-research] ⚠️  PESQUISA PENDENTE não resolvida — ` +
        `bucket "${result.marker.bucket}" continua vazio (0 itens). ` +
        `Pedido do editor (${result.marker.requestedAt}): "${result.marker.request}". ` +
        `Ação: completar a pesquisa e integrar ao bucket, ou rodar ` +
        `"npx tsx scripts/check-pending-research.ts --resolve --edition-dir ${editionDirArg} --reason <motivo>" ` +
        `se o editor decidiu não perseguir (#4990).`,
    );
    console.log(JSON.stringify({ ok: false, ...result }));
    process.exit(1);
  }

  usage();
}

if (isMainModule(import.meta.url)) {
  main();
}
