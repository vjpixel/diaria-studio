/**
 * test/continuo-cadence-prose-drift-6928.test.ts (#6928)
 *
 * Guard de regressão contra a classe de erro do #6928: cadências dos 2 crons
 * do contínuo (tick `hermes-diaria-continuo`, job `5d791ef6fc2c`; review de
 * PR `continuo-pr-review.sh`, job `3330b108a5b2`) escritas como números na
 * prosa do repo — e uma conclusão numérica (descompasso "12:1", espera
 * "~24h") derivada desses números errados. Medição de 01/09/2026 na issue:
 * a prosa registrava o tick 2× mais lento e o review 2× mais rápido do que
 * o real — nas duas direções.
 *
 * Por que um teste e não só editar a prosa: a prosa já tinha o aviso correto
 * no CLAUDE.md ("cadência/estado nunca se citam daqui nem de memória:
 * derivar com `hermes cron list --all`") e mesmo assim continuou sendo lida
 * como fonte — o aviso protege quem lê o CLAUDE.md, não quem lê o SKILL.md
 * ou o cabeçalho do script (a issue produziu um erro real de relato no dia).
 * `.hermes/cron/jobs.json` é estado de máquina, fora do repo — CI não
 * alcança (por isso a opção "drift-check vs jobs.json" da issue NÃO é este
 * teste). O que este teste tranca é a metade que dá: o repo para de AFFIRMAR
 * número de cadência — número que não está na prosa não pode ficar obsoleto
 * em silêncio.
 *
 * Regra: os tokens de cadência abaixo só podem aparecer em prosa de
 * `hermes/` DENTRO de aspas/backticks — como alegação nomeada-e-rejeitada
 * num registro de correção (padrão do changelog: "registrava X, corrigido
 * no #Y"). Ocorrência solta (afirmação direta) falha o teste.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const REPO_ROOT = join(import.meta.dirname, "..");

// Tokens que a prosa do repo já registrou errado (`~4h`, `every 240m`,
// `12:1`) ou que afirmam cadência dos crons do contínuo — nunca afirmação
// direta; a fonte canônica é `hermes cron list --all` (CLAUDE.md).
/**
 * Padrões por CLASSE, não por token literal (#6950 review, finding 2).
 *
 * A primeira versão listava as 6 strings exatas do incidente (`every 240m`,
 * `~4h`, `12:1`, ...). Isso pega a REVERSÃO daquele incidente e mais nada:
 * `a cada 90min` e `~6h` — afirmações idênticas em natureza, números
 * diferentes — passavam batido. Um guard que só reconhece o erro que já
 * aconteceu não impede o próximo; vira teste de regressão de uma linha
 * específica, não invariante de prosa.
 */
/** Abre aspas/crases opcionais entre o termo e o número — `every \`60m\`` é a
 *  MESMA afirmação que `every 60m` (ver `stripQuotedSpans` abaixo). */
const Q = "[`'\"]?";

/**
 * Padrões INEQUÍVOCOS: só aparecem em contexto de cadência de cron, então
 * valem sozinhos em qualquer linha.
 */
const FORBIDDEN_PATTERNS: RegExp[] = [
  new RegExp(`every\\s+${Q}\\d+\\s*m\\b`, "i"), // sintaxe de cron do Hermes
  /\b\d+:1(?!\d)/, // razão "12:1"/"2:1" — sem casar "12:15" (horário)
];

/**
 * Padrões AMBÍGUOS: a mesma forma aparece em prosa que não é cadência de
 * cron ("renovando a cada 3min" é lock, não tick). Só violam quando a linha
 * também traz uma palavra de contexto de cadência.
 *
 * Isto é o "extremo oposto" que o review do #6950 mandou evitar: generalizar
 * o padrão sem discriminar contexto transformaria o guard num acusador de
 * qualquer número com unidade de tempo no repo — barulho que treina quem lê
 * a ignorar o guard, que é como um guard morre sem ninguém remover.
 */
const AMBIGUOUS_PATTERNS: RegExp[] = [
  new RegExp(`a cada\\s+${Q}\\d+\\s*(?:min|h|hora)`, "i"),
  new RegExp(`~\\s*${Q}\\d+\\s*h\\b`, "i"),
];

/** Palavras que tornam a linha uma afirmação sobre cadência dos crons do contínuo. */
const CADENCE_CONTEXT = /\b(tick|cron|cont[ií]nuo|job|cad[êe]ncia|revis(?:or|ão|ao) de PR)\b/i;

