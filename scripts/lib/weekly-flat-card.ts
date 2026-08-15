/**
 * weekly-flat-card.ts (#5330)
 *
 * Card 4:5 SEM foto — capa e CTA final do carrossel semanal do Instagram.
 * Decisão do editor (#5330, 260815): os dois carrosséis semanais (destaques
 * e mais clicados, ver `weekly-instagram-select.ts`) passam a abrir com um
 * slide de apresentação e fechar com um slide de CTA de assinatura — nenhum
 * dos dois tem imagem gerada por IA (custo zero, e diferencia visualmente
 * "isto é uma moldura do post" dos 5 cards de notícia no meio, que usam a
 * arte publicada de verdade).
 *
 * Layout reusa a MESMA tipografia/hierarquia de `buildOverlaySvg`
 * (gen-social-card-4x5.ts) — título serif branco, filete teal, rodapé
 * `diar.ia.br` — só troca a arte de fundo por um fundo sólido (`COLORS.ink`,
 * DS canônico, nunca cor inventada) com leve gradiente pra não ficar chapado.
 *
 * Cache: `data/weekly/{key}/_internal/06-flat-cards.json`, chave
 * `{slot}` ("cover" | "cta") — idempotente, mesmo padrão de
 * `06-public-images.json` (nunca regenera/reupload se a chave já existe).
 * `{key}` é o identificador do carrossel (`{saturday}-{mode}`, ver
 * `publish-weekly-social.ts`) — cover/CTA de "destaques" e "mais clicados"
 * nunca colidem mesmo publicados no mesmo sábado.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { COLORS, FONTS } from "./shared/design-tokens.ts";
import { assertBrandSerifAvailable } from "./shared/assert-brand-font.ts";
import { uploadImageToWorkerKV } from "./cloudflare-kv-upload.ts";
import { DIARIA_EIA_URL } from "./canonical-urls.ts";
import { esc, wrapTitle } from "../gen-social-card-4x5.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const W = 1080;
const H = 1350;
const PAD = 79; // 7.3% de 1080, mesma margem lateral do overlay de notícia.

const FONT_SANS = "'Geist', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif";

export interface FlatCardText {
  kicker: string;
  title: string;
  /** Rodapé — texto livre (ex: "diar.ia.br" na capa, "Link na bio" no CTA). */
  footer: string;
}

/**
 * Pure: monta o SVG do card sem foto — fundo sólido `COLORS.ink` com leve
 * gradiente, filete teal + kicker (mesma posição do overlay de notícia),
 * título serif branco, rodapé.
 *
 * Wrap e tamanho de fonte reusam EXATAMENTE a fórmula de `buildOverlaySvg`
 * (`wrapTitle`, divisor 26, fator 0.52, clamp 44-88) — achado ao vivo
 * (#5330, review do editor): usar constantes próprias (divisor 24, fator
 * 0.5, clamp 48-84) deixava o título da capa/CTA visivelmente
 * desproporcional ao título dos 5 cards de notícia no mesmo carrossel.
 */
