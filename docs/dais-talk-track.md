# LensIQ at Data + AI Summit

**A 5-10 minute booth demo any SA or AE can deliver. The point is the business
case for treating camera footage as an asset, not a sunk cost.**

The structure is **tell, show, tell**. Lead with the message, demo it on the
app, recap the outcome. Customers should leave the booth with one sentence
they could repeat to their boss, not a list of features.

---

## The one-sentence pitch

> "Every retailer pays twice for their cameras: once to install them, and
> again every time something goes wrong that they could have caught live.
> LensIQ turns that footage into a revenue and risk lever, on the Databricks
> you already own."

---

## Section 1 - TELL: footage is the most underutilized asset on the floor

Hold this beat. Don't move to the laptop yet.

The setup, in plain English:

- Every store, restaurant, hotel, and station already has cameras. They were
  bought for loss prevention and insurance compliance.
- **Today that footage is post-incident evidence.** Someone scrubs through
  clips on a Monday morning to explain what went wrong on Friday. The chart
  the regional VP gets is a PDF, three days late.
- Footage is **the highest-resolution behavioral data in the building** -
  who came in, what they did, what they didn't buy, where they slipped,
  which pump they used without paying - and almost none of it makes it into
  a decision.

The reason it has stayed that way is plumbing. Pulling video off the edge,
making sense of it with models, governing it next to the rest of the
business data, and getting the result back in front of an operator on the
floor used to be a multi-vendor, multi-quarter project.

That math has changed.

> "We're going to show you the same footage you already capture, turned into
> something your store manager, your loss-prevention lead, and your CFO can
> all act on - in one workspace, with one bill."

---

## Section 2 - Architecture at a glance (the one diagram)

Spend 60 seconds here. Hand-draw it in the air if you have to. Every page
the customer is about to see lives inside these four boxes, in the order
the data flows.

```
Camera  ->  Zerobus  ->  ETL (model detections)  ->  Lakebase + downstream apps
```

- **Camera.** Whatever you already own - the dome cam in the aisle, the
  forecourt PTZ, the drive-thru lane camera, the back-of-house DVR. No
  rip-and-replace. The platform meets you at the cable you already have.
- **Zerobus.** The on-ramp. Sub-second, governed writes from the edge
  straight into Unity Catalog. No Kafka cluster, no MQTT broker, no
  third-party message bus to operate and pay for. Every frame is a row
  the moment it leaves the device.
- **ETL (model detections).** A serverless Spark Declarative Pipeline
  runs every model on every frame. Bronze frames in, enriched detections
  out, all in Delta - ACID, time-travel, schema-enforced. Each use case
  is its own model serving endpoint that scales to zero between events,
  so you pay for inference, not idle GPUs.
- **Lakebase + downstream apps.** The operator layer. Postgres-fast
  reads and writes for this app and any other operator app, dashboard,
  Genie space, alert, or agent your team builds on top. Every row stays
  synced back to Delta so analytics and BI are never stale.

> "Every page in the demo is reading and writing through that same
> four-box loop. There is no separate CV stack to operate - it's the
> lake, the same lake your finance and supply chain data already live
> in. One bundle, one bill, one security boundary."

Why this matters before the walkthrough:
- The customer sees the same architecture under every page, not a
  different vendor stitched in per use case.
- The boxes map one-to-one onto bills - they can predict cost without
  guessing at how the pieces fit.
- It pre-empts the "do we need Kafka in front" / "do we need a separate
  metrics database" questions that derail the demo otherwise.

---

## Section 3 - SHOW: walk the app

Nine stops, each is its own purpose-built model on its own serving endpoint.
Total time on this section: about five minutes. The point is that the
audience sees footage become a row, a row become an alert, and an alert
become a dollar figure - in seconds. Pick the two or three stops that fit
the badge in front of you.

### Stop 1: Live Detection (`/live`)

What to do:
1. Click **Live Detection** in the sidebar.
2. Pick a sample clip (or the webcam at the booth).
3. Cycle the **Detector** dropdown to show a couple of specialty models -
   YOLO, spill, license plate, fog detector - against the same source.

What to say:
> "This is the same footage your stores already record. The difference is
> that every frame is being scored by a model right now. Every use case you
> see in the sidebar - spill, plate, guest count, camera health - is its
> own serving endpoint. Each one scales to zero independently. The team
> responsible for safety doesn't share a release cycle with the team
> responsible for loyalty."

Why this matters to the buyer:
- One platform, many use cases. They don't pick a vendor per problem.
- The models scale to zero between events. They pay for inference, not for
  idle GPUs.

### Stop 2: Spill Detection (`/spills`)

