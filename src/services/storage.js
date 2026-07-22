const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

// Local-disk fallback for Docker/VPS deployments (persists via the
// `uploads_data` volume in docker-compose.yml). Not used on Vercel or
// when S3-compatible storage is configured.
const LOCAL_UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

function randomFilename(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${crypto.randomBytes(16).toString("hex")}${ext}`;
}

async function saveToS3(file) {
  const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
  const client = new S3Client({
    region: process.env.S3_REGION || "auto",
    endpoint: process.env.S3_ENDPOINT, // e.g. https://<account>.r2.cloudflarestorage.com
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  });

  const key = `uploads/${randomFilename(file.originalname)}`;
  await client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      // R2/most S3-compatible providers serve objects publicly via a CDN
      // domain instead of ACLs - see S3_PUBLIC_URL below. Real AWS S3
      // buckets that rely on ACLs instead can add "ACL: public-read" here.
    })
  );

  // S3_PUBLIC_URL is the bucket's public base URL, e.g.:
  //   Cloudflare R2:  https://pub-xxxxxxxx.r2.dev  (or your custom domain)
  //   AWS S3:         https://your-bucket.s3.amazonaws.com
  const base = process.env.S3_PUBLIC_URL?.replace(/\/$/, "");
  if (!base) {
    throw new Error("S3_PUBLIC_URL is not set - can't build a public URL for the uploaded file");
  }
  return `${base}/${key}`;
}

async function saveToVercelBlob(file) {
  const { put } = await import("@vercel/blob");
  const blob = await put(randomFilename(file.originalname), file.buffer, {
    access: "public",
    contentType: file.mimetype,
  });
  return blob.url; // absolute https://*.public.blob.vercel-storage.com/... URL
}

function saveToLocalDisk(file) {
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  const filename = randomFilename(file.originalname);
  fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, filename), file.buffer);
  return `/uploads/${filename}`; // served by express.static in server.js
}

/** Saves an uploaded file and returns its public URL. Picks a backend
 *  automatically based on which env vars are set - no other code needs to
 *  know or care which one is active:
 *
 *  1. S3-compatible (Cloudflare R2, AWS S3, Backblaze B2, MinIO, ...) if
 *     S3_ENDPOINT + S3_BUCKET are set. Best for large volumes of images -
 *     R2 in particular has no egress fees and a generous free tier.
 *  2. Vercel Blob if BLOB_READ_WRITE_TOKEN is set. Zero-config on Vercel,
 *     fine for moderate volumes.
 *  3. Local disk otherwise (Docker/VPS deployments).
 */
async function saveFile(file) {
  if (process.env.S3_ENDPOINT && process.env.S3_BUCKET) {
    return saveToS3(file);
  }
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    return saveToVercelBlob(file);
  }
  return saveToLocalDisk(file);
}

module.exports = { saveFile, LOCAL_UPLOAD_DIR };
