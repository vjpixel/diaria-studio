/**
 * no-versioned-conflict-markers.test.ts (#6668)
 *
 * Guard barato (item 3 da "Correção sugerida" da issue): nenhum `.md`
 * rastreado pelo git pode conter marcador de conflito de merge/stash-pop
 * literal (`<<<<<<<`/`>>>>>>>` em início de linha) no working tree.
 *
 * Origem: um `git stash pop` que conflita pode deixar marcadores literais
 * dentro de um arquivo VERSIONADO sem nenhum merge/rebase em curso
 * (`.git/MERGE_HEAD` ausente) — o arquivo fica sintaticamente quebrado e
 * outra sessão lendo esse arquivo o trataria como íntegro (incidente #6668:
 * `hermes/skills/hermes-diaria-continuo/SKILL.md` ficou em `UU` com
 * `<<<<<<< Updated upstream` / `>>>>>>> Stashed changes` por horas no
 * checkout compartilhado). `scripts/lib/git-sync.ts` (#6668 item 2) agora
 * detecta esse caso NA HORA do sync (`stash_pop_conflict`) — este teste é a
 * 2ª linha de defesa, mais barata e mais ampla: pega a classe inteira
 * (qualquer origem de marcador deixado — não só stash pop; ex: um merge/
 * rebase abortado incorretamente, um cherry-pick com conflito não resolvido
 * e commitado por engano) em QUALQUER `.md` rastreado, rodando em CI a cada
 * PR — não depende de ninguém ter rodado o sync na hora certa.
 *
 * Heurística (deliberadamente simples, #6668 item 3): procurar linhas que
 * COMECEM com `<<<<<<< ` ou `>>>>>>> `. Esses 2 marcadores sozinhos já são
 * sinal suficiente — raramente aparecem em início de linha em prosa
 * legítima (changelog, código de exemplo com diff, etc. os usam indentados
 * ou dentro de blocos ```` que ainda assim começam com esses tokens só em
 * fixtures/exemplos deliberados de conflito, tratados abaixo). `=======`
 * sozinho fica DE FORA de propósito — tem falsos positivos demais (headers
 * markdown `===`, separadores de tabela) — não teria valor sem exigir que
 * apareça ENTRE um `<<<<<<<` e um `>>>>>>>` no mesmo arquivo, o que a
 * varredura por linha isolada abaixo já não faz (nem precisa: os 2
 * marcadores de fronteira já bastam).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Marcador de INÍCIO de conflito (`<<<<<<< branch-name` ou `<<<<<<< Updated upstream`). */
export const CONFLICT_START_RE = /^<<<<<<< /m;
/** Marcador de FIM de conflito (`>>>>>>> branch-name` ou `>>>>>>> Stashed changes`). */
export const CONFLICT_END_RE = /^>>>>>>> /m;

describe("#6668 CONFLICT_START_RE/CONFLICT_END_RE: sanity dos próprios regexes de detecção", () => {
  it("casa o marcador real do incidente #6668 (git stash pop)", () => {
    const leaked =
      "<<<<<<< Updated upstream\n" +
      "- 0.5.1 (28/08/2026): session-id do cron por TICK, não por JOB (#6443, ...)\n" +
      "=======\n" +
      "- 0.5.1 (28/08/2026): subagent MCP drain (#6465, epic #6464) — lote 5 posts ...\n" +
      ">>>>>>> Stashed changes\n";
    assert.match(leaked, CONFLICT_START_RE);
    assert.match(leaked, CONFLICT_END_RE);
  });

  it("casa marcador de merge/rebase comum (branch name em vez de 'Updated upstream')", () => {
    assert.match("<<<<<<< HEAD\n", CONFLICT_START_RE);
    assert.match(">>>>>>> feature/xyz\n", CONFLICT_END_RE);
  });

  it("NÃO casa quando indentado (não é início de linha) — evita falso positivo em bloco de código citando o formato", () => {
    assert.doesNotMatch("  <<<<<<< HEAD\n", CONFLICT_START_RE);
    assert.doesNotMatch("    >>>>>>> branch\n", CONFLICT_END_RE);
  });

  it("NÃO casa header markdown nem separador de tabela (só '=======' isolado, fora de escopo por design)", () => {
    assert.doesNotMatch("=======\n", CONFLICT_START_RE);
    assert.doesNotMatch("=======\n", CONFLICT_END_RE);
  });
});

describe("#6668 varredura repo-wide: nenhum .md rastreado pelo git contém marcador de conflito", () => {
  it("git ls-files '*.md' — 0 ocorrências de linha começando com '<<<<<<< ' ou '>>>>>>> '", () => {
    const tracked = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Este PRÓPRIO arquivo é auto-excluído: ele contém os marcadores como
    // fixtures literais nos testes de sanity acima — sem essa exclusão, o
    // scan se acusaria a si mesmo (mesmo padrão de
    // test/no-committed-make-webhook.test.ts, #3903).
    const SELF_PATH = "test/no-versioned-conflict-markers.test.ts";
    const offenders: Array<{ path: string; markers: string[] }> = [];

    for (const relPath of tracked) {
      const normalized = relPath.replace(/\\/g, "/");
      if (normalized === SELF_PATH) continue;
      const absPath = resolve(ROOT, relPath);
      let content: string;
      try {
        content = readFileSync(absPath, "utf8");
      } catch (err) {
        // Só ENOENT é esperado aqui (arquivo removido no working tree, `D` no
        // index de `git ls-files` — fora do escopo deste teste). Qualquer
        // outro erro (permissão, I/O) é sinal de que a varredura não rodou
        // completa — não deve ser engolido em silêncio.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw err;
      }
      const markers: string[] = [];
      if (CONFLICT_START_RE.test(content)) markers.push("<<<<<<< ");
      if (CONFLICT_END_RE.test(content)) markers.push(">>>>>>> ");
      if (markers.length > 0) offenders.push({ path: relPath, markers });
    }

    assert.deepEqual(
      offenders,
      [],
      `arquivo(s) .md rastreado(s) com marcador de conflito literal (#6668): ` +
        offenders.map((o) => `${o.path} [${o.markers.join(", ")}]`).join("; "),
    );
  });
});
