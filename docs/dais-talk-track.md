# LensIQ at Data + AI Summit

**Talk track for a customer-facing demo: from a camera feed to an actioned outcome,
all in Databricks.**

This document is laid out the way you'd actually deliver it on stage or in a
customer briefing room. Each section has the message, the screen the audience
should be looking at, and the supporting facts you'll get pinged on in Q&A.

---

## 1. Problem statement

> "Every retailer in this room already has the data. It's stuck on the wrong
> side of a coax cable."

The setup:

- Customers have cameras everywhere. Pumps, drive-thrus, fryers, aisles, doors.
- That footage is almost exclusively **post-incident** evidence. The loss
  prevention team scrubs through clips on a Monday morning to figure out why
  Friday's shrink number was bad. Operations gets weekly PDFs of foot
  traffic. Marketing has no idea which license plates are repeat customers.
- The footage *is the data*. We just haven't been treating it like data.

The promise of this demo:

> "In the next ten minutes you'll watch a frame leave a camera, hit a
> Databricks-served model, land in Unity Catalog, render in a live dashboard,
> trigger an operator action, and write that action back to the lakehouse.
> No new vendor. No new control plane. Just Databricks."

---

## 2. How Databricks can help

Single-slide framing:

```
camera frame  ->  Model Serving  ->  Unity Catalog  ->  Databricks App
                                                       (live dashboard)
                                                            |
                                                            v
                                                       Lakebase Postgres
                                                       (operator state)
                                                            |
                                                            v
                                                       back to UC via
                                                       synced tables
```

Everything is one workspace. Same governance, same billing line, same
identity.

---

## 3. Architecture of solution

Walk the audience through the components in the order data flows.

**Edge / cameras.** Today's demo uses a webcam and a few canned MP4s. In
production it's RTSP from IP cameras, often with a lightweight edge box
running pre-filters (motion, person/no-person) to drop the bandwidth.

**Ingest: Zerobus.** Direct gRPC into Unity Catalog tables. No Kafka. No
Kinesis. No "we'll send it to S3 and crawl it." A Python/Java/Go/TS/Rust
client on the edge writes records straight to a UC table with ACKs and at
sub-second P50 latency. We generate the protobuf schema from the UC table
definition so the client and the table can never drift.

**Model Serving.** Seven endpoints today, all PyFunc, all registered in
Unity Catalog. One endpoint per use case so each model has its own
version history, scale-to-zero schedule, and cost line:

- `lensiq-detector` - general-purpose YOLO. People, vehicles, packages.
- `lensiq-license-plate` - Roboflow license-plate proxy.
- `lensiq-spill` - liquid spill detection.
- `lensiq-wet-floor-sign` - wet-floor caution-sign detection.
- `lensiq-cigarette-vape` - loss-prevention model for age-gated areas.
- `lensiq-slip-fall` - standing-vs-fallen person classifier.
- `lensiq-fog-detector` - pure-Python camera-health classifier
  (Laplacian variance + brightness gating; no external API).

All scale to zero. The app handles cold starts gracefully (Section 4).
The teardown story is the same in reverse: any endpoint can be
versioned, redeployed, or retired independently without touching the
others.

**Lakehouse.** All detections, frames, alerts, traffic - in UC. Same place
your finance team's data lives. Same governance.

**Lakeflow Spark Declarative Pipelines.** Enrichment between bronze
detections and the gold tables the dashboards read. Serverless. YAML-defined.
Same bundle as everything else.

**Lakebase Postgres Autoscaling.** Operational state - open incidents,
supervisor acknowledgments, response timestamps. Things that need
transactional consistency and millisecond UPDATEs, not append-only Delta
writes. Lakebase gives you Postgres-flavored OLTP that scales to zero and
syncs back to UC.

**Databricks Apps.** The LensIQ UI itself. React + TypeScript front end,
Node + Express back end via the AppKit framework. Lives in the same bundle
as the jobs, pipelines, endpoints, and Lakebase project.

Punchline:

> "There is exactly one `databricks bundle deploy` between an empty
> workspace and this running app."

