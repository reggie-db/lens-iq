# LensIQ Rapid Fire Talk Track

Target time: 3 minutes 35 seconds

## 10 minutes before

- Open the app on the Fleet Dashboard and confirm it is authenticated.
- Treat Fleet Dashboard KPIs as illustrative boardroom theater only. Do not cite dollar figures or percentages as customer proof.
- Open Spill Detection once and let the model warm up.
- Open Guest Counts once and confirm both videos load.
- Keep Spill Detection and Guest Counts in separate tabs if navigation is slow.
- Close notifications and any tabs that could expose customer information.
- Start a phone timer when the presenter before you begins.

## [0:00 - 0:25] Set up the problem

[Show the Fleet Dashboard]

"Hi, I am Reggie. This is LensIQ, a technology demo built on Databricks.

The business idea is simple. Retailers already have thousands of cameras. They paid for the hardware, the network, and the footage, but usually use that asset only after an incident. Someone reviews video to explain what went wrong days ago.

That makes camera footage one of the most underutilized assets in the building. This boardroom view is illustrative. It shows the kinds of outcomes a fleet operator would want. The live model pages are where the technology becomes actionable."

## [0:25 - 1:30] Make safety actionable

[Open Spill Detection and let the aisle clip play]

"Here is a simple example. The system detects a spill, then separately detects when the wet floor sign appears.

The spill appears at second one. The sign appears at second twenty-seven."

[Point to the response timer and summary cards]

"The technology is computer vision, but the business outcome is a measurable time-to-cone KPI. A store manager can respond now. A regional leader can compare response times by store and shift. A risk team gets a timestamped audit trail instead of manually reviewing footage after a claim.

The business value is reduced safety risk, faster coaching, and evidence that the team followed procedure. The important part is not another alert. It is an operational metric the business can improve."

## [1:30 - 2:35] Connect activity to revenue

[Open Guest Counts]

"Now let us use the same platform for revenue.

These two feeds count people at the pumps, vehicles on the forecourt, and guests entering the store. They are unique tracks, so one person standing at a pump is counted once, not once per frame."

[Point to the three counters and activity chart]

"Divide in-store guests by pump users and we get pump-to-store conversion.

That gives regional operations a denominator they did not have in the POS system. They can see which locations convert fuel traffic into store visits, then test staffing, signage, offers, or store layout and measure whether conversion improves.

This technology demo is not claiming a measured customer result. It demonstrates where the value comes from: connecting camera activity to an operating decision and a business KPI instead of stopping at object detection."

## [2:35 - 3:10] Explain why Databricks

[Return to the Fleet Dashboard or remain on Guest Counts]

"Every detection becomes governed data on Databricks. Model Serving scores the footage, Lakebase gives the app fast operational reads and writes, and the same events are available in Unity Catalog for analytics, alerts, dashboards, and Genie.

The customer does not need a separate computer vision data stack for every use case. The models can change, but the governed data and application pattern stay the same."

## [3:10 - 3:35] Re-skin and close

"LensIQ starts with convenience retail, but this is a platform pattern with significant room to expand. The camera and governed data foundation stay the same while the model, workflow, and business action change.

Re-skin it for queue management in QSR and stadiums, camera health in grocery, guest service in hospitality, safety compliance in manufacturing, beverage refills in restaurants, or pump and inventory signals in convenience retail.

You already paid for the camera. LensIQ shows how to turn that underutilized asset from post-incident evidence into a growing source of revenue, risk, and operational signals. Do not just visualize the lake. Action it."

## If running long

At 2:45, skip the Databricks architecture paragraph and go directly to:

"This technology demo starts with convenience retail, but the same pattern can expand across QSR, grocery, hospitality, stadiums, and manufacturing. You already paid for the camera. LensIQ shows how to turn that underutilized asset into live business signals."

## Backup if a model is cold

"The serving endpoint scales to zero when it is idle. While it wakes up, the key point is that each use case has its own independently deployed model, but every result follows the same governed data and application pattern."

## Do not claim

- Named customer logos, pilots, or measured ROI from a specific account.
- Fleet Dashboard dollar figures or percentages as live or customer-sourced data.
- A separate `lensiq-spill` endpoint. Spill detection runs through the Claude vision path in this demo.
- Shipped detectors that are not in the app today, such as age-gate or hard-hat models.
- Slack pings, agents, or other integrations unless you are showing them live.
- Genie unless you are in a workspace-authenticated session where the chat button works.
