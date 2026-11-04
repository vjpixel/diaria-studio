/**
 * probe-public-images-r2.ts (#11412, passos 2 e 3 da ativação)
 *
 * @one-off-validity: expira=2027-02-04 pergunta="o caminho R2 das imagens públicas (env, upload e GET nos dois Workers) está pronto para ligar public_images_r2.enabled? (#11412)"
 *
 * Confere, antes de ligar `platform.config.json → public_images_r2.enabled`,
 * que o caminho R2 das imagens públicas funciona de ponta a ponta. A ordem de
 * ativação vive no docstring de `scripts/lib/public-images-r2.ts`; este script
 * transforma os passos 2 (objeto de teste + GET nos dois Workers) e 3 (env do
 * R2) em um comando.
 *
 * Dois modos:
 *
 *   npx tsx scripts/probe-public-images-r2.ts
 *     Só leitura, sem rede: estado da flag e se o env do R2 está completo
 *     (passo 3). Sai 0 com o env pronto, 1 se faltar alguma var.
 *
 *   npx tsx scripts/probe-public-images-r2.ts --write [--edition AAMMDD]
 *     ESCREVE um JPEG pequeno (8x8, cor aleatória) no bucket de mídia, em
 *     `img/{AAMMDD}/r2-probe-{md5short}.jpg`, pelo MESMO uploader da edição
 *     (`makeR2ImageUploader`: PUT, HEAD na base pública e HEAD em
 *     `eia.diar.ia.br/img/…` e `diar.ia.br/img/…`). Depois faz GET nas duas
 *     URLs do Worker e confere 200, `Content-Type: image/jpeg`, `Cache-Control`
 *     com `immutable` e o tamanho do corpo. Sai 0 se tudo passar, 1 caso
 *     contrário. `--edition` default = data de hoje em BRT.
 *
 * O objeto de teste fica no bucket (algumas centenas de bytes, fora do prefixo
 * `shorts/` com retenção). A key nunca colide com imagem de edição: o nome
 * `r2-probe-…` não é gerado por nenhum uploader.
 *
 * Não liga a flag e não mexe no KV: o passo 4 continua sendo editar
 * `platform.config.json` (e a asserção de `test/public-images-r2-11412.test.ts`).
 */

import { loadProjectEnv } from "./lib/env-loader.ts";
loadProjectEnv();

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadR2UploadConfig, type R2UploadConfig, type R2UploadDeps } from "./lib/r2-object-upload.ts";
import {
  PUBLIC_IMAGE_SITE_ORIGIN,
  makeR2ImageUploader,
  readPublicImagesR2Settings,
  r2KeyForImageKey,
  workerImageUrl,
} from "./lib/public-images-r2.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_WORKER_URL = "https://eia.diar.ia.br";

/** Key `/img/` do objeto de teste: `img-{AAMMDD}-r2-probe-{md5short}.jpg` (content-addressed, mapeável pro R2). */
export function probeImageKey(aammdd: string, body: Buffer): string {
  if (!/^\d{6}$/.test(aammdd)) throw new Error(`probe-public-images-r2: edição "${aammdd}" não é AAMMDD`);
  const md5short = createHash("md5").update(body).digest("hex").slice(0, 8);
  return `img-${aammdd}-r2-probe-${md5short}.jpg`;
}

