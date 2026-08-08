#!/usr/bin/env node
/**
 * clarice-build-segment.ts (#2885) — grupos de envio NOMEADOS derivados do
 * store, fim do CSV hand-made como unidade de gestão.
 *
 * O store único (#2647) é a fonte única da verdade; um grupo de envio é um
 * PREDICADO sobre ele, re-derivado FRESCO a cada invocação — nunca um
 * snapshot congelado. Cobre grupos por OBJETIVO: retenção (`engajados`),
 * re-ativação (`reativacao`), e a RAMPA de 1º envio (`ramp-warm` — fila
 * engajado→1º envio→decaído, corte por `--budget`, pra crescer alcance).
 * Até o #4657 (05/08) a rampa vivia num script à parte, `clarice-build-waves-store.ts`
 * — aposentado no #4759 por não ter o guard cycle-wide `sent-or-queued.json`
 * (#3227, abaixo), que causou ~18k envios duplicados num ciclo antes de
 * existir. `ramp-warm` aqui **substitui** aquele script, não só complementa.
 *
 * Grupos nomeados (predicados versionados/testados em
 * `scripts/lib/clarice-segment.ts`, ao lado de `segmentFromStore` — ver
 * `NAMED_GROUPS`):
 *   - `engajados`   (retenção)  = send_eligible=1 AND sends_count>0 AND
 *                     priority_points>0, ordem priority_points DESC.
 *                     Exclui internos (#2809).
 *   - `reativacao`              = send_eligible=1 AND sends_count>0 AND
 *                     opens_count=0 AND hasMeasuredOpens (brevo_modified_at
 *                     != null — #4688, opens_count=0 sozinho não basta: sem
 *                     essa condição um contato NUNCA sincronizado também
 *                     aparenta opens_count=0), ordem last_sent_at DESC
 *                     (não-abridores mais recentes primeiro). Ver JSDoc de
 *                     `isReativacao` em clarice-segment.ts. Exclui internos
 *                     (#2809).
 *   - `ramp-warm`   (1º envio seguro) = send_eligible=1 AND sends_count=0 AND
 *                     (mv_bucket='verified' OR cohort MV-isento — #3826,
 *                     `isMvExemptCohort`), ordem cohortSendRank (morno→frio,
 *                     assinantes-ativos rank 0). NÃO exclui internos (não
 *                     pedido pela #2885 — este grupo é sobre segurança de 1º
 *                     contato, não retenção/reativação).
 *
 * GUARD DE DEFASAGEM (#4205): `--group engajados` filtra por priority_points
 * — se o store foi tocado pelo sync do Brevo (opens_count/etc atualizado)
 * DEPOIS do último `recomputeDerived`, esse grupo sairia menor sem avisar
 * (quem abriu recentemente fica invisível até o próximo rebuild). Antes de
 * montar 'engajados', `main()` chama `isDerivedStale` (clarice-db.ts) e
 * ABORTA com instrução se detectar a defasagem — defesa em profundidade sobre
 * o fix primário (`clarice-sync-brevo.ts` sempre chamar `recomputeDerived` ao
 * final, mesmo no `--incremental`). Não se aplica a 'reativacao'/'ramp-warm'
 * (nenhum dos dois filtra por priority_points).
 *
 * SEGURANÇA: só ESCREVE CSV+manifest LOCAIS — não envia nada. O envio segue
 * gated no import (`clarice-import-waves.ts --group {group}`, #2916 —
 * dry-run por padrão) + schedule (manual). `--dry-run` aqui só imprime o
 * plano sem escrever.
 *
 * #4347: `BREVO_CLARICE_API_KEY` é OPCIONAL em `--dry-run` (a checagem de
 * campanhas comprometidas — queued/sent — é pulada com aviso se ausente ou se
 * a consulta falhar) mas OBRIGATÓRIA pra escrita real (aborta sem ela).
 *
 * Uso:
 *   npx tsx scripts/clarice-build-segment.ts --group engajados --cycle 2606-07 [--budget N] [--min-score N] [--dry-run]
 *   --group X    OBRIGATÓRIO — um dos grupos nomeados (ver NAMED_GROUPS em clarice-segment.ts).
 *   --cycle X    OBRIGATÓRIO — {conteúdo}-{envio} (destino dos artefatos, ver clarice-paths.ts).
 *   --budget N   OPCIONAL (>0) — teto do grupo; pega o TOPO da ordem (pós-sort).
 *                Sem a flag, o grupo inteiro é escrito.
 *   --min-score N / --score N   OPCIONAL (#2973 — "score" é o termo do editor
 *                pro dia a dia, alias puro de `priority_points`; NÃO reintroduz
 *                o `score`/`OPEN_PROBABILITY` legado removido em #2647, que
 *                segue morto). Exclui contatos com `priority_points < N` ANTES
 *                do sort/budget do grupo. `--score` é apenas um atalho pro
 *                mesmo valor de `--min-score` (o editor pode usar qualquer um
 *                dos dois nomes); se ambos forem passados, `--min-score` vence.
 *                Sem a flag, nenhum corte por score é aplicado (comportamento
 *                inalterado).
 *   --dry-run    só conta/imprime o plano, nada escrito.
 *   --hold X[,Y] (#4542) RESERVA: exclui da seleção os contatos do segmento X
 *                (hoje só `juridico`), que o editor está segurando pra uma
 *                campanha própria. Opt-in por invocação — o envio especial
 *                desse mesmo segmento é montado SEM a flag. Nome inválido
 *                aborta (nunca ignora em silêncio) — e desde o review da PR
 *                #4564 a flag SEM VALOR (`--hold`, `--hold=`, `--hold` seguida
 *                de outra flag) ou REPETIDA também aborta, via `getStringArg`:
 *                antes viravam "nenhuma reserva pedida" e o script gravava o
 *                segmento inteiro com exit 0. O resumo reporta `hold` (quais
 *                segmentos foram passados — presente mesmo com 0 retidos, pro
 *                operador ver que a reserva estava ativa), `held_by_segment`
 *                (quebra por segmento) e
 *                `held_from_selection` (quantos a reserva tirou DESTA seleção —
 *                o número que responde "o que deixei de mandar hoje") ao lado
 *                de `held_in_universe` (quantos do segmento existem no
 *                universo, quase sempre muito maior e sem significado
 *                operacional sozinho), pra seleção menor nunca ser confundida
 *                com predicado errado.
 *   --since YYYY-MM-DD   OBRIGATÓRIO só pro grupo `novos` (#4347) — janela de
 *                "cadastrou desde". Ignorado pelos outros 3 grupos.
 *   --force      OPCIONAL — só pro grupo `novos` (#4347, D13): destrava a
 *                escrita quando o grupo selecionou mais que
 *                `NOVOS_ROUND_SIZE_CAP` (500) contatos. Sem a flag, a rodada
 *                aborta ANTES de escrever (substitui o gate humano que a
 *                skill `/diaria-clarice-novos` não tem — D6).
 *   --data-root DIR   OPCIONAL, uso interno de teste (#4207, generaliza o
 *                `--segments-dir` pontual do #4176) — substitui `CLARICE_BASE`
 *                (raiz fixa `data/clarice-subscribers`) na resolução de
 *                `clariceSegmentsDir(cycle, baseDir)`, então o sent-or-queued.json/CSV
 *                são lidos/escritos sob `{data-root}/{cycle}/segments` em vez do
 *                disco real de produção. Sem a flag, comportamento de produção
 *                inalterado (baseDir default = `CLARICE_BASE`).
 *   --cohort X   OPCIONAL (#4622) — restringe o universo a uma safra mensal
 *                específica ANTES do predicado/ordem do grupo (mesma mecânica
 *                de `--cohort` em `clarice-build-waves-store.ts` desde #2817:
 *                resolvido via `resolveCohortArg` — rótulo pt-BR como
 *                "junho", forma canônica "YYYY-MM", ou slug direto da
 *                taxonomia como "leads-2024h2"). Reusável pelos 4
 *                `NAMED_GROUPS` (não só `reativacao`) — resolve o caso "N
 *                contatos frios de uma safra específica, ordenados no TOM do
 *                grupo escolhido" sem precisar de SQL ad-hoc fora do pipeline
 *                versionado. Sem a flag, roda sobre a base inteira
 *                (comportamento pré-#4622, sem mudança).
 *   --not-sent-within Nd / --not-sent-since YYYY-MM-DD   OPCIONAIS e
 *                mutuamente exclusivos (#4719) — excluem do universo quem tem
 *                `last_sent_at` dentro da janela pedida, ANTES do corte por
 *                `--budget` (senão o volume final sai menor que o pedido).
 *                Diferente do dedup por ciclo (`sent-or-queued.json` abaixo,
 *                que só enxerga quem foi SELECIONADO por um `--group` neste
 *                ciclo): este filtro responde "recebeu e-mail nosso de fato,
 *                não importa por qual via?" — cobre seeds do editor, listas
 *                montadas à mão, campanhas ad-hoc, tudo que o dedup por ciclo
 *                não vê mas que ainda assim atualiza `last_sent_at` via o
 *                sync da Brevo. Ver `scripts/lib/clarice-recency.ts` pro
 *                racional completo e o caso real (onda `d7-sex07`, 06/08,
 *                15 de 817 contatos vazaram e foram filtrados à mão).
 *                `EDITOR_SEED_EMAILS` continuam ISENTOS — a linha do editor só
 *                é injetada no CSV no momento do IMPORT
 *                (`ensureEditorCopyRow`, `clarice-import-waves.ts`), depois
 *                desta seleção, então nunca faz parte do universo que este
 *                filtro enxerga.
 *
 *                #4765: este filtro agora corre SEMPRE, nunca desligado por
 *                omissão da flag — mesmo padrão dos outros guards automáticos
 *                deste arquivo (sent-or-queued.json abaixo, committed/queued).
 *                Sem `--not-sent-within`/`--not-sent-since`, o default é o
 *                início do mês de ENVIO do ciclo (`cycleSendMonthStartIso`,
 *                clarice-paths.ts) — cobre exatamente a MESMA janela que
 *                `sent-or-queued.json` tenta cobrir, mas contra o dado real
 *                do store (`last_sent_at`), então pega quem escapou do dedup
 *                por ciclo por qualquer motivo (achado #4765: 52 de 1.963
 *                contatos escaparam numa onda porque a invocação anterior que
 *                os selecionou não deixou rastro em `sent-or-queued.json`).
 *                Passar a flag explicitamente continua SOBRESCREVENDO esse
 *                default (mais estreito ou mais largo, à escolha do
 *                operador) — nunca soma/intersecta com ele.
 *
 * Outputs (em data/clarice-subscribers/{conteúdo}-{envio}/segments/):
 *   {group}.csv                     (colunas: email,NOME — compatível com clarice-import-waves)
 *   {group}-priority-snapshot.csv   (#4763 — colunas: email,priority_points,cohort,priority_optin;
 *                             snapshot do MOMENTO em que a onda foi montada — `priority_points`
 *                             só existe TRANSIENTE na query SQL (recomputado do zero a cada sync,
 *                             sem histórico), então sem este arquivo nenhuma análise retroativa
 *                             tipo "esta coorte abriu diferente daquela?" é possível. Arquivo
 *                             SEPARADO do CSV de transporte — a Brevo lê só `{group}.csv` no
 *                             import e não deve ganhar coluna que ela não espera. Não escrito
 *                             em --dry-run (mesma disciplina do resto do script).)
 *   {group}-manifest.json    ([{ key, file, desc, count }], mesmo shape de waves-manifest.json)
 *   sent-or-queued.json      (#3227 — ÚNICO por ciclo, não por grupo; ver guard abaixo. Não
 *                             escrito em --dry-run.)
 *
 * #2916: `clarice-import-waves.ts` (que só lia `waves/waves-manifest.json` da
 * rampa) foi generalizado com a flag `--group {group}` — quando informada, lê
 * `segments/{group}-manifest.json` (este script) em vez de `waves/`. Sem essa
 * flag no import, o output deste script fica órfão (ninguém consome) — SEMPRE
 * passar `--group` no import de um grupo nomeado:
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2606-07 --group engajados --label "Retenção Jun/2026"            # dry-run
 *   npx tsx scripts/clarice-import-waves.ts --cycle 2606-07 --group engajados --label "Retenção Jun/2026" --execute  # cria + importa
 *
 * Guard anti-duplo-envio POR CICLO (#2883, generalizado em #3227): o
 * mecanismo original (`collectPriorCycleEmails`/`excludeAlreadySentEmails` em
 * `clarice-build-edition-sends.ts`) é acoplado à convenção de arquivo da
 * RAMPA (`d{NN}-{date}.csv` dentro de `{ciclo}/sends/`) e ao cursor posicional
 * do plano de blocos — não se aplica limpo aqui (diretório diferente,
 * convenção de nome diferente, sem plano de blocos). Este script tem o seu
 * PRÓPRIO guard, equivalente em espírito mas de mecanismo mais simples:
 * `sent-or-queued.json`, um arquivo ÚNICO por ciclo (não por grupo — ver
 * `sentOrQueuedFilePath`) em `{ciclo}/segments/`, que acumula os emails
 * SELECIONADOS por CADA invocação `--group` bem-sucedida (independente de já
 * ter sido importado no Brevo). Toda invocação, automaticamente (sem flag —
 * #3227, decisão do editor: "sem flag manual, mais seguro contra
 * esquecimento"):
 *   1. LÊ o arquivo (se existir) e exclui do universo quem já está lá, ANTES
 *      de `buildSegmentArtifact` (`loadSentOrQueuedEmails` + `excludeSentOrQueued`).
 *   2. Após escrita bem-sucedida (não-dry-run), ACRESCENTA os emails
 *      recém-selecionados (`appendSentOrQueuedEmails`).
 * CICLO-WIDE por design (não por-grupo): rodar `engajados` e depois
 * `ramp-warm` no mesmo ciclo também deduplica entre os dois — um contato
 * pode aparecer em ambos os predicados (ex: sai de `ramp-warm` após o 1º
 * envio) e a mesma pessoa não deveria ser re-selecionada só porque o GRUPO
 * mudou. `--dry-run` só LÊ (pra refletir no preview), nunca ESCREVE (mesma
 * convenção do resto do script: dry-run não muta estado).
 *
 * #4765 — POR QUE `sent-or-queued.json` sozinho não bastava (achado, não
 * fechado ao vivo): o guard acima é robusto CONTRA re-seleção dentro do
 * PRÓPRIO fluxo `--group`, mas `appendSentOrQueuedEmails` faz um
 * read-modify-write (lê o JSON inteiro, funde em memória, `writeFileSync` de
 * volta) SEM lock nem escrita atômica (diferente de
 * `appendGroupListsRegistry` em `clarice-import-waves.ts`, que já usa
 * `writeFileAtomic`, `scripts/lib/atomic-write.ts`). Duas invocações deste
 * script sobre o MESMO ciclo próximas no tempo (`data/` é uma junction
 * compartilhada por todas as sessões/worktrees na mesma máquina, ver
 * CLAUDE.md) sofrem um lost-update clássico: se a invocação B lê o arquivo
 * ANTES da invocação A escrever, o write de A (que já leu uma versão mais
 * antiga) sobrescreve o de B sem os emails que B tinha acabado de acrescentar
 * — e nenhuma das duas erra ou avisa, o arquivo só fica menor do que devia.
 * Hipótese plausível pro caso real (52 de 1.963 sem rastro), não confirmada
 * ao vivo — nada nos logs disponíveis prova concorrência no momento exato.
 * Corrigir isso (lock de arquivo, não só escrita atômica — atomicidade
 * sozinha evita arquivo CORROMPIDO, não a perda de update concorrente) é
 * escopo maior que este fix e não bloqueia o guard de recência automático
 * abaixo, que é a mitigação primária pedida pela issue: ele não depende de
 * `sent-or-queued.json` estar correto — lê `last_sent_at` direto do store,
 * que o sync da Brevo grava independente de qual mecanismo local rastreou a
 * seleção.
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import Papa from "papaparse";
import { loadProjectEnv } from "./lib/env-loader.ts";
import { openClariceDb, DEFAULT_DB_PATH, isDerivedStale } from "./lib/clarice-db.ts";
import {
  NAMED_GROUPS,
  isNamedGroupKey,
  excludeCommittedToQueuedCampaigns,
  resolveCohortArg,
  type NamedGroupKey,
  type NamedGroupContext,
  type StoreRow,
} from "./lib/clarice-segment.ts";
import { clariceSegmentsDir, cycleSendMonthStartIso, ensureDir, requireCycleArg } from "./lib/clarice-paths.ts";
import { getArg, getStringArg, hasFlag, isMainModule } from "./lib/cli-args.ts";
import { fetchCommittedCampaignListIds, fetchQueuedCampaignListIds } from "./lib/brevo-client.ts";
import { parseHoldArg, applyHolds, type HoldSegmentName } from "./lib/clarice-hold.ts";
import {
  resolveNotSentCutoff,
  resolveRecencyCutoffWithDefault,
  excludeSentSince,
  type RecencyCutoffSource,
} from "./lib/clarice-recency.ts";

loadProjectEnv();

export interface SegmentRow extends StoreRow {
  name: string | null;
}

export interface SegmentManifestEntry {
  key: string;
  file: string;
  desc: string;
  count: number;
}

/** 1º nome p/ personalização (ex: "Azevedo, Ana" → "Azevedo"). Mesma convenção
 *  de `clarice-build-waves-store.ts`/`clarice-build-edition-sends.ts`. */
