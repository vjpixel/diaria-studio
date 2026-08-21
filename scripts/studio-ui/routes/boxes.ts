/**
 * routes/boxes.ts — rotas da seção Caixas (#3924, #3937)
 * Extraído de server.ts seguindo o padrão de extração por feature.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readRequestBody, sendJson } from "../server.ts";
import {
  listBoxes,
  readBox,
  saveBox,
  createBox,
  archiveBox,
  unarchiveBox,
  listArchivedBoxes,
  readBoxSlotsState,
  saveBoxSlots,
  type SaveBoxOptions,
  type SaveBoxSlotsInput,
  type SaveBoxSlotsOptions,
} from "../studio-boxes.ts";

export async function handleBoxesList(rootDir: string, res: ServerResponse): Promise<void> {
  try {
    const boxes = listBoxes(rootDir);
    sendJson(res, 200, { boxes });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

export async function handleBoxGet(rootDir: string, slug: string, res: ServerResponse): Promise<void> {
  try {
    const box = readBox(rootDir, slug);
    sendJson(res, 200, box);
  } catch (e) {
    sendJson(res, 404, { error: (e as Error).message });
  }
}

export async function handleBoxSave(rootDir: string, slug: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req, 256 * 1024);
    const { content, expectedModifiedAt, force } = JSON.parse(body) as { content: string; expectedModifiedAt?: string | null; force?: boolean };
    const opts: SaveBoxOptions = { expectedModifiedAt, force };
    const result = saveBox(rootDir, slug, content, opts);
    if (result.conflict) {
      sendJson(res, 409, result);
    } else if (result.notFound) {
      sendJson(res, 404, result);
    } else if (!result.ok) {
      sendJson(res, 400, result);
    } else {
      sendJson(res, 200, result);
    }
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

export async function handleBoxCreate(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req, 256 * 1024);
    const { slug, content } = JSON.parse(body) as { slug: string; content: string };
    const result = createBox(rootDir, slug, content);
    if (!result.ok) {
      sendJson(res, 400, result);
    } else {
      sendJson(res, 200, result);
    }
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

export async function handleBoxArchive(rootDir: string, slug: string, res: ServerResponse): Promise<void> {
  try {
    const result = archiveBox(rootDir, slug);
    if (!result.ok) {
      sendJson(res, 400, result);
    } else {
      sendJson(res, 200, result);
    }
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

export async function handleBoxUnarchive(rootDir: string, slug: string, res: ServerResponse): Promise<void> {
  try {
    const result = unarchiveBox(rootDir, slug);
    if (!result.ok) {
      sendJson(res, 400, result);
    } else {
      sendJson(res, 200, result);
    }
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

export async function handleArchivedBoxesList(rootDir: string, res: ServerResponse): Promise<void> {
  try {
    const boxes = listArchivedBoxes(rootDir);
    sendJson(res, 200, { boxes });
  } catch (e) {
    sendJson(res, 500, { error: (e as Error).message });
  }
}

export async function handleBoxSlotsGet(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const variant = new URL(req.url!, `http://localhost`).searchParams.get("variant") ?? "default";
    const state = readBoxSlotsState(rootDir, variant as "default" | "patronos");
    sendJson(res, 200, state);
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}

export async function handleBoxSlotsSave(rootDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readRequestBody(req, 256 * 1024);
    const { slot0, slot1, slot2, slot3, variant, expectedModifiedAt, force } = JSON.parse(body) as SaveBoxSlotsInput & SaveBoxSlotsOptions;
    const opts: SaveBoxSlotsOptions = { variant, expectedModifiedAt, force };
    const input: SaveBoxSlotsInput = { slot0, slot1, slot2, slot3 };
    const result = saveBoxSlots(rootDir, input, opts);
    if (!result.ok) {
      sendJson(res, 400, result);
    } else {
      sendJson(res, 200, result);
    }
  } catch (e) {
    sendJson(res, 400, { error: (e as Error).message });
  }
}