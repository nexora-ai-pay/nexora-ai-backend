const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const { db, initDatabase } = require("./database");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { pool } = require("./database");

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

async function requireTelegramUser(req, res, next) {
  const initData = req.headers["x-telegram-init-data"];
  const user = verifyTelegramWebAppData(initData);

  if (!user) {
    return res.status(401).json({ success: false, message: "Invalid Telegram authentication" });
  }

  try {
    const r = await pool.query("SELECT banned FROM users WHERE telegram_id=$1", [String(user.id)]);
    if (r.rows[0]?.banned) {
      return res.status(403).json({ success: false, message: "Your Nexora AI account is suspended." });
    }
  } catch (e) {
    console.error("Ban check failed:", e);
    return res.status(503).json({ success: false, message: "Account security check unavailable" });
  }

  req.telegramUser = user;
  next();
}

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return res.status(503).json({ success:false, message:"ADMIN_SECRET is not configured" });
  if (req.headers["x-admin-secret"] !== secret) return res.status(401).json({ success:false, message:"Unauthorized" });
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
app.get("/api/deposit-config", (req, res) => {
  const address = String(process.env.DEPOSIT_WALLET_ADDRESS || "").trim();

  if (!address) {
    return res.status(503).json({
      success: false,
      message: "Deposit wallet address is not configured"
    });
  }

  res.json({
    success: true,
    deposit_address: address,
    network: "BEP-20",
    token: "USDT"
  });
});
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

    void sendMainBotMessage(telegramId,`💰 Nexora AI — New Deposit Request\n\n👤 ${[user.first_name,user.last_name].filter(Boolean).join(" ") || user.username || telegramId}\n💵 Requested: ${amount.toFixed(4)} USDT\n🔢 Unique Amount: ${uniqueAmount.toFixed(6)} USDT\n🟢 Status: Pending verification`);

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

app.post("/api/deposits/:id/verify", requireAdmin, async (req,res)=>{
  try{
    const txHash=String(req.body.tx_hash||"").trim();
    if(!/^0x[a-fA-F0-9]{64}$/.test(txHash)){
      return res.status(400).json({success:false,message:"A valid blockchain TX Hash is required"});
    }
    const dres=await pool.query("SELECT * FROM deposits WHERE id=$1",[String(req.params.id)]);
    if(!dres.rows.length)return res.status(404).json({success:false,message:"Deposit not found"});
    const d=dres.rows[0];
    if(!["pending","detected"].includes(d.status))return res.status(409).json({success:false,message:"Deposit has already been processed"});

    const {provider}=await getUsdtContract();
    const receipt=await provider.getTransactionReceipt(txHash);
    if(!receipt)return res.status(400).json({success:false,message:"Transaction not found on BNB Smart Chain"});
    const usdt=String(process.env.BSC_USDT_CONTRACT||"0x55d398326f99059fF775485246999027B3197955").toLowerCase();
    const depositAddress=String(d.deposit_address||process.env.DEPOSIT_WALLET_ADDRESS||"").toLowerCase();
    const topic=ethers.id("Transfer(address,address,uint256)");
    let matched=false;
    let blockNumber=receipt.blockNumber;
    for(const log of receipt.logs||[]){
      if(String(log.address).toLowerCase()!==usdt || log.topics?.[0]!==topic)continue;
      const to="0x"+String(log.topics[2]).slice(-40);
      const amount=Number(ethers.formatUnits(BigInt(log.data),18));
      if(to.toLowerCase()===depositAddress && Math.abs(amount-Number(d.amount))<1e-9){matched=true;break;}
    }
    if(!matched)return res.status(400).json({success:false,message:"TX Hash does not match this deposit's exact USDT amount and deposit address"});
    const latest=await provider.getBlockNumber();
    const confirmations=Math.max(0,latest-blockNumber+1);
    const required=Number(process.env.DEPOSIT_CONFIRMATIONS||12);
    if(confirmations<required)return res.status(400).json({success:false,message:`Transaction has only ${confirmations} confirmations; ${required} required`});
    await creditVerifiedDeposit(d.id,txHash,blockNumber,confirmations);
    await adminLog("deposit_manual_verified","deposit",d.id,{tx_hash:txHash,confirmations});
    const fresh=await pool.query("SELECT * FROM deposits WHERE id=$1",[d.id]);
    res.json({success:true,message:"Deposit verified from blockchain TX Hash",deposit:fresh.rows[0]});
  }catch(e){console.error(e);res.status(500).json({success:false,message:"Failed to verify deposit",error:e.message});}
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
    const user = db.data.users.find(u => String(u.telegram_id) === telegramId);

    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    const referralCode = String(user.referral_code || "");
    const botUsername = String(process.env.MAIN_BOT_USERNAME || "NexoraAI_Pay_bot").replace(/^@/, "").trim();

    const referredUsers = db.data.users
      .filter(u => String(u.referred_by || "").trim().toLowerCase() === referralCode.trim().toLowerCase())
      .map(u => ({
        telegram_id: String(u.telegram_id),
        username: u.username || "",
        first_name: u.first_name || "",
        last_name: u.last_name || "",
        created_at: u.created_at || null,
        status: u.banned ? "BANNED" : "ACTIVE"
      }))
      .sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    db.data.nft_purchases ||= [];

    const nftActivity = db.data.nft_purchases
      .filter(p => String(p.referrer_telegram_id || "") === telegramId && Number(p.referral_commission || 0) > 0)
      .map(p => ({
        type: "NFT Commission",
        action: `5% commission • ${p.nft_name || "NFT"}`,
        amount: Number(p.referral_commission || 0),
        nft_name: p.nft_name || "NFT",
        created_at: p.purchased_at || null,
        telegram_id: String(p.telegram_id || "")
      }));

    const depositActivity = db.data.deposits
      .filter(d => {
        const referred = db.data.users.find(u => String(u.telegram_id) === String(d.telegram_id));
        return referred && String(referred.referred_by || "").trim().toLowerCase() === referralCode.trim().toLowerCase() && Number(d.referral_commission || 0) > 0;
      })
      .map(d => ({
        type: "Deposit Commission",
        action: "5% deposit commission",
        amount: Number(d.referral_commission || 0),
        created_at: d.verified_at || d.created_at || null,
        telegram_id: String(d.telegram_id || "")
      }));

    const activity = [...nftActivity, ...depositActivity]
      .sort((a,b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    const totalCommission = activity.reduce((sum, x) => sum + Number(x.amount || 0), 0);

    res.json({
      success: true,
      referral_code: referralCode,
      referral_link: botUsername ? `https://t.me/${botUsername}?start=${encodeURIComponent(referralCode)}` : "",
      referral_count: referredUsers.length,
      total_commission: Number(totalCommission.toFixed(8)),
      total_earned: Number(totalCommission.toFixed(8)),
      referrals: referredUsers,
      activity: activity.slice(0, 50)
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: "Failed to load referral data" });
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

    const wdName=[user.first_name,user.last_name].filter(Boolean).join(" ") || user.username || telegramId;
    void sendPayoutReviewMessage(`💸 NEXORA AI PAYOUT REVIEW\n\n🆕 New Withdrawal Request\n👤 ${wdName}\n🆔 ${telegramId}\n💵 Amount: ${amount.toFixed(4)} USDT\n🌐 Network: BEP-20\n🏦 Wallet: ${address}\n🕒 ${new Date().toISOString()}\n\nAdmin action required: Approve & Send / Reject`);
    void sendMainBotMessage(telegramId,`💸 Nexora AI — New Withdrawal Request\n\n👤 ${wdName}\n💵 Amount: ${amount.toFixed(4)} USDT\n🌐 BEP-20 USDT\n🟡 Status: Pending admin review`);

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


// ==================== TELEGRAM ACTIVITY NOTIFICATIONS ====================
async function botApiWithToken(token, method, body={}) {
  const t=String(token||"").trim();
  if(!t) throw new Error("Telegram bot token is not configured");
  const r=await fetch(`https://api.telegram.org/bot${t}/${method}`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify(body)
  });
  const data=await r.json();
  if(!data.ok) {
    const err=new Error(data.description||"Telegram API error");
    err.telegram=data;
    throw err;
  }
  return data;
}

async function sendMainBotMessage(chatId, text, extra={}) {
  const token=String(process.env.BOT_TOKEN||"").trim();
  if(!token) return {ok:false, skipped:true};
  try { return await botApiWithToken(token,"sendMessage",{chat_id:String(chatId),text,disable_web_page_preview:true,...extra}); }
  catch(e){ console.warn("Main bot sendMessage failed for",chatId,e.message); return {ok:false,error:e.message}; }
}

async function broadcastMainBot(text) {
  const token=String(process.env.BOT_TOKEN||"").trim();
  if(!token) { console.warn("Main bot broadcast disabled: BOT_TOKEN is not configured."); return; }
  try {
    await db.read();
    const ids=[...new Set((db.data.users||[]).map(u=>String(u.telegram_id||"")).filter(Boolean))];
    for(const id of ids){
      const result=await sendMainBotMessage(id,text);
      if(result?.telegram?.error_code===429){
        const retry=Number(result.telegram.parameters?.retry_after||2);
        await new Promise(r=>setTimeout(r,Math.min(retry,10)*1000));
        await sendMainBotMessage(id,text);
      }
      await new Promise(r=>setTimeout(r,40));
    }
  } catch(e){ console.error("Main bot broadcast error:",e.message); }
}

async function sendPayoutReviewMessage(text,extra={}) {
  const token=String(process.env.PAYOUT_REVIEW_BOT_TOKEN||"").trim();
  const chatId=String(process.env.PAYOUT_REVIEW_CHAT_ID||"").trim();
  if(!token || !chatId){
    console.warn("Payout Review notification disabled: configure PAYOUT_REVIEW_BOT_TOKEN and PAYOUT_REVIEW_CHAT_ID.");
    return;
  }
  try { await botApiWithToken(token,"sendMessage",{chat_id:chatId,text,disable_web_page_preview:true,...extra}); }
  catch(e){ console.error("Payout Review bot error:",e.message); }
}

app.get("/api/payout-review/config",(req,res)=>{
  const username=String(process.env.PAYOUT_REVIEW_BOT_USERNAME||"").replace(/^@/,"").trim();
  if(!username) return res.status(503).json({success:false,message:"Payout Review bot is not configured"});
  res.json({success:true,bot_username:username,bot_url:`https://t.me/${username}`});
});

// ==================== MAIN BOT REFERRAL START FLOW ====================
async function sendMainBotWelcomePhoto(token, chatId, caption, appUrl){
  const imagePath=path.join(__dirname,"nexora-bot-welcome.png");
  const image=await fs.promises.readFile(imagePath);
  const form=new FormData();
  form.append("chat_id",String(chatId));
  form.append("photo",new Blob([image],{type:"image/png"}),"nexora-bot-welcome.png");
  form.append("caption",caption);
  form.append("reply_markup",JSON.stringify({
    inline_keyboard:[
      [{text:"🚀 Start Earning",web_app:{url:appUrl}}],
      [{text:"📢 Nexora AI Official Channel",url:"https://t.me/nexora_ai_pay"}]
    ]
  }));
  const r=await fetch(`https://api.telegram.org/bot${String(token).trim()}/sendPhoto`,{method:"POST",body:form});
  const data=await r.json();
  if(!data.ok) throw new Error(data.description||"Telegram sendPhoto error");
  return data;
}

async function startMainBotPolling(){
  const token=String(process.env.BOT_TOKEN||"").trim();
  if(!token){ console.warn("Main bot referral flow disabled: BOT_TOKEN is not configured."); return; }
  const miniAppBase=String(process.env.MINI_APP_URL||"https://nexora-ai-pay.github.io/nexora-ai-mini-app/").trim();
  let offset=0;
  try{ await botApiWithToken(token,"deleteWebhook",{drop_pending_updates:false}); }catch(e){}
  const loop=async()=>{
    try{
      const data=await botApiWithToken(token,"getUpdates",{offset,timeout:25,allowed_updates:["message"]});
      for(const u of (data.result||[])){
        offset=Math.max(offset,Number(u.update_id)+1);
        const msg=u?.message; if(!msg?.chat?.id || !msg?.from) continue;
        const text=String(msg.text||"").trim();
        const match=text.match(/^\/start(?:@\S+)?(?:\s+(.+))?$/i); if(!match) continue;
        const code=String(match[1]||"").trim();
        const appUrl=code ? `${miniAppBase}${miniAppBase.includes("?")?"&":"?"}startapp=${encodeURIComponent(code)}` : miniAppBase;
        const welcomeCaption=code
          ? "🚀 NEXORA AI — PROJECT IS LIVE!\n\n🤖 AI Auto Pay Ecosystem\n⛏️ Mine • 💰 Earn • 🤖 AI Trading Bot\n💎 9 NFT Plans • ⚡ Fast Withdrawals\n✨ Earn Daily High Rewards\n\n🎯 Your referral link is ready. Start earning now!"
          : "🚀 NEXORA AI — PROJECT IS LIVE!\n\n🤖 AI Auto Pay Ecosystem\n⛏️ Mine • 💰 Earn • 🤖 AI Trading Bot\n💎 9 NFT Plans • ⚡ Fast Withdrawals\n🌍 Global Community\n✨ Earn Daily High Rewards\n\n🔥 Start your Nexora AI journey now!";
        await sendMainBotWelcomePhoto(token,String(msg.chat.id),welcomeCaption,appUrl);
      }
    }catch(e){ console.error("Main bot referral polling error:",e.message); await new Promise(r=>setTimeout(r,3000)); }
    setImmediate(loop);
  }; loop();
}

// ==================== TELEGRAM SUPPORT BOT ====================
async function telegramApi(method, body={}) {
  const token=String(process.env.SUPPORT_BOT_TOKEN||"").trim();
  if(!token) throw new Error("SUPPORT_BOT_TOKEN is not configured");
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)
  });
  const data=await r.json();
  if(!data.ok) throw new Error(data.description||"Telegram API error");
  return data;
}

