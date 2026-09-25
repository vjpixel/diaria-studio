/**
 * scripts/lib/apoio-overrides.ts (#8820, mecanismo — falta o e-mail real p/
 * ativar a entrada da Bruna Quevedo, ver issue)
 *
 * Override manual de nível de apoio, versionado em `context/apoio-overrides.json`
 * (`[{ email, nivel, motivo, desde }]`), consumido por
 * `scripts/sync-apoio-nivel-kit.ts` e `scripts/sync-apoio-nivel-beehiiv.ts` —
 * mesmo shape genérico plataforma-agnóstico que o resto do módulo de apoio
 * (`ApoioNivel` de `./shared/apoio-nivel-types.ts`).
 *
 * ## Por que existe
 *
 * Hoje `apoio_nivel` (Kit/Beehiiv) é derivado 100% da base do apoia.se
 * (`computeDesiredApoioLevels` em `sync-apoio-nivel-beehiiv.ts`) — não existe
 * camada de override, então um valor editado à mão direto no Kit/Beehiiv é
 * sobrescrito no próximo `--push`. O pedido original (#8820): fixar
 * manualmente que uma pessoa específica (ex: Bruna Quevedo) é de um
 * determinado nível, independente do que o apoia.se reporta — porque o
 * apoio dela não passa (ou não passa ainda) pelo apoia.se.
 *
 * ## Onde plugar (nos dois sync scripts)
 *
 * Aplicar **depois** de `computeDesiredApoioLevels` e **antes** de
 * `diffApoioTags` — override vence o valor derivado do apoia.se:
 *
 *   const desired = computeDesiredApoioLevels(data.contacts, pastSnapshots, currentMonth);
 *   const overrides = loadApoioOverrides(ROOT);
 *   const desiredWithOverrides = applyApoioOverrides(desired, overrides);
 *   const diff = diffApoioTags(desiredWithOverrides, current);
 *
 * ## Guard de blast radius — por que override nunca conta como remoção
 *
 * `evaluateBlastRadiusGuard`/`shouldBlockRemovals` (em
 * `sync-apoio-nivel-beehiiv.ts`) operam sobre `diff.toRemove` — entradas cujo
 * `toLevel` é `null`. Um override sempre atribui um `ApoioNivel` concreto
 * (o schema não aceita `nivel: null`), então `applyApoioOverrides` nunca
 * produz uma entrada com `level: null` — logo nunca entra em `toRemove`, e
 * os dois guards de remoção seguem intocados. Isso vale mesmo quando o
 * override REBAIXA um nível já calculado pelo apoia.se (ex: apoia.se calcula
 * `patrono`, override fixa `apoiador`): ainda é uma troca de faixa
 * (`toApply`), não uma remoção.
 *
 * ## Semântica de "adiciona pra quem não está no apoia.se" (caso a)
 *
 * Se o e-mail do override não casa com nenhum contato em `desired` (pessoa
 * fora da base do apoia.se), `applyApoioOverrides` cria uma entrada
 * SINTÉTICA (`contactId: "override:{email}"`) — ela segue o pipeline normal
 * daí em diante (`diffApoioTags` tenta casar por e-mail contra o estado
 * atual da plataforma, igual a qualquer outro contato).
 *
 * ## Sobrevivência a sync onde a pessoa some do apoia.se (caso b)
 *
 * Como o override é relido do arquivo em TODA execução (nunca depende de um
 * estado anterior persistido), ele se reafirma a cada `--push` — não importa
 * se `data.contacts` (a base do apoia.se) parou de incluir aquele e-mail.
 * Só some se alguém remover a entrada do `context/apoio-overrides.json`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type ApoioNivel, isApoioNivel } from "./shared/apoio-nivel-types.ts";

export interface ApoioOverrideEntry {
  /** Normalizado (lowercase/trim) por `loadApoioOverrides`. */
  email: string;
  nivel: ApoioNivel;
  /** Justificativa — nunca vazia (exigido no parse, vira nome de fallback
   *  quando a entrada não casa com nenhum contato conhecido). */
  motivo: string;
  /** Data (livre, ex: "2026-09-25") — registro de auditoria, não usada em
   *  nenhum cálculo (override não expira sozinho). */
  desde: string;
}

