/**
 * scripts/lib/walk-file-sizes.ts (#10957)
 *
 * Lista recursiva de arquivos com tamanho, relativa a uma raiz, com `/`
 * como separador. Não segue symlink/junction INTERNO (só a raiz pode ser
 * um link, como `data/` → OneDrive) — um link dentro de `data/` contaria
 * em dobro ou sairia da árvore. Erro de leitura num subdiretório pula
 * aquele ramo em vez de derrubar a varredura inteira (um arquivo que o
 * OneDrive está trocando no meio da leitura não pode apagar o alarme).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface FileSize {
  relPath: string;
  sizeBytes: number;
}

export function walkFileSizes(root: string, onError?: (relDir: string, err: Error) => void): FileSize[] {
  const out: FileSize[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch (e) {
      onError?.(relDir, e as Error);
      continue;
    }
    for (const ent of entries) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        stack.push(rel);
      } else if (ent.isFile()) {
        try {
          out.push({ relPath: rel, sizeBytes: statSync(join(root, rel)).size });
        } catch {
          // sumiu entre o readdir e o stat — ignora
        }
      }
    }
  }
  return out;
}
