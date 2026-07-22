const prisma = require("../lib/prisma");
const odoo = require("./odooClient");
const { generateNextCode } = require("./codeGenerator");

async function log(entity, entityId, direction, odooModel, odooId, status, message) {
  await prisma.odooSyncLog.create({
    data: { entity, entityId, direction, odooModel, odooId, status, message },
  });
}

// Default logical-field -> Odoo technical-field mapping. Overridden per
// deployment via OdooConfig.fieldMap (edited from Settings > Field Mapping)
// so this app works against Odoo Studio custom fields without code changes.
const DEFAULT_FIELD_MAPS = {
  HotelSupplier: { name: "name", email: "email", phone: "phone", address: "street", taxId: "vat", code: "ref" },
  TourSupplier: { name: "name", email: "email", phone: "phone", phoneSales: "mobile", code: "ref" },
  Product: { name: "name", price: "list_price", code: "default_code" },
};

async function getFieldMap(entity) {
  const config = await prisma.odooConfig.findUnique({ where: { id: "singleton" } });
  const overrides = config?.fieldMap?.[entity] || {};
  return { ...DEFAULT_FIELD_MAPS[entity], ...overrides };
}

/* ------------------------------------------------------------------ */
/* PUSH: app -> Odoo                                                   */
/* ------------------------------------------------------------------ */

async function pushHotelSupplier(id) {
  const hotel = await prisma.hotelSupplier.findUniqueOrThrow({ where: { id } });
  const model = await odoo.resolveModel("HotelSupplier", "res.partner");
  const f = await getFieldMap("HotelSupplier");
  const values = {
    [f.name]: hotel.name,
    [f.email]: hotel.email || false,
    [f.phone]: hotel.phone || false,
    [f.address]: hotel.address || false,
    [f.taxId]: hotel.taxId || false,
    [f.code]: hotel.hotelCode,
    is_company: true,
  };

  try {
    let odooId = hotel.odooId;
    let dropped = [];
    if (odooId) {
      ({ dropped } = await odoo.write(model, odooId, values));
    } else {
      ({ id: odooId, dropped } = await odoo.create(model, values));
    }
    await prisma.hotelSupplier.update({
      where: { id },
      data: { odooId, odooModel: model, odooSyncedAt: new Date() },
    });
    const note = dropped.length ? `Skipped fields not in Odoo: ${dropped.join(", ")}` : null;
    await log("HotelSupplier", id, "PUSH", model, odooId, "SUCCESS", note);
    return odooId;
  } catch (err) {
    await log("HotelSupplier", id, "PUSH", model, hotel.odooId, "FAILED", err.message);
    throw err;
  }
}

async function pushTourSupplier(id) {
  const supplier = await prisma.tourSupplier.findUniqueOrThrow({ where: { id } });
  const model = await odoo.resolveModel("TourSupplier", "res.partner");
  const f = await getFieldMap("TourSupplier");
  const values = {
    [f.name]: supplier.name,
    [f.email]: supplier.email || false,
    [f.phone]: supplier.phone || false,
    [f.phoneSales]: supplier.phoneSales || false,
    [f.code]: supplier.supplierCode,
    is_company: true,
  };

  try {
    let odooId = supplier.odooId;
    let dropped = [];
    if (odooId) {
      ({ dropped } = await odoo.write(model, odooId, values));
    } else {
      ({ id: odooId, dropped } = await odoo.create(model, values));
    }
    await prisma.tourSupplier.update({
      where: { id },
      data: { odooId, odooModel: model, odooSyncedAt: new Date() },
    });
    const note = dropped.length ? `Skipped fields not in Odoo: ${dropped.join(", ")}` : null;
    await log("TourSupplier", id, "PUSH", model, odooId, "SUCCESS", note);
    return odooId;
  } catch (err) {
    await log("TourSupplier", id, "PUSH", model, supplier.odooId, "FAILED", err.message);
    throw err;
  }
}

