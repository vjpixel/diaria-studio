/**
 * test/clarice-tutorial-11836.test.ts (#11836)
 *
 * CLARICE — TUTORIAL da mensal vem do Doc "Laboratório Clarice": parse do
 * texto do Doc (fixture = texto real lido pelo conector em 03/11/2026) e do
 * JSON real do `read_doc` (fixture enxuta: 2 tutoriais + Notas), escolha do
 * próximo tutorial contra o registro, idempotência por ciclo, esgotado,
 * identidade número + título, log malformado/ausente e o CLI.
 *
 * O registro de produção vive em `data/monthly/clarice-tutorial-log.json`
 * (fora do git); aqui o histórico é a constante congelada `SEED`, que tem de
 * bater com o seed declarado no corpo da PR.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClariceTutorialError,
  docJsonToMarkedText,
  parseLaboratorioClarice,
  parseTutorialLog,
  pickNextTutorial,
  recordTutorial,
  type TutorialLog,
} from "../scripts/lib/mensal/clarice-tutorial.ts";
import { run, DEFAULT_LOG_PATH } from "../scripts/clarice-tutorial-next.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test", "fixtures", "clarice-laboratorio.txt");
const FIXTURE_JSON = join(ROOT, "test", "fixtures", "clarice-laboratorio-read-doc.json");
const text = readFileSync(FIXTURE, "utf8");

/** Histórico congelado (7 entradas): o mesmo JSON que a PR declara em "Escrita pendente em data/". */
const SEED: TutorialLog = {
  doc_id: "1KiuwIGyUP3JDhxoCPxV_EgWINWc-osIsSZ_Y1ZCjIIY",
  doc_title: "Laboratório Clarice",
  entries: [
    { cycle: "2604-05", numero: 1, titulo: "Revisar (correção, clareza, concisão)", nota: "rotulado LABORATÓRIO CLARICE; título no draft: Editar, revisar e humanizar texto em português" },
    { cycle: "2605-06", numero: 2, titulo: "Personalizar o tom da revisão", nota: "rotulado LABORATÓRIO CLARICE no draft" },
    { cycle: "2606-07", numero: 3, titulo: "Parafrasear sem repetir você mesmo", nota: "rotulado LABORATÓRIO CLARICE no draft" },
    { cycle: "2607-08", numero: 4, titulo: "Humanizar texto gerado por IA", nota: "rotulado LABORATÓRIO CLARICE no draft" },
    { cycle: "2608-09", numero: 5, titulo: "Sumarizar um texto longo" },
    { cycle: "2609-10", numero: null, titulo: "Simplificar um trecho difícil", nota: "fora da lista do Doc" },
    { cycle: "2610-11", numero: 6, titulo: "Conversar com a Clarice sobre o seu texto" },
  ],
};
const seededLog = (): TutorialLog => structuredClone(SEED);
const seedRaw = () => JSON.stringify(SEED, null, 2) + "\n";

const reasonOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ClariceTutorialError, `esperado ClariceTutorialError, veio ${err}`);
    return err.reason;
  }
  assert.fail("esperado erro");
};

