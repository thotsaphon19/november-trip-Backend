/**
 * Generates the next sequential code for a prefix like "HT-" or "TSP-" by
 * scanning existing codes for that prefix and incrementing the highest
 * number found - so it stays correct even if codes were deleted out of
 * order, imported from Odoo with gaps, or customized by hand.
 *
 * @param {import("@prisma/client").PrismaClient} prisma
 * @param {"hotelSupplier" | "tourSupplier"} model
 * @param {"hotelCode" | "supplierCode"} field
 * @param {string} prefix e.g. "HT-"
 * @param {number} padLength zero-pad width, e.g. 2 -> "01"
 */
async function generateNextCode(prisma, model, field, prefix, padLength = 2) {
  const rows = await prisma[model].findMany({
    where: { [field]: { startsWith: prefix } },
    select: { [field]: true },
  });

  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`);
  let maxNumber = 0;
  for (const row of rows) {
    const match = row[field]?.match(pattern);
    if (match) maxNumber = Math.max(maxNumber, parseInt(match[1], 10));
  }

  const next = maxNumber + 1;
  return `${prefix}${String(next).padStart(padLength, "0")}`;
}

module.exports = { generateNextCode };
