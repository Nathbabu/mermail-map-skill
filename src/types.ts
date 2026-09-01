/**
 * Domain model for MAP-Skill.
 *
 * Names follow SPEC.md: MermailInbox, EmailMessage, ParsedVerification and
 * PaymentIntent are the four core interfaces, with the rest built around them.
 *
 * Two conventions worth knowing before reading the rest of the codebase:
 *
 * 1. Money never touches a JS number. Amounts travel as decimal strings at the
 *    API boundary and as bigint base units internally. USDC has 6 decimals and
 *    a float round-trip loses cents at surprisingly small balances.
 * 2. Fallible operations return `Result` instead of throwing. Provisioning an
 *    inbox and paying an invoice both fail for boring, expected reasons (rate
 *    limits, insufficient funds, a vendor saying no), and an agent loop handles
 *    those better as values than as exceptions.
 */

/** Nominal typing so an inbox id can't be passed where a wallet address goes. */
declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type InboxId = Brand<string, 'InboxId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type WalletAddress = Brand<string, 'WalletAddress'>;
export type TxHash = Brand<string, 'TxHash'>;
export type EmailAddress = Brand<string, 'EmailAddress'>;

export const asInboxId = (v: string): InboxId => v as InboxId;
export const asMessageId = (v: string): MessageId => v as MessageId;
export const asWalletAddress = (v: string): WalletAddress => v as WalletAddress;
export const asTxHash = (v: string): TxHash => v as TxHash;
export const asEmailAddress = (v: string): EmailAddress => v as EmailAddress;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export type MermailErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'network'
  | 'timeout'
  | 'inbox_expired'
  | 'insufficient_funds'
  | 'policy_violation'
  | 'approval_required'
  | 'untrusted_vendor'
  | 'vendor_rejected'
  | 'parse_failed'
  | 'unsupported'
  | 'upstream';

export interface MermailErrorOptions {
  readonly retryable?: boolean;
  readonly status?: number;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class MermailError extends Error {
  readonly code: MermailErrorCode;
  readonly retryable: boolean;
  readonly status: number | undefined;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(code: MermailErrorCode, message: string, options: MermailErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'MermailError';
    this.code = code;
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE.has(code);
    this.status = options.status;
    this.details = options.details;
  }

  toJSON(): { code: MermailErrorCode; message: string; retryable: boolean; details?: Record<string, unknown> } {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: { ...this.details } } : {}),
    };
  }
}

const DEFAULT_RETRYABLE: ReadonlySet<MermailErrorCode> = new Set<MermailErrorCode>([
  'rate_limited',
  'network',
  'timeout',
  'upstream',
]);

/* -------------------------------------------------------------------------- */
/* Result                                                                     */
/* -------------------------------------------------------------------------- */

export type Result<T, E = MermailError> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export function fail(code: MermailErrorCode, message: string, options?: MermailErrorOptions): Result<never> {
  return err(new MermailError(code, message, options));
}

/** Throws on the error branch. Only for call sites that genuinely cannot continue. */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

export type Currency = 'USDC' | 'SOL';

export const CURRENCY_DECIMALS: Readonly<Record<Currency, number>> = { USDC: 6, SOL: 9 };

/** Rough USD reference used for spend-policy checks only, never for settlement. */
export const USD_REFERENCE_RATE: Readonly<Record<Currency, number>> = { USDC: 1, SOL: 150 };

export function isCurrency(value: unknown): value is Currency {
  return value === 'USDC' || value === 'SOL';
}

export interface Money {
  readonly currency: Currency;
  /** Human-facing decimal string, e.g. "12.500000". */
  readonly amount: string;
  /** Base units as a decimal string, so the value survives JSON. */
  readonly base: string;
}

const AMOUNT_PATTERN = /^\d{1,18}(\.\d{1,9})?$/;

/**
 * Converts a decimal string to base units. Rejects rather than rounds when the
 * caller passes more precision than the currency has: silently dropping a
 * fraction of a cent is the kind of bug that only shows up in reconciliation.
 */
export function parseAmount(amount: string, currency: Currency): Result<bigint> {
  const trimmed = amount.trim();
  if (!AMOUNT_PATTERN.test(trimmed)) {
    return fail('invalid_request', `"${amount}" is not a valid ${currency} amount`);
  }
  const decimals = CURRENCY_DECIMALS[currency];
  const [whole = '0', fraction = ''] = trimmed.split('.');
  if (fraction.length > decimals) {
    return fail('invalid_request', `${currency} supports ${decimals} decimal places, got ${fraction.length}`);
  }
  return ok(BigInt(whole + fraction.padEnd(decimals, '0')));
}

