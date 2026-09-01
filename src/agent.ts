/**
 * Autonomous workflow engine (SPEC component 4).
 *
 * Two use cases live here:
 *
 *   1. Automated account registration. Create an inbox, submit a signup,
 *      extract the verification token, confirm, pay, collect credentials.
 *   2. Autonomous subscription renewal. An invoice arrives by email, the sender
 *      and the destination wallet are checked against a trusted-vendor list,
 *      and only then does the payment go out.
 *
 * Every step is recorded so a failed run can be read back afterwards, and the
 * payment step is gated by a spend policy the vendor has no say in.
 */

import { randomUUID } from 'node:crypto';

import {
  type AgentIdentity,
  type InboxId,
  type Invoice,
  type MermailError,
  type Money,
  type ParsedInvoice,
  type ParsedVerification,
  type PaymentReceipt,
  type PolicyDecision,
  type ProcurementOutcome,
  type ProcurementRequest,
  type RenewalOutcome,
  type RenewalRequest,
  type Result,
  type SpendPolicy,
  type TrustedVendor,
  type VendorAccount,
  type VendorConnector,
  type VendorSignupInput,
  type VendorSignupTicket,
  type WalletAddress,
  type WorkflowStep,
  type WorkflowStepName,
  approxUsd,
  asWalletAddress,
  DEFAULT_SPEND_POLICY,
  err,
  fail,
  money,
  moneyToBase,
  ok,
  parseMoney,
} from './types.js';
import { type MermailBackend, type MermailClient, type MessageSink, isMessageSink } from './mermail-client.js';

/* -------------------------------------------------------------------------- */
/* Spend policy                                                               */
/* -------------------------------------------------------------------------- */

export interface PolicyContext {
  readonly amount: Money;
  readonly recipient: WalletAddress;
  /** Approximate USD already committed by this agent in the current session. */
  readonly spentUsd: number;
}

export function evaluateSpendPolicy(policy: SpendPolicy, context: PolicyContext): PolicyDecision {
  if (!policy.allowedCurrencies.includes(context.amount.currency)) {
    return {
      allowed: false,
      code: 'policy_violation',
      reason: `${context.amount.currency} is not in the allowed currency list (${policy.allowedCurrencies.join(', ')})`,
    };
  }

  if (policy.allowedRecipients && !policy.allowedRecipients.includes(context.recipient)) {
    return { allowed: false, code: 'policy_violation', reason: `${context.recipient} is not an allowlisted recipient` };
  }

  const usd = approxUsd(context.amount);
  if (usd > policy.maxPerTransactionUsd) {
    return {
      allowed: false,
      code: 'policy_violation',
      reason: `${usd.toFixed(2)} USD exceeds the per-transaction cap of ${policy.maxPerTransactionUsd.toFixed(2)}`,
    };
  }

  if (context.spentUsd + usd > policy.maxTotalUsd) {
    return {
      allowed: false,
      code: 'policy_violation',
      reason: `${(context.spentUsd + usd).toFixed(2)} USD would exceed the session cap of ${policy.maxTotalUsd.toFixed(2)}`,
    };
  }

  if (usd > policy.requireApprovalAboveUsd) {
    return {
      allowed: false,
      code: 'approval_required',
      reason: `${usd.toFixed(2)} USD is above the ${policy.requireApprovalAboveUsd.toFixed(2)} USD auto-approval threshold`,
    };
  }

  return { allowed: true };
}

/**
 * Checks a parsed invoice against the trusted-vendor list.
 *
 * This is the control that stops invoice fraud. An attacker who knows the
 * agent's address can send a well-formed invoice email; matching both the
 * sender domain and the destination wallet against a list the operator wrote
 * is what makes that fail instead of paying out.
 */
export function verifyVendor(invoice: ParsedInvoice, trusted: readonly TrustedVendor[]): Result<TrustedVendor> {
  const vendor = trusted.find((candidate) => candidate.senderDomain.toLowerCase() === invoice.senderDomain);
  if (!vendor) {
    return fail('untrusted_vendor', `"${invoice.senderDomain || 'unknown sender'}" is not a trusted vendor domain`);
  }
  if (vendor.treasury !== invoice.payTo) {
    return fail('untrusted_vendor', `Invoice from ${vendor.name} asks for payment to ${invoice.payTo}, which is not their registered treasury`);
  }
  if (vendor.maxPerInvoiceUsd !== undefined && approxUsd(invoice.amount) > vendor.maxPerInvoiceUsd) {
    return fail('policy_violation', `${approxUsd(invoice.amount).toFixed(2)} USD is above the ${vendor.maxPerInvoiceUsd.toFixed(2)} USD limit set for ${vendor.name}`);
  }
  return ok(vendor);
}

