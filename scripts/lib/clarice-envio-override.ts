/**
 * scripts/lib/clarice-envio-override.ts (#5515)
 *
 * **Dormente desde #6793 "Faixa B" item 2 (01/09/2026):** `decideBrake`
 * nunca mais produz `"stop"` sozinho, e este módulo só age quando
 * `brake.level === "stop"` — sem `stop` pra rebaixar, o override não tem
 * mais efeito no caminho automático. Ferramenta do editor, não removida.
 *
 * Mecanismo de override PERSISTENTE pro freio automático de envio Clarice
 * (`clarice-envio-risk.ts` 19:00 BRT + `clarice-envio-guard.ts` 05:00 BRT,
 * #5026/#5220). Sem isto, uma correção manual do editor ("este STOP é
 * falso-positivo, ver #5487") só vale pro CICLO atual — o próximo ciclo
 * recomputa o freio do zero e pode reverter a decisão do editor sem alarme
 * distinguível de um cancelamento correto (#5513).
 *
 * Mesmo padrão de `clarice-envio-enabled.ts` (kill switch já existente):
 * JSON dedicado sob `data/`, leitura fail-soft (nunca lança), CLI simples
 * pra escrever/limpar. **Divergência deliberada em relação àquele módulo:**
 * lá "ausente" e "presente mas inválido" recebem defaults OPOSTOS por causa
 * do blast radius de uma automação de envio em massa; aqui os dois colapsam
 * no MESMO resultado (`null` = "sem override ativo, freio decide sozinho")
 * porque este mecanismo só pode REBAIXAR risco (stop→hold), nunca elevá-lo
 * — não existe um "lado perigoso" pra falhar, então não existe divergência
 * de default a proteger.
 *
 * Restrições de desenho (decisão do editor, issue #5515 — NÃO reabrir aqui):
 *   1. `brake` só pode ser `"hold"`. Um arquivo com `brake: "ok"` (editado
 *      manualmente, ou gerado por engano) é tratado como INVÁLIDO — nunca
 *      autoriza a automação a pular de STOP/HOLD calculado direto pra OK.
 *      O pior caso deste mecanismo mal-usado é sempre "manda o mesmo volume
 *      de sempre", nunca "acelera sobre risco não confirmado".
 *   2. `until` é OBRIGATÓRIO. Sem prazo, um override vira kill switch
 *      permanente do freio por esquecimento — teto sugerido ~48h (não
 *      travado em código, é o operador que escolhe o `--until` na hora de
 *      criar).
 *   3. Expirado (`until` no passado, relativo ao `now` injetado) é
 *      IGNORADO SILENCIOSAMENTE — freio volta a decidir sozinho. Isto é o
 *      comportamento CORRETO: voltar ao normal não é um erro, não alarma.
 *   4. Enquanto ATIVO, o override nunca é silencioso — `applyEnvioOverride`
 *      (abaixo) sempre anexa uma razão legível ao `BrakeDecision.reasons`
 *      explicando que o STOP real foi rebaixado, com motivo/prazo/issue.
 *
 * Consumido por `clarice-envio-risk.ts` (`fetchRiskSnapshot`, ponto único
 * de cálculo do freio — as DUAS metades do par 19:00/05:00 leem o freio
 * daquele mesmo script, seja por import direto ou via subprocess) e
 * também consultado diretamente por `clarice-envio-guard.ts` na decisão de
 * cancelar (defesa em profundidade — ver docstring de `applyEnvioOverride`).
 *
 * Uso CLI:
 *   npx tsx scripts/lib/clarice-envio-override.ts
 *   # → imprime o override ativo (JSON) ou "sem override ativo"
 *   npx tsx scripts/lib/clarice-envio-override.ts --set --until 2026-08-18T09:00:00.000Z --reason "pico de campanha de 27/06 (#5487) confirmado falso-positivo" --issue 5487
 *   npx tsx scripts/lib/clarice-envio-override.ts --clear
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { getIntArg, getStringArg, hasFlag, isMainModule } from "./cli-args.ts";
import type { BrakeDecision } from "./clarice-envio-policy.ts";
import {
  clearWaitUntilMarkerOnIssue,
  readIssueRefForClear,
  syncWaitUntilMarkerOnIssue,
  type GhRunFn,
} from "./wait-until-sync.ts";
import { spawnGhSync } from "./shared/gh-run.ts";

/** `brake` é um literal de 1 valor de propósito — ver restrição 1 na
 * docstring do módulo. O tipo por si só já impede `setClariceEnvioOverride`
 * de aceitar `"ok"`/`"stop"` em TypeScript; a validação em runtime (leitura
 * de um arquivo escrito à mão, ou por uma versão futura descuidada do
 * escritor) é o que protege o caminho que o compilador não alcança. */
