require("dotenv").config();
require("express-async-errors");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");

const auth = require("./routes/auth");
const hotelSuppliers = require("./routes/hotelSuppliers");
const tourSuppliers = require("./routes/tourSuppliers");
const products = require("./routes/products");
const quotations = require("./routes/quotations");
const reports = require("./routes/reports");
const odoo = require("./routes/odoo");
const odooWebhook = require("./routes/odooWebhook");
const uploads = require("./routes/uploads");
const attachments = require("./routes/attachments");
const settings = require("./routes/settings");
const { LOCAL_UPLOAD_DIR } = require("./services/storage");
const { requireAuth } = require("./middleware/authMiddleware");

if (!process.env.JWT_SECRET) {
  console.error("FATAL: JWT_SECRET is not set. Add it to your .env file (or your host's env var settings) before starting the server.");
  process.exit(1);
}

const app = express();

// helmet's default CSP blocks cross-origin <img> loads of our own uploads
// when the frontend is served from a different origin/port, so relax it
// just for this.
app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
app.use(cors({ origin: process.env.CORS_ORIGIN?.split(",") || "*" }));
app.use(express.json({ limit: "5mb" }));
app.use(morgan("dev"));

// Local-disk uploads are only served this way on Docker/VPS deployments.
// When S3-compatible storage or Vercel Blob is configured (see
// services/storage.js), files get an absolute cloud URL directly and this
// static route is simply unused - no serverless filesystem issue either way.
if (!process.env.S3_ENDPOINT && !process.env.BLOB_READ_WRITE_TOKEN) {
  app.use("/uploads", express.static(LOCAL_UPLOAD_DIR));
}

app.get("/api/health", (req, res) => res.json({ status: "ok", time: new Date().toISOString() }));

// /api/auth is public (each route inside decides its own requirements);
// everything else requires a valid JWT.
app.use("/api/auth", auth);
// Odoo -> app webhook: NOT protected by user JWT (Odoo can't log in as a
// user), instead guarded by a shared secret header - see odooWebhook.js
app.use("/api/odoo/webhook", odooWebhook);
app.use("/api/suppliers/hotels", requireAuth, hotelSuppliers);
app.use("/api/suppliers/tours", requireAuth, tourSuppliers);
app.use("/api/products", requireAuth, products);
app.use("/api/quotations", requireAuth, quotations);
app.use("/api/reports", requireAuth, reports);
app.use("/api/odoo", requireAuth, odoo);
app.use("/api/uploads", requireAuth, uploads);
app.use("/api/attachments", requireAuth, attachments);
app.use("/api/settings", settings);

// central error handler (express-async-errors forwards thrown errors here)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

// On Vercel, this file is imported by api/index.js as a request handler
// and must NOT call app.listen() - Vercel's runtime manages the server.
// Everywhere else (Docker, a VPS, local dev) it runs as a normal Node
// process, so app.listen() is what actually starts the API.
if (!process.env.VERCEL) {
  const PORT = process.env.PORT || 4000;
  app.listen(PORT, () => console.log(`November Trip API listening on port ${PORT}`));
}

module.exports = app;
