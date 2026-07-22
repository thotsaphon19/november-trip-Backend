const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing Authorization header" });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { sub, email, name, role }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/** Use after requireAuth to restrict a route to admins only. */
function requireAdmin(req, res, next) {
  if (req.user?.role !== "ADMIN") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, JWT_SECRET };