/* -------------------------------------------------------------------------- */
/* Vendors                                                                    */
/* -------------------------------------------------------------------------- */

export interface SimulatedVendorOptions {
  readonly name?: string;
  readonly priceUsdc?: string;
  readonly senderDomain?: string;
  /** Delivery lag in milliseconds. Zero keeps tests fast. */
  readonly deliveryDelayMs?: number;
  /** Reject the verification artifact, to exercise the failure path. */
  readonly rejectVerification?: boolean;
  readonly payTo?: WalletAddress;
}

/**
 * A vendor that exists entirely inside the simulator. It writes a real-looking
 * verification email into the target mailbox, then trades a valid code for an
 * invoice. This is what makes the end-to-end demo run without a network.
 */
export class SimulatedVendor implements VendorConnector {
  readonly name: string;
  readonly senderDomain: string;
  readonly treasury: WalletAddress;
  readonly #backend: MermailBackend & MessageSink;
  readonly #priceUsdc: string;
  readonly #deliveryDelayMs: number;
  readonly #rejectVerification: boolean;
  readonly #codes = new Map<string, string>();
  readonly #tickets = new Map<string, VendorSignupInput>();
  #sequence = 100_000;

  constructor(backend: MermailBackend, options: SimulatedVendorOptions = {}) {
    if (!isMessageSink(backend)) {
      throw new TypeError('SimulatedVendor needs a backend that can deliver mail (use SimulationBackend)');
    }
    this.#backend = backend;
    this.name = options.name ?? 'Acme Analytics';
    this.senderDomain = options.senderDomain ?? 'acme-analytics.example';
    this.treasury = options.payTo ?? asWalletAddress('AcmeAnaLyt1csTreasury1111111111111111111111');
    this.#priceUsdc = options.priceUsdc ?? '5.000000';
    this.#deliveryDelayMs = options.deliveryDelayMs ?? 0;
    this.#rejectVerification = options.rejectVerification ?? false;
  }

  /** The trusted-vendor entry an operator would write for this vendor. */
  asTrustedVendor(maxPerInvoiceUsd?: number): TrustedVendor {
    return {
      name: this.name,
      senderDomain: this.senderDomain,
      treasury: this.treasury,
      ...(maxPerInvoiceUsd === undefined ? {} : { maxPerInvoiceUsd }),
    };
  }

