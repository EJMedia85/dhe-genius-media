const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");
const { WebSocketServer } = require("ws");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false })
  : null;

let bridgeDbReady = null;

const BRIDGE_SECRET = String(process.env.DGM_BRIDGE_SECRET || process.env.SESSION_SECRET || "").trim();
if (process.env.NODE_ENV === "production" && BRIDGE_SECRET.length < 32) {
  console.warn("DGM Bridge: DGM_BRIDGE_SECRET is missing/short; using SESSION_SECRET fallback. Set DGM_BRIDGE_SECRET to a dedicated 32+ character secret for production.");
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
function bridgePin() {
  return crypto.randomInt(100000, 1000000).toString();
}
function pinKey() {
  return crypto.createHash("sha256").update(BRIDGE_SECRET || "development-only-bridge-secret").digest();
}
function encryptPin(pin) {
  const iv=crypto.randomBytes(12), cipher=crypto.createCipheriv("aes-256-gcm",pinKey(),iv);
  const enc=Buffer.concat([cipher.update(String(pin),"utf8"),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),enc]).toString("base64url");
}
function decryptPin(value) {
  try { const b=Buffer.from(String(value),"base64url"); const iv=b.subarray(0,12), tag=b.subarray(12,28), data=b.subarray(28); const decipher=crypto.createDecipheriv("aes-256-gcm",pinKey(),iv); decipher.setAuthTag(tag); return Buffer.concat([decipher.update(data),decipher.final()]).toString("utf8"); } catch { return ""; }
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
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dgm_bridge_pairings (
      code TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      host_device_id TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      claimed_by TEXT,
      claimed_at TIMESTAMPTZ,
      session_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const columns = [
    ["approval_status", "TEXT NOT NULL DEFAULT 'pending'"],
    ["approved_at", "TIMESTAMPTZ"],
    ["approved_by", "TEXT"],
    ["device_name", "TEXT"],
    ["app_version", "TEXT"],
    ["platform", "TEXT DEFAULT 'Android'"],
    ["last_error", "TEXT"],
    ["pin_ciphertext", "TEXT"],
    ["active_session_id", "TEXT"],
    ["active_token_hash", "TEXT"]
  ];
  for (const [name, definition] of columns) {
    await pool.query('ALTER TABLE dgm_bridge_devices ADD COLUMN IF NOT EXISTS ' + name + ' ' + definition);
  }

  await pool.query('CREATE INDEX IF NOT EXISTS dgm_bridge_pairings_expiry_idx ON dgm_bridge_pairings(expires_at)');
  await pool.query('CREATE INDEX IF NOT EXISTS dgm_bridge_devices_status_idx ON dgm_bridge_devices(approval_status,status)');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dgm_bridge_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(
    'INSERT INTO dgm_bridge_config(key,value) VALUES($1,$2),($3,$4),($5,$6) ON CONFLICT(key) DO NOTHING',
    [
      'latest_version', String(process.env.DGM_BRIDGE_LATEST_VERSION || '1.1.2').trim(),
      'minimum_version', String(process.env.DGM_BRIDGE_MIN_VERSION || '1.1.0').trim(),
      'update_url', String(process.env.DGM_BRIDGE_UPDATE_URL || '').trim()
    ]
  );
}

async function bridgeAudit(adminEmail, action, targetId, details = {}) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO admin_audit_log(admin_email,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5::jsonb)',
      [adminEmail || "admin", action, "bridge_device", targetId || null, JSON.stringify(details)]
    );
  } catch (e) { console.error("Bridge audit:", e.message); }
}

async function bridgeConfig(key, fallback = "") {
  if (!pool) return fallback;
  try {
    const row = (await pool.query("SELECT value FROM dgm_bridge_config WHERE key=$1", [key])).rows[0];
    return row ? row.value : fallback;
  } catch { return fallback; }
}

function bridgeVersionNeedsUpdate(current, minimum) {
  const a=String(current||"0").split(".").map(x=>parseInt(x,10)||0);
  const b=String(minimum||"0").split(".").map(x=>parseInt(x,10)||0);
  for(let i=0;i<Math.max(a.length,b.length);i++){if((a[i]||0)<(b[i]||0))return true;if((a[i]||0)>(b[i]||0))return false;}
  return false;
}

