/**
 * test/issue-decisions.test.ts (#5373)
 *
 * Regressão pura pra `scripts/lib/issue-decisions.ts` — nenhum teste aqui
 * chama `gh` de verdade (as funções puras recebem os bodies já buscados).
 * Cobre a lista pedida pela issue:
 *
 *   - parse de marcador válido
 *   - marcador ausente (retorna null)
 *   - múltiplos marcadores (pega o mais recente por decided_at)
 *   - marcador malformado (base64/JSON inválido — ignora, não lança)
 *   - lista de comentários vazia
 *   - payload contendo a sequência literal "-->" (achado do fleet review do
 *     PR #5375 — a versão original embutia JSON cru entre os delimitadores,
 *     e um `pergunta`/`resposta` contendo "-->" truncava o parse; o payload
 *     agora vai em base64, que nunca contém essa sequência)
 *
 * Espelha a mesma cobertura para o marcador `bloqueio-execucao` (item 5 do
 * #5373) — happy path, marcador ausente, malformado, múltiplos marcadores
 * pega o mais recente, "-->" no payload, e não-confusão entre os dois tipos
 * de marcador quando ambos aparecem no mesmo conjunto de comentários.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDecisionMarker,
  parseDecisionMarkers,
  latestDecisionFor,
  formatExecutionBlockMarker,
  parseExecutionBlockMarkers,
  latestExecutionBlockFor,
  type IssueDecision,
  type ExecutionBlock,
} from "../scripts/lib/issue-decisions.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function decision(overrides: Partial<IssueDecision> = {}): IssueDecision {
  return {
    decided_at: "2026-08-14T05:38:00Z",
    pergunta: "Consertar ou aposentar GA4?",
    resposta: "CONSERTAR, não aposentar",
    sessao: "continuo",
    ...overrides,
  };
}

function executionBlock(overrides: Partial<ExecutionBlock> = {}): ExecutionBlock {
  return {
    recorded_at: "2026-08-15T16:00:00Z",
    motivo: "falta acesso a painel GA4/GTM",
    sessao: "continuo",
    ...overrides,
  };
}

describe("formatDecisionMarker + parseDecisionMarkers round-trip", () => {
  it("marcador formatado é reconhecido pelo parser", () => {
    const d = decision();
    const marker = formatDecisionMarker(d);
    assert.match(marker, /^<!-- decisao-editor: [A-Za-z0-9+/=]+ -->$/);
    const parsed = parseDecisionMarkers([`Decisão do editor: CONSERTAR.\n\n${marker}`]);
    assert.deepEqual(parsed, [d]);
  });

  it("payload contendo a sequência literal '-->' não trunca o parse (#5375)", () => {
    const d = decision({
      pergunta: 'Trocar o comentário <!-- x --> por span?',
      resposta: 'Sim, o comentário <!-- x --> deve virar <span>.',
    });
    const marker = formatDecisionMarker(d);
    const parsed = parseDecisionMarkers([marker]);
    assert.deepEqual(parsed, [d]);
  });
});

describe("parseDecisionMarkers", () => {
  it("marcador ausente retorna lista vazia", () => {
    assert.deepEqual(parseDecisionMarkers(["comentário qualquer sem marcador"]), []);
  });

  it("lista de comentários vazia retorna lista vazia", () => {
    assert.deepEqual(parseDecisionMarkers([]), []);
  });

  it("marcador malformado (JSON inválido) é ignorado, não lança", () => {
    const bad = "<!-- decisao-editor: {not valid json} -->";
    assert.doesNotThrow(() => parseDecisionMarkers([bad]));
    assert.deepEqual(parseDecisionMarkers([bad]), []);
  });

  it("marcador com campo faltando é ignorado", () => {
    const incomplete = '<!-- decisao-editor: {"decided_at":"2026-08-14T00:00:00Z"} -->';
    assert.deepEqual(parseDecisionMarkers([incomplete]), []);
  });

  it("extrai múltiplos marcadores válidos de múltiplos comentários", () => {
    const d1 = decision({ decided_at: "2026-08-12T20:02:00Z" });
    const d2 = decision({ decided_at: "2026-08-14T14:34:00Z" });
    const bodies = [formatDecisionMarker(d1), formatDecisionMarker(d2)];
    assert.deepEqual(parseDecisionMarkers(bodies), [d1, d2]);
  });
});

describe("latestDecisionFor", () => {
  it("nenhum marcador -> null", () => {
    assert.equal(latestDecisionFor(["sem marcador aqui"]), null);
  });

  it("lista vazia -> null", () => {
    assert.equal(latestDecisionFor([]), null);
  });

  it("múltiplos marcadores -> devolve o mais recente por decided_at", () => {
    const older = decision({ decided_at: "2026-08-12T20:02:00Z", resposta: "resposta antiga" });
    const newer = decision({ decided_at: "2026-08-15T16:00:00Z", resposta: "resposta atual" });
    const middle = decision({ decided_at: "2026-08-14T14:34:00Z", resposta: "resposta do meio" });
    const bodies = [
      formatDecisionMarker(older),
      formatDecisionMarker(newer),
      formatDecisionMarker(middle),
    ];
    assert.deepEqual(latestDecisionFor(bodies), newer);
  });

  it("mistura de marcador válido e malformado -> ignora o malformado, acha o válido", () => {
    const valid = decision();
    const bodies = ["<!-- decisao-editor: {broken -->", formatDecisionMarker(valid)];
    assert.deepEqual(latestDecisionFor(bodies), valid);
  });
});

describe("formatExecutionBlockMarker + parseExecutionBlockMarkers round-trip (#5373 item 5)", () => {
  it("marcador formatado é reconhecido pelo parser", () => {
    const b = executionBlock();
    const marker = formatExecutionBlockMarker(b);
    assert.match(marker, /^<!-- bloqueio-execucao: [A-Za-z0-9+/=]+ -->$/);
    const parsed = parseExecutionBlockMarkers([`Bloqueio de execução registrado.\n\n${marker}`]);
    assert.deepEqual(parsed, [b]);
  });

  it("payload contendo a sequência literal '-->' não trunca o parse", () => {
    const b = executionBlock({
      motivo: 'Guard de publicação (ver <!-- comentário --> no código) proíbe envio real.',
    });
    const marker = formatExecutionBlockMarker(b);
    const parsed = parseExecutionBlockMarkers([marker]);
    assert.deepEqual(parsed, [b]);
  });
});

describe("parseExecutionBlockMarkers", () => {
  it("marcador ausente retorna lista vazia", () => {
    assert.deepEqual(parseExecutionBlockMarkers(["comentário qualquer sem marcador"]), []);
  });

  it("lista de comentários vazia retorna lista vazia", () => {
    assert.deepEqual(parseExecutionBlockMarkers([]), []);
  });

  it("marcador malformado (JSON inválido) é ignorado, não lança", () => {
    const bad = "<!-- bloqueio-execucao: {not valid json} -->";
    assert.doesNotThrow(() => parseExecutionBlockMarkers([bad]));
    assert.deepEqual(parseExecutionBlockMarkers([bad]), []);
  });

  it("marcador com campo faltando é ignorado", () => {
    const incomplete = '<!-- bloqueio-execucao: {"recorded_at":"2026-08-15T00:00:00Z"} -->';
    assert.deepEqual(parseExecutionBlockMarkers([incomplete]), []);
  });

  it("marcador com motivo vazio é ignorado", () => {
    const encoded = Buffer.from(
      JSON.stringify({ recorded_at: "2026-08-15T00:00:00Z", motivo: "", sessao: "overnight" }),
      "utf8",
    ).toString("base64");
    assert.deepEqual(
      parseExecutionBlockMarkers([`<!-- bloqueio-execucao: ${encoded} -->`]),
      [],
    );
  });

  it("extrai múltiplos marcadores válidos de múltiplos comentários", () => {
    const b1 = executionBlock({ recorded_at: "2026-08-14T05:38:00Z" });
    const b2 = executionBlock({ recorded_at: "2026-08-15T16:00:00Z" });
    const bodies = [formatExecutionBlockMarker(b1), formatExecutionBlockMarker(b2)];
    assert.deepEqual(parseExecutionBlockMarkers(bodies), [b1, b2]);
  });

  it("não confunde marcador de decisão com marcador de bloqueio-de-execução", () => {
    const d = decision();
    const bodies = [formatDecisionMarker(d)];
    assert.deepEqual(parseExecutionBlockMarkers(bodies), []);
    assert.deepEqual(parseDecisionMarkers(bodies), [d]);
  });
});

describe("latestExecutionBlockFor", () => {
  it("nenhum marcador -> null", () => {
    assert.equal(latestExecutionBlockFor(["sem marcador aqui"]), null);
  });

  it("lista vazia -> null", () => {
    assert.equal(latestExecutionBlockFor([]), null);
  });

  it("múltiplos marcadores -> devolve o mais recente por recorded_at", () => {
    const older = executionBlock({ recorded_at: "2026-08-12T20:02:00Z", motivo: "motivo antigo" });
    const newer = executionBlock({ recorded_at: "2026-08-15T16:00:00Z", motivo: "motivo atual" });
    const middle = executionBlock({ recorded_at: "2026-08-14T14:34:00Z", motivo: "motivo do meio" });
    const bodies = [
      formatExecutionBlockMarker(older),
      formatExecutionBlockMarker(newer),
      formatExecutionBlockMarker(middle),
    ];
    assert.deepEqual(latestExecutionBlockFor(bodies), newer);
  });

  it("mistura de marcador válido e malformado -> ignora o malformado, acha o válido", () => {
    const valid = executionBlock();
    const bodies = ["<!-- bloqueio-execucao: {broken -->", formatExecutionBlockMarker(valid)];
    assert.deepEqual(latestExecutionBlockFor(bodies), valid);
  });
});

describe("CLI wrapper (#5535 — main() precisa rodar de fato)", () => {
  // Regressão pra um bug real: o wrapper detectava execução direta via
  // `import.meta.url === \`file://${process.argv[1]}\`` — comparação de
  // string que nunca bate no Windows (drive letter + separador divergem
  // entre o path cru de process.argv[1] e o file:// URL), mesma classe do
  // #5480. `main()` nunca rodava, e o CLI retornava stdout vazio sempre,
  // silenciosamente, mascarando decisões/bloqueios de execução já
  // registrados. Os testes acima cobrem só as funções puras (que nunca
  // dependeram do wrapper) — nenhum exercitava o `isDirectRun`/`main()` em
  // si, por isso o bug passou despercebido. Este teste falha em qualquer
  // plataforma onde `main()` não executa: sem `--issue`, main() escreve o
  // "uso: ..." em stderr e sai com exit 1 — se `isDirectRun` for false, o
  // processo sai limpo (exit 0, stdout/stderr vazios) porque nada roda.
  it("sem --issue: sai com exit 1 e imprime uso em stderr (prova que main() rodou)", () => {
    const result = spawnSync("npx", ["tsx", "scripts/lib/issue-decisions.ts"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /uso: npx tsx scripts\/lib\/issue-decisions\.ts --issue N/);
  });

  it("--issue inválido (não-numérico): sai com exit 1 e imprime erro em stderr", () => {
    const result = spawnSync("npx", ["tsx", "scripts/lib/issue-decisions.ts", "--issue", "abc"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--issue inválido: abc/);
  });
});
