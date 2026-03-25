/**
 * eval-memory.ts - End-to-end memory system evaluation
 *
 * Simulates a ghostbox agent acting as master engineer for a repo:
 * 1. Onboarding: agent explores a codebase, builds knowledge
 * 2. Feature dispatch: agent handles feature/bug requests
 * 3. Compaction survival: force new session, verify retention
 * 4. Continuity: agent picks up work using preserved memory
 * 5. Scoring: measure what was retained vs what was lost
 *
 * Usage: bun run tests/eval-memory.ts [ghost-name]
 */

const GHOST_NAME = process.argv[2] || 'evalbot';
const GHOST_MODEL = 'anthropic/claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type GhostMessage = {
  type: 'assistant' | 'tool_use' | 'tool_result' | 'result';
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  sessionId?: string;
};

const getStatePath = () => `${process.env.HOME}/.ghostbox/state.json`;
const getVaultPath = () => `${process.env.HOME}/.ghostbox/ghosts/${GHOST_NAME}/vault`;

const loadState = async () => {
  const raw = await Bun.file(getStatePath()).text();
  return JSON.parse(raw);
};

const getGhostPort = async (): Promise<number> => {
  const state = await loadState();
  return state.ghosts[GHOST_NAME]?.portBase;
};

const getGhostKey = async (): Promise<string> => {
  const state = await loadState();
  return state.ghosts[GHOST_NAME]?.apiKeys?.[0]?.key || '';
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = (phase: string, msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${phase}] ${msg}`);
};

const sendMessage = async (prompt: string, retries = 1): Promise<{ text: string; tools: string[] }> => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const port = await getGhostPort();
      const key = await getGhostKey();

      const response = await fetch(`http://localhost:${port}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.timeout(300_000),
      });

      const raw = await response.text();
      const lines = raw.trim().split('\n').filter(Boolean);
      let text = '';
      const tools: string[] = [];
      let hasError = false;

      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as GhostMessage;
          if (msg.type === 'assistant' && msg.text) text = msg.text;
          if (msg.type === 'tool_use' && msg.tool) tools.push(msg.tool);
          if (msg.type === 'result' && msg.text && !text) text = msg.text;
        } catch {
          // skip malformed lines
        }
      }

      // Check for error responses that indicate crashed session
      if (text.includes('failed while processing') || text.includes('not iterable')) {
        hasError = true;
      }

      if (hasError && attempt < retries) {
        log('RETRY', `Session may have crashed, starting new session and retrying...`);
        await newSession();
        await sleep(2000);
        continue;
      }

      return { text, tools };
    } catch (error) {
      if (attempt < retries) {
        log('RETRY', `Request failed: ${error}, retrying after new session...`);
        await newSession();
        await sleep(2000);
        continue;
      }
      return { text: '', tools: [] };
    }
  }

  return { text: '', tools: [] };
};

const newSession = async (): Promise<void> => {
  const port = await getGhostPort();
  const key = await getGhostKey();
  await fetch(`http://localhost:${port}/new`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
  });
  await sleep(2000);
};

const readVaultFile = async (path: string): Promise<string> => {
  try {
    return await Bun.file(`${getVaultPath()}/${path}`).text();
  } catch {
    return '';
  }
};

const writeVaultFile = async (path: string, content: string): Promise<void> => {
  const full = `${getVaultPath()}/${path}`;
  const dir = full.slice(0, full.lastIndexOf('/'));
  await Bun.spawn(['mkdir', '-p', dir]).exited;
  await Bun.write(full, content);
};

// ---------------------------------------------------------------------------
// Simulated codebase
// ---------------------------------------------------------------------------

