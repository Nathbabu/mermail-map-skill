/**
 * Agent tool definitions (SPEC component 3).
 *
 * Twelve tools, shaped for the MCP `tools/list` and `tools/call` contract but
 * with no dependency on an MCP SDK, so the same definitions can be handed to a
 * plain function-calling loop (LangChain, Eliza, AutoGPT), an HTTP route, or
 * the CLI in this repo. The four names SPEC.md calls for are
 * `mermail_create_inbox`, `mermail_wait_for_otp`, `mermail_parse_invoice` and
 * `mermail_pay_invoice`; the rest fill in the gaps around them.
 *
 * Arguments arrive from a model, which means they arrive untrusted and often
 * malformed. Every handler validates before it touches the client, and returns
 * a structured error instead of throwing, because a thrown exception ends an
 * agent turn while an error result lets the model correct itself.
 */

import {
  type AgentIdentity,
  type Currency,
  type InboxId,
  type Invoice,
  MermailError,
  type MessageId,
  type Money,
  type ParsedInvoice,
  type Result,
  type TrustedVendor,
  type VendorConnector,
  asInboxId,
  asMessageId,
  asWalletAddress,
  isCurrency,
  parseMoney,
} from './types.js';
import { type MermailBackend, type MermailClient, parseInvoice, parseVerification } from './mermail-client.js';
import { ProvisioningAgent, SimulatedVendor, verifyVendor } from './agent.js';

/* -------------------------------------------------------------------------- */
/* Tool contract                                                              */
/* -------------------------------------------------------------------------- */

export interface JsonSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
}

export interface ToolContent {
  readonly type: 'text';
  readonly text: string;
}

export interface ToolCallResult {
  readonly content: readonly ToolContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

export interface SkillContext {
  readonly client: MermailClient;
  readonly agent: ProvisioningAgent;
  readonly vendors: Map<string, VendorConnector>;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  /** True for anything that spends money or creates state a human should see. */
  readonly destructive: boolean;
  handler(input: unknown, context: SkillContext): Promise<ToolCallResult>;
}

/* -------------------------------------------------------------------------- */
/* Argument reading                                                           */
/* -------------------------------------------------------------------------- */

class ArgumentError extends Error {}

class Args {
  readonly #raw: Record<string, unknown>;

  constructor(input: unknown) {
    if (input === undefined || input === null) {
      this.#raw = {};
    } else if (typeof input !== 'object' || Array.isArray(input)) {
      throw new ArgumentError('Arguments must be a JSON object');
    } else {
      this.#raw = input as Record<string, unknown>;
    }
  }

  has(key: string): boolean {
    return this.#raw[key] !== undefined && this.#raw[key] !== null;
  }

  string(key: string): string {
    const value = this.#raw[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ArgumentError(`"${key}" is required and must be a non-empty string`);
    }
    return value.trim();
  }

  optionalString(key: string): string | undefined {
    const value = this.#raw[key];
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string') throw new ArgumentError(`"${key}" must be a string`);
    return value.trim();
  }

