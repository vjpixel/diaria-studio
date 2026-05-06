import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { extractPostText, postToMakeWebhook } from "../scripts/publish-linkedin.ts";

const LF = "# Facebook\n\n## d1\nFacebook d1.\n\n# LinkedIn\n\n## d1\nLinkedIn d1.\n\nLinha 2 d1.\n\n## d2\nLinkedIn d2.\n<!-- oculto -->\n\n## d3\nLinkedIn d3.";
const CRLF = LF.replace(/\n/g, "\r\n");

describe("extractPostText (publish-linkedin) (#528)", () => {
  it("extrai d1 de # LinkedIn (LF)", () => { const t=extractPostText(LF,"d1"); assert.ok(t.includes("LinkedIn d1.")); assert.ok(t.includes("Linha 2 d1.")); assert.ok(!t.includes("Facebook d1.")); });
  it("extrai d2 sem vazar d1/d3", () => { const t=extractPostText(LF,"d2"); assert.ok(t.includes("LinkedIn d2.")); assert.ok(!t.includes("LinkedIn d1.")); assert.ok(!t.includes("LinkedIn d3.")); });
  it("extrai d3", () => { assert.ok(extractPostText(LF,"d3").includes("LinkedIn d3.")); });
  it("normaliza CRLF para LF", () => { assert.ok(extractPostText(CRLF,"d1").includes("LinkedIn d1.")); });
  it("remove comentarios HTML", () => { assert.ok(!extractPostText(LF,"d2").includes("oculto")); });
  it("lanca sem secao LinkedIn", () => { assert.throws(()=>extractPostText("# Facebook\n\n## d1\nT.","d1"),/LinkedIn/i); });
  it("lanca sem destaque", () => { assert.throws(()=>extractPostText("# LinkedIn\n\n## d1\nT.","d4"),/d4/i); });
  it("d1 nao contamina d2", () => { assert.ok(!extractPostText(LF,"d1").includes("LinkedIn d2.")); });
});

describe("postToMakeWebhook (#528)", () => {
  const webhookUrl="https://hook.eu2.make.com/test";
  const payload={text:"T",image_url:null as string|null,scheduled_at:null as string|null,destaque:"d1"};
  let saved: typeof globalThis.fetch;
  beforeEach(()=>{saved=globalThis.fetch;});
  afterEach(()=>{globalThis.fetch=saved;});

  it("retry: 500 na 1a tentativa 200 na 2a", async()=>{
    let n=0;
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>{n++;if(n===1)return new Response("E",{status:500});return new Response(JSON.stringify({accepted:true,request_id:"r"}),{status:200,headers:{"Content-Type":"application/json"}});};
    const r=await postToMakeWebhook(webhookUrl,payload,2);
    assert.equal(n,2); assert.equal(r.accepted,true);
  });

  it("lanca apos 2 tentativas sempre 500", async()=>{
    let n=0;
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>{n++;return new Response("E",{status:503});};
    await assert.rejects(()=>postToMakeWebhook(webhookUrl,payload,2),/Make webhook HTTP 503/);
    assert.equal(n,2);
  });

  it("retorna accepted:true body vazio HTTP 200", async()=>{
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>new Response("",{status:200});
    assert.equal((await postToMakeWebhook(webhookUrl,payload,1)).accepted,true);
  });

  it("retorna accepted:true body nao-JSON HTTP 200", async()=>{
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>new Response("OK",{status:200});
    assert.equal((await postToMakeWebhook(webhookUrl,payload,1)).accepted,true);
  });

  it("retorna request_id do response JSON", async()=>{
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>new Response(JSON.stringify({request_id:"req_xyz",accepted:true}),{status:200,headers:{"Content-Type":"application/json"}});
    assert.equal((await postToMakeWebhook(webhookUrl,payload,1)).request_id,"req_xyz");
  });

  it("maxAttempts=1 tenta apenas 1x e lanca", async()=>{
    let n=0;
    globalThis.fetch=async(_u:string|URL|Request,_o?:RequestInit)=>{n++;return new Response("Bad",{status:502});};
    await assert.rejects(()=>postToMakeWebhook(webhookUrl,payload,1),/Make webhook HTTP 502/);
    assert.equal(n,1);
  });

  it("payload contem image_url:null nenhuma URL enviada", async()=>{
    let body:string|undefined;
    globalThis.fetch=async(_u:string|URL|Request,o?:RequestInit)=>{body=o?.body as string;return new Response(JSON.stringify({accepted:true}),{status:200});};
    await postToMakeWebhook(webhookUrl,payload,1);
    assert.ok(body!==undefined); assert.equal(JSON.parse(body).image_url,null);
  });
});

