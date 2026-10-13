/**
 * test/clarice-envio-enabled.test.ts (automação do envio Clarice — decisões
 * do editor 260811)
 *
 * Cobre `scripts/lib/clarice-envio-enabled.ts` — o kill switch do par de
 * tasks `Diaria-Clarice-Envio` (19:00) / `Diaria-Clarice-Envio-Guard`
 * (05:00). Mesmo molde de `test/clarice-novos-enabled.test.ts`, travando as
 * DUAS divergências deliberadas em relação ao irmão (ver docstring do
 * módulo):
 *
 *   1. arquivo AUSENTE -> `enabled: true` (LIGADO — decisão do editor
 *      "ligada desde o início"), ao contrário do `clarice-novos`, que nasce
 *      pausado;
 *   2. arquivo PRESENTE mas ilegível/inválido -> `enabled: false` (PAUSADO)
 *      **e com aviso**, porque ilegível é sinal de problema, não de intenção
 *      — e uma pausa que o editor não pediu não pode ser silenciosa.
 *
 * Os dois defaults são OPOSTOS de propósito: os testes abaixo existem
 * justamente pra que ninguém "uniformize" isso com o irmão sem ler o porquê.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  readClariceEnvioEnabledState,
  isClariceEnvioEnabled,
  setClariceEnvioEnabled,
} from "../scripts/lib/clarice-envio-enabled.ts";

/** Root descartável com um `data/clarice-envio-enabled.json` de conteúdo
 * arbitrário (string crua — pra poder escrever JSON inválido/vazio). */
function rootWithStateFile(label: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), `clarice-envio-enabled-${label}-`));
  mkdirSync(resolve(dir, "data"), { recursive: true });
  writeFileSync(resolve(dir, "data", "clarice-envio-enabled.json"), contents, "utf8");
  return dir;
}

/** Coletor de avisos — o módulo aceita `onInvalid` injetável exatamente pra
 * este teste assertar o aviso sem despejar `console.warn` na saída da suíte. */
function collector(): { warnings: string[]; onInvalid: (m: string) => void } {
  const warnings: string[] = [];
  return { warnings, onInvalid: (m: string) => warnings.push(m) };
}

