// #13404: o bisync do data/ no 300 abortava toda rodada porque um corpo salvo em
// editions/*/_internal/_forensic/link-verify-bodies/ foi marcado pelo Google como
// malware (403 cannotDownloadAbusiveFile). Sem listagem salva, a rodada seguinte
// via arquivos mexidos no Neo como "changed in both paths" e, com mtime empatado,
// renomeava as duas cópias (.conflictN), sumindo com o original (blocks.json).
// O filtro do sync de data/ exclui _forensic/ inteiro (cache por máquina). A
// profundidade com o rclone real é provada em data-sync-exclusions-12357.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const filters = readFileSync(new URL("../scripts/systemd/gdrive-data-bisync-filters.txt", import.meta.url), "utf8");
const rules = filters.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

test("#13404: o filtro do bisync de data/ declara '- _forensic/**' sem âncora na raiz", () => {
  assert.ok(rules.includes("- _forensic/**"), "falta '- _forensic/**' no gdrive-data-bisync-filters.txt");
  assert.ok(!rules.some((r) => r.startsWith("- /_forensic")), "regra ancorada na raiz não casa em editions/*/_internal/");
});

test("#13404: a exclusão de _forensic/ não é inclusão (nenhum '+ _forensic')", () => {
  assert.ok(!rules.some((r) => r.startsWith("+") && r.includes("_forensic")));
});
