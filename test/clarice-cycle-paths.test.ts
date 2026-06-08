/**
 * test/clarice-cycle-paths.test.ts (#1961)
 *
 * Trava o namespacing por **ciclo de envio** `{conteúdo}-{envio}` (ex: 2605-06 =
 * conteúdo de maio enviado em junho) dos artefatos por-ciclo Clarice/Brevo.
 *
 * Antes (flat + prefixo de mês, #1960) o T1-W1 de um mês sobrescrevia o do
 * outro, e "2604 vs 2605" confundia (nome da campanha usa o mês do CONTEÚDO,
 * o envio é no mês SEGUINTE). O rótulo `{conteúdo}-{envio}` carrega os dois.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { sep, join } from "node:path";
import { tmpdir } from "node:os";
import {
  isValidCycle,
  clariceCycleDir,
  clariceWavesDir,
  clariceBaseFile,
  ensureDir,
  parseCycleArg,
  requireCycleArg,
  CLARICE_BASE,
} from "../scripts/lib/clarice-paths.ts";
import { parseArgs } from "../scripts/clarice-import-waves.ts";

const norm = (p: string): string => p.split(sep).join("/");

describe("clarice cycle paths (#1961)", () => {
  it("isValidCycle aceita {conteúdo}-{envio} e rejeita o resto (forma)", () => {
    assert.equal(isValidCycle("2605-06"), true);
    assert.equal(isValidCycle("2604-05"), true);
    assert.equal(isValidCycle("2606"), false); // só mês — formato antigo
    assert.equal(isValidCycle("2605"), false);
    assert.equal(isValidCycle("2605-6"), false); // envio precisa de 2 dígitos
    assert.equal(isValidCycle("260-506"), false);
    assert.equal(isValidCycle("lixo"), false);
    assert.equal(isValidCycle(""), false);
    assert.equal(isValidCycle(undefined), false);
  });

  it("isValidCycle valida a SEMÂNTICA (mês 01-12 + envio = conteúdo+1)", () => {
    // mês impossível:
    assert.equal(isValidCycle("2605-13"), false);
    assert.equal(isValidCycle("2605-00"), false);
    assert.equal(isValidCycle("2600-01"), false); // conteúdo mês 00
    assert.equal(isValidCycle("2613-01"), false); // conteúdo mês 13
    // envio ≠ conteúdo+1 (o mislabel que a feature combate):
    assert.equal(isValidCycle("2605-07"), false); // pulou junho
    assert.equal(isValidCycle("2605-05"), false); // mesmo mês
    assert.equal(isValidCycle("2605-04"), false); // anterior
    // rollover dez→jan:
    assert.equal(isValidCycle("2612-01"), true); // dezembro → janeiro
    assert.equal(isValidCycle("2601-02"), true);
  });

  it("clariceCycleDir aponta pro subdir do ciclo, sob CLARICE_BASE", () => {
    const dir = clariceCycleDir("2605-06");
    // Estrutural (não tautológico): é CLARICE_BASE + sep + ciclo, não outra raiz.
    assert.equal(dir, join(CLARICE_BASE, "2605-06"));
    assert.ok(dir.startsWith(CLARICE_BASE + sep));
    assert.ok(norm(dir).endsWith("clarice-subscribers/2605-06"));
  });

  it("clariceCycleDir explode em ciclo inválido (fail-loud, não grava no lugar errado)", () => {
    assert.throws(() => clariceCycleDir("2606"), /ciclo inválido/);
    assert.throws(() => clariceCycleDir("2605-07"), /ciclo inválido/); // gap de mês
    assert.throws(() => clariceWavesDir("lixo"), /ciclo inválido/);
  });

  it("ensureDir cria o diretório (recursivo) e devolve o path", () => {
    const root = mkdtempSync(join(tmpdir(), "clarice-paths-"));
    try {
      const nested = join(root, "2605-06", "waves");
      const ret = ensureDir(nested);
      assert.equal(ret, nested);
      assert.ok(existsSync(nested));
      ensureDir(nested); // idempotente — não lança na 2ª vez
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("requireCycleArg devolve o ciclo válido (happy-path, sem exit)", () => {
    assert.equal(requireCycleArg(["--cycle", "2605-06"]), "2605-06");
  });

  it("clariceWavesDir = {ciclo}/waves", () => {
    assert.ok(norm(clariceWavesDir("2605-06")).endsWith("clarice-subscribers/2605-06/waves"));
    // Junho (maio→junho) não colide com maio (abril→maio):
    assert.notEqual(clariceWavesDir("2605-06"), clariceWavesDir("2604-05"));
  });

  it("clariceBaseFile fica no root (não por-ciclo): stripe, excluded, tiers", () => {
    assert.ok(norm(clariceBaseFile("brevo-import-t01-assinantes-ativos.csv")).endsWith("clarice-subscribers/brevo-import-t01-assinantes-ativos.csv"));
    assert.ok(norm(clariceBaseFile("brevo-import-excluded.csv")).endsWith("clarice-subscribers/brevo-import-excluded.csv"));
  });

  it("parseCycleArg: extrai --cycle, vazio quando ausente/inválido (main aborta)", () => {
    assert.equal(parseCycleArg(["--cycle", "2605-06"]), "2605-06");
    assert.equal(parseCycleArg([]), "");
    assert.equal(parseCycleArg(["--cycle", "2606"]), ""); // formato antigo → inválido
    assert.equal(parseCycleArg(["--cycle", "lixo"]), "");
    // getArg trata "--cycle" seguido de outra flag como ausente (não engole "--execute"):
    assert.equal(parseCycleArg(["--cycle", "--execute"]), "");
  });

  it("import-waves parseArgs não inventa default de ciclo", () => {
    assert.equal(parseArgs(["--cycle", "2605-06"]).cycle, "2605-06");
    assert.equal(parseArgs([]).cycle, ""); // ausente → vazio (main aborta)
    assert.equal(parseArgs(["--cycle", "2606"]).cycle, ""); // inválido → vazio
  });
});
