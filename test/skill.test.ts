import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';

import {
  MermailClient,
  SimulationBackend,
  type MermailClientOptions,
  parseInvoice,
  parseVerification,
  resolveConfig,
} from '../src/mermail-client.js';
import { HttpVendorConnector, ProvisioningAgent, SimulatedVendor, evaluateSpendPolicy, verifyVendor } from '../src/agent.js';
import { MermailSkill } from '../src/skill.js';
import { createRestServer, createRuntime } from '../src/index.js';
import {
  DEFAULT_SPEND_POLICY,
  type AgentIdentity,
  type EmailMessage,
  type MermailConfig,
  type ParsedInvoice,
  type TrustedVendor,
  asInboxId,
  asMessageId,
  asWalletAddress,
  formatAmount,
  money,
  parseAmount,
  parseMoney,
  unwrap,
} from '../src/types.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/** Controllable clock so timeout paths finish instantly and deterministically. */
function fakeClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

interface Harness {
  client: MermailClient;
  backend: SimulationBackend;
  config: MermailConfig;
}

function harness(overrides: Partial<MermailConfig> = {}, clientOptions: MermailClientOptions = {}): Harness {
  const config: MermailConfig = { ...resolveConfig({}), ...overrides };
  const backend = new SimulationBackend({ domain: config.domain, network: 'simulation', seed: 0xc0ffee });
  const clock = fakeClock();
  const client = new MermailClient(config, { backend, sleep: clock.sleep, now: clock.now, ...clientOptions });
  return { client, backend, config };
}

async function provision(h: Harness, label = 'test-suite'): Promise<AgentIdentity> {
  return unwrap(await h.client.createInbox({ label }));
}

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: asMessageId('msg_test'),
    inboxId: asInboxId('inb_test'),
    from: 'no-reply@vendor.example',
    to: 'agent_test@mermail.app',
    subject: 'Verify',
    text: 'Hello',
    attachments: [],
    receivedAt: '2026-09-01T10:00:00.000Z',
    read: false,
    headers: {},
    ...overrides,
  };
}

const TREASURY = asWalletAddress('AcmeAnaLyt1csTreasury1111111111111111111111');
const ATTACKER = asWalletAddress('AttackerWa11et11111111111111111111111111111');