  async register(input: VendorSignupInput): Promise<Result<VendorSignupTicket>> {
    const inboxes = await this.#backend.listInboxes();
    if (!inboxes.ok) return inboxes;

    const target = inboxes.value.find((identity) => identity.inbox.address === input.email);
    if (!target) return fail('vendor_rejected', `${input.email} is not a mailbox this simulator can reach`);

    this.#sequence += 1;
    const ticketId = `tkt_${this.#sequence}`;
    const code = String(100_000 + (this.#sequence % 900_000));
    this.#codes.set(ticketId, code);
    this.#tickets.set(ticketId, input);

    const deliver = (): void => {
      this.#backend.deliver(target.id, {
        from: `no-reply@${this.senderDomain}`,
        to: input.email,
        subject: `Confirm your ${this.name} account`,
        text: [
          `Hi ${input.displayName ?? 'there'},`,
          '',
          `Your ${this.name} verification code is ${code}.`,
          'It expires in 10 minutes.',
          '',
          `Or open https://${this.senderDomain}/verify?ticket=${ticketId}&code=${code}`,
          '',
          `Plan selected: ${input.plan}`,
          `Unsubscribe: https://${this.senderDomain}/unsubscribe`,
        ].join('\n'),
        headers: { 'x-vendor-ticket': ticketId },
      });
    };

    if (this.#deliveryDelayMs > 0) {
      const timer = setTimeout(deliver, this.#deliveryDelayMs);
      // Do not hold the process open just for a simulated email.
      timer.unref?.();
    } else {
      deliver();
    }

    return ok({ ticketId, vendor: this.name, expectedSenderDomain: this.senderDomain });
  }

  async confirm(ticket: VendorSignupTicket, verification: ParsedVerification): Promise<Result<Invoice>> {
    if (this.#rejectVerification) {
      return fail('vendor_rejected', 'Verification refused by vendor policy');
    }
    const expected = this.#codes.get(ticket.ticketId);
    if (!expected) return fail('not_found', `Unknown ticket ${ticket.ticketId}`);

    const supplied = verification.otp ?? /[?&]code=(\d{4,8})/.exec(verification.activationLink ?? '')?.[1] ?? '';
    if (supplied !== expected) {
      return fail('vendor_rejected', 'Verification code did not match');
    }

    const price = parseMoney(this.#priceUsdc, 'USDC');
    if (!price.ok) return price;

    return ok({
      invoiceId: `INV-${ticket.ticketId.slice(4)}`,
      vendor: this.name,
      description: `${this.#tickets.get(ticket.ticketId)?.plan ?? 'standard'} plan, first month`,
      amount: price.value,
      payTo: this.treasury,
      dueBy: new Date(Date.now() + 86_400_000).toISOString(),
    });
  }

  async activate(invoice: Invoice, receipt: PaymentReceipt): Promise<Result<VendorAccount>> {
    if (receipt.status !== 'confirmed') {
      return fail('vendor_rejected', `Payment ${receipt.txHash} is ${receipt.status}, not confirmed`);
    }
    const ticketId = `tkt_${invoice.invoiceId.slice(4)}`;
    const input = this.#tickets.get(ticketId);
    if (!input) return fail('not_found', `No signup behind invoice ${invoice.invoiceId}`);

    return ok({
      vendor: this.name,
      accountId: `acct_${invoice.invoiceId.slice(4)}`,
      email: input.email,
      plan: input.plan,
      activatedAt: new Date().toISOString(),
      credentials: { apiKey: `sk_sim_${receipt.txHash.slice(0, 24)}`, dashboard: `https://${this.senderDomain}/app` },
    });
  }

  /**
   * Drops a renewal invoice into a mailbox, the way a monthly billing email
   * would arrive. Used by the renewal demo and its tests.
   */
  issueRenewalInvoice(inboxId: InboxId, options: { amountUsdc?: string; payTo?: WalletAddress; invoiceId?: string } = {}): Result<unknown> {
    const amount = options.amountUsdc ?? this.#priceUsdc;
    const invoiceId = options.invoiceId ?? `INV-${(this.#sequence += 1)}`;
    const dueBy = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);

    return this.#backend.deliver(inboxId, {
      from: `billing@${this.senderDomain}`,
      to: 'agent',
      subject: `Invoice ${invoiceId} from ${this.name}`,
      text: [
        `Invoice: ${invoiceId}`,
        `Amount due: ${amount} USDC`,
        `Pay to: ${options.payTo ?? this.treasury}`,
        `Due by: ${dueBy}`,
        '',
        `Thanks for using ${this.name}.`,
      ].join('\n'),
      headers: { 'x-invoice-id': invoiceId },
    });
  }
}

export interface HttpVendorOptions {
  readonly name: string;
  readonly baseUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Talks to a vendor that exposes a machine-readable signup API. Real vendors
 * mostly do not, yet; when they do not, write a connector that drives their
 * flow however it needs driving and keep this interface.
 */
export class HttpVendorConnector implements VendorConnector {
  readonly name: string;
  readonly #options: HttpVendorOptions;
  readonly #fetch: typeof fetch;

  constructor(options: HttpVendorOptions) {
    this.name = options.name;
    this.#options = options;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  async #post<T>(path: string, body: unknown): Promise<Result<T>> {
    try {
      const response = await this.#fetch(`${this.#options.baseUrl.replace(/\/+$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.#options.headers ?? {}) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.#options.timeoutMs ?? 20_000),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return fail('vendor_rejected', `${this.name} returned ${response.status} for ${path}`, {
          status: response.status,
          details: { body: detail.slice(0, 512) },
        });
      }
      return ok((await response.json()) as T);
    } catch (cause) {
      return fail('network', `${this.name} is unreachable`, { cause });
    }
  }

  register(input: VendorSignupInput): Promise<Result<VendorSignupTicket>> {
    return this.#post<VendorSignupTicket>('/signup', input);
  }

  confirm(ticket: VendorSignupTicket, verification: ParsedVerification): Promise<Result<Invoice>> {
    return this.#post<Invoice>('/signup/confirm', {
      ticketId: ticket.ticketId,
      ...(verification.otp ? { otp: verification.otp } : { link: verification.activationLink }),
    });
  }

  activate(invoice: Invoice, receipt: PaymentReceipt): Promise<Result<VendorAccount>> {
    return this.#post<VendorAccount>('/signup/activate', { invoiceId: invoice.invoiceId, txHash: receipt.txHash });
  }
}

