const express = require("express");
const prisma = require("../lib/prisma");
const sync = require("../services/syncService");
const { cascadeRoomTypePriceChange } = require("../services/costCascade");
const { generateNextCode } = require("../services/codeGenerator");

const router = express.Router();

// ---- Hotel Supplier CRUD -------------------------------------------------

// Lets the "add hotel" form pre-fill a suggested code before the hotel
// exists - GET so opening the modal can call it without side effects.
router.get("/next-code", async (req, res) => {
  const code = await generateNextCode(prisma, "hotelSupplier", "hotelCode", "HT-", 2);
  res.json({ code });
});

router.get("/", async (req, res) => {
  const { q, province, starRating, inclusionTagId } = req.query;
  const filters = [];
  if (q) {
    filters.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { hotelCode: { contains: q, mode: "insensitive" } },
      ],
    });
  }
  if (province) filters.push({ province });
  if (starRating) filters.push({ starRating: Number(starRating) });
  // "Which hotels have a pool" etc. - a hotel matches if ANY of its room
  // types carries the chosen inclusion tag (not every room needs it).
  if (inclusionTagId) filters.push({ roomTypes: { some: { inclusions: { some: { id: inclusionTagId } } } } });
  const hotels = await prisma.hotelSupplier.findMany({
    where: filters.length ? { AND: filters } : undefined,
    include: {
      roomTypes: { include: { inclusions: true, seasonPrices: true } },
      mealCosts: true,
      images: true,
      conditions: { include: { conditionType: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(hotels);
});

// ---- Global catalogs (must be registered BEFORE "/:id" below, otherwise
// Express matches "/condition-types" and "/inclusion-tags" as if they were
// a hotel id and returns "Hotel not found") --------------------------------

// User-extensible catalog of condition "types" (Cancellation Policy,
// Check-in/Check-out, Children Policy, etc.) shared across every hotel.
router.get("/condition-types", async (req, res) => {
  const types = await prisma.conditionType.findMany({ orderBy: { label: "asc" } });
  res.json(types);
});

// Idempotent by label, same pattern as inclusion-tags below.
router.post("/condition-types", async (req, res) => {
  const label = (req.body.label || "").trim();
  if (!label) return res.status(400).json({ error: "label is required" });
  const existing = await prisma.conditionType.findFirst({ where: { label: { equals: label, mode: "insensitive" } } });
  if (existing) return res.status(200).json(existing);
  const type = await prisma.conditionType.create({ data: { label } });
  res.status(201).json(type);
});

// Global catalog of "what's included" checkboxes (Room With Breakfast, etc.)
// Shared across every hotel/room so users build the list up once and reuse it.
router.get("/inclusion-tags", async (req, res) => {
  const tags = await prisma.inclusionTag.findMany({ orderBy: { label: "asc" } });
  res.json(tags);
});

// Idempotent by label - if the user types a tag that already exists (e.g. with
// different casing/spacing) we reuse it instead of creating a duplicate.
router.post("/inclusion-tags", async (req, res) => {
  const label = (req.body.label || "").trim();
  const details = (req.body.details || "").trim() || null;
  if (!label) return res.status(400).json({ error: "label is required" });
  const existing = await prisma.inclusionTag.findFirst({ where: { label: { equals: label, mode: "insensitive" } } });
  if (existing) return res.status(200).json(existing);
  const tag = await prisma.inclusionTag.create({ data: { label, details } });
  res.status(201).json(tag);
});

// Edit an existing option's pre-filled details later (e.g. update the
// breakfast hours) without having to delete and recreate the tag.
router.put("/inclusion-tags/:tagId", async (req, res) => {
  const label = req.body.label?.trim();
  const details = req.body.details !== undefined ? req.body.details.trim() || null : undefined;
  const tag = await prisma.inclusionTag.update({
    where: { id: req.params.tagId },
    data: { label, details },
  });
  res.json(tag);
});

// Remove an option from the catalog entirely. Uses Prisma's implicit m2m
// join table (RoomTypeInclusions), so this also cleanly un-ticks the tag
// from every room type that had it checked - no separate cleanup needed.
router.delete("/inclusion-tags/:tagId", async (req, res) => {
  await prisma.inclusionTag.delete({ where: { id: req.params.tagId } });
  res.status(204).send();
});

router.get("/:id", async (req, res) => {
  const hotel = await prisma.hotelSupplier.findUnique({
    where: { id: req.params.id },
    include: {
      roomTypes: { include: { seasonPrices: true, inclusions: true } },
      mealCosts: true,
      images: true,
      conditions: { include: { conditionType: true }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!hotel) return res.status(404).json({ error: "Hotel not found" });
  res.json(hotel);
});

router.post("/", async (req, res) => {
  const {
    hotelCode,
    name,
    logoUrl,
    contactName,
    phones,
    emails,
    bankName,
    bankAccountName,
    bankAccountNumber,
    contractStart,
    contractEnd,
    address,
    province,
    taxId,
    starRating,
  } = req.body;
  const cleanPhones = (phones || []).filter(Boolean).slice(0, 6);
  const cleanEmails = (emails || []).filter(Boolean).slice(0, 5);
  const code = hotelCode?.trim() || (await generateNextCode(prisma, "hotelSupplier", "hotelCode", "HT-", 2));
  const hotel = await prisma.hotelSupplier.create({
    data: {
      hotelCode: code,
      name,
      logoUrl,
      contactName,
      phones: cleanPhones,
      emails: cleanEmails,
      // Keep the singular phone/email in sync with the first entry - this is
      // what the Odoo push/pull mapping (syncService.js) still reads.
      phone: cleanPhones[0] || null,
      email: cleanEmails[0] || null,
      bankName,
      bankAccountName,
      bankAccountNumber,
      address,
      province,
      taxId,
      contractStart: contractStart ? new Date(contractStart) : null,
      contractEnd: contractEnd ? new Date(contractEnd) : null,
      starRating: starRating ? Number(starRating) : null,
    },
  });
  res.status(201).json(hotel);
});

router.put("/:id", async (req, res) => {
  const {
    hotelCode,
    name,
    logoUrl,
    contactName,
    phones,
    emails,
    bankName,
    bankAccountName,
    bankAccountNumber,
    contractStart,
    contractEnd,
    address,
    province,
    taxId,
    starRating,
  } = req.body;
  const cleanPhones = phones !== undefined ? phones.filter(Boolean).slice(0, 6) : undefined;
  const cleanEmails = emails !== undefined ? emails.filter(Boolean).slice(0, 5) : undefined;
  const hotel = await prisma.hotelSupplier.update({
    where: { id: req.params.id },
    data: {
      hotelCode,
      name,
      logoUrl,
      contactName,
      phones: cleanPhones,
      emails: cleanEmails,
      phone: cleanPhones !== undefined ? cleanPhones[0] || null : undefined,
      email: cleanEmails !== undefined ? cleanEmails[0] || null : undefined,
      bankName,
      bankAccountName,
      bankAccountNumber,
      address,
      province,
      taxId,
      contractStart: contractStart ? new Date(contractStart) : undefined,
      contractEnd: contractEnd ? new Date(contractEnd) : undefined,
      starRating: starRating !== undefined ? (starRating ? Number(starRating) : null) : undefined,
    },
  });
  res.json(hotel);
});

router.delete("/:id", async (req, res) => {
  await prisma.hotelSupplier.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

router.post("/:id/conditions", async (req, res) => {
  const { conditionTypeId, content } = req.body;
  const condition = await prisma.hotelCondition.create({
    data: { hotelId: req.params.id, conditionTypeId, content },
    include: { conditionType: true },
  });
  res.status(201).json(condition);
});

router.put("/conditions/:conditionId", async (req, res) => {
  const { conditionTypeId, content } = req.body;
  const condition = await prisma.hotelCondition.update({
    where: { id: req.params.conditionId },
    data: { conditionTypeId, content },
    include: { conditionType: true },
  });
  res.json(condition);
});

router.delete("/conditions/:conditionId", async (req, res) => {
  await prisma.hotelCondition.delete({ where: { id: req.params.conditionId } });
  res.status(204).end();
});

// ---- Images ---------------------------------------------------------------

router.post("/:id/images", async (req, res) => {
  const { url } = req.body;
  const image = await prisma.hotelImage.create({
    data: { hotelId: req.params.id, url },
  });
  res.status(201).json(image);
});

router.delete("/:id/images/:imageId", async (req, res) => {
  await prisma.hotelImage.delete({ where: { id: req.params.imageId } });
  res.status(204).end();
});

// ---- Room Types -------------------------------------------------------------

router.post("/:id/room-types", async (req, res) => {
  const { name, costPrice, sellPrice, maxPax, imageUrl, inclusionIds } = req.body;
  const roomType = await prisma.roomType.create({
    data: {
      hotelId: req.params.id,
      name,
      costPrice,
      sellPrice,
      maxPax,
      imageUrl,
      inclusions: inclusionIds?.length ? { connect: inclusionIds.map((id) => ({ id })) } : undefined,
    },
    include: { inclusions: true },
  });
  res.status(201).json(roomType);
});

router.put("/room-types/:roomTypeId", async (req, res) => {
  const { name, costPrice, sellPrice, maxPax, imageUrl, inclusionIds } = req.body;
  const roomType = await prisma.roomType.update({
    where: { id: req.params.roomTypeId },
    data: {
      name,
      costPrice,
      sellPrice,
      maxPax,
      imageUrl,
      inclusions: inclusionIds !== undefined ? { set: inclusionIds.map((id) => ({ id })) } : undefined,
    },
    include: { inclusions: true },
  });
  // Keep every itinerary that already uses this room type showing the
  // current price instead of a stale snapshot from when it was picked.
  await cascadeRoomTypePriceChange(req.params.roomTypeId);
  res.json(roomType);
});

router.delete("/room-types/:roomTypeId", async (req, res) => {
  await prisma.roomType.delete({ where: { id: req.params.roomTypeId } });
  res.status(204).end();
});

// ---- Meal Costs -------------------------------------------------------------

router.post("/:id/meal-costs", async (req, res) => {
  const { mealType, adultPrice, childPrice } = req.body;
  const mealCost = await prisma.mealCost.create({
    data: { hotelId: req.params.id, mealType, adultPrice, childPrice },
  });
  res.status(201).json(mealCost);
});

router.put("/meal-costs/:mealCostId", async (req, res) => {
  const { mealType, adultPrice, childPrice } = req.body;
  const mealCost = await prisma.mealCost.update({
    where: { id: req.params.mealCostId },
    data: { mealType, adultPrice, childPrice },
  });
  res.json(mealCost);
});

router.delete("/meal-costs/:mealCostId", async (req, res) => {
  await prisma.mealCost.delete({ where: { id: req.params.mealCostId } });
  res.status(204).end();
});

// ---- Holiday Season Pricing -------------------------------------------------

router.post("/room-types/:roomTypeId/season-prices", async (req, res) => {
  const { dateFrom, dateTo, price, imageUrl, daysOfWeek } = req.body;
  const seasonPrice = await prisma.holidaySeasonPrice.create({
    data: {
      roomTypeId: req.params.roomTypeId,
      dateFrom: new Date(dateFrom),
      dateTo: new Date(dateTo),
      price,
      imageUrl,
      daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : [],
    },
  });
  res.status(201).json(seasonPrice);
});

router.put("/season-prices/:seasonPriceId", async (req, res) => {
  const { dateFrom, dateTo, price, imageUrl, daysOfWeek } = req.body;
  const seasonPrice = await prisma.holidaySeasonPrice.update({
    where: { id: req.params.seasonPriceId },
    data: {
      dateFrom: new Date(dateFrom),
      dateTo: new Date(dateTo),
      price,
      imageUrl,
      daysOfWeek: Array.isArray(daysOfWeek) ? daysOfWeek : [],
    },
  });
  res.json(seasonPrice);
});

router.delete("/season-prices/:seasonPriceId", async (req, res) => {
  await prisma.holidaySeasonPrice.delete({ where: { id: req.params.seasonPriceId } });
  res.status(204).end();
});

// ---- Odoo sync --------------------------------------------------------------

router.post("/:id/odoo/push", async (req, res) => {
  const odooId = await sync.pushHotelSupplier(req.params.id);
  res.json({ odooId });
});

module.exports = router;