const SIMULATED_CODEBASE: Record<string, string> = {
  'code/acme-api/src/server.ts': `import { Hono } from 'hono';
import { authMiddleware } from './middleware/auth';
import { rateLimiter } from './middleware/rate-limit';
import { usersRouter } from './routes/users';
import { ordersRouter } from './routes/orders';
import { webhooksRouter } from './routes/webhooks';

const app = new Hono();

app.use('*', authMiddleware);
app.use('/api/*', rateLimiter({ windowMs: 60000, max: 100 }));

app.route('/api/users', usersRouter);
app.route('/api/orders', ordersRouter);
app.route('/api/webhooks', webhooksRouter);

app.get('/health', (c) => c.json({ status: 'ok', version: '2.4.1' }));

export default { port: 3000, fetch: app.fetch };
`,
  'code/acme-api/src/middleware/auth.ts': `import { Context, Next } from 'hono';
import { verify } from 'hono/jwt';

const JWT_SECRET = process.env.JWT_SECRET!;
const PUBLIC_PATHS = ['/health', '/api/webhooks/stripe'];

export const authMiddleware = async (c: Context, next: Next) => {
  if (PUBLIC_PATHS.some(p => c.req.path.startsWith(p))) {
    return next();
  }
  const token = c.req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const payload = await verify(token, JWT_SECRET);
    c.set('userId', payload.sub);
    c.set('role', payload.role);
    return next();
  } catch {
    return c.json({ error: 'Invalid token' }, 401);
  }
};
`,
  'code/acme-api/src/routes/orders.ts': `import { Hono } from 'hono';
import { db } from '../db';
import { orders, orderItems } from '../db/schema';
import { eq } from 'drizzle-orm';
import { stripe } from '../services/stripe';

export const ordersRouter = new Hono();

ordersRouter.get('/', async (c) => {
  const userId = c.get('userId');
  const result = await db.select().from(orders).where(eq(orders.userId, userId));
  return c.json(result);
});

ordersRouter.post('/', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json();
  // BUG: no validation on body.items - crashes if undefined
  const total = body.items.reduce((sum: number, item: any) => sum + item.price * item.qty, 0);
  const [order] = await db.insert(orders).values({
    userId, total, status: 'pending',
  }).returning();
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(total * 100),
    currency: 'usd',
    metadata: { orderId: order.id },
  });
  return c.json({ order, clientSecret: intent.client_secret });
});

// TECH DEBT: O(N+1) query - loads items one by one
ordersRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const order = await db.select().from(orders).where(eq(orders.id, id));
  if (!order.length) return c.json({ error: 'Not found' }, 404);
  const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
  return c.json({ ...order[0], items });
});
`,
  'code/acme-api/src/db/schema.ts': `import { pgTable, text, integer, decimal, timestamp, uuid } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  role: text('role').notNull().default('customer'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const orders = pgTable('orders', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id).notNull(),
  total: decimal('total', { precision: 10, scale: 2 }).notNull(),
  status: text('status').notNull().default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const orderItems = pgTable('order_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  orderId: uuid('order_id').references(() => orders.id).notNull(),
  productName: text('product_name').notNull(),
  price: decimal('price', { precision: 10, scale: 2 }).notNull(),
  quantity: integer('quantity').notNull(),
});
`,
  'code/acme-api/src/services/stripe.ts': `import Stripe from 'stripe';
// ISSUE: hardcoded to test key, should use env var
export const stripe = new Stripe('sk_test_xxx', { apiVersion: '2024-04-10' });
`,
  'code/acme-api/README.md': `# Acme API
E-commerce API for Acme Corp. Handles users, orders, payments via Stripe.
## Stack: Bun + Hono + PostgreSQL + Drizzle ORM + Stripe
## Known Issues
- Order creation has no input validation (body.items can be undefined)
- Order detail endpoint has O(N+1) query
- Stripe key hardcoded in services/stripe.ts
- Rate limiter not env-configurable
- No webhook signature verification
`,
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type CheckResult = { name: string; pass: boolean; detail: string };
const checks: CheckResult[] = [];

const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ name, pass, detail });
  log('CHECK', `[${pass ? 'PASS' : 'FAIL'}] ${name}`);
};

