const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const prisma = require("../lib/prisma");
const { requireAuth, requireAdmin, JWT_SECRET } = require("../middleware/authMiddleware");

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function sanitize(user) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// One-time setup: only works while the User table is empty, so it can't be
// abused to create rogue admins after the app is live.
router.post("/bootstrap", async (req, res) => {
  const count = await prisma.user.count();
  if (count > 0) {
    return res.status(403).json({ error: "Setup already completed. Ask an admin to create your account." });
  }

  const { email, password, name } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "email and password (min 8 chars) are required" });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, name: name || "Admin", role: "ADMIN" },
  });

  res.status(201).json({ user: sanitize(user), token: signToken(user) });
});

router.get("/needs-bootstrap", async (req, res) => {
  const count = await prisma.user.count();
  res.json({ needsBootstrap: count === 0 });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return res.status(401).json({ error: "Invalid email or password" });

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) return res.status(401).json({ error: "Invalid email or password" });

  res.json({ user: sanitize(user), token: signToken(user) });
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json(sanitize(user));
});

// Admin-only: invite teammates
router.post("/users", requireAuth, requireAdmin, async (req, res) => {
  const { email, password, name, role } = req.body;
  if (!email || !password || password.length < 8) {
    return res.status(400).json({ error: "email and password (min 8 chars) are required" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { email, passwordHash, name: name || email, role: role === "ADMIN" ? "ADMIN" : "STAFF" },
  });
  res.status(201).json(sanitize(user));
});

router.get("/users", requireAuth, requireAdmin, async (req, res) => {
  const users = await prisma.user.findMany({ orderBy: { createdAt: "asc" } });
  res.json(users.map(sanitize));
});

// Admin-only: edit a teammate's name/role, and optionally reset their
// password (leave password blank/omitted to keep their current one).
router.put("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const { name, role, password } = req.body;
  if (password && password.length < 8) {
    return res.status(400).json({ error: "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร" });
  }
  const data = {
    name,
    role: role === "ADMIN" ? "ADMIN" : role === "STAFF" ? "STAFF" : undefined,
  };
  if (password) data.passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.update({ where: { id: req.params.id }, data });
  res.json(sanitize(user));
});

router.delete("/users/:id", requireAuth, requireAdmin, async (req, res) => {
  if (req.user.sub === req.params.id) {
    return res.status(400).json({ error: "Cannot delete your own account" });
  }
  await prisma.user.delete({ where: { id: req.params.id } });
  res.status(204).end();
});

module.exports = router;
