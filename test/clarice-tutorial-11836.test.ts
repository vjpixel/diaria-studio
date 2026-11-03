/**
 * test/clarice-tutorial-11836.test.ts (#11836)
 *
 * CLARICE — TUTORIAL da mensal vem do Doc "Laboratório Clarice": parse do
 * texto do Doc (fixture = texto real lido pelo conector em 03/11/2026), escolha
 * do próximo tutorial contra o registro versionado, idempotência por ciclo,
 * esgotado, e o CLI.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  docJsonToMarkedText,
  parseLaboratorioClarice,
  parseTutorialLog,
  pickNextTutorial,
  recordTutorial,
  type TutorialLog,
} from "../scripts/lib/mensal/clarice-tutorial.ts";
import { run } from "../scripts/clarice-tutorial-next.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "clarice-laboratorio.txt");
const LOG_PATH = join(ROOT, "context", "clarice-tutorial-log.json");
const text = readFileSync(FIXTURE, "utf8");
const seededLog = (): TutorialLog => parseTutorialLog(readFileSync(LOG_PATH, "utf8"));

describe("parseLaboratorioClarice (#11836)", () => {
  const tutorials = parseLaboratorioClarice(text);

  it("acha os 8 tutoriais, na ordem do Doc, e ignora Notas", () => {
    assert.deepEqual(tutorials.map((t) => t.numero), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(!tutorials.some((t) => /notas/i.test(t.titulo)));
    assert.ok(!tutorials.some((t) => t.passos.some((p) => /Detalhes técnicos/.test(p))));
  });

  it("separa título, intro, passos, dica e CTA", () => {
    const t1 = tutorials[0];
    assert.equal(t1.titulo, "Revisar (correção, clareza, concisão)");
    assert.match(t1.intro, /^A Clarice classifica as sugestões/);
    assert.equal(t1.passos.length, 4);
    assert.equal(t1.passos[0], "Cole ou digite o texto na área de revisão.");
    assert.equal(t1.dica, "Ctrl+Z desfaz, Ctrl+Y refaz, e o documento salva automaticamente.");
    assert.equal(t1.cta, "Assine agora e ganhe até 63% de desconto");
    for (const t of tutorials) {
      assert.ok(t.passos.length >= 3 && t.passos.length <= 4, `tutorial ${t.numero}: ${t.passos.length} passos`);
      assert.ok(t.dica && t.cta && t.intro, `tutorial ${t.numero} incompleto`);
    }
  });

  it("aceita texto plano sem marcadores, inclusive com passos numerados", () => {
    // Export em texto plano: sem [HEADING_N], e os passos podem vir como "1. ..."
    const plain = text
      .split("\n")
      .map((l) => l.replace(/^\[HEADING_\d\]\s*/, ""))
      .join("\n")
      .replace("Cole ou digite o texto na área de revisão.", "1. Cole ou digite o texto na área de revisão.")
      .replace("Em Geral, configure público", "2. Em Geral, configure público");
    const parsed = parseLaboratorioClarice(plain);
    assert.deepEqual(parsed.map((t) => t.numero), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(parsed[0].passos[0], "Cole ou digite o texto na área de revisão.");
    assert.equal(parsed[0].passos.length, 4);
    assert.deepEqual(parsed.map((t) => t.titulo), tutorials.map((t) => t.titulo));
  });

  it("texto sem tutorial nenhum é erro claro, nunca lista vazia", () => {
    assert.throws(() => parseLaboratorioClarice("Outro documento\nsem tutoriais"), /nenhum tutorial/);
    assert.throws(() => parseLaboratorioClarice(""), /nenhum tutorial/);
  });

  it("tutorial incompleto é erro que nomeia o tutorial", () => {
    const semDica = "[HEADING_2] 1. Revisar\nIntro.\nPasso um.\n→ Assine";
    assert.throws(() => parseLaboratorioClarice(semDica), /tutorial 1 .*Dica/);
  });
});

describe("docJsonToMarkedText (#11836)", () => {
  it("converte o JSON do read_doc (com abas) no mesmo resultado do texto", () => {
    const para = (t: string, style = "NORMAL_TEXT") => ({
      paragraph: { paragraphStyle: { namedStyleType: style }, elements: [{ textRun: { content: t + "\n" } }] },
    });
    const content = text.split("\n").map((l) => {
      const m = l.match(/^\[HEADING_(\d)\]\s*(.*)$/);
      return m ? para(m[2], `HEADING_${m[1]}`) : para(l);
    });
    const json = { content: { tabs: [{ documentTab: { body: { content } } }] } };
    const parsed = parseLaboratorioClarice(docJsonToMarkedText(json));
    assert.deepEqual(parsed, parseLaboratorioClarice(text));
  });

  it("JSON sem corpo é erro", () => {
    assert.throws(() => docJsonToMarkedText({ foo: 1 }), /body\.content/);
  });
});

