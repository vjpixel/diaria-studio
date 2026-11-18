/**
 * test/conflict-copy-triage-13423.test.ts (#13423)
 *
 * Triagem das cópias `.conflictN` acumuladas em `data/` (#13404). Fixture em
 * diretório temporário, nunca o `data/` real. Trava: o dry-run não move nada,
 * o `--apply` exige plano, só `archive` sai do lugar, nada é apagado, e
 * cópia sem original (a possível única cópia, #9732) fica onde está.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyTriagePlan,
  buildTriagePlan,
  classifyConflictCopy,
  conflictChainOriginalName,
  fileValidity,
  findConflictCopies,
  parseTriagePlan,
  summarizePlan,
  brtStampAAMMDD,
  type CopyFacts,
} from "../scripts/lib/conflict-copy-triage.ts";
import { main } from "../scripts/triage-conflict-copies.ts";

let root: string;

function put(rel: string, content: string | Buffer, mtimeSec?: number): string {
  const p = join(root, ...rel.split("/"));
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

/** Lista recursiva de todos os arquivos (para provar que nada some). */
function allFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...allFiles(full, base));
    else out.push(full.slice(base.length + 1).split("\\").join("/"));
  }
  return out.sort();
}

const SQLITE_HEADER = Buffer.concat([Buffer.from("SQLite format 3\u0000", "latin1"), Buffer.alloc(84)]);
const T_OLD = 1_700_000_000;
const T_NEW = 1_700_100_000;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "triage-13423-")));
  // idêntica
  put("editions/2611/261116/_internal/blocks.json", '{"a":1}', T_NEW);
  put("editions/2611/261116/_internal/blocks.json.conflict1", '{"a":1}', T_OLD);
  // mais antiga e diferente, original válido
  put("editions/2611/261116/_internal/blocks.json.conflict2", '{"a":0}', T_OLD);
  // mais nova e diferente: pode ser a boa
  put("editions/2611/261116/_internal/plan.json", '{"v":1}', T_OLD);
  put("editions/2611/261116/_internal/plan.json.conflict1", '{"v":2}', T_NEW);
  // sem original: talvez a única cópia
  put("editions/2611/261118/_internal/roteiro-falas.json.conflict1", '{"f":[]}', T_OLD);
  // original inválido
  put("alarms/state.json", "{quebrado", T_NEW);
  put("alarms/state.json.conflict1", '{"ok":true}', T_OLD);
  // cópia inválida, original válido
  put("alarms/other.json", '{"ok":true}', T_OLD);
  put("alarms/other.json.conflict1", "{trunc", T_NEW);
  // JSONL com linha só na cópia (mais antiga)
  put("logs/run-log.jsonl", '{"i":1}\n{"i":2}\n', T_NEW);
  put("logs/run-log.jsonl.conflict1", '{"i":1}\n{"i":9}\n', T_OLD);
  // JSONL contido no original
  put("logs/run-log.jsonl.conflict2", '{"i":1}\n', T_OLD);
  // registro de sessão diferente
  put("sessions/develop-Neo-x.json", '{"claimed_issues":[]}', T_NEW);
  put("sessions/develop-Neo-x.json.conflict1.conflict2", '{"claimed_issues":[1]}', T_OLD);
  // sqlite: original válido e mais novo
  put("diaria-subscribers/diaria-subscribers.db", Buffer.concat([SQLITE_HEADER, Buffer.from("new")]), T_NEW);
  put("diaria-subscribers/diaria-subscribers.db.conflict3", Buffer.concat([SQLITE_HEADER, Buffer.from("old")]), T_OLD);
  // já arquivada: fora da varredura
  put("editions/2611/261117/_internal/_conflitos-261117/x.json.conflict1", "{}", T_OLD);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function verdictOf(plan: ReturnType<typeof buildTriagePlan>, rel: string) {
  const e = plan.entries.find((x) => x.rel === rel);
  assert.ok(e, `entrada ausente: ${rel}`);
  return `${e.verdict}/${e.reason}`;
}

describe("conflictChainOriginalName (#13423)", () => {
  it("tira o sufixo em cadeia e ignora nome sem sufixo", () => {
    assert.equal(conflictChainOriginalName("s.json.conflict1"), "s.json");
    assert.equal(conflictChainOriginalName("s.json.conflict1.conflict12"), "s.json");
    assert.equal(conflictChainOriginalName("noext.conflict3"), "noext");
    assert.equal(conflictChainOriginalName("s.json"), null);
    assert.equal(conflictChainOriginalName(".conflict1"), null);
  });
});

