create extension if not exists pgcrypto;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','refunded')),
  amount integer not null default 14900 check (amount = 14900),
  currency text not null default 'ARS' check (currency = 'ARS'),
  buyer_email text not null,
  mp_preference_id text,
  mp_payment_id text unique,
  guide_path text not null default '01_Guia_Profesional_Seguridad_Electronica_actualizada.pdf',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz
);

alter table public.orders enable row level security;
-- No policies are intentionally created. Browser clients cannot read or modify orders.
revoke all on public.orders from anon, authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('guias', 'guias', false, 15000000, array['application/pdf'])
on conflict (id) do update set public = false, file_size_limit = 15000000, allowed_mime_types = array['application/pdf'];
