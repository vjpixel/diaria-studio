/**
 * weekly-instagram-ondemand-card.ts (#4513)
 *
 * Card 4:5 SOB DEMANDA pra itens de RADAR que vencem o ranking por clique do
 * post semanal do Instagram (`weekly-instagram-select.ts`) mas NÃO têm o
 * card pré-gerado no Stage 3 diário (que só produz d1/d2/d3 — decisão do
 * editor #4513, briefing 260803: gerar sob demanda no fluxo SEMANAL, não
 * preventivamente pra todo item de toda edição — mais caro, e a maioria
 * nunca seria usada). **USE MELHOR também competiu aqui entre o #4513 e o
 * #5319 (260814)** — excluído do pool de candidatos em
 * `weekly-instagram-select.ts::normalizeInstagramSectionName`, então na
 * prática este módulo só recebe `section: "radar"` hoje. As funções abaixo
 * (`sectionCardCacheKey` etc.) continuam parametrizadas por seção de
 * propósito — geração de chave/cache é agnóstica a QUAL seção, e estreitar o
 * tipo aqui não evitaria bug nenhum (a exclusão real acontece na extração,
 * não aqui); os testes que exercitam `"use_melhor"` neste arquivo continuam
 * válidos como verificação de que chaves de seções diferentes nunca colidem.
 *
 * Reusa a MESMA pipeline de compositing (`generateCard`, de
 * `gen-social-card-4x5.ts` — já genérica em `destaque: string`, não travada
 * em d1/d2/d3) e o MESMO uploader (`uploadImageToWorkerKV`, de
 * `cloudflare-kv-upload.ts`) que D1/D2/D3 já usam. Só a GERAÇÃO da arte
 * NATIVA 4:5 (hoje só acessível via `image-generate.ts --destaque dN --ratio
 * 4x5`, chamado pelo Stage 3) precisa de um id de destaque sintético aqui —
 * `image-generate.ts` valida `--destaque` no formato `d\d+`, e o #4513 optou
 * por NÃO alterar esse script (Stage 3 da diária permanece intocado).
 * `syntheticDestaqueIdFor` deriva um id `d9{10 dígitos}` determinístico a
 * partir da URL do item — nunca colide com d1/d2/d3 reais de nenhuma edição.
 *
 * Idempotência: a URL resolvida fica gravada em
 * `{editionDir}/06-public-images.json` sob a chave de `sectionCardCacheKey`
 * — MESMO arquivo que já guarda d1/d2/d3 (`upload-images-public.ts`), reusando
 * o padrão de merge-por-cima documentado lá (#1865: sempre carrega o cache
 * existente como base, nunca zera). Re-execuções do post semanal (ex: re-run
 * após falha de rede) NUNCA regeram a arte (custo de API paga) se a chave já
 * está presente — `resolveOrGenerateSectionCardUrl` checa o cache ANTES de
 * chamar o gerador.
 *
 * MVP de qualidade de prompt (honesto): D1/D2/D3 têm um prompt CÊNICO
 * dedicado, escrito por `writer-destaque` especificamente pra virar arte
 * (`_internal/02-d{n}-prompt.md`). RADAR/USE MELHOR nunca tiveram esse
 * prompt — o "texto editorial" que vira cena aqui é literalmente
 * título+corpo do item (`buildOnDemandEditorialText`). Suficiente pro caso de
 * uso raro (só quando o item VENCE o ranking semanal); se a qualidade da arte
 * incomodar, o próximo passo é gerar um prompt cênico dedicado via LLM antes
 * de chamar `image-generate.ts`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCard } from "../gen-social-card-4x5.ts";
import { assertBrandSerifAvailable } from "./shared/assert-brand-font.ts";
import { uploadImageToWorkerKV } from "./cloudflare-kv-upload.ts";
import { cloudflareKvKey } from "../upload-images-public.ts";
import { DIARIA_EIA_URL } from "./canonical-urls.ts";
import type { InstagramRankedCandidate } from "./weekly-instagram-select.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * Normalização de URL local (host lowercase, sem query/hash/barra final) —
 * duplicada de propósito de `weekly-instagram-select.ts::normalizeUrl` em vez
 * de importada: esta é só a base de um HASH determinístico (não precisa
 * casar com nenhum outro consumidor), e evitar o import cruzado mantém este
 * módulo importável isoladamente em teste sem puxar o parser de markdown.
 */
