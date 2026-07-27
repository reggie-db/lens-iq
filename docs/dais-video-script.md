LensIQ — Demo Video Script (~4 minutes)
App: https://lens-iq-7474652124440999.aws.databricksapps.com/live
Github: https://github.com/reggie-db/dais-demos

________________

Pre-demo checklist
* App is warm — load /live once before recording so the first frame isn't waking a cold model
* Sample clips queued: aisle spill clip, forecourt + c-store guest feeds
* A face ready to enroll (photo or webcam) for the Facial Recognition stop
* Genie space open in a second tab

________________

[0:00 – 0:25] Setup
[On camera or title card, before touching the app]

"Hi, I'm Reggie, a Solutions Architect at Databricks. Every retailer pays for their cameras twice — once to install them, and again every time something goes wrong that they could have caught live. Today that footage is post-incident evidence: someone scrubs clips on Monday to explain what went wrong Friday. But it's the highest-resolution behavioral data in the building — who came in, what they didn't buy, where they slipped, which pump they used without paying — and almost none of it reaches a decision. Let me show you how LensIQ turns that same footage into a revenue and risk lever, on the Databricks you already own."

________________

[0:25 – 0:55] Architecture at a glance
[Show the architecture page, or a simple four-box graphic: Camera → Zerobus → ETL → Lakebase]

"Before the app, the whole thing is four boxes. Your camera — whatever you already own, no rip-and-replace. Zerobus, the on-ramp that writes every frame straight into Unity Catalog, sub-second, no Kafka, no message broker. A serverless pipeline that runs a model on every frame and lands enriched detections in Delta. And Lakebase — Postgres-fast reads and writes for the operator app, synced back to Delta so analytics is never stale. Every page I'm about to show reads and writes through that same loop. There's no separate computer-vision stack — it's the same lake your finance and supply-chain data already live in. One bundle, one bill, one security boundary."

________________

[0:55 – 1:40] Spill Detection
[Click Spill Detection. Let the aisle clip play.]

"Here's the same footage your stores already record — except every frame is being scored right now. Watch: the spill lights up at second one."

[Cone enters frame / click Place cone at 0:27]

"The wet-floor sign goes down at second 27."

[Point at the stopwatch and the response cards in the corner]

"The model just measured your time-to-cone as a number you can put on a dashboard. The fastest, last, and average-response cards are reading straight out of Lakebase. A slip-and-fall claim averages mid-five figures, an insurance carrier wants proof you responded, and a regional VP can finally answer 'which stores are slow?' — all from one row. The conversation goes from 'did anyone see the spill Friday?' to 'your Tuesday closing crew averages four minutes, the chain's at ninety seconds — what do they need?'"

________________

[1:40 – 2:20] Guest Counts
[Click Guest Counts. Two feeds — forecourt + c-store — light up side by side.]

"Different problem. Fuel traffic is up, but inside sales aren't keeping pace. We're counting people on the forecourt, cars at the pumps, and people in the c-store — in parallel, from separate cameras, on one screen. These are unique tracks, not raw detections, so a person standing at a pump for thirty seconds counts once, not thirty times."

[Point at the three cards, then the activity-over-time chart]

"Divide in-store by pump users and you have canopy-to-store conversion — the denominator a fuel chain has never had. Now a regional manager sees exactly which stores turn traffic into baskets and which need attention, by store and by shift."

________________

[2:20 – 3:05] Facial Recognition
[Click Facial Recognition. Enroll a face at the booth — snap or upload a photo, pick a role.]

"This is the most visceral one. I'll enroll a face right here — photo, pick a role: banned, VIP, or staff."

[Step in front of the webcam — the box flips from 'Unknown' to a name and similarity %]

"Under the hood that's two models on one frame: InsightFace finds the face, ArcFace turns it into a 512-dimension embedding. That embedding goes into Lakebase, and pgvector runs a cosine search against everyone we've enrolled — in the same Postgres the rest of the app already uses. No separate vector database."

[Switch the role to banned, walk back in — badge blinks red, toast fires]

"The roles are what make it a business app. Banned blinks red and fires a toast — that's loss prevention. VIP goes gold — that's the host being told who just walked in. Staff goes blue — on-duty check, or after-hours intrusion at 2am. Same model, three conversations. And the enrolled faces never leave the customer's workspace — it runs CPU-only in their own account, governed by the same Unity Catalog rules as the rest of their PII."

________________

[3:05 – 3:40] Genie
[Switch to Genie. Ask one question in plain English.]

"Everything you just saw is now a row in Delta. So your analysts don't need a new tool to use it."

[Type:] "Which stores had the slowest spill response times this week?" [Run]

[Genie returns the answer]

"It just answers, against the exact same tables driving the app. The CFO asks the question they were going to email the data team. The regional VP compares stores without opening a BI tool. The loss-prevention lead pulls repeat plate offenders without writing SQL — same governance, the row-level security and column masks already configured. Every detection the camera produced is a number an analyst can talk to."

________________

[3:40 – 4:00] Close
[Back in the app]

"So zoom out. The moat isn't the plumbing — moving footage, hosting models, governing output. That's a bundle deploy. The moat is the model trained on your footage of your floor. Models, lake, Postgres, app, and Genie — one bundle, one bill, one security boundary. That used to be a six-month, three-vendor integration. Today it's an afternoon. You already paid for the camera. You already pay for Databricks. We're just connecting the wires you already own."

[Beat]

"Don't just visualize the lake. Action it."

________________

Demo data quick-ref
Thing                  Value
App                    https://lens-iq-7474652124440999.aws.databricksapps.com/live
Pivotal spill clip     Aisle clip — spill at 0:01, cone at 0:27
Guest feeds            Forecourt + c-store; conversion = in_store ÷ pump_users
Face roles             banned (red) · VIP (gold) · staff (blue) · unknown (slate)
Genie openers          "slowest spill response this week"; "lowest pump-to-store conversion"; "plates seen at 3+ locations"

LP-heavy alt: swap Guest Counts for keeping Facial Recognition front and center, and open Genie on "who's our most-repeat trespasser this month".
