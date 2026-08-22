/**
 * routes/boxes.ts (#5894)
 *
 * Rotas de API da seção "Caixas" (#3924/#3928/#3937/#3979/#4079/#4274/#4275).
 * Movidas de `server.ts` (#5894 — server.ts > 2300 linhas). Cada handler é
 * GLUE fina: parse request → chama `studio-boxes.ts` → serializa response via
 * `sendJson`. Leia a docstring de `server.ts` § #3924/#3937 pro contrato de
 * cada rota.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { listBoxes, readBox, saveBox, createBox, archiveBox, unarchiveBox, listArchivedBoxes, buildBoxContent, buildBoxContentWithNome, replaceBoxContentTitle, readBoxSlotsState, saveBoxSlots, readParaEncerrarState, saveParaEncerrar } from "../studio-boxes.ts";
import { sendJson, readRequestBody } from "../http-utils.ts";

const BOXES_MAX_BODY_BYTES = 500_000;

/** `GET /api/boxes` — lista dinâmica de `data/snippets/*.md` (#3924). */
export function handleApiBoxesList(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, { boxes: listBoxes(rootDir) });
}

/** `GET /api/boxes/:slug` — conteúdo + mtime de UMA caixa (#3924). */
export function handleApiBoxGet(rootDir: string, slug: string, res: ServerResponse): void {
  const state = readBox(rootDir, slug);
  sendJson(res, state.ok ? 200 : 404, state);
}

/** `PUT /api/boxes/:slug` — salva o conteúdo de UMA caixa (#3924). */
export async function handleApiBoxSave(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
  slug: string,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(req, BOXES_MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const parsed = body as {
    content?: unknown;
    body?: unknown;
    conteudo?: unknown;
    nome?: unknown;
    categoria?: unknown;
    notas?: unknown;
    titulo?: unknown;
    expectedModifiedAt?: unknown;
    force?: unknown;
  } | null;
  let content: string;
  if (typeof parsed?.conteudo === "string") {
    const nome = typeof parsed.nome === "string" ? parsed.nome : "";
    const categoria = typeof parsed.categoria === "string" ? parsed.categoria : "";
    const notas = typeof parsed.notas === "string" ? parsed.notas : "";
    const conteudo =
      typeof parsed.titulo === "string" ? replaceBoxContentTitle(parsed.conteudo, parsed.titulo) : parsed.conteudo;
    content = buildBoxContent({ nome, categoria, notas }, conteudo);
  } else if (typeof parsed?.body === "string") {
    const nome = typeof parsed.nome === "string" ? parsed.nome : "";
    content = buildBoxContentWithNome(nome, parsed.body);
  } else if (typeof parsed?.content === "string") {
    content = parsed.content;
  } else {
    sendJson(res, 400, {
      error:
        "corpo precisa de 'conteudo' (string, com 'nome'/'categoria'/'notas' opcionais), 'body' (string, com 'nome' opcional, legado) ou 'content' (string, legado)",
    });
    return;
  }
  let expectedModifiedAt: string | null | undefined;
  if (parsed && "expectedModifiedAt" in parsed) {
    const raw = parsed.expectedModifiedAt ?? null;
    if (raw !== null && typeof raw !== "string") {
      sendJson(res, 400, { error: "campo 'expectedModifiedAt' precisa ser string ISO ou null" });
      return;
    }
    expectedModifiedAt = raw;
  }
  const force = parsed?.force === true;
  const result = saveBox(rootDir, slug, content, { expectedModifiedAt, force });
  const status = result.ok ? 200 : result.conflict ? 409 : result.notFound ? 404 : 400;
  sendJson(res, status, result);
}

/** `POST /api/boxes` — cria uma caixa NOVA (#3928). Body `{slug, content}`. */
export async function handleApiBoxCreate(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(req, BOXES_MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const parsed = body as { slug?: unknown; content?: unknown; nome?: unknown; categoria?: unknown } | null;
  const slug = parsed?.slug;
  const content = parsed?.content;
  if (typeof slug !== "string" || !slug) {
    sendJson(res, 400, { error: "campo 'slug' (string) é obrigatório no corpo" });
    return;
  }
  if (typeof content !== "string") {
    sendJson(res, 400, { error: "campo 'content' (string) é obrigatório no corpo" });
    return;
  }
  const nome = typeof parsed?.nome === "string" ? parsed.nome : "";
  const categoria = typeof parsed?.categoria === "string" ? parsed.categoria : "";
  const finalContent =
    nome.trim() || categoria.trim() ? buildBoxContent({ nome, categoria, notas: "" }, content) : content;
  const result = createBox(rootDir, slug, finalContent);
  const status = result.ok ? 201 : result.exists ? 409 : 400;
  sendJson(res, status, result);
}

/** `POST /api/boxes/:slug/archive` — arquiva uma caixa (#3928). */
export function handleApiBoxArchive(rootDir: string, slug: string, res: ServerResponse): void {
  const result = archiveBox(rootDir, slug);
  const status = result.ok ? 200 : result.notFound ? 404 : result.blockedBySlot ? 409 : 400;
  sendJson(res, status, result);
}

/** `POST /api/boxes/:slug/unarchive` — restaura uma caixa arquivada (#3928). */
export function handleApiBoxUnarchive(rootDir: string, slug: string, res: ServerResponse): void {
  const result = unarchiveBox(rootDir, slug);
  const status = result.ok ? 200 : result.notFound ? 404 : result.conflict ? 409 : 400;
  sendJson(res, status, result);
}

/** `GET /api/boxes/archived` — lista caixas arquivadas (#3928). */
export function handleApiArchivedBoxesList(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, { boxes: listArchivedBoxes(rootDir) });
}

/** #4275: resolve `?variant=patronos` da query string. */
export function resolveBoxSlotVariantFromQuery(req: IncomingMessage): "default" | "patronos" {
  const v = new URL(req.url ?? "/", "http://localhost").searchParams.get("variant");
  return v === "patronos" ? "patronos" : "default";
}

/** `GET /api/boxes/slots` — atribuição atual dos 3 slots de divulgação (#3937). */
export function handleApiBoxSlotsGet(rootDir: string, req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, readBoxSlotsState(rootDir, resolveBoxSlotVariantFromQuery(req)));
}

