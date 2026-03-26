/**
 * eval-orchestrator.ts - End-to-end orchestrator evaluation
 *
 * Simulates a ghostbox agent acting as an engineering manager:
 * 1. Onboarding: agent explores a codebase, builds knowledge proactively
 * 2. Incident handling: investigates a production crash
 * 3. Dispatch issue creation: frames work for a principal engineer
 * 4. Contract review: approves a good contract with real scrutiny
 * 5. Implementation review: accepts a good fix
 * 6. Contract rejection: catches scope creep and breaking changes
 * 7. Implementation rejection: catches a dangerous regression and weak review
 * 8. Compaction survival: force new session, verify retained context
 * 9. Second compaction: verify continuity again from a fresh session
 *
 * Usage: bun run tests/eval-orchestrator.ts [ghost-name]
 */

import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";

const GHOST_NAME = process.argv[2] || "evalbot";
const GHOST_MODEL = "anthropic/claude-sonnet-4-6";
const MESSAGE_SETTLE_MS = 3500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type GhostMessage = {
  type: "assistant" | "tool_use" | "tool_result" | "result";
  text?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  sessionId?: string;
};

type FixtureValue = string | unknown;
type ScenarioFixtures = Record<string, FixtureValue>;

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
  return state.ghosts[GHOST_NAME]?.apiKeys?.[0]?.key || "";
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const log = (phase: string, msg: string) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${phase}] ${msg}`);
};

const normalize = (value: string) => value.toLowerCase();
const containsAny = (text: string, keywords: string[]) => {
  const haystack = normalize(text);
  return keywords.some((keyword) => haystack.includes(normalize(keyword)));
};
const countMentions = (text: string, keywords: string[]) => {
  const haystack = normalize(text);
  return keywords.filter((keyword) => haystack.includes(normalize(keyword))).length;
};

const sendMessage = async (prompt: string, retries = 1): Promise<{ text: string; tools: string[] }> => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const port = await getGhostPort();
      const key = await getGhostKey();

      const response = await fetch(`http://localhost:${port}/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`
        },
        body: JSON.stringify({ prompt }),
        signal: AbortSignal.timeout(300_000)
      });

      const raw = await response.text();
      const lines = raw.trim().split("\n").filter(Boolean);
      const assistantParts: string[] = [];
      const tools: string[] = [];

      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as GhostMessage;
          if (msg.type === "assistant" && msg.text) assistantParts.push(msg.text);
          if (msg.type === "tool_use" && msg.tool) tools.push(msg.tool);
          if (msg.type === "result" && msg.text && assistantParts.length === 0) assistantParts.push(msg.text);
        } catch {
          // skip malformed lines
        }
      }

      const text = assistantParts.join("\n").trim();
      const rawLower = raw.toLowerCase();
      const hasError =
        !response.ok ||
        rawLower.includes("failed while processing") ||
        rawLower.includes("not iterable") ||
        rawLower.includes("session crashed") ||
        rawLower.includes("exception") ||
        rawLower.includes('"error"');

      if (hasError && attempt < retries) {
        log("RETRY", "Session may have crashed, starting new session and retrying...");
        await newSession();
        await sleep(2000);
        continue;
      }

      return { text, tools };
    } catch (error) {
      if (attempt < retries) {
        log("RETRY", `Request failed: ${error}, retrying after new session...`);
        await newSession();
        await sleep(2000);
        continue;
      }
      return { text: "", tools: [] };
    }
  }

  return { text: "", tools: [] };
};

