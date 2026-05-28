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

## Section 2 - SHOW: walk the app

Three stops. Total time on this section: about four minutes. The point is
that the audience sees footage become a row, a row become an alert, and an
alert become an action - in seconds.

### Stop 1: Live Detection (`/live`)

What to do:
1. Click **Live Detection** in the sidebar.
2. Pick a sample clip (or the webcam at the booth).
3. Let the bounding boxes start painting.

What to say:
> "This is the same footage your stores already record. The difference is
> that every frame is being scored by a model right now. Spill, slip,
> license plate, person at the pump, PPE - any of it. Each model runs
> independently, so the team responsible for safety doesn't share a release
> cycle with the team responsible for loyalty."

Why this matters to the buyer:
- One platform, many use cases. They don't pick a vendor per problem.
- The models scale to zero between events. They pay for inference, not for
  idle GPUs.

### Stop 2: Live activity from the lake (`/detections` or `/alerts`)

What to do:
1. Click **Detections** (or **Alerts**).
2. Point at the rows streaming in from the camera demo you just did.

What to say:
> "What you just saw on the video isn't a screenshot. It's a row in the
> lake. The moment the camera saw it, it landed in Unity Catalog - the same
> place your finance, supply chain, and HR data live. That means your loss
> prevention team, your dashboards, your AI agents, and your operations app
> are all looking at the *same* event with the *same* governance."

Why this matters to the buyer:
- They were going to buy a separate computer-vision system that wrote to
  its own database. Now there isn't one. There's just the lake.
- Audit, retention, redaction, and PII rules they already wrote for the
  rest of the business apply to footage too.

### Stop 3: Composability (`/trends` or `/overview`)

What to do:
1. Click **Trends** or **Overview**.
2. Show the dashboards reading the same detection table the live page reads.

What to say:
> "The same row that just flashed on the alerts page is feeding this
> dashboard, the Genie space your regional VP uses to ask questions in
> English, and the weekly executive report. One source of truth - four
> interfaces - no duplicated pipelines."

Why this matters to the buyer:
- They have asked their data team for "one number" for years. Footage
  finally rolls up into the same number everyone else is using.

---

## Section 3 - TELL: the unlock is zerobus + one workspace

This is the recap. Spend 60 seconds here. Don't pivot back to features.

> "What changed is two things. First, the ingest. **Zerobus** lets a camera,
> a mobile app, or any edge device write directly into Unity Catalog -
> sub-second, governed, no message broker in between. The same channel
> we're using to stream detections here is the one our mobile teams are
> moving onto next. If a guest taps a button in your app, that event lands
> in the same governed table as the camera saw it. One channel for every
> signal."

> "Second, the workspace. Models, lake, app, and write-back are one bundle,
> one bill, one security boundary. That used to be a six-month
> system-integration project with three vendors. Today it's an afternoon."

The slogan to leave them with:

> **"Don't just visualize the lake. Action it."**

---

## Section 4 - Outcomes by vertical

Pick the ones that match the badge in front of you. Lead with the dollar
figure, not the model.

### Quick-serve and casual dining

- **Time-to-cone on a spill** under 90 seconds, with an audit trail your
  insurance carrier will accept. Slip-and-fall claims average mid-five
  figures per incident.
- **Drive-thru SLA** measured per order, not per car at the window.
  Coaches by shift, not by store, with the camera evidence to back it.
- **PPE and food-safety compliance** as a weekly coaching trend, not a
  punitive write-up.

### Convenience and fuel

- **People-to-pump-to-store conversion**. The denominator the chain has
  never had. If your canopy traffic is up but your in-store basket isn't,
  you finally know it - and you know which store, which shift.
- **Pump-island fraud and drive-offs**. For some chains this single line
  item pays for the whole platform in a quarter.
- **Repeat-customer recognition** without an app or a punch card. Plate
  comes in, manager gets a Slack ping, customer gets a free coffee.

### Travel, hospitality, and stadiums

- **Queue management** at check-in, gate, and concessions. Move staff
  before the line breaks an NPS threshold, not after.
- **Asset and incident detection** in lobbies, lots, and back-of-house -
  unattended bags, slips, smoke, after-hours presence.
- **Loyalty and VIP detection** at the front door, not at the POS.

### Stadium, venues, and live events

- **Per-section concession throughput** to rebalance staff in real time.
- **Crowd density and egress** monitoring with alerts to operations.
- **Lost-and-found and incident response** with timestamped, queryable
  footage instead of a binder.

A single sentence to anchor any of these:

> "You already paid for the camera. You already pay for Databricks. We're
> just connecting the wires you already own."

---

## Section 5 - The close (30 seconds)

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
platform.

**"What does it cost to run?"**
Three line items, all elastic: model serving, the operational write-back
database (Lakebase), and storage for whichever frames you choose to keep.
Models and database scale to zero between events. Most customers persist
only the frames around an alert, so storage is small.

**"What about privacy - faces and plates?"**
Same governance surface as the rest of your data. Blur at the edge, or
keep raw frames behind Unity Catalog row-level security. Every read is in
the audit log. The privacy team writes the policy once, in the place they
already write it.

**"What happens if a model is wrong?"**
You see the detection in the same row stream the operator does, with the
frame attached. Wrong detections are a labelled-data set, not a support
ticket. Your team's next model train uses them.

**"Can we bring our own model?"**
Yes. Any MLflow model goes in Unity Catalog and serves on the same
endpoint pattern. You get versioning, RBAC, and a cost line per model out
of the box.

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
Cameras / mobile / edge -- Zerobus -->  Unity Catalog (detections, frames)
                                              |
                                  Model Serving (one endpoint per use case)
                                              |
                                Databricks App (LensIQ - live + write-back)
                                              |
                                  Lakebase Postgres (operator state)
                                              |
                              Synced back to UC for analytics, Genie, agents
```

One bundle. One workspace. One bill.

---

## Notes for the presenter

- **Time budget.** Three minutes on Section 1, four on Section 2, one on
  Section 3, two on Sections 4-5. The 5-minute version cuts Section 4 to
  one vertical and skips Q&A.
- **Don't open the IDE.** This is a business demo, not a code review. The
  appendix and the deeper architecture are for the SA standing behind you.
- **No customer logos.** This demo is generic so it can be reused.
- **If the model is cold,** narrate it: "endpoints scale to zero, so the
  first frame wakes the model - in production it's already warm because
  another camera fired ten seconds ago." Don't apologize for it.
- **If asked about ROI,** anchor to the outcomes in Section 4 with the
  insurance, fraud, or conversion line items - not to "savings on
  dashboards."
