/**
 * test/hermes-diaria-continuo-skill-size.test.ts (#6712 Parte B)
 *
 * Guard de tamanho do `hermes/skills/hermes-diaria-continuo/SKILL.md` —
 * mesmo racional de `test/claude-md-size.test.ts` (#5904), aplicado ao 2º
 * arquivo de prompt que é carregado incondicionalmente sempre que ele roda:
 * o `helios` (via cron do Hermes, ver `test/continuo-infra-consumidor-
 * externo.test.ts`) lê o SKILL.md inteiro em TODO tick do contínuo. Medido
 * em 02/09/2026: 48.282 bytes, crescendo ~7KB/dia (cada incidente/decisão
 * vira um parágrafo novo no changelog ou nos passos operacionais, narrativa
 * velha raramente sai) — mesma dinâmica que motivou o #5904 no CLAUDE.md.
 *
 * **Fix aplicado antes deste teto (#6712 Parte B, 02/09/2026):** o Changelog
 * completo (versão a versão, 13,8KB de narrativa de incidente sem instrução
 * operacional nova) e 1 pitfall histórico foram extraídos para
 * `hermes/skills/hermes-diaria-continuo/references/*.md`, com um ponteiro
 * curto no lugar — mesmo padrão já usado por
 * `references/subagent-mcp-drain-20260828.md` e
 * `references/tick-20260828-claim-collision-and-subagent.md`, que essa skill
 * já vinha usando antes deste PR. Resultado: 48.282 → 34.102 bytes (-29,4%).
 * O conteúdo OPERACIONAL (o que o tick precisa pra executar — "Segurança e
 * escopo", "Ferramentas desta skill", "Cada ciclo" passos 1-7, formato do
 * relatório, definição de sucesso) permanece integralmente no SKILL.md — só
 * narrativa histórica (changelog, "achado ao vivo", derivação de decisão já
 * encerrada) foi movida.
 *
 * **Quando este teste estourar: extrair mais narrativa para `references/`,
 * NUNCA subir o teto sem decisão do editor registrada em issue.** Os passos
 * "Cada ciclo" (§1-7) concentram bastante rationale/histórico intercalado
 * com instrução operacional (ex: parágrafos "Achado ao vivo (#N)",
 * "Incidente de referência", "Review da PR #N (achado...)") — candidatos
 * naturais pra extração adicional quando o teto for cruzado de novo, desde
 * que a instrução operacional em si (o comando a rodar, a condição a
 * checar) permaneça no SKILL.md com um ponteiro pro rationale.
 *
 * Teto inicial 40KB (bytes) — folga de ~6,8KB (~20%) sobre o tamanho
 * pós-extração (34.102 B), maior em proporção que a folga do #5904
 * (~2,4%) porque este arquivo mediu crescimento bem mais rápido
 * (~7KB/dia vs. o ritmo do CLAUDE.md) — folga mínima aqui estouraria em
 * menos de 1 dia e travaria CI por um problema que o editor nem teve
 * chance de notar. Apertar depois é mudar 1 constante AQUI; subir o teto
 * exige decisão do editor registrada na issue #6712.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_MD = join(
  ROOT,
  "hermes",
  "skills",
  "hermes-diaria-continuo",
  "SKILL.md",
);

/** Teto em bytes. 40 * 1024 = 40_960. Ver docblock antes de alterar. */
export const CONTINUO_SKILL_MAX_BYTES = 40 * 1024;

/**
 * Limiar de proximidade — mesma técnica do #6275 aplicada aqui: avisa sem
 * falhar quando o arquivo cruza 90% do teto (folga menor que o CLAUDE.md
 * porque o teto absoluto também é menor — 90% de 40KB ainda deixa ~4KB de
 * margem real pra agir).
 */
export const CONTINUO_SKILL_WARN_RATIO = 0.9;

export type ContinuoSkillSizeStatus = "ok" | "warn" | "over";

