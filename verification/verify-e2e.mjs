// ============================================================================
// V-E2E 验证：真起 TLS 上游 + 真起 ASTI 代理（最小原型），端到端验证 4 项：
//   ① 命中规则 → 静默拦截（200 {code:0}，不触达上游）
//   ② 同域其它路径 → 放行转发（真转发到上游）
//   ③ 非 targets 域 → 纯隧道透传（不解密）
//   ④ SSE 流式 → 增量转发（不缓冲，证明模型流式不被破坏）
// 全程真实 TLS，不 mock 中间层。
// ============================================================================
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";

const P = "C:/tmp/egress-probe";
const leafKey = fs.readFileSync(P+"/leaf.key");
const leafCert = fs.readFileSync(P+"/leaf.pem");
const caCert = fs.readFileSync(P+"/ca.pem");

const UPSTREAM_PORT = 9443;
const PROXY_PORT = 8899;

// ---------- 真实 TLS 上游（模拟 zcode.z.ai 等多路径） ----------
let upstreamHits = [];
const upstream = https.createServer({ key: leafKey, cert: leafCert }, (req,res)=>{
  upstreamHits.push(req.url);
  if (req.url.startsWith("/api/v1/zcode-plan/billing/balance")) {
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({code:0,data:{balances:[]}}));
  }
  if (req.url.startsWith("/api/v1/snapshot/upload-credential")) {
    // 真实上游会返回凭据；但命中规则时我们应拦在前，永不到这
    res.writeHead(200,{"Content-Type":"application/json"});
    return res.end(JSON.stringify({code:0,data:{snapshot:{snapshot_id:"REAL-UPSTREAM"}}}));
  }
  if (req.url.startsWith("/sse")) {
    res.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-cache"});
    let n=0;
    const t=setInterval(()=>{ res.write(`data: chunk-${n}\n\n`); if(++n>=3){clearInterval(t);res.end("data: done\n\n");} },120);
    return;
  }
  res.writeHead(200,{"Content-Type":"application/json"}); res.end(JSON.stringify({code:0,path:req.url}));
});

// ---------- 最小 ASTI 代理 ----------
const TARGETS = new Set(["zcode.z.ai"]);          // 需解密的域
const BLOCK = [{host:/^zcode\.z\.ai$/, path:/^\/api\/v1\/snapshot\/upload-credential/}];
const UPSTREAM_MAP = { "zcode.z.ai":"127.0.0.1:"+UPSTREAM_PORT, "api.deepseek.com":"127.0.0.1:"+UPSTREAM_PORT, "passthrough.test":"127.0.0.1:"+UPSTREAM_PORT };
const proxyLog = [];

const proxy = net.createServer((client)=>{
  let buf = Buffer.alloc(0);
  client.on("data", function onFirst(chunk){
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf("\r\n\r\n");
    if (end<0) return;
    client.removeListener("data", onFirst);
    const header = buf.slice(0,end).toString("latin1");
    const m = /^CONNECT\s+([^:\s]+):(\d+)/.exec(header);
    if(!m){ client.end("HTTP/1.1 400 Bad Request\r\n\r\n"); return; }
    const host = m[1];
    const up = UPSTREAM_MAP[host] || (host+":"+m[2]);
    if(!TARGETS.has(host)){
      // ③ 透传：纯 TCP 隧道，不解密（注意：必须缓存 upSock 建连前到达的 ClientHello）
      proxyLog.push(`PASSTHROUGH ${host}`);
      const [uh,up_] = up.split(":");
      const upSock = net.connect(Number(up_), uh);
      let pending = [buf.slice(end+4)];
      const onMore = (c)=> pending.push(c);
      client.on("data", onMore);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upSock.on("connect",()=>{
        client.removeListener("data", onMore);
        for(const p of pending) if(p.length) upSock.write(p);
        pending = [];
        client.pipe(upSock); upSock.pipe(client);
      });
      upSock.on("error",()=>client.destroy());
      return;
    }
    // MITM：用 leaf 终止 TLS
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tlsSock = new tls.TLSSocket(client,{isServer:true,key:leafKey,cert:leafCert});
    let hb = Buffer.alloc(0);
    tlsSock.on("data", function onReq(c){
      hb = Buffer.concat([hb,c]);
      const he = hb.indexOf("\r\n\r\n");
      if(he<0) return;
      tlsSock.removeListener("data", onReq);
      const h = hb.slice(0,he).toString("latin1");
      const [reqLine] = h.split("\r\n");
      const [method, path] = reqLine.split(" ");
      const isBlock = BLOCK.some(r=>r.host.test(host) && r.path.test(path));
      if(isBlock){
        // ① 静默拦截
        proxyLog.push(`BLOCK ${method} https://${host}${path}`);
        const body = JSON.stringify({code:0,msg:""});
        tlsSock.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        return;
      }
      // ② 放行转发到真实上游（用 CA 信任上游）
      proxyLog.push(`PASS ${method} https://${host}${path}`);
      const [uh,up_] = up.split(":");
      const uReq = https.request({host:uh,port:Number(up_),path:path,method:method,headers:{"host":host},ca:caCert,rejectUnauthorized:true}, (uRes)=>{
        tlsSock.write(`HTTP/1.1 ${uRes.statusCode} OK\r\n`);
        for(const [k,v] of Object.entries(uRes.headers)) tlsSock.write(`${k}: ${v}\r\n`);
        tlsSock.write("\r\n");
        uRes.pipe(tlsSock); // ④ 流式：直接 pipe，不缓冲
      });
      uReq.on("error",(e)=>{ tlsSock.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n`); });
      if(hb.length>he+4) uReq.write(hb.slice(he+4));
      uReq.end();
    });
    tlsSock.on("error",()=>{});
  });
});

// ---------- 测试驱动 ----------
function request(host, path, {expectStream=false}={}){
  return new Promise((resolve,reject)=>{
    const sock = net.connect(PROXY_PORT,"127.0.0.1",()=>{
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
    });
    let phase="connect", buf="";
    const chunks=[]; let firstChunkAt=null; const t0=Date.now();
    sock.on("data",(d)=>{
      if(phase==="connect"){
        buf+=d.toString("latin1");
        if(buf.includes("\r\n\r\n")){
          const rest=buf.slice(buf.indexOf("\r\n\r\n")+4);
          phase="tls";
          const ts = tls.connect({socket:sock,servername:host,ca:caCert,rejectUnauthorized:true},()=>{
            ts.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nAccept: text/event-stream\r\nConnection: close\r\n\r\n`);
            if(rest) ts.write(rest);
          });
          ts.on("data",(dd)=>{ if(firstChunkAt===null) firstChunkAt=Date.now()-t0; chunks.push(dd.toString()); });
          ts.on("end",()=>resolve({text:chunks.join(""),firstChunkAt}));
          ts.on("error",reject);
        }
        return;
      }
    });
    sock.on("error",reject);
    setTimeout(()=>reject(new Error("timeout")),5000);
  });
}

