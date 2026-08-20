#!/usr/bin/env tsx
/**
 * derive-editor-requests.ts (#5731)
 *
 * Deriva pedidos editoriais de forma determinística a partir do diff entre
 * snapshots pós-geração (Stage 2/4) e o estado atual no gate (Stage 4/6).
 *
 * O problema original (#5731): a captura via `log-editor-request.ts` manual
 * quase não roda — depende do orchestrator LEMBRAR de chamar o script no meio
 * da conversa. A solução é derivar os pedidos do diff, não da memória do agente.
 *
 * Dois pontos de snapshot:
 * 1. Pós-Stage 2 (após gate unificado) — snapshot de 02-reviewed.md, 03-social.md,
 *    _internal/01-approved.json
 * 2. Pós-Stage 4 pre-render — snapshot de _internal/newsletter-final.html,
 *    _internal/social-preview.html
 *
 * Dois pontos de diff:
 * - Stage 4 gate: diff dos snapshots Stage 2 vs estado atual (02-reviewed.md,
 *   03-social.md) + diff dos snapshots Stage 4 pre-render vs estado atual
 * - Stage 6 gate: diff adicional se houver mudanças pós-Stage 4
 *
 * Classificação usando a taxonomia existente de log-editor-request.ts.
 * Escrita no mesmo editor-requests.jsonl com source: "derived".
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, isMainModule } from "./lib/cli-args.ts";
import { resolveEditionDir } from "./lib/find-current-edition.ts";
import { appendEditorRequest, type EditorRequestEntry, type RequestType, type RequestTarget, type Resolution, type RequestSource } from "./log-editor-request.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Arquivos para snapshots pós-Stage 2 */
const STAGE2_SNAPSHOT_FILES = [
  "02-reviewed.md",
  "03-social.md",
  "_internal/01-approved.json",
] as const;

/** Arquivos para snapshots pós-Stage 4 pre-render */
const STAGE4_SNAPSHOT_FILES = [
  "_internal/newsletter-final.html",
  "_internal/social-preview.html",
] as const;

/** Diretório de snapshots */
const SNAPSHOT_DIR = "_internal/editor-request-snapshots";

/** Tipos de request mapeados por arquivo e padrão de mudança */
interface DiffClassifier {
  file: string;
  classify: (oldContent: string, newContent: string) => Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }>;
}

/**
 * Classifica diferenças no 02-reviewed.md (newsletter)
 */
