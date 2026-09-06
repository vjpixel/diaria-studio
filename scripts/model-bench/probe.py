#!/usr/bin/env python3
"""Harness de avaliação de modelo local para a skill `hermes-diaria-continuo`.

Mede o que importa para o workload REAL do contínuo — que é orquestração,
não código (ver `docs/goal-modelo-local-continuo.md`): janela útil real,
velocidade, e ocupação de memória. Reexecutável para qualquer modelo novo.

Subcomandos:
  idle    — verifica se a máquina está ociosa o bastante para medir
  window  — busca binária pela janela ÚTIL real (onde o modelo trunca)
  speed   — prefill e geração num tamanho de contexto dado
  show    — o que o Ollama declara vs. o que o Modelfile serve

Por que `window` não confia no `num_ctx` declarado: medido em 06/09/2026, o
`qwen-64k:latest` aceitou 102.213 tokens, devolveu HTTP 200 SEM ERRO e leu
só 32.770 — truncando do começo, que é onde ficam as regras. Truncagem não
é erro em lugar nenhum da pilha (Ollama devolve 200; o Hermes v0.20.5 não
checa `prompt_eval_count` no caminho da chamada), então a única forma de
saber a janela real é sondar e comparar enviado contra lido.

Uso típico:
    python3 probe.py idle
    python3 probe.py window --model qwen-64k:latest
    python3 probe.py speed  --model qwen-64k:latest --ctx 32768
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request

OLLAMA = "http://127.0.0.1:11434"

# Ocupação aceitável para uma medição valer. O tick do contínuo é I/O-bound
# (chamadas de API, `gh`, `git`), então roda com load1 baixo e GPU livre —
# um guard só de CPU/VRAM aprova a largada por engano enquanto um tick está
# em voo. Por isso `idle` também checa processo, não só carga.
MAX_LOAD1 = 1.5
MAX_GPU_UTIL = 10  # %


def _post(path: str, payload: dict, timeout: int = 900) -> dict:
    req = urllib.request.Request(
        OLLAMA + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _sh(cmd: str) -> str:
    return subprocess.run(
        cmd, shell=True, capture_output=True, text=True
    ).stdout.strip()


def gpu_state() -> tuple[int, int, int]:
    """(util%, usado MiB, livre MiB) — zeros se não houver nvidia-smi."""
    out = _sh(
        "nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.free "
        "--format=csv,noheader,nounits"
    )
    if not out:
        return (0, 0, 0)
    util, used, free = (int(x.strip()) for x in out.split(","))
    return (util, used, free)


def busy_processes() -> list[str]:
    """Processos que indicam tick do contínuo/revisor em voo.

    O padrão usa classe de caractere (`[h]ermes`) de propósito: um `pgrep -f`
    ou `grep` cujo padrão case a própria linha de comando encontra a si
    mesmo — e, quando esse resultado alimenta um `kill`, mata a própria
    sessão SSH (exit 255, aconteceu 3× ao levantar estes números).
    """
    out = _sh(
        "ps -eo etimes,args --sort=-etimes | "
        "grep -E '[h]ermes_cli.*(cron|run)|[c]laude -p|[c]ontinuo-pr-review' "
        "| grep -v gateway | grep -v dashboard"
    )
    return [l.strip() for l in out.splitlines() if l.strip()]


def check_idle(verbose: bool = True) -> tuple[bool, str]:
    load1 = float(open("/proc/loadavg").read().split()[0])
    util, used, free = gpu_state()
    procs = busy_processes()
    reasons = []
    if load1 > MAX_LOAD1:
        reasons.append(f"load1={load1:.2f} > {MAX_LOAD1}")
    if util > MAX_GPU_UTIL:
        reasons.append(f"gpu_util={util}% > {MAX_GPU_UTIL}%")
    if procs:
        reasons.append(f"{len(procs)} processo(s) de tick em voo")
    ok = not reasons
    msg = (
        f"load1={load1:.2f} gpu_util={util}% vram_usada={used}MiB "
        f"vram_livre={free}MiB procs={len(procs)}"
    )
    if verbose:
        print(("OCIOSA   " if ok else "OCUPADA  ") + msg)
        for p in procs:
            print("   em voo:", p[:110])
        for r in reasons:
            print("   motivo:", r)
    return ok, msg


def wait_idle(max_wait: int = 300, verbose: bool = True) -> bool:
    """Espera a máquina esfriar, em vez de abortar.

    Numa SEQUÊNCIA de medições o estorvo é a rodada anterior: o modelo fica
    residente e `gpu_util` segue alto por dezenas de segundos depois que a
    chamada retornou. Abortar aí descarta uma célula boa por causa de si
    mesmo — foi o que aconteceu na 1ª execução da bateria, que perdeu dois
    dos três níveis de contexto. Abortar continua certo para carga ALHEIA
    (tick em voo); para a própria cauda, esperar é o correto.
    """
    t0 = time.time()
    while time.time() - t0 < max_wait:
        ok, msg = check_idle(verbose=False)
        if ok:
            if verbose and time.time() - t0 > 2:
                print(f"esfriou em {time.time()-t0:.0f}s: {msg}")
            return True
        time.sleep(10)
    if verbose:
        print(f"AVISO: nao esfriou em {max_wait}s — {check_idle(verbose=False)[1]}")
    return False


def _filler(n_chars: int, codeword: str) -> str:
    """Prompt com a palavra-código na PRIMEIRA linha.

    A posição importa: o Ollama trunca do COMEÇO, então um código no fim
    sobreviveria à truncagem e o teste passaria sem medir nada.
    """
    head = f"CODIGO={codeword}\nGuarde o codigo acima.\n"
    body = ("Linha de preenchimento para ocupar contexto do modelo. "
            "Conteudo irrelevante, so volume.\n")
    reps = max(1, (n_chars - len(head)) // len(body))
    tail = "\nQual e o CODIGO da primeira linha? Responda so o codigo.\n"
    return head + body * reps + tail


def measure_prompt(model: str, n_chars: int, codeword: str = "ZORFAX-7731",
                   num_predict: int = 512) -> dict:
    """Mede uma chamada. `num_predict` alto e `think=False` de propósito.

    Modelo com capability `thinking` (o `qwen3.5` tem) gasta o orçamento de
    saída raciocinando e devolve `response` VAZIO se `num_predict` for
    apertado — o que faz um prompt que coube parecer falha de compreensão.
    Foi assim que a 1ª versão desta sonda reportou "janela útil 0 tokens".
    """
    prompt = _filler(n_chars, codeword)
    t0 = time.time()
    r = _post("/api/generate", {
        "model": model,
        "prompt": prompt,
        "stream": False,
        "think": False,
        "options": {"num_predict": num_predict, "temperature": 0},
    })
    read = r.get("prompt_eval_count", 0)
    resp = (r.get("response") or "").strip()
    return {
        "chars_enviados": len(prompt),
        "tokens_lidos": read,
        "achou_codigo": codeword in resp,
        "resposta": resp[:60],
        "segundos": round(time.time() - t0, 1),
        "prefill_tok_s": round(read / (r.get("prompt_eval_duration", 1) / 1e9), 1)
        if r.get("prompt_eval_duration") else None,
        "geracao_tok_s": round(
            r.get("eval_count", 0) / (r.get("eval_duration", 1) / 1e9), 1
        ) if r.get("eval_duration") else None,
    }


def cmd_window(args) -> int:
    """Busca binária pela janela ÚTIL real, em TOKENS.

    A busca é dirigida SÓ pelo sinal determinístico: `prompt_eval_count`
    devolvido pelo Ollama deixa de acompanhar o que foi enviado. A palavra-
    código é confirmação semântica REPORTADA À PARTE, nunca critério de
    corte — a 1ª versão usava as duas juntas, e como o modelo respondia
    vazio por `num_predict` apertado, toda célula virava "truncou" e a busca
    desceu até o piso reportando "janela 0". Sinal mecânico decide; sinal
    semântico só descreve.

    Calibra chars/token antes de buscar, porque a razão depende do texto
    (~4,19 para o filler repetitivo em pt-BR) e sem ela a busca em chars
    não diz nada sobre a janela em tokens.
    """
    # Espera esfriar em vez de abortar: numa sequência, o estorvo costuma ser
    # a própria rodada anterior (modelo residente, gpu_util alto por dezenas
    # de segundos). Abortar aí perde célula boa por causa de si mesma — foi o
    # que descartou janela e velocidade do phi4-mini na 1ª passada da Fase 2.
    if not wait_idle(args.wait_idle) and not args.force:
        print("ABORTADO: máquina não esfriou (use --force para ignorar).")
        return 2

    print(f"\ncalibrando chars/token de {args.model}...")
    cal = measure_prompt(args.model, 40_000)
    ratio = cal["chars_enviados"] / max(1, cal["tokens_lidos"])
    print(f"  {cal['chars_enviados']:,} chars -> {cal['tokens_lidos']:,} "
          f"tokens  (razão {ratio:.2f} chars/token)")

    lo, hi = args.min_tokens, args.max_tokens
    melhor = 0
    print(f"\nbusca binária da janela útil entre {lo:,} e {hi:,} tokens")
    print(f"{'alvo tok':>10} {'lidos':>10} {'perda':>8} {'código':>7}  veredito")

    while hi - lo > args.tolerance:
        alvo = (lo + hi) // 2
        m = measure_prompt(args.model, int(alvo * ratio))
        lidos = m["tokens_lidos"]
        # Truncou se leu bem menos do que o alvo pedia. A folga de 5% cobre
        # variação de tokenização; o colapso real é abrupto (~2x), não sutil.
        truncou = lidos < alvo * 0.95
        perda = f"-{100 * (1 - lidos / alvo):.0f}%" if truncou else "—"
        print(f"{alvo:>10,} {lidos:>10,} {perda:>8} "
              f"{str(m['achou_codigo']):>7}  {'TRUNCOU' if truncou else 'ok'}")
        if truncou:
            hi = alvo
        else:
            lo = alvo
            melhor = max(melhor, lidos)

    print(f"\nJANELA ÚTIL MEDIDA: ~{melhor:,} tokens "
          f"(passou em {lo:,}, truncou em {hi:,})")
    print(json.dumps({"modelo": args.model, "janela_util_tokens": melhor,
                      "ultimo_ok": lo, "primeiro_truncou": hi,
                      "chars_por_token": round(ratio, 2)}, ensure_ascii=False))
    return 0


def cmd_speed(args) -> int:
    if not wait_idle(args.wait_idle) and not args.force:
        print("ABORTADO: máquina não esfriou (use --force para ignorar).")
        return 2
    _, antes = check_idle()
    # ~3,2 chars/token para texto técnico em pt-BR; o número que vale é o
    # `tokens_lidos` devolvido, não esta estimativa.
    m = measure_prompt(args.model, args.ctx * 3, num_predict=args.predict)
    _, depois = check_idle(verbose=False)
    print(json.dumps({
        "modelo": args.model, "ctx_alvo": args.ctx,
        "tokens_lidos": m["tokens_lidos"],
        "prefill_tok_s": m["prefill_tok_s"],
        "geracao_tok_s": m["geracao_tok_s"],
        "segundos": m["segundos"],
        "carga_antes": antes, "carga_depois": depois,
    }, ensure_ascii=False, indent=2))
    return 0


def cmd_show(args) -> int:
    r = _post("/api/show", {"model": args.model}, timeout=30)
    info = r.get("model_info", {})
    arq = [v for k, v in info.items() if "context_length" in k]
    params = [l for l in (r.get("parameters") or "").splitlines()
              if "num_ctx" in l]
    d = r.get("details", {})
    print(json.dumps({
        "modelo": args.model,
        "parametros": d.get("parameter_size"),
        "quantizacao": d.get("quantization_level"),
        "context_length_arquitetura": arq[0] if arq else None,
        "num_ctx_modelfile": params[0].split()[-1] if params else None,
        "aviso": "nenhum destes é a janela ÚTIL — use `window` para medir",
    }, ensure_ascii=False, indent=2))
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("idle", help="verifica ociosidade da máquina")

    w = sub.add_parser("window", help="busca binária pela janela útil real")
    w.add_argument("--model", required=True)
    w.add_argument("--min-tokens", type=int, default=8_000)
    w.add_argument("--max-tokens", type=int, default=200_000)
    w.add_argument("--tolerance", type=int, default=2_000)
    w.add_argument("--force", action="store_true")
    w.add_argument("--wait-idle", type=int, default=300)

    s = sub.add_parser("speed", help="prefill e geração num contexto dado")
    s.add_argument("--model", required=True)
    s.add_argument("--ctx", type=int, default=32_768)
    s.add_argument("--predict", type=int, default=128)
    s.add_argument("--force", action="store_true")
    s.add_argument("--wait-idle", type=int, default=300)

    sh = sub.add_parser("show", help="o que o Ollama declara")
    sh.add_argument("--model", required=True)

    args = p.parse_args()
    if args.cmd == "idle":
        return 0 if check_idle()[0] else 1
    return {"window": cmd_window, "speed": cmd_speed, "show": cmd_show}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