function invoiceEmail(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return message({
    from: 'billing@acme-analytics.example',
    subject: 'Invoice INV-2026-0042 from Acme Analytics',
    text: ['Invoice: INV-2026-0042', 'Amount due: 5.000000 USDC', `Pay to: ${TREASURY}`, 'Due by: 2026-09-08'].join('\n'),
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */

describe('money', () => {
  it('round-trips decimal strings through base units', () => {
    assert.equal(unwrap(parseAmount('12.5', 'USDC')), 12_500_000n);
    assert.equal(formatAmount(12_500_000n, 'USDC'), '12.500000');
    assert.equal(formatAmount(1n, 'SOL'), '0.000000001');
    assert.equal(unwrap(parseMoney('0', 'USDC')).amount, '0.000000');
  });

  it('rejects more precision than the currency has', () => {
    const result = parseAmount('1.1234567', 'USDC');
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.message, /6 decimal places/);
  });

  it('rejects anything that is not a plain positive decimal', () => {
    for (const bad of ['', '-1', '1e6', 'abc', '1.2.3', ' 1,000 ']) {
      assert.equal(parseAmount(bad, 'USDC').ok, false, `${bad} should be rejected`);
    }
  });

  it('keeps precision that a float would lose', () => {
    const base = unwrap(parseAmount('0.100000', 'USDC')) + unwrap(parseAmount('0.200000', 'USDC'));
    assert.equal(formatAmount(base, 'USDC'), '0.300000');
  });
});

describe('config', () => {
  it('falls back to simulation when no API key is present', () => {
    const config = resolveConfig({});
    assert.equal(config.mode, 'simulation');
    assert.equal(config.network, 'simulation');
    assert.equal(config.defaultTtlSeconds, 86_400);
  });

  it('switches to live as soon as a key appears', () => {
    const config = resolveConfig({ MERMAIL_API_KEY: 'sk_test_placeholder' });
    assert.equal(config.mode, 'live');
    assert.equal(config.network, 'solana-mainnet');
  });

  it('lets MERMAIL_MODE force the simulator even with a key set', () => {
    assert.equal(resolveConfig({ MERMAIL_API_KEY: 'sk_test_placeholder', MERMAIL_MODE: 'simulation' }).mode, 'simulation');
  });

  it('reads spend limits, TTL and webhook from the environment', () => {
    const config = resolveConfig({
      MAP_MAX_PER_TX_USD: '3',
      MAP_MAX_TOTAL_USD: '9',
      MERMAIL_INBOX_TTL_SECONDS: '600',
      MERMAIL_WEBHOOK_URL: 'https://agent.example/hook',
    });
    assert.equal(config.policy.maxPerTransactionUsd, 3);
    assert.equal(config.policy.maxTotalUsd, 9);
    assert.equal(config.defaultTtlSeconds, 600);
    assert.equal(config.webhookUrl, 'https://agent.example/hook');
  });

  it('never puts the wallet signing key anywhere but its own field', () => {
    const config = resolveConfig({ AGENT_WALLET_KEY: 'wallet-key-placeholder' });
    assert.equal(config.agentWalletKey, 'wallet-key-placeholder');
    assert.equal(JSON.stringify(config.policy).includes('wallet-key-placeholder'), false);
  });
});

describe('inboxes', () => {
  it('mints an addressable mailbox and a wallet', async () => {
    const identity = await provision(harness(), 'Notion Trial');

    assert.match(identity.inbox.address, /^agent_notion_trial_[a-z0-9]{6}@mermail\.app$/);
    assert.equal(identity.inbox.status, 'active');
    assert.ok(identity.wallet.address.length > 30);
    assert.equal(identity.wallet.network, 'simulation');
  });

  it('honours an explicit prefix', async () => {
    const identity = unwrap(await harness().client.createInbox({ label: 'anything', prefix: 'ops-desk' }));
    assert.match(identity.inbox.address, /^agent_ops_desk_/);
  });

  it('sets an expiry from the TTL, or none when the TTL is zero', async () => {
    const h = harness();
    const temporary = unwrap(await h.client.createInbox({ label: 'short', ttlSeconds: 3_600 }));
    const permanent = unwrap(await h.client.createInbox({ label: 'forever', ttlSeconds: 0 }));

    assert.ok(temporary.inbox.expiresAt);
    assert.equal(temporary.inbox.ttlSeconds, 3_600);
    assert.equal(permanent.inbox.expiresAt, null);
  });

  it('stops accepting mail once expired', async () => {
    const h = harness();
    const identity = await provision(h);
    unwrap(await h.client.expireInbox(identity.id));

    const delivered = h.backend.deliver(identity.id, { from: 'x@y.example', to: 'a', subject: 's', text: 't', headers: {} });
    assert.equal(delivered.ok, false);
    assert.equal(delivered.ok ? null : delivered.error.code, 'inbox_expired');

    const sent = await h.client.sendEmail(identity.id, { to: 'x@y.example', subject: 's', text: 't' });
    assert.equal(sent.ok, false);
  });

  it('expires on its own once the TTL elapses', async () => {
    let clock = new Date('2026-09-01T00:00:00.000Z');
    const backend = new SimulationBackend({ seed: 7, now: () => clock });
    const client = new MermailClient(resolveConfig({}), { backend });

    const identity = unwrap(await client.createInbox({ label: 'ttl', ttlSeconds: 60 }));
    assert.equal(identity.inbox.status, 'active');

    clock = new Date('2026-09-01T00:02:00.000Z');
    assert.equal(unwrap(await client.getInbox(identity.id)).inbox.status, 'expired');
  });

  it('records webhook deliveries instead of making outbound calls', async () => {
    const h = harness();
    const identity = unwrap(await h.client.createInbox({ label: 'hooked', webhookUrl: 'https://agent.example/hook' }));
    unwrap(h.backend.deliver(identity.id, { from: 'x@y.example', to: 'a', subject: 's', text: 't', headers: {} }));

    const deliveries = h.backend.webhookDeliveriesOf(identity.id);
    // The welcome mail plus the one just injected.
    assert.equal(deliveries.length, 2);
    assert.equal(deliveries[0]?.url, 'https://agent.example/hook');
  });

  it('seeds the inbox so the first read is never a blank screen', async () => {
    const h = harness();
    const identity = await provision(h);
    const messages = unwrap(await h.client.fetchEmails(identity.id));

    assert.equal(messages.length, 1);
    assert.match(messages[0]?.from ?? '', /postmaster@/);
    assert.deepEqual(messages[0]?.attachments, []);
  });

  it('rejects an empty label', async () => {
    const result = await harness().client.createInbox({ label: '   ' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'invalid_request');
  });

  it('reports not_found for an unknown inbox instead of throwing', async () => {
    const result = await harness().client.getWallet(asInboxId('inb_missing'));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'not_found');
  });
});

describe('wallet', () => {
  it('refuses a payment the wallet cannot cover', async () => {
    const h = harness();
    const identity = await provision(h);
    const result = await h.client.sendPayment(identity.id, { to: TREASURY, amount: unwrap(parseMoney('5', 'USDC')), idempotencyKey: 'k1' });

    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'insufficient_funds');
  });

  it('funds, pays, and charges a fee', async () => {
    const h = harness();
    const identity = await provision(h);
    unwrap(await h.client.fundWallet(identity.id, unwrap(parseMoney('10', 'USDC'))));

    const receipt = unwrap(
      await h.client.sendPayment(identity.id, { to: TREASURY, amount: unwrap(parseMoney('4', 'USDC')), idempotencyKey: 'k2', reference: 'INV-1' }),
    );

    assert.equal(receipt.status, 'confirmed');
    assert.equal(receipt.amount.amount, '4.000000');
    assert.equal(receipt.reference, 'INV-1');
    assert.ok(receipt.txHash.length > 40);
    assert.equal(unwrap(await h.client.balanceOf(identity.id, 'USDC')).amount, '5.999000');
  });

  it('treats a repeated idempotency key as the same payment', async () => {
    const h = harness();
    const identity = await provision(h);
    unwrap(await h.client.fundWallet(identity.id, unwrap(parseMoney('10', 'USDC'))));

    const intent = { to: TREASURY, amount: unwrap(parseMoney('4', 'USDC')), idempotencyKey: 'retry-me' };
    const first = unwrap(await h.client.sendPayment(identity.id, intent));
    const second = unwrap(await h.client.sendPayment(identity.id, intent));

    assert.equal(first.txHash, second.txHash);
    assert.equal(unwrap(await h.client.balanceOf(identity.id, 'USDC')).amount, '5.999000');
  });
});

describe('verification parsing', () => {
  it('prefers an OTP that sits next to the word "code"', () => {
    const parsed = parseVerification(message({ text: 'Your verification code is 481920. It expires in 10 minutes.' }));
    assert.equal(parsed?.kind, 'otp');
    assert.equal(parsed?.otp, '481920');
    assert.equal(parsed?.activationLink, null);
    assert.ok((parsed?.confidence ?? 0) > 0.9);
  });

  it('reads the stated expiry window', () => {
    const parsed = parseVerification(message({ text: 'Your code is 481920. It expires in 10 minutes.' }));
    assert.equal(parsed?.expiresAt, '2026-09-01T10:10:00.000Z');
  });

  it('falls back to a bare six-digit line with lower confidence', () => {
    const parsed = parseVerification(message({ subject: 'Hello', text: 'Enter this:\n\n778812\n\nThanks' }));
    assert.equal(parsed?.otp, '778812');
    assert.ok((parsed?.confidence ?? 1) < 0.9);
  });

  it('picks the activation link over the unsubscribe link', () => {
    const parsed = parseVerification(
      message({
        subject: 'Confirm your account',
        text: 'Unsubscribe: https://vendor.example/unsubscribe\nConfirm: https://vendor.example/confirm?t=abc123',
      }),
    );
    assert.equal(parsed?.kind, 'link');
    assert.match(parsed?.activationLink ?? '', /\/confirm\?t=abc123$/);
  });

  it('returns nothing for an ordinary message', () => {
    assert.equal(parseVerification(message({ subject: 'Weekly digest', text: 'Nothing actionable here.' })), undefined);
  });

  it('does not mistake a year or a price for a code', () => {
    assert.equal(parseVerification(message({ subject: 'Receipt', text: 'Paid 24.99 USD on 2026-03-04. Thanks!' })), undefined);
  });
});

describe('invoice parsing', () => {
  it('reads id, amount, destination and due date', () => {
    const parsed = unwrap(parseInvoice(invoiceEmail()));
    assert.equal(parsed.invoiceId, 'INV-2026-0042');
    assert.equal(parsed.amount.amount, '5.000000');
    assert.equal(parsed.amount.currency, 'USDC');
    assert.equal(parsed.payTo, TREASURY);
    assert.equal(parsed.dueBy, '2026-09-08');
    assert.equal(parsed.senderDomain, 'acme-analytics.example');
    assert.equal(parsed.confidence, 1);
  });

  it('scores lower when the id and due date are missing', () => {
    const parsed = unwrap(parseInvoice(invoiceEmail({ subject: 'Payment request', text: `Amount due: 2 USDC\nPay to: ${TREASURY}` })));
    assert.ok(parsed.confidence < 0.9);
    assert.equal(parsed.dueBy, null);
  });

  it('fails rather than guessing when there is no amount', () => {
    const result = parseInvoice(invoiceEmail({ text: `Invoice: INV-1\nPay to: ${TREASURY}` }));
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'parse_failed');
  });

  it('fails when there is no destination wallet', () => {
    const result = parseInvoice(invoiceEmail({ text: 'Invoice: INV-1\nAmount due: 5 USDC' }));
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.message, /destination wallet/);
  });

  it('ignores an ordinary message', () => {
    assert.equal(parseInvoice(message({ text: 'Just checking in.' })).ok, false);
  });
});

