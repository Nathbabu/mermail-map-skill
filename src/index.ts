#!/usr/bin/env node
/**
 * Interactive CLI demo and REST API server (SPEC component 5).
 *
 *   map-skill demo    both workflows end to end, printing every step
 *   map-skill repl    interactive shell over the same tools
 *   map-skill serve   REST wrapper, one route per tool, plus a webhook sink
 *
 * All three run against the simulator unless MERMAIL_API_KEY is set, so the
 * demo works on a fresh clone with no configuration at all.
 */

import { createInterface } from 'node:readline/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';

import { MermailClient, SimulationBackend, isMessageSink, resolveConfig } from './mermail-client.js';
import { ProvisioningAgent, SimulatedVendor } from './agent.js';
import { MermailSkill, type ToolCallResult } from './skill.js';
import { asInboxId, type TrustedVendor, type WorkflowStep } from './types.js';

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/** Minimal .env reader. Existing environment variables always win. */
function loadDotEnv(path = '.env'): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match?.[1]) continue;
    if (process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = (match[2] ?? '').trim().replace(/^["']|["']$/g, '');
  }
}

export interface Runtime {
  readonly client: MermailClient;
  readonly agent: ProvisioningAgent;
  readonly skill: MermailSkill;
  readonly vendorName: string;
  /** Present only in simulation, where a fake vendor can post mail. */
  readonly demoVendor: SimulatedVendor | undefined;
}

export function createRuntime(onStep?: (step: WorkflowStep) => void): Runtime {
  const config = resolveConfig(process.env);
  const client = new MermailClient(config);
  const agent = new ProvisioningAgent(client, {
    ...(onStep ? { onStep } : {}),
    // In simulation the operator is right here at the terminal, so approve
    // anything the policy is merely cautious about and refuse hard violations.
    onApprovalRequired: async (invoice, reason) => {
      process.stderr.write(`  approval requested for ${invoice.amount.amount} ${invoice.amount.currency}: ${reason}\n`);
      return client.mode === 'simulation';
    },
  });

  const skill = new MermailSkill(client, { agent });
  let demoVendor: SimulatedVendor | undefined;
  if (client.backend instanceof SimulationBackend) {
    demoVendor = [...skill.context.vendors.values()].find((v): v is SimulatedVendor => v instanceof SimulatedVendor);
    if (!demoVendor) {
      demoVendor = new SimulatedVendor(client.backend);
      skill.registerVendor(demoVendor);
    }
  }

  const vendorName = [...skill.context.vendors.values()][0]?.name ?? 'none';
  return { client, agent, skill, vendorName, demoVendor };
}

const banner = (runtime: Runtime): string =>
  [
    `MAP-Skill 0.2.0  mode=${runtime.client.mode}  network=${runtime.client.config.network}`,
    runtime.client.mode === 'simulation'
      ? 'Running on the built-in simulator. Set MERMAIL_API_KEY in .env to talk to the real API.'
      : `Live against ${runtime.client.config.apiUrl}.`,
  ].join('\n');

function renderResult(result: ToolCallResult): string {
  const body = result.content.map((c) => c.text).join('\n');
  return result.isError ? `error: ${body}` : body;
}

/* -------------------------------------------------------------------------- */
/* demo                                                                       */
/* -------------------------------------------------------------------------- */

export async function runDemo(plan = 'starter'): Promise<number> {
  const runtime = createRuntime((step) => {
    stdout.write(`  [${step.status === 'ok' ? ' ok ' : 'FAIL'}] ${step.name.padEnd(18)} ${step.detail}  (${step.durationMs}ms)\n`);
  });

  stdout.write(`${banner(runtime)}\n\n`);

  stdout.write(`Use case 1: register with ${runtime.vendorName} and pay for the "${plan}" plan\n`);
  const procured = await runtime.skill.callTool('mermail_procure_subscription', {
    vendor: runtime.vendorName,
    plan,
    budgetUsdc: '20.000000',
    displayName: 'Autonomous Buyer',
  });
  stdout.write(`\n${renderResult(procured)}\n`);
  if (procured.isError || !runtime.demoVendor) return procured.isError ? 1 : 0;

  const identity = (procured.structuredContent as { identity: { id: string } }).identity;
  const inboxId = asInboxId(identity.id);

  stdout.write(`\nUse case 2: a renewal invoice arrives by email and gets settled\n`);
  const trusted: TrustedVendor[] = [runtime.demoVendor.asTrustedVendor(15)];
  runtime.demoVendor.issueRenewalInvoice(inboxId, { amountUsdc: '5.000000' });

  const renewed = await runtime.skill.callTool('mermail_renew_subscription', {
    inboxId,
    trustedVendors: trusted,
    budgetUsdc: '10.000000',
    timeoutMs: 5_000,
  });
  stdout.write(`\n${renderResult(renewed)}\n`);
  if (renewed.isError) return 1;

  stdout.write(`\nA spoofed invoice from the same vendor name, paid to a different wallet:\n`);
  const spoofSentAt = new Date().toISOString();
  runtime.demoVendor.issueRenewalInvoice(inboxId, {
    amountUsdc: '5.000000',
    invoiceId: 'INV-SPOOF',
    payTo: 'AttackerWa11et11111111111111111111111111111' as never,
  });
  const spoofed = await runtime.skill.callTool('mermail_renew_subscription', {
    inboxId,
    trustedVendors: trusted,
    after: spoofSentAt,
    timeoutMs: 5_000,
  });
  stdout.write(`${renderResult(spoofed)}\n`);

  const inboxes = await runtime.skill.callTool('mermail_list_inboxes', {});
  stdout.write(`\nInboxes after the run:\n${renderResult(inboxes)}\n`);
  return spoofed.isError ? 0 : 1;
}

/* -------------------------------------------------------------------------- */
/* repl                                                                       */
/* -------------------------------------------------------------------------- */

const REPL_HELP = `
Commands
  provision <label>              mint an inbox and wallet
  inboxes                        list everything provisioned so far
  emails <inboxId> [n]           read the newest n messages (default 5)
  wait <inboxId>                 block until a verification code arrives
  invoice <inboxId>              parse the newest invoice in the inbox
  bill <inboxId> [amount]        simulator only: have the demo vendor send an invoice
  renew <inboxId>                settle the newest invoice from the demo vendor
  fund <inboxId> <amount>        top up USDC from the faucet
  balance <inboxId>              wallet address and balances
  pay <inboxId> <to> <amount>    send USDC, subject to the spend policy
  procure <plan>                 run the registration workflow against the demo vendor
  expire <inboxId>               retire an address early
  tools                          list tool names and titles
  call <tool> <json>             call any tool directly with raw arguments
  policy                         show the active spend limits
  help                           this list
  exit                           leave
`.trim();

export async function runRepl(): Promise<number> {
  const runtime = createRuntime();
  // Iterating the interface pauses the input stream while a handler is awaiting.
  // Looping on rl.question() instead loses every line typed or piped during a
  // slow call, which is exactly what `procure` is.
  const rl = createInterface({ input: stdin, output: stdout, prompt: 'map> ' });

  stdout.write(`${banner(runtime)}\n\nType "help" for commands.\n`);
  rl.prompt();

  for await (const raw of rl) {
    const line = raw.trim();
    if (line !== '') {
      const [command = '', ...rest] = line.split(/\s+/);

      if (command === 'exit' || command === 'quit') break;

      if (command === 'help') {
        stdout.write(`${REPL_HELP}\n`);
      } else if (command === 'tools') {
        for (const tool of runtime.skill.listTools()) {
          stdout.write(`  ${tool.name.padEnd(30)} ${tool.title}${tool.destructive ? '  [writes]' : ''}\n`);
        }
      } else if (command === 'policy') {
        stdout.write(`${JSON.stringify(runtime.agent.policy, null, 2)}\n`);
        stdout.write(`spent this session: ~${runtime.agent.spentUsd.toFixed(2)} USD\n`);
      } else if (command === 'bill') {
        stdout.write(`${billFromDemoVendor(runtime, rest)}\n`);
      } else if (command === 'expire') {
        if (rest[0] === undefined) {
          stdout.write('usage: expire <inboxId>\n');
        } else {
          const expired = await runtime.client.expireInbox(asInboxId(rest[0]));
          stdout.write(expired.ok ? `${expired.value.inbox.address} is now ${expired.value.inbox.status}\n` : `error: ${expired.error.message}\n`);
        }
      } else {
        const call = translate(command, rest, runtime, line);
        if (call === undefined) {
          stdout.write(`Unknown command "${command}". Type "help".\n`);
        } else if (typeof call === 'string') {
          stdout.write(`${call}\n`);
        } else {
          const result = await runtime.skill.callTool(call.tool, call.args);
          stdout.write(`${renderResult(result)}\n`);
        }
      }
    }
    rl.prompt();
  }

  rl.close();
  return 0;
}

function billFromDemoVendor(runtime: Runtime, rest: readonly string[]): string {
  if (!runtime.demoVendor) return 'bill only works against the simulator';
  if (rest.length < 1) return 'usage: bill <inboxId> [amount]';
  const issued = runtime.demoVendor.issueRenewalInvoice(asInboxId(rest[0] as string), {
    ...(rest[1] === undefined ? {} : { amountUsdc: rest[1] }),
  });
  return issued.ok ? 'Invoice delivered.' : `error: ${issued.error.message}`;
}

type TranslatedCall = { tool: string; args: Record<string, unknown> };

/** Maps a REPL line onto a tool call, or returns an error string to print. */
function translate(command: string, rest: readonly string[], runtime: Runtime, raw: string): TranslatedCall | string | undefined {
  const need = (n: number, usage: string): string | undefined => (rest.length < n ? `usage: ${usage}` : undefined);
  const trusted = runtime.demoVendor ? [runtime.demoVendor.asTrustedVendor(15)] : [];

  switch (command) {
    case 'provision':
      return need(1, 'provision <label>') ?? { tool: 'mermail_create_inbox', args: { label: rest.join(' ') } };
    case 'inboxes':
      return { tool: 'mermail_list_inboxes', args: {} };
    case 'emails': {
      const usage = need(1, 'emails <inboxId> [n]');
      if (usage) return usage;
      const limit = rest[1] === undefined ? 5 : Number(rest[1]);
      return { tool: 'mermail_fetch_emails', args: { inboxId: rest[0], limit: Number.isFinite(limit) ? limit : 5 } };
    }
    case 'wait':
      return need(1, 'wait <inboxId>') ?? { tool: 'mermail_wait_for_otp', args: { inboxId: rest[0], timeoutMs: 15_000 } };
    case 'invoice':
      return need(1, 'invoice <inboxId>') ?? { tool: 'mermail_parse_invoice', args: { inboxId: rest[0] } };
    case 'renew':
      return (
        need(1, 'renew <inboxId>') ?? {
          tool: 'mermail_renew_subscription',
          args: { inboxId: rest[0], trustedVendors: trusted, timeoutMs: 5_000 },
        }
      );
    case 'fund':
      return need(2, 'fund <inboxId> <amount>') ?? { tool: 'mermail_wallet_fund', args: { inboxId: rest[0], amount: rest[1] } };
    case 'balance':
      return need(1, 'balance <inboxId>') ?? { tool: 'mermail_wallet_balance', args: { inboxId: rest[0] } };
    case 'pay':
      return (
        need(3, 'pay <inboxId> <to> <amount>') ?? {
          tool: 'mermail_wallet_pay',
          args: { inboxId: rest[0], to: rest[1], amount: rest[2] },
        }
      );
    case 'procure':
      return (
        need(1, 'procure <plan>') ?? {
          tool: 'mermail_procure_subscription',
          args: { vendor: runtime.vendorName, plan: rest[0], displayName: 'Autonomous Buyer' },
        }
      );
    case 'call': {
      const usage = need(1, 'call <tool> <json>');
      if (usage) return usage;
      const jsonStart = raw.indexOf(rest[0] ?? '') + (rest[0]?.length ?? 0);
      const payload = raw.slice(jsonStart).trim();
      try {
        return { tool: rest[0] as string, args: payload === '' ? {} : (JSON.parse(payload) as Record<string, unknown>) };
      } catch {
        return 'arguments must be valid JSON';
      }
    }
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* serve                                                                      */
/* -------------------------------------------------------------------------- */

const MAX_BODY_BYTES = 256 * 1024;

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('body must be a JSON object');
  return parsed as Record<string, unknown>;
}

function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function createRestServer(runtime: Runtime = createRuntime()) {
  return createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      try {
        if (req.method === 'GET' && (path === '/' || path === '/health')) {
          return send(res, 200, { status: 'ok', mode: runtime.client.mode, network: runtime.client.config.network, vendor: runtime.vendorName });
        }

        if (req.method === 'GET' && path === '/tools') {
          return send(res, 200, { tools: runtime.skill.toMcpTools() });
        }

        if (req.method === 'POST' && path.startsWith('/tools/')) {
          const name = decodeURIComponent(path.slice('/tools/'.length));
          const result = await runtime.skill.callTool(name, await readJsonBody(req));
          return send(res, result.isError ? 400 : 200, result);
        }

        if (req.method === 'GET' && path === '/inboxes') {
          return send(res, 200, await runtime.skill.callTool('mermail_list_inboxes', {}));
        }

        if (req.method === 'POST' && path === '/inboxes') {
          const result = await runtime.skill.callTool('mermail_create_inbox', await readJsonBody(req));
          return send(res, result.isError ? 400 : 201, result);
        }

        const messages = /^\/inboxes\/([^/]+)\/messages$/.exec(path);
        if (req.method === 'GET' && messages?.[1]) {
          const limit = Number(url.searchParams.get('limit') ?? 10);
          const result = await runtime.skill.callTool('mermail_fetch_emails', {
            inboxId: decodeURIComponent(messages[1]),
            limit: Number.isFinite(limit) ? limit : 10,
          });
          return send(res, result.isError ? 404 : 200, result);
        }

        // Inbound webhook. In live mode Mermail posts here; in simulation this
        // is how an external script injects a message without the CLI.
        if (req.method === 'POST' && path === '/webhooks/mermail') {
          const body = await readJsonBody(req);
          if (!isMessageSink(runtime.client.backend)) {
            return send(res, 501, { error: 'webhook ingest is only available against the simulator' });
          }
          const inboxId = str(body['inboxId']);
          if (inboxId === '') return send(res, 400, { error: 'inboxId is required' });

          const delivered = runtime.client.backend.deliver(asInboxId(inboxId), {
            from: str(body['from']) || 'unknown@example',
            to: str(body['to']),
            subject: str(body['subject']),
            text: str(body['text']),
            headers: {},
          });
          return delivered.ok
            ? send(res, 202, { accepted: true, messageId: delivered.value.id })
            : send(res, 400, delivered.error.toJSON());
        }

        if (req.method === 'POST' && path === '/procure') {
          const body = await readJsonBody(req);
          const result = await runtime.skill.callTool('mermail_procure_subscription', { vendor: runtime.vendorName, ...body });
          return send(res, result.isError ? 400 : 200, result);
        }

        if (req.method === 'POST' && path === '/renew') {
          const result = await runtime.skill.callTool('mermail_renew_subscription', await readJsonBody(req));
          return send(res, result.isError ? 400 : 200, result);
        }

        return send(res, 404, { error: `no route for ${req.method} ${path}` });
      } catch (error) {
        // Message only. Stack traces and internal paths stay out of responses.
        return send(res, 400, { error: error instanceof Error ? error.message : 'request failed' });
      }
    })();
  });
}