function firstName(name: string | null): string {
  return (name ?? "").trim().split(/[\s,]+/)[0] || "";
}

/**
 * Monta o CSV + manifest do grupo (puro: retorna os artefatos, não escreve).
 * `budget > 0` corta o TOPO da fila já filtrada+ordenada por `NAMED_GROUPS[group].segment`
 * (não uma fatia arbitrária — o corte acontece DEPOIS do sort).
 */
export function buildSegmentArtifact(
  rows: SegmentRow[],
  group: NamedGroupKey,
  budget: number,
  minScore = 0,
  ctx?: NamedGroupContext,
): { csv: string; manifestEntry: SegmentManifestEntry; selected: SegmentRow[] } {
  const def = NAMED_GROUPS[group];
  const nameByEmail = new Map(rows.map((r) => [r.email, firstName(r.name)]));
  // #2973: "score" = alias do editor pra `priority_points` (NÃO o score/
  // OPEN_PROBABILITY legado morto em #2647). Corte ANTES do sort/budget do
  // predicado do grupo — quem não bate o piso nunca entra na ordenação.
  const scoped = minScore > 0 ? rows.filter((r) => (r.priority_points ?? 0) >= minScore) : rows;
  // `def.segment` filtra+ordena preservando a IDENTIDADE dos objetos de `rows`
  // (não clona) — o cast de volta pra SegmentRow[] é seguro porque cada
  // elemento retornado É um dos objetos de `rows` (que já são SegmentRow).
  // `ctx` (#4347): só o grupo `novos` precisa (sinceIso) — os outros 3 ignoram.
  const ordered = def.segment(scoped, ctx) as SegmentRow[];
  const selected = budget > 0 ? ordered.slice(0, budget) : ordered;

  const csvRows = selected.map((r) => ({ email: r.email, NOME: nameByEmail.get(r.email) ?? "" }));
  const file = `${group}.csv`;
  const csv = Papa.unparse({ fields: ["email", "NOME"], data: csvRows });
  const manifestEntry: SegmentManifestEntry = { key: group, file, desc: def.label, count: selected.length };

  return { csv, manifestEntry, selected };
}

