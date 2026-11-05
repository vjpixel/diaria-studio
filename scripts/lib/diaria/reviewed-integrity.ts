/**
 * reviewed-integrity.ts (#12259)
 *
 * Dois guards do Stage 4 sobre a integridade de `02-reviewed.md`:
 *
 * 1. `reviewed-no-pending-placeholder` (error): o arquivo não chega ao gate com
 *    os placeholders do swap/promote (`[RASCUNHO PENDENTE ...]`,
 *    `[TEXTO PENDENTE ...]`). O invariante `titulo-subtitulo-not-provisional`
 *    (#9601) só olha o placeholder quando o marcador do swap ainda existe e o
 *    TÍTULO/SUBTÍTULO carrega o título provisório; fora disso, quem percebia era
 *    o fact-checker.
 *
 * 2. `reviewed-onedrive-conflict-copy` (warning): `data/` é sincronizado pelo
 *    OneDrive. Quando o cliente acha que a cópia local e a da nuvem mudaram ao
 *    mesmo tempo, ele renomeia a LOCAL para `{nome}-{host}-safeBackup-NNNN.md` e
 *    baixa a da nuvem no lugar, sem erro para quem escreveu. Foi a causa da
 *    edição 261105: o texto do D3 foi integrado às 16:44:19 UTC (19 s depois do
 *    swap-destaque gravar o placeholder), e o `02-reviewed-300-safeBackup-0001.md`
 *    dessa hora tem o texto integrado; o principal voltou ao estado do swap, com
 *    o placeholder e o título provisório. O mesmo arquivo aparece em 260818 e
 *    261027. O guard avisa que existe a cópia, para o editor comparar antes de
 *    aprovar.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { InvariantViolation } from "../invariant-checks/types.ts";

/** Placeholders escritos por `swap-destaque.ts`/`swap-destaques.ts`/`promote-to-destaque.ts`. */
const PENDING_PLACEHOLDER_RE = /\[(?:RASCUNHO|TEXTO) PENDENTE\b[^\]\n]*\]/g;

export interface PendingPlaceholder {
  line: number;
  text: string;
}

/** Placeholders `[RASCUNHO PENDENTE ...]`/`[TEXTO PENDENTE ...]` no MD, com a linha (1-based). @pure */
export function findPendingPlaceholders(md: string): PendingPlaceholder[] {
  const out: PendingPlaceholder[] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const m of lines[i].matchAll(PENDING_PLACEHOLDER_RE)) {
      out.push({ line: i + 1, text: m[0] });
    }
  }
  return out;
}

export function checkReviewedNoPendingPlaceholder(editionDir: string): InvariantViolation[] {
  const path = resolve(editionDir, "02-reviewed.md");
  if (!existsSync(path)) return [];
  const found = findPendingPlaceholders(readFileSync(path, "utf8"));
  if (found.length === 0) return [];
  const list = found.map((p) => `linha ${p.line}: ${p.text}`).join("; ");
  return [
    {
      rule: "reviewed-no-pending-placeholder",
      message:
        `02-reviewed.md tem ${found.length} placeholder(s) de destaque não integrado(s) (${list}). ` +
        `Rodar o writer-destaque da posição e integrar o texto. Se o texto já tinha sido integrado, ` +
        `procurar uma cópia de conflito do OneDrive (02-reviewed-*-safeBackup-*.md) na pasta da edição: ` +
        `ela costuma ter a versão integrada (#12259).`,
      source_issue: "#12259",
      severity: "error",
      file: path,
      line: found[0].line,
    },
  ];
}

/** Cópia de conflito do OneDrive (`{base}-{host}-safeBackup-NNNN.md`) de um arquivo editorial. @pure */
export function isOnedriveConflictCopyOf(fileName: string, base: string): boolean {
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${esc}-.+-safeBackup-\\d+\\.md$`).test(fileName);
}

const EDITORIAL_FILES = ["02-reviewed", "03-social"] as const;

export function checkReviewedOnedriveConflictCopy(editionDir: string): InvariantViolation[] {
  if (!existsSync(editionDir)) return [];
  let names: string[];
  try {
    names = readdirSync(editionDir);
  } catch {
    return [];
  }
  const out: InvariantViolation[] = [];
  for (const base of EDITORIAL_FILES) {
    const copies = names.filter((n) => isOnedriveConflictCopyOf(n, base)).sort();
    if (copies.length === 0) continue;
    const mainPath = resolve(editionDir, `${base}.md`);
    const described = copies.map((n) => {
      try {
        return `${n} (${statSync(resolve(editionDir, n)).mtime.toISOString()})`;
      } catch {
        return n;
      }
    });
    out.push({
      rule: "reviewed-onedrive-conflict-copy",
      message:
        `O OneDrive resolveu um conflito de sync em ${base}.md: ${described.join(", ")}. Nessa resolução a ` +
        `versão LOCAL vai para a cópia e o principal recebe a da nuvem, então uma edição pode ter sido ` +
        `desfeita sem aviso (caso 261105: o D3 integrado foi para a cópia e o placeholder voltou). ` +
        `Comparar com \`diff "${resolve(editionDir, copies[copies.length - 1])}" "${mainPath}"\` antes de aprovar (#12259).`,
      source_issue: "#12259",
      severity: "warning",
      file: mainPath,
    });
  }
  return out;
}
