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

/* =========================================================
   NEXORA AI NFT CATALOG
   Server-side fixed values
========================================================= */

const NFT_CATALOG = [
  {
    id: "bronze",
    name: "Bronze",
    price: 3,
    days: 75,
    daily_rate: 4,
  },
  {
    id: "silver",
    name: "Silver",
    price: 5,
    days: 75,
    daily_rate: 4.4,
  },
  {
    id: "gold",
    name: "Gold",
    price: 15,
    days: 75,
    daily_rate: 4.8,
  },
  {
    id: "platinum",
    name: "Platinum",
    price: 25,
    days: 60,
    daily_rate: 5.2,
  },
  {
    id: "diamond",
    name: "Diamond",
    price: 50,
    days: 60,
    daily_rate: 5.6,
  },
  {
    id: "heroic",
    name: "Heroic",
    price: 100,
    days: 60,
    daily_rate: 6,
  },
  {
    id: "master",
    name: "Master",
    price: 250,
    days: 45,
    daily_rate: 6.4,
  },
  {
    id: "elite_master",
    name: "Elite Master",
    price: 500,
    days: 45,
    daily_rate: 7,
  },
  {
    id: "grand_master",
    name: "Grand Master",
    price: 1000,
    days: 45,
    daily_rate: 7.7,
  },
];

const NFT_REFERRAL_RATE = 0.05;

/* Prevent simultaneous NFT purchase processing */
let nftPurchaseLock = Promise.resolve();

function getNFTById(id) {
  return NFT_CATALOG.find(
    (nft) => String(nft.id).toLowerCase() === String(id).toLowerCase()
  );
}

/* =========================================================
   BASIC ROUTES
========================================================= */

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

/* =========================================================
   USERS
========================================================= */

app.get("/api/users/count", async (req, res) => {
  try {
    await db.read();

    db.data.users ||= [];

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

    db.data.users ||= [];

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

        if (
          referrer &&
          String(referrer.telegram_id) !== telegram_id
        ) {
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
        updated_at: new Date().toISOString(),
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

        if (
          referrer &&
          String(referrer.telegram_id) !== telegram_id
        ) {
          user.referred_by = String(referrer.referral_code);
        }
      }

      user.updated_at = new Date().toISOString();
    }

    await db.write();

    return res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Failed to save user",
    });
  }
});

/* =========================================================
   DEPOSIT SYSTEM
   Referral commission = 0%
========================================================= */

app.post("/api/deposits", requireTelegramUser, async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid deposit amount",
      });
    }

    await db.read();

    db.data.deposits ||= [];
    db.data.users ||= [];

    const telegramId = String(req.telegramUser.id);

    const user = db.data.users.find(
      (u) => String(u.telegram_id) === telegramId
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const deposit = {
      id:
        "DEP-" +
        Date.now() +
        "-" +
        Math.random().toString(36).slice(2, 8),

      telegram_id: telegramId,
      amount,
      status: "pending",
      created_at: new Date().toISOString(),
      verified_at: null,
    };

    db.data.deposits.push(deposit);

    await db.write();

    res.json({
      success: true,
      message: "Deposit request created and is pending verification",
      deposit,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to create deposit request",
    });
  }
});

/* =========================================================
   ADMIN DEPOSIT VERIFICATION
   IMPORTANT:
   NO REFERRAL COMMISSION IS CREATED HERE
========================================================= */

app.post("/api/deposits/:id/verify", async (req, res) => {
  try {
    const adminSecret = process.env.ADMIN_SECRET;

    if (!adminSecret) {
      return res.status(503).json({
        success: false,
        message: "ADMIN_SECRET is not configured",
      });
    }

    if (req.headers["x-admin-secret"] !== adminSecret) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    await db.read();

    db.data.deposits ||= [];
    db.data.users ||= [];

    const deposit = db.data.deposits.find(
      (d) => String(d.id) === String(req.params.id)
    );

    if (!deposit) {
      return res.status(404).json({
        success: false,
        message: "Deposit not found",
      });
    }

    if (deposit.status !== "pending") {
      return res.status(409).json({
        success: false,
        message: "Deposit has already been processed",
      });
    }

    const user = db.data.users.find(
      (u) => String(u.telegram_id) === String(deposit.telegram_id)
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "Deposit user not found",
      });
    }

    user.balance =
      Number(user.balance || 0) + Number(deposit.amount);

    deposit.status = "verified";
    deposit.verified_at = new Date().toISOString();

    user.updated_at = new Date().toISOString();

    await db.write();

    res.json({
      success: true,
      message: "Deposit verified successfully",
      deposit,
      user_balance: user.balance,
      referral_commission: 0,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to verify deposit",
    });
  }
});

