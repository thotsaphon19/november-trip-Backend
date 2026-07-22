const express = require("express");
const prisma = require("../lib/prisma");
const { uploadDocument } = require("../middleware/upload");
const { saveFile } = require("../services/storage");

const router = express.Router();

// GET /api/attachments?entityType=TourSupplier&entityId=xxx
router.get("/", async (req, res) => {
  const { entityType, entityId } = req.query;
  if (!entityType || !entityId) {
    return res.status(400).json({ error: "entityType and entityId are required" });
  }
  const attachments = await prisma.attachment.findMany({
    where: { entityType, entityId },
    orderBy: { uploadedAt: "desc" },
  });
  res.json(attachments);
});

// POST /api/attachments  (multipart/form-data: file, entityType, entityId)
router.post("/", (req, res) => {
  uploadDocument.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const { entityType, entityId } = req.body;
    if (!req.file) return res.status(400).json({ error: "No file uploaded (expected field name 'file')" });
    if (!entityType || !entityId) {
      return res.status(400).json({ error: "entityType and entityId are required" });
    }
    try {
      const fileUrl = await saveFile(req.file);
      const attachment = await prisma.attachment.create({
        data: {
          entityType,
          entityId,
          fileName: req.file.originalname,
          fileUrl,
          fileSize: req.file.size,
          mimeType: req.file.mimetype,
        },
      });
      res.status(201).json(attachment);
    } catch (uploadErr) {
      res.status(500).json({ error: `Upload failed: ${uploadErr.message}` });
    }
  });
});

router.delete("/:id", async (req, res) => {
  await prisma.attachment.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
