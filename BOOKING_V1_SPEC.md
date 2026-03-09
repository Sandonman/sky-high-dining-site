# Sky High Dining — Booking System v1 Spec

## 1) PostgreSQL Schema (minimum viable)

```sql
-- Optional extensions
create extension if not exists pgcrypto;

create type reservation_status as enum (
  'pending',
  'pending_staff_approval',
  'confirmed',
  'cancelled',
  'no_show',
  'completed'
);

create type menu_tier as enum ('standard', 'premium');

create type hold_status as enum ('active', 'expired', 'converted');

create table reservations (
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
  sides jsonb default '[]'::jsonb,
  extra_sides_count int not null default 0 check (extra_sides_count >= 0),

  deposit_amount_cents int not null default 10000,
  no_show_fee_cents int,

  stripe_payment_intent_id text,
  stripe_charge_id text,

  staff_override boolean not null default false,
  staff_override_reason text,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table reservation_holds (
  id uuid primary key default gen_random_uuid(),

  slot_start_at timestamptz not null,
  slot_end_at timestamptz not null,
  expires_at timestamptz not null,

  status hold_status not null default 'active',

  reservation_id uuid references reservations(id) on delete set null,

  created_at timestamptz not null default now()
);

create index idx_reservations_start on reservations(reservation_start_at);
create index idx_reservations_status on reservations(status);
create index idx_holds_slot on reservation_holds(slot_start_at, slot_end_at);
create index idx_holds_expires on reservation_holds(expires_at);

-- Helper view: blocked windows (90 min dining + 90 min prep buffer)
create view blocked_windows as
select
  id,
  reservation_start_at as block_start,
  reservation_start_at + interval '180 minutes' as block_end,
  status
from reservations
where status in ('pending', 'pending_staff_approval', 'confirmed')

union all

select
  id,
  slot_start_at as block_start,
  slot_end_at as block_end,
  status::text::reservation_status
from reservation_holds
where status = 'active' and expires_at > now();
```

---

## 2) Conflict Logic

For every requested start time:
- reservation duration: **90 min**
- prep/cleanup buffer: **90 min**
- blocked window used for conflict check: `[start, start + 180 min)`

Conflict query pattern:
```sql
-- overlap if new_start < existing_end and new_end > existing_start
select 1
from blocked_windows
where $1 < block_end
  and $2 > block_start
limit 1;
```

Use transaction + lock during hold creation to prevent race conditions.

---

## 3) API Contract (v1)

### `POST /api/availability/check`
Request:
```json
{
  "date": "2026-04-15",
  "experienceType": "dinner",
  "partySize": 4
}
```
Response:
```json
{
  "availableStartTimes": ["2026-04-15T17:00:00-07:00", "2026-04-15T20:00:00-07:00"]
}
```

### `POST /api/booking/hold`
Request:
```json
{
  "startAt": "2026-04-15T17:00:00-07:00",
  "experienceType": "dinner",
  "partySize": 4
}
```
Response:
```json
{
  "holdId": "uuid",
  "expiresAt": "2026-03-09T22:15:00Z"
}
```

### `POST /api/booking/submit`
Request:
```json
{
  "holdId": "uuid",
  "customer": {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "phone": "555-222-1111"
  },
  "menu": {
    "tier": "premium",
    "entreeChoice": "Filet Mignon Platter",
    "sides": ["Baked potato", "House salad", "Fresh-baked bread"],
    "extraSidesCount": 1
  },
  "notes": "Anniversary"
}
```
Response:
```json
{
  "reservationId": "uuid",
  "status": "pending"
}
```

> If `experienceType=custom`, status should be `pending_staff_approval`.

### `POST /api/payment/deposit/create`
Request:
```json
{ "reservationId": "uuid" }
```
Response:
```json
{
  "paymentIntentId": "pi_xxx",
  "clientSecret": "pi_xxx_secret_xxx",
  "amountCents": 10000
}
```

### `POST /api/payment/webhook` (Stripe)
Handle:
- `payment_intent.succeeded`
  - non-custom -> `confirmed`
  - custom -> stay `pending_staff_approval` until approved

### `POST /api/booking/staff/approve`
Request:
```json
{ "reservationId": "uuid", "approvedBy": "staff@skyhighdining.com" }
```
Response:
```json
{ "reservationId": "uuid", "status": "confirmed" }
```

### `POST /api/booking/cancel`
Request:
```json
{ "reservationId": "uuid", "reason": "Customer request" }
```
Response:
```json
{
  "status": "cancelled",
  "refundCents": 10000,
  "depositRetainedCents": 0
}
```

Refund rule:
- >48h before start: full refund including deposit
- <=48h before start: refund minus $100 deposit

---

## 4) No-show Rule (v1)

If marked no-show:
- retain deposit: 10000 cents
- charge fee: `2000 * party_size`
- refund any remaining prepaid amount after deductions

---

## 5) Booking States

- `pending`
- `pending_staff_approval` (custom bookings)
- `confirmed`
- `cancelled`
- `no_show`
- `completed`

---

## 6) Immediate Implementation Plan

1. Create DB tables + enums
2. Build `availability/check` and `booking/hold`
3. Connect booking form to hold + submit
4. Add Stripe deposit creation + webhook
5. Add simple staff approve/cancel endpoints