describe('vendor verification', () => {
  const trusted: TrustedVendor[] = [{ name: 'Acme Analytics', senderDomain: 'acme-analytics.example', treasury: TREASURY }];
  const parsed = (overrides: Partial<ParsedInvoice> = {}): ParsedInvoice => ({
    ...unwrap(parseInvoice(invoiceEmail())),
    ...overrides,
  });

  it('accepts an invoice whose sender and treasury both match', () => {
    assert.equal(verifyVendor(parsed(), trusted).ok, true);
  });

  it('rejects an unknown sender domain', () => {
    const result = verifyVendor(parsed({ senderDomain: 'not-acme.example' }), trusted);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'untrusted_vendor');
  });

  it('rejects a spoofed invoice pointing at another wallet', () => {
    const result = verifyVendor(parsed({ payTo: ATTACKER }), trusted);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.error.message, /registered treasury/);
  });

  it('enforces the per-vendor invoice ceiling', () => {
    const capped: TrustedVendor[] = [{ ...(trusted[0] as TrustedVendor), maxPerInvoiceUsd: 1 }];
    const result = verifyVendor(parsed(), capped);
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'policy_violation');
  });
});

describe('waitForMessage', () => {
  it('returns the first message that matches', async () => {
    const h = harness();
    const identity = await provision(h);
    unwrap(h.backend.deliver(identity.id, { from: 'ops@vendor.example', to: 'a', subject: 'Code', text: 'code 909090', headers: {} }));

    const found = unwrap(await h.client.waitForMessage(identity.id, (m) => m.from.includes('vendor.example')));
    assert.equal(found.subject, 'Code');
  });

  it('times out without hanging when nothing arrives', async () => {
    const h = harness();
    const identity = await provision(h);

    const result = await h.client.waitForMessage(identity.id, () => false, { timeoutMs: 3_000, pollIntervalMs: 500 });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'timeout');
    assert.equal(result.ok ? null : result.error.retryable, true);
  });

  it('ignores mail that predates the "after" anchor', async () => {
    const h = harness();
    const identity = await provision(h);
    const anchor = new Date(Date.now() + 60_000).toISOString();

    const result = await h.client.waitForMessage(identity.id, () => true, { after: anchor, timeoutMs: 1_000, pollIntervalMs: 500 });
    assert.equal(result.ok, false);
  });
});

