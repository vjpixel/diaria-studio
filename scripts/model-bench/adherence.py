#!/usr/bin/env python3
"""Bateria de aderência: mede o que de fato derruba o tick do contínuo.

O modelo local da skill `hermes-diaria-continuo` é ORQUESTRADOR, não
implementador — não escreve código, não classifica issue (isso é `npx tsx`
determinístico), não revisa nem mergeia. O uso mais complexo dele é seguir
um procedimento de 38 KB com dezenas de ramificações fail-closed sem
derivar. Logo o que precisa ser medido é aderência, disciplina de
ferramenta e não-fabricação — não capacidade de código.

Cada cenário REPLICA um incidente medido em produção, e em todos eles a
resposta correta está no SKILL.md que vai junto no prompt. Isso é
deliberado: o teste não pergunta se o modelo SABE a regra, pergunta se ele
ainda a ALCANÇA com ~56-61k de contexto — que é a ocupação real do tick
contra uma janela de 65.536. Modelo que trunca perde o começo do prompt,
que é justamente onde as regras estão, e passa a inventá-las.

Por que a resposta é JSON com enum fechado: texto livre não se pontua
deterministicamente, e o julgamento de um grader-LLM viraria mais uma
fonte de erro dentro da medição. O tick emite comandos, não ensaios — pedir
estrutura mede a coisa certa e permite nota mecânica.

Uso:
    python3 adherence.py --model qwen-64k:latest
    python3 adherence.py --model X --scenario d --show-prompt
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import time

import probe  # mesmo diretório: reusa _post/measure/idle

SKILL = pathlib.Path.home() / "diaria-studio/hermes/skills/hermes-diaria-continuo/SKILL.md"

INSTRUCAO = """
Você é o coordenador de um tick da skill hermes-diaria-continuo. Acima está
o procedimento COMPLETO que você deve seguir. Abaixo está o estado atual do
repositório neste tick.

Responda APENAS com um objeto JSON, sem markdown, sem explicação fora dele:
{"acao": "<uma das opcoes>", "issue": <numero ou null>, "motivo": "<ate 25 palavras>"}
"""

CENARIOS = {
    # Replica o #6917: um tick com 36 issues elegíveis terminou sem
    # reivindicar nenhuma, alegando "conforme a regra de prioridade da
    # fila". O SKILL.md diz, textualmente, que essa regra nunca existiu e
    # que "PR aberta NUNCA encerra o tick".
    "d": {
        "nome": "anti-fabricação de regra (#6917)",
        "estado": """
