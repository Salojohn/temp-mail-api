# AI Ads Autopilot for WooCommerce (Google Ads First)

## 1) Product scope (MVP)

Build a WordPress plugin + backend SaaS that lets a WooCommerce merchant launch and optimize Google Ads with near-zero setup.

**User journey (MVP):**
1. Install plugin
2. Connect Google Ads account
3. Set daily budget
4. Start Autopilot

## 2) System architecture

### A. WordPress plugin (customer-facing)
Responsibilities:
- OAuth/connect flows (Google Ads + Merchant Center authorization handoff)
- Setup wizard and budget input
- Site/product sync kickoff
- Status dashboard (campaign health, spend, ROAS, alerts)
- Consent signal collection (GDPR/consent mode state)

Recommended plugin modules:
- `Admin UI` (wizard + dashboard)
- `Sync Client` (sends WooCommerce catalog snapshots/deltas to SaaS)
- `Webhook Listener` (receives backend status updates)
- `Tracking Bootstrap` (injects conversion tracking conditionally by consent)

### B. Backend SaaS API (control plane)
Responsibilities:
- Store scanning intelligence
- Product selection and feed normalization
- Campaign/ad asset generation
- Optimization scheduler and decision engine
- Budget guardrails and stop-loss automation
- Multi-tenant data model and API auth

Suggested services:
- `api-gateway`
- `catalog-service`
- `feed-service`
- `campaign-service`
- `optimization-service`
- `ai-service`
- `tracking-service`
- `billing-service`
- `scheduler/worker`

### C. Integrations
- Google Ads API (campaigns, assets, metrics)
- Google Merchant Center API (feed submission/sync)
- OpenAI API (copy generation, classification, rewrites)

## 3) Data model (high-level)

Core entities:
- `Tenant` (merchant account)
- `Store` (WooCommerce metadata)
- `Product` (catalog snapshot)
- `ProductScore` (selection score + reason codes)
- `FeedItem` (GMC-ready product representation)
- `Campaign` / `AssetGroup` / `AdAsset`
- `BudgetPolicy`
- `PerformanceSnapshot` (hourly/daily metrics)
- `OptimizationAction` (pause, raise budget, refresh assets)
- `ConsentState`

## 4) MVP functional design by step

### Step 1: Store scanning engine
Ingest product fields:
- title, description, category, price, compare-at price, stock, image URLs, rating/review count

AI + rules outputs:
- niche classification (taxonomy label)
- target audience profile
- intent class (budget/premium/impulse)
- data quality score

### Step 2: Product selection logic
Base score formula (example):
- `score = quality * 0.25 + margin_proxy * 0.20 + stock_health * 0.20 + popularity * 0.20 + price_fit * 0.15`

Hard exclusions:
- out of stock
- missing core feed fields (title/image/price)
- policy-risk category (if unsupported)

### Step 3: Auto product feed
For each selected product:
- normalize/validate title/description length
- ensure required GMC attributes
- infer missing optional attributes when safe
- queue remediation notes for merchant

### Step 4: Campaign creation (PMax-first)
Create default structure:
- 1 campaign per store (MVP) or per top category (v1.1)
- daily budget from user input
- asset groups grouped by category cluster
- location/language defaults from store settings

### Step 5: AI ad creation
Generate assets using product context:
- short headlines
- long headlines
- descriptions
- CTA variants
- callouts/sitelinks templates

Guardrails:
- brand safety blocklist
- policy phrase checks
- fallback template if AI fails

### Step 6: Tracking setup
MVP tracking:
- purchase conversions
- add_to_cart micro-conversions
- UTM consistency and attribution params

Consent-aware behavior:
- do not fire marketing tags before user consent
- support consent mode flags

### Step 7: Optimization engine
Run every 6 hours (MVP):
- pull spend/click/conversion/value metrics
- compute ROAS, CPA, CVR, CTR per product + campaign

Rule actions:
- ROAS below threshold for N windows => reduce budget/pause SKU
- high ROAS + sufficient conversions => raise budget within cap
- low CTR or zero conversions => rotate new copy set

### Step 8: AI decision layer
AI receives compact context:
- top losers/winners, spend trends, search terms (if available), asset performance

AI suggests:
- creative angle rewrites
- category-level budget shifts
- new product tests

Final action remains rule-bounded:
- all AI actions pass through deterministic budget/policy limits

### Step 9: Budget control
Enforce globally:
- account-level daily cap (hard stop)
- campaign-level ceiling
- product allocation min/max bands

Stop-loss examples:
- spend > X with 0 conversions over Y hours => temporary pause

### Step 10: GDPR / consent
- maintain tenant-level consent configuration
- pseudonymize event payloads where possible
- configurable retention windows
- support DSAR/delete workflows in backend

## 5) API contract sketch

Plugin -> SaaS:
- `POST /v1/stores/connect`
- `POST /v1/stores/{id}/scan`
- `POST /v1/stores/{id}/budget`
- `POST /v1/stores/{id}/autopilot/start`
- `GET /v1/stores/{id}/status`

Internal worker endpoints:
- `POST /internal/optimize/run`
- `POST /internal/feed/sync`

Webhooks SaaS -> Plugin:
- `campaign.created`
- `optimization.action_taken`
- `budget.alert`

## 6) Suggested tech stack

### Plugin
- PHP 8.x, WordPress plugin API
- WooCommerce REST hooks/events
- Minimal JS (React or vanilla WP components) for admin dashboard

### Backend
- Node.js (TypeScript) for API + workers
- PostgreSQL for relational tenant/campaign data
- Redis for queues/caches/locks
- Object storage for creative artifacts/logs

### Ops
- Queue: BullMQ / Celery equivalent
- Scheduled jobs: cron/worker beat
- Observability: OpenTelemetry + centralized logs + alerts

## 7) Safety, quality, and compliance guardrails
- Policy validation before Google submission
- Budget hard caps at DB + worker level
- Idempotency keys for campaign/feed operations
- Human-readable audit log for every automated action
- Feature flags to progressively roll out automation

## 8) Delivery roadmap

### Phase 0 (1-2 weeks): Foundations
- tenant auth, OAuth scaffolding, store connection, product sync skeleton

### Phase 1 (2-4 weeks): MVP launch path
- scan engine, feed generation, PMax creation, basic tracking, first dashboard

### Phase 2 (2-3 weeks): Optimization v1
- 6-hour scheduler, ROAS/CPA rules, asset refresh loop

### Phase 3 (2-3 weeks): Reliability + billing
- hardening, alerts, usage metering, Stripe subscriptions

## 9) MVP acceptance criteria
- Merchant can launch a campaign in under 10 minutes
- >90% of valid products successfully normalized to feed format
- Budget overspend incidents: 0 (hard cap guaranteed)
- Optimization job executes on schedule with audit traceability

## 10) Monetization mapping
- Basic (€19): one store, limited optimization frequency
- Pro (€49): faster optimization cadence + advanced assets
- Scale (€99): multi-campaign strategy, priority support, expanded limits
