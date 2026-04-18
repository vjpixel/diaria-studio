# ComfyUI Setup — Diar.ia Studio

Guia para instalar e configurar o ComfyUI com LoRA Van Gogh impasto para geração das imagens da newsletter.

---

## 1. Instalar ComfyUI

```bash
git clone https://github.com/comfyanonymous/ComfyUI
cd ComfyUI
pip install -r requirements.txt
```

Requer **Python 3.12** e uma GPU com suporte a CUDA (ou CPU, mais lento). [Docs oficiais](https://github.com/comfyanonymous/ComfyUI).

> **Atenção:** PyTorch CUDA tem wheels apenas para Python 3.9–3.13. Se o seu Python padrão for 3.14+, veja a seção "Python 3.14" antes de continuar.

---

## 2. Baixar um modelo base (SD 1.5)

O workflow da Diar.ia usa SD 1.5 como base. Baixe um dos modelos abaixo e coloque em `ComfyUI/models/checkpoints/`:

- **Recomendado**: [v1-5-pruned-emaonly.safetensors](https://huggingface.co/runwayml/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors) (~4GB)

Após baixar, atualize `platform.config.json`:
```json
"comfyui": {
  "checkpoint": "v1-5-pruned-emaonly.safetensors"
}
```

---

## 3. Baixar LoRA Van Gogh impasto

Procure no [CivitAI](https://civitai.com) por uma LoRA de estilo Van Gogh/impasto. Sugestões de busca:
- "Van Gogh style LoRA"
- "impasto painting LoRA"
- "oil painting impressionist LoRA"

Coloque o arquivo `.safetensors` da LoRA em `ComfyUI/models/loras/` e atualize `platform.config.json`:
```json
"comfyui": {
  "lora": "nome-exato-do-arquivo.safetensors"
}
```

O nome deve corresponder **exatamente** ao arquivo (incluindo extensão).

---

## 4. Iniciar ComfyUI

```bash
cd ComfyUI
python main.py --listen 127.0.0.1 --port 8188
```

Para rodar em background (Windows):
```powershell
Start-Process python -ArgumentList "main.py --listen 127.0.0.1 --port 8188" -WindowStyle Minimized
```

---

## 5. Verificar instalação

```bash
curl http://127.0.0.1:8188/system_stats
```

Deve retornar JSON com `system.os`, `devices[]`, etc. Se retornar erro, verifique se o ComfyUI iniciou sem erros.

Verificar modelos disponíveis:
```bash
# Checkpoints:
curl -s http://127.0.0.1:8188/object_info/CheckpointLoaderSimple | node -e \
  "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.CheckpointLoaderSimple.input.required.ckpt_name[0])"

# LoRAs:
curl -s http://127.0.0.1:8188/object_info/LoraLoader | node -e \
  "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.LoraLoader.input.required.lora_name[0])"
```

Os nomes listados devem corresponder ao que está em `platform.config.json`.

---

## 6. Configuração final em `platform.config.json`

Arquivo fica na raiz do projeto: `diaria-studio/platform.config.json`.

```json
"comfyui": {
  "host": "http://127.0.0.1:8188",
  "checkpoint": "v1-5-pruned-emaonly.safetensors",
  "lora": "seu-lora-van-gogh.safetensors",
  "steps": 30,
  "cfg": 7.5,
  "sampler": "dpmpp_2m",
  "base_width": 768,
  "base_height": 384,
  "width": 2000,
  "height": 1000,
  "hires_steps": 15,
  "hires_denoise": 0.5,
  "hires_upscale_method": "bislerp"
}
```

Ajuste `steps` (mais steps = mais qualidade, mais tempo) e `cfg` (escala de aderência ao prompt, 6–8 é um bom range) conforme preferência.

---

## 7. Por que hires.fix? (workflow de 2 passos)

SD 1.5 foi treinado em **512×512**. Se pedir direto uma imagem 2000×1000 ao modelo, o resultado tem artefatos clássicos: anatomia duplicada, mesmos objetos repetidos pela tela, composição quebrada. A rede "não enxerga" a imagem inteira de uma vez em alta resolução.

A solução padrão é **hires.fix**: gerar em resolução nativa e depois refinar em alta.

```
[passo 1] EmptyLatent 768×384 → KSampler (steps=30, denoise=1.0)
              ↓
[passo 2] LatentUpscale → 2000×1000 (bislerp)
              ↓
[passo 3] KSampler (steps=15, denoise=0.5) → VAEDecode → SaveImage
```

### Parâmetros que importam

| Param | Função | Valores típicos |
|---|---|---|
| `base_width` × `base_height` | Resolução do 1º passo. Deve ficar próxima de 512×512 em área total. 768×384 = 295k pixels ≈ 512×512 = 262k pixels. | `768×384` (2:1), `512×512` (1:1), `640×512` (5:4) |
| `width` × `height` | Resolução final após upscale latente. | `2000×1000` |
| `hires_denoise` | Quanto o 2º passo "refaz" a imagem upscaled. Baixo demais = imagem borrada; alto demais = perde a composição do 1º passo. | `0.3`–`0.7` (default `0.5`) |
| `hires_steps` | Passos do 2º KSampler. Menos que `steps` porque só refina detalhes. | `10`–`20` |
| `hires_upscale_method` | Algoritmo do upscale latente. `bislerp` é o padrão e costuma produzir os melhores resultados; `nearest-exact` preserva mais o 1º passo; `bicubic`/`bilinear` suavizam mais. | `bislerp` |

### Quando ajustar

- **Composição mudando demais no 2º passo** → baixar `hires_denoise` para `0.4` ou menos
- **Imagem muito borrada ou sem detalhes finos** → subir `hires_denoise` para `0.6`
- **Ainda vendo elementos duplicados** → baixar `base_width`/`base_height` para `640×320` (mais perto de 512×512)
- **Tempo de geração muito longo** → baixar `hires_steps` para 10, ou `steps` para 25

---

## Python 3.14 — criar virtualenv com Python 3.12

PyTorch CUDA tem wheels para Python 3.9–3.13. Se o Python do sistema for 3.14+, o `pip install` vai dizer "Requirement already satisfied" (encontra o torch CPU-only existente) mas o CUDA não vai funcionar.

Solução: criar um virtualenv com Python 3.12 dentro da pasta do ComfyUI.

**1. Instalar Python 3.12** (se não tiver): [python.org/downloads](https://www.python.org/downloads/release/python-3120/)

**2. Criar venv e instalar dependências:**
```powershell
cd C:\Users\vjpix\ComfyUI
python3.12 -m venv venv
venv\Scripts\activate
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
```

**3. Verificar CUDA:**
```powershell
python -c "import torch; print(torch.cuda.is_available())"
# deve retornar: True
```

**4. Sempre ativar o venv antes de iniciar:**
```powershell
cd C:\Users\vjpix\ComfyUI
venv\Scripts\activate
python main.py --listen 127.0.0.1 --port 8188
```

---

## Resolução de problemas

| Erro | Causa provável | Solução |
|---|---|---|
| `AssertionError: Torch not compiled with CUDA enabled` | PyTorch CPU-only instalado | Criar venv com Python 3.12 (seção acima) |
| `pip install` diz "already satisfied" mas CUDA não funciona | Python 3.14 sem wheels CUDA | Criar venv com Python 3.12 (seção acima) |
| `curl: (7) Failed to connect` | ComfyUI não está rodando | Iniciar `python main.py` |
| `{"error":"...ckpt_name..."}` | Nome do checkpoint errado | Verificar nome exato com o comando da seção 5 |
| `{"error":"...lora_name..."}` | Nome da LoRA errado | Verificar nome exato com o comando da seção 5 |
| Imagem gerada sem estilo Van Gogh | LoRA não está sendo aplicada | Verificar `strength_model: 0.8` e nome da LoRA |
| Timeout após 5 min | GPU lenta ou muitos steps | Reduzir `steps` para 20 em `platform.config.json` |
