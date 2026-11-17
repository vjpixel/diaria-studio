/**
 * #13404: o sync de `data/` (rclone bisync) trocou o `blocks.json` da montagem
 * por `blocks.json.conflict1..4` e todo comando parou com "blocks.json (gate da
 * decupagem) ausente", sem dizer que a cópia estava ao lado; o `roteiro` falhou
 * e o `roteiro.md` da rodada anterior ficou no disco com cara de atual.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conflictCopiesOf,
  conflictRestoreCommand,
  missingFileConflictHint,
  restoreMissingFromConflictCopies,
} from "../scripts/lib/sync-conflict-copy.ts";
import { main, missingWorkFileMessage, roteiroNotRewrittenNotice } from "../scripts/video-montagem.ts";

const T0 = new Date("2026-11-17T13:17:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);

function put(dir: string, name: string, text: string, when: Date): string {
  const p = join(dir, name);
  writeFileSync(p, text);
  utimesSync(p, when, when);
  return p;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vm-13404-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("conflictCopiesOf (#13404)", () => {
  it("lista só as cópias do arquivo, a mais recente primeiro (mtime, não o N)", () => {
    put(dir, "blocks.json.conflict1", "a", at(0));
    put(dir, "blocks.json.conflict2", "b", at(34));
    put(dir, "blocks.json.conflict4", "d", at(29));
    put(dir, "blocks.json.conflict3", "c", at(31));
    put(dir, "plan.json.conflict9", "x", at(50));
    put(dir, "blocks.json.bak", "y", at(60));
    put(dir, "blocks-Neo-safeBackup-0001.json", "z", at(10));
    const names = conflictCopiesOf(join(dir, "blocks.json")).map((c) => c.name);
    assert.deepEqual(names, ["blocks.json.conflict2", "blocks.json.conflict3", "blocks.json.conflict4", "blocks-Neo-safeBackup-0001.json", "blocks.json.conflict1"]);
  });

  it("empate de mtime: o maior N primeiro", () => {
    put(dir, "blocks.json.conflict1", "a", at(0));
    put(dir, "blocks.json.conflict2", "b", at(0));
    assert.deepEqual(conflictCopiesOf(join(dir, "blocks.json")).map((c) => c.seq), [2, 1]);
  });

  it("diretório inexistente = nenhuma cópia", () => {
    assert.deepEqual(conflictCopiesOf(join(dir, "nao-existe", "blocks.json")), []);
  });
});

describe("missingFileConflictHint (#13404)", () => {
  it("aponta a mais recente e o comando de restauração", () => {
    put(dir, "blocks.json.conflict1", "a", at(0));
    const latest = put(dir, "blocks.json.conflict4", "d", at(34));
    const target = join(dir, "blocks.json");
    const lines = missingFileConflictHint(target, conflictCopiesOf(target));
    assert.equal(lines.length, 2);
    assert.match(lines[0], /2 cópia\(s\) de conflito/);
    assert.match(lines[0], /a mais recente é blocks\.json\.conflict4 \(modificada em 2026-11-17T13:51:00\.000Z\)/);
    assert.match(lines[0], /as outras: blocks\.json\.conflict1/);
    assert.equal(lines[1], `conferir e restaurar: ${conflictRestoreCommand(latest, target)}`);
  });

  it("sem cópia, nenhuma linha", () => {
    assert.deepEqual(missingFileConflictHint(join(dir, "blocks.json"), []), []);
  });

  it("o comando usa aspas simples (Git Bash e PowerShell) e escapa a aspa do caminho", () => {
    assert.equal(conflictRestoreCommand("C:\\a b\\x.json.conflict1", "C:\\a b\\x.json"), "cp 'C:\\a b\\x.json.conflict1' 'C:\\a b\\x.json'");
    assert.equal(conflictRestoreCommand("/d'x/f.conflict1", "/d'x/f"), "cp '/d'\\''x/f.conflict1' '/d'\\''x/f'");
  });
});

describe("restoreMissingFromConflictCopies (#13404)", () => {
  it("recria o ausente pela cópia mais recente, deixa as cópias e não toca o presente", () => {
    put(dir, "blocks.json.conflict1", "velho", at(0));
    put(dir, "blocks.json.conflict2", "novo", at(34));
    put(dir, "plan.json", "vivo", at(40));
    put(dir, "plan.json.conflict1", "perdedor", at(30));
    const done = restoreMissingFromConflictCopies(dir);
    assert.deepEqual(done.map((r) => r.restored), [join(dir, "blocks.json")]);
    assert.equal(done[0].from, join(dir, "blocks.json.conflict2"));
    assert.deepEqual(done[0].others, [join(dir, "blocks.json.conflict1")]);
    assert.equal(readFileSync(join(dir, "blocks.json"), "utf8"), "novo");
    assert.equal(readFileSync(join(dir, "plan.json"), "utf8"), "vivo");
    assert.ok(existsSync(join(dir, "blocks.json.conflict1")) && existsSync(join(dir, "blocks.json.conflict2")));
  });

  it("sem cópia, não faz nada", () => {
    put(dir, "blocks.json", "x", at(0));
    assert.deepEqual(restoreMissingFromConflictCopies(dir), []);
  });
});

describe("video-montagem com o blocks.json sumido no sync (#13404)", () => {
  const args = (cmd: string, ...rest: string[]) => [cmd, "261116", "--state-dir", dir, "--work-dir", dir, "--out-dir", dir, "--no-drive-api", "--drive-root", dir, ...rest];
  let errs: string[];
  const origErr = console.error;
  beforeEach(() => {
    errs = [];
    console.error = (...a: unknown[]) => { errs.push(a.join(" ")); };
  });
  afterEach(() => {
    console.error = origErr;
  });

  it("a mensagem de ausente aponta a cópia mais recente e o comando (antes: só 'gate da decupagem ausente')", async () => {
    put(dir, "blocks.json.conflict1", "{}", at(0));
    put(dir, "blocks.json.conflict3", "{}", at(34));
    await assert.rejects(main(args("roteiro", "--no-short-word-check")), (e: Error) => {
      assert.match(e.message, /^blocks\.json \(gate da decupagem\) ausente: /);
      assert.match(e.message, /a mais recente é blocks\.json\.conflict3/);
      assert.ok(e.message.includes(conflictRestoreCommand(join(dir, "blocks.json.conflict3"), join(dir, "blocks.json"))), e.message);
      assert.match(e.message, /--restore-conflict/);
      return true;
    });
  });

  it("sem cópia de conflito, a mensagem é a de sempre", () => {
    const p = join(dir, "blocks.json");
    assert.equal(missingWorkFileMessage(p, "blocks.json (gate da decupagem)"), `blocks.json (gate da decupagem) ausente: ${p}`);
  });

  it("o mesmo vale para os demais arquivos lidos por readJson (plan.json)", () => {
    put(dir, "plan.json.conflict1", "{}", at(0));
    assert.match(missingWorkFileMessage(join(dir, "plan.json"), "plan.json (rode build)"), /plan\.json \(rode build\) ausente: .*\n {2}o sync de data\/ deixou 1 cópia/s);
  });

  it("roteiro que falha diz no stderr que o roteiro.md do disco é defasado", async () => {
    put(dir, "blocks.json.conflict1", "{}", at(0));
    put(dir, "roteiro.md", "# roteiro velho\n", at(-60));
    await assert.rejects(main(args("roteiro", "--no-short-word-check")));
    const line = errs.find((l) => l.startsWith("[erro] roteiro falhou"));
    assert.ok(line, errs.join("\n"));
    assert.match(line!, /NÃO foi regravado; o que está no disco é de 2026-11-17T12:17:00\.000Z, defasado/);
    assert.equal(readFileSync(join(dir, "roteiro.md"), "utf8"), "# roteiro velho\n");
  });

  it("roteiroNotRewrittenNotice sem roteiro.md anterior", () => {
    assert.match(roteiroNotRewrittenNotice("/x/roteiro.md", null), /^\[erro\] roteiro falhou: \/x\/roteiro\.md não foi gravado/);
  });

  it("--restore-conflict copia a mais recente de volta com [premissa] e segue até o próximo erro", async () => {
    put(dir, "blocks.json.conflict1", '{"velho":true}', at(0));
    put(dir, "blocks.json.conflict2", '{"novo":true}', at(34));
    await assert.rejects(main(args("roteiro", "--no-short-word-check", "--restore-conflict")), (e: Error) => {
      assert.doesNotMatch(e.message, /gate da decupagem\) ausente/);
      return true;
    });
    assert.equal(readFileSync(join(dir, "blocks.json"), "utf8"), '{"novo":true}');
    assert.ok(errs.some((l) => /^\[premissa\] blocks\.json restaurado de blocks\.json\.conflict2.*ficaram no disco: blocks\.json\.conflict1/.test(l)), errs.join("\n"));
    assert.ok(existsSync(join(dir, "blocks.json.conflict2")));
  });

  it("build --seq recusa o plan.json que só existe como cópia de conflito (o merge perderia as outras sequências)", async () => {
    put(dir, "plan.json.conflict1", "{}", at(0));
    await assert.rejects(main(args("build", "--seq", "youtube", "--no-audio-clean")), (e: Error) => {
      assert.match(e.message, /^build --seq recusado: plan\.json anterior ausente: .*a mais recente é plan\.json\.conflict1/s);
      return true;
    });
  });
});