/* =========================================================
   BALANCE
========================================================= */

app.get("/api/balance", requireTelegramUser, async (req, res) => {
  try {
    await db.read();

    db.data.users ||= [];

    const telegramId = String(req.telegramUser.id);

    const user = db.data.users.find(
      (u) => String(u.telegram_id) === telegramId
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    res.json({
      success: true,
      user,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to load balance",
    });
  }
});

/* =========================================================
   NFT CATALOG
========================================================= */

app.get("/api/nft/catalog", requireTelegramUser, async (req, res) => {
  try {
    res.json({
      success: true,
      nfts: NFT_CATALOG,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to load NFT catalog",
    });
  }
});

/* =========================================================
   NFT PURCHASE
   Referral commission = 5%
========================================================= */

app.post("/api/nft/purchase", requireTelegramUser, async (req, res) => {
  const runPurchase = async () => {
    try {
      const nftId = String(req.body.nft_id || "").trim();

      if (!nftId) {
        return res.status(400).json({
          success: false,
          message: "NFT ID is required",
        });
      }

      const nft = getNFTById(nftId);

      if (!nft) {
        return res.status(400).json({
          success: false,
          message: "Invalid NFT",
        });
      }

      await db.read();

      db.data.users ||= [];
      db.data.nft_purchases ||= [];

      const telegramId = String(req.telegramUser.id);

      const buyer = db.data.users.find(
        (u) => String(u.telegram_id) === telegramId
      );

      if (!buyer) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const currentBalance = Number(buyer.balance || 0);
      const price = Number(nft.price);

      if (currentBalance < price) {
        return res.status(400).json({
          success: false,
          message: "Insufficient balance",
          required: price,
          balance: currentBalance,
        });
      }

      let referrer = null;
      let referralCommission = 0;

      const referredBy = String(
        buyer.referred_by || ""
      ).trim();

      if (referredBy) {
        referrer = db.data.users.find(
          (u) =>
            String(u.referral_code || "").toLowerCase() ===
            referredBy.toLowerCase()
        );

        if (
          referrer &&
          String(referrer.telegram_id) === telegramId
        ) {
          referrer = null;
        }

        if (referrer) {
          referralCommission = Number(
            (price * NFT_REFERRAL_RATE).toFixed(8)
          );
        }
      }

      const purchaseId =
        "NFT-" +
        Date.now() +
        "-" +
        crypto.randomBytes(5).toString("hex");

      const now = new Date().toISOString();

      const purchase = {
        id: purchaseId,

        telegram_id: telegramId,

        nft_id: nft.id,
        nft_name: nft.name,

        price: price,
        days: nft.days,
        daily_rate: nft.daily_rate,

        status: "active",

        referrer_telegram_id: referrer
          ? String(referrer.telegram_id)
          : null,

        referrer_code: referrer
          ? String(referrer.referral_code)
          : null,

        referral_commission: referralCommission,

        commission_credited:
          referralCommission > 0,

        created_at: now,
        updated_at: now,
      };

      /* Debit buyer */
      buyer.balance =
        Number(buyer.balance || 0) - price;

      buyer.updated_at = now;

      /* Credit referrer exactly 5% */
      if (referrer && referralCommission > 0) {
        referrer.balance =
          Number(referrer.balance || 0) +
          referralCommission;

        referrer.total_earned =
          Number(referrer.total_earned || 0) +
          referralCommission;

        referrer.updated_at = now;
      }

      db.data.nft_purchases.push(purchase);

      await db.write();

      return res.json({
        success: true,
        message: `${nft.name} NFT purchased successfully`,
        purchase,
        user: buyer,
        referral_commission: referralCommission,
      });
    } catch (error) {
      console.error("NFT purchase error:", error);

      return res.status(500).json({
        success: false,
        message: "Failed to purchase NFT",
      });
    }
  };

  /*
    Queue NFT purchases so two rapid requests
    cannot process the same balance simultaneously.
  */
  const previousLock = nftPurchaseLock;

  let releaseLock;

  nftPurchaseLock = new Promise((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  try {
    return await runPurchase();
  } finally {
    releaseLock();
  }
});

/* =========================================================
   NFT PURCHASE HISTORY
========================================================= */

app.get(
  "/api/nft/purchases",
  requireTelegramUser,
  async (req, res) => {
    try {
      await db.read();

      db.data.nft_purchases ||= [];

      const telegramId = String(req.telegramUser.id);

      const purchases = db.data.nft_purchases
        .filter(
          (p) =>
            String(p.telegram_id) === telegramId
        )
        .sort(
          (a, b) =>
            new Date(b.created_at || 0) -
            new Date(a.created_at || 0)
        );

      res.json({
        success: true,
        purchases,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to load NFT purchase history",
      });
    }
  }
);

/* =========================================================
   REFERRAL INFORMATION
   ONLY NFT PURCHASE COMMISSION IS COUNTED
========================================================= */

app.get(
  "/api/referral",
  requireTelegramUser,
  async (req, res) => {
    try {
      await db.read();

      db.data.users ||= [];
      db.data.nft_purchases ||= [];

      const telegramId = String(req.telegramUser.id);

      const user = db.data.users.find(
        (u) =>
          String(u.telegram_id) === telegramId
      );

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const referralCode = String(
        user.referral_code || ""
      );

      const referredUsers =
        db.data.users.filter(
          (u) =>
            String(u.referred_by || "")
              .trim()
              .toLowerCase() ===
            referralCode.trim().toLowerCase()
        );

      const nftCommissions =
        db.data.nft_purchases.filter(
          (purchase) =>
            String(
              purchase.referrer_telegram_id || ""
            ) === telegramId &&
            purchase.commission_credited === true
        );

      const totalCommission =
        nftCommissions.reduce(
          (sum, purchase) =>
            sum +
            Number(
              purchase.referral_commission || 0
            ),
          0
        );

      res.json({
        success: true,

        referral_code: referralCode,

        referral_count:
          referredUsers.length,

        total_commission:
          Number(
            totalCommission.toFixed(8)
          ),
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

/* =========================================================
   DEPOSIT HISTORY
========================================================= */

app.get(
  "/api/deposits",
  requireTelegramUser,
  async (req, res) => {
    try {
      await db.read();

      db.data.deposits ||= [];

      const telegramId = String(
        req.telegramUser.id
      );

      const deposits =
        db.data.deposits
          .filter(
            (d) =>
              String(d.telegram_id) ===
              telegramId
          )
          .sort(
            (a, b) =>
              new Date(b.created_at || 0) -
              new Date(a.created_at || 0)
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
          "Failed to load deposit history",
      });
    }
  }
);

/* =========================================================
   WITHDRAWAL SYSTEM
========================================================= */

app.post(
  "/api/withdrawals",
  requireTelegramUser,
  async (req, res) => {
    try {
      const amount = Number(
        req.body.amount
      );

      const address = String(
        req.body.address || ""
      ).trim();

      if (
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        return res.status(400).json({
          success: false,
          message:
            "Invalid withdrawal amount",
        });
      }

      if (!address) {
        return res.status(400).json({
          success: false,
          message:
            "Withdrawal address is required",
        });
      }

      await db.read();

      db.data.users ||= [];
      db.data.withdrawals ||= [];

      const telegramId = String(
        req.telegramUser.id
      );

      const user = db.data.users.find(
        (u) =>
          String(u.telegram_id) ===
          telegramId
      );

      if (!user) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      const balance = Number(
        user.balance || 0
      );

      if (amount > balance) {
        return res.status(400).json({
          success: false,
          message:
            "Insufficient balance",
        });
      }

      const withdrawal = {
        id:
          Date.now() +
          "-" +
          Math.random()
            .toString(36)
            .slice(2, 10),






      telegram_id: telegramId,
      amount,
      address,
      status: "pending",
      created_at: new Date().toISOString(),
      processed_at: null,
    };

    db.data.withdrawals.push(withdrawal);

    await db.write();

    res.json({
      success: true,
      message: "Withdrawal request submitted and marked pending",
      withdrawal,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: "Failed to create withdrawal request",
    });
  }
});

/* =========================================================
   WITHDRAWAL HISTORY
========================================================= */

app.get(
  "/api/withdrawals",
  requireTelegramUser,
  async (req, res) => {
    try {
      await db.read();

      db.data.withdrawals ||= [];

      const telegramId = String(req.telegramUser.id);

      const withdrawals = db.data.withdrawals
        .filter(
          (w) => String(w.telegram_id) === telegramId
        )
        .sort(
          (a, b) =>
            new Date(b.created_at || 0) -
            new Date(a.created_at || 0)
        );

      res.json({
        success: true,
        withdrawals,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        success: false,
        message: "Failed to load withdrawal history",
      });
    }
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    await initDatabase();

    await db.read();

    db.data.users ||= [];
    db.data.deposits ||= [];
    db.data.withdrawals ||= [];
    db.data.nft_purchases ||= [];

    await db.write();

    app.listen(
      PORT,
      "0.0.0.0",
      () => {
        console.log("=================================");
        console.log("   NEXORA AI BACKEND STARTED");
        console.log("=================================");
        console.log(`Port: ${PORT}`);
        console.log("Database: Connected");
        console.log("NFT System: Enabled");
        console.log("NFT Referral Commission: 5%");
        console.log("Deposit Referral Commission: 0%");
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
