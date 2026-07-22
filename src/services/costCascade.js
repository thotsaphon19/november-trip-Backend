const prisma = require("../lib/prisma");

/**
 * Cost prices on TourDay/QuotationDay are snapshotted at the moment a
 * supplier item (RoomType or TourActivity) is picked, so the itinerary
 * keeps showing what it cost *then*. But that means editing a supplier's
 * price afterwards - or pulling a changed price from Odoo - would silently
 * leave every itinerary that already uses it showing a stale number.
 *
 * These helpers re-stamp every day currently pointing at a given supplier
 * item with its current cost, then re-roll the parent Quotation's totals.
 * Call them any time a RoomType/TourActivity cost changes, whether from a
 * local edit or an Odoo pull.
 */

// If the trip has a start date, resolves the room's price for the calendar
// month `dayNumber` actually falls on (matching a HolidaySeasonPrice range)
// instead of always using the room's flat "ปกติ" cost. Falls back to the
// flat cost when there's no start date or no matching season.
function resolveSeasonalCost(roomType, tripStartDate, dayNumber) {
  if (!tripStartDate) return roomType.costPrice;
  const date = new Date(tripStartDate);
  date.setDate(date.getDate() + (dayNumber - 1));
  const dow = date.getDay(); // 0=Sun..6=Sat

  // Exact date-range match (hotel rate sheets often split mid-month, e.g.
  // "16 Apr" not just "April") - a straight date >= from && date <= to
  // check, no month/year wraparound math needed anymore.
  const inRange = (roomType.seasonPrices || []).filter(
    (sp) => date >= new Date(sp.dateFrom) && date <= new Date(sp.dateTo)
  );

  // Within the date range, a row can also be restricted to specific days of
  // week (e.g. a Fri/Sat rate for the same room, same range). An empty
  // daysOfWeek means "every day". If both a day-restricted row and a
  // catch-all row cover this exact date, the day-restricted one wins -
  // it's the more specific rule (e.g. "Fri/Sat: 3,800" should beat a
  // broader "every day: 3,300" covering the same range).
  const matches = inRange.filter((sp) => !sp.daysOfWeek?.length || sp.daysOfWeek.includes(dow));
  const match = matches.find((sp) => sp.daysOfWeek?.length) || matches[0];

  return match ? match.price : roomType.costPrice;
}

// Re-resolves the seasonal cost for every day of a Product that has a room
// selected - call this after the product's startDate changes, since days
// picked before a start date was set (or picked under a different date)
// need their cost re-evaluated against the now-known calendar month.
async function recomputeProductSeasonalCosts(productId) {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { itinerary: { where: { roomTypeId: { not: null } }, include: { roomType: { include: { seasonPrices: true } } } } },
  });
  for (const day of product.itinerary) {
    const costPrice = resolveSeasonalCost(day.roomType, product.startDate, day.dayNumber);
    if (Number(costPrice) !== Number(day.costPrice)) {
      await prisma.tourDay.update({ where: { id: day.id }, data: { costPrice } });
    }
  }
}

// Same idea for Quotation, plus re-rolls the quotation's totals afterward.
async function recomputeQuotationSeasonalCosts(quotationId) {
  const quotation = await prisma.quotation.findUniqueOrThrow({
    where: { id: quotationId },
    include: { itinerary: { where: { roomTypeId: { not: null } }, include: { roomType: { include: { seasonPrices: true } } } } },
  });
  for (const day of quotation.itinerary) {
    const costPrice = resolveSeasonalCost(day.roomType, quotation.startDate, day.dayNumber);
    if (Number(costPrice) !== Number(day.costPrice)) {
      await prisma.quotationDay.update({ where: { id: day.id }, data: { costPrice } });
    }
  }
  if (quotation.itinerary.length > 0) await recalcQuotationTotals(quotationId);
}

async function recalcQuotationTotals(quotationId) {
  const days = await prisma.quotationDay.findMany({ where: { quotationId } });
  const costPrice = days.reduce((sum, d) => sum + Number(d.costPrice), 0);
  const sellPrice = days.reduce((sum, d) => sum + Number(d.sellPrice), 0);
  await prisma.quotation.update({ where: { id: quotationId }, data: { costPrice, sellPrice } });
}

async function cascadeRoomTypePriceChange(roomTypeId) {
  const roomType = await prisma.roomType.findUniqueOrThrow({ where: { id: roomTypeId } });

  await prisma.tourDay.updateMany({
    where: { roomTypeId },
    data: { costPrice: roomType.costPrice },
  });

  const affectedQuoteDays = await prisma.quotationDay.findMany({ where: { roomTypeId } });
  await prisma.quotationDay.updateMany({
    where: { roomTypeId },
    data: { costPrice: roomType.costPrice },
  });

  const quotationIds = [...new Set(affectedQuoteDays.map((d) => d.quotationId))];
  for (const id of quotationIds) await recalcQuotationTotals(id);

  return { tourDaysUpdated: true, quotationsUpdated: quotationIds.length };
}

async function cascadeTourActivityPriceChange(tourActivityId) {
  const activity = await prisma.tourActivity.findUniqueOrThrow({ where: { id: tourActivityId } });

  await prisma.tourDay.updateMany({
    where: { tourActivityId },
    data: { costPrice: activity.costPrice },
  });

  const affectedQuoteDays = await prisma.quotationDay.findMany({ where: { tourActivityId } });
  await prisma.quotationDay.updateMany({
    where: { tourActivityId },
    data: { costPrice: activity.costPrice },
  });

  const quotationIds = [...new Set(affectedQuoteDays.map((d) => d.quotationId))];
  for (const id of quotationIds) await recalcQuotationTotals(id);

  return { tourDaysUpdated: true, quotationsUpdated: quotationIds.length };
}

module.exports = {
  recalcQuotationTotals,
  cascadeRoomTypePriceChange,
  cascadeTourActivityPriceChange,
  resolveSeasonalCost,
  recomputeProductSeasonalCosts,
  recomputeQuotationSeasonalCosts,
};
