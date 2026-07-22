const PDFDocument = require("pdfkit");
const axios = require("axios");
const path = require("path");

const THAI_FONT = path.join(__dirname, "..", "assets", "fonts", "NotoSansThai.ttf");
const PRIMARY_COLOR = "#2563eb";
const MUTED_COLOR = "#64748b";
const BORDER_COLOR = "#e2e8f0";

// Only the document's own labels/headings are translated - customer names,
// place names, hotel names etc. are free text the person typed in Thai and
// are shown as-is in either language (this isn't a translation service).
const LABELS = {
  th: {
    quotation: "ใบเสนอราคา",
    quoteNo: "เลขที่",
    date: "วันที่",
    tourCode: "รหัสทัวร์",
    quoteTo: "เสนอราคาให้",
    days: "จำนวนวัน",
    daysUnit: "วัน",
    adults: "ผู้ใหญ่",
    adultsUnit: "ท่าน",
    children: "เด็ก",
    childrenUnit: "ท่าน",
    taxId: "เลขประจำตัวผู้เสียภาษี",
    colDay: "วัน",
    colItem: "รายการ",
    colQty: "จำนวน",
    colAmount: "ราคา (บาท)",
    noItems: "ยังไม่มีรายการที่กำหนดราคาขาย",
    subtotal: "ราคารวม (Subtotal)",
    vat: "ภาษีมูลค่าเพิ่ม (VAT",
    grandTotal: "ยอดรวมทั้งสิ้น",
    guide: "ไกด์ดูแล",
    includesFlight: "ราคานี้รวมตั๋วเครื่องบิน",
    excludesFlight: "ราคานี้ไม่รวมตั๋วเครื่องบิน",
    thankYou: "ขอบคุณที่ใช้บริการ",
    dateLocale: "th-TH",
    policiesHeading: "เงื่อนไขและนโยบาย",
    preliminaryNote: "เอกสารนี้เป็นใบเสนอราคาเบื้องต้น รายละเอียดโปรแกรมฉบับเต็มจะจัดส่งให้หลังยืนยันการจอง",
  },
  en: {
    quotation: "QUOTATION",
    quoteNo: "No.",
    date: "Date",
    tourCode: "Tour Code",
    quoteTo: "Quotation For",
    days: "Duration",
    daysUnit: "days",
    adults: "Adults",
    adultsUnit: "pax",
    children: "Children",
    childrenUnit: "pax",
    taxId: "Tax ID",
    colDay: "Day",
    colItem: "Description",
    colQty: "Qty",
    colAmount: "Amount (THB)",
    noItems: "No priced items yet",
    subtotal: "Subtotal",
    vat: "VAT",
    grandTotal: "Grand Total",
    guide: "Tour Guide",
    includesFlight: "Price includes airfare",
    excludesFlight: "Price excludes airfare",
    thankYou: "Thank you for your business",
    dateLocale: "en-US",
    policiesHeading: "Terms & Policies",
    preliminaryNote: "This is a preliminary quotation. The full detailed itinerary will be sent after your booking is confirmed.",
  },
};

function money(n) {
  return Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const { data } = await axios.get(url, { responseType: "arraybuffer", timeout: 8000 });
    return Buffer.from(data);
  } catch {
    return null; // logo is decorative - never let a fetch failure break the PDF
  }
}

/**
 * Renders a quotation PDF. Two params control the output:
 * - lang: "th" (default) or "en" - only the document's own labels change,
 *   not free-text content like customer/place/hotel names.
 * - detail: "full" (default) shows one row per itinerary item plus the
 *   policies section - meant for the confirmed/paid customer. "simple"
 *   collapses each day into a single summary row with no per-item pricing
 *   and skips policies - meant for the first proposal sent to a lead.
 * Returns a Buffer (caller streams it back as the HTTP response).
 */