function classifyNewsletterDiff(oldContent: string, newContent: string): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  const results: Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }> = [];

  // Helper para extrair seções do markdown
  const extractSections = (content: string): Map<string, string> => {
    const sections = new Map<string, string>();
    const lines = content.split("\n");
    let currentSection = "intro";
    let currentContent: string[] = [];

    for (const line of lines) {
      // Match headers like **DESTAQUE 1 | 🚀 LANÇAMENTO** or **É IA?** etc.
      const headerMatch = line.match(/^\*\*((DESTAQUE \d+)(?:\s*\|\s*[^*]*)?|É IA\?|USE MELHOR|LANÇAMENTOS|RADAR|VÍDEOS|SORTEIO|PARA ENCERRAR)\*\*$/);
      if (headerMatch) {
        if (currentContent.length > 0) {
          sections.set(currentSection, currentContent.join("\n"));
        }
        // Normalize section name: "DESTAQUE 1 | 🚀 LANÇAMENTO" -> "destaque-1"
        const rawSection = headerMatch[1];
        if (rawSection.startsWith("DESTAQUE ")) {
          const numMatch = rawSection.match(/DESTAQUE (\d+)/);
          currentSection = numMatch ? `destaque-${numMatch[1]}` : rawSection.toLowerCase().replace(/\s+/g, "-");
        } else {
          currentSection = rawSection.toLowerCase().replace(/\s+/g, "-").replace(/\|/g, "").replace(/[🚀💼🎓🔬📹🎁🙋]/g, "").trim();
        }
        currentContent = [line];
      } else {
        currentContent.push(line);
      }
    }
    if (currentContent.length > 0) {
      sections.set(currentSection, currentContent.join("\n"));
    }
    return sections;
  };

  const oldSections = extractSections(oldContent);
  const newSections = extractSections(newContent);

  // Detectar mudanças por seção
  for (const [section, newText] of newSections) {
    const oldText = oldSections.get(section) ?? "";
    if (oldText === newText) continue;

    // Determinar target baseado na seção
    let target: RequestTarget = "newsletter";
    let requestType: RequestType = "other";

    if (section.startsWith("destaque-")) {
      const numMatch = section.match(/destaque-(\d+)/);
      if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        target = `d${num}` as RequestTarget;
      }
      requestType = "lead-rewrite"; // default para mudanças em destaque
    } else if (section === "eia") {
      target = "eia";
      requestType = "eia-choice";
    } else if (section === "use-melhor") {
      target = "use-melhor";
      requestType = "destaque-promote";
    } else if (section === "lancamentos") {
      target = "lancamentos";
      requestType = "link-swap";
    } else if (section === "radar") {
      target = "radar";
      requestType = "link-swap";
    } else if (section === "videos" || section === "vídeos") {
      target = "newsletter";
      requestType = "link-swap";
    } else if (section === "para-encerrar") {
      target = "newsletter";
      requestType = "section-order";
    }

    // Tentar classificar melhor o tipo de mudança
    const oldLines = oldText.split("\n");
    const newLines = newText.split("\n");

    // Verificar se título mudou (linha do título do destaque - primeira linha após header que começa com ** e tem link)
    const oldTitleLine = oldLines.find(l => l.trim().startsWith("**[") && l.includes("]("));
    const newTitleLine = newLines.find(l => l.trim().startsWith("**[") && l.includes("]("));
    if (oldTitleLine && newTitleLine && oldTitleLine !== newTitleLine) {
      requestType = "title-choice";
    }

    // Verificar se "Por que isso importa" mudou
    const oldWhyIdx = oldLines.findIndex(l => l.includes("Por que isso importa"));
    const newWhyIdx = newLines.findIndex(l => l.includes("Por que isso importa"));
    if (oldWhyIdx >= 0 && newWhyIdx >= 0 && oldLines[oldWhyIdx] !== newLines[newWhyIdx]) {
      requestType = "lead-rewrite";
    }

    // Verificar se URL mudou
    const oldUrlLine = oldLines.find(l => l.trim().startsWith("http"));
    const newUrlLine = newLines.find(l => l.trim().startsWith("http"));
    if (oldUrlLine && newUrlLine && oldUrlLine !== newUrlLine) {
      requestType = "link-swap";
    }

    // Verificar tamanho (corte/alongamento)
    const oldLen = oldText.length;
    const newLen = newText.length;
    if (newLen < oldLen * 0.7) {
      requestType = "length-cut";
    } else if (newLen > oldLen * 1.3) {
      requestType = "lead-rewrite";
    }

    // Verificar se destaque foi removido (swap/cut)
    if (!newSections.has(section) && oldSections.has(section)) {
      requestType = "destaque-cut";
      target = "radar"; // movido para radar
    }

    results.push({
      request_type: requestType,
      target,
      description: `Mudança detectada em ${section}: ${oldText.slice(0, 100)}... → ${newText.slice(0, 100)}...`,
      resolution: "accepted",
      context: { section, old_length: oldLen, new_length: newLen },
    });
  }

  // Detectar seções novas (promoção)
  for (const [section] of newSections) {
    if (!oldSections.has(section) && section.startsWith("destaque-")) {
      results.push({
        request_type: "destaque-promote",
        target: "radar",
        description: `Novo destaque promovido: ${section}`,
        resolution: "accepted",
        context: { section },
      });
    }
  }

  return results;
}

/**
 * Classifica diferenças no 03-social.md (social)
 */
