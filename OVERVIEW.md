# Email Preflight — Overview

*Draft, 26 Aug 2026 · Saksham Mathur*

A sidebar component for the Marketing Cloud Next email builder that checks an email **before** it is
sent and reports what it finds.

---

## The problem

Marketing Cloud Engagement had a validation step before send. Marketing Cloud Next does not, and
three things follow from that:

- **QA falls to whoever built the email.** Resource constraints mean developers routinely review
  their own work, which is the review least likely to catch anything.
- **Failures are discovered after the fact.** When a send goes wrong, the evidence is in the Email
  Engagement Data Model Objects — you are reading rows to reconstruct what happened, after the email
  has already gone out.
- **Copy-and-edit is how most emails get made, and it is where most errors come from.** Duplicating
  last month's campaign and editing it leaves behind the things nobody thought to change: a link
  still pointing at the old landing page, placeholder copy, a subject line from the template.

None of these are hard problems to *check*. They are hard problems to check *consistently*, by hand,
under time pressure, on the tenth email of the day.

## What it is

A read-only panel inside the email builder, reached through the 🧩 toolbox. It reads the email you
have open and reports on it. It cannot edit your content and cannot block a send — the worst case is
a wrong report, never a damaged email.

It has two tabs, which answer two different questions.

| Tab | Question it answers |
|---|---|
| **Email Issues** | Is anything wrong with this email? |
| **Email QA** | Does this email match what the spec says it should be? |

---

## Tab 1 — Email Issues

Runs **77 checks** across 20 categories as soon as the panel opens. No button to press.

### Three severities

- **Error** — will break the send or ship visibly broken. Fix before sending.
- **Warning** — probably wrong, but legitimate exceptions exist. Review.
- **Note** — informational. No action implied.

The separation is the point. A tool that reports everything at one volume gets ignored, so anything
that might legitimately be intentional is a warning or a note, never an error.

### What it catches, by way of example

**Errors** — missing subject line, missing preheader, broken personalisation syntax, and giveaway
text like "draft", "lorem ipsum" or "do not send" left in the copy.

**Warnings** — no unsubscribe link, no preference centre, no postal address, images with no alt
text, and layout choices that break on mobile such as columns that will not stack.

**Notes** — subject lines long enough to be truncated in the inbox, images with no link where one
was probably intended, and inconsistent spacing between sections — 30px on one and 100px on the
next, which is almost always an accident.

### It tells you *where*

A finding that says `lightning/section` names a type and leaves you to work out which of six
sections it means. Instead, every finding is located the way the builder's own Component Tree
presents it — `Section 3 of 6 — "Everything reduced until Sunday"` — so you can go straight to it.

Fix something, hit **Re-check**, and it drops off the list.

---

## Tab 2 — Email QA

The Issues tab applies rules the tool carries itself. The QA tab answers a different question: does
this email match what somebody wrote down?

This is aimed squarely at the copy-and-edit problem. You have last month's email and this month's
spec, and you need to confirm every field was actually updated.

The tab reads the email and lists **what is actually in it** — one row per link, per button label,
per image — each named by the component it sits in and showing its current value. You type what it
*should* be and validate that row. Anything left blank is skipped, not passed, so an unchecked row
never looks like a checked one.

It validates subject line, preheader, link destinations, button and link text, image files, and
image alt text.

Comparison is exact, but a failure explains itself. Pasting a subject line out of Word silently
substitutes curly quotes and non-breaking spaces, so a plain comparison would report a mismatch
between two strings that look identical on screen — and the reviewer would conclude the tool is
broken. Instead the failure names the actual difference: curly versus straight quotes, a
capitalisation change, a merge field standing where the spec has an example value, or a genuine
wording difference and where it starts.

---

## Getting the results out

**Copy report** puts a plain-text version on the clipboard for a ticket or a Slack thread.

**Copy for Excel** puts it on the clipboard as spreadsheet rows — click, open your QA sheet, paste,
and it splits into columns with no import step. You get `Email · Severity · Rule · Issue · Where ·
Details · Status`, with the email name repeated on every row so several emails can be pasted into
one sheet and still filtered. `Status` is deliberately blank: it is there for a developer to mark
rows off as they work through them.

---

## What it does not do

Worth being explicit, so nobody assumes a clean report means more than it does.

- It reads the content, so it cannot tell you whether a well-formed link actually resolves, whether
  an image actually loads, or how any of it renders in Outlook. It flags the known *causes* of
  rendering problems; only a real client or Litmus shows the effect.
- It only sees the content item you have open. Content living in a shared reusable block or in the
  template is not visible from the email, and the panel says so rather than implying otherwise.
- From name, from address and send-time data live on the sending profile and the flow, not in the
  content, so they are outside its reach.

It is a first pass that clears the mechanical failures. It does not replace a human review.

---

## Where the rules came from

Not invented. The current set was assembled from real sources: QA sheets from recent projects,
rendering issues raised in community Slack threads, and the documented gaps between MCE and MCN.
Built with AI assistance.

## Status and next steps

Deployed and working in a demo org. Presented 26 Aug 2026.

**The ask:** which of these checks are worth keeping, which are noise, and what is missing? The
feature set is a starting point drawn from a handful of projects, and the fastest way to make it
useful is to hear where it is wrong.