  optionalNumber(key: string, min = 0): number | undefined {
    const value = this.#raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
      throw new ArgumentError(`"${key}" must be a number no smaller than ${min}`);
    }
    return value;
  }

  optionalBoolean(key: string): boolean | undefined {
    const value = this.#raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'boolean') throw new ArgumentError(`"${key}" must be a boolean`);
    return value;
  }

  optionalStringMap(key: string): Record<string, string> | undefined {
    const value = this.#raw[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) throw new ArgumentError(`"${key}" must be an object`);
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new ArgumentError(`"${key}.${k}" must be a string`);
      out[k] = v;
    }
    return out;
  }

  object(key: string): Args {
    const value = this.#raw[key];
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new ArgumentError(`"${key}" must be an object`);
    }
    return new Args(value);
  }

  inboxId(key = 'inboxId'): InboxId {
    return asInboxId(this.string(key));
  }

  optionalMessageId(key = 'messageId'): MessageId | undefined {
    const value = this.optionalString(key);
    return value === undefined ? undefined : asMessageId(value);
  }

  currency(key = 'currency', fallback: Currency = 'USDC'): Currency {
    const value = this.optionalString(key);
    if (value === undefined) return fallback;
    if (!isCurrency(value)) throw new ArgumentError(`"${key}" must be USDC or SOL`);
    return value;
  }

  money(amountKey: string, currencyKey = 'currency'): Money {
    const currency = this.currency(currencyKey);
    const parsed = parseMoney(this.string(amountKey), currency);
    if (!parsed.ok) throw new ArgumentError(parsed.error.message);
    return parsed.value;
  }

  /** Trusted-vendor entries, the allowlist that invoice payment checks against. */
  trustedVendors(key = 'trustedVendors'): readonly TrustedVendor[] {
    const value = this.#raw[key];
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new ArgumentError(`"${key}" must be an array`);

    return value.map((entry, index) => {
      const item = new Args(entry);
      const max = item.optionalNumber('maxPerInvoiceUsd');
      if (!item.has('senderDomain') || !item.has('treasury')) {
        throw new ArgumentError(`"${key}[${index}]" needs both senderDomain and treasury`);
      }
      return {
        name: item.optionalString('name') ?? item.string('senderDomain'),
        senderDomain: item.string('senderDomain'),
        treasury: asWalletAddress(item.string('treasury')),
        ...(max === undefined ? {} : { maxPerInvoiceUsd: max }),
      };
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Result shaping                                                             */
/* -------------------------------------------------------------------------- */

function textResult(summary: string, structured: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: summary }], structuredContent: structured };
}

function errorResult(error: unknown): ToolCallResult {
  const payload =
    error instanceof MermailError
      ? error.toJSON()
      : {
          code: error instanceof ArgumentError ? 'invalid_request' : 'upstream',
          message: String(error instanceof Error ? error.message : error),
          retryable: false,
        };
  return { content: [{ type: 'text', text: `${payload.code}: ${payload.message}` }], structuredContent: payload, isError: true };
}

async function guarded(work: () => Promise<ToolCallResult>): Promise<ToolCallResult> {
  try {
    return await work();
  } catch (error) {
    return errorResult(error);
  }
}

