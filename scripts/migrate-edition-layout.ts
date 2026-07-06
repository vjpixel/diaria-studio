/**
 * migrate-edition-layout.ts (#2463)
 *
 * Migra `data/editions/{AAMMDD}/` (layout FLAT legado) para
 * `data/editions/{AAMM}/{AAMMDD}/` (layout NESTED por mês, #2463) — o mesmo
 * layout que já é usado pelo Google Drive sync
 * (`Work/Startups/diar.ia/edicoes/{YYMM}/{AAMMDD}/`).
 *
 * Também cobre variantes `*-backup-*` (ex: `260420-backup-antes-fix/`) —
 * extrai o AAMMDD do prefixo do nome e migra sob o mesmo {AAMM}.
 *
 * Modo de operação:
 *   npx tsx scripts/migrate-edition-layout.ts               # dry-run (default) — só imprime o plano
 *   npx tsx scripts/migrate-edition-layout.ts --execute      # executa de verdade (rename, não copy+delete)
 *   npx tsx scripts/migrate-edition-layout.ts --undo         # dry-run do undo (nested → flat)
 *   npx tsx scripts/migrate-edition-layout.ts --undo --execute  # reverte de verdade
 *
 * Reversibilidade: a operação é simétrica. `--undo` faz o rename inverso
 * (`data/editions/{AAMM}/{AAMMDD}/` → `data/editions/{AAMMDD}/`), incluindo
 * variantes `*-backup-*`. Sem `--undo`, roda o forward (flat → nested).
 *
 * Idempotência: já-nested é sempre pulado (não há double-nesting); já-flat
 * (ao rodar `--undo`) também é pulado. Rodar 2x seguidas é sempre no-op na
 * 2ª vez.
 *
 * Atomicidade: usa `fs.renameSync` (rename, NÃO copy-then-delete) — em
 * `data/` (directory junction do OneDrive, business-sensitive), um
 * copy-then-delete interrompido no meio poderia perder dados durante sync;
 * um rename dentro do MESMO filesystem é atômico. `renameSync` entre
 * `data/editions/{AAMMDD}` e `data/editions/{AAMM}/{AAMMDD}` fica dentro da
 * mesma junction/volume (ambos sob `data/editions/`), então não atravessa
 * fronteira de filesystem.
 *
 * IMPORTANTE: este script NÃO é rodado automaticamente por este PR. A
 * execução real (`--execute`) contra `data/editions/` de verdade é a Etapa 3
 * do #2463 — requer Gate B explícito com o editor (diff-walkthrough + 1
 * pasta de exemplo antes/depois + resultado de teste local) antes de rodar.
 */