/**
 * Snapshot de `priority_points` do MOMENTO em que a onda foi montada (#4763).
 * `priority_points` só existe TRANSIENTE na query SQL de `main()` — todo sync
 * diário recomputa a coluna do zero (last-write-wins, `recomputeDerived`,
 * clarice-db.ts), sem histórico. O valor de HOJE para um contato já inclui o
 * engajamento de HOJE, então usá-lo pra reconstruir "em que faixa essa pessoa
 * estava quando a onda saiu" é circular — sem este snapshot, "esta coorte
 * abriu diferente daquela?" é uma pergunta estruturalmente impossível de
 * responder depois (não só pra esta onda — pra TODA onda futura).
 *
 * Pura — recebe exatamente os `selected` que `main()` vai escrever no CSV de
 * transporte, então os dois arquivos sempre descrevem o MESMO conjunto de
 * contatos. Arquivo SEPARADO de `{group}.csv`: a Brevo lê só esse no import
 * (`clarice-import-waves.ts`) e não deve ganhar coluna que ela não espera.
 */
export function buildPrioritySnapshotCsv(selected: SegmentRow[]): string {
  const rows = selected.map((r) => ({
    email: r.email,
    priority_points: r.priority_points ?? 0,
    cohort: r.cohort ?? "",
    priority_optin: r.priority_optin ? 1 : 0,
  }));
  return Papa.unparse({
    fields: ["email", "priority_points", "cohort", "priority_optin"],
    data: rows,
  });
}

