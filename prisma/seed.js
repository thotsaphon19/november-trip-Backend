const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const hotel = await prisma.hotelSupplier.create({
    data: {
      hotelCode: "HTL-001",
      name: "Chiang Mai Riverside Hotel",
      contactName: "Khun Somsri",
      phone: "053-123456",
      email: "sales@cmriverside.example",
      address: "99 Riverside Rd, Chiang Mai",
      taxId: "0123456789012",
      roomTypes: {
        create: [
          { name: "Deluxe Twin", costPrice: 1200, sellPrice: 1800, maxPax: 2 },
          { name: "Suite River View", costPrice: 2500, sellPrice: 3600, maxPax: 3 },
        ],
      },
      mealCosts: {
        create: [{ mealType: "Breakfast", adultPrice: 250, childPrice: 150 }],
      },
    },
    include: { roomTypes: true },
  });

  const tourSupplier = await prisma.tourSupplier.create({
    data: {
      supplierCode: "TSP-001",
      name: "Doi Suthep Local Guide Co.",
      phone: "081-2223333",
      email: "contact@doisuthepguide.example",
      line: "@doisuthep",
      activities: {
        create: [
          { name: "Doi Suthep Temple Half-day Tour", category: "Tour", costPrice: 800, sellPrice: 1400 },
          { name: "Elephant Sanctuary Visit", category: "Activities", costPrice: 1500, sellPrice: 2400 },
        ],
      },
    },
    include: { activities: true },
  });

  const product = await prisma.product.create({
    data: {
      tourCode: "NOV-CM-5D",
      tourName: "Chiang Mai 5 Days 4 Nights",
      price: 12900,
      days: 5,
      adults: 2,
      children: 0,
      supplierType: "Hotel",
      hotelSupplierId: hotel.id,
      itinerary: {
        create: [
          {
            dayNumber: 1,
            place: "Arrival & Hotel Check-in",
            category: "Hotels",
            hotelSupplierIdRef: hotel.id,
            roomTypeId: hotel.roomTypes[0].id,
            costPrice: hotel.roomTypes[0].costPrice,
          },
          {
            dayNumber: 2,
            place: "Doi Suthep Temple",
            category: "Tour",
            tourActivityId: tourSupplier.activities[0].id,
            costPrice: tourSupplier.activities[0].costPrice,
          },
          { dayNumber: 3, place: "Free day", category: "Tour", costPrice: 0 },
          {
            dayNumber: 4,
            place: "Elephant Sanctuary",
            category: "Activities",
            tourActivityId: tourSupplier.activities[1].id,
            costPrice: tourSupplier.activities[1].costPrice,
          },
          { dayNumber: 5, place: "Departure", category: "Tour", costPrice: 0 },
        ],
      },
    },
  });

  const quotation = await prisma.quotation.create({
    data: {
      quoteCode: "QT-0001",
      tourCode: product.tourCode,
      customerName: "คุณสมชาย ใจดี",
      days: 5,
      adults: 2,
      children: 0,
      status: "AWAITING_PAYMENT",
      guideName: "พี่แดง",
      includesFlight: true,
      itinerary: {
        create: [
          {
            dayNumber: 1,
            place: "Arrival & Hotel Check-in",
            category: "Hotels",
            roomTypeId: hotel.roomTypes[0].id,
            costPrice: hotel.roomTypes[0].costPrice,
            sellPrice: hotel.roomTypes[0].sellPrice,
          },
          {
            dayNumber: 2,
            place: "Doi Suthep Temple",
            category: "Tour",
            tourActivityId: tourSupplier.activities[0].id,
            costPrice: tourSupplier.activities[0].costPrice,
            sellPrice: tourSupplier.activities[0].sellPrice,
          },
        ],
      },
    },
  });

  // Roll the day-level totals up to the quotation header, same as the
  // PUT /quotations/days/:dayId route does after every edit.
  await prisma.quotation.update({
    where: { id: quotation.id },
    data: { costPrice: 1200 + 800, sellPrice: 1800 + 1400 },
  });

  console.log("Seeded:", {
    hotel: hotel.hotelCode,
    tourSupplier: tourSupplier.supplierCode,
    product: product.tourCode,
    quotation: quotation.quoteCode,
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
