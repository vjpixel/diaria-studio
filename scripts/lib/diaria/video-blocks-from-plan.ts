/**
 * `blocks --from-plan` (#13463): o `blocks.json` montado do molde da decupagem
 * (`blocks.template.json`, as falas "usar" com o intervalo no bruto e o texto
 * gravado) e da proposta do roteiro de gravação (`video-roteiro-blocos.ts`,
 * `propostaBlocosDoRoteiro`: bloco, `falaId` e `targets` de cada fala, as
 * sequências e o título da vertical), sem o script ad-hoc em `node -e` que a
 * skill escrevia a cada edição (261117, 261118).
 *
 * O vínculo entre as duas pontas é o `falaId` que a skill grava na linha
 * "usar" do `decupagem-plan.json` e que a decupagem leva para o molde. Regras:
 *
 * - A ordem dos itens dentro do bloco é a da proposta (a do roteiro). Cada
 *   fala da proposta recebe os itens do molde com o mesmo `falaId`, de
 *   preferência no mesmo bloco (o `resumo_curto` que repete o `resumo` cai no
 *   item do `resumo` quando a decupagem não o duplicou), com os `targets` da
 *   proposta e o texto e o intervalo do molde (o texto gravado, não o
 *   planejado: é o que vai para a legenda).
 * - Trecho de uma fala com corte aplicado numa vertical (#13129, os
 *   `segmentos`) sai só com o texto: o molde tem a tomada da fala inteira, e
 *   partir o intervalo pede o tempo das palavras. O `roteiro` resolve a tomada
 *   pelo texto (a última completa) e a skill confere.
 * - Fala da proposta sem item no molde sai só com o texto do roteiro, com aviso.
 * - Item do molde sem `falaId`, com um id que a proposta não tem, ou que a
 *   proposta não consumiu, fica no bloco dele, logo depois do item do molde
 *   que o precedia, sem `targets` (entra em todas as versões que têm o
 *   bloco), com aviso: fala improvisada não ganha id adivinhado.
 * - Sequências e título da vertical vêm da proposta (sem `sequences` na
 *   proposta, ficam as do molde); bloco sem item que chegue à sequência sai da
 *   ordem dela, com aviso (o `fecho`/`cta_yt` vazios que a skill tirava à mão).
 *
 * Função pura: não lê nem grava arquivo. O CLI valida o resultado com
 * `parseBlocksFile` antes de gravar.
 */

import { BLOCK_KEYS, itemInTarget, type BlockItem, type BlockKey, type BlocksFile, type SequenceKey } from "./video-montage.ts";
import type { PropostaBlocos } from "./roteiro-videos.ts";

export interface BlocksFromPlanResult {
  file: BlocksFile;
  avisos: string[];
}

type PlanProposta = Pick<PropostaBlocos, "blocks" | "sequences" | "screenTitle" | "sequencias">;

interface TplRef {
  key: BlockKey;
  idx: number;
  item: BlockItem;
}

/** O item do molde sem o escopo (`targets`/`skip`): o escopo vem da proposta. */
function semEscopo(item: BlockItem): BlockItem {
  const { targets: _t, skip: _s, ...rest } = item;
  return rest as BlockItem;
}

const resumoTexto = (s: string) => (s.length > 60 ? `${s.slice(0, 60).trimEnd()}…` : s);

