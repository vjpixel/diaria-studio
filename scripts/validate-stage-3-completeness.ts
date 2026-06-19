#!/usr/bin/env npx tsx
/**
 * validate-stage-3-completeness.ts (#1132 P1.2)
 *
 * Validador anti-skip: garante que todos os outputs determinísticos do
 * Stage 3 (Imagens) existem antes do gate humano ou antes de Stage 4 começar.
 *
 * Cobre:
 *   1. È IA? images (`01-eia-A.jpg` + `01-eia-B.jpg`) — pre-#192 fallback
 *      pra `01-eia-real.jpg` + `01-eia-ia.jpg` aceito
 *   2. Destaque images (`04-d1-2x1.jpg`, `04-d1-1x1.jpg`, `04-d2-2x1.jpg`,
 *      `04-d2-1x1.jpg`, `04-d3-2x1.jpg`, `04-d3-1x1.jpg`) — D3 obrigatório
 *      só em edições 3-destaque (#2352); D2 2x1 hero adicionado (#2133/#2141/#2366)
 *   3. EIA metadata (`_internal/01-eia-meta.json`) — produzido pelo eia-compose
 *   4. EIA markdown (`01-eia.md`) — produzido pelo eia-compose
 *
 * Análogo a `validate-stage-1-completeness.ts` (#1091) — chamado pelo
 * orchestrator antes de fechar Stage 3.
 *
 * Uso:
 *   npx tsx scripts/validate-stage-3-completeness.ts --edition-dir data/editions/260512
 *
 * Exit codes:
 *   0 = todos os outputs presentes
 *   1 = algum output ausente (FATAL); stderr lista quais
 *   2 = erro de leitura
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  readDestaqueCount,
  REQUIRED_IMAGES_BASE,
  REQUIRED_IMAGES_D3,
} from "./lib/invariant-checks/stage-3.ts";

// #2366: deriva a lista de imagens de destaque da fonte canônica
// (REQUIRED_IMAGES_BASE/D3 em stage-3.ts) em vez de re-listar inline — sem isso,
// adicionar uma imagem em REQUIRED_IMAGES_BASE (como 04-d2-2x1.jpg em #2133/#2141)
// silenciosamente divergia desta validação. As imagens È IA? (01-eia-*) são
// checadas separadamente na seção 1; aqui só interessa os destaques `04-*`.
const DESTAQUE_IMAGES_BASE = REQUIRED_IMAGES_BASE.filter((f) => f.startsWith("04-"));
const DESTAQUE_IMAGES_D3 = REQUIRED_IMAGES_D3.filter((f) => f.startsWith("04-"));

interface Missing {
  file: string;
  category: "eia-image" | "destaque-image" | "eia-metadata" | "eia-md";
  reason: string;
}

/**
 * Pure: dado um editionDir (caminho absoluto), retorna lista de outputs
 * ausentes ou vazios. Empty array = stage 3 completo.
 *
 * Aceita ambos os naming schemes do È IA? (#192 novo A/B + legacy real/ia).
 */
export function findMissingStage3Outputs(editionDir: string): Missing[] {
  const missing: Missing[] = [];

  // 1. EIA images (aceita A/B novo ou legacy real/ia)
  const eaiA = resolve(editionDir, "01-eia-A.jpg");
  const eaiB = resolve(editionDir, "01-eia-B.jpg");
  const eaiReal = resolve(editionDir, "01-eia-real.jpg");
  const eaiIa = resolve(editionDir, "01-eia-ia.jpg");
  const hasNewPair = existsSync(eaiA) && existsSync(eaiB);
  const hasLegacyPair = existsSync(eaiReal) && existsSync(eaiIa);
  if (!hasNewPair && !hasLegacyPair) {
    missing.push({
      file: "01-eia-{A,B}.jpg",
      category: "eia-image",
      reason: "par de imagens È IA? ausente (nem A/B nem legacy real/ia)",
    });
  } else {
    // Validate non-empty
    const checkPair = hasNewPair ? [eaiA, eaiB] : [eaiReal, eaiIa];
    for (const p of checkPair) {
      try {
        if (statSync(p).size === 0) {
          missing.push({
            file: p.split(/[\\/]/).pop()!,
            category: "eia-image",
            reason: "arquivo existe mas está vazio (0 bytes)",
          });
        }
      } catch {
        // Already handled by existsSync above
      }
    }
  }

  // 2. Destaque images — D3 apenas requerida em edições 3-destaque (#2352).
  // #2366: lista derivada de REQUIRED_IMAGES_BASE/D3 (stage-3.ts) em vez de
  // re-listada inline, para não divergir de novo (04-d2-2x1.jpg hero D2 estava
  // ausente desta validação apesar de constar na fonte canônica).
  const destaqueCount = readDestaqueCount(editionDir);
  const destaques =
    destaqueCount === 2
      ? DESTAQUE_IMAGES_BASE
      : [...DESTAQUE_IMAGES_BASE, ...DESTAQUE_IMAGES_D3];
  for (const name of destaques) {
    const p = resolve(editionDir, name);
    if (!existsSync(p)) {
      missing.push({ file: name, category: "destaque-image", reason: "imagem de destaque ausente" });
    } else {
      try {
        if (statSync(p).size === 0) {
          missing.push({ file: name, category: "destaque-image", reason: "imagem vazia (0 bytes)" });
        }
      } catch {
        /* ignore */
      }
    }
  }

  // 3. EIA metadata JSON
  const metaPath = resolve(editionDir, "_internal/01-eia-meta.json");
  if (!existsSync(metaPath)) {
    missing.push({
      file: "_internal/01-eia-meta.json",
      category: "eia-metadata",
      reason: "metadata do È IA? ausente (eia-compose pode ter falhado)",
    });
  }

  // 4. EIA markdown
  const eiaMd = resolve(editionDir, "01-eia.md");
  if (!existsSync(eiaMd)) {
    missing.push({
      file: "01-eia.md",
      category: "eia-md",
      reason: "MD do È IA? ausente (eia-compose pode ter falhado)",
    });
  }

  return missing;
}

function parseArgs(argv: string[]): { editionDir: string } {
  let editionDir = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--edition-dir" && i + 1 < argv.length) {
      editionDir = argv[i + 1];
      i++;
    }
  }
  if (!editionDir) {
    process.stderr.write("Usage: validate-stage-3-completeness.ts --edition-dir <path>\n");
    process.exit(2);
  }
  return { editionDir };
}

function main(): void {
  const { editionDir } = parseArgs(process.argv.slice(2));
  const absDir = resolve(editionDir);
  if (!existsSync(absDir)) {
    process.stderr.write(`[validate-stage-3] edition dir ausente: ${absDir}\n`);
    process.exit(2);
  }

  const missing = findMissingStage3Outputs(absDir);
  if (missing.length === 0) {
    process.stdout.write(JSON.stringify({ ok: true, edition_dir: editionDir }, null, 2) + "\n");
    process.exit(0);
  }

  process.stderr.write("[validate-stage-3] Outputs ausentes:\n");
  for (const m of missing) {
    process.stderr.write(`  - ${m.file} (${m.category}): ${m.reason}\n`);
  }
  process.stdout.write(
    JSON.stringify({ ok: false, edition_dir: editionDir, missing }, null, 2) + "\n",
  );
  process.exit(1);
}

const isMain = process.argv[1]?.replace(/\\/g, "/").endsWith("validate-stage-3-completeness.ts");
if (isMain) {
  main();
}
