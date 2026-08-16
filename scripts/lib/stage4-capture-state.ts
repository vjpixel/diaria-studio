/**
 * stage4-capture-state.ts (#5414)
 *
 * Persiste os 2 valores computados no meio do Stage 4 (§4c.1b `whatsapp_url`,
 * §4c.1c `meta_description_suggestion`, ambos em `orchestrator-stage-4.md`)
 * e só consumidos mais tarde, na apresentação do gate (§4d) — hoje
 * "capturados em sessão" na prosa do playbook (`Capturar como {whatsapp_url}`
 * / `Capturar como {meta_description_suggestion}`). O Stage 4 é o mais longo
 * do pipeline (587 turnos, ~424M tokens medidos na auditoria de 260816 do
 * #5414) — o objetivo desta issue é permitir contexto limpo mesmo DENTRO de
 * um stage longo, não só entre stages: sem persistir em disco, qualquer
 * corte/compaction de contexto entre §4c e §4d perderia os dois valores e o
 * gate reapresentaria sem eles.
 *
 * `whatsappUrl`/`metaDescriptionSuggestion` = `null` até serem computados;
 * string vazia É um valor legítimo já capturado (`meta_description_
 * suggestion` vem `''` quando `buildMetaDescriptionSuggestion` retorna
 * `null` — corpo do D1 sem prosa aproveitável, ver §4c.1c) — só `null`
 * significa "ainda não rodou nesta edição". Se o editor mudar o título do D1
 * via "ajustar" (§4d.1), `whatsapp_url` precisa ser recomputado e
 * regravado — este módulo não faz cache invalidation sozinho, é o playbook
 * quem decide recomputar.
 *
 * Fail-soft na leitura — arquivo ausente/corrompido/shape inesperado -> os
 * dois campos `null`.
 *
 * @see .claude/agents/orchestrator-stage-4.md §4c.1b, §4c.1c, §4d
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMainModule, parseArgs } from "./cli-args.ts";

export interface Stage4CaptureState {
  /** URL prevista do bloco WhatsApp do D1 (`buildWhatsappEditionUrl`, #4570).
   * Puramente informativa no gate — nunca bloqueia. `null` = ainda não
   * computada nesta edição. */
  whatsappUrl: string | null;
  /** Sugestão de meta description do D1 (`buildMetaDescriptionSuggestion`,
   * #5101 item 2). `''` = computada mas sem sugestão disponível (corpo sem
   * prosa aproveitável) — distinto de `null` = "ainda não computada". */
  metaDescriptionSuggestion: string | null;
  /** ISO — quando este estado foi gravado por último. `null` = nunca escrito. */
  capturedAt: string | null;
}

const DEFAULT_STATE: Stage4CaptureState = {
  whatsappUrl: null,
  metaDescriptionSuggestion: null,
  capturedAt: null,
};

function statePath(editionDir: string): string {
  return resolve(editionDir, "_internal", "stage4-capture-state.json");
}

/** `null` = arquivo ausente (legítimo, "nunca escrito"). Propaga qualquer
 * erro de FS real (EACCES/EPERM/EISDIR/lock do OneDrive) — quem chama decide
 * se isso é fail-soft (leitura) ou deve abortar (escrita, ver
 * `writeStage4CaptureState`). */
