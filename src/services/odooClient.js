/**
 * Odoo JSON-RPC client.
 *
 * Odoo exposes a generic RPC endpoint at POST {url}/jsonrpc that lets us call
 * any model's methods (search_read, create, write, unlink) the same way the
 * Odoo web client itself does. This works identically for standard models
 * (res.partner, product.template, sale.order) and for Odoo Studio custom
 * models (x_studio_..., or whatever technical name Studio generated),
 * because Studio models are just regular Odoo models under the hood.
 *
 * Credentials are looked up from the DB (OdooConfig, editable from the UI)
 * and fall back to environment variables so the app also works before
 * anyone has filled in the settings screen.
 */

const axios = require("axios");
const prisma = require("../lib/prisma");

let cachedConfig = null;
let cachedUid = null;
let cacheExpiresAt = 0;
let inFlightAuth = null; // shared promise so concurrent calls don't each hit Odoo's login endpoint

async function getConfig() {
  const now = Date.now();
  if (cachedConfig && now < cacheExpiresAt) return cachedConfig;

  const row = await prisma.odooConfig.findUnique({ where: { id: "singleton" } });

  const config = row
    ? {
        url: row.url,
        db: row.db,
        username: row.username,
        apiKey: row.apiKey,
        modelMap: row.modelMap || {},
      }
    : {
        url: process.env.ODOO_URL,
        db: process.env.ODOO_DB,
        username: process.env.ODOO_USERNAME,
        apiKey: process.env.ODOO_API_KEY,
        modelMap: process.env.ODOO_MODEL_MAP ? JSON.parse(process.env.ODOO_MODEL_MAP) : {},
      };

  if (!config.url || !config.db || !config.username || !config.apiKey) {
    throw new Error(
      "Odoo is not configured yet. Set it via PUT /api/odoo/config or the ODOO_* env vars."
    );
  }

  cachedConfig = config;
  cacheExpiresAt = now + 60_000; // re-read config at most once a minute
  return config;
}

async function rpcCall(url, service, method, args) {
  const { data } = await axios.post(
    `${url.replace(/\/$/, "")}/jsonrpc`,
    {
      jsonrpc: "2.0",
      method: "call",
      params: { service, method, args },
      id: Math.floor(Math.random() * 1e9),
    },
    { headers: { "Content-Type": "application/json" }, timeout: 20_000 }
  );

  if (data.error) {
    const msg =
      data.error?.data?.message || data.error?.message || "Unknown Odoo RPC error";
    throw new Error(`Odoo error: ${msg}`);
  }
  return data.result;
}

async function authenticate() {
  if (cachedUid) return cachedUid;
  // If a login is already in progress, wait for that one instead of
  // starting a second - this is what was causing 429 "Too Many Requests"
  // from Odoo when several pulls ran at once (e.g. the "Pull ทั้งหมด"
  // button), since each would otherwise call authenticate() before any of
  // them had a chance to populate cachedUid.
  if (inFlightAuth) return inFlightAuth;

  inFlightAuth = (async () => {
    try {
      const config = await getConfig();
      const uid = await rpcCall(config.url, "common", "authenticate", [
        config.db,
        config.username,
        config.apiKey,
        {},
      ]);
      if (!uid) throw new Error("Odoo authentication failed - check URL/DB/username/API key");
      cachedUid = uid;
      return uid;
    } finally {
      inFlightAuth = null;
    }
  })();

  return inFlightAuth;
}

async function execute(model, method, args = [], kwargs = {}) {
  const config = await getConfig();
  const uid = await authenticate();
  return rpcCall(config.url, "object", "execute_kw", [
    config.db,
    uid,
    config.apiKey,
    model,
    method,
    args,
    kwargs,
  ]);
}

/** Resolve a logical entity name (e.g. "HotelSupplier") to the actual Odoo
 *  technical model, honoring any Studio override in modelMap. */
async function resolveModel(entity, fallbackModel) {
  const config = await getConfig();
  return config.modelMap[entity] || fallbackModel;
}

// --- Schema-aware create/write ---------------------------------------------
//
// Every Odoo instance is slightly different (version, Studio customizations,
// stripped-down apps). Hardcoding a field like `company_type` and having the
// entire sync fail with "Invalid field" the moment that one field doesn't
// exist is fragile. Instead, before every create/write we fetch the model's
// real field list (cached briefly) and silently drop any keys that aren't
// actually present, logging what got dropped so it's visible in the Sync
// Log rather than failing the whole operation.

let modelFieldsCache = {}; // model -> { names: Set<string>, expiresAt: number }

async function getModelFieldNames(model) {
  const now = Date.now();
  const cached = modelFieldsCache[model];
  if (cached && now < cached.expiresAt) return cached.names;

  const raw = await execute(model, "fields_get", [], { attributes: [] });
  const names = new Set(Object.keys(raw));
  modelFieldsCache[model] = { names, expiresAt: now + 10 * 60_000 }; // 10 min
  return names;
}

function splitKnownFields(values, fieldNames) {
  const known = {};
  const dropped = [];
  for (const [key, value] of Object.entries(values)) {
    if (fieldNames.has(key)) known[key] = value;
    else dropped.push(key);
  }
  return { known, dropped };
}

const odooClient = {
  async searchRead(model, domain = [], fields = [], opts = {}) {
    return execute(model, "search_read", [domain, fields], opts);
  },
  /** Creates a record, silently dropping any field names that don't exist
   *  on this Odoo model. Returns { id, dropped } - `dropped` is the list of
   *  field names that got skipped (empty array when everything matched). */
  async create(model, values) {
    const fieldNames = await getModelFieldNames(model);
    const { known, dropped } = splitKnownFields(values, fieldNames);
    const id = await execute(model, "create", [known]);
    return { id, dropped };
  },
  /** Same idea for updates - returns { dropped }. */
  async write(model, id, values) {
    const fieldNames = await getModelFieldNames(model);
    const { known, dropped } = splitKnownFields(values, fieldNames);
    await execute(model, "write", [[id], known]);
    return { dropped };
  },
  async unlink(model, id) {
    return execute(model, "unlink", [[id]]);
  },
  /** Returns { field_name: { string, type, required, ... } } for a model -
   *  used to populate the field-mapping dropdowns with real Odoo fields
   *  instead of asking the user to type technical names from memory. */
  async fieldsGet(model) {
    return execute(model, "fields_get", [], { attributes: ["string", "type", "required"] });
  },
  resolveModel,
  /** Clears cached credentials/uid/field-schema - call after updating
   *  OdooConfig, since a changed model mapping means different fields too. */
  resetCache() {
    cachedConfig = null;
    cachedUid = null;
    cacheExpiresAt = 0;
    modelFieldsCache = {};
  },
};

module.exports = odooClient;