/** AAMMDD de `now` no fuso de São Paulo. */
export function brtAammdd(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "2-digit", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}${get("month")}${get("day")}`;
}

/**
 * Problemas de uma resposta GET de `/img/` para a imagem de teste. Lista vazia
 * = o Worker serve o objeto do R2 como serviria uma imagem de edição.
 */
export function servedImageProblems(
  res: { status: number; headers: { get(name: string): string | null } },
  bodyLength: number,
  expectedLength: number,
): string[] {
  const problems: string[] = [];
  if (res.status !== 200) {
    problems.push(`HTTP ${res.status} (esperado 200)`);
    return problems;
  }
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("image/jpeg")) problems.push(`Content-Type "${ct}" (esperado image/jpeg)`);
  const cc = res.headers.get("cache-control") ?? "";
  if (!/\bimmutable\b/i.test(cc)) problems.push(`Cache-Control "${cc}" sem immutable`);
  if (bodyLength !== expectedLength) problems.push(`corpo com ${bodyLength} bytes (o objeto tem ${expectedLength})`);
  return problems;
}

export interface ProbeResult {
  ok: boolean;
  imageKey: string;
  r2Key: string;
  checks: { url: string; problems: string[] }[];
  error?: string;
}

/**
 * Sobe `body` pelo uploader da edição e confere o GET nos dois Workers.
 * Injetável (`deps`, `writeTemp`) para teste sem rede.
 */
export async function runProbe(input: {
  config: R2UploadConfig;
  workerUrl: string;
  siteOrigin?: string;
  aammdd: string;
  body: Buffer;
  deps: R2UploadDeps;
  /** Grava o corpo num arquivo temporário e devolve [path, cleanup]. */
  writeTemp?: (body: Buffer) => [string, () => void];
}): Promise<ProbeResult> {
  const imageKey = probeImageKey(input.aammdd, input.body);
  const r2Key = r2KeyForImageKey(imageKey);
  if (!r2Key) throw new Error(`probe-public-images-r2: key "${imageKey}" sem forma R2`);
  const siteOrigin = input.siteOrigin ?? PUBLIC_IMAGE_SITE_ORIGIN;
  const writeTemp = input.writeTemp ?? defaultWriteTemp;
  const [path, cleanup] = writeTemp(input.body);
  try {
    const uploader = makeR2ImageUploader(input.config, input.workerUrl, input.deps, { siteOrigin });
    await uploader(path, imageKey, "image/jpeg");
  } catch (err) {
    return { ok: false, imageKey, r2Key, checks: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    cleanup();
  }

  const urls = [...new Set([workerImageUrl(input.workerUrl, imageKey), workerImageUrl(siteOrigin, imageKey)])];
  const checks: ProbeResult["checks"] = [];
  for (const url of urls) {
    try {
      const res = await input.deps.fetch(url, { method: "GET", headers: { "User-Agent": "diaria-studio/probe-public-images-r2" } });
      const buf = Buffer.from(await res.arrayBuffer());
      checks.push({ url, problems: servedImageProblems(res, buf.length, input.body.length) });
    } catch (err) {
      checks.push({ url, problems: [`GET falhou: ${err instanceof Error ? err.message : String(err)}`] });
    }
  }
  return { ok: checks.every((c) => c.problems.length === 0), imageKey, r2Key, checks };
}

function defaultWriteTemp(body: Buffer): [string, () => void] {
  const dir = mkdtempSync(join(tmpdir(), "r2-probe-"));
  const path = join(dir, "probe.jpg");
  writeFileSync(path, body);
  return [path, () => rmSync(dir, { recursive: true, force: true })];
}

async function makeProbeJpeg(): Promise<Buffer> {
  const sharp = (await import("sharp")).default;
  const c = () => Math.floor(Math.random() * 256);
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: c(), g: c(), b: c() } } }).jpeg().toBuffer();
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const editionIdx = args.indexOf("--edition");
  const aammdd = editionIdx >= 0 ? args[editionIdx + 1] ?? "" : brtAammdd(new Date());

  const cfg = JSON.parse(readFileSync(resolve(ROOT, "platform.config.json"), "utf8"));
  const settings = readPublicImagesR2Settings(cfg);
  const workerUrl: string = cfg?.poll?.worker_url ?? DEFAULT_WORKER_URL;
  const r2 = loadR2UploadConfig(process.env);

  const envReport = { flag_enabled: settings.enabled, env_ready: r2.ready, missing: r2.ready ? [] : r2.missing };
  if (!write) {
    console.log(JSON.stringify(envReport, null, 2));
    return r2.ready ? 0 : 1;
  }
  if (!r2.ready) {
    console.error(`probe-public-images-r2: falta ${r2.missing.join(", ")} — passo 3 da ativação pendente.`);
    console.log(JSON.stringify(envReport, null, 2));
    return 1;
  }

  const result = await runProbe({
    config: r2.config,
    workerUrl,
    aammdd,
    body: await makeProbeJpeg(),
    deps: { fetch: (u, i) => fetch(u, i), now: () => new Date() },
  });
  console.log(JSON.stringify({ ...envReport, ...result }, null, 2));
  return result.ok ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  runCli(main, { onError: (e) => console.error("probe-public-images-r2:", e) });
}