const newSession = async (): Promise<void> => {
  const port = await getGhostPort();
  const key = await getGhostKey();
  await fetch(`http://localhost:${port}/new`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` }
  });
  await sleep(2000);
};

const readVaultFile = async (path: string): Promise<string> => {
  try {
    return await Bun.file(`${getVaultPath()}/${path}`).text();
  } catch {
    return "";
  }
};

const writeVaultFile = async (path: string, content: string): Promise<void> => {
  const full = `${getVaultPath()}/${path}`;
  const dir = full.slice(0, full.lastIndexOf("/"));
  await Bun.spawn(["mkdir", "-p", dir]).exited;
  await Bun.write(full, content);
};

// ---------------------------------------------------------------------------
// Simulated codebase
// ---------------------------------------------------------------------------

const SIMULATED_CODEBASE: Record<string, string> = {
  "code/acme-api/src/server.ts": `import { Hono } from 'hono';
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
  "code/acme-api/src/middleware/auth.ts": `import { Context, Next } from 'hono';
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
  "code/acme-api/src/routes/orders.ts": `import { Hono } from 'hono';
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
  "code/acme-api/src/db/schema.ts": `import { pgTable, text, integer, decimal, timestamp, uuid } from 'drizzle-orm/pg-core';

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
  "code/acme-api/src/services/stripe.ts": `import Stripe from 'stripe';
// ISSUE: hardcoded to test key, should use env var
export const stripe = new Stripe('sk_test_xxx', { apiVersion: '2024-04-10' });
`,
  "code/acme-api/README.md": `# Acme API
E-commerce API for Acme Corp. Handles users, orders, payments via Stripe.
## Stack: Bun + Hono + PostgreSQL + Drizzle ORM + Stripe
## Known Issues
- Order creation has no input validation (body.items can be undefined)
- Order detail endpoint has O(N+1) query
- Stripe key hardcoded in services/stripe.ts
- Rate limiter not env-configurable
- No webhook signature verification
`
};

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const getScenarioPath = (scenario: string) => join(process.cwd(), "tests", "fixtures", scenario);

const loadScenarioFixtures = async (scenario: string): Promise<ScenarioFixtures> => {
  const dir = getScenarioPath(scenario);
  const fixtures: ScenarioFixtures = {};
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name);
    if (ext !== ".json" && ext !== ".txt") continue;
    const fullPath = join(dir, entry.name);
    const raw = await Bun.file(fullPath).text();
    fixtures[entry.name] = ext === ".json" ? JSON.parse(raw) : raw.trimEnd();
  }

  return fixtures;
};

const requireTextFixture = (fixtures: ScenarioFixtures, name: string) => {
  const value = fixtures[name];
  if (typeof value !== "string") {
    throw new Error(`Missing text fixture "${name}"`);
  }
  return value;
};

const requireJsonFixture = <T>(fixtures: ScenarioFixtures, name: string): T => {
  const value = fixtures[name];
  if (typeof value === "string" || value === undefined) {
    throw new Error(`Missing JSON fixture "${name}"`);
  }
  return value as T;
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

type CheckResult = { phase: string; name: string; pass: boolean; detail: string };
const checks: CheckResult[] = [];
const phaseToolCounts: Record<string, number> = {};
let currentPhase = "SETUP";

const check = (name: string, pass: boolean, detail: string) => {
  checks.push({ phase: currentPhase, name, pass, detail });
  log("CHECK", `[${pass ? "PASS" : "FAIL"}] ${currentPhase}: ${name}`);
};

const _checkMemoryContains = async (substring: string, label: string) => {
  const memory = await readVaultFile("MEMORY.md");
  const found = memory.toLowerCase().includes(substring.toLowerCase());
  check(label, found, found ? "Found" : "Missing");
  return found;
};

const checkResponseMentions = (response: string, keyword: string, label: string) => {
  const found = response.toLowerCase().includes(keyword.toLowerCase());
  check(label, found, found ? "Found" : "Missing");
  return found;
};

const startPhase = (phase: string, message: string) => {
  currentPhase = phase;
  log(phase, message);
};

const trackTools = (tools: string[], label: string) => {
  phaseToolCounts[currentPhase] = (phaseToolCounts[currentPhase] || 0) + tools.length;
  const suffix = tools.length ? ` [${tools.join(", ")}]` : "";
  log(currentPhase, `${label}: ${tools.length} tools${suffix}`);
};

const listKnowledgeFiles = async (): Promise<string[]> => {
  const base = `${getVaultPath()}/knowledge`;

  const walk = async (dir: string, prefix = ""): Promise<string[]> => {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          files.push(...(await walk(join(dir, entry.name), rel)));
          continue;
        }
        if (entry.name === ".gitkeep") continue;
        files.push(rel);
      }
      return files;
    } catch {
      return [];
    }
  };

  return walk(base);
};

const onboardingSnapshot = {
  memoryBefore: "",
  knowledgeFilesBefore: [] as string[]
};

const scenarioData = {
  incident001: {} as ScenarioFixtures,
  feature001: {} as ScenarioFixtures,
  feature002: {} as ScenarioFixtures
};

// ---------------------------------------------------------------------------
// Phase 1: Setup
// ---------------------------------------------------------------------------

const phase1_setup = async () => {
  startPhase("SETUP", "Seeding simulated codebase into vault...");
  for (const [path, content] of Object.entries(SIMULATED_CODEBASE)) {
    await writeVaultFile(path, content);
  }

  scenarioData.incident001 = await loadScenarioFixtures("incident-001");
  scenarioData.feature001 = await loadScenarioFixtures("feature-001");
  scenarioData.feature002 = await loadScenarioFixtures("feature-002");

  onboardingSnapshot.memoryBefore = await readVaultFile("MEMORY.md");
  onboardingSnapshot.knowledgeFilesBefore = await listKnowledgeFiles();

  log("SETUP", `Seeded ${Object.keys(SIMULATED_CODEBASE).length} files`);
  log(
    "SETUP",
    `Loaded fixtures: incident-001=${Object.keys(scenarioData.incident001).length}, feature-001=${Object.keys(scenarioData.feature001).length}, feature-002=${Object.keys(scenarioData.feature002).length}`
  );
};

// ---------------------------------------------------------------------------
// Phase 2: Onboard
// ---------------------------------------------------------------------------

const phase2_onboard = async () => {
  startPhase("PROACTIVENESS", "Onboarding: agent explores the repo without any memory instructions...");

  const r = await sendMessage(
    "You are the engineering manager for the Acme API codebase at /vault/code/acme-api/. " +
      "Your role is to manage this repo through the Dispatch system. You receive production signals and user feedback, " +
      "create dispatch issues, monitor principal engineers, review their output, and ensure code quality. " +
      "You never write code yourself - you orchestrate agents who do. Explore the codebase now and get familiar " +
      "with the architecture, tech stack, and known issues."
  );
  trackTools(r.tools, "Onboarding");
  await sleep(MESSAGE_SETTLE_MS);

  const memoryAfter = await readVaultFile("MEMORY.md");
  const knowledgeAfter = await listKnowledgeFiles();
  const newKnowledgeFiles = knowledgeAfter.filter((file) => !onboardingSnapshot.knowledgeFilesBefore.includes(file));
  const memoryChanged = memoryAfter !== onboardingSnapshot.memoryBefore;

  check("Memory file has entries", memoryAfter.trim().length > 0, `${memoryAfter.trim().length} chars`);
  check("Memory changed without prompting", memoryChanged, memoryChanged ? "Updated" : "Unchanged");
  check("Agent used tools during onboarding", r.tools.length > 0, `${r.tools.length} tools`);
  check(
    "Knowledge files created during onboarding",
    newKnowledgeFiles.length > 0,
    newKnowledgeFiles.join(", ") || "None"
  );
};

// ---------------------------------------------------------------------------
// Phase 3: Incident
// ---------------------------------------------------------------------------

const phase3_incident = async () => {
  startPhase("INCIDENT", "Production crash signal...");

  const signal = requireTextFixture(scenarioData.incident001, "signal.txt");
  const r = await sendMessage(`PRODUCTION ALERT: ${signal}`);
  trackTools(r.tools, "Incident response");
  await sleep(MESSAGE_SETTLE_MS);

  const researched = containsAny(r.text, [
    "investigat",
    "research",
    "inspect",
    "trace",
    "look into",
    "review the code"
  ]);
  check(
    "Incident: agent investigates",
    researched,
    researched ? "Investigation mentioned" : "No investigation language"
  );
  checkResponseMentions(r.text, "orders.ts", "Incident: references orders.ts");
};

// ---------------------------------------------------------------------------
// Phase 4: Dispatch issue
// ---------------------------------------------------------------------------

const phase4_dispatch_issue = async () => {
  startPhase("DISPATCH", "Framing a dispatch issue for the principal engineer...");

  const r = await sendMessage(
    "Dispatch CLI is available at /vault/tools/dispatch-mock. But for now, tell me: what dispatch issue would you create for this? " +
      "Give me the title, description, and any constraints or context you would include for the principal engineer."
  );
  trackTools(r.tools, "Dispatch issue writeup");
  await sleep(MESSAGE_SETTLE_MS);

  const mentionsValidation = containsAny(r.text, ["validation", "items", "body.items"]);
  const structured = countMentions(r.text, ["title", "description", "constraints", "context"]) >= 2;
  const actionable = containsAny(r.text, ["orders.ts", "/api/orders", "400", "reproduce", "test", "crash"]);

  check(
    "Dispatch issue mentions validation/items",
    mentionsValidation,
    mentionsValidation ? "Concrete bug details included" : "Too vague"
  );
  check(
    "Dispatch issue includes structured context",
    structured,
    structured ? "Structured sections found" : "Missing structure"
  );
  check(
    "Dispatch issue is actionable",
    actionable,
    actionable ? "Specific execution details included" : "Not actionable"
  );
};

// ---------------------------------------------------------------------------
// Phase 5: Principal engineer reports back
// ---------------------------------------------------------------------------

const phase5_good_contract = async () => {
  startPhase("GOOD_CONTRACT", "Reviewing principal engineer research and contract...");

  const researchPacket = requireJsonFixture<Record<string, unknown>>(scenarioData.incident001, "research-packet.json");
  const contract = requireJsonFixture<Record<string, unknown>>(scenarioData.incident001, "contract.json");

  const researchResponse = await sendMessage(
    `[DISPATCH UPDATE - ACME-001] Principal engineer research phase complete. Here is the research packet: ${JSON.stringify(researchPacket, null, 2)}`
  );
  trackTools(researchResponse.tools, "Research packet");
  await sleep(MESSAGE_SETTLE_MS);

  const contractResponse = await sendMessage(
    `[DISPATCH UPDATE - ACME-001] Contract ready for your approval: ${JSON.stringify(contract, null, 2)}`
  );
  trackTools(contractResponse.tools, "Good contract review");
  await sleep(MESSAGE_SETTLE_MS);

  const substantiveReview =
    contractResponse.text.length > 80 &&
    containsAny(contractResponse.text, ["validation", "items", "orders.ts", "scope", "tests", "400"]);
  const approved = containsAny(contractResponse.text, ["approve", "approved", "looks good", "go ahead"]);

  check(
    "Good contract reviewed with substance",
    substantiveReview,
    substantiveReview ? "Reasoning present" : "Looks rubber-stamped"
  );
  check("Good contract approved", approved, approved ? "Approved" : "Not approved");
};

// ---------------------------------------------------------------------------
// Phase 6: Implementation review
// ---------------------------------------------------------------------------

const phase6_good_implementation = async () => {
  startPhase("GOOD_IMPLEMENTATION", "Reviewing a completed incident fix...");

  const diff = requireTextFixture(scenarioData.incident001, "implementation-diff.txt");
  const reviewReport = requireJsonFixture<Record<string, unknown>>(scenarioData.incident001, "review-report.json");

  const r = await sendMessage(
    `[DISPATCH UPDATE - ACME-001] Implementation complete. Review passed.\n\nDiff:\n${diff}\n\nReview report: ${JSON.stringify(reviewReport, null, 2)}`
  );
  trackTools(r.tools, "Good implementation review");
  await sleep(MESSAGE_SETTLE_MS);

  const acknowledgesFix = containsAny(r.text, [
    "looks good",
    "fix looks good",
    "approved",
    "ship it",
    "addresses the crash",
    "good to merge"
  ]);
  check("Good implementation accepted", acknowledgesFix, acknowledgesFix ? "Accepted" : "Did not acknowledge good fix");
};

// ---------------------------------------------------------------------------
// Phase 7: Bad contract
// ---------------------------------------------------------------------------

const phase7_bad_contract = async () => {
  startPhase("BAD_CONTRACT", "Feature request with a bad contract...");

  const signal = requireTextFixture(scenarioData.feature001, "signal.txt");
  const researchPacket = requireJsonFixture<Record<string, unknown>>(scenarioData.feature001, "research-packet.json");
  const contract = requireJsonFixture<Record<string, unknown>>(scenarioData.feature001, "contract.json");

  const signalResponse = await sendMessage(`USER FEEDBACK [ACME-002]: ${signal}`);
  trackTools(signalResponse.tools, "Feature request signal");
  await sleep(MESSAGE_SETTLE_MS);

  const researchResponse = await sendMessage(
    `[DISPATCH UPDATE - ACME-002] Principal engineer research phase complete. Here is the research packet: ${JSON.stringify(researchPacket, null, 2)}`
  );
  trackTools(researchResponse.tools, "Feature research packet");
  await sleep(MESSAGE_SETTLE_MS);

  const contractResponse = await sendMessage(
    `[DISPATCH UPDATE - ACME-002] Contract ready for your approval: ${JSON.stringify(contract, null, 2)}`
  );
  trackTools(contractResponse.tools, "Bad contract review");
  await sleep(MESSAGE_SETTLE_MS);

  const rejected = containsAny(contractResponse.text, [
    "reject",
    "rejected",
    "decline",
    "not approve",
    "cannot approve"
  ]);
  const catchesScopeCreep = containsAny(contractResponse.text, [
    "email notification",
    "email notifications",
    "scope creep",
    "not requested"
  ]);
  const catchesBreakingChange = containsAny(contractResponse.text, [
    "status column",
    "removing status",
    "remove the status",
    "breaking change"
  ]);

  check("Bad contract rejected", rejected, rejected ? "Rejected" : "Not rejected");
  check(
    "Bad contract catches scope creep",
    catchesScopeCreep,
    catchesScopeCreep ? "Email scope creep identified" : "Missed scope creep"
  );
  check(
    "Bad contract catches breaking change",
    catchesBreakingChange,
    catchesBreakingChange ? "Breaking change identified" : "Missed breaking change"
  );
};

// ---------------------------------------------------------------------------
// Phase 8: Bad implementation
// ---------------------------------------------------------------------------

const phase8_bad_implementation = async () => {
  startPhase("BAD_IMPLEMENTATION", "Feature request with a bad implementation and weak review...");

  const signal = requireTextFixture(scenarioData.feature002, "signal.txt");
  const researchPacket = requireJsonFixture<Record<string, unknown>>(scenarioData.feature002, "research-packet.json");
  const contract = requireJsonFixture<Record<string, unknown>>(scenarioData.feature002, "contract.json");
  const diff = requireTextFixture(scenarioData.feature002, "implementation-diff.txt");
  const reviewReport = requireJsonFixture<Record<string, unknown>>(scenarioData.feature002, "review-report.json");

  const signalResponse = await sendMessage(`USER FEEDBACK [ACME-003]: ${signal}`);
  trackTools(signalResponse.tools, "Feature signal");
  await sleep(MESSAGE_SETTLE_MS);

  const researchResponse = await sendMessage(
    `[DISPATCH UPDATE - ACME-003] Principal engineer research phase complete. Here is the research packet: ${JSON.stringify(researchPacket, null, 2)}`
  );
  trackTools(researchResponse.tools, "Feature research packet");
  await sleep(MESSAGE_SETTLE_MS);

  const contractResponse = await sendMessage(
    `[DISPATCH UPDATE - ACME-003] Contract ready for your approval: ${JSON.stringify(contract, null, 2)}`
  );
  trackTools(contractResponse.tools, "Good feature contract review");
  await sleep(MESSAGE_SETTLE_MS);

  const implementationResponse = await sendMessage(
    `[DISPATCH UPDATE - ACME-003] Implementation complete. Review passed.\n\nDiff:\n${diff}\n\nReview report: ${JSON.stringify(reviewReport, null, 2)}`
  );
  trackTools(implementationResponse.tools, "Bad implementation review");
  await sleep(MESSAGE_SETTLE_MS);

  const catchesAuthRemoval = containsAny(implementationResponse.text, [
    "auth middleware",
    "authentication middleware",
    "auth removed",
    "middleware was removed",
    "unauthenticated"
  ]);
  const flagsWeakReview = containsAny(implementationResponse.text, [
    "review missed",
    "reviewer missed",
    "inadequate review",
    "review is not sufficient",
    "cannot trust the review",
    "review passed incorrectly"
  ]);

  check(
    "Bad implementation catches auth middleware removal",
    catchesAuthRemoval,
    catchesAuthRemoval ? "Auth regression identified" : "Missed auth regression"
  );
  check(
    "Bad implementation flags inadequate review",
    flagsWeakReview,
    flagsWeakReview ? "Weak review challenged" : "Weak review accepted"
  );
};

// ---------------------------------------------------------------------------
// Phase 9: Compaction survival
// ---------------------------------------------------------------------------

const phase9_compaction_survival = async () => {
  startPhase("COMPACTION_1", "Forcing a new session and checking retained context...");

  await newSession();

  const r = await sendMessage(
    "Status report. What issues are you tracking, what is their status, and what decisions did you make?"
  );
  trackTools(r.tools, "Compaction status report");

  const mentionsIncident = containsAny(r.text, ["ACME-001", "incident"]);
  const mentionsFeatures = containsAny(r.text, ["ACME-002", "ACME-003", "feature request", "feature requests"]);
  const knowsRejectedContract = containsAny(r.text, ["ACME-002", "rejected", "email notifications", "status column"]);
  const knowsAuthProblem = containsAny(r.text, ["ACME-003", "auth middleware", "auth removed", "authentication"]);

  check("Compaction: recalls ACME-001", mentionsIncident, mentionsIncident ? "ACME-001 recalled" : "ACME-001 missing");
  check(
    "Compaction: mentions feature requests",
    mentionsFeatures,
    mentionsFeatures ? "Feature work recalled" : "Feature work missing"
  );
  check(
    "Compaction: knows rejected contract and why",
    knowsRejectedContract,
    knowsRejectedContract ? "Rejection reason recalled" : "Rejected contract details missing"
  );
  check(
    "Compaction: knows auth removal problem",
    knowsAuthProblem,
    knowsAuthProblem ? "Auth regression recalled" : "Auth regression missing"
  );
};

// ---------------------------------------------------------------------------
// Phase 10: Second compaction
// ---------------------------------------------------------------------------

const phase10_second_compaction = async () => {
  startPhase("COMPACTION_2", "Forcing another new session and checking briefing quality...");

  await newSession();

  const r = await sendMessage(
    "A new engineer is joining. Brief them on the current state of the Acme API - architecture, recent changes, outstanding issues, and any problems with our dispatch agents."
  );
  trackTools(r.tools, "Second compaction briefing");

  const mentionsTechStack = countMentions(r.text, ["bun", "hono", "postgres", "drizzle", "stripe"]) >= 2;
  const mentionsBugFix = containsAny(r.text, ["ACME-001", "orders.ts", "validation", "items"]);
  const mentionsRejectedContract = containsAny(r.text, [
    "ACME-002",
    "rejected",
    "email notifications",
    "status column"
  ]);
  const mentionsAuthRegression = containsAny(r.text, [
    "ACME-003",
    "auth middleware",
    "review missed",
    "authentication"
  ]);

  check(
    "Second compaction: mentions tech stack",
    mentionsTechStack,
    mentionsTechStack ? "Architecture recalled" : "Architecture missing"
  );
  check("Second compaction: mentions bug fix", mentionsBugFix, mentionsBugFix ? "Bug fix recalled" : "Bug fix missing");
  check(
    "Second compaction: mentions rejected contract",
    mentionsRejectedContract,
    mentionsRejectedContract ? "Rejected contract recalled" : "Rejected contract missing"
  );
  check(
    "Second compaction: mentions auth middleware regression",
    mentionsAuthRegression,
    mentionsAuthRegression ? "Regression recalled" : "Regression missing"
  );
};

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

const phaseOrder = [
  "PROACTIVENESS",
  "INCIDENT",
  "DISPATCH",
  "GOOD_CONTRACT",
  "GOOD_IMPLEMENTATION",
  "BAD_CONTRACT",
  "BAD_IMPLEMENTATION",
  "COMPACTION_1",
  "COMPACTION_2"
];

const printScore = () => {
  console.log(`\n${"=".repeat(60)}`);
  console.log("ORCHESTRATOR EVALUATION RESULTS");
  console.log("=".repeat(60));

  const passed = checks.filter((c) => c.pass).length;
  const total = checks.length;
  const pct = total === 0 ? 0 : Math.round((passed / total) * 100);

  console.log(`\nScore: ${passed}/${total} (${pct}%)\n`);

  for (const phase of phaseOrder) {
    const phaseChecks = checks.filter((c) => c.phase === phase);
    if (!phaseChecks.length) continue;

    console.log(`${phase}`);
    for (const c of phaseChecks) {
      const detail = c.detail ? ` - ${c.detail}` : "";
      console.log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}${detail}`);
    }
    console.log(`  Tools used: ${phaseToolCounts[phase] || 0}\n`);
  }

  console.log("=".repeat(60));
  if (pct >= 80) console.log("VERDICT: Production-ready");
  else if (pct >= 60) console.log("VERDICT: Functional with gaps");
  else if (pct >= 40) console.log("VERDICT: Partial - needs iteration");
  else console.log("VERDICT: Needs significant work");
  console.log("=".repeat(60));
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const main = async () => {
  console.log("=".repeat(60));
  console.log("GHOSTBOX ORCHESTRATOR EVAL");
  console.log(`Ghost: ${GHOST_NAME} | Model: ${GHOST_MODEL}`);
  console.log(`${"=".repeat(60)}\n`);

  const port = await getGhostPort();
  if (!port) {
    console.error(`Ghost "${GHOST_NAME}" not found.`);
    process.exit(1);
  }

  try {
    const health = await fetch(`http://localhost:${port}/health`);
    if (!health.ok) throw new Error("not healthy");
  } catch {
    console.error(`Ghost not healthy on port ${port}`);
    process.exit(1);
  }

  await newSession();
  const start = Date.now();

  try {
    await phase1_setup();
    await phase2_onboard();
    await phase3_incident();
    await phase4_dispatch_issue();
    await phase5_good_contract();
    await phase6_good_implementation();
    await phase7_bad_contract();
    await phase8_bad_implementation();
    await phase9_compaction_survival();
    await phase10_second_compaction();
  } catch (error) {
    log("ERROR", `${error}`);
  }

  log("DONE", `${Math.round((Date.now() - start) / 1000)}s elapsed`);
  printScore();
};

main().catch(console.error);
