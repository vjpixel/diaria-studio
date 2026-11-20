/**
 * video-decupagem-gate.ts (#13600) — a decupagem da `/diaria-video-montagem`
 * deixou de ser parada obrigatória (Gate 1). Decisão do editor de 18/11/2026:
 * a resposta dele no Gate 1 só mudaria algo se ele fosse regravar uma frase, e
 * ele não regrava depois do bruto. As decisões do Gate 1 já têm critério
 * (tomada pela direção/emenda/última completa, corte da vertical proposto na
 * própria decupagem, espelhamento pelo metadado da câmera e pelo `frame`,
 * tomada colapsada pelo `retranscribe`), e a revisão editorial inteira fica
 * no Gate 2 (roteiro das duas versões + fact-check da fala).
 *
 * Este módulo decide, a partir do que a 2ª passada da `decupagem` já sabe,
 * se a skill **segue** direto para o `blocks.json` e o roteiro (com um banner
 * das premissas) ou **para** — só nas exceções que o Gate 2 não resolve bem:
 *
 * - tomada colapsada que o `retranscribe` não separou, numa linha que vai ao
 *   ar ("usar"/"alternativa");
 * - linha "usar" que contraria o comentário da direção sem motivo no `reason`;
 * - bruto sem metadado de câmera com o espelhamento ambíguo que o `frame`
 *   lado a lado não desfez (a skill informa isso com `--espelho-ambiguo`).
 *
 * Puro, sem I/O.
 */

import type { ListingOrigin } from "./video-decupagem-collapsed.ts";
import type { TakeDecision } from "./video-montage.ts";
import type { ContraDirecao, DecupagemPlan } from "./video-montage-docs.ts";

export type Gate1StopKind = "tomada-colapsada" | "contra-direcao" | "espelhamento-ambiguo";

export interface Gate1Stop {
  kind: Gate1StopKind;
  detail: string;
}

export interface Gate1Input {
  plan: DecupagemPlan;
  /** A listagem congelada (`decupagem-segments.json`); `null` = plano anterior ao #13587. */
  origin: ReadonlyArray<ListingOrigin> | null;
  /** Plano anterior ao #13587 (sem `origin`): os segmentos (1-based) com suspeita de tomada colapsada. */
  legacyCollapsed?: ReadonlyArray<number>;
  contraDirecao: ReadonlyArray<ContraDirecao>;
  mirror: {
    /** A premissa em uma linha (`mirroredPremise`). */
    premise: string;
    /** Sem metadado de câmera que decida (algum arquivo do bruto). */
    ambiguous: boolean;
    /** A skill conferiu o `frame` lado a lado e ele não decidiu (`--espelho-ambiguo`). */
    frameUnresolved: boolean;
  };
  /** As tomadas "usar" com o critério que decidiu, uma linha por frase (já formatadas). */
  takes: ReadonlyArray<string>;
  /** Versões com a duração estimada da montagem sugerida (`overS > 0` = passa do teto). */
  durations: ReadonlyArray<{ name: string; totalS: number; overS: number }>;
  /** Teto da vertical (s), para a frase do corte. */
  verticalMaxS: number;
  /** Loudness do bruto em uma linha, ou null sem medida. */
  loudness: string | null;
  /** Quantas linhas "alternativa" (dúvida real, vai para o Gate 2 como opção A/B). */
  alternativas: number;
}

export interface Gate1Decision {
  decision: "segue" | "para";
  stops: Gate1Stop[];
  premissas: string[];
}

/** Estado de tomada colapsada de uma linha da listagem: o campo do #13600 ou, na listagem anterior, pela nota. */
export function collapsedStatus(o: ListingOrigin | undefined): "nao-separada" | "falso-comeco" | null {
  if (!o) return null;
  if (o.collapsed) return o.collapsed;
  if (o.retranscribed || !o.note) return null;
  if (/^falso começo/.test(o.note)) return "falso-comeco";
  return /tomada colapsada/.test(o.note) ? "nao-separada" : null;
}

const ON_AIR = new Set(["usar", "alternativa"]);

