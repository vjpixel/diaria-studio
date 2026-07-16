/**
 * studio-edition-detail.ts (#3555)
 *
 * Camada de leitura PURA pra `GET /api/editions/{AAMMDD}`: metadados +
 * arquivos gate-facing de UMA edição específica. Reusa `resolveEditionDir`
 * (`scripts/lib/find-current-edition.ts`, #3024) pra achar a edição em
 * qualquer um dos 2 layouts no disco (flat legado / nested #2463), e `loadDoc` /
 * `STAGE_LABELS` (`scripts/update-stage-status.ts`) pro mesmo doc de
 * timing/custo usado por `studio-state.ts`.
 *
 * Read-only por design (#3555 é a fatia fundação read-only da EPIC #3554).
 */

import { existsSync, statSync } from "node:fs";
import { resolve, relative } from "node:path";
import { resolveEditionDir, findEditionsInProgress } from "../lib/find-current-edition.ts";
import { loadDoc, type StageStatusDoc } from "../update-stage-status.ts";
import { currentStageFromDoc, stageLabelFor, type CurrentStage } from "./studio-state.ts";

/**
 * Arquivos "gate-facing" (root de `data/editions/{AAMMDD}/`, revisados pelo
 * editor — convenção documentada em CLAUDE.md § Estrutura) que a página de
 * status de uma edição individual pode querer listar. Lista fechada e
 * conhecida, não um scan livre do diretório — mantém o endpoint previsível
 * e evita vazar nomes de arquivo internos por acidente.
 */
export const GATE_FACING_FILES = [
  "01-categorized.md",
  "01-eia.md",
  "01-eia-A.jpg",
  "01-eia-B.jpg",
  "02-reviewed.md",
  "03-social.md",
  "04-d1-2x1.jpg",
  "04-d1-1x1.jpg",
  "04-d2-1x1.jpg",
  "04-d3-1x1.jpg",
  "stage-status.md",
] as const;

export interface EditionFileInfo {
  name: string;
  exists: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null; // ISO
}

export interface StudioEditionDetail {
  edition: string;
  editionDir: string; // relativo a rootDir
  found: boolean;
  currentStage: CurrentStage;
  stageLabel: string;
  gatesPending: number[];
  gateFacingFiles: EditionFileInfo[];
  /**
   * Doc completo de `_internal/stage-status.json` (linhas por stage 0-6,
   * timing/custo) — a UI usa isso pra renderizar a timeline dos 6 stages
   * (#3555 critério de aceite). `null` quando a edição ainda não tem
   * `stage-status.json`/`.md` (ex: recém-criada, Stage 0 ainda rodando).
   */
  stageStatus: StageStatusDoc | null;
}

const AAMMDD_RE = /^\d{6}$/;

function toRelative(rootDir: string, absPath: string): string {
  return relative(rootDir, absPath).split("\\").join("/");
}

function statFile(absPath: string): EditionFileInfo {
  const name = absPath; // placeholder, sobrescrito pelo caller
  if (!existsSync(absPath)) {
    return { name, exists: false, sizeBytes: null, modifiedAt: null };
  }
  try {
    const st = statSync(absPath);
    return {
      name,
      exists: st.isFile(),
      sizeBytes: st.isFile() ? st.size : null,
      modifiedAt: st.isFile() ? st.mtime.toISOString() : null,
    };
  } catch {
    return { name, exists: false, sizeBytes: null, modifiedAt: null };
  }
}

/**
 * Monta o detalhe de UMA edição. Retorna `found: false` (sem lançar) quando
 * o AAMMDD é inválido ou a edição não existe no disco — o caller HTTP decide
 * o status code (404) a partir desse campo.
 */
export function buildEditionDetail(rootDir: string, aammdd: string): StudioEditionDetail {
  if (!AAMMDD_RE.test(aammdd)) {
    return {
      edition: aammdd,
      editionDir: "",
      found: false,
      currentStage: "unknown",
      stageLabel: "Desconhecido",
      gatesPending: [],
      gateFacingFiles: [],
      stageStatus: null,
    };
  }

  const editionsRootAbs = resolve(rootDir, "data", "editions");
  const editionDirAbs = resolveEditionDir(editionsRootAbs, aammdd);
  const found = existsSync(editionDirAbs);

  let currentStage: CurrentStage = "unknown";
  let stageLabel = "Desconhecido";
  let stageStatus: StageStatusDoc | null = null;
  if (found) {
    const jsonPath = resolve(editionDirAbs, "_internal", "stage-status.json");
    const mdPath = resolve(editionDirAbs, "stage-status.md");
    if (existsSync(jsonPath) || existsSync(mdPath)) {
      stageStatus = loadDoc(editionDirAbs, aammdd);
      currentStage = currentStageFromDoc(stageStatus);
      stageLabel = stageLabelFor(currentStage);
    }
  }

  const gatesPending: number[] = [];
  if (found) {
    if (findEditionsInProgress(4, rootDir).includes(aammdd)) gatesPending.push(4);
    if (findEditionsInProgress(6, rootDir).includes(aammdd)) gatesPending.push(6);
  }

  const gateFacingFiles = found
    ? GATE_FACING_FILES.map((name) => ({ ...statFile(resolve(editionDirAbs, name)), name }))
    : [];

  return {
    edition: aammdd,
    editionDir: found ? toRelative(rootDir, editionDirAbs) : "",
    found,
    currentStage,
    stageLabel,
    gatesPending,
    gateFacingFiles,
    stageStatus,
  };
}