/* -------------------------------------------------------------------------- */
/* Agent                                                                      */
/* -------------------------------------------------------------------------- */

export type ApprovalHandler = (invoice: Invoice, reason: string) => Promise<boolean> | boolean;

export interface AgentOptions {
  readonly policy?: SpendPolicy;
  readonly onStep?: (step: WorkflowStep) => void;
  /** Called when an invoice lands above the auto-approval threshold. */
  readonly onApprovalRequired?: ApprovalHandler;
  /** Top up a fresh wallet before paying. Off on mainnet by design. */
  readonly autoFund?: boolean;
  readonly now?: () => number;
}

type StepError = MermailError & { steps?: readonly WorkflowStep[] };

interface StepRecorder {
  readonly steps: WorkflowStep[];
  run<T>(name: WorkflowStepName, describe: (value: T) => string, work: () => Promise<Result<T>>): Promise<Result<T>>;
  attach<E extends MermailError>(error: E): E & { steps: readonly WorkflowStep[] };
}

export class ProvisioningAgent {
  readonly client: MermailClient;
  readonly policy: SpendPolicy;
  readonly #onStep: ((step: WorkflowStep) => void) | undefined;
  readonly #onApprovalRequired: ApprovalHandler | undefined;
  readonly #autoFund: boolean;
  readonly #now: () => number;
  readonly #settled = new Set<string>();
  #spentUsd = 0;

  constructor(client: MermailClient, options: AgentOptions = {}) {
    this.client = client;
    this.policy = options.policy ?? client.config.policy ?? DEFAULT_SPEND_POLICY;
    this.#onStep = options.onStep;
    this.#onApprovalRequired = options.onApprovalRequired;
    this.#autoFund = options.autoFund ?? client.config.network !== 'solana-mainnet';
    this.#now = options.now ?? (() => Date.now());
  }

  /** Approximate USD this agent has committed since it was constructed. */
  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** Invoice ids this agent has already paid, so a rerun does not pay twice. */
  get settledInvoiceIds(): readonly string[] {
    return [...this.#settled];
  }

  #recorder(): StepRecorder {
    const steps: WorkflowStep[] = [];
    const onStep = this.#onStep;
    const now = this.#now;

    return {
      steps,
      async run(name, describe, work) {
        const startedAt = new Date().toISOString();
        const t0 = now();
        const result = await work();
        const step: WorkflowStep = {
          name,
          status: result.ok ? 'ok' : 'failed',
          startedAt,
          durationMs: now() - t0,
          detail: result.ok ? describe(result.value) : result.error.message,
        };
        steps.push(step);
        onStep?.(step);
        return result;
      },
      attach(error) {
        return Object.assign(error, { steps: [...steps] });
      },
    };
  }

  provision(label: string, metadata?: Record<string, string>, ttlSeconds?: number): Promise<Result<AgentIdentity>> {
    return this.client.createInbox({
      label,
      ...(metadata ? { metadata } : {}),
      ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
    });
  }

