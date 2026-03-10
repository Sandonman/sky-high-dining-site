# Deploy Booking API (Render)

## 1) Create service
- In Render: **New +** → **Blueprint**
- Connect repo: `Sandonman/sky-high-dining-site`
- Render will detect `render.yaml`

## 2) Set env vars in Render
- `DATABASE_URL` = your Supabase Postgres URI
- `STRIPE_SECRET_KEY` = your Stripe secret key (or test key)
- `STRIPE_WEBHOOK_SECRET` = webhook secret (optional for now)
- `RESEND_API_KEY` = Resend API key (for booking/status emails)
- `EMAIL_FROM` = verified sender (or `onboarding@resend.dev` for test)
- `WEBSITE_BASE_URL` = public website URL (example: `https://sandonman.github.io/sky-high-dining-site`)

## 3) Deploy
- Click deploy and copy API URL (example: `https://sky-high-dining-api.onrender.com`)

## 4) Wire frontend
In `booking.html`, set before the script logic:

```html
<script>
  window.BOOKING_API_BASE = 'https://your-api-url.onrender.com';
</script>
```

(Place this above the existing booking script.)

## 5) Stripe webhook framework setup (when ready)
- In Stripe Dashboard → Developers → Webhooks, add endpoint:
  - `https://sky-high-dining-site.onrender.com/api/payment/webhook`
- Subscribe to events:
  - `checkout.session.completed`
  - `checkout.session.expired`
  - `payment_intent.payment_failed`
  - `charge.refunded`
- Copy signing secret (`whsec_...`) into Render as `STRIPE_WEBHOOK_SECRET`
- Redeploy service

## 6) Test
- Visit `/booking.html`
- Submit a request
- Approve in `/admin.html`
- Open terms link from approval email and complete Stripe checkout
- Confirm `reservations.payment_status` updates (`checkout_created` → `paid`)
