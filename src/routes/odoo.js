const express = require("express");
const prisma = require("../lib/prisma");
const odoo = require("../services/odooClient");
const sync = require("../services/syncService");

const router = express.Router();

// ---- Connection config (editable from the UI instead of redeploying) -----

router.get("/config", async (req, res) => {
  const config = await prisma.odooConfig.findUnique({ where: { id: "singleton" } });
  if (!config) return res.json(null);
  // never send the API key back to the browser
  const { apiKey, ...safe } = config;
  res.json({ ...safe, apiKeySet: !!apiKey });
});

router.put("/config", async (req, res) => {
  const { url, db, username, apiKey, modelMap, fieldMap } = req.body;
  const config = await prisma.odooConfig.upsert({
    where: { id: "singleton" },
    update: {
      url,
      db,
      username,
      ...(apiKey ? { apiKey } : {}),
      modelMap: modelMap || {},
      ...(fieldMap ? { fieldMap } : {}),
    },
    create: { id: "singleton", url, db, username, apiKey, modelMap: modelMap || {}, fieldMap: fieldMap || {} },
  });
  odoo.resetCache();
  const { apiKey: _hidden, ...safe } = config;
  res.json({ ...safe, apiKeySet: true });
});

router.post("/config/test", async (req, res) => {
  try {
    const uid = await odoo.searchRead("res.partner", [], ["id"], { limit: 1 }).then(
      () => "ok"
    );
    res.json({ success: true, message: "Connected to Odoo successfully" });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ---- Manual pull triggers (app polls Odoo on demand / cron) ---------------

router.post("/pull/hotel-partners", async (req, res) => {
  const result = await sync.pullHotelPartners();
  res.json(result);
});

router.post("/pull/tour-partners", async (req, res) => {
  const result = await sync.pullTourPartners();
  res.json(result);
});

router.post("/pull/products", async (req, res) => {
  const result = await sync.pullProducts();
  res.json(result);
});

router.post("/pull/supplier-products", async (req, res) => {
  const result = await sync.pullSupplierProducts();
  res.json(result);
});

router.post("/pull/sale-orders", async (req, res) => {
  const result = await sync.pullSaleOrders();
  res.json(result);
});

// Unlike the other /pull/* routes, this one CREATES new Quotations for
// sale.order records that were made directly in Odoo and never pushed from
// this app - an explicit, separate action from the status-only pull above
// so a stray Odoo order can't silently turn into a quotation by accident.
router.post("/import/sale-orders", async (req, res) => {
  const result = await sync.importSaleOrdersFromOdoo();
  res.json(result);
});

// Convenience: run every pull in one call, e.g. for a scheduled cron job.
router.post("/pull/all", async (req, res) => {
  // Sequential on purpose (not Promise.all) - Odoo Online rate-limits
  // bursts of simultaneous requests, and the authenticate() single-flight
  // fix alone doesn't help the search_read calls that follow it.
  const hotelPartners = await sync.pullHotelPartners();
  const tourPartners = await sync.pullTourPartners();
  const products = await sync.pullProducts();
  const supplierProducts = await sync.pullSupplierProducts();
  const saleOrders = await sync.pullSaleOrders();
  res.json({ hotelPartners, tourPartners, products, supplierProducts, saleOrders });
});

// ---- Field mapping helpers -------------------------------------------------

// Returns the local logical entities that can be field-mapped, their
// default Odoo field names, and the model each maps to - the Field
// Mapping settings page uses this to know what to show before the user
// has picked anything.
router.get("/field-map/defaults", async (req, res) => {
  res.json(sync.DEFAULT_FIELD_MAPS);
});

// Fetches the real field list from a live Odoo model via fields_get, so
// the mapping UI can offer a dropdown of actual Odoo fields instead of
// asking the user to type technical names from memory.
router.get("/fields/:model", async (req, res) => {
  const fields = await odoo.fieldsGet(req.params.model);
  const list = Object.entries(fields).map(([name, meta]) => ({
    name,
    label: meta.string,
    type: meta.type,
    required: meta.required,
  }));
  list.sort((a, b) => a.name.localeCompare(b.name));
  res.json(list);
});

// ---- Helper: search Odoo contacts to link a Quotation to a partner --------

router.get("/resolve-partner", async (req, res) => {
  const { q } = req.query;
  const results = await odoo.searchRead(
    "res.partner",
    q ? [["name", "ilike", q]] : [],
    ["id", "name", "email", "phone"],
    { limit: 10 }
  );
  res.json(results);
});

// ---- Sync log (for debugging on the Odoo settings page) -------------------

router.get("/logs", async (req, res) => {
  const logs = await prisma.odooSyncLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(logs);
});

module.exports = router;
