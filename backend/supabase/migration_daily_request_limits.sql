-- Run once in Supabase when deploying the daily request limits.
-- Start every existing account with a fresh 24-hour quota window.

update users
set requests_used = 0,
    period_reset_at = now() + interval '1 day';