async function generateQuotationPdf(quotation, appSettings, lang = "th", detail = "full") {
  const t = LABELS[lang] || LABELS.th;
  const logoBuffer = await fetchImageBuffer(appSettings?.companyLogoUrl);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.registerFont("Thai", THAI_FONT);
    doc.font("Thai");

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    // ---- Header: logo + company info (left), title + quote meta (right) --
    let headerBottom = doc.y;

    if (logoBuffer) {
      try {
        doc.image(logoBuffer, left, doc.y, { fit: [90, 60] });
      } catch {
        /* corrupt/unsupported image format - skip silently */
      }
    }

    const companyInfoX = logoBuffer ? left + 100 : left;
    let cy = doc.y;
    doc.fontSize(13).fillColor("#0f172a").text(appSettings?.companyName || "November Trip", companyInfoX, cy, {
      width: 260,
    });
    doc.fontSize(9).fillColor(MUTED_COLOR);
    if (appSettings?.companyAddress) doc.text(appSettings.companyAddress, companyInfoX, doc.y + 2, { width: 260 });
    const contactLine = [appSettings?.companyPhone, appSettings?.companyEmail].filter(Boolean).join("  ·  ");
    if (contactLine) doc.text(contactLine, companyInfoX, doc.y + 2, { width: 260 });
    if (appSettings?.companyTaxId) doc.text(`${t.taxId}: ${appSettings.companyTaxId}`, companyInfoX, doc.y + 2, { width: 260 });

    // Title block, right-aligned
    const titleX = left + pageWidth - 220;
    doc.fontSize(20).fillColor(PRIMARY_COLOR).text(t.quotation, titleX, headerBottom, { width: 220, align: "right" });
    doc.fontSize(9).fillColor(MUTED_COLOR);
    doc.text(`${t.quoteNo}: ${quotation.quoteCode}`, titleX, doc.y + 4, { width: 220, align: "right" });
    doc.text(
      `${t.date}: ${new Date(quotation.createdAt).toLocaleDateString(t.dateLocale, { year: "numeric", month: "long", day: "numeric" })}`,
      titleX,
      doc.y + 2,
      { width: 220, align: "right" }
    );
    if (quotation.tourCode) doc.text(`${t.tourCode}: ${quotation.tourCode}`, titleX, doc.y + 2, { width: 220, align: "right" });

    headerBottom = Math.max(doc.y, headerBottom + 70);
    doc.y = headerBottom + 15;

    // ---- Divider -------------------------------------------------------
    doc.moveTo(left, doc.y).lineTo(left + pageWidth, doc.y).strokeColor(BORDER_COLOR).lineWidth(1).stroke();
    doc.moveDown(1);

    // ---- Customer box ----------------------------------------------------
    const boxTop = doc.y;
    doc.fontSize(9).fillColor(MUTED_COLOR).text(t.quoteTo, left, boxTop);
    doc.fontSize(12).fillColor("#0f172a").text(quotation.customerName, left, doc.y + 3);
    doc.fontSize(9).fillColor(MUTED_COLOR);
    if (quotation.customerAddress) doc.text(quotation.customerAddress, left, doc.y + 2, { width: 300 });
    const custContact = [quotation.customerPhone, quotation.customerEmail].filter(Boolean).join("  ·  ");
    if (custContact) doc.text(custContact, left, doc.y + 2, { width: 300 });

    doc.fontSize(9).fillColor(MUTED_COLOR);
    doc.text(`${t.days}: ${quotation.days} ${t.daysUnit}`, left + 320, boxTop, { width: 200 });
    doc.text(`${t.adults}: ${quotation.adults} ${t.adultsUnit}  ${t.children}: ${quotation.children} ${t.childrenUnit}`, left + 320, doc.y + 2, {
      width: 200,
    });

    doc.y = Math.max(doc.y, boxTop + 60);
    doc.moveDown(1);

    // ---- Itinerary table --------------------------------------------------
    const priced = quotation.itinerary.filter((d) => Number(d.sellPrice) > 0);

    // "simple" mode: one row per day (combined description, summed price) -
    // hides the internal per-item breakdown, appropriate for a first pitch.
    const rows =
      detail === "simple"
        ? Object.values(
            priced.reduce((byDay, item) => {
              const key = item.dayNumber;
              if (!byDay[key]) byDay[key] = { dayNumber: item.dayNumber, places: [], amount: 0 };
              byDay[key].places.push(item.place || item.category);
              byDay[key].amount += Number(item.sellPrice);
              return byDay;
            }, {})
          )
            .sort((a, b) => a.dayNumber - b.dayNumber)
            .map((d) => ({ dayNumber: d.dayNumber, description: d.places.join(", "), amount: d.amount }))
        : priced.map((item) => ({ dayNumber: item.dayNumber, description: item.place || item.category, amount: Number(item.sellPrice) }));

    const colDay = left;
    const colDesc = left + 50;
    const colQty = left + pageWidth - 150;
    const colAmount = left + pageWidth - 100;

    function tableHeader() {
      const y = doc.y;
      doc.rect(left, y, pageWidth, 22).fill(PRIMARY_COLOR);
      doc.fillColor("#fff").fontSize(9);
      doc.text(t.colDay, colDay + 8, y + 6, { width: 35 });
      doc.text(t.colItem, colDesc, y + 6, { width: colQty - colDesc - 10 });
      if (detail !== "simple") doc.text(t.colQty, colQty, y + 6, { width: 50, align: "center" });
      doc.text(t.colAmount, colAmount, y + 6, { width: pageWidth - (colAmount - left) - 8, align: "right" });
      doc.y = y + 22;
    }

    tableHeader();

    let subtotal = 0;
    rows.forEach((row, i) => {
      if (doc.y > doc.page.height - 200) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        tableHeader();
      }
      const rowY = doc.y;
      subtotal += row.amount;

      if (i % 2 === 1) doc.rect(left, rowY, pageWidth, 20).fill("#f8fafc");

      doc.fillColor("#334155").fontSize(9);
      doc.text(String(row.dayNumber), colDay + 8, rowY + 5, { width: 35 });
      doc.text(row.description, colDesc, rowY + 5, { width: colQty - colDesc - 10 });
      if (detail !== "simple") doc.text("1", colQty, rowY + 5, { width: 50, align: "center" });
      doc.text(money(row.amount), colAmount, rowY + 5, { width: pageWidth - (colAmount - left) - 8, align: "right" });
      doc.y = rowY + 20;
    });

    // If nothing has a sell price yet, still show one info row so the PDF
    // isn't a blank table.
    if (rows.length === 0) {
      doc.fillColor(MUTED_COLOR).fontSize(9).text(t.noItems, colDesc, doc.y + 6);
      doc.moveDown(1.5);
    }

    doc.moveTo(left, doc.y).lineTo(left + pageWidth, doc.y).strokeColor(BORDER_COLOR).stroke();
    doc.moveDown(0.8);

    // ---- Totals -------------------------------------------------------
    const totalsX = left + pageWidth - 220;
    function totalRow(label, value, opts = {}) {
      const y = doc.y;
      doc.fontSize(opts.big ? 12 : 10).fillColor(opts.big ? "#0f172a" : MUTED_COLOR);
      doc.text(label, totalsX, y, { width: 120 });
      doc.text(`฿${money(value)}`, totalsX + 120, y, { width: 100, align: "right" });
      doc.y = y + (opts.big ? 20 : 16);
    }

    const vatAmount = quotation.includeVat ? subtotal * (Number(quotation.vatRate) / 100) : 0;
    const grandTotal = subtotal + vatAmount;

    totalRow(t.subtotal, subtotal);
    if (quotation.includeVat) {
      totalRow(`${t.vat} ${Number(quotation.vatRate)}%)`, vatAmount);
    }
    doc.moveTo(totalsX, doc.y + 2).lineTo(left + pageWidth, doc.y + 2).strokeColor(BORDER_COLOR).stroke();
    doc.y += 8;
    totalRow(t.grandTotal, grandTotal, { big: true });

    // ---- Footer ---------------------------------------------------------
    doc.moveDown(2);
    if (quotation.guideName) {
      doc.fontSize(9).fillColor(MUTED_COLOR).text(`${t.guide}: ${quotation.guideName}`, left, doc.y);
    }
    doc.fontSize(9).fillColor(MUTED_COLOR).text(
      quotation.includesFlight ? t.includesFlight : t.excludesFlight,
      left,
      doc.y + 4
    );

    // ---- Policies (full detail only) -------------------------------------
    if (detail !== "simple" && quotation.policies?.length > 0) {
      doc.moveDown(1.5);
      if (doc.y > doc.page.height - 150) {
        doc.addPage();
        doc.y = doc.page.margins.top;
      }
      doc.fontSize(11).fillColor("#0f172a").text(t.policiesHeading, left, doc.y);
      doc.moveDown(0.3);
      quotation.policies.forEach((p) => {
        if (doc.y > doc.page.height - 100) {
          doc.addPage();
          doc.y = doc.page.margins.top;
        }
        doc.fontSize(9).fillColor(PRIMARY_COLOR).text(p.conditionType.label, left, doc.y + 4);
        doc.fontSize(9).fillColor("#334155").text(p.content, left, doc.y + 2, { width: pageWidth });
      });
    }

    // ---- Preliminary-quote disclaimer (simple mode only) ------------------
    if (detail === "simple") {
      doc.moveDown(1.5);
      doc.fontSize(8.5).fillColor(MUTED_COLOR).text(t.preliminaryNote, left, doc.y, { width: pageWidth, align: "center" });
    }

    doc.moveDown(2);
    doc.fontSize(9).fillColor(MUTED_COLOR).text(t.thankYou, left, doc.y, { width: pageWidth, align: "center" });

    doc.end();
  });
}

module.exports = { generateQuotationPdf };
