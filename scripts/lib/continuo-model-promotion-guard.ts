/**
 * scripts/lib/continuo-model-promotion-guard.ts (#7568)
 *
 * Converte em MECANISMO a recomendação que, até este PR, só existia em
 * prosa: `docs/goal-modelo-local-continuo.md` diz "não promover o modelo
 * local a primário do contínuo enquanto [o alarme de fabricação, #7537]
 * disparar" — mas nada no repo checava isso antes de escrever
 * `~/.hermes/config.yaml`. `scripts/write-hermes-config.ts` (o verbo único
 * de escrita de config do Hermes, #6817 item 3) é o único ponto por onde
 * uma futura sessão de `/goal` promoveria o modelo local a `model.default`
 * — este módulo é o miolo PURO do guard que ele passa a rodar
 * automaticamente sempre que o arquivo escrito é `config.yaml`.
 *
 * ## Escopo do guard
 *
 * Só bloqueia a transição ESPECÍFICA "`model.default` passa a apontar pro
 * modelo local" (`isLocalModelId` — heurística por padrão de nome: `qwen`,
 * prefixo `custom/`, prefixo `ollama/`, os três formatos vistos em
 * `docs/goal-modelo-local-continuo.md`). Qualquer outra escrita de
 * `config.yaml` (trocar `max_tokens`, mexer em `fallback_providers`, trocar
 * entre dois modelos PAGOS) passa direto — `detectsModelPromotionToLocal`
 * devolve `isPromotion: false` e o guard não interfere.
 *
 * ## Por que fail-open em `indeterminate`/`error`
 *
 * O detector de fabricação (`hermes/scripts/detect-tick-claim-fabrication.py`,
 * #7537) já documenta que `indeterminate` é um estado LEGÍTIMO e comum —
 * job pausado, 1º tick, nenhuma sessão pra correlacionar. Bloquear a
 * promoção nesses casos tornaria o guard num bloqueio permanente por falta
 * de dado, não uma checagem do alarme real. Só `fabrication_suspected`
 * (status explícito, positivo) bloqueia. `error` (detector não rodou —
 * `python3` ausente, JSON malformado, timeout) também não bloqueia, pelo
 * mesmo racional de "infra indisponível não é sinal de fabricação" que as
 * checagens do `watch-continuo-health.sh` já seguem (indeterminado ali
 * incrementa `FAILS`, nunca vira alarme). O escape hatch `--force-model-
 * promotion` no CLI cobre o caso em que o operador já investigou e decidiu
 * seguir mesmo com o alarme ativo (fail-closed não é fail-permanente).
 */
import { execSync } from "node:child_process";

/** Padrões de nome que identificam o modelo LOCAL do contínuo (Ollama via
 * Hermes) — os três formatos documentados em `docs/goal-modelo-local-
 * continuo.md`: `qwen-64k:latest`/`qwen3.5:4b` (nome cru), `custom/qwen-
 * 64k:latest` (prefixo que o Hermes usa pra resolver via sondagem local —
 * ver seção "Por que a compressão nunca protege" do briefing), e o padrão
 * genérico `ollama/*` caso um modelo local futuro não tenha "qwen" no
 * nome. */