const checkMemoryContains = async (substring: string, label: string) => {
  const memory = await readVaultFile('MEMORY.md');
  const found = memory.toLowerCase().includes(substring.toLowerCase());
  check(label, found, found ? 'Found' : 'Missing');
  return found;
};

const checkResponseMentions = (response: string, keyword: string, label: string) => {
  const found = response.toLowerCase().includes(keyword.toLowerCase());
  check(label, found, found ? 'Found' : 'Missing');
  return found;
};

// ---------------------------------------------------------------------------
// Phase 1: Setup
// ---------------------------------------------------------------------------

const phase1_setup = async () => {
  log('PHASE1', 'Seeding simulated codebase into vault...');
  for (const [path, content] of Object.entries(SIMULATED_CODEBASE)) {
    await writeVaultFile(path, content);
  }
  log('PHASE1', `Seeded ${Object.keys(SIMULATED_CODEBASE).length} files`);
};

// ---------------------------------------------------------------------------
// Phase 2: Onboarding - EXPLICIT about using ghost-memory
// ---------------------------------------------------------------------------

const phase2_onboarding = async () => {
  log('PHASE2', 'Onboarding: agent explores the codebase...');

  // Step 1: Explore
  const r1 = await sendMessage(
    `You are the master engineer for the Acme API at /vault/code/acme-api/. ` +
    `Read these files now: README.md, src/server.ts, src/routes/orders.ts, src/db/schema.ts, src/services/stripe.ts, src/middleware/auth.ts`
  );
  log('PHASE2', `Explore: ${r1.tools.length} tools`);
  await sleep(3000);

  // Step 2: Save to memory - very explicit
  const r2 = await sendMessage(
    `Now save what you learned. Run these exact commands:\n` +
    `1. ghost-memory add memory "Acme API: Bun + Hono + PostgreSQL + Drizzle ORM + Stripe payments"\n` +
    `2. ghost-memory add memory "Known bugs: orders POST has no body.items validation, O(N+1) in orders/:id, Stripe key hardcoded"\n` +
    `3. ghost-memory add memory "Files: server.ts (routes), orders.ts (main business logic), schema.ts (DB), stripe.ts (payments), auth.ts (JWT middleware)"\n` +
    `4. ghost-memory add memory "Architecture notes written to knowledge/acme-architecture.md"\n` +
    `5. ghost-memory add user "Engineering team dispatch. Care about code quality, security, and clean architecture."`
  );
  log('PHASE2', `Save: ${r2.tools.length} tools`);
  await sleep(3000);

  // Step 3: Write architecture doc
  const r3 = await sendMessage(
    `Write a detailed architecture summary of the Acme API to /vault/knowledge/acme-architecture.md. ` +
    `Include: tech stack, file structure, database schema, auth flow, known issues, and the Stripe integration pattern.`
  );
  log('PHASE2', `Arch doc: ${r3.tools.length} tools`);
  await sleep(3000);

  // Verify
  await checkMemoryContains('hono', 'Memory: tech stack');
  await checkMemoryContains('stripe', 'Memory: Stripe noted');
  await checkMemoryContains('acme', 'Memory: project name');
  await checkMemoryContains('validation', 'Memory: known bugs');
  const archFile = await readVaultFile('knowledge/acme-architecture.md');
  check('Knowledge file created', archFile.length > 100, `${archFile.length} chars`);
};

// ---------------------------------------------------------------------------
// Phase 3: Bug dispatch
// ---------------------------------------------------------------------------