---

## 4. Setup, end-to-end

Walk through it as a checklist. The audience should be nodding along thinking
"that's it?"

**Prereqs:** Premium Databricks workspace, Unity Catalog, a SQL warehouse,
optionally a Lakebase project. Assume they have all of these.

**Step 1 - Seed Unity Catalog**

- Catalog + schema (`lensiq`).
- Tables: `detections`, `alerts`, `plates`, `vehicle_traffic`, `inventory`,
  `devices`.
- A volume for frame images at `/Volumes/<catalog>/lensiq/frames`.
- `databricks bundle deploy -t prod && databricks bundle run lensiq_seed`.

**Step 2 - Deploy the detection models**

- `databricks bundle run lensiq_deploy_yolo` -> `lensiq-detector`.
- `databricks bundle run lensiq_deploy_roboflow_detectors` -> fan-out
  multi-task job that deploys all five Roboflow-backed specialty endpoints
  in parallel (license plate, spill, wet-floor sign, cigarette/vape,
  slip & fall). Re-run an individual task to ship a new version of just
  that detector without touching the others.
- `databricks bundle run lensiq_deploy_fog_detector` -> `lensiq-fog-detector`.
  Pure-Python (Pillow + numpy), no external API, no model weights.
- Bring your own custom-trained Roboflow model: parameterize the same
  `deploy_roboflow_detector` notebook with a different `model_slug` and
  `roboflow_model_id`. You get a fresh UC registered model, a fresh
  endpoint, and per-use-case ownership in two minutes.

**Step 3 - Wire live ingest via Zerobus**

- Generate the protobuf schema from the UC `detections` table.
- The edge collector authenticates with workspace OAuth and opens a gRPC
  stream. Each detected object becomes one record.
- No message broker stands between the camera and the lakehouse. The only
  things you pay for are network egress and UC storage.

**Step 4 - Enrich with a Spark Declarative Pipeline**

- Bronze: raw Zerobus rows.
- Silver: dedupe inside a watermark, join camera -> store -> region, classify
  shift, drop noisy near-duplicate boxes.
- Gold: materialized views the dashboards consume - `detections_summary`,
  `detections_hourly`, `plate_recent`, `vehicle_traffic`, etc.

All serverless. All declared in YAML in the same bundle.

**Step 5 - Lakebase for operational state**

- `databricks lakebase` CLI to create the Postgres database; autoscaling
  endpoint comes up in ~60s.
- The App's service principal binds via OAuth - no static passwords.
- Tables: `incidents`, `incident_responses`. These are the rows the
  supervisor's tap-to-acknowledge buttons update.

**Step 6 - Deploy the App**

- `databricks bundle deploy && databricks apps deploy lens-iq`.
- Resource bindings in the bundle declare: SQL warehouse (CAN_USE), both
  serving endpoints (CAN_QUERY), Postgres (database). The app SP gets
  exactly those scopes; nothing more.
- The Files plugin runs on-behalf-of-user, so per-user RLS on the frames
  volume is preserved.

> "First-time stand-up on an empty workspace: about 30 minutes. Redeploys:
> about five. The whole thing is one repo."

---

## 5. Why this beats a static dashboard

This is the section that lands the deal. Don't rush it.

**A static dashboard tells you something happened.**

- The numbers are stale by an hour or a day.
- They're read-only - you see a spike and... switch to a different app to
  do anything about it.
- They lack the original context. The chart says "spills up 30% this week"
  and the supervisor still has to scrub through 168 hours of footage to
  figure out why.
- They live outside your operational tooling. Most stores literally print
  them out and pin them to the back-office wall.

**LensIQ is a live, two-way control surface.**

- **Live.** Detections land in UC within a second or two of the frame. The
  Detections page subscribes via SSE; you see new rows tile in as they happen.
  The Live page overlays bounding boxes on the video itself, with
  cold-start UX so a scaled-to-zero endpoint doesn't look broken.