async function ensureSupportConversation(tgUser, chatId) {
  const id=String(tgUser.id);
  const r=await pool.query(
    `INSERT INTO support_conversations(telegram_id,chat_id,username,first_name,last_name,status,updated_at,last_message_at)
     VALUES($1,$2,$3,$4,$5,'open',NOW(),NOW())
     ON CONFLICT(telegram_id) DO UPDATE SET chat_id=EXCLUDED.chat_id,
       username=EXCLUDED.username,first_name=EXCLUDED.first_name,last_name=EXCLUDED.last_name,
       updated_at=NOW()
     RETURNING *`,
    [id,String(chatId),tgUser.username||"",tgUser.first_name||"",tgUser.last_name||""]
  );
  return r.rows[0];
}

async function handleSupportBotUpdate(update) {
  const msg=update?.message;
  if(!msg?.chat?.id || !msg?.from) return;
  const text=String(msg.text||"").trim();
  if(!text) return;

  const conv=await ensureSupportConversation(msg.from,msg.chat.id);
  if(text.startsWith("/start")){
    await telegramApi("sendMessage",{chat_id:msg.chat.id,text:
      "👋 Welcome to Nexora AI Help Team.\n\nPlease send your query here. Our support team will review your message and reply to you here."});
    return;
  }

  const ins=await pool.query(
    `INSERT INTO support_messages(conversation_id,sender_type,sender_id,message_text,telegram_message_id)
     VALUES($1,'user',$2,$3,$4) RETURNING id`,
    [conv.id,String(msg.from.id),text,msg.message_id||null]
  );
  await pool.query(
    `UPDATE support_conversations SET status='new',unread_count=unread_count+1,
     updated_at=NOW(),last_message_at=NOW() WHERE id=$1`,[conv.id]
  );
  await telegramApi("sendMessage",{chat_id:msg.chat.id,text:
    "✅ Your query has been received by Nexora AI Help Team. An admin will reply here."});
}

async function startSupportBotPolling(){
  if(!process.env.SUPPORT_BOT_TOKEN){
    console.warn("Support bot disabled: SUPPORT_BOT_TOKEN is not configured.");
    return;
  }
  let offset=0;
  try{ await telegramApi("deleteWebhook",{drop_pending_updates:false}); }catch(e){}
  const loop=async()=>{
    try{
      const data=await telegramApi("getUpdates",{offset,timeout:25,allowed_updates:["message"]});
      for(const u of (data.result||[])){
        offset=Math.max(offset,Number(u.update_id)+1);
        try{await handleSupportBotUpdate(u);}catch(e){console.error("Support update error:",e.message);}
      }
    }catch(e){console.error("Support bot polling error:",e.message);await new Promise(r=>setTimeout(r,3000));}
    setImmediate(loop);
  };
  loop();
}

// Public config used by Mini App to open the separate support bot.
app.get("/api/support/config",(req,res)=>{
  const username=String(process.env.SUPPORT_BOT_USERNAME||"").replace(/^@/,"").trim();
  if(!username)return res.status(503).json({success:false,message:"Support bot is not configured"});
  res.json({success:true,bot_username:username,bot_url:`https://t.me/${username}`});
});