/** Shape mínimo que `applyApoioOverrides` precisa de uma entrada "desejada" —
 *  casa estruturalmente com `DesiredApoioLevel` de `sync-apoio-nivel-beehiiv.ts`
 *  sem importar de lá (evita ciclo de módulos ES; ver o mesmo padrão de
 *  reexport documentado naquele arquivo). */
export interface DesiredLevelLike {
  contactId: string;
  contactName: string;
  emails: string[];
  level: ApoioNivel | null;
  unresolved: boolean;
}

export const DEFAULT_APOIO_OVERRIDES_PATH = "context/apoio-overrides.json";

/**
 * I/O: lê + valida `context/apoio-overrides.json`. Fail-soft na AUSÊNCIA do
 * arquivo (clone fresco, `data/` não montado — devolve `[]`); fail-LOUD em
 * conteúdo malformado (JSON inválido, não-array, entrada sem `email`/`nivel`
 * válido) — um override mal escrito que falhasse em silêncio deixaria a
 * pessoa sem a recompensa fixada sem ninguém perceber.
 */
export function loadApoioOverrides(
  root: string,
  relativePath: string = DEFAULT_APOIO_OVERRIDES_PATH,
): ApoioOverrideEntry[] {
  const fullPath = resolve(root, relativePath);
  if (!existsSync(fullPath)) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(fullPath, "utf8"));
  } catch (e) {
    throw new Error(`${relativePath} malformado — não foi possível fazer parse do JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error(`${relativePath} deve ser um array — formato esperado: [{ email, nivel, motivo, desde }]`);
  }

  const out: ApoioOverrideEntry[] = [];
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`${relativePath}[${i}] inválida — esperado objeto { email, nivel, motivo, desde }`);
    }
    const rec = entry as Record<string, unknown>;
    const email = typeof rec.email === "string" ? rec.email.trim().toLowerCase() : "";
    const nivel = typeof rec.nivel === "string" ? rec.nivel : "";
    if (!email || !isApoioNivel(nivel)) {
      throw new Error(
        `${relativePath}[${i}] inválida — email não-vazio + nivel válido (amigo|apoiador|mantenedor|patrono) ` +
          `são obrigatórios; recebido: ${JSON.stringify(entry)}`,
      );
    }
    out.push({
      email,
      nivel,
      motivo: typeof rec.motivo === "string" ? rec.motivo : "",
      desde: typeof rec.desde === "string" ? rec.desde : "",
    });
  }
  return out;
}

/**
 * Pure: aplica os overrides sobre o estado DESEJADO calculado do apoia.se —
 * override sempre vence o valor derivado. Duas ações possíveis por entrada
 * de override:
 *
 *   - **Casa** com um contato existente em `desired` (por e-mail, mesma
 *     regra de casamento do resto do módulo): substitui `level` pelo nível
 *     do override, e força `unresolved: false` (um override explícito
 *     resolve qualquer "sem_dados" pendente daquele contato — é justamente
 *     pra isso que ele existe).
 *   - **Não casa** com nenhum contato (pessoa fora da base do apoia.se,
 *     caso (a) do #8820): cria uma entrada sintética
 *     (`contactId: "override:{email}"`), que segue pro diff normalmente.
 *
 * Nunca produz `level: null` — ver docblock do módulo, seção "Guard de
 * blast radius", pro porquê disso importar.
 */
export function applyApoioOverrides<T extends DesiredLevelLike>(
  desired: readonly T[],
  overrides: readonly ApoioOverrideEntry[],
): T[] {
  if (overrides.length === 0) return [...desired];

  const overrideByEmail = new Map(overrides.map((o) => [o.email, o]));
  const matchedEmails = new Set<string>();

  const applied = desired.map((d) => {
    const hitEmail = d.emails.find((e) => overrideByEmail.has(e));
    if (!hitEmail) return d;
    const override = overrideByEmail.get(hitEmail)!;
    matchedEmails.add(hitEmail);
    if (d.level === override.nivel && d.unresolved === false) return d;
    return { ...d, level: override.nivel, unresolved: false };
  });

  const synthetic: T[] = [];
  for (const override of overrides) {
    if (matchedEmails.has(override.email)) continue;
    synthetic.push({
      contactId: `override:${override.email}`,
      contactName: override.motivo || override.email,
      emails: [override.email],
      level: override.nivel,
      unresolved: false,
    } as T);
  }

  return [...applied, ...synthetic];
}
