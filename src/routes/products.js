const express = require("express");
const prisma = require("../lib/prisma");
const sync = require("../services/syncService");
const { resolveSeasonalCost, recomputeProductSeasonalCosts } = require("../services/costCascade");

const router = express.Router();

router.get("/", async (req, res) => {
  const { q } = req.query;
  const products = await prisma.product.findMany({
    where: q
      ? {
          OR: [
            { tourName: { contains: q, mode: "insensitive" } },
            { tourCode: { contains: q, mode: "insensitive" } },
            { hotelSupplier: { name: { contains: q, mode: "insensitive" } } },
            { tourSupplier: { name: { contains: q, mode: "insensitive" } } },
          ],
        }
      : undefined,
    include: {
      itinerary: { orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }] },
      hotelSupplier: { include: { images: true } },
      tourSupplier: true,
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(products);
});

router.get("/:id", async (req, res) => {
  const product = await prisma.product.findUnique({
    where: { id: req.params.id },
    include: {
      itinerary: {
        orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        include: { hotel: true, roomType: true, tourActivity: true },
      },
      hotelSupplier: true,
      tourSupplier: true,
    },
  });
  if (!product) return res.status(404).json({ error: "Product not found" });
  res.json(product);
});

// Creating a product with `days` immediately scaffolds N empty itinerary
// rows, matching the "type 5 -> five day rows appear below" UX from spec.
// `supplierType` + `supplierId` set the tour-level Supplier field (#4 in
// the spec), pulled straight from the Supplier module.
router.post("/", async (req, res) => {
  const { tourCode, tourName, price, days, startDate, adults, children, supplierType, supplierId } = req.body;
  const product = await prisma.product.create({
    data: {
      tourCode,
      tourName,
      price,
      days,
      startDate: startDate ? new Date(startDate) : null,
      adults: adults ?? 2,
      children: children ?? 0,
      supplierType: supplierType || null,
      hotelSupplierId: supplierType === "Hotel" ? supplierId : null,
      tourSupplierId: supplierType === "Tour" ? supplierId : null,
      itinerary: {
        create: Array.from({ length: days }, (_, i) => ({
          dayNumber: i + 1,
          category: "Tour",
          costPrice: 0,
        })),
      },
    },
    include: { itinerary: true, hotelSupplier: true, tourSupplier: true },
  });
  res.status(201).json(product);
});

router.put("/:id", async (req, res) => {
  const { tourCode, tourName, price, startDate, adults, children, supplierType, supplierId } = req.body;
  const product = await prisma.product.update({
    where: { id: req.params.id },
    data: {
      tourCode,
      tourName,
      price,
      startDate: startDate !== undefined ? (startDate ? new Date(startDate) : null) : undefined,
      adults,
      children,
      ...(supplierType !== undefined
        ? {
            supplierType: supplierType || null,
            hotelSupplierId: supplierType === "Hotel" ? supplierId : null,
            tourSupplierId: supplierType === "Tour" ? supplierId : null,
          }
        : {}),
    },
    include: { hotelSupplier: true, tourSupplier: true },
  });
  // The start date changing means every already-picked room's cost may now
  // resolve to a different season - re-stamp them instead of leaving stale costs.
  if (startDate !== undefined) await recomputeProductSeasonalCosts(product.id);
  res.json(product);
});

// Change day count after creation: adds/removes trailing day rows.
router.put("/:id/days", async (req, res) => {
  const { days } = req.body;
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: req.params.id },
    include: { itinerary: true },
  });

  if (days > product.itinerary.length) {
    const toAdd = Array.from({ length: days - product.itinerary.length }, (_, i) => ({
      productId: product.id,
      dayNumber: product.itinerary.length + i + 1,
      category: "Tour",
      costPrice: 0,
    }));
    await prisma.tourDay.createMany({ data: toAdd });
  } else if (days < product.itinerary.length) {
    const idsToRemove = product.itinerary
      .filter((d) => d.dayNumber > days)
      .map((d) => d.id);
    await prisma.tourDay.deleteMany({ where: { id: { in: idsToRemove } } });
  }

  const updated = await prisma.product.update({
    where: { id: req.params.id },
    data: { days },
    include: { itinerary: { orderBy: [{ dayNumber: "asc" }, { createdAt: "asc" }, { id: "asc" }] } },
  });
  res.json(updated);
});