function classifySocialDiff(oldContent: string, newContent: string): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  const results: Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }> = [];

  const extractSections = (content: string): Map<string, string> => {
    const sections = new Map<string, string>();
    const lines = content.split("\n");
    let currentSection = "intro";
    let currentContent: string[] = [];

    for (const line of lines) {
      const headerMatch = line.match(/^##\s+(.+)$/);
      if (headerMatch) {
        if (currentContent.length > 0) {
          sections.set(currentSection, currentContent.join("\n"));
        }
        currentSection = headerMatch[1].toLowerCase().replace(/\s+/g, "-");
        currentContent = [line];
      } else {
        currentContent.push(line);
      }
    }
    if (currentContent.length > 0) {
      sections.set(currentSection, currentContent.join("\n"));
    }
    return sections;
  };

  const oldSections = extractSections(oldContent);
  const newSections = extractSections(newContent);

  for (const [section, newText] of newSections) {
    const oldText = oldSections.get(section) ?? "";
    if (oldText === newText) continue;

    let target: RequestTarget = "social";
    let requestType: RequestType = "social-rewrite";

    if (section.startsWith("d")) {
      target = section as RequestTarget;
    } else if (section === "post-pixel" || section === "post_pixel") {
      target = "social";
      requestType = "social-rewrite";
    }

    results.push({
      request_type: requestType,
      target,
      description: `Mudança em social ${section}: reescrita/ajuste de texto`,
      resolution: "accepted",
      context: { section, old_length: oldText.length, new_length: newText.length },
    });
  }

  return results;
}

/**
 * Classifica diferenças no 01-approved.json (seleção de destaques)
 */
function classifyApprovedDiff(oldContent: string, newContent: string): Array<{
  request_type: RequestType;
  target: RequestTarget;
  description: string;
  resolution: Resolution;
  context?: Record<string, unknown>;
}> {
  const results: Array<{
    request_type: RequestType;
    target: RequestTarget;
    description: string;
    resolution: Resolution;
    context?: Record<string, unknown>;
  }> = [];

  try {
    const oldJson = JSON.parse(oldContent);
    const newJson = JSON.parse(newContent);

    const oldHighlights = oldJson.highlights ?? [];
    const newHighlights = newJson.highlights ?? [];

    // Detectar swap de destaque
    if (oldHighlights.length === newHighlights.length && oldHighlights.length > 0) {
      for (let i = 0; i < oldHighlights.length; i++) {
        const oldUrl = oldHighlights[i]?.article?.url;
        const newUrl = newHighlights[i]?.article?.url;
        if (oldUrl && newUrl && oldUrl !== newUrl) {
          results.push({
            request_type: "destaque-swap",
            target: `d${i + 1}` as RequestTarget,
            description: `Destaque D${i + 1} trocado: ${oldHighlights[i]?.article?.title} → ${newHighlights[i]?.article?.title}`,
            resolution: "accepted",
            context: { old_url: oldUrl, new_url: newUrl, position: i + 1 },
          });
        }
      }
    }

    // Detectar corte de destaque
    if (newHighlights.length < oldHighlights.length) {
      for (let i = newHighlights.length; i < oldHighlights.length; i++) {
        results.push({
          request_type: "destaque-cut",
          target: `d${i + 1}` as RequestTarget,
          description: `Destaque D${i + 1} removido: ${oldHighlights[i]?.article?.title}`,
          resolution: "accepted",
          context: { old_url: oldHighlights[i]?.article?.url, position: i + 1 },
        });
      }
    }

    // Detectar promoção (aumento de destaques - não deve acontecer pois max 3)
    if (newHighlights.length > oldHighlights.length) {
      for (let i = oldHighlights.length; i < newHighlights.length; i++) {
        results.push({
          request_type: "destaque-promote",
          target: "radar",
          description: `Item promovido a destaque D${i + 1}: ${newHighlights[i]?.article?.title}`,
          resolution: "accepted",
          context: { new_url: newHighlights[i]?.article?.url, position: i + 1 },
        });
      }
    }

    // Detectar mudança de ordem
    if (oldHighlights.length === newHighlights.length && oldHighlights.length > 1) {
      const oldUrls = oldHighlights.map((h: any) => h?.article?.url);
      const newUrls = newHighlights.map((h: any) => h?.article?.url);
      const sameSet = oldUrls.length === newUrls.length && oldUrls.every((u: string) => newUrls.includes(u));
      if (sameSet && JSON.stringify(oldUrls) !== JSON.stringify(newUrls)) {
        results.push({
          request_type: "section-order",
          target: "newsletter",
          description: `Reordenação de destaques: ${oldUrls.map((u: string, i: number) => `D${i+1}=${u}`).join(" → ")} → ${newUrls.map((u: string, i: number) => `D${i+1}=${u}`).join(" → ")}`,
          resolution: "accepted",
          context: { old_order: oldUrls, new_order: newUrls },
        });
      }
    }
  } catch {
    // JSON inválido - ignorar
  }

  return results;
}

