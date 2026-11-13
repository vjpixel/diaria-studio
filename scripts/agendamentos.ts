#!/usr/bin/env node
/**
 * scripts/agendamentos.ts (#12774) — CLI do banco de agendamentos
 * (`data/agendamentos/banco.json`, lógica em `scripts/lib/diaria/agendamentos.ts`).
 *
 * Uso:
 *   npx tsx scripts/agendamentos.ts registrar --edicao 261111 --peca vertical-2 \
 *       --destinos youtube_shorts,instagram,tiktok --dias 7 --hora 12:00 \
 *       --dono "sessão /diaria-publica do dia" [--estado pendente|pronto|agendado] [--nota "..."]
 *     (`--destinos vertical` = os destinos da vertical da edição na config,
 *      `publishing.shorts`, os mesmos do plano do `publish-shorts.ts`;
 *      ou `--alvo 2026-11-18T12:00:00-03:00` no lugar de `--dias`/`--hora`;
 *      `--dias N` conta a partir da edição, `--hora` é BRT, default 12:00)
 *   npx tsx scripts/agendamentos.ts listar [--json] [--todos]
 *     (sem `--todos`, só os itens em aberto e os falhos)
 *   npx tsx scripts/agendamentos.ts marcar --id 261111-vertical-2 --estado pronto|agendado|falhou [--nota "..."]
 *   npx tsx scripts/agendamentos.ts marcar --id 261111-vertical-2 --estado publicado \
 *       --verificado-fonte "youtube videos.list" [--verificado-url URL]
 *     (`publicado` só com a releitura da plataforma, #573)
 *   npx tsx scripts/agendamentos.ts remover --id 261111-vertical-2
 *   npx tsx scripts/agendamentos.ts registrar-extras --edicao 261110 [--blocks PATH]
 *     (#12934: cada corte extra do blocks.json da montagem, menos o `guia`,
 *      vira item `pendente` peça `corte-{corte}`, alvo do plano do
 *      `video-extra-verticals.ts`; item existente fica como está)
 *   npx tsx scripts/agendamentos.ts estoque [--json] [--todos]
 *     (#12934: vídeos prontos e não usados, cruzando os blocks.json de todas
 *      as edições, data/cortes/ e o banco; lógica em `lib/diaria/cortes-estoque.ts`)
 *   npx tsx scripts/agendamentos.ts verificar [--id 261111-vertical-2] [--dry-run] [--json]
 *     (relê na plataforma os itens `agendado` do vertical e marca `publicado`
 *      só quando TODOS os destinos do item foram relidos no ar, #573; lógica e
 *      leitores em `scripts/lib/diaria/agendamentos-verificar.ts`; destino sem
 *      leitor deixa o item como está; `--dry-run` relê sem gravar)
 *
 * Registrar o mesmo item duas vezes é no-op. Nenhum subcomando publica nada:
 * o banco só registra o que deve sair, quando e por quem; o `verificar` só LÊ
 * a plataforma.
 *
 * Exit 0 = ok; 1 = erro de uso, de validação ou de gravação (banco mudou
 * desde a leitura, transição inválida); 2 = `verificar` com alguma leitura
 * que falhou (o que foi confirmado é gravado mesmo assim).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyCliAction, isMainModule, parseArgs, type CliSpec } from "./lib/cli-args.ts";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { editionDir } from "./lib/edition-paths.ts";
import { defaultYouTubeUploadDeps } from "./lib/diaria/youtube-upload.ts";
import { leitoresPadrao, verificarAgendamentos, type LeitorDestino, type VerificacaoItem } from "./lib/diaria/agendamentos-verificar.ts";
import {
  montarEstoque,
  planejarRegistroExtras,
  registrarExtras,
  type EstoqueBlocks,
  type EstoqueCorteDir,
  type EstoqueItem,
} from "./lib/diaria/cortes-estoque.ts";
import { CORTE_SPEC_FILE, CORTES_REL_DIR, parseCorteSpec, type CorteSpec } from "./lib/diaria/short-corte.ts";
import { listShortDestinations, loadShortScheduleConfig, loadShortsConfig } from "./lib/diaria/short-video.ts";
import { readShortsRegistry } from "./lib/diaria/shorts-published-store.ts";
import { parseBlocksFile } from "./lib/diaria/video-montage.ts";
import {
  AGENDAMENTO_ESTADOS,
  ESTADOS_EM_ABERTO,
  addAgendamento,
  addDaysAammdd,
  agendamentosPath,
  brtAlvoIso,
  loadAgendamentos,
  removerAgendamento,
  saveAgendamentos,
  transicionarAgendamento,
  type AgendamentoEstado,
  type AgendamentoItem,
} from "./lib/diaria/agendamentos.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = "scripts/agendamentos.ts";

export const SUBCOMMAND_SPECS: Record<string, CliSpec> = {
  registrar: {
    script: `${SCRIPT} registrar`,
    values: ["edicao", "peca", "destinos", "dias", "hora", "alvo", "dono", "estado", "nota"],
    numeric: ["dias"],
  },
  listar: { script: `${SCRIPT} listar`, booleans: ["json", "todos"] },
  marcar: { script: `${SCRIPT} marcar`, values: ["id", "estado", "nota", "verificado-fonte", "verificado-url"] },
  remover: { script: `${SCRIPT} remover`, values: ["id"] },
  "registrar-extras": {
    script: `${SCRIPT} registrar-extras`,
    values: ["edicao", "blocks"],
    usage:
      `uso: npx tsx ${SCRIPT} registrar-extras --edicao AAMMDD [--blocks PATH]\n\n` +
      "Registra no banco, como `pendente`, cada corte extra do blocks.json da montagem (menos o `guia`, que é o vertical-2), " +
      "peça `corte-{corte}`, destinos da vertical na config e o alvo do plano do video-extra-verticals.ts (#12934).\n" +
      "Item que já existe fica como está. --blocks: default {edição}/_internal/video-montagem/blocks.json.",
  },
  estoque: {
    script: `${SCRIPT} estoque`,
    booleans: ["json", "todos"],
    usage:
      `uso: npx tsx ${SCRIPT} estoque [--json] [--todos]\n\n` +
      "Vídeos prontos e não usados (#12934): cruza os blocks.json de todas as edições, data/cortes/ e o banco.\n" +
      "Sem --todos, só os cortes sem envio, sem \"pode publicar\" e sem item agendado/publicado no banco.",
  },
  verificar: {
    script: `${SCRIPT} verificar`,
    values: ["id"],
    booleans: ["dry-run", "json"],
    usage:
      `uso: npx tsx ${SCRIPT} verificar [--id <id>] [--dry-run] [--json]\n\n` +
      "Relê na plataforma (só leitura) os itens `agendado` do vertical e marca `publicado` quando todos os destinos do item estão no ar (#573).\n" +
      "Sem --dry-run grava no banco os itens confirmados. Exit 2 = alguma leitura falhou.",
  },
};

export interface CliIo {
  root: string;
  now: Date;
  out: (s: string) => void;
  err: (s: string) => void;
}

function required(values: Record<string, string>, key: string): string {
  const v = values[key];
  if (v === undefined || v === "") throw new Error(`--${key} é obrigatório`);
  return v;
}

function parseEstado(s: string): AgendamentoEstado {
  if (!(AGENDAMENTO_ESTADOS as readonly string[]).includes(s)) {
    throw new Error(`--estado inválido: ${s} (aceitos: ${AGENDAMENTO_ESTADOS.join(", ")})`);
  }
  return s as AgendamentoEstado;
}

/**
 * `--destinos vertical` (#12774): os destinos da vertical da edição na config
 * (`listShortDestinations` de `publishing.shorts` em `{root}/platform.config.json`,
 * a mesma lista do plano do `publish-shorts.ts`), para a skill registrar o
 * vertical 2 sem digitar os ids à mão. Qualquer outro valor é a lista
 * separada por vírgula, como antes.
 */
