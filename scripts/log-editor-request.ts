#!/usr/bin/env tsx
/**
 * log-editor-request.ts (#4966)
 *
 * Append-only logger pra "pedidos editoriais" — mudanças de CONTEÚDO que o
 * editor pede durante a edição (troca de título, promoção/corte de destaque,
 * reescrita de lead, tom, etc). Espelho de `scripts/log-runtime-fix.ts`
 * (#1210), que registra o lado oposto: correções que o orchestrator faz
 * sozinho pra contornar regressão.
 *
 * Sem este log, pedido recorrente do editor ("esse título tá longo demais",
 * "promove esse item do Radar pra destaque") morre no transcript da sessão —
 * nada agrega, ninguém percebe o padrão, e o editor continua pedindo
 * manualmente edição após edição uma mudança que já deveria ter virado regra
 * editorial ou ajuste de prompt de agente.
 *
 * Escopo (#4966, decisão do editor 260811): SÓ pedidos editoriais — conteúdo
 * da edição. Pedido de processo/mecânica ("roda o Stage 3 de novo", "pula o
 * Facebook") fica FORA — não logar.
 *
 * Uso:
 *   npx tsx scripts/log-editor-request.ts \
 *     --edition 260811 \
 *     --stage 4 \
 *     --request-type title-length \
 *     --target d2 \
 *     --description "editor pediu título mais curto no D2; o escolhido tinha 51 chars mas 'não cabe no assunto'" \
 *     --resolution accepted
 *     [--editions-dir <path>]  # override de onde `data/editions/` mora (default: ROOT do repo, só teste)
 *
 * Output: append em `{editionDir}/_internal/editor-requests.jsonl`, 1 linha
 * por pedido. Lido por `collect-edition-signals.ts` como sinal
 * `kind: "recurring_editor_request"` (leitura cross-edição, últimas 7).
 *
 * `--editions-dir`: mesmo propósito/convenção de `log-runtime-fix.ts` — existe
 * SÓ pra isolamento de teste. Sem a flag, a raiz de edições sempre resolve
 * pra `{ROOT}/data/editions` (ROOT = raiz do repo, cwd-independente).
 */

import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Taxonomia fechada (#4966). `other` existe como escape hatch mas NÃO
 * participa da detecção de recorrência (`collect-edition-signals.ts`) —
 * agrupar `other` com `other` não diz nada sobre o que mudar. Se `other`
 * aparecer muito, é sinal de que a taxonomia precisa de categoria nova.
 */
export type RequestType =
  | "title-choice"
  | "title-length"
  | "destaque-swap"
  | "destaque-cut"
  | "destaque-promote"
  | "lead-rewrite"
  | "tone"
  | "length-cut"
  | "link-swap"
  | "image-redo"
  | "image-crop"
  | "section-order"
  | "eia-choice"
  | "social-rewrite"
  | "factual-correction"
  | "other";

export type RequestTarget =
  | "d1"
  | "d2"
  | "d3"
  | "eia"
  | "radar"
  | "use-melhor"
  | "lancamentos"
  | "social"
  | "newsletter";

export type Resolution = "accepted" | "partial" | "declined";

export interface EditorRequestEntry {
  timestamp: string;
  edition: string;
  stage: number;
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}

export function appendEditorRequest(
  editionDir: string,
  entry: Omit<EditorRequestEntry, "timestamp">,
): EditorRequestEntry {
  const full: EditorRequestEntry = {
    timestamp: new Date().toISOString(),
    ...entry,
  };
  const outPath = resolve(editionDir, "_internal", "editor-requests.jsonl");
  mkdirSync(resolve(editionDir, "_internal"), { recursive: true });
  appendFileSync(outPath, JSON.stringify(full) + "\n", "utf8");
  return full;
}

export const VALID_REQUEST_TYPES: ReadonlyArray<RequestType> = [
  "title-choice",
  "title-length",
  "destaque-swap",
  "destaque-cut",
  "destaque-promote",
  "lead-rewrite",
  "tone",
  "length-cut",
  "link-swap",
  "image-redo",
  "image-crop",
  "section-order",
  "eia-choice",
  "social-rewrite",
  "factual-correction",
  "other",
];

export const VALID_TARGETS: ReadonlyArray<RequestTarget> = [
  "d1",
  "d2",
  "d3",
  "eia",
  "radar",
  "use-melhor",
  "lancamentos",
  "social",
  "newsletter",
];

export const VALID_RESOLUTIONS: ReadonlyArray<Resolution> = [
  "accepted",
  "partial",
  "declined",
];

function main(): void {
  const args = parseArgs(process.argv.slice(2)).values;
  const required = ["edition", "stage", "request-type", "target", "description", "resolution"];
  const missing = required.filter((k) => !args[k]);
  if (missing.length > 0) {
    console.error(
      "Uso: log-editor-request.ts --edition AAMMDD --stage N --request-type <type> --target <target> --description \"...\" --resolution accepted|partial|declined [--context '<json>']\n" +
        `Faltam: ${missing.join(", ")}`,
    );
    process.exit(2);
  }

  const requestType = args["request-type"] as RequestType;
  if (!VALID_REQUEST_TYPES.includes(requestType)) {
    console.error(`request-type inválido: ${requestType}. Aceitos: ${VALID_REQUEST_TYPES.join(", ")}`);
    process.exit(2);
  }

  const target = args.target as RequestTarget;
  if (!VALID_TARGETS.includes(target)) {
    console.error(`target inválido: ${target}. Aceitos: ${VALID_TARGETS.join(", ")}`);
    process.exit(2);
  }

  const resolution = args.resolution as Resolution;
  if (!VALID_RESOLUTIONS.includes(resolution)) {
    console.error(`resolution inválida: ${resolution}. Aceitos: ${VALID_RESOLUTIONS.join(", ")}`);
    process.exit(2);
  }

  const stage = parseInt(args.stage, 10);
  if (isNaN(stage) || stage < 0 || stage > 6) {
    console.error(`stage inválido: ${args.stage} (esperado 0-6)`);
    process.exit(2);
  }

  let context: Record<string, unknown> | undefined;
  if (args.context) {
    try {
      context = JSON.parse(args.context);
    } catch {
      console.error(`--context não é JSON válido: ${args.context}`);
      process.exit(2);
    }
  }

  // Mesma resolução de path que log-runtime-fix.ts (#3484) — checa os dois
  // layouts possíveis (flat legado e nested novo) via resolveEditionDir em
  // vez de montar `data/editions/{AAMMDD}` à mão.
  const editionsRootDir = args["editions-dir"]
    ? resolve(args["editions-dir"])
    : resolve(ROOT, "data", "editions");
  const editionDir = resolveEditionDir(editionsRootDir, args.edition);
  if (!existsSync(editionDir)) {
    console.error(`Edition dir não existe: ${editionDir}`);
    process.exit(2);
  }

  const entry = appendEditorRequest(editionDir, {
    edition: args.edition,
    stage,
    request_type: requestType,
    target,
    description: args.description,
    resolution,
    context,
  });

  console.log(JSON.stringify({ ok: true, entry }, null, 2));
}

if (isMainModule(import.meta.url)) {
  main();
}