function unwrapOrThrow<T>(result: Result<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function summarise(identity: AgentIdentity): string {
  const balances = identity.wallet.balances.map((b) => `${b.amount} ${b.currency}`).join(', ') || 'empty';
  const ttl = identity.inbox.expiresAt ? ` | expires ${identity.inbox.expiresAt}` : ' | no expiry';
  return `${identity.inbox.address} [${identity.inbox.status}]${ttl} | wallet ${identity.wallet.address} on ${identity.wallet.network} | ${balances}`;
}

function stepTrace(steps: readonly { status: string; name: string; detail: string }[]): string {
  return steps.map((s) => `  ${s.status === 'ok' ? 'ok  ' : 'FAIL'} ${s.name}: ${s.detail}`).join('\n');
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                      */
/* -------------------------------------------------------------------------- */

const inboxIdProperty = { type: 'string', description: 'Inbox id returned by mermail_create_inbox' };

const trustedVendorsProperty = {
  type: 'array',
  description: 'Vendors allowed to be paid. An invoice is settled only when both the sender domain and the destination wallet match an entry.',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      senderDomain: { type: 'string', description: 'e.g. "acme-analytics.example"' },
      treasury: { type: 'string', description: "The vendor's registered wallet address" },
      maxPerInvoiceUsd: { type: 'number' },
    },
    required: ['senderDomain', 'treasury'],
  },
};

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: 'mermail_create_inbox',
    title: 'Provision a scoped inbox and wallet',
    description:
      'Mint a fresh agent_xyz@mermail.app address with its own USDC/SOL wallet, an optional TTL, and an optional webhook. Use one inbox per vendor so a leak or a spam wave stays contained.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        label: { type: 'string', description: 'What this inbox is for, e.g. "notion-trial". Becomes part of the address.' },
        prefix: { type: 'string', description: 'Override the address prefix. Defaults to a slug of the label.' },
        ttlSeconds: { type: 'number', description: 'Seconds before the address stops accepting mail. 0 means it never expires.' },
        webhookUrl: { type: 'string', description: 'Where inbound mail should be pushed, instead of polling.' },
        metadata: { type: 'object', description: 'Free-form string tags stored with the inbox.', additionalProperties: { type: 'string' } },
        fundUsdc: { type: 'string', description: 'Optional starting USDC balance as a decimal string. Simulation and devnet only.' },
      },
      required: ['label'],
      additionalProperties: false,
    },
    handler: (input, { client }) =>
      guarded(async () => {
        const args = new Args(input);
        const fundRaw = args.optionalString('fundUsdc');
        const prefix = args.optionalString('prefix');
        const webhookUrl = args.optionalString('webhookUrl');
        const ttlSeconds = args.optionalNumber('ttlSeconds');
        const metadata = args.optionalStringMap('metadata');

        const identity = unwrapOrThrow(
          await client.createInbox({
            label: args.string('label'),
            ...(prefix === undefined ? {} : { prefix }),
            ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
            ...(webhookUrl === undefined ? {} : { webhookUrl }),
            ...(metadata ? { metadata } : {}),
            ...(fundRaw === undefined ? {} : { fund: unwrapOrThrow(parseMoney(fundRaw, 'USDC')) }),
          }),
        );
        return textResult(summarise(identity), identity);
      }),
  },

  {
    name: 'mermail_list_inboxes',
    title: 'List provisioned inboxes',
    description: 'List every inbox this workspace has provisioned, with status, expiry, wallet address and balances.',
    destructive: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: (_input, { client }) =>
      guarded(async () => {
        const identities = unwrapOrThrow(await client.listInboxes());
        const summary = identities.length === 0 ? 'No inboxes yet.' : identities.map((i) => `${i.id}  ${summarise(i)}`).join('\n');
        return textResult(summary, identities);
      }),
  },

  {
    name: 'mermail_fetch_emails',
    title: 'Fetch messages',
    description: 'Read messages for an inbox, newest first, with optional sender, subject, unread and attachment filters.',
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        limit: { type: 'number', description: 'Maximum messages to return. Defaults to 10.' },
        unreadOnly: { type: 'boolean' },
        hasAttachments: { type: 'boolean' },
        fromContains: { type: 'string', description: 'Substring match against the sender address.' },
        subjectContains: { type: 'string' },
      },
      required: ['inboxId'],
      additionalProperties: false,
    },
    handler: (input, { client }) =>
      guarded(async () => {
        const args = new Args(input);
        const unreadOnly = args.optionalBoolean('unreadOnly');
        const hasAttachments = args.optionalBoolean('hasAttachments');
        const fromContains = args.optionalString('fromContains');
        const subjectContains = args.optionalString('subjectContains');

        const messages = unwrapOrThrow(
          await client.fetchEmails(args.inboxId(), {
            limit: args.optionalNumber('limit', 1) ?? 10,
            ...(unreadOnly === undefined ? {} : { unreadOnly }),
            ...(hasAttachments === undefined ? {} : { hasAttachments }),
            ...(fromContains === undefined ? {} : { fromContains }),
            ...(subjectContains === undefined ? {} : { subjectContains }),
          }),
        );
        const summary =
          messages.length === 0
            ? 'Inbox is empty for those filters.'
            : messages
                .map((m) => `${m.id} [${m.receivedAt}] ${m.from} - ${m.subject}${m.read ? '' : '  (unread)'}${m.attachments.length ? `  (${m.attachments.length} attachment)` : ''}`)
                .join('\n');
        return textResult(summary, messages);
      }),
  },

  {
    name: 'mermail_wait_for_otp',
    title: 'Wait for a verification code',
    description:
      'Block until a verification email arrives, then return the OTP or activation link with a confidence score and an expiry when the message states one. Anything below 0.6 confidence counts as no match.',
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        fromContains: { type: 'string', description: 'Restrict to a sender domain, e.g. "acme-analytics.example".' },
        timeoutMs: { type: 'number', description: 'How long to wait. Defaults to MAP_VERIFICATION_TIMEOUT_MS.' },
        minConfidence: { type: 'number', description: 'Extraction confidence floor between 0 and 1. Defaults to 0.6.' },
        after: { type: 'string', description: 'ISO timestamp. Older messages are ignored.' },
      },
      required: ['inboxId'],
      additionalProperties: false,
    },
    handler: (input, { client }) =>
      guarded(async () => {
        const args = new Args(input);
        const timeoutMs = args.optionalNumber('timeoutMs', 1);
        const minConfidence = args.optionalNumber('minConfidence', 0);
        const fromContains = args.optionalString('fromContains');
        const after = args.optionalString('after');

        const found = unwrapOrThrow(
          await client.waitForVerification(args.inboxId(), {
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(minConfidence === undefined ? {} : { minConfidence }),
            ...(fromContains === undefined ? {} : { fromContains }),
            ...(after === undefined ? {} : { after }),
          }),
        );
        const v = found.verification;
        return textResult(
          `${v.kind} "${v.value}" from ${found.message.from} (confidence ${v.confidence.toFixed(2)}${v.expiresAt ? `, expires ${v.expiresAt}` : ''})`,
          found,
        );
      }),
  },

  {
    name: 'mermail_parse_invoice',
    title: 'Parse an invoice out of an email',
    description:
      'Extract invoice id, amount, currency, destination wallet and due date from a billing email. Pass a messageId, or omit it to take the newest message in the inbox that parses as an invoice. This reads only; it never pays.',
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        messageId: { type: 'string', description: 'Specific message to parse. Omit to scan the inbox.' },
      },
      required: ['inboxId'],
      additionalProperties: false,
    },
    handler: (input, { client }) =>
      guarded(async () => {
        const args = new Args(input);
        const inboxId = args.inboxId();
        const messageId = args.optionalMessageId();

        const messages = unwrapOrThrow(await client.fetchEmails(inboxId, { limit: 50 }));
        const candidates = messageId ? messages.filter((m) => m.id === messageId) : messages;
        if (candidates.length === 0) {
          throw new MermailError('not_found', messageId ? `No message ${messageId} in ${inboxId}` : `Inbox ${inboxId} is empty`);
        }

        for (const candidate of candidates) {
          const parsed = parseInvoice(candidate);
          if (parsed.ok) {
            const invoice = parsed.value;
            return textResult(
              `${invoice.invoiceId}: ${invoice.amount.amount} ${invoice.amount.currency} to ${invoice.payTo}, from ${invoice.senderDomain}${invoice.dueBy ? `, due ${invoice.dueBy}` : ''} (confidence ${invoice.confidence.toFixed(2)})`,
              invoice,
            );
          }
        }
        throw new MermailError('parse_failed', messageId ? `Message ${messageId} does not look like an invoice` : 'No message in this inbox parses as an invoice');
      }),
  },

  {
    name: 'mermail_pay_invoice',
    title: 'Settle an invoice',
    description:
      'Pay an invoice, either parsed from a message or supplied directly. When a messageId is given, the sender domain and destination wallet must both match a trustedVendors entry before anything is signed. The spend policy applies on top of that.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        messageId: { type: 'string', description: 'Billing email to parse and pay. Requires trustedVendors.' },
        trustedVendors: trustedVendorsProperty,
        invoice: {
          type: 'object',
          description: 'An invoice handed over out of band, instead of messageId.',
          properties: {
            invoiceId: { type: 'string' },
            vendor: { type: 'string' },
            description: { type: 'string' },
            amount: { type: 'string', description: 'Decimal string.' },
            currency: { type: 'string', enum: ['USDC', 'SOL'] },
            payTo: { type: 'string' },
          },
          required: ['invoiceId', 'amount', 'payTo'],
        },
      },
      required: ['inboxId'],
      additionalProperties: false,
    },
    handler: (input, { client, agent }) =>
      guarded(async () => {
        const args = new Args(input);
        const inboxId = args.inboxId();
        const identity = unwrapOrThrow(await client.getInbox(inboxId));

        let invoice: Invoice;
        let parsed: ParsedInvoice | undefined;

        if (args.has('messageId')) {
          const messageId = args.optionalMessageId() as MessageId;
          const messages = unwrapOrThrow(await client.fetchEmails(inboxId, { limit: 50 }));
          const message = messages.find((m) => m.id === messageId);
          if (!message) throw new MermailError('not_found', `No message ${messageId} in ${inboxId}`);

          parsed = unwrapOrThrow(parseInvoice(message));
          const trusted = args.trustedVendors();
          if (trusted.length === 0) {
            throw new MermailError('untrusted_vendor', 'Paying a parsed invoice requires a trustedVendors list. Refusing to pay an address that came out of an email.');
          }
          unwrapOrThrow(verifyVendor(parsed, trusted));
          invoice = parsed;
        } else if (args.has('invoice')) {
          const raw = args.object('invoice');
          invoice = {
            invoiceId: raw.string('invoiceId'),
            vendor: raw.optionalString('vendor') ?? 'direct',
            description: raw.optionalString('description') ?? 'invoice',
            amount: raw.money('amount'),
            payTo: asWalletAddress(raw.string('payTo')),
            dueBy: null,
          };
        } else {
          throw new ArgumentError('Pass either "messageId" or "invoice"');
        }

        const receipt = unwrapOrThrow(await agent.payInvoice(identity, invoice));
        return textResult(
          `Paid ${receipt.amount.amount} ${receipt.amount.currency} for ${invoice.invoiceId} to ${receipt.to}. Tx ${receipt.txHash}`,
          { invoice, receipt, ...(parsed ? { parsed } : {}) },
        );
      }),
  },

  {
    name: 'mermail_send_email',
    title: 'Send email from an inbox',
    description: 'Send a plain-text message from an agent inbox, for replies and confirmation flows that need one.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        to: { type: 'string' },
        subject: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['inboxId', 'to', 'subject', 'text'],
      additionalProperties: false,
    },
    handler: (input, { client }) =>
      guarded(async () => {
        const args = new Args(input);
        const sent = unwrapOrThrow(
          await client.sendEmail(args.inboxId(), { to: args.string('to'), subject: args.string('subject'), text: args.string('text') }),
        );
        return textResult(`Queued ${sent.id} at ${sent.queuedAt}`, sent);
      }),
  },

  {
    name: 'mermail_wallet_balance',
    title: 'Read wallet balance',
    description: 'Return the wallet address, network and per-currency balances for an inbox.',
    destructive: false,
    inputSchema: { type: 'object', properties: { inboxId: inboxIdProperty }, required: ['inboxId'], additionalProperties: false },
    handler: (input, { client }) =>
      guarded(async () => {
        const wallet = unwrapOrThrow(await client.getWallet(new Args(input).inboxId()));
        const balances = wallet.balances.map((b) => `${b.amount} ${b.currency}`).join(', ') || 'empty';
        return textResult(`${wallet.address} (${wallet.network}): ${balances}`, wallet);
      }),
  },

  {
    name: 'mermail_wallet_fund',
    title: 'Fund a wallet from the faucet',
    description: 'Top up an inbox wallet. Works in simulation and on devnet; mainnet has no faucet and returns an error.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        amount: { type: 'string', description: 'Decimal string, e.g. "10.5".' },
        currency: { type: 'string', enum: ['USDC', 'SOL'], description: 'Defaults to USDC.' },
      },
      required: ['inboxId', 'amount'],
      additionalProperties: false,
    },
    handler: (input, { client }) =>
      guarded(async () => {
        const args = new Args(input);
        const wallet = unwrapOrThrow(await client.fundWallet(args.inboxId(), args.money('amount')));
        return textResult(`Funded. Balances: ${wallet.balances.map((b) => `${b.amount} ${b.currency}`).join(', ')}`, wallet);
      }),
  },

  {
    name: 'mermail_wallet_pay',
    title: 'Send a direct payment',
    description:
      'Transfer USDC or SOL from an inbox wallet with no invoice attached. The spend policy is checked first, so an amount above the configured cap is refused here rather than on chain.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        to: { type: 'string', description: 'Destination wallet address.' },
        amount: { type: 'string', description: 'Decimal string.' },
        currency: { type: 'string', enum: ['USDC', 'SOL'], description: 'Defaults to USDC.' },
        memo: { type: 'string' },
        idempotencyKey: { type: 'string', description: 'Reuse the same key when retrying a payment. Generated if omitted.' },
      },
      required: ['inboxId', 'to', 'amount'],
      additionalProperties: false,
    },
    handler: (input, { client, agent }) =>
      guarded(async () => {
        const args = new Args(input);
        const inboxId = args.inboxId();
        const identity = unwrapOrThrow(await client.getInbox(inboxId));

        // Route through the agent so ad-hoc payments obey the same policy as
        // invoices. The synthetic invoice is the cheapest way to say that.
        const receipt = unwrapOrThrow(
          await agent.payInvoice(identity, {
            invoiceId: args.optionalString('idempotencyKey') ?? `adhoc_${Date.now().toString(36)}`,
            vendor: 'direct-transfer',
            description: args.optionalString('memo') ?? 'direct transfer',
            amount: args.money('amount'),
            payTo: asWalletAddress(args.string('to')),
            dueBy: null,
          }),
        );
        return textResult(`Sent ${receipt.amount.amount} ${receipt.amount.currency} to ${receipt.to}. Tx ${receipt.txHash}`, receipt);
      }),
  },

  {
    name: 'mermail_procure_subscription',
    title: 'Register, verify and buy',
    description:
      'Use case 1 end to end: mint an inbox, sign up with a registered vendor, read the verification email, pay the invoice, return the credentials. Returns a per-step log whether it succeeds or fails.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Registered vendor name. Call with an unknown name to see the list.' },
        plan: { type: 'string', description: 'Plan identifier the vendor understands, e.g. "starter".' },
        budgetUsdc: { type: 'string', description: 'Refuse the invoice above this amount, on top of the global spend policy.' },
        displayName: { type: 'string' },
        label: { type: 'string', description: 'Override the generated inbox label.' },
        ttlSeconds: { type: 'number' },
        verificationTimeoutMs: { type: 'number' },
      },
      required: ['vendor', 'plan'],
      additionalProperties: false,
    },
    handler: (input, { agent, vendors }) =>
      guarded(async () => {
        const args = new Args(input);
        const vendorName = args.string('vendor');
        const vendor = vendors.get(vendorName) ?? vendors.get(vendorName.toLowerCase());
        if (!vendor) {
          throw new MermailError('not_found', `No vendor "${vendorName}". Registered: ${[...new Set(vendors.values())].map((v) => v.name).join(', ') || 'none'}`);
        }

        const budgetRaw = args.optionalString('budgetUsdc');
        const timeout = args.optionalNumber('verificationTimeoutMs', 1);
        const ttlSeconds = args.optionalNumber('ttlSeconds');
        const label = args.optionalString('label');
        const displayName = args.optionalString('displayName');

        const outcome = await agent.procure({
          vendor,
          plan: args.string('plan'),
          ...(budgetRaw === undefined ? {} : { budget: unwrapOrThrow(parseMoney(budgetRaw, 'USDC')) }),
          ...(label === undefined ? {} : { label }),
          ...(displayName === undefined ? {} : { displayName }),
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          ...(timeout === undefined ? {} : { verificationTimeoutMs: timeout }),
        });

        if (!outcome.ok) {
          return {
            content: [{ type: 'text', text: `Procurement failed at ${outcome.error.code}: ${outcome.error.message}\n${stepTrace(outcome.error.steps ?? [])}` }],
            structuredContent: { ...outcome.error.toJSON(), steps: outcome.error.steps ?? [] },
            isError: true,
          };
        }

        const { account, receipt, invoice, identity } = outcome.value;
        return textResult(
          [
            `${account.vendor} account ${account.accountId} is live on the ${account.plan} plan.`,
            `Mailbox: ${identity.inbox.address}`,
            `Paid ${receipt.amount.amount} ${receipt.amount.currency} for invoice ${invoice.invoiceId} (tx ${receipt.txHash.slice(0, 16)}...)`,
            `Credential keys: ${Object.keys(account.credentials).join(', ')}`,
          ].join('\n'),
          outcome.value,
        );
      }),
  },

  {
    name: 'mermail_renew_subscription',
    title: 'Watch for an invoice and settle it',
    description:
      'Use case 2 end to end: wait for a billing email in an existing inbox, parse it, check the sender and destination against trustedVendors, apply the spend policy, then pay. Returns a per-step log either way.',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        inboxId: inboxIdProperty,
        trustedVendors: trustedVendorsProperty,
        budgetUsdc: { type: 'string' },
        timeoutMs: { type: 'number' },
        after: { type: 'string', description: 'ISO timestamp. Invoices older than this are ignored.' },
      },
      required: ['inboxId', 'trustedVendors'],
      additionalProperties: false,
    },
    handler: (input, { agent }) =>
      guarded(async () => {
        const args = new Args(input);
        const trustedVendors = args.trustedVendors();
        if (trustedVendors.length === 0) throw new ArgumentError('"trustedVendors" must list at least one vendor');

        const budgetRaw = args.optionalString('budgetUsdc');
        const timeoutMs = args.optionalNumber('timeoutMs', 1);
        const after = args.optionalString('after');

        const outcome = await agent.renewSubscription({
          inboxId: args.inboxId(),
          trustedVendors,
          ...(budgetRaw === undefined ? {} : { budget: unwrapOrThrow(parseMoney(budgetRaw, 'USDC')) }),
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          ...(after === undefined ? {} : { after }),
        });

        if (!outcome.ok) {
          return {
            content: [{ type: 'text', text: `Renewal failed at ${outcome.error.code}: ${outcome.error.message}\n${stepTrace(outcome.error.steps ?? [])}` }],
            structuredContent: { ...outcome.error.toJSON(), steps: outcome.error.steps ?? [] },
            isError: true,
          };
        }

        const { invoice, vendor, receipt } = outcome.value;
        return textResult(
          `Settled ${invoice.invoiceId} from ${vendor.name}: ${receipt.amount.amount} ${receipt.amount.currency} to ${receipt.to}. Tx ${receipt.txHash.slice(0, 16)}...`,
          outcome.value,
        );
      }),
  },
];