What to do:
1. Click **Spill Detection**. Let the canonical aisle clip play.
2. Watch the spill bbox light up. Click **Place cone** at 0:27.
3. Point at the "Current response" stopwatch flipping to a millisecond
   delta when the cone enters frame.

What to say:
> "Spill at second one. Cone at second 27. The model just measured your
> time-to-cone *as a number you can put on a dashboard*. Mid-five-figure
> slip-and-fall claim averages, an insurance carrier that wants proof you
> responded, and a regional VP who can finally answer 'which stores are
> slow?' - all from one row in Lakebase. The fastest, last, and average
> response cards in the corner are reading directly out of Postgres."

### Stop 3: License Plates (`/plates`)

What to do:
1. Click **License Plates**. Let YOLO start boxing vehicles.
2. Watch the "reading..." overlay flip to actual plate text as Claude
   vision returns the OCR result.
3. Point at the "Recent plates" list in the right column - those are rows
   coming back out of Lakebase.

What to say:
> "Two models in one loop. YOLO finds the vehicle, Claude vision crops the
> bumper and reads the digits. Each plate is read exactly once per visit
> - we're not paying for OCR every frame. Drive-off prevention, drive-thru
> SLA per car, fleet recognition for a B2B account, repeat-customer pings
> for a loyalty manager - same row, four different audiences."

### Stop 4: Guest Counts (`/guests`)

What to do:
1. Click **Guest Counts**. Two CCTV feeds (forecourt + c-store) light up
   side by side.
2. Point at the three cards: pump users, pump cars, in-store.
3. Scroll down to the "Activity over time" chart - lines coming back out
   of Lakebase, 30-second buckets, last 10 minutes.

What to say:
> "Three running totals, one chart. We're counting people on the forecourt,
> cars at the pumps, and people in the c-store - all in parallel, from
> separate cameras, on the same screen. The numbers you see going up are
> unique tracks, not raw detections, so we're not double-counting the
> same person on three consecutive frames. Divide in-store by pump users
> and you have your **canopy-to-store conversion rate** - the denominator
> a fuel chain has never had until now."

### Stop 5: Camera Clarity (`/clarity`)

What to do:
1. Click **Camera Clarity**. Camera A (the clear baseline) sits green.
   Camera B (the foggy lens) flashes red after a few ticks.
2. Point at the "Cleaning tickets opened" card incrementing.
3. Show the side-by-side fog coverage chart.

What to say:
> "Every loss-prevention model in this building only works as well as the
> camera it's looking through. A smudged dome cam in a freezer aisle is
> invisible to your spill model and your shoplifter model and your
> people-counter. This is the diagnostic layer that *watches the
> watchers*. It's a tiny Pillow + numpy PyFunc, no GPU, that flags the
> camera *before* downstream models silently miss things. Sustained fog
> opens a cleaning ticket. The same governance, same Lakebase row stream."

### Stop 6: Facial Recognition (`/facial-recognition`)

What to do:
1. Click **Facial Recognition** in the sidebar.
2. Enroll a face right there at the booth: snap or upload a photo of
   yourself, pick a role (banned / VIP / staff), hit **Enroll face**.
3. Step in front of the webcam. The bbox flips from grey "Unknown" to a
   coloured pill with your name and a similarity percentage in under a
   second.
4. Switch the role to **banned** for the next enrollment and walk back
   in - the badge blinks red and a toast fires.
5. Scroll the **Recent matches** card. Each row has both the live frame
   *and* the enrolled reference photo, plus role colour, similarity %,
   and a relative timestamp.

What to say:
> "Two models on one frame and one SQL query in between. **InsightFace
> SCRFD** finds every face in the webcam frame; **ArcFace** turns each
> one into a 512-dimensional embedding. That embedding goes into
> **Lakebase Postgres**, which we're using as the vector database -
> `pgvector` does the cosine search against everyone we've enrolled, in
> the same database the rest of the app already writes to. There's no
> separate vector store to operate."

> "The roles are what turn this into a business app. **Banned** subjects
> blink the badge red and send a toast - that's loss prevention. **VIP**
> goes gold - that's the host or concierge being told who just walked
> in. **Staff** goes blue - that's on-duty check, or after-hours
> intrusion if the same camera fires at 2am. Same model, three
> conversations."

Why this matters to the buyer:
- **Lakebase is the operator database AND the vector index.** Same
  Postgres connection, same governance, no extra system to procure or
  patch. Enrolled faces, match history, and the live tap-to-acknowledge
  are all in one place.
