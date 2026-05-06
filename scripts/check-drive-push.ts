/**
 * check-drive-push.ts (#694)
 *
 * Verifica que um arquivo foi pushed para o Drive antes de apresentar um gate.
 * Substitui o bloco inline `node -e "..."` no orchestrator Stage 1w.
 *
 * Motivo: o bloco inline usa dot-notation frágil (`cache.editions[AAMMDD]?.files?.[file]`)
 * que silenciosamente retorna undefined se o schema do drive-cache.json mudar,
 * causando FATAL falso. Este script valida o schema antes de acessar os campos.
 *
 * Uso:
 *   npx tsx scripts/check-drive-push.ts --edition 260506 --file 01-categorized.md
 *
 * Exit codes:
 *   0 = pushed (ou drive_sync desabilitado)
 *   1 = não pushed (step 1w foi skipado — re-rodar antes do gate)
 *   2 = erro de leitura / schema inesperado (warn, não bloqueia — evita falso FATAL)
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface DriveCacheFile {
  push_count?: number;
  drive_file_id?: string;
  [key: string]: unknown;
}

interface DriveCacheEdition {
  day_folder_id?: string;
  files?: Record<string, DriveCacheFile>;
  [key: string]: unknown;
}

interface DriveCache {
  editions?: Record<string, DriveCacheEdition>;
  [key: string]: unknown;
}

/**
 * Lê e valida o drive-cache.json de forma segura.
 * Retorna null (com warn) se o arquivo não existe ou tem schema inesperado.
 */
export function readDriveCache(cachePath: string): DriveCache | null {
  if (!existsSync(cachePath)) return null;
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8"));
    // Validação mínima: deve ser objeto com campo editions
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return raw as DriveCache;
  } catch {
    return null;
  }
}

/**
 * Retorna o push_count de um arquivo em uma edição, ou null se não encontrado.
 * Nunca lança — schema inesperado retorna null.
 */
export function getPushCount(
  cache: DriveCache,
  edition: string,
  filename: string,
): number | null {
  try {
    const editionEntry = cache.editions?.[edition];
    if (!editionEntry || typeof editionEntry !== "object") return null;
    const fileEntry = editionEntry.files?.[filename];
    if (!fileEntry || typeof fileEntry !== "object") return null;
    const count = fileEntry.push_count;
    return typeof count === "number" && count > 0 ? count : null;
  } catch {
    return null;
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--") && i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const edition = args["edition"];
  const filename = args["file"] ?? "01-categorized.md";

  if (!edition) {
    console.error("Uso: check-drive-push.ts --edition AAMMDD [--file filename]");
    process.exit(2);
  }

  const configPath = resolve(ROOT, "platform.config.json");
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, "utf8"));
      if (cfg?.drive_sync === false) {
        console.log("drive_sync=false — anti-skip check ignorado");
        process.exit(0);
      }
    } catch {
      // Se não conseguir ler config, prosseguir com a verificação
    }
  }

  const cachePath = resolve(ROOT, "data/drive-cache.json");
  const cache = readDriveCache(cachePath);

  if (!cache) {
    if (!existsSync(cachePath)) {
      console.error(`FATAL: drive_sync ativo mas data/drive-cache.json não existe. Step 1w foi skipado.`);
      process.exit(1);
    }
    // Cache existe mas schema inesperado — warn mas não bloquear (#694)
    console.error(
      `WARN: data/drive-cache.json com schema inesperado — não foi possível verificar push. ` +
      `Verifique se drive-sync.ts foi atualizado. Prosseguindo sem garantia de push.`,
    );
    process.exit(2);
  }

  if (!cache.editions) {
    // Cache sem campo editions = schema v-nova desconhecida — warn, não FATAL
    console.error(
      `WARN: drive-cache.json não tem campo 'editions' — schema pode ter mudado. ` +
      `Anti-skip check ignorado para evitar falso FATAL (#694).`,
    );
    process.exit(2);
  }

  const pushCount = getPushCount(cache, edition, filename);
  if (!pushCount) {
    console.error(
      `FATAL: ${filename} não foi pushed para o Drive (edição ${edition}). ` +
      `Step 1w foi skipado. Re-rodar push antes do gate.`,
    );
    process.exit(1);
  }

  console.log(`✓ ${filename} pushed para o Drive (push #${pushCount}, edição ${edition})`);
  process.exit(0);
}

const _argv1 = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  import.meta.url === `file://${_argv1}` ||
  import.meta.url === `file:///${_argv1.replace(/^\//, "")}`
) {
  main();
}