async function pushProduct(id) {
  const product = await prisma.product.findUniqueOrThrow({ where: { id } });
  const model = await odoo.resolveModel("Product", "product.template");
  const f = await getFieldMap("Product");
  const values = {
    [f.name]: `[${product.tourCode}] ${product.tourName}`,
    [f.price]: Number(product.price),
    [f.code]: product.tourCode,
    sale_ok: true,
    type: "service",
  };

  try {
    let odooId = product.odooId;
    let dropped = [];
    if (odooId) {
      ({ dropped } = await odoo.write(model, odooId, values));
    } else {
      ({ id: odooId, dropped } = await odoo.create(model, values));
    }
    await prisma.product.update({
      where: { id },
      data: { odooId, odooModel: model, odooSyncedAt: new Date() },
    });
    const note = dropped.length ? `Skipped fields not in Odoo: ${dropped.join(", ")}` : null;
    await log("Product", id, "PUSH", model, odooId, "SUCCESS", note);
    return odooId;
  } catch (err) {
    await log("Product", id, "PUSH", model, product.odooId, "FAILED", err.message);
    throw err;
  }
}

/** Push a RoomType as an Odoo product.product so it can be used as a
 *  sale.order.line product_id. Reused across every quotation that
 *  references this room type. */
async function pushRoomTypeProduct(roomTypeId) {
  const roomType = await prisma.roomType.findUniqueOrThrow({
    where: { id: roomTypeId },
    include: { hotel: true },
  });
  if (roomType.odooProductId) return roomType.odooProductId;

  const model = "product.product";
  const { id: odooId, dropped } = await odoo.create(model, {
    name: `${roomType.hotel.name} - ${roomType.name}`,
    list_price: Number(roomType.sellPrice),
    type: "service",
    sale_ok: true,
  });
  await prisma.roomType.update({
    where: { id: roomTypeId },
    data: { odooProductId: odooId, odooProductSyncedAt: new Date() },
  });
  if (dropped.length) {
    await log("RoomType", roomTypeId, "PUSH", model, odooId, "SUCCESS", `Skipped fields not in Odoo: ${dropped.join(", ")}`);
  }
  return odooId;
}

/** Same idea for TourActivity. */
async function pushTourActivityProduct(tourActivityId) {
  const activity = await prisma.tourActivity.findUniqueOrThrow({
    where: { id: tourActivityId },
    include: { supplier: true },
  });

  const model = "product.product";
  const values = {
    name: `${activity.supplier.name} - ${activity.name}`,
    list_price: Number(activity.sellPrice),
    default_code: activity.activityCode || false,
    type: "service",
    sale_ok: true,
  };

  let odooId = activity.odooProductId;
  let dropped = [];
  if (odooId) {
    ({ dropped } = await odoo.write(model, odooId, values));
  } else {
    ({ id: odooId, dropped } = await odoo.create(model, values));
  }

  await prisma.tourActivity.update({
    where: { id: tourActivityId },
    data: { odooProductId: odooId, odooProductSyncedAt: new Date() },
  });
  await log(
    "TourActivity",
    tourActivityId,
    "PUSH",
    model,
    odooId,
    "SUCCESS",
    dropped.length ? `Skipped fields not in Odoo: ${dropped.join(", ")}` : null
  );
  return odooId;
}

/** Find an existing res.partner by name, or create one, and cache the id
 *  on the Quotation so repeated pushes don't create duplicate contacts. */
async function resolvePartnerForQuotation(quotation) {
  if (quotation.odooPartnerId) return quotation.odooPartnerId;

  const matches = await odoo.searchRead(
    "res.partner",
    [["name", "=", quotation.customerName]],
    ["id"],
    { limit: 1 }
  );

  const partnerId = matches.length
    ? matches[0].id
    : (await odoo.create("res.partner", { name: quotation.customerName })).id;

  await prisma.quotation.update({
    where: { id: quotation.id },
    data: { odooPartnerId: partnerId },
  });
  return partnerId;
}

