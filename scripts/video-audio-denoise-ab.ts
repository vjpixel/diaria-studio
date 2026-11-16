#!/usr/bin/env -S npx tsx
/**
 * video-audio-denoise-ab.ts (#13234) — A/B cego dos motores de redução de
 * ruído da faixa tratada, no mesmo trecho do bruto.
 *
 * A escolha entre o ffmpeg atual (afftdn + agate, #12102/#12262) e o
 * DeepFilterNet é de ouvido: este script prepara o par cego e as medidas, e o
 * editor escolhe. Variantes: o áudio cru, o tratamento atual, o DeepFilterNet
 * sem teto e com teto reduzido (`--df-atten-db`, padrão 18 dB), e o export do
 * Adobe Podcast quando `--reference` é dado (cortado na mesma janela: o export
 * precisa estar na linha do tempo do bruto). Sem `deep-filter` instalado, as
 * variantes dele saem da lista com `[aviso]`.
 *
 * Saída em `--out` (padrão: diretório temporário novo): `ab-A.wav`, `ab-B.wav`,
 * ... em ordem embaralhada, e `ab-chave.json` com o que é cada letra e as
 * medidas (piso nas pausas, nível da fala, separação, LUFS integrado, energia
 * acima de 5 kHz na fala em relação à banda inteira: sibilantes). O terminal
 * não mostra a chave, para o A/B seguir cego; abrir o JSON só depois de
 * escolher.
 *
 * Só lê o bruto e grava em `--out`; não toca o Drive nem a pasta da edição.
 *
 * Uso: npx tsx scripts/video-audio-denoise-ab.ts --src BRUTO [--start S] [--dur S]
 *        [--out DIR] [--threshold-db N] [--df-atten-db N] [--reference ADOBE.wav] [--seed N]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isMainModule, parseArgs } from "./lib/cli-args.ts";
import { runCli } from "./lib/cli-exit.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { audioLevelStats, deepFilterBin, DEEP_FILTER_REDUCED_ATTEN_DB, parseDeepFilterVersion, shuffled, type AudioLevelStats } from "./lib/diaria/audio-denoise.ts";
import { audioCleanFilter, audioCleanParams, parseLoudnormJson, SILENCE_DETECT } from "./lib/diaria/video-montage.ts";
import { renderDeepFilter } from "./video-montagem.ts";

export type AbVariantId = "cru" | "ffmpeg-atual" | "deepfilternet" | "deepfilternet-reduzido" | "adobe";

export interface AbVariant {
  id: AbVariantId;
  description: string;
}

/** As variantes do A/B, na ordem de referência (antes de embaralhar). */
export function abVariants(o: { deepFilter: boolean; reference: boolean; thresholdDb: number; reducedAttenDb: number }): AbVariant[] {
  const v: AbVariant[] = [
    { id: "cru", description: "áudio cru do bruto" },
    { id: "ffmpeg-atual", description: `tratamento atual (${audioCleanFilter(audioCleanParams(o.thresholdDb))})` },
  ];
  if (o.deepFilter) {
    v.push({ id: "deepfilternet", description: "DeepFilterNet, sem teto de atenuação" });
    v.push({ id: "deepfilternet-reduzido", description: `DeepFilterNet, teto de ${o.reducedAttenDb} dB` });
  }
  if (o.reference) v.push({ id: "adobe", description: "export do Adobe Podcast (referência)" });
  return v;
}

/** Letra cega de cada variante (A, B, ...), na ordem embaralhada. */
export function blindAssignment(variants: readonly AbVariant[], random: () => number): { letter: string; variant: AbVariant }[] {
  return shuffled(variants, random).map((variant, i) => ({ letter: String.fromCharCode(65 + i), variant }));
}

/** Gerador determinístico (mulberry32) para `--seed`: o mesmo seed repete o embaralhamento. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ffmpeg(args: string[]): { stdout: Buffer; stderr: string } {
  const r = spawnSync("ffmpeg", args, { maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw new Error(`ffmpeg: ${r.error.message}`);
  const stderr = String(r.stderr ?? "");
  if (r.status !== 0) throw new Error(`ffmpeg saiu ${r.status}: ${stderr.trim().split(/\r?\n/).slice(-4).join(" | ")}`);
  return { stdout: r.stdout as Buffer, stderr };
}

const RATE = 48000;

function decodeS16(path: string, filter?: string): Int16Array {
  const out = ffmpeg(["-v", "error", "-i", path, ...(filter ? ["-af", filter] : []), "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-"]).stdout;
  return new Int16Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 2));
}

export interface AbMetrics extends AudioLevelStats {
  lufs: number | null;
  /** Nível da fala acima de 5 kHz menos o da banda inteira (dB): queda = sibilantes comidas. */
  hfRelDb: number;
}