/* -------------------------------------------------------------------------- */
/* Skill                                                                      */
/* -------------------------------------------------------------------------- */

export interface SkillOptions {
  readonly agent?: ProvisioningAgent;
  readonly vendors?: Iterable<VendorConnector>;
  /** Register the built-in simulated vendor. Defaults to true in simulation mode. */
  readonly includeSimulatedVendor?: boolean;
}

export class MermailSkill {
  static readonly version = '0.2.0';
  readonly context: SkillContext;

  constructor(client: MermailClient, options: SkillOptions = {}) {
    const vendors = new Map<string, VendorConnector>();
    for (const vendor of options.vendors ?? []) {
      vendors.set(vendor.name, vendor);
      vendors.set(vendor.name.toLowerCase(), vendor);
    }

    const wantsSimulated = options.includeSimulatedVendor ?? client.mode === 'simulation';
    if (wantsSimulated && vendors.size === 0) {
      const backend: MermailBackend = client.backend;
      // Only possible against the in-memory backend; live mode has no fake vendor.
      if ('deliver' in backend) {
        const vendor = new SimulatedVendor(backend);
        vendors.set(vendor.name, vendor);
        vendors.set(vendor.name.toLowerCase(), vendor);
      }
    }

    this.context = { client, agent: options.agent ?? new ProvisioningAgent(client), vendors };
  }

  registerVendor(vendor: VendorConnector): void {
    this.context.vendors.set(vendor.name, vendor);
    this.context.vendors.set(vendor.name.toLowerCase(), vendor);
  }

  listTools(): readonly ToolDefinition[] {
    return TOOLS;
  }

  /** Shape expected by an MCP `tools/list` response. */
  toMcpTools(): ReadonlyArray<{ name: string; title: string; description: string; inputSchema: JsonSchema }> {
    return TOOLS.map(({ name, title, description, inputSchema }) => ({ name, title, description, inputSchema }));
  }

  async callTool(name: string, input: unknown): Promise<ToolCallResult> {
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return errorResult(new MermailError('not_found', `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}`));
    }
    return tool.handler(input, this.context);
  }
}

export { parseVerification, parseInvoice };
