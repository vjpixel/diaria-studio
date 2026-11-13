/**
 * scripts/lib/diaria/cortes-estoque.ts (#12934)
 *
 * Os cortes extras da montagem no banco de agendamentos (#12774) e a visão de
 * ESTOQUE: os vídeos prontos que ainda não foram usados.
 *
 * Até o #12934 o banco só recebia o corte `guia` (vertical 2 do roteiro,
 * peça `vertical-2`), registrado pela `/diaria-video-montagem`. Os outros
 * cortes da montagem (as sequências com `corte` no `blocks.json`, #11898)
 * nunca entravam: `nvidia` (261110) e `automacao` (261111) só apareceram numa
 * varredura feita à mão, cruzando `blocks.json`, `data/cortes/` e o banco.
 *
 * Duas peças, ambas puras (a leitura do disco fica no CLI,
 * `scripts/agendamentos.ts registrar-extras` e `estoque`):
 *
 *   - `planejarRegistroExtras` + `registrarExtras`: cada corte extra do
 *     `blocks.json` (menos o `guia`, que a skill registra como `vertical-2`
 *     com D+7) vira um item `pendente` do banco, peça `corte-{corte}`
 *     (`pecaDoCorte`), com o alvo do plano do `video-extra-verticals.ts`
 *     (k-ésimo dia útil depois da edição, horário seguinte ao da principal).
 *     Assim um corte esquecido alarma no tick como qualquer item vencido.
 *   - `montarEstoque`: junta `blocks.json` (todas as edições), `data/cortes/`
 *     e o banco, e diz para cada corte se ele já foi usado. Pega também os
 *     cortes de antes do registro no banco e os cortes feitos à mão (só
 *     `data/cortes/`, sem `blocks.json`).
 *
 * "Usado" = o registro do corte tem algum envio (`_internal/06-shorts-published*.json`,
 * qualquer status: `published`, `scheduled` ou `send_unknown`), ou o
 * `corte.json` tem o "pode publicar" do editor (`publish_confirmed_at`, o
 * timer do 300 publica sozinho a partir dali, #11912), ou o item do banco está
 * `agendado`/`publicado`. É o que a pergunta do editor quer dizer ("vídeos que
 * ainda não foram usados"): o estoque é o que ninguém mandou sair.
 */

import type { AgendamentoEstado, AgendamentoItem, AgendamentosBanco, NovoAgendamento } from "./agendamentos.ts";
import { addAgendamento, brtAlvoIso } from "./agendamentos.ts";
import { corteDaPeca, pecaDoCorte } from "./agendamentos-verificar.ts";
import { extraVerticalSlug, planExtraVerticals } from "./extra-verticals.ts";
import { VERTICAL2_CORTE_SLUG } from "./roteiro-videos.ts";
import type { CorteSpec } from "./short-corte.ts";
import type { ShortPublishedEntry, ShortScheduleConfig } from "./short-video.ts";
import type { BlocksFile } from "./video-montage.ts";

// ─── Registro dos extras no banco ────────────────────────────────────────────

/** Dono dos itens dos cortes extras: quem publica é o modo corte, depois do "pode publicar". */
export function donoDoCorteExtra(slug: string): string {
  return `modo corte ${slug} (publish-shorts.ts --corte), após o "pode publicar" do editor`;
}

/**
 * Puro: os itens do banco para os cortes extras da edição. O `guia` fica de
 * fora (a skill o registra como `vertical-2`, alvo D+7, #12774). O alvo é o
 * do plano (`planExtraVerticals`): o dia útil e o horário em que o
 * `video-extra-verticals.ts` manda publicar. Os `problems` do plano (export
 * ainda não encontrado, falta de título ou gancho) não impedem o registro:
 * na montagem o export ainda nem existe, e o corte entra no estoque desde já.
 */
export function planejarRegistroExtras(input: {
  edition: string;
  file: Pick<BlocksFile, "blocks" | "sequences">;
  sched: ShortScheduleConfig;
  destinos: readonly string[];
}): NovoAgendamento[] {
  if (!input.destinos.length) throw new Error("nenhum destino da vertical na config: o item do banco precisa de destinos");
  return planExtraVerticals({ edition: input.edition, file: input.file, sched: input.sched })
    .filter((p) => p.corte !== VERTICAL2_CORTE_SLUG)
    .map((p) => ({
      edicao: input.edition,
      peca: pecaDoCorte(p.corte),
      destinos: [...input.destinos],
      alvo: brtAlvoIso(p.date, p.hhmm),
      dono: donoDoCorteExtra(p.slug),
      estado: "pendente" as const,
      nota: `corte extra ${p.slug} da montagem (#12934); título: ${p.title ?? "(sequência sem screenTitle)"}`,
    }));
}

