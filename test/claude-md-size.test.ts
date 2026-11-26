/**
 * test/claude-md-size.test.ts (#5904, alarme de proximidade #6275)
 *
 * Guard de tamanho do CLAUDE.md — o arquivo é carregado incondicionalmente em
 * toda sessão E todo dispatch de subagente (§Otimização de tokens, #4814), o
 * que faz dele o multiplicador de custo nº 1 do projeto. O histórico mostra
 * que ele recresce a cada issue fechada (cada decisão vira parágrafo novo,
 * narrativa velha raramente sai); o trim manual do PR #5893 ganhou ~3,7% e
 * sem enforcement esse ganho evapora.
 *
 * Mesmo racional do lib-boundary.test.ts (#2747): o erro barato em CI força a
 * pergunta certa no momento certo — "esse parágrafo novo precisa estar no
 * arquivo incondicional, ou cabe em context//docs/issue com um ponteiro?".
 *
 * Teto inicial 75KB (bytes) — premissa declarada na issue, não decisão
 * fechada: congela o tamanho pós-#5893 (73.230 B) com folga mínima (~1.8KB).
 * Apertar depois é mudar 1 constante AQUI; subir o teto exige decisão do
 * editor registrada.
 *
 * Teto baixado para 64KB (65.536 B) no #14002 (decisão do editor, briefing
 * overnight 25/11/2026): o arquivo voltava a ~97% de 75KB a cada rodada de
 * corte. Os seis blocos de histórico (mensal-apoiadores, anual, infra
 * `continuo`, Sonnet 5, Opus 5, #8941) foram para `docs/` com ponteiro. A
 * regra segue a mesma: a falta de folga obriga a curadoria, nunca a subida
 * do teto sem decisão registrada.
 *
 * --- Alarme de proximidade (#6275, direção 3) ---
 *
 * O #6275 mediu master a 9 bytes do teto: o único sinal que existia era o
 * teto binário (passa em 76.799, quebra em 76.801), sem nenhum degrau
 * intermediário — quem estourasse descobria só quando o PRÓPRIO push virava
 * master vermelho, travando o CI de TODO PR em voo ao mesmo tempo (não só o
 * seu). `evaluateClaudeMdSize` (função pura, testável com bytes injetados —
 * nunca acoplada ao tamanho real do arquivo, que muda toda semana) introduz
 * um limiar de proximidade em `WARN_RATIO` (95% do teto) com 3 estados:
 * "ok" (abaixo do limiar), "warn" (cruzou o limiar mas ainda dentro do teto)
 * e "over" (estourou — o comportamento de sempre, #5904).
 *
 * Escolha deliberada, registrada aqui porque é a parte que "impede a
 * recorrência" segundo a própria issue: o estado "warn" NÃO falha o teste.
 * Fazer "warn" falhar recriaria o problema que a issue reporta — só que
 * ~4KB mais cedo: master vermelho de novo, bloqueando todo PR em voo por
 * uma margem que ainda folga. Em vez disso, o teste passa mas imprime um
 * aviso acionável (bytes que faltam pro teto + o que fazer) via
 * `console.warn`, visível no log de CI só do PR que cruzou o limiar — sinal
 * cedo, sem punir quem não tocou o arquivo. O critério de poda é o mesmo do
 * #6266 (detalhe de implementação → docstring do módulo; fica no CLAUDE.md
 * só o veredito + ponteiro) — ver PR do #6266 pro precedente aplicado.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_MD = join(ROOT, "CLAUDE.md");

/** Teto em bytes. 64 * 1024 = 65_536 (#14002; era 75 * 1024). Ver docblock antes de alterar. */
export const CLAUDE_MD_MAX_BYTES = 64 * 1024;

/**
 * Limiar de proximidade — fração do teto a partir da qual emitimos aviso
 * (#6275, direção 3). 95%: dá margem real (~3,2KB no teto atual) pra agir
 * antes do estouro, sem disparar cedo demais no dia a dia.
 */
export const CLAUDE_MD_WARN_RATIO = 0.95;

export type ClaudeMdSizeStatus = "ok" | "warn" | "over";

export interface ClaudeMdSizeEvaluation {
  status: ClaudeMdSizeStatus;
  sizeBytes: number;
  maxBytes: number;
  warnThresholdBytes: number;
  /** Bytes livres até o teto. Negativo quando já estourou. */
  bytesRemaining: number;
  /** Mensagem acionável — vazia quando status === "ok". */
  message: string;
}

/**
 * Função pura de avaliação — testável com bytes injetados, sem tocar disco.
 * Nunca deve ser acoplada ao tamanho ATUAL do CLAUDE.md real: o arquivo muda
 * toda semana e um teste que hardcode-asse esse número viraria flake.
 */
