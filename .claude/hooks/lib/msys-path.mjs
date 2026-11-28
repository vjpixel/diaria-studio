// Caminho do Git Bash (MSYS) para o caminho que o Node entende no Windows
// (#14216; movido para cá no #14321, para os guards não importarem uns aos
// outros): `/c/Users/x` → `C:/Users/x`, `/tmp/x` → `{tmpdir}/x`. Sem isso o
// `resolve` do Node lê `/c/Users` como `C:\c\Users`. Fora do Windows, igual.
import { tmpdir } from "node:os";

export function normalizeMsysPath(p, platform = process.platform, tmp = tmpdir) {
  if (platform !== "win32" || typeof p !== "string") return p;
  const drive = /^\/([a-zA-Z])(?=\/|$)/.exec(p);
  if (drive) return `${drive[1].toUpperCase()}:${p.slice(2) || "/"}`;
  if (p === "/tmp" || p.startsWith("/tmp/")) return `${tmp().replaceAll("\\", "/")}${p.slice(4)}`;
  return p;
}
