require("dotenv").config();

const crypto = require("node:crypto");
const express = require("express");
const helmet = require("helmet");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { pool } = require("./db");
const { publishNotification } = require("./notifications");

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(helmet());
app.use(express.json({ limit: "20kb" }));

// This starter intentionally uses demo customer IDs instead of real authentication.
// Replace this middleware with Amazon Cognito JWT verification before AWS deployment.
function demoCustomer(req, res, next) {
  const id = req.header("x-demo-customer-id");
  if (!id) {
    return res.status(401).json({
      error: "For local demo only, send x-demo-customer-id header. Add Cognito JWT verification before deployment."
    });
  }
  req.customerId = id;
  next();
}

const uuidSchema = z.string().uuid();
const amountSchema = z.number().positive().max(1000000).refine(
  (n) => Math.round(n * 100) === n * 100,
  "Amount must have at most two decimal places"
);

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "cloudbank-backend", database: "connected" });
  } catch {
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

// Creates repeatable fictional test users. Remove/disable this route in any shared deployment.
app.post("/dev/seed", async (_req, res, next) => {
  try {
    const customers = [
      { id: "11111111-1111-4111-8111-111111111111", name: "Asha Demo", email: "asha@example.test", accountId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", number: "1000000001", balance: "50000.00", pin: "1234" },
      { id: "22222222-2222-4222-8222-222222222222", name: "Ravi Demo", email: "ravi@example.test", accountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", number: "1000000002", balance: "15000.00", pin: "5678" }
    ];
    for (const c of customers) {
      const pinHash = await bcrypt.hash(c.pin, 12);
      await pool.query(
        `INSERT INTO customers (id, display_name, email, pin_hash)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, email=EXCLUDED.email, pin_hash=EXCLUDED.pin_hash`,
        [c.id, c.name, c.email, pinHash]
      );
      await pool.query(
        `INSERT INTO accounts (id, customer_id, account_number, currency, balance)
         VALUES ($1,$2,$3,'INR',$4)
         ON CONFLICT (id) DO UPDATE SET balance=EXCLUDED.balance`,
        [c.accountId, c.id, c.number, c.balance]
      );
      await pool.query(
        `INSERT INTO account_security (customer_id) VALUES ($1)
         ON CONFLICT (customer_id) DO NOTHING`,
        [c.id]
      );
    }
    res.json({
      message: "Fictional demo users seeded. Do not expose this route outside local development.",
      users: [
        { name: "Asha Demo", customerId: customers[0].id, accountNumber: "1000000001", pin: "1234" },
        { name: "Ravi Demo", customerId: customers[1].id, accountNumber: "1000000002", pin: "5678" }
      ]
    });
  } catch (err) { next(err); }
});

app.get("/api/balance", demoCustomer, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, account_number AS "accountNumber", currency, balance::text AS balance
       FROM accounts WHERE customer_id=$1 ORDER BY created_at LIMIT 1`,
      [req.customerId]
    );
    if (!result.rowCount) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

app.get("/api/transactions", demoCustomer, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT t.id, t.kind, t.amount::text AS amount, t.currency, t.description,
              t.created_at AS "createdAt",
              fa.account_number AS "fromAccount",
              ta.account_number AS "toAccount"
       FROM transactions t
       LEFT JOIN accounts fa ON fa.id=t.from_account_id
       LEFT JOIN accounts ta ON ta.id=t.to_account_id
       WHERE fa.customer_id=$1 OR ta.customer_id=$1
       ORDER BY t.created_at DESC LIMIT 100`,
      [req.customerId]
    );
    res.json({ transactions: result.rows });
  } catch (err) { next(err); }
});

