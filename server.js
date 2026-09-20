const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const { db, initDatabase } = require("./database");
const crypto = require("crypto");

function verifyTelegramWebAppData(initData) {
  if (!initData || !process.env.BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");

  if (!receivedHash) return null;

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(process.env.BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== receivedHash) return null;

  const userData = params.get("user");
  if (!userData) return null;

  try {
    return JSON.parse(userData);
  } catch {
    return null;
  }
}
const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet());

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  })
);

app.use(express.json());
function requireTelegramUser(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];

  const user = verifyTelegramWebAppData(initData);

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Invalid Telegram authentication"
    });
  }

  req.telegramUser = user;
  next();
}
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Nexora AI Backend is running 🚀",
  });
});

app.get("/health", (req, res) => {
  res.json({
    success: true,
    status: "healthy",
    service: "Nexora AI Backend",
    database: "connected",
    time: new Date().toISOString(),
  });
});

app.get("/api/users/count", async (req, res) => {
  try {
    await db.read();

    res.json({
      success: true,
      count: db.data.users.length,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Database error",
    });
  }
});

app.post("/api/users", requireTelegramUser, async (req, res) => {
  try {
    const {
      telegram_id,
      username = "",
      first_name = "",
      last_name = "",
      referral_code = ""
    } = req.body;

    if (!telegram_id) {
      return res.status(400).json({
        success: false,
        message: "telegram_id is required"
      });
    }

    await db.read();

    let user = db.data.users.find(
      (u) => String(u.telegram_id) === String(telegram_id)
    );

    if (!user) {
      user = {
        telegram_id: String(telegram_id),
        username,
        first_name,
        last_name,
        balance: 0,
        total_earned: 0,
        referral_code,
        referred_by: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      db.data.users.push(user);
    } else {
      user.username = username;
      user.first_name = first_name;
      user.last_name = last_name;
      user.updated_at = new Date().toISOString();
    }

    await db.write();

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to save user"
    });
  }
});
async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, "0.0.0.0", () => {
      console.log("=================================");
      console.log("   NEXORA AI BACKEND STARTED");
      console.log("=================================");
      console.log(`Port: ${PORT}`);
      console.log("Database: Connected");
    });
  } catch (error) {
    console.error("Failed to start backend:", error);
    process.exit(1);
  }
}

startServer();
