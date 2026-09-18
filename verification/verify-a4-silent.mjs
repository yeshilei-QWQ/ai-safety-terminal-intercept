// ============================================================================
// V-A4 验证：用 app.asar 中【真实提取】的 yme/L5e/hme/Qp 函数，驱动
// getUploadCredential → getUploadKey 决策链，验证「静默响应 → null → capture 短路」。
// 只 fake 网络层（ut），其余为真实代码字节。
// 提取来源：D:\Zcode\resources\app.asar v3.10.2
//   yme @254477877  L5e @254477704  hme @254477374  Qp @254477223(cred module)
// ============================================================================

// ---- 以下 4 个函数为 asar 真实字节提取，未做任何改写 ----
function L5e(e){if(e==null)return;let t=typeof e=="string"?Number(e):e;if(!(typeof t!="number"||!Number.isFinite(t)||t<0))return t}

function Qp(e){return!e||typeof e!="object"?"none":Object.keys(e).sort().join(",")||"none"}

function hme(e){return[`code=${e.code}`,e.msg?`msg=${e.msg}`:"",`responseKeys=${Qp(e)}`,`dataKeys=${Qp(e.data)}`,`callbackKeys=${Qp(e.data?.callback)}`,`ossKeys=${Qp(e.data?.oss)}`,`encryptionKeys=${Qp(e.data?.encryption)}`,`snapshotKeys=${Qp(e.data?.snapshot)}`].filter(Boolean).join("; ")}

function yme(e){if(e.code!==0)throw new Error(e.msg||`repo snapshot upload credential failed: code=${e.code}`);if(!e.data)return null;let t=[],n=e.data;n.callback?.url||t.push("callback.url"),n.callback?.body||t.push("callback.body"),n.callback?.content_type||t.push("callback.content_type"),n.oss?.host||t.push("oss.host"),n.oss?.path||t.push("oss.path"),n.oss?.policy||t.push("oss.policy"),n.oss?.x_oss_signature||t.push("oss.x_oss_signature"),n.oss?.x_oss_signature_version||t.push("oss.x_oss_signature_version"),n.oss?.x_oss_credential||t.push("oss.x_oss_credential"),n.oss?.x_oss_security_token||t.push("oss.x_oss_security_token"),n.oss?.x_oss_date||t.push("oss.x_oss_date"),n.encryption?.public_key||t.push("encryption.public_key"),n.encryption?.key_version===void 0&&t.push("encryption.key_version"),n.encryption?.algorithm||t.push("encryption.algorithm"),n.snapshot?.snapshot_id||t.push("snapshot.snapshot_id");let o=L5e(n.max_size);if(n.max_size!==void 0&&o===void 0&&N5e.warn(void 0,"__",{max_size:n.max_size,shape:hme(e)}),t.length>0)throw new Error(`repo snapshot upload credential missing fields: ${t.join(", ")}; ${hme(e)}`);let{max_size:r,...i}=n;return{...i,...o!==void 0?{max_size:o}:{}}}
// ---- 真实字节提取结束 ----

// 依赖桩（仅日志）
const N5e = { warn(){}, info(){} };
const q5e = (e)=>{ if(e.encryption.algorithm!=="RSA-OAEP-256") throw new Error("unsupported repo snapshot key wrap algorithm: "+e.encryption.algorithm); };

// ut = asar 真实逻辑（readApiJson）：非 2xx 抛错；2xx 解析 json（解析失败抛错）
async function ut(apiClient, url, opts){
  const i = await apiClient.request(url, opts);
  if(!i.ok){ throw new Error("HTTP "+i.status); }
  try { return await i.json(); } catch(a){ throw new Error("Invalid JSON response"); }
}

// getUploadCredential / getUploadKey = asar 真实方法体（仅把外部依赖名对齐）
class UploadClient {
  constructor(apiClient){ this.apiClient = apiClient; this.credentialTimeoutMs = 15000; this.uploadCredentialsByHandle = new Map(); }
  pruneExpiredUploadCredentials(){}
  async getUploadCredential(t,n,o){
    let r = "https://zcode.z.ai/api/v1/snapshot/upload-credential?workspace_id="+n,
        i = await ut(this.apiClient, r, {method:"GET", headers:{Authorization:`Bearer ${t}`}, timeoutMs:this.credentialTimeoutMs, signal:o}),
        a = yme(i);
    return a ? (q5e(a), a) : null;
  }
  async getUploadKey(t,n,o,r){
    let i = await this.getUploadCredential(t,n,r?.signal);
    if(!i) return null;
    this.pruneExpiredUploadCredentials();
    let a = "handle-"+Math.random().toString(16).slice(2);
    this.uploadCredentialsByHandle.set(a,{credential:i});
    return { schema:"v", uploadCredentialHandle:a, snapshotId:i.snapshot.snapshot_id };
  }
}

// capture 侧判定（asar: captureBeforePromptUnsafe 的真实分流）
async function captureWouldUpload(client, token, wsId){
  const a = await client.getUploadKey(token, wsId, undefined, {});
  if(!a) return "SHORT-CIRCUIT（不上传）";   // 真实代码：if(!a)return;
  return "PROCEED（继续打包上传）";
}

// ---- 三个用例 ----
const silentResp   = { code:0, msg:"" };                                   // 我们的静默拦截响应
const okResp       = { code:0, data:{ callback:{url:"u",body:"b",content_type:"c"}, oss:{host:"h",path:"p",policy:"po",x_oss_signature:"s",x_oss_signature_version:"1",x_oss_credential:"c",x_oss_security_token:"t",x_oss_date:"d"}, encryption:{public_key:"-----BEGIN PUBLIC KEY-----\nxxx", key_version:1, algorithm:"RSA-OAEP-256"}, snapshot:{snapshot_id:"snap-1"} } };

function mkClient(responder){
  return new UploadClient({ request: async(url,opts)=> responder(url,opts) });
}
const ok = (body)=>({ ok:true, status:200, json: async()=>body });
const err = (status)=>({ ok:false, status, json: async()=>{throw new Error("no body")} });

(async ()=>{
  let pass = 0, fail = 0;
  const check = (name, got, want)=>{ const good = got===want; good?pass++:fail++; console.log(`${good?"PASS":"FAIL"}  ${name}\n      got=${got}  want=${want}`); };

  // 用例1：静默响应 {code:0} 无 data → 应短路且不抛错
  {
    const c = mkClient(()=>ok(silentResp));
    let r; try { r = await captureWouldUpload(c, "tok", "ws1"); } catch(e){ r = "THREW: "+e.message; }
    check("静默响应 {code:0} 无 data → 不上传、不报错", r, "SHORT-CIRCUIT（不上传）");
  }

  // 用例2：真实成功响应 → 应继续上传（证明未误伤正常链路）
  {
    const c = mkClient(()=>ok(okResp));
    let r; try { r = await captureWouldUpload(c, "tok", "ws1"); } catch(e){ r = "THREW: "+e.message; }
    check("真实凭据响应 → 继续上传（未误伤）", r, "PROCEED（继续打包上传）");
  }

  // 用例3：forbidden 模式 403 → ut 抛错（客户端可能记录/重试）
  {
    const c = mkClient(()=>err(403));
    let r; try { r = await captureWouldUpload(c, "tok", "ws1"); } catch(e){ r = "THREW"; }
    check("403 forbidden → 抛错（fail-loud 模式）", r, "THREW");
  }

  console.log(`\n结果：${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
})();
