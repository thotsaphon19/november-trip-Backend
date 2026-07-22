const express = require("express");
const prisma = require("../lib/prisma");
const sync = require("../services/syncService");
const { cascadeTourActivityPriceChange } = require("../services/costCascade");
const { generateNextCode } = require("../services/codeGenerator");

const router = express.Router();

// Lets the "add supplier" form pre-fill a suggested code before the
// supplier exists - GET so opening the modal can call it without side effects.
router.get("/next-code", async (req, res) => {
  const code = await generateNextCode(prisma, "tourSupplier", "supplierCode", "TSP-", 3);
  res.json({ code });
});

router.get("/", async (req, res) => {
  const { q, province } = req.query;
  const filters = [];
  if (q) {
    filters.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { supplierCode: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (province) filters.push({ province });
  const suppliers = await prisma.tourSupplier.findMany({
    where: filters.length ? { AND: filters } : undefined,
    include: { activities: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(suppliers);
});

router.get("/:id", async (req, res) => {
  const supplier = await prisma.tourSupplier.findUnique({
    where: { id: req.params.id },
    include: { activities: true },
  });
  if (!supplier) return res.status(404).json({ error: "Supplier not found" });
  res.json(supplier);
});

router.post("/", async (req, res) => {
  const { supplierCode, name, phone, phoneSales, email, line, whatsapp, province, contractStart, contractEnd } = req.body;
  const code = supplierCode?.trim() || (await generateNextCode(prisma, "tourSupplier", "supplierCode", "TSP-", 3));
  const supplier = await prisma.tourSupplier.create({
    data: {
      supplierCode: code,
      name,
      phone,
      phoneSales,
      email,
      line,
      whatsapp,
      province,
      contractStart: contractStart ? new Date(contractStart) : null,
      contractEnd: contractEnd ? new Date(contractEnd) : null,
    },
  });
  res.status(201).json(supplier);
});

router.put("/:id", async (req, res) => {
  const { supplierCode, name, phone, phoneSales, email, line, whatsapp, province, contractStart, contractEnd } = req.body;
  const supplier = await prisma.tourSupplier.update({
    where: { id: req.params.id },
    data: {
      supplierCode,
      name,
      phone,
      phoneSales,
      email,
      line,
      whatsapp,
      province,
      contractStart: contractStart ? new Date(contractStart) : undefined,
      contractEnd: contractEnd ? new Date(contractEnd) : undefined,
    },
  });
  res.json(supplier);
});

router.delete("/:id", async (req, res) => {
  await prisma.tourSupplier.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ---- Activities ---------------------------------------------------------

router.post("/:id/activities", async (req, res) => {
  const { name, activityCode, category, imageUrl, costPrice, sellPrice, childCostPrice, childSellPrice, conditions, contractStart, contractEnd } =
    req.body;
  const activity = await prisma.tourActivity.create({
    data: {
      supplierId: req.params.id,
      name,
      activityCode: activityCode || null,
      category: category || "Tour",
      imageUrl: imageUrl || null,
      costPrice,
      sellPrice,
      childCostPrice: childCostPrice || null,
      childSellPrice: childSellPrice || null,
      conditions: conditions || null,
      contractStart: contractStart ? new Date(contractStart) : null,
      contractEnd: contractEnd ? new Date(contractEnd) : null,
    },
  });
  res.status(201).json(activity);
});

router.put("/activities/:activityId", async (req, res) => {
  const { name, activityCode, category, imageUrl, costPrice, sellPrice, childCostPrice, childSellPrice, conditions, contractStart, contractEnd } =
    req.body;
  const activity = await prisma.tourActivity.update({
    where: { id: req.params.activityId },
    data: {
      name,
      activityCode,
      category,
      imageUrl,
      costPrice,
      sellPrice,
      childCostPrice,
      childSellPrice,
      conditions,
      contractStart: contractStart ? new Date(contractStart) : undefined,
      contractEnd: contractEnd ? new Date(contractEnd) : undefined,
    },
  });
  await cascadeTourActivityPriceChange(req.params.activityId);
  res.json(activity);
});

router.delete("/activities/:activityId", async (req, res) => {
  await prisma.tourActivity.delete({ where: { id: req.params.activityId } });
  res.status(204).end();
});

// Suggests the next product code for a new activity - "ACT-001", "ACT-002", ...
router.get("/activities/next-code", async (req, res) => {
  const code = await generateNextCode(prisma, "tourActivity", "activityCode", "ACT-", 3);
  res.json({ code });
});

router.post("/activities/:activityId/odoo/push", async (req, res) => {
  const odooId = await sync.pushTourActivityProduct(req.params.activityId);
  res.json({ odooId });
});

// ---- Odoo sync ------------------------------------------------------------

router.post("/:id/odoo/push", async (req, res) => {
  const odooId = await sync.pushTourSupplier(req.params.id);
  res.json({ odooId });
});

module.exports = router;
