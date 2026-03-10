create extension if not exists pgcrypto;

do $$ begin
  create type reservation_status as enum ('pending','pending_staff_approval','confirmed','cancelled','no_show','completed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type menu_tier as enum ('standard','premium');
exception when duplicate_object then null; end $$;

do $$ begin
  create type hold_status as enum ('active','expired','converted');
exception when duplicate_object then null; end $$;

create table if not exists reservations (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  customer_email text not null,
  customer_phone text not null,
  party_size int not null check (party_size between 2 and 12),
  experience_type text not null,
  reservation_start_at timestamptz not null,
  duration_minutes int not null default 90 check (duration_minutes = 90),
  buffer_minutes int not null default 90 check (buffer_minutes = 90),
  status reservation_status not null default 'pending',
  menu_tier menu_tier,
  entree_choice text,
  sides jsonb not null default '[]'::jsonb,
  extra_sides_count int not null default 0 check (extra_sides_count >= 0),
  deposit_amount_cents int not null default 10000,
  no_show_fee_cents int,
  stripe_payment_intent_id text,
  location_key text,
  location_name text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists reservation_holds (
  id uuid primary key default gen_random_uuid(),
  slot_start_at timestamptz not null,
  slot_end_at timestamptz not null,
  expires_at timestamptz not null,
  location_key text,
  status hold_status not null default 'active',
  reservation_id uuid references reservations(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table reservations add column if not exists admin_notes text;
alter table reservations add column if not exists status_updated_at timestamptz;
alter table reservations add column if not exists reservation_access_token text;
alter table reservations add column if not exists terms_accepted_at timestamptz;
alter table reservations add column if not exists terms_accepted_ip text;
alter table reservations add column if not exists terms_accepted_user_agent text;
alter table reservations add column if not exists location_key text;
alter table reservations add column if not exists location_name text;
alter table reservations add column if not exists stripe_checkout_session_id text;
alter table reservations add column if not exists payment_status text not null default 'unpaid';
alter table reservations add column if not exists payment_total_cents int;
alter table reservations add column if not exists paid_at timestamptz;
alter table reservations add column if not exists refunded_cents int;
alter table reservations add column if not exists refunded_at timestamptz;

create unique index if not exists idx_reservation_access_token on reservations(reservation_access_token);
create index if not exists idx_res_payment_status on reservations(payment_status);

alter table reservation_holds add column if not exists location_key text;

create table if not exists locations (
  key text primary key,
  name text not null,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into locations (key, name, description, active)
values (
  'serenade-assisted-living',
  'Serenade Assisted Living',
  'Farm-adjacent elevated dining with views of the San Tan Mountains and nearby animals.',
  true
)
on conflict (key) do update set name = excluded.name, description = excluded.description, active = true;

update reservations
set location_key = coalesce(location_key, 'serenade-assisted-living'),
    location_name = coalesce(location_name, 'Serenade Assisted Living')
where location_key is null or location_name is null;

update reservation_holds
set location_key = coalesce(location_key, 'serenade-assisted-living')
where location_key is null;

create index if not exists idx_res_start on reservations(reservation_start_at);
create index if not exists idx_res_status on reservations(status);
create index if not exists idx_res_location on reservations(location_key);
create index if not exists idx_holds_slot on reservation_holds(slot_start_at, slot_end_at);
create index if not exists idx_holds_location on reservation_holds(location_key);