export interface ClariceEnvioOverrideState {
  readonly brake: "hold";
  /** ISO — teto do override. Obrigatório; expirado = ignorado (ver módulo). */
  readonly until: string;
  readonly reason: string;
  readonly decidedBy: string;
  /** Issue GitHub que motivou a decisão — sempre citada no relatório. */
  readonly issueRef: number;
  readonly createdAt: string;
}

export interface ReadClariceEnvioOverrideOptions {
  /** Chamado quando o arquivo EXISTE mas não deu pra interpretar (JSON
   * inválido, shape errado, `brake` != "hold", `until` não-parseável) —
   * NUNCA chamado por expiração normal (restrição 3: silêncio ali é
   * correto). Default `console.warn`. */
  onInvalid?: (message: string) => void;
}

function statePath(rootDir: string): string {
  return resolve(rootDir, "data", "clarice-envio-override.json");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `until` inválido (não-parseável) é tratado como ILEGÍVEL, não como
 * "sempre expirado" — um `until` quebrado é sinal de escrita malformada
 * (mesma classe de "presente mas inválido" dos outros módulos-irmão), e o
 * caller precisa do aviso pra corrigir, não um silêncio que parece
 * "nenhum override foi criado". */
function parseUntil(until: unknown): number | null {
  if (typeof until !== "string" || until.trim() === "") return null;
  const ms = Date.parse(until);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Lê o override ativo. Fail-soft total — nunca lança.
 *   - arquivo ausente → `null`, sem aviso (caso normal).
 *   - presente, válido, `until` no FUTURO relativo a `now` → o estado.
 *   - presente, válido, `until` no PASSADO → `null`, SEM aviso (restrição
 *     3 — expiração é silenciosa por design).
 *   - presente mas ilegível/inválido (JSON quebrado, shape errado, `brake`
 *     diferente de `"hold"`, `until` não-parseável) → `null`, COM aviso via
 *     `opts.onInvalid` — isto é sinal de PROBLEMA, nunca de intenção.
 */
export function readClariceEnvioOverrideState(
  rootDir: string,
  now: Date,
  opts: ReadClariceEnvioOverrideOptions = {},
): ClariceEnvioOverrideState | null {
  const warn = opts.onInvalid ?? ((m: string) => console.warn(m));
  const p = statePath(rootDir);
  if (!existsSync(p)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    warn(
      `[clarice-envio-override] ${p} existe mas não deu pra ler/parsear (${(e as Error).message}) — ` +
        `tratando como SEM OVERRIDE (fail-soft). Conserte o arquivo ou rode ` +
        `\`npx tsx scripts/lib/clarice-envio-override.ts --clear\` pra removê-lo.`,
    );
    return null;
  }

  if (!isPlainObject(raw)) {
    warn(`[clarice-envio-override] ${p} existe mas não é um objeto JSON — tratando como SEM OVERRIDE (fail-soft).`);
    return null;
  }

  if (raw.brake !== "hold") {
    warn(
      `[clarice-envio-override] ${p} tem "brake": ${JSON.stringify(raw.brake)} — só "hold" é aceito ` +
        `(restrição deliberada, #5515: este mecanismo nunca destrava "ok"). Tratando como SEM OVERRIDE.`,
    );
    return null;
  }

  const untilMs = parseUntil(raw.until);
  if (untilMs === null) {
    warn(
      `[clarice-envio-override] ${p} tem "until" ausente ou não-parseável (${JSON.stringify(raw.until)}) — ` +
        `campo é OBRIGATÓRIO (restrição #5515). Tratando como SEM OVERRIDE.`,
    );
    return null;
  }

  if (typeof raw.reason !== "string" || raw.reason.trim() === "") {
    warn(`[clarice-envio-override] ${p} sem "reason" (obrigatório) — tratando como SEM OVERRIDE.`);
    return null;
  }

  if (typeof raw.issueRef !== "number" || !Number.isInteger(raw.issueRef)) {
    warn(`[clarice-envio-override] ${p} sem "issueRef" numérico (obrigatório) — tratando como SEM OVERRIDE.`);
    return null;
  }

  // Expirado: SILENCIOSO (restrição 3) — nunca chega aqui via `warn`.
  if (untilMs <= now.getTime()) return null;

  return {
    brake: "hold",
    until: raw.until as string,
    reason: raw.reason,
    decidedBy: typeof raw.decidedBy === "string" && raw.decidedBy.trim() !== "" ? raw.decidedBy : "editor",
    issueRef: raw.issueRef,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date(0).toISOString(),
  };
}

/** Escreve o override — único ponto de escrita. Cria `data/` se ausente.
 * Propaga erro de escrita real (disco cheio, permissão) — nunca fail-soft
 * na ESCRITA, mesma disciplina de `clarice-envio-enabled.ts`. */
export function setClariceEnvioOverride(
  rootDir: string,
  state: Omit<ClariceEnvioOverrideState, "brake">,
): ClariceEnvioOverrideState {
  const full: ClariceEnvioOverrideState = { brake: "hold", ...state };
  if (parseUntil(full.until) === null) {
    throw new Error(`--until inválido (${JSON.stringify(full.until)}) — precisa ser uma data ISO parseável.`);
  }
  const p = statePath(rootDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileAtomic(p, JSON.stringify(full, null, 2) + "\n");
  return full;
}

/** Remove o override (idempotente — arquivo ausente não é erro). */
export function clearClariceEnvioOverride(rootDir: string): void {
  const p = statePath(rootDir);
  if (existsSync(p)) unlinkSync(p);
}

// ---------------------------------------------------------------------------
// Aplicação sobre um BrakeDecision já calculado.
// ---------------------------------------------------------------------------

export interface EnvioOverrideApplication {
  /** `BrakeDecision` efetivo — igual ao de entrada quando o override não se
   * aplica (ausente/expirado/o freio calculado não era `stop`). */
  readonly brake: BrakeDecision;
  /** `true` só quando o override REBAIXOU um `stop` calculado — nunca
   * `true` por override presente mas irrelevante (freio já era ok/hold). */
  readonly overrideApplied: boolean;
}

/**
 * Aplica um override JÁ LIDO (via `readClariceEnvioOverrideState`) sobre um
 * `BrakeDecision` calculado por `decideBrake`. Função pura — não lê disco,
 * não injeta `now` (isso já aconteceu na leitura) — só decide se e como
 * rebaixar.
 *
 * **Nunca destrava `ok`** (restrição 1): só age quando `brake.level ===
 * "stop"`. Um freio que já calculou `hold`/`ok` sai IDÊNTICO — mesmo
 * objeto, `overrideApplied: false`.
 *
 * **Nunca esconde o STOP real** (restrição 4): quando aplica, o `reasons`
 * resultante começa com uma linha de override explícita — citando motivo,
 * prazo e issue — seguida das razões ORIGINAIS que produziram o STOP
 * calculado. O relatório (`clarice-envio-run.ts`/`clarice-envio-guard.ts`
 * só imprimem `brake.level` + `brake.reasons.join(" ")`) mostra os dois
 * sem precisar de nenhuma mudança no código de relatório.
 *
 * Chamada em DOIS pontos deliberadamente (defesa em profundidade, #5515):
 * `clarice-envio-risk.ts` (`fetchRiskSnapshot`, fonte única do freio —
 * cobre as duas metades do par por elas consumirem o mesmo script) E
 * `clarice-envio-guard.ts` (antes de decidir cancelar onda pendente) — a
 * 2ª chamada é IDEMPOTENTE quando a 1ª já rebaixou (o freio recebido já não
 * é mais `"stop"`, então esta função vira no-op), então nunca duplica a
 * razão de override no relatório do guard.
 */
export function applyEnvioOverride(
  brake: BrakeDecision,
  override: ClariceEnvioOverrideState | null,
): EnvioOverrideApplication {
  if (!override || brake.level !== "stop") {
    return { brake, overrideApplied: false };
  }
  const overrideReason =
    `⚠️  OVERRIDE do editor: freio calculado seria STOP, rebaixado para HOLD. ` +
    `Motivo: ${override.reason}. Decidido por: ${override.decidedBy}. ` +
    `Expira em: ${override.until}. Ver issue #${override.issueRef}.`;
  return {
    brake: {
      level: "hold",
      reasons: [overrideReason, ...brake.reasons],
      maxUtil: brake.maxUtil,
    },
    overrideApplied: true,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Saída injetável pra teste — produção sempre usa `console` (default). */
export interface CliIO {
  log: (message: string) => void;
  warn: (message: string) => void;
}

const defaultCliIo: CliIO = { log: (m) => console.log(m), warn: (m) => console.warn(m) };

/**
 * Corpo executável da CLI (`--set`/`--clear`/leitura), extraído do guard
 * `isMainModule` (#5729, self-review do fleet: sem esta extração, nada testava
 * o WIRING — só as funções de biblioteca chamadas diretamente. O revisor
 * removeu a chamada de `syncWaitUntilMarkerOnIssue` do branch `--set` como
 * prova, e os 20 testes originais continuaram todos verdes; alguém podia
 * reverter a integração de 2 linhas do #5724 e o CI nunca perceberia).
 * `ghRun`/`io` injetáveis (mesmo padrão de `GhRunFn`) pra testar sem rede —
 * produção sempre usa `spawnGhSync`/`console` (defaults).
 *
 * Devolve o exit code: `0` em sucesso completo; `2` quando o override LOCAL
 * foi gravado/removido com sucesso mas a sincronização do marcador na issue
 * falhou ou não pôde ser determinada — nunca silencioso (#738), e nunca
 * reverte o efeito local já aplicado (esse é sempre o passo anterior,
 * irreversível por esta função).
 */
export function runCli(argv: string[], cwd: string, ghRun: GhRunFn = spawnGhSync, io: CliIO = defaultCliIo): number {
  if (hasFlag(argv, "clear")) {
    // Lido ANTES de apagar o arquivo (#5724) — `--clear` também limpa o
    // marcador `aguardando-ate:` da issue que o override tinha referenciado,
    // senão uma issue revogada antes do prazo natural fica presa em
    // `agendada` até a data que não vale mais nada.
    let invalidReason: string | undefined;
    const issueRefToClear = readIssueRefForClear(cwd, {
      onInvalid: (m) => {
        invalidReason = m;
      },
    });
    clearClariceEnvioOverride(cwd);
    io.log("cleared");

    if (invalidReason !== undefined) {
      // Arquivo local existia mas estava ilegível — "cleared" acima é
      // verdade (o arquivo foi removido), mas NUNCA fica sozinho/ambíguo:
      // sem saber o issueRef, não há como saber se sobrou marcador obsoleto
      // numa issue (achado do self-review — antes disso, esse caso imprimia
      // só "cleared" e nada mais, indistinguível do caminho feliz).
      io.warn(
        `[clarice-envio-override] override local removido, mas NÃO FOI POSSÍVEL determinar a issue a limpar ` +
          `(arquivo ilegível) — verifique manualmente se ficou marcador "aguardando-ate:" obsoleto em alguma ` +
          `issue. Detalhe: ${invalidReason}`,
      );
      return 2;
    }

    if (issueRefToClear !== undefined) {
      const marker = clearWaitUntilMarkerOnIssue(issueRefToClear, cwd, ghRun);
      if (!marker.ok) {
        io.warn(
          `[clarice-envio-override] override limpo, marcador NÃO removido da issue #${issueRefToClear}: ${marker.error}`,
        );
        return 2;
      }
    }
    return 0;
  }

  if (hasFlag(argv, "set")) {
    const until = getStringArg(argv, "until", { example: "2026-08-18T09:00:00.000Z" });
    const reason = getStringArg(argv, "reason", { example: "pico de campanha confirmado falso-positivo" });
    const issue = getIntArg(argv, "issue", { min: 1 });
    const decidedBy = getStringArg(argv, "decided-by", { example: "editor" }) ?? "editor";
    if (!until) throw new Error("--set requer --until ISO (ex: --until 2026-08-18T09:00:00.000Z).");
    if (!reason) throw new Error("--set requer --reason \"...\".");
    if (issue === undefined) throw new Error("--set requer --issue N (issue GitHub que motivou a decisão).");
    const state = setClariceEnvioOverride(cwd, {
      until,
      reason,
      decidedBy,
      issueRef: issue,
      createdAt: new Date().toISOString(),
    });
    io.log(JSON.stringify(state, null, 2));
    // Override local é a função PRIMÁRIA do comando — já gravado acima e
    // NUNCA revertido por falha aqui (#5724, no espírito do #738: fail-soft
    // com warning inequívoco, nunca silêncio).
    const marker = syncWaitUntilMarkerOnIssue(issue, until, cwd, ghRun);
    if (!marker.ok) {
      io.warn(
        `[clarice-envio-override] override gravado, marcador NÃO sincronizado na issue #${issue}: ${marker.error}`,
      );
      return 2;
    }
    return 0;
  }

  const state = readClariceEnvioOverrideState(cwd, new Date());
  io.log(state ? JSON.stringify(state, null, 2) : "sem override ativo");
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2), process.cwd());
}