function stableUrlKeyBase(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hostname = u.hostname.toLowerCase();
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw.trim();
  }
}

/**
 * Pure: chave de cache do card sob demanda pra um item de seção — determinística
 * por seção+URL, então re-execuções acham o mesmo card já gerado/uploadado.
 */
export function sectionCardCacheKey(section: "radar" | "use_melhor", url: string): string {
  const hash = createHash("md5").update(stableUrlKeyBase(url)).digest("hex").slice(0, 10);
  return `${section}_${hash}_4x5`;
}

/**
 * Pure: id de destaque SINTÉTICO (`d9{10 dígitos}`) determinístico a partir
 * da URL — satisfaz a validação `/^d\d+$/` de `image-generate.ts` sem alterar
 * esse script, e o prefixo `d9` nunca colide com d1/d2/d3 reais (nenhuma
 * edição tem 9+ destaques).
 */
export function syntheticDestaqueIdFor(url: string): string {
  const hash = createHash("md5").update(stableUrlKeyBase(url)).digest("hex");
  const digits = [...hash.slice(0, 10)].map((c) => String(parseInt(c, 16) % 10)).join("");
  return `d9${digits}`;
}

/** Pure: texto editorial que vira "cena" pro gerador de imagem — ver nota de MVP no cabeçalho do arquivo. */
export function buildOnDemandEditorialText(item: Pick<InstagramRankedCandidate, "title" | "body">): string {
  return `${item.title}. ${item.body}`.trim();
}

/**
 * Lê a URL cacheada (se houver) do card sob demanda pra uma chave, do mesmo
 * `06-public-images.json` que `upload-images-public.ts` já usa. Distingue
 * "chave ausente" de "JSON corrompido" (mesmo cuidado de
 * `resolveDestaqueImageDetailed` em `publish-weekly-social.ts`, #4511).
 */
export function readSectionCardUrl(
  editionDir: string,
  cacheKey: string,
): { url: string | null; corruptError?: string } {
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  if (!existsSync(publicImagesPath)) return { url: null };
  try {
    const data = JSON.parse(readFileSync(publicImagesPath, "utf8")) as {
      images?: Record<string, { url?: string }>;
    };
    return { url: data.images?.[cacheKey]?.url ?? null };
  } catch (e: any) {
    return { url: null, corruptError: e.message };
  }
}

/**
 * Grava a URL do card sob demanda em `06-public-images.json`, mergeando por
 * cima do cache existente (nunca zera as chaves d1/d2/d3 do Stage 3 — mesmo
 * cuidado de `mergeBaseFromCache` em `upload-images-public.ts`, #1865).
 */
