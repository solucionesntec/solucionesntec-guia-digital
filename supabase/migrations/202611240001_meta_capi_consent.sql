-- Meta Pixel + Conversions API tracking metadata.
-- Idempotent: safe to run even if the earlier tracking columns already exist.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS meta_fbp TEXT,
  ADD COLUMN IF NOT EXISTS meta_fbc TEXT,
  ADD COLUMN IF NOT EXISTS meta_client_ip_address TEXT,
  ADD COLUMN IF NOT EXISTS meta_client_user_agent TEXT,
  ADD COLUMN IF NOT EXISTS meta_event_source_url TEXT,
  ADD COLUMN IF NOT EXISTS meta_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meta_consent_version TEXT,
  ADD COLUMN IF NOT EXISTS meta_initiate_checkout_event_id TEXT,
  ADD COLUMN IF NOT EXISTS meta_initiate_checkout_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS meta_purchase_sent_at TIMESTAMPTZ;