describe("parseLaboratorioClarice (#11836)", () => {
  const tutorials = parseLaboratorioClarice(text);

  it("acha os tutoriais na ordem do Doc e ignora Notas", () => {
    assert.deepEqual(tutorials.map((t) => t.numero), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(!tutorials.some((t) => /notas/i.test(t.titulo)));
    assert.ok(!tutorials.some((t) => t.passos.some((p) => /Detalhes técnicos/.test(p))));
  });

  it("separa título, intro, passos, dica e CTA; passos entre 3 e 5", () => {
    const t1 = tutorials[0];
    assert.equal(t1.titulo, "Revisar (correção, clareza, concisão)");
    assert.match(t1.intro, /^A Clarice classifica as sugestões/);
    assert.equal(t1.passos.length, 4);
    assert.equal(t1.passos[0], "Cole ou digite o texto na área de revisão.");
    assert.equal(t1.dica, "Ctrl+Z desfaz, Ctrl+Y refaz, e o documento salva automaticamente.");
    assert.equal(t1.cta, "Assine agora e ganhe até 63% de desconto");
    for (const t of tutorials) {
      assert.ok(t.passos.length >= 3 && t.passos.length <= 5, `tutorial ${t.numero}: ${t.passos.length} passos`);
      assert.ok(t.dica && t.cta && t.intro, `tutorial ${t.numero} incompleto`);
    }
  });

  it("aceita texto plano sem marcadores, inclusive com passos numerados", () => {
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

  it("os dois modos aceitam número fora de sequência (a ordem do Doc é a lista)", () => {
    const skip = (s: string) => s.replace("2. Personalizar o tom", "9. Personalizar o tom");
    const plain = text.split("\n").map((l) => l.replace(/^\[HEADING_\d\]\s*/, "")).join("\n");
    assert.deepEqual(parseLaboratorioClarice(skip(text)).map((t) => t.numero), [1, 9, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(parseLaboratorioClarice(skip(plain)).map((t) => t.numero), [1, 9, 3, 4, 5, 6, 7, 8]);
  });

  it("texto sem tutorial nenhum é erro doc-invalido, nunca lista vazia", () => {
    assert.equal(reasonOf(() => parseLaboratorioClarice("Outro documento\nsem tutoriais")), "doc-invalido");
    assert.throws(() => parseLaboratorioClarice(""), /nenhum tutorial/);
  });

  const T = (n: number, passos = 3) =>
    `[HEADING_2] ${n}. Título ${n}\nIntro.\n${Array.from({ length: passos }, (_, i) => `Passo ${i + 1}.`).join("\n")}\nDica: d.\n→ Assine`;

  it("tutorial incompleto é erro que nomeia o tutorial", () => {
    const semDica = "[HEADING_2] 1. Revisar\nIntro.\nPasso um.\nPasso dois.\nPasso três.\n→ Assine";
    assert.throws(() => parseLaboratorioClarice(semDica), /tutorial 1 .*Dica/);
  });

  it("passos fora de 3 a 5 é erro", () => {
    assert.doesNotThrow(() => parseLaboratorioClarice(T(1, 3)));
    assert.doesNotThrow(() => parseLaboratorioClarice(T(1, 5)));
    assert.throws(() => parseLaboratorioClarice(T(1, 2)), /2 passos/);
    assert.throws(() => parseLaboratorioClarice(T(1, 6)), /6 passos/);
  });

  it("estrito: heading numerado fora de HEADING_2 é erro", () => {
    const h3 = `${T(1)}\n${T(2).replace("[HEADING_2]", "[HEADING_3]")}`;
    assert.throws(() => parseLaboratorioClarice(h3), /HEADING_3; tutorial é HEADING_2/);
  });

  it("estrito: HEADING_2 não numerado (fora de Notas) depois do 1º tutorial é erro", () => {
    const solto = `${T(1)}\n[HEADING_2] Bônus\nIntro solta.\n${T(2)}`;
    assert.throws(() => parseLaboratorioClarice(solto), /"Bônus".*não é tutorial nem "Notas"/);
    // antes do 1º tutorial (preâmbulo) e HEADING_1 seguem permitidos
    assert.doesNotThrow(() => parseLaboratorioClarice(`[HEADING_1] Doc\n[HEADING_2] Sobre\nTexto.\n${T(1)}`));
  });

  it("estrito: tutorial repetido é erro", () => {
    assert.throws(() => parseLaboratorioClarice(`${T(1)}\n${T(1)}`), /aparece duas vezes/);
  });
});

describe("docJsonToMarkedText (#11836)", () => {
  it("JSON real do read_doc (vários textRun por parágrafo, bullets, sectionBreak, horizontalRule) = parse do texto", () => {
    const json = JSON.parse(readFileSync(FIXTURE_JSON, "utf8"));
    const body = json.content.tabs[0].documentTab.body.content as any[];
    // a fixture cobre o que torna o JSON diferente do texto
    assert.ok(body.some((e) => e.sectionBreak));
    assert.ok(body.some((e) => e.paragraph?.bullet));
    assert.ok(body.some((e) => (e.paragraph?.elements?.filter((x: any) => x.textRun).length ?? 0) > 1));
    assert.ok(body.some((e) => e.paragraph?.elements?.some((x: any) => x.horizontalRule)));
    const fromJson = parseLaboratorioClarice(docJsonToMarkedText(json));
    assert.deepEqual(fromJson.map((t) => t.numero), [1, 2]);
    assert.deepEqual(fromJson, parseLaboratorioClarice(text).slice(0, 2));
  });

  it("converte o JSON sintético (com abas) no mesmo resultado do texto completo", () => {
    const para = (t: string, style = "NORMAL_TEXT") => ({
      paragraph: { paragraphStyle: { namedStyleType: style }, elements: [{ textRun: { content: t + "\n" } }] },
    });
    const content = text.split("\n").map((l) => {
      const m = l.match(/^\[HEADING_(\d)\]\s*(.*)$/);
      return m ? para(m[2], `HEADING_${m[1]}`) : para(l);
    });
    const json = { content: { tabs: [{ documentTab: { body: { content } } }] } };
    assert.deepEqual(parseLaboratorioClarice(docJsonToMarkedText(json)), parseLaboratorioClarice(text));
  });

  it("JSON sem corpo é erro doc-invalido", () => {
    assert.equal(reasonOf(() => docJsonToMarkedText({ foo: 1 })), "doc-invalido");
  });
});

describe("parseTutorialLog (#11836)", () => {
  const bad = (entries: unknown) => () => parseTutorialLog(JSON.stringify({ entries }));
  const ok = { cycle: "2611-12", numero: 7, titulo: "x" };

  it("seed congelado é válido", () => {
    assert.deepEqual(parseTutorialLog(seedRaw()), SEED);
  });

  it("malformado → log-invalido, nunca log vazio", () => {
    assert.equal(reasonOf(() => parseTutorialLog("{ não é json")), "log-invalido");
    assert.equal(reasonOf(() => parseTutorialLog("{}")), "log-invalido");
    assert.equal(reasonOf(() => parseTutorialLog("null")), "log-invalido");
    assert.equal(reasonOf(bad([{ ...ok, numero: "7" }])), "log-invalido");
    assert.equal(reasonOf(bad([{ numero: 7, titulo: "x" }])), "log-invalido");
    assert.equal(reasonOf(bad([{ ...ok, cycle: "2611" }])), "log-invalido");
    assert.equal(reasonOf(bad([{ ...ok, cycle: "26-1112" }])), "log-invalido");
    assert.equal(reasonOf(bad([{ ...ok, titulo: "" }])), "log-invalido");
    assert.equal(reasonOf(bad([ok, { ...ok, numero: 8 }])), "log-invalido");
    assert.equal(reasonOf(bad([ok, { ...ok, cycle: "2612-01" }])), "log-invalido");
    assert.throws(bad([ok, { ...ok, cycle: "2612-01" }]), /tutorial 7 registrado em dois ciclos/);
    assert.throws(bad([ok, { ...ok, numero: 8 }]), /ciclo 2611-12 aparece duas vezes/);
  });
});

describe("pickNextTutorial (#11836)", () => {
  const tutorials = parseLaboratorioClarice(text);

  it("com o log semeado, o próximo é o #7 (o #1 saiu em 2604-05)", () => {
    const r = pickNextTutorial(tutorials, seededLog(), "2611-12");
    assert.ok(r.kind === "tutorial" && r.tutorial.numero === 7 && !r.reused);
  });

  it("depois do #7 vem o #8, e então esgotado", () => {
    let log = seededLog();
    const seq: number[] = [];
    for (const cycle of ["2611-12", "2612-01"]) {
      const r = pickNextTutorial(tutorials, log, cycle);
      assert.equal(r.kind, "tutorial");
      if (r.kind !== "tutorial") return;
      seq.push(r.tutorial.numero);
      log = recordTutorial(log, cycle, r.tutorial, "2026-11-03");
    }
    assert.deepEqual(seq, [7, 8]);
    const r = pickNextTutorial(tutorials, log, "2701-02");
    assert.equal(r.kind, "esgotado");
    assert.ok(r.kind === "esgotado" && r.no_doc.length === 8 && r.usados.length === 8);
  });

  it("idempotente: o ciclo já registrado devolve o mesmo tutorial", () => {
    const first = pickNextTutorial(tutorials, seededLog(), "2611-12");
    assert.ok(first.kind === "tutorial");
    const log = recordTutorial(seededLog(), "2611-12", first.tutorial, "2026-11-03");
    const again = pickNextTutorial(tutorials, log, "2611-12");
    assert.ok(again.kind === "tutorial" && again.reused && again.tutorial.numero === first.tutorial.numero);
    const old = pickNextTutorial(tutorials, log, "2604-05");
    assert.ok(old.kind === "tutorial" && old.tutorial.numero === 1 && old.reused);
    assert.equal(recordTutorial(log, "2611-12", first.tutorial, "x").entries.length, log.entries.length);
  });

  it("ciclo registrado fora da lista (Simplificar, 2609-10) não avança a sequência", () => {
    assert.equal(pickNextTutorial(tutorials, seededLog(), "2609-10").kind, "fora-da-lista");
  });

  it("log que aponta tutorial inexistente no Doc é log-diverge-do-doc", () => {
    const log: TutorialLog = { entries: [{ cycle: "2611-12", numero: 99, titulo: "x" }] };
    assert.equal(reasonOf(() => pickNextTutorial(tutorials, log, "2611-12")), "log-diverge-do-doc");
  });

  it("identidade é número + título: Doc reordenado é log-diverge-do-doc (reused e usados)", () => {
    // Doc reordenado: o 7 e o 8 trocaram de título
    const swapped = tutorials.map((t) =>
      t.numero === 7 ? { ...t, titulo: tutorials[7].titulo } : t.numero === 8 ? { ...t, titulo: tutorials[6].titulo } : t,
    );
    const log = recordTutorial(seededLog(), "2611-12", tutorials[6], "2026-11-03");
    // caminho reused (o próprio ciclo)
    assert.throws(() => pickNextTutorial(swapped, log, "2611-12"), /registra o tutorial 7 como/);
    // caminho usados (outro ciclo): a entrada divergente também barra
    assert.equal(reasonOf(() => pickNextTutorial(swapped, log, "2612-01")), "log-diverge-do-doc");
    // diferença só de caixa/espaço não é divergência
    const spaced = seededLog();
    spaced.entries[1] = { ...spaced.entries[1], titulo: "  personalizar o TOM  da revisão " };
    assert.equal(pickNextTutorial(tutorials, spaced, "2605-06").kind, "tutorial");
    // entrada fora da lista (numero null) não é conferida
    assert.equal(pickNextTutorial(swapped.slice(0, 6), seededLog(), "2609-10").kind, "fora-da-lista");
  });
});

describe("clarice-tutorial-next CLI (#11836)", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "clarice-tut-"));
  const parseOk = (r: { exitCode: number; stdout: string; stderr: string }) => {
    assert.equal(r.exitCode, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const parseErr = (r: { exitCode: number; stdout: string; stderr: string }, reason: string) => {
    assert.equal(r.exitCode, 1, r.stdout);
    const p = JSON.parse(r.stdout);
    assert.equal(p.kind, "erro");
    assert.equal(p.reason, reason);
    assert.ok(r.stderr.startsWith(`clarice-tutorial-next [${reason}]:`), r.stderr);
    return p;
  };

  it("log default fica em data/monthly/ (fora do git)", () => {
    assert.equal(DEFAULT_LOG_PATH, join(ROOT, "data", "monthly", "clarice-tutorial-log.json"));
    assert.equal(existsSync(join(ROOT, "context", "clarice-tutorial-log.json")), false);
  });

  it("--record grava a entrada no log e --out grava o tutorial; 2ª rodada reaproveita", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, seedRaw());
    const out = join(dir, "_internal", "clarice-tutorial.json");
    const argv = ["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log, "--record", "--out", out];
    const p1 = parseOk(run(argv, new Date("2026-11-03T12:00:00Z")));
    assert.equal(p1.kind, "tutorial");
    assert.equal(p1.tutorial.numero, 7);
    assert.equal(p1.recorded, true);
    const saved = parseTutorialLog(readFileSync(log, "utf8"));
    assert.deepEqual(saved.entries.at(-1), {
      cycle: "2611-12",
      numero: 7,
      titulo: "Diagnosticar o estado do texto antes de revisar",
      recorded_at: "2026-11-03",
    });
    assert.equal(JSON.parse(readFileSync(out, "utf8")).numero, 7);

    const p2 = parseOk(run(argv));
    assert.equal(p2.tutorial.numero, 7);
    assert.equal(p2.reused, true);
    assert.equal(p2.recorded, false);
    assert.equal(parseTutorialLog(readFileSync(log, "utf8")).entries.length, saved.entries.length);
  });

  it("--doc-json com o JSON real do read_doc funciona", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, JSON.stringify({ entries: [] }));
    const p = parseOk(run(["--cycle", "2611-12", "--doc-json", FIXTURE_JSON, "--log", log]));
    assert.equal(p.tutorial.numero, 1);
  });

  it("--out é gravado antes do log: falha no --out não registra o ciclo", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, seedRaw());
    const blocker = join(dir, "arquivo");
    writeFileSync(blocker, "x");
    const r = run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log, "--record", "--out", join(blocker, "sub", "t.json")]);
    parseErr(r, "io");
    assert.equal(readFileSync(log, "utf8"), seedRaw());
  });

  it("sem --record não toca o log", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, seedRaw());
    parseOk(run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log]));
    assert.equal(readFileSync(log, "utf8"), seedRaw());
  });

  it("esgotado com --record --out: exit 0, não altera o log nem grava --out", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    const entries = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      cycle: `26${String(n).padStart(2, "0")}-01`,
      numero: n,
      titulo: parseLaboratorioClarice(text)[n - 1].titulo,
    }));
    const before = JSON.stringify({ entries });
    writeFileSync(log, before);
    const out = join(dir, "out.json");
    const p = parseOk(run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log, "--record", "--out", out]));
    assert.equal(p.kind, "esgotado");
    assert.deepEqual(p.no_doc, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(existsSync(out), false);
    assert.equal(readFileSync(log, "utf8"), before);
  });

  it("fora-da-lista com --record --out: exit 0, não altera o log nem grava --out", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, seedRaw());
    const out = join(dir, "out.json");
    const p = parseOk(run(["--cycle", "2609-10", "--doc-text", FIXTURE, "--log", log, "--record", "--out", out]));
    assert.equal(p.kind, "fora-da-lista");
    assert.equal(p.entry.titulo, "Simplificar um trecho difícil");
    assert.equal(existsSync(out), false);
    assert.equal(readFileSync(log, "utf8"), seedRaw());
  });

  it("log ausente → log-ausente (nunca recomeça do #1 em silêncio), sem --out", () => {
    const dir = tmp();
    const out = join(dir, "out.json");
    const r = run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", join(dir, "nao-existe.json"), "--record", "--out", out]);
    parseErr(r, "log-ausente");
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(join(dir, "nao-existe.json")), false);
  });

  it("log malformado → log-invalido; log divergente → log-diverge-do-doc", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, "{ quebrado");
    parseErr(run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log]), "log-invalido");
    writeFileSync(log, JSON.stringify({ entries: [{ cycle: "2604-05", numero: 1, titulo: "Outro título" }] }));
    parseErr(run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--log", log]), "log-diverge-do-doc");
  });

  it("Doc que não parseia → doc-invalido (texto e JSON); arquivo do Doc ausente → io", () => {
    const dir = tmp();
    const log = join(dir, "log.json");
    writeFileSync(log, seedRaw());
    const bad = join(dir, "bad.txt");
    writeFileSync(bad, "nada aqui");
    const p = parseErr(run(["--cycle", "2611-12", "--doc-text", bad, "--log", log]), "doc-invalido");
    assert.match(p.message, /nenhum tutorial/);
    const badJson = join(dir, "bad.json");
    writeFileSync(badJson, "{ não é json");
    parseErr(run(["--cycle", "2611-12", "--doc-json", badJson, "--log", log]), "doc-invalido");
    parseErr(run(["--cycle", "2611-12", "--doc-text", join(dir, "sumiu.txt"), "--log", log]), "io");
  });

  it("uso inválido sai exit 1 com reason uso", () => {
    parseErr(run(["--doc-text", FIXTURE]), "uso");
    parseErr(run(["--cycle", "2611", "--doc-text", FIXTURE]), "uso");
    parseErr(run(["--cycle", "2611-12"]), "uso");
    parseErr(run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--doc-json", FIXTURE_JSON]), "uso");
    for (const k of ["out", "log", "doc-text", "doc-json", "cycle"]) {
      parseErr(run(["--cycle", "2611-12", "--doc-text", FIXTURE, `--${k}`]), "uso");
      parseErr(run(["--cycle", "2611-12", "--doc-text", FIXTURE, `--${k}`, "--record"]), "uso");
    }
    parseErr(run(["--cycle", "2611-12", "--doc-text", FIXTURE, "--out="]), "uso");
  });
});