describe('spend policy', () => {
  it('allows a small payment inside every limit', () => {
    assert.equal(evaluateSpendPolicy(DEFAULT_SPEND_POLICY, { amount: money(2_000_000n, 'USDC'), recipient: TREASURY, spentUsd: 0 }).allowed, true);
  });

  it('blocks a single payment over the per-transaction cap', () => {
    const decision = evaluateSpendPolicy(DEFAULT_SPEND_POLICY, { amount: money(40_000_000n, 'USDC'), recipient: TREASURY, spentUsd: 0 });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed ? null : decision.code, 'policy_violation');
  });

  it('blocks the payment that would break the session total', () => {
    const decision = evaluateSpendPolicy(DEFAULT_SPEND_POLICY, { amount: money(20_000_000n, 'USDC'), recipient: TREASURY, spentUsd: 95 });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed ? '' : decision.reason, /session cap/);
  });

  it('asks for a human above the approval threshold', () => {
    const decision = evaluateSpendPolicy(DEFAULT_SPEND_POLICY, { amount: money(15_000_000n, 'USDC'), recipient: TREASURY, spentUsd: 0 });
    assert.equal(decision.allowed, false);
    assert.equal(decision.allowed ? null : decision.code, 'approval_required');
  });

  it('rejects a currency that is not on the list', () => {
    assert.equal(evaluateSpendPolicy(DEFAULT_SPEND_POLICY, { amount: money(1_000_000n, 'SOL'), recipient: TREASURY, spentUsd: 0 }).allowed, false);
  });

  it('honours a recipient allowlist', () => {
    const policy = { ...DEFAULT_SPEND_POLICY, allowedRecipients: [asWalletAddress('OnlyThisOne1111111111111111111111111111111')] };
    const decision = evaluateSpendPolicy(policy, { amount: money(1_000_000n, 'USDC'), recipient: TREASURY, spentUsd: 0 });
    assert.equal(decision.allowed, false);
    assert.match(decision.allowed ? '' : decision.reason, /allowlisted/);
  });
});