- **The customer's own model, the customer's own data.** The enrolled
  set never leaves their workspace. The endpoint runs in their account.
  No images shipped to a third-party SaaS, which is the answer to the
  privacy question before it gets asked.
- **The pipeline is identical to every other detector.** Frame -> serving
  endpoint -> Lakebase row -> Genie can ask about it. Pull this one out
  for **retail loss prevention**, **hospitality VIP recognition**, and
  **secure-area staff verification** depending on the badge.

### Stop 7: Live activity from the lake (`/detections` or `/alerts`)

What to do:
1. Click **Detections** (or **Alerts**).
2. Point at the rows streaming in from the demos you just ran.

What to say:
> "What you just saw on the videos isn't a screenshot. It's a row in a
> **Delta** table. The frame itself, the detection, the model version that
> produced it - all of it lands in Unity Catalog with ACID guarantees, the
> same place your finance, supply chain, and HR data live."

> "Then the gold layer writes into **Lakebase Postgres** - the operational
> database this app reads and writes back to. That's why the supervisor's
> tap-to-acknowledge is millisecond-fast even at scale, and why the same
> incident row is queryable in Postgres *and* in the lake for tomorrow's
> report."

Why this matters to the buyer:
- They were going to buy a separate computer-vision system that wrote to
  its own database. Now there isn't one. There's just the lake.
- **Delta** handles the ingest and pipeline math: every frame, every
  enrichment, every model version - ACID, time-travel, auditable.
- **Lakebase** handles the operator path: Postgres-fast read/write at
  scale, synced back to Delta so analytics never goes stale.
- Audit, retention, redaction, and PII rules they already wrote for the
  rest of the business apply to footage too.

### Stop 8: Composability (`/trends` or `/overview`)

What to do:
1. Click **Trends** or **Overview**.
2. Show the dashboards reading the same detection table the live page reads.

What to say:
> "The same row that just flashed on the alerts page is feeding this
> dashboard, the Genie space your regional VP uses to ask questions in
> English, and the weekly executive report. One source of truth - four
> interfaces - no duplicated pipelines."

### Stop 9: Talk to the data with Genie

What to do:
1. Open the Genie panel (or the AI chat button in the corner).
2. Ask one question in plain English. Examples that always land:
   - *"Which stores had the most spills this week?"*
   - *"What was the average time-to-cone yesterday, by shift?"*
   - *"Show me unique license plates that visited more than three of our
     locations this month."*
   - *"Which cameras have been fogged more than 20% of the time this week?"*

What to say:
> "Once your footage is rows in Delta, your analysts don't have to learn a
> new tool to use it. **Genie** is a natural-language interface over the
> exact same tables you saw on every page. The CFO can ask the question
> they were going to email the data team. The regional VP can compare
> stores without opening a BI tool. Your loss prevention lead can pull a
> list of repeat plate offenders without writing SQL. Every detection the
> camera produced is a number an analyst can talk to."

Why this matters to the buyer:
- The biggest cost of a CV system isn't the cameras or the models - it's
  the data team translating questions into SQL for everyone else. Genie
  removes that translator.
- Genie reads the same Unity Catalog governance you've already configured
  - row-level security, column masks, audit log. Analysts get the data
  they're allowed to see, not more.

---

## Section 4 - Use case deep dive (one slide per detector)

This is the section to lean on when a customer asks **"what does each
model actually do for me?"**. Each use case is a separate serving endpoint,
versioned and scaled independently, persisted to Lakebase, and queryable
from Genie. Lead with the dollar number, not the model name.

### 4.1 - Spill detection (`/spills`)

What the model sees:
- Two detectors running on the same frame: **spill** (liquid on the floor)
  and **wet_floor_sign** (yellow caution cone).
- The app stamps a wall-clock delta between the first spill detection and
  the first cone detection of each cycle. That delta is the metric.

What the operator gets:
- A live stopwatch from spill-to-cone, per camera, per store.
- A rolling fleet KPI: **last response**, **average across last 50**,
  **fastest in window** - reading straight out of Lakebase.
- An audit row per cycle with both timestamps, the source clip, and
  whether the cone arrived organically or by operator override.

Business value, in the customer's words:
- **Insurance and liability.** The average slip-and-fall claim is mid-five
  figures, before legal. A timestamped row showing "spill detected, cone
  deployed in 73 seconds" is what the carrier wants in discovery. One
  avoided claim per region per year pays for the platform.
- **Coaching, not blame.** Time-to-cone is a coaching metric by shift and
  store, not a punitive write-up. The conversation goes from "did anyone
  see the spill on Friday?" to "your Tuesday closing crew is averaging
  4 minutes, the chain average is 90 seconds - what do they need?"