(async ()=>{
  process.on("unhandledRejection",(e)=>{ console.error("[unhandledRejection]", e&&e.stack||e); });
  process.on("uncaughtException",(e)=>{ console.error("[uncaughtException]", e&&e.stack||e); });
  await new Promise(r=>upstream.listen(UPSTREAM_PORT,"127.0.0.1",r));
  await new Promise(r=>proxy.listen(PROXY_PORT,"127.0.0.1",r));
  const results=[];
  const t=(name,cond,extra="")=>{ results.push([cond,name,extra]); };
  const safe = async (label, fn)=>{ try { return await fn(); } catch(e){ console.error(`[用例 ${label} 抛错] ${e.message}`); return {text:"",firstChunkAt:null}; } };

  // ① 命中 → 静默拦截（上游不应被触达）
  upstreamHits=[];
  let r1 = await safe("①",()=>request("zcode.z.ai","/api/v1/snapshot/upload-credential?workspace_id=abc"));
  t("① 命中规则 → 静默拦截 200", r1.text.includes('"code":0') && !r1.text.includes("REAL-UPSTREAM"), r1.text.slice(0,60));
  t("① 拦截时上游未被触达", !upstreamHits.some(u=>u.includes("upload-credential")), "upstreamHits="+JSON.stringify(upstreamHits));

  // ② 同域其它路径 → 放行，真转发
  upstreamHits=[];
  let r2 = await safe("②",()=>request("zcode.z.ai","/api/v1/zcode-plan/billing/balance"));
  t("② 同域其它路径 → 放行转发", r2.text.includes("balances"), r2.text.slice(0,60));
  t("② 放行时上游确实被触达", upstreamHits.some(u=>u.includes("billing")), "upstreamHits="+JSON.stringify(upstreamHits));

  // ③ 非 targets 域 → 透传
  let r3 = await safe("③",()=>request("passthrough.test","/api/v1/zcode-plan/billing/balance"));
  t("③ 非 targets 域 → 透传成功", r3.text.includes("balances"), r3.text.slice(0,60));

  // ④ SSE 流式 → 增量（首个 chunk 应在 3 个 chunk 全部完成前到达）
  let r4 = await safe("④",()=>request("zcode.z.ai","/sse",{expectStream:true}));
  const totalTime = 3*120;
  t("④ SSE 流式未缓冲（首块早于总时长）", r4.firstChunkAt!==null && r4.firstChunkAt < totalTime-80, `firstChunkAt=${r4.firstChunkAt}ms total≈${totalTime}ms`);
  t("④ SSE 内容完整", r4.text.includes("chunk-0")&&r4.text.includes("chunk-2")&&r4.text.includes("done"), r4.text.replace(/\n/g,"|").slice(0,80));

  // 输出
  console.log("\n===== V-E2E 结果 =====");
  let pass=0,fail=0;
  for(const [c,n,x] of results){ c?pass++:fail++; console.log(`${c?"PASS":"FAIL"}  ${n}\n      ${x}`); }
  console.log(`\nproxyLog: ${JSON.stringify(proxyLog)}`);
  console.log(`\n结果：${pass} passed, ${fail} failed`);
  proxy.close(); upstream.close();
  process.exit(fail?1:0);
})();
