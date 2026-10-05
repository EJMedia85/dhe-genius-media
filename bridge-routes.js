const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false })
  : null;

const BRIDGE_SECRET = String(process.env.DGM_BRIDGE_SECRET || "").trim();
if (process.env.NODE_ENV === "production" && BRIDGE_SECRET.length < 32) {
  console.warn("DGM Bridge: DGM_BRIDGE_SECRET is missing/short; pairing routes will refuse writes.");
}

function hmac(value) {
  return crypto.createHmac("sha256", BRIDGE_SECRET || "development-only-bridge-secret").update(value).digest("hex");
}
function token(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return body + "." + hmac(body);
}
function verifyToken(raw) {
  try {
    const [body, sig] = String(raw || "").split(".");
    if (!body || !sig || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(hmac(body)))) return null;
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function randomCode() {
  return crypto.randomInt(100000, 1000000).toString();
}
function randomSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

async function initBridgeDatabase() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dgm_bridge_devices (
      device_id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('host','client')),
      public_key TEXT NOT NULL,
      country TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      last_seen TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS dgm_bridge_pairings (
      code TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      host_device_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      session_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS dgm_bridge_pairings_expiry_idx ON dgm_bridge_pairings(expires_at);
  `);
}

function installBridge(app) {
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/bridge/status", async (req, res) => {
    res.json({ success:true, service:"DGM Bridge", protocol:"relay-v1", configured:Boolean(pool && BRIDGE_SECRET), timestamp:new Date().toISOString() });
  });

  app.get("/api/bridge/registration-status", async (req,res) => {
    try {
      if (!pool) return res.status(503).json({success:false,message:"Database unavailable."});
      const deviceId=String(req.query.device_id||"").trim();
      if(!deviceId) return res.status(400).json({success:false,message:"device_id is required."});
      const row=(await pool.query(`SELECT device_id,role,approval_status,status,approved_at FROM dgm_bridge_devices WHERE device_id=$1`,[deviceId])).rows[0];
      if(!row) return res.status(404).json({success:false,message:"Device registration not found."});
      if(row.approval_status==="approved"){
        const issued=token({sub:row.device_id,role:row.role,exp:Date.now()+24*60*60*1000});
        await pool.query(`UPDATE dgm_bridge_devices SET status='online',last_seen=NOW() WHERE device_id=$1`,[deviceId]);
        return res.json({success:true,device_id:row.device_id,role:row.role,approval_status:"approved",status:"authorized",token:issued});
      }
      return res.json({success:true,device_id:row.device_id,role:row.role,approval_status:row.approval_status,status:row.status,approved_at:row.approved_at||null,message:row.approval_status==="denied"?"Registration denied by DGM Admin.":"Waiting for DGM Admin authorization."});
    } catch(e){ console.error("Bridge registration status:",e.message); return res.status(500).json({success:false,message:"Could not check registration status."}); }
  });

  app.get("/api/admin/bridge/registrations", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const rows=(await pool.query(`SELECT device_id,role,country,status,approval_status,approved_at,approved_by,last_seen,created_at FROM dgm_bridge_devices ORDER BY CASE approval_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,created_at DESC`)).rows;
      return res.json({success:true,registrations:rows});
    } catch(e){ return res.status(500).json({success:false,message:"Could not load registrations."}); }
  });

  app.post("/api/admin/bridge/registrations/:deviceId/approve", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const id=String(req.params.deviceId||"").trim();
      const row=(await pool.query(`UPDATE dgm_bridge_devices SET approval_status='approved',status='authorized',approved_at=NOW(),approved_by=$2 WHERE device_id=$1 RETURNING device_id,role,approval_status,status,approved_at,approved_by`,[id,req.session.adminEmail||"admin"])).rows[0];
      if(!row) return res.status(404).json({success:false,message:"Device registration not found."});
      return res.json({success:true,registration:row});
    } catch(e){ console.error("Bridge approve:",e.message); return res.status(500).json({success:false,message:"Could not authorize device."}); }
  });

  app.post("/api/admin/bridge/registrations/:deviceId/deny", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const id=String(req.params.deviceId||"").trim();
      const row=(await pool.query(`UPDATE dgm_bridge_devices SET approval_status='denied',status='denied',approved_at=NULL,approved_by=$2 WHERE device_id=$1 RETURNING device_id,approval_status,status`,[id,req.session.adminEmail||"admin"])).rows[0];
      if(!row) return res.status(404).json({success:false,message:"Device registration not found."});
      return res.json({success:true,registration:row});
    } catch(e){ return res.status(500).json({success:false,message:"Could not deny device."}); }
  });

  app.post("/api/bridge/register", async (req,res) => {
    try {
      if (!pool || BRIDGE_SECRET.length < 32) return res.status(503).json({success:false,message:"DGM Bridge control plane is not configured."});
      const deviceId=String(req.body?.device_id||"").trim();
      const role=String(req.body?.role||"").trim();
      const publicKey=String(req.body?.public_key||"").trim();
      const country=String(req.body?.country||"").trim().slice(0,80);
      if (!deviceId || !publicKey || !["host","client"].includes(role)) return res.status(400).json({success:false,message:"device_id, role and public_key are required."});
      await pool.query(
        `INSERT INTO dgm_bridge_devices(device_id,role,public_key,country,status,approval_status,last_seen)
         VALUES($1,$2,$3,$4,'pending','pending',NOW())
         ON CONFLICT(device_id) DO UPDATE SET role=EXCLUDED.role,public_key=EXCLUDED.public_key,country=EXCLUDED.country,last_seen=NOW()`,
        [deviceId,role,publicKey,country]
      );
      const row=(await pool.query(`SELECT device_id,role,approval_status,status FROM dgm_bridge_devices WHERE device_id=$1`,[deviceId])).rows[0];
      if(row.approval_status!=="approved") {
        return res.json({success:true,device_id:deviceId,role:row.role,approval_status:row.approval_status,status:"pending",message:"Registration received. Waiting for DGM Admin authorization."});
      }
      const issued=token({sub:deviceId,role,exp:Date.now()+24*60*60*1000});
      await pool.query(`UPDATE dgm_bridge_devices SET status='online',last_seen=NOW() WHERE device_id=$1`,[deviceId]);
      res.json({success:true,device_id:deviceId,role,approval_status:"approved",status:"authorized",token:issued});
    } catch(e) {
      console.error("Bridge register:",e.message);
      res.status(500).json({success:false,message:"Could not register bridge device."});
    }
  });

  app.post("/api/bridge/pair/create", async (req,res) => {
    try {
      const auth=verifyToken(req.get("authorization")?.replace(/^Bearer\s+/i,""));
      if (!auth || auth.role!=="host") return res.status(401).json({success:false,message:"Host authentication required."});
      const approved=(await pool.query("SELECT approval_status FROM dgm_bridge_devices WHERE device_id=$1",[auth.sub])).rows[0];
      if(!approved || approved.approval_status!=="approved") return res.status(403).json({success:false,message:"Host device is not authorized by DGM Admin."});
      if (!pool) return res.status(503).json({success:false,message:"Database unavailable."});
      const device=(await pool.query("SELECT device_id FROM dgm_bridge_devices WHERE device_id=$1 AND role='host'",[auth.sub])).rows[0];
      if (!device) return res.status(404).json({success:false,message:"Host device not registered."});
      await pool.query("DELETE FROM dgm_bridge_pairings WHERE expires_at<NOW()");
      const code=randomCode(), secret=randomSecret(), sessionId=crypto.randomUUID();
      await pool.query(
        "INSERT INTO dgm_bridge_pairings(code,secret_hash,host_device_id,expires_at,session_id) VALUES($1,$2,$3,NOW()+INTERVAL '5 minutes',$4)",
        [code,hmac("pair:"+secret),auth.sub,sessionId]
      );
      const hostRelayToken=token({sid:sessionId,host:auth.sub,exp:Date.now()+12*60*60*1000});
      res.json({
        success:true,
        expires_in:300,
        pairing:{code,secret,session_id:sessionId,host_relay_token:hostRelayToken,qr_payload:`DGM-BRIDGE|1|${code}|${secret}`}
      });
    } catch(e) {
      console.error("Bridge pair create:",e.message);
      res.status(500).json({success:false,message:"Could not create pairing."});
    }
  });

  app.get("/api/admin/bridge/devices", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      if (!pool) return res.status(503).json({success:false,message:"Database unavailable."});
      const devices = await pool.query(
        `SELECT d.device_id,d.role,d.country,d.status,d.approval_status,d.approved_at,d.approved_by,d.last_seen,d.created_at,
                EXISTS(
                  SELECT 1 FROM dgm_bridge_pairings p
                  WHERE p.host_device_id=d.device_id
                    AND p.expires_at>NOW()
                    AND p.claimed_by IS NOT NULL
                ) AS paired
         FROM dgm_bridge_devices d
         ORDER BY d.last_seen DESC NULLS LAST,d.created_at DESC`
      );
      const pairings = await pool.query(
        `SELECT p.code,p.host_device_id,p.expires_at,p.claimed_by,p.claimed_at,p.session_id,
                CASE WHEN p.expires_at<=NOW() THEN 'expired'
                     WHEN p.claimed_by IS NOT NULL THEN 'claimed'
                     ELSE 'waiting' END AS state
         FROM dgm_bridge_pairings p
         ORDER BY p.created_at DESC LIMIT 100`
      );
      return res.json({success:true,devices:devices.rows,pairings:pairings.rows});
    } catch(e) {
      console.error("Admin Bridge devices error:",e.message);
      return res.status(500).json({success:false,message:"Could not load DGM Bridge devices."});
    }
  });

  app.post("/api/bridge/pair/claim", async (req,res) => {
    try {
      const auth=verifyToken(req.get("authorization")?.replace(/^Bearer\s+/i,""));
      if (!auth || auth.role!=="client") return res.status(401).json({success:false,message:"Client authentication required."});
      const approved=(await pool.query("SELECT approval_status FROM dgm_bridge_devices WHERE device_id=$1",[auth.sub])).rows[0];
      if(!approved || approved.approval_status!=="approved") return res.status(403).json({success:false,message:"Client device is not authorized by DGM Admin."});
      if (!pool) return res.status(503).json({success:false,message:"Database unavailable."});
      const code=String(req.body?.code||"").trim();
      const secret=String(req.body?.secret||"").trim();
      if (!/^\d{6}$/.test(code) || secret.length<20) return res.status(400).json({success:false,message:"Invalid pairing payload."});
      const row=(await pool.query("SELECT * FROM dgm_bridge_pairings WHERE code=$1 AND expires_at>NOW()",[code])).rows[0];
      if (!row) return res.status(404).json({success:false,message:"Pairing code expired or not found."});
      if (row.claimed_by) return res.status(409).json({success:false,message:"Pairing code has already been used."});
      if (!crypto.timingSafeEqual(Buffer.from(row.secret_hash),Buffer.from(hmac("pair:"+secret)))) return res.status(403).json({success:false,message:"Pairing secret is invalid."});
      await pool.query("UPDATE dgm_bridge_pairings SET claimed_by=$1,claimed_at=NOW() WHERE code=$2",[auth.sub,code]);
      const sessionToken=token({sid:row.session_id,host:row.host_device_id,client:auth.sub,exp:Date.now()+12*60*60*1000});
      res.json({success:true,session_id:row.session_id,session_token:sessionToken,host_device_id:row.host_device_id});
    } catch(e) {
      console.error("Bridge pair claim:",e.message);
      res.status(500).json({success:false,message:"Could not claim pairing."});
    }
  });

  app.post("/api/bridge/heartbeat", async (req,res) => {
    try {
      const auth=verifyToken(req.get("authorization")?.replace(/^Bearer\s+/i,""));
      if (!auth) return res.status(401).json({success:false,message:"Authentication required."});
      if (pool) await pool.query("UPDATE dgm_bridge_devices SET status='online',last_seen=NOW() WHERE device_id=$1",[auth.sub]);
      res.json({success:true,online:true,timestamp:new Date().toISOString()});
    } catch(e) { res.status(500).json({success:false,message:"Heartbeat failed."}); }
  });

  const originalListen = app.listen;
  if (app.__dgmBridgeListenPatched) return;
  app.__dgmBridgeListenPatched=true;
  app.listen = function(...args) {
    installBridge(this);
    initBridgeDatabase().catch((e)=>console.error("DGM Bridge database init:",e.message));
    const server=originalListen.apply(this,args);
    const wss=new WebSocketServer({server,path:"/api/bridge/relay",maxPayload:2*1024*1024});
    const sessions=new Map();
    wss.on("connection",(ws,req)=>{
      try {
        const url=new URL(req.url,"http://bridge.local");
        const relayToken=verifyToken(url.searchParams.get("token"));
        const role=url.searchParams.get("role");
        if(!relayToken || !relayToken.sid || !["host","client"].includes(role)) return ws.close(1008,"unauthorized");
        if ((role==="host" && relayToken.host===undefined) || (role==="client" && relayToken.client===undefined)) return ws.close(1008,"unauthorized");
        const sid=relayToken.sid;
        let state=sessions.get(sid);
        if(!state){state={};sessions.set(sid,state);}
        if(state[role]) return ws.close(1008,"duplicate role");
        state[role]=ws;
        ws.on("message",(data,isBinary)=>{
          const peer=state[role==="host"?"client":"host"];
          if(peer && peer.readyState===1) peer.send(data,{binary:isBinary});
        });
        ws.on("close",()=>{ if(state[role]===ws) delete state[role]; if(!state.host&&!state.client)sessions.delete(sid); });
        ws.send(JSON.stringify({type:"ready",role,session_id:sid}));
        const peer=state[role==="host"?"client":"host"];
        if(peer && peer.readyState===1){
          peer.send(JSON.stringify({type:"peer_ready",session_id:sid}));
          ws.send(JSON.stringify({type:"peer_ready",session_id:sid}));
        }
      } catch { ws.close(1011,"relay error"); }
    });
    return server;
  };
}

installBridge.__init=initBridgeDatabase;
module.exports={installBridge,initBridgeDatabase};
