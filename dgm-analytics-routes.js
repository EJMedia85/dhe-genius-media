"use strict";

// Read-only financial and order analytics for the DGM Super Admin.
// Values are sourced from the existing orders table; unknown supplier costs
// are explicitly excluded from profit calculations rather than treated as zero.
function installDgmAnalytics(app, { pool, requireAdmin }) {
  app.get("/api/admin/overview", requireAdmin, async (req, res) => {
    const now = new Date();
    const toRaw = String(req.query.to || now.toISOString().slice(0, 10));
    const fromDefault = new Date(now);
    fromDefault.setUTCDate(fromDefault.getUTCDate() - 29);
    const fromRaw = String(req.query.from || fromDefault.toISOString().slice(0, 10));
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + "T00:00:00Z"));
    if (!validDate(fromRaw) || !validDate(toRaw) || fromRaw > toRaw) {
      return res.status(400).json({ success: false, message: "Use valid from/to dates in YYYY-MM-DD format; from must not be after to." });
    }
    const span = (Date.parse(toRaw + "T00:00:00Z") - Date.parse(fromRaw + "T00:00:00Z")) / 86400000;
    if (span > 364) return res.status(400).json({ success: false, message: "Date range cannot exceed 365 days." });

    try {
      const params = [fromRaw, toRaw];
      const summary = await pool.query(`
        SELECT
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid')::int AS paid_orders,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) <> 'paid')::int AS unpaid_orders,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('completed','successful','success'))::int AS completed_orders,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(status, '')) IN ('failed','refunded','refund pending'))::int AS failed_or_refund_orders,
          COALESCE(SUM(amount) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid'), 0)::numeric(14,2) AS paid_revenue,
          COALESCE(SUM(supplier_cost) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid' AND supplier_cost IS NOT NULL), 0)::numeric(14,2) AS known_supplier_cost,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid' AND supplier_cost IS NULL)::int AS paid_orders_missing_supplier_cost,
          COALESCE(SUM(dgm_gross_profit) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid' AND dgm_gross_profit IS NOT NULL), 0)::numeric(14,2) AS recorded_gross_profit,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid' AND dgm_gross_profit IS NOT NULL)::int AS orders_with_recorded_profit
        FROM orders
        WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
      `, params);

      const byNetwork = await pool.query(`
        SELECT COALESCE(NULLIF(network, ''), 'Other') AS network,
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid')::int AS paid_orders,
          COALESCE(SUM(amount) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid'), 0)::numeric(14,2) AS paid_revenue
        FROM orders
        WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
        GROUP BY COALESCE(NULLIF(network, ''), 'Other')
        ORDER BY paid_revenue DESC, total_orders DESC
      `, params);

      const daily = await pool.query(`
        SELECT created_at::date AS date,
          COUNT(*)::int AS total_orders,
          COUNT(*) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid')::int AS paid_orders,
          COALESCE(SUM(amount) FILTER (WHERE LOWER(COALESCE(payment_status, 'pending')) = 'paid'), 0)::numeric(14,2) AS paid_revenue
        FROM orders
        WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
        GROUP BY created_at::date
        ORDER BY date ASC
      `, params);

      const recent = await pool.query(`
        SELECT order_ref, service, network, capacity, amount, status, payment_status,
          supplier_cost, dgm_gross_profit, supplier_settlement_status, created_at, completed_at
        FROM orders
        WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day')
        ORDER BY created_at DESC
        LIMIT 20
      `, params);

      const s = summary.rows[0] || {};
      const n = value => Number(value || 0);
      return res.json({
        success: true,
        range: { from: fromRaw, to: toRaw, timezone: "UTC" },
        summary: {
          totalOrders: n(s.total_orders),
          paidOrders: n(s.paid_orders),
          unpaidOrders: n(s.unpaid_orders),
          completedOrders: n(s.completed_orders),
          failedOrRefundOrders: n(s.failed_or_refund_orders),
          paidRevenueGhs: n(s.paid_revenue),
          knownSupplierCostGhs: n(s.known_supplier_cost),
          recordedGrossProfitGhs: n(s.recorded_gross_profit),
          ordersWithRecordedProfit: n(s.orders_with_recorded_profit),
          paidOrdersMissingSupplierCost: n(s.paid_orders_missing_supplier_cost),
          financialDataWarning: n(s.paid_orders_missing_supplier_cost) > 0
            ? "Some paid orders have no recorded supplier cost. Profit totals are incomplete and must not be treated as final."
            : null
        },
        byNetwork: byNetwork.rows.map(row => ({
          network: row.network, totalOrders: n(row.total_orders),
          paidOrders: n(row.paid_orders), paidRevenueGhs: n(row.paid_revenue)
        })),
        daily: daily.rows.map(row => ({
          date: row.date, totalOrders: n(row.total_orders),
          paidOrders: n(row.paid_orders), paidRevenueGhs: n(row.paid_revenue)
        })),
        recentOrders: recent.rows.map(row => ({
          orderRef: row.order_ref, service: row.service, network: row.network,
          capacity: row.capacity, amountGhs: n(row.amount), status: row.status,
          paymentStatus: row.payment_status, supplierCostGhs: row.supplier_cost == null ? null : n(row.supplier_cost),
          recordedGrossProfitGhs: row.dgm_gross_profit == null ? null : n(row.dgm_gross_profit),
          supplierSettlementStatus: row.supplier_settlement_status,
          createdAt: row.created_at, completedAt: row.completed_at
        })),
        generatedAt: new Date().toISOString()
      });
    } catch (error) {
      console.error("DGM admin overview analytics failed:", error.message);
      return res.status(500).json({ success: false, message: "Could not load DGM analytics right now." });
    }
  });
}

module.exports = { installDgmAnalytics };
