const express = require("express");
const prisma = require("../lib/prisma");
const sync = require("../services/syncService");
const mailer = require("../services/mailer");
const line = require("../services/lineMessaging");
const { generateQuotationPdf } = require("../services/pdfGenerator");
const { generateNextCode } = require("../services/codeGenerator");
const { resolveSeasonalCost, recomputeQuotationSeasonalCosts } = require("../services/costCascade");

const router = express.Router();

// Lets the "create quotation" form pre-fill a suggested code before the
// quotation exists - GET so opening the panel can call it without side effects.
router.get("/next-code", async (req, res) => {
  const code = await generateNextCode(prisma, "quotation", "quoteCode", "QT-", 4);
  res.json({ code });
});

router.get("/", async (req, res) => {
  const { q, status } = req.query;
  const quotations = await prisma.quotation.findMany({
    where: {
      AND: [
        q
          ? {
              OR: [
                { customerName: { contains: q, mode: "insensitive" } },
                { quoteCode: { contains: q, mode: "insensitive" } },
              ],
            }
          : {},
        status ? { status } : {},
      ],
    },
    include: { itinerary: { orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
    orderBy: { createdAt: "desc" },
  });
  res.json(quotations);
});

router.get("/:id", async (req, res) => {
  const quotation = await prisma.quotation.findUnique({
    where: { id: req.params.id },
    include: {
      itinerary: {
        orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        include: { roomType: { include: { hotel: true } }, tourActivity: { include: { supplier: true } } },
      },
      policies: { include: { conditionType: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!quotation) return res.status(404).json({ error: "Quotation not found" });
  res.json(quotation);
});

router.post("/", async (req, res) => {
  const {
    quoteCode,
    tourCode,
    customerName,
    customerEmail,
    customerPhone,
    customerAddress,
    customerLineId,
    days,
    startDate,
    adults,
    children,
    sellPrice,
    includeVat,
    vatRate,
  } = req.body;
  const quotation = await prisma.quotation.create({
    data: {
      quoteCode: quoteCode?.trim() || (await generateNextCode(prisma, "quotation", "quoteCode", "QT-", 4)),
      tourCode,
      customerName,
      customerEmail,
      customerPhone,
      customerAddress,
      customerLineId,
      days,
      startDate: startDate ? new Date(startDate) : null,
      adults: adults ?? 2,
      children: children ?? 0,
      sellPrice: sellPrice ?? 0,
      includeVat: includeVat ?? false,
      vatRate: vatRate ?? 7,
      itinerary: {
        create: Array.from({ length: days }, (_, i) => ({
          dayNumber: i + 1,
          category: "Tour",
          costPrice: 0,
          sellPrice: 0,
        })),
      },
    },
    include: { itinerary: true },
  });
  res.status(201).json(quotation);
});

router.put("/:id", async (req, res) => {
  const {
    customerName,
    customerEmail,
    customerPhone,
    customerAddress,
    customerLineId,
    days,
    adults,
    children,
    startDate,
    sellPrice,
    status,
    guideName,
    includesFlight,
    includeVat,
    vatRate,
  } = req.body;
  const quotation = await prisma.quotation.update({
    where: { id: req.params.id },
    data: {
      customerName,
      customerEmail,
      customerPhone,
      customerAddress,
      customerLineId,
      days,
      adults,
      children,
      startDate: startDate !== undefined ? (startDate ? new Date(startDate) : null) : undefined,
      sellPrice,
      status,
      guideName,
      includesFlight,
      includeVat,
      vatRate,
    },
  });
  // The start date changing means every already-picked room's cost may now
  // resolve to a different season - re-stamp them instead of leaving stale costs.
  if (startDate !== undefined) await recomputeQuotationSeasonalCosts(quotation.id);
  res.json(quotation);
});

router.delete("/:id", async (req, res) => {
  await prisma.quotation.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ---- Multiple items per day -------------------------------------------------
// A single day can have more than one line (e.g. Hotel check-in + an
// Activity the same day) - each is its own QuotationDay row sharing a dayNumber.

router.post("/:id/days/:dayNumber/items", async (req, res) => {
  const dayNumber = Number(req.params.dayNumber);
  const day = await prisma.quotationDay.create({
    data: { quotationId: req.params.id, dayNumber, category: "Tour", costPrice: 0, sellPrice: 0 },
  });
  res.status(201).json(day);
});

async function recomputeQuotationTotals(quotationId) {
  const allDays = await prisma.quotationDay.findMany({ where: { quotationId } });
  const totalCost = allDays.reduce((sum, d) => sum + Number(d.costPrice), 0);
  const totalSell = allDays.reduce((sum, d) => sum + Number(d.sellPrice), 0);
  await prisma.quotation.update({
    where: { id: quotationId },
    data: { costPrice: totalCost, sellPrice: totalSell },
  });
}

router.delete("/day-items/:dayId", async (req, res) => {
  const day = await prisma.quotationDay.delete({ where: { id: req.params.dayId } });
  await recomputeQuotationTotals(day.quotationId);
  res.status(204).end();
});

// ---- Itinerary day updates: pulls cost automatically, lets sell be edited --

router.put("/days/:dayId", async (req, res) => {
  const { place, category, roomTypeId, tourActivityId, seasonPriceId, sellPrice, costPrice: manualCostPrice } = req.body;

  let costPrice;
  if (roomTypeId) {
    const [rt, existingDay] = await Promise.all([
      prisma.roomType.findUniqueOrThrow({ where: { id: roomTypeId }, include: { seasonPrices: true } }),
      prisma.quotationDay.findUniqueOrThrow({ where: { id: req.params.dayId }, include: { quotation: true } }),
    ]);
    if (seasonPriceId !== undefined) {
      // Person explicitly picked from the "ช่วงราคา" dropdown - "" means
      // they chose ราคาปกติ (normal price), an id means a specific season.
      const chosen = seasonPriceId ? rt.seasonPrices.find((sp) => sp.id === seasonPriceId) : null;
      costPrice = chosen ? chosen.price : rt.costPrice;
    } else {
      // No explicit choice sent - fall back to auto-resolving by the trip's
      // start date, same as before.
      costPrice = resolveSeasonalCost(rt, existingDay.quotation.startDate, existingDay.dayNumber);
    }
  } else if (tourActivityId) {
    const act = await prisma.tourActivity.findUniqueOrThrow({ where: { id: tourActivityId } });
    costPrice = act.costPrice;
  } else if (manualCostPrice !== undefined) {
    // No supplier selected - this is a manually-typed line (e.g. "Van transfer")
    // where the cost is entered directly instead of looked up.
    costPrice = manualCostPrice;
  } else {
    costPrice = 0;
  }

  const day = await prisma.quotationDay.update({
    where: { id: req.params.dayId },
    data: { place, category, roomTypeId, tourActivityId, costPrice, sellPrice },
  });

  // Recompute quotation-level cost + sell totals so the top summary,
  // dashboard, and report all reflect the day-by-day entries automatically.
  await recomputeQuotationTotals(day.quotationId);

  res.json(day);
});

// Bulk-fills a day with the standard tour-costing line items (Van
// transfer, Boat tour, Hotel, National Park, etc.) as empty starter rows -
// matches the paper costing sheet format DMCs commonly use.
const DAY_TEMPLATE = [
  { place: "Van transfer", category: "Tour" },
  { place: "Van tour", category: "Tour" },
  { place: "Guide", category: "Tour" },
  { place: "Accom guide", category: "Tour" },
  { place: "Boat transfer", category: "Tour" },
  { place: "Boat tour", category: "Tour" },
  { place: "Hotel", category: "Hotels" },
  { place: "National Park", category: "Place" },
];

router.post("/:id/days/:dayNumber/template", async (req, res) => {
  const dayNumber = Number(req.params.dayNumber);
  await prisma.quotationDay.createMany({
    data: DAY_TEMPLATE.map((item) => ({
      quotationId: req.params.id,
      dayNumber,
      place: item.place,
      category: item.category,
      costPrice: 0,
      sellPrice: 0,
    })),
  });
  const created = await prisma.quotationDay.findMany({
    where: { quotationId: req.params.id, dayNumber },
    orderBy: { id: "asc" },
  });
  res.status(201).json({ days: created });
});

// ---- PDF -------------------------------------------------------------------

router.get("/:id/pdf", async (req, res) => {
  const quotation = await prisma.quotation.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      itinerary: { orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
      policies: { include: { conditionType: true }, orderBy: { createdAt: "asc" } },
    },
  });
  const appSettings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
  const lang = req.query.lang === "en" ? "en" : "th";
  const detail = req.query.detail === "simple" ? "simple" : "full";

  const pdfBuffer = await generateQuotationPdf(quotation, appSettings, lang, detail);

  const suffix = (lang === "en" ? "-EN" : "") + (detail === "simple" ? "-Preliminary" : "");
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${quotation.quoteCode}${suffix}.pdf"`);
  res.send(pdfBuffer);
});

// ---- Send to customer -------------------------------------------------------

function summaryText(quotation) {
  const lines = quotation.itinerary
    .map((d) => `Day ${d.dayNumber}: ${d.place || d.category} - ฿${Number(d.sellPrice).toLocaleString()}`)
    .join("\n");
  return (
    `ใบเสนอราคา ${quotation.quoteCode}\n` +
    `ลูกค้า: ${quotation.customerName}\n` +
    `จำนวนวัน: ${quotation.days} วัน (ผู้ใหญ่ ${quotation.adults} เด็ก ${quotation.children})\n\n` +
    `${lines}\n\n` +
    `ราคารวม: ฿${Number(quotation.sellPrice).toLocaleString()}`
  );
}

router.post("/:id/send-email", async (req, res) => {
  const quotation = await prisma.quotation.findUniqueOrThrow({
    where: { id: req.params.id },
    include: {
      itinerary: { orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
      policies: { include: { conditionType: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!quotation.customerEmail) {
    return res.status(400).json({ error: "ใบเสนอราคานี้ยังไม่มีอีเมลลูกค้า" });
  }
  const appSettings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
  const lang = req.body.lang === "en" ? "en" : "th";
  const detail = req.body.detail === "simple" ? "simple" : "full";
  const pdfBuffer = await generateQuotationPdf(quotation, appSettings, lang, detail);

  await mailer.sendMail({
    to: quotation.customerEmail,
    subject: `ใบเสนอราคาทัวร์ ${quotation.quoteCode}`,
    text: summaryText(quotation),
    attachments: [{ filename: `${quotation.quoteCode}.pdf`, content: pdfBuffer, contentType: "application/pdf" }],
  });
  res.json({ success: true, sentTo: quotation.customerEmail });
});

router.post("/:id/send-line", async (req, res) => {
  const quotation = await prisma.quotation.findUniqueOrThrow({
    where: { id: req.params.id },
    include: { itinerary: { orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
  });
  if (!quotation.customerLineId) {
    return res.status(400).json({ error: "ใบเสนอราคานี้ยังไม่มี LINE User ID ของลูกค้า" });
  }
  await line.pushMessage(quotation.customerLineId, summaryText(quotation));
  res.json({ success: true, sentTo: quotation.customerLineId });
});

// ---- Policies ---------------------------------------------------------------
// Free-text policy lines (payment terms, cancellation, documents required,
// etc.), each tagged with a type from the shared ConditionType catalog - the
// same "+ เพิ่มประเภทใหม่" catalog used by Hotel Supplier conditions.

router.post("/:id/policies", async (req, res) => {
  const { conditionTypeId, content } = req.body;
  const policy = await prisma.quotationPolicy.create({
    data: { quotationId: req.params.id, conditionTypeId, content },
    include: { conditionType: true },
  });
  res.status(201).json(policy);
});

router.put("/policies/:policyId", async (req, res) => {
  const { conditionTypeId, content } = req.body;
  const policy = await prisma.quotationPolicy.update({
    where: { id: req.params.policyId },
    data: { conditionTypeId, content },
    include: { conditionType: true },
  });
  res.json(policy);
});

router.delete("/policies/:policyId", async (req, res) => {
  await prisma.quotationPolicy.delete({ where: { id: req.params.policyId } });
  res.status(204).end();
});

// ---- Odoo sync -------------------------------------------------------------

router.post("/:id/odoo/push", async (req, res) => {
  const odooId = await sync.pushQuotation(req.params.id);
  res.json({ odooId });
});

module.exports = router;
