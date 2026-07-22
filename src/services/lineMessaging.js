const axios = require("axios");
const prisma = require("../lib/prisma");

async function getSettings() {
  const settings = await prisma.lineSettings.findUnique({ where: { id: "singleton" } });
  if (!settings) {
    throw new Error("LINE is not configured yet. Set it up on the Settings > LINE page.");
  }
  return settings;
}

/** Pushes a text message to a specific LINE user via the Messaging API.
 *  `userId` is the customer's LINE user ID (starts with "U..."), which
 *  your OA gets once they add/message your official account. */
async function pushMessage(userId, text) {
  const s = await getSettings();
  const { data } = await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: userId, messages: [{ type: "text", text }] },
    {
      headers: {
        Authorization: `Bearer ${s.channelAccessToken}`,
        "Content-Type": "application/json",
      },
    }
  );
  return data;
}

/** Lightweight connectivity check - confirms the token is accepted by
 *  hitting the bot info endpoint (no message sent, no quota used). */
async function verifyConnection() {
  const s = await getSettings();
  await axios.get("https://api.line.me/v2/bot/info", {
    headers: { Authorization: `Bearer ${s.channelAccessToken}` },
  });
  return true;
}

module.exports = { pushMessage, verifyConnection };