export function formatAmount(base: bigint, currency: Currency): string {
  const decimals = CURRENCY_DECIMALS[currency];
  const negative = base < 0n;
  const digits = (negative ? -base : base).toString().padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

export function money(base: bigint, currency: Currency): Money {
  return { currency, amount: formatAmount(base, currency), base: base.toString() };
}

export function parseMoney(amount: string, currency: Currency): Result<Money> {
  const parsed = parseAmount(amount, currency);
  return parsed.ok ? ok(money(parsed.value, currency)) : parsed;
}

export function moneyToBase(value: Money): bigint {
  return BigInt(value.base);
}

export function approxUsd(value: Money): number {
  const base = Number(moneyToBase(value)) / 10 ** CURRENCY_DECIMALS[value.currency];
  return base * USD_REFERENCE_RATE[value.currency];
}

/* -------------------------------------------------------------------------- */
/* Inboxes, wallets, identities                                               */
/* -------------------------------------------------------------------------- */

export type Network = 'solana-mainnet' | 'solana-devnet' | 'simulation';

export type InboxStatus = 'active' | 'expired' | 'suspended';

/** SPEC component 1: address, TTL, webhook URL, status. */
export interface MermailInbox {
  readonly id: InboxId;
  readonly address: EmailAddress;
  /** Seconds until the address stops accepting mail. 0 means it never expires. */
  readonly ttlSeconds: number;
  readonly expiresAt: string | null;
  readonly webhookUrl: string | null;
  readonly status: InboxStatus;
  readonly createdAt: string;
}

export interface AgentWallet {
  readonly address: WalletAddress;
  readonly network: Network;
  readonly balances: readonly Money[];
}

/** An inbox and the wallet that shares its scope. One per vendor, by convention. */
export interface AgentIdentity {
  readonly id: InboxId;
  readonly label: string;
  readonly inbox: MermailInbox;
  readonly wallet: AgentWallet;
  readonly createdAt: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export const inboxAddress = (identity: AgentIdentity): EmailAddress => identity.inbox.address;

export interface CreateInboxInput {
  /** Free-text purpose, e.g. "notion-trial". Becomes part of the address slug. */
  readonly label: string;
  /** Optional explicit prefix. Defaults to a slug of the label. */
  readonly prefix?: string;
  readonly ttlSeconds?: number;
  readonly webhookUrl?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Pre-fund the wallet at creation. Simulation and devnet only. */
  readonly fund?: Money;
}

/* -------------------------------------------------------------------------- */
/* Mail                                                                       */
/* -------------------------------------------------------------------------- */

export interface Attachment {
  readonly filename: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  /** Download URL. The agent never fetches these on its own. */
  readonly url?: string;
}

/** SPEC component 1: sender, recipient, subject, body, attachments, receivedAt. */
export interface EmailMessage {
  readonly id: MessageId;
  readonly inboxId: InboxId;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
  readonly attachments: readonly Attachment[];
  readonly receivedAt: string;
  readonly read: boolean;
  readonly headers: Readonly<Record<string, string>>;
}

export interface EmailFilter {
  readonly limit?: number;
  readonly since?: string;
  readonly unreadOnly?: boolean;
  readonly fromContains?: string;
  readonly subjectContains?: string;
  readonly hasAttachments?: boolean;
}

export interface SendEmailInput {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface SentEmail {
  readonly id: MessageId;
  readonly queuedAt: string;
}

export type MessageMatcher = (message: EmailMessage) => boolean;

export interface WaitOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Ignore anything already in the inbox before this timestamp. */
  readonly after?: string;
  readonly fromContains?: string;
  readonly minConfidence?: number;
}

/** SPEC component 1: extracted OTP code, activation link, expiration. */
export interface ParsedVerification {
  readonly kind: 'otp' | 'link';
  readonly otp: string | null;
  readonly activationLink: string | null;
  /** Whichever of the two above is populated, for callers that want one field. */
  readonly value: string;
  /** 0 to 1. Below ~0.6 the extraction is a guess and is not auto-submitted. */
  readonly confidence: number;
  readonly expiresAt: string | null;
  readonly sourceMessageId: MessageId;
  readonly receivedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                   */
/* -------------------------------------------------------------------------- */

export type PaymentStatus = 'pending' | 'confirmed' | 'failed';

/** SPEC component 1: recipient, amount, memo, txHash, status. */
export interface PaymentIntent {
  readonly to: WalletAddress;
  readonly amount: Money;
  readonly memo?: string;
  /** Invoice id or similar, carried through to the receipt. */
  readonly reference?: string;
  /**
   * Required, not optional. Every payment path in this codebase retries on
   * network errors, and without a stable key a retry is a double spend.
   */
  readonly idempotencyKey: string;
  readonly txHash?: TxHash;
  readonly status?: PaymentStatus;
}

export interface PaymentReceipt {
  readonly txHash: TxHash;
  readonly from: WalletAddress;
  readonly to: WalletAddress;
  readonly amount: Money;
  readonly fee: Money;
  readonly status: PaymentStatus;
  readonly network: Network;
  readonly confirmedAt: string;
  readonly memo?: string;
  readonly reference?: string;
}

/* -------------------------------------------------------------------------- */
/* Spend policy                                                               */
/* -------------------------------------------------------------------------- */

export interface SpendPolicy {
  readonly maxPerTransactionUsd: number;
  readonly maxTotalUsd: number;
  /** Above this, the agent stops and asks a human instead of signing. */
  readonly requireApprovalAboveUsd: number;
  readonly allowedCurrencies: readonly Currency[];
  /** When present, payments to anything outside the list are refused. */
  readonly allowedRecipients?: readonly WalletAddress[];
}

export const DEFAULT_SPEND_POLICY: SpendPolicy = {
  maxPerTransactionUsd: 25,
  maxTotalUsd: 100,
  requireApprovalAboveUsd: 10,
  allowedCurrencies: ['USDC'],
};

export type PolicyDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: 'policy_violation' | 'approval_required'; readonly reason: string };

/* -------------------------------------------------------------------------- */
/* Invoices and vendors                                                       */
/* -------------------------------------------------------------------------- */

export interface Invoice {
  readonly invoiceId: string;
  readonly vendor: string;
  readonly description: string;
  readonly amount: Money;
  readonly payTo: WalletAddress;
  readonly dueBy: string | null;
}

/** An invoice recovered from an email body rather than handed over by an API. */
export interface ParsedInvoice extends Invoice {
  readonly confidence: number;
  readonly sourceMessageId: MessageId;
  readonly senderDomain: string;
}

/**
 * A vendor the agent is allowed to pay without asking. The treasury address is
 * the important half: it is what makes a spoofed invoice email fail closed.
 */
export interface TrustedVendor {
  readonly name: string;
  readonly senderDomain: string;
  readonly treasury: WalletAddress;
  readonly maxPerInvoiceUsd?: number;
}

export interface VendorSignupInput {
  readonly email: EmailAddress;
  readonly plan: string;
  readonly displayName?: string;
}

export interface VendorSignupTicket {
  readonly ticketId: string;
  readonly vendor: string;
  readonly expectedSenderDomain: string;
}

export interface VendorAccount {
  readonly vendor: string;
  readonly accountId: string;
  readonly email: EmailAddress;
  readonly plan: string;
  readonly activatedAt: string;
  /** Whatever the vendor hands back. Never logged in full by the CLI. */
  readonly credentials: Readonly<Record<string, string>>;
}

/**
 * Anything the agent can buy from implements this. The simulator and a real
 * HTTP signup endpoint are interchangeable behind it, which is what keeps the
 * procurement workflow testable without a network.
 */
export interface VendorConnector {
  readonly name: string;
  register(input: VendorSignupInput): Promise<Result<VendorSignupTicket>>;
  confirm(ticket: VendorSignupTicket, verification: ParsedVerification): Promise<Result<Invoice>>;
  activate(invoice: Invoice, receipt: PaymentReceipt): Promise<Result<VendorAccount>>;
}

/* -------------------------------------------------------------------------- */
/* Workflows                                                                  */
/* -------------------------------------------------------------------------- */

export type WorkflowStepName =
  | 'create_inbox'
  | 'vendor_register'
  | 'wait_for_otp'
  | 'vendor_confirm'
  | 'await_invoice'
  | 'parse_invoice'
  | 'verify_vendor'
  | 'policy_check'
  | 'payment'
  | 'vendor_activate';

export interface WorkflowStep {
  readonly name: WorkflowStepName;
  readonly status: 'ok' | 'failed';
  readonly startedAt: string;
  readonly durationMs: number;
  readonly detail: string;
}

export interface ProcurementRequest {
  readonly vendor: VendorConnector;
  readonly plan: string;
  readonly label?: string;
  readonly displayName?: string;
  readonly budget?: Money;
  readonly ttlSeconds?: number;
  readonly verificationTimeoutMs?: number;
}

export interface ProcurementOutcome {
  readonly identity: AgentIdentity;
  readonly account: VendorAccount;
  readonly invoice: Invoice;
  readonly receipt: PaymentReceipt;
  readonly steps: readonly WorkflowStep[];
}

export interface RenewalRequest {
  readonly inboxId: InboxId;
  /** Only invoices from these vendors, to these treasuries, get paid. */
  readonly trustedVendors: readonly TrustedVendor[];
  readonly budget?: Money;
  readonly timeoutMs?: number;
  readonly after?: string;
}

export interface RenewalOutcome {
  readonly invoice: ParsedInvoice;
  readonly vendor: TrustedVendor;
  readonly receipt: PaymentReceipt;
  readonly steps: readonly WorkflowStep[];
}

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

export type RuntimeMode = 'live' | 'simulation';

export interface MermailConfig {
  readonly mode: RuntimeMode;
  readonly apiUrl: string;
  readonly apiKey: string | undefined;
  /** Signing key handle for the agent wallet. Never logged, never serialised. */
  readonly agentWalletKey: string | undefined;
  readonly domain: string;
  readonly network: Network;
  readonly defaultTtlSeconds: number;
  readonly webhookUrl: string | undefined;
  readonly requestTimeoutMs: number;
  readonly maxRetries: number;
  readonly pollIntervalMs: number;
  readonly verificationTimeoutMs: number;
  readonly policy: SpendPolicy;
}
