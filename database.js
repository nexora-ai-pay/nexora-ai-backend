const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

const db = {
  data: {
    users: [],
    deposits: [],
    withdrawals: [],
    nft_purchases: []
  },

  async read() {
    const [users, deposits, withdrawals, nftPurchases] =
      await Promise.all([
        pool.query("SELECT * FROM users ORDER BY created_at ASC"),
        pool.query("SELECT * FROM deposits ORDER BY created_at ASC"),
        pool.query("SELECT * FROM withdrawals ORDER BY created_at ASC"),
        pool.query("SELECT * FROM nft_purchases ORDER BY purchased_at ASC")
      ]);

    this.data.users = users.rows.map((u) => ({
      ...u,
      balance: Number(u.balance || 0),
      total_earned: Number(u.total_earned || 0)
    }));

    this.data.deposits = deposits.rows.map((d) => ({
      ...d,
      requested_amount: Number(d.requested_amount || 0),
      amount: Number(d.amount || 0),
      referral_commission: Number(d.referral_commission || 0)
    }));

    this.data.withdrawals = withdrawals.rows.map((w) => ({
      ...w,
      amount: Number(w.amount || 0)
    }));

    this.data.nft_purchases = nftPurchases.rows.map((n) => ({
      ...n,
      price: Number(n.price || 0),
      duration_days: Number(n.duration_days || 0),
      daily_rate: Number(n.daily_rate || 0),
      daily_earning: Number(n.daily_earning || 0),
      mined_cycles: Number(n.mined_cycles || 0),
      total_mined: Number(n.total_mined || 0),
      referral_commission: Number(n.referral_commission || 0)
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
            (telegram_id, username, first_name, last_name,
             balance, total_earned, referral_code, referred_by,
             created_at, updated_at)
           VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (telegram_id)
           DO UPDATE SET
             username = EXCLUDED.username,
             first_name = EXCLUDED.first_name,
             last_name = EXCLUDED.last_name,
             balance = EXCLUDED.balance,
             total_earned = EXCLUDED.total_earned,
             referral_code = EXCLUDED.referral_code,
             referred_by = EXCLUDED.referred_by,
             created_at = EXCLUDED.created_at,
             updated_at = EXCLUDED.updated_at`,
          [
            String(u.telegram_id),
            u.username || "",
            u.first_name || "",
            u.last_name || "",
            Number(u.balance || 0),
            Number(u.total_earned || 0),
            u.referral_code || "",
            u.referred_by || "",
            u.created_at || new Date().toISOString(),
            u.updated_at || new Date().toISOString()
          ]
        );
      }

      for (const d of this.data.deposits || []) {
        await client.query(
          `INSERT INTO deposits
            (id, telegram_id, requested_amount, amount,
             deposit_address, network, token, status,
             referral_commission, commission_credited,
             created_at, verified_at)
           VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id)
           DO UPDATE SET
             telegram_id = EXCLUDED.telegram_id,
             requested_amount = EXCLUDED.requested_amount,
             amount = EXCLUDED.amount,
             deposit_address = EXCLUDED.deposit_address,
             network = EXCLUDED.network,
             token = EXCLUDED.token,
             status = EXCLUDED.status,
             referral_commission = EXCLUDED.referral_commission,
             commission_credited = EXCLUDED.commission_credited,
             created_at = EXCLUDED.created_at,
             verified_at = EXCLUDED.verified_at`,
          [
            String(d.id),
            String(d.telegram_id),
            Number(d.requested_amount || 0),
            Number(d.amount || 0),
            d.deposit_address || "",
            d.network || "BEP-20",
            d.token || "USDT",
            d.status || "pending",
            Number(d.referral_commission || 0),
            Boolean(d.commission_credited),
            d.created_at || new Date().toISOString(),
            d.verified_at || null
          ]
        );
      }

      for (const w of this.data.withdrawals || []) {
        await client.query(
          `INSERT INTO withdrawals
            (id, telegram_id, amount, address,
             status, created_at, processed_at)
           VALUES
            ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id)
           DO UPDATE SET
             telegram_id = EXCLUDED.telegram_id,
             amount = EXCLUDED.amount,
             address = EXCLUDED.address,
             status = EXCLUDED.status,
             created_at = EXCLUDED.created_at,
             processed_at = EXCLUDED.processed_at`,
          [
            String(w.id),
            String(w.telegram_id),
            Number(w.amount || 0),
            w.address || "",
            w.status || "pending",
            w.created_at || new Date().toISOString(),
            w.processed_at || null
          ]
        );
      }

      for (const n of this.data.nft_purchases || []) {
        await client.query(
          `INSERT INTO nft_purchases
            (id, telegram_id, nft_id, nft_name, price,
             duration_days, daily_rate, daily_earning,
             mined_cycles, total_mined, next_mining_at,
             last_mined_at, referral_commission,
             commission_credited, referrer_telegram_id,
             status, purchased_at)
           VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (id)
           DO UPDATE SET
             telegram_id = EXCLUDED.telegram_id,
             nft_id = EXCLUDED.nft_id,
             nft_name = EXCLUDED.nft_name,
             price = EXCLUDED.price,
             duration_days = EXCLUDED.duration_days,
             daily_rate = EXCLUDED.daily_rate,
             daily_earning = EXCLUDED.daily_earning,
             mined_cycles = EXCLUDED.mined_cycles,
             total_mined = EXCLUDED.total_mined,
             next_mining_at = EXCLUDED.next_mining_at,
             last_mined_at = EXCLUDED.last_mined_at,
             referral_commission = EXCLUDED.referral_commission,
             commission_credited = EXCLUDED.commission_credited,
             referrer_telegram_id = EXCLUDED.referrer_telegram_id,
             status = EXCLUDED.status,
             purchased_at = EXCLUDED.purchased_at`,
          [
            String(n.id),
            String(n.telegram_id),
            String(n.nft_id),
            n.nft_name || "",
            Number(n.price || 0),
            Number(n.duration_days || 0),
            Number(n.daily_rate || 0),
            Number(n.daily_earning || 0),
            Number(n.mined_cycles || 0),
            Number(n.total_mined || 0),
            n.next_mining_at || null,
            n.last_mined_at || null,
            Number(n.referral_commission || 0),
            Boolean(n.commission_credited),
            n.referrer_telegram_id || "",
            n.status || "active",
            n.purchased_at || new Date().toISOString()
          ]
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
  await db.read();

  console.log("Nexora AI PostgreSQL database initialized successfully.");
  console.log(
    `PostgreSQL data loaded: ${db.data.users.length} users, ${db.data.deposits.length} deposits, ${db.data.withdrawals.length} withdrawals, ${db.data.nft_purchases.length} NFT purchases`
  );
}

module.exports = {
  db,
  initDatabase,
  pool
};