- **Carrier-defensible audit trail.** Same row in Delta, same row in
  Lakebase, same row your insurance broker queries quarterly. No PDFs.

Where this lands hardest: **QSR, grocery, c-store, hotels, stadiums.**

### 4.2 - License plate recognition (`/plates`)

What the model sees:
- YOLO finds vehicles (car, truck, bus, motorcycle). A centroid tracker
  gives each vehicle a stable id across frames so we don't OCR the same
  plate every tick.
- When a new track appears, the vehicle crop goes to a vision LLM
  (Claude via Foundation Model APIs) which extracts the plate text plus
  a tight bbox in one call.
- The read is persisted to Lakebase with timestamp, source camera, and
  the OCR model version.

What the operator gets:
- A live feed with each vehicle box flipping from "reading..." to the
  actual plate text the moment OCR returns.
- A recent-reads panel sourced from Lakebase, refreshing every five
  seconds.
- Session totals (reads, unique plates, vehicles in frame) so a manager
  can sanity-check the camera before the next shift.

Business value, in the customer's words:
- **Drive-off prevention at the fuel pump.** For some chains this single
  line item pays for the whole platform in a quarter. Plate captured at
  arrival, transaction joined at the POS, missing transactions surface
  as exceptions.
- **Drive-thru SLA, per order, not per car.** Plate is the join key. You
  finally measure speed of service for *this customer's order*, not "the
  red car at the window."
- **Loyalty without an app or punch card.** Plate comes in, manager gets a
  Slack ping with the lifetime visit count, customer gets a free coffee.
  Loyalty conversion goes up without changing checkout.
- **Fleet and B2B recognition.** Same logic, applied to repeat commercial
  vehicles - a hotel can pre-stage a regular's room, a c-store can flag
  a vendor truck for the back dock.

Where this lands hardest: **convenience and fuel, hotels, parking,
drive-thru QSR, fleet operators.**

### 4.3 - Guest and vehicle counts (`/guests`)

What the model sees:
- Two CCTV feeds run YOLO in parallel: a forecourt camera and an
  in-store interior camera.
- Each detection is filtered into three buckets: **pump_users**
  (people on the forecourt), **pump_cars** (vehicles on the forecourt),
  **in_store** (people inside).
- A centroid tracker per bucket converts raw bounding boxes into
  **unique tracks** so a person standing at a pump for thirty seconds
  contributes one, not thirty.
- Per-tick counts are streamed to Lakebase in five-second batches.

What the operator gets:
- Current totals on premises **right now**, plus cumulative since the
  shift started.
- A time-series chart of average bucket counts per zone over the last
  ten minutes, read back from Postgres.
- A clean denominator for any conversion math the chain wants to do.

Business value, in the customer's words:
- **The denominator a fuel chain has never had.** Canopy traffic up but
  in-store basket flat? Now you know which store, which shift. The
  pump-to-store conversion ratio is the lever every CMO has been asking
  for.
- **Staffing that matches the floor, not the schedule.** Queue forming at
  the register? Add a cashier *before* NPS drops, not at the Monday
  staffing review.
- **Marketing attribution that survives audit.** "Our coupon drove a 14%
  lift in canopy traffic" is a defensible claim when the camera counted
  it.
- **Concession throughput per section** for stadiums and venues -
  rebalance staff in real time instead of guessing from POS lag.

Where this lands hardest: **fuel and c-store, QSR, stadiums and venues,
hotels, big-box retail.**

### 4.4 - Camera clarity / fog detection (`/clarity`)

What the model sees:
- Every camera is tiled into an 8x6 grid each tick. A Laplacian variance
  (sharpness proxy) plus mean brightness scores each patch.
- Connected patches that flunk the sharpness threshold become a
  **fogged** bounding box. A clear frame returns a single full-frame
  `clear` detection that we deliberately don't paint.
- Sustained-fog runs (three consecutive ticks) cross the threshold for
  an "incident" - a cleaning ticket - so a one-frame reflection doesn't
  spam the queue.

What the operator gets:
- A side-by-side of every monitored camera with a green / yellow / red
  verdict pill.
- **Cleaning tickets opened** counter on the page, plus a fog-coverage
  time-series chart per camera, read from Lakebase.
- A "recent fog events" feed of which camera and how much of its frame
  was obscured.

Business value, in the customer's words:
- **Quality gate on every other model on the platform.** A smudged dome
  camera is invisible to your spill detector, your shoplifter model, and
  your people-counter. The fog detector is the diagnostic that keeps the
  rest of the platform honest. It's the difference between **"the camera
  is offline"** (which you already monitor) and **"the camera is on but
  blind"** (which you don't).