export type RegistroExtraStatus = "criado" | "ja-registrado" | "mantido";

export interface RegistroExtraResultado {
  id: string;
  status: RegistroExtraStatus;
  item: AgendamentoItem;
  /** Só em `mantido`: por que o item existente não foi tocado. */
  motivo?: string;
}

/**
 * Puro: aplica os itens no banco. Reexecução (retomada da montagem) é no-op;
 * item que já existe com outros dados (alvo mudou porque a grade mudou, o
 * editor agendou para outro dia, o item já saiu de `pendente`) é MANTIDO como
 * está e volta em `mantido`: o registro dos extras nunca reescreve um item
 * existente, quem muda alvo/estado é o `marcar`/`remover` à mão.
 */
export function registrarExtras(
  banco: AgendamentosBanco,
  novos: readonly NovoAgendamento[],
  now: Date,
): { banco: AgendamentosBanco; resultados: RegistroExtraResultado[] } {
  let cur = banco;
  const resultados: RegistroExtraResultado[] = [];
  for (const novo of novos) {
    const id = `${novo.edicao}-${novo.peca}`;
    const existing = cur.itens.find((it) => it.id === id);
    if (existing) {
      const r = addAgendamentoSafe(cur, novo, now);
      if (r && !r.created) {
        resultados.push({ id, status: "ja-registrado", item: existing });
      } else {
        resultados.push({
          id,
          status: "mantido",
          item: existing,
          motivo: `já existe com outros dados (alvo ${existing.alvo}, estado ${existing.estado}); mantido como está`,
        });
      }
      continue;
    }
    const r = addAgendamento(cur, novo, now);
    cur = r.banco;
    resultados.push({ id, status: "criado", item: r.item });
  }
  return { banco: cur, resultados };
}

function addAgendamentoSafe(banco: AgendamentosBanco, novo: NovoAgendamento, now: Date) {
  try {
    return addAgendamento(banco, novo, now);
  } catch {
    return null;
  }
}

// ─── Estoque ─────────────────────────────────────────────────────────────────

/** Uma edição com `blocks.json` lido e válido. */
export interface EstoqueBlocks {
  edition: string;
  file: Pick<BlocksFile, "sequences">;
}

/** Uma pasta de `data/cortes/{slug}/`. `spec`/`entries` nulos = não lidos (ver `erro`). */
export interface EstoqueCorteDir {
  slug: string;
  spec: Pick<CorteSpec, "date" | "hhmm" | "title" | "publish_confirmed_at"> | null;
  entries: readonly Pick<ShortPublishedEntry, "destination" | "status">[] | null;
  erro?: string;
}

export interface EstoqueItem {
  /** `{corte}-{AAMMDD}` (pasta de `data/cortes/`). */
  slug: string;
  corte: string;
  /** Edição de origem (gravação). */
  edicao: string;
  titulo: string | null;
  /** A sequência está no `blocks.json` da edição. */
  noBlocks: boolean;
  /** Existe `data/cortes/{slug}/`. */
  temCorteDir: boolean;
  bancoId: string | null;
  bancoEstado: AgendamentoEstado | null;
  /** Alvo do item do banco, ou dia/horário do `corte.json`, ISO; null se nenhum dos dois. */
  alvo: string | null;
  /** Destinos com envio no registro do corte (qualquer status). */
  envios: number;
  usado: boolean;
  /** Por que está (ou não) em uso, em uma linha. */
  motivo: string;
  avisos: string[];
}

const SLUG_EDICAO_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)-(\d{6})$/;

/** Puro: `nvidia-261110` → `{ corte: "nvidia", edicao: "261110" }`; null se o nome não segue a convenção. */
export function parseCorteSlug(slug: string): { corte: string; edicao: string } | null {
  const m = SLUG_EDICAO_RE.exec(slug);
  return m ? { corte: m[1], edicao: m[2] } : null;
}

/**
 * Puro: o estoque de cortes. Une as três fontes pelo slug do corte
 * (`extraVerticalSlug`): as sequências com `corte` de cada `blocks.json`, as
 * pastas de `data/cortes/` e os itens do banco cuja peça tem corte
 * (`corteDaPeca`: `vertical-2` = `guia`, `corte-{corte}`). Ordem: edição,
 * depois slug. Pasta de `data/cortes/` com nome fora da convenção
 * `{corte}-{AAMMDD}` entra com edição vazia e um aviso.
 */
