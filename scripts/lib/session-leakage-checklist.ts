/**
 * session-leakage-checklist.ts (#5547 item 4)
 *
 * Checklist de qualidade editorial verificável programaticamente, a partir
 * dos "17 pontos" de vazamento de sessão mapeados pelo #5414: playbooks que
 * mandavam "setar em sessão"/"capturar como" um valor consumido só mais
 * tarde — quebra a premissa de rodar stages com contexto limpo (o cenário de
 * risco que a #5547 pede pra checar na edição de TRATAMENTO: "o Stage 4 não
 * lembra do Stage 1", será que existe algo que só vivia na conversa e não em
 * disco?).
 *
 * O #5414 (mergeado via #5429 + follow-ups #5436/#5438/#5479) fechou os 17
 * pontos com **3 módulos de estado em disco** cobrindo **9 valores
 * distintos** (17 é contagem de OCORRÊNCIAS em prosa nos playbooks — writes
 * + reads — não de valores distintos; ver #5414 corpo + #5430 comentário de
 * fechamento):
 *
 *   - `preflight-state.ts` (Stage 0 → consumido em Stage 0/2/5): chromeMcp,
 *     gmailMcp, beehiivMcp, clariceRest, cloudflareTokenOk.
 *   - `stage4-capture-state.ts` (Stage 4 §4c → gate §4d, mesmo stage):
 *     whatsappUrl, metaDescriptionSuggestion.
 *   - `eia-dispatch-state.ts` (Stage 1 → Stage 3): eiaBashId (informational,
 *     só útil na mesma sessão — `null` cross-session é ESPERADO, não falha),
 *     eiaDispatchedAt (usado pelo timeout de 10min do Stage 3 — precisa
 *     sobreviver a sessão nova).
 *
 * `checkPersistedStateCompleteness` verifica, sobre a edição de TRATAMENTO,
 * que os 3 arquivos de estado existem e os campos que DEVERIAM estar
 * preenchidos ao fim de um run completo estão de fato preenchidos — sinal
 * mecânico de que o mecanismo de persistência funcionou nesta edição
 * específica, não só "existe em algum lugar do código".
 *
 * `findUncoveredSessionValueMentions` faz o complemento: escaneia os
 * playbooks `orchestrator-stage-*.md` atrás de NOVOS candidatos — o "há
 * outros?" que o #5414 deixou em aberto — via os mesmos verbos de prosa que
 * levaram aos 9 valores conhecidos ("armazenar como", "capturar como",
 * "guardar/manter/setar em sessão"). Um match sem marcador `#5414` (nem na
 * mesma linha nem nas 2 linhas seguintes, onde o padrão real sempre colocou
 * a referência) é um candidato NÃO investigado — não é veredito automático
 * de "isto é um bug", é uma lista pra triagem humana, mecanicamente
 * derivada em vez de prosa pra reler (ver `#5547 item 4`). Um candidato
 * marcado pode ainda ser de baixo risco (ex: valor trivialmente
 * recomputável em 1 linha, como `edition_iso`/`anchor_iso` do Stage 0 —
 * achado ao vivo ao escrever este módulo) — a triagem decide, o scan só
 * lista.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readPreflightState } from "./preflight-state.ts";
import { readStage4CaptureState } from "./stage4-capture-state.ts";
import { readEiaDispatchState } from "./eia-dispatch-state.ts";

export interface LeakageValueCheck {
  key: string;
  state_file: string;
  present: boolean;
  ok: boolean;
  /** `true` quando `null`/ausente é ESPERADO (ex: `eiaBashId` cross-sessão)
   * — presente para não confundir "falhou" com "não se aplica aqui". */
  optional: boolean;
  note?: string;
}

/**
 * Verifica, sobre `editionDir` (a edição de TRATAMENTO, já rodada), que os 9
 * valores conhecidos do #5414 foram de fato persistidos em disco — não só
 * que o mecanismo existe no código. Puro dado o `editionDir` (delega toda
 * leitura de arquivo aos `read*State` já testados por #5414).
 */
