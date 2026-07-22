const express = require("express");
const prisma = require("../lib/prisma");

const router = express.Router();

function requireWebhookSecret(req, res, next) {
  const configured = process.env.ODOO_WEBHOOK_SECRET;
  if (!configured) {
    return res.status(503).json({
      error: "Webhook not enabled. Set ODOO_WEBHOOK_SECRET in the backend .env to turn it on.",
    });
  }
  const provided = req.headers["x-webhook-secret"];
  if (provided !== configured) {
    return res.status(401).json({ error: "Invalid webhook secret" });
  }
  next();
}

// Configure this URL in Odoo as the target of an Automated Action / Webhook
// (Settings > Technical > Automation Rules > built-in "Webhook" action in
// Odoo 17+, or "Execute Python Code" using `requests.post` on older
// versions). Send header `X-Webhook-Secret: <ODOO_WEBHOOK_SECRET>`.
// Expected payload: { model, odooId, entity, action, values }
router.post("/", requireWebhookSecret, async (req, res) => {
  const { model, odooId, entity, action, values = {} } = req.body;

  if (!entity || !odooId) {
    return res.status(400).json({ error: "entity and odooId are required" });
  }

  try {
    switch (entity) {
      case "HotelSupplier": {
        const existing = await prisma.hotelSupplier.findFirst({ where: { odooId } });
        if (action === "unlink" && existing) {
          await prisma.hotelSupplier.delete({ where: { id: existing.id } });
        } else if (existing) {
          await prisma.hotelSupplier.update({
            where: { id: existing.id },
            data: {
              name: values.name,
              email: values.email,
              phone: values.phone,
              address: values.street,
              taxId: values.vat,
              odooSyncedAt: new Date(),
            },
          });
        } else {
          await prisma.hotelSupplier.create({
            data: {
              hotelCode: values.ref || `ODOO-${odooId}`,
              name: values.name,
              email: values.email,
              phone: values.phone,
              address: values.street,
              taxId: values.vat,
              odooId,
              odooModel: model,
              odooSyncedAt: new Date(),
            },
          });
        }
        break;
      }
      case "TourSupplier": {
        const existing = await prisma.tourSupplier.findFirst({ where: { odooId } });
        if (action === "unlink" && existing) {
          await prisma.tourSupplier.delete({ where: { id: existing.id } });
        } else if (existing) {
          await prisma.tourSupplier.update({
            where: { id: existing.id },
            data: {
              name: values.name,
              email: values.email,
              phone: values.phone,
              odooSyncedAt: new Date(),
            },
          });
        }
        break;
      }
      case "Quotation": {
        const existing = await prisma.quotation.findFirst({ where: { odooId } });
        if (existing) {
          await prisma.quotation.update({
            where: { id: existing.id },
            data: { status: values.status || existing.status, odooSyncedAt: new Date() },
          });
        }
        break;
      }
      case "Product": {
        const existing = await prisma.product.findFirst({ where: { odooId } });
        if (existing && values.list_price !== undefined) {
          await prisma.product.update({
            where: { id: existing.id },
            data: { price: values.list_price, odooSyncedAt: new Date() },
          });
        }
        break;
      }
      // Odoo id of a product.product created from a RoomType (see
      // pushRoomTypeProduct in syncService.js). A price edit in Odoo
      // updates the room type's sell price and re-stamps every itinerary
      // day already using it.
      case "RoomTypeProduct": {
        const existing = await prisma.roomType.findFirst({ where: { odooProductId: odooId } });
        if (existing && values.list_price !== undefined) {
          await prisma.roomType.update({
            where: { id: existing.id },
            data: { sellPrice: values.list_price, odooProductSyncedAt: new Date() },
          });
        }
        break;
      }
      case "TourActivityProduct": {
        const existing = await prisma.tourActivity.findFirst({ where: { odooProductId: odooId } });
        if (existing && values.list_price !== undefined) {
          await prisma.tourActivity.update({
            where: { id: existing.id },
            data: { sellPrice: values.list_price, odooProductSyncedAt: new Date() },
          });
        }
        break;
      }
      default:
        return res.status(400).json({ error: `Unsupported entity: ${entity}` });
    }

    await prisma.odooSyncLog.create({
      data: {
        entity,
        entityId: String(odooId),
        direction: "PULL",
        odooModel: model || "unknown",
        odooId,
        status: "SUCCESS",
        message: `Webhook action=${action || "update"}`,
      },
    });

    res.json({ received: true });
  } catch (err) {
    await prisma.odooSyncLog.create({
      data: {
        entity,
        entityId: String(odooId),
        direction: "PULL",
        odooModel: model || "unknown",
        odooId,
        status: "FAILED",
        message: err.message,
      },
    });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