export function montarEstoque(input: {
  blocks: readonly EstoqueBlocks[];
  cortes: readonly EstoqueCorteDir[];
  banco: AgendamentosBanco;
}): EstoqueItem[] {
  interface Acc {
    slug: string;
    corte: string;
    edicao: string;
    titulo: string | null;
    noBlocks: boolean;
    dir: EstoqueCorteDir | null;
    banco: AgendamentoItem | null;
    avisos: string[];
  }
  const bySlug = new Map<string, Acc>();
  const get = (slug: string, corte: string, edicao: string): Acc => {
    let a = bySlug.get(slug);
    if (!a) {
      a = { slug, corte, edicao, titulo: null, noBlocks: false, dir: null, banco: null, avisos: [] };
      bySlug.set(slug, a);
    }
    return a;
  };

  for (const b of input.blocks) {
    for (const s of b.file.sequences ?? []) {
      if (typeof s.corte !== "string") continue;
      const a = get(extraVerticalSlug(s.corte, b.edition), s.corte, b.edition);
      a.noBlocks = true;
      const t = typeof s.screenTitle === "string" ? s.screenTitle.replace(/\s+/g, " ").trim() : "";
      if (t && !a.titulo) a.titulo = t;
    }
  }
  for (const d of input.cortes) {
    const parsed = parseCorteSlug(d.slug);
    const a = get(d.slug, parsed?.corte ?? d.slug, parsed?.edicao ?? "");
    a.dir = d;
    if (!parsed) a.avisos.push(`pasta data/cortes/${d.slug} fora da convenção {corte}-{AAMMDD}: edição de origem desconhecida`);
    if (d.spec?.title) a.titulo = d.spec.title;
    if (d.erro) a.avisos.push(`data/cortes/${d.slug}: ${d.erro}`);
  }
  for (const it of input.banco.itens) {
    const corte = corteDaPeca(it.peca);
    if (!corte) continue;
    const a = get(extraVerticalSlug(corte, it.edicao), corte, it.edicao);
    a.banco = it;
  }

  const out: EstoqueItem[] = [];
  for (const a of bySlug.values()) {
    const entries = a.dir?.entries ?? [];
    const envios = new Set(entries.map((e) => e.destination)).size;
    const autorizado = Boolean(a.dir?.spec?.publish_confirmed_at);
    const bancoEstado = a.banco?.estado ?? null;
    const avisos = [...a.avisos];
    let usado = false;
    let motivo: string;
    if (envios > 0) {
      usado = true;
      motivo = `envio registrado em ${envios} destino(s)`;
    } else if (autorizado) {
      usado = true;
      motivo = `"pode publicar" dado em ${a.dir!.spec!.publish_confirmed_at} (o timer do 300 publica)`;
    } else if (bancoEstado === "agendado" || bancoEstado === "publicado") {
      usado = true;
      motivo = `banco: ${bancoEstado}`;
    } else if (a.dir && a.dir.entries === null) {
      motivo = "registro do corte não lido (ver aviso): conferir à mão";
    } else if (a.dir) {
      motivo = "corte preparado (data/cortes/), nada enviado nem autorizado";
    } else if (a.banco) {
      motivo = `só no banco (${bancoEstado}), sem data/cortes/: o export ainda não passou pelo modo corte`;
    } else {
      motivo = "só no blocks.json: nem no banco nem em data/cortes/ (estoque invisível antes do #12934)";
    }
    if (usado && (bancoEstado === "pendente" || bancoEstado === "pronto")) {
      avisos.push(`banco desatualizado: ${a.banco!.id} segue ${bancoEstado}, mas o corte já está em uso (marcar --id ${a.banco!.id} --estado agendado)`);
    }
    if (a.banco && a.edicao && a.banco.edicao !== a.edicao) {
      avisos.push(`item ${a.banco.id} do banco aponta para outra edição (${a.banco.edicao})`);
    }
    const alvo = a.banco?.alvo ?? (a.dir?.spec ? safeAlvo(a.dir.spec.date, a.dir.spec.hhmm) : null);
    out.push({
      slug: a.slug,
      corte: a.corte,
      edicao: a.edicao,
      titulo: a.titulo,
      noBlocks: a.noBlocks,
      temCorteDir: a.dir !== null,
      bancoId: a.banco?.id ?? null,
      bancoEstado,
      alvo,
      envios,
      usado,
      motivo,
      avisos,
    });
  }
  return out.sort((x, y) => x.edicao.localeCompare(y.edicao) || x.slug.localeCompare(y.slug));
}

function safeAlvo(date: string, hhmm: string): string | null {
  try {
    return brtAlvoIso(date, hhmm);
  } catch {
    return null;
  }
}