describe('use case 1: automated account registration', () => {
  it('goes from nothing to working credentials', async () => {
    const h = harness();
    const vendor = new SimulatedVendor(h.backend, { priceUsdc: '5.000000' });
    const agent = new ProvisioningAgent(h.client);

    const outcome = await agent.procure({ vendor, plan: 'starter', displayName: 'Test Buyer' });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
    if (!outcome.ok) return;

    assert.deepEqual(
      outcome.value.steps.map((s) => s.name),
      ['create_inbox', 'vendor_register', 'wait_for_otp', 'vendor_confirm', 'policy_check', 'payment', 'vendor_activate'],
    );
    assert.ok(outcome.value.steps.every((s) => s.status === 'ok'));
    assert.equal(outcome.value.receipt.status, 'confirmed');
    assert.equal(outcome.value.receipt.amount.amount, '5.000000');
    assert.equal(outcome.value.account.plan, 'starter');
    assert.ok(outcome.value.account.credentials['apiKey']);
    assert.equal(agent.spentUsd, 5);
  });

  it('stops at vendor_confirm when the vendor refuses the code', async () => {
    const h = harness();
    const agent = new ProvisioningAgent(h.client);
    const outcome = await agent.procure({ vendor: new SimulatedVendor(h.backend, { rejectVerification: true }), plan: 'starter' });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.code, 'vendor_rejected');
    const steps = outcome.error.steps ?? [];
    assert.equal(steps.at(-1)?.name, 'vendor_confirm');
    assert.equal(steps.filter((s) => s.name === 'payment').length, 0);
  });

  it('refuses an invoice above the caller budget before paying', async () => {
    const h = harness();
    const agent = new ProvisioningAgent(h.client);
    const outcome = await agent.procure({
      vendor: new SimulatedVendor(h.backend, { priceUsdc: '9.000000' }),
      plan: 'pro',
      budget: unwrap(parseMoney('3', 'USDC')),
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.code, 'policy_violation');
    assert.equal(agent.spentUsd, 0);
  });

  it('stops for approval when the invoice is large and no operator is wired up', async () => {
    const h = harness();
    const agent = new ProvisioningAgent(h.client);
    const outcome = await agent.procure({ vendor: new SimulatedVendor(h.backend, { priceUsdc: '18.000000' }), plan: 'enterprise' });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.code, 'approval_required');
    assert.equal((outcome.error.steps ?? []).at(-1)?.name, 'payment');
  });

  it('proceeds when the approval handler says yes', async () => {
    const h = harness();
    let asked = 0;
    const agent = new ProvisioningAgent(h.client, {
      onApprovalRequired: () => {
        asked += 1;
        return true;
      },
    });

    const outcome = await agent.procure({ vendor: new SimulatedVendor(h.backend, { priceUsdc: '18.000000' }), plan: 'enterprise' });
    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
    assert.equal(asked, 1);
  });

  it('reports every step through the onStep callback', async () => {
    const h = harness();
    const seen: string[] = [];
    const agent = new ProvisioningAgent(h.client, { onStep: (step) => seen.push(step.name) });
    await agent.procure({ vendor: new SimulatedVendor(h.backend), plan: 'starter' });
    assert.equal(seen.length, 7);
  });
});