- **Asset preservation without a maintenance contract.** Cleaning tickets
  fire on actual lens degradation, not on a quarterly checklist. The
  janitor walks past the camera that *needs* a wipe, not all 40.
- **Trustable downstream metrics.** When a regional VP asks "why was our
  shrink number off last week?", "because half our LP cameras were
  fogged" is a defensible answer with a row to back it up.
- **No GPU, no API cost.** Pure Pillow + numpy. The cheapest detector on
  the platform watches every other model. Runs on every camera the
  customer owns, every tick, for pennies.

Where this lands hardest: **grocery freezer/cooler aisles, outdoor PTZ
fleets, gas-station canopy cameras, any chain with thousands of cameras
under one maintenance team.**

### 4.5 - Slip and fall, PPE, age-gate (Live page specialty models)

These ship as additional endpoints on the **Live** page detector
dropdown. Same Delta + Lakebase plumbing as the headline use cases. Pull
these out when the badge in front of you matches.

- **Slip & fall (`slip_fall`).** Detects standing vs fallen persons.
  Pair with the spill model so the carrier has both the hazard *and*
  the incident timestamped on the same row. QSR, grocery, hotels.
- **PPE / hard hat (`hard_hat`).** Detects helmet compliance on
  back-of-house or industrial lines. Weekly coaching trend, not a
  punitive write-up. Manufacturing, distribution, fuel back-of-house.
- **Cigarette / vape (`cigarette_vape`).** Loss-prevention model for
  age-gated areas in a c-store. Flags activity near the counter so the
  manager can intervene without watching the camera live.

The talk track for these is identical to spill: it's a model on its own
endpoint, every detection lands in Delta and Lakebase, Genie can ask
questions in English. The customer gets a model, not a stack.

### 4.6 - Facial recognition (`/facial-recognition`)

What the model sees:
- **InsightFace `buffalo_l`** runs as a single serving endpoint that
  bundles **SCRFD-10G** (face detection) and **ArcFace `w600k_r50`**
  (512-dimensional, L2-normalised identity embedding). One request per
  frame returns every visible face with its bbox, detection score, and
  embedding.
- The whole model pack (~280 MB) is shipped *inside* the MLflow
  artifact and staged into `INSIGHTFACE_HOME` at scale-from-zero, so
  there's no cold-start CDN call - the endpoint has zero external
  network dependencies once it's warm.
- The app server takes each embedding and runs a **`pgvector` cosine
  search** against the `faces` table in Lakebase to find the closest
  enrolled identity, if any is above threshold.

What the operator gets:
- A simple enroll card on the left: name + role (banned / VIP / staff)
  + photo. The server crops the largest face, embeds it, and writes the
  thumbnail + embedding to Lakebase in one round trip.
- A live webcam panel with role-coloured bounding boxes: red for
  banned, gold for VIP, blue for staff, slate for unknown faces. Matched
  faces get a name + similarity %; unknown faces stay anonymous.
- A **Recent matches** stream backed by Lakebase, deduped per face for
  30 seconds so the list reads like signal, not telemetry. Each row
  pairs the **live frame** with the **enrolled reference** so the
  operator can sanity-check a match in one glance.
- A toast plus a blinking badge whenever a **banned** subject is
  matched - the loss-prevention escalation path is on-screen, not in a
  separate alerting tool.

Business value, in the customer's words:
- **Loss prevention without an external biometrics vendor.** A
  previously-trespassed shopper walks in, the store manager's tablet
  flashes red within a second. The enrolled set, the match history, and
  the audit trail all live in the customer's own Unity Catalog + their
  own Lakebase database. Faces never leave the workspace.
- **VIP and concierge recognition** for hospitality, casinos, private
  clubs, and high-end retail. The right person greets the right guest
  at the door, not at checkout. The matched row is the join key for
  whatever loyalty system is downstream.
- **Staff verification and after-hours intrusion** in the same model.
  The on-duty shift roster is enrolled as "staff"; an unfamiliar face
  in a back-of-house camera at 2am is the same `face_matches` row with
  a role of `unknown`. One model, three operational doctrines.
- **One Postgres for everything operational.** Lakebase is already the
  app's read/write database; `pgvector` makes it the vector index too.
  No separate Pinecone / Weaviate / Milvus bill, no second governance
  surface, no second on-call rotation. The vector search runs over the
  same OAuth-authenticated connection the rest of the app uses.

Why this lands with the platform team:
- The endpoint is **self-contained** - the model pack travels in the
  MLflow artifact, validated with onnxruntime at log time, so there's
  no "model zoo downloaded a 503" failure mode at cold start.