async function startServer() {
  try {
    await initDatabase();

    setTimeout(() => {
      monitorBep20Deposits();
      finalizeDetectedDeposits();
      finalizeProcessingWithdrawals();
      setInterval(monitorBep20Deposits, Number(process.env.DEPOSIT_POLL_INTERVAL_MS || 15000));
      setInterval(finalizeDetectedDeposits, Number(process.env.DEPOSIT_CONFIRMATION_POLL_MS || 30000));
      setInterval(finalizeProcessingWithdrawals, Number(process.env.WITHDRAWAL_CONFIRMATION_POLL_INTERVAL_MS || 15000));
    }, 2000);
    startMainBotPolling();
    startSupportBotPolling();

    

// NEXORA_ADMIN_V1_START

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;

  if (!secret) {
    return res.status(503).json({
      success: false,
      message: "ADMIN_SECRET is not configured"
    });
  }

  if (req.headers["x-admin-secret"] !== secret) {
    return res.status(401).json({
      success: false,
      message: "Unauthorized"
    });
  }

  next();
}

// Admin dashboard — PostgreSQL source of truth
app.get("/api/admin/dashboard", requireAdmin, async (req, res) => {
  try {
    const [u, d, w, n, totals] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS users,
                         COUNT(*) FILTER (WHERE banned=false)::int AS active_users,
                         COUNT(*) FILTER (WHERE banned=true)::int AS banned_users
                  FROM users`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending_deposits,
                         COUNT(*) FILTER (WHERE status='verified')::int AS verified_deposits,
                         COALESCE(SUM(amount) FILTER (WHERE status='verified'),0) AS total_deposits
                  FROM deposits`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending_withdrawals,
                         COUNT(*) FILTER (WHERE status IN ('processed','completed'))::int AS processed_withdrawals,
                         COALESCE(SUM(amount) FILTER (WHERE status IN ('processed','completed')),0) AS total_withdrawals
                  FROM withdrawals`),
      pool.query(`SELECT COUNT(*)::int AS nft_purchases,
                         COALESCE(SUM(referral_commission),0) AS total_referral_commission
                  FROM nft_purchases`),
      pool.query(`SELECT COALESCE(SUM(balance),0) AS total_balance,
                         COALESCE(SUM(total_earned),0) AS total_earned
                  FROM users`)
    ]);

    const a = u.rows[0], b = d.rows[0], c = w.rows[0], e = n.rows[0], t = totals.rows[0];
    res.json({
      success: true,
      stats: {
        users: Number(a.users || 0),
        active_users: Number(a.active_users || 0),
        banned_users: Number(a.banned_users || 0),
        pending_deposits: Number(b.pending_deposits || 0),
        verified_deposits: Number(b.verified_deposits || 0),
        pending_withdrawals: Number(c.pending_withdrawals || 0),
        processed_withdrawals: Number(c.processed_withdrawals || 0),
        nft_purchases: Number(e.nft_purchases || 0),
        total_balance: Number(t.total_balance || 0),
        total_earned: Number(t.total_earned || 0),
        total_deposits: Number(b.total_deposits || 0),
        total_withdrawals: Number(c.total_withdrawals || 0),
        total_referral_commission: Number(e.total_referral_commission || 0)
      }
    });
  } catch (error) {
    console.error("Admin dashboard error:", error);
    res.status(500).json({ success: false, message: "Failed to load admin dashboard" });
  }
});

// Admin users — PostgreSQL source of truth
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT telegram_id, username, first_name, last_name,
             balance, total_earned, referral_code, referred_by,
             banned, banned_at, ban_reason, created_at, updated_at
      FROM users
      ORDER BY created_at DESC NULLS LAST
    `);
    res.json({ success: true, count: r.rows.length, users: r.rows });
  } catch (error) {
    console.error("Admin users error:", error);
    res.status(500).json({ success: false, message: "Failed to load users" });
  }
});

// Admin deposits — PostgreSQL source of truth
app.get("/api/admin/deposits", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM deposits ORDER BY created_at DESC NULLS LAST`);
    res.json({ success: true, count: r.rows.length, deposits: r.rows });
  } catch (error) {
    console.error("Admin deposits error:", error);
    res.status(500).json({ success: false, message: "Failed to load deposits" });
  }
});

// Admin withdrawals — PostgreSQL source of truth
app.get("/api/admin/withdrawals", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM withdrawals ORDER BY created_at DESC NULLS LAST`);
    res.json({ success: true, count: r.rows.length, withdrawals: r.rows });
  } catch (error) {
    console.error("Admin withdrawals error:", error);
    res.status(500).json({ success: false, message: "Failed to load withdrawals" });
  }
});

// Admin NFT purchases — PostgreSQL source of truth
app.get("/api/admin/nft-purchases", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(`SELECT * FROM nft_purchases ORDER BY purchased_at DESC NULLS LAST`);
    res.json({ success: true, count: r.rows.length, purchases: r.rows });
  } catch (error) {
    console.error("Admin NFT purchases error:", error);
    res.status(500).json({ success: false, message: "Failed to load NFT purchases" });
  }
});

// ==================== NEXORA AI ADMIN PRO ====================

function adminLog(action, targetType="", targetId="", details={}) {
  return pool.query(
    `INSERT INTO admin_activity_logs (admin_action,target_type,target_id,details)
     VALUES ($1,$2,$3,$4)`,
    [action, targetType, String(targetId || ""), JSON.stringify(details || {})]
  ).catch(e => console.error("Admin log error:", e));
}

function isValidBscAddress(address) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(address || "").trim());
}

async function getBscProvider() {
  const rpc = String(process.env.BSC_RPC_URL || "").trim();
  if (!rpc) throw new Error("BSC_RPC_URL is not configured");
  const provider = new ethers.JsonRpcProvider(rpc, 56, { staticNetwork: true });
  return provider;
}

const USDT_ABI = [
  "function transfer(address to,uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)"
];

async function getUsdtContract() {
  const provider = await getBscProvider();
  const contractAddress = String(
    process.env.BSC_USDT_CONTRACT || "0x55d398326f99059fF775485246999027B3197955"
  ).trim();
  return { provider, contract: new ethers.Contract(contractAddress, USDT_ABI, provider), contractAddress };
}

async function sendBep20Usdt(address, amount) {
  if (!isValidBscAddress(address)) throw new Error("Invalid BEP-20 wallet address");
  const key = String(process.env.WITHDRAWAL_PRIVATE_KEY || "").trim();
  if (!key) throw new Error("Withdrawal sending wallet is not configured");

  const { provider, contract, contractAddress } = await getUsdtContract();
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 56) throw new Error("Configured RPC is not BNB Smart Chain");

  const wallet = new ethers.Wallet(key, provider);
  const sender = await wallet.getAddress();
  const decimals = Number(await contract.decimals());
  const tokenAmount = ethers.parseUnits(Number(amount).toFixed(8), decimals);

  const tokenBalance = await contract.balanceOf(sender);
  if (tokenBalance < tokenAmount) throw new Error("Sending wallet has insufficient USDT");

  const nativeBalance = await provider.getBalance(sender);
  const gasLimit = BigInt(process.env.WITHDRAWAL_GAS_LIMIT || 100000);
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice || ethers.parseUnits("3","gwei");

  if (nativeBalance < gasLimit * gasPrice) {
    throw new Error("Sending wallet has insufficient BNB for gas");
  }

  const data = contract.interface.encodeFunctionData("transfer",[address,tokenAmount]);

  // Persisting the TX hash immediately after broadcast is critical: if the
  // server restarts while waiting for confirmations, the finalizer can still
  // recover and complete the withdrawal from the saved hash.
  const tx = await wallet.sendTransaction({
    to: contractAddress,
    data,
    gasLimit,
    gasPrice
  });

  console.log("BEP-20 withdrawal broadcast:", tx.hash);

  return {
    tx_hash: tx.hash,
    block_number: null,
    confirmations: 0,
    pending: true
  };
}

async function creditVerifiedDeposit(depositId, txHash, blockNumber, confirmations) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dep = await client.query(
      "SELECT * FROM deposits WHERE id=$1 FOR UPDATE", [String(depositId)]
    );
    if (!dep.rows.length) throw new Error("Deposit not found");
    const d = dep.rows[0];
    if (d.status === "verified") {
      await client.query("ROLLBACK");
      return { already: true };
    }

    const usr = await client.query(
      "SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE", [String(d.telegram_id)]
    );
    if (!usr.rows.length) throw new Error("Deposit user not found");
    const user = usr.rows[0];

const amount = Number(d.amount || 0);
const newBalance = Number(user.balance || 0) + amount;
const commission = 0;

    await client.query(
      `UPDATE users SET balance=$1, updated_at=NOW() WHERE telegram_id=$2`,
      [newBalance, String(user.telegram_id)]
    );
    await client.query(
      `UPDATE deposits SET status='verified', tx_hash=COALESCE($2,tx_hash),
       block_number=COALESCE($3,block_number), confirmations=$4,
       referral_commission=$5, commission_credited=$6, verified_at=NOW()
       WHERE id=$1`,
      [String(depositId), txHash || null, blockNumber || null, Number(confirmations || 0),
0, false]
    );

    await client.query("COMMIT");

    const depositName=[user.first_name,user.last_name].filter(Boolean).join(" ") || user.username || String(user.telegram_id);
void sendMainBotMessage(String(user.telegram_id),`💰 Nexora AI — Deposit Verified\n\n👤 ${depositName}\n💵 ${amount.toFixed(4)} USDT\n🟢 Status: Verified & credited`);
    return { already: false, commission };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

let depositMonitorRunning = false;

async function processBep20DepositLogs(provider, usdt, topic, depositAddress, logs, latest, confRequired) {
  for (const log of logs) {
    const txHash = log.transactionHash;
    const already = await pool.query("SELECT id FROM deposits WHERE tx_hash=$1 LIMIT 1", [txHash]);
    if (already.rows.length) continue;

    const amountRaw = BigInt(log.data);
    const amount = Number(ethers.formatUnits(amountRaw, 18));
    const matching = await pool.query(
      `SELECT * FROM deposits
       WHERE status IN ('pending','detected')
         AND LOWER(deposit_address)=LOWER($1)
         AND network='BEP-20' AND token='USDT'
         AND ABS(amount-$2) < 0.000000001
       ORDER BY created_at ASC LIMIT 1`,
      [depositAddress, amount]
    );

    if (!matching.rows.length) {
      const fromAddress = "0x" + String(log.topics?.[1] || "").slice(-40);
      await pool.query(
        `INSERT INTO unmatched_deposits(tx_hash,from_address,to_address,amount,block_number,reason)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT(tx_hash) DO NOTHING`,
        [txHash,fromAddress,depositAddress,amount,log.blockNumber,"No pending deposit with exact unique amount"]
      );
      continue;
    }

    const confirmations = Math.max(0, latest - log.blockNumber + 1);
    const dep = matching.rows[0];
    await pool.query(
      `UPDATE deposits SET status='detected', tx_hash=$1, block_number=$2, confirmations=$3
       WHERE id=$4 AND status IN ('pending','detected')`,
      [txHash, log.blockNumber, confirmations, dep.id]
    );

    if (confirmations >= confRequired) {
      await creditVerifiedDeposit(dep.id, txHash, log.blockNumber, confirmations);
    }
  }
}

