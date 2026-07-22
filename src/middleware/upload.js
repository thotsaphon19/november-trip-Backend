const multer = require("multer");

// Always buffer in memory - routes/uploads.js then either writes the
// buffer to local disk (Docker/VPS deployments) or to Vercel Blob
// (serverless deployments, where local disk isn't persistent). Using
// memoryStorage everywhere keeps one code path working on both.
const ALLOWED_MIME = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_FILE_SIZE = 8 * 1024 * 1024; // 8MB

function fileFilter(req, file, cb) {
  if (!ALLOWED_MIME.has(file.mimetype)) {
    return cb(new Error("Only JPG, PNG, WEBP, or GIF images are allowed"));
  }
  cb(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter,
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

// Broader allowlist for the generic "attach a file" button on detail pages
// (contracts, price sheets, etc.) - documents and images, not just images.
const ALLOWED_DOCUMENT_MIME = new Set([
  ...ALLOWED_MIME,
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
]);
const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024; // 20MB

function documentFileFilter(req, file, cb) {
  if (!ALLOWED_DOCUMENT_MIME.has(file.mimetype)) {
    return cb(new Error("Only images, PDF, Word, Excel, or plain text files are allowed"));
  }
  cb(null, true);
}

const uploadDocument = multer({
  storage: multer.memoryStorage(),
  fileFilter: documentFileFilter,
  limits: { fileSize: MAX_DOCUMENT_SIZE, files: 1 },
});

module.exports = { upload, uploadDocument };
