const express = require("express");
const crypto = require("crypto");
const { Pool } = require("pg");

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
      max: 5,
      connectionTimeoutMillis: 10000
    })
  : null;

let readyPromise = null;

async function ensureMarketDatabase() {
  if (!pool) throw new Error("Database is not configured.");
  if (!readyPromise) {
    readyPromise = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_categories (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          slug TEXT NOT NULL UNIQUE,
          icon TEXT DEFAULT '🛍️',
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_products (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          description TEXT DEFAULT '',
          category_id INTEGER REFERENCES market_categories(id) ON DELETE SET NULL,
          brand TEXT DEFAULT '',
          sku TEXT UNIQUE,
          price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
          sale_price NUMERIC(12,2),
          stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
          image_url TEXT DEFAULT '',
          gallery JSONB NOT NULL DEFAULT '[]'::jsonb,
          variants JSONB NOT NULL DEFAULT '[]'::jsonb,
          delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
          rating NUMERIC(3,2) NOT NULL DEFAULT 0,
          review_count INTEGER NOT NULL DEFAULT 0,
          featured BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_wishlists (
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY(customer_id, product_id)
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_reviews (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          product_id INTEGER NOT NULL REFERENCES market_products(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
          title TEXT DEFAULT '',
          body TEXT DEFAULT '',
          verified_purchase BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(customer_id, product_id)
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_orders (
          id SERIAL PRIMARY KEY,
          order_ref TEXT NOT NULL UNIQUE,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          subtotal NUMERIC(12,2) NOT NULL,
          delivery_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
          total NUMERIC(12,2) NOT NULL,
          payment_method TEXT NOT NULL DEFAULT 'Wallet',
          payment_status TEXT NOT NULL DEFAULT 'Paid',
          status TEXT NOT NULL DEFAULT 'Pending',
          delivery_name TEXT NOT NULL,
          delivery_phone TEXT NOT NULL,
          delivery_address TEXT NOT NULL,
          notes TEXT DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_order_items (
          id SERIAL PRIMARY KEY,
          market_order_id INTEGER NOT NULL REFERENCES market_orders(id) ON DELETE CASCADE,
          product_id INTEGER REFERENCES market_products(id) ON DELETE SET NULL,
          product_name TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          unit_price NUMERIC(12,2) NOT NULL,
          line_total NUMERIC(12,2) NOT NULL,
          variant JSONB NOT NULL DEFAULT '{}'::jsonb
        );
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS market_wallet_transactions (
          id SERIAL PRIMARY KEY,
          market_order_id INTEGER REFERENCES market_orders(id) ON DELETE SET NULL,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          amount NUMERIC(12,2) NOT NULL,
          balance_before NUMERIC(12,2) NOT NULL,
          balance_after NUMERIC(12,2) NOT NULL,
          transaction_ref TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);

      const categories = [
        ["Phones & Accessories","phones-accessories","📱"],
        ["Electronics","electronics","💻"],
        ["Fashion","fashion","👕"],
        ["Beauty & Personal Care","beauty","💄"],
        ["Home & Kitchen","home-kitchen","🏠"],
        ["Gaming","gaming","🎮"],
        ["Computer & Tech","computer-tech","🖥️"],
        ["Deals","deals","🔥"]
      ];
      for (const [name, slug, icon] of categories) {
        await pool.query(
          `INSERT INTO market_categories(name,slug,icon) VALUES($1,$2,$3)
           ON CONFLICT(slug) DO NOTHING`,
          [name, slug, icon]
        );
      }

      const demo = [
        ["DGM Wireless Earbuds","dgm-wireless-earbuds","Premium wireless earbuds with charging case.","Electronics","DGM","59.00",49, "https://images.unsplash.com/photo-1606220945770-b5b6c2c55bf1?auto=format&fit=crop&w=800&q=80",true],
        ["Fast USB-C Power Bank","fast-usbc-power-bank","Portable fast-charging power bank for phones and tablets.","Electronics","DGM","149.00",35,"https://images.unsplash.com/photo-1609592424896-8e8c0b7d5f0e?auto=format&fit=crop&w=800&q=80",true],
        ["Smart Phone Stand","smart-phone-stand","Adjustable desktop phone stand for home and office.","Home & Kitchen","DGM","45.00",60,"https://images.unsplash.com/photo-1586953208448-b95a79798f07?auto=format&fit=crop&w=800&q=80",false],
        ["Classic Unisex Backpack","classic-unisex-backpack","Durable everyday backpack for school, work and travel.","Fashion","DGM","120.00",25,"https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=800&q=80",false],
        ["Bluetooth Mini Speaker","bluetooth-mini-speaker","Compact Bluetooth speaker with strong portable sound.","Electronics","DGM","85.00",40,"https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?auto=format&fit=crop&w=800&q=80",true]
      ];
      for (const item of demo) {
        const [name,slug,description,categoryName,brand,price,stock,image,featured] = item;
        const cat = await pool.query("SELECT id FROM market_categories WHERE name=$1 LIMIT 1",[categoryName]);
        await pool.query(
          `INSERT INTO market_products(name,slug,description,category_id,brand,price,stock,image_url,featured)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT(slug) DO NOTHING`,
          [name,slug,description,cat.rows[0]?.id || null,brand,price,stock,image,featured]
        );
      }
    })().catch(error => {
      readyPromise = null;
      throw error;
    });
  }
  return readyPromise;
}

function sendError(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function requireLogin(req,res,next) {
  if (!req.session?.customerId) return sendError(res,401,"Please login to continue.");
  next();
}

function requireAdmin(req,res,next) {
  if (!req.session?.adminAuthenticated) return sendError(res,401,"Admin authentication required.");
  next();
}

function safeSlug(value) {
  return String(value || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,100);
}

function publicProduct(row) {
  return {
    id: row.id, name: row.name, slug: row.slug, description: row.description || "",
    category_id: row.category_id, category: row.category_name || "",
    brand: row.brand || "", sku: row.sku || "",
    price: Number(row.price || 0), sale_price: row.sale_price == null ? null : Number(row.sale_price),
    stock: Number(row.stock || 0), image_url: row.image_url || "",
    gallery: Array.isArray(row.gallery) ? row.gallery : [],
    variants: Array.isArray(row.variants) ? row.variants : [],
    delivery_fee: Number(row.delivery_fee || 0), rating: Number(row.rating || 0),
    review_count: Number(row.review_count || 0), featured: Boolean(row.featured),
    active: Boolean(row.active)
  };
}

function effectivePrice(row) {
  return Number(row.sale_price != null ? row.sale_price : row.price);
}

function orderRef() {
  return "DGM-MKT-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}

function installMarket(app) {
  app.get("/api/market/categories", async (req,res) => {
    try {
      await ensureMarketDatabase();
      const r = await pool.query("SELECT id,name,slug,icon FROM market_categories WHERE active=TRUE ORDER BY name");
      res.json({success:true,categories:r.rows});
    } catch(e) { console.error("Market categories:",e); sendError(res,500,"Could not load market categories."); }
  });

  app.get("/api/market/products", async (req,res) => {
    try {
      await ensureMarketDatabase();
      const page=Math.min(Math.max(Number(req.query.page)||1,1),50), limit=Math.min(Math.max(Number(req.query.limit)||24,1),48);
      const values=[], where=["p.active=TRUE"]; let n=1;
      const q=String(req.query.q||"").trim();
      const category=String(req.query.category||"").trim();
      const sort=String(req.query.sort||"newest");
      if(q){ values.push("%"+q+"%"); where.push("(p.name ILIKE $"+n+" OR p.description ILIKE $"+n+" OR p.brand ILIKE $"+n+")"); n++; }
      if(category){ values.push(category); where.push("c.slug=$"+n); n++; }
      const order={newest:"p.created_at DESC",price_asc:"COALESCE(p.sale_price,p.price) ASC",price_desc:"COALESCE(p.sale_price,p.price) DESC",popular:"p.rating DESC,p.review_count DESC"}[sort]||"p.created_at DESC";
      const count=await pool.query(`SELECT COUNT(*)::int count FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id WHERE ${where.join(" AND ")}`,values);
      const rows=await pool.query(`SELECT p.*,c.name category_name FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page-1)*limit}`,values);
      res.json({success:true,page,limit,total:count.rows[0].count,products:rows.rows.map(publicProduct)});
    } catch(e){console.error("Market products:",e);sendError(res,500,"Could not load market products.");}
  });

  app.get("/api/market/products/:id", async (req,res) => {
    try {
      await ensureMarketDatabase();
      const r=await pool.query("SELECT p.*,c.name category_name FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id WHERE p.id=$1 AND p.active=TRUE",[Number(req.params.id)]);
      if(!r.rows.length) return sendError(res,404,"Product not found.");
      res.json({success:true,product:publicProduct(r.rows[0])});
    } catch(e){console.error("Market product:",e);sendError(res,500,"Could not load product.");}
  });

  app.get("/api/market/wishlist",requireLogin,async(req,res)=>{
    try {
      await ensureMarketDatabase();
      const r=await pool.query(`SELECT p.*,c.name category_name FROM market_wishlists w JOIN market_products p ON p.id=w.product_id LEFT JOIN market_categories c ON c.id=p.category_id WHERE w.customer_id=$1 AND p.active=TRUE ORDER BY w.created_at DESC`,[req.session.customerId]);
      res.json({success:true,products:r.rows.map(publicProduct)});
    } catch(e){sendError(res,500,"Could not load wishlist.");}
  });

  app.post("/api/market/wishlist/:id",requireLogin,async(req,res)=>{
    try {
      await ensureMarketDatabase();
      const id=Number(req.params.id);
      const p=await pool.query("SELECT id FROM market_products WHERE id=$1 AND active=TRUE",[id]);
      if(!p.rows.length)return sendError(res,404,"Product not found.");
      const exists=await pool.query("SELECT 1 FROM market_wishlists WHERE customer_id=$1 AND product_id=$2",[req.session.customerId,id]);
      if(exists.rows.length){await pool.query("DELETE FROM market_wishlists WHERE customer_id=$1 AND product_id=$2",[req.session.customerId,id]);return res.json({success:true,saved:false});}
      await pool.query("INSERT INTO market_wishlists(customer_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[req.session.customerId,id]);
      res.json({success:true,saved:true});
    } catch(e){sendError(res,500,"Could not update wishlist.");}
  });

  app.get("/api/market/products/:id/reviews",async(req,res)=>{
    try {
      await ensureMarketDatabase();
      const r=await pool.query(`SELECT r.id,r.rating,r.title,r.body,r.verified_purchase,r.created_at,c.name customer_name FROM market_reviews r JOIN customers c ON c.id=r.customer_id WHERE r.product_id=$1 ORDER BY r.created_at DESC LIMIT 100`,[Number(req.params.id)]);
      res.json({success:true,reviews:r.rows});
    } catch(e){sendError(res,500,"Could not load reviews.");}
  });

  app.post("/api/market/products/:id/reviews",requireLogin,async(req,res)=>{
    try {
      await ensureMarketDatabase();
      const productId=Number(req.params.id), rating=Math.round(Number(req.body?.rating));
      const title=String(req.body?.title||"").trim().slice(0,160), body=String(req.body?.body||"").trim().slice(0,2000);
      if(!Number.isInteger(rating)||rating<1||rating>5||!body)return sendError(res,400,"Rating and review text are required.");
      const purchased=await pool.query(`SELECT 1 FROM market_order_items i JOIN market_orders o ON o.id=i.market_order_id WHERE o.customer_id=$1 AND i.product_id=$2 AND o.status='Delivered' LIMIT 1`,[req.session.customerId,productId]);
      const v=purchased.rows.length>0;
      const r=await pool.query(`INSERT INTO market_reviews(customer_id,product_id,rating,title,body,verified_purchase) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(customer_id,product_id) DO UPDATE SET rating=EXCLUDED.rating,title=EXCLUDED.title,body=EXCLUDED.body,verified_purchase=EXCLUDED.verified_purchase,updated_at=NOW()
        RETURNING id`,[req.session.customerId,productId,rating,title,body,v]);
      await pool.query(`UPDATE market_products SET rating=COALESCE((SELECT ROUND(AVG(rating)::numeric,2) FROM market_reviews WHERE product_id=$1),0),review_count=(SELECT COUNT(*) FROM market_reviews WHERE product_id=$1),updated_at=NOW() WHERE id=$1`,[productId]);
      res.json({success:true,id:r.rows[0].id,verified_purchase:v});
    } catch(e){console.error("Market review:",e);sendError(res,500,"Could not save review.");}
  });

  app.get("/api/market/orders",requireLogin,async(req,res)=>{
    try {
      await ensureMarketDatabase();
      const r=await pool.query("SELECT id,order_ref,subtotal,delivery_fee,total,payment_method,payment_status,status,delivery_name,delivery_phone,delivery_address,created_at,updated_at FROM market_orders WHERE customer_id=$1 ORDER BY created_at DESC",[req.session.customerId]);
      res.json({success:true,orders:r.rows});
    } catch(e){console.error("Market orders:",e);sendError(res,500,"Could not load market orders.");}
  });

  app.post("/api/market/checkout",requireLogin,async(req,res)=>{
    const client=await pool.connect();
    try {
      await ensureMarketDatabase();
      const items=Array.isArray(req.body.items)?req.body.items:[], delivery=req.body.delivery||{};
      if(!items.length) return sendError(res,400,"Your cart is empty.");
      if(!String(delivery.name||"").trim() || !String(delivery.phone||"").trim() || !String(delivery.address||"").trim()) return sendError(res,400,"Delivery name, phone and address are required.");
      await client.query("BEGIN");
      const ids=items.map(x=>Number(x.product_id)).filter(Number.isInteger);
      if(!ids.length) throw new Error("No valid products in cart.");
      const rows=await client.query("SELECT p.*,c.name category_name FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id WHERE p.id=ANY($1::int[]) AND p.active=TRUE FOR UPDATE",[ids]);
      const map=new Map(rows.rows.map(r=>[r.id,r]));
      let subtotal=0, deliveryFee=0, normalized=[];
      for(const item of items){
        const p=map.get(Number(item.product_id)), qty=Math.max(1,Math.min(Number(item.quantity)||1,99));
        if(!p) throw new Error("One of the products is no longer available.");
        if(Number(p.stock)<qty) throw new Error(p.name+" is out of stock.");
        const unit=effectivePrice(p); subtotal+=unit*qty; deliveryFee=Math.max(deliveryFee,Number(p.delivery_fee||0));
        normalized.push({p,qty,unit});
      }
      const total=subtotal+deliveryFee;
      const cust=await client.query("SELECT id,balance FROM customers WHERE id=$1 FOR UPDATE",[req.session.customerId]);
      if(!cust.rows.length) throw new Error("Customer account not found.");
      const before=Number(cust.rows[0].balance||0);
      if(before<total) throw new Error("Insufficient DGM Wallet balance.");
      const after=before-total, ref=orderRef(), txref="DGM-MKT-WALLET-"+crypto.randomBytes(6).toString("hex").toUpperCase();
      const o=await client.query(`INSERT INTO market_orders(order_ref,customer_id,subtotal,delivery_fee,total,payment_method,payment_status,status,delivery_name,delivery_phone,delivery_address,notes) VALUES($1,$2,$3,$4,$5,'Wallet','Paid','Pending',$6,$7,$8,$9) RETURNING id,order_ref,total,status,created_at`,[ref,req.session.customerId,subtotal,deliveryFee,total,String(delivery.name).trim(),String(delivery.phone).trim(),String(delivery.address).trim(),String(delivery.notes||"").trim()]);
      for(const x of normalized){
        await client.query("UPDATE market_products SET stock=stock-$1,updated_at=NOW() WHERE id=$2",[x.qty,x.p.id]);
        await client.query("INSERT INTO market_order_items(market_order_id,product_id,product_name,quantity,unit_price,line_total,variant) VALUES($1,$2,$3,$4,$5,$6,$7)",[o.rows[0].id,x.p.id,x.p.name,x.qty,x.unit,x.unit*x.qty,JSON.stringify({})]);
      }
      await client.query("UPDATE customers SET balance=balance-$1 WHERE id=$2",[total,req.session.customerId]);
      await client.query("INSERT INTO market_wallet_transactions(market_order_id,customer_id,amount,balance_before,balance_after,transaction_ref) VALUES($1,$2,$3,$4,$5,$6)",[o.rows[0].id,req.session.customerId,total,before,after,txref]);
      await client.query("INSERT INTO wallet_transactions(customer_id,type,amount,balance_before,balance_after,description,transaction_ref,status,reference) VALUES($1,'debit',$2,$3,$4,$5,$6,'Completed',$7)",[req.session.customerId,total,before,after,"DGM Market order "+ref,txref,ref]);
      await client.query("COMMIT");
      res.json({success:true,order:o.rows[0],balance:after});
    } catch(e) {
      try { await client.query("ROLLBACK"); } catch {}
      console.error("Market checkout:",e);
      sendError(res,400,e.message||"Checkout failed.");
    } finally { client.release(); }
  });

  app.get("/api/admin/market/categories",requireAdmin,async(req,res)=>{
    try { await ensureMarketDatabase(); const r=await pool.query("SELECT * FROM market_categories ORDER BY name"); res.json({success:true,categories:r.rows}); }
    catch(e){sendError(res,500,"Could not load categories.");}
  });

  app.get("/api/admin/market/products",requireAdmin,async(req,res)=>{
    try { await ensureMarketDatabase(); const r=await pool.query("SELECT p.*,c.name category_name FROM market_products p LEFT JOIN market_categories c ON c.id=p.category_id ORDER BY p.created_at DESC"); res.json({success:true,products:r.rows.map(publicProduct)}); }
    catch(e){sendError(res,500,"Could not load products.");}
  });

  app.post("/api/admin/market/products",requireAdmin,async(req,res)=>{
    try {
      await ensureMarketDatabase();
      const b=req.body||{}, name=String(b.name||"").trim(), slug=safeSlug(b.slug||name);
      if(!name||!slug||!Number.isFinite(Number(b.price))) return sendError(res,400,"Product name and valid price are required.");
      const cat=Number(b.category_id)||null, price=Number(b.price), sale=b.sale_price===""||b.sale_price==null?null:Number(b.sale_price), stock=Math.max(0,Number(b.stock)||0);
      const r=await pool.query(`INSERT INTO market_products(name,slug,description,category_id,brand,sku,price,sale_price,stock,image_url,gallery,variants,delivery_fee,featured,active) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,[name,slug,String(b.description||""),cat,String(b.brand||""),String(b.sku||"")||null,price,sale,stock,String(b.image_url||""),JSON.stringify(Array.isArray(b.gallery)?b.gallery:[]),JSON.stringify(Array.isArray(b.variants)?b.variants:[]),Math.max(0,Number(b.delivery_fee)||0),Boolean(b.featured),b.active!==false]);
      res.json({success:true,id:r.rows[0].id});
    } catch(e){console.error("Admin market product:",e);sendError(res,400,e.code==="23505"?"Product slug or SKU already exists.":e.message||"Could not create product.");}
  });

  app.patch("/api/admin/market/products/:id",requireAdmin,async(req,res)=>{
    try {
      await ensureMarketDatabase();
      const b=req.body||{}, id=Number(req.params.id);
      const current=await pool.query("SELECT * FROM market_products WHERE id=$1",[id]);
      if(!current.rows.length) return sendError(res,404,"Product not found.");
      const p=current.rows[0], name=String(b.name??p.name).trim(), slug=safeSlug(b.slug??p.slug);
      const r=await pool.query(`UPDATE market_products SET name=$1,slug=$2,description=$3,category_id=$4,brand=$5,sku=$6,price=$7,sale_price=$8,stock=$9,image_url=$10,gallery=$11,variants=$12,delivery_fee=$13,featured=$14,active=$15,updated_at=NOW() WHERE id=$16 RETURNING id`,[name,slug,String(b.description ?? p.description ?? ""),Number(b.category_id??p.category_id)||null,String(b.brand ?? p.brand ?? ""),String(b.sku ?? p.sku ?? "")||null,Number(b.price??p.price),b.sale_price===""||b.sale_price==null?null:Number(b.sale_price),Math.max(0,Number(b.stock??p.stock)||0),String(b.image_url ?? p.image_url ?? ""),JSON.stringify(Array.isArray(b.gallery)?b.gallery:(Array.isArray(p.gallery)?p.gallery:[])),JSON.stringify(Array.isArray(b.variants)?b.variants:(Array.isArray(p.variants)?p.variants:[])),Math.max(0,Number(b.delivery_fee??p.delivery_fee)||0),Boolean(b.featured??p.featured),b.active!==undefined?Boolean(b.active):Boolean(p.active),id]);
      res.json({success:true,id:r.rows[0].id});
    } catch(e){console.error("Admin market update:",e);sendError(res,400,e.code==="23505"?"Product slug or SKU already exists.":e.message||"Could not update product.");}
  });

  app.delete("/api/admin/market/products/:id",requireAdmin,async(req,res)=>{
    try { await ensureMarketDatabase(); await pool.query("UPDATE market_products SET active=FALSE,updated_at=NOW() WHERE id=$1",[Number(req.params.id)]); res.json({success:true}); }
    catch(e){sendError(res,500,"Could not remove product.");}
  });

  app.get("/api/admin/market/orders",requireAdmin,async(req,res)=>{
    try { await ensureMarketDatabase(); const r=await pool.query(`SELECT o.*,c.name customer_name,c.phone customer_phone FROM market_orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`); res.json({success:true,orders:r.rows}); }
    catch(e){sendError(res,500,"Could not load market orders.");}
  });

  app.patch("/api/admin/market/orders/:id",requireAdmin,async(req,res)=>{
    try { await ensureMarketDatabase(); const allowed=["Pending","Confirmed","Processing","Shipped","Out for Delivery","Delivered","Cancelled","Refunded"]; const status=String(req.body?.status||""); if(!allowed.includes(status)) return sendError(res,400,"Invalid market order status."); const r=await pool.query("UPDATE market_orders SET status=$1,updated_at=NOW() WHERE id=$2 RETURNING id,status",[status,Number(req.params.id)]); if(!r.rows.length) return sendError(res,404,"Market order not found."); res.json({success:true,order:r.rows[0]}); }
    catch(e){sendError(res,500,"Could not update market order.");}
  });

  app.get("/api/admin/market/summary",requireAdmin,async(req,res)=>{
    try { await ensureMarketDatabase(); const [p,o,s]=await Promise.all([pool.query("SELECT COUNT(*)::int count FROM market_products WHERE active=TRUE"),pool.query("SELECT COUNT(*)::int count FROM market_orders"),pool.query("SELECT COALESCE(SUM(total),0)::numeric total FROM market_orders WHERE payment_status='Paid' AND status<>'Cancelled'")]); res.json({success:true,products:p.rows[0].count,orders:o.rows[0].count,sales:Number(s.rows[0].total||0)}); }
    catch(e){sendError(res,500,"Could not load market summary.");}
  });
}

module.exports = { installMarket, ensureMarketDatabase };