async function getBep20LogsAdaptive(provider, filter, fromBlock, toBlock) {
  let chunkSize = Math.max(1, toBlock - fromBlock + 1);

  while (true) {
    const end = Math.min(toBlock, fromBlock + chunkSize - 1);
    try {
      const logs = await provider.getLogs({ ...filter, fromBlock, toBlock: end });
      return { logs, toBlock: end, chunkSize };
    } catch (e) {
      if (chunkSize === 1) {
        throw new Error(`BEP-20 RPC cannot read block ${fromBlock}: ${e.message}`);
      }
      const nextSize = Math.max(1, Math.floor(chunkSize / 2));
      console.warn(
        `BEP-20 deposit RPC chunk ${fromBlock}-${end} failed; retrying with ${nextSize} blocks: ${e.message}`
      );
      chunkSize = nextSize;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
}

async function scanBep20DepositRange(provider, usdt, topic, depositAddress, startBlock, endBlock, latest, confRequired, maxBlocksPerRun) {
  if (startBlock > endBlock) return endBlock;

  let cursor = startBlock;
  let scanned = 0;
  const safeChunk = Math.max(1, Number(process.env.DEPOSIT_SCAN_CHUNK_BLOCKS || 100));

  while (cursor <= endBlock && scanned < maxBlocksPerRun) {
    const requestedEnd = Math.min(endBlock, cursor + safeChunk - 1, cursor + (maxBlocksPerRun - scanned) - 1);
    const result = await getBep20LogsAdaptive(
      provider,
      { address: usdt, topics: [topic, null, ethers.zeroPadValue(depositAddress, 32)] },
      cursor,
      requestedEnd
    );

    await processBep20DepositLogs(
      provider,
      usdt,
      topic,
      depositAddress,
      result.logs,
      latest,
      confRequired
    );

    await pool.query(
      `INSERT INTO blockchain_scans(key,value,updated_at) VALUES('deposit_last_block',$1,NOW())
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`,
      [String(result.toBlock)]
    );

    scanned += result.toBlock - cursor + 1;
    cursor = result.toBlock + 1;
  }

  return cursor - 1;
}

async function monitorBep20Deposits() {
  if (global.__nexoraDepositMonitorRunning) return;
  global.__nexoraDepositMonitorRunning = true;

  const rpc = String(process.env.BSC_RPC_URL || '').trim();
  const depositAddress = String(process.env.DEPOSIT_WALLET_ADDRESS || '').trim();
  if (!rpc || !isValidBscAddress(depositAddress)) {
    console.warn('BEP-20 deposit monitor disabled: configure BSC_RPC_URL and DEPOSIT_WALLET_ADDRESS.');
    global.__nexoraDepositMonitorRunning = false;
    return;
  }

  const MAX_RPC_LOG_RANGE = 10; // Alchemy Free BNB eth_getLogs hard limit.

  try {
    const provider = await getBscProvider();
    const usdt = String(process.env.BSC_USDT_CONTRACT || '0x55d398326f99059fF775485246999027B3197955').toLowerCase();
    const topic = ethers.id('Transfer(address,address,uint256)');
    const latest = await provider.getBlockNumber();
    const confRequired = Math.max(1, Number(process.env.DEPOSIT_CONFIRMATIONS || 12));
    const liveLookback = Math.max(10, Number(process.env.DEPOSIT_LIVE_LOOKBACK_BLOCKS || 120));
    const historicalPerRun = Math.max(10, Number(process.env.DEPOSIT_HISTORICAL_BLOCKS_PER_RUN || 1000));

    async function processLogs(logs, scanLatest) {
      for (const log of logs) {
        if (log.removed) continue;
        const txHash = String(log.transactionHash || '').trim();
        if (!txHash) continue;

        const already = await pool.query('SELECT id FROM deposits WHERE tx_hash=$1 LIMIT 1', [txHash]);
        if (already.rows.length) continue;

        const amountRaw = BigInt(log.data);
        const amount = Number(ethers.formatUnits(amountRaw, 18));
        const matching = await pool.query(
          `SELECT * FROM deposits
           WHERE status IN ('pending','detected')
             AND LOWER(deposit_address)=LOWER($1)
             AND network='BEP-20' AND token='USDT'
             AND ABS(amount-$2) < 0.000000001
           ORDER BY created_at ASC LIMIT 1`,
          [depositAddress, amount]
        );

        if (!matching.rows.length) {
          const fromAddress = '0x' + String(log.topics?.[1] || '').slice(-40);
          await pool.query(
            `INSERT INTO unmatched_deposits(tx_hash,from_address,to_address,amount,block_number,reason)
             VALUES($1,$2,$3,$4,$5,$6)
             ON CONFLICT(tx_hash) DO NOTHING`,
            [txHash, fromAddress, depositAddress, amount, log.blockNumber, 'No pending deposit with exact unique amount']
          );
          await adminLog('unmatched_deposit','blockchain',txHash,{amount,depositAddress,blockNumber:log.blockNumber});
          continue;
        }

        const confirmations = Math.max(0, Number(scanLatest) - Number(log.blockNumber) + 1);
        const dep = matching.rows[0];
        await pool.query(
          `UPDATE deposits SET status='detected', tx_hash=$1, block_number=$2, confirmations=$3
           WHERE id=$4 AND status IN ('pending','detected')`,
          [txHash, log.blockNumber, confirmations, dep.id]
        );
        if (confirmations >= confRequired) {
          await creditVerifiedDeposit(dep.id, txHash, log.blockNumber, confirmations);
        }
      }
    }

    async function scanRange(rangeFrom, rangeTo) {
      let cursor = Number(rangeFrom);
      const end = Number(rangeTo);
      while (cursor <= end) {
        const chunkFrom = cursor;
        const chunkTo = Math.min(end, chunkFrom + MAX_RPC_LOG_RANGE - 1);
        let logs = null;
        let attemptSize = MAX_RPC_LOG_RANGE;

        while (attemptSize >= 1) {
          const requestTo = Math.min(chunkTo, chunkFrom + attemptSize - 1);
          try {
            logs = await provider.getLogs({
              address: usdt,
              topics: [topic, null, ethers.zeroPadValue(depositAddress, 32)],
              fromBlock: chunkFrom,
              toBlock: requestTo
            });
            if (requestTo < chunkTo) {
              // A degraded retry covered only a prefix; continue the remainder separately.
              await processLogs(logs, latest);
              cursor = requestTo + 1;
              logs = null;
              break;
            }
            await processLogs(logs, latest);
            cursor = chunkTo + 1;
            logs = null;
            break;
          } catch (err) {
            console.error(`BEP-20 deposit RPC chunk ${chunkFrom}-${requestTo} failed:`, err.message);
            if (attemptSize === 1) throw err;
            attemptSize = Math.max(1, Math.floor(attemptSize / 2));
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }

        if (logs !== null) throw new Error(`BEP-20 deposit scan stalled at block ${cursor}`);
      }
    }

    // 1) Live-first: repeatedly inspect the newest window without moving the historical checkpoint.
    const liveStart = Math.max(0, latest - liveLookback + 1);
    await scanRange(liveStart, latest);

    // 2) Historical recovery: checkpoint only moves after every <=10-block range succeeds.
    const state = await pool.query("SELECT value FROM blockchain_scans WHERE key='deposit_last_block'");
    let checkpoint = Number(state.rows[0]?.value || 0);
    if (!checkpoint) checkpoint = Math.max(0, latest - Number(process.env.DEPOSIT_SCAN_LOOKBACK_BLOCKS || 5000));
    if (checkpoint > latest) checkpoint = latest;

    const historicalEnd = Math.min(liveStart - 1, checkpoint + historicalPerRun - 1);
    if (checkpoint <= historicalEnd) {
      let cursor = checkpoint;
      while (cursor <= historicalEnd) {
        const chunkEnd = Math.min(historicalEnd, cursor + MAX_RPC_LOG_RANGE - 1);
        await scanRange(cursor, chunkEnd);
        await pool.query(
          `INSERT INTO blockchain_scans(key,value,updated_at) VALUES('deposit_last_block',$1,NOW())
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=EXCLUDED.updated_at`,
          [String(chunkEnd)]
        );
        cursor = chunkEnd + 1;
      }
    }
  } catch (e) {
    console.error('BEP-20 deposit monitor error:', e.message);
    // Intentionally do not advance the checkpoint after a failed scan.
  } finally {
    global.__nexoraDepositMonitorRunning = false;
  }
}

async function finalizeDetectedDeposits() {
  try {
    const { provider } = await getBscProvider();
    const latest = await provider.getBlockNumber();
    const required = Number(process.env.DEPOSIT_CONFIRMATIONS || 12);
    const rows = await pool.query(
      `SELECT * FROM deposits WHERE status='detected' AND tx_hash IS NOT NULL`
    );
    for (const d of rows.rows) {
      if (d.block_number == null) continue;
      const confirmations = Math.max(0, latest - Number(d.block_number) + 1);
      await pool.query("UPDATE deposits SET confirmations=$1 WHERE id=$2", [confirmations, d.id]);
      if (confirmations >= required) {
        await creditVerifiedDeposit(d.id, d.tx_hash, d.block_number, confirmations);
      }
    }
  } catch (e) {
    console.error("Deposit confirmation check error:", e.message);
  }
}

async function finalizeProcessingWithdrawals() {
  try {
    const { provider } = await getBscProvider();

    const rows = await pool.query(
      `SELECT * FROM withdrawals
       WHERE status='processing'
       AND tx_hash IS NOT NULL
       ORDER BY created_at ASC`
    );

    for (const w of rows.rows) {
      const txHash=String(w.tx_hash||"").trim();
      if(!txHash) continue;

      let receipt=null;

      try {
        receipt=await provider.getTransactionReceipt(txHash);
      } catch(e) {
        console.error("Withdrawal receipt check failed:",txHash,e.message);
        continue;
      }

      if(!receipt) continue;

      if(Number(receipt.status)===1) {
        const latest = await provider.getBlockNumber();
        const required = Number(process.env.WITHDRAWAL_CONFIRMATIONS || 3);
        const confirmations = Math.max(0, latest - Number(receipt.blockNumber || 0) + 1);
        if (confirmations < required) continue;

        const completed=await pool.query(
          `UPDATE withdrawals
           SET status='completed',
               block_number=$1,
               processed_at=COALESCE(processed_at,NOW()),
               error_message=NULL
           WHERE id=$2 AND status='processing'`,
          [receipt.blockNumber||null,w.id]
        );

        if(completed.rowCount===1){
          await adminLog(
            "withdrawal_completed",
            "withdrawal",
            w.id,
            {tx_hash:txHash,confirmations,finalized:true}
          );

          const paidUser=await pool.query(
            "SELECT first_name,last_name,username,telegram_id FROM users WHERE telegram_id=$1",
            [String(w.telegram_id)]
          );
          const pu=paidUser.rows[0]||{};
          const paidName=[pu.first_name,pu.last_name].filter(Boolean).join(" ") || pu.username || String(w.telegram_id);

          void sendPayoutReviewMessage(
            `✅ NEXORA AI PAYOUT REVIEW\\n\\nWithdrawal Approved & Sent\\n👤 ${paidName}\\n🆔 ${w.telegram_id}\\n💵 ${Number(w.amount).toFixed(4)} USDT\\n🌐 BEP-20\\n🏦 ${w.address}\\n🔗 TX: <a href="https://bscscan.com/tx/${txHash}">${txHash}</a>`,
            {parse_mode:"HTML"}
          );

          void sendMainBotMessage(String(w.telegram_id),
            `✅ Nexora AI — Withdrawal Sent\\n\\n👤 ${paidName}\\n💵 ${Number(w.amount).toFixed(4)} USDT\\n🌐 BEP-20 USDT\\n🟢 Status: Completed\\n🔗 TX: ${txHash}`
          );
        }

        continue;
      }

      const client=await pool.connect();

      try {
        await client.query("BEGIN");

        const locked=await client.query(
          "SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",
          [w.id]
        );

        if(!locked.rows.length || locked.rows[0].status!=="processing") {
          await client.query("ROLLBACK");
          continue;
        }

        const current=locked.rows[0];

        await client.query(
          "UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2",
          [Number(current.amount),String(current.telegram_id)]
        );

        await client.query(
          `UPDATE withdrawals
           SET status='failed',
               processed_at=NOW(),
               error_message=$1
           WHERE id=$2`,
          ["BEP-20 transaction reverted on-chain",current.id]
        );

        await client.query("COMMIT");

        await adminLog(
          "withdrawal_failed",
          "withdrawal",
          current.id,
          {
            tx_hash:txHash,
            error:"BEP-20 transaction reverted on-chain",
            balance_restored:true,
            finalized:true
          }
        );

        void sendPayoutReviewMessage(
          `❌ NEXORA AI PAYOUT REVIEW\\n\\nWithdrawal Failed\\n🆔 ${current.telegram_id}\\n💵 ${Number(current.amount).toFixed(4)} USDT\\n⚠️ BEP-20 transaction reverted on-chain\\n\\nUser balance was restored.\\n🔗 TX: ${txHash}`
        );

        void sendMainBotMessage(String(current.telegram_id),
          `❌ Nexora AI — Withdrawal Failed\\n\\n🆔 ${current.telegram_id}\\n💵 ${Number(current.amount).toFixed(4)} USDT\\n🔴 Status: Failed\\n⚠️ BEP-20 transaction reverted on-chain\\n🔗 TX: ${txHash}`
        );
      } catch(e) {
        try { await client.query("ROLLBACK"); } catch(_) {}
        console.error("Withdrawal finalization error:",e.message);
      } finally {
        client.release();
      }
    }
  } catch(e) {
    console.error("Withdrawal confirmation finalizer error:",e.message);
  }
}

// Enhanced admin dashboard
app.get("/api/admin/statistics", requireAdmin, async (req,res)=>{
  try {
    await settleNFTMining();
    const [u,d,w,n] = await Promise.all([
      pool.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE banned=false)::int active, COUNT(*) FILTER (WHERE banned=true)::int banned FROM users"),
      pool.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='pending')::int pending, COUNT(*) FILTER (WHERE status='verified')::int verified, COALESCE(SUM(amount) FILTER (WHERE status='verified'),0) total_verified FROM deposits"),
      pool.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status='pending')::int pending, COUNT(*) FILTER (WHERE status IN ('processed','completed'))::int completed, COALESCE(SUM(amount) FILTER (WHERE status IN ('processed','completed')),0) total_paid FROM withdrawals"),
      pool.query("SELECT COUNT(*)::int total, COALESCE(SUM(price),0) total_sales, COALESCE(SUM(daily_earning) FILTER (WHERE status='active'),0) daily_active FROM nft_purchases")
    ]);
    res.json({success:true, users:u.rows[0], deposits:d.rows[0], withdrawals:w.rows[0], nft:n.rows[0]});
  } catch(e) { console.error(e); res.status(500).json({success:false,message:"Failed to load statistics"}); }
});