router.delete("/:id", async (req, res) => {
  await prisma.product.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

// ---- Multiple items per day -------------------------------------------------
// A single day can have more than one line (e.g. Hotel check-in + an
// Activity the same day) - each is its own TourDay row sharing a dayNumber.

router.post("/:id/days/:dayNumber/items", async (req, res) => {
  const dayNumber = Number(req.params.dayNumber);
  const day = await prisma.tourDay.create({
    data: { productId: req.params.id, dayNumber, category: "Tour", costPrice: 0 },
  });
  res.status(201).json(day);
});

router.delete("/day-items/:dayId", async (req, res) => {
  await prisma.tourDay.delete({ where: { id: req.params.dayId } });
  res.status(204).end();
});

// ---- Itinerary day updates (place/category/supplier selection) -----------
// Cost price is auto-filled from the chosen supplier record, exactly like
// the "shows cost price automatically" requirement. If the trip has a start
// date, resolveSeasonalCost() picks the price for the calendar month
// `dayNumber` actually falls on instead of the flat "ปกติ" cost.
router.put("/days/:dayId", async (req, res) => {
  const { place, category, hotelSupplierIdRef, roomTypeId, tourActivityId, seasonPriceId, costPrice: manualCostPrice } = req.body;

  let costPrice;
  if (roomTypeId) {
    const [rt, existingDay] = await Promise.all([
      prisma.roomType.findUniqueOrThrow({ where: { id: roomTypeId }, include: { seasonPrices: true } }),
      prisma.tourDay.findUniqueOrThrow({ where: { id: req.params.dayId }, include: { product: true } }),
    ]);
    if (seasonPriceId !== undefined) {
      // Person explicitly picked from the "ช่วงราคา" dropdown - "" means
      // they chose ราคาปกติ (normal price), an id means a specific season.
      const chosen = seasonPriceId ? rt.seasonPrices.find((sp) => sp.id === seasonPriceId) : null;
      costPrice = chosen ? chosen.price : rt.costPrice;
    } else {
      // No explicit choice sent - fall back to auto-resolving by the trip's
      // start date, same as before.
      costPrice = resolveSeasonalCost(rt, existingDay.product.startDate, existingDay.dayNumber);
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

  const day = await prisma.tourDay.update({
    where: { id: req.params.dayId },
    data: { place, category, hotelSupplierIdRef, roomTypeId, tourActivityId, costPrice },
    include: { hotel: true, roomType: { include: { seasonPrices: true } }, tourActivity: true },
  });
  res.json(day);
});

// Bulk-fills a day with the standard tour-costing line items (Van
// transfer, Boat tour, Hotel, National Park, etc.) as empty starter rows -
// matches the paper costing sheet format DMCs commonly use, instead of
// adding each line one at a time.
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
  const days = await prisma.tourDay.createMany({
    data: DAY_TEMPLATE.map((item) => ({
      productId: req.params.id,
      dayNumber,
      place: item.place,
      category: item.category,
      costPrice: 0,
    })),
  });
  const created = await prisma.tourDay.findMany({
    where: { productId: req.params.id, dayNumber },
    orderBy: { id: "asc" },
  });
  res.status(201).json({ count: days.count, days: created });
});

// ---- Odoo sync -------------------------------------------------------------

router.post("/:id/odoo/push", async (req, res) => {
  const odooId = await sync.pushProduct(req.params.id);
  res.json({ odooId });
});

module.exports = router;