export interface ContinuoSkillSizeEvaluation {
  status: ContinuoSkillSizeStatus;
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
 * Nunca deve ser acoplada ao tamanho ATUAL do SKILL.md real: o arquivo muda
 * a cada tick/incidente e um teste que hardcode-asse esse número viraria
 * flake.
 */
export function evaluateContinuoSkillSize(
  sizeBytes: number,
  maxBytes: number = CONTINUO_SKILL_MAX_BYTES,
  warnRatio: number = CONTINUO_SKILL_WARN_RATIO,
): ContinuoSkillSizeEvaluation {
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
        `hermes/skills/hermes-diaria-continuo/SKILL.md tem ${sizeBytes} bytes` +
        ` — excede o teto de ${maxBytes} (${(sizeBytes - maxBytes).toLocaleString("pt-BR")}` +
        ` bytes acima).\n\n` +
        `Caminho correto: mova narrativa histórica/incidente/rationale de decisão` +
        ` já encerrada para hermes/skills/hermes-diaria-continuo/references/*.md e` +
        ` deixe um ponteiro curto no lugar (mesmo padrão de` +
        ` references/changelog.md e references/subagent-mcp-drain-20260828.md) —` +
        ` NÃO remova instrução operacional (o que o tick precisa pra executar).\n` +
        `NÃO suba este teto sem decisão do editor registrada na issue #6712.`,
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
        `hermes/skills/hermes-diaria-continuo/SKILL.md tem ${sizeBytes} bytes` +
        ` — já cruzou ${Math.round(warnRatio * 100)}% do teto de ${maxBytes}` +
        ` (faltam só ${bytesRemaining} bytes pra estourar).\n\n` +
        `Ainda dá tempo de podar sem virar master vermelho: mova o próximo` +
        ` parágrafo de narrativa/histórico/rationale pra` +
        ` hermes/skills/hermes-diaria-continuo/references/ antes do próximo push.`,
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

describe("hermes-diaria-continuo SKILL.md size (#6712 Parte B)", () => {
  it("SKILL.md existe", () => {
    assert.equal(statSync(SKILL_MD).isFile(), true);
  });

  it(`SKILL.md ≤ ${CONTINUO_SKILL_MAX_BYTES} bytes (teto #6712)`, () => {
    const size = readFileSync(SKILL_MD).length;
    const evaluation = evaluateContinuoSkillSize(size);
    assert.ok(evaluation.status !== "over", evaluation.message);
  });

  it(`alarme de proximidade: avisa sem falhar quando SKILL.md cruza ${Math.round(CONTINUO_SKILL_WARN_RATIO * 100)}% do teto`, () => {
    const size = readFileSync(SKILL_MD).length;
    const evaluation = evaluateContinuoSkillSize(size);
    // Nunca falha aqui (mesmo em "warn") — só torna o sinal visível cedo, no
    // log de CI do próprio PR que cruzou o limiar. Ver docblock do módulo.
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

describe("evaluateContinuoSkillSize — cenários sintéticos", () => {
  const MAX = 40_960; // mesmo valor de CONTINUO_SKILL_MAX_BYTES, literal p/ deixar os cenários auto-contidos
  const WARN_THRESHOLD = Math.floor(MAX * CONTINUO_SKILL_WARN_RATIO); // 36.864

  it("confortavelmente abaixo do limiar de proximidade → ok, sem mensagem", () => {
    const evaluation = evaluateContinuoSkillSize(WARN_THRESHOLD - 5_000, MAX);
    assert.equal(evaluation.status, "ok");
    assert.equal(evaluation.message, "");
  });

  it("logo abaixo do teto mas acima do limiar → warn, com mensagem acionável", () => {
    const evaluation = evaluateContinuoSkillSize(MAX - 50, MAX);
    assert.equal(evaluation.status, "warn");
    assert.match(evaluation.message, /cruzou 90%/);
    assert.match(evaluation.message, /faltam só 50 bytes/);
  });

  it("exatamente no limiar de proximidade → warn (inclusivo)", () => {
    const evaluation = evaluateContinuoSkillSize(WARN_THRESHOLD, MAX);
    assert.equal(evaluation.status, "warn");
  });

  it("1 byte abaixo do limiar de proximidade → ok (exclusivo)", () => {
    const evaluation = evaluateContinuoSkillSize(WARN_THRESHOLD - 1, MAX);
    assert.equal(evaluation.status, "ok");
  });

  it("acima do teto → over, com a mensagem de estouro", () => {
    const evaluation = evaluateContinuoSkillSize(MAX + 9, MAX);
    assert.equal(evaluation.status, "over");
    assert.match(evaluation.message, /excede o teto/);
  });

  it("bytesRemaining é negativo quando estourado, positivo quando não", () => {
    assert.equal(evaluateContinuoSkillSize(MAX + 100, MAX).bytesRemaining, -100);
    assert.equal(evaluateContinuoSkillSize(MAX - 100, MAX).bytesRemaining, 100);
  });
});