export const DESTINOS_VERTICAL = "vertical";

export function resolveDestinos(raw: string, root: string): string[] {
  if (raw.trim() === DESTINOS_VERTICAL) {
    const configPath = join(root, "platform.config.json");
    let config: unknown;
    try {
      config = JSON.parse(readFileSync(configPath, "utf8"));
    } catch (e) {
      throw new Error(`--destinos ${DESTINOS_VERTICAL}: não li ${configPath}: ${(e as Error).message}`);
    }
    return listShortDestinations(loadShortsConfig(config)).map((d) => d.id);
  }
  return raw
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

/**
 * Lê as três fontes do estoque (#12934) a partir de `root`: os `blocks.json`
 * de `data/editions/` (layout aninhado `{AAMM}/{AAMMDD}` e o plano legado
 * `{AAMMDD}`), as pastas de `data/cortes/` e o banco. Arquivo ilegível vira
 * aviso e não derruba a listagem; o banco ilegível lança (como no `listar`).
 */
export function lerEstoque(root: string): { itens: EstoqueItem[]; avisos: string[] } {
  const avisos: string[] = [];
  const blocks: EstoqueBlocks[] = [];
  const editionsDir = join(root, "data", "editions");
  const editionDirs: string[] = [];
  const subdirs = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const name of subdirs(editionsDir)) {
    if (/^\d{6}$/.test(name)) editionDirs.push(join(editionsDir, name));
    else if (/^\d{4}$/.test(name)) for (const ed of subdirs(join(editionsDir, name))) if (/^\d{6}$/.test(ed)) editionDirs.push(join(editionsDir, name, ed));
  }
  for (const dir of editionDirs) {
    const p = join(dir, "_internal", "video-montagem", "blocks.json");
    if (!existsSync(p)) continue;
    try {
      const parsed = parseBlocksFile(JSON.parse(readFileSync(p, "utf8")));
      if (!parsed.ok) {
        avisos.push(`${p} inválido (${parsed.errors.join("; ")}): cortes desta edição fora da listagem`);
        continue;
      }
      blocks.push({ edition: parsed.file.edition, file: parsed.file });
    } catch (e) {
      avisos.push(`${p} ilegível (${(e as Error).message}): cortes desta edição fora da listagem`);
    }
  }
  const cortes: EstoqueCorteDir[] = [];
  const cortesDir = join(root, ...CORTES_REL_DIR.split("/"));
  for (const slug of subdirs(cortesDir)) {
    const dir = join(cortesDir, slug);
    const specPath = join(dir, CORTE_SPEC_FILE);
    if (!existsSync(specPath)) {
      cortes.push({ slug, spec: null, entries: [], erro: `${CORTE_SPEC_FILE} ausente` });
      continue;
    }
    let spec: CorteSpec;
    try {
      spec = parseCorteSpec(readFileSync(specPath, "utf8"), specPath);
    } catch (e) {
      cortes.push({ slug, spec: null, entries: null, erro: (e as Error).message });
      continue;
    }
    try {
      cortes.push({ slug, spec, entries: readShortsRegistry(dir, spec.date).entries });
    } catch (e) {
      cortes.push({ slug, spec, entries: null, erro: `registro de envios ilegível: ${(e as Error).message}` });
    }
  }
  const banco = loadAgendamentos(agendamentosPath(root));
  return { itens: montarEstoque({ blocks, cortes, banco }), avisos };
}