export function writeSectionCardUrl(editionDir: string, cacheKey: string, url: string): void {
  const publicImagesPath = resolve(editionDir, "06-public-images.json");
  const existing = existsSync(publicImagesPath)
    ? JSON.parse(readFileSync(publicImagesPath, "utf8"))
    : { images: {} };
  existing.images = existing.images ?? {};
  existing.images[cacheKey] = { ...(existing.images[cacheKey] ?? {}), url, target: "cloudflare", cloudflare_url: url };
  writeFileSync(publicImagesPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

export interface SectionCardGeneratorInput {
  item: InstagramRankedCandidate;
  editionDir: string;
  /** Id sintético (`d9...`) usado como nome de arquivo/chave — ver `syntheticDestaqueIdFor`. */
  destaqueId: string;
}

/**
 * Injetável — testes passam um fake em vez do gerador real (que chama
 * `image-generate.ts` de verdade, gastando crédito de API). Mesmo padrão de
 * `UploadDeps` em `upload-images-public.ts`.
 */
export type SectionCardGenerator = (input: SectionCardGeneratorInput) => Promise<{ url: string }>;

/**
 * Implementação REAL — NUNCA invocada em teste (custo de API paga real,
 * mesma classe de restrição de `scripts/publish-*` — guard de publicação do
 * overnight/develop, ver `context/overnight-dispatch-rules.md` #1). Gera a
 * arte nativa 4:5 via `image-generate.ts` (subprocess, mesmo padrão de
 * spawn já usado por esse próprio script pra `crop-resize.ts`), compõe o
 * card com `generateCard` (mesma pipeline de D1/D2/D3), e faz upload pro
 * mesmo KV Cloudflare.
 */
export const defaultSectionCardGenerator: SectionCardGenerator = async ({ item, editionDir, destaqueId }) => {
  await assertBrandSerifAvailable("weekly-instagram-ondemand-card");

  const editorialText = buildOnDemandEditorialText(item);
  const internalDir = resolve(editionDir, "_internal");
  mkdirSync(internalDir, { recursive: true });
  const promptPath = resolve(internalDir, `06-${destaqueId}-ondemand-prompt.md`);
  writeFileSync(promptPath, editorialText, "utf8");

  const imageGenerateScript = resolve(ROOT, "scripts/image-generate.ts");
  execFileSync(
    process.execPath,
    ["--import", "tsx", imageGenerateScript, "--editorial", promptPath, "--out-dir", editionDir, "--destaque", destaqueId, "--ratio", "4x5"],
    { stdio: "inherit", cwd: ROOT },
  );

  const cardPath = await generateCard(editionDir, destaqueId, item.title, item.category, "4x5", "overlay");
  if (!cardPath) {
    throw new Error(
      `geração da arte 4x5 nativa não produziu ${destaqueId} em ${editionDir} — image-generate.ts deveria ter criado 04-${destaqueId}-4x5-nativo.jpg`,
    );
  }

  const platformCfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const kvNamespaceId = platformCfg?.poll?.kv_namespace_id;
  const workerUrl = platformCfg?.poll?.worker_url ?? DIARIA_EIA_URL;
  if (!kvNamespaceId) {
    throw new Error("platform.config.json → poll.kv_namespace_id não configurado (card sob demanda RADAR/USE MELHOR)");
  }

  const kvKey = cloudflareKvKey(editionDir, `${destaqueId}-4x5.jpg`);
  const url = await uploadImageToWorkerKV(cardPath, kvKey, { kvNamespaceId, workerUrl });
  return { url };
};

export interface SectionCardResolution {
  url: string | null;
  /** `true` quando o gerador FOI chamado nesta invocação (cache miss). `false` em cache hit ou erro. */
  generated: boolean;
  error?: string;
}

/**
 * Resolve a URL do card 4:5 de um item de RADAR/USE MELHOR: cache hit em
 * `06-public-images.json` retorna direto (idempotente, NUNCA regenera);
 * cache miss chama `generator` (default `defaultSectionCardGenerator`) e
 * grava o resultado no cache antes de retornar. Nunca lança — erros do
 * gerador viram `{url: null, error}` pro caller decidir a política de falha
 * (mesmo contrato de `resolveWeeklyImageUrls` em `publish-weekly-social.ts`).
 */
export async function resolveOrGenerateSectionCardUrl(
  item: InstagramRankedCandidate,
  editionDir: string,
  generator: SectionCardGenerator = defaultSectionCardGenerator,
): Promise<SectionCardResolution> {
  if (!item.section) {
    return {
      url: null,
      generated: false,
      error: `item sem section (kind=${item.kind}) — resolveOrGenerateSectionCardUrl só serve pra RADAR/USE MELHOR`,
    };
  }
  const cacheKey = sectionCardCacheKey(item.section, item.url);
  const cached = readSectionCardUrl(editionDir, cacheKey);
  if (cached.corruptError) {
    return { url: null, generated: false, error: `06-public-images.json corrompido: ${cached.corruptError}` };
  }
  if (cached.url) return { url: cached.url, generated: false };

  const destaqueId = syntheticDestaqueIdFor(item.url);
  try {
    const { url } = await generator({ item, editionDir, destaqueId });
    writeSectionCardUrl(editionDir, cacheKey, url);
    return { url, generated: true };
  } catch (e: any) {
    return { url: null, generated: false, error: e.message };
  }
}
