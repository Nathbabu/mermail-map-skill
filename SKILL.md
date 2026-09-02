---
name: mermail-procurement
description: Autonomous procurement and account provisioning skill for AI agents using Mermail. Enables disposable email identities, OTP verification extraction, invoice parsing, and USDC/SOL wallet micro-payments.
---

# Mermail Autonomous Procurement & Account Provisioner (MAP-Skill)

Equips autonomous agents with programmable email inboxes and payment-capable wallets via the Mermail infrastructure.

---

## 1. What the Skill Enables

- **Scoped Email Identities**: Provision disposable addresses (`agent_<label>_<suffix>@mermail.app`) with configurable TTL and webhooks so external communications stay isolated per vendor.
- **Verification Automation**: Listen for inbound emails, extract one-time passwords (OTPs) and activation links with confidence scoring, and filter out spam or non-verification links.
- **Invoice Parsing**: Automatically identify invoice IDs, due dates, billing amounts, and recipient wallet addresses from email text.
- **Autonomous Settlement**: Settle USDC or SOL payments directly from an agent's embedded wallet.
- **Hard Guardrails**: Enforce domain validation, recipient treasury allowlists, per-transaction caps, session spend limits, and human-in-the-loop approval thresholds before signing.

---

## 2. How It Interacts with Mermail

MAP-Skill connects to Mermail through the `MermailClient` interface, supporting two runtime modes:

1. **Live API (`HttpBackend`)**:
   - Authenticates via `MERMAIL_API_KEY`.
   - Provisions real inboxes on `mermail.app`.
   - Receives inbound emails via webhooks or polling (`GET /v1/inboxes/:id/messages`).
   - Dispatches on-chain transactions across `solana-mainnet` or `solana-devnet`.

2. **Simulation Mode (`SimulationBackend`)**:
   - Automatically active when `MERMAIL_API_KEY` is omitted, or when `MERMAIL_MODE=simulation`.
   - Runs an in-memory ledger, message store, and vendor simulator for testing without live tokens.

---

## 3. Workflows

### Workflow 1: Automated Account Registration & Procurement

```
[Agent] ──(1. mermail_create_inbox)──► [Mermail: agent_xyz@mermail.app + wallet]
   │
   ├──(2. Submit signup to Vendor with agent email)
   │
   ├──(3. mermail_wait_for_otp)──────► [Extracts OTP / verification link]
   │
   ├──(4. Confirm with Vendor)───────► [Vendor issues invoice]
   │
   ├──(5. Spend policy check)────────► [Verify amount <= budget & policy caps]
   │
   └──(6. mermail_pay_invoice)───────► [Settle on-chain & receive credentials]
```

### Workflow 2: Autonomous Subscription Renewal

```
[Inbound billing email arrives]
   │
   ├──(1. mermail_parse_invoice)─────► [Extracts invoice ID, amount, wallet]
   │
   ├──(2. Verify vendor)─────────────► [Check sender domain & treasury match trusted list]
   │
   ├──(3. Check spend policy)────────► [Ensure within per-tx and total session limits]
   │
   └──(4. mermail_pay_invoice)───────► [Sign and dispatch transaction]
```

---

## 4. Example Prompts & Expected Results

### Example 1: Register and Buy a Subscription

**User Prompt**:
> "Register an account for Acme Analytics on the starter plan with a maximum budget of 10 USDC."

**Agent Action (Tool Call)**:
```json
{
  "tool": "mermail_procure_subscription",
  "arguments": {
    "vendor": "Acme Analytics",
    "plan": "starter",
    "budgetUsdc": "10.0"
  }
}
```

**Expected Result**:
```json
{
  "status": "success",
  "account": {
    "accountId": "acct_100001",
    "email": "agent_acme_analytics_starter_naewaw@mermail.app",
    "plan": "starter",
    "apiKey": "acme_live_sk_89f0a7b1c3d5e2a8",
    "dashboard": "https://acme-analytics.example/dashboard"
  },
  "settlement": {
    "invoiceId": "INV-100001",
    "amount": "5.000000",
    "currency": "USDC",
    "txHash": "EDnYgntgHRXYJf89kmGxeSgymyEm8x3d"
  }
}
```

---

### Example 2: Check Inbox and Extract Verification Code

**User Prompt**:
> "Check if the verification email has arrived for inbox `inb_a1b2c3d4` from sender `auth.service.com`."

**Agent Action (Tool Call)**:
```json
{
  "tool": "mermail_wait_for_otp",
  "arguments": {
    "inboxId": "inb_a1b2c3d4",
    "fromContains": "auth.service.com",
    "timeoutMs": 15000,
    "minConfidence": 0.8
  }
}
```

**Expected Result**:
```json
{
  "matched": true,
  "otp": "749201",
  "confidence": 0.95,
  "expiresAt": "2026-09-02T06:00:00.000Z",
  "messageId": "msg_908123"
}
```

---

### Example 3: Pay an Approved Invoice

**User Prompt**:
> "Pay invoice INV-204 from Acme Analytics for 5 USDC to `AcmeAnaLyt1csTreasury...` from inbox `inb_a1b2c3d4`."

**Agent Action (Tool Call)**:
```json
{
  "tool": "mermail_pay_invoice",
  "arguments": {
    "inboxId": "inb_a1b2c3d4",
    "invoice": {
      "invoiceId": "INV-204",
      "vendor": "Acme Analytics",
      "amount": "5.0",
      "currency": "USDC",
      "payTo": "AcmeAnaLyt1csTreasury11111111111111111111111"
    }
  }
}
```

**Expected Result**:
```json
{
  "success": true,
  "invoiceId": "INV-204",
  "status": "settled",
  "txHash": "kmGxeSgymyEm8x3dEDnYgntgHRXYJf89",
  "remainingBalance": "15.000000 USDC"
}
```

---

## 5. Tool Catalog

| Tool Name | Purpose |
| :--- | :--- |
| `mermail_create_inbox` | Provision an inbox with address, TTL, webhook, and Solana wallet. |
| `mermail_list_inboxes` | List all active inboxes with balance and expiration metadata. |
| `mermail_fetch_emails` | Fetch messages with unread, sender, and attachment filters. |
| `mermail_wait_for_otp` | Wait for verification email and extract OTP/link with confidence scoring. |
| `mermail_parse_invoice` | Extract amount, due date, invoice ID, and destination wallet from emails. |
| `mermail_pay_invoice` | Settle parsed or supplied invoice against trusted vendor rules and spend limits. |
| `mermail_send_email` | Send outgoing plain-text email for verification replies or support. |
| `mermail_wallet_balance`| Query current USDC and SOL balances for an inbox wallet. |
| `mermail_wallet_fund` | Request devnet/simulation faucet funding. |
| `mermail_wallet_pay` | Send direct payment subject to spend policy limits. |
| `mermail_procure_subscription` | Full end-to-end signup, OTP confirmation, and settlement flow. |
| `mermail_renew_subscription` | Full subscription invoice parsing, vendor verification, and renewal flow. |

---

## 6. Safety & Guardrails

1. **Vendor Allowlist**: Checks sender domain against registered treasury public keys to block spoofed billing emails.
2. **Deterministic Spend Caps**:
   - `MAP_MAX_PER_TX_USD`: Maximum allowed single payment (default: $25).
   - `MAP_MAX_TOTAL_USD`: Maximum session spend limit (default: $100).
   - `MAP_REQUIRE_APPROVAL_ABOVE_USD`: Triggers operator confirmation (default: $10).
3. **Idempotency**: Prevents double-spending on retried network requests.
