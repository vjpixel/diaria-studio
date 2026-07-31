/**
 * test/update-audience-archive-guard.test.ts (#4366)
 *
 * Regressão pro guard de archive duplicado em `scripts/update-audience.ts`:
 * arquivar `context/audience-profile.md` sob uma data nova quando o conteúdo é
 * byte-a-byte idêntico ao arquivo de histórico mais recente já existente é
 * sinal de que uma rodada anterior falhou/crashou entre o archive e o write
 * final — a regeneração daquela rodada nunca aconteceu. O guard não bloqueia
 * (a rodada de hoje pode legitimamente ter sucesso), só loga um warning.
 *
 * Cobre:
 *   - findLatestHistoryFile: seleciona o arquivo mais recente (ordenação
 *     lexicográfica de nomes YYYY-MM-DD), excluindo o arquivo de hoje, ignora
 *     arquivos que não casam o padrão de data, e retorna null sem diretório /
 *     sem arquivos.
 *   - detectDuplicateArchiveWarning: warning quando o conteúdo prestes a ser
 *     arquivado é idêntico ao último já arquivado (cenário exato do #4366:
 *     2026-07-29.md e 2026-07-30.md ambos com o conteúdo stale de 07-27);
 *     null no caminho feliz (conteúdo genuinamente diferente); null quando não
 *     há histórico anterior pra comparar (1º archive de sempre).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLatestHistoryFile,
  detectDuplicateArchiveWarning,
} from "../scripts/update-audience.ts";

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "update-audience-archive-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findLatestHistoryFile", () => {
  it("retorna null quando o diretório de histórico não existe", () => {
    assert.equal(findLatestHistoryFile(join(dir, "nao-existe")), null);
  });

  it("retorna null quando o diretório existe mas está vazio", () => {
    const empty = join(dir, "vazio");
    mkdirSync(empty);
    assert.equal(findLatestHistoryFile(empty), null);
  });

  it("escolhe o arquivo com a data mais recente (ordenação lexicográfica YYYY-MM-DD)", () => {
    const d = join(dir, "ordenado");
    mkdirSync(d);
    writeFileSync(join(d, "2026-07-25.md"), "a", "utf8");
    writeFileSync(join(d, "2026-07-27.md"), "b", "utf8");
    writeFileSync(join(d, "2026-07-29.md"), "c", "utf8");
    assert.equal(findLatestHistoryFile(d), "2026-07-29.md");
  });

  it("exclui o arquivo de hoje passado em excludeFilename", () => {
    const d = join(dir, "exclui-hoje");
    mkdirSync(d);
    writeFileSync(join(d, "2026-07-29.md"), "a", "utf8");
    writeFileSync(join(d, "2026-07-30.md"), "b", "utf8");
    // Se 2026-07-30.md já existir (re-run no mesmo dia), excluí-lo revela o
    // penúltimo, não ele mesmo.
    assert.equal(findLatestHistoryFile(d, "2026-07-30.md"), "2026-07-29.md");
  });

  it("ignora arquivos que não casam o padrão de data YYYY-MM-DD.md", () => {
    const d = join(dir, "ignora-lixo");
    mkdirSync(d);
    writeFileSync(join(d, "2026-07-27.md"), "a", "utf8");
    writeFileSync(join(d, "README.md"), "not a snapshot", "utf8");
    writeFileSync(join(d, "2026-07.md"), "sem o dia — não casa o padrão", "utf8");
    writeFileSync(join(d, "notas.txt"), "extensão errada", "utf8");
    assert.equal(findLatestHistoryFile(d), "2026-07-27.md");
  });
});

describe("detectDuplicateArchiveWarning", () => {
  it("cenário real do #4366: conteúdo idêntico ao último arquivado gera warning", () => {
    const staleContent = "# Perfil de Audiência — Diar.ia\n\n**updated_at:** 2026-07-27\n";
    const warning = detectDuplicateArchiveWarning(
      staleContent,
      "2026-07-30.md",
      "2026-07-29.md",
      staleContent,
    );
    assert.notEqual(warning, null);
    assert.match(warning!, /idêntico ao mais recente já arquivado/);
    assert.match(warning!, /2026-07-30\.md/);
    assert.match(warning!, /2026-07-29\.md/);
  });

  it("caminho feliz: conteúdo genuinamente diferente não gera warning", () => {
    const oldContent = "# Perfil de Audiência — Diar.ia\n\n**updated_at:** 2026-07-29\n";
    const newContent = "# Perfil de Audiência — Diar.ia\n\n**updated_at:** 2026-07-30\n";
    assert.equal(
      detectDuplicateArchiveWarning(newContent, "2026-07-30.md", "2026-07-29.md", oldContent),
      null,
    );
  });

  it("sem histórico anterior (1º archive de sempre) não gera warning", () => {
    assert.equal(
      detectDuplicateArchiveWarning("qualquer conteúdo", "2026-07-30.md", null, null),
      null,
    );
  });
});