export function evaluateClaudeMdSize(
  sizeBytes: number,
  maxBytes: number = CLAUDE_MD_MAX_BYTES,
  warnRatio: number = CLAUDE_MD_WARN_RATIO,
): ClaudeMdSizeEvaluation {
  const warnThresholdBytes = Math.floor(maxBytes * warnRatio);
  const bytesRemaining = maxBytes - sizeBytes;

  if (sizeBytes > maxBytes) {
    return {
      status: "over",
      sizeBytes,
      maxBytes,
      warnThresholdBytes,
      bytesRemaining,
      message:
        `CLAUDE.md tem ${sizeBytes} bytes — excede o teto de ${maxBytes}` +
        ` (${(sizeBytes - maxBytes).toLocaleString("pt-BR")} bytes acima).\n\n` +
        `Caminho correto: mova histórico/narrativa pra docs/ ou pra uma issue` +
        ` e deixe um ponteiro no lugar — NÃO delete conteúdo operativo.\n` +
        `NÃO suba este teto sem decisão do editor registrada na issue #5904.`,
    };
  }

  if (sizeBytes >= warnThresholdBytes) {
    return {
      status: "warn",
      sizeBytes,
      maxBytes,
      warnThresholdBytes,
      bytesRemaining,
      message:
        `CLAUDE.md tem ${sizeBytes} bytes — já cruzou ${Math.round(warnRatio * 100)}%` +
        ` do teto de ${maxBytes} (faltam só ${bytesRemaining} bytes pra estourar).\n\n` +
        `Ainda dá tempo de podar sem virar master vermelho: aplique o critério do` +
        ` #6266 (detalhe de implementação → docstring do módulo; fica no CLAUDE.md` +
        ` só o veredito + ponteiro) nas seções mais longas de "Regras invariáveis".`,
    };
  }

  return {
    status: "ok",
    sizeBytes,
    maxBytes,
    warnThresholdBytes,
    bytesRemaining,
    message: "",
  };
}

describe("claude-md-size (#5904)", () => {
  it("CLAUDE.md existe", () => {
    assert.equal(statSync(CLAUDE_MD).isFile(), true);
  });

  it(`CLAUDE.md ≤ ${CLAUDE_MD_MAX_BYTES} bytes (teto #5904)`, () => {
    const size = readFileSync(CLAUDE_MD).length;
    const evaluation = evaluateClaudeMdSize(size);
    if (evaluation.status === "over") {
      assert.fail(evaluation.message);
    }
    assert.ok(size <= CLAUDE_MD_MAX_BYTES);
  });

  it(`alarme de proximidade (#6275): avisa sem falhar quando CLAUDE.md cruza ${Math.round(CLAUDE_MD_WARN_RATIO * 100)}% do teto`, () => {
    const size = readFileSync(CLAUDE_MD).length;
    const evaluation = evaluateClaudeMdSize(size);
    // Nunca falha aqui (mesmo em "warn") — só torna o sinal visível cedo,
    // no log de CI do próprio PR que cruzou o limiar. Ver docblock do
    // módulo para a justificativa de por que "warn" não falha o teste.
    if (evaluation.status === "warn") {
      console.warn(`\n⚠️  ${evaluation.message}\n`);
    }
    assert.notEqual(
      evaluation.status,
      "over",
      "estado 'over' já é coberto (e falha) pelo teste de teto acima — inesperado aqui",
    );
  });
});

describe("evaluateClaudeMdSize — cenários sintéticos (#6275, direção 3)", () => {
  const MAX = 65_536; // mesmo valor de CLAUDE_MD_MAX_BYTES, literal p/ deixar os cenários auto-contidos
  const WARN_THRESHOLD = Math.floor(MAX * CLAUDE_MD_WARN_RATIO); // 62.259

  it("o literal dos cenários acompanha o teto real (#14002)", () => {
    assert.equal(MAX, CLAUDE_MD_MAX_BYTES);
  });

  it("confortavelmente abaixo do limiar de proximidade → ok, sem mensagem", () => {
    const evaluation = evaluateClaudeMdSize(WARN_THRESHOLD - 5_000, MAX);
    assert.equal(evaluation.status, "ok");
    assert.equal(evaluation.message, "");
  });

  it("logo abaixo do teto mas acima do limiar de 95% → warn, com mensagem acionável", () => {
    const evaluation = evaluateClaudeMdSize(MAX - 50, MAX);
    assert.equal(evaluation.status, "warn");
    assert.match(evaluation.message, /cruzou 95%/);
    assert.match(evaluation.message, /faltam só 50 bytes/);
  });

  it("exatamente no limiar de proximidade → warn (inclusivo)", () => {
    const evaluation = evaluateClaudeMdSize(WARN_THRESHOLD, MAX);
    assert.equal(evaluation.status, "warn");
  });

  it("1 byte abaixo do limiar de proximidade → ok (exclusivo)", () => {
    const evaluation = evaluateClaudeMdSize(WARN_THRESHOLD - 1, MAX);
    assert.equal(evaluation.status, "ok");
  });

  it("acima do teto → over, com a mensagem de estouro de sempre (#5904)", () => {
    const evaluation = evaluateClaudeMdSize(MAX + 9, MAX);
    assert.equal(evaluation.status, "over");
    assert.match(evaluation.message, /excede o teto/);
  });

  it("bytesRemaining é negativo quando estourado, positivo quando não", () => {
    assert.equal(evaluateClaudeMdSize(MAX + 100, MAX).bytesRemaining, -100);
    assert.equal(evaluateClaudeMdSize(MAX - 100, MAX).bytesRemaining, 100);
  });
});

