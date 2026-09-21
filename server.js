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
    const { referral_code = "" } = req.body;
    const telegramUser = req.telegramUser;

    const telegram_id = String(telegramUser.id);
    const username = telegramUser.username || "";
    const first_name = telegramUser.first_name || "";
    const last_name = telegramUser.last_name || "";

    await db.read();

    let user = db.data.users.find(
      (u) => String(u.telegram_id) === telegram_id
    );

    if (!user) {
      let referredBy = "";

      if (referral_code) {
        const referrer = db.data.users.find(
          (u) =>
            String(u.referral_code || "").toLowerCase() ===
            String(referral_code).trim().toLowerCase()
        );

        if (referrer && String(referrer.telegram_id) !== telegram_id) {
          referredBy = String(referrer.referral_code);
        }
      }

      user = {
        telegram_id,
        username,
        first_name,
        last_name,
        balance: 0,
        total_earned: 0,
        referral_code: `NX${telegram_id}`,
        referred_by: referredBy,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      db.data.users.push(user);
    } else {
      user.username = username;
      user.first_name = first_name;
      user.last_name = last_name;

      if (!user.referral_code) {
        user.referral_code = `NX${telegram_id}`;
      }

      if (!user.referred_by && referral_code) {
        const referrer = db.data.users.find(
          (u) =>
            String(u.referral_code || "").toLowerCase() ===
            String(referral_code).trim().toLowerCase()
        );

        if (referrer && String(referrer.telegram_id) !== telegram_id) {
          user.referred_by = String(referrer.referral_code);
        }
      }

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


// ==================== DEPOSIT SYSTEM ====================
// Deposit requests stay PENDING until securely verified.
// Referral commission: 5% of verified deposit.

app.post("/api/deposits", requireTelegramUser, async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit amount"
      });
    }

    await db.read();

    const telegramId = String(req.telegramUser.id);

    const user = db.data.users.find(
      u => String(u.telegram_id) === telegramId
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const deposit = {
      id: "DEP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      telegram_id: telegramId,
      amount,
      status: "pending",
      referral_commission: 0,
      commission_credited: false,
      created_at: new Date().toISOString(),
      verified_at: null
    };

    db.data.deposits.push(deposit);
    await db.write();

    res.json({
      success: true,
      message: "Deposit request created and is pending verification",
      deposit
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to create deposit request"
    });
  }
});


// Admin verification.
// Set ADMIN_SECRET in Render environment variables before using this route.

app.post("/api/deposits/:id/verify", async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET;

    if (!adminSecret) {
      return res.status(503).json({
        success: false,
        message: "ADMIN_SECRET is not configured"
      });
    }

    if (req.headers["x-admin-secret"] !== adminSecret) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized"
      });
    }

    await db.read();

    const deposit = db.data.deposits.find(
      d => String(d.id) === String(req.params.id)
    );

    if (!deposit) {
      return res.status(404).json({
        success: false,
        message: "Deposit not found"
      });
    }

    if (deposit.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Deposit has already been processed"
      });
    }

    const user = db.data.users.find(
      u => String(u.telegram_id) === String(deposit.telegram_id)
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Deposit user not found"
      });
    }

    // Credit the user's verified deposit.
    user.balance = Number(user.balance || 0) + Number(deposit.amount);

    let commission = 0;
    let referrer = null;

    // Credit exactly 5% to the valid referrer.
    if (
      user.referred_by &&
      String(user.referred_by).trim()
    ) {
      referrer = db.data.users.find(
        u =>
          String(u.referral_code || "").toLowerCase() ===
          String(user.referred_by).trim().toLowerCase()
      );

      if (
        referrer &&
        String(referrer.telegram_id) !== String(user.telegram_id)
      ) {
        commission = Number(
          (Number(deposit.amount) * 0.05).toFixed(8)
        );

        referrer.balance =
          Number(referrer.balance || 0) + commission;

        referrer.total_earned =
          Number(referrer.total_earned || 0) + commission;

        referrer.updated_at = new Date().toISOString();
      }
    }

    deposit.status = "verified";
    deposit.referral_commission = commission;
    deposit.commission_credited = commission > 0;
    deposit.verified_at = new Date().toISOString();

    user.updated_at = new Date().toISOString();

    await db.write();

    res.json({
      success: true,
      message: "Deposit verified successfully",
      deposit,
      user_balance: user.balance,
      referral_commission: commission
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to verify deposit"
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
