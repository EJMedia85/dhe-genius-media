const bcrypt=require("bcryptjs");
const P={
"dashboard.view":"View dashboard","customers.view":"View customers","customers.balance":"Adjust customer wallets","customers.delete":"Delete customers","orders.view":"View orders","wallet.view":"View wallet & withdrawals","wallet.withdrawals":"Approve/reject/pay withdrawals","agents.manage":"Manage agents","analytics.view":"View analytics","services.manage":"Manage services/providers","market.manage":"Manage DGM Market","social.manage":"Manage social boosting","savings.manage":"Manage Savings/Susu","companion.manage":"Manage DGM Companion","bridge.manage":"Manage DGM Bridge","devices.manage":"Manage devices","marketing.manage":"Manage marketing","notifications.manage":"Manage notifications","support.manage":"Manage support","security.audit":"View security/audit logs","system.view":"View system health","staff.manage":"Manage DGM staff & permissions"};
const R={
support:["Customer Support",["dashboard.view","customers.view","orders.view","support.manage","notifications.manage"]],
finance:["Finance",["dashboard.view","customers.view","orders.view","wallet.view","wallet.withdrawals","analytics.view"]],
operations:["Operations",["dashboard.view","customers.view","orders.view","agents.manage","services.manage","companion.manage","bridge.manage","devices.manage","analytics.view"]],
manager:["Business Manager",Object.keys(P).filter(x=>!["staff.manage","customers.delete","customers.balance","security.audit"].includes(x))]
};
const PAGE_PERMISSIONS={overview:"dashboard.view",customers:"customers.view",orders:"orders.view",wallet:"wallet.view",agents:"agents.manage",analytics:"analytics.view",services:"services.manage",market:"market.manage",bwm:"social.manage",savings:"savings.manage",companion:"companion.manage",bridge:"bridge.manage",devices:"devices.manage",marketing:"marketing.manage",notifications:"notifications.manage",support:"support.manage",security:"security.audit",system:"system.view",staff:"staff.manage"};
const staffLoginAttempts=new Map();
// Every Staff Workspace API capability is mapped here to the same permission
// catalog that the Super Admin edits. A route may intentionally accept more
// than one permission when two dashboard areas share the same underlying API.
const MAP=[
[/^\/stats$/,["dashboard.view"]],[/^\/analytics/,["analytics.view"]],[/^\/orders/,["orders.view"]],
[/^\/customers\/\d+\/balance$/,["customers.balance"]],[/^\/customers\/\d+$/,["customers.delete"]],[/^\/customers/,["customers.view"]],
[/^\/withdrawals\/\d+\/(approve|reject|paid)$/,["wallet.withdrawals"]],[/^\/withdrawals/,["wallet.view"]],
[/^\/agents/,["agents.manage"]],[/^\/services/,["services.manage"]],[/^\/market/,["market.manage"]],[/^\/bwm/,["social.manage"]],
[/^\/savings/,["savings.manage"]],[/^\/companion/,["companion.manage"]],[/^\/bridge/,["bridge.manage"]],[/^\/devices/,["devices.manage"]],
[/^\/marketing/,["marketing.manage"]],[/^\/notifications/,["notifications.manage"]],[/^\/support/,["support.manage"]],
[/^\/audit$/,["security.audit"]],[/^\/system$/,["system.view","services.manage"]],[/^\/staff/,["staff.manage"]]
];
async function audit(pool,req,action,target_type,target_id,details={}){try{await pool.query("INSERT INTO admin_audit_log(admin_email,action,target_type,target_id,details) VALUES($1,$2,$3,$4,$5::jsonb)",[req.session?.staffEmail||req.session?.adminEmail||"unknown",action,target_type,String(target_id||""),JSON.stringify({actor_type:req.session?.staffId?"staff":"super_admin",actor_id:req.session?.staffId||null,...details})]);}catch(e){console.error("staff audit:",e.message);}}
async function perms(pool,id){
 const r=await pool.query("SELECT permissions FROM staff_users WHERE id=$1 AND active=TRUE",[id]);
 const raw=r.rows[0]?.permissions; let list=[];
 if(Array.isArray(raw)) list=raw;
 else if(typeof raw==="string"){try{const v=JSON.parse(raw);if(Array.isArray(v))list=v;}catch(_){list=raw.split(",").map(x=>x.trim()).filter(Boolean);}}
 return new Set(list.map(String));
}
function installStaff(app,pool){
const staffReady=pool.query("CREATE TABLE IF NOT EXISTS staff_users(id SERIAL PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password_hash TEXT NOT NULL,role_key TEXT NOT NULL,permissions JSONB NOT NULL DEFAULT '[]',active BOOLEAN NOT NULL DEFAULT TRUE,last_login_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
app.use("/api/admin",async(req,res,next)=>{
if(!req.session?.staffId)return next();
await staffReady;const p=req.path||"/";if(["/me","/logout","/staff/me","/staff/logout","/staff/login"].includes(p))return next();
const m=MAP.find(x=>x[0].test(p));if(!m){await audit(pool,req,"authorization_denied","route",p);return res.status(403).json({success:false,message:"Staff permission required."});}
const s=await perms(pool,req.session.staffId);const required=m[1];if(!required.some(permission=>s.has(permission))){await audit(pool,req,"authorization_denied","permission",required.join(" OR "),{route:p});return res.status(403).json({success:false,message:"You do not have permission for this function."});}next();
});
app.post("/api/admin/staff/login",async(req,res)=>{try{const key=String(req.ip||req.socket?.remoteAddress||"unknown");const now=Date.now(),a=staffLoginAttempts.get(key)||{count:0,resetAt:now+15*60*1000};if(now>a.resetAt){a.count=0;a.resetAt=now+15*60*1000;}if(a.count>=10)return res.status(429).json({success:false,message:"Too many staff login attempts. Please wait 15 minutes."});a.count++;staffLoginAttempts.set(key,a);await staffReady;const email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||"");const r=await pool.query("SELECT * FROM staff_users WHERE email=$1 LIMIT 1",[email]);if(!r.rows.length||!r.rows[0].active||!await bcrypt.compare(password,r.rows[0].password_hash))return res.status(401).json({success:false,message:"Invalid staff login details."});staffLoginAttempts.delete(key);const s=r.rows[0];await new Promise((ok,no)=>req.session.regenerate(e=>e?no(e):ok()));Object.assign(req.session,{adminAuthenticated:true,staffId:s.id,staffEmail:s.email,staffName:s.name,staffRole:s.role_key,staffPermissions:s.permissions,adminEmail:s.email,adminLoginAt:new Date().toISOString()});await pool.query("UPDATE staff_users SET last_login_at=NOW(),updated_at=NOW() WHERE id=$1",[s.id]);await audit(pool,req,"staff_login","staff",s.id,{role:s.role_key});await new Promise((ok,no)=>req.session.save(e=>e?no(e):ok()));res.json({success:true,staff:{id:s.id,name:s.name,email:s.email,role:s.role_key,permissions:s.permissions}});}catch(e){console.error(e);res.status(500).json({success:false,message:"Staff login failed."});}});
app.get("/api/admin/staff/me",async(req,res)=>{
  if(!req.session?.staffId)return res.status(401).json({success:false,message:"Staff authentication required."});
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");
  try{
    // Read the authoritative permission set directly from staff_users.
    // Do not depend on the table-initialization promise here: a previously
    // created staff account must be able to authenticate even if initialization
    // is still resolving elsewhere in the process.
    const sessionPermissions=Array.isArray(req.session.staffPermissions)
      ? req.session.staffPermissions.map(String)
      : (typeof req.session.staffPermissions==="string" ? req.session.staffPermissions.split(",").map(x=>x.trim()).filter(Boolean) : []);
    const fallback={
      id:req.session.staffId,
      name:req.session.staffName||"Staff",
      email:req.session.staffEmail||"",
      role_key:req.session.staffRole||"staff",
      permissions:sessionPermissions,
      page_permissions:PAGE_PERMISSIONS,
      permission_catalog:P,
      permissions_updated_at:null,
      active:true,
      last_login_at:null,
      created_at:null
    };
    // Do not let a slow database connection leave the Staff Workspace stuck
    // on "Verifying staff session". The session is already authenticated; use
    // its permission snapshot immediately if the authoritative lookup is slow.
    let lookup;
    try{
      lookup=await Promise.race([
        pool.query("SELECT id,name,email,role_key,permissions,active,last_login_at,created_at,updated_at FROM staff_users WHERE id=$1 LIMIT 1",[req.session.staffId]),
        new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error("Staff permission lookup timed out"),{code:"STAFF_LOOKUP_TIMEOUT"})),2500))
      ]);
    }catch(e){
      if(e.code==="STAFF_LOOKUP_TIMEOUT"){
        return res.json({success:true,staff:fallback,source:"session-fallback"});
      }
      throw e;
    }
    if(!lookup.rows.length)return res.status(401).json({success:false,message:"Staff account no longer exists."});
    const s=lookup.rows[0];
    if(!s.active)return res.status(401).json({success:false,message:"Staff account is inactive."});
    const permissions=Array.isArray(s.permissions)
      ? s.permissions.map(String)
      : (typeof s.permissions==="string" ? (()=>{try{const v=JSON.parse(s.permissions);return Array.isArray(v)?v.map(String):[];}catch(_){return [];}})() : []);
    return res.json({
      success:true,
      staff:{
        id:s.id,name:s.name,email:s.email,role_key:s.role_key,
        permissions,
        page_permissions:PAGE_PERMISSIONS,
        permission_catalog:P,
        permissions_updated_at:s.updated_at || null,
        active:Boolean(s.active),
        last_login_at:s.last_login_at,
        created_at:s.created_at
      }
    });
  }catch(e){
    console.error("Staff session check error:",e);
    return res.status(503).json({success:false,message:"Staff session could not be verified. Please try again."});
  }
});
app.post("/api/admin/staff/logout",(req,res)=>{
  // Expire the browser session cookie immediately. Even if the PostgreSQL
  // session store is temporarily unavailable, the staff browser session
  // cannot continue using the old cookie.
  res.clearCookie("dgm.sid",{
    httpOnly:true,
    secure:process.env.NODE_ENV==="production",
    sameSite:"lax",
    path:"/",
    expires:new Date(0)
  });
  res.setHeader("Cache-Control","no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma","no-cache");

  if(!req.session)return res.json({success:true});

  req.session.destroy(e=>{
    if(e)console.error("Staff logout session cleanup error:",e);
    return res.json({success:true});
  });
});
const superOnly=(req,res,next)=>{if(!req.session?.adminAuthenticated)return res.status(401).json({success:false,message:"Admin authentication required."});if(req.session?.staffId)return res.status(403).json({success:false,message:"Only the Super Admin can manage staff."});next();};
app.get("/api/admin/staff",superOnly,async(req,res)=>{await staffReady;return res.json({success:true,staff:(await pool.query("SELECT id,name,email,role_key,permissions,active,last_login_at,created_at FROM staff_users ORDER BY created_at DESC")).rows,roles:Object.entries(R).map(([key,v])=>({key,name:v[0],permissions:v[1]})),permission_catalog:P});});
app.post("/api/admin/staff",superOnly,async(req,res)=>{try{await staffReady;const name=String(req.body?.name||"").trim(),email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||""),role=String(req.body?.role||"").trim().toLowerCase();if(name.length<2||!email.includes("@")||password.length<8||password.length>72||!R[role])return res.status(400).json({success:false,message:"Name, valid email, 8+ character password and valid role are required."});const h=await bcrypt.hash(password,12),r=await pool.query("INSERT INTO staff_users(name,email,password_hash,role_key,permissions) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id,name,email,role_key,active,created_at",[name,email,h,role,JSON.stringify(R[role][1])]);await audit(pool,req,"staff_created","staff",r.rows[0].id,{email,role});res.status(201).json({success:true,staff:r.rows[0]});}catch(e){res.status(e.code==="23505"?409:500).json({success:false,message:e.code==="23505"?"A staff account with that email already exists.":"Could not create staff account."});}});
app.patch("/api/admin/staff/:id",superOnly,async(req,res)=>{await staffReady;const id=Number(req.params.id);if(!Number.isInteger(id)||id<=0)return res.status(400).json({success:false,message:"Invalid staff ID."});const r=await pool.query("SELECT * FROM staff_users WHERE id=$1",[id]);if(!r.rows.length)return res.status(404).json({success:false,message:"Staff account not found."});const role=String(req.body?.role||r.rows[0].role_key).toLowerCase(),active=req.body?.active===undefined?r.rows[0].active:Boolean(req.body.active);if(!R[role])return res.status(400).json({success:false,message:"Invalid role."});await pool.query("UPDATE staff_users SET role_key=$1,permissions=$2::jsonb,active=$3,updated_at=NOW() WHERE id=$4",[role,JSON.stringify(R[role][1]),active,id]);if(!active){await pool.query("DELETE FROM user_sessions WHERE sess->>'staffId'=$1",[String(id)]);}await audit(pool,req,"staff_updated","staff",id,{role,active});res.json({success:true,message:"Staff account updated."});});
app.put("/api/admin/staff/:id/permissions",superOnly,async(req,res)=>{await staffReady;const id=Number(req.params.id),items=Array.isArray(req.body?.permissions)?req.body.permissions:[];if(id===Number(req.session.staffId))return res.status(400).json({success:false,message:"You cannot change your own permissions."});const valid=items.filter(x=>x!=="staff.manage"&&Object.prototype.hasOwnProperty.call(P,x));if(!await pool.query("SELECT id FROM staff_users WHERE id=$1",[id]).then(x=>x.rows.length))return res.status(404).json({success:false,message:"Staff account not found."});await pool.query("UPDATE staff_users SET permissions=$1::jsonb,updated_at=NOW() WHERE id=$2",[JSON.stringify(valid),id]);await audit(pool,req,"staff_permissions_updated","staff",id,{permission_count:valid.length});res.json({success:true,message:"Custom permissions saved. Staff member can refresh to apply the new permissions."});});
app.delete("/api/admin/staff/:id",superOnly,async(req,res)=>{await staffReady;const id=Number(req.params.id);if(id===Number(req.session.staffId))return res.status(400).json({success:false,message:"You cannot delete your own staff account."});const r=await pool.query("DELETE FROM staff_users WHERE id=$1 RETURNING id,email",[id]);if(!r.rows.length)return res.status(404).json({success:false,message:"Staff account not found."});await audit(pool,req,"staff_deleted","staff",id,{email:r.rows[0].email});res.json({success:true,message:"Staff account removed."});});
app.get("/api/admin/staff/audit",superOnly,async(req,res)=>{await staffReady;return res.json({success:true,audit:(await pool.query("SELECT id,admin_email,action,target_type,target_id,details,created_at FROM admin_audit_log ORDER BY created_at DESC LIMIT 300")).rows});});
console.log("DGM Staff & Permissions system initialized.");
return staffReady;
}
module.exports={installStaff,P};