- Inference is **CPU-only** (`CPUExecutionProvider`, `Small` workload).
  Operators can run it cheaply on every store, not just flagship sites.
- The whole pipeline is **boundaried by Unity Catalog**: enrolled
  thumbnails, embeddings, and match history are tables the privacy
  team can apply column masks, row-level security, and retention to
  exactly like any other PII column.

Where this lands hardest: **retail loss prevention, hotels and
hospitality, casinos and gaming, stadiums and venues, secure
back-of-house in QSR / manufacturing / fuel.**

---

## Section 5 - TELL: the unlock is zerobus, Delta, and Lakebase

This is the recap. Spend 60 seconds here. Don't pivot back to features.
Three pieces, in the order data flows.

> "First, the **ingest**. **Zerobus** lets a camera, a mobile app, or any
> edge device write directly into Unity Catalog - sub-second, governed, no
> message broker in between. The same channel we're using to stream
> detections here is the one our mobile teams are moving onto next. If a
> guest taps a button in your app, that event lands in the same governed
> table as the camera saw it. One channel for every signal."

> "Second, the **storage**. Every frame, every detection, every pipeline
> transformation is a **Delta** table - ACID transactions, time-travel,
> schema enforcement. That's what makes it safe for thousands of cameras
> to write while a serverless pipeline is enriching and a dashboard is
> reading. You don't need a separate analytics database; the lake is the
> database."

> "Third, the **operator layer**. The gold output of that pipeline lands in
> **Lakebase Postgres** - autoscaling, Postgres-flavored OLTP that the app
> reads and writes back to. That's how you get millisecond
> tap-to-acknowledge on the floor *and* the same incident row available in
> the lake for tomorrow's executive report. Operational and analytical on
> one surface."

> "And once it's all in Delta, **Genie** lets your analysts *talk* to the
> data in plain English. The CFO doesn't file a ticket with the data team
> to ask 'which stores had the most spills this week' - they just ask.
> Every detection your camera produced is a question your business is
> already trying to answer."

> "All of it - models, lake, Postgres, app, Genie - is one bundle, one
> bill, one security boundary. That used to be a six-month
> system-integration project with three vendors. Today it's an afternoon."

The slogan to leave them with:

> **"Don't just visualize the lake. Action it."**

---

## Section 6 - Outcomes by vertical

Pick the ones that match the badge in front of you. Lead with the dollar
figure, not the model. Cross-reference Section 4 for the model that
unlocks each outcome.

### Quick-serve and casual dining

- **Time-to-cone on a spill** under 90 seconds (Section 4.1), with an
  audit trail your insurance carrier will accept. Slip-and-fall claims
  average mid-five figures per incident.
- **Drive-thru SLA** measured per order, not per car at the window
  (Section 4.2). Coaches by shift, not by store, with the camera
  evidence to back it.
- **PPE and food-safety compliance** as a weekly coaching trend, not a
  punitive write-up (Section 4.5).
- **Banned-subject and shift-roster verification** in the lobby and
  back-of-house (Section 4.6). Trespass enforcement and on-duty staff
  check, same endpoint, same database as the rest of the operator app.

### Convenience and fuel

- **People-to-pump-to-store conversion** (Section 4.3). The denominator
  the chain has never had. If your canopy traffic is up but your
  in-store basket isn't, you finally know it - and you know which store,
  which shift.
- **Pump-island fraud and drive-offs** (Section 4.2). For some chains
  this single line item pays for the whole platform in a quarter.
- **Repeat-customer recognition** without an app or a punch card
  (Section 4.2). Plate comes in, manager gets a Slack ping, customer
  gets a free coffee.
- **Camera health on the canopy and freezer aisle** (Section 4.4). The
  freezer dome cam that fogs over every winter is the same camera your
  LP team relies on. Catch it before the model misses a theft.
- **Banned-shopper alerting** at the door of the c-store
  (Section 4.6). A previously-trespassed subject walks in, the manager's
  tablet flashes red, the incident is one row in Lakebase with the live
  frame attached.

### Travel, hospitality, and stadiums

- **Queue management** at check-in, gate, and concessions (Section 4.3).
  Move staff before the line breaks an NPS threshold, not after.
- **Asset and incident detection** in lobbies, lots, and back-of-house -
  unattended bags, slips (Section 4.5), smoke, after-hours presence.
- **Loyalty and VIP detection** at the front door, not at the POS
  (Section 4.2 for plates, Section 4.6 for faces). Plate at the
  porte-cochere, face at the lobby, same row stream the front-desk
  concierge or casino host is watching.

