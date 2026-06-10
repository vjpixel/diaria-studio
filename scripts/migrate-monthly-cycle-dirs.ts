/**
 * migrate-monthly-cycle-dirs.ts (#1962)
 *
 * Renomeia pastas `data/monthly/{YYMM}/` → `data/monthly/{YYMM}-{MM+1}/`
 * (mês de envio = conteúdo + 1, com rollover dez→jan no sufixo MM).
 *
 * Exemplos:
 *   data/monthly/2604/  →  data/monthly/2604-05/
 *   data/monthly/2605/  →  data/monthly/2605-06/
 *   data/monthly/2612/  →  data/monthly/2612-01/
 *
 * Regras:
 *   - Pastas que já estão no formato `{YYMM}-{MM}` são puladas (idempotente).
 *   - Pastas cujo nome não é YYMM nem {YYMM}-{MM} são ignoradas (aviso).
 *   - Dry-run por default: imprime o plano sem executar nada.
 *   - `--execute` para valer.
 *
 * Uso:
 *   npx tsx scripts/migrate-monthly-cycle-dirs.ts             # dry-run (ver plano)
 *   npx tsx scripts/migrate-monthly-cycle-dirs.ts --execute   # executar
 *
 * NOTA: este script NÃO toca em `data/clarice-subscribers/` — essa pasta já
 * foi migrada pelo #1961. Aqui só `data/monthly/`.
 *
 * NOTA OPERACIONAL (#2048 item 11): `--execute` pode falhar com EPERM transiente
 * se o OneDrive estiver sincronizando o diretório no momento do `renameSync`.
 * O script é **idempotente** — pastas já no formato novo são puladas. Re-rodar
 * depois que o OneDrive terminar a sincronização resolve sem side-effects.
 *
 * O coordenador executa este script após o merge do PR do #1962.
 */

import { readdirSync, renameSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isValidYymm,
  isValidMonthlyCycle,
  yymmToCycle,
  MONTHLY_BASE,
} from "./lib/monthly-paths.ts";

const EXECUTE = process.argv.includes("--execute");

interface MigrationEntry {
  from: string;   // nome do diretório atual
  to: string;     // nome do diretório destino
  fromPath: string;
  toPath: string;
  status: "migrate" | "skip-already-new" | "skip-unknown" | "skip-dest-exists";
  note?: string;
}

function planMigration(): MigrationEntry[] {
  if (!existsSync(MONTHLY_BASE)) {
    console.warn(`[migrate] data/monthly/ não existe — nada a migrar.`);
    return [];
  }

  const entries: MigrationEntry[] = [];
  const dirs = readdirSync(MONTHLY_BASE, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const name of dirs) {
    const fromPath = join(MONTHLY_BASE, name);

    // Já está no formato novo → skip idempotente
    if (isValidMonthlyCycle(name)) {
      entries.push({
        from: name,
        to: name,
        fromPath,
        toPath: fromPath,
        status: "skip-already-new",
        note: "já no formato {conteúdo}-{envio}",
      });
      continue;
    }

    // Formato legado YYMM → migrar
    if (isValidYymm(name)) {
      const newName = yymmToCycle(name);
      const toPath = join(MONTHLY_BASE, newName);

      // Destino já existe (migração parcial?) → skip com aviso
      if (existsSync(toPath)) {
        entries.push({
          from: name,
          to: newName,
          fromPath,
          toPath,
          status: "skip-dest-exists",
          note: `destino "${newName}" já existe — renomear manual necessário`,
        });
        continue;
      }

      entries.push({
        from: name,
        to: newName,
        fromPath,
        toPath,
        status: "migrate",
      });
      continue;
    }

    // Nome desconhecido (ex: _temp, rascunho, etc.) → ignorar
    entries.push({
      from: name,
      to: name,
      fromPath,
      toPath: fromPath,
      status: "skip-unknown",
      note: "nome não reconhecido (não é YYMM nem {YYMM}-{MM})",
    });
  }

  return entries;
}

function main(): void {
  const plan = planMigration();

  if (plan.length === 0) {
    console.log("[migrate] Nenhum diretório para processar.");
    return;
  }

  const toMigrate = plan.filter((e) => e.status === "migrate");
  const alreadyNew = plan.filter((e) => e.status === "skip-already-new");
  const destExists = plan.filter((e) => e.status === "skip-dest-exists");
  const unknown = plan.filter((e) => e.status === "skip-unknown");

  console.log(`\n[migrate] Plano de migração — data/monthly/`);
  console.log(`  Para migrar:      ${toMigrate.length}`);
  console.log(`  Já no formato novo: ${alreadyNew.length}`);
  console.log(`  Destino já existe:  ${destExists.length}`);
  console.log(`  Desconhecidos:    ${unknown.length}`);

  if (toMigrate.length > 0) {
    console.log(`\nMigrações:`);
    for (const e of toMigrate) {
      console.log(`  ${e.from}/ → ${e.to}/`);
    }
  }

  if (destExists.length > 0) {
    console.warn(`\nWarnings (destino já existe — revisar manualmente):`);
    for (const e of destExists) {
      console.warn(`  ${e.from}/ → ${e.to}/ ← ${e.note}`);
    }
  }

  if (unknown.length > 0) {
    console.log(`\nIgnorados (nome não reconhecido):`);
    for (const e of unknown) {
      console.log(`  ${e.from}/ — ${e.note}`);
    }
  }

  if (!EXECUTE) {
    console.log(
      `\n[migrate] DRY RUN — nenhuma alteração feita. ` +
      `Rode com --execute para aplicar.`,
    );
    if (toMigrate.length > 0) {
      console.log(
        `  Comando: npx tsx scripts/migrate-monthly-cycle-dirs.ts --execute`,
      );
    }
    return;
  }

  // Execução real
  let ok = 0;
  let failed = 0;
  for (const e of toMigrate) {
    try {
      renameSync(e.fromPath, e.toPath);
      console.log(`  ✓ ${e.from}/ → ${e.to}/`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${e.from}/: ${(err as Error).message}`);
      failed++;
    }
  }

  console.log(
    `\n[migrate] Concluído: ${ok} migrada${ok === 1 ? "" : "s"}, ${failed} falha${failed === 1 ? "" : "s"}.`,
  );
  if (failed > 0) process.exit(1);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
