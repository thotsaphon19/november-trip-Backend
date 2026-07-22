const express = require("express");
const prisma = require("../lib/prisma");
const mailer = require("../services/mailer");
const line = require("../services/lineMessaging");
const { requireAuth, requireAdmin } = require("../middleware/authMiddleware");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Appearance - public GET so the Login page can theme itself too      */
/* ------------------------------------------------------------------ */

router.get("/appearance", async (req, res) => {
  const settings = await prisma.appSettings.findUnique({ where: { id: "singleton" } });
  res.json(
    settings || {
      primaryColor: "#2563eb",
      fontFamily: "Inter",
      companyName: "November Trip",
      companyLogoUrl: null,
      companyAddress: null,
      companyTaxId: null,
      companyPhone: null,
      companyEmail: null,
      contractWarningDays: 7,
    }
  );
});

router.put("/appearance", requireAuth, requireAdmin, async (req, res) => {
  const {
    primaryColor,
    fontFamily,
    companyName,
    companyLogoUrl,
    companyAddress,
    companyTaxId,
    companyPhone,
    companyEmail,
    contractWarningDays,
  } = req.body;
  const data = {
    primaryColor,
    fontFamily,
    companyName,
    companyLogoUrl,
    companyAddress,
    companyTaxId,
    companyPhone,
    companyEmail,
    // Clamp to a sane range - 0 would mean "always show", negative makes no
    // sense, and leaving it undefined (field not sent) keeps the existing value.
    contractWarningDays: contractWarningDays !== undefined ? Math.max(0, Math.min(365, Number(contractWarningDays))) : undefined,
  };
  const settings = await prisma.appSettings.upsert({
    where: { id: "singleton" },
    update: data,
    create: { id: "singleton", ...data },
  });
  res.json(settings);
});

/* ------------------------------------------------------------------ */
/* Email (SMTP)                                                        */
/* ------------------------------------------------------------------ */

router.get("/email", requireAuth, requireAdmin, async (req, res) => {
  const settings = await prisma.emailSettings.findUnique({ where: { id: "singleton" } });
  if (!settings) return res.json(null);
  const { smtpPass, ...safe } = settings;
  res.json({ ...safe, smtpPassSet: !!smtpPass });
});

router.put("/email", requireAuth, requireAdmin, async (req, res) => {
  const { smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, fromName, fromEmail } = req.body;
  const settings = await prisma.emailSettings.upsert({
    where: { id: "singleton" },
    update: {
      smtpHost,
      smtpPort,
      smtpSecure,
      smtpUser,
      fromName,
      fromEmail,
      ...(smtpPass ? { smtpPass } : {}),
    },
    create: { id: "singleton", smtpHost, smtpPort, smtpSecure, smtpUser, smtpPass, fromName, fromEmail },
  });
  const { smtpPass: _hidden, ...safe } = settings;
  res.json({ ...safe, smtpPassSet: true });
});

router.post("/email/test", requireAuth, requireAdmin, async (req, res) => {
  const { to } = req.body;
  try {
    await mailer.verifyConnection();
    if (to) {
      await mailer.sendMail({
        to,
        subject: "ทดสอบการเชื่อมต่ออีเมล - November Trip",
        text: "นี่คืออีเมลทดสอบจากระบบ November Trip การตั้งค่า SMTP ใช้งานได้ถูกต้อง",
      });
    }
    res.json({ success: true, message: to ? `ส่งอีเมลทดสอบไปที่ ${to} แล้ว` : "เชื่อมต่อ SMTP สำเร็จ" });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* LINE Messaging API                                                   */
/* ------------------------------------------------------------------ */

router.get("/line", requireAuth, requireAdmin, async (req, res) => {
  const settings = await prisma.lineSettings.findUnique({ where: { id: "singleton" } });
  if (!settings) return res.json(null);
  res.json({ channelAccessTokenSet: true, updatedAt: settings.updatedAt });
});

router.put("/line", requireAuth, requireAdmin, async (req, res) => {
  const { channelAccessToken } = req.body;
  if (!channelAccessToken) {
    return res.status(400).json({ error: "channelAccessToken is required" });
  }
  const settings = await prisma.lineSettings.upsert({
    where: { id: "singleton" },
    update: { channelAccessToken },
    create: { id: "singleton", channelAccessToken },
  });
  res.json({ channelAccessTokenSet: true, updatedAt: settings.updatedAt });
});

router.post("/line/test", requireAuth, requireAdmin, async (req, res) => {
  const { testUserId } = req.body;
  try {
    await line.verifyConnection();
    if (testUserId) {
      await line.pushMessage(testUserId, "ทดสอบการเชื่อมต่อ LINE จากระบบ November Trip 🎉");
    }
    res.json({
      success: true,
      message: testUserId ? `ส่งข้อความทดสอบไปที่ ${testUserId} แล้ว` : "เชื่อมต่อ LINE Channel สำเร็จ",
    });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    res.status(400).json({ success: false, message: msg });
  }
});

module.exports = router;