/**
 * Cria snapshots dos arquivos especificados.
 *
 * Preserva a subestrutura de diretórios do arquivo original dentro do
 * snapshot dir (ex: `_internal/01-approved.json` vira
 * `{snapshotDir}/_internal/01-approved.json`) em vez de "achatar" o path
 * substituindo `/` por `_` — um path que já começa com `_` (como
 * `_internal/...`) tornaria esse achatamento não-reversível (`readSnapshots`
 * não conseguiria distinguir o `_` original do `_` que substituiu `/`).
 */
function createSnapshots(editionDir: string, files: readonly string[], label: string): void {
  const snapshotDir = resolve(editionDir, SNAPSHOT_DIR, label);
  mkdirSync(snapshotDir, { recursive: true });

  for (const file of files) {
    const srcPath = resolve(editionDir, file);
    if (existsSync(srcPath)) {
      const destPath = resolve(snapshotDir, file);
      mkdirSync(dirname(destPath), { recursive: true });
      copyFileSync(srcPath, destPath);
    }
  }
  console.log(`[derive-editor-requests] Snapshots ${label} criados em ${snapshotDir}`);
}

/**
 * Lê snapshots de um label. Recebe a lista de arquivos esperados (mesma
 * lista usada por `createSnapshots`) em vez de enumerar o diretório — o
 * path relativo original é preservado por `createSnapshots`, então basta
 * checar `{snapshotDir}/{file}` diretamente.
 */
function readSnapshots(editionDir: string, label: string, files: readonly string[]): Map<string, string> {
  const snapshotDir = resolve(editionDir, SNAPSHOT_DIR, label);
  const result = new Map<string, string>();

  if (!existsSync(snapshotDir)) return result;

  for (const file of files) {
    const snapPath = resolve(snapshotDir, file);
    if (existsSync(snapPath)) {
      result.set(file, readFileSync(snapPath, "utf8"));
    }
  }
  return result;
}

/**
 * Executa diff e classifica mudanças
 */
function diffAndClassify(
  editionDir: string,
  snapshotLabel: string,
  currentFiles: readonly string[],
  classifierMap: Map<string, (oldC: string, newC: string) => any[]>,
  stage: number
): Array<Omit<EditorRequestEntry, "timestamp" | "edition">> {
  const snapshots = readSnapshots(editionDir, snapshotLabel, currentFiles);
  const results: Array<Omit<EditorRequestEntry, "timestamp" | "edition">> = [];

  for (const file of currentFiles) {
    const currentPath = resolve(editionDir, file);
    if (!existsSync(currentPath)) continue;

    const currentContent = readFileSync(currentPath, "utf8");
    const snapshotContent = snapshots.get(file);

    if (!snapshotContent) {
      // Sem snapshot - primeira vez, não podemos derivar
      continue;
    }

    if (snapshotContent === currentContent) continue; // sem mudança

    const classifier = classifierMap.get(file);
    if (classifier) {
      const classified = classifier(snapshotContent, currentContent);
      for (const c of classified) {
        results.push({ ...c, stage });
      }
    }
  }

  return results;
}

/**
 * Função principal - cria snapshots pós-Stage 2
 */
function snapshotStage2(editionDir: string): void {
  createSnapshots(editionDir, STAGE2_SNAPSHOT_FILES, "stage2-post-gate");
}

/**
 * Função principal - cria snapshots pós-Stage 4 pre-render
 */
function snapshotStage4(editionDir: string): void {
  createSnapshots(editionDir, STAGE4_SNAPSHOT_FILES, "stage4-pre-render");
}

