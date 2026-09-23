---
name: schedule-later
description: "Come back to this chat later on your own: schedule_message sends a message into this chat at a set time, and it wakes you as a new turn. Use it WITHOUT being asked whenever the right move is to check again later rather than now — a build, deploy, download, job, CI run or long command still running; a page, price, status or result that will change; something the user said they will do (\"I'll reply after lunch\") — and whenever the user says remind me, ping me, check back, follow up, later, tonight, tomorrow, in N minutes/hours, every day, or after a time. Never sleep, poll in a loop or tell the user to come back when a scheduled check-in would do it."
---

# Schedule later: come back to this chat on your own

`schedule_message` puts a message into **this** chat at a time you choose. When
it fires, it arrives as a new user turn marked `[Scheduled by the assistant]`,
and you answer it like any other turn — with the whole conversation still
there. It is how you keep a promise to come back.

| Tool | Use it to |
| --- | --- |
| `schedule_message` | `message` + either `delay_minutes` or `at` (ISO 8601, local time without an offset). |
| `list_scheduled_messages` | See what is already pending here, and the current local time. |
| `cancel_scheduled_message` | Cancel one **you** scheduled, by id. The user's own you cannot touch. |

Limits: at least 1 minute ahead, at most 30 days, at most 10 pending that you
scheduled in one chat.

## When to schedule without being asked

Schedule when **waiting is the right answer and the user would want you to
come back**, not only when they say "remind me":

* **Something is still running.** A build, deploy, test suite, migration,
  download, render, training run or CI pipeline you started or were shown.
  Instead of sleeping or asking the user to tell you when it is done, schedule
  a check at the time it should finish.
* **Something will change.** A page that updates, a status that flips, a
  price, a queue, a PR waiting for review, an email reply the user expects.
* **The user deferred something.** "I'll send the file after lunch", "let's
  pick this up tonight", "remind me before the meeting".
* **The user asked for repetition.** "Every morning", "each hour". The tool
  sends once, so each run schedules the next one at its end.

Do **not** schedule:

* what you can do right now in this turn;
* checks the user did not want — if you are unsure, ask in one line first;
* a second copy of something already pending — `list_scheduled_messages`
  before scheduling anything that might already be there;
* shorter than the thing takes — a 20-minute build is checked in ~20 minutes,
  not every minute.

## Writing the message

The message is an instruction **to your future self**, who reads it cold. The
conversation will still be there, but it may have been compacted, so put the
facts in the message itself:

* what to check, and exactly how (the command, path, URL, job id, PR number);
* what "done" looks like, and what to do in each case — report, fix, retry,
  schedule another check;
* who asked and why, in a clause.

Good:

> Check the release build started at 14:05: run `gh run view 8812 --json status,conclusion`. If it passed, tell the user the release is ready and link the run. If it failed, read the failing step's log, summarise the cause, and propose a fix. If it is still running, schedule one more check in 10 minutes.

Bad: `check the build` — your future self will not know which build.

## After you schedule

Tell the user in one line **what** you will do and **when**, in their local
time, and that they can cancel it from the **Scheduled** panel. For example:
*"I'll check the build again at 3:25 PM (in 20 min) — cancel it from
Scheduled if you'd rather not."*

## When a scheduled message arrives

* Do what it says, then report.
* If it is recurring, schedule the next one **before** you finish.
* If the work turned out to be done already, say so briefly — do not
  reschedule.
* If a later event makes one of your pending messages pointless, cancel it.