/**
 * Remove trechos entre ASPAS DUPLAS — alegação citada/rejeitada é permitida
 * ("o comentário dizia \"every 240m\", que estava errado").
 *
 * **Backtick NÃO isenta mais (#6950 review, finding 3).** A versão anterior
 * também limpava `` `...` ``, e neste repo crase em volta de valor técnico é
 * o estilo NORMAL de escrita — então ``roda a cada `120min` `` (afirmação
 * presente, não citação histórica) passava pelo guard. O bypass não exigia
 * má-fé, exigia formatação comum, que é o pior tipo de bypass: quem escreve
 * não percebe que desarmou a checagem.
 *
 * Aspas duplas seguem isentas porque ali a intenção de CITAR é explícita —
 * é a convenção que o próprio changelog usa pra registrar valor errado sem
 * reafirmá-lo.
 */
function stripQuotedSpans(line: string): string {
  return line.replace(/"[^"]*"/g, "");
}

/** Decide se UMA linha afirma cadência de cron do contínuo. Fonte única —
 *  o scan de arquivos e os testes unitários abaixo usam esta mesma função,
 *  pra não divergirem (lição do #6963: guard e teste que reimplementam o
 *  mesmo critério separadamente acabam concordando entre si e discordando
 *  da realidade). */
export function violatesCadenceProse(line: string): boolean {
  const bare = stripQuotedSpans(line);
  if (FORBIDDEN_PATTERNS.some((p) => p.test(bare))) return true;
  if (!CADENCE_CONTEXT.test(bare)) return false;
  return AMBIGUOUS_PATTERNS.some((p) => p.test(bare));
}

/**
 * Normaliza separador de path (`\` no Windows) para `/` antes de comparar
 * contra sufixos hardcoded com `/` — sem isso, `endsWith("a/b.md")` nunca
 * casa um caminho montado por `path.join()` no Windows (#7132). `readFileSync`/
 * `readdirSync` continuam recebendo o path original (nativo do SO); esta
 * função serve só para comparação textual.
 *
 * `platformSep` é injetável (default `path.sep`, o real do SO rodando o
 * teste) só para permitir o teste unitário abaixo simular o separador do
 * Windows a partir de qualquer plataforma — em produção, chamar sempre com 1
 * argumento.
 */
