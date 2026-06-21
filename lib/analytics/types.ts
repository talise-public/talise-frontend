/**
 * Shared types for the Talise on-chain analytics indexer.
 *
 * These are the single source of truth for the analytics pipeline: the indexing
 * sources (gRPC / SuiVision) normalize into `IndexedTx`, per-user index passes
 * produce `UserIndex`, the recent-transaction feed is composed of `RecentTx`
 * rows, and the dashboard API serves an `AnalyticsSummary`. All other analytics
 * modules import these types rather than redeclaring them.
 */

/** One normalized on-chain transaction touching a user. */
export type IndexedTx = {
  digest: string;
  ts: number;                 // epoch ms
  direction: string;          // 'sent'|'received'|'swap'|'invest'|'withdraw'|'autoswap'
  amountUsd: number | null;   // USDsui≈USD magnitude moved (non-negative), null if unknown
  counterparty: string | null;
  counterpartyName: string | null; // resolved name@talise if any
  source: "grpc" | "suivision";
};

/** Per-user aggregate from one index pass. */
export type UserIndex = {
  txCount: number;
  volumeUsd: number;          // sum of |amountUsd| over the user's txs
  swapCount: number;          // count of direction in ('swap','autoswap')
  lastActiveAt: number | null;
  txs: IndexedTx[];           // the individual txs (feed the recent-tx table)
};

/** A row in the recent-transactions table. */
export type RecentTx = {
  digest: string;
  ts: number;                 // epoch ms
  direction: string;
  amountUsd: number | null;
  handle: string | null;      // the indexed user's talise_username
  address: string | null;     // the indexed user's sui_address
  counterparty: string | null;
  counterpartyName: string | null;
};

export type AnalyticsSummary = {
  totals: {
    users: number;            // total Talise accounts (COUNT users, excl deleted)
    stablecoinVolumeUsd: number; // SUM(volume_usd) over indexed users
    transactions: number;     // SUM(tx_count) over indexed users
  };
  recent: RecentTx[];         // newest-first, from analytics_recent_tx
  index: {
    indexedUsers: number;     // rows in analytics_user_stats
    totalUsers: number;       // same as totals.users
    lastRunAt: number | null; // last batch run (epoch ms)
    fullPassAt: number | null;// when the last full pass over all users completed
  };
};