export function buildFlatCardSvg(text: FlatCardText): string {
  const available = W - PAD * 2;
  const lines = wrapTitle(text.title, Math.floor(available / 26));
  const longest = Math.max(...lines.map((l) => l.length));
  const size = Math.max(44, Math.min(88, Math.floor(available / (longest * 0.52))));
  const lineGap = Math.round(size * 1.18);
  const baseY = H - 150;
  const startY = baseY - (lines.length - 1) * lineGap;
  const titleLines = lines
    .map(
      (line, i) =>
        `<text x="${PAD}" y="${startY + i * lineGap}" font-family="${FONTS.serif}" font-size="${size}" font-weight="400" fill="#FFFFFF">${esc(line)}</text>`,
    )
    .join("\n  ");
  const kickerY = startY - size - 46;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0.35" y2="1">
      <stop offset="0" stop-color="#242019"/>
      <stop offset="1" stop-color="${COLORS.ink}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#bg)"/>
  <rect x="${PAD}" y="${kickerY - 64}" width="64" height="6" rx="3" fill="${COLORS.brand}"/>
  <text x="${PAD}" y="${kickerY}" font-family="${FONT_SANS}" font-size="30" font-weight="700" letter-spacing="2" fill="${COLORS.brand}">${esc(text.kicker.toUpperCase())}</text>
  ${titleLines}
  <text x="${PAD}" y="${H - 62}" font-family="${FONTS.serif}" font-size="34" fill="#FFFFFF">${esc(text.footer)}</text>
</svg>`;
}

/** Renderiza `buildFlatCardSvg` pra um JPEG em disco. */
export async function renderFlatCard(text: FlatCardText, outPath: string): Promise<string> {
  await sharp({ create: { width: W, height: H, channels: 3, background: COLORS.ink } })
    .composite([{ input: Buffer.from(buildFlatCardSvg(text)), top: 0, left: 0 }])
    .jpeg({ quality: 88 })
    .toFile(outPath);
  return outPath;
}

export type FlatCardSlot = "cover" | "cta";

function flatCardsCachePath(dataRoot: string, key: string): string {
  return resolve(dataRoot, "weekly", key, "_internal", "06-flat-cards.json");
}

function readFlatCardUrl(dataRoot: string, key: string, slot: FlatCardSlot): string | null {
  const p = flatCardsCachePath(dataRoot, key);
  if (!existsSync(p)) return null;
  try {
    const data = JSON.parse(readFileSync(p, "utf8")) as Record<string, { url?: string }>;
    return data[slot]?.url ?? null;
  } catch {
    return null;
  }
}

function writeFlatCardUrl(dataRoot: string, key: string, slot: FlatCardSlot, url: string): void {
  const p = flatCardsCachePath(dataRoot, key);
  mkdirSync(resolve(dataRoot, "weekly", key, "_internal"), { recursive: true });
  const existing = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  existing[slot] = { url };
  writeFileSync(p, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

export interface FlatCardGeneratorInput {
  text: FlatCardText;
  outPath: string;
  kvKey: string;
}

/**
 * Injetável — mesmo padrão de `SectionCardGenerator`
 * (weekly-instagram-ondemand-card.ts): testes passam um fake em vez do
 * gerador real, que checa fonte de marca + faz upload real pro KV
 * Cloudflare (rede + dependência de máquina, nunca exercitado em teste).
 */
export type FlatCardGenerator = (input: FlatCardGeneratorInput) => Promise<{ url: string }>;

/** Implementação REAL — NUNCA invocada em teste (mesma classe de restrição de `defaultSectionCardGenerator`). */
export const defaultFlatCardGenerator: FlatCardGenerator = async ({ text, outPath, kvKey }) => {
  await assertBrandSerifAvailable("weekly-flat-card");
  await renderFlatCard(text, outPath);

  const platformCfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId = platformCfg?.poll?.kv_namespace_id;
  const workerUrl = platformCfg?.poll?.worker_url ?? DIARIA_EIA_URL;
  if (!kvNamespaceId) {
    throw new Error("platform.config.json → poll.kv_namespace_id não configurado (card sem foto capa/CTA)");
  }
  const url = await uploadImageToWorkerKV(outPath, kvKey, { kvNamespaceId, workerUrl });
  return { url };
};

/**
 * Resolve a URL pública do card capa/CTA de um carrossel semanal: cache hit
 * retorna direto (nunca re-renderiza/re-upload); cache miss chama `generator`
 * (default `defaultFlatCardGenerator`) + grava no cache. `key` identifica o
 * carrossel (`{saturday}-{mode}`) — cover/CTA de "destaques" e "mais
 * clicados" nunca colidem.
 */
export async function resolveOrGenerateFlatCardUrl(
  dataRoot: string,
  key: string,
  slot: FlatCardSlot,
  text: FlatCardText,
  generator: FlatCardGenerator = defaultFlatCardGenerator,
): Promise<string> {
  const cached = readFlatCardUrl(dataRoot, key, slot);
  if (cached) return cached;

  const outDir = resolve(dataRoot, "weekly", key, "_internal");
  mkdirSync(outDir, { recursive: true });
  const outPath = resolve(outDir, `06-${slot}-4x5.jpg`);
  const kvKey = `weekly/${key}/${slot}-4x5.jpg`;

  const { url } = await generator({ text, outPath, kvKey });
  writeFlatCardUrl(dataRoot, key, slot, url);
  return url;
}
