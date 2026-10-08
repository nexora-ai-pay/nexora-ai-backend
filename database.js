const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const db = {
  data: {
    users: [],
    deposits: [],
    withdrawals: [],
    nft_purchases: [],
    free_earning_claims: [],
    free_earning_history: [],
    free_referral_rewards: []
  },

  async read() {
    const [users, deposits, withdrawals, nftPurchases, freeEarningClaims, freeEarningHistory, freeReferralRewards] = await Promise.all([
      pool.query("SELECT * FROM users ORDER BY created_at ASC"),
      pool.query("SELECT * FROM deposits ORDER BY created_at ASC"),
      pool.query("SELECT * FROM withdrawals ORDER BY created_at ASC"),
      pool.query("SELECT * FROM nft_purchases ORDER BY purchased_at ASC"),
      pool.query("SELECT * FROM free_earning_claims ORDER BY created_at ASC"),
      pool.query("SELECT * FROM free_earning_history ORDER BY created_at ASC"),
      pool.query("SELECT * FROM free_referral_rewards ORDER BY created_at ASC")
    ]);

    this.data.users = users.rows.map(u => ({
      ...u,
      balance: Number(u.balance || 0),
      total_earned: Number(u.total_earned || 0),
      banned: Boolean(u.banned)
    }));

    this.data.deposits = deposits.rows.map(d => ({
      ...d,
      requested_amount: Number(d.requested_amount || 0),
      amount: Number(d.amount || 0),
      referral_commission: Number(d.referral_commission || 0)
    }));

    this.data.withdrawals = withdrawals.rows.map(w => ({
      ...w,
      amount: Number(w.amount || 0)
    }));

    this.data.nft_purchases = nftPurchases.rows.map(n => ({
      ...n,
      price: Number(n.price || 0),
      duration_days: Number(n.duration_days || 0),
      daily_rate: Number(n.daily_rate || 0),
      daily_earning: Number(n.daily_earning || 0),
      mined_cycles: Number(n.mined_cycles || 0),
      total_mined: Number(n.total_mined || 0),
      referral_commission: Number(n.referral_commission || 0)
    }));

    this.data.free_earning_claims = freeEarningClaims.rows.map(c => ({
      ...c,
      claim_count: Number(c.claim_count || 0),
      total_earned: Number(c.total_earned || 0)
    }));

    this.data.free_earning_history = freeEarningHistory.rows.map(h => ({
      ...h,
      amount: Number(h.amount || 0)
    }));

    this.data.free_referral_rewards = freeReferralRewards.rows.map(r => ({
      ...r,
      amount: Number(r.amount || 0)
    }));

    return this;
  },

  async write() {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      for (const u of this.data.users || []) {
        await client.query(
          `INSERT INTO users
            (telegram_id, username, first_name, last_name, balance, total_earned,
             referral_code, referred_by, banned, banned_at, ban_reason, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           ON CONFLICT (telegram_id) DO UPDATE SET
             username=EXCLUDED.username, first_name=EXCLUDED.first_name,
             last_name=EXCLUDED.last_name, balance=EXCLUDED.balance,
             total_earned=EXCLUDED.total_earned, referral_code=EXCLUDED.referral_code,
             referred_by=EXCLUDED.referred_by, banned=EXCLUDED.banned,
             banned_at=EXCLUDED.banned_at, ban_reason=EXCLUDED.ban_reason,
             created_at=EXCLUDED.created_at, updated_at=EXCLUDED.updated_at`,
          [
            String(u.telegram_id), u.username || "", u.first_name || "", u.last_name || "",
            Number(u.balance || 0), Number(u.total_earned || 0), u.referral_code || "",
            u.referred_by || "", Boolean(u.banned), u.banned_at || null, u.ban_reason || "",
            u.created_at || new Date().toISOString(), u.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const d of this.data.deposits || []) {
        await client.query(
          `INSERT INTO deposits
            (id, telegram_id, requested_amount, amount, deposit_address, network, token, status,
             referral_commission, commission_credited, tx_hash, block_number, confirmations,
             created_at, verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
           ON CONFLICT (id) DO UPDATE SET
             telegram_id=EXCLUDED.telegram_id, requested_amount=EXCLUDED.requested_amount,
             amount=EXCLUDED.amount, deposit_address=EXCLUDED.deposit_address,
             network=EXCLUDED.network, token=EXCLUDED.token, status=EXCLUDED.status,
             referral_commission=EXCLUDED.referral_commission,
             commission_credited=EXCLUDED.commission_credited, tx_hash=EXCLUDED.tx_hash,
             block_number=EXCLUDED.block_number, confirmations=EXCLUDED.confirmations,
             created_at=EXCLUDED.created_at, verified_at=EXCLUDED.verified_at`,
          [
            String(d.id), String(d.telegram_id), Number(d.requested_amount || 0),
            Number(d.amount || 0), d.deposit_address || "", d.network || "BEP-20",
            d.token || "USDT", d.status || "pending", Number(d.referral_commission || 0),
            Boolean(d.commission_credited), d.tx_hash || null, d.block_number || null,
            Number(d.confirmations || 0), d.created_at || new Date().toISOString(),
            d.verified_at || null
          ]
        );
      }

      for (const w of this.data.withdrawals || []) {
        await client.query(
          `INSERT INTO withdrawals
            (id, telegram_id, amount, address, status, tx_hash, block_number, error_message,
             created_at, processed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (id) DO UPDATE SET
             telegram_id=EXCLUDED.telegram_id, amount=EXCLUDED.amount, address=EXCLUDED.address,
             status=EXCLUDED.status, tx_hash=EXCLUDED.tx_hash, block_number=EXCLUDED.block_number,
             error_message=EXCLUDED.error_message, created_at=EXCLUDED.created_at,
             processed_at=EXCLUDED.processed_at`,
          [
            String(w.id), String(w.telegram_id), Number(w.amount || 0), w.address || "",
            w.status || "pending", w.tx_hash || null, w.block_number || null,
            w.error_message || null, w.created_at || new Date().toISOString(),
            w.processed_at || null
          ]
        );
      }

      for (const n of this.data.nft_purchases || []) {
        await client.query(
          `INSERT INTO nft_purchases
            (id, telegram_id, nft_id, nft_name, price, duration_days, daily_rate, daily_earning,
             mined_cycles, total_mined, next_mining_at, last_mined_at, referral_commission,
             commission_credited, referrer_telegram_id, status, purchased_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (id) DO UPDATE SET
             telegram_id=EXCLUDED.telegram_id, nft_id=EXCLUDED.nft_id, nft_name=EXCLUDED.nft_name,
             price=EXCLUDED.price, duration_days=EXCLUDED.duration_days, daily_rate=EXCLUDED.daily_rate,
             daily_earning=EXCLUDED.daily_earning, mined_cycles=EXCLUDED.mined_cycles,
             total_mined=EXCLUDED.total_mined, next_mining_at=EXCLUDED.next_mining_at,
             last_mined_at=EXCLUDED.last_mined_at, referral_commission=EXCLUDED.referral_commission,
             commission_credited=EXCLUDED.commission_credited,
             referrer_telegram_id=EXCLUDED.referrer_telegram_id, status=EXCLUDED.status,
             purchased_at=EXCLUDED.purchased_at`,
          [
            String(n.id), String(n.telegram_id), String(n.nft_id), n.nft_name || "",
            Number(n.price || 0), Number(n.duration_days || 0), Number(n.daily_rate || 0),
            Number(n.daily_earning || 0), Number(n.mined_cycles || 0), Number(n.total_mined || 0),
            n.next_mining_at || null, n.last_mined_at || null, Number(n.referral_commission || 0),
            Boolean(n.commission_credited), n.referrer_telegram_id || "", n.status || "active",
            n.purchased_at || new Date().toISOString()
          ]
        );
      }

      for (const c of this.data.free_earning_claims || []) {
        await client.query(
          `INSERT INTO free_earning_claims
            (telegram_id, claim_count, total_earned, last_claim_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (telegram_id) DO UPDATE SET
             claim_count=EXCLUDED.claim_count,
             total_earned=EXCLUDED.total_earned,
             last_claim_at=EXCLUDED.last_claim_at,
             created_at=EXCLUDED.created_at,
             updated_at=EXCLUDED.updated_at`,
          [String(c.telegram_id), Number(c.claim_count || 0), Number(c.total_earned || 0),
           c.last_claim_at || null, c.created_at || new Date().toISOString(), c.updated_at || new Date().toISOString()]
        );
      }

      for (const h of this.data.free_earning_history || []) {
        await client.query(
          `INSERT INTO free_earning_history
            (id, telegram_id, amount, type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (id) DO UPDATE SET
             telegram_id=EXCLUDED.telegram_id, amount=EXCLUDED.amount,
             type=EXCLUDED.type, status=EXCLUDED.status, created_at=EXCLUDED.created_at`,
          [String(h.id), String(h.telegram_id), Number(h.amount || 0), h.type || "DAILY_FREE_EARNING",
           h.status || "credited", h.created_at || new Date().toISOString()]
        );
      }

      for (const r of this.data.free_referral_rewards || []) {
        await client.query(
          `INSERT INTO free_referral_rewards
            (id, referrer_telegram_id, referred_telegram_id, referral_code, amount, reward_type, status, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (id) DO UPDATE SET
             referrer_telegram_id=EXCLUDED.referrer_telegram_id,
             referred_telegram_id=EXCLUDED.referred_telegram_id,
             referral_code=EXCLUDED.referral_code, amount=EXCLUDED.amount,
             reward_type=EXCLUDED.reward_type, status=EXCLUDED.status, created_at=EXCLUDED.created_at`,
          [String(r.id), String(r.referrer_telegram_id), String(r.referred_telegram_id), r.referral_code || "",
           Number(r.amount || 0), r.reward_type || "FREE_REFERRAL", r.status || "credited",
           r.created_at || new Date().toISOString()]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
};

async function initDatabase() {
  await pool.query(`ALTER TABLE users
    ADD COLUMN IF NOT EXISTS banned BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ban_reason TEXT DEFAULT '';`);

  await pool.query(`ALTER TABLE deposits
    ADD COLUMN IF NOT EXISTS tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS block_number BIGINT,
    ADD COLUMN IF NOT EXISTS confirmations INTEGER NOT NULL DEFAULT 0;`);

  await pool.query(`ALTER TABLE withdrawals
    ADD COLUMN IF NOT EXISTS tx_hash TEXT,
    ADD COLUMN IF NOT EXISTS block_number BIGINT,
    ADD COLUMN IF NOT EXISTS error_message TEXT;`);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_deposits_tx_hash
    ON deposits(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash <> '';`);

  await pool.query(`CREATE TABLE IF NOT EXISTS support_conversations (
    id BIGSERIAL PRIMARY KEY,
    telegram_id TEXT NOT NULL UNIQUE,
    chat_id TEXT NOT NULL,
    username TEXT DEFAULT '',
    first_name TEXT DEFAULT '',
    last_name TEXT DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    unread_count INTEGER NOT NULL DEFAULT 0,
    assigned_admin TEXT DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_message_at TIMESTAMPTZ
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS support_messages (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES support_conversations(id) ON DELETE CASCADE,
    sender_type TEXT NOT NULL CHECK (sender_type IN ('user','admin','system')),
    sender_id TEXT DEFAULT '',
    message_text TEXT NOT NULL,
    telegram_message_id BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_at TIMESTAMPTZ
  );`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_support_messages_conversation
    ON support_messages(conversation_id, created_at);`);

  await pool.query(`CREATE TABLE IF NOT EXISTS admin_activity_logs (
    id BIGSERIAL PRIMARY KEY,
    admin_action TEXT NOT NULL,
    target_type TEXT DEFAULT '',
    target_id TEXT DEFAULT '',
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS admin_settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS blockchain_scans (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT '',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS free_earning_claims (
    telegram_id TEXT PRIMARY KEY,
    claim_count INTEGER NOT NULL DEFAULT 0,
    total_earned NUMERIC(30,8) NOT NULL DEFAULT 0,
    last_claim_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

  await pool.query(`CREATE TABLE IF NOT EXISTS free_earning_history (
    id TEXT PRIMARY KEY,
    telegram_id TEXT NOT NULL,
    amount NUMERIC(30,8) NOT NULL DEFAULT 0,
    type TEXT NOT NULL DEFAULT 'DAILY_FREE_EARNING',
    status TEXT NOT NULL DEFAULT 'credited',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_free_earning_history_telegram
    ON free_earning_history(telegram_id, created_at);`);

  await pool.query(`CREATE TABLE IF NOT EXISTS free_referral_rewards (
    id TEXT PRIMARY KEY,
    referrer_telegram_id TEXT NOT NULL,
    referred_telegram_id TEXT NOT NULL,
    referral_code TEXT DEFAULT '',
    amount NUMERIC(30,8) NOT NULL DEFAULT 0,
    reward_type TEXT NOT NULL DEFAULT 'FREE_REFERRAL',
    status TEXT NOT NULL DEFAULT 'credited',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`);

  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_free_referral_rewards_referred
    ON free_referral_rewards(referred_telegram_id);`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_free_referral_rewards_referrer
    ON free_referral_rewards(referrer_telegram_id, created_at);`);

  await pool.query(`CREATE TABLE IF NOT EXISTS unmatched_deposits (
    id BIGSERIAL PRIMARY KEY,
    tx_hash TEXT NOT NULL UNIQUE,
    from_address TEXT DEFAULT '',
    to_address TEXT DEFAULT '',
    amount NUMERIC(30,8) NOT NULL DEFAULT 0,
    block_number BIGINT,
    reason TEXT DEFAULT '',
    resolved BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at TIMESTAMPTZ
  );`);

  await db.read();
  console.log("Nexora AI PostgreSQL database initialized successfully.");
  console.log(`PostgreSQL data loaded: ${db.data.users.length} users, ${db.data.deposits.length} deposits, ${db.data.withdrawals.length} withdrawals, ${db.data.nft_purchases.length} NFT purchases`);
}

module.exports = { db, initDatabase, pool };
