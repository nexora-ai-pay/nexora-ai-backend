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


function generateUniqueDepositAmount(requestedAmount, deposits) {
  const base = Math.round(Number(requestedAmount) * 1000) / 1000;

  for (let i = 1; i <= 999; i++) {
    const candidate = Number((base + (i / 1000000)).toFixed(6));

    const used = deposits.some((d) =>
      d.status === "pending" &&
      Number(d.amount) === candidate
    );

    if (!used) {
      return candidate;
    }
  }

  throw new Error("No unique deposit amount available");
}

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
    return res.json({
      success: true,
      user
    });
  }
  catch (error) {
    console.error(error);
    return res.status(500).json({
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

    const uniqueAmount = generateUniqueDepositAmount(
      amount,
      db.data.deposits
    );

    const deposit = {
      id: "DEP-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
      telegram_id: telegramId,
      requested_amount: amount,
      amount: uniqueAmount,
      deposit_address: process.env.DEPOSIT_WALLET_ADDRESS,
      network: "BEP-20",
      token: "USDT",
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

    const commission = 0;

deposit.status = "verified";
deposit.referral_commission = 0;
deposit.commission_credited = false;
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


// ==================== FRONTEND API ROUTES ====================

// Current authenticated user's balance/profile.
app.get("/api/balance", requireTelegramUser, async (req, res) => {
  try {
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

    res.json({
      success: true,
      user
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Failed to load balance"
    });
  }
});


// Referral information for the authenticated user.
app.get("/api/referral", requireTelegramUser, async (req, res) => {
  try {
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

    const referralCode = String(user.referral_code || "");

    const referredUsers = db.data.users.filter(
      u =>
        String(u.referred_by || "").trim().toLowerCase() ===
        referralCode.trim().toLowerCase()
    );

    db.data.nft_purchases ||= [];

    const nftReferralCommissions = db.data.nft_purchases.filter(
      p =>
        String(p.referrer_telegram_id || "") === telegramId &&
        p.commission_credited === true
    );

    const totalCommission = nftReferralCommissions.reduce(
      (sum, p) => sum + Number(p.referral_commission || 0),
      0
    );

    res.json({
      success: true,
      referral_code: referralCode,
      referral_count: referredUsers.length,
      total_commission: Number(totalCommission.toFixed(8))
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Failed to load referral data"
    });
  }
});


// Deposit history for the authenticated user.
app.get("/api/deposits", requireTelegramUser, async (req, res) => {
  try {
    await db.read();

    const telegramId = String(req.telegramUser.id);

    const deposits = db.data.deposits
      .filter(d => String(d.telegram_id) === telegramId)
      .sort(
        (a, b) =>
          new Date(b.created_at || 0) -
          new Date(a.created_at || 0)
      );

    res.json({
      success: true,
      deposits
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Failed to load deposit history"
    });
  }
});


// Create a pending withdrawal request.
// Actual payment processing is NOT performed here.
app.post("/api/withdrawals", requireTelegramUser, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const address = String(req.body.address || "").trim();

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid withdrawal amount"
      });
    }

    if (!address) {
      return res.status(400).json({
        success: false,
        message: "Withdrawal address is required"
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

    const balance = Number(user.balance || 0);

    if (amount > balance) {
      return res.status(400).json({
        success: false,
        message: "Insufficient balance"
      });
    }

    const withdrawal = {
      id:
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2, 10),
      telegram_id: telegramId,
      amount,
      address,
      status: "pending",
      created_at: new Date().toISOString(),
      processed_at: null
    };

    db.data.withdrawals.push(withdrawal);

    await db.write();

    res.json({
      success: true,
      message: "Withdrawal request submitted and marked pending",
      withdrawal
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Failed to create withdrawal request"
    });
  }
});


// Withdrawal history for the authenticated user.
app.get("/api/withdrawals", requireTelegramUser, async (req, res) => {
  try {
    await db.read();

    const telegramId = String(req.telegramUser.id);

    const withdrawals = db.data.withdrawals
      .filter(w => String(w.telegram_id) === telegramId)
      .sort(
        (a, b) =>
          new Date(b.created_at || 0) -
          new Date(a.created_at || 0)
      );

    res.json({
      success: true,
      withdrawals
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Failed to load withdrawal history"
    });
  }
});

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

/* =========================
   NEXORA AI NFT SYSTEM
   ========================= */

const NFT_CATALOG = [
  { id: "bronze", name: "Bronze", price: 3, duration_days: 75, daily_rate: 4.00 },
  { id: "silver", name: "Silver", price: 5, duration_days: 75, daily_rate: 4.40 },
  { id: "gold", name: "Gold", price: 15, duration_days: 75, daily_rate: 4.80 },
  { id: "platinum", name: "Platinum", price: 25, duration_days: 60, daily_rate: 5.20 },
  { id: "diamond", name: "Diamond", price: 50, duration_days: 60, daily_rate: 5.60 },
  { id: "heroic", name: "Heroic", price: 100, duration_days: 60, daily_rate: 6.00 },
  { id: "master", name: "Master", price: 250, duration_days: 45, daily_rate: 6.40 },
  { id: "elite_master", name: "Elite Master", price: 500, duration_days: 45, daily_rate: 7.00 },
  { id: "grand_master", name: "Grand Master", price: 1000, duration_days: 45, daily_rate: 7.70 }
];

app.get("/api/nft/catalog", requireTelegramUser, async (req, res) => {
  res.json({
    success: true,
    nfts: NFT_CATALOG
  });
});

app.post("/api/nft/purchase", requireTelegramUser, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);
    const nftId = String(req.body.nft_id || "").trim().toLowerCase();

    const nft = NFT_CATALOG.find(item => item.id === nftId);

    if (!nft) {
      return res.status(400).json({
        success: false,
        message: "Invalid NFT selected"
      });
    }

    db.data.nft_purchases ||= [];

    const user = db.data.users.find(
      u => String(u.telegram_id) === telegramId
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    const balance = Number(user.balance || 0);

    if (balance < nft.price) {
      return res.status(400).json({
        success: false,
        message: "Insufficient USDT balance",
        required: nft.price,
        balance
      });
    }

    const purchaseId =
      "NFT-" +
      Date.now() +
      "-" +
      crypto.randomBytes(4).toString("hex");

    const now = new Date().toISOString();

    user.balance = Number((balance - nft.price).toFixed(8));
    user.updated_at = now;

    let referralCommission = 0;
    let referrerTelegramId = null;

    if (user.referred_by) {
      const referrer = db.data.users.find(
        u =>
          String(u.referral_code || "").trim().toLowerCase() ===
          String(user.referred_by || "").trim().toLowerCase()
      );

      if (
        referrer &&
        String(referrer.telegram_id) !== String(user.telegram_id)
      ) {
        referralCommission = Number((nft.price * 0.05).toFixed(8));
        referrerTelegramId = String(referrer.telegram_id);

        referrer.balance =
          Number(referrer.balance || 0) + referralCommission;

        referrer.total_earned =
          Number(referrer.total_earned || 0) + referralCommission;

        referrer.updated_at = now;
      }
    }

    const purchase = {
      id: purchaseId,
      telegram_id: telegramId,
      nft_id: nft.id,
      nft_name: nft.name,
      price: nft.price,
      duration_days: nft.duration_days,
      daily_rate: nft.daily_rate,
      referral_commission: referralCommission,
      commission_credited: referralCommission > 0,
      referrer_telegram_id: referrerTelegramId,
      status: "active",
      purchased_at: now
    };

    db.data.nft_purchases.push(purchase);

    await db.write();

    res.json({
      success: true,
      message: "NFT purchased successfully",
      purchase,
      user_balance: user.balance,
      referral_commission: referralCommission
    });
  } catch (error) {
    console.error("NFT purchase error:", error);

    res.status(500).json({
      success: false,
      message: "NFT purchase failed"
    });
  }
});

app.get("/api/nft/purchases", requireTelegramUser, async (req, res) => {
  try {
    const telegramId = String(req.telegramUser.id);

    db.data.nft_purchases ||= [];

    const purchases = db.data.nft_purchases.filter(
      p => String(p.telegram_id) === telegramId
    );

    res.json({
      success: true,
      purchases
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Unable to load NFT purchases"
    });
  }
});