/** Classificadores compartilhados por deriveStage4/deriveStage6 (mesmos arquivos-fonte). */
function buildStage2FilesClassifierMap(): Map<string, (oldC: string, newC: string) => any[]> {
  return new Map<string, (oldC: string, newC: string) => any[]>([
    ["02-reviewed.md", classifyNewsletterDiff],
    ["03-social.md", classifySocialDiff],
    ["_internal/01-approved.json", classifyApprovedDiff],
  ]);
}

/**
 * Função principal - deriva requests no gate do Stage 4
 *
 * Compara o checkpoint "stage2-post-gate" (criado por snapshotStage2, logo
 * após o gate unificado do Stage 2) contra o estado atual dos arquivos —
 * captura qualquer edição feita pelo editor (Studio ou manual) entre o fim
 * do Stage 2 e a aprovação do gate do Stage 4.
 *
 * Ao final, o checkpoint é REFRESCADO para o estado atual: isso evita que
 * `deriveStage6` re-derive as mesmas mudanças já logadas aqui — Stage 6 só
 * vê o que mudou DEPOIS desta chamada.
 */
function deriveStage4(editionDir: string, edition: string): number {
  const classifierMap = buildStage2FilesClassifierMap();
  const derived = diffAndClassify(editionDir, "stage2-post-gate", STAGE2_SNAPSHOT_FILES, classifierMap, 4);

  let count = 0;
  for (const entry of derived) {
    appendEditorRequest(editionDir, { ...entry, edition, source: "derived" });
    count++;
  }

  createSnapshots(editionDir, STAGE2_SNAPSHOT_FILES, "stage2-post-gate");

  console.log(`[derive-editor-requests] Stage 4 gate: ${count} pedidos derivados`);
  return count;
}

/**
 * Função principal - deriva requests no gate do Stage 6
 *
 * Mesmo checkpoint "stage2-post-gate" usado por deriveStage4. Se o Stage 4
 * já rodou o gate (caso normal), o checkpoint foi refrescado ao final
 * daquela chamada — então este diff captura só mudanças feitas DEPOIS da
 * aprovação do Stage 4 (ex: edição via Studio durante o Stage 5). Se a
 * edição pulou o gate do Stage 4 (via --no-gates ou interrupção), o
 * checkpoint ainda é o snapshot original pós-Stage 2, e este diff cobre o
 * intervalo inteiro Stage 2 → Stage 6 numa passada só.
 */
function deriveStage6(editionDir: string, edition: string): number {
  const classifierMap = buildStage2FilesClassifierMap();
  const derived = diffAndClassify(editionDir, "stage2-post-gate", STAGE2_SNAPSHOT_FILES, classifierMap, 6);

  let count = 0;
  for (const entry of derived) {
    appendEditorRequest(editionDir, { ...entry, edition, source: "derived" });
    count++;
  }

  console.log(`[derive-editor-requests] Stage 6 gate: ${count} pedidos derivados`);
  return count;
}

/**
 * CLI
 */
function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  const args = parsed.values;
  const command = parsed.positional[0];

  if (!command) {
    console.error("Uso: derive-editor-requests.ts <snapshot-stage2|snapshot-stage4|derive-stage4|derive-stage6> --edition AAMMDD");
    process.exit(2);
  }

  const edition = args.edition;
  if (!edition || !/^\d{6}$/.test(edition)) {
    console.error("Edition AAMMDD obrigatório");
    process.exit(2);
  }

  const editionsRootDir = args["editions-dir"]
    ? resolve(args["editions-dir"])
    : resolve(ROOT, "data", "editions");
  const editionDir = resolveEditionDir(editionsRootDir, edition);

  if (!existsSync(editionDir)) {
    console.error(`Edition dir não existe: ${editionDir}`);
    process.exit(2);
  }

  switch (command) {
    case "snapshot-stage2":
      snapshotStage2(editionDir);
      break;
    case "snapshot-stage4":
      snapshotStage4(editionDir);
      break;
    case "derive-stage4":
      deriveStage4(editionDir, edition);
      break;
    case "derive-stage6":
      deriveStage6(editionDir, edition);
      break;
    default:
      console.error(`Comando desconhecido: ${command}`);
      process.exit(2);
  }
}

if (isMainModule(import.meta.url)) {
  main();
}