describe("classifyConflictCopy (#13423)", () => {
  const base: CopyFacts = {
    rel: "x/a.json.conflict1",
    originalExists: true,
    originalValid: { ok: true },
    copyValid: { ok: true },
    identical: false,
    copyMtimeMs: 1,
    originalMtimeMs: 2,
    jsonlOnlyInCopy: null,
  };
  it("original ausente nunca é arquivado", () => {
    assert.equal(classifyConflictCopy({ ...base, originalExists: false, originalValid: null, originalMtimeMs: null }).verdict, "keep");
  });
  it("original inválido nunca é arquivado, mesmo com cópia idêntica", () => {
    assert.equal(classifyConflictCopy({ ...base, identical: true, originalValid: { ok: false, why: "vazio" } }).verdict, "keep");
  });
  it("cópia mais nova e diferente vai para revisão", () => {
    assert.equal(classifyConflictCopy({ ...base, copyMtimeMs: 3 }).reason, "copia-mais-nova-difere");
  });
  it("mesmo horário do original arquiva", () => {
    assert.equal(classifyConflictCopy({ ...base, copyMtimeMs: 2 }).verdict, "archive");
  });
});

describe("fileValidity (#13423)", () => {
  it("lê JSON, JSONL, SQLite e vazio", () => {
    assert.equal(fileValidity(put("v/a.json", "{}")).ok, true);
    assert.equal(fileValidity(put("v/b.json", "{")).ok, false);
    // stream-json com extensão .json (overnight/.nightly-chain-last-overnight.json)
    assert.equal(fileValidity(put("v/b2.json", '{"type":"system"}\n{"type":"result"}\n')).ok, true);
    assert.equal(fileValidity(put("v/c.jsonl", '{"a":1}\n\n{"b":2}\n')).ok, true);
    assert.equal(fileValidity(put("v/d.jsonl", '{"a":1}\nlixo\n')).ok, false);
    assert.equal(fileValidity(put("v/e.db", SQLITE_HEADER)).ok, true);
    assert.equal(fileValidity(put("v/f.db", "não é sqlite")).ok, false);
    assert.equal(fileValidity(put("v/g.txt", "")).ok, false);
    assert.equal(fileValidity(put("v/h.txt", "x")).ok, true);
  });
});

describe("buildTriagePlan sobre fixture (#13423)", () => {
  it("classifica cada caso da issue", () => {
    const plan = buildTriagePlan(root, { stamp: "261117" });
    assert.equal(verdictOf(plan, "editions/2611/261116/_internal/blocks.json.conflict1"), "archive/identica");
    assert.equal(verdictOf(plan, "editions/2611/261116/_internal/blocks.json.conflict2"), "archive/copia-mais-antiga");
    assert.equal(verdictOf(plan, "editions/2611/261116/_internal/plan.json.conflict1"), "review/copia-mais-nova-difere");
    assert.equal(verdictOf(plan, "editions/2611/261118/_internal/roteiro-falas.json.conflict1"), "keep/original-ausente");
    assert.equal(verdictOf(plan, "alarms/state.json.conflict1"), "keep/original-invalido");
    assert.equal(verdictOf(plan, "alarms/other.json.conflict1"), "archive/copia-invalida");
    assert.equal(verdictOf(plan, "logs/run-log.jsonl.conflict1"), "review/jsonl-linhas-so-na-copia");
    assert.equal(verdictOf(plan, "logs/run-log.jsonl.conflict2"), "archive/copia-mais-antiga");
    assert.equal(verdictOf(plan, "sessions/develop-Neo-x.json.conflict1.conflict2"), "review/registro-de-sessao");
    assert.equal(verdictOf(plan, "diaria-subscribers/diaria-subscribers.db.conflict3"), "archive/copia-mais-antiga");
  });
  it("não varre _conflitos-* e soma por veredito", () => {
    const copies = findConflictCopies(root);
    assert.ok(copies.every((p) => !p.includes("_conflitos-")));
    const s = summarizePlan(buildTriagePlan(root).entries);
    assert.deepEqual(s.byVerdict, { archive: 5, review: 3, keep: 2 });
    assert.equal(s.total, 10);
  });
  it("stamp default é AAMMDD em BRT", () => {
    // 2026-11-18 02:00 UTC = 2026-11-17 23:00 BRT
    assert.equal(brtStampAAMMDD(Date.UTC(2026, 10, 18, 2, 0)), "261117");
  });
});

