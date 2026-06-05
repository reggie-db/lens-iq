# LensIQ Booth Talk Track (Data + AI Summit)

## Live Detection

"Most companies already have cameras everywhere, but almost none of that data ends up in their analytics platform.

What we're showing here is a live video stream where every frame is being processed by a model and turned into structured data. Different detectors can look for different things: spills, people, vehicles, license plates, camera issues, and so on.

The interesting part isn't really the model. It's that the output lands in Databricks alongside everything else the business already tracks."

---

## Spill Detection

"This is one of the simpler examples.

The model identifies a spill and separately identifies when a caution cone appears. That lets us measure response time automatically.

Instead of reviewing footage after an incident, you can start tracking operational metrics directly from video. In this case, we're calculating time from spill detection to mitigation."

---

## Facial Recognition

"This demo usually gets people's attention because it's very visual.

We enroll a face, assign a role, and then the system recognizes that person when they reappear.

Under the covers we're generating embeddings and matching them against enrolled identities stored in Lakebase with pgvector.

The point isn't really facial recognition specifically. It's that video can become another searchable dataset inside the platform."

---

## Detections / Activity Feed

"Everything we've done so far is creating rows in Delta tables.

Every detection, timestamp, model version, and associated metadata becomes data that can be governed, queried, and analyzed like any other business dataset.

The application is reading from Lakebase for operational responsiveness, but the same information is available in the lake for analytics."

---

## Genie

"This is where things start to get interesting.

Once video events become rows in tables, they become something you can ask questions about.

For example: 'Which stores had the most spills this week?'

The user doesn't need to know where the data came from. To Genie it's just another governed dataset in Unity Catalog."

---

## Close

"The main idea isn't really computer vision.

It's taking a data source that traditionally lives in a silo and making it part of the rest of the data estate.

Once that happens, you can build applications, dashboards, alerts, agents, and analytics on top of it using the same platform you're already using for everything else."

## Tone Notes

Avoid:
- Revenue and risk lever
- One bundle, one bill
- Pays for itself
- Insurance carrier wants in discovery
- You already pay for Databricks
- Moat
- Six month project with three vendors

Focus on:
- Interesting technical architecture
- How video becomes data
- Unity Catalog governance
- Delta + Lakebase integration
- Real-time operational applications
- Genie and downstream analytics