async function pushQuotation(id) {
  const quotation = await prisma.quotation.findUniqueOrThrow({
    where: { id },
    include: { itinerary: { orderBy: { dayNumber: "asc" } } },
  });
  const model = await odoo.resolveModel("Quotation", "sale.order");

  try {
    const partnerId = await resolvePartnerForQuotation(quotation);

    // Build one order line per itinerary day that has a priced item.
    // (1, lineId, vals) updates an existing line; (0, 0, vals) creates one.
    const orderLineCommands = [];
    for (const day of quotation.itinerary) {
      let productId = null;
      if (day.roomTypeId) productId = await pushRoomTypeProduct(day.roomTypeId);
      else if (day.tourActivityId) productId = await pushTourActivityProduct(day.tourActivityId);
      if (!productId) continue; // skip free/unassigned days - nothing to bill

      const lineVals = {
        product_id: productId,
        name: `Day ${day.dayNumber}: ${day.place || day.category}`,
        product_uom_qty: 1,
        price_unit: Number(day.sellPrice),
      };

      orderLineCommands.push(
        day.odooLineId ? [1, day.odooLineId, lineVals] : [0, 0, lineVals]
      );
    }

    const subtotal = quotation.itinerary.reduce((sum, d) => sum + Number(d.sellPrice), 0);
    const vatNote = quotation.includeVat
      ? ` | VAT ${Number(quotation.vatRate)}%: ${(subtotal * (Number(quotation.vatRate) / 100)).toFixed(2)} | Total incl. VAT: ${(
          subtotal *
          (1 + Number(quotation.vatRate) / 100)
        ).toFixed(2)}`
      : "";

    const values = {
      partner_id: partnerId,
      client_order_ref: quotation.quoteCode,
      note: `Auto-synced from November Trip. Tour code: ${quotation.tourCode || "-"}${vatNote}`,
      order_line: orderLineCommands,
    };

    let odooId = quotation.odooId;
    let dropped = [];
    if (odooId) {
      ({ dropped } = await odoo.write(model, odooId, values));
    } else {
      ({ id: odooId, dropped } = await odoo.create(model, values));
    }

    // Read back the order lines so we can store each line's Odoo id
    // against the matching QuotationDay for future updates.
    const [orderRecord] = await odoo.searchRead(
      model,
      [["id", "=", odooId]],
      ["order_line"]
    );
    const lineIds = orderRecord?.order_line || [];
    const lines = lineIds.length
      ? await odoo.searchRead("sale.order.line", [["id", "in", lineIds]], ["id", "name"])
      : [];

    const claimedLineIds = new Set(quotation.itinerary.filter((d) => d.odooLineId).map((d) => d.odooLineId));
    for (const day of quotation.itinerary) {
      if (day.odooLineId) continue;
      const expectedName = `Day ${day.dayNumber}: ${day.place || day.category}`;
      const match = lines.find((l) => l.name === expectedName && !claimedLineIds.has(l.id));
      if (match) {
        claimedLineIds.add(match.id);
        await prisma.quotationDay.update({
          where: { id: day.id },
          data: { odooLineId: match.id },
        });
      }
    }

    await prisma.quotation.update({
      where: { id },
      data: { odooId, odooModel: model, odooSyncedAt: new Date() },
    });
    const droppedNote = dropped.length ? ` | Skipped fields not in Odoo: ${dropped.join(", ")}` : "";
    await log("Quotation", id, "PUSH", model, odooId, "SUCCESS", `${orderLineCommands.length} line(s) synced${droppedNote}`);
    return odooId;
  } catch (err) {
    await log("Quotation", id, "PUSH", model, quotation.odooId, "FAILED", err.message);
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* PULL: Odoo -> app                                                    */
/* ------------------------------------------------------------------ */

async function pullHotelPartners() {
  const model = await odoo.resolveModel("HotelSupplier", "res.partner");
  const f = await getFieldMap("HotelSupplier");
  const records = await odoo.searchRead(
    model,
    [["is_company", "=", true]],
    ["id", f.name, f.email, f.phone, f.address, f.taxId, f.code]
  );

  let updated = 0;
  for (const rec of records) {
    const existing = await prisma.hotelSupplier.findFirst({
      where: { odooId: rec.id, odooModel: model },
    });
    if (existing) {
      await prisma.hotelSupplier.update({
        where: { id: existing.id },
        data: {
          name: rec[f.name],
          email: rec[f.email] || existing.email,
          phone: rec[f.phone] || existing.phone,
          address: rec[f.address] || existing.address,
          taxId: rec[f.taxId] || existing.taxId,
          odooSyncedAt: new Date(),
        },
      });
      updated++;
      await log("HotelSupplier", existing.id, "PULL", model, rec.id, "SUCCESS", null);
    }
    // Records that don't exist locally yet are intentionally left alone -
    // pulling only updates suppliers this app already pushed/knows about,
    // so a stray Odoo contact can't silently become a hotel supplier.
  }
  return { fetched: records.length, updated };
}

async function pullTourPartners() {
  const model = await odoo.resolveModel("TourSupplier", "res.partner");
  const f = await getFieldMap("TourSupplier");
  const records = await odoo.searchRead(
    model,
    [["is_company", "=", true]],
    ["id", f.name, f.email, f.phone, f.phoneSales, f.code]
  );

  let updated = 0;
  for (const rec of records) {
    const existing = await prisma.tourSupplier.findFirst({
      where: { odooId: rec.id, odooModel: model },
    });
    if (existing) {
      await prisma.tourSupplier.update({
        where: { id: existing.id },
        data: {
          name: rec[f.name],
          email: rec[f.email] || existing.email,
          phone: rec[f.phone] || existing.phone,
          phoneSales: rec[f.phoneSales] || existing.phoneSales,
          odooSyncedAt: new Date(),
        },
      });
      updated++;
      await log("TourSupplier", existing.id, "PULL", model, rec.id, "SUCCESS", null);
    }
  }
  return { fetched: records.length, updated };
}

async function pullProducts() {
  const model = await odoo.resolveModel("Product", "product.template");
  const f = await getFieldMap("Product");
  const records = await odoo.searchRead(model, [], ["id", f.name, f.price, f.code]);

  let updated = 0;
  for (const rec of records) {
    const existing = await prisma.product.findFirst({ where: { odooId: rec.id, odooModel: model } });
    if (existing) {
      await prisma.product.update({
        where: { id: existing.id },
        data: { price: rec[f.price], odooSyncedAt: new Date() },
      });
      updated++;
      await log("Product", existing.id, "PULL", model, rec.id, "SUCCESS", null);
    }
  }
  return { fetched: records.length, updated };
}

/** Pulls price changes for the product.product records this app created
 *  from RoomType/TourActivity (see pushRoomTypeProduct/pushTourActivityProduct
 *  above), and cascades any change into every itinerary already using them
 *  so cost totals never go stale. */
async function pullSupplierProducts() {
  const roomTypeIds = await prisma.roomType.findMany({
    where: { odooProductId: { not: null } },
    select: { id: true, odooProductId: true },
  });
  const activityIds = await prisma.tourActivity.findMany({
    where: { odooProductId: { not: null } },
    select: { id: true, odooProductId: true },
  });

  const allOdooIds = [...roomTypeIds, ...activityIds].map((r) => r.odooProductId);
  if (allOdooIds.length === 0) return { fetched: 0, updated: 0 };

  const records = await odoo.searchRead(
    "product.product",
    [["id", "in", allOdooIds]],
    ["id", "list_price", "default_code"]
  );
  const dataById = Object.fromEntries(records.map((r) => [r.id, r]));

  let updated = 0;
  for (const rt of roomTypeIds) {
    if (!(rt.odooProductId in dataById)) continue;
    await prisma.roomType.update({
      where: { id: rt.id },
      data: { sellPrice: dataById[rt.odooProductId].list_price, odooProductSyncedAt: new Date() },
    });
    await log("RoomType", rt.id, "PULL", "product.product", rt.odooProductId, "SUCCESS", null);
    updated++;
  }
  for (const act of activityIds) {
    if (!(act.odooProductId in dataById)) continue;
    const rec = dataById[act.odooProductId];
    await prisma.tourActivity.update({
      where: { id: act.id },
      data: {
        sellPrice: rec.list_price,
        activityCode: rec.default_code || undefined,
        odooProductSyncedAt: new Date(),
      },
    });
    await log("TourActivity", act.id, "PULL", "product.product", act.odooProductId, "SUCCESS", null);
    updated++;
  }

  return { fetched: records.length, updated };
}

async function pullSaleOrders() {
  const model = await odoo.resolveModel("Quotation", "sale.order");
  const records = await odoo.searchRead(
    model,
    [],
    ["id", "name", "state", "amount_total", "client_order_ref"]
  );

  const stateMap = {
    draft: "QUOTED",
    sent: "QUOTED",
    sale: "AWAITING_PAYMENT",
    done: "PAID",
    cancel: "CANCELLED",
  };

  let updated = 0;
  for (const rec of records) {
    const existing = await prisma.quotation.findFirst({
      where: { odooId: rec.id, odooModel: model },
    });
    if (existing) {
      await prisma.quotation.update({
        where: { id: existing.id },
        data: {
          status: stateMap[rec.state] || existing.status,
          odooSyncedAt: new Date(),
        },
      });
      updated++;
      await log("Quotation", existing.id, "PULL", model, rec.id, "SUCCESS", null);
    }
  }
  return { fetched: records.length, updated };
}

/**
 * Imports sale.order records that were created directly in Odoo (never
 * pushed from this app, so they have no matching Quotation.odooId yet) as
 * brand-new Quotations - so quotes built in Odoo don't have to be retyped
 * here to get e.g. the bilingual PDF or the day-by-day itinerary tools.
 *
 * Important limitation: sale.order.line is a flat product/qty/price list -
 * Odoo has no concept of "which day of the trip" a line belongs to. Every
 * imported line lands on Day 1 as a manual (non-supplier-linked) item with
 * cost left at 0 (Odoo doesn't track our internal cost price either) and
 * sell price taken from the order line subtotal. The person still needs to
 * spread the items across the right days afterward - this saves the retyping
 * of customer info, item names, and prices, not the day-by-day planning.
 */
async function importSaleOrdersFromOdoo() {
  const model = await odoo.resolveModel("Quotation", "sale.order");
  const stateMap = {
    draft: "QUOTED",
    sent: "QUOTED",
    sale: "AWAITING_PAYMENT",
    done: "PAID",
    cancel: "CANCELLED",
  };

  const records = await odoo.searchRead(
    model,
    [],
    ["id", "name", "state", "partner_id", "amount_total", "client_order_ref", "order_line"]
  );

  const alreadyLinked = await prisma.quotation.findMany({
    where: { odooModel: model, odooId: { in: records.map((r) => r.id) } },
    select: { odooId: true },
  });
  const linkedIds = new Set(alreadyLinked.map((q) => q.odooId));
  const newRecords = records.filter((r) => !linkedIds.has(r.id));

  if (newRecords.length === 0) return { fetched: records.length, imported: 0, skipped: records.length };

  // Batch-fetch partner contact details for every order in one call.
  const partnerIds = [...new Set(newRecords.map((r) => r.partner_id && r.partner_id[0]).filter(Boolean))];
  const partners = partnerIds.length
    ? await odoo.searchRead("res.partner", [["id", "in", partnerIds]], ["id", "name", "email", "phone", "street"])
    : [];
  const partnerById = Object.fromEntries(partners.map((p) => [p.id, p]));

  // Batch-fetch every order line for every order in one call.
  const orderIds = newRecords.map((r) => r.id);
  const lines = await odoo.searchRead(
    "sale.order.line",
    [["order_id", "in", orderIds]],
    ["order_id", "name", "price_subtotal", "product_uom_qty"]
  );
  const linesByOrder = {};
  for (const line of lines) {
    const orderId = Array.isArray(line.order_id) ? line.order_id[0] : line.order_id;
    (linesByOrder[orderId] ||= []).push(line);
  }

  let imported = 0;
  for (const rec of newRecords) {
    const partner = rec.partner_id ? partnerById[rec.partner_id[0]] : null;
    const orderLines = linesByOrder[rec.id] || [];

    const quoteCode =
      (rec.name && !(await prisma.quotation.findUnique({ where: { quoteCode: rec.name } })) && rec.name) ||
      (await generateNextCode(prisma, "quotation", "quoteCode", "QT-", 4));

    const created = await prisma.quotation.create({
      data: {
        quoteCode,
        tourCode: rec.client_order_ref || null,
        customerName: partner?.name || "(นำเข้าจาก Odoo)",
        customerEmail: partner?.email || null,
        customerPhone: partner?.phone || null,
        customerAddress: partner?.street || null,
        days: 1,
        adults: 2,
        children: 0,
        sellPrice: rec.amount_total || 0,
        costPrice: 0,
        status: stateMap[rec.state] || "QUOTED",
        odooId: rec.id,
        odooModel: model,
        odooSyncedAt: new Date(),
        itinerary: {
          create: orderLines.length
            ? orderLines.map((line) => ({
                dayNumber: 1,
                category: "Tour",
                place: line.name,
                costPrice: 0,
                sellPrice: line.price_subtotal || 0,
              }))
            : [{ dayNumber: 1, category: "Tour", costPrice: 0, sellPrice: rec.amount_total || 0 }],
        },
      },
    });
    imported++;
    await log(
      "Quotation",
      created.id,
      "PULL",
      model,
      rec.id,
      "SUCCESS",
      `Imported as new quotation (${orderLines.length} line item(s) on Day 1 - needs reorganizing)`
    );
  }

  return { fetched: records.length, imported, skipped: records.length - imported };
}

module.exports = {
  pushHotelSupplier,
  pushTourSupplier,
  pushProduct,
  pushQuotation,
  pullHotelPartners,
  pullTourPartners,
  pullProducts,
  pullSupplierProducts,
  pullSaleOrders,
  importSaleOrdersFromOdoo,
  getFieldMap,
  DEFAULT_FIELD_MAPS,
};
