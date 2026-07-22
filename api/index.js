// Vercel convention: any file under /api becomes a serverless function.
// Exporting the Express app directly works because Express apps are
// already valid (req, res) => {} handlers - Vercel's Node.js runtime
// calls this the same way it would call any other function.
//
// vercel.json rewrites every request to this file, so Express's own
// router (mounted in src/server.js) still handles all the /api/* paths
// exactly like it does in Docker/local dev.
module.exports = require("../src/server");