### Stadium, venues, and live events

- **Per-section concession throughput** to rebalance staff in real time
  (Section 4.3).
- **Crowd density and egress** monitoring with alerts to operations.
- **Lost-and-found and incident response** with timestamped, queryable
  footage instead of a binder.
- **Banned-subject enforcement at the gate** (Section 4.6) for venues
  with a no-trespass list. The match fires before the subject reaches
  the turnstile.

A single sentence to anchor any of these:

> "You already paid for the camera. You already pay for Databricks. We're
> just connecting the wires you already own."

---

## Section 7 - The close (30 seconds)

> "If your team has built a computer-vision proof of concept in the last
> two years, they spent most of it on plumbing - moving footage, hosting
> models, governing the output, getting it to an operator. None of that is
> the moat. The moat is the model your team trains on **your** footage of
> **your** floor. Everything else - the ingest, the serving, the lake, the
> app, the write-back - is a bundle deploy."

Three offers, in order of commitment:

1. **A walkthrough on your footage.** Send us a few clips, we'll show you
   the same loop running on your frames within a workshop.
2. **A free Databricks demo workspace** preloaded with this code so your
   team can poke at it.
3. **A scoped pilot.** Pick one outcome from Section 4 - usually spill
   response or drive-thru SLA for QSR, conversion or fraud for fuel - and
   we run it end to end in a single store.

---

## Q&A primers

Short, business-first answers. Keep the architecture answer for the SA on
the booth, not the opening pitch.

**"How is this different from the CV vendor we already evaluated?"**
Most CV vendors give you their dashboard. We give you rows in your lake.
That difference is what lets your finance, ops, and loyalty teams use the
same numbers - and what lets you swap the model without swapping the
platform. Each use case in Section 4 is a separate endpoint you can turn
on, off, or version on its own.

**"What does it cost to run?"**
Three line items, all elastic: model serving (one endpoint per use case,
scale to zero between events), the operational write-back database
(Lakebase Postgres), and Delta storage for whichever frames you choose to
keep. The fog detector (Section 4.4) is pure CPU and runs for pennies.
Most customers persist only the frames around an alert, so storage is
small.

**"What happens when a thousand cameras write at once?"**
Delta handles concurrent writes by design - the lake is the buffer.
Zerobus ACKs each record as it lands. Your enrichment pipeline reads from
the same Delta table without blocking, and the gold layer flows into
Lakebase Postgres for the operator app. Each tier scales independently.

**"Why Postgres in the middle - isn't the lake enough?"**
For the things an operator does in the moment - opening an incident,
acknowledging a spill, updating a status - you want millisecond UPDATEs,
not append-only Delta writes. Lakebase gives you that *and* keeps the
data synced back to Unity Catalog automatically, so analytics is never
out of date. Same governance surface, two access patterns.

**"What about privacy - faces and plates?"**
Same governance surface as the rest of your data. Blur at the edge, or
keep raw frames behind Unity Catalog row-level security. Every read is in
the audit log. The privacy team writes the policy once, in the place they
already write it.

**"How does the face recognition stay compliant - BIPA, GDPR, the rest?"**
Three concrete things. First, **the enrolled set is the customer's own
table.** Nothing leaves their workspace; there's no third-party face
database. Second, the embeddings themselves are stored as `pgvector`
columns in Lakebase under the same Unity Catalog policy the customer
already enforces on PII - row-level security, column masks, retention,
audit, the works. Third, **consent and right-to-erasure are one DELETE**
against the `faces` row, which cascades through the `face_matches`
history. The model serving endpoint runs inside the customer's account
on `CPUExecutionProvider`, with no outbound network calls at inference
time. That's the answer for BIPA in Illinois, GDPR Article 9 in the EU,
and the equivalent biometrics statutes in the rest of the world - the
customer owns every leg of the data path.

**"What happens if a model is wrong?"**
You see the detection in the same row stream the operator does, with the
frame attached. Wrong detections are a labelled-data set, not a support
ticket. Your team's next model train uses them. The fog detector
(Section 4.4) also tells you when a model is being asked to see through
a smudged lens, which closes the loop on "is this a model bug or a
camera bug?"

**"Can we bring our own model?"**
Yes. Any MLflow model goes in Unity Catalog and serves on the same
endpoint pattern. You get versioning, RBAC, and a cost line per model out
of the box. Every detector you saw in Section 4 is exactly that - we
just shipped them with the demo.

**"How fast is the ingest?"**
Sub-second from camera to lake on Zerobus. The bottleneck is the store
network, not the platform. Mobile and IoT use cases ride the same channel.