import {
  readdirSync,
  renameSync,
  existsSync,
  statSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

const EXECUTE = process.argv.includes("--execute");
const UNDO = process.argv.includes("--undo");

const EDITIONS_ROOT = join("data", "editions");
const AAMMDD_RE = /^\d{6}$/;
const AAMM_RE = /^\d{4}$/;
// Aceita nomes tipo "260420" ou "260420-backup-antes-fix" — captura o AAMMDD líder.
const AAMMDD_PREFIXED_RE = /^(\d{6})(-.*)?$/;

export interface MigrationEntry {
  from: string; // path relativo (a partir de data/editions/), forma de exibição
  to: string;
  fromPath: string;
  toPath: string;
  status: "migrate" | "skip-already-target" | "skip-unknown" | "skip-dest-exists";
  note?: string;
}

/**
 * Plano de migração FORWARD: flat `data/editions/{AAMMDD}[-suffix]/` →
 * nested `data/editions/{AAMM}/{AAMMDD}[-suffix]/`.
 */
export function planForward(
  editionsRoot: string = EDITIONS_ROOT,
): MigrationEntry[] {
  if (!existsSync(editionsRoot)) {
    return [];
  }

  const entries: MigrationEntry[] = [];
  const names = readdirSync(editionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const name of names) {
    const fromPath = join(editionsRoot, name);

    // Já é um diretório {AAMM} (layout novo) — não é candidato a mover, é o destino.
    if (AAMM_RE.test(name)) {
      continue;
    }

    const m = AAMMDD_PREFIXED_RE.exec(name);
    if (!m) {
      entries.push({
        from: name,
        to: name,
        fromPath,
        toPath: fromPath,
        status: "skip-unknown",
        note: "nome não reconhecido (não é AAMMDD nem AAMMDD-suffix nem AAMM)",
      });
      continue;
    }

    const aammdd = m[1];
    const aamm = aammdd.slice(0, 4);
    const toPath = join(editionsRoot, aamm, name);

    if (existsSync(toPath)) {
      entries.push({
        from: name,
        to: join(aamm, name),
        fromPath,
        toPath,
        status: "skip-dest-exists",
        note: `destino "${join(aamm, name)}" já existe`,
      });
      continue;
    }

    entries.push({
      from: name,
      to: join(aamm, name),
      fromPath,
      toPath,
      status: "migrate",
    });
  }

  return entries;
}

/**
 * Plano de migração UNDO: nested `data/editions/{AAMM}/{AAMMDD}[-suffix]/` →
 * flat `data/editions/{AAMMDD}[-suffix]/`.
 */
export function planUndo(
  editionsRoot: string = EDITIONS_ROOT,
): MigrationEntry[] {
  if (!existsSync(editionsRoot)) {
    return [];
  }

  const entries: MigrationEntry[] = [];
  const aammDirs = readdirSync(editionsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && AAMM_RE.test(d.name))
    .map((d) => d.name)
    .sort();

  for (const aamm of aammDirs) {
    const aammPath = join(editionsRoot, aamm);
    const subNames = readdirSync(aammPath, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    for (const name of subNames) {
      const fromPath = join(aammPath, name);
      const m = AAMMDD_PREFIXED_RE.exec(name);
      if (!m || !name.startsWith(aamm)) {
        entries.push({
          from: join(aamm, name),
          to: join(aamm, name),
          fromPath,
          toPath: fromPath,
          status: "skip-unknown",
          note: `nome não reconhecido sob ${aamm}/ (não é AAMMDD nem AAMMDD-suffix consistente)`,
        });
        continue;
      }

      const toPath = join(editionsRoot, name);
      if (existsSync(toPath)) {
        entries.push({
          from: join(aamm, name),
          to: name,
          fromPath,
          toPath,
          status: "skip-dest-exists",
          note: `destino flat "${name}" já existe`,
        });
        continue;
      }

      entries.push({
        from: join(aamm, name),
        to: name,
        fromPath,
        toPath,
        status: "migrate",
      });
    }
  }

  return entries;
}

function printPlan(plan: MigrationEntry[], mode: "forward" | "undo"): void {
  const toMigrate = plan.filter((e) => e.status === "migrate");
  const destExists = plan.filter((e) => e.status === "skip-dest-exists");
  const unknown = plan.filter((e) => e.status === "skip-unknown");

  const label =
    mode === "forward"
      ? "flat → nested ({AAMM}/{AAMMDD})"
      : "nested → flat (undo)";
  console.log(`\n[migrate-edition-layout] Plano (${label}) — data/editions/`);
  console.log(`  Para migrar:       ${toMigrate.length}`);
  console.log(`  Destino já existe: ${destExists.length}`);
  console.log(`  Desconhecidos:     ${unknown.length}`);

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
}

/**
 * Executa o plano com `renameSync` (atômico, não copy+delete). Cria o
 * diretório-pai `{AAMM}/` se necessário antes do rename.
 */
export function executeMigration(plan: MigrationEntry[]): {
  ok: number;
  failed: number;
} {
  let ok = 0;
  let failed = 0;
  const toMigrate = plan.filter((e) => e.status === "migrate");

  for (const e of toMigrate) {
    try {
      const parentDir = join(e.toPath, "..");
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }
      renameSync(e.fromPath, e.toPath);
      console.log(`  ✓ ${e.from}/ → ${e.to}/`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${e.from}/: ${(err as Error).message}`);
      failed++;
    }
  }

  return { ok, failed };
}

function main(): void {
  const mode: "forward" | "undo" = UNDO ? "undo" : "forward";
  const plan = mode === "forward" ? planForward() : planUndo();

  if (plan.length === 0) {
    console.log(
      `[migrate-edition-layout] Nenhum diretório para processar (${mode}).`,
    );
    return;
  }

  printPlan(plan, mode);

  if (!EXECUTE) {
    console.log(
      `\n[migrate-edition-layout] DRY RUN — nenhuma alteração feita. ` +
        `Rode com --execute para aplicar.`,
    );
    console.log(
      `  Comando: npx tsx scripts/migrate-edition-layout.ts${UNDO ? " --undo" : ""} --execute`,
    );
    return;
  }

  const { ok, failed } = executeMigration(plan);
  console.log(
    `\n[migrate-edition-layout] Concluído: ${ok} migrada${ok === 1 ? "" : "s"}, ${failed} falha${failed === 1 ? "" : "s"}.`,
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
