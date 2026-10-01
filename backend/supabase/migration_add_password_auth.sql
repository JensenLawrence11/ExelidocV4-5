-- Run once in Supabase SQL Editor to enable email/password sign-in.
-- Existing users can set a password from an app where they are already signed in.

alter table users add column if not exists password_hash text;