**"How long does a real pilot take?"**
Two to four weeks for one outcome in one store, assuming we can get to the
camera feed and a small label set. The point of the pilot is to defend a
number to the CFO, not to prove the tech works.

---

## Appendix - one-line architecture (for the SA)

```
Cameras / mobile / edge -- Zerobus -->  Delta bronze in Unity Catalog
                                        (frames, raw detections)
                                              |
                              Spark Declarative Pipeline (serverless)
                              bronze -> silver -> gold, all Delta
                                              |
                          +-------------------+-------------------+
                          |                                       |
                Model Serving                              Lakebase Postgres
                (one endpoint per                          (operator state:
                 use case, scale                            incidents, ACKs,
                 to zero)                                   write-back)
                          |                                       |
                          +-------------------+-------------------+
                                              |
                                Databricks App (LensIQ UI -
                                live, alerts, swimlane,
                                composable with Genie + AI/BI)
                                              |
                              Lakebase synced tables back to Delta
                              -> analytics, Genie, agents always fresh
```

One bundle. One workspace. One bill. Delta is the durable spine, Lakebase
is the operator path, Zerobus is the on-ramp.

### Model endpoints in the bundle

| Demo page          | Model id           | Serving endpoint           | What it does                                                  |
| ------------------ | ------------------ | -------------------------- | ------------------------------------------------------------- |
| Live               | `yolo`             | `lensiq-detector`          | General-purpose YOLOv8: people, vehicles, products            |
| Spills             | `spill`            | `lensiq-spill`             | Liquid on the floor                                           |
| Spills             | `wet_floor_sign`   | `lensiq-wet-floor-sign`    | Yellow caution cone deployment                                |
| Plates             | `license_plate`    | `lensiq-license-plate`     | Plate detection (paired with Claude vision OCR)               |
| Guests             | `yolo`             | `lensiq-detector`          | Person + vehicle tracking, two feeds in parallel              |
| Camera Clarity     | `fog_detector`     | `lensiq-fog-detector`      | Pillow + numpy lens-condition diagnostic, no GPU              |
| Facial Recognition | `face_recognition` | `lensiq-face-recognition`  | InsightFace `buffalo_l` (SCRFD + ArcFace 512-d) + pgvector match in Lakebase |
| Live (specialty)   | `slip_fall`        | `lensiq-slip-fall`         | Standing vs fallen person                                     |
| Live (specialty)   | `hard_hat`         | (on-demand)                | PPE compliance                                                |
| Live (specialty)   | `cigarette_vape`   | `lensiq-cigarette-vape`    | Age-gated area loss-prevention                                |

Each endpoint is independently versioned, owned, and billed. Adding a new
use case is one notebook (`notebooks/deploy_*.ipynb`) plus one row in
`resources/app.yml`.

---

## Notes for the presenter

- **Time budget.** Three minutes on Section 1, one on Section 2
  (architecture diagram), five on Section 3 (pick the two or three
  demo stops that match the badge, always end on Genie), one on
  Section 5, two on Sections 6-7. Section 4 is the reference material
  you reach for when the customer asks for detail on a specific
  model - don't read it aloud end-to-end.
- **5-minute version.** Section 1 (one minute), the architecture
  diagram (Section 2, 30 seconds), Spill Detection (Section 3 stop 2),
  Camera Clarity (Section 3 stop 5) to land the "platform of
  platforms" pitch, then Genie (Section 3 stop 9) and the close.
  Skip everything else.
- **3-minute version.** Section 1 in 30 seconds, the architecture
  diagram (Section 2, 20 seconds), Spill Detection (Section 3 stop 2),
  Genie (Section 3 stop 9), close.
- **The LP-heavy version.** Spill Detection (Section 3 stop 2) for
  the carrier story, then Facial Recognition (Section 3 stop 6) for
  the banned-shopper / VIP / staff trio - it's the booth's most
  visceral live demo because the badge blinks red the moment a
  banned face walks in. Close on Genie (Section 3 stop 9) so the LP
  director sees they can ask "who's our most-repeat trespasser this
  month" in plain English.
- **Don't open the IDE.** This is a business demo, not a code review. The
  appendix and the deeper architecture are for the SA standing behind you.
- **No customer logos.** This demo is generic so it can be reused.
- **If a model is cold,** narrate it: "endpoints scale to zero, so the
  first frame wakes the model - in production it's already warm because
  another camera fired ten seconds ago." Don't apologize for it.
- **If asked about ROI,** anchor to the dollar lines in Section 4 (slip
  claims, drive-offs, conversion, cleaning routes) - not to "savings on
  dashboards."
