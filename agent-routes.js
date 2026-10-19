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
  await pool.query(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS store_logo_url TEXT`);
  await pool.query(`ALTER TABLE agent_profiles ADD COLUMN IF NOT EXISTS store_banner_url TEXT`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_pricing_rules (id SERIAL PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE, service TEXT NOT NULL, network TEXT, capacity TEXT, sale_price NUMERIC(12,2) NOT NULL, UNIQUE(agent_id,service,network,capacity))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_promo_codes (id SERIAL PRIMARY KEY, agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE, code TEXT NOT NULL, discount_type TEXT NOT NULL DEFAULT 'fixed', discount_value NUMERIC(12,2) NOT NULL DEFAULT 0, max_uses INTEGER, uses INTEGER NOT NULL DEFAULT 0, active BOOLEAN NOT NULL DEFAULT TRUE, expires_at TIMESTAMPTZ, UNIQUE(agent_id,code))`);
  await pool.query("ALTER TABLE agent_sales ADD COLUMN IF NOT EXISTS customer_payment_mode TEXT NOT NULL DEFAULT 'agent_wallet'");
  await pool.query("ALTER TABLE agent_sales ADD COLUMN IF NOT EXISTS customer_charge NUMERIC(12,2) NOT NULL DEFAULT 0");
  await pool.query("ALTER TABLE agent_sales ADD COLUMN IF NOT EXISTS customer_refunded BOOLEAN NOT NULL DEFAULT FALSE");
  await pool.query("CREATE INDEX IF NOT EXISTS agent_sales_customer_payment_idx ON agent_sales(customer_payment_mode,status,created_at DESC)");
  await pool.query(`CREATE TABLE IF NOT EXISTS agent_subagents (
    id SERIAL PRIMARY KEY,
    parent_agent_id INTEGER NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
    customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    status TEXT NOT NULL DEFAULT 'invited',
    invite_code TEXT UNIQUE,
    commission_rate NUMERIC(5,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    joined_at TIMESTAMPTZ
  );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS agent_subagents_parent_idx ON agent_subagents(parent_agent_id, created_at DESC)`);
  await pool.query(`INSERT INTO agent_wallets(agent_id,balance)
    SELECT id,0 FROM agent_profiles
    WHERE NOT EXISTS (SELECT 1 FROM agent_wallets WHERE agent_wallets.agent_id=agent_profiles.id)`);
}

