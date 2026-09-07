/**
 * test/ads-rolling-cac-cli-7577.test.ts (#7577)
 *
 * A CLI é o que a task agendada `relatorio-diario-teste-2608` roda toda manhã,
 * desassistida. O review da PR #7586 apontou que ela tinha zero cobertura: os
 * 24 testes da janela exercitam só a lib pura, e a camada que decide exit code,
 * resolve `--ate` e RECUSA calcular sobre CSV quebrado passava inteira sem
 * teste. É justamente a camada onde uma falha vira número errado no relatório
 * em vez de stack trace.
 *
 * `main()` é chamada direto (não por subprocesso) para que o exit code seja um
 * valor de retorno testável, em vez de um `process.exit` que derrubaria o
 * runner.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../scripts/ads-rolling-cac.ts";

const HEADER =
  "canal,data_apuracao,gasto_acumulado,cadastros_acumulado,custo_por_cadastro,leitores_acumulado,fonte\n";

function csvFixture(linhas: string[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "rolling-cac-7577-"));
  const path = join(dir, "clicks.csv");
  writeFileSync(path, HEADER + linhas.map((l) => `${l}\n`).join(""), "utf8");
  return { dir, path };
}

/** Silencia stdout/stderr da CLI e devolve o que ela imprimiu. */
function capturar<T>(fn: () => T): { valor: T; out: string } {
  const out: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.warn = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => out.push(a.join(" "));
  try {
    return { valor: fn(), out: out.join("\n") };
  } finally {
    Object.assign(console, orig);
  }
}

describe("#7577 — CLI ads-rolling-cac: exit codes", () => {
  it("CSV ausente sai 1, não 0", () => {
    const { valor } = capturar(() => main(["--csv", join(tmpdir(), "nao-existe-7577.csv")]));
    assert.equal(valor, 1);
  });

  it("REGRESSÃO: CSV com erro de parsing RECUSA calcular", () => {
    // É a propriedade de segurança que a própria docstring da CLI nomeia: o
    // parser engole linhas em silêncio quando a quebra de linha não bate
    // (CRLF vs LF, incidente de 07/09), e calcular sobre um CSV meio-lido
    // produziria uma janela silenciosamente incompleta.
    const { dir, path } = csvFixture(["Google Ads (teste 2608),2026-09-04,não-é-número,10,,0,painel"]);
    try {
      const { valor, out } = capturar(() => main(["--csv", path, "--ate", "2026-09-04"]));
      assert.equal(valor, 1);
      assert.match(out, /não é seguro calcular/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dias não-numérico sai 1 com mensagem, em vez de estourar RangeError", () => {
    // `Number("abc")` é NaN e atravessa `shiftDate` até `toISOString` lançar.
    const { dir, path } = csvFixture(["Google Ads (teste 2608),2026-09-04,190,22,,0,painel"]);
    try {
      const { valor, out } = capturar(() => main(["--csv", path, "--dias", "abc"]));
      assert.equal(valor, 1);
      assert.match(out, /--dias/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--ate em formato inválido sai 1 — comparação de string devolveria janela torta, não erro", () => {
    const { dir, path } = csvFixture(["Google Ads (teste 2608),2026-09-04,190,22,,0,painel"]);
    try {
      const { valor, out } = capturar(() => main(["--csv", path, "--ate", "04/09/2026"]));
      assert.equal(valor, 1);
      assert.match(out, /--ate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("braço não-comparável NÃO é erro — sai 0 e explica na saída", () => {
    const { dir, path } = csvFixture([
      "Microsoft Ads (teste 2608),2026-09-03,1.34,0,,0,painel",
      "Microsoft Ads (teste 2608),2026-09-04,1.34,0,,0,painel",
    ]);
    try {
      const { valor, out } = capturar(() => main(["--csv", path, "--ate", "2026-09-04"]));
      assert.equal(valor, 0, "amostra baixa é resultado, não falha de processo");
      assert.match(out, /fora da comparação/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#7577 — CLI ads-rolling-cac: saída", () => {
  it("--json traz comparacaoPossivel no topo, sem exigir re-derivação", () => {
    const { dir, path } = csvFixture([
      "Google Ads (teste 2608),2026-09-01,100,10,,0,painel",
      "Google Ads (teste 2608),2026-09-04,190,22,,0,painel",
    ]);
    try {
      const { valor, out } = capturar(() => main(["--csv", path, "--ate", "2026-09-04", "--json"]));
      assert.equal(valor, 0);
      const j = JSON.parse(out);
      assert.equal(j.ate, "2026-09-04");
      assert.equal(j.dias, 3);
      assert.equal(typeof j.comparacaoPossivel, "boolean");
      assert.equal(j.resultados[0].gastoJanela, 90, "190 − 100");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("null nunca é impresso como 0 na coluna de cadastros", () => {
    // "não medido" e "zero cadastros" pedem ações opostas do editor, e num
    // alinhamento à direita os dois se leem igual.
    const { dir, path } = csvFixture([
      "Google Ads (teste 2608),2026-09-03,100,,,0,painel",
      "Google Ads (teste 2608),2026-09-04,190,,,0,painel",
    ]);
    try {
      const { valor, out } = capturar(() => main(["--csv", path, "--ate", "2026-09-04"]));
      assert.equal(valor, 0);
      const linha = out.split("\n").find((l) => l.startsWith("Google Ads")) ?? "";
      assert.match(linha, /—/, "coluna sem dado precisa sair como travessão, nunca como 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