function installBridge(app) {
  if (!bridgeDbReady) bridgeDbReady = initBridgeDatabase();
  app.use(async (req,res,next) => {
    try { await bridgeDbReady; next(); }
    catch (e) { console.error("DGM Bridge database initialization:", e.message); res.status(503).json({success:false,message:"DGM Bridge database is still initializing. Please try again in a few seconds."}); }
  });
  app.use(express.json({ limit: "32kb" }));

  app.get("/api/bridge/status", async (req, res) => {
    res.json({ success:true, service:"DGM Bridge", protocol:"relay-v1", configured:Boolean(pool && BRIDGE_SECRET), timestamp:new Date().toISOString() });
  });

  app.get("/api/bridge/registration-status", async (req,res) => {
    try {
      if (!pool) return res.status(503).json({success:false,message:"Database unavailable."});
      const deviceId=String(req.query.device_id||"").trim();
      if(!deviceId) return res.status(400).json({success:false,message:"device_id is required."});
      const row=(await pool.query(`SELECT device_id,role,approval_status,status,approved_at,app_version FROM dgm_bridge_devices WHERE device_id=$1`,[deviceId])).rows[0];
      if(!row) return res.status(404).json({success:false,message:"Device registration not found."});
      if(row.role === "host" && !req.session?.adminAuthenticated) return res.status(403).json({success:false,message:"Host Bridge status is restricted to DGM Admin."});
      if(row.approval_status==="approved" && !["revoked","suspended"].includes(row.status)){
        const minimum=await bridgeConfig("minimum_version",String(process.env.DGM_BRIDGE_MIN_VERSION || "1.1.0"));
        return res.json({success:true,device_id:row.device_id,role:row.role,approval_status:"approved",status:"authorized",update_required:bridgeVersionNeedsUpdate(row.app_version,minimum)});
      }
      return res.json({success:true,device_id:row.device_id,role:row.role,approval_status:row.approval_status,status:row.status,approved_at:row.approved_at||null,message:row.approval_status==="denied"?"Registration denied by DGM Admin.":"Waiting for DGM Admin authorization."});
    } catch(e){ console.error("Bridge registration status:",e.message); return res.status(500).json({success:false,message:"Could not check registration status: "+String(e.message||"server error").slice(0,180)}); }
  });

  app.get("/api/admin/bridge/registrations", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const rows=(await pool.query(`SELECT device_id,role,country,device_name,app_version,platform,status,approval_status,approved_at,approved_by,last_seen,last_error,created_at,pin_ciphertext FROM dgm_bridge_devices ORDER BY CASE approval_status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,created_at DESC`)).rows;
      return res.json({success:true,registrations:rows});
    } catch(e){ return res.status(500).json({success:false,message:"Could not load registrations."}); }
  });

  app.post("/api/admin/bridge/registrations/:deviceId/approve", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const id=String(req.params.deviceId||"").trim();
      const row=(await pool.query(`UPDATE dgm_bridge_devices SET approval_status='approved',status='authorized',approved_at=NOW(),approved_by=$2,active_session_id=NULL,active_token_hash=NULL WHERE device_id=$1 RETURNING device_id,role,approval_status,status,approved_at,approved_by`,[id,req.session.adminEmail||"admin"])).rows[0];
      if(!row) return res.status(404).json({success:false,message:"Device registration not found."});
      await bridgeAudit(req.session.adminEmail,"bridge.approve",id,{role:row.role});
      return res.json({success:true,registration:row});
    } catch(e){ console.error("Bridge approve:",e.message); return res.status(500).json({success:false,message:"Could not authorize device."}); }
  });

  app.post("/api/admin/bridge/registrations/:deviceId/deny", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const id=String(req.params.deviceId||"").trim();
      const row=(await pool.query(`UPDATE dgm_bridge_devices SET approval_status='denied',status='denied',approved_at=NULL,approved_by=$2,active_session_id=NULL,active_token_hash=NULL WHERE device_id=$1 RETURNING device_id,approval_status,status`,[id,req.session.adminEmail||"admin"])).rows[0];
      if(!row) return res.status(404).json({success:false,message:"Device registration not found."});
      await bridgeAudit(req.session.adminEmail,"bridge.deny",id);
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
      const deviceName=String(req.body?.device_name||"DGM Bridge").trim().slice(0,120);
      const appVersion=String(req.body?.app_version||"").trim().slice(0,40);
      const platform=String(req.body?.platform||"Android").trim().slice(0,40);
      const pin=String(req.body?.pin||"").trim();
      if (!deviceId || !publicKey || !["host","client"].includes(role)) return res.status(400).json({success:false,message:"device_id, role and public_key are required."});
      if (role === "host" && !req.session?.adminAuthenticated) return res.status(403).json({success:false,message:"Host Bridge is restricted to DGM Admin. Please sign in as Admin first."});
      if (!/^\d{6}$/.test(pin)) return res.status(400).json({success:false,message:"A 6-digit Bridge PIN is required."});
      await pool.query(
        `INSERT INTO dgm_bridge_devices(device_id,role,public_key,country,device_name,app_version,platform,pin_ciphertext,status,approval_status,last_seen)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending','pending',NOW())
         ON CONFLICT(device_id) DO UPDATE SET role=EXCLUDED.role,public_key=EXCLUDED.public_key,country=EXCLUDED.country,device_name=EXCLUDED.device_name,app_version=EXCLUDED.app_version,platform=EXCLUDED.platform,pin_ciphertext=EXCLUDED.pin_ciphertext,last_seen=NOW()
         WHERE dgm_bridge_devices.status <> 'revoked'`,
        [deviceId,role,publicKey,country,deviceName,appVersion,platform,encryptPin(pin)]
      );
      const row=(await pool.query(`SELECT device_id,role,approval_status,status FROM dgm_bridge_devices WHERE device_id=$1`,[deviceId])).rows[0];
      if(row.approval_status!=="approved") {
        return res.json({success:true,device_id:deviceId,role:row.role,approval_status:row.approval_status,status:"pending",message:"Registration received. Waiting for DGM Admin authorization."});
      }
      const issued=token({sub:deviceId,role,exp:Date.now()+24*60*60*1000});
      await pool.query(`UPDATE dgm_bridge_devices SET status='online',last_seen=NOW() WHERE device_id=$1`,[deviceId]);
      res.json({success:true,device_id:deviceId,role,approval_status:"approved",status:"authorized",token:issued});
    } catch(e) {
      console.error("Bridge register:",e);
      res.status(500).json({success:false,message:"Could not register bridge device: "+String(e.message||"server error").slice(0,180)});
    }
  });

  app.post("/api/bridge/connect", async (req,res) => {
    try {
      if (!pool) return res.status(503).json({success:false,message:"Database unavailable."});
      const deviceId=String(req.body?.device_id||"").trim(), pin=String(req.body?.pin||"").trim();
      if (!deviceId || !/^\d{6}$/.test(pin)) return res.status(400).json({success:false,message:"Device ID and 6-digit PIN are required."});
      const row=(await pool.query("SELECT device_id,role,approval_status,status,pin_ciphertext FROM dgm_bridge_devices WHERE device_id=$1",[deviceId])).rows[0];
      if(!row) return res.status(404).json({success:false,message:"Bridge device is not registered."});
      if(row.role === "host" && !req.session?.adminAuthenticated) return res.status(403).json({success:false,message:"Host Bridge access is restricted to DGM Admin."});
      if(row.approval_status!=="approved" || ["revoked","suspended"].includes(row.status)) return res.status(403).json({success:false,message:"Bridge is not authorized by DGM Admin."});
      const stored=decryptPin(row.pin_ciphertext);
      if(!stored || !crypto.timingSafeEqual(Buffer.from(stored),Buffer.from(pin))) return res.status(401).json({success:false,message:"Incorrect Bridge PIN."});
      const issued=token({sub:row.device_id,role:row.role,sid:crypto.randomUUID(),exp:Date.now()+24*60*60*1000});
      const sid=JSON.parse(Buffer.from(issued.split(".")[0],"base64url").toString("utf8")).sid;
      await pool.query("UPDATE dgm_bridge_devices SET status='online',last_seen=NOW(),last_error=NULL,active_session_id=$2,active_token_hash=$3 WHERE device_id=$1",[deviceId,sid,hmac("session:"+issued)]);
      res.json({success:true,device_id:row.device_id,role:row.role,status:"authorized",token:issued});
    } catch(e){ console.error("Bridge connect:",e.message); res.status(500).json({success:false,message:"Could not connect Bridge."}); }
  });

  app.post("/api/admin/bridge/devices/:deviceId/reset-pin", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const id=String(req.params.deviceId||"").trim(), supplied=String(req.body?.pin||"").trim(), pin=/^\d{6}$/.test(supplied)?supplied:bridgePin();
      const row=(await pool.query("UPDATE dgm_bridge_devices SET pin_ciphertext=$2,active_session_id=NULL,active_token_hash=NULL WHERE device_id=$1 RETURNING device_id,device_name",[id,encryptPin(pin)])).rows[0];
      if(!row)return res.status(404).json({success:false,message:"Device not found."});
      await bridgeAudit(req.session.adminEmail,"bridge.reset_pin",id,{device_name:row.device_name});
      res.json({success:true,device_id:id,pin});
    } catch(e){ console.error("Bridge reset PIN:",e.message); res.status(500).json({success:false,message:"Could not reset Bridge PIN."}); }
  });

  app.get("/api/bridge/update-policy", async (req,res) => {
    res.json({
      success:true,
      latest_version:await bridgeConfig("latest_version",String(process.env.DGM_BRIDGE_LATEST_VERSION || "1.1.2")),
      minimum_version:await bridgeConfig("minimum_version",String(process.env.DGM_BRIDGE_MIN_VERSION || "1.1.0")),
      update_url:await bridgeConfig("update_url",String(process.env.DGM_BRIDGE_UPDATE_URL || ""))
    });
  });

  app.get("/api/admin/bridge/stats", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    try {
      const r=(await pool.query(`SELECT COUNT(*)::int AS total,
        COUNT(*) FILTER(WHERE approval_status='pending')::int AS pending,
        COUNT(*) FILTER(WHERE approval_status='approved')::int AS approved,
        COUNT(*) FILTER(WHERE status='online')::int AS online,
        COUNT(*) FILTER(WHERE status='offline')::int AS offline,
        COUNT(*) FILTER(WHERE status='suspended')::int AS suspended,
        COUNT(*) FILTER(WHERE status='revoked')::int AS revoked
        FROM dgm_bridge_devices`)).rows[0];
      res.json({success:true,stats:r});
    } catch(e){res.status(500).json({success:false,message:"Could not load Bridge statistics."});}
  });

  app.post("/api/admin/bridge/devices/:deviceId/action", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    const id=String(req.params.deviceId||"").trim();
    const action=String(req.body?.action||"").trim();
    const map={suspend:["suspended","approved"],resume:["offline","approved"],revoke:["revoked","denied"],offline:["offline","approved"]};
    if(!map[action]) return res.status(400).json({success:false,message:"Unsupported device action."});
    try {
      const row=(await pool.query(`UPDATE dgm_bridge_devices SET status=$2,approval_status=$3,active_session_id=NULL,active_token_hash=NULL WHERE device_id=$1 RETURNING device_id,status,approval_status`,[id,map[action][0],map[action][1]])).rows[0];
      if(!row)return res.status(404).json({success:false,message:"Device not found."});
      await bridgeAudit(req.session.adminEmail,"bridge."+action,id,{status:row.status,approval_status:row.approval_status});
      res.json({success:true,device:row});
    } catch(e){res.status(500).json({success:false,message:"Could not update device."});}
  });

  app.post("/api/admin/bridge/devices/:deviceId/rename", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    const id=String(req.params.deviceId||"").trim(), name=String(req.body?.device_name||"").trim().slice(0,120);
    if(!name)return res.status(400).json({success:false,message:"Device name is required."});
    try {
      const row=(await pool.query(`UPDATE dgm_bridge_devices SET device_name=$2 WHERE device_id=$1 RETURNING device_id,device_name`,[id,name])).rows[0];
      if(!row)return res.status(404).json({success:false,message:"Device not found."});
      await bridgeAudit(req.session.adminEmail,"bridge.rename",id,{device_name:name});
      res.json({success:true,device:row});
    } catch(e){res.status(500).json({success:false,message:"Could not rename device."});}
  });

  app.get("/api/admin/bridge/config", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    res.json({success:true,config:{
      latest_version:await bridgeConfig("latest_version",String(process.env.DGM_BRIDGE_LATEST_VERSION || "1.1.2")),
      minimum_version:await bridgeConfig("minimum_version",String(process.env.DGM_BRIDGE_MIN_VERSION || "1.1.0")),
      update_url:await bridgeConfig("update_url",String(process.env.DGM_BRIDGE_UPDATE_URL || ""))
    }});
  });

  app.post("/api/admin/bridge/config", async (req,res) => {
    if (!req.session?.adminAuthenticated) return res.status(401).json({success:false,message:"Admin authentication required."});
    const values={
      latest_version:String(req.body?.latest_version||"").trim().slice(0,40),
      minimum_version:String(req.body?.minimum_version||"").trim().slice(0,40),
      update_url:String(req.body?.update_url||"").trim().slice(0,500)
    };
    if(!values.latest_version||!values.minimum_version)return res.status(400).json({success:false,message:"Latest and minimum versions are required."});
    try {
      for(const [key,value] of Object.entries(values)){
        await pool.query(`INSERT INTO dgm_bridge_config(key,value) VALUES($1,$2)
          ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[key,value]);
      }
      await bridgeAudit(req.session.adminEmail,"bridge.update_policy",null,values);
      res.json({success:true,config:values});
    } catch(e){res.status(500).json({success:false,message:"Could not update Bridge version policy."});}
  });

  app.post("/api/bridge/diagnostic", async (req,res) => {
    try {
      const rawToken=req.get("authorization")?.replace(/^Bearer\s+/i,"");
      const auth=verifyToken(rawToken);
      if(!auth||!pool)return res.status(401).json({success:false,message:"Authentication required."});
      const session=(await pool.query("SELECT active_session_id,active_token_hash FROM dgm_bridge_devices WHERE device_id=$1",[auth.sub])).rows[0];
      if(!session || !auth.sid || session.active_session_id!==auth.sid || session.active_token_hash!==hmac("session:"+rawToken)) return res.status(401).json({success:false,message:"Bridge session is no longer active on this device."});
      const error=String(req.body?.error||"").trim().slice(0,500);
      await pool.query("UPDATE dgm_bridge_devices SET last_error=$2,last_seen=NOW() WHERE device_id=$1",[auth.sub,error||null]);
      res.json({success:true});
    } catch(e){res.status(500).json({success:false,message:"Diagnostic update failed."});}
  });

  app.post("/api/bridge/pair/create", async (req,res) => {
    try {
      const rawToken=req.get("authorization")?.replace(/^Bearer\s+/i,"");
      const auth=verifyToken(rawToken);
      if (!auth || auth.role!=="host") return res.status(401).json({success:false,message:"Host authentication required."});
      const approved=(await pool.query("SELECT approval_status,status,active_session_id,active_token_hash FROM dgm_bridge_devices WHERE device_id=$1",[auth.sub])).rows[0];
      if(!approved || approved.active_session_id!==auth.sid || approved.active_token_hash!==hmac("session:"+rawToken)) return res.status(401).json({success:false,message:"Bridge session is no longer active on this device."});
      if(!approved || approved.approval_status!=="approved" || ["revoked","suspended"].includes(approved.status)) return res.status(403).json({success:false,message:"Host device is not authorized by DGM Admin."});
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
        `SELECT d.device_id,d.role,d.country,d.device_name,d.app_version,d.platform,d.status,d.approval_status,d.approved_at,d.approved_by,d.last_seen,d.last_error,d.created_at,
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
      return res.json({success:true,devices:devices.rows.map(x=>({...x,pin:x.pin_ciphertext?decryptPin(x.pin_ciphertext):""})),pairings:pairings.rows});
    } catch(e) {
      console.error("Admin Bridge devices error:",e.message);
      return res.status(500).json({success:false,message:"Could not load DGM Bridge devices."});
    }
  });

  app.post("/api/bridge/pair/claim", async (req,res) => {
    try {
      const rawToken=req.get("authorization")?.replace(/^Bearer\s+/i,"");
      const auth=verifyToken(rawToken);
      if (!auth || auth.role!=="client") return res.status(401).json({success:false,message:"Client authentication required."});
      const approved=(await pool.query("SELECT approval_status,status,active_session_id,active_token_hash FROM dgm_bridge_devices WHERE device_id=$1",[auth.sub])).rows[0];
      if(!approved || approved.active_session_id!==auth.sid || approved.active_token_hash!==hmac("session:"+rawToken)) return res.status(401).json({success:false,message:"Bridge session is no longer active on this device."});
      if(!approved || approved.approval_status!=="approved" || ["revoked","suspended"].includes(approved.status)) return res.status(403).json({success:false,message:"Client device is not authorized by DGM Admin."});
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
      const rawToken=req.get("authorization")?.replace(/^Bearer\s+/i,"");
      const auth=verifyToken(rawToken);
      if (!auth) return res.status(401).json({success:false,message:"Authentication required."});
      const row=pool ? (await pool.query("SELECT approval_status,status,active_session_id,active_token_hash FROM dgm_bridge_devices WHERE device_id=$1",[auth.sub])).rows[0] : null;
      if(!row || row.active_session_id!==auth.sid || row.active_token_hash!==hmac("session:"+rawToken)) return res.status(401).json({success:false,message:"Bridge session is no longer active on this device."});
      if(!row || row.approval_status!=="approved" || ["revoked","suspended"].includes(row.status)) return res.status(403).json({success:false,message:"Device is not authorized."});
      if (pool) await pool.query("UPDATE dgm_bridge_devices SET status='online',last_seen=NOW(),last_error=NULL WHERE device_id=$1",[auth.sub]);
      res.json({success:true,online:true,timestamp:new Date().toISOString()});
    } catch(e) { res.status(500).json({success:false,message:"Heartbeat failed."}); }
  });

  const originalListen = app.listen;
  if (app.__dgmBridgeListenPatched) return;
  app.__dgmBridgeListenPatched=true;
  app.listen = function(...args) {
    installBridge(this);
    bridgeDbReady.catch((e)=>console.error("DGM Bridge database init:",e.message));
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