export function blocksFromPlan(template: BlocksFile, proposta: PlanProposta): BlocksFromPlanResult {
  const avisos: string[] = [];
  const tpl: TplRef[] = [];
  for (const key of BLOCK_KEYS) (template.blocks[key] ?? []).forEach((item, idx) => tpl.push({ key, idx, item }));
  const porFala = new Map<string, TplRef[]>();
  for (const r of tpl) {
    const id = r.item.falaId?.trim();
    if (!id) continue;
    const lista = porFala.get(id) ?? [];
    lista.push(r);
    porFala.set(id, lista);
  }
  // Trechos de fala cortada numa vertical (#13129): texto que não é a fala inteira.
  const trechos = new Map<string, Set<string>>();
  for (const s of proposta.sequencias ?? []) {
    for (const fa of s.falas) {
      if (!fa.segmentos?.length) continue;
      const set = trechos.get(fa.id) ?? new Set<string>();
      for (const t of fa.segmentos) set.add(t);
      trechos.set(fa.id, set);
    }
  }
  const idsDaProposta = new Set<string>();
  for (const key of BLOCK_KEYS) for (const p of proposta.blocks[key] ?? []) idsDaProposta.add(p.falaId);

  const usados = new Set<TplRef>();
  const out = new Map<BlockKey, Array<{ item: BlockItem; ref?: TplRef }>>();
  for (const key of BLOCK_KEYS) {
    const lista: Array<{ item: BlockItem; ref?: TplRef }> = [];
    // A mesma fala duas vezes no bloco é a ordem própria de uma vertical (#13128): mesmo texto, mesma tomada.
    const jaNoBloco = new Map<string, string>();
    for (const p of proposta.blocks[key] ?? []) {
      const escopo: { targets?: SequenceKey[] } = p.targets?.length ? { targets: [...p.targets] as SequenceKey[] } : {};
      const soTexto = (motivo: string) => {
        lista.push({ item: { falaId: p.falaId, text: p.text, ...escopo } });
        avisos.push(`${key}: fala ${p.falaId} ("${resumoTexto(p.text)}") ${motivo}`);
      };
      if (trechos.get(p.falaId)?.has(p.text)) {
        soTexto("é trecho de corte numa vertical (#13129): item só com o texto, a tomada sai pelo roteiro (a última completa); conferir no roteiro.md");
        continue;
      }
      const cands = porFala.get(p.falaId) ?? [];
      const mesmo = cands.filter((r) => r.key === key);
      const escolhidos = mesmo.length ? mesmo : cands;
      if (!escolhidos.length) {
        soTexto(`sem linha "usar" com falaId ${p.falaId} no decupagem-plan.json: item só com o texto do roteiro, a tomada sai pela última completa; conferir no roteiro.md ou pôr o falaId na linha da decupagem`);
        continue;
      }
      const antes = jaNoBloco.get(p.falaId);
      if (antes !== undefined && antes !== p.text) {
        avisos.push(`${key}: fala ${p.falaId} aparece de novo no bloco com outro texto ("${resumoTexto(p.text)}"): mesma tomada do molde repetida; conferir no roteiro.md`);
      }
      jaNoBloco.set(p.falaId, p.text);
      for (const r of escolhidos) {
        lista.push({ item: { ...semEscopo(r.item), falaId: p.falaId, ...escopo } as BlockItem, ref: r });
        usados.add(r);
      }
    }
    out.set(key, lista);
  }

  // O que a proposta não consumiu fica no bloco do molde, depois do item que o precedia.
  for (const r of tpl) {
    if (usados.has(r)) continue;
    const id = r.item.falaId?.trim();
    const lista = out.get(r.key)!;
    let pos = 0;
    lista.forEach((e, i) => {
      if (e.ref && e.ref.key === r.key && e.ref.idx < r.idx) pos = i + 1;
    });
    lista.splice(pos, 0, { item: semEscopo(r.item), ref: r });
    const onde = `${r.key}: item do molde "${resumoTexto(r.item.text ?? "")}"`;
    if (!id) avisos.push(`${onde} sem falaId: mantido no bloco, sem targets (entra em todas as versões que têm o bloco); fala improvisada fica sem id, pôr targets se for de uma versão só`);
    else if (!idsDaProposta.has(id)) avisos.push(`${onde} com falaId ${id}, que a proposta do roteiro não tem: mantido no bloco, sem targets; conferir o id`);
    else avisos.push(`${onde} com falaId ${id}: a proposta põe essa fala em outro bloco; mantido aqui, sem targets; conferir se sobra`);
  }

  const blocks: BlocksFile["blocks"] = {};
  for (const key of BLOCK_KEYS) {
    const lista = out.get(key)!;
    if (lista.length) blocks[key] = lista.map((e) => e.item);
  }
  const { blocks: _b, sequences: tplSeq, screenTitle: tplTitle, ...resto } = template;
  // Bloco sem item que chegue à sequência sai da ordem dela (o build recusa bloco
  // obrigatório vazio; na 261117 e na 261118 a skill tirava à mão cta_yt/fecho).
  const sequences = (proposta.sequences ?? tplSeq)?.map((spec) => {
    const order = spec.order.filter((k) => (blocks[k] ?? []).some((it) => itemInTarget(it, spec)));
    const fora = spec.order.filter((k) => !order.includes(k));
    if (fora.length) avisos.push(`sequência ${spec.name}: ${fora.join(", ")} sem item que chegue a ela, fora da ordem`);
    return fora.length ? { ...spec, order } : spec;
  });
  const screenTitle = proposta.screenTitle ?? tplTitle;
  const file: BlocksFile = {
    ...resto,
    ...(screenTitle !== undefined ? { screenTitle } : {}),
    blocks,
    ...(sequences !== undefined ? { sequences } : {}),
  };
  return { file, avisos };
}
