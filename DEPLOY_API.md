# Deploy Booking API (Render)

## 1) Create service
- In Render: **New +** → **Blueprint**
- Connect repo: `Sandonman/sky-high-dining-site`
- Render will detect `render.yaml`

## 2) Set env vars in Render
- `DATABASE_URL` = your Supabase Postgres URI
- `STRIPE_SECRET_KEY` = your Stripe secret key (or test key)
- `STRIPE_WEBHOOK_SECRET` = webhook secret (optional for now)

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

## 5) Test
- Visit `/booking.html`
- Submit a request
- Confirm rows in Supabase tables: `reservation_holds`, `reservations`
