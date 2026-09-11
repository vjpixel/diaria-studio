/**
 * scripts/lib/calibration-evidence-report.ts (#7978, Camada 5 da #7972)
 *
 * Template DETERMINÍSTICO de 3 partes pro corpo de qualquer PR de
 * calibração de verdade (#7978 ponto 2): (1) o que muda, (2) evidência
 * concreta — no máximo 5 casos nomeados edição+URL+ação, (3) como reverter
 * em 1 comando. Puro (string in, string out) — nenhum I/O, nenhuma
 * chamada de rede; quem monta o `CalibrationEvidenceInput` (a partir do
 * output de `calibration-power-report.ts`/`shadow-validation-report.ts` e
 * do histórico de `analyze-destaque-overrides.ts`) é responsabilidade do
 * chamador (`scripts/generate-calibration-evidence-report.ts`).
 *
 * "No máximo 5 casos" é um INVARIANTE FALHO-ALTO, não um corte silencioso
 * — `renderCalibrationEvidenceReport` lança se `cases.length > 5`. O
 * limite existe pro relatório continuar revisável por um humano em minutos
 * (#7978 ponto 6, sign-off explícito do editor) — mais casos não tornam a
 * evidência mais forte pro editor ler, só mais cara de revisar.
 */

export interface CalibrationCase {
  /** AAMMDD da edição onde este caso aconteceu. */
  edition: string;
  url: string;
  /** O que aconteceu com este item — ex: "editor promoveu a destaque apesar de score baixo", "editor removeu do pool apesar de hands_on:true". */
  action: string;
}

export interface CalibrationEvidenceInput {
  /** Nome da feature/constante calibrada (ex: "hands_on", "primary_source"). */
  feature: string;
  /** Ex: "peso do bônus hands_on: +8 → +10 pontos". */
  whatChanges: string;
  /** No máximo 5 — ver docstring do módulo. */
  cases: readonly CalibrationCase[];
  /** Comando único que desfaz esta mudança — ex: "git revert <sha-do-merge>". */
  revertCommand: string;
  /** Opcional: resumo numérico de calibration-power-report.ts/shadow-validation-report.ts (n, p-valor, AUC etc.) — texto livre, citado como contexto, não reprocessado aqui. */
  evidenceSummary?: string;
  /** Issue/PR de origem, pra rastreabilidade (ex: "#7990"). */
  sourceIssue?: string;
}

const MAX_CASES = 5;

/**
 * Valida o invariante de contagem de `cases` (1 a 5) SEM renderizar nada —
 * achado de review do #7978 (P2, alta confiança): a versão anterior só
 * validava dentro de `renderCalibrationEvidenceReport`, então um
 * `CalibrationEvidenceInput` inválido podia ser construído, logado,
 * serializado ou passado adiante por qualquer código ANTES de chegar no
 * único ponto que checava — o objeto existia num estado inválido por um
 * tempo, mesmo que hoje só haja 1 call site (`generate-calibration-
 * evidence-report.ts`) que valida imediatamente. Chamar isto assim que o
 * input é montado fecha essa janela pra qualquer call site futuro.
 */
export function assertValidCalibrationEvidenceInput(input: CalibrationEvidenceInput): void {
  if (input.cases.length === 0) {
    throw new Error("CalibrationEvidenceInput.cases não pode ser vazio — um PR de calibração sem nenhum caso nomeado não tem evidência pra revisar.");
  }
  if (input.cases.length > MAX_CASES) {
    throw new Error(`CalibrationEvidenceInput.cases tem ${input.cases.length} casos — máximo permitido é ${MAX_CASES} (#7978 ponto 2). Selecione os ${MAX_CASES} mais representativos, não trunque em silêncio.`);
  }
}

/** Renderiza o corpo markdown de 3 partes. Lança se `cases` estiver vazio (nenhuma evidência = não deveria existir PR) ou tiver mais de 5 (ver docstring do módulo e `assertValidCalibrationEvidenceInput`). */
export function renderCalibrationEvidenceReport(input: CalibrationEvidenceInput): string {
  assertValidCalibrationEvidenceInput(input);

  const lines: string[] = [];

  lines.push(`## O que muda`);
  lines.push("");
  lines.push(`**Feature:** \`${input.feature}\``);
  lines.push("");
  lines.push(input.whatChanges);
  if (input.evidenceSummary) {
    lines.push("");
    lines.push(`**Resumo da evidência:** ${input.evidenceSummary}`);
  }
  if (input.sourceIssue) {
    lines.push("");
    lines.push(`Origem: ${input.sourceIssue}`);
  }
  lines.push("");

  lines.push(`## Evidência concreta (${input.cases.length} caso${input.cases.length > 1 ? "s" : ""})`);
  lines.push("");
  for (const c of input.cases) {
    lines.push(`- **${c.edition}** — [${c.url}](${c.url}): ${c.action}`);
  }
  lines.push("");

  lines.push(`## Como reverter`);
  lines.push("");
  lines.push("```bash");
  lines.push(input.revertCommand);
  lines.push("```");
  lines.push("");

  lines.push(`---`);
  lines.push("");
  lines.push(`**REGRA DE OURO (#7972):** esta PR muda score/seleção/geração real e NUNCA é mergeada por uma sessão automática. Aguarda sign-off explícito do editor (label \`editorial-signoff:approved\`) antes de qualquer merge — ver \`.github/workflows/editorial-signoff-required.yml\` (#7978).`);

  return lines.join("\n");
}
