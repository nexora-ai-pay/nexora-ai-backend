CREATE TABLE IF NOT EXISTS users (
  telegram_id TEXT PRIMARY KEY,
  username TEXT DEFAULT '',
  first_name TEXT DEFAULT '',
  last_name TEXT DEFAULT '',
  balance NUMERIC(30,8) NOT NULL DEFAULT 0,
  total_earned NUMERIC(30,8) NOT NULL DEFAULT 0,
  referral_code TEXT UNIQUE,
  referred_by TEXT DEFAULT '',
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS deposits (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  requested_amount NUMERIC(30,8) NOT NULL DEFAULT 0,
  amount NUMERIC(30,8) NOT NULL DEFAULT 0,
  deposit_address TEXT DEFAULT '',
  network TEXT DEFAULT 'BEP-20',
  token TEXT DEFAULT 'USDT',
  status TEXT NOT NULL DEFAULT 'pending',
  referral_commission NUMERIC(30,8) NOT NULL DEFAULT 0,
  commission_credited BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_deposits_telegram_id
ON deposits(telegram_id);

CREATE INDEX IF NOT EXISTS idx_deposits_status
ON deposits(status);

CREATE TABLE IF NOT EXISTS withdrawals (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  amount NUMERIC(30,8) NOT NULL DEFAULT 0,
  address TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ,
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_withdrawals_telegram_id
ON withdrawals(telegram_id);

CREATE INDEX IF NOT EXISTS idx_withdrawals_status
ON withdrawals(status);

CREATE TABLE IF NOT EXISTS nft_purchases (
  id TEXT PRIMARY KEY,
  telegram_id TEXT NOT NULL,
  nft_id TEXT NOT NULL,
  nft_name TEXT NOT NULL,
  price NUMERIC(30,8) NOT NULL DEFAULT 0,
  duration_days INTEGER NOT NULL DEFAULT 0,
  daily_rate NUMERIC(30,8) NOT NULL DEFAULT 0,
  daily_earning NUMERIC(30,8) NOT NULL DEFAULT 0,
  mined_cycles INTEGER NOT NULL DEFAULT 0,
  total_mined NUMERIC(30,8) NOT NULL DEFAULT 0,
  next_mining_at TIMESTAMPTZ,
  last_mined_at TIMESTAMPTZ,
  referral_commission NUMERIC(30,8) NOT NULL DEFAULT 0,
  commission_credited BOOLEAN NOT NULL DEFAULT FALSE,
  referrer_telegram_id TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  purchased_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_nft_purchases_telegram_id
ON nft_purchases(telegram_id);

CREATE INDEX IF NOT EXISTS idx_nft_purchases_status
ON nft_purchases(status);