/**
 * #14002 — o histórico saiu do CLAUDE.md para docs/ com ponteiro. Regra que
 * vira ponteiro só serve se o ponteiro resolve e o conteúdo chegou ao destino;
 * e o aviso do `continuo` (guard contra repetir o #6059) tem que continuar no
 * arquivo carregado em toda sessão, não só no doc.
 */
describe("ponteiros do CLAUDE.md para docs/ (#14002)", () => {
  const claudeMd = readFileSync(CLAUDE_MD, "utf8");
  const readDoc = (p: string) => readFileSync(join(ROOT, p), "utf8");

  it("todo docs/*.md citado no CLAUDE.md existe", () => {
    const cited = [...new Set(claudeMd.match(/docs\/[A-Za-z0-9_./-]+\.md/g) ?? [])];
    assert.ok(cited.length > 0);
    const missing = cited.filter((p) => {
      try {
        return !statSync(join(ROOT, p)).isFile();
      } catch {
        return true;
      }
    });
    assert.deepEqual(missing, [], `ponteiros quebrados no CLAUDE.md: ${missing.join(", ")}`);
  });

  it("o aviso do continuo segue no CLAUDE.md, em uma linha, com o ponteiro", () => {
    const line = claudeMd.split("\n").find((l) => l.includes("infra do kind `continuo`"));
    assert.ok(line, "a linha de aviso do continuo sumiu do CLAUDE.md");
    assert.match(line, /não é código morto/);
    assert.match(line, /hermes-diaria-continuo/);
    assert.match(line, /não remover nada/);
    assert.match(line, /`300`/);
    assert.match(line, /docs\/continuo-consumidor-externo\.md/);
  });

  it("cada bloco movido tem a regra + ponteiro no CLAUDE.md e o detalhe no doc", () => {
    const cases: Array<{ doc: string; ruleInClaudeMd: RegExp; detailInDoc: RegExp[] }> = [
      {
        doc: "docs/edicao-anual.md",
        ruleInClaudeMd: /`\/diaria-anual` \(#7569\)[^\n]*editorialDate\(\)[^\n]*docs\/edicao-anual\.md/,
        detailInDoc: [/legacy-edition-parse\.ts/, /27\/08\/2025/, /lint-annual-draft\.ts/, /#7587/],
      },
      {
        doc: "docs/mensal-apoiadores-canal-kit.md",
        ruleInClaudeMd: /`\/diaria-mensal-apoiadores`: canal Kit \(#7633\)[^\n]*TAG, nunca segmento[^\n]*docs\/mensal-apoiadores-canal-kit\.md/,
        detailInDoc: [/segment_id=X/, /apoio-retrospectiva/, /#6582/, /`public: false`/, /25844671/],
      },
      {
        doc: "docs/continuo-consumidor-externo.md",
        ruleInClaudeMd: /docs\/continuo-consumidor-externo\.md/,
        detailInDoc: [/hermes cron list --all/, /5d791ef6fc2c/, /#6168/, /#6446/, /test\/continuo-infra-consumidor-externo\.test\.ts/],
      },
      {
        doc: "docs/model-mix-historico.md",
        ruleInClaudeMd: /Sonnet 5 #2745, Opus 5 #4042, #8941[^\n]*docs\/model-mix-historico\.md/,
        detailInDoc: [/\*\*\(Histórico #8941\)\*\*/, /\*\*Opus 5\*\* \(#4042/, /\*\*Sonnet 5\*\* \(#2745\)/, /#3710/, /#6496/],
      },
    ];
    for (const c of cases) {
      assert.match(claudeMd, c.ruleInClaudeMd, `${c.doc}: regra/ponteiro ausente no CLAUDE.md`);
      const doc = readDoc(c.doc);
      for (const re of c.detailInDoc) assert.match(doc, re, `${c.doc}: detalhe ${re} não chegou ao doc`);
    }
  });

  it("o detalhe movido não voltou ao CLAUDE.md (senão o corte não vale)", () => {
    for (const re of [/hermes cron list --all/, /segment_id=X/, /legacy-edition-parse\.ts/, /\*\*Opus 5\*\* \(#4042/]) {
      assert.doesNotMatch(claudeMd, re);
    }
  });
});