// ---------------------------------------------------------------------------
// Teto de tamanho da rodada (#4347, D13) — grupo `novos` apenas
// ---------------------------------------------------------------------------
//
// A skill `/diaria-clarice-novos` roda ~4×/semana SEM gate humano (D6) — o
// teto abaixo é o substituto direto do gate: trava contra `--since` errado,
// rebuild que zerou `sends_count`, ou backlog inesperado que faria a rodada
// disparar pra um volume muito maior que o esperado (~100/rodada). Só o
// grupo `novos` é sujeito a este teto — os outros 3 grupos nomeados
// (engajados/reativação/ramp-warm) são operados manualmente pelo editor, que
// já é o gate.

export const NOVOS_ROUND_SIZE_CAP = 500;

/**
 * Pura/testável: `selectedCount > cap` sem `--force` → aborta (`ok:false`).
 * `--force` destrava (D13) — o editor já olhou e decidiu prosseguir mesmo
 * assim. O caller decide QUANDO chamar (só pro grupo `novos` — ver `if
 * (group === "novos")` em `main()`); esta função não sabe qual grupo está
 * ativo, só recebe o `selectedCount` já resolvido.
 */
export function checkRoundSizeCap(
  selectedCount: number,
  cap: number,
  force: boolean,
): { ok: true } | { ok: false; message: string } {
  if (force || selectedCount <= cap) return { ok: true };
  return {
    ok: false,
    message:
      `❌ grupo 'novos' selecionou ${selectedCount} contato(s) — acima do teto de ${cap} (D13, #4347). ` +
      `Isso substitui o gate humano que a skill não tem (D6): provável --since errado, rebuild que zerou ` +
      `sends_count, ou backlog inesperado. Confira antes de prosseguir. Use --force pra destravar depois de olhar.`,
  };
}

// ---------------------------------------------------------------------------
// Guard anti-duplo-envio POR CICLO (#3227) — sent-or-queued.json
// ---------------------------------------------------------------------------
//
// Arquivo ÚNICO por ciclo (irmão dos `{group}.csv`/`{group}-manifest.json`,
// mesmo diretório `clariceSegmentsDir(cycle)`), CICLO-WIDE: qualquer grupo
// nomeado que já selecionou um email neste ciclo aparece aqui, não importa
// QUAL grupo — ver docstring do topo do arquivo pro raciocínio completo.

export interface SentOrQueuedHistoryEntry {
  group: NamedGroupKey;
  /** Quantidade de emails NOVOS adicionados por esta entrada (não cumulativo). */
  count: number;
  /** ISO timestamp da invocação que gravou esta entrada. */
  at: string;
}