- **Bidirectional.** The app doesn't just *read* the lake. It *writes back*
  through Lakebase. A supervisor closes an incident in the swimlane; that
  timestamp is in Postgres in milliseconds, and Lakebase's synced tables
  push it back to Unity Catalog for tomorrow's report. **Round-trip on one
  governance surface.**

- **Composable.** The same Unity Catalog tables power:
  - This React app.
  - The Lakeview / AI-BI dashboard finance already built.
  - The Genie space the regional VP is using to ask questions in English.
  - The agent your data team is wiring up to summarize each store's
    weekend.

  One source of truth, four interfaces.

- **Governed.** Every detection, every write-back, every model invocation is
  scoped by UC ACLs and recorded in the audit log. Try producing that
  evidence trail with a screenshot dashboard.

- **Actionable.** A detection isn't a bar in a chart - it's a row that can
  trigger:
  - An incident on the Activity swimlane (Postgres INSERT).
  - A Slack notification (Model Serving LLM endpoint + agent tool).
  - A workflow job (Lakeflow run).
  - A page to the manager on call.

The slogan:

> "Don't just visualize the lake. **Action it.**"

---

## 6. Actionable outcomes

These are the slides where the customer thinks "oh, that's a line item I
already have a budget for." Pick the ones that match the vertical in the
room.

### 6a. Spill response time

> Slip-and-fall claims in c-store and QSR average mid-five-figures per
> incident. The mitigation is fast cone placement. We can measure that
> down to the second.

- Spill detector fires on a frame -> detection row in UC.
- Lakebase opens an incident.
- Activity swimlane shows the spill blip; a manager taps "cone placed",
  OR the wet-floor-sign detector picks it up automatically when the
  employee carries the cone in.
- Incident closes; response-time metric updates in real time.
- **KPI:** average time-to-cone, by store, by shift. Today: unknown.
  Demo target: under 90s. Insurance and claims teams care a lot about
  this number being defensible.

### 6b. People-to-pump-to-store conversion (c-store / gas)

> "We know how many gallons we sold. We don't know how many people drove
> in and never came inside. That's the whole TAM."

- Person count at the canopy + pump-usage detector + ALPR running on
  their own dedicated serving endpoints, all queried in parallel.
- Join with POS pump events and in-store basket scans.
- Answer: of the N vehicles that pulled in this hour, how many fueled,
  how many also walked inside, what was their average basket?
- **Action:** when canopy traffic spikes but in-store conversion dips,
  pull someone from back-of-house to the door. Measure whether the line
  moves. Roll out to other stores if it does. **You couldn't do this
  experiment before because you didn't have the denominator.**

### 6c. VIP / repeat customer identification

> "Your top 5% of customers visit 14+ times a month and you have no
> idea who they are."

- Plate detector + a UC `plates_history` table.
- "This plate has visited 14 times in 30 days, average basket $X." That
  fact is in the app's right-hand panel the moment the car pulls in.
- The app pushes a Slack notification to the on-shift manager via the LLM
  tool-calling agent.
- **Action:** comp a coffee, learn the regular's name, run loyalty
  *without asking the customer to download an app or carry a punch card*.

### 6d. PPE / safety compliance

- Vape / cigarette detector in non-smoking zones.
- Hairnet, glove, or fryer-area apron detector behind the counter.
- Aggregated daily by shift; results show up as a coaching nudge, not a
  write-up, on the morning report.
- **Action:** identify which shifts need a refresh on training. The point
  is the trend, not catching one person.

### 6e. Inventory shrink correlation

- Detections of staff presence vs. customer presence near high-value SKUs.
- Joined to POS shrink reports.
- Find the shifts and aisles where shrink correlates with low staff
  presence in the camera view.
- **Action:** restaff or recamera. Loss prevention has a budget for both;
  data tells them which one.

### 6f. Pump-island fraud and loitering

- Person at pump > N minutes with no corresponding fueling event in POS.
- Same plate seen at multiple stores in the same hour.
- For some chains, drive-off and credit-card-skimming detection at the
  pump is the **single largest** controllable loss line.