describe("applyTriagePlan (#13423)", () => {
  it("move só archive para _conflitos-{stamp}/ ao lado, sem apagar nada", () => {
    const before = allFiles(root);
    const plan = buildTriagePlan(root, { stamp: "261117" });
    const res = applyTriagePlan(plan, root);
    assert.equal(res.filter((r) => r.status === "moved").length, 5);
    const after = allFiles(root);
    assert.equal(after.length, before.length, "nenhum arquivo apagado");
    assert.ok(after.includes("editions/2611/261116/_internal/_conflitos-261117/blocks.json.conflict1"));
    assert.ok(after.includes("diaria-subscribers/_conflitos-261117/diaria-subscribers.db.conflict3"));
    // review e keep ficam no lugar
    assert.ok(after.includes("editions/2611/261116/_internal/plan.json.conflict1"));
    assert.ok(after.includes("editions/2611/261118/_internal/roteiro-falas.json.conflict1"));
    assert.ok(after.includes("sessions/develop-Neo-x.json.conflict1.conflict2"));
    assert.ok(after.includes("alarms/state.json.conflict1"));
    // original intocado
    assert.equal(readFileSync(join(root, "editions/2611/261116/_internal/blocks.json"), "utf8"), '{"a":1}');
  });
  it("pula a entrada cujo original ou cópia mudou depois do dry-run", () => {
    const plan = buildTriagePlan(root, { stamp: "261117" });
    writeFileSync(join(root, "editions/2611/261116/_internal/blocks.json"), '{"a":2}');
    writeFileSync(join(root, "alarms/other.json.conflict1"), "{outro");
    const res = applyTriagePlan(plan, root);
    const skipped = Object.fromEntries(res.filter((r) => r.status === "skipped").map((r) => [r.rel, r.status === "skipped" ? r.why : ""]));
    assert.equal(skipped["editions/2611/261116/_internal/blocks.json.conflict1"], "original mudou desde o dry-run");
    assert.equal(skipped["alarms/other.json.conflict1"], "cópia mudou desde o dry-run");
    assert.ok(existsSync(join(root, "alarms/other.json.conflict1")));
  });
  it("nunca sobrescreve um destino que já existe", () => {
    put("alarms/_conflitos-261117/other.json.conflict1", "anterior");
    const res = applyTriagePlan(buildTriagePlan(root, { stamp: "261117" }), root);
    const r = res.find((x) => x.rel === "alarms/other.json.conflict1");
    assert.deepEqual(r, { rel: "alarms/other.json.conflict1", status: "skipped", why: "destino já existe no arquivo" });
    assert.equal(readFileSync(join(root, "alarms/_conflitos-261117/other.json.conflict1"), "utf8"), "anterior");
  });
});

describe("parseTriagePlan (#13423)", () => {
  it("recusa plano estranho e caminho com ..", () => {
    assert.throws(() => parseTriagePlan({ issue: 1 }));
    assert.throws(() => parseTriagePlan({ issue: 13423, root: "/x", stamp: "../x", entries: [] }));
    assert.throws(() => parseTriagePlan({ issue: 13423, root: "/x", stamp: "261117", entries: [{ rel: "../a.conflict1", originalRel: "a" }] }));
  });
});

describe("CLI triage-conflict-copies (#13423)", () => {
  function quiet<T>(fn: () => T): T {
    const log = console.log;
    const err = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.log = log;
      console.error = err;
    }
  }
  it("dry-run é o default e não move nada", () => {
    const before = allFiles(root);
    assert.equal(quiet(() => main(["--root", root])), 0);
    assert.deepEqual(allFiles(root), before);
  });
  it("--apply sem --plan é recusado sem mover nada", () => {
    const before = allFiles(root);
    assert.equal(quiet(() => main(["--root", root, "--apply"])), 2);
    assert.deepEqual(allFiles(root), before);
  });
  it("--out + --apply --plan arquiva só as archive", () => {
    const planFile = join(mkdtempSync(join(tmpdir(), "triage-13423-plan-")), "plano.json");
    assert.equal(quiet(() => main(["--root", root, "--out", planFile, "--stamp", "261117"])), 0);
    assert.equal(quiet(() => main(["--root", root, "--apply", "--plan", planFile])), 0);
    assert.ok(existsSync(join(root, "logs/_conflitos-261117/run-log.jsonl.conflict2")));
    assert.ok(existsSync(join(root, "logs/run-log.jsonl.conflict1")));
    rmSync(join(planFile, ".."), { recursive: true, force: true });
  });
  it("plano de outra raiz é recusado", () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "triage-13423-other-")));
    const planFile = join(other, "plano.json");
    assert.equal(quiet(() => main(["--root", other, "--out", planFile])), 0);
    assert.equal(quiet(() => main(["--root", root, "--apply", "--plan", planFile])), 2);
    rmSync(other, { recursive: true, force: true });
  });
  it("raiz ausente sai 1 e flag desconhecida sai 2", () => {
    assert.equal(quiet(() => main(["--root", join(root, "nao-existe")])), 1);
    assert.equal(quiet(() => main(["--root", root, "--force"])), 2);
  });
});
