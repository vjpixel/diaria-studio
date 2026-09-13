/**
 * test/github-awesome-list-entry.test.ts (#8068)
 *
 * `scripts/lib/github-awesome-list-entry.ts` é puro (sem I/O) e
 * `scripts/gen-github-awesome-list-entry.ts::run` só formata texto — nenhuma
 * chamada de rede, nenhum fork/PR real. Cobre: --list enumera os 4 alvos
 * conhecidos; --target válido produz a linha de entrada + guidance; --target
 * desconhecido e ausência de --target lançam erro explícito (nunca
 * degradam silenciosamente pra um alvo default).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AWESOME_LIST_TARGETS,
  buildAwesomeListEntryLine,
  buildAwesomeListEntryGuidance,
  findAwesomeListTarget,
  DIARIA_NEWSLETTER_META,
} from "../scripts/lib/github-awesome-list-entry.ts";
import { run } from "../scripts/gen-github-awesome-list-entry.ts";

describe("github-awesome-list-entry (lib pura)", () => {
  it("conhece os 4 alvos documentados em docs/seo-backlinks-plan.md", () => {
    const keys = AWESOME_LIST_TARGETS.map((t) => t.key).sort();
    assert.deepEqual(keys, [
      "italojs",
      "machinelearningbr",
      "randalmaia",
      "wendelmarques",
    ]);
  });

  it("findAwesomeListTarget resolve por key e retorna undefined pra key desconhecida", () => {
    assert.equal(findAwesomeListTarget("randalmaia")?.name, "randalmaia/awesome-newsletters");
    assert.equal(findAwesomeListTarget("nao-existe"), undefined);
  });

  it("buildAwesomeListEntryLine monta o formato Markdown padrão de lista awesome-*", () => {
    const line = buildAwesomeListEntryLine(DIARIA_NEWSLETTER_META);
    assert.equal(
      line,
      "- [diar.ia.br](https://diar.ia.br) — Newsletter diária em português sobre inteligência artificial — curadoria, lançamentos e análise, com foco no Brasil.",
    );
  });

  it("buildAwesomeListEntryGuidance inclui repo, seção e a linha de entrada", () => {
    const target = findAwesomeListTarget("machinelearningbr")!;
    const guidance = buildAwesomeListEntryGuidance(target);
    assert.match(guidance, /MachineLearningBR\/recursos/);
    assert.match(guidance, /github\.com\/MachineLearningBR\/recursos/);
    assert.match(guidance, /- \[diar\.ia\.br\]\(https:\/\/diar\.ia\.br\)/);
    assert.match(guidance, /ação HUMANA/);
  });
});

describe("gen-github-awesome-list-entry CLI (run puro)", () => {
  it("--list enumera os 4 alvos com key, nome e URL", () => {
    const out = run(["--list"]);
    assert.match(out, /^key\tname\trepoUrl/);
    assert.match(out, /randalmaia\trandalmaia\/awesome-newsletters\thttps:\/\/github\.com\/randalmaia\/awesome-newsletters/);
    assert.equal(out.split("\n").length, AWESOME_LIST_TARGETS.length + 1);
  });

  it("--target válido retorna a guidance completa", () => {
    const out = run(["--target", "italojs"]);
    assert.match(out, /italojs\/awesome-machine-learning-portugues/);
  });

  it("--target desconhecido lança erro explícito, nunca degrada pra um alvo default", () => {
    assert.throws(() => run(["--target", "nao-existe"]), /desconhecido/);
  });

  it("ausência de --target (e sem --list) lança erro explícito", () => {
    assert.throws(() => run([]), /uso: npx tsx/);
  });
});