app.get("/api/admin/analytics", requireAdmin, async (req,res)=>{
  try{
    const r = await pool.query(`
      WITH date_series AS (
        SELECT generate_series(
          CURRENT_DATE - INTERVAL '364 days',
          CURRENT_DATE,
          INTERVAL '1 day'
        )::date AS metric_date
      ),
      user_daily AS (
        SELECT created_at::date AS metric_date,
               COUNT(*)::int AS users
        FROM users
        WHERE created_at IS NOT NULL
          AND created_at >= CURRENT_DATE - INTERVAL '364 days'
        GROUP BY created_at::date
      ),
      deposit_daily AS (
        SELECT created_at::date AS metric_date,
               COUNT(*)::int AS deposits,
               COALESCE(SUM(amount) FILTER (WHERE status='verified'),0) AS deposits_amount
        FROM deposits
        WHERE created_at IS NOT NULL
          AND created_at >= CURRENT_DATE - INTERVAL '364 days'
        GROUP BY created_at::date
      ),
      withdrawal_daily AS (
        SELECT created_at::date AS metric_date,
               COUNT(*)::int AS withdrawals,
               COALESCE(
                 SUM(amount) FILTER (WHERE status IN ('processed','completed')),
                 0
               ) AS withdrawals_amount
        FROM withdrawals
        WHERE created_at IS NOT NULL
          AND created_at >= CURRENT_DATE - INTERVAL '364 days'
        GROUP BY created_at::date
      ),
      nft_daily AS (
        SELECT purchased_at::date AS metric_date,
               COUNT(*)::int AS nft_purchases,
               COALESCE(SUM(price),0) AS nft_sales
        FROM nft_purchases
        WHERE purchased_at IS NOT NULL
          AND purchased_at >= CURRENT_DATE - INTERVAL '364 days'
        GROUP BY purchased_at::date
      )
      SELECT
        TO_CHAR(ds.metric_date, 'YYYY-MM-DD') AS day,
        COALESCE(u.users,0)::int AS users,
        COALESCE(d.deposits,0)::int AS deposits,
        COALESCE(d.deposits_amount,0) AS deposits_amount,
        COALESCE(w.withdrawals,0)::int AS withdrawals,
        COALESCE(w.withdrawals_amount,0) AS withdrawals_amount,
        COALESCE(n.nft_purchases,0)::int AS nft_purchases,
        COALESCE(n.nft_sales,0) AS nft_sales
      FROM date_series ds
      LEFT JOIN user_daily u ON u.metric_date = ds.metric_date
      LEFT JOIN deposit_daily d ON d.metric_date = ds.metric_date
      LEFT JOIN withdrawal_daily w ON w.metric_date = ds.metric_date
      LEFT JOIN nft_daily n ON n.metric_date = ds.metric_date
      ORDER BY ds.metric_date ASC
    `);

    res.json({
      success:true,
      days:r.rows
    });
  }catch(e){
    console.error("Admin analytics error:", e);
    res.status(500).json({
      success:false,
      message:"Failed to load analytics"
    });
  }
});