function measure(path: string): AbMetrics {
  const stats = audioLevelStats(decodeS16(path), RATE);
  const hf = audioLevelStats(decodeS16(path, "highpass=f=5000:poles=2"), RATE);
  const loud = parseLoudnormJson(ffmpeg(["-hide_banner", "-nostats", "-i", path, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json", "-f", "null", "-"]).stderr);
  return { ...stats, lufs: loud?.inputI ?? null, hfRelDb: hf.speechDb - stats.speechDb };
}

function deepFilterAvailable(): string | null {
  const r = spawnSync(deepFilterBin(process.env.DIARIA_DEEP_FILTER), ["--version"], { encoding: "utf8", shell: process.platform === "win32" });
  return r.error || r.status !== 0 ? null : parseDeepFilterVersion(`${r.stdout}\n${r.stderr}`);
}

function num(raw: string | undefined, label: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!raw.trim() || !Number.isFinite(n)) throw new Error(`${label} espera um número (recebido: "${raw}")`);
  return n;
}

async function main(): Promise<number> {
  loadProjectEnv(resolve(import.meta.dirname, ".."));
  const { values } = parseArgs(process.argv.slice(2));
  const src = values["src"];
  if (!src || !existsSync(src)) throw new Error("--src BRUTO obrigatório (arquivo do bruto ou do áudio dele)");
  const start = num(values["start"], "--start", 0);
  const dur = num(values["dur"], "--dur", 60);
  const thresholdDb = num(values["threshold-db"], "--threshold-db", SILENCE_DETECT.noiseDb);
  const reducedAttenDb = num(values["df-atten-db"], "--df-atten-db", DEEP_FILTER_REDUCED_ATTEN_DB);
  const reference = values["reference"];
  if (reference && !existsSync(reference)) throw new Error(`--reference ${reference} não existe`);
  const out = values["out"] ?? mkdtempSync(join(tmpdir(), "denoise-ab-"));
  mkdirSync(out, { recursive: true });
  const work = join(out, "_trabalho");
  mkdirSync(work, { recursive: true });

  const dfVersion = deepFilterAvailable();
  if (!dfVersion) console.error(`[aviso] ${deepFilterBin(process.env.DIARIA_DEEP_FILTER)} não encontrado: o A/B sai sem as variantes do DeepFilterNet (docs/setup.md, "Vídeo: montagem")`);
  const variants = abVariants({ deepFilter: dfVersion !== null, reference: Boolean(reference), thresholdDb, reducedAttenDb });

  const cut = (from: string, to: string) =>
    ffmpeg(["-y", "-v", "error", "-ss", String(start), "-t", String(dur), "-i", from, "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", "-f", "wav", to]);
  const cru = join(work, "cru.wav");
  cut(src, cru);
  const files: Record<string, string> = {};
  for (const v of variants) {
    const path = join(work, `${v.id}.wav`);
    if (v.id === "cru") copyFileSync(cru, path);
    else if (v.id === "ffmpeg-atual") ffmpeg(["-y", "-v", "error", "-i", cru, "-af", audioCleanFilter(audioCleanParams(thresholdDb)), "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", "-f", "wav", path]);
    else if (v.id === "adobe") cut(reference!, path);
    else renderDeepFilter({ src: cru, part: path, tmpDir: join(work, `df-${v.id}`), attenDb: v.id === "deepfilternet-reduzido" ? reducedAttenDb : null }, { ffmpeg: (a) => void ffmpeg(a) });
    files[v.id] = path;
  }

  const blind = blindAssignment(variants, values["seed"] !== undefined ? seededRandom(num(values["seed"], "--seed", 0)) : Math.random);
  const key = blind.map(({ letter, variant }) => {
    const file = join(out, `ab-${letter}.wav`);
    copyFileSync(files[variant.id], file);
    return { letter, file, variant: variant.id, description: variant.description, metrics: measure(file) };
  });
  rmSync(work, { recursive: true, force: true });
  writeFileSync(join(out, "ab-chave.json"), JSON.stringify({ src, start, dur, thresholdDb, deepFilterVersion: dfVersion, reducedAttenDb, reference: reference ?? null, key }, null, 2) + "\n");
  console.log(`A/B cego em ${out} (${start}s a ${start + dur}s do bruto):`);
  for (const k of key) console.log(`  ab-${k.letter}.wav`);
  console.log(`Chave e medidas em ${join(out, "ab-chave.json")}: abrir só depois de escolher de ouvido (sibilantes e finais de palavra, #13194).`);
  return 0;
}

if (isMainModule(import.meta.url)) runCli(main);