  /**
   * Pays an invoice after checking it against the spend policy. Separated from
   * the workflows so a caller can drive things manually and keep the guard.
   */
  async payInvoice(identity: AgentIdentity, invoice: Invoice): Promise<Result<PaymentReceipt>> {
    const decision = evaluateSpendPolicy(this.policy, {
      amount: invoice.amount,
      recipient: invoice.payTo,
      spentUsd: this.#spentUsd,
    });

    if (!decision.allowed) {
      if (decision.code === 'approval_required' && this.#onApprovalRequired) {
        const approved = await this.#onApprovalRequired(invoice, decision.reason);
        if (!approved) return fail('approval_required', `Operator declined: ${decision.reason}`);
      } else {
        return fail(decision.code, decision.reason, { details: { invoiceId: invoice.invoiceId } });
      }
    }

    if (this.#autoFund) {
      const funded = await this.#ensureFunds(identity, invoice.amount);
      if (!funded.ok) return funded;
    }

    const receipt = await this.client.sendPayment(identity.id, {
      to: invoice.payTo,
      amount: invoice.amount,
      memo: `${invoice.vendor} ${invoice.invoiceId}`,
      reference: invoice.invoiceId,
      // Stable across retries of the same invoice, unique across invoices.
      idempotencyKey: `map:${identity.id}:${invoice.invoiceId}`,
    });
    if (!receipt.ok) return receipt;

    this.#spentUsd += approxUsd(invoice.amount);
    this.#settled.add(invoice.invoiceId);
    return receipt;
  }

  async #ensureFunds(identity: AgentIdentity, amount: Money): Promise<Result<void>> {
    const balance = await this.client.balanceOf(identity.id, amount.currency);
    if (!balance.ok) return balance;

    const needed = moneyToBase(amount);
    const held = moneyToBase(balance.value);
    if (held >= needed * 2n) return ok(undefined);