function tryReadRaw(p: string): string | null {
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

function normalizeState(raw: Partial<Stage4CaptureState>): Stage4CaptureState {
  return {
    whatsappUrl: typeof raw.whatsappUrl === "string" ? raw.whatsappUrl : null,
    metaDescriptionSuggestion:
      typeof raw.metaDescriptionSuggestion === "string" ? raw.metaDescriptionSuggestion : null,
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : null,
  };
}

/** Lê o estado capturado no Stage 4. Fail-soft — arquivo ausente, erro de FS
 * real (EACCES/EPERM/EISDIR/lock do OneDrive — logado, nunca engolido em
 * silêncio) ou JSON corrompido/shape inesperado -> os 2 campos `null`. */
export function readStage4CaptureState(editionDir: string): Stage4CaptureState {
  const p = statePath(editionDir);
  let raw: string | null;
  try {
    raw = tryReadRaw(p);
  } catch (err) {
    console.error(
      `stage4-capture-state: falha ao ler ${p}: ${(err as Error).message} — tratando como nunca capturado`,
    );
    return { ...DEFAULT_STATE };
  }
  if (raw === null) return { ...DEFAULT_STATE };
  try {
    return normalizeState(JSON.parse(raw) as Partial<Stage4CaptureState>);
  } catch (err) {
    console.error(
      `stage4-capture-state: JSON inválido em ${p}: ${(err as Error).message} — tratando como nunca capturado`,
    );
    return { ...DEFAULT_STATE };
  }
}

/** Grava um patch parcial por cima do estado já existente (upsert) — §4c.1b
 * e §4c.1c computam os 2 valores em passos separados, cada write só toca o
 * próprio campo. Sempre atualiza `capturedAt`. Propaga erro de escrita
 * real — e propaga também erro de LEITURA real do arquivo existente
 * (EACCES/EPERM/lock do OneDrive): sobrescrever um arquivo que existe mas
 * não pôde ser lido apagaria silenciosamente um valor já capturado por um
 * write anterior na mesma edição (ex: `whatsappUrl` de §4c.1b, se §4c.1c
 * falhar ao reler antes de gravar `metaDescriptionSuggestion`), então esse
 * caso aborta em vez de fazer merge sobre `DEFAULT_STATE`. Só JSON
 * corrompido é tolerado no caminho de escrita (aceitável sobrescrever —
 * mesmo comportamento já documentado). */
export function writeStage4CaptureState(
  editionDir: string,
  patch: Partial<Omit<Stage4CaptureState, "capturedAt">>,
  opts: { now?: () => Date } = {},
): Stage4CaptureState {
  const now = opts.now ?? (() => new Date());
  const p = statePath(editionDir);
  const raw = tryReadRaw(p); // propaga erro de FS real — NÃO captura aqui, de propósito
  let current: Stage4CaptureState;
  if (raw === null) {
    current = { ...DEFAULT_STATE };
  } else {
    try {
      current = normalizeState(JSON.parse(raw) as Partial<Stage4CaptureState>);
    } catch {
      current = { ...DEFAULT_STATE };
    }
  }
  const next: Stage4CaptureState = { ...current, ...patch, capturedAt: now().toISOString() };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}

// CLI:
//   Escrever (1+ flags):
//     npx tsx scripts/lib/stage4-capture-state.ts --edition-dir <dir> \
//       --whatsapp-url "https://…" --meta-description-suggestion "…"
//   Ler (imprime o JSON completo em stdout):
//     npx tsx scripts/lib/stage4-capture-state.ts --edition-dir <dir> --read
if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const editionDir = parsed.values["edition-dir"];
  if (!editionDir) {
    console.error(
      "uso: stage4-capture-state.ts --edition-dir <dir> [--read] " +
        '[--whatsapp-url "<url>"] [--meta-description-suggestion "<texto ou vazio>"]',
    );
    process.exit(1);
  }
  if (parsed.flags.has("read")) {
    console.log(JSON.stringify(readStage4CaptureState(editionDir)));
  } else {
    const patch: Partial<Omit<Stage4CaptureState, "capturedAt">> = {};
    if (parsed.values["whatsapp-url"] !== undefined) patch.whatsappUrl = parsed.values["whatsapp-url"];
    if (parsed.values["meta-description-suggestion"] !== undefined) {
      patch.metaDescriptionSuggestion = parsed.values["meta-description-suggestion"];
    }
    if (Object.keys(patch).length === 0) {
      console.error("nada para escrever — passe --whatsapp-url e/ou --meta-description-suggestion, ou --read");
      process.exit(1);
    }
    const next = writeStage4CaptureState(editionDir, patch);
    console.log(JSON.stringify(next));
  }
}