describe('use case 2: autonomous subscription renewal', () => {
  it('settles an invoice from a trusted vendor', async () => {
    const h = harness();
    const vendor = new SimulatedVendor(h.backend, { priceUsdc: '5.000000' });
    const agent = new ProvisioningAgent(h.client);
    const identity = await provision(h, 'renewals');
    unwrap(vendor.issueRenewalInvoice(identity.id));

    const outcome = await agent.renewSubscription({
      inboxId: identity.id,
      trustedVendors: [vendor.asTrustedVendor(15)],
      timeoutMs: 5_000,
    });

    assert.equal(outcome.ok, true, outcome.ok ? '' : outcome.error.message);
    if (!outcome.ok) return;
    assert.deepEqual(
      outcome.value.steps.map((s) => s.name),
      ['await_invoice', 'parse_invoice', 'verify_vendor', 'policy_check', 'payment'],
    );
    assert.equal(outcome.value.receipt.amount.amount, '5.000000');
    assert.equal(outcome.value.receipt.to, vendor.treasury);
  });

  it('refuses an invoice that redirects payment to another wallet', async () => {
    const h = harness();
    const vendor = new SimulatedVendor(h.backend);
    const agent = new ProvisioningAgent(h.client);
    const identity = await provision(h, 'renewals');
    unwrap(vendor.issueRenewalInvoice(identity.id, { payTo: ATTACKER, invoiceId: 'INV-SPOOF' }));

    const outcome = await agent.renewSubscription({
      inboxId: identity.id,
      trustedVendors: [vendor.asTrustedVendor()],
      timeoutMs: 5_000,
    });

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error.code, 'untrusted_vendor');
    assert.equal((outcome.error.steps ?? []).at(-1)?.name, 'verify_vendor');
    assert.equal(agent.spentUsd, 0);
  });

  it('refuses an invoice from a domain nobody trusted', async () => {
    const h = harness();
    const vendor = new SimulatedVendor(h.backend);
    const agent = new ProvisioningAgent(h.client);
    const identity = await provision(h, 'renewals');
    unwrap(vendor.issueRenewalInvoice(identity.id));

    const outcome = await agent.renewSubscription({
      inboxId: identity.id,
      trustedVendors: [{ name: 'Someone Else', senderDomain: 'other.example', treasury: TREASURY }],
      timeoutMs: 5_000,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? null : outcome.error.code, 'untrusted_vendor');
  });

  it('will not settle the same invoice twice', async () => {
    const h = harness();
    const vendor = new SimulatedVendor(h.backend, { priceUsdc: '5.000000' });
    const agent = new ProvisioningAgent(h.client);
    const identity = await provision(h, 'renewals');
    unwrap(vendor.issueRenewalInvoice(identity.id, { invoiceId: 'INV-ONCE' }));

    const trustedVendors = [vendor.asTrustedVendor(15)];
    const first = await agent.renewSubscription({ inboxId: identity.id, trustedVendors, timeoutMs: 5_000 });
    assert.equal(first.ok, true);

    // The email is still sitting in the mailbox. A second run must not pay it.
    const second = await agent.renewSubscription({ inboxId: identity.id, trustedVendors, timeoutMs: 2_000 });
    assert.equal(second.ok, false);
    assert.equal(second.ok ? null : second.error.code, 'timeout');
    assert.deepEqual(agent.settledInvoiceIds, ['INV-ONCE']);
    assert.equal(agent.spentUsd, 5);
  });

  it('times out when no invoice ever arrives', async () => {
    const h = harness();
    const agent = new ProvisioningAgent(h.client);
    const identity = await provision(h, 'quiet');

    const outcome = await agent.renewSubscription({
      inboxId: identity.id,
      trustedVendors: [{ name: 'Acme', senderDomain: 'acme-analytics.example', treasury: TREASURY }],
      timeoutMs: 2_000,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.ok ? null : outcome.error.code, 'timeout');
  });
});

describe('skill surface', () => {
  it('publishes tools with MCP-shaped schemas', () => {
    const tools = new MermailSkill(harness().client).toMcpTools();

    assert.equal(tools.length, 12);
    for (const tool of tools) {
      assert.match(tool.name, /^mermail_[a-z_]+$/);
      assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema.type, 'object');
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });

  it('exposes the four tool names SPEC.md asks for', () => {
    const names = new Set(new MermailSkill(harness().client).toMcpTools().map((t) => t.name));
    for (const required of ['mermail_create_inbox', 'mermail_wait_for_otp', 'mermail_parse_invoice', 'mermail_pay_invoice']) {
      assert.ok(names.has(required), `${required} is missing`);
    }
  });

  it('registers the simulated vendor automatically in simulation mode', () => {
    assert.ok(new MermailSkill(harness().client).context.vendors.size > 0);
  });

  it('returns an error result for an unknown tool rather than throwing', async () => {
    const result = await new MermailSkill(harness().client).callTool('mermail_nope', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Unknown tool/);
  });

  it('rejects malformed arguments with a usable message', async () => {
    const skill = new MermailSkill(harness().client);

    const missing = await skill.callTool('mermail_create_inbox', {});
    assert.equal(missing.isError, true);
    assert.match(missing.content[0]?.text ?? '', /"label" is required/);

    assert.equal((await skill.callTool('mermail_create_inbox', 'label=x')).isError, true);

    const badAmount = await skill.callTool('mermail_wallet_fund', { inboxId: 'inb_x', amount: '1.1234567' });
    assert.equal(badAmount.isError, true);
    assert.match(badAmount.content[0]?.text ?? '', /decimal places/);
  });

  it('provisions, funds and reads a balance through tool calls only', async () => {
    const skill = new MermailSkill(harness().client);

    const provisioned = await skill.callTool('mermail_create_inbox', { label: 'tool-path', metadata: { owner: 'test' } });
    assert.equal(provisioned.isError, undefined);
    const identity = provisioned.structuredContent as AgentIdentity;

    assert.equal((await skill.callTool('mermail_wallet_fund', { inboxId: identity.id, amount: '7.5' })).isError, undefined);
    const balance = await skill.callTool('mermail_wallet_balance', { inboxId: identity.id });
    assert.match(balance.content[0]?.text ?? '', /7\.500000 USDC/);
  });

  it('parses an invoice out of the inbox without paying anything', async () => {
    const h = harness();
    const skill = new MermailSkill(h.client);
    const vendor = [...skill.context.vendors.values()][0] as SimulatedVendor;
    const identity = await provision(h, 'parse-path');
    unwrap(vendor.issueRenewalInvoice(identity.id));

    const parsed = await skill.callTool('mermail_parse_invoice', { inboxId: identity.id });
    assert.equal(parsed.isError, undefined);
    assert.match(parsed.content[0]?.text ?? '', /5\.000000 USDC/);
    assert.equal(unwrap(await h.client.balanceOf(identity.id, 'USDC')).amount, '0.000000');
  });

  it('will not pay a parsed invoice without a trusted-vendor list', async () => {
    const h = harness();
    const skill = new MermailSkill(h.client);
    const vendor = [...skill.context.vendors.values()][0] as SimulatedVendor;
    const identity = await provision(h, 'no-allowlist');
    unwrap(vendor.issueRenewalInvoice(identity.id));

    const messages = unwrap(await h.client.fetchEmails(identity.id, { limit: 5 }));
    const invoiceMessage = messages.find((m) => m.subject.startsWith('Invoice'));

    const result = await skill.callTool('mermail_pay_invoice', { inboxId: identity.id, messageId: invoiceMessage?.id });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /trustedVendors/);
  });

  it('pays an invoice supplied directly', async () => {
    const h = harness();
    const skill = new MermailSkill(h.client);
    const identity = await provision(h, 'direct-invoice');
    unwrap(await h.client.fundWallet(identity.id, unwrap(parseMoney('10', 'USDC'))));

    const result = await skill.callTool('mermail_pay_invoice', {
      inboxId: identity.id,
      invoice: { invoiceId: 'INV-DIRECT', vendor: 'Acme', amount: '3', payTo: TREASURY },
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.match(result.content[0]?.text ?? '', /Paid 3\.000000 USDC/);
  });

  it('runs the whole purchase from a single tool call', async () => {
    const skill = new MermailSkill(harness().client);
    const vendorName = [...skill.context.vendors.values()][0]?.name ?? '';

    const result = await skill.callTool('mermail_procure_subscription', { vendor: vendorName, plan: 'starter' });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.match(result.content[0]?.text ?? '', /account acct_/);
  });

  it('runs the renewal from a single tool call', async () => {
    const h = harness();
    const skill = new MermailSkill(h.client);
    const vendor = [...skill.context.vendors.values()][0] as SimulatedVendor;
    const identity = await provision(h, 'renew-tool');
    unwrap(vendor.issueRenewalInvoice(identity.id));

    const result = await skill.callTool('mermail_renew_subscription', {
      inboxId: identity.id,
      trustedVendors: [vendor.asTrustedVendor(15)],
      timeoutMs: 5_000,
    });
    assert.equal(result.isError, undefined, result.content[0]?.text);
    assert.match(result.content[0]?.text ?? '', /Settled INV-/);
  });

  it('rejects a trusted-vendor entry that is missing a treasury', async () => {
    const result = await new MermailSkill(harness().client).callTool('mermail_renew_subscription', {
      inboxId: 'inb_x',
      trustedVendors: [{ senderDomain: 'acme.example' }],
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /senderDomain and treasury/);
  });

  it('lists the registered vendors when asked for one that does not exist', async () => {
    const result = await new MermailSkill(harness().client).callTool('mermail_procure_subscription', { vendor: 'ghost', plan: 'x' });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /Registered:/);
  });

  it('applies the spend policy to direct transfers, not just invoices', async () => {
    const h = harness();
    const skill = new MermailSkill(h.client);
    const identity = unwrap(await h.client.createInbox({ label: 'direct' }));

    const result = await skill.callTool('mermail_wallet_pay', { inboxId: identity.id, to: TREASURY, amount: '999' });
    assert.equal(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /policy_violation/);
  });
});

describe('http vendor connector', () => {
  it('turns a non-2xx signup response into a vendor_rejected result', async () => {
    const connector = new HttpVendorConnector({
      name: 'Stub',
      baseUrl: 'https://vendor.invalid',
      fetchImpl: async () => new Response('nope', { status: 409 }),
    });

    const result = await connector.register({ email: 'agent_x@mermail.app' as never, plan: 'starter' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.code, 'vendor_rejected');
  });

  it('surfaces a transport failure as a retryable network error', async () => {
    const connector = new HttpVendorConnector({
      name: 'Stub',
      baseUrl: 'https://vendor.invalid',
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });

    const result = await connector.register({ email: 'agent_x@mermail.app' as never, plan: 'starter' });
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error.retryable, true);
  });
});

describe('rest server', () => {
  const server = createRestServer(createRuntime());
  after(() => server.close());

  async function start(): Promise<string> {
    if (!server.listening) await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async function postJson(base: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('reports health and mode', async () => {
    const body = (await (await fetch(`${await start()}/health`)).json()) as { status: string; mode: string };
    assert.equal(body.status, 'ok');
    assert.equal(body.mode, 'simulation');
  });

  it('serves the tool catalogue', async () => {
    const body = (await (await fetch(`${await start()}/tools`)).json()) as { tools: unknown[] };
    assert.equal(body.tools.length, 12);
  });

  it('creates an inbox and reads its messages', async () => {
    const base = await start();
    const created = await postJson(base, '/inboxes', { label: 'rest-path' });
    assert.equal(created.status, 201);
    const identity = ((await created.json()) as { structuredContent: AgentIdentity }).structuredContent;

    assert.equal((await fetch(`${base}/inboxes/${identity.id}/messages`)).status, 200);
  });

  it('accepts an inbound message on the webhook route', async () => {
    const base = await start();
    const created = await postJson(base, '/inboxes', { label: 'webhook-path' });
    const identity = ((await created.json()) as { structuredContent: AgentIdentity }).structuredContent;

    const hook = await postJson(base, '/webhooks/mermail', {
      inboxId: identity.id,
      from: 'billing@vendor.example',
      subject: 'Invoice INV-9 from Vendor',
      text: `Invoice: INV-9\nAmount due: 1 USDC\nPay to: ${TREASURY}`,
    });
    assert.equal(hook.status, 202);

    const parsed = await postJson(base, '/tools/mermail_parse_invoice', { inboxId: identity.id });
    assert.equal(parsed.status, 200);
    const body = (await parsed.json()) as { structuredContent: ParsedInvoice };
    assert.equal(body.structuredContent.invoiceId, 'INV-9');
  });

  it('rejects a webhook post with no inbox', async () => {
    assert.equal((await postJson(await start(), '/webhooks/mermail', { from: 'x@y.example' })).status, 400);
  });

  it('answers 400 on a bad tool call and 404 on an unknown route', async () => {
    const base = await start();
    assert.equal((await postJson(base, '/tools/mermail_create_inbox', {})).status, 400);
    assert.equal((await fetch(`${base}/nothing-here`)).status, 404);
  });
});