app.get("/api/admin/earnings-forecast", requireAdmin, async (req,res)=>{
  try {
    await settleNFTMining();
    const r=await pool.query(
      `SELECT COALESCE(SUM(daily_earning * LEAST(duration_days-mined_cycles,1)),0) AS next_24h,
              COUNT(*) FILTER (WHERE status='active' AND duration_days>mined_cycles)::int AS active_positions,
              COALESCE(SUM(daily_earning * GREATEST(duration_days-mined_cycles,0)),0) AS remaining_total
       FROM nft_purchases WHERE status='active'`
    );
    const w=await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS pending_withdrawals FROM withdrawals
       WHERE status IN ('pending','processing')`
    );
    const b=await pool.query(`SELECT COALESCE(SUM(balance),0) AS user_balances FROM users WHERE banned=false`);
    const f=r.rows[0], wd=w.rows[0], bal=b.rows[0];
    res.json({success:true, forecast:{
      next_24h:Number(f.next_24h||0), active_positions:Number(f.active_positions||0),
      remaining_total:Number(f.remaining_total||0), pending_withdrawals:Number(wd.pending_withdrawals||0),
      user_balances:Number(bal.user_balances||0),
      liquidity_reference:Number((Number(f.next_24h||0)+Number(wd.pending_withdrawals||0)).toFixed(8))
    }});
  } catch(e){console.error(e);res.status(500).json({success:false,message:"Failed to calculate forecast"});}
});

app.get("/api/admin/deposits/auto-status", requireAdmin, async (req,res)=>{
  const r=await pool.query(`SELECT id,telegram_id,amount,status,tx_hash,block_number,confirmations,created_at,verified_at
    FROM deposits ORDER BY created_at DESC LIMIT 500`);
  res.json({success:true,deposits:r.rows});
});

app.get("/api/admin/deposits/unmatched", requireAdmin, async (req,res)=>{
  const r=await pool.query("SELECT * FROM unmatched_deposits WHERE resolved=false ORDER BY created_at DESC LIMIT 500");
  res.json({success:true,deposits:r.rows});
});
app.post("/api/admin/deposits/unmatched/:id/credit", requireAdmin, async (req,res)=>{
  const unmatchedId=String(req.params.id||"").trim();
  const telegramId=String(req.body?.telegram_id||"").trim();
  if(!unmatchedId || !telegramId){
    return res.status(400).json({success:false,message:"Unmatched deposit ID and user are required"});
  }

  const client=await pool.connect();
  try{
    await client.query("BEGIN");

    const ur=await client.query(
      "SELECT * FROM unmatched_deposits WHERE id=$1 AND resolved=false FOR UPDATE",
      [unmatchedId]
    );
    if(!ur.rows.length){
      await client.query("ROLLBACK");
      return res.status(404).json({success:false,message:"Unmatched deposit not found or already resolved"});
    }
    const unmatched=ur.rows[0];

    const userResult=await client.query(
      "SELECT telegram_id,username,first_name,last_name,balance,banned FROM users WHERE telegram_id=$1 FOR UPDATE",
      [telegramId]
    );
    if(!userResult.rows.length){
      await client.query("ROLLBACK");
      return res.status(404).json({success:false,message:"User not found"});
    }
    const user=userResult.rows[0];
    if(user.banned){
      await client.query("ROLLBACK");
      return res.status(400).json({success:false,message:"Cannot credit a banned user"});
    }

    const txHash=String(unmatched.tx_hash||"").trim();
    const depositAddress=String(process.env.DEPOSIT_WALLET_ADDRESS||"").trim().toLowerCase();
    const usdtAddress=String(process.env.BSC_USDT_CONTRACT||"0x55d398326f99059fF775485246999027B3197955").trim().toLowerCase();
    if(!txHash || !isValidBscAddress(depositAddress) || !isValidBscAddress(usdtAddress)){
      await client.query("ROLLBACK");
      return res.status(400).json({success:false,message:"Blockchain verification configuration is invalid"});
    }

    const provider=await getBscProvider();
    const receipt=await provider.getTransactionReceipt(txHash);
    if(!receipt){
      await client.query("ROLLBACK");
      return res.status(409).json({success:false,message:"Transaction receipt is not available yet"});
    }
    if(Number(receipt.status)!==1){
      await client.query("ROLLBACK");
      return res.status(400).json({success:false,message:"Blockchain transaction failed or reverted"});
    }

    const latest=await provider.getBlockNumber();
    const confirmations=Math.max(0,latest-Number(receipt.blockNumber||0)+1);
    const required=Math.max(1,Number(process.env.DEPOSIT_CONFIRMATIONS||12));
    if(confirmations<required){
      await client.query("ROLLBACK");
      return res.status(409).json({success:false,message:`Deposit needs ${required} confirmations; currently ${confirmations}`});
    }

    const transferInterface=new ethers.Interface([
      "event Transfer(address indexed from,address indexed to,uint256 value)"
    ]);
    let verifiedTransfer=null;
    for(const log of (receipt.logs||[])){
      if(String(log.address||"").toLowerCase()!==usdtAddress) continue;
      try{
        const parsed=transferInterface.parseLog(log);
        if(!parsed || parsed.name!=="Transfer") continue;
        const to=String(parsed.args.to||"").toLowerCase();
        const value=BigInt(parsed.args.value);
        if(to!==depositAddress) continue;
        verifiedTransfer={
          from:String(parsed.args.from||"").toLowerCase(),
          to,
          value
        };
        break;
      }catch(_){}
    }
    if(!verifiedTransfer){
      await client.query("ROLLBACK");
      return res.status(400).json({success:false,message:"Verified USDT transfer to the Nexora deposit wallet was not found in this transaction"});
    }

    const actualAmount=Number(ethers.formatUnits(verifiedTransfer.value,18));
    const recordedAmount=Number(unmatched.amount||0);
    if(!Number.isFinite(actualAmount) || Math.abs(actualAmount-recordedAmount)>0.000000001){
      await client.query("ROLLBACK");
      return res.status(400).json({success:false,message:`On-chain amount ${actualAmount} USDT does not match unmatched amount ${recordedAmount} USDT`});
    }

    const newBalance=Number(user.balance||0)+actualAmount;
    await client.query(
      "UPDATE users SET balance=$1,updated_at=NOW() WHERE telegram_id=$2",
      [newBalance,telegramId]
    );
    const resolved=await client.query(
      `UPDATE unmatched_deposits
       SET resolved=true,resolved_at=NOW()
       WHERE id=$1 AND resolved=false
       RETURNING *`,
      [unmatchedId]
    );
    if(!resolved.rows.length) throw new Error("Unmatched deposit was already resolved");

    await adminLog("unmatched_deposit_credited","deposit",unmatchedId,{
      telegram_id:telegramId,
      amount:actualAmount,
      tx_hash:txHash,
      block_number:receipt.blockNumber,
      confirmations,
      verified_on_chain:true
    });

    await client.query("COMMIT");

    const userName=[user.first_name,user.last_name].filter(Boolean).join(" ") || user.username || telegramId;
    void sendMainBotMessage(telegramId,`💰 Nexora AI — Deposit Verified\n\n👤 ${userName}\n💵 ${actualAmount.toFixed(6)} USDT\n🟢 Status: Verified & credited`);

    res.json({
      success:true,
      amount:actualAmount,
      telegram_id:telegramId,
      new_balance:newBalance,
      confirmations,
      tx_hash:txHash,
      deposit:resolved.rows[0]
    });
  }catch(e){
    try{await client.query("ROLLBACK");}catch(_){}
    console.error("Admin unmatched deposit credit error:",e);
    res.status(500).json({success:false,message:e.message||"Failed to verify and credit unmatched deposit"});
  }finally{
    client.release();
  }
});

app.post("/api/admin/deposits/unmatched/:id/resolve", requireAdmin, async (req,res)=>{
  const r=await pool.query("UPDATE unmatched_deposits SET resolved=true,resolved_at=NOW() WHERE id=$1 AND resolved=false RETURNING *",[req.params.id]);
  if(!r.rows.length)return res.status(404).json({success:false,message:"Unmatched deposit not found"});
  await adminLog("unmatched_deposit_resolved","deposit",req.params.id,{});
  res.json({success:true,deposit:r.rows[0]});
});

app.post("/api/admin/users/:id/ban", requireAdmin, async (req,res)=>{
  const id=String(req.params.id);
  await pool.query("UPDATE users SET banned=true,banned_at=NOW(),ban_reason=$1,updated_at=NOW() WHERE telegram_id=$2",[String(req.body.reason||"Admin action"),id]);
  await adminLog("ban_user","user",id,{reason:req.body.reason||"Admin action"});
  res.json({success:true,message:"User banned"});
});
app.post("/api/admin/users/:id/unban", requireAdmin, async (req,res)=>{
  const id=String(req.params.id);
  await pool.query("UPDATE users SET banned=false,banned_at=NULL,ban_reason='',updated_at=NOW() WHERE telegram_id=$1",[id]);
  await adminLog("unban_user","user",id,{});
  res.json({success:true,message:"User unbanned"});
});

app.get("/api/admin/logs", requireAdmin, async (req,res)=>{
  const r=await pool.query("SELECT * FROM admin_activity_logs ORDER BY created_at DESC LIMIT 500");
  res.json({success:true,logs:r.rows});
});

app.get("/api/admin/system-config", requireAdmin, async (req,res)=>{
  const rpc=String(process.env.BSC_RPC_URL||"").trim();
  const depositAddress=String(process.env.DEPOSIT_WALLET_ADDRESS||"").trim();
  const usdt=String(process.env.BSC_USDT_CONTRACT||"0x55d398326f99059fF775485246999027B3197955").trim();
  res.json({success:true,config:{
    chain:"BNB Smart Chain (BEP-20)",
    auto_deposit_monitor:Boolean(rpc && isValidBscAddress(depositAddress)),
    deposit_confirmations:Number(process.env.DEPOSIT_CONFIRMATIONS||12),
    deposit_poll_interval_ms:Number(process.env.DEPOSIT_POLL_INTERVAL_MS||15000),
    deposit_scan_chunk_blocks:Number(process.env.DEPOSIT_SCAN_CHUNK_BLOCKS||500),
    withdrawal_confirmations:Number(process.env.WITHDRAWAL_CONFIRMATIONS||3),
    withdrawal_sender_configured:Boolean(String(process.env.WITHDRAWAL_PRIVATE_KEY||"").trim()),
    usdt_contract:usdt,
    deposit_address_configured:isValidBscAddress(depositAddress),
    rpc_configured:Boolean(rpc)
  }});
});

app.get("/api/admin/settings", requireAdmin, async (req,res)=>{
  const r=await pool.query("SELECT key,value,updated_at FROM admin_settings ORDER BY key");
  res.json({success:true,settings:r.rows});
});

app.post("/api/admin/settings", requireAdmin, async (req,res)=>{
  const entries=req.body && typeof req.body==="object"?req.body:{};
  for(const [key,value] of Object.entries(entries)){
    if(!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) continue;
    await pool.query(`INSERT INTO admin_settings(key,value,updated_at) VALUES($1,$2,NOW())
      ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=NOW()`,[key,String(value)]);
  }
  await adminLog("update_settings","settings","",entries);
  res.json({success:true});
});

// Support / Help Team admin API
app.get("/api/admin/support/conversations", requireAdmin, async (req,res)=>{
  const q=String(req.query.q||"").trim();
  const params=[];
  let where="";
  if(q){ params.push(`%${q}%`); where="WHERE telegram_id ILIKE $1 OR username ILIKE $1 OR first_name ILIKE $1 OR last_name ILIKE $1"; }
  const r=await pool.query(`SELECT * FROM support_conversations ${where} ORDER BY last_message_at DESC NULLS LAST,updated_at DESC LIMIT 300`,params);
  res.json({success:true,conversations:r.rows});
});

app.get("/api/admin/support/:id/messages", requireAdmin, async (req,res)=>{
  const r=await pool.query(`SELECT m.*,c.telegram_id,c.chat_id FROM support_messages m
    JOIN support_conversations c ON c.id=m.conversation_id
    WHERE c.id=$1 ORDER BY m.created_at ASC`,[req.params.id]);
  await pool.query("UPDATE support_conversations SET unread_count=0,updated_at=NOW() WHERE id=$1",[req.params.id]);
  res.json({success:true,messages:r.rows});
});

app.post("/api/admin/support/:id/reply", requireAdmin, async (req,res)=>{
  const text=String(req.body.message||"").trim();
  if(!text) return res.status(400).json({success:false,message:"Message required"});
  const c=await pool.query("SELECT * FROM support_conversations WHERE id=$1",[req.params.id]);
  if(!c.rows.length) return res.status(404).json({success:false,message:"Conversation not found"});
  const chatId=c.rows[0].chat_id;
  const sent=await telegramApi("sendMessage",{chat_id:chatId,text});
  const msg=await pool.query(`INSERT INTO support_messages(conversation_id,sender_type,sender_id,message_text,telegram_message_id)
    VALUES($1,'admin',$2,$3,$4) RETURNING *`,[req.params.id,"admin",text,sent.result?.message_id||null]);
  await pool.query("UPDATE support_conversations SET status='replied',unread_count=0,updated_at=NOW(),last_message_at=NOW() WHERE id=$1",[req.params.id]);
  await adminLog("support_reply","support",req.params.id,{message:text});
  res.json({success:true,message:msg.rows[0]});
});

app.post("/api/admin/support/:id/status", requireAdmin, async (req,res)=>{
  const status=String(req.body.status||"").toLowerCase();
  if(!["new","open","replied","closed"].includes(status)) return res.status(400).json({success:false,message:"Invalid status"});
  await pool.query("UPDATE support_conversations SET status=$1,updated_at=NOW() WHERE id=$2",[status,req.params.id]);
  await adminLog("support_status","support",req.params.id,{status});
  res.json({success:true,status});
});

// Replace old withdrawal process/reject behavior with blockchain send.
app.post("/api/admin/withdrawals/:id/process", requireAdmin, async (req,res)=>{
  const id=String(req.params.id);
  const client=await pool.connect();
  let withdrawal=null;
  try{
    await client.query("BEGIN");
    const wr=await client.query("SELECT * FROM withdrawals WHERE id=$1 FOR UPDATE",[id]);
    if(!wr.rows.length){await client.query("ROLLBACK");return res.status(404).json({success:false,message:"Withdrawal not found"});}
    withdrawal=wr.rows[0];
    if(withdrawal.status!=="pending"){await client.query("ROLLBACK");return res.status(409).json({success:false,message:"Withdrawal already processed"});}
    if(!isValidBscAddress(withdrawal.address)){await client.query("ROLLBACK");return res.status(400).json({success:false,message:"Invalid BEP-20 wallet address"});}
    const ur=await client.query("SELECT * FROM users WHERE telegram_id=$1 FOR UPDATE",[String(withdrawal.telegram_id)]);
    if(!ur.rows.length){await client.query("ROLLBACK");return res.status(404).json({success:false,message:"User not found"});}
    const amount=Number(withdrawal.amount||0), balance=Number(ur.rows[0].balance||0);
    if(amount<=0||amount>balance){await client.query("ROLLBACK");return res.status(400).json({success:false,message:"Insufficient balance"});}
    await client.query("UPDATE users SET balance=balance-$1,updated_at=NOW() WHERE telegram_id=$2",[amount,String(withdrawal.telegram_id)]);
    await client.query("UPDATE withdrawals SET status='processing',error_message=NULL WHERE id=$1",[id]);
    await client.query("COMMIT");
  }catch(e){await client.query("ROLLBACK");throw e;}finally{client.release();}

  try{
    const sent=await sendBep20Usdt(withdrawal.address,Number(withdrawal.amount));

    if(sent.pending){
      await pool.query(
        `UPDATE withdrawals SET status='processing',tx_hash=$1,block_number=NULL,error_message=NULL WHERE id=$2`,
        [sent.tx_hash,id]
      );
      await adminLog("withdrawal_broadcast","withdrawal",id,{
        tx_hash:sent.tx_hash,
        amount:Number(withdrawal.amount),
        address:withdrawal.address
      });
      return res.status(202).json({
        success:true,
        message:"Withdrawal broadcast successfully. Waiting for blockchain confirmation.",
        tx_hash:sent.tx_hash,
        withdrawal:{...withdrawal,status:"processing",tx_hash:sent.tx_hash}
      });
    }

    await pool.query(`UPDATE withdrawals SET status='completed',tx_hash=$1,block_number=$2,processed_at=NOW(),error_message=NULL WHERE id=$3`,
      [sent.tx_hash,sent.block_number,id]);
    await adminLog("withdrawal_completed","withdrawal",id,{tx_hash:sent.tx_hash,amount:Number(withdrawal.amount),address:withdrawal.address});
    const paidUser=await pool.query("SELECT first_name,last_name,username,telegram_id FROM users WHERE telegram_id=$1",[String(withdrawal.telegram_id)]);
    const pu=paidUser.rows[0]||{};
    const paidName=[pu.first_name,pu.last_name].filter(Boolean).join(" ") || pu.username || String(withdrawal.telegram_id);
    void sendPayoutReviewMessage(`✅ NEXORA AI PAYOUT REVIEW\n\nWithdrawal Approved & Sent\n👤 ${paidName}\n🆔 ${withdrawal.telegram_id}\n💵 ${Number(withdrawal.amount).toFixed(4)} USDT\n🌐 BEP-20\n🏦 ${withdrawal.address}\n🔗 TX: <a href="https://bscscan.com/tx/${sent.tx_hash}">${sent.tx_hash}</a>`,{parse_mode:"HTML"});
    void sendMainBotMessage(String(withdrawal.telegram_id),`✅ Nexora AI — Withdrawal Sent\n\n👤 ${paidName}\n💵 ${Number(withdrawal.amount).toFixed(4)} USDT\n🌐 BEP-20 USDT\n🟢 Status: Completed\n🔗 TX: ${sent.tx_hash}`);
    return res.json({success:true,message:"Withdrawal approved and sent on BEP-20",tx_hash:sent.tx_hash,withdrawal:{...withdrawal,status:"completed",tx_hash:sent.tx_hash}});
  }catch(e){
    await pool.query("UPDATE users SET balance=balance+$1,updated_at=NOW() WHERE telegram_id=$2",[Number(withdrawal.amount),String(withdrawal.telegram_id)]);
    await pool.query("UPDATE withdrawals SET status='failed',error_message=$1 WHERE id=$2",[String(e.message||e),id]);
    await adminLog("withdrawal_failed","withdrawal",id,{error:String(e.message||e)});
    void sendPayoutReviewMessage(`❌ NEXORA AI PAYOUT REVIEW\n\nWithdrawal Failed\n🆔 ${withdrawal.telegram_id}\n💵 ${Number(withdrawal.amount).toFixed(4)} USDT\n⚠️ ${String(e.message||e)}\n\nUser balance was restored.`);
    return res.status(502).json({success:false,message:"Blockchain transfer failed. User balance was restored.",error:String(e.message||e)});
  }
});

app.post("/api/admin/withdrawals/:id/reject", requireAdmin, async (req,res)=>{
  const id=String(req.params.id);
  const r=await pool.query("UPDATE withdrawals SET status='rejected',processed_at=NOW() WHERE id=$1 AND status='pending' RETURNING *",[id]);
  if(!r.rows.length)return res.status(409).json({success:false,message:"Withdrawal not found or already processed"});
  await adminLog("withdrawal_rejected","withdrawal",id,{});
  void sendPayoutReviewMessage(`🚫 NEXORA AI PAYOUT REVIEW\n\nWithdrawal Rejected\n🆔 ${r.rows[0].telegram_id}\n💵 ${Number(r.rows[0].amount||0).toFixed(4)} USDT`);
  void sendMainBotMessage(String(r.rows[0].telegram_id),`🚫 Nexora AI — Withdrawal Rejected\n\n💵 ${Number(r.rows[0].amount||0).toFixed(4)} USDT\n🔴 Status: Rejected`);
  res.json({success:true,message:"Withdrawal rejected",withdrawal:r.rows[0]});
});

// Admin support/bot status
app.get("/api/admin/support/status", requireAdmin, async (req,res)=>{
  const c=await pool.query("SELECT COUNT(*)::int total, COUNT(*) FILTER (WHERE status IN ('new','open'))::int open, COALESCE(SUM(unread_count),0)::int unread FROM support_conversations");
  res.json({success:true,status:c.rows[0]});
});

// ================= NFT LIVE MINING ENGINE =================

let miningSettlementRunning = false;

function calculateNFTDailyEarning(purchase) {
  const price = Number(purchase.price || 0);
  const rate = Number(purchase.daily_rate || 0);

  return Number((price * rate / 100).toFixed(8));
}

async function settleNFTMining() {
  if (miningSettlementRunning) return;

  miningSettlementRunning = true;

  try {
    await db.read();

    db.data.users ||= [];
    db.data.nft_purchases ||= [];

    const nowMs = Date.now();
    let changed = false;

    for (const purchase of db.data.nft_purchases) {
      if (!purchase || !purchase.telegram_id) continue;

      const durationDays = Number(purchase.duration_days || 0);

      if (durationDays <= 0) continue;

      const purchasedMs = new Date(
        purchase.purchased_at || purchase.created_at || Date.now()
      ).getTime();

      if (!Number.isFinite(purchasedMs)) continue;

      // Initialize mining state for existing purchases.
      if (!purchase.mined_cycles) {
        purchase.mined_cycles = 0;
        changed = true;
      }

      if (!purchase.daily_earning) {
        purchase.daily_earning = calculateNFTDailyEarning(purchase);
        changed = true;
      }

      if (!purchase.next_mining_at) {
        purchase.next_mining_at = new Date(
          purchasedMs + 24 * 60 * 60 * 1000
        ).toISOString();
        changed = true;
      }

      if (!purchase.total_mined) {
        purchase.total_mined = 0;
        changed = true;
      }

      if (purchase.status === 'completed') continue;

      const user = db.data.users.find(
        u => String(u.telegram_id) === String(purchase.telegram_id)
      );

      if (!user) continue;

      const dailyEarning = Number(purchase.daily_earning || 0);

      if (dailyEarning <= 0) continue;

      let nextMiningMs = new Date(purchase.next_mining_at).getTime();

      if (!Number.isFinite(nextMiningMs)) {
        nextMiningMs =
          purchasedMs +
          (Number(purchase.mined_cycles || 0) + 1) *
            24 * 60 * 60 * 1000;

        purchase.next_mining_at = new Date(nextMiningMs).toISOString();
        changed = true;
      }

      let cyclesDue = 0;

      while (
        nowMs >= nextMiningMs &&
        Number(purchase.mined_cycles || 0) < durationDays
      ) {
        cyclesDue++;

        purchase.mined_cycles =
          Number(purchase.mined_cycles || 0) + 1;

        purchase.total_mined = Number(
          (Number(purchase.total_mined || 0) + dailyEarning).toFixed(8)
        );

        user.balance = Number(
          (Number(user.balance || 0) + dailyEarning).toFixed(8)
        );

        user.total_earned = Number(
          (Number(user.total_earned || 0) + dailyEarning).toFixed(8)
        );

        user.updated_at = new Date().toISOString();

        nextMiningMs += 24 * 60 * 60 * 1000;

        purchase.next_mining_at =
          new Date(nextMiningMs).toISOString();

        changed = true;
      }

      if (
        Number(purchase.mined_cycles || 0) >= durationDays
      ) {
        purchase.status = 'completed';
        purchase.next_mining_at = null;
        purchase.mining_completed_at =
          new Date().toISOString();
        changed = true;
      }

      if (cyclesDue > 0) {
        purchase.last_mined_at =
          new Date().toISOString();
      }
    }

    if (changed) {
      await db.write();
    }
  } catch (error) {
    console.error('NFT mining settlement error:', error);
  } finally {
    miningSettlementRunning = false;
  }
}

// User-specific mining state.
// The backend settles due earnings before returning the timers.
app.get('/api/nft/mining', requireTelegramUser, async (req, res) => {
  try {
    await settleNFTMining();
    await db.read();

    const telegramId = String(req.telegramUser.id);

    db.data.nft_purchases ||= [];

    const purchases = db.data.nft_purchases.filter(
      p => String(p.telegram_id) === telegramId
    );

    const mining = purchases.map(p => {
      const durationDays = Number(p.duration_days || 0);
      const minedCycles = Number(p.mined_cycles || 0);

      return {
        id: p.id,
        nft_id: p.nft_id,
        nft_name: p.nft_name,
        price: Number(p.price || 0),
        daily_rate: Number(p.daily_rate || 0),
        daily_earning: Number(
          p.daily_earning || calculateNFTDailyEarning(p)
        ),
        duration_days: durationDays,
        mined_cycles: minedCycles,
        remaining_cycles: Math.max(
          0,
          durationDays - minedCycles
        ),
        purchased_at: p.purchased_at,
        next_mining_at: p.next_mining_at || null,
        last_mined_at: p.last_mined_at || null,
        total_mined: Number(p.total_mined || 0),
        status: p.status || 'active'
      };
    });

    res.json({
      success: true,
      mining
    });
  } catch (error) {
    console.error('NFT mining API error:', error);

    res.status(500).json({
      success: false,
      message: 'Unable to load NFT mining'
    });
  }
});

// Automatic backend settlement.
// This keeps mining progressing even when the Mini App is closed.
settleNFTMining();

setInterval(() => {
  settleNFTMining();
}, 60 * 1000);

// ================= END NFT LIVE MINING ENGINE =================


// NEXORA_ADMIN_V1_END

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
      daily_earning: Number((nft.price * nft.daily_rate / 100).toFixed(8)),
      mined_cycles: 0,
      total_mined: 0,
      next_mining_at: new Date(
        Date.now() + 24 * 60 * 60 * 1000
      ).toISOString(),
      last_mined_at: null,
      referral_commission: referralCommission,
      commission_credited: referralCommission > 0,
      referrer_telegram_id: referrerTelegramId,
      status: "active",
      purchased_at: now
    };

    db.data.nft_purchases.push(purchase);

    await db.write();

    const nftBuyerName=[user.first_name,user.last_name].filter(Boolean).join(" ") || user.username || telegramId;
    void sendMainBotMessage(telegramId,`🖼️ Nexora AI — NFT Purchase\n\n👤 ${nftBuyerName}\n💎 Plan: ${nft.name}\n💵 Price: ${Number(nft.price).toFixed(2)} USDT\n🟢 Status: Active${referralCommission>0?`\n🎁 Referral commission credited: ${referralCommission.toFixed(4)} USDT`:""}`);
    if (referralCommission > 0 && referrerTelegramId) {
      void sendMainBotMessage(referrerTelegramId,`🎁 Nexora AI — 5% Referral NFT Commission\n\nYour referred user purchased ${nft.name}.\n💵 Commission: ${referralCommission.toFixed(4)} USDT\n🟢 Commission credited to your balance.`);
    }

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

