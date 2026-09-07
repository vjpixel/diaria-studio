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

/**
 * Fixture hermética: CSV, `run-state.json` e `edicoes.jsonl` próprios.
 *
 * Sem os três, o guard de cobertura leria a lista de braços de PRODUÇÃO e todo
 * teste falharia por um braço que a fixture nem pretende ter. `bracos` permite
 * declarar um braço registrado SEM linha no CSV — que é justamente o caso do
 * incidente CRLF.
 */
function csvFixture(linhas: string[], bracos?: string[]): { dir: string; args: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "rolling-cac-7577-"));
  const path = join(dir, "clicks.csv");
  writeFileSync(path, HEADER + linhas.map((l) => `${l}\n`).join(""), "utf8");
  const runState = join(dir, "run-state.json");
  const derivados = [...new Set(linhas.map((l) => l.split(",")[0]))];
  writeFileSync(runState, JSON.stringify({ bracos: bracos ?? derivados }), "utf8");
  const edicoes = join(dir, "edicoes.jsonl");
  writeFileSync(edicoes, "", "utf8");
  return { dir, args: ["--csv", path, "--run-state", runState, "--edicoes", edicoes] };
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
    const { dir, args } = csvFixture(["Google Ads (teste 2608),2026-09-04,não-é-número,10,,0,painel"]);
    try {
      const { valor, out } = capturar(() => main([...args, "--ate", "2026-09-04"]));
      assert.equal(valor, 1);
      assert.match(out, /não é seguro calcular/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--dias não-numérico sai 1 com mensagem, em vez de estourar RangeError", () => {
    // `Number("abc")` é NaN e atravessa `shiftDate` até `toISOString` lançar.
    const { dir, args } = csvFixture(["Google Ads (teste 2608),2026-09-04,190,22,,0,painel"]);
    try {
      const { valor, out } = capturar(() => main([...args, "--dias", "abc"]));
      assert.equal(valor, 1);
      assert.match(out, /--dias/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--ate em formato inválido sai 1 — comparação de string devolveria janela torta, não erro", () => {
    const { dir, args } = csvFixture(["Google Ads (teste 2608),2026-09-04,190,22,,0,painel"]);
    try {
      const { valor, out } = capturar(() => main([...args, "--ate", "04/09/2026"]));
      assert.equal(valor, 1);
      assert.match(out, /--ate/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("braço não-comparável NÃO é erro — sai 0 e explica na saída", () => {
    const { dir, args } = csvFixture([
      "Microsoft Ads (teste 2608),2026-09-03,1.34,0,,0,painel",
      "Microsoft Ads (teste 2608),2026-09-04,1.34,0,,0,painel",
    ]);
    try {
      const { valor, out } = capturar(() => main([...args, "--ate", "2026-09-04"]));
      assert.equal(valor, 0, "amostra baixa é resultado, não falha de processo");
      assert.match(out, /fora da comparação/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("#7577 — CLI ads-rolling-cac: saída", () => {
  it("--json traz comparacaoPossivel no topo, sem exigir re-derivação", () => {
    const { dir, args } = csvFixture([
      "Google Ads (teste 2608),2026-09-01,100,10,,0,painel",
      "Google Ads (teste 2608),2026-09-04,190,22,,0,painel",
    ]);
    try {
      const { valor, out } = capturar(() => main([...args, "--ate", "2026-09-04", "--json"]));
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
    const { dir, args } = csvFixture([
      "Google Ads (teste 2608),2026-09-03,100,,,0,painel",
      "Google Ads (teste 2608),2026-09-04,190,,,0,painel",
    ]);
    try {
      const { valor, out } = capturar(() => main([...args, "--ate", "2026-09-04"]));
      assert.equal(valor, 0);
      const linha = out.split("\n").find((l) => l.startsWith("Google Ads")) ?? "";
      assert.match(linha, /—/, "coluna sem dado precisa sair como travessão, nunca como 0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Achado P1 do comment-analyzer na PR #7586: o comentário afirmava que o guard
 * de `errors.length > 0` protegia contra o incidente CRLF de 07/09/2026 — e
 * não protege. Naquele incidente as linhas anexadas com LF num arquivo CRLF
 * sumiram do parse com `errors[]` VAZIO: a última coluna é texto livre entre
 * aspas, e uma quebra solta dentro de campo citado é conteúdo, então as linhas
 * seguintes são engolidas e nunca chegam à validação.
 *
 * O que dá para checar é COBERTURA do último dia. Este é o teste dessa guarda.
 */
describe("#7577 — cobertura do último dia pega a linha engolida que o parser não acusa", () => {
  it("braço sem linha no último dia sai 1, mesmo com o parse limpo", () => {
    const { dir, args } = csvFixture([
      "Google Ads (teste 2608),2026-09-03,100,10,,0,painel",
      "Google Ads (teste 2608),2026-09-04,190,22,,0,painel",
      "Meta Ads (teste 2608),2026-09-03,50,5,,0,painel",
      // Meta SEM linha em 04 — foi o formato exato do incidente CRLF.
    ]);
    try {
      const { valor, out } = capturar(() => main([...args, "--ate", "2026-09-04"]));
      assert.equal(valor, 1);
      assert.match(out, /sem linha de apuração em 2026-09-04/);
      assert.match(out, /Meta Ads/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("todos os braços com linha no último dia passa normalmente", () => {
    const { dir, args } = csvFixture([
      "Google Ads (teste 2608),2026-09-04,190,22,,0,painel",
      "Meta Ads (teste 2608),2026-09-04,90,12,,0,painel",
    ]);
    try {
      const { valor } = capturar(() => main([...args, "--ate", "2026-09-04"]));
      assert.equal(valor, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
