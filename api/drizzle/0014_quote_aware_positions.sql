ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "token_y_mint" text;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "quote_mint" text;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "quote_symbol" text;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "quote_decimals" integer;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "quote_side" text;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "valuation_status" text;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "economic_status" text;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "pnl_quote" double precision;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "pnl_pct_quote" double precision;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "size_quote" double precision;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "deposit_quote" double precision;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "withdraw_quote" double precision;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "claimed_fees_quote" double precision;
--> statement-breakpoint
ALTER TABLE "positions" ADD COLUMN IF NOT EXISTS "unclaimed_fees_quote" double precision;
--> statement-breakpoint
ALTER TABLE "dlmm_legs" ALTER COLUMN "active_bin_id" DROP NOT NULL;
--> statement-breakpoint

-- Backfill only facts that are already trustworthy. Existing SOL rows retain their exact legacy
-- amounts in the native-quote columns. Non-SOL rows receive their real quote identity but remain
-- unpriced until the on-chain leg projector recomputes them; zero must never masquerade as complete.
UPDATE "positions" AS p
SET
  "token_y_mint" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112' THEN d."mint_x"
    WHEN d."mint_y" = 'So11111111111111111111111111111111111111112' THEN d."mint_y"
    WHEN d."mint_x" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN d."mint_x"
    WHEN d."mint_y" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN d."mint_y"
    WHEN d."mint_x" = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' THEN d."mint_x"
    ELSE d."mint_y"
  END,
  "quote_mint" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112' THEN d."mint_x"
    WHEN d."mint_y" = 'So11111111111111111111111111111111111111112' THEN d."mint_y"
    WHEN d."mint_x" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN d."mint_x"
    WHEN d."mint_y" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN d."mint_y"
    WHEN d."mint_x" = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' THEN d."mint_x"
    ELSE d."mint_y"
  END,
  "quote_symbol" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN 'SOL'
    WHEN d."mint_x" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
      OR d."mint_y" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' THEN 'USDC'
    WHEN d."mint_x" = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
      OR d."mint_y" = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' THEN 'USDT'
    ELSE NULL
  END,
  "quote_decimals" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN 9
    WHEN d."mint_x" IN (
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    ) OR d."mint_y" IN (
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    ) THEN 6
    ELSE NULL
  END,
  "quote_side" = CASE
    WHEN d."mint_x" IN (
      'So11111111111111111111111111111111111111112',
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    ) THEN 'X'
    ELSE 'Y'
  END,
  "valuation_status" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN 'complete'
    ELSE 'unpriced'
  END,
  "pnl_quote" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN p."pnl_sol"
    ELSE NULL
  END,
  "pnl_pct_quote" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN p."pnl_pct_sol"
    ELSE NULL
  END,
  "size_quote" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN p."size_sol"
    ELSE NULL
  END,
  "deposit_quote" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN p."deposit_sol"
    ELSE NULL
  END,
  "withdraw_quote" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN p."withdraw_sol"
    ELSE NULL
  END,
  "claimed_fees_quote" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN p."claimed_fees_sol"
    ELSE NULL
  END,
  "unclaimed_fees_quote" = CASE
    WHEN d."mint_x" = 'So11111111111111111111111111111111111111112'
      OR d."mint_y" = 'So11111111111111111111111111111111111111112' THEN p."unclaimed_fees_sol"
    ELSE NULL
  END
FROM "dlmm_pools" AS d
WHERE p."pool_address" = d."pool_address";
--> statement-breakpoint

UPDATE "positions" AS p
SET "economic_status" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "dlmm_legs" AS l
    WHERE l."position" = p."position_address"
      AND (l."amount_x" <> '0' OR l."amount_y" <> '0')
  ) THEN 'funded'
  WHEN EXISTS (
    SELECT 1 FROM "dlmm_legs" AS l
    WHERE l."position" = p."position_address"
  ) THEN 'empty_shell'
  ELSE NULL
END;