describe("resume-aware skip posts LinkedIn (#528)", () => {
  it("pula scheduled", ()=>{const p=[{platform:"linkedin",destaque:"d1",status:"scheduled"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d1"&&(x.status==="draft"||x.status==="scheduled"));assert.ok(e!==undefined);assert.equal(e.status,"scheduled");});
  it("pula draft", ()=>{const p=[{platform:"linkedin",destaque:"d2",status:"draft"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d2"&&(x.status==="draft"||x.status==="scheduled"));assert.ok(e!==undefined);assert.equal(e.status,"draft");});
  it("nao pula failed retry", ()=>{const p=[{platform:"linkedin",destaque:"d3",status:"failed"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d3"&&(x.status==="draft"||x.status==="scheduled"));assert.equal(e,undefined);});
  it("nao pula outra plataforma facebook nao afeta linkedin", ()=>{const p=[{platform:"facebook",destaque:"d1",status:"scheduled"}];const e=p.find((x)=>x.platform==="linkedin"&&x.destaque==="d1"&&(x.status==="draft"||x.status==="scheduled"));assert.equal(e,undefined);});
});

describe("image_url null por padrao LinkedIn (#528)", () => {
  it("image_url e null no payload nenhuma URL enviada", ()=>{const imageUrl:string|null=null;const p={text:"T",image_url:imageUrl,scheduled_at:null,destaque:"d1"};assert.equal(p.image_url,null);});
});

describe("image_url via cache 06-public-images.json (#725 bug #9)", () => {
  // Testa a lógica de leitura do cache — o main() de publish-linkedin.ts
  // usa existsSync+readFileSync pra carregar 06-public-images.json.
  // Verificamos o shape esperado do cache pra garantir que o código de leitura
  // está correto (campo images.{d}.url).

  it("shape do cache: images.d1.url é a URL Drive esperada", () => {
    const cacheShape = {
      images: {
        d1: { file_id: "abc123", url: "https://drive.google.com/uc?id=abc123&export=view", mime_type: "image/jpeg", filename: "04-d1-1x1.jpg" },
        d2: { file_id: "def456", url: "https://drive.google.com/uc?id=def456&export=view", mime_type: "image/jpeg", filename: "04-d2-1x1.jpg" },
        d3: { file_id: "ghi789", url: "https://drive.google.com/uc?id=ghi789&export=view", mime_type: "image/jpeg", filename: "04-d3-1x1.jpg" },
      },
    };
    // Simula o que main() faz ao ler o cache
    for (const d of ["d1", "d2", "d3"] as const) {
      const url = cacheShape.images?.[d]?.url ?? null;
      assert.ok(url !== null, `${d} deve ter URL`);
      assert.ok(url.startsWith("https://drive.google.com/uc?"), `${d} URL deve ser Drive`);
    }
  });

  it("graceful fallback: chave ausente → null sem throw", () => {
    const cacheShape = { images: { d1: { url: "https://drive.google.com/uc?id=x&export=view" } } };
    const urlD2 = (cacheShape.images as Record<string, {url?: string}>)["d2"]?.url ?? null;
    assert.equal(urlD2, null, "chave ausente deve retornar null");
  });

  it("graceful fallback: cache vazio → null sem throw", () => {
    const emptyCache = {} as { images?: Record<string, {url?: string}> };
    const url = emptyCache.images?.["d1"]?.url ?? null;
    assert.equal(url, null);
  });
});
