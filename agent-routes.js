const crypto = require("crypto");

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function agentCode() {
  return "DGMAG-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function initAgentDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id SERIAL PRIMARY KEY,
      customer_id INTEGER NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
      agent_code TEXT UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      tier TEXT NOT NULL DEFAULT 'Starter',
      commission_balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      application_note TEXT,
      approved_at TIMESTAMPTZ,
      suspended_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS agent_profiles_status_idx ON agent_profiles(status);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_wallets (
      id SERIAL PRIMARY KEY,
      agent_id INTEGER NOT NULL UNIQUE REFERENCES agent_profiles(id) ON DELETE CASCADE,
      balance NUMERIC(12,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_wallet_transactions (
      id SERIAL PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_before NUMERIC(12,2) NOT NULL DEFAULT 0,
      balance_after NUMERIC(12,2) NOT NULL DEFAULT 0,
      description TEXT,
      reference TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS agent_wallet_tx_agent_created_idx ON agent_wallet_transactions(agent_id, created_at DESC);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_sales (
      id SERIAL PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      order_id INTEGER UNIQUE REFERENCES orders(id) ON DELETE SET NULL,
      order_ref TEXT UNIQUE NOT NULL,
      service TEXT NOT NULL,
      network TEXT,
      phone TEXT NOT NULL,
      capacity TEXT,
      base_cost NUMERIC(12,2) NOT NULL,
      sale_price NUMERIC(12,2) NOT NULL,
      profit NUMERIC(12,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Processing',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS agent_sales_agent_created_idx ON agent_sales(agent_id, created_at DESC);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_commission_transactions (
      id SERIAL PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      sale_id INTEGER REFERENCES agent_sales(id) ON DELETE SET NULL,
      type TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      balance_before NUMERIC(12,2) NOT NULL DEFAULT 0,
      balance_after NUMERIC(12,2) NOT NULL DEFAULT 0,
      description TEXT,
      reference TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS agent_commission_agent_created_idx ON agent_commission_transactions(agent_id, created_at DESC);
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agent_withdrawals (
      id SERIAL PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
      reference TEXT UNIQUE NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      momo_network TEXT NOT NULL,
      momo_phone TEXT NOT NULL,
      momo_name TEXT,
      status TEXT NOT NULL DEFAULT 'Pending Approval',
      admin_note TEXT,
      approved_at TIMESTAMPTZ,
      rejected_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS agent_withdrawals_status_idx ON agent_withdrawals(status);
  `);
  await pool.query(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS store_slug TEXT UNIQUE`);
  await pool.query(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS store_name TEXT`);
  await pool.query(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS store_bio TEXT`);
  await pool.query(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS whatsapp_phone TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_pricing_rules (id SERIAL PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE, service TEXT NOT NULL, network TEXT, capacity TEXT, sale_price NUMERIC(12,2) NOT NULL, UNIQUE(agent_id,service,network,capacity))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_promo_codes (id SERIAL PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE, code TEXT NOT NULL, discount_type TEXT NOT NULL DEFAULT 'fixed', discount_value NUMERIC(12,2) NOT NULL DEFAULT 0, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, expires_at TIMESTAMPTZ, UNIQUE(agent_id,code))`);
  await pool.query("ALTER TABLE agent_sales ADD COLUMN IF NOT EXISTS customer_payment_mode TEXT NOT NULL DEFAULT 'agent_wallet'");
  await pool.query("ALTER TABLE agent_sales ADD COLUMN IF NOT EXISTS customer_charge NUMERIC(12,2) NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE agent_sales ADD COLUMN IF NOT EXISTS customer_refunded BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("CREATE INDEX IF NOT EXISTS agent_sales_customer_payment_idx ON agent_sales(customer_payment_mode,status,created_at DESC)");
  await pool.query(`INSERT INTO agent_wallets(agent_id,balance)
    SELECT id,0 FROM agent_profiles
    WHERE NOT EXISTS (SELECT 1 FROM agent_wallets WHERE agent_wallets.agent_id=agent_profiles.id)`);
}

function installAgent(app, { pool, requireCustomer, requireAdmin, getRetailPrice, fulfillDataOrder }) {
  async function getAgent(customerId, client = pool) {
    const q = await client.query(
      `SELECT a.*, c.name, c.phone, c.email, w.balance AS agent_wallet
       FROM agent_profiles a
       JOIN customers c ON c.id=a.customer_id
       LEFT JOIN agent_wallets w ON w.agent_id=a.id
       WHERE a.customer_id=$1 LIMIT 1`, [customerId]
    );
    return q.rows[0] || null;
  }

  async function notify(poolRef, customerId, title, message, type = "info") {
    try {
      await poolRef.query(
        `INSERT INTO customer_notifications(customer_id,title,message,type) VALUES($1,$2,$3,$4)`,
        [customerId, title, message, type]
      );
    } catch (e) { console.error("Agent notification error:", e.message); }
  }

  app.get("/api/agent/data-catalogue", requireCustomer, async (req,res) => {
    try {
      const networks = {};
      for (const network of ["MTN","AirtelTigo","Telecel"]) {
        const rows = [];
        const capacities = network === "MTN"
          ? [1,2,3,4,5,6,8,10,15,20,25,30,40,50]
          : network === "AirtelTigo"
            ? [1,2,3,4,5,6,8,10,12,15,25,30,40,50]
            : [10,15,20,25,30,35,40,45,50,100];
        for (const capacity of capacities) {
          const price = money(await getRetailPrice(network, capacity));
          if (price > 0) rows.push({capacity, price});
        }
        networks[network] = rows;
      }
      return res.json({success:true,source:"DataMart public catalogue",checked_at:new Date().toISOString(),networks});
    } catch (e) {
      console.error("Agent catalogue:",e);
      return res.status(500).json({success:false,message:"Could not load the live DataMart catalogue."});
    }
  });

  app.get("/api/agent/me", requireCustomer, async (req,res) => {
    try {
      const a = await getAgent(req.session.customerId);
      if (!a) return res.json({success:true, enrolled:false});
      const [sales, withdrawals] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS count, COALESCE(SUM(sale_price),0) AS sales, COALESCE(SUM(profit),0) AS profit
          FROM agent_sales WHERE agent_id=$1 AND status='Completed'`, [a.id]),
        pool.query(`SELECT id,reference,amount,momo_network,momo_phone,momo_name,status,created_at,updated_at
          FROM agent_withdrawals WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 20`, [a.id])
      ]);
      return res.json({
        success:true, enrolled:true,
        agent:{id:a.id,agent_code:a.agent_code,status:a.status,tier:a.tier,commission_balance:money(a.commission_balance),
          wallet:money(a.agent_wallet),name:a.name,phone:a.phone,email:a.email,application_note:a.application_note,
          store_slug:a.store_slug||"",store_name:a.store_name||"",store_bio:a.store_bio||"",whatsapp_phone:a.whatsapp_phone||""},
        stats:{completed_sales:sales.rows[0].count,total_sales:money(sales.rows[0].sales),total_profit:money(sales.rows[0].profit)},
        withdrawals:withdrawals.rows
      });
    } catch(e) { console.error("Agent me:",e); return res.status(500).json({success:false,message:"Could not load agent account."}); }
  });

  app.post("/api/agent/apply", requireCustomer, async (req,res) => {
    const note=String(req.body?.note||"").trim().slice(0,1000);
    try {
      const existing=await getAgent(req.session.customerId);
      if(existing && existing.status==="approved") return res.status(400).json({success:false,message:"You are already an approved DGM Agent."});
      if(existing && existing.status==="pending") return res.status(400).json({success:false,message:"Your agent application is already pending."});
      if(existing && existing.status==="suspended") return res.status(400).json({success:false,message:"Your agent account is suspended. Contact DGM Support."});
      if(existing) {
        await pool.query(`UPDATE agent_profiles SET status='pending',application_note=$1,updated_at=NOW() WHERE id=$2`,[note,existing.id]);
      } else {
        const p=await pool.query(`INSERT INTO agent_profiles(customer_id,status,application_note) VALUES($1,'pending',$2) RETURNING id`,[req.session.customerId,note]);
        await pool.query(`INSERT INTO agent_wallets(agent_id,balance) VALUES($1,0)`,[p.rows[0].id]);
      }
      return res.json({success:true,message:"Agent application submitted. DGM will review it shortly."});
    } catch(e) { console.error("Agent apply:",e); return res.status(500).json({success:false,message:"Could not submit agent application."}); }
  });

  app.post("/api/agent/wallet/transfer", requireCustomer, async (req,res) => {
    const amount=money(req.body?.amount);
    if(!Number.isFinite(amount)||amount<5) return res.status(400).json({success:false,message:"Minimum transfer is GH₵5.00."});
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      const a=await getAgent(req.session.customerId,client);
      if(!a||a.status!=="approved") throw new Error("Only approved agents can fund an Agent Wallet.");
      const c=(await client.query("SELECT id,balance FROM customers WHERE id=$1 FOR UPDATE",[req.session.customerId])).rows[0];
      const w=(await client.query("SELECT balance FROM agent_wallets WHERE agent_id=$1 FOR UPDATE",[a.id])).rows[0];
      if(Number(c.balance)<amount) throw new Error("Insufficient DGM Wallet balance.");
      const before=money(c.balance), after=money(before-amount), agentBefore=money(w.balance), agentAfter=money(agentBefore+amount);
      await client.query("UPDATE customers SET balance=$1 WHERE id=$2",[after,c.id]);
      await client.query("UPDATE agent_wallets SET balance=$1,updated_at=NOW() WHERE agent_id=$2",[agentAfter,a.id]);
      const ref="DGM-AGENT-FUND-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
      await client.query(`INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,reference,status)
        VALUES($1,'Debit',$2,$3,$4,'Transfer to Agent Wallet',$5,$5,'Completed')`,[c.id,amount,before,after,ref]);
      await client.query(`INSERT INTO agent_wallet_transactions(agent_id,type,amount,balance_before,balance_after,description,reference)
        VALUES($1,'Credit',$2,$3,$4,'Transfer from DGM Wallet',$5)`,[a.id,amount,agentBefore,agentAfter,ref]);
      await client.query("COMMIT");
      return res.json({success:true,message:"Agent Wallet funded.",wallet_balance:agentAfter,dgm_balance:after});
    } catch(e) { await client.query("ROLLBACK"); return res.status(400).json({success:false,message:e.message||"Could not fund Agent Wallet."}); }
    finally { client.release(); }
  });

  app.get("/api/agent/sales", requireCustomer, async (req,res) => {
    try {
      const a=await getAgent(req.session.customerId);
      if(!a) return res.status(404).json({success:false,message:"Agent account not found."});
      const rows=await pool.query(`SELECT id,order_ref,service,network,phone,capacity,base_cost,sale_price,profit,status,created_at,completed_at
        FROM agent_sales WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 100`,[a.id]);
      return res.json({success:true,sales:rows.rows});
    } catch(e){return res.status(500).json({success:false,message:"Could not load agent sales."});}
  });

  app.post("/api/agent/data/sell", requireCustomer, async (req,res) => {
    const network=String(req.body?.network||"").trim();
    const capacity=String(req.body?.capacity||"").replace(/GB/i,"").trim();
    const phone=String(req.body?.phone||"").trim();
    const salePrice=money(req.body?.sale_price);
    if(!["MTN","AirtelTigo","Telecel"].includes(network)) return res.status(400).json({success:false,message:"Invalid network."});
    if(!/^\d+(?:\.\d+)?$/.test(capacity)||Number(capacity)<=0) return res.status(400).json({success:false,message:"Invalid bundle size."});
    if(!/^0\d{9}$/.test(phone)) return res.status(400).json({success:false,message:"Enter a valid Ghana phone number."});
    const base=money(await getRetailPrice(network,Number(capacity)));
    if(!base) return res.status(400).json({success:false,message:"Selected bundle is unavailable."});
    if(!Number.isFinite(salePrice)||salePrice<base) return res.status(400).json({success:false,message:`Agent sale price must be at least GH₵${base.toFixed(2)}.`});
    const client=await pool.connect();
    let saleId=null, orderId=null, orderRef=null;
    try {
      await client.query("BEGIN");
      const a=await getAgent(req.session.customerId,client);
      if(!a||a.status!=="approved") throw new Error("Your DGM Agent account is not approved.");
      const w=(await client.query("SELECT balance FROM agent_wallets WHERE agent_id=$1 FOR UPDATE",[a.id])).rows[0];
      if(!w||Number(w.balance)<base) throw new Error("Insufficient Agent Wallet balance.");
      const wb=money(w.balance), wa=money(wb-base);
      await client.query("UPDATE agent_wallets SET balance=$1,updated_at=NOW() WHERE agent_id=$2",[wa,a.id]);
      orderRef="DGM-AG-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(4).toString("hex").toUpperCase();
      const o=(await client.query(`INSERT INTO orders(order_ref,customer_id,service,network,phone,amount,status,capacity,payment_status,paid_at)
        VALUES($1,$2,'Data',$3,$4,$5,'Processing',$6,'Paid',NOW()) RETURNING id`,[orderRef,a.customer_id,network,phone,base,capacity])).rows[0];
      orderId=o.id;
      const sale=(await client.query(`INSERT INTO agent_sales(agent_id,order_id,order_ref,service,network,phone,capacity,base_cost,sale_price,profit,status)
        VALUES($1,$2,$3,'Data',$4,$5,$6,$7,$8,$9,'Processing') RETURNING id`,[a.id,orderId,orderRef,network,phone,capacity,base,salePrice,money(salePrice-base)])).rows[0];
      saleId=sale.id;
      await client.query(`INSERT INTO agent_wallet_transactions(agent_id,type,amount,balance_before,balance_after,description,reference)
        VALUES($1,'Debit',$2,$3,$4,'Data sale funding',$5)`,[a.id,base,wb,wa,orderRef]);
      await client.query("COMMIT");
      const result=await fulfillDataOrder({id:orderId,order_ref:orderRef,customer_id:a.customer_id,service:"Data",network,phone,amount:base,status:"Processing",payment_status:"Paid",capacity});
      if(!result?.success && result?.status==="Failed") {
        await refundAgentSale(a.id,saleId,base,orderRef,"Provider rejected the data sale.");
        return res.status(502).json({success:false,message:"The data provider rejected the sale. Agent Wallet has been refunded."});
      }
      const providerStatus=String(result?.status||"").toLowerCase();
      if(["completed","success","successful","delivered"].includes(providerStatus)) await completeAgentSale(saleId);
      return res.json({success:true,message:"Data sale submitted.",order_ref:orderRef,sale_id:saleId,status:providerStatus==="completed"?"Completed":(result?.status||"Processing"),base_cost:base,sale_price:salePrice,profit:money(salePrice-base),wallet_balance:wa});
    } catch(e) {
      try { await client.query("ROLLBACK"); } catch {}
      if(saleId) await refundAgentSale((await getAgent(req.session.customerId))?.id,saleId,base,orderRef,e.message);
      return res.status(400).json({success:false,message:e.message||"Could not create agent sale."});
    } finally { client.release(); }
  });

  async function refundAgentSale(agentId,saleId,amount,reference,reason) {
    if(!agentId||!saleId||!amount)return;
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const s=(await c.query("SELECT id,status FROM agent_sales WHERE id=$1 FOR UPDATE",[saleId])).rows[0];
      if(!s||s.status==="Refunded"){await c.query("ROLLBACK");return;}
      const w=(await c.query("SELECT balance FROM agent_wallets WHERE agent_id=$1 FOR UPDATE",[agentId])).rows[0];
      if(!w){await c.query("ROLLBACK");return;}
      const before=money(w.balance),after=money(before+amount);
      await c.query("UPDATE agent_wallets SET balance=$1,updated_at=NOW() WHERE agent_id=$2",[after,agentId]);
      await c.query("UPDATE agent_sales SET status='Refunded' WHERE id=$1",[saleId]);
      await c.query(`INSERT INTO agent_wallet_transactions(agent_id,type,amount,balance_before,balance_after,description,reference)
        VALUES($1,'Credit',$2,$3,$4,$5,$6)`,[agentId,amount,before,after,reason,"REFUND:"+reference]);
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK");console.error("Agent refund:",e.message)}finally{c.release();}
  }

  async function completeAgentSale(saleId) {
    const c=await pool.connect();
    try {
      await c.query("BEGIN");
      const locked=(await c.query("SELECT * FROM agent_sales WHERE id=$1 FOR UPDATE",[saleId])).rows[0];
      if(!locked || locked.status!=="Processing") { await c.query("ROLLBACK"); return false; }
      const a=(await c.query("SELECT * FROM agent_profiles WHERE id=$1 FOR UPDATE",[locked.agent_id])).rows[0];
      if(!a) { await c.query("ROLLBACK"); return false; }
      const profit=money(locked.profit);
      const before=money(a.commission_balance);
      const after=money(before+profit);
      await c.query("UPDATE agent_profiles SET commission_balance=$1,updated_at=NOW() WHERE id=$2",[after,a.id]);
      await c.query("UPDATE agent_sales SET status='Completed',completed_at=NOW() WHERE id=$1",[locked.id]);
      await c.query(`INSERT INTO agent_commission_transactions(agent_id,sale_id,type,amount,balance_before,balance_after,description,reference)
        VALUES($1,$2,'Credit',$3,$4,$5,'Profit from agent sale',$6)
        ON CONFLICT(reference) DO NOTHING`,[a.id,locked.id,profit,before,after,"SALE:"+locked.order_ref]);
      await c.query("COMMIT");
      await notify(pool,a.customer_id,"Agent profit credited",`GH₵${profit.toFixed(2)} profit was added from sale ${locked.order_ref}.`,"success");
      return true;
    } catch(e) {
      await c.query("ROLLBACK");
      console.error("Agent sale completion:",e.message);
      return false;
    } finally { c.release(); }
  }

  async function reconcileAgentSales() {
    try {
      const rows=await pool.query(`SELECT s.*,o.status AS order_status FROM agent_sales s JOIN orders o ON o.id=s.order_id
        WHERE s.status='Processing' ORDER BY s.created_at ASC LIMIT 50`);
      for(const s of rows.rows){
        const status=String(s.order_status||"").toLowerCase();
        if(["completed","success","successful","delivered"].includes(status)){
          await completeAgentSale(s.id);
        } else if(["failed","refunded","cancelled","canceled"].includes(status)){
          await refundAgentSale(s.agent_id,s.id,money(s.base_cost),s.order_ref,"Data sale failed; Agent Wallet refunded.");
          if(s.customer_payment_mode==="store_wallet" && !s.customer_refunded){
            await refundStoreCustomer(s.customer_id,s.id,money(s.customer_charge),s.order_ref,"Store order failed; customer DGM Wallet refunded.");
          }
        }
      }
    } catch(e){console.error("Agent reconciliation:",e.message)}
  }

  app.post("/api/agent/withdraw", requireCustomer, async (req,res) => {
    const amount=money(req.body?.amount), network=String(req.body?.momo_network||"").trim(), phone=String(req.body?.momo_phone||"").trim(), name=String(req.body?.momo_name||"").trim().slice(0,120);
    if(!Number.isFinite(amount)||amount<5)return res.status(400).json({success:false,message:"Minimum commission withdrawal is GH₵5.00."});
    if(!["MTN","Telecel","AirtelTigo","Vodafone"].includes(network))return res.status(400).json({success:false,message:"Select a valid MoMo network."});
    if(!/^0\d{9}$/.test(phone))return res.status(400).json({success:false,message:"Enter a valid Ghana MoMo number."});
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const a=await getAgent(req.session.customerId,c);
      if(!a||a.status!=="approved")throw new Error("Approved agent account required.");
      const p=money(a.commission_balance); if(p<amount)throw new Error("Insufficient commission balance.");
      const after=money(p-amount);
      await c.query("UPDATE agent_profiles SET commission_balance=$1,updated_at=NOW() WHERE id=$2",[after,a.id]);
      const ref="DGM-AG-WD-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
      await c.query(`INSERT INTO agent_withdrawals(agent_id,reference,amount,momo_network,momo_phone,momo_name)
        VALUES($1,$2,$3,$4,$5,$6)`,[a.id,ref,amount,network,phone,name]);
      await c.query(`INSERT INTO agent_commission_transactions(agent_id,type,amount,balance_before,balance_after,description,reference)
        VALUES($1,'Debit',$2,$3,$4,'Commission withdrawal request',$5)`,[a.id,amount,p,after,ref]);
      await c.query("COMMIT");
      res.json({success:true,message:"Commission withdrawal requested.",reference:ref,balance:after});
    }catch(e){await c.query("ROLLBACK");res.status(400).json({success:false,message:e.message||"Could not request withdrawal."});}finally{c.release();}
  });

  app.get("/api/agent/store", requireCustomer, async (req,res)=>{try{const a=await getAgent(req.session.customerId);if(!a||a.status!=="approved")return res.status(403).json({success:false,message:"Approved agent account required."});let slug=a.store_slug||("agent-"+a.agent_code.toLowerCase().replace(/[^a-z0-9]+/g,"-"));if(!a.store_slug)await pool.query("UPDATE agent_profiles SET store_slug=$1,store_name=$2,updated_at=NOW() WHERE id=$3",[slug,a.name||"DGM Agent Store",a.id]);const p=await pool.query("SELECT service,network,capacity,sale_price FROM agent_pricing_rules WHERE agent_id=$1 ORDER BY network,capacity",[a.id]);res.json({success:true,store:{slug,name:a.store_name||a.name||"DGM Agent Store",bio:a.store_bio||"DGM services at your trusted agent price.",whatsapp:a.whatsapp_phone||a.phone,pricing:p.rows}})}catch(e){res.status(500).json({success:false,message:"Could not load store."})}});

  app.post("/api/agent/store", requireCustomer, async (req,res)=>{try{const a=await getAgent(req.session.customerId);if(!a||a.status!=="approved")throw new Error("Approved agent account required.");let name=String(req.body?.name||"").trim().slice(0,80),bio=String(req.body?.bio||"").trim().slice(0,300),wa=String(req.body?.whatsapp||a.phone||"").trim();if(!name)name=a.name||"DGM Agent Store";if(!/^0\d{9}$/.test(wa))throw new Error("Enter a valid Ghana WhatsApp number.");let slug=String(req.body?.slug||a.store_slug||"").toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60);if(!slug)slug="agent-"+a.agent_code.toLowerCase();const clash=await pool.query("SELECT id FROM agent_profiles WHERE store_slug=$1 AND id<>$2",[slug,a.id]);if(clash.rows.length)throw new Error("That store link is already in use.");await pool.query("UPDATE agent_profiles SET store_slug=$1,store_name=$2,store_bio=$3,whatsapp_phone=$4,updated_at=NOW() WHERE id=$5",[slug,name,bio,wa,a.id]);res.json({success:true,store_url:"/store.html?slug="+encodeURIComponent(slug),message:"Agent Store updated."})}catch(e){res.status(400).json({success:false,message:e.message})}});

  app.post("/api/agent/pricing", requireCustomer, async (req,res)=>{try{const a=await getAgent(req.session.customerId);if(!a||a.status!=="approved")throw new Error("Approved agent account required.");const network=String(req.body?.network||"").trim(),capacity=String(req.body?.capacity||"").replace(/GB/i,"").trim(),price=money(req.body?.sale_price),base=money(await getRetailPrice(network,Number(capacity)));if(!base||price<base)throw new Error("Price must be at or above the DGM base price.");await pool.query("INSERT INTO agent_pricing_rules(agent_id,service,network,capacity,sale_price) VALUES($1,'Data',$2,$3,$4) ON CONFLICT(agent_id,service,network,capacity) DO UPDATE SET sale_price=EXCLUDED.sale_price",[a.id,network,capacity,price]);res.json({success:true,message:"Agent pricing saved."})}catch(e){res.status(400).json({success:false,message:e.message})}});

  app.get("/api/public/agent-store/:slug", async (req,res)=>{try{const slug=String(req.params.slug||"").toLowerCase();const q=await pool.query("SELECT a.id,a.agent_code,a.store_name,a.store_bio,a.whatsapp_phone,c.name,c.phone FROM agent_profiles a JOIN customers c ON c.id=a.customer_id WHERE a.store_slug=$1 AND a.status='approved' LIMIT 1",[slug]);if(!q.rows.length)return res.status(404).json({success:false,message:"Store not found."});const a=q.rows[0],p=await pool.query("SELECT service,network,capacity,sale_price FROM agent_pricing_rules WHERE agent_id=$1 ORDER BY network,capacity",[a.id]);res.json({success:true,store:{agent_code:a.agent_code,name:a.store_name||a.name,bio:a.store_bio||"DGM Agent Store",whatsapp:a.whatsapp_phone||a.phone,pricing:p.rows}})}catch(e){res.status(500).json({success:false,message:"Could not load store."})}});
  // CUSTOMER-FACING DGM AGENT STORE CHECKOUT
  app.post("/api/public/agent-store/:slug/order", requireCustomer, async (req,res)=>{
    const slug=String(req.params.slug||"").trim().toLowerCase();
    const network=String(req.body?.network||"").trim();
    const capacity=String(req.body?.capacity||"").replace(/GB/i,"").trim();
    const phone=String(req.body?.phone||"").trim();
    const promo=String(req.body?.promo_code||"").trim().toUpperCase().slice(0,40);
    if(!slug||!["MTN","AirtelTigo","Telecel"].includes(network)) return res.status(400).json({success:false,message:"Select a valid network."});
    if(!/^\d+(?:\.\d+)?$/.test(capacity)||Number(capacity)<=0) return res.status(400).json({success:false,message:"Select a valid bundle."});
    if(!/^0\d{9}$/.test(phone)) return res.status(400).json({success:false,message:"Enter a valid Ghana recipient number."});
    const client=await pool.connect();
    let saleId=null,orderId=null,orderRef=null,base=0,netPrice=0,agentId=null;
    try{
      await client.query("BEGIN");
      const a=(await client.query("SELECT a.*,c.name,c.phone FROM agent_profiles a JOIN customers c ON c.id=a.customer_id WHERE a.store_slug=$1 AND a.status='approved' LIMIT 1 FOR UPDATE",[slug])).rows[0];
      if(!a) throw new Error("Store not found or unavailable.");
      agentId=a.id;
      const p=(await client.query("SELECT sale_price FROM agent_pricing_rules WHERE agent_id=$1 AND service='Data' AND network=$2 AND capacity=$3 LIMIT 1",[a.id,network,capacity])).rows[0];
      if(!p) throw new Error("This bundle is not available in this store.");
      base=money(await getRetailPrice(network,Number(capacity)));
      const published=money(p.sale_price);
      if(!base||published<base) throw new Error("This bundle is temporarily unavailable.");
      netPrice=published;
      if(promo){
        const pr=(await client.query("SELECT * FROM agent_promo_codes WHERE agent_id=$1 AND UPPER(code)=UPPER($2) AND active=true AND (expires_at IS NULL OR expires_at>NOW()) AND (max_uses IS NULL OR uses<max_uses) FOR UPDATE",[a.id,promo])).rows[0];
        if(!pr) throw new Error("Promo code is invalid or expired.");
        const discount=pr.discount_type==="percent" ? money(published*(Number(pr.discount_value)/100)) : money(pr.discount_value);
        netPrice=money(Math.max(base,published-discount));
        if(netPrice>=published) throw new Error("Promo code does not reduce this order.");
      }
      const customer=(await client.query("SELECT id,balance FROM customers WHERE id=$1 FOR UPDATE",[req.session.customerId])).rows[0];
      if(!customer) throw new Error("Customer account not found.");
      const wallet=(await client.query("SELECT balance FROM agent_wallets WHERE agent_id=$1 FOR UPDATE",[a.id])).rows[0];
      if(!wallet||Number(wallet.balance)<base) throw new Error("This agent is temporarily unable to process the order. Please try again later.");
      if(Number(customer.balance)<netPrice) throw new Error("Insufficient DGM Wallet balance. You need GH₵"+netPrice.toFixed(2)+".");
      const cb=money(customer.balance),ca=money(cb-netPrice),wb=money(wallet.balance),wa=money(wb-base);
      await client.query("UPDATE customers SET balance=$1 WHERE id=$2",[ca,customer.id]);
      await client.query("UPDATE agent_wallets SET balance=$1,updated_at=NOW() WHERE agent_id=$2",[wa,a.id]);
      orderRef="DGM-STORE-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(4).toString("hex").toUpperCase();
      const o=(await client.query("INSERT INTO orders(order_ref,customer_id,service,network,phone,amount,status,capacity,payment_status,paid_at) VALUES($1,$2,'Data',$3,$4,$5,'Processing',$6,'Paid',NOW()) RETURNING id",[orderRef,customer.id,network,phone,netPrice,capacity])).rows[0];
      orderId=o.id;
      const sale=(await client.query("INSERT INTO agent_sales(agent_id,order_id,order_ref,service,network,phone,capacity,base_cost,sale_price,profit,status,customer_payment_mode,customer_charge) VALUES($1,$2,$3,'Data',$4,$5,$6,$7,$8,$9,'Processing','store_wallet',$10) RETURNING id",[a.id,orderId,orderRef,network,phone,capacity,base,netPrice,money(netPrice-base),netPrice])).rows[0];
      saleId=sale.id;
      await client.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'Debit',$2,$3,$4,$5,$6,'Completed',$6)",[customer.id,netPrice,cb,ca,"Agent Store purchase - "+(a.store_name||a.name)+" - "+network+" "+capacity+"GB",orderRef]);
      await client.query("INSERT INTO agent_wallet_transactions(agent_id,type,amount,balance_before,balance_after,description,reference) VALUES($1,'Debit',$2,$3,$4,'Customer Store order wholesale funding',$5)",[a.id,base,wb,wa,orderRef]);
      if(promo) await client.query("UPDATE agent_promo_codes SET uses=uses+1 WHERE agent_id=$1 AND UPPER(code)=UPPER($2)",[a.id,promo]);
      await client.query("COMMIT");
      let result;
      try{result=await fulfillDataOrder({id:orderId,order_ref:orderRef,customer_id:customer.id,service:"Data",network,phone,amount:netPrice,status:"Processing",payment_status:"Paid",capacity});}
      catch(e){result={success:false,status:"Failed",message:e.message};}
      const ps=String(result?.status||"").toLowerCase();
      if(!result?.success && ["failed","rejected","error"].includes(ps)){
        await refundAgentSale(agentId,saleId,base,orderRef,"Store order failed; Agent Wallet refunded.");
        await refundStoreCustomer(customer.id,saleId,netPrice,orderRef,"Store order failed; customer DGM Wallet refunded.");
        await pool.query("UPDATE orders SET status='Failed',provider_message=$1 WHERE id=$2",[String(result?.message||"Provider rejected the order."),orderId]);
        return res.status(502).json({success:false,message:"The data provider rejected the order. Your DGM Wallet has been refunded.",order_ref:orderRef});
      }
      if(["completed","success","successful","delivered"].includes(ps)) await completeAgentSale(saleId);
      return res.json({success:true,message:["completed","success","successful","delivered"].includes(ps)?"Data delivered successfully.":"Order submitted. Data is being delivered.",order_ref:orderRef,status:["completed","success","successful","delivered"].includes(ps)?"Completed":"Processing",charged:netPrice});
    }catch(e){
      try{await client.query("ROLLBACK")}catch{}
      return res.status(400).json({success:false,message:e.message||"Could not place store order."});
    }finally{client.release();}
  });

  async function refundStoreCustomer(customerId,saleId,amount,reference,reason){
    if(!customerId||!saleId||!amount)return;
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const s=(await c.query("SELECT customer_payment_mode,customer_refunded FROM agent_sales WHERE id=$1 FOR UPDATE",[saleId])).rows[0];
      if(!s||s.customer_refunded||s.customer_payment_mode!=="store_wallet"){await c.query("ROLLBACK");return;}
      const customer=(await c.query("SELECT balance FROM customers WHERE id=$1 FOR UPDATE",[customerId])).rows[0];
      if(!customer){await c.query("ROLLBACK");return;}
      const before=money(customer.balance),after=money(before+amount);
      await c.query("UPDATE customers SET balance=$1 WHERE id=$2",[after,customerId]);
      await c.query("UPDATE agent_sales SET customer_refunded=true WHERE id=$1",[saleId]);
      await c.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'Credit',$2,$3,$4,$5,$6,'Completed',$6)",[customerId,amount,before,after,reason,"REFUND:"+reference]);
      await c.query("COMMIT");
    }catch(e){await c.query("ROLLBACK").catch(()=>{});console.error("Store customer refund:",e.message)}finally{c.release();}
  }

  app.get("/api/public/agent-store/:slug/order/:reference", requireCustomer, async (req,res)=>{
    try{
      const slug=String(req.params.slug||"").toLowerCase(),ref=String(req.params.reference||"").trim();
      const q=await pool.query("SELECT s.order_ref,s.status,s.network,s.capacity,s.phone,s.sale_price,s.profit,o.provider_status,o.provider_message,o.completed_at FROM agent_sales s JOIN agent_profiles a ON a.id=s.agent_id JOIN orders o ON o.id=s.order_id WHERE a.store_slug=$1 AND s.order_ref=$2 AND o.customer_id=$3 LIMIT 1",[slug,ref,req.session.customerId]);
      if(!q.rows.length)return res.status(404).json({success:false,message:"Order not found."});
      res.json({success:true,order:q.rows[0]});
    }catch(e){res.status(500).json({success:false,message:"Could not load order status."})}
  });


  // ADMIN
  app.get("/api/admin/agents", requireAdmin, async (req,res)=>{
    try{
      const [agents,withdrawals]=await Promise.all([
        pool.query(`SELECT a.id,a.customer_id,a.agent_code,a.status,a.tier,a.commission_balance,a.application_note,a.approved_at,a.created_at,
          c.name,c.phone,c.email,COALESCE(w.balance,0) AS wallet,
          COALESCE((SELECT COUNT(*) FROM agent_sales s WHERE s.agent_id=a.id AND s.status='Completed'),0)::int AS completed_sales,
          COALESCE((SELECT SUM(profit) FROM agent_sales s WHERE s.agent_id=a.id AND s.status='Completed'),0) AS total_profit
          FROM agent_profiles a JOIN customers c ON c.id=a.customer_id LEFT JOIN agent_wallets w ON w.agent_id=a.id ORDER BY a.created_at DESC`),
        pool.query(`SELECT w.id,w.reference,w.amount,w.momo_network,w.momo_phone,w.momo_name,w.status,w.created_at,a.agent_code,c.name,c.phone
          FROM agent_withdrawals w JOIN agent_profiles a ON a.id=w.agent_id JOIN customers c ON c.id=a.customer_id ORDER BY w.created_at DESC LIMIT 100`)
      ]);
      res.json({success:true,agents:agents.rows,withdrawals:withdrawals.rows});
    }catch(e){res.status(500).json({success:false,message:"Could not load agents."});}
  });

  app.post("/api/admin/agents/:id/approve", requireAdmin, async (req,res)=>{
    try{
      const id=Number(req.params.id); const c=await pool.connect();
      try{
        await c.query("BEGIN");
        const a=(await c.query("SELECT * FROM agent_profiles WHERE id=$1 FOR UPDATE",[id])).rows[0];
        if(!a)throw new Error("Agent application not found.");
        const code=a.agent_code||agentCode();
        await c.query(`UPDATE agent_profiles SET status='approved',agent_code=$1,tier='Starter',approved_at=NOW(),suspended_at=NULL,updated_at=NOW() WHERE id=$2`,[code,id]);
        await c.query("INSERT INTO agent_wallets(agent_id,balance) VALUES($1,0) ON CONFLICT(agent_id) DO NOTHING",[id]);
        await c.query("COMMIT");
        await notify(pool,a.customer_id,"DGM Agent application approved",`Your DGM Agent account is approved. Agent ID: ${code}.`,"success");
        res.json({success:true,message:"Agent approved.",agent_code:code});
      }catch(e){await c.query("ROLLBACK");throw e}finally{c.release();}
    }catch(e){res.status(400).json({success:false,message:e.message||"Could not approve agent."});}
  });

  app.post("/api/admin/agents/:id/reject", requireAdmin, async (req,res)=>{
    try{const id=Number(req.params.id);const a=(await pool.query("SELECT * FROM agent_profiles WHERE id=$1",[id])).rows[0];if(!a)throw new Error("Agent not found.");await pool.query("UPDATE agent_profiles SET status='rejected',updated_at=NOW() WHERE id=$1",[id]);await notify(pool,a.customer_id,"DGM Agent application update","Your DGM Agent application was not approved at this time.","alert");res.json({success:true,message:"Agent application rejected."});}catch(e){res.status(400).json({success:false,message:e.message||"Could not reject application."});}
  });

  app.post("/api/admin/agents/:id/suspend", requireAdmin, async (req,res)=>{
    try{const id=Number(req.params.id);await pool.query("UPDATE agent_profiles SET status='suspended',suspended_at=NOW(),updated_at=NOW() WHERE id=$1",[id]);res.json({success:true,message:"Agent suspended."});}catch(e){res.status(400).json({success:false,message:e.message});}
  });
  app.post("/api/admin/agents/:id/reactivate", requireAdmin, async (req,res)=>{
    try{const id=Number(req.params.id);await pool.query("UPDATE agent_profiles SET status='approved',suspended_at=NULL,updated_at=NOW() WHERE id=$1",[id]);res.json({success:true,message:"Agent reactivated."});}catch(e){res.status(400).json({success:false,message:e.message});}
  });


  app.get("/api/admin/agents/:id/details", requireAdmin, async (req,res)=>{
    try{
      const id=Number(req.params.id);
      const [agent,pricing,sales,walletTx,commissionTx]=await Promise.all([
        pool.query(`SELECT a.id,a.customer_id,a.agent_code,a.status,a.tier,a.commission_balance,a.application_note,a.approved_at,a.created_at,a.store_slug,a.store_name,a.store_bio,a.whatsapp_phone,c.name,c.phone,c.email,COALESCE(w.balance,0) AS wallet
          FROM agent_profiles a JOIN customers c ON c.id=a.customer_id LEFT JOIN agent_wallets w ON w.agent_id=a.id WHERE a.id=$1 LIMIT 1`,[id]),
        pool.query(`SELECT service,network,capacity,sale_price FROM agent_pricing_rules WHERE agent_id=$1 ORDER BY service,network,capacity`,[id]),
        pool.query(`SELECT id,order_ref,service,network,phone,capacity,base_cost,sale_price,profit,status,created_at,completed_at FROM agent_sales WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 100`,[id]),
        pool.query(`SELECT type,amount,balance_before,balance_after,description,reference,created_at FROM agent_wallet_transactions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 50`,[id]),
        pool.query(`SELECT type,amount,balance_before,balance_after,description,reference,created_at FROM agent_commission_transactions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 50`,[id])
      ]);
      if(!agent.rows.length) return res.status(404).json({success:false,message:"Agent not found."});
      const a=agent.rows[0];
      res.json({success:true,agent:a,pricing:pricing.rows,sales:sales.rows,wallet_transactions:walletTx.rows,commission_transactions:commissionTx.rows});
    }catch(e){console.error("Admin agent details:",e);res.status(500).json({success:false,message:"Could not load agent details."});}
  });

  app.post("/api/admin/agents/:id/wallet", requireAdmin, async (req,res)=>{
    const amount=money(req.body?.amount), action=String(req.body?.action||"").toLowerCase(), note=String(req.body?.note||"Admin wallet adjustment").trim().slice(0,200);
    if(!["credit","debit"].includes(action)||!Number.isFinite(amount)||amount<=0) return res.status(400).json({success:false,message:"Enter a valid positive amount and choose credit or debit."});
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const w=(await c.query("SELECT balance FROM agent_wallets WHERE agent_id=$1 FOR UPDATE",[Number(req.params.id)])).rows[0];
      if(!w) throw new Error("Agent Wallet not found.");
      const before=money(w.balance), after=money(action==="credit"?before+amount:before-amount);
      if(after<0) throw new Error("Agent Wallet cannot go below GH₵0.00.");
      await c.query("UPDATE agent_wallets SET balance=$1,updated_at=NOW() WHERE agent_id=$2",[after,Number(req.params.id)]);
      const ref="DGM-ADMIN-AW-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
      await c.query(`INSERT INTO agent_wallet_transactions(agent_id,type,amount,balance_before,balance_after,description,reference) VALUES($1,$2,$3,$4,$5,$6,$7)`,[Number(req.params.id),action==="credit"?"Credit":"Debit",amount,before,after,note,ref]);
      await c.query("COMMIT");
      res.json({success:true,message:"Agent Wallet "+action+"ed.",balance:after,reference:ref});
    }catch(e){await c.query("ROLLBACK");res.status(400).json({success:false,message:e.message});}finally{c.release();}
  });

  app.post("/api/admin/agents/:id/commission", requireAdmin, async (req,res)=>{
    const amount=money(req.body?.amount), action=String(req.body?.action||"").toLowerCase(), note=String(req.body?.note||"Admin commission adjustment").trim().slice(0,200);
    if(!["credit","debit"].includes(action)||!Number.isFinite(amount)||amount<=0) return res.status(400).json({success:false,message:"Enter a valid positive amount and choose credit or debit."});
    const c=await pool.connect();
    try{
      await c.query("BEGIN");
      const a=(await c.query("SELECT commission_balance FROM agent_profiles WHERE id=$1 FOR UPDATE",[Number(req.params.id)])).rows[0];
      if(!a) throw new Error("Agent not found.");
      const before=money(a.commission_balance), after=money(action==="credit"?before+amount:before-amount);
      if(after<0) throw new Error("Commission balance cannot go below GH₵0.00.");
      await c.query("UPDATE agent_profiles SET commission_balance=$1,updated_at=NOW() WHERE id=$2",[after,Number(req.params.id)]);
      const ref="DGM-ADMIN-AC-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(3).toString("hex").toUpperCase();
      await c.query(`INSERT INTO agent_commission_transactions(agent_id,type,amount,balance_before,balance_after,description,reference) VALUES($1,$2,$3,$4,$5,$6,$7)`,[Number(req.params.id),action==="credit"?"Credit":"Debit",amount,before,after,note,ref]);
      await c.query("COMMIT");
      res.json({success:true,message:"Agent commission "+action+"ed.",balance:after,reference:ref});
    }catch(e){await c.query("ROLLBACK");res.status(400).json({success:false,message:e.message});}finally{c.release();}
  });

  app.post("/api/admin/agent-withdrawals/:id/approve", requireAdmin, async (req,res)=>{
    try{
      const id=Number(req.params.id);
      const r=await pool.query("UPDATE agent_withdrawals SET status='Approved',approved_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='Pending Approval' RETURNING agent_id");
      if(!r.rows.length) throw new Error("Withdrawal is no longer pending.");
      res.json({success:true,message:"Agent withdrawal approved for payment."});
    }catch(e){res.status(400).json({success:false,message:e.message});}
  });

  app.post("/api/admin/agent-withdrawals/:id/paid", requireAdmin, async (req,res)=>{
    try{
      const id=Number(req.params.id);
      const r=await pool.query("UPDATE agent_withdrawals SET status='Paid',paid_at=NOW(),updated_at=NOW() WHERE id=$1 AND status='Approved' RETURNING reference");
      if(!r.rows.length) throw new Error("Withdrawal must be approved before it can be marked paid.");
      res.json({success:true,message:"Agent withdrawal marked as paid.",reference:r.rows[0].reference});
    }catch(e){res.status(400).json({success:false,message:e.message});}
  });
  app.post("/api/admin/agent-withdrawals/:id/reject", requireAdmin, async (req,res)=>{
    const c=await pool.connect();try{await c.query("BEGIN");const w=(await c.query("SELECT * FROM agent_withdrawals WHERE id=$1 FOR UPDATE",[Number(req.params.id)])).rows[0];if(!w||w.status!=="Pending Approval")throw new Error("Withdrawal is no longer pending.");const a=(await c.query("SELECT * FROM agent_profiles WHERE id=$1 FOR UPDATE",[w.agent_id])).rows[0];const before=money(a.commission_balance),after=money(before+Number(w.amount));await c.query("UPDATE agent_profiles SET commission_balance=$1,updated_at=NOW() WHERE id=$2",[after,a.id]);await c.query("UPDATE agent_withdrawals SET status='Rejected',rejected_at=NOW(),updated_at=NOW() WHERE id=$1",[w.id]);await c.query(`INSERT INTO agent_commission_transactions(agent_id,type,amount,balance_before,balance_after,description,reference) VALUES($1,'Credit',$2,$3,$4,'Rejected withdrawal returned',$5)`,[a.id,w.amount,before,after,"RETURN:"+w.reference]);await c.query("COMMIT");res.json({success:true,message:"Withdrawal rejected and commission returned."});}catch(e){await c.query("ROLLBACK");res.status(400).json({success:false,message:e.message});}finally{c.release();}
  });

  setTimeout(()=>{ reconcileAgentSales(); setInterval(reconcileAgentSales,60000); },15000);
}

module.exports = { initAgentDatabase, installAgent };