function formatEstoque(it: EstoqueItem): string[] {
  const fontes = [it.noBlocks ? "blocks.json" : null, it.temCorteDir ? "data/cortes" : null, it.bancoId ? `banco ${it.bancoId} (${it.bancoEstado})` : null]
    .filter(Boolean)
    .join(", ");
  return [
    `${it.slug}  ${it.usado ? "em uso " : "ESTOQUE"}  edição ${it.edicao || "?"}  ${it.titulo ? `"${it.titulo}"` : "(sem título)"}`,
    `  ${it.motivo}; fontes: ${fontes}${it.alvo ? `; alvo ${it.alvo}` : ""}`,
    ...it.avisos.map((a) => `  [aviso] ${a}`),
  ];
}

function formatItem(it: AgendamentoItem): string {
  return `${it.id}  ${it.estado.padEnd(9)}  alvo ${it.alvo}  destinos ${it.destinos.join(",")}  dono: ${it.dono}`;
}

/** Testável: roda um subcomando contra `io.root` e devolve o exit code. */
export function runAgendamentosCli(argv: readonly string[], io: CliIo): number {
  const [sub, ...rest] = argv;
  const spec = sub ? SUBCOMMAND_SPECS[sub] : undefined;
  if (!spec) {
    io.err(`uso: npx tsx ${SCRIPT} {${Object.keys(SUBCOMMAND_SPECS).join("|")}} [flags] (--help em cada subcomando)`);
    return sub === "--help" || sub === "-h" ? 0 : 1;
  }
  if (sub === "verificar") {
    io.err(`[${SCRIPT}] verificar é assíncrono: use runVerificarCli`);
    return 1;
  }
  const cliExit = applyCliAction(rest, spec, { out: io.out, err: io.err });
  if (cliExit !== null) return cliExit;
  const { values, flags } = parseArgs([...rest]);
  const path = agendamentosPath(io.root);

  try {
    if (sub === "listar") {
      const banco = loadAgendamentos(path);
      const itens = flags.has("todos")
        ? banco.itens
        : banco.itens.filter((it) => ESTADOS_EM_ABERTO.includes(it.estado) || it.estado === "falhou");
      const sorted = [...itens].sort((a, b) => a.alvo.localeCompare(b.alvo));
      if (flags.has("json")) io.out(JSON.stringify({ revisao: banco.revisao, itens: sorted }, null, 2));
      else if (sorted.length === 0) io.out("(nenhum item)");
      else for (const it of sorted) io.out(formatItem(it));
      return 0;
    }

    if (sub === "estoque") {
      const { itens, avisos } = lerEstoque(io.root);
      for (const a of avisos) io.err(`[aviso] ${a}`);
      const mostrar = flags.has("todos") ? itens : itens.filter((it) => !it.usado);
      if (flags.has("json")) io.out(JSON.stringify({ itens: mostrar }, null, 2));
      else if (mostrar.length === 0) io.out(flags.has("todos") ? "(nenhum corte)" : "(nenhum corte pronto sem uso)");
      else for (const it of mostrar) for (const line of formatEstoque(it)) io.out(line);
      return 0;
    }

    const banco = loadAgendamentos(path);

    if (sub === "registrar-extras") {
      const edicao = required(values, "edicao");
      if (!/^\d{6}$/.test(edicao)) throw new Error("--edicao precisa ser AAMMDD");
      const blocksPath = resolve(io.root, values.blocks ?? join(editionDir(edicao), "_internal", "video-montagem", "blocks.json"));
      if (!existsSync(blocksPath)) throw new Error(`blocks.json ausente: ${blocksPath}`);
      const parsed = parseBlocksFile(JSON.parse(readFileSync(blocksPath, "utf8")));
      if (!parsed.ok) throw new Error(`blocks.json inválido: ${parsed.errors.join("; ")}`);
      if (parsed.file.edition !== edicao) throw new Error(`blocks.json é da edição ${parsed.file.edition}, não ${edicao}`);
      const config = JSON.parse(readFileSync(join(io.root, "platform.config.json"), "utf8"));
      const novos = planejarRegistroExtras({
        edition: edicao,
        file: parsed.file,
        sched: loadShortScheduleConfig(config),
        destinos: resolveDestinos(DESTINOS_VERTICAL, io.root),
      });
      if (novos.length === 0) {
        io.out(`(edição ${edicao} sem corte extra além do guia: nada a registrar)`);
        return 0;
      }
      const { banco: next, resultados } = registrarExtras(banco, novos, io.now);
      if (resultados.some((r) => r.status === "criado")) saveAgendamentos(path, next);
      for (const r of resultados) {
        if (r.status === "criado") io.out(`registrado: ${formatItem(r.item)}`);
        else if (r.status === "ja-registrado") io.out(`já registrado (sem mudança): ${formatItem(r.item)}`);
        else io.err(`[aviso] ${r.id} ${r.motivo}`);
      }
      return 0;
    }

    if (sub === "registrar") {
      const edicao = required(values, "edicao");
      let alvo = values.alvo;
      if (alvo && (values.dias !== undefined || values.hora !== undefined)) {
        throw new Error("use --alvo OU --dias/--hora, não os dois");
      }
      if (!alvo) {
        const dias = Number(required(values, "dias"));
        if (!Number.isInteger(dias)) throw new Error("--dias precisa ser inteiro");
        alvo = brtAlvoIso(addDaysAammdd(edicao, dias), values.hora ?? "12:00");
      } else if (!/(Z|[+-]\d{2}:\d{2})$/.test(alvo)) {
        throw new Error("--alvo precisa de fuso explícito (ex.: 2026-11-18T12:00:00-03:00)");
      }
      const res = addAgendamento(
        banco,
        {
          edicao,
          peca: required(values, "peca"),
          destinos: resolveDestinos(required(values, "destinos"), io.root),
          alvo,
          dono: required(values, "dono"),
          estado: values.estado ? parseEstado(values.estado) : undefined,
          nota: values.nota,
        },
        io.now,
      );
      if (!res.created) {
        io.out(`já registrado (sem mudança): ${formatItem(res.item)}`);
        return 0;
      }
      saveAgendamentos(path, res.banco);
      io.out(`registrado: ${formatItem(res.item)}`);
      return 0;
    }

    if (sub === "marcar") {
      const para = parseEstado(required(values, "estado"));
      const fonte = values["verificado-fonte"];
      if ((fonte || values["verificado-url"]) && para !== "publicado") {
        throw new Error("--verificado-fonte/--verificado-url só valem com --estado publicado");
      }
      if (values["verificado-url"] && !fonte) throw new Error("--verificado-url exige --verificado-fonte");
      const verificacao = fonte
        ? { fonte, em: io.now.toISOString(), ...(values["verificado-url"] ? { url: values["verificado-url"] } : {}) }
        : undefined;
      const next = transicionarAgendamento(banco, { id: required(values, "id"), para, nota: values.nota, verificacao }, io.now);
      saveAgendamentos(path, next);
      io.out(`marcado: ${formatItem(next.itens.find((it) => it.id === values.id)!)}`);
      return 0;
    }

    // remover
    const id = required(values, "id");
    saveAgendamentos(path, removerAgendamento(banco, id));
    io.out(`removido: ${id}`);
    return 0;
  } catch (e) {
    io.err(`[${SCRIPT}] ${(e as Error).message}`);
    return 1;
  }
}

function formatVerificacao(v: VerificacaoItem): string[] {
  const head = v.publicado ? `${v.item.id}: publicado (todos os destinos relidos no ar)` : `${v.item.id}: continua agendado`;
  return [
    head,
    ...v.leituras.map((l) => `  ${l.destino.padEnd(22)} ${l.status}${"fonte" in l ? ` (${l.fonte}${l.url ? `, ${l.url}` : ""})` : `: ${l.motivo}`}`),
  ];
}

/**
 * Testável: `verificar` (#12774, #573). Relê os itens `agendado` com os
 * `leitores` (default: `leitoresPadrao` com o ambiente do projeto) e grava
 * `publicado` só nos itens com todos os destinos confirmados. A gravação relê
 * o banco e aplica as transições sobre a versão em disco (revisão otimista).
 */
export async function runVerificarCli(
  argv: readonly string[],
  io: CliIo,
  leitores?: Readonly<Record<string, LeitorDestino>>,
): Promise<number> {
  const spec = SUBCOMMAND_SPECS.verificar;
  const cliExit = applyCliAction([...argv], spec, { out: io.out, err: io.err });
  if (cliExit !== null) return cliExit;
  const { values, flags } = parseArgs([...argv]);
  const path = agendamentosPath(io.root);
  try {
    const banco = loadAgendamentos(path);
    if (values.id && !banco.itens.some((it) => it.id === values.id)) throw new Error(`item ${values.id} não existe`);
    const resultados = await verificarAgendamentos(
      banco,
      { root: io.root, now: io.now, leitores: leitores ?? leitoresPadrao({ deps: defaultYouTubeUploadDeps, env: process.env }) },
      values.id,
    );
    const confirmados = resultados.filter((r) => r.publicado);
    const comErro = resultados.some((r) => r.leituras.some((l) => l.status === "erro"));
    if (confirmados.length && !flags.has("dry-run")) {
      // Relê o banco: entre a leitura e agora alguém pode ter marcado o item à mão.
      let next = loadAgendamentos(path);
      let changed = false;
      for (const r of confirmados) {
        if (next.itens.find((it) => it.id === r.item.id)?.estado !== "agendado") {
          io.err(`[${SCRIPT}] ${r.item.id} mudou de estado durante a releitura: não marcado`);
          continue;
        }
        next = transicionarAgendamento(next, { id: r.item.id, para: "publicado", verificacao: r.verificacao, nota: "relido na plataforma (agendamentos.ts verificar)" }, io.now);
        changed = true;
      }
      if (changed) saveAgendamentos(path, next);
    }
    if (flags.has("json")) {
      io.out(JSON.stringify({ dryRun: flags.has("dry-run"), resultados: resultados.map((r) => ({ id: r.item.id, publicado: r.publicado, verificacao: r.verificacao ?? null, leituras: r.leituras })) }, null, 2));
    } else if (resultados.length === 0) {
      io.out("(nenhum item agendado para verificar)");
    } else {
      for (const r of resultados) for (const line of formatVerificacao(r)) io.out(line);
      if (confirmados.length) io.out(flags.has("dry-run") ? `--dry-run: ${confirmados.length} item(ns) seriam marcados publicado` : `${confirmados.length} item(ns) marcados publicado`);
    }
    return comErro ? 2 : 0;
  } catch (e) {
    io.err(`[${SCRIPT}] ${(e as Error).message}`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const io: CliIo = { root: ROOT, now: new Date(), out: (s) => console.log(s), err: (s) => console.error(s) };
  if (argv[0] === "verificar") {
    loadProjectEnv(ROOT);
    runVerificarCli(argv.slice(1), io).then(
      (code) => (process.exitCode = code),
      (e) => {
        console.error(`[${SCRIPT}] erro fatal:`, e);
        process.exitCode = 1;
      },
    );
  } else {
    process.exitCode = runAgendamentosCli(argv, io);
  }
}
