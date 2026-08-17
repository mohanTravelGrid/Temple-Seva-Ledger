import { randomBytes } from "node:crypto";
import { db, getTempleBySlug } from "./db.js";

const sessions = new Map();

export function createSession(user) {
  const token = randomBytes(32).toString("hex");
  sessions.set(token, { userId: user.id, templeId: user.temple_id, createdAt: Date.now() });
  return token;
}

export function requireAuth(req, res, next) {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const session = sessions.get(token);
  if (!session) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  const temple = getTempleBySlug(req.params.templeSlug);
  if (!temple || temple.id !== session.templeId) {
    res.status(403).json({ message: "Invalid temple access" });
    return;
  }
  const user = db.prepare("SELECT id, temple_id, name, email, phone, role FROM users WHERE id = ? AND active = 1").get(session.userId);
  if (!user) {
    res.status(401).json({ message: "Unauthorized" });
    return;
  }
  req.temple = temple;
  req.user = user;
  next();
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ message: "You do not have permission for this action" });
      return;
    }
    next();
  };
}
