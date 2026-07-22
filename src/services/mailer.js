const nodemailer = require("nodemailer");
const prisma = require("../lib/prisma");

async function getSettings() {
  const settings = await prisma.emailSettings.findUnique({ where: { id: "singleton" } });
  if (!settings) {
    throw new Error("Email is not configured yet. Set it up on the Settings > Email page.");
  }
  return settings;
}

async function getTransport() {
  const s = await getSettings();
  return nodemailer.createTransport({
    host: s.smtpHost,
    port: s.smtpPort,
    secure: s.smtpSecure,
    auth: { user: s.smtpUser, pass: s.smtpPass },
  });
}

/** Sends an email using the SMTP settings stored in the database.
 *  `attachments` follows nodemailer's format: [{ filename, content, contentType }] */
async function sendMail({ to, subject, text, html, attachments }) {
  const s = await getSettings();
  const transport = await getTransport();
  return transport.sendMail({
    from: `"${s.fromName}" <${s.fromEmail}>`,
    to,
    subject,
    text,
    html,
    attachments,
  });
}

/** Verifies the SMTP credentials without sending a real email. */
async function verifyConnection() {
  const transport = await getTransport();
  await transport.verify();
  return true;
}

module.exports = { sendMail, verifyConnection };