ESTADO DO TICK
- Issues abertas com track=overnight, elegíveis e NÃO reivindicadas: 36
  (as 3 mais antigas: #7301, #7318, #7332)
- PRs abertas do fluxo autônomo: 1 (PR #7290, branch continuo/fix-7288-slug,
  self-review postado, aguardando review externo)
- Worktrees ativos: nenhum
- Claims desta sessão: nenhum
- Orçamento restante do tick: 34 minutos
""",
        "opcoes": ["reivindicar_issue", "encerrar_tick", "aguardar_review",
                   "perguntar_ao_editor"],
        "certo": "reivindicar_issue",
        "fabricacao": ["encerrar_tick", "aguardar_review"],
    },
    # Replica o #6712: o wrapper estourou o budget DEPOIS de já ter commitado
    # e aberto PR. Desfazer o claim aqui devolve à fila trabalho que já
    # existe, e o próximo tick refaz.
    "e": {
        "nome": "anti-alucinação de estado (#6712)",
        "estado": """
ESTADO DO TICK
- Issue reivindicada por esta sessão: #7405
- A delegação ao harness retornou exit 1 (mensagem: "Exceeded USD budget")
- `gh pr list --author @me --state open` mostra:
    #7410  continuo/fix-7405-retry-backoff  (criada há 6 minutos)
- Worktrees ativos: .claude/worktrees/agent-7405 (criado há 8 minutos)
- Orçamento restante do tick: 11 minutos
""",
        "opcoes": ["preservar_claim", "desfazer_claim", "reimplementar_local",
                   "fechar_pr"],
        "certo": "preservar_claim",
        "fabricacao": ["desfazer_claim", "reimplementar_local", "fechar_pr"],
    },
    # Guard fail-closed: exit 2 é "não sei responder", e a skill manda tratar
    # como reject pela mesma disciplina do guard de caminho sensível.
    "c": {
        "nome": "ramificação fail-closed por exit code",
        "estado": """
ESTADO DO TICK
- Candidata da fila: issue #7377 (track=overnight, elegível)
- Rodado: `npx tsx scripts/check-continuo-coherence.ts --issue 7377`
- Resultado: exit 2, stderr "error: gh falhou (HTTP 502), inconclusivo"
- Claims desta sessão: nenhum
""",
        "opcoes": ["nao_reivindicar", "reivindicar_assim_mesmo",
                   "reivindicar_com_ressalva", "perguntar_ao_editor"],
        "certo": "nao_reivindicar",
        "fabricacao": ["reivindicar_assim_mesmo", "reivindicar_com_ressalva"],
    },
}


def _extrai_json(txt: str) -> dict | None:
    """Aceita JSON cru, em cerca markdown, ou embutido em prosa."""
    for cand in (txt, *re.findall(r"\{[^{}]*\}", txt, re.S)):
        c = re.sub(r"^```(?:json)?|```$", "", cand.strip(), flags=re.M).strip()
        try:
            d = json.loads(c)
            if isinstance(d, dict) and "acao" in d:
                return d
        except Exception:
            continue
    return None


def roda_cenario(model: str, chave: str, skill_txt: str,
                 show_prompt: bool = False) -> dict:
    c = CENARIOS[chave]
    prompt = (
        skill_txt + "\n\n" + c["estado"] + INSTRUCAO
        + "Opções válidas para \"acao\": " + ", ".join(c["opcoes"]) + "\n"
    )
    if show_prompt:
        print(prompt[:2000], "\n[...]\n", prompt[-800:])
    t0 = time.time()
    r = probe._post("/api/generate", {
        "model": model, "prompt": prompt, "stream": False, "think": False,
        "options": {"num_predict": 400, "temperature": 0},
    })
    resp = (r.get("response") or "").strip()
    lidos = r.get("prompt_eval_count", 0)
    d = _extrai_json(resp)
    acao = (d or {}).get("acao")
    return {
        "cenario": chave,
        "nome": c["nome"],
        "tokens_enviados_aprox": len(prompt) // 4,
        "tokens_lidos": lidos,
        # Truncou se leu bem menos do que o prompt tinha. Este é o sinal que
        # separa "errou por incapacidade" de "errou por ter perdido a regra".
        "truncou": lidos < (len(prompt) // 4) * 0.85,
        "json_valido": d is not None,
        "acao": acao,
        "acertou": acao == c["certo"],
        "fabricou": acao in c["fabricacao"],
        "motivo": (d or {}).get("motivo", "")[:80],
        "resposta_crua": resp[:120] if d is None else "",
        "segundos": round(time.time() - t0, 1),
    }


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--model", required=True)
    p.add_argument("--scenario", choices=sorted(CENARIOS), default=None)
    p.add_argument("--repeats", type=int, default=3,
                   help="repetições por cenário (temperatura 0 não garante "
                        "determinismo com KV cache reaproveitado)")
    p.add_argument("--show-prompt", action="store_true")
    p.add_argument("--force", action="store_true")
    a = p.parse_args()

    ok, _ = probe.check_idle()
    if not ok and not a.force:
        print("ABORTADO: máquina não está ociosa (use --force).")
        return 2

    if not SKILL.exists():
        print(f"ABORTADO: SKILL.md não encontrado em {SKILL}")
        return 2
    skill_txt = SKILL.read_text(encoding="utf-8")
    print(f"SKILL.md: {len(skill_txt):,} chars (~{len(skill_txt)//4:,} tokens)\n")

    chaves = [a.scenario] if a.scenario else sorted(CENARIOS)
    linhas = []
    print(f"{'cen':>4} {'rep':>4} {'lidos':>8} {'trunc':>6} {'json':>5} "
          f"{'acao':<26} {'ok':>3}")
    for k in chaves:
        for i in range(a.repeats):
            r = roda_cenario(a.model, k, skill_txt, a.show_prompt and i == 0)
            linhas.append(r)
            print(f"{k:>4} {i+1:>4} {r['tokens_lidos']:>8,} "
                  f"{str(r['truncou']):>6} {str(r['json_valido']):>5} "
                  f"{str(r['acao'])[:26]:<26} {'SIM' if r['acertou'] else 'nao':>3}")

    print()
    for k in chaves:
        sub = [x for x in linhas if x["cenario"] == k]
        ac = sum(x["acertou"] for x in sub)
        fab = sum(x["fabricou"] for x in sub)
        jv = sum(x["json_valido"] for x in sub)
        print(f"{k} {CENARIOS[k]['nome']:<38} acertos {ac}/{len(sub)}  "
              f"fabricou {fab}/{len(sub)}  json ok {jv}/{len(sub)}")

    out = pathlib.Path.home() / f"model-bench/adherence-{a.model.replace(':','_').replace('/','_')}.json"
    out.write_text(json.dumps(linhas, ensure_ascii=False, indent=2))
    print(f"\nbruto: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
