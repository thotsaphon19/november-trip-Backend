const express = require("express");
const { upload } = require("../middleware/upload");
const { saveFile } = require("../services/storage");

const router = express.Router();

// POST /api/uploads  (multipart/form-data, field name "file")
// Returns { url } - save that straight into imageUrl fields (HotelImage.url,
// RoomType.imageUrl, HolidaySeasonPrice.imageUrl). The URL works the same
// way regardless of which storage backend produced it (see services/storage.js).
router.post("/", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded (expected field name 'file')" });
    }
    try {
      const url = await saveFile(req.file);
      res.status(201).json({ url, size: req.file.size, mimetype: req.file.mimetype });
    } catch (uploadErr) {
      res.status(500).json({ error: `Upload failed: ${uploadErr.message}` });
    }
  });
});

module.exports = router;