describe("pickNextTutorial (#11836)", () => {
  const tutorials = parseLaboratorioClarice(text);

  it("com o log semeado, o próximo é o #1 (nunca saiu)", () => {
    const r = pickNextTutorial(tutorials, seededLog(), "2611-12");
    assert.equal(r.kind, "tutorial");
    assert.ok(r.kind === "tutorial" && r.tutorial.numero === 1 && !r.reused);
  });

  it("depois do #1 vêm o #7 e o #8, e então esgotado", () => {
    let log = seededLog();
    const seq: number[] = [];
    for (const cycle of ["2611-12", "2612-01", "2701-02"]) {
      const r = pickNextTutorial(tutorials, log, cycle);
      assert.equal(r.kind, "tutorial");
      if (r.kind !== "tutorial") return;
      seq.push(r.tutorial.numero);
      log = recordTutorial(log, cycle, r.tutorial, "2026-11-03");
    }
    assert.deepEqual(seq, [1, 7, 8]);
    const r = pickNextTutorial(tutorials, log, "2702-03");
    assert.equal(r.kind, "esgotado");
  });

  it("idempotente: o ciclo já registrado devolve o mesmo tutorial", () => {
    const first = pickNextTutorial(tutorials, seededLog(), "2611-12");
    assert.ok(first.kind === "tutorial");
    const log = recordTutorial(seededLog(), "2611-12", first.tutorial, "2026-11-03");
    const again = pickNextTutorial(tutorials, log, "2611-12");
    assert.ok(again.kind === "tutorial" && again.reused && again.tutorial.numero === first.tutorial.numero);
    // ciclo antigo do histórico também é estável
    const old = pickNextTutorial(tutorials, log, "2610-11");
    assert.ok(old.kind === "tutorial" && old.tutorial.numero === 6 && old.reused);
    // recordTutorial não duplica entrada do mesmo ciclo
    assert.equal(recordTutorial(log, "2611-12", first.tutorial, "x").entries.length, log.entries.length);
  });

  it("ciclo registrado fora da lista (Simplificar, 2609-10) não avança a sequência", () => {
    const r = pickNextTutorial(tutorials, seededLog(), "2609-10");
    assert.equal(r.kind, "fora-da-lista");
  });

  it("log que aponta tutorial inexistente no Doc é erro", () => {
    const log: TutorialLog = { entries: [{ cycle: "2611-12", numero: 99, titulo: "x" }] };
    assert.throws(() => pickNextTutorial(tutorials, log, "2611-12"), /não existe mais no Doc/);
  });
});

describe("clarice-tutorial-next CLI (#11836)", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "clarice-tut-"));

  it("--record grava a entrada no log e --out grava o tutorial; 2ª rodada reaproveita", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, readFileSync(LOG_PATH, "utf8"));
    const out = join(dir, "_internal", "clarice-tutorial.json");
    const argv = ["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log, "--record", "--out", out];
    const r1 = run(argv, new Date("2026-11-03T12:00:00Z"));
    assert.equal(r1.exitCode, 0, r1.stderr);
    const p1 = JSON.parse(r1.stdout);
    assert.equal(p1.kind, "tutorial");
    assert.equal(p1.tutorial.numero, 1);
    assert.equal(p1.recorded, true);
    const saved = parseTutorialLog(readFileSync(log, "utf8"));
    assert.deepEqual(saved.entries.at(-1), {
      cycle: "2611-12",
      numero: 1,
      titulo: "Revisar (correção, clareza, concisão)",
      recorded_at: "2026-11-03",
    });
    assert.equal(JSON.parse(readFileSync(out, "utf8")).numero, 1);

    const r2 = run(argv);
    const p2 = JSON.parse(r2.stdout);
    assert.equal(p2.tutorial.numero, 1);
    assert.equal(p2.reused, true);
    assert.equal(p2.recorded, false);
    assert.equal(parseTutorialLog(readFileSync(log, "utf8")).entries.length, saved.entries.length);
  });

  it("sem --record não toca o log", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    const before = readFileSync(LOG_PATH, "utf8");
    writeFileSync(log, before);
    const r = run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log]);
    assert.equal(r.exitCode, 0);
    assert.equal(readFileSync(log, "utf8"), before);
  });

  it("esgotado: exit 0, kind esgotado, sem arquivo --out", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((n, i) => ({ cycle: `26${String(i).padStart(2, "0")}-xx`, numero: n, titulo: "t" }));
    writeFileSync(log, JSON.stringify({ entries }));
    const out = join(dir, "out.json");
    const r = run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log, "--record", "--out", out]);
    assert.equal(r.exitCode, 0);
    assert.equal(JSON.parse(r.stdout).kind, "esgotado");
    assert.equal(existsSync(out), false);
  });

  it("uso inválido e Doc que não parseia saem exit 1", () => {
    assert.equal(run(["--doc-text", FIXTURE]).exitCode, 1);
    assert.equal(run(["--cycle", "2611", "--doc-text", FIXTURE]).exitCode, 1);
    assert.equal(run(["--cycle", "2611-12"]).exitCode, 1);
    const dir = tmp();
    const bad = join(dir, "bad.txt");
    writeFileSync(bad, "nada aqui");
    const r = run(["--cycle", "2611-12", "--doc-text", bad]);
    assert.equal(r.exitCode, 1);
    assert.match(r.stderr, /nenhum tutorial/);
  });

  it("o log versionado está semeado com o histórico (2605-06 a 2610-11) e o #1 nunca saiu", () => {
    const log = seededLog();
    assert.deepEqual(log.entries.map((e) => e.cycle), ["2605-06", "2606-07", "2607-08", "2608-09", "2609-10", "2610-11"]);
    assert.deepEqual(log.entries.map((e) => e.numero), [2, 3, 4, 5, null, 6]);
  });
});