export function toPosixPath(f: string, platformSep: string = sep): string {
  return platformSep === "/" ? f : f.split(platformSep).join("/");
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

describe("continuo-cadence-prose-drift-6928 (#6928)", () => {
  const proseFiles = listFiles(join(REPO_ROOT, "hermes"), [
    ".md",
    ".sh",
  ]).filter((f) => !f.endsWith(".test.sh"));

  it("varre arquivos de prosa do hermes/ (sanidade da própria varredura)", () => {
    assert.ok(
      proseFiles.some((f) => toPosixPath(f).endsWith("hermes-diaria-continuo/SKILL.md")),
      "SKILL.md tem que estar no escopo da varredura",
    );
    assert.ok(
      proseFiles.some((f) => toPosixPath(f).endsWith("scripts/continuo-pr-review.sh")),
      "continuo-pr-review.sh tem que estar no escopo da varredura",
    );
  });

  it("nenhuma prosa de hermes/ afirma cadência dos crons do contínuo fora de citação", () => {
    const violations: string[] = [];
    for (const file of proseFiles) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (violatesCadenceProse(line)) {
          violations.push(`${file}:${i + 1} — cadência afirmada fora de citação: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Cadência de cron do Hermes não se escreve em prosa — derivar com \`hermes cron list --all\` (CLAUDE.md; issue #6928). Se a linha é um registro de correção, ponha o token entre aspas/backticks como alegação rejeitada:\n${violations.join("\n")}`,
    );
  });

  it("o ponteiro de derivação continua presente nos pontos onde cadência era afirmada", () => {
    const skill = readFileSync(
      join(REPO_ROOT, "hermes/skills/hermes-diaria-continuo/SKILL.md"),
      "utf8",
    );
    const script = readFileSync(
      join(REPO_ROOT, "hermes/scripts/continuo-pr-review.sh"),
      "utf8",
    );
    assert.ok(
      skill.includes("hermes cron list --all"),
      "SKILL.md tem que apontar a fonte canônica de cadência",
    );
    assert.ok(
      script.includes("hermes cron list --all"),
      "continuo-pr-review.sh tem que apontar a fonte canônica de cadência",
    );
  });
});

/**
 * #6950 (review da 1ª saída do lane GLM): os dois bypasses abaixo eram
 * REAIS e foram verificados ao vivo pelo revisor — um arquivo com
 * "a cada 90min" ou "~6h" dava 0 violações, e envolver a afirmação em
 * crase também dava 0. Estes testes exercitam a função de matching
 * diretamente (não o filesystem), pra que a CLASSE fique travada mesmo que
 * nenhum arquivo do repo contenha o caso hoje.
 */
describe("continuo-cadence-prose-drift-6928 — matching por CLASSE (#6950 findings 2 e 3)", () => {
  it("#6950 f2: pega números que NÃO são os do incidente original", () => {
    assert.equal(violatesCadenceProse("o contínuo roda a cada 90min neste cron"), true, "'a cada 90min' tem que violar");
    assert.equal(violatesCadenceProse("a espera máxima do tick é ~6h"), true, "'~6h' tem que violar");
    assert.equal(violatesCadenceProse("o job está em every 45m"), true, "'every 45m' tem que violar");
    assert.equal(violatesCadenceProse("a razão entre os dois jobs fica 3:1"), true, "razão '3:1' tem que violar");
  });

  it("#6950 f2: continua pegando os tokens do incidente original (não é regressão)", () => {
    for (const token of ["every 240m", "every 120m", "every 60m", "~4h", "a cada 120min"]) {
      assert.equal(violatesCadenceProse(`o tick do cron afirmando ${token} aqui`), true, `'${token}' tem que violar`);
    }
    assert.equal(violatesCadenceProse("o descompasso era 12:1 entre os dois"), true, "'12:1' tem que violar");
  });

  it("#6950 f3: crase NÃO isenta mais — era bypass por formatação normal do repo", () => {
    assert.equal(
      violatesCadenceProse("O contínuo roda a cada `120min` neste cron."),
      true,
      "valor entre crases é afirmação presente, não citação histórica — tem que violar",
    );
    assert.equal(violatesCadenceProse("o job está em `every 60m`"), true, "'every 60m' entre crases tem que violar");
  });

  it("aspas duplas seguem isentas — é a convenção de registrar valor ERRADO sem reafirmá-lo", () => {
    assert.equal(
      violatesCadenceProse('o comentário dizia "every 240m", que estava errado'),
      false,
      "alegação citada entre aspas duplas é permitida",
    );
  });

  it("#6950: padrão AMBÍGUO sem contexto de cadência NÃO acusa (evita o extremo oposto)", () => {
    assert.equal(
      violatesCadenceProse("o lock é renovado a cada 3min antes da delegação"),
      false,
      "'a cada 3min' de renovação de lock não é cadência de cron — falso positivo real, achado ao rodar o guard",
    );
    assert.equal(violatesCadenceProse("o timeout da unidade é ~2h de teto"), false, "'~2h' sem contexto de cron não acusa");
  });

  it("#6950: o MESMO padrão ambíguo COM contexto de cadência acusa", () => {
    assert.equal(violatesCadenceProse("o tick do contínuo roda a cada 90min"), true);
    assert.equal(violatesCadenceProse("a espera máxima do job é ~6h"), true);
  });

  it("não acusa horário nem número sem unidade de cadência (evita o extremo oposto)", () => {
    assert.equal(violatesCadenceProse("a reunião é às 12:15 de terça"), false, "horário não é razão de cadência");
    assert.equal(violatesCadenceProse("foram 98 requisições no tick"), false, "contagem sem unidade de tempo não é cadência");
    assert.equal(violatesCadenceProse("o teto é de 10 unidades"), false, "número solto não é cadência");
  });
});

describe("continuo-cadence-prose-drift-6928 — toPosixPath (#7132)", () => {
  it("reproduz o bug original: endsWith('a/b') nunca casa um path com separador Windows", () => {
    const windowsPath = "C:\\repo\\hermes\\skills\\hermes-diaria-continuo\\SKILL.md";
    // Sem normalizar — exatamente o que a asserção fazia antes do #7132.
    assert.equal(
      windowsPath.endsWith("hermes-diaria-continuo/SKILL.md"),
      false,
      "sanidade: reproduz o bug — comparação crua falha no path estilo Windows",
    );
  });

  it("normaliza separador Windows (`\\\\`) para `/` antes de comparar", () => {
    const windowsPath = "C:\\repo\\hermes\\skills\\hermes-diaria-continuo\\SKILL.md";
    assert.equal(
      toPosixPath(windowsPath, "\\").endsWith("hermes-diaria-continuo/SKILL.md"),
      true,
      "path normalizado tem que casar o sufixo com '/'",
    );
  });

  it("é no-op em separador POSIX (`/`) — não quebra o caminho Linux/CI já correto", () => {
    const posixPath = "/repo/hermes/skills/hermes-diaria-continuo/SKILL.md";
    assert.equal(toPosixPath(posixPath, "/"), posixPath);
  });
});