/** `PUT /api/boxes/slots` — salva a atribuição dos 3 slots de divulgação (#3937). */
export async function handleApiBoxSlotsSave(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(req, BOXES_MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const parsed = body as {
    slot0?: unknown;
    slot1?: unknown;
    slot2?: unknown;
    slot3?: unknown;
    expectedModifiedAt?: unknown;
    force?: unknown;
    variant?: unknown;
  } | null;
  const slotField = (v: unknown): string | null => (v === undefined || v === null ? "" : typeof v === "string" ? v : null);
  const slot0 = slotField(parsed?.slot0);
  const slot1 = slotField(parsed?.slot1);
  const slot2 = slotField(parsed?.slot2);
  const slot3 = slotField(parsed?.slot3);
  if (slot0 === null || slot1 === null || slot2 === null || slot3 === null) {
    sendJson(res, 400, { error: "campos 'slot0'/'slot1'/'slot2'/'slot3' precisam ser string (slug da caixa) ou vazio" });
    return;
  }
  let expectedModifiedAt: string | null | undefined;
  if (parsed && "expectedModifiedAt" in parsed) {
    const raw = parsed.expectedModifiedAt ?? null;
    if (raw !== null && typeof raw !== "string") {
      sendJson(res, 400, { error: "campo 'expectedModifiedAt' precisa ser string ISO ou null" });
      return;
    }
    expectedModifiedAt = raw;
  }
  const force = parsed?.force === true;
  const variant = parsed?.variant === "patronos" ? "patronos" : "default";
  const result = saveBoxSlots(rootDir, { slot0, slot1, slot2, slot3 }, { expectedModifiedAt, force, variant });
  const status = result.ok ? 200 : result.conflict ? 409 : 400;
  sendJson(res, status, result);
}

/** `GET /api/boxes/para-encerrar` — conteúdo dos slots A/B do PARA ENCERRAR (#4274). */
export function handleApiParaEncerrarGet(rootDir: string, res: ServerResponse): void {
  sendJson(res, 200, readParaEncerrarState(rootDir));
}

/** `PUT /api/boxes/para-encerrar` — salva os slots A/B do PARA ENCERRAR (#4274). */
export async function handleApiParaEncerrarSave(
  rootDir: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: unknown;
  try {
    body = JSON.parse(await readRequestBody(req, BOXES_MAX_BODY_BYTES));
  } catch {
    sendJson(res, 400, { error: "corpo da request precisa ser JSON válido" });
    return;
  }
  const parsed = body as {
    slotA?: unknown;
    slotB?: unknown;
    expectedModifiedAt?: unknown;
    force?: unknown;
  } | null;
  const slotField = (v: unknown): string | null => (v === undefined || v === null ? "" : typeof v === "string" ? v : null);
  const slotA = slotField(parsed?.slotA);
  const slotB = slotField(parsed?.slotB);
  if (slotA === null || slotB === null) {
    sendJson(res, 400, { error: "campos 'slotA'/'slotB' precisam ser string ou vazio" });
    return;
  }
  let expectedModifiedAt: string | null | undefined;
  if (parsed && "expectedModifiedAt" in parsed) {
    const raw = parsed.expectedModifiedAt ?? null;
    if (raw !== null && typeof raw !== "string") {
      sendJson(res, 400, { error: "campo 'expectedModifiedAt' precisa ser string ISO ou null" });
      return;
    }
    expectedModifiedAt = raw;
  }
  const force = parsed?.force === true;
  const result = saveParaEncerrar(rootDir, { slotA, slotB }, { expectedModifiedAt, force });
  const status = result.ok ? 200 : result.conflict ? 409 : 400;
  sendJson(res, status, result);
}
