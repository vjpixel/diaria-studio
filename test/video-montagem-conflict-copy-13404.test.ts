/**
 * #13404: o sync de `data/` (rclone bisync) trocou o `blocks.json` da montagem
 * por `blocks.json.conflict1..4` e todo comando parou com "blocks.json (gate da
 * decupagem) ausente", sem dizer que a cópia estava ao lado; o `roteiro` falhou
 * e o `roteiro.md` da rodada anterior ficou no disco com cara de atual.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  brtStamp,
  chooseConflictCopy,
  conflictCopiesOf,
  conflictRestoreCommand,
  missingFileConflictHint,
  restoreFromConflictCopy,
} from "../scripts/lib/sync-conflict-copy.ts";
import { main, missingWorkFileMessage, restoreConflictCopies, roteiroNotRewrittenNotice, warnConflictOnly } from "../scripts/video-montagem.ts";

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

describe("conflictCopiesOf / chooseConflictCopy (#13404)", () => {
  it("lista só as cópias do arquivo, a mais nova primeiro (mtime, não o N)", () => {
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

  it("empate de mtime nas mais novas: tie, nenhuma escolhida", () => {
    put(dir, "blocks.json.conflict1", "a", at(5));
    put(dir, "blocks.json.conflict2", "b", at(5));
    put(dir, "blocks.json.conflict3", "c", at(0));
    const c = chooseConflictCopy(join(dir, "blocks.json"));
    assert.equal(c.kind, "tie");
    assert.deepEqual(c.kind === "tie" && c.tied.map((x) => x.name).sort(), ["blocks.json.conflict1", "blocks.json.conflict2"]);
  });

  it("diretório inexistente = none", () => {
    assert.deepEqual(chooseConflictCopy(join(dir, "nao-existe", "blocks.json")), { kind: "none" });
  });
});

describe("missingFileConflictHint (#13404)", () => {
  it("aponta a mais nova em BRT, o comando de Git Bash e a flag", () => {
    put(dir, "blocks.json.conflict1", "a", at(0));
    const newest = put(dir, "blocks.json.conflict4", "d", at(34));
    const target = join(dir, "blocks.json");
    const lines = missingFileConflictHint(target, chooseConflictCopy(target), "--restore-conflict blocks.json");
    assert.equal(lines.length, 3);
    assert.match(lines[0], /2 cópia\(s\) de conflito/);
    assert.match(lines[0], /a mais nova é blocks\.json\.conflict4 \(modificada em 2026-11-17 10:51:00 BRT \(UTC-3\)\)/);
    assert.match(lines[0], /as outras: blocks\.json\.conflict1/);
    assert.equal(lines[1], `conferir e restaurar (Git Bash): ${conflictRestoreCommand(newest, target)}`);
    assert.match(lines[2], /--restore-conflict blocks\.json \(copia blocks\.json\.conflict4 de volta/);
  });

  it("empate: diz que a escolha é arbitrária, sem 'mais nova', sem comando e sem flag", () => {
    put(dir, "blocks.json.conflict1", "a", at(5));
    put(dir, "blocks.json.conflict2", "b", at(5));
    const target = join(dir, "blocks.json");
    const lines = missingFileConflictHint(target, chooseConflictCopy(target), "--restore-conflict blocks.json");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /mesmo horário \(2026-11-17 10:22:00 BRT \(UTC-3\)\), então a escolha entre elas é arbitrária/);
    assert.doesNotMatch(lines[0], /mais nova|mais recente|cp '|--restore-conflict/);
  });

  it("sem cópia, nenhuma linha", () => {
    assert.deepEqual(missingFileConflictHint(join(dir, "blocks.json"), { kind: "none" }), []);
  });

  it("o comando não é gerado com aspa simples no caminho", () => {
    assert.equal(conflictRestoreCommand("C:\\a b\\x.json.conflict1", "C:\\a b\\x.json"), "cp 'C:\\a b\\x.json.conflict1' 'C:\\a b\\x.json'");
    assert.equal(conflictRestoreCommand("/d'x/f.conflict1", "/d'x/f"), null);
    const lines = missingFileConflictHint("/d'x/f.json", { kind: "newest", chosen: { path: "/d'x/f.json.conflict1", name: "f.json.conflict1", seq: 1, mtimeMs: T0.getTime() }, copies: [] });
    assert.match(lines[1], /copiar à mão f\.json\.conflict1 para f\.json \(caminho com aspa simples: comando não gerado\)/);
  });

  it("brtStamp tem o offset", () => {
    assert.equal(brtStamp(Date.parse("2026-11-17T13:47:00Z")), "2026-11-17 10:47:00 BRT (UTC-3)");
  });
});

describe("mensagem e --restore-conflict leem a MESMA escolha (#13404)", () => {
  it("safeBackup do OneDrive mais nova que o .conflictN: a mensagem mostra a safeBackup e a flag restaura a safeBackup", () => {
    put(dir, "blocks.json.conflict1", "rclone", at(0));
    put(dir, "blocks-Neo-safeBackup-0001.json", "onedrive", at(20));
    const target = join(dir, "blocks.json");
    const msg = missingWorkFileMessage(target, "blocks.json", undefined, dir);
    assert.match(msg, /a mais nova é blocks-Neo-safeBackup-0001\.json/);
    assert.match(msg, /--restore-conflict blocks\.json \(copia blocks-Neo-safeBackup-0001\.json/);
    const r = restoreFromConflictCopy(target);
    assert.equal(r.status === "restored" && r.from, join(dir, "blocks-Neo-safeBackup-0001.json"));
    assert.equal(readFileSync(target, "utf8"), "onedrive");
  });

  it("só safeBackup: a flag é sugerida e restaura essa cópia", () => {
    put(dir, "blocks-Neo-safeBackup-0002.json", "onedrive", at(20));
    const target = join(dir, "blocks.json");
    assert.match(missingWorkFileMessage(target, "blocks.json", undefined, dir), /--restore-conflict blocks\.json \(copia blocks-Neo-safeBackup-0002\.json/);
    const lines: string[] = [];
    assert.equal(restoreConflictCopies(dir, "blocks.json", undefined, (l) => lines.push(l)), 1);
    assert.equal(readFileSync(target, "utf8"), "onedrive");
    assert.match(lines[0], /^\[premissa\] blocks\.json restaurado de blocks-Neo-safeBackup-0002\.json/);
  });

  it("a restauração preserva o mtime da cópia (a prévia e o SRT se comparam com o plano por mtime)", () => {
    put(dir, "plan.json.conflict1", "{}", at(0));
    restoreFromConflictCopy(join(dir, "plan.json"));
    assert.equal(Math.round(statSync(join(dir, "plan.json")).mtimeMs / 1000), Math.round(at(0).getTime() / 1000));
  });

  it("arquivo fora do stateDir: sem sugestão de flag (ela não o alcança)", () => {
    put(dir, "blocks.json.conflict1", "a", at(0));
    assert.doesNotMatch(missingWorkFileMessage(join(dir, "blocks.json"), "blocks.json", undefined, join(dir, "outro")), /--restore-conflict/);
  });

  it("empate: a flag não restaura", () => {
    put(dir, "blocks.json.conflict1", "a", at(5));
    put(dir, "blocks.json.conflict2", "b", at(5));
    const lines: string[] = [];
    assert.equal(restoreConflictCopies(dir, "blocks.json", undefined, (l) => lines.push(l)), 0);
    assert.ok(!existsSync(join(dir, "blocks.json")));
    assert.match(lines[0], /escolha seria arbitrária/);
  });

  it("nome com caminho é recusado; sem nome também", () => {
    assert.throws(() => restoreConflictCopies(dir, "../blocks.json"), /só o nome do arquivo/);
    assert.throws(() => restoreConflictCopies(dir, ""), /exige o nome/);
  });
});

describe("warnConflictOnly (#13404)", () => {
  it("avisa uma vez, com a cópia e a flag, quando o opcional só existe como cópia", () => {
    put(dir, "blocks.json.conflict2", "x", at(0));
    const lines: string[] = [];
    warnConflictOnly(join(dir, "blocks.json"), (l) => lines.push(l), undefined, dir);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[aviso\] blocks\.json ausente, seguindo sem ele: .*a mais nova é blocks\.json\.conflict2.*--restore-conflict blocks\.json/);
  });

  it("calado com o original presente ou sem cópia", () => {
    const lines: string[] = [];
    warnConflictOnly(join(dir, "blocks.json"), (l) => lines.push(l), undefined, dir);
    put(dir, "plan.json", "{}", at(0));
    put(dir, "plan.json.conflict1", "{}", at(5));
    warnConflictOnly(join(dir, "plan.json"), (l) => lines.push(l), undefined, dir);
    assert.deepEqual(lines, []);
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

  it("a mensagem de ausente aponta a cópia mais nova, o comando e a flag (antes: só 'gate da decupagem ausente')", async () => {
    put(dir, "blocks.json.conflict1", "{}", at(0));
    put(dir, "blocks.json.conflict3", "{}", at(34));
    await assert.rejects(main(args("roteiro", "--no-short-word-check")), (e: Error) => {
      assert.match(e.message, /^blocks\.json \(gate da decupagem\) ausente: /);
      assert.match(e.message, /a mais nova é blocks\.json\.conflict3/);
      assert.ok(e.message.includes(conflictRestoreCommand(join(dir, "blocks.json.conflict3"), join(dir, "blocks.json"))!), e.message);
      assert.match(e.message, /--restore-conflict blocks\.json/);
      return true;
    });
  });

  it("sem cópia de conflito, a mensagem é a de sempre", () => {
    const p = join(dir, "blocks.json");
    assert.equal(missingWorkFileMessage(p, "blocks.json (gate da decupagem)", undefined, dir), `blocks.json (gate da decupagem) ausente: ${p}`);
  });

  it("roteiro que falha diz no stderr que o roteiro.md do disco é defasado", async () => {
    put(dir, "blocks.json.conflict1", "{}", at(0));
    put(dir, "roteiro.md", "# roteiro velho\n", at(-60));
    await assert.rejects(main(args("roteiro", "--no-short-word-check")));
    const line = errs.find((l) => l.startsWith("[erro] roteiro falhou"));
    assert.ok(line, errs.join("\n"));
    assert.match(line!, /NÃO foi regravado; o que está no disco é de 2026-11-17 09:17:00 BRT \(UTC-3\), defasado/);
    assert.equal(readFileSync(join(dir, "roteiro.md"), "utf8"), "# roteiro velho\n");
  });

  it("roteiroNotRewrittenNotice sem roteiro.md anterior", () => {
    assert.match(roteiroNotRewrittenNotice("/x/roteiro.md", null), /^\[erro\] roteiro falhou: \/x\/roteiro\.md não foi gravado/);
  });

  it("--restore-conflict blocks.json copia a mais nova de volta com [premissa] e segue até o próximo erro", async () => {
    put(dir, "blocks.json.conflict1", '{"velho":true}', at(0));
    put(dir, "blocks.json.conflict2", '{"novo":true}', at(34));
    await assert.rejects(main(args("roteiro", "--no-short-word-check", "--restore-conflict", "blocks.json")), (e: Error) => {
      assert.doesNotMatch(e.message, /gate da decupagem\) ausente/);
      return true;
    });
    assert.equal(readFileSync(join(dir, "blocks.json"), "utf8"), '{"novo":true}');
    assert.ok(errs.some((l) => /^\[premissa\] blocks\.json restaurado de blocks\.json\.conflict2.*ficaram no disco: blocks\.json\.conflict1/.test(l)), errs.join("\n"));
    assert.ok(existsSync(join(dir, "blocks.json.conflict2")));
  });

  it("--restore-conflict não varre: o original presente com .conflictN mais novo ao lado não é sobrescrito, e o arquivo não nomeado não volta", async () => {
    put(dir, "blocks.json", '{"vivo":true}', at(0));
    put(dir, "blocks.json.conflict1", '{"conflito":true}', at(40));
    put(dir, "decupagem-plan.json.conflict1", "{}", at(40));
    await assert.rejects(main(args("roteiro", "--no-short-word-check", "--restore-conflict", "blocks.json")));
    assert.equal(readFileSync(join(dir, "blocks.json"), "utf8"), '{"vivo":true}');
    assert.ok(!existsSync(join(dir, "decupagem-plan.json")));
    assert.ok(errs.some((l) => /--restore-conflict: blocks\.json existe, nada sobrescrito/.test(l)), errs.join("\n"));
  });

  it("--restore-conflict sem nome sai 2 sem tocar nada", async () => {
    put(dir, "blocks.json.conflict1", "{}", at(0));
    assert.equal(await main(args("roteiro", "--restore-conflict")), 2);
    assert.ok(!existsSync(join(dir, "blocks.json")));
  });

  it("build --seq recusa o plan.json que só existe como cópia de conflito (o merge perderia as outras sequências)", async () => {
    put(dir, "plan.json.conflict1", "{}", at(0));
    await assert.rejects(main(args("build", "--seq", "youtube", "--no-audio-clean")), (e: Error) => {
      assert.match(e.message, /^build --seq recusado: plan\.json anterior ausente: .*a mais nova é plan\.json\.conflict1/s);
      return true;
    });
  });

  it("srt --no-plan avisa (uma vez) o plan.json que só existe como cópia, em vez de seguir calado", async () => {
    put(dir, "plan.json.conflict1", "{}", at(0));
    await assert.rejects(main(args("srt", "--seq", "youtube", "--from-final", join(dir, "nao-existe.mp4"), "--no-plan")));
    const avisos = errs.filter((l) => l.startsWith("[aviso] plan.json ausente, seguindo sem ele"));
    assert.equal(avisos.length, 1, errs.join("\n"));
  });
});
