#!/usr/bin/env tsx
/**
 * sync-eia-block.ts (#5459)
 *
 * Wrapper de I/O fino em torno de `syncEiaBlockFromReviewed`
 * (`scripts/lib/eia-sync.ts`) — lê `01-eia.md` + `02-reviewed.md` do
 * edition dir, e regrava `01-eia.md` se o bloco mirror pós-humanizador+
 * Clarice divergir. Rodar no Stage 2, LOGO APÓS Clarice terminar de
 * corrigir `02-reviewed.md` (ver `orchestrator-stage-2.md`) — antes disso,
 * `01-eia.md` ainda não tem o que sincronizar; depois disso, quanto antes
 * melhor (o Stage 4 nunca deve ver a divergência).
 *
 * Uso:
 *   npx tsx scripts/sync-eia-block.ts --edition-dir <dir>            # 02 → 01 (default)
 *   npx tsx scripts/sync-eia-block.ts --edition-dir <dir> --from 01  # 01 → 02 (#13886)
 *
 * SENTIDO (#13886): o default copia o mirror de `02-reviewed.md` PARA
 * `01-eia.md` — serve para propagar ao real a correção que humanizador/
 * Clarice fizeram no mirror. Quando o `01-eia.md` é que está certo e o
 * mirror está defasado (placeholder do stitch, mirror anterior à Etapa 3),
 * o fix é `--from 01`, que espelha o corpo de `01-eia.md` no bloco mirror
 * de `02-reviewed.md` sem tocar o `01-eia.md`.
 *
 * Exit codes:
 *   0 — sucesso (sincronizou OU já estava sincronizado OU sem mirror ainda —
 *       nenhum desses é erro; o Stage 3 pode não ter rodado ainda quando
 *       este script roda cedo demais, então "sem mirror" é esperado em
 *       alguns fluxos e nunca deve travar o Stage 2). Também placeholder no
 *       mirror com `01-eia.md` ausente/vazio (ordem normal do Stage 2).
 *   1 — args inválidos
 *   3 — `02-reviewed.md` ausente (erro de verdade — Stage 2 não devia ter
 *       chegado até aqui sem esse arquivo); com `--from 01`, também
 *       `01-eia.md` ausente/vazio
 *   4 — recusa (#13886): no sentido 02→01, o mirror é o placeholder ou
 *       perderia legenda/"Resultado da última edição" de um `01-eia.md` que
 *       tem conteúdo real. Nada é escrito; a mensagem manda rodar `--from 01`.
 *
 * `01-eia.md` ausente é tratado como corpo vazio implícito (mesmo padrão de
 * `fallbackEIA` em `newsletter-parse.ts`) — se o Stage 3 ainda não rodou,
 * não há nada pra sincronizar (o mirror em `02-reviewed.md` nesse caso é o
 * placeholder "ainda processando", que não bate com nenhum credit real, mas
 * isso não é um erro de sync — é ordem de stages, fora de escopo aqui).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgsSimple, isMainModule } from "./lib/cli-args.ts";
import { eiaMdHasRealContent, syncEiaBlockFromReviewed, syncReviewedMirrorFromEia } from "./lib/eia-sync.ts";

export type SyncDirection = "02" | "01";

export function parseArgs(argv: string[]): { editionDir: string; from: SyncDirection } | null {
  const args = parseArgsSimple(argv);
  const editionDir = args["edition-dir"] ?? "";
  if (!editionDir) return null;
  const from = args["from"] ?? "02";
  if (from !== "01" && from !== "02") return null;
  return { editionDir, from };
}

export interface SyncOutcome {
  exitCode: number;
  message: string;
  /** Arquivo regravado, quando houve escrita. */
  wrote?: string;
}

/** I/O do CLI isolado de `process.exit` para o teste de regressão (#13886)
 * exercitar os arquivos de verdade num diretório temporário. */
export function runSyncEiaBlock(editionDirArg: string, from: SyncDirection = "02"): SyncOutcome {
  const editionDir = resolve(editionDirArg);
  const reviewedPath = resolve(editionDir, "02-reviewed.md");
  const eiaPath = resolve(editionDir, "01-eia.md");
  const fromCmd = `npx tsx scripts/sync-eia-block.ts --edition-dir ${editionDirArg} --from 01`;

  if (!existsSync(reviewedPath)) {
    return { exitCode: 3, message: `[sync-eia-block] ${reviewedPath} não existe.` };
  }

  const reviewedMd = readFileSync(reviewedPath, "utf8");
  const eiaMd = existsSync(eiaPath) ? readFileSync(eiaPath, "utf8") : "";

  if (from === "01") {
    if (!eiaMdHasRealContent(eiaMd)) {
      return {
        exitCode: 3,
        message: `[sync-eia-block] --from 01: ${eiaPath} ausente, vazio ou só com o placeholder — nada a espelhar em 02-reviewed.md.`,
      };
    }
    const r = syncReviewedMirrorFromEia(eiaMd, reviewedMd);
    if (!r.changed) {
      return { exitCode: 0, message: `[sync-eia-block] --from 01: no-op (${r.reason}) — nada a espelhar.` };
    }
    writeFileSync(reviewedPath, r.newReviewedMd, "utf8");
    return {
      exitCode: 0,
      wrote: reviewedPath,
      message: `[sync-eia-block] --from 01: bloco É IA? de ${reviewedPath} espelhado a partir de 01-eia.md (01-eia.md intacto).`,
    };
  }

  const result = syncEiaBlockFromReviewed(eiaMd, reviewedMd, editionDir);

  if (!result.changed) {
    const refuses =
      result.reason === "mirror-loses-content" ||
      (result.reason === "mirror-is-placeholder" && eiaMdHasRealContent(eiaMd));
    if (refuses) {
      const why =
        result.reason === "mirror-is-placeholder"
          ? "o bloco É IA? de 02-reviewed.md é o placeholder do stitch"
          : "o bloco É IA? de 02-reviewed.md não tem a legenda ou a linha \"Resultado da última edição\" que 01-eia.md tem";
      return {
        exitCode: 4,
        message:
          `[sync-eia-block] RECUSADO (#13886): ${why}. O sentido default deste script é 02-reviewed.md → 01-eia.md ` +
          `e sobrescreveria a legenda real de 01-eia.md (a que vai pro e-mail). Nada foi escrito. ` +
          `Se 01-eia.md está certo, espelhe 01 → 02 com: ${fromCmd}`,
      };
    }
    return { exitCode: 0, message: `[sync-eia-block] no-op (${result.reason}) — nada a sincronizar.` };
  }

  if (!existsSync(eiaPath)) {
    return {
      exitCode: 0,
      message:
        `[sync-eia-block] ${eiaPath} não existe ainda — mirror presente em 02-reviewed.md ` +
        "mas sem 01-eia.md real pra sincronizar (Stage 3 provavelmente ainda não rodou). No-op.",
    };
  }

  writeFileSync(eiaPath, result.newEiaMd, "utf8");
  return {
    exitCode: 0,
    wrote: eiaPath,
    message: `[sync-eia-block] ${eiaPath} sincronizado com o mirror pós-Clarice de 02-reviewed.md (sentido 02 → 01).`,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error("Uso: sync-eia-block.ts --edition-dir <dir> [--from 01|02]");
    process.exit(1);
  }
  const out = runSyncEiaBlock(args.editionDir, args.from);
  if (out.exitCode === 0) console.log(out.message);
  else console.error(out.message);
  if (out.exitCode !== 0) process.exit(out.exitCode);
}

if (isMainModule(import.meta.url)) main();
