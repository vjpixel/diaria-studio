/**
 * #9253: `_internal/box-selection.json` é gravado no stitch (Stage 2) e
 * congela o snippet de cada slot. Se o editor troca `boxes_divulgacao.slotN`
 * no `platform.config.json` (ou pelo painel Caixas) DEPOIS disso, o render
 * continua lendo título/alt/categoria do snippet antigo — sem aviso nenhum
 * (caso real 261001: slot 1 seguia em `workshop-agente-ia-outubro.md`).
 *
 * Este módulo detecta a divergência — puro, sem I/O de config — pra que o
 * Stage 4 a mostre explicitamente, apontando `scripts/apply-box-slot.ts`
 * como caminho de correção (troca o box no `02-reviewed.md` E atualiza o
 * `box-selection.json`, com guarda contra sobrescrever edição do editor).
 *
 * Só entra na comparação o registro cujo arquivo VEIO do config:
 * `disabled` (auto-seleção desligada), `pinned` e `fallback-no-candidates`
 * (o `file` é o próprio `slotN`) e `fallback-ineligible` (o `rejectedFile` é
 * o `slotN` recusado). `auto` (escolhido por cliques) e `manual`
 * (`apply-box-slot.ts`) divergem do config por definição — nunca é drift.
 */

export interface BoxSelectionDrift {
  slot: 1 | 2;
  /** Arquivo congelado em box-selection.json (de `file` ou `rejectedFile`). */
  selectionFile: string | null;
  /** `boxes_divulgacao.slotN` atual. */
  configFile: string | null;
  mode: string;
}

const CONFIG_DERIVED_MODES = new Set(["disabled", "pinned", "fallback-no-candidates", "fallback-ineligible"]);

export function detectBoxSelectionConfigDrift(
  selection: unknown,
  config: { slot1?: string | null; slot2?: string | null },
): BoxSelectionDrift[] {
  if (!Array.isArray(selection)) return [];
  const drifts: BoxSelectionDrift[] = [];
  for (const raw of selection) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as { slot?: unknown; mode?: unknown; file?: unknown; rejectedFile?: unknown };
    if (e.slot !== 1 && e.slot !== 2) continue;
    const mode = typeof e.mode === "string" ? e.mode : "";
    if (!CONFIG_DERIVED_MODES.has(mode)) continue;
    // #9319: o Studio grava slot vazio como `""` (normalizeSlotValue), não
    // `null` — normalizar com `||` (mesma regra do `selectionFile` abaixo),
    // senão `null !== ""` acusa drift falso num slot vazio dos dois lados.
    const configFile = (e.slot === 1 ? config.slot1 : config.slot2) || null;
    const selectionFile =
      mode === "fallback-ineligible"
        ? (typeof e.rejectedFile === "string" && e.rejectedFile ? e.rejectedFile : null)
        : (typeof e.file === "string" && e.file ? e.file : null);
    // `disabled` com file null num slot inativo (edição de 2 destaques, #9175)
    // não é drift: o slot nem renderiza.
    if (mode === "disabled" && selectionFile === null) continue;
    if (selectionFile !== configFile) {
      drifts.push({ slot: e.slot, selectionFile, configFile, mode });
    }
  }
  return drifts;
}

export function formatBoxSelectionDrift(d: BoxSelectionDrift, edition: string | null): string {
  const fix = d.configFile
    ? `npx tsx scripts/apply-box-slot.ts --edition ${edition ?? "AAMMDD"} --slot ${d.slot} --file ${d.configFile}`
    : `remover o box do slot ${d.slot} do 02-reviewed.md à mão (config agora sem caixa nesse slot)`;
  return (
    `Slot ${d.slot}: box-selection.json (gravado no stitch) congelou \`${d.selectionFile ?? "(vazio)"}\`, ` +
    `mas platform.config.json → boxes_divulgacao.slot${d.slot} agora é \`${d.configFile ?? "(vazio)"}\`. ` +
    `O render segue usando o snippet congelado (título/alt/categoria) — a troca no config NÃO tem efeito ` +
    `nesta edição. Pra aplicar: ${fix}. Se a troca não era pra esta edição, ignore.`
  );
}