export function checkPersistedStateCompleteness(editionDir: string): LeakageValueCheck[] {
  const preflight = readPreflightState(editionDir);
  const stage4 = readStage4CaptureState(editionDir);
  const eia = readEiaDispatchState(editionDir);

  const checks: LeakageValueCheck[] = [
    {
      key: "preflight.capturedAt",
      state_file: "_internal/preflight-state.json",
      present: preflight.capturedAt != null,
      ok: preflight.capturedAt != null,
      optional: false,
      note: preflight.capturedAt == null ? "Stage 0 nunca gravou o preflight-state nesta edição." : undefined,
    },
    ...(["chromeMcp", "gmailMcp", "beehiivMcp", "clariceRest", "cloudflareTokenOk"] as const).map((k) => ({
      key: `preflight.${k}`,
      state_file: "_internal/preflight-state.json",
      present: preflight[k] != null,
      ok: preflight[k] != null,
      optional: false,
      note: preflight[k] == null ? `Sinal ${k} nunca foi apurado/gravado pelo Stage 0 nesta edição.` : undefined,
    })),
    {
      key: "stage4.capturedAt",
      state_file: "_internal/stage4-capture-state.json",
      present: stage4.capturedAt != null,
      ok: stage4.capturedAt != null,
      optional: false,
      note: stage4.capturedAt == null ? "Stage 4 nunca gravou o stage4-capture-state nesta edição." : undefined,
    },
    {
      key: "stage4.whatsappUrl",
      state_file: "_internal/stage4-capture-state.json",
      present: stage4.whatsappUrl != null,
      ok: stage4.whatsappUrl != null,
      optional: false,
      note: stage4.whatsappUrl == null ? "§4c.1b nunca computou/persistiu whatsapp_url nesta edição." : undefined,
    },
    {
      key: "stage4.metaDescriptionSuggestion",
      // '' é um valor legítimo já computado (sem sugestão aproveitável) —
      // só `null` significa "nunca computado" (ver docstring do módulo).
      state_file: "_internal/stage4-capture-state.json",
      present: stage4.metaDescriptionSuggestion != null,
      ok: stage4.metaDescriptionSuggestion != null,
      optional: false,
      note:
        stage4.metaDescriptionSuggestion == null
          ? "§4c.1c nunca computou/persistiu meta_description_suggestion nesta edição."
          : undefined,
    },
    {
      key: "eia.dispatchedAt",
      state_file: "_internal/eia-dispatch-state.json",
      present: eia.dispatchedAt != null,
      ok: eia.dispatchedAt != null,
      optional: false,
      note: eia.dispatchedAt == null ? "Stage 1 §1a-bis nunca dispatchou/persistiu o É IA? nesta edição." : undefined,
    },
    {
      key: "eia.bashId",
      state_file: "_internal/eia-dispatch-state.json",
      present: eia.bashId != null,
      // Sempre ok — `null` cross-sessão é o caso ESPERADO (docstring de
      // eia-dispatch-state.ts: "só útil dentro da MESMA sessão que o criou").
      ok: true,
      optional: true,
      note: eia.bashId == null ? "null é esperado quando Stage 3 rodou em sessão diferente do Stage 1." : undefined,
    },
  ];

  return checks;
}

export interface UncoveredMention {
  file: string;
  line: number;
  text: string;
}

const LEAKAGE_PATTERN = /armazenar como|capturar como|guardar em sess[ãa]o|manter em sess[ãa]o|setar em sess[ãa]o|reter em sess[ãa]o/i;
const COVERAGE_MARKER = /#5414/;
/** Janela de linhas (a partir do match, inclusive) em que o marcador de
 * cobertura é procurado — o padrão real sempre colocou "(#5414)" na mesma
 * linha ou na frase imediatamente seguinte (ver exemplos no cabeçalho). */
const COVERAGE_WINDOW = 3;

/**
 * Escaneia `orchestrator-stage-*.md` (não recursivo — são os únicos
 * playbooks de stage do pipeline diário) atrás de menções de "valor de
 * sessão" sem marcador de cobertura próximo. Puro dado `agentsDir`
 * (testável com fixtures, sem depender do repo real).
 */
export function findUncoveredSessionValueMentions(agentsDir: string): UncoveredMention[] {
  if (!existsSync(agentsDir)) return [];
  const files = readdirSync(agentsDir).filter((f) => /^orchestrator-stage-\d.*\.md$/.test(f));
  const out: UncoveredMention[] = [];
  for (const file of files) {
    const fullPath = join(agentsDir, file);
    const lines = readFileSync(fullPath, "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!LEAKAGE_PATTERN.test(lines[i])) continue;
      const windowEnd = Math.min(lines.length, i + COVERAGE_WINDOW);
      const window = lines.slice(i, windowEnd).join(" ");
      if (COVERAGE_MARKER.test(window)) continue;
      out.push({ file, line: i + 1, text: lines[i].trim() });
    }
  }
  return out;
}

export interface SessionLeakageReport {
  edition: string;
  persisted_state: LeakageValueCheck[];
  uncovered_mentions: UncoveredMention[];
  clean: boolean;
}

export function buildSessionLeakageReport(editionDir: string, editionId: string, agentsDir: string): SessionLeakageReport {
  const persisted = checkPersistedStateCompleteness(editionDir);
  const uncovered = findUncoveredSessionValueMentions(agentsDir);
  return {
    edition: editionId,
    persisted_state: persisted,
    uncovered_mentions: uncovered,
    clean: persisted.every((c) => c.ok) && uncovered.length === 0,
  };
}