function installAgent(app, { pool, requireCustomer, requireAdmin, getRetailPrice, fulfillDataOrder, paystackSecretKey, initiateGuestSupplierTransfer, initiateGuestPaystackRefund }) {
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
      return res.json({success:true,source:"DGM configured retail price list",pricing_note:"These are DGM retail prices, not verified DataMart wholesale costs.",checked_at:new Date().toISOString(),networks});
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
        pool.query(`SELECT
          COUNT(*) FILTER (WHERE s.status='Completed')::int AS count,
          COALESCE(SUM(s.sale_price) FILTER (WHERE s.status='Completed'),0) AS sales,
          COALESCE(SUM(s.profit) FILTER (WHERE s.status='Completed'),0) AS profit,
          COUNT(*) FILTER (WHERE s.status='Processing' AND LOWER(COALESCE(o.payment_status,''))='paid' AND LOWER(COALESCE(o.status,''))<>'pending payment')::int AS pending,
          COUNT(*) FILTER (WHERE s.status='Processing' AND (LOWER(COALESCE(o.payment_status,''))<>'paid' OR LOWER(COALESCE(o.status,''))='pending payment'))::int AS awaiting_payment,
          COUNT(*) FILTER (WHERE s.status='Failed')::int AS failed,
          COUNT(*) FILTER (WHERE s.status='Refunded')::int AS refunded
          FROM agent_sales s LEFT JOIN orders o ON o.id=s.order_id WHERE s.agent_id=$1`, [a.id]),
        pool.query(`SELECT id,reference,amount,momo_network,momo_phone,momo_name,status,created_at,updated_at
          FROM agent_withdrawals WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 20`, [a.id])
      ]);
      return res.json({
        success:true, enrolled:true,
        agent:{id:a.id,agent_code:a.agent_code,status:a.status,tier:a.tier,commission_balance:money(a.commission_balance),
          wallet:money(a.agent_wallet),name:a.name,phone:a.phone,email:a.email,application_note:a.application_note,
          store_slug:a.store_slug||"",store_name:a.store_name||"",store_bio:a.store_bio||"",whatsapp_phone:a.whatsapp_phone||""},
        stats:{
          completed_sales:sales.rows[0].count,
          total_sales:money(sales.rows[0].sales),
          total_profit:money(sales.rows[0].profit),
          pending_sales:sales.rows[0].pending,
          awaiting_payment_sales:sales.rows[0].awaiting_payment,
          failed_sales:sales.rows[0].failed,
          refunded_sales:sales.rows[0].refunded
        },
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
      const rows=await pool.query(`SELECT s.id,s.order_ref,s.service,s.network,s.phone,s.capacity,s.base_cost,s.sale_price,s.profit,s.status,s.created_at,s.completed_at,
        o.status AS order_status,o.payment_status, s.customer_payment_mode
        FROM agent_sales s LEFT JOIN orders o ON o.id=s.order_id WHERE s.agent_id=$1 ORDER BY s.created_at DESC LIMIT 100`,[a.id]);
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
    if(!Number.isFinite(salePrice)||salePrice<=base) return res.status(400).json({success:false,message:`Agent selling price must be above the DGM price of GH₵${base.toFixed(2)}.`});
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
      // Idempotency guard: if the immutable sale commission ledger entry already exists,
      // repair the sale status only; never add the same profit to the balance a second time.
      const priorCredit=(await c.query(
        "SELECT id FROM agent_commission_transactions WHERE reference=$1 FOR UPDATE",
        ["SALE:"+locked.order_ref]
      )).rows[0];
      if(priorCredit) {
        await c.query("UPDATE agent_sales SET status='Completed',completed_at=COALESCE(completed_at,NOW()) WHERE id=$1",[locked.id]);
        await c.query("COMMIT");
        return true;
      }
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
          if(s.customer_payment_mode==="store_paystack"){
            await pool.query("UPDATE agent_sales SET status='Refunded' WHERE id=$1 AND status='Processing'",[s.id]);
          }else{
            await refundAgentSale(s.agent_id,s.id,money(s.base_cost),s.order_ref,"Data sale failed; Agent Wallet refunded.");
            if(s.customer_payment_mode==="store_wallet" && !s.customer_refunded){
              await refundStoreCustomer(s.customer_id,s.id,money(s.customer_charge),s.order_ref,"Store order failed; customer DGM Wallet refunded.");
            }
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

  app.get("/api/agent/store", requireCustomer, async (req,res)=>{try{const a=await getAgent(req.session.customerId);if(!a||a.status!=="approved")return res.status(403).json({success:false,message:"Approved agent account required."});let slug=a.store_slug||("agent-"+a.agent_code.toLowerCase().replace(/[^a-z0-9]+/g,"-"));if(!a.store_slug)await pool.query("UPDATE agent_profiles SET store_slug=$1,store_name=$2,updated_at=NOW() WHERE id=$3",[slug,a.name||"DGM Agent Store",a.id]);const p=await pool.query("SELECT service,network,capacity,sale_price,COALESCE((SELECT COUNT(*)::int FROM agent_sales ss WHERE ss.agent_id=agent_pricing_rules.agent_id AND ss.network=agent_pricing_rules.network AND ss.capacity=agent_pricing_rules.capacity AND ss.status='Completed'),0) AS completed_sales FROM agent_pricing_rules WHERE agent_id=$1 ORDER BY network,capacity",[a.id]);res.json({success:true,store:{slug,name:a.store_name||a.name||"DGM Agent Store",bio:a.store_bio||"DGM services at your trusted agent price.",whatsapp:a.whatsapp_phone||a.phone,logo_url:a.store_logo_url||"",banner_url:a.store_banner_url||"",pricing:p.rows}})}catch(e){res.status(500).json({success:false,message:"Could not load store."})}});

  app.post("/api/agent/store", requireCustomer, async (req,res)=>{try{const a=await getAgent(req.session.customerId);if(!a||a.status!=="approved")throw new Error("Approved agent account required.");let name=String(req.body?.name||"").trim().slice(0,80),bio=String(req.body?.bio||"").trim().slice(0,300),wa=String(req.body?.whatsapp||a.phone||"").trim(),logo=String(req.body?.logo_url||"").trim().slice(0,1000),banner=String(req.body?.banner_url||"").trim().slice(0,1000);if(!name)name=a.name||"DGM Agent Store";if(!/^0[0-9]{9}$/.test(wa))throw new Error("Enter a valid Ghana WhatsApp number.");for(const [label,url] of [["Logo",logo],["Banner",banner]])if(url&&!url.toLowerCase().startsWith("https://"))throw new Error(label+" image must use a secure https:// URL.");let slug=String(req.body?.slug||a.store_slug||"").toLowerCase().replace(/[^a-z0-9-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,60);if(!slug)slug="agent-"+a.agent_code.toLowerCase();const clash=await pool.query("SELECT id FROM agent_profiles WHERE store_slug=$1 AND id<>$2",[slug,a.id]);if(clash.rows.length)throw new Error("That store link is already in use.");await pool.query("UPDATE agent_profiles SET store_slug=$1,store_name=$2,store_bio=$3,whatsapp_phone=$4,store_logo_url=$5,store_banner_url=$6,updated_at=NOW() WHERE id=$7",[slug,name,bio,wa,logo||null,banner||null,a.id]);res.json({success:true,store_url:"/store.html?slug="+encodeURIComponent(slug),message:"Agent Store updated."})}catch(e){res.status(400).json({success:false,message:e.message})}});

  app.post("/api/agent/pricing", requireCustomer, async (req,res)=>{try{const a=await getAgent(req.session.customerId);if(!a||a.status!=="approved")throw new Error("Approved agent account required.");const network=String(req.body?.network||"").trim(),capacity=String(req.body?.capacity||"").replace(/GB/i,"").trim(),price=money(req.body?.sale_price),base=money(await getRetailPrice(network,Number(capacity)));if(!base||price<=base)throw new Error("Selling price must be above the DGM price.");await pool.query("INSERT INTO agent_pricing_rules(agent_id,service,network,capacity,sale_price) VALUES($1,'Data',$2,$3,$4) ON CONFLICT(agent_id,service,network,capacity) DO UPDATE SET sale_price=EXCLUDED.sale_price",[a.id,network,capacity,price]);res.json({success:true,message:"Agent pricing saved."})}catch(e){res.status(400).json({success:false,message:e.message})}});

  app.get("/api/public/agent-store/:slug", async (req,res)=>{try{const slug=String(req.params.slug||"").toLowerCase();const q=await pool.query("SELECT a.id,a.agent_code,a.store_name,a.store_bio,a.whatsapp_phone,a.store_logo_url,a.store_banner_url,c.name,c.phone FROM agent_profiles a JOIN customers c ON c.id=a.customer_id WHERE a.store_slug=$1 AND a.status='approved' LIMIT 1",[slug]);if(!q.rows.length)return res.status(404).json({success:false,message:"Store not found."});const a=q.rows[0],p=await pool.query("SELECT service,network,capacity,sale_price,COALESCE((SELECT COUNT(*)::int FROM agent_sales ss WHERE ss.agent_id=agent_pricing_rules.agent_id AND ss.network=agent_pricing_rules.network AND ss.capacity=agent_pricing_rules.capacity AND ss.status='Completed'),0) AS completed_sales FROM agent_pricing_rules WHERE agent_id=$1 ORDER BY network,capacity",[a.id]);res.json({success:true,store:{agent_code:a.agent_code,name:a.store_name||a.name,bio:a.store_bio||"DGM Agent Store",whatsapp:a.whatsapp_phone||a.phone,logo_url:a.store_logo_url||"",banner_url:a.store_banner_url||"",pricing:p.rows}})}catch(e){res.status(500).json({success:false,message:"Could not load store."})}});
  // PUBLIC AGENT STORE PAYSTACK CHECKOUT (GUEST / NO DGM ACCOUNT REQUIRED)
  app.post("/api/public/agent-store/:slug/guest-order", async (req,res)=>{
    const slug=String(req.params.slug||"").trim().toLowerCase();
    const network=String(req.body?.network||"").trim();
    const capacity=String(req.body?.capacity||"").replace(/GB/i,"").trim();
    const phone=String(req.body?.phone||"").trim();
    const promo=String(req.body?.promo_code||"").trim().toUpperCase().slice(0,40);
    if(!slug||!["MTN","AirtelTigo","Telecel"].includes(network)) return res.status(400).json({success:false,message:"Select a valid network."});
    if(!/^\d+(?:\.\d+)?$/.test(capacity)||Number(capacity)<=0) return res.status(400).json({success:false,message:"Select a valid bundle."});
    if(!/^0\d{9}$/.test(phone)) return res.status(400).json({success:false,message:"Enter a valid Ghana recipient number."});
    const client=await pool.connect();
    try{
      await client.query("BEGIN");
      const a=(await client.query("SELECT a.*,c.name FROM agent_profiles a JOIN customers c ON c.id=a.customer_id WHERE a.store_slug=$1 AND a.status='approved' LIMIT 1 FOR UPDATE",[slug])).rows[0];
      if(!a) throw new Error("Store not found or unavailable.");
      const p=(await client.query("SELECT sale_price FROM agent_pricing_rules WHERE agent_id=$1 AND service='Data' AND network=$2 AND capacity=$3 LIMIT 1",[a.id,network,capacity])).rows[0];
      if(!p) throw new Error("This bundle is not available in this store.");
      const base=money(await getRetailPrice(network,Number(capacity)));
      const published=money(p.sale_price);
      if(!base||published<=base) throw new Error("This bundle is temporarily unavailable.");
      let netPrice=published;
      let promoRow=null;
      if(promo){
        promoRow=(await client.query("SELECT * FROM agent_promo_codes WHERE agent_id=$1 AND UPPER(code)=UPPER($2) AND active=true AND (expires_at IS NULL OR expires_at>NOW()) AND (max_uses IS NULL OR uses<max_uses) FOR UPDATE",[a.id,promo])).rows[0];
        if(!promoRow) throw new Error("Promo code is invalid or expired.");
        const discount=promoRow.discount_type==="percent" ? money(published*(Number(promoRow.discount_value)/100)) : money(promoRow.discount_value);
        netPrice=money(Math.max(base,published-discount));
        if(netPrice>=published) throw new Error("Promo code does not reduce this order.");
      }
      const orderRef="DGM-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(5).toString("hex").toUpperCase();
      const guestToken=crypto.randomBytes(32).toString("hex");
      const tokenHash=crypto.createHash("sha256").update(guestToken).digest("hex");
      let supplierCost=null;
      try{
        const configured=JSON.parse(String(process.env.DATAMART_BUNDLE_COSTS_JSON||"{}"));
        const candidate=configured?.[network]?.[String(Number(capacity))];
        if(candidate!==undefined&&candidate!==null&&candidate!==""&&Number.isFinite(Number(candidate))&&Number(candidate)>0) supplierCost=money(candidate);
      }catch(e){console.error("DataMart cost config could not be read for agent store:",e.message)}
      const order=(await client.query(`INSERT INTO orders
        (order_ref,customer_id,service,network,phone,amount,status,capacity,payment_status,base_amount,promo_discount,guest_token_hash,
         supplier_cost,dgm_gross_profit,supplier_settlement_status)
        VALUES($1,NULL,'Data Bundle',$2,$3,$4,'Pending Payment',$5,'Pending',$6,$7,$8,$9,$10,$11)
        RETURNING id,order_ref,service,network,phone,amount,status,capacity,payment_status,created_at`,
        [orderRef,network,phone,netPrice,capacity,published,money(published-netPrice),tokenHash,
         supplierCost,supplierCost===null?null:money(netPrice-supplierCost),supplierCost===null?"cost_unconfigured":"awaiting_settlement"])).rows[0];
      await client.query(`INSERT INTO agent_sales
        (agent_id,order_id,order_ref,service,network,phone,capacity,base_cost,sale_price,profit,status,customer_payment_mode,customer_charge)
        VALUES($1,$2,$3,'Data',$4,$5,$6,$7,$8,$9,'Processing','store_paystack',$10)`,
        [a.id,order.id,orderRef,network,phone,capacity,base,netPrice,money(netPrice-base),netPrice]);
      if(promoRow) await client.query("UPDATE agent_promo_codes SET uses=uses+1 WHERE id=$1",[promoRow.id]);
      await client.query("COMMIT");
      return res.json({success:true,guest:true,guest_token:guestToken,order,store_name:a.store_name||a.name});
    }catch(e){
      await client.query("ROLLBACK").catch(()=>{});
      return res.status(400).json({success:false,message:e.message||"Could not create agent store order."});
    }finally{client.release();}
  });


  // Dedicated public Agent Store Mobile Money checkout, isolated from normal guest checkout.
  async function findPublicStoreOrder(slug, orderRef, guestToken) {
    const tokenHash = crypto.createHash("sha256").update(guestToken).digest("hex");
    const q = await pool.query(
      `SELECT o.*, s.id AS agent_sale_id, s.agent_id, s.status AS agent_sale_status
       FROM orders o
       JOIN agent_sales s ON s.order_id=o.id AND s.customer_payment_mode='store_paystack'
       JOIN agent_profiles a ON a.id=s.agent_id AND a.store_slug=$1
       WHERE UPPER(o.order_ref)=$2 AND o.customer_id IS NULL AND o.guest_token_hash=$3
       LIMIT 1`,
      [slug, orderRef, tokenHash]
    );
    return q.rows[0] || null;
  }

  app.post("/api/public/agent-store/:slug/checkout/mobile-money", async (req,res) => {
    let order = null, reference = "";
    try {
      if (!paystackSecretKey) return res.status(503).json({success:false,message:"Agent Store Mobile Money payments are not configured."});
      const slug=String(req.params.slug||"").trim().toLowerCase();
      const orderRef=String(req.body?.orderRef||"").trim().toUpperCase();
      const guestToken=String(req.body?.guestToken||"").trim();
      const phone=String(req.body?.phone||"").trim().replace(/\s+/g,"");
      const provider=String(req.body?.provider||"").trim().toLowerCase();
      if(!slug||!/^DGM-[A-Z0-9]+-[A-Z0-9]+$/.test(orderRef)) return res.status(400).json({success:false,message:"Agent Store order details are invalid."});
      if(!/^[a-f0-9]{64}$/i.test(guestToken)) return res.status(403).json({success:false,message:"Secure Agent Store tracking session is invalid. Recreate the order."});
      if(!/^0\d{9}$/.test(phone)) return res.status(400).json({success:false,message:"Enter a valid Ghana Mobile Money phone number."});
      if(!["mtn","atl","vod"].includes(provider)) return res.status(400).json({success:false,message:"Choose MTN MoMo, AT Money, or Telecel Cash."});
      order=await findPublicStoreOrder(slug,orderRef,guestToken);
      if(!order) return res.status(404).json({success:false,message:"Agent Store order not found."});
      if(String(order.payment_status||"").toLowerCase()==="paid") return res.json({success:true,alreadyPaid:true,order:{order_ref:order.order_ref}});
      if(String(order.status||"").toLowerCase()!=="pending payment") return res.status(409).json({success:false,message:"This order is no longer awaiting payment."});
      if(order.paystack_reference) return res.status(409).json({success:false,message:"A payment attempt already exists. Open your Agent Store tracking link before trying again."});
      const amount=Number(order.amount);
      if(!Number.isFinite(amount)||amount<=0) return res.status(400).json({success:false,message:"Order amount is invalid."});
      reference="DGM-STORE-MOMO-"+Date.now().toString(36).toUpperCase()+"-"+crypto.randomBytes(5).toString("hex").toUpperCase();
      const email="store-"+phone.replace(/\D/g,"")+"@dhegeniusmedia.com";
      const saved=await pool.query("UPDATE orders SET paystack_reference=$1,guest_email=$2 WHERE id=$3 AND customer_id IS NULL AND guest_token_hash=$4 AND paystack_reference IS NULL AND LOWER(COALESCE(payment_status,'pending'))<>'paid' AND status='Pending Payment'",[reference,email,order.id,crypto.createHash("sha256").update(guestToken).digest("hex")]);
      if(saved.rowCount!==1) return res.status(409).json({success:false,message:"Order status changed. Refresh your tracking link."});
      const response=await fetch("https://api.paystack.co/charge",{method:"POST",headers:{Authorization:"Bearer "+paystackSecretKey,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({email,amount:String(Math.round(amount*100)),currency:"GHS",reference,mobile_money:{phone,provider},metadata:{type:"agent_store_guest_order",order_ref:order.order_ref,agent_id:order.agent_id,network:order.network,capacity:order.capacity,store_slug:slug}})});
      const raw=await response.text();let payload={};try{payload=JSON.parse(raw)}catch{}
      if(!response.ok||!payload.status||!payload.data?.reference){
        await pool.query("UPDATE orders SET paystack_reference=NULL,guest_email=NULL WHERE id=$1 AND paystack_reference=$2 AND LOWER(COALESCE(payment_status,'pending'))<>'paid'",[order.id,reference]);
        return res.status(502).json({success:false,message:payload.message||"Paystack could not start the Agent Store Mobile Money request. Please try again."});
      }
      return res.json({success:true,reference:payload.data.reference,status:payload.data.status||"pending",display_text:payload.data.display_text||payload.message||"Approve the Mobile Money request on your phone."});
    }catch(e){console.error("Agent Store Mobile Money initialization:",e.message);return res.status(500).json({success:false,message:reference?"Payment prompt response could not be confirmed. Open your Agent Store tracking link before retrying.":"Could not start Mobile Money payment."})}
  });

  app.post("/api/public/agent-store/:slug/checkout/mobile-money/otp", async (req,res) => {
    try {
      if(!paystackSecretKey)return res.status(503).json({success:false,message:"Agent Store payment authorization is not configured."});
      const slug=String(req.params.slug||"").trim().toLowerCase(),orderRef=String(req.body?.orderRef||"").trim().toUpperCase(),guestToken=String(req.body?.guestToken||"").trim(),reference=String(req.body?.reference||"").trim(),otp=String(req.body?.otp||"").trim();
      if(!/^DGM-[A-Z0-9]+-[A-Z0-9]+$/.test(orderRef)||!/^[a-f0-9]{64}$/i.test(guestToken)||!reference)return res.status(400).json({success:false,message:"Agent Store payment details are incomplete."});
      if(!/^\d{4,8}$/.test(otp))return res.status(400).json({success:false,message:"Enter the authorization code supplied for this payment."});
      const order=await findPublicStoreOrder(slug,orderRef,guestToken);
      if(!order)return res.status(404).json({success:false,message:"Agent Store order not found."});
      if(order.paystack_reference!==reference)return res.status(403).json({success:false,message:"Payment reference does not belong to this Agent Store order."});
      if(String(order.payment_status||"").toLowerCase()==="paid")return res.json({success:true,status:"success",message:"Payment is already confirmed."});
      const response=await fetch("https://api.paystack.co/charge/submit_otp",{method:"POST",headers:{Authorization:"Bearer "+paystackSecretKey,"Content-Type":"application/json",Accept:"application/json"},body:JSON.stringify({reference,otp})});
      const raw=await response.text();let payload={};try{payload=JSON.parse(raw)}catch{}
      if(!response.ok||!payload.status||!payload.data)return res.status(502).json({success:false,message:payload.message||"Paystack could not authorize this payment."});
      return res.json({success:true,status:String(payload.data.status||"pending").toLowerCase(),reference:payload.data.reference||reference,display_text:payload.data.display_text||payload.data.message||payload.message||"Authorization submitted. Checking payment."});
    }catch(e){console.error("Agent Store OTP:",e.message);return res.status(500).json({success:false,message:"Could not submit the authorization code."})}
  });


  // ADMIN reconciliation for an order whose customer delivery has already been confirmed.
  // This deliberately does NOT call DataMart or initiate another payment/refund.
  app.post("/api/admin/agent-store/orders/:orderRef/confirm-delivered", requireAdmin, async (req,res) => {
    const orderRef=String(req.params.orderRef||"").trim().toUpperCase();
    const c=await pool.connect();
    let saleId=null;
    try {
      await c.query("BEGIN");
      const row=(await c.query(
        `SELECT o.id,o.order_ref,o.status,o.payment_status,o.paystack_reference,o.customer_id,
                s.id AS sale_id,s.status AS sale_status,s.customer_payment_mode
         FROM orders o JOIN agent_sales s ON s.order_id=o.id
         WHERE o.order_ref=$1 AND o.customer_id IS NULL
         FOR UPDATE OF o,s`,[orderRef]
      )).rows[0];
      if(!row) throw new Error("Agent Store order or linked agent sale was not found.");
      if(String(row.payment_status||"").toLowerCase()!=="paid" || !row.paystack_reference)
        throw new Error("The original Agent Store payment is not recorded as paid.");
      if(row.customer_payment_mode!=="store_paystack")
        throw new Error("This reconciliation is only for Paystack Agent Store sales.");
      if(["refunded","refund complete","cancelled","canceled","failed"].includes(String(row.status||"").toLowerCase()) ||
         ["refunded","failed","cancelled","canceled"].includes(String(row.sale_status||"").toLowerCase()))
        throw new Error("This order or sale is marked failed/refunded and cannot be completed here.");
      if(String(row.sale_status||"").toLowerCase()==="completed") {
        await c.query("COMMIT");
        return res.json({success:true,already_completed:true,message:"This sale is already completed; no additional commission was credited."});
      }
      if(String(row.sale_status||"").toLowerCase()!=="processing")
        throw new Error("The agent sale is not in Processing status and requires manual review.");
      saleId=row.sale_id;
      await c.query(
        `UPDATE orders SET status='Completed',provider_status='delivered',
          provider_message=$1 WHERE id=$2`,
        ["Admin-confirmed customer delivery; reconciled without retrying fulfillment.",row.id]
      );
      await c.query("COMMIT");
      const credited=await completeAgentSale(saleId);
      const final=(await pool.query(
        `SELECT o.order_ref,o.status,o.payment_status,o.provider_status,
                s.status AS agent_sale_status,s.profit,
                a.commission_balance
         FROM orders o JOIN agent_sales s ON s.order_id=o.id
         JOIN agent_profiles a ON a.id=s.agent_id WHERE o.order_ref=$1 LIMIT 1`,[orderRef]
      )).rows[0];
      if(!final || String(final.agent_sale_status).toLowerCase()!=="completed")
        return res.status(502).json({success:false,message:"Order delivery was recorded, but commission completion did not confirm. Do not retry fulfillment; inspect the agent sale before further action."});
      return res.json({success:true,commission_credited:credited,order:final,
        message:credited?"Delivery reconciled; the agent sale was completed and its commission credited once.":"Sale is completed; no duplicate commission was issued."});
    } catch(e) {
      await c.query("ROLLBACK").catch(()=>{});
      console.error("Agent Store delivered-order reconciliation:",orderRef,e.message);
      return res.status(400).json({success:false,message:e.message||"Could not reconcile delivered Agent Store order."});
    } finally { c.release(); }
  });

  // ADMIN-ONLY RECOVERY FOR A VERIFIED, PAID AGENT STORE ORDER.
  // This does not charge the customer or automatically issue a refund.
  app.post("/api/admin/agent-store/orders/:orderRef/recover-delivery", requireAdmin, async (req,res) => {
    const orderRef=String(req.params.orderRef||"").trim().toUpperCase();
    const newPhone=String(req.body?.phone||"").trim();
    if(!/^DGM-[A-Z0-9]+-[A-Z0-9]+$/.test(orderRef)) return res.status(400).json({success:false,message:"Invalid order reference."});
    if(!/^0\d{9}$/.test(newPhone)) return res.status(400).json({success:false,message:"Enter a valid Ghana phone number."});
    if(!paystackSecretKey) return res.status(503).json({success:false,message:"Paystack verification is not configured."});

    const c=await pool.connect();
    let order=null;
    try {
      // Verify against Paystack before touching the order.
      const initial=(await c.query(
        `SELECT o.*, s.id AS agent_sale_id, s.status AS agent_sale_status
         FROM orders o LEFT JOIN agent_sales s ON s.order_id=o.id
         WHERE o.order_ref=$1 AND o.customer_id IS NULL LIMIT 1`,[orderRef]
      )).rows[0];
      if(!initial) return res.status(404).json({success:false,message:"Agent Store order not found."});
      if(String(initial.payment_status||"").toLowerCase()!=="paid" || !initial.paystack_reference)
        return res.status(409).json({success:false,message:"The original order is not recorded as paid."});

      const response=await fetch("https://api.paystack.co/transaction/verify/"+encodeURIComponent(initial.paystack_reference),{
        headers:{Authorization:"Bearer "+paystackSecretKey,Accept:"application/json"}
      });
      const raw=await response.text();let payload={};try{payload=JSON.parse(raw)}catch{}
      if(!response.ok||!payload.status||!payload.data)
        return res.status(502).json({success:false,message:"Paystack could not verify the original payment. No changes were made."});
      const tx=payload.data;
      if(String(tx.reference||"")!==String(initial.paystack_reference) ||
         String(tx.status||"").toLowerCase()!=="success" ||
         String(tx.currency||"").toUpperCase()!=="GHS" ||
         Math.round(Number(tx.amount||0))!==Math.round(Number(initial.amount||0)*100))
        return res.status(409).json({success:false,message:"Paystack payment details do not match this order. No changes were made."});

      await c.query("BEGIN");
      const locked=(await c.query(
        `SELECT o.*, s.id AS agent_sale_id, s.status AS agent_sale_status
         FROM orders o LEFT JOIN agent_sales s ON s.order_id=o.id
         WHERE o.id=$1 FOR UPDATE OF o`,[initial.id]
      )).rows[0];
      if(!locked) throw new Error("Order no longer exists.");
      if(String(locked.payment_status||"").toLowerCase()!=="paid") throw new Error("Order is no longer marked paid.");
      if(locked.datamart_purchase_id || locked.datamart_reference) throw new Error("A DataMart purchase/reference already exists. Automatic retry is blocked to prevent duplicate delivery; reconcile the existing purchase instead.");
      if(String(locked.status||"").toLowerCase()==="recovery in progress") throw new Error("Recovery is already in progress.");
      if(["completed","delivered","success","successful"].includes(String(locked.status||"").toLowerCase())) throw new Error("Order is already marked delivered.");
      if(String(locked.guest_refund_status||"").toLowerCase()==="refunded" || locked.customer_refunded===true) throw new Error("This order appears refunded; manual review is required before delivery.");

      await c.query(
        `UPDATE orders SET phone=$1,status='Recovery In Progress',
          provider_message='Admin recovery: original Paystack payment re-verified; delivery retry in progress. No new customer charge.',
          guest_refund_status='delivery_recovery'
         WHERE id=$2`,[newPhone,locked.id]
      );
      if(locked.agent_sale_id) {
        await c.query("UPDATE agent_sales SET phone=$1,status='Processing' WHERE id=$2 AND status<>'Completed'",[newPhone,locked.agent_sale_id]);
      }
      await c.query("COMMIT");
      order=(await pool.query("SELECT * FROM orders WHERE id=$1",[locked.id])).rows[0];
    } catch(e) {
      try{await c.query("ROLLBACK")}catch{}
      return res.status(409).json({success:false,message:e.message||"Could not safely prepare this order for recovery."});
    } finally { c.release(); }

    try {
      const fulfillment=await fulfillDataOrder(order);
      const finalStatus=String(fulfillment?.status||"").toLowerCase();
      if(!fulfillment?.success || finalStatus==="failed") {
        await pool.query(
          `UPDATE orders SET status='Refund Pending',guest_refund_status='needs_review',
            provider_message=$1 WHERE id=$2 AND status='Recovery In Progress'`,
          ["Delivery recovery did not confirm success. No automatic refund or additional charge was initiated; DGM support must review.",order.id]
        );
        return res.status(502).json({success:false,delivery:"not_confirmed",order_ref:order.order_ref,message:"Delivery was not confirmed. No refund was attempted and no new payment was taken. DGM support must review before another retry."});
      }
      const latest=(await pool.query("SELECT * FROM orders WHERE id=$1",[order.id])).rows[0];
      try { await initiateGuestSupplierTransfer(latest); }
      catch(e) { console.error("Agent Store recovery supplier transfer:",order.order_ref,e.message); }
      if(["completed","success","successful","delivered"].includes(finalStatus) && order.agent_sale_id) await completeAgentSale(order.agent_sale_id);
      const safe=(await pool.query("SELECT order_ref,service,network,phone,amount,status,capacity,payment_status,paid_at,provider_status,provider_message,datamart_purchase_id,datamart_reference,datamart_status FROM orders WHERE id=$1",[order.id])).rows[0];
      return res.json({success:true,delivery:finalStatus||"processing",message:"Recovery submitted using the original verified payment. No additional customer payment was taken.",order:safe});
    } catch(e) {
      console.error("Agent Store admin delivery recovery:",order?.order_ref,e.message);
      await pool.query(
        `UPDATE orders SET status='Refund Pending',guest_refund_status='needs_review',
          provider_message=$1 WHERE id=$2 AND status='Recovery In Progress'`,
        ["Delivery recovery failed before success could be confirmed. No automatic refund or additional charge was initiated; DGM support must review.",order.id]
      ).catch(()=>{});
      return res.status(502).json({success:false,delivery:"not_confirmed",message:"Delivery could not be confirmed. No refund was attempted and no new payment was taken; DGM support must review before another retry."});
    }
  });

  app.post("/api/public/agent-store/:slug/checkout/verify", async (req,res) => {
    try {
      if(!paystackSecretKey)return res.status(503).json({success:false,message:"Agent Store payment verification is not configured."});
      const slug=String(req.params.slug||"").trim().toLowerCase(),orderRef=String(req.body?.orderRef||"").trim().toUpperCase(),guestToken=String(req.body?.guestToken||"").trim(),reference=String(req.body?.reference||"").trim();
      if(!/^DGM-[A-Z0-9]+-[A-Z0-9]+$/.test(orderRef)||!/^[a-f0-9]{64}$/i.test(guestToken)||!reference)return res.status(400).json({success:false,message:"Agent Store verification details are incomplete."});
      const order=await findPublicStoreOrder(slug,orderRef,guestToken);
      if(!order)return res.status(404).json({success:false,message:"Agent Store order not found."});
      if(String(order.payment_status||"").toLowerCase()==="paid")return res.json({success:true,verified:true,order:{order_ref:order.order_ref,status:order.status,payment_status:order.payment_status}});
      if(!order.paystack_reference||reference!==order.paystack_reference)return res.status(403).json({success:false,message:"Payment reference does not belong to this Agent Store order."});
      const response=await fetch("https://api.paystack.co/transaction/verify/"+encodeURIComponent(reference),{method:"GET",headers:{Authorization:"Bearer "+paystackSecretKey,Accept:"application/json"}});
      const raw=await response.text();let payload={};try{payload=JSON.parse(raw)}catch{}
      if(!response.ok||!payload.status||!payload.data)return res.status(502).json({success:false,message:"Paystack could not verify this payment yet. Keep this page open."});
      const tx=payload.data;
      if(String(tx.reference||"")!==reference)return res.status(400).json({success:false,message:"Paystack reference mismatch."});
      if(String(tx.status||"").toLowerCase()!=="success")return res.status(202).json({success:true,verified:false,order:{order_ref:order.order_ref,status:order.status,payment_status:order.payment_status}});
      if(String(tx.currency||"").toUpperCase()!=="GHS"||Math.round(Number(tx.amount||0))!==Math.round(Number(order.amount||0)*100))return res.status(400).json({success:false,message:"Payment amount or currency does not match this Agent Store order. Contact DGM support."});
      const marked=await pool.query("UPDATE orders SET payment_status='Paid',paid_at=COALESCE(paid_at,NOW()),status=CASE WHEN status='Pending Payment' THEN 'Processing' ELSE status END WHERE id=$1 AND customer_id IS NULL AND LOWER(COALESCE(payment_status,'pending'))<>'paid' AND paystack_reference=$2 RETURNING id",[order.id,reference]);
      if(marked.rowCount===1){
        const updated=(await pool.query("SELECT * FROM orders WHERE id=$1 LIMIT 1",[order.id])).rows[0];
        try{
          const fulfillment=await fulfillDataOrder(updated);
          if(!fulfillment?.success||String(fulfillment?.status||"").toLowerCase()==="failed"){
            await pool.query("UPDATE agent_sales SET status='Refunded' WHERE id=$1 AND customer_payment_mode='store_paystack'",[order.agent_sale_id]);
            await initiateGuestPaystackRefund(order.id,fulfillment.error||"Agent Store data delivery failed.");
          }else{
            const latest=(await pool.query("SELECT * FROM orders WHERE id=$1 LIMIT 1",[order.id])).rows[0];
            await initiateGuestSupplierTransfer(latest);
            if(["completed","success","successful","delivered"].includes(String(fulfillment?.status||"").toLowerCase()))await completeAgentSale(order.agent_sale_id);
          }
        }catch(e){console.error("Agent Store fulfillment after verified payment:",order.order_ref,e.message);await pool.query("UPDATE agent_sales SET status='Refunded' WHERE id=$1 AND customer_payment_mode='store_paystack'",[order.agent_sale_id]);await initiateGuestPaystackRefund(order.id,e.message||"Agent Store data delivery failed.");}
      }
      const latest=await pool.query("SELECT order_ref,service,network,phone,amount,status,capacity,payment_status,paid_at,provider_status,provider_message,created_at,completed_at FROM orders WHERE id=$1",[order.id]);
      return res.json({success:true,verified:true,order:latest.rows[0]});
    }catch(e){console.error("Agent Store payment verification:",e.message);return res.status(500).json({success:false,message:"Could not verify this Agent Store payment yet."})}
  });

  app.post("/api/public/agent-store/:slug/checkout/status", async (req,res) => {
    try{
      const slug=String(req.params.slug||"").trim().toLowerCase(),orderRef=String(req.body?.orderRef||"").trim().toUpperCase(),guestToken=String(req.body?.guestToken||"").trim();
      if(!/^DGM-[A-Z0-9]+-[A-Z0-9]+$/.test(orderRef)||!/^[a-f0-9]{64}$/i.test(guestToken))return res.status(400).json({success:false,message:"Agent Store order details are invalid."});
      const order=await findPublicStoreOrder(slug,orderRef,guestToken);
      if(!order)return res.status(404).json({success:false,message:"Agent Store order not found. Check your tracking link."});
      const safe=(await pool.query("SELECT order_ref,service,network,phone,amount,status,capacity,payment_status,paid_at,provider_status,provider_message,created_at,completed_at FROM orders WHERE id=$1",[order.id])).rows[0];
      return res.json({success:true,order:safe});
    }catch(e){console.error("Agent Store status:",e.message);return res.status(500).json({success:false,message:"Could not load Agent Store order status."})}
  });


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
      if(!base||published<=base) throw new Error("This bundle is temporarily unavailable.");
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
      try{result=await fulfillDataOrder({id:orderId,order_ref:orderRef,customer_id:customer.id,service:"Data",network,phone,amount:netPrice,base_amount:base,supplier_cost:base,status:"Processing",payment_status:"Paid",capacity});}
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


  // AGENT BUSINESS MANAGEMENT — DataMart-style parity without copying DataMart branding
  app.get("/api/agent/transactions", requireCustomer, async (req,res)=>{
    try{
      const a=await getAgent(req.session.customerId);
      if(!a) return res.status(404).json({success:false,message:"Agent account not found."});
      const [wallet,commission]=await Promise.all([
        pool.query(`SELECT type,amount,balance_before,balance_after,description,reference,created_at FROM agent_wallet_transactions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 100`,[a.id]),
        pool.query(`SELECT type,amount,balance_before,balance_after,description,reference,created_at FROM agent_commission_transactions WHERE agent_id=$1 ORDER BY created_at DESC LIMIT 100`,[a.id])
      ]);
      res.json({success:true,wallet:wallet.rows,commission:commission.rows});
    }catch(e){res.status(500).json({success:false,message:"Could not load agent transactions."});}
  });

  app.post("/api/agent/promos", requireCustomer, async (req,res)=>{
    try{
      const a=await getAgent(req.session.customerId); if(!a||a.status!=="approved") throw new Error("Approved agent account required.");
      const code=String(req.body?.code||"").trim().toUpperCase().replace(/[^A-Z0-9_-]/g,"").slice(0,32);
      const type=String(req.body?.discount_type||"fixed").toLowerCase();
      const value=money(req.body?.discount_value), maxUses=req.body?.max_uses?Number(req.body.max_uses):null;
      const expires=req.body?.expires_at?new Date(req.body.expires_at):null;
      if(!code||code.length<3) throw new Error("Promo code must be at least 3 characters.");
      if(!["fixed","percent"].includes(type)||!Number.isFinite(value)||value<=0) throw new Error("Enter a valid discount.");
      if(type==="percent"&&value>100) throw new Error("Percentage discount cannot exceed 100%.");
      if(maxUses!==null&&(!Number.isInteger(maxUses)||maxUses<1)) throw new Error("Maximum uses must be a positive whole number.");
      if(expires&&Number.isNaN(expires.getTime())) throw new Error("Invalid expiry date.");
      await pool.query(`INSERT INTO agent_promo_codes(agent_id,code,discount_type,discount_value,max_uses,expires_at) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(agent_id,code) DO UPDATE SET discount_type=EXCLUDED.discount_type,discount_value=EXCLUDED.discount_value,max_uses=EXCLUDED.max_uses,expires_at=EXCLUDED.expires_at,active=true`,[a.id,code,type,value,maxUses,expires]);
      res.json({success:true,message:"Promo code saved."});
    }catch(e){res.status(400).json({success:false,message:e.message||"Could not save promo code."});}
  });

  app.post("/api/agent/promos/:id/toggle", requireCustomer, async (req,res)=>{
    try{const a=await getAgent(req.session.customerId);if(!a)throw new Error("Agent account not found.");const r=await pool.query(`UPDATE agent_promo_codes SET active=NOT active WHERE id=$1 AND agent_id=$2 RETURNING active`,[Number(req.params.id),a.id]);if(!r.rows.length)throw new Error("Promo code not found.");res.json({success:true,message:r.rows[0].active?"Promo activated.":"Promo deactivated."});}catch(e){res.status(400).json({success:false,message:e.message});}
  });

  // AGENT TEAM / CRM
  app.get("/api/agent/team", requireCustomer, async (req,res)=>{
    try{
      const a=await getAgent(req.session.customerId);
      if(!a||a.status!=="approved") throw new Error("Approved agent account required.");
      const rows=await pool.query(`SELECT id,name,phone,email,status,commission_rate,invite_code,created_at,joined_at
        FROM agent_subagents WHERE parent_agent_id=$1 ORDER BY created_at DESC`,[a.id]);
      res.json({success:true,agents:rows.rows});
    }catch(e){res.status(400).json({success:false,message:e.message||"Could not load sub-agents."});}
  });
  app.post("/api/agent/team/invite", requireCustomer, async (req,res)=>{
    try{
      const a=await getAgent(req.session.customerId);
      if(!a||a.status!=="approved") throw new Error("Approved agent account required.");
      const name=String(req.body?.name||"").trim().slice(0,100);
      const phone=String(req.body?.phone||"").trim();
      const email=String(req.body?.email||"").trim().slice(0,160);
      const rate=money(req.body?.commission_rate);
      if(!name) throw new Error("Enter the sub-agent name.");
      if(phone&&!/^0\d{9}$/.test(phone)) throw new Error("Enter a valid Ghana phone number.");
      if(email&&!/^\\S+@\\S+\\.\\S+$/.test(email)) throw new Error("Enter a valid email address.");
      if(rate<0||rate>100) throw new Error("Commission rate must be between 0% and 100%.");
      const code="DGM-SUB-"+crypto.randomBytes(4).toString("hex").toUpperCase();
      const row=(await pool.query(`INSERT INTO agent_subagents(parent_agent_id,name,phone,email,status,invite_code,commission_rate)
        VALUES($1,$2,$3,$4,'invited',$5,$6) RETURNING id,name,phone,email,status,invite_code,commission_rate,created_at`,
        [a.id,name,phone||null,email||null,code,rate])).rows[0];
      res.json({success:true,message:"Sub-agent invitation created.",agent:row});
    }catch(e){res.status(400).json({success:false,message:e.message||"Could not create invitation."});}
  });
  app.post("/api/agent/team/:id/toggle", requireCustomer, async (req,res)=>{
    try{
      const a=await getAgent(req.session.customerId);
      if(!a||a.status!=="approved") throw new Error("Approved agent account required.");
      const id=Number(req.params.id);
      const r=await pool.query(`UPDATE agent_subagents SET status=CASE WHEN status='active' THEN 'suspended' ELSE 'active' END
        WHERE id=$1 AND parent_agent_id=$2 RETURNING status`,[id,a.id]);
      if(!r.rows.length) throw new Error("Sub-agent not found.");
      res.json({success:true,message:"Sub-agent status updated.",status:r.rows[0].status});
    }catch(e){res.status(400).json({success:false,message:e.message});}
  });

  app.get("/api/agent/customers", requireCustomer, async (req,res)=>{
    try{
      const a=await getAgent(req.session.customerId);
      if(!a||a.status!=="approved") throw new Error("Approved agent account required.");
      const rows=await pool.query(`SELECT phone,MAX(created_at) AS last_order,COUNT(*)::int AS orders,
        COALESCE(SUM(customer_charge),0) AS spent,COALESCE(SUM(profit),0) AS profit
        FROM agent_sales WHERE agent_id=$1 AND customer_charge>0 GROUP BY phone ORDER BY last_order DESC LIMIT 200`,[a.id]);
      res.json({success:true,customers:rows.rows});
    }catch(e){res.status(400).json({success:false,message:e.message});}
  });

  app.get("/api/agent/promos", requireCustomer, async (req,res)=>{
    try{
      const a=await getAgent(req.session.customerId);
      if(!a||a.status!=="approved") throw new Error("Approved agent account required.");
      const rows=await pool.query(`SELECT id,code,discount_type,discount_value,max_uses,uses,active,expires_at
        FROM agent_promo_codes WHERE agent_id=$1 ORDER BY id DESC`,[a.id]);
      res.json({success:true,promos:rows.rows});
    }catch(e){res.status(400).json({success:false,message:e.message});}
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