- **Action:** real-time alert to loss prevention; in some chains this
  pays for the whole platform in a quarter.

### 6g. Drive-thru SLA

- People count in the drive-thru lane at minute granularity.
- Combined with POS order start/end events to compute end-to-end time per
  order, not just per car at the window.
- **Action:** alert when a lane SLA breaches; coach by shift, not by
  store, because you have the camera evidence.

---

## 7. The close (~30s)

> "You already pay for the cameras. You already pay for Databricks. The
> bridge between them used to be a six-month system-integration project
> with three vendors. Today it's an afternoon and one repo."

Next steps to offer:

1. A free FE demo workspace with this code preloaded.
2. A Roboflow model swap-in for the customer's domain - we'll fine-tune
   on a few thousand of their own frames in a workshop.
3. A Lakebase project to hold their operational state and prove the
   write-back loop end to end.

---

## 8. Q&A primers

The questions you'll get every time.

**"What's Zerobus latency look like in production?"**
Sub-second ACK at P50, P99 under a couple seconds with retry. Bottleneck
is usually the edge network, not Zerobus. Idempotent record keys so
retries don't double-write.

**"Can I bring my own custom-trained model?"**
Yes. Register as an MLflow PyFunc in Unity Catalog and parameterize the
`deploy_roboflow_detector` notebook with a different `model_slug` and
`roboflow_model_id` (or write your own deploy notebook for non-Roboflow
weights). You get a fresh registered model, a fresh endpoint, and
per-use-case versioning + RBAC out of the box. Endpoints scale to zero
so the steady-state cost is the model's storage footprint, not its
compute.

**"Privacy and PII - faces and plates?"**
Frames live in a UC volume with per-user RLS. You can blur faces and
plates at the edge before upload, or keep them and rely on UC ACLs.
Every read of the frames volume is in the UC audit log.

**"What does this cost?"**
Three dominant line items: Model Serving (scales to zero), Lakebase
(scales to zero), and UC storage for whatever frames you choose to
persist. You do not have to persist every frame - typically you only
keep frames around an alert. Detection rows themselves are tiny.

**"How is this different from a Genie space?"**
Genie is read-only NL-to-SQL over UC. LensIQ is a write-back operational
app on top of the same UC. They're complementary: the LensIQ app
embeds a Genie chat panel so the supervisor can ask "what's our average
time-to-cone this week?" in English without leaving the app.

**"Can the same architecture replace my BI dashboard?"**
No, and you don't want it to. AI-BI / Lakeview is the right tool for
"give the CFO a self-serve view of the gold tables." LensIQ is the
right tool for the operator on the floor who needs to *do* something
with what the cameras saw. Both read from the same UC tables. That's
the point.

**"What if I don't want Lakebase?"**
Then write-back lands as an append-only event log in UC and you accept
the latency penalty (seconds vs milliseconds) on the operational read
path. The architecture still works; the operator UX is just less snappy.

---

## Appendix - one-slide architecture (copy/paste)

```
+-------------+    Zerobus      +-----------------+    Spark Declarative
|   Cameras   |  (gRPC, ACKed)  |  Unity Catalog  |    Pipeline (serverless)
|  / edge box | --------------> |  detections     | ----+
+-------------+                 |  frames volume  |     |
                                +-----------------+     v
                                                  +----------------+
+---------------------+    Model Serving          | gold tables     |
| lensiq-detector     | <--- /api/detect ------+  | (materialized)  |
| lensiq-roboflow-    |  (scale-to-zero,      |   +----------------+
|   detector (multi)  |   cold-start UX)      |          |
+---------------------+                       |          v
                                              |  +----------------+
                                              |  | Databricks App |
                                              +--|   (LensIQ UI)  |
                                                 +----------------+
                                                        |
                                              write-back via OAuth
                                                        v
                                              +----------------+
                                              |    Lakebase    |
                                              |   (incidents,  |
                                              |    responses)  |
                                              +----------------+
                                                        |
                                                synced tables
                                                        v
                                                back to UC for
                                                  analytics
```