export interface SentOrQueuedFile {
  cycle: string;
  /** Emails normalizados (trim + lowercase), únicos, ordem alfabética (determinístico). */
  emails: string[];
  /** Uma entrada por invocação bem-sucedida (não-dry-run) que gravou artefato. */
  history: SentOrQueuedHistoryEntry[];
}

/** Caminho do arquivo de tracking cycle-wide (`{ciclo}/segments/sent-or-queued.json`). */
export function sentOrQueuedFilePath(segmentsDir: string): string {
  return resolve(segmentsDir, "sent-or-queued.json");
}

/**
 * Lê `sent-or-queued.json` de `segmentsDir` e devolve o Set de emails já
 * rastreados (normalizados trim+lowercase, mesmo padrão de
 * `collectPriorCycleEmails`/`excludeAlreadySentEmails` em
 * `clarice-build-edition-sends.ts`). Tolerante: arquivo ausente, JSON
 * corrompido, ou shape inesperado (`emails` não é array) → Set vazio (nunca
 * lança) — dado ruim aqui vira "nada rastreado ainda", não derruba o build.
 * Só LEITURA — seguro chamar mesmo em `--dry-run` (não cria o diretório nem
 * o arquivo).
 */
export function loadSentOrQueuedEmails(segmentsDir: string): Set<string> {
  const file = sentOrQueuedFilePath(segmentsDir);
  if (!existsSync(file)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SentOrQueuedFile>;
    if (!Array.isArray(parsed.emails)) return new Set();
    return new Set(parsed.emails.map((e) => String(e).trim().toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * Filtra `rows` removendo quem já está em `sentOrQueued` (comparação
 * normalizada trim+lowercase). Preserva a ordem relativa dos remanescentes.
 * Pura — mesmo padrão de `excludeAlreadySentEmails`.
 */
export function excludeSentOrQueued<T extends { email: string }>(
  rows: T[],
  sentOrQueued: ReadonlySet<string>,
): T[] {
  if (sentOrQueued.size === 0) return rows;
  return rows.filter((r) => !sentOrQueued.has(r.email.trim().toLowerCase()));
}

/**
 * Acrescenta `newEmails` ao `sent-or-queued.json` de `segmentsDir` (união com
 * o que já existe — nunca remove), registra uma entrada de `history`, e
 * escreve de volta. Cria `segmentsDir` se faltar (mesmo padrão de
 * `ensureDir` usado pelo resto do script). Chamar SOMENTE após escrita
 * bem-sucedida (não-dry-run) — `main()` é responsável por não chamar esta
 * função em `--dry-run`.
 */
export function appendSentOrQueuedEmails(
  segmentsDir: string,
  cycle: string,
  group: NamedGroupKey,
  newEmails: string[],
): void {
  ensureDir(segmentsDir);
  const file = sentOrQueuedFilePath(segmentsDir);
  let existingEmails: string[] = [];
  let history: SentOrQueuedHistoryEntry[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<SentOrQueuedFile>;
      if (Array.isArray(parsed.emails)) existingEmails = parsed.emails.map((e) => String(e));
      if (Array.isArray(parsed.history)) history = parsed.history;
    } catch {
      // JSON corrompido — recomeça do zero em vez de travar o build (mesma
      // postura tolerante de loadSentOrQueuedEmails).
    }
  }
  const emailSet = new Set(existingEmails.map((e) => e.trim().toLowerCase()));
  const normalizedNew = newEmails.map((e) => e.trim().toLowerCase());
  for (const e of normalizedNew) emailSet.add(e);

  const merged: SentOrQueuedFile = {
    cycle,
    emails: [...emailSet].sort(),
    history: [...history, { group, count: normalizedNew.length, at: new Date().toISOString() }],
  };
  writeFileSync(file, JSON.stringify(merged, null, 2), "utf8");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const cycle = requireCycleArg(argv);
  const dbPath = getArg(argv, "db") || DEFAULT_DB_PATH;

  const groupArg = getArg(argv, "group");
  if (!groupArg || !isNamedGroupKey(groupArg)) {
    console.error(
      `❌ --group é obrigatório — um dos grupos nomeados: ${Object.keys(NAMED_GROUPS).join(", ")}. ` +
        `Ex: --group engajados.`,
    );
    process.exit(1);
  }
  const group: NamedGroupKey = groupArg;

  // #4347: `novos` exige --since YYYY-MM-DD (janela do laço Stripe→MV→envio).
  // Validação de FORMA aqui (semântica de data delegada ao Date.parse dentro
  // de isNovos/segmentNovos, via ctx.sinceIso) — os outros 3 grupos ignoram.
  let ctx: NamedGroupContext | undefined;
  const forceCap = hasFlag(argv, "force");
  if (group === "novos") {
    const sinceArg = getArg(argv, "since");
    if (!sinceArg || !/^\d{4}-\d{2}-\d{2}$/.test(sinceArg) || Number.isNaN(Date.parse(sinceArg))) {
      console.error(`❌ --group novos requer --since YYYY-MM-DD (ex: --since 2026-07-01). Recebido: "${sinceArg}".`);
      process.exit(1);
    }
    ctx = { sinceIso: sinceArg };
  }

  // --budget é OPCIONAL (diferente de clarice-build-waves-store.ts, onde é
  // obrigatório): sem a flag, o grupo inteiro (já filtrado pelo predicado) é
  // escrito — o predicado JÁ é o corte de blast-radius (ex: `reativacao` só
  // pega quem nunca abriu, não a base inteira).
  const budgetArg = getArg(argv, "budget");
  let budget = 0;
  if (budgetArg) {
    const n = Number(budgetArg);
    if (!Number.isFinite(n) || n <= 0) {
      console.error("❌ --budget precisa ser um número > 0 (omita a flag pra não ter teto).");
      process.exit(1);
    }
    budget = n;
  }

  // #2973: --min-score / --score são ALIASES do mesmo corte (score := priority_points,
  // vocabulário do editor no dia a dia — não o score/OPEN_PROBABILITY legado morto em #2647).
  // --min-score vence se ambos forem passados.
  const minScoreArg = getArg(argv, "min-score") || getArg(argv, "score");
  let minScore = 0;
  if (minScoreArg) {
    const n = Number(minScoreArg);
    if (!Number.isFinite(n)) {
      console.error("❌ --min-score/--score precisa ser um número (omita a flag pra não ter piso).");
      process.exit(1);
    }
    minScore = n;
  }

  const dryRun = hasFlag(argv, "dry-run");

  // #4622: --cohort restringe o universo a uma safra mensal específica.
  // Resolvido ANTES do SELECT (falha cedo se o rótulo/forma não for
  // reconhecido — ver resolveCohortArg) e aplicado como WHERE, mesma mecânica
  // de --cohort em clarice-build-waves-store.ts (#2817).
  let cohort: string | null = null;
  try {
    const cohortArg = getStringArg(argv, "cohort", { example: "junho" });
    cohort = cohortArg ? resolveCohortArg(cohortArg) : null;
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }

  // #4719/#4765: --not-sent-within/--not-sent-since — cutoff de recência
  // resolvido cedo (mesmo padrão do --cohort acima), aplicado depois do
  // SELECT (precisa de last_sent_at, que só existe pós-carga). Desde #4765
  // este filtro NUNCA fica desligado: sem flag explícita, cai no default
  // automático (início do mês de ENVIO do ciclo) — ver docstring do topo do
  // arquivo e `resolveRecencyCutoffWithDefault` (clarice-recency.ts).
  let notSentCutoff = "";
  let recencyCutoffSource: RecencyCutoffSource = "auto";
  try {
    const explicitCutoff = resolveNotSentCutoff(
      getStringArg(argv, "not-sent-within", { example: "30d" }),
      getStringArg(argv, "not-sent-since", { example: "2026-08-01" }),
      new Date(),
    );
    const resolved = resolveRecencyCutoffWithDefault(explicitCutoff, cycleSendMonthStartIso(cycle));
    notSentCutoff = resolved.cutoffIso;
    recencyCutoffSource = resolved.source;
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }

  const db = openClariceDb(dbPath);

  // #4205: 'engajados' é o único grupo nomeado que filtra por priority_points
  // (`isEngajados`, clarice-segment.ts) — o único, portanto, exposto ao
  // incidente do #4205 (sync que atualiza opens_count sem recomputeDerived
  // alcançar o fim, deixando priority_points pra trás). 'reativacao'/
  // 'ramp-warm' não dependem de priority_points, então não precisam do guard.
  // Defesa em profundidade: mesmo com o (1) implementado (clarice-sync-brevo.ts
  // sempre chama recomputeDerived ao final), um run interrompido por
  // rate-limit/Ctrl+C ANTES do recompute final — ou um caminho futuro que
  // bypasse recomputeDerived — recria o problema silenciosamente. Abortar aqui
  // troca "onda menor sem aviso" por uma instrução clara de como destravar.
  if (group === "engajados" && isDerivedStale(db)) {
    db.close();
    console.error(
      "❌ store defasado (#4205): existem contatos com engajamento Brevo mais " +
        "recente que o último recompute de priority_points — o grupo 'engajados' " +
        "sairia menor do que deveria, silenciosamente. Rode " +
        "`npx tsx scripts/clarice-build-db.ts` (ou `clarice-sync-brevo.ts` até o " +
        "fim, sem interrupção) antes de montar esta onda.",
    );
    process.exit(1);
  }

  const rows = db
    .prepare(
      `SELECT email, name, tier, cohort, priority_points, priority_optin, send_eligible, ineligible_reason,
              sends_count, opens_count, last_sent_at, mv_bucket, brevo_list_ids, created, brevo_modified_at
         FROM clarice_users${cohort ? " WHERE cohort = ?" : ""}`,
    )
    .all(...(cohort ? [cohort] : [])) as unknown as SegmentRow[];
  db.close();

  if (cohort) {
    console.error(`🎯 filtro --cohort aplicado: cohort='${cohort}' (${rows.length} linha(s) no universo)`);
  }

  if (rows.length === 0) {
    console.error(
      cohort
        ? `❌ 0 contatos com cohort='${cohort}' — verifique se o store já foi rebuildado após o import da safra.`
        : "❌ store vazio — rode clarice-build-db.ts + clarice-sync-brevo.ts antes.",
    );
    process.exit(1);
  }

  // #3227: guard anti-duplo-envio POR CICLO — exclui do universo quem já foi
  // SELECIONADO por qualquer grupo nomeado (não só este `group`) neste mesmo
  // ciclo, ANTES do predicado/sort/budget de buildSegmentArtifact. Automático
  // (sem flag), inclusive em --dry-run (só LEITURA aqui — nunca escreve).
  // `--data-root` (#4207, generaliza `--segments-dir` do #4176): override de
  // teste do root usado por `clariceSegmentsDir` — sem a flag, resolve a raiz
  // fixa de produção via `CLARICE_BASE` (comportamento inalterado).
  const dataRootArg = getArg(argv, "data-root");
  const segDir = clariceSegmentsDir(cycle, dataRootArg || undefined);
  const sentOrQueued = loadSentOrQueuedEmails(segDir);
  const afterSentOrQueued = excludeSentOrQueued(rows, sentOrQueued);
  const alreadyTracked = rows.length - afterSentOrQueued.length;
  if (alreadyTracked > 0) {
    console.error(
      `🔒 dedup por ciclo (#3227): ${alreadyTracked} contato(s) já selecionado(s) por outra invocação de grupo nomeado neste ciclo — excluído(s) do universo.`,
    );
  }

  // #4719/#4765: filtro de recência — "recebeu de fato?" é uma pergunta
  // diferente de "foi selecionado neste ciclo?" (o guard acima). Roda SEMPRE
  // desde #4765 (nunca fica ausente). Ver scripts/lib/clarice-recency.ts pro
  // racional completo. ANTES do corte por --budget (senão o volume final sai
  // menor que o pedido).
  const afterRecency = excludeSentSince(afterSentOrQueued, notSentCutoff);
  const excludedByRecency = afterSentOrQueued.length - afterRecency.length;
  console.error(
    recencyCutoffSource === "explicit"
      ? `🔒 filtro de recência (#4719): ${excludedByRecency} contato(s) com last_sent_at >= ${notSentCutoff} excluído(s) do universo.`
      : `🔒 filtro de recência automático (#4765 — início do mês de envio do ciclo): ${excludedByRecency} contato(s) com last_sent_at >= ${notSentCutoff} excluído(s) do universo.`,
  );

  // #4347: guard de campanha comprometida (excludeCommittedToQueuedCampaigns, a
  // mesma checagem já usada por weekly-send-plan-audience.ts/
  // clarice-schedule-ramp.ts/cohort-order-dryrun.ts) — vale pros 4 grupos
  // nomeados, não só 'novos' (#4347 Etapa 2c). O ESCOPO, porém, depende do
  // grupo desde 260731 (`guardScope` em NAMED_GROUPS): 1º envio exclui
  // queued ∪ sent; RE-envio (engajados/reativacao) exclui só `queued`. Motivo
  // em `CommittedGuardScope` (clarice-segment.ts): incluir `sent` zerava esses
  // dois grupos por CONSTRUÇÃO — todo contato com `sends_count > 0` está em
  // alguma lista com campanha `sent`, então predicado e guard se anulavam.
  //
  // O que `sent` resolve nos grupos de 1º envio: o sync do Brevo é 1×/dia, então
  // `sends_count` fica até 24h defasado — `fetchSentCampaignListIds` é a fonte
  // AO VIVO que fecha esse furo. Em RE-envio esse furo não existe (já recebeu é
  // pré-requisito, não impedimento).
  //
  // Fail-safe (ambos os escopos): --dry-run PROSSEGUE com aviso se a consulta
  // falhar (ou sem a key); escrita real ABORTA — nunca escreve um grupo sem
  // essa checagem passar, senão duas rodadas próximas (a cadência de ~4×/semana
  // que a #4347 introduz) podem re-selecionar quem já está comprometido com uma
  // campanha AGENDADA, que na Brevo é imutável.
  const apiKey = process.env.BREVO_CLARICE_API_KEY;
  const guardScope = NAMED_GROUPS[group].guardScope;
  // Nome neutro de propósito: o conteúdo é `queued` OU `queued ∪ sent` conforme
  // `guardScope` — chamá-lo de "committed" induziria a ler `sent` onde não há.
  let guardListIds: Set<string> = new Set();
  if (apiKey) {
    try {
      // `switch` + exhaustividade (em vez de ternário): um escopo novo
      // adicionado a `CommittedGuardScope` quebra o TYPECHECK aqui, em vez de
      // cair silenciosamente no ramo `committed` — que é a forma exata do bug
      // que esta função corrige.
      switch (guardScope) {
        case "queued":
          guardListIds = await fetchQueuedCampaignListIds(apiKey);
          break;
        case "committed":
          guardListIds = await fetchCommittedCampaignListIds(apiKey);
          break;
        default: {
          const jamais: never = guardScope;
          throw new Error(`guardScope não tratado: ${String(jamais)}`);
        }
      }
      if (guardListIds.size > 0) {
        console.error(
          guardScope === "queued"
            ? `🔒 guard queued (grupo de re-envio): ${guardListIds.size} lista(s) Brevo com campanha AGENDADA serão excluídas.`
            : `🔒 guard queued/sent: ${guardListIds.size} lista(s) Brevo comprometida(s) (campanha agendada ou já disparada) serão excluídas.`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`⚠️  Não foi possível consultar campanhas agendadas/disparadas na Brevo: ${msg}`);
      if (!dryRun) {
        console.error("❌ escrita real requer a checagem de campanhas agendadas/disparadas bem-sucedida — evita envio duplicado. Abortando (use --dry-run pra inspecionar sem essa checagem).");
        process.exit(1);
      }
    }
  } else if (!dryRun) {
    console.error(
      "❌ BREVO_CLARICE_API_KEY não definida — necessária pra checar campanhas agendadas/disparadas antes de escrever (--dry-run funciona sem ela).",
    );
    process.exit(1);
  }
  const universe = excludeCommittedToQueuedCampaigns(afterRecency, guardListIds);
  const committedExcluded = afterRecency.length - universe.length;
  if (committedExcluded > 0) {
    // A causa nomeada acompanha o escopo: em RE-envio nunca é "disparada".
    console.error(
      guardScope === "queued"
        ? `🔒 ${committedExcluded} contato(s) excluído(s) por já estarem comprometidos com campanha AGENDADA.`
        : `🔒 ${committedExcluded} contato(s) excluído(s) por já estarem comprometidos com campanha agendada/disparada.`,
    );
  }

  // #4542: reserva de segmento — retira do universo quem o editor está
  // segurando pra uma campanha própria (hoje `--hold juridico`). ANTES do
  // buildSegmentArtifact de propósito: segurar depois do corte de budget
  // encolheria a onda em vez de puxar os próximos da fila.
  let holds: HoldSegmentName[];
  try {
    holds = parseHoldArg(getStringArg(argv, "hold", { example: "juridico" }));
  } catch (e) {
    console.error(`❌ ${(e as Error).message}`);
    process.exit(1);
  }
  const holdResult = applyHolds(universe, holds);

  const { csv, manifestEntry, selected } = buildSegmentArtifact(holdResult.kept, group, budget, minScore, ctx);

  // O número que importa pro operador não é quantos contatos do segmento
  // existem no universo (a maioria nem seria selecionada), e sim quantos a
  // reserva TIROU DESTA seleção. Só o segundo responde "o que eu deixei de
  // mandar hoje". Calculado rodando a mesma seleção sem a reserva —
  // buildSegmentArtifact é puro (não escreve; a escrita é do main), então o
  // custo é uma passada em memória, e só quando há reserva ativa.
  let heldFromSelection = 0;
  if (holdResult.heldTotal > 0) {
    const semReserva = buildSegmentArtifact(universe, group, budget, minScore, ctx);
    heldFromSelection = semReserva.manifestEntry.count - manifestEntry.count;
    console.error(
      `🔒 reserva (--hold ${holds.join(",")}): ${heldFromSelection} contato(s) a menos NESTA seleção ` +
        `(${manifestEntry.count} em vez de ${semReserva.manifestEntry.count}). ` +
        `${holdResult.heldTotal} do segmento retidos do universo.`,
    );
  }

  // #4347 D13: teto de tamanho da rodada — só o grupo 'novos' (substituto do
  // gate humano que a skill /diaria-clarice-novos não tem, D6). Checado ANTES
  // de qualquer escrita (CSV/manifest) e ABORTA identicamente com ou sem
  // --dry-run — dry-run já reflete o plano real, então não faz sentido deixar
  // passar aqui e travar só na execução de verdade.
  if (group === "novos") {
    const cap = checkRoundSizeCap(manifestEntry.count, NOVOS_ROUND_SIZE_CAP, forceCap);
    if (!cap.ok) {
      console.error(cap.message);
      process.exit(1);
    }
  }

  const summary = {
    cycle,
    group,
    label: NAMED_GROUPS[group].label,
    source: "store-driven, grupo nomeado (#2885)",
    budget: budget || undefined,
    min_score: minScore || undefined,
    since: ctx?.sinceIso || undefined,
    // #4622: auditoria — undefined vira ausente no JSON (não escreve `null` ruidoso).
    cohort: cohort ?? undefined,
    universe_total: rows.length,
    already_sent_or_queued: alreadyTracked || undefined,
    // #4719/#4765: cutoff SEMPRE presente (nunca ausente desde #4765 — o
    // filtro nunca fica desligado) + a FONTE (explícito vs default automático)
    // + quantos ele excluiu — número que não aparece no resumo é número que
    // ninguém confere.
    not_sent_cutoff: notSentCutoff,
    recency_cutoff_source: recencyCutoffSource,
    excluded_by_recency: excludedByRecency || undefined,
    // Sempre presente (não `|| undefined`): saber QUAL escopo de guard rodou é
    // o que permite auditar, meses depois, por que um contato entrou ou não
    // numa rodada — e este guard já falhou em silêncio uma vez, zerando um
    // grupo inteiro (ver `CommittedGuardScope`, clarice-segment.ts).
    guard_scope: guardScope,
    already_committed_brevo: committedExcluded || undefined,
    // #4542: presente quando --hold foi PASSADA (independente de ter retido
    // alguem) — o operador precisa ver que a flag estava ativa mesmo com 0
    // retidos. Os campos held_* abaixo so aparecem quando algo casou.
    hold: holds.length > 0 ? holds.join(",") : undefined,
    /** Quantos a reserva tirou DESTA seleção — o "o que deixei de mandar hoje". */
    // NUNCA `|| undefined`: um 0 legitimo (budget recompos a onda com os
    // proximos da fila) sumiria do JSON e leria como campo quebrado, bem no
    // caso em que o operador mais precisa saber que a reserva nao mudou nada.
    held_from_selection: holdResult.heldTotal > 0 ? heldFromSelection : undefined,
    /** Quantos do segmento existem no universo (contexto, quase sempre maior). */
    held_in_universe: holdResult.heldTotal || undefined,
    held_by_segment: holdResult.heldTotal > 0 ? holdResult.heldBySegment : undefined,
    selected: manifestEntry.count,
  };

  if (manifestEntry.count === 0) {
    // #4347: 'novos' roda desassistido ~4×/semana — 0 cadastros novos desde
    // o --since é um resultado ROTINEIRO (dia calmo de signups), não um sinal
    // de bug como seria pros outros 3 grupos (engajados/reativacao/ramp-warm,
    // onde 0 quase sempre indica predicado errado ou store vazio). SKILL.md
    // documenta explicitamente "0 contatos → sai limpo, exit 0, não é erro" —
    // sem esse branch, a skill sem gate humano trataria um dia comum como halt.
    if (group === "novos") {
      console.error(`ℹ️  0 contato(s) no grupo 'novos' — rodada vazia (não é erro). Nada escrito.`);
      console.log(JSON.stringify(summary, null, 2));
      return;
    }
    console.error(
      `❌ 0 contato(s) no grupo '${group}' — verifique o predicado (send_eligible/histórico/mv_bucket) contra o store, ` +
        `se todo o universo elegível já foi selecionado por outra invocação deste ciclo ` +
        `(${alreadyTracked} excluído(s) via sent-or-queued.json)` +
        (cohort ? `, se a safra '${cohort}' (--cohort) tem contatos elegíveis pro predicado` : "") +
        `, ou se o filtro de recência (${recencyCutoffSource === "explicit" ? "--not-sent-within/--not-sent-since" : "automático — início do mês de envio, #4765"}: ${excludedByRecency} excluído(s)) zerou o universo` +
        `. Nada escrito.`,
    );
    process.exit(1);
  }

  if (!dryRun) {
    const dir = segDir;
    ensureDir(dir);
    writeFileSync(resolve(dir, manifestEntry.file), csv, "utf8");
    // #4763: snapshot de priority_points no MOMENTO da montagem — arquivo
    // SEPARADO do CSV de transporte (ver buildPrioritySnapshotCsv), mesmos
    // `selected` que foram pro CSV acima.
    writeFileSync(
      resolve(dir, `${group}-priority-snapshot.csv`),
      buildPrioritySnapshotCsv(selected),
      "utf8",
    );
    writeFileSync(
      resolve(dir, `${group}-manifest.json`),
      JSON.stringify([manifestEntry], null, 2),
      "utf8",
    );
    appendSentOrQueuedEmails(dir, cycle, group, selected.map((r) => r.email));
    console.error(`✅ ${manifestEntry.count} contato(s) do grupo '${group}' em ${resolve(dir, manifestEntry.file)}`);
  } else {
    console.error(`ℹ️  dry-run — nada escrito. ${manifestEntry.count} contato(s) no grupo '${group}'.`);
  }
  console.log(JSON.stringify(summary, null, 2));
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(String((e as Error)?.stack || e));
    process.exit(1);
  });
}
