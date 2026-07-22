const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

// The Report page reads straight from Quotation - no separate ledger to
// re-type. tourCode, customerName, costPrice, and sellPrice are already
// kept in sync automatically as itinerary days are priced (see
// routes/quotations.js). guideName/includesFlight/status are editable
// directly from this page since they're usually only known once a
// quotation is confirmed as a booking.

router.get("/", async (req, res) => {
  const { q, status, from, to } = req.query;

  const quotations = await prisma.quotation.findMany({
    where: {
      AND: [
        q
          ? {
              OR: [
                { tourCode: { contains: q, mode: "insensitive" } },
                { quoteCode: { contains: q, mode: "insensitive" } },
                { customerName: { contains: q, mode: "insensitive" } },
              ],
            }
          : {},
        status ? { status } : {},
        from ? { createdAt: { gte: new Date(from) } } : {},
        to ? { createdAt: { lte: new Date(to) } } : {},
      ],
    },
    orderBy: { createdAt: "desc" },
  });

  const totals = quotations.reduce(
    (acc, r) => {
      acc.totalCost += Number(r.costPrice);
      acc.totalSell += Number(r.sellPrice);
      acc.totalProfit += Number(r.sellPrice) - Number(r.costPrice);
      return acc;
    },
    { totalCost: 0, totalSell: 0, totalProfit: 0 }
  );

  res.json({ rows: quotations, totals, count: quotations.length });
});

// Quick inline edit for the report-only fields (guide, flight, status)
// without going back into the full Quotation editor.
router.put("/:id", async (req, res) => {
  const { status, guideName, includesFlight } = req.body;
  const quotation = await prisma.quotation.update({
    where: { id: req.params.id },
    data: { status, guideName, includesFlight },
  });
  res.json(quotation);
});

module.exports = router;
