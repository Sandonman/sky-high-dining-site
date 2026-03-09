import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { Pool } from 'pg';

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('supabase.co') ? { rejectUnauthorized: false } : undefined
});
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
        to,
        subject,
        html
      })
    });
  } catch (e) {
    console.error('Email send failed:', e.message);
  }
}

function formatReservationDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: 'America/Phoenix' });
  } catch {
    return iso;
  }
}

const PORT = process.env.PORT || 8787;
const HOLD_MINUTES = 10;
const DURATION_MINUTES = 90;
const BUFFER_MINUTES = 90;
const BLOCK_MINUTES = DURATION_MINUTES + BUFFER_MINUTES;

const isCustom = (experienceType = '') => experienceType.toLowerCase().includes('custom');

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/availability/check', async (req, res) => {
  // Placeholder: wire real window generation next.
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });
  return res.json({ availableStartTimes: [] });
});

app.post('/api/booking/hold', async (req, res) => {
  const { startAt } = req.body;
  if (!startAt) return res.status(400).json({ error: 'startAt is required' });

  const client = await pool.connect();
  try {
    await client.query('begin');

    const start = new Date(startAt);
    const end = new Date(start.getTime() + BLOCK_MINUTES * 60 * 1000);
    const expiresAt = new Date(Date.now() + HOLD_MINUTES * 60 * 1000);

    const conflict = await client.query(
      `select 1
       from (
         select reservation_start_at as block_start,
                reservation_start_at + interval '180 minutes' as block_end
         from reservations
         where status in ('pending','pending_staff_approval','confirmed')
         union all
         select slot_start_at as block_start, slot_end_at as block_end
         from reservation_holds
         where status='active' and expires_at > now()
       ) w
       where $1::timestamptz < w.block_end and $2::timestamptz > w.block_start
       limit 1`,
      [start.toISOString(), end.toISOString()]
    );

    if (conflict.rowCount > 0) {
      await client.query('rollback');
      return res.status(409).json({ error: 'Time slot unavailable' });
    }

    const hold = await client.query(
      `insert into reservation_holds (slot_start_at, slot_end_at, expires_at)
       values ($1,$2,$3)
       returning id, expires_at`,
      [start.toISOString(), end.toISOString(), expiresAt.toISOString()]
    );

    await client.query('commit');
    return res.json({ holdId: hold.rows[0].id, expiresAt: hold.rows[0].expires_at });
  } catch (e) {
    await client.query('rollback');
    return res.status(500).json({ error: 'Failed to create hold', detail: e.message });
  } finally {
    client.release();
  }
});

app.post('/api/booking/submit', async (req, res) => {
  const { holdId, customer, menu = {}, experienceType, partySize, startAt, notes } = req.body;
  if (!holdId || !customer?.name || !customer?.email || !customer?.phone || !startAt || !experienceType || !partySize) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const status = isCustom(experienceType) ? 'pending_staff_approval' : 'pending';

  const result = await pool.query(
    `insert into reservations (
      customer_name, customer_email, customer_phone, party_size, experience_type,
      reservation_start_at, status, menu_tier, entree_choice, sides, extra_sides_count, notes
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
    returning id, status`,
    [
      customer.name,
      customer.email,
      customer.phone,
      partySize,
      experienceType,
      new Date(startAt).toISOString(),
      status,
      menu.tier || null,
      menu.entreeChoice || null,
      JSON.stringify(menu.sides || []),
      menu.extraSidesCount || 0,
      notes || null
    ]
  );

  await pool.query(
    `update reservation_holds
     set reservation_id = $1, status='converted'
     where id = $2 and status='active'`,
    [result.rows[0].id, holdId]
  );

  const whenText = formatReservationDate(startAt);
  const statusText = result.rows[0].status === 'pending_staff_approval' ? 'pending staff approval' : 'pending';
  await sendEmail({
    to: customer.email,
    subject: 'Sky High Dining reservation received',
    html: `
      <p>Hi ${customer.name},</p>
      <p>We received your reservation request for <strong>${whenText}</strong>.</p>
      <p>Current status: <strong>${statusText}</strong>.</p>
      <p>Reservation ID: <code>${result.rows[0].id}</code></p>
      <p>We’ll email you again once this is approved or declined.</p>
    `
  });

  return res.json({ reservationId: result.rows[0].id, status: result.rows[0].status });
});

function requireAdmin(req, res) {
  const adminKey = process.env.ADMIN_API_KEY;
  const provided = req.header('x-admin-key');
  if (!adminKey || provided !== adminKey) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

app.get('/api/admin/reservations', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  try {
    const result = await pool.query(
      `select id, customer_name, customer_email, customer_phone, party_size, experience_type,
              reservation_start_at, status, created_at, notes, admin_notes, status_updated_at
       from reservations
       order by created_at desc
       limit 200`
    );
    return res.json({ reservations: result.rows });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load reservations', detail: e.message });
  }
});

app.post('/api/admin/reservations/:id/status', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;
  const { status, adminNotes } = req.body;
  const allowed = new Set(['pending', 'pending_staff_approval', 'confirmed', 'cancelled']);

  if (!status || !allowed.has(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  try {
    const result = await pool.query(
      `update reservations
       set status = $1,
           admin_notes = $2,
           status_updated_at = now()
       where id = $3
       returning id, status, admin_notes, status_updated_at, customer_name, customer_email, reservation_start_at`,
      [status, adminNotes || null, id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Reservation not found' });
    }

    const reservation = result.rows[0];
    const whenText = formatReservationDate(reservation.reservation_start_at);

    if (reservation.status === 'confirmed') {
      await sendEmail({
        to: reservation.customer_email,
        subject: 'Sky High Dining reservation approved',
        html: `
          <p>Hi ${reservation.customer_name},</p>
          <p>Great news — your reservation for <strong>${whenText}</strong> has been <strong>approved</strong>.</p>
          <p>Reservation ID: <code>${reservation.id}</code></p>
        `
      });
    } else if (reservation.status === 'cancelled') {
      await sendEmail({
        to: reservation.customer_email,
        subject: 'Sky High Dining reservation update',
        html: `
          <p>Hi ${reservation.customer_name},</p>
          <p>Your reservation request for <strong>${whenText}</strong> was not approved at this time.</p>
          <p>Reservation ID: <code>${reservation.id}</code></p>
        `
      });
    }

    return res.json({ ok: true, reservation });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update reservation', detail: e.message });
  }
});

app.delete('/api/admin/reservations/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;

  const { id } = req.params;

  try {
    const result = await pool.query(
      `delete from reservations
       where id = $1 and status = 'cancelled'
       returning id`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(400).json({ error: 'Only cancelled reservations can be cleared' });
    }

    return res.json({ ok: true, deletedId: result.rows[0].id });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to clear reservation', detail: e.message });
  }
});

app.post('/api/payment/deposit/create', async (req, res) => {
  const { reservationId } = req.body;
  if (!reservationId) return res.status(400).json({ error: 'reservationId is required' });
  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(400).json({ error: 'Stripe not configured yet' });
  }

  const paymentIntent = await stripe.paymentIntents.create({
    amount: 10000,
    currency: 'usd',
    metadata: { reservationId }
  });

  await pool.query(
    'update reservations set stripe_payment_intent_id=$1 where id=$2',
    [paymentIntent.id, reservationId]
  );

  return res.json({
    paymentIntentId: paymentIntent.id,
    clientSecret: paymentIntent.client_secret,
    amountCents: 10000
  });
});

app.listen(PORT, () => {
  console.log(`Sky High booking API running on :${PORT}`);
});