const phase3_bug_dispatch = async () => {
  log('PHASE3', 'Bug dispatch...');

  const r = await sendMessage(
    `DISPATCH [BUG-2847]: POST /api/orders crashes when body has no items field. ` +
    `Fix it in /vault/code/acme-api/src/routes/orders.ts - add validation at the top of the POST handler. ` +
    `Then run: ghost-memory add memory "Fixed BUG-2847: added items array validation to orders POST endpoint"`
  );
  log('PHASE3', `${r.tools.length} tools`);
  await sleep(3000);

  const ordersFile = await readVaultFile('code/acme-api/src/routes/orders.ts');
  const hasValidation = ordersFile.includes('Array.isArray') ||
    ordersFile.includes('!body.items') ||
    ordersFile.includes('body?.items') ||
    ordersFile.includes('validate') ||
    ordersFile.includes('items') && ordersFile.includes('400');
  check('Bug fix applied', hasValidation, hasValidation ? 'Validation found' : 'No validation');
  await checkMemoryContains('BUG-2847', 'Memory: bug ticket saved');
};

// ---------------------------------------------------------------------------
// Phase 4: Feature dispatch
// ---------------------------------------------------------------------------

const phase4_feature_dispatch = async () => {
  log('PHASE4', 'Feature dispatch...');

  const r = await sendMessage(
    `DISPATCH [FEAT-1023]: Add PATCH /api/orders/:id/status endpoint to /vault/code/acme-api/src/routes/orders.ts. ` +
    `Only role=admin can use it. Valid transitions: pending->confirmed->shipped->delivered. ` +
    `After implementing, run: ghost-memory add memory "Implemented FEAT-1023: order status PATCH endpoint with admin auth and state machine"`
  );
  log('PHASE4', `${r.tools.length} tools`);
  await sleep(3000);

  const ordersFile = await readVaultFile('code/acme-api/src/routes/orders.ts');
  const hasPatch = ordersFile.toLowerCase().includes('patch') || ordersFile.includes('status');
  check('Feature implemented', hasPatch, hasPatch ? 'Status endpoint found' : 'Missing');
  await checkMemoryContains('FEAT-1023', 'Memory: feature ticket saved');
};

// ---------------------------------------------------------------------------
// Phase 5: COMPACTION SURVIVAL
// ---------------------------------------------------------------------------

const phase5_compaction_survival = async () => {
  log('PHASE5', '=== COMPACTION SURVIVAL TEST ===');

  const memBefore = await readVaultFile('MEMORY.md');
  const userBefore = await readVaultFile('USER.md');
  log('PHASE5', `Pre-compaction: MEMORY=${memBefore.length}c, USER=${userBefore.length}c`);

  await newSession();
  log('PHASE5', 'New session. Testing retention without tools...');

  // Test 1: Project knowledge
  const r1 = await sendMessage(
    'Without running any tools: what project do you manage, what is its tech stack, and name 2 known issues.'
  );
  checkResponseMentions(r1.text, 'acme', 'Retention: project name');
  checkResponseMentions(r1.text, 'hono', 'Retention: framework');
  const knowsIssues = r1.text.toLowerCase().includes('validation') ||
    r1.text.toLowerCase().includes('hardcoded') ||
    r1.text.toLowerCase().includes('stripe');
  check('Retention: knows issues', knowsIssues, knowsIssues ? 'Issues recalled' : 'Issues lost');

  // Test 2: Dispatch history
  const r2 = await sendMessage(
    'Without tools: what dispatch requests have you handled? Give ticket numbers and one-line descriptions.'
  );
  const knowsBug = r2.text.includes('2847');
  const knowsFeat = r2.text.includes('1023');
  check('Retention: bug ticket', knowsBug, knowsBug ? 'BUG-2847 recalled' : 'Lost');
  check('Retention: feature ticket', knowsFeat, knowsFeat ? 'FEAT-1023 recalled' : 'Lost');

  // Test 3: Deep recall via qmd
  const r3 = await sendMessage(
    'Use qmd to read your architecture notes at knowledge/acme-architecture.md. What database and ORM does the project use?'
  );
  checkResponseMentions(r3.text, 'postgres', 'Deep recall: database');
  checkResponseMentions(r3.text, 'drizzle', 'Deep recall: ORM');
};

