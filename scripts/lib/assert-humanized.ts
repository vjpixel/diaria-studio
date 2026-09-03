/**
 * assert-humanized.ts (#1385)
 *
 * Gate de Stage 2: assert que `02-reviewed.md` E `03-social.md` passaram
 * pelo humanizador (skill anthropic-skills:humanizador) antes do orchestrator
 * avançar.
 *
 * Critério mecânico: existência de snapshots pre-humanizer com mtime mais
 * recente do que o arquivo final. Sem isso, humanizador foi pulado.
 *
 * Caso real 260519: editor pulou humanizer no social por causa de timeout
 * Clarice — `03-social.md` saiu sem passar pelo humanizer. Padrões de IA
 * (travessões, negações paralelas, "ponto central", etc) ficaram no copy
 * final. Sem snapshot, gate aqui detecta retroativamente.
 *
 * Uso:
 *   import { assertHumanized } from "./lib/assert-humanized.ts";
 *   const r = assertHumanized("data/editions/260519");
 *   if (!r.ok) { ... halt ... }
 *
 * Pure-ish (file system reads only) — usável em invariant check.
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

export interface HumanizedCheck {
  ok: boolean;
  missing: Array<{
    final: string;
    snapshot: string;
    reason: "snapshot_missing" | "snapshot_stale" | "final_missing";
  }>;
}

export interface SnapshotPair {
  /** Path final relativo ao editionDir (ex: "02-reviewed.md") */
  final: string;
  /** Path do snapshot pre-humanizer relativo ao editionDir */
  snapshot: string;
  /**
   * Path opcional (relativo ao editionDir) cujo mtime substitui o de `final`
   * na comparação de staleness (#7230). Use quando `final` legitimamente
   * continua mudando bem depois do humanizador — o gate humano do erro
   * intencional (`render-erro-intencional.ts` → editor preenche o campo)
   * toca `02-reviewed.md` de novo, e pode demorar horas sem que isso
   * signifique "humanizer pulado". Um anchor gravado 1x, logo após o passo
   * que importa (aqui: o snapshot pré-Clarice, escrito minutos depois do
   * humanizador), decorrelaciona a checagem do tempo que o humano leva no
   * gate. Ausente → cai no comportamento legado (compara contra `final`).
   */
  anchor?: string;
}

/**
 * Pares padrão checked em Stage 2:
 * - Newsletter: 02-reviewed.md vs _internal/02-humanized.md (existe se humanizer rodou ANTES de Clarice),
 *   ancorado em _internal/02-pre-clarice.md (#7230 — ver docstring de `anchor` acima)
 * - Social: 03-social.md vs _internal/03-social-pre-humanizador.md (existe se humanizer rodou)
 *
 * Convenção dos arquivos snapshot existe há tempo no playbook
 * (orchestrator-stage-2.md §2b/§2c). Esta função só assert.
 */
export const DEFAULT_SNAPSHOT_PAIRS: SnapshotPair[] = [
  {
    final: "02-reviewed.md",
    snapshot: "_internal/02-humanized.md",
    anchor: "_internal/02-pre-clarice.md",
  },
  { final: "03-social.md", snapshot: "_internal/03-social-pre-humanizador.md" },
];

/**
 * Pure: dado editionDir + lista de pares, retorna `{ ok, missing[] }`.
 *
 * Regras:
 * - Se final ausente → `final_missing` (pode ser stage não rodou ainda)
 * - Se snapshot ausente → `snapshot_missing` (humanizer pulado)
 * - Se snapshot.mtime <= 0 ou final ausente: skip
 * - Se anchor.mtime > snapshot.mtime + 1h → `snapshot_stale` (snapshot é de
 *   run anterior; humanizer não rodou no run atual). 1h tolerance pra
 *   cobrir edição manual leve pós-humanizer. `anchor` é `pair.anchor` quando
 *   presente e existente no disco, senão `final` (comportamento legado) —
 *   ver docstring de `SnapshotPair.anchor` (#7230): usar `final` sem anchor
 *   faz a checagem medir "quanto tempo o humano levou depois", não "o
 *   humanizer rodou nesta run", quando `final` segue sendo editado por um
 *   gate humano longo (ex: preenchimento do erro intencional).
 *
 * Ordem: missing array preserva ordem dos pares passed.
 */
export function assertHumanized(
  editionDir: string,
  pairs: SnapshotPair[] = DEFAULT_SNAPSHOT_PAIRS,
): HumanizedCheck {
  const missing: HumanizedCheck["missing"] = [];
  for (const pair of pairs) {
    const finalPath = resolve(editionDir, pair.final);
    const snapPath = resolve(editionDir, pair.snapshot);
    if (!existsSync(finalPath)) {
      // Stage ainda não produziu — não é falha de humanizer
      continue;
    }
    if (!existsSync(snapPath)) {
      missing.push({
        final: pair.final,
        snapshot: pair.snapshot,
        reason: "snapshot_missing",
      });
      continue;
    }
    const anchorPath = pair.anchor ? resolve(editionDir, pair.anchor) : finalPath;
    const anchorStat =
      pair.anchor && existsSync(anchorPath) ? statSync(anchorPath) : statSync(finalPath);
    const snapStat = statSync(snapPath);
    // 1h tolerance: edição manual leve pós-humanizer é OK
    const TOLERANCE_MS = 60 * 60 * 1000;
    if (anchorStat.mtimeMs > snapStat.mtimeMs + TOLERANCE_MS) {
      missing.push({
        final: pair.final,
        snapshot: pair.snapshot,
        reason: "snapshot_stale",
      });
    }
  }
  return { ok: missing.length === 0, missing };
}
