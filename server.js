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
      message: "Invalid Telegram authentication",
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


/* =========================
   USER API
========================= */

function normalizeUser(user) {
  return {
    telegram_id: String(user.telegram_id),
    username: user.username || "",
    first_name: user.first_name || "",
    last_name: user.last_name || "",
    balance: Number(user.balance || 0),
    total_earned: Number(user.total_earned || 0),
    referral_code:
      user.referral_code || `NEXORA-${user.telegram_id}`,
    referred_by: user.referred_by || "",
    created_at: user.created_at || "",
    updated_at: user.updated_at || "",
  };
}

async function getOrCreateTelegramUser(
  telegramUser,
  referralCode = ""
) {
  await db.read();

  db.data.users ||= [];

  const telegram_id = String(telegramUser.id);

  let user = db.data.users.find(
    (u) => String(u.telegram_id) === telegram_id
  );

  if (!user) {
    user = {
      telegram_id,
      username: telegramUser.username || "",
      first_name: telegramUser.first_name || "",
      last_name: telegramUser.last_name || "",

      balance: 0,
      total_earned: 0,

      referral_code: `NEXORA-${telegram_id}`,
      referred_by: referralCode || "",

      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    db.data.users.push(user);
  } else {
    user.username = telegramUser.username || "";
    user.first_name = telegramUser.first_name || "";
    user.last_name = telegramUser.last_name || "";

    user.updated_at = new Date().toISOString();

    if (!user.referral_code) {
      user.referral_code = `NEXORA-${telegram_id}`;
    }
  }

  await db.write();

  return user;
}


/* =========================
   CREATE / UPDATE USER
========================= */

app.post(
  "/api/users",
  requireTelegramUser,
  async (req, res) => {
    try {
      const referral_code =
        String(req.body?.referral_code || "").trim();

      const user = await getOrCreateTelegramUser(
        req.telegramUser,
        referral_code
      );

      res.json({
        success: true,
        user: normalizeUser(user),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to save user",
      });
    }
  }
);


/* =========================
   GET CURRENT USER
========================= */

app.get(
  "/api/me",
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = await getOrCreateTelegramUser(
        req.telegramUser
      );

      res.json({
        success: true,
        user: normalizeUser(user),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to load user",
      });
    }
  }
);


/* =========================
   SYNC USER
========================= */

app.post(
  "/api/users/sync",
  requireTelegramUser,
  async (req, res) => {
    try {
      const referral_code =
        String(req.body?.referral_code || "").trim();

      const user = await getOrCreateTelegramUser(
        req.telegramUser,
        referral_code
      );

      res.json({
        success: true,
        user: normalizeUser(user),
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to sync user",
      });
    }
  }
);


/* =========================
   REFERRAL
========================= */

app.get(
  "/api/referral",
  requireTelegramUser,
  async (req, res) => {
    try {
      const user = await getOrCreateTelegramUser(
        req.telegramUser
      );

      await db.read();

      const referrals = (db.data.users || []).filter(
        (u) =>
          String(u.referred_by || "") ===
          String(user.referral_code || "")
      );

      res.json({
        success: true,
        referral_code:
          user.referral_code ||
          `NEXORA-${user.telegram_id}`,
        referral_count: referrals.length,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to load referral data",
      });
    }
  }
);


/* =========================
   WITHDRAWAL LIST
========================= */

app.get(
  "/api/withdrawals",
  requireTelegramUser,
  async (req, res) => {
    try {
      const telegram_id =
        String(req.telegramUser.id);

      await db.read();

      const withdrawals =
        (db.data.withdrawals || [])
          .filter(
            (w) =>
              String(w.telegram_id) === telegram_id
          )
          .sort((a, b) =>
            String(b.created_at).localeCompare(
              String(a.created_at)
            )
          );

      res.json({
        success: true,
        withdrawals,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to load withdrawals",
      });
    }
  }
);


/* =========================
   CREATE WITHDRAWAL
========================= */

app.post(
  "/api/withdrawals",
  requireTelegramUser,
  async (req, res) => {
    try {
      const amount =
        Number(req.body?.amount);

      const address =
        String(req.body?.address || "").trim();


      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid withdrawal amount",
        });
      }


      if (address.length < 10) {
        return res.status(400).json({
          success: false,
          message: "Enter a valid wallet address",
        });
      }


      const telegram_id =
        String(req.telegramUser.id);

      await db.read();

      db.data.users ||= [];
      db.data.withdrawals ||= [];


      const user = db.data.users.find(
        (u) =>
          String(u.telegram_id) === telegram_id
      );


      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }


      const balance =
        Number(user.balance || 0);


      if (amount > balance) {
        return res.status(400).json({
          success: false,
          message: "Insufficient balance",
        });
      }


      /*
        Reserve the requested amount.

        No blockchain transaction is performed here.
        The withdrawal stays pending for admin processing.
      */

      user.balance = Number(
        (balance - amount).toFixed(8)
      );

      user.updated_at =
        new Date().toISOString();


      const withdrawal = {
        id:
          `WD-${Date.now()}-${telegram_id}`,

        telegram_id,

        amount:
          Number(amount.toFixed(8)),

        address,

        status: "pending",

        created_at:
          new Date().toISOString(),

        updated_at:
          new Date().toISOString(),
      };


      db.data.withdrawals.push(
        withdrawal
      );

      await db.write();


      res.json({
        success: true,

        message:
          "Withdrawal request submitted",

        withdrawal,

        user:
          normalizeUser(user),
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message:
          "Failed to submit withdrawal",
      });
    }
  }
);


/* =========================
   DEPOSIT LIST
========================= */

app.get(
  "/api/deposits",
  requireTelegramUser,
  async (req, res) => {
    try {
      const telegram_id =
        String(req.telegramUser.id);

      await db.read();

      const deposits =
        (db.data.deposits || [])
          .filter(
            (d) =>
              String(d.telegram_id) ===
              telegram_id
          )
          .sort((a, b) =>
            String(b.created_at).localeCompare(
              String(a.created_at)
            )
          );

      res.json({
        success: true,
        deposits,
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message:
          "Failed to load deposits",
      });
    }
  }
);


/* =========================
   START SERVER
========================= */

async function startServer() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log(
          "================================="
        );

        console.log(
          "   NEXORA AI BACKEND STARTED"
        );

        console.log(
          "================================="
        );

        console.log(
          `Port: ${PORT}`
        );

        console.log(
          "Database: Connected"
        );
      }
    );

  } catch (error) {
    console.error(
      "Failed to start backend:",
      error
    );

    process.exit(1);
  }
}

startServer();