export const LOCAL_MODEL_PATTERNS: readonly RegExp[] = [/qwen/i, /^custom\//i, /^ollama\//i];

/** `true` se `modelId` casa algum padrão de modelo local conhecido.
 * String vazia/só espaço nunca casa (nunca haveria promoção "pra nada"). */
export function isLocalModelId(modelId: string): boolean {
  const trimmed = modelId.trim();
  if (!trimmed) return false;
  return LOCAL_MODEL_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Extrai o valor de `model:\n  default: <valor>` de um `config.yaml` do
 * Hermes. Parsing por LINHA/indentação, não um parser YAML completo — mesmo
 * racional de `redactConfigText` em `hermes-config-writer.ts`: o schema é
 * conhecido e estável, um parser dedicado seria dependência nova pra um
 * formato que não varia. Devolve `null` quando a seção `model:` ou a chave
 * `default:` sob ela não aparecem (arquivo novo, seção ausente, etc — nunca
 * lança).
 */
export function extractModelDefault(yamlText: string): string | null {
  const lines = yamlText.split(/\r?\n/);
  const modelLineIdx = lines.findIndex((l) => /^model:\s*$/.test(l));
  if (modelLineIdx === -1) return null;
  for (let i = modelLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    // Linha sem indentação nenhuma = nova chave top-level -> saiu da seção
    // `model:`. Linha em branco não conta como saída (YAML tolera linhas
    // vazias dentro de uma seção).
    if (/^\S/.test(line)) break;
    const m = line.match(/^\s+default:\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
}

export interface PromotionDetectionResult {
  readonly isPromotion: boolean;
  readonly oldModel: string | null;
  readonly newModel: string | null;
}

/**
 * Compara `model.default` de dois conteúdos de `config.yaml` (antes/depois
 * de uma escrita) e decide se a mudança é uma PROMOÇÃO do modelo local —
 * `newModel` casa `isLocalModelId` e `oldModel` NÃO casava (ou não existia
 * ainda). Trocar de um modelo local pra outro (ex: `qwen-64k` ->
 * `qwen3.5:4b`) não conta como nova promoção — o modelo local já era o
 * default. `oldContent` undefined (1ª escrita do arquivo) trata `oldModel`
 * como `null`, então `newModel` local sempre conta como promoção nesse
 * caso.
 */
export function detectsModelPromotionToLocal(
  oldContent: string | undefined,
  newContent: string,
): PromotionDetectionResult {
  const oldModel = oldContent !== undefined ? extractModelDefault(oldContent) : null;
  const newModel = extractModelDefault(newContent);
  const isPromotion = newModel !== null && isLocalModelId(newModel) && !(oldModel !== null && isLocalModelId(oldModel));
  return { isPromotion, oldModel, newModel };
}

export type FabricationStatus = "ok" | "fabrication_suspected" | "indeterminate" | "error";

export interface FabricationCheckResult {
  readonly status: FabricationStatus;
  readonly raw: string;
}

/** Função de execução injetável — mesmo padrão de `DirScanOps`/`VersionCheckOps`
 * usado nos módulos irmãos de alarme deste repo (testabilidade sem depender
 * de `python3`/`gh` reais). Default real via `execSync`. */
export type ExecFn = (cmd: string) => string;

const defaultExec: ExecFn = (cmd) => execSync(cmd, { encoding: "utf8" });

/**
 * Roda `cmd` (default: `python3 hermes/scripts/detect-tick-claim-
 * fabrication.py --json`, mas o caller decide o comando exato — ver
 * `CONTINUO_MODEL_PROMOTION_FABRICATION_CMD` em `write-hermes-config.ts`)
 * e interpreta o `status` do JSON de saída. Qualquer falha — comando não
 * encontrado, saída não-JSON, campo `status` ausente/desconhecido — vira
 * `status: "error"`, NUNCA `"ok"` nem `"fabrication_suspected"` por
 * default (fail-soft nunca finge um veredito que não foi computado).
 */
export function checkFabricationAlarm(cmd: string, exec: ExecFn = defaultExec): FabricationCheckResult {
  let raw: string;
  try {
    raw = exec(cmd);
  } catch (e) {
    return { status: "error", raw: (e as Error).message };
  }
  try {
    const parsed = JSON.parse(raw) as { status?: unknown };
    const status = parsed?.status;
    if (status === "ok" || status === "fabrication_suspected" || status === "indeterminate") {
      return { status, raw };
    }
    return { status: "error", raw };
  } catch {
    return { status: "error", raw };
  }
}

export interface PromotionGuardVerdict {
  readonly allowed: boolean;
  readonly reason: string;
  readonly detection: PromotionDetectionResult;
  readonly fabricationCheck?: FabricationCheckResult;
}

/**
 * Veredito completo do guard: combina `detectsModelPromotionToLocal` com
 * `checkFabricationAlarm`, mas só RODA a checagem de fabricação quando a
 * escrita É de fato uma promoção — evita chamar `gh`/`python3` (custo real,
 * chamada de rede) em toda escrita de `config.yaml` que não mexe em
 * `model.default`.
 */
export function evaluateModelPromotionGuard(
  oldContent: string | undefined,
  newContent: string,
  fabricationCheckCmd: string,
  exec?: ExecFn,
): PromotionGuardVerdict {
  const detection = detectsModelPromotionToLocal(oldContent, newContent);
  if (!detection.isPromotion) {
    return {
      allowed: true,
      reason: "não promove model.default para o modelo local — guard não se aplica.",
      detection,
    };
  }
  const fabricationCheck = checkFabricationAlarm(fabricationCheckCmd, exec);
  if (fabricationCheck.status === "fabrication_suspected") {
    return {
      allowed: false,
      reason:
        `promoção de "${detection.newModel}" a model.default BLOQUEADA — alarme de fabricação de ` +
        `conclusão pelo coordenador do contínuo (#7537/#7568, ver docs/goal-modelo-local-continuo.md) ` +
        `está ATIVO (status=fabrication_suspected). Investigar antes de promover.`,
      detection,
      fabricationCheck,
    };
  }
  return {
    allowed: true,
    reason: `promoção de "${detection.newModel}" a model.default permitida — checagem de fabricação: status=${fabricationCheck.status}.`,
    detection,
    fabricationCheck,
  };
}