    // Over-fund a little so the network fee does not tip the transfer short.
    const topUp = money(needed * 2n - held, amount.currency);
    const funded = await this.client.fundWallet(identity.id, topUp);
    if (!funded.ok) {
      return funded.error.code === 'unsupported' ? ok(undefined) : (funded as Result<never>);
    }
    return ok(undefined);
  }

  #checkBudgetAndPolicy(invoice: Invoice, budget: Money | undefined): Result<Invoice> {
    if (budget) {
      if (budget.currency !== invoice.amount.currency) {
        return fail('policy_violation', `Budget is ${budget.currency} but the invoice is ${invoice.amount.currency}`);
      }
      if (moneyToBase(invoice.amount) > moneyToBase(budget)) {
        return fail('policy_violation', `Invoice ${invoice.amount.amount} exceeds budget ${budget.amount}`);
      }
    }
    const decision = evaluateSpendPolicy(this.policy, {
      amount: invoice.amount,
      recipient: invoice.payTo,
      spentUsd: this.#spentUsd,
    });
    if (!decision.allowed && decision.code === 'policy_violation') {
      return fail('policy_violation', decision.reason);
    }
    return ok(invoice);
  }

  /* ---------------------------------------------------------------------- */
  /* Use case 1: automated account registration                             */
  /* ---------------------------------------------------------------------- */

  async procure(request: ProcurementRequest): Promise<Result<ProcurementOutcome, StepError>> {
    const recorder = this.#recorder();
    const label = request.label ?? `${request.vendor.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${request.plan}`;

    const identityResult = await recorder.run<AgentIdentity>(
      'create_inbox',
      (identity) => `${identity.inbox.address} (${identity.wallet.address})`,
      () => this.provision(label, { vendor: request.vendor.name, plan: request.plan, run: randomUUID() }, request.ttlSeconds),
    );
    if (!identityResult.ok) return err(recorder.attach(identityResult.error));
    const identity = identityResult.value;

    // Anchor the inbox scan here so an old message can never satisfy this run.
    const registeredAt = new Date().toISOString();

    const ticketResult = await recorder.run<VendorSignupTicket>(
      'vendor_register',
      (ticket) => `${ticket.vendor} ticket ${ticket.ticketId}`,
      () =>
        request.vendor.register({
          email: identity.inbox.address,
          plan: request.plan,
          ...(request.displayName ? { displayName: request.displayName } : {}),
        }),
    );
    if (!ticketResult.ok) return err(recorder.attach(ticketResult.error));
    const ticket = ticketResult.value;

    const verification = await recorder.run<{ verification: ParsedVerification }>(
      'wait_for_otp',
      ({ verification: v }) => `${v.kind} at ${v.confidence.toFixed(2)} confidence${v.expiresAt ? `, expires ${v.expiresAt}` : ''}`,
      () =>
        this.client.waitForVerification(identity.id, {
          after: registeredAt,
          fromContains: ticket.expectedSenderDomain,
          ...(request.verificationTimeoutMs === undefined ? {} : { timeoutMs: request.verificationTimeoutMs }),
        }),
    );
    if (!verification.ok) return err(recorder.attach(verification.error));

    const invoiceResult = await recorder.run<Invoice>(
      'vendor_confirm',
      (invoice) => `${invoice.invoiceId} for ${invoice.amount.amount} ${invoice.amount.currency}`,
      () => request.vendor.confirm(ticket, verification.value.verification),
    );
    if (!invoiceResult.ok) return err(recorder.attach(invoiceResult.error));
    const invoice = invoiceResult.value;

    const checked = await recorder.run<Invoice>(
      'policy_check',
      () => `within budget and policy (${invoice.amount.amount} ${invoice.amount.currency})`,
      async () => this.#checkBudgetAndPolicy(invoice, request.budget),
    );
    if (!checked.ok) return err(recorder.attach(checked.error));

    const receiptResult = await recorder.run<PaymentReceipt>(
      'payment',
      (receipt) => `${receipt.amount.amount} ${receipt.amount.currency} to ${receipt.to} (${receipt.txHash.slice(0, 12)}...)`,
      () => this.payInvoice(identity, invoice),
    );
    if (!receiptResult.ok) return err(recorder.attach(receiptResult.error));

    const accountResult = await recorder.run<VendorAccount>(
      'vendor_activate',
      (account) => `${account.vendor} account ${account.accountId} on ${account.plan}`,
      () => request.vendor.activate(invoice, receiptResult.value),
    );
    if (!accountResult.ok) return err(recorder.attach(accountResult.error));

    const refreshed = await this.client.getInbox(identity.id);

    return ok({
      identity: refreshed.ok ? refreshed.value : identity,
      account: accountResult.value,
      invoice,
      receipt: receiptResult.value,
      steps: recorder.steps,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Use case 2: autonomous subscription renewal                            */
  /* ---------------------------------------------------------------------- */

  /**
   * Watches a mailbox for a billing email and settles it. The order matters:
   * parse, then verify the sender against the trusted list, then apply the
   * spend policy, and only then sign. Nothing an attacker controls gets to
   * skip a step.
   */
  async renewSubscription(request: RenewalRequest): Promise<Result<RenewalOutcome, StepError>> {
    const recorder = this.#recorder();

    const identityResult = await this.client.getInbox(request.inboxId);
    if (!identityResult.ok) return err(recorder.attach(identityResult.error));
    const identity = identityResult.value;

    const arrived = await recorder.run<{ invoice: ParsedInvoice }>(
      'await_invoice',
      ({ invoice }) => `${invoice.invoiceId} from ${invoice.senderDomain}`,
      () =>
        this.client.waitForInvoice(request.inboxId, {
          skipInvoiceIds: [...this.#settled],
          ...(request.after === undefined ? {} : { after: request.after }),
          ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        }),
    );
    if (!arrived.ok) return err(recorder.attach(arrived.error));
    const invoice = arrived.value.invoice;

    const parsed = await recorder.run<ParsedInvoice>(
      'parse_invoice',
      (value) => `${value.amount.amount} ${value.amount.currency} to ${value.payTo} at ${value.confidence.toFixed(2)} confidence`,
      async () => ok(invoice),
    );
    if (!parsed.ok) return err(recorder.attach(parsed.error));

    const vendorResult = await recorder.run<TrustedVendor>(
      'verify_vendor',
      (vendor) => `${vendor.name} matched on domain and treasury`,
      async () => verifyVendor(invoice, request.trustedVendors),
    );
    if (!vendorResult.ok) return err(recorder.attach(vendorResult.error));

    const checked = await recorder.run<Invoice>(
      'policy_check',
      () => `within budget and policy (${invoice.amount.amount} ${invoice.amount.currency})`,
      async () => this.#checkBudgetAndPolicy(invoice, request.budget),
    );
    if (!checked.ok) return err(recorder.attach(checked.error));

    const receiptResult = await recorder.run<PaymentReceipt>(
      'payment',
      (receipt) => `${receipt.amount.amount} ${receipt.amount.currency} to ${receipt.to} (${receipt.txHash.slice(0, 12)}...)`,
      () => this.payInvoice(identity, invoice),
    );
    if (!receiptResult.ok) return err(recorder.attach(receiptResult.error));

    return ok({ invoice, vendor: vendorResult.value, receipt: receiptResult.value, steps: recorder.steps });
  }
}

export type { InboxId };
