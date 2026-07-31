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
 *   - handleArchiveGuard: no cenário de duplicata, chama tanto o warnFn
 *     (console.warn) quanto dispara `log-event.ts` (via spawnFn injetado) com
 *     `--level warn` e `--details` referenciando `#4366` + os 2 nomes de
 *     arquivo; no caminho feliz, NENHUM dos dois canais dispara — o warning
 *     fica consultável depois via `/diaria-log`, não só no stdout da sessão
 *     que rodou o Stage 0 (achado do self-review do #4366).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { spawnSync } from "node:child_process";
import {
  findLatestHistoryFile,
  detectDuplicateArchiveWarning,
  buildDuplicateArchiveLogArgs,
  handleArchiveGuard,
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

describe("buildDuplicateArchiveLogArgs", () => {
  it("monta argv com --level warn e --details referenciando #4366 + os 2 arquivos", () => {
    const args = buildDuplicateArchiveLogArgs("2026-07-30.md", "2026-07-29.md");
    assert.equal(args[args.indexOf("--level") + 1], "warn");
    assert.equal(args[args.indexOf("--agent") + 1], "update-audience");
    const details = JSON.parse(args[args.indexOf("--details") + 1]);
    assert.equal(details.issue, "#4366");
    assert.equal(details.today_file, "2026-07-30.md");
    assert.equal(details.latest_file, "2026-07-29.md");
  });
});

describe("handleArchiveGuard", () => {
  // Mock mínimo de spawnSync — captura a chamada sem spawnar processo real.
  // Cast necessário porque o retorno real de spawnSync tem mais campos do que
  // o teste precisa popular.
  function mockSpawn(): { calls: unknown[][]; fn: typeof spawnSync } {
    const calls: unknown[][] = [];
    const fn = ((...args: unknown[]) => {
      calls.push(args);
      return { status: 0 } as ReturnType<typeof spawnSync>;
    }) as typeof spawnSync;
    return { calls, fn };
  }

  it("cenário real do #4366: duplicata dispara console.warn E log-event (--level warn, details com #4366)", () => {
    const staleContent = "# Perfil de Audiência — Diar.ia\n\n**updated_at:** 2026-07-27\n";
    const { calls, fn } = mockSpawn();
    const warnCalls: string[] = [];

    handleArchiveGuard(
      staleContent,
      "2026-07-30.md",
      "2026-07-29.md",
      staleContent,
      fn,
      (msg) => warnCalls.push(msg),
    );

    assert.equal(warnCalls.length, 1, "console.warn deve disparar 1x");
    assert.match(warnCalls[0], /idêntico ao mais recente já arquivado/);

    assert.equal(calls.length, 1, "log-event (via spawnFn) deve disparar 1x");
    const spawnArgs = calls[0][1] as string[]; // (command, args, options)
    assert.equal(spawnArgs[spawnArgs.indexOf("--level") + 1], "warn");
    const details = JSON.parse(spawnArgs[spawnArgs.indexOf("--details") + 1]);
    assert.equal(details.issue, "#4366");
    assert.equal(details.today_file, "2026-07-30.md");
    assert.equal(details.latest_file, "2026-07-29.md");
  });

  it("caminho feliz: conteúdo genuinamente diferente NÃO dispara console.warn nem log-event", () => {
    const oldContent = "# Perfil de Audiência — Diar.ia\n\n**updated_at:** 2026-07-29\n";
    const newContent = "# Perfil de Audiência — Diar.ia\n\n**updated_at:** 2026-07-30\n";
    const { calls, fn } = mockSpawn();
    const warnCalls: string[] = [];

    handleArchiveGuard(
      newContent,
      "2026-07-30.md",
      "2026-07-29.md",
      oldContent,
      fn,
      (msg) => warnCalls.push(msg),
    );

    assert.equal(warnCalls.length, 0, "console.warn não deve disparar no caminho feliz");
    assert.equal(calls.length, 0, "log-event não deve disparar no caminho feliz");
  });

  it("sem histórico anterior: não dispara nenhum canal", () => {
    const { calls, fn } = mockSpawn();
    const warnCalls: string[] = [];

    handleArchiveGuard("qualquer conteúdo", "2026-07-30.md", null, null, fn, (msg) => warnCalls.push(msg));

    assert.equal(warnCalls.length, 0);
    assert.equal(calls.length, 0);
  });
});