export async function runServer(): Promise<number> {
  const runtime = createRuntime();
  const port = Number(process.env['PORT'] ?? 8787);
  const host = process.env['HOST'] ?? '127.0.0.1';
  const server = createRestServer(runtime);

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  stdout.write(`${banner(runtime)}\n\nListening on http://${host}:${port}\n`);
  stdout.write('  GET  /tools\n  POST /tools/:name\n  POST /inboxes\n  GET  /inboxes/:id/messages\n  POST /webhooks/mermail\n  POST /procure\n  POST /renew\n');

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      server.close(() => resolve());
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return 0;
}

/* -------------------------------------------------------------------------- */
/* main                                                                       */
/* -------------------------------------------------------------------------- */

const USAGE = `
map-skill <command>

  demo [plan]   run both workflows and print the step log
  repl          interactive shell (default)
  serve         REST server on PORT (default 8787)
  tools         print the tool schemas as JSON
  help          this message
`.trim();

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  loadDotEnv();
  const command = argv[0] ?? 'repl';

  switch (command) {
    case 'demo':
      return runDemo(argv[1] ?? 'starter');
    case 'repl':
      return runRepl();
    case 'serve':
      return runServer();
    case 'tools':
      stdout.write(`${JSON.stringify(createRuntime().skill.toMcpTools(), null, 2)}\n`);
      return 0;
    case 'help':
    case '--help':
    case '-h':
      stdout.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

export { MermailClient, MermailSkill, ProvisioningAgent, SimulatedVendor };
export * from './types.js';