describe("readClariceEnvioEnabledState — default de arquivo AUSENTE é LIGADO (divergência 1, decisão do editor)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "clarice-envio-enabled-absent-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("sem data/clarice-envio-enabled.json -> {enabled:true, updatedAt:null} (INVERSO do clarice-novos)", () => {
    const c = collector();
    assert.deepEqual(readClariceEnvioEnabledState(root, c), { enabled: true, updatedAt: null, fileAbsent: true });
    assert.equal(isClariceEnvioEnabled(root, c), true);
  });

  it("arquivo ausente NÃO avisa — é o default esperado, não um problema", () => {
    const c = collector();
    readClariceEnvioEnabledState(root, c);
    assert.deepEqual(c.warnings, []);
  });

  it("nem sequer o diretório data/ existindo muda o default (root vazio -> LIGADO)", () => {
    const bare = mkdtempSync(join(tmpdir(), "clarice-envio-enabled-bare-"));
    const c = collector();
    assert.equal(isClariceEnvioEnabled(bare, c), true);
    assert.deepEqual(c.warnings, []);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe("readClariceEnvioEnabledState — arquivo válido manda no estado", () => {
  it('{"enabled": false} -> false (o editor pausou explicitamente)', () => {
    const dir = rootWithStateFile("false", JSON.stringify({ enabled: false, updatedAt: "2026-08-11T22:00:00.000Z" }));
    const c = collector();
    assert.deepEqual(readClariceEnvioEnabledState(dir, c), {
      enabled: false,
      updatedAt: "2026-08-11T22:00:00.000Z",
    });
    assert.equal(isClariceEnvioEnabled(dir, c), false);
    assert.deepEqual(c.warnings, [], "arquivo válido nunca avisa");
    rmSync(dir, { recursive: true, force: true });
  });

  it('{"enabled": true} -> true (idêntico ao default, mas escrito de propósito)', () => {
    const dir = rootWithStateFile("true", JSON.stringify({ enabled: true, updatedAt: "2026-08-11T22:05:00.000Z" }));
    const c = collector();
    assert.deepEqual(readClariceEnvioEnabledState(dir, c), {
      enabled: true,
      updatedAt: "2026-08-11T22:05:00.000Z",
    });
    assert.equal(isClariceEnvioEnabled(dir, c), true);
    assert.deepEqual(c.warnings, []);
    rmSync(dir, { recursive: true, force: true });
  });

  it("'updatedAt' de tipo errado -> normaliza pra null, 'enabled' ainda respeitado", () => {
    const dir = rootWithStateFile("badupdated", JSON.stringify({ enabled: false, updatedAt: 12345 }));
    const c = collector();
    assert.deepEqual(readClariceEnvioEnabledState(dir, c), { enabled: false, updatedAt: null });
    assert.deepEqual(c.warnings, [], "'enabled' é o campo que decide; updatedAt torto não invalida o arquivo");
    rmSync(dir, { recursive: true, force: true });
  });

  it('#10117: {"enabled": true} escrito à mão sem updatedAt NÃO carrega fileAbsent (não é o default de ausência)', () => {
    const dir = rootWithStateFile("manual", JSON.stringify({ enabled: true }));
    const state = readClariceEnvioEnabledState(dir, collector());
    assert.equal(state.fileAbsent, undefined);
    assert.deepEqual(state, { enabled: true, updatedAt: null });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("readClariceEnvioEnabledState — arquivo PRESENTE e inválido é PAUSADO + avisa (divergência 2)", () => {
  const CASES: Array<{ label: string; contents: string; why: string }> = [
    { label: "corrompido", contents: "{ isso não é json", why: "JSON inválido (escrita interrompida no meio)" },
    { label: "vazio", contents: "", why: "arquivo de 0 byte (truncado por sync/crash)" },
    { label: "sem-campo", contents: JSON.stringify({ updatedAt: "2026-08-11T22:00:00.000Z" }), why: "campo 'enabled' faltando" },
    { label: "tipo-errado", contents: JSON.stringify({ enabled: "sim" }), why: "'enabled' string em vez de boolean" },
    { label: "null", contents: "null", why: "JSON válido mas não é objeto" },
    { label: "array", contents: JSON.stringify([{ enabled: true }]), why: "JSON válido mas shape errado" },
  ];

  for (const { label, contents, why } of CASES) {
    it(`${label} (${why}) -> {enabled:false, updatedAt:null}, nunca lança`, () => {
      const dir = rootWithStateFile(label, contents);
      const c = collector();
      assert.doesNotThrow(() => readClariceEnvioEnabledState(dir, c));
      assert.deepEqual(readClariceEnvioEnabledState(dir, c), { enabled: false, updatedAt: null });
      assert.equal(isClariceEnvioEnabled(dir, c), false);
      rmSync(dir, { recursive: true, force: true });
    });

    it(`${label} -> AVISA (pausa que o editor não pediu nunca é silenciosa)`, () => {
      const dir = rootWithStateFile(label, contents);
      const c = collector();
      readClariceEnvioEnabledState(dir, c);
      assert.equal(c.warnings.length, 1, `esperava exatamente 1 aviso, veio: ${JSON.stringify(c.warnings)}`);
      assert.match(c.warnings[0], /clarice-envio-enabled/);
      assert.match(c.warnings[0], /PAUSADO/);
      rmSync(dir, { recursive: true, force: true });
    });
  }

  it("inválido NÃO cai no default de ausente — os dois estados são distintos de propósito", () => {
    const invalid = rootWithStateFile("distincao", "{{{");
    const absent = mkdtempSync(join(tmpdir(), "clarice-envio-enabled-distincao-absent-"));
    const c = collector();
    assert.equal(isClariceEnvioEnabled(invalid, c), false, "presente-e-inválido => PAUSADO");
    assert.equal(isClariceEnvioEnabled(absent, c), true, "ausente => LIGADO");
    rmSync(invalid, { recursive: true, force: true });
    rmSync(absent, { recursive: true, force: true });
  });
});

/** #10105 — proveniência fixa (sem depender do hostname/env da máquina que roda a suíte). */
const AUDIT = { machine: "maquina-teste", sessionId: null, reason: "teste" };

describe("setClariceEnvioEnabled — escrita (now injetado, path dedicado)", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "clarice-envio-enabled-set-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("setClariceEnvioEnabled(false) persiste a pausa e a leitura reflete", () => {
    const written = setClariceEnvioEnabled(root, false, { now: () => new Date("2026-08-11T22:00:00.000Z"), ...AUDIT });
    assert.deepEqual(written, { enabled: false, updatedAt: "2026-08-11T22:00:00.000Z", ...AUDIT });
    assert.deepEqual(readClariceEnvioEnabledState(root, collector()), {
      enabled: false,
      updatedAt: "2026-08-11T22:00:00.000Z",
      ...AUDIT,
    });
    assert.equal(isClariceEnvioEnabled(root, collector()), false);
  });

  it("setClariceEnvioEnabled(true) religa e atualiza updatedAt", () => {
    const written = setClariceEnvioEnabled(root, true, { now: () => new Date("2026-08-12T09:30:00.000Z"), ...AUDIT });
    assert.deepEqual(written, { enabled: true, updatedAt: "2026-08-12T09:30:00.000Z", ...AUDIT });
    assert.equal(isClariceEnvioEnabled(root, collector()), true);
  });

  it("cria data/ quando ainda não existe (root fresco, sem junction montada)", () => {
    const fresh = mkdtempSync(join(tmpdir(), "clarice-envio-enabled-fresh-"));
    setClariceEnvioEnabled(fresh, false, { now: () => new Date("2026-08-11T23:00:00.000Z"), ...AUDIT });
    const raw = JSON.parse(readFileSync(resolve(fresh, "data", "clarice-envio-enabled.json"), "utf8"));
    assert.deepEqual(raw, { enabled: false, updatedAt: "2026-08-11T23:00:00.000Z", ...AUDIT });
    rmSync(fresh, { recursive: true, force: true });
  });

  it("nunca sobrescreve outro arquivo sob data/ — path dedicado, e em particular NÃO é o do clarice-novos", () => {
    const novos = resolve(root, "data", "clarice-novos-enabled.json");
    writeFileSync(novos, JSON.stringify({ enabled: false, updatedAt: null }), "utf8");
    setClariceEnvioEnabled(root, true, { now: () => new Date("2026-08-12T10:00:00.000Z") });
    assert.deepEqual(
      JSON.parse(readFileSync(novos, "utf8")),
      { enabled: false, updatedAt: null },
      "as duas automações têm defaults OPOSTOS — compartilhar arquivo pausaria/ligaria a errada",
    );
    assert.equal(isClariceEnvioEnabled(root, collector()), true);
  });
});

// #10105 — a reativação de 01/10/2026 não deixou rastro: o arquivo só tinha
// {enabled, updatedAt} e nada ia pro run-log.
describe("setClariceEnvioEnabled — rastro da troca (#10105)", () => {
  it("grava machine/sessionId/reason no arquivo e emite evento no run-log.jsonl", () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-envio-enabled-audit-"));
    setClariceEnvioEnabled(root, true, {
      now: () => new Date("2026-10-01T15:31:21.000Z"),
      machine: "neo",
      sessionId: "sess-1",
      reason: "religando por decisão do editor em #8099",
    });
    const raw = JSON.parse(readFileSync(resolve(root, "data", "clarice-envio-enabled.json"), "utf8"));
    assert.equal(raw.machine, "neo");
    assert.equal(raw.sessionId, "sess-1");
    assert.equal(raw.reason, "religando por decisão do editor em #8099");
    const lines = readFileSync(resolve(root, "data", "run-log.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const ev = JSON.parse(lines[0]);
    assert.equal(ev.agent, "clarice-envio-enabled");
    assert.equal(ev.level, "warn", "religar envio real é warn");
    assert.equal(ev.details.enabled, true);
    assert.equal(ev.details.machine, "neo");
    assert.equal(ev.details.reason, "religando por decisão do editor em #8099");
    rmSync(root, { recursive: true, force: true });
  });

  it("sessionId vem de CLAUDE_CODE_SESSION_ID quando não injetado", () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-envio-enabled-audit-env-"));
    const w = setClariceEnvioEnabled(root, false, { reason: "x", machine: "m", env: { CLAUDE_CODE_SESSION_ID: "env-sess" }, logRunEvent: false });
    assert.equal(w.sessionId, "env-sess");
    rmSync(root, { recursive: true, force: true });
  });
});