/** A decisão do Gate 1 (#13600): segue com as premissas, ou para numa exceção. */
export function decupagemGate(input: Gate1Input): Gate1Decision {
  const stops: Gate1Stop[] = [];
  const legacy = new Set(input.legacyCollapsed ?? []);
  for (const b of input.plan.blocks) {
    b.rows.forEach((r, j) => {
      if (!ON_AIR.has(r.suggestion)) return;
      for (const s1 of r.segments) {
        const st = input.origin ? collapsedStatus(input.origin[s1 - 1]) : legacy.has(s1) ? "nao-separada" : null;
        if (st === "nao-separada") {
          stops.push({
            kind: "tomada-colapsada",
            detail: `${b.key}.rows[${j}] ("${r.suggestion}"): segmento ${s1} com tomada colapsada que o retranscribe não separou${input.origin?.[s1 - 1]?.note ? ` (${input.origin[s1 - 1].note})` : ""}; ouvir o trecho e decidir a tomada`,
          });
        }
      }
    });
  }
  for (const c of input.contraDirecao) {
    if (c.reason) continue;
    stops.push({
      kind: "contra-direcao",
      detail: `${c.label}: "usar" no segmento ${c.segment}, mas a direção aprovou o segmento ${c.approved}, sem motivo no reason`,
    });
  }
  if (input.mirror.ambiguous && input.mirror.frameUnresolved) {
    stops.push({ kind: "espelhamento-ambiguo", detail: `bruto sem metadado de câmera e o frame lado a lado não decidiu: ${input.mirror.premise}` });
  }

  const premissas: string[] = [];
  // #13742: a tomada que a janela de cauda separou sai sem o editor ouvir; a premissa diz qual e onde conferir.
  for (const b of input.plan.blocks) {
    b.rows.forEach((r, j) => {
      if (!ON_AIR.has(r.suggestion)) return;
      for (const s1 of r.segments) {
        const o = input.origin?.[s1 - 1];
        if (o?.tail) premissas.push(`Tomada colapsada resolvida pela cauda, ${b.key}.rows[${j}] (segmento ${s1}): ${o.note ?? "a última tomada"}`);
      }
    });
  }
  if (input.takes.length) premissas.push(`Tomadas por frase (${input.takes.length}):`, ...input.takes.map((t) => `  - ${t}`));
  for (const c of input.contraDirecao) if (c.reason) premissas.push(`Contraria a direção com motivo: ${c.label}, segmento ${c.segment} (a direção aprovou o ${c.approved}): ${c.reason}`);
  if (input.alternativas) premissas.push(`${input.alternativas} linha(s) "alternativa": nenhum critério decidiu; vão ao Gate 2 como opção A/B`);
  for (const d of input.durations) {
    premissas.push(
      d.overS > 0
        ? `${d.name}: ~${d.totalS.toFixed(1)} s na montagem sugerida, ${d.overS.toFixed(1)} s acima do teto de ${input.verticalMaxS} s: o corte proposto na decupagem entra no blocks.json`
        : `${d.name}: ~${d.totalS.toFixed(1)} s na montagem sugerida`,
    );
  }
  premissas.push(`Espelhamento: ${input.mirror.premise}`);
  premissas.push(`Loudness: ${input.loudness ?? "sem medida (loudness.json ausente)"}`);
  premissas.push("Enquadramento: o face mede o rosto por item depois do blocks.json; sem medida, o default da 261027 (faceX 0,482, eyeY 0,537)");
  return { decision: stops.length ? "para" : "segue", stops, premissas };
}

/**
 * Uma linha por linha "usar" do plano: bloco, segmentos e o critério que
 * decidiu (o `reason` da linha vence; senão a decisão por critério da
 * listagem, `decideTakes`; segmento sem tomada repetida = "tomada única").
 */
export function decupagemTakeLines(plan: DecupagemPlan, bySegment: ReadonlyMap<number, Pick<TakeDecision, "suggestion" | "reason" | "group">>): string[] {
  const out: string[] = [];
  for (const b of plan.blocks) {
    for (const r of b.rows) {
      if (r.suggestion !== "usar") continue;
      const why = r.reason?.trim() || r.segments.map((s1) => {
        const d = bySegment.get(s1 - 1);
        if (!d || d.group.length < 2) return "tomada única";
        const nth = `${d.group.indexOf(s1 - 1) + 1}ª de ${d.group.length} tomadas`;
        return d.suggestion === "usar" ? `${nth}, ${d.reason}` : `${nth}, escolha da decupagem (o critério sugeria cortar: ${d.reason})`;
      }).join("; ");
      out.push(`${b.key}: segmento(s) ${r.segments.join(", ")}${r.falaId ? ` (${r.falaId})` : ""}: ${why}`);
    }
  }
  return out;
}

/** O banner da decupagem (#13600), para o stderr e o resumo ao editor. `docRef` = link do Doc ou o caminho do `decupagem.md`. */
export function decupagemGateBanner(d: Gate1Decision, docRef: string): string[] {
  const head =
    d.decision === "segue"
      ? "[premissa] Decupagem sem parada (#13600): segue para o blocks.json e o roteiro; a revisão editorial fica no Gate 2."
      : `[parada] Decupagem com ${d.stops.length} exceção(ões) que o Gate 2 não resolve (#13600): resolver com o editor antes do blocks.json.`;
  const out = [head, `Doc da decupagem (consulta): ${docRef}`];
  for (const s of d.stops) out.push(`  [${s.kind}] ${s.detail}`);
  out.push("Premissas assumidas:", ...d.premissas.map((p) => (p.startsWith("  ") ? p : `- ${p}`)));
  return out;
}