// ---------------------------------------------------------------------------
// Phase 6: Post-compaction work
// ---------------------------------------------------------------------------

const phase6_continuity = async () => {
  log('PHASE6', 'Post-compaction security dispatch...');

  const r = await sendMessage(
    `DISPATCH [SEC-0091]: Fix the hardcoded Stripe API key in /vault/code/acme-api/src/services/stripe.ts. ` +
    `Use process.env.STRIPE_SECRET_KEY instead. ` +
    `Then run: ghost-memory add memory "Fixed SEC-0091: Stripe key now uses env var"`,
    1, // retry on crash
  );
  log('PHASE6', `${r.tools.length} tools`);
  await sleep(3000);

  const stripeFile = await readVaultFile('code/acme-api/src/services/stripe.ts');
  const usesEnv = stripeFile.includes('process.env');
  check('Security fix applied', usesEnv, usesEnv ? 'Uses env var' : 'Still hardcoded');
  await checkMemoryContains('SEC-0091', 'Memory: security ticket saved');
};

// ---------------------------------------------------------------------------
// Phase 7: Second compaction
// ---------------------------------------------------------------------------

const phase7_second_compaction = async () => {
  log('PHASE7', '=== SECOND COMPACTION ===');

  await newSession();

  const r = await sendMessage(
    'Without tools: give me a full status report. What project, what tickets handled (numbers), what is still on the known issues list?'
  );

  checkResponseMentions(r.text, 'acme', 'Final: project name');
  const ticketCount = [r.text.includes('2847'), r.text.includes('1023'), r.text.includes('0091')].filter(Boolean).length;
  check('Final: ticket recall', ticketCount >= 2, `${ticketCount}/3 tickets recalled`);

  const mentionsIssues = r.text.toLowerCase().includes('n+1') ||
    r.text.toLowerCase().includes('webhook') ||
    r.text.toLowerCase().includes('rate limit');
  check('Final: knows remaining issues', mentionsIssues, mentionsIssues ? 'Issues noted' : 'Issues lost');
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const printScore = () => {
  console.log('\n' + '='.repeat(60));
  console.log('MEMORY SYSTEM EVALUATION RESULTS');
  console.log('='.repeat(60));

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const pct = Math.round((passed / total) * 100);

  console.log(`\nScore: ${passed}/${total} (${pct}%)\n`);

  for (const c of checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}`);
  }

  console.log('\n' + '='.repeat(60));
  if (pct >= 80) console.log('VERDICT: Production-ready');
  else if (pct >= 60) console.log('VERDICT: Functional with gaps');
  else if (pct >= 40) console.log('VERDICT: Partial - needs iteration');
  else console.log('VERDICT: Needs significant work');
  console.log('='.repeat(60));
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  console.log('='.repeat(60));
  console.log('GHOSTBOX MEMORY EVAL');
  console.log(`Ghost: ${GHOST_NAME} | Model: ${GHOST_MODEL}`);
  console.log('='.repeat(60) + '\n');

  const port = await getGhostPort();
  if (!port) {
    console.error(`Ghost "${GHOST_NAME}" not found.`);
    process.exit(1);
  }

  try {
    const health = await fetch(`http://localhost:${port}/health`);
    if (!health.ok) throw new Error('not healthy');
  } catch {
    console.error(`Ghost not healthy on port ${port}`);
    process.exit(1);
  }

  await newSession();
  const start = Date.now();

  try {
    await phase1_setup();
    await phase2_onboarding();
    await phase3_bug_dispatch();
    await phase4_feature_dispatch();
    await phase5_compaction_survival();
    await phase6_continuity();
    await phase7_second_compaction();
  } catch (error) {
    log('ERROR', `${error}`);
  }

  log('DONE', `${Math.round((Date.now() - start) / 1000)}s elapsed`);
  printScore();
};

main().catch(console.error);
