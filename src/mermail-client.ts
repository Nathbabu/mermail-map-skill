/**
 * Mermail REST and webhook client wrapper (SPEC component 2).
 *
 * `MermailClient` is what the rest of the codebase talks to. It delegates to a
 * `MermailBackend`, of which there are two: `HttpBackend` against the real
 * Mermail API, and `SimulationBackend`, an in-memory implementation selected
 * automatically when no API key is configured. The simulator is not a test
 * double bolted on the side; it is the default path, so `npm test`,
 * `npm run demo` and a fresh clone all work with zero credentials.
 */

import {
  type AgentIdentity,
  type AgentWallet,
  type Currency,
  type CreateInboxInput,
  type EmailFilter,
  type EmailMessage,
  type InboxId,
  type Invoice,
  type MermailConfig,
  MermailError,
  type MessageId,
  type MessageMatcher,
  type Money,
  type Network,
  type ParsedInvoice,
  type ParsedVerification,
  type PaymentIntent,
  type PaymentReceipt,
  type Result,
  type RuntimeMode,
  type SendEmailInput,
  type SentEmail,
  type SpendPolicy,
  type TxHash,
  type WaitOptions,
  asEmailAddress,
  asInboxId,
  asMessageId,
  asTxHash,
  asWalletAddress,
  CURRENCY_DECIMALS,
  DEFAULT_SPEND_POLICY,
  err,
  fail,
  formatAmount,
  isCurrency,
  money,
  moneyToBase,
  ok,
  parseMoney,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* Config                                                                     */
/* -------------------------------------------------------------------------- */

export type EnvLike = Readonly<Record<string, string | undefined>>;

function num(env: EnvLike, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function readNetwork(raw: string | undefined, mode: RuntimeMode): Network {
  if (raw === 'solana-mainnet' || raw === 'solana-devnet' || raw === 'simulation') return raw;
  return mode === 'live' ? 'solana-mainnet' : 'simulation';
}

export function resolveSpendPolicy(env: EnvLike): SpendPolicy {
  return {
    maxPerTransactionUsd: num(env, 'MAP_MAX_PER_TX_USD', DEFAULT_SPEND_POLICY.maxPerTransactionUsd),
    maxTotalUsd: num(env, 'MAP_MAX_TOTAL_USD', DEFAULT_SPEND_POLICY.maxTotalUsd),
    requireApprovalAboveUsd: num(env, 'MAP_REQUIRE_APPROVAL_ABOVE_USD', DEFAULT_SPEND_POLICY.requireApprovalAboveUsd),
    allowedCurrencies: DEFAULT_SPEND_POLICY.allowedCurrencies,
  };
}

export function resolveConfig(env: EnvLike = process.env): MermailConfig {
  const apiKey = env['MERMAIL_API_KEY']?.trim() || undefined;
  const forced = env['MERMAIL_MODE']?.trim().toLowerCase();
  const mode: RuntimeMode = forced === 'simulation' || forced === 'simulate' ? 'simulation' : apiKey ? 'live' : 'simulation';

  return {
    mode,
    apiUrl: (env['MERMAIL_API_URL']?.trim() || 'https://api.mermail.app').replace(/\/+$/, ''),
    apiKey,
    agentWalletKey: env['AGENT_WALLET_KEY']?.trim() || undefined,
    domain: env['MERMAIL_DOMAIN']?.trim() || 'mermail.app',
    network: readNetwork(env['MERMAIL_NETWORK']?.trim(), mode),
    defaultTtlSeconds: num(env, 'MERMAIL_INBOX_TTL_SECONDS', 86_400),
    webhookUrl: env['MERMAIL_WEBHOOK_URL']?.trim() || undefined,
    requestTimeoutMs: num(env, 'MERMAIL_TIMEOUT_MS', 15_000),
    maxRetries: num(env, 'MERMAIL_MAX_RETRIES', 3),
    pollIntervalMs: num(env, 'MAP_POLL_INTERVAL_MS', 1_000),
    verificationTimeoutMs: num(env, 'MAP_VERIFICATION_TIMEOUT_MS', 60_000),
    policy: resolveSpendPolicy(env),
  };
}

/* -------------------------------------------------------------------------- */
/* Backend contract                                                           */
/* -------------------------------------------------------------------------- */

export interface MermailBackend {
  readonly mode: RuntimeMode;
  createInbox(input: CreateInboxInput): Promise<Result<AgentIdentity>>;
  getInbox(id: InboxId): Promise<Result<AgentIdentity>>;
  listInboxes(): Promise<Result<readonly AgentIdentity[]>>;
  expireInbox(id: InboxId): Promise<Result<AgentIdentity>>;
  registerWebhook(id: InboxId, url: string): Promise<Result<AgentIdentity>>;
  fetchEmails(id: InboxId, filter?: EmailFilter): Promise<Result<readonly EmailMessage[]>>;
  markRead(id: InboxId, messageId: MessageId): Promise<Result<void>>;
  sendEmail(id: InboxId, input: SendEmailInput): Promise<Result<SentEmail>>;
  getWallet(id: InboxId): Promise<Result<AgentWallet>>;
  fundWallet(id: InboxId, amount: Money): Promise<Result<AgentWallet>>;
  sendPayment(id: InboxId, intent: PaymentIntent): Promise<Result<PaymentReceipt>>;
  getTransaction(txHash: TxHash): Promise<Result<PaymentReceipt>>;
}

export type InboundMessage = Omit<EmailMessage, 'id' | 'inboxId' | 'receivedAt' | 'read' | 'attachments'> & {
  readonly attachments?: readonly EmailMessage['attachments'][number][];
};

/**
 * Implemented by the simulator and by the webhook route, so an external
 * delivery and a simulated vendor land in the mailbox by the same door.
 */
export interface MessageSink {
  deliver(id: InboxId, message: InboundMessage): Result<EmailMessage>;
}

export function isMessageSink(value: unknown): value is MessageSink {
  return typeof value === 'object' && value !== null && typeof (value as MessageSink).deliver === 'function';
}

/* -------------------------------------------------------------------------- */
/* HTTP backend                                                               */
/* -------------------------------------------------------------------------- */

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function statusToCode(status: number): MermailError['code'] {
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 402) return 'insufficient_funds';
  if (status === 410) return 'inbox_expired';
  if (status === 429) return 'rate_limited';
  return 'upstream';
}

export interface HttpBackendOptions {
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpBackend implements MermailBackend {
  readonly mode: RuntimeMode = 'live';
  readonly #config: MermailConfig;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(config: MermailConfig, options: HttpBackendOptions = {}) {
    if (!config.apiKey) {
      throw new MermailError('unauthorized', 'HttpBackend requires MERMAIL_API_KEY');
    }
    this.#config = config;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async #request<T>(method: string, path: string, body?: unknown, signing = false): Promise<Result<T>> {
    const url = `${this.#config.apiUrl}${path}`;
    let lastError: MermailError | undefined;

    for (let attempt = 0; attempt <= this.#config.maxRetries; attempt += 1) {
      if (attempt > 0) {
        // Exponential backoff with jitter. Without the jitter a fleet of agents
        // retrying a 429 lines up and hits the same wall together.
        const backoff = Math.min(2 ** attempt * 250, 8_000);
        await this.#sleep(backoff + Math.random() * 250);
      }

      try {
        const response = await this.#fetch(url, {
          method,
          headers: {
            authorization: `Bearer ${this.#config.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
            'user-agent': 'map-skill/0.2',
            // Only sent on the routes that move money, so a leaked read-only
            // trace never contains the signing handle.
            ...(signing && this.#config.agentWalletKey ? { 'x-agent-wallet-key': this.#config.agentWalletKey } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
        });

        if (response.ok) {
          if (response.status === 204) return ok(undefined as T);
          return ok((await response.json()) as T);
        }

        const detail = await response.text().catch(() => '');
        lastError = new MermailError(statusToCode(response.status), `${method} ${path} failed with ${response.status}`, {
          status: response.status,
          retryable: RETRYABLE_STATUS.has(response.status),
          details: { body: detail.slice(0, 512) },
        });
        if (!lastError.retryable) return err(lastError);
      } catch (cause) {
        const timedOut = cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError');
        lastError = new MermailError(timedOut ? 'timeout' : 'network', `${method} ${path} could not be completed`, { cause });
      }
    }

    return err(lastError ?? new MermailError('network', `${method} ${path} failed`));
  }

  createInbox(input: CreateInboxInput): Promise<Result<AgentIdentity>> {
    return this.#request<AgentIdentity>('POST', '/v1/inboxes', {
      ttlSeconds: this.#config.defaultTtlSeconds,
      ...(this.#config.webhookUrl ? { webhookUrl: this.#config.webhookUrl } : {}),
      ...input,
    });
  }

  getInbox(id: InboxId): Promise<Result<AgentIdentity>> {
    return this.#request<AgentIdentity>('GET', `/v1/inboxes/${encodeURIComponent(id)}`);
  }

  listInboxes(): Promise<Result<readonly AgentIdentity[]>> {
    return this.#request<readonly AgentIdentity[]>('GET', '/v1/inboxes');
  }

  expireInbox(id: InboxId): Promise<Result<AgentIdentity>> {
    return this.#request<AgentIdentity>('POST', `/v1/inboxes/${encodeURIComponent(id)}/expire`);
  }

  registerWebhook(id: InboxId, url: string): Promise<Result<AgentIdentity>> {
    return this.#request<AgentIdentity>('POST', `/v1/inboxes/${encodeURIComponent(id)}/webhook`, { url });
  }

  fetchEmails(id: InboxId, filter: EmailFilter = {}): Promise<Result<readonly EmailMessage[]>> {
    const query = new URLSearchParams();
    if (filter.limit !== undefined) query.set('limit', String(filter.limit));
    if (filter.since !== undefined) query.set('since', filter.since);
    if (filter.unreadOnly) query.set('unread', 'true');
    if (filter.fromContains !== undefined) query.set('from', filter.fromContains);
    if (filter.subjectContains !== undefined) query.set('subject', filter.subjectContains);
    if (filter.hasAttachments) query.set('attachments', 'true');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return this.#request<readonly EmailMessage[]>('GET', `/v1/inboxes/${encodeURIComponent(id)}/messages${suffix}`);
  }

  markRead(id: InboxId, messageId: MessageId): Promise<Result<void>> {
    return this.#request<void>('POST', `/v1/inboxes/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/read`);
  }

  sendEmail(id: InboxId, input: SendEmailInput): Promise<Result<SentEmail>> {
    return this.#request<SentEmail>('POST', `/v1/inboxes/${encodeURIComponent(id)}/messages`, input);
  }

  getWallet(id: InboxId): Promise<Result<AgentWallet>> {
    return this.#request<AgentWallet>('GET', `/v1/inboxes/${encodeURIComponent(id)}/wallet`);
  }

  async fundWallet(id: InboxId, amount: Money): Promise<Result<AgentWallet>> {
    if (this.#config.network === 'solana-mainnet') {
      return fail('unsupported', 'There is no faucet on mainnet. Fund the wallet from treasury instead.');
    }
    return this.#request<AgentWallet>('POST', `/v1/inboxes/${encodeURIComponent(id)}/wallet/fund`, amount);
  }

  sendPayment(id: InboxId, intent: PaymentIntent): Promise<Result<PaymentReceipt>> {
    return this.#request<PaymentReceipt>('POST', `/v1/inboxes/${encodeURIComponent(id)}/wallet/payments`, intent, true);
  }

  getTransaction(txHash: TxHash): Promise<Result<PaymentReceipt>> {
    return this.#request<PaymentReceipt>('GET', `/v1/transactions/${encodeURIComponent(txHash)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Simulation backend                                                         */
/* -------------------------------------------------------------------------- */

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Small xorshift PRNG. Seeding it is what makes simulated runs reproducible. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0 || 0x2f6e2b1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return slug || 'agent';
}

interface SimInboxRecord {
  identity: AgentIdentity;
  balances: Map<Currency, bigint>;
  inbox: EmailMessage[];
  outbox: Array<SendEmailInput & { id: MessageId; queuedAt: string }>;
  webhookDeliveries: Array<{ url: string; messageId: MessageId }>;
}

export interface SimulationOptions {
  readonly domain?: string;
  readonly network?: Network;
  readonly seed?: number;
  /** Fixed clock keeps assertions on timestamps stable in tests. */
  readonly now?: () => Date;
  readonly defaultTtlSeconds?: number;
  /** Base units of USDC granted to every new inbox. Defaults to 0. */
  readonly startingUsdc?: bigint;
}

export class SimulationBackend implements MermailBackend, MessageSink {
  readonly mode: RuntimeMode = 'simulation';
  readonly #records = new Map<InboxId, SimInboxRecord>();
  readonly #transactions = new Map<TxHash, PaymentReceipt>();
  readonly #idempotency = new Map<string, TxHash>();
  readonly #random: () => number;
  readonly #now: () => Date;
  readonly #domain: string;
  readonly #network: Network;
  readonly #defaultTtl: number;
  readonly #startingUsdc: bigint;
  #counter = 0;

  constructor(options: SimulationOptions = {}) {
    this.#random = makeRandom(options.seed ?? ((Date.now() ^ (Math.random() * 0xffff_ffff)) >>> 0));
    this.#now = options.now ?? (() => new Date());
    this.#domain = options.domain ?? 'mermail.app';
    this.#network = options.network ?? 'simulation';
    this.#defaultTtl = options.defaultTtlSeconds ?? 86_400;
    this.#startingUsdc = options.startingUsdc ?? 0n;
  }

  #token(length: number, alphabet = BASE58): string {
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += alphabet[Math.floor(this.#random() * alphabet.length)] ?? '1';
    }
    return out;
  }

  #timestamp(): string {
    // Nudge the clock forward so messages created in the same tick still sort.
    this.#counter += 1;
    return new Date(this.#now().getTime() + this.#counter).toISOString();
  }

  #balances(record: SimInboxRecord): readonly Money[] {
    return [...record.balances.entries()].map(([currency, base]) => money(base, currency));
  }

  #snapshot(record: SimInboxRecord): AgentIdentity {
    const expired = record.identity.inbox.expiresAt !== null && record.identity.inbox.expiresAt <= this.#now().toISOString();
    return {
      ...record.identity,
      inbox: {
        ...record.identity.inbox,
        status: record.identity.inbox.status === 'active' && expired ? 'expired' : record.identity.inbox.status,
      },
      wallet: { ...record.identity.wallet, balances: this.#balances(record) },
    };
  }

  #find(id: InboxId): Result<SimInboxRecord> {
    const record = this.#records.get(id);
    return record ? ok(record) : fail('not_found', `No inbox ${id}`);
  }

  /** Mail-facing operations refuse an expired inbox; wallet reads still work. */
  #findLive(id: InboxId): Result<SimInboxRecord> {
    const found = this.#find(id);
    if (!found.ok) return found;
    if (this.#snapshot(found.value).inbox.status !== 'active') {
      return fail('inbox_expired', `Inbox ${id} is no longer accepting mail`);
    }
    return found;
  }

  async createInbox(input: CreateInboxInput): Promise<Result<AgentIdentity>> {
    if (!input.label || input.label.trim() === '') {
      return fail('invalid_request', 'label is required');
    }
    const id = asInboxId(`inb_${this.#token(16)}`);
    const prefix = slugify(input.prefix ?? input.label);
    const address = asEmailAddress(`agent_${prefix}_${this.#token(6).toLowerCase()}@${this.#domain}`);
    const ttlSeconds = input.ttlSeconds ?? this.#defaultTtl;
    const createdAt = this.#timestamp();

    const balances = new Map<Currency, bigint>([
      ['USDC', this.#startingUsdc],
      ['SOL', 0n],
    ]);
    if (input.fund) {
      balances.set(input.fund.currency, (balances.get(input.fund.currency) ?? 0n) + moneyToBase(input.fund));
    }

    const record: SimInboxRecord = {
      identity: {
        id,
        label: input.label,
        inbox: {
          id,
          address,
          ttlSeconds,
          expiresAt: ttlSeconds > 0 ? new Date(this.#now().getTime() + ttlSeconds * 1000).toISOString() : null,
          webhookUrl: input.webhookUrl ?? null,
          status: 'active',
          createdAt,
        },
        wallet: { address: asWalletAddress(this.#token(44)), network: this.#network, balances: [] },
        createdAt,
        metadata: { ...(input.metadata ?? {}) },
      },
      balances,
      inbox: [],
      outbox: [],
      webhookDeliveries: [],
    };
    this.#records.set(id, record);

    // A real mailbox is never empty on arrival, and the demo reads better when
    // the agent has to filter past something irrelevant.
    this.deliver(id, {
      from: `postmaster@${this.#domain}`,
      to: address,
      subject: 'Your Mermail address is live',
      text: `This mailbox (${address}) is provisioned and accepting mail. Wallet: ${record.identity.wallet.address}`,
      headers: { 'x-mermail-system': 'true' },
    });

    return ok(this.#snapshot(record));
  }

  async getInbox(id: InboxId): Promise<Result<AgentIdentity>> {
    const found = this.#find(id);
    return found.ok ? ok(this.#snapshot(found.value)) : found;
  }

  async listInboxes(): Promise<Result<readonly AgentIdentity[]>> {
    return ok([...this.#records.values()].map((record) => this.#snapshot(record)));
  }

  async expireInbox(id: InboxId): Promise<Result<AgentIdentity>> {
    const found = this.#find(id);
    if (!found.ok) return found;
    found.value.identity = {
      ...found.value.identity,
      inbox: { ...found.value.identity.inbox, status: 'expired', expiresAt: this.#timestamp() },
    };
    return ok(this.#snapshot(found.value));
  }

  async registerWebhook(id: InboxId, url: string): Promise<Result<AgentIdentity>> {
    const found = this.#find(id);
    if (!found.ok) return found;
    found.value.identity = { ...found.value.identity, inbox: { ...found.value.identity.inbox, webhookUrl: url } };
    return ok(this.#snapshot(found.value));
  }

  async fetchEmails(id: InboxId, filter: EmailFilter = {}): Promise<Result<readonly EmailMessage[]>> {
    const found = this.#find(id);
    if (!found.ok) return found;

    let messages = [...found.value.inbox];
    if (filter.since !== undefined) {
      const since = filter.since;
      messages = messages.filter((m) => m.receivedAt > since);
    }
    if (filter.unreadOnly) messages = messages.filter((m) => !m.read);
    if (filter.hasAttachments) messages = messages.filter((m) => m.attachments.length > 0);
    if (filter.fromContains !== undefined) {
      const needle = filter.fromContains.toLowerCase();
      messages = messages.filter((m) => m.from.toLowerCase().includes(needle));
    }
    if (filter.subjectContains !== undefined) {
      const needle = filter.subjectContains.toLowerCase();
      messages = messages.filter((m) => m.subject.toLowerCase().includes(needle));
    }
    messages.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
    return ok(filter.limit === undefined ? messages : messages.slice(0, filter.limit));
  }

  async markRead(id: InboxId, messageId: MessageId): Promise<Result<void>> {
    const found = this.#find(id);
    if (!found.ok) return found;
    const index = found.value.inbox.findIndex((m) => m.id === messageId);
    const existing = found.value.inbox[index];
    if (!existing) return fail('not_found', `No message ${messageId}`);
    found.value.inbox[index] = { ...existing, read: true };
    return ok(undefined);
  }

  async sendEmail(id: InboxId, input: SendEmailInput): Promise<Result<SentEmail>> {
    const found = this.#findLive(id);
    if (!found.ok) return found;
    const sent = { id: asMessageId(`msg_${this.#token(16)}`), queuedAt: this.#timestamp() };
    found.value.outbox.push({ ...input, ...sent });
    return ok(sent);
  }

  async getWallet(id: InboxId): Promise<Result<AgentWallet>> {
    const found = this.#find(id);
    if (!found.ok) return found;
    return ok({ ...found.value.identity.wallet, balances: this.#balances(found.value) });
  }

  async fundWallet(id: InboxId, amount: Money): Promise<Result<AgentWallet>> {
    const found = this.#find(id);
    if (!found.ok) return found;
    const base = moneyToBase(amount);
    if (base <= 0n) return fail('invalid_request', 'Funding amount must be positive');
    found.value.balances.set(amount.currency, (found.value.balances.get(amount.currency) ?? 0n) + base);
    return this.getWallet(id);
  }

  async sendPayment(id: InboxId, intent: PaymentIntent): Promise<Result<PaymentReceipt>> {
    const found = this.#find(id);
    if (!found.ok) return found;
    if (!intent.idempotencyKey) return fail('invalid_request', 'idempotencyKey is required');

    const replay = this.#idempotency.get(intent.idempotencyKey);
    if (replay) {
      const receipt = this.#transactions.get(replay);
      if (receipt) return ok(receipt);
    }

    const amount = moneyToBase(intent.amount);
    if (amount <= 0n) return fail('invalid_request', 'Payment amount must be positive');

    const fee = intent.amount.currency === 'SOL' ? 5_000n : 1_000n;
    const available = found.value.balances.get(intent.amount.currency) ?? 0n;
    if (available < amount + fee) {
      return fail(
        'insufficient_funds',
        `Wallet holds ${formatAmount(available, intent.amount.currency)} ${intent.amount.currency}, needs ${formatAmount(amount + fee, intent.amount.currency)}`,
        { details: { available: available.toString(), required: (amount + fee).toString() } },
      );
    }

    found.value.balances.set(intent.amount.currency, available - amount - fee);
    const receipt: PaymentReceipt = {
      txHash: asTxHash(this.#token(88)),
      from: found.value.identity.wallet.address,
      to: intent.to,
      amount: intent.amount,
      fee: money(fee, intent.amount.currency),
      status: 'confirmed',
      network: this.#network,
      confirmedAt: this.#timestamp(),
      ...(intent.memo === undefined ? {} : { memo: intent.memo }),
      ...(intent.reference === undefined ? {} : { reference: intent.reference }),
    };
    this.#transactions.set(receipt.txHash, receipt);
    this.#idempotency.set(intent.idempotencyKey, receipt.txHash);
    return ok(receipt);
  }

  async getTransaction(txHash: TxHash): Promise<Result<PaymentReceipt>> {
    const receipt = this.#transactions.get(txHash);
    return receipt ? ok(receipt) : fail('not_found', `No transaction ${txHash}`);
  }

  deliver(id: InboxId, message: InboundMessage): Result<EmailMessage> {
    const found = this.#findLive(id);
    if (!found.ok) return found;
    const full: EmailMessage = {
      ...message,
      attachments: message.attachments ?? [],
      id: asMessageId(`msg_${this.#token(16)}`),
      inboxId: id,
      receivedAt: this.#timestamp(),
      read: false,
    };
    found.value.inbox.push(full);

    // Record rather than send. A simulator that made outbound HTTP calls would
    // stop being safe to run in CI.
    const hook = found.value.identity.inbox.webhookUrl;
    if (hook) found.value.webhookDeliveries.push({ url: hook, messageId: full.id });

    return ok(full);
  }

  /** Test and demo helpers. Not part of `MermailBackend`. */
  outboxOf(id: InboxId): readonly SendEmailInput[] {
    return this.#records.get(id)?.outbox ?? [];
  }

  webhookDeliveriesOf(id: InboxId): ReadonlyArray<{ url: string; messageId: MessageId }> {
    return this.#records.get(id)?.webhookDeliveries ?? [];
  }
}

/* -------------------------------------------------------------------------- */
/* Verification parsing                                                       */
/* -------------------------------------------------------------------------- */

const CODE_NEAR_KEYWORD = /(?:code|otp|pin|passcode|token)\D{0,24}?(\d{4,8})/i;
const CODE_ON_ITS_OWN = /(?:^|\n)\s*([0-9]{6})\s*(?:$|\n)/;
const VERIFY_LINK = /https?:\/\/[^\s"'<>)]*(?:verify|confirm|activate|magic|validate)[^\s"'<>)]*/i;
const ANY_LINK = /https?:\/\/[^\s"'<>)]+/i;
const UNSUBSCRIBE = /unsubscribe|preferences|privacy/i;
const EXPIRY_WINDOW = /expires?\s+in\s+(\d{1,3})\s*(second|minute|hour|day)s?/i;

const EXPIRY_UNIT_MS: Readonly<Record<string, number>> = { second: 1_000, minute: 60_000, hour: 3_600_000, day: 86_400_000 };

function readExpiry(body: string, receivedAt: string): string | null {
  const match = EXPIRY_WINDOW.exec(body);
  const unit = match?.[2]?.toLowerCase();
  if (!match?.[1] || !unit) return null;
  const ms = EXPIRY_UNIT_MS[unit];
  if (ms === undefined) return null;
  return new Date(new Date(receivedAt).getTime() + Number(match[1]) * ms).toISOString();
}

/**
 * Pulls the OTP or activation link out of a verification email.
 *
 * The confidence score exists because "the message contains six digits" is a
 * much weaker claim than "the message says CODE and then six digits", and the
 * agent refuses to auto-submit the weak ones.
 */
export function parseVerification(message: EmailMessage): ParsedVerification | undefined {
  const body = `${message.subject}\n${message.text}`;
  const expiresAt = readExpiry(body, message.receivedAt);
  const base = { sourceMessageId: message.id, receivedAt: message.receivedAt, expiresAt };
  const candidates: ParsedVerification[] = [];

  const keyed = CODE_NEAR_KEYWORD.exec(body);
  if (keyed?.[1]) {
    candidates.push({ ...base, kind: 'otp', otp: keyed[1], activationLink: null, value: keyed[1], confidence: 0.95 });
  }

  const standalone = CODE_ON_ITS_OWN.exec(message.text);
  if (standalone?.[1]) {
    candidates.push({ ...base, kind: 'otp', otp: standalone[1], activationLink: null, value: standalone[1], confidence: 0.7 });
  }

  const verifyLink = VERIFY_LINK.exec(body);
  if (verifyLink?.[0] && !UNSUBSCRIBE.test(verifyLink[0])) {
    candidates.push({ ...base, kind: 'link', otp: null, activationLink: verifyLink[0], value: verifyLink[0], confidence: 0.9 });
  } else {
    const anyLink = ANY_LINK.exec(body);
    if (anyLink?.[0] && !UNSUBSCRIBE.test(anyLink[0])) {
      candidates.push({ ...base, kind: 'link', otp: null, activationLink: anyLink[0], value: anyLink[0], confidence: 0.4 });
    }
  }

  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates[0];
}

/* -------------------------------------------------------------------------- */
/* Invoice parsing                                                            */
/* -------------------------------------------------------------------------- */

const INVOICE_ID = /\b(?:invoice|inv)\b[^A-Z0-9]{0,12}((?:INV|IN)?[-_]?[A-Z0-9][A-Z0-9-_]{3,23})/i;
const INVOICE_AMOUNT = /(?:amount\s+due|total\s+due|amount|total|due)\s*[:\-]?\s*([0-9]+(?:\.[0-9]+)?)\s*(USDC|SOL)\b/i;
const INVOICE_PAY_TO = /(?:pay\s+to|send\s+to|payable\s+to|wallet|address)\s*[:\-]?\s*([1-9A-HJ-NP-Za-km-z]{32,44})\b/i;
const INVOICE_DUE = /(?:due\s+(?:by|on|date)|payable\s+by)\s*[:\-]?\s*(\d{4}-\d{2}-\d{2}(?:T[0-9:.+Z-]+)?)/i;

function senderDomainOf(from: string): string {
  return from.split('@').at(-1)?.replace(/[>\s]/g, '').toLowerCase() ?? '';
}

/**
 * Recovers an invoice from an email body. Every field is optional in the wild,
 * so the confidence score reports how much of it actually matched and the
 * caller decides whether that is enough to pay against.
 */
export function parseInvoice(message: EmailMessage): Result<ParsedInvoice> {
  const body = `${message.subject}\n${message.text}`;

  const amountMatch = INVOICE_AMOUNT.exec(body);
  const currencyRaw = amountMatch?.[2]?.toUpperCase();
  if (!amountMatch?.[1] || !isCurrency(currencyRaw)) {
    return fail('parse_failed', 'No payable amount found in the message');
  }
  const amount = parseMoney(amountMatch[1], currencyRaw);
  if (!amount.ok) return amount;

  const payToMatch = INVOICE_PAY_TO.exec(body);
  if (!payToMatch?.[1]) {
    return fail('parse_failed', 'No destination wallet address found in the message');
  }

  const idMatch = INVOICE_ID.exec(body);
  const dueMatch = INVOICE_DUE.exec(body);
  const senderDomain = senderDomainOf(message.from);

  // Amount and destination are mandatory, so start at 0.7 and add for the rest.
  const confidence = Math.min(1, 0.7 + (idMatch ? 0.15 : 0) + (dueMatch ? 0.15 : 0));

  return ok({
    invoiceId: idMatch?.[1] ?? `parsed_${message.id}`,
    vendor: senderDomain || 'unknown',
    description: message.subject,
    amount: amount.value,
    payTo: asWalletAddress(payToMatch[1]),
    dueBy: dueMatch?.[1] ?? null,
    confidence,
    sourceMessageId: message.id,
    senderDomain,
  });
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

export interface MermailClientOptions {
  readonly backend?: MermailBackend;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export class MermailClient {
  readonly config: MermailConfig;
  readonly backend: MermailBackend;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;

  constructor(config: MermailConfig = resolveConfig(), options: MermailClientOptions = {}) {
    this.config = config;
    this.backend =
      options.backend ??
      (config.mode === 'live'
        ? new HttpBackend(config)
        : new SimulationBackend({ domain: config.domain, network: config.network, defaultTtlSeconds: config.defaultTtlSeconds }));
    this.#sleep = options.sleep ?? defaultSleep;
    this.#now = options.now ?? (() => Date.now());
  }

  get mode(): RuntimeMode {
    return this.backend.mode;
  }

  /** SPEC: createInbox(prefix?). The label is what the address is named after. */
  createInbox(input: CreateInboxInput | string): Promise<Result<AgentIdentity>> {
    return this.backend.createInbox(typeof input === 'string' ? { label: input } : input);
  }

  getInbox(id: InboxId): Promise<Result<AgentIdentity>> {
    return this.backend.getInbox(id);
  }

  listInboxes(): Promise<Result<readonly AgentIdentity[]>> {
    return this.backend.listInboxes();
  }

  expireInbox(id: InboxId): Promise<Result<AgentIdentity>> {
    return this.backend.expireInbox(id);
  }

  registerWebhook(id: InboxId, url: string): Promise<Result<AgentIdentity>> {
    return this.backend.registerWebhook(id, url);
  }

  fetchEmails(id: InboxId, filter?: EmailFilter): Promise<Result<readonly EmailMessage[]>> {
    return this.backend.fetchEmails(id, filter);
  }

  markRead(id: InboxId, messageId: MessageId): Promise<Result<void>> {
    return this.backend.markRead(id, messageId);
  }

  sendEmail(id: InboxId, input: SendEmailInput): Promise<Result<SentEmail>> {
    return this.backend.sendEmail(id, input);
  }

  getWallet(id: InboxId): Promise<Result<AgentWallet>> {
    return this.backend.getWallet(id);
  }

  fundWallet(id: InboxId, amount: Money): Promise<Result<AgentWallet>> {
    return this.backend.fundWallet(id, amount);
  }

  sendPayment(id: InboxId, intent: PaymentIntent): Promise<Result<PaymentReceipt>> {
    return this.backend.sendPayment(id, intent);
  }

  getTransaction(txHash: TxHash): Promise<Result<PaymentReceipt>> {
    return this.backend.getTransaction(txHash);
  }

  async balanceOf(id: InboxId, currency: Currency): Promise<Result<Money>> {
    const wallet = await this.getWallet(id);
    if (!wallet.ok) return wallet;
    const found = wallet.value.balances.find((b) => b.currency === currency);
    return ok(found ?? money(0n, currency));
  }

  /** Polls the inbox until `matcher` hits or the deadline passes. */
  async waitForMessage(id: InboxId, matcher: MessageMatcher, options: WaitOptions = {}): Promise<Result<EmailMessage>> {
    const timeoutMs = options.timeoutMs ?? this.config.verificationTimeoutMs;
    const interval = options.pollIntervalMs ?? this.config.pollIntervalMs;
    const deadline = this.#now() + timeoutMs;
    let attempts = 0;

    for (;;) {
      attempts += 1;
      const listed = await this.backend.fetchEmails(id, {
        ...(options.after === undefined ? {} : { since: options.after }),
        ...(options.fromContains === undefined ? {} : { fromContains: options.fromContains }),
        limit: 50,
      });
      if (!listed.ok) return listed;

      // Oldest first: if two codes arrived, the first one is the one the vendor
      // is still expecting.
      const hit = [...listed.value].reverse().find(matcher);
      if (hit) return ok(hit);

      if (this.#now() >= deadline) {
        return fail('timeout', `No matching message for ${id} after ${timeoutMs}ms (${attempts} polls)`, {
          details: { inboxId: id, attempts },
        });
      }
      await this.#sleep(interval);
    }
  }

  /** SPEC: waitForVerification(inboxId, options). */
  async waitForVerification(
    id: InboxId,
    options: WaitOptions = {},
  ): Promise<Result<{ message: EmailMessage; verification: ParsedVerification }>> {
    const minConfidence = options.minConfidence ?? 0.6;

    const found = await this.waitForMessage(
      id,
      (message) => {
        const parsed = parseVerification(message);
        return parsed !== undefined && parsed.confidence >= minConfidence;
      },
      options,
    );
    if (!found.ok) return found;

    const verification = parseVerification(found.value);
    if (!verification) return fail('parse_failed', 'Message matched but no verification artifact could be extracted');
    return ok({ message: found.value, verification });
  }

  /**
   * Waits for the first message that parses as an invoice. `skipInvoiceIds`
   * exists because a settled invoice stays in the mailbox, and without it the
   * next renewal run would find the same email and pay it again.
   */
  async waitForInvoice(
    id: InboxId,
    options: WaitOptions & { readonly skipInvoiceIds?: readonly string[] } = {},
  ): Promise<Result<{ message: EmailMessage; invoice: ParsedInvoice }>> {
    const minConfidence = options.minConfidence ?? 0.7;
    const skip = new Set(options.skipInvoiceIds ?? []);

    const found = await this.waitForMessage(
      id,
      (message) => {
        const parsed = parseInvoice(message);
        return parsed.ok && parsed.value.confidence >= minConfidence && !skip.has(parsed.value.invoiceId);
      },
      options,
    );
    if (!found.ok) return found;

    const invoice = parseInvoice(found.value);
    if (!invoice.ok) return invoice;
    return ok({ message: found.value, invoice: invoice.value });
  }
}

/** Convenience for scripts and tests: build a client straight from an env map. */
export function createClient(env: EnvLike = process.env, options: MermailClientOptions = {}): MermailClient {
  return new MermailClient(resolveConfig(env), options);
}

export type { Invoice };
export { parseMoney, money, isCurrency, CURRENCY_DECIMALS };
