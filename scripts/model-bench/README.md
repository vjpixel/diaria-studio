# Harness de avaliação do modelo local do contínuo

Mede se um modelo local serve como primário da skill
`hermes-diaria-continuo`. Reexecutável para qualquer modelo novo — é o
ponto: quando aparecer um candidato, roda-se isto em vez de re-derivar a
metodologia.

Contexto, decisões e medições acumuladas: [`docs/goal-modelo-local-continuo.md`](../../docs/goal-modelo-local-continuo.md).

## O que ele mede, e por quê

O modelo local é **orquestrador, não implementador**: não escreve código
(delegado a `claude -p`), não classifica issue (`npx tsx` determinístico,
sem LLM), não revisa nem mergeia. O uso mais complexo é seguir um
procedimento de 38 KB com dezenas de ramificações fail-closed sem derivar.

Por isso o harness **não** mede capacidade de código. Mede janela útil,
aderência a instrução longa, disciplina de ferramenta e não-fabricação —
que é o que os 3 modos de falha medidos em produção têm em comum (#6917
regra fabricada, #7130 laço não fechado, #6712 estado alucinado).

## Uso

```bash
# no 300, onde o Ollama roda
python3 probe.py idle                                  # a máquina está medível?
python3 probe.py show      --model qwen-64k:latest     # o que o Ollama declara
python3 probe.py window    --model qwen-64k:latest     # janela ÚTIL real
python3 probe.py speed     --model qwen-64k:latest --ctx 32768
python3 adherence.py       --model qwen-64k:latest     # cenários c/d/e
```

## Três armadilhas que este harness existe para não repetir

**1. O `num_ctx` declarado não é a janela útil.** Medido em 06/09/2026: o
`qwen-64k:latest` aceitou 102.213 tokens, devolveu **HTTP 200 sem erro** e
leu 32.770 — truncando *do começo*, que é onde ficam as regras. Truncagem
não é erro em lugar nenhum da pilha (o Ollama devolve 200; o Hermes v0.20.5
não checa `prompt_eval_count` no caminho da chamada), então o fallback
nunca dispara. `window` sonda e compara enviado contra lido; nunca confie
em `show`.

**2. Medir com a máquina ocupada invalida a célula.** O tick do contínuo é
I/O-bound (chamadas de API, `gh`, `git`): roda com `load1` baixo e GPU
livre, então um guard só de CPU/VRAM **aprova a largada por engano**. Por
isso `check_idle` também procura processo em voo. Todo comando aborta se a
máquina não estiver ociosa; `--force` existe mas invalida a comparação.

**3. Sinal semântico não pode dirigir busca.** A 1ª versão de `window`
cortava o intervalo quando o modelo não devolvia a palavra-código. Como
`num_predict` estava apertado e o `qwen3.5` é um modelo *thinking*, o
orçamento de saída ia todo para o raciocínio e a resposta vinha vazia —
toda célula virou "truncou" e a busca reportou **"janela útil 0 tokens"**.
Hoje a busca é dirigida só por `prompt_eval_count` (mecânico) e a
palavra-código é reportada à parte, como confirmação. As chamadas mandam
`think=False` e `num_predict` folgado.

## Cenários da bateria de aderência

Cada um replica um incidente real, e em todos a resposta correta **está no
SKILL.md que vai junto no prompt**. É deliberado: o teste não pergunta se o
modelo sabe a regra, e sim se ele ainda a alcança com ~56-61k de contexto —
a ocupação real do tick contra uma janela de 65.536.

| cenário | replica | resposta certa | falha característica |
|---|---|---|---|
| `d` | #6917 | `reivindicar_issue` | inventa regra para encerrar o tick |
| `e` | #6712 | `preservar_claim` | desfaz claim de trabalho que já existe |
| `c` | guard fail-closed | `nao_reivindicar` | trata `exit 2` como permissão |

**O modelo em produção falha o `c` em todos os níveis de contexto** — escolhe
`perguntar_ao_editor` em vez de `nao_reivindicar`, contrariando o guard e o
princípio "Perguntar é exceção". Não é truncagem: erra com a regra inteira
disponível. Nenhum candidato testado acertou melhor.

A resposta é JSON com enum fechado, pontuada mecanicamente: texto livre não
se avalia de forma determinística, e um grader-LLM introduziria mais uma
fonte de erro dentro da própria medição. O tick emite comandos, não ensaios.

Cada cenário roda `--repeats` vezes (3 por padrão): temperatura 0 não
garante determinismo quando o KV cache é reaproveitado entre chamadas.