app.post("/api/transfer", demoCustomer, async (req, res, next) => {
  const schema = z.object({
    recipientAccountNumber: z.string().min(6).max(30),
    amount: amountSchema,
    pin: z.string().regex(/^\\d{4,6}$/),
    idempotencyKey: z.string().uuid()
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid transfer details", details: parsed.error.issues });
  const { recipientAccountNumber, amount, pin, idempotencyKey } = parsed.data;
  const client = await pool.connect();
  let notificationEvent;

  try {
    await client.query("BEGIN");
    const existing = await client.query("SELECT id FROM transactions WHERE idempotency_key=$1", [idempotencyKey]);
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This transfer request was already processed", transactionId: existing.rows[0].id });
    }

    const senderResult = await client.query(
      `SELECT c.id AS customer_id, c.pin_hash, c.pin_failed_attempts, c.pin_locked_until,
              a.id AS account_id, a.account_number, a.balance::text AS balance
       FROM customers c JOIN accounts a ON a.customer_id=c.id
       WHERE c.id=$1 ORDER BY a.created_at LIMIT 1 FOR UPDATE OF c, a`,
      [req.customerId]
    );
    if (!senderResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sender account not found" });
    }
    const sender = senderResult.rows[0];
    if (sender.pin_locked_until && new Date(sender.pin_locked_until) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(423).json({ error: "PIN temporarily locked. Try again later." });
    }
    if (!(await bcrypt.compare(pin, sender.pin_hash))) {
      const attempts = Number(sender.pin_failed_attempts) + 1;
      const lockedUntil = attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null;
      await client.query(
        "UPDATE customers SET pin_failed_attempts=$2, pin_locked_until=$3 WHERE id=$1",
        [req.customerId, attempts, lockedUntil]
      );
      await client.query("COMMIT");
      return res.status(401).json({ error: "Incorrect PIN", remainingAttempts: Math.max(0, 5 - attempts) });
    }
    if (sender.account_number === recipientAccountNumber) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Cannot transfer to your own account" });
    }

    const recipientResult = await client.query(
      `SELECT id, customer_id, account_number, balance::text AS balance
       FROM accounts WHERE account_number=$1 FOR UPDATE`,
      [recipientAccountNumber]
    );
    if (!recipientResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Recipient account not found" });
    }
    const recipient = recipientResult.rows[0];
    if (Number(sender.balance) < amount) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Insufficient funds" });
    }

    await client.query("UPDATE accounts SET balance=balance-$2 WHERE id=$1", [sender.account_id, amount]);
    await client.query("UPDATE accounts SET balance=balance+$2 WHERE id=$1", [recipient.id, amount]);
    const transactionId = crypto.randomUUID();
    await client.query(
      `INSERT INTO transactions
       (id, from_account_id, to_account_id, amount, currency, kind, idempotency_key, description)
       VALUES ($1,$2,$3,$4,'INR','transfer',$5,$6)`,
      [transactionId, sender.account_id, recipient.id, amount, idempotencyKey, `Transfer to ${recipient.account_number}`]
    );
    await client.query("UPDATE customers SET pin_failed_attempts=0, pin_locked_until=NULL WHERE id=$1", [req.customerId]);
    await client.query("COMMIT");

    notificationEvent = {
      type: "transfer.completed",
      transactionId,
      fromAccount: sender.account_number,
      toAccount: recipient.account_number,
      amount: Number(amount),
      currency: "INR",
      occurredAt: new Date().toISOString()
    };
    try { await publishNotification(notificationEvent); }
    catch (e) {
      // Database transfer is committed; do not report the transfer as failed just because notification publishing failed.
      console.error("SQS notification publish failed:", e.message);
    }

    const balances = await pool.query(
      `SELECT account_number AS "accountNumber", balance::text AS balance
       FROM accounts WHERE id = ANY($1::uuid[])`,
      [[sender.account_id, recipient.id]]
    );
    res.status(201).json({ message: "Demo transfer completed", transactionId, balances: balances.rows });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    next(err);
  } finally {
    client.release();
  }
});

app.post("/api/pin/change", demoCustomer, async (req, res, next) => {
  const schema = z.object({
    currentPin: z.string().regex(/^\\d{4,6}$/),
    newPin: z.string().regex(/^\\d{4,6}$/)
  }).refine((d) => d.currentPin !== d.newPin, { message: "New PIN must differ from current PIN" });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid PIN details", details: parsed.error.issues });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      "SELECT id, pin_hash, pin_failed_attempts, pin_locked_until FROM customers WHERE id=$1 FOR UPDATE",
      [req.customerId]
    );
    if (!result.rowCount) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Customer not found" }); }
    const customer = result.rows[0];
    if (customer.pin_locked_until && new Date(customer.pin_locked_until) > new Date()) {
      await client.query("ROLLBACK");
      return res.status(423).json({ error: "PIN temporarily locked. Try again later." });
    }
    if (!(await bcrypt.compare(parsed.data.currentPin, customer.pin_hash))) {
      const attempts = Number(customer.pin_failed_attempts) + 1;
      await client.query(
        "UPDATE customers SET pin_failed_attempts=$2, pin_locked_until=$3 WHERE id=$1",
        [req.customerId, attempts, attempts >= 5 ? new Date(Date.now() + 15 * 60 * 1000) : null]
      );
      await client.query("COMMIT");
      return res.status(401).json({ error: "Current PIN is incorrect" });
    }
    const newHash = await bcrypt.hash(parsed.data.newPin, 12);
    await client.query(
      "UPDATE customers SET pin_hash=$2, pin_failed_attempts=0, pin_locked_until=NULL WHERE id=$1",
      [req.customerId, newHash]
    );
    await client.query(
      "INSERT INTO account_security (customer_id, pin_changed_at) VALUES ($1,NOW()) ON CONFLICT (customer_id) DO UPDATE SET pin_changed_at=NOW()",
      [req.customerId]
    );
    await client.query("COMMIT");
    res.json({ message: "PIN changed successfully" });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    next(err);
  } finally { client.release(); }
});

app.post("/api/loans", demoCustomer, async (req, res, next) => {
  const parsed = z.object({
    amount: amountSchema,
    purpose: z.string().trim().min(3).max(200)
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid loan application", details: parsed.error.issues });
  try {
    const account = await pool.query("SELECT id FROM accounts WHERE customer_id=$1 ORDER BY created_at LIMIT 1", [req.customerId]);
    if (!account.rowCount) return res.status(404).json({ error: "Account not found" });
    const loanId = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO loans (id, customer_id, account_id, amount, purpose)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, amount::text AS amount, purpose, status, created_at AS "createdAt"`,
      [loanId, req.customerId, account.rows[0].id, parsed.data.amount, parsed.data.purpose]
    );
    res.status(201).json({ loan: result.rows[0] });
  } catch (err) { next(err); }
});

app.get("/api/loans", demoCustomer, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, amount::text AS amount, purpose, status, created_at AS "createdAt"
       FROM loans WHERE customer_id=$1 ORDER BY created_at DESC`,
      [req.customerId]
    );
    res.json({ loans: result.rows });
  } catch (err) { next(err); }
});

app.use((req, res) => res.status(404).json({ error: "Route not found" }));
app.use((err, _req, res, _next) => {
  console.error(err.stack || err.message);
  res.status(500).json({ error: "Internal server error" });
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`CloudBank backend listening on port ${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
