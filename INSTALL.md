# Install & Setup — Email Preflight

A Marketing Cloud Next email-builder sidebar extension that runs pre-send checks on an email, an
email template or a reusable content block. See `README.md` for what it checks and why.

**There is no configuration step.** The component is three LWCs and nothing else — no Apex, no Named
Credential, no External Credential, no permission set. Deploy it and it works.

Prerequisites: Marketing Cloud Next with the 🧩 extension panel in the email builder, and permission
to deploy metadata.

---

## Deploy

From this project's root folder (the one containing `sfdx-project.json`):

```bash
sf project deploy start --source-dir force-app --target-org <your-org-alias>
```

Deployed components:

- `lwc/emailPreflight` — the sidebar panel (target `lightning__CmsEditorExtension`)
- `lwc/preflightEngine` — the rules engine (internal, `isExposed` false)
- `lwc/qaCompare` — spec-versus-email comparisons for the QA tab (internal, `isExposed` false)

Deploy the whole `force-app` directory rather than one bundle. The three are versioned together, and
deploying the panel against a stale engine produces findings that do not match the code you are
reading.

### Deploying to production

Production requires Apex tests to run, and by default the CLI runs **every** test in the org. If any
pre-existing test in your org is failing for unrelated reasons, your deploy fails with it.

This project contains **no Apex**, so there is no test class of its own to specify. Two options:

```bash
# Preferred: LWC-only deploys have nothing to test, so specify an existing passing test class
sf project deploy validate --source-dir force-app --target-org <prod-alias> \
  --test-level RunSpecifiedTests --tests <AnyPassingTestClassInYourOrg> --wait 60

sf project deploy quick --use-most-recent --target-org <prod-alias>
```

If your org has no reliably passing test class, deploy the two LWC bundles on their own — a
deployment containing no Apex is not subject to the coverage requirement, and `RunLocalTests` will
still be attempted unless you specify otherwise. Validate first either way, so a failure costs you
nothing.

## How to use

1. Open an **email**, an **email template** or a **reusable content block** in the Marketing Cloud
   Next builder.
2. Click the 🧩 panel → **Email Preflight**.
3. It detects the content type and scans immediately — no button to press.
4. Read the counts table, then the findings beneath it. **Re-check** re-runs after you make edits.
5. Use **All / Errors / Warnings / Notes** to narrow the list when there is a lot to work through.

The panel has two tabs, named after whatever is open — **Email Issues** and **Email QA** on an email,
**Template Issues** and **Template QA** on a template, **Content Block Issues** and **Content Block
QA** on a block. The Issues tab is the automatic scan described above. The QA tab is described below.

**Run it on your templates.** A template gets the email ruleset with nothing removed, because a
template is an email layout. It is also the cheapest place to fix anything, since a fault in a master
template is repeated in every email built from it. Run against one real org template, this reported
two buttons with no link set, two sections that would not stack on a phone, and a 94-character URL
pasted in as text.

### What the content is built from

Above the findings sits a folded **Built from** card naming the template the content came from, the
brand it inherits and the CMS images it places. It is not a check — it is the answer to "what is this
made of", which the builder does not show in one place.

Each item is named, with its **content key** beside it — the name is what you check against a brief,
the key is what CMS search matches on. Names are read from `ManagedContent` through the GraphQL wire,
which needs no Apex and no permission set of its own; your user does need read access to CMS content.
If the lookup cannot answer, the card shows keys alone and nothing else changes.

A template row appears only for content built from a *saved* template. The out-of-the-box starter
layouts copy themselves in and keep no link back, so no row means "not built from a saved template"
rather than "we could not tell".

## The Email QA tab

The Email Issues tab applies rules the tool carries itself. The QA tab answers a different question —
does this email match what somebody wrote down in a spec?

### It lists what is in the email, not the other way round

The tab reads the email and prints **one row per link, per clickable label and per image**, each named
by the component it sits in — `Section 2 of 4`, `Button "Shop now"`, `Image 3 in Section 2 (hero.jpg)`
— and each showing what it currently says. You type what it *should* say in the box beneath and click
**Validate** on that row.

That inversion matters. Typing a list into one box means the tool has to guess which entry referred to
which component, and the reviewer has to hold the email's structure in their head while typing. Listing
what is actually there removes both problems, and a leftover template link is visible simply by being
in the list with nothing typed against it.

| What you fill in | Compared against |
|---|---|
| Subject line | The email's subject |
| Preheader | The email's preheader |
| One box per link | That component's destination |
| One box per button or text link | That component's label |
| One box per image | That image's file or URL |
| One box per image | That image's alt text |

A component shows up in more than one group when there's more than one thing to check about it — a
button has both a destination and a label, an image has both a file and its alt text. One input per
row keeps each question single and the sidebar narrow.

Anything left blank is **skipped, not passed** — an untested row never looks like a tested one.
**Validate all** at the bottom runs every row and field at once. Nothing typed here is written back to
the content item, and nothing survives a page reload.

**The groups start folded.** A real email produces around sixteen rows across the four groups, which
is a long scroll if it all opens at once. Each header says what is inside — `2 to check`, or
`4 of 6 checked, 1 failing` — so you can see where a group stands without opening it, work through
one group at a time, and fold it when you're done. If **Validate all** fails a row inside a folded
group, that group opens by itself rather than reporting the failure somewhere you can't see it.

### Three things it does deliberately

**Tracking parameters are ignored when matching links.** A spec lists the page being linked to, while
the email's href has campaign and click-tracking parameters bolted on afterwards, or a merge field
standing in for the whole query string. Comparing those literally would fail on every link.
Parameters that identify the destination, like `?product=123`, are kept and compared.

**A URL mismatch says what kind of mismatch it is.** No destination set at all, the same page over
`http` instead of `https`, a different page on the same site, and a different site entirely mean four
different things to a reviewer, and "they don't match" means none of them.

**An image file matches on its name as well as in full.** The builder stores a picture as a CDN URL,
a bare file name or an opaque CMS content key depending on where it came from, and a reviewer working
from a spec will have one of those, not necessarily the one on screen. So `hero-banner.jpg` matches
`https://cdn.example.com/a/b/hero-banner.jpg`. Two extensionless content keys still have to match
exactly, since "same last path segment" would otherwise pass everything.

### Why a mismatch explains itself

Pasting a subject line out of Word or Google Docs silently substitutes curly quotes, en dashes and
non-breaking spaces. A plain comparison then reports a mismatch between two strings that look
identical on screen, and the reviewer concludes the tool is broken. So every failure names the actual
difference — "the text reads the same but the characters differ: curly vs straight quotes" — and
distinguishes that from a capitalisation change, a merge field standing where the spec has an example
value, text appended to the end, and a genuine wording difference with its position.

**Run it on your reusable blocks too.** The tool only sees the item open in the editor; embedded
blocks are separate content items and are invisible from an email. `BLK001` lists each one it finds
with its location and content key so you know exactly what is missing from the results. This is the
single most important thing to understand about the results — see the scope-limit section in
`README.md`.

## Reading the results

| Severity | Meaning |
|---|---|
| **Error** | Will break the send or ship visibly broken. Fix first. |
| **Warning** | Probably wrong, but legitimate exceptions exist. Review. |
| **Note** | Informational. No action implied. |

The tool cannot block a send and never tries to.

Findings are listed most severe first, so errors are always at the top. The severity buttons above the
list narrow it to one severity when you want to work through a single category — they filter the
display only, and both copy buttons always contain everything regardless of what is on screen.

### Getting the findings into a spreadsheet

**Copy for Excel** puts the findings on the clipboard as spreadsheet rows. Click it, open your QA
sheet, click a cell and paste — Excel and Google Sheets both split it into columns on a plain paste,
with no import step or Text to Columns.

You get `Email · Severity · Rule · Issue · Where · Details · Status`. The email name is repeated on
every row, so you can scan several emails and paste them all into one sheet and still sort or filter
by which email a row came from. `Status` is deliberately empty — it is there for you to mark rows
off as you work through them.

Each finding is one row, with all its locations in the `Where` cell separated by `|`. Sorting the
sheet by `Severity` puts the errors together; filtering on `Rule` pulls out every instance of one
problem.

If the button reports that the editor won't allow clipboard access, a box appears with the rows in
it. Select all of it, copy, and paste into the sheet — the result is identical.

### Findings you can expect to see legitimately

- **`CMP001` no unsubscribe link** — correct and expected if your unsubscribe lives in a shared
  footer block or template. It is recognised whether you use the `{!$link.optout}` token, link your
  own unsubscribe page, or use a tracked link whose wording says "Unsubscribe", so if it fires on an
  email that visibly has one, the link is almost certainly in a block this tool cannot see.
- **`VAR001` undefined variable** — expected for Content Variables supplied by the Flow's Send Email
  step, and for a reusable block inheriting a variable from the email that includes it. Worth
  confirming each one is genuinely wired up, since a typo produces a silent blank.
- **`AMP001` AMPscript detected** — expected if you use Marketing Object lookups or the Smart Block
  canvas-obfuscation pattern.
- **`IMG001` no alt text** — a purely decorative image correctly has empty alt text.
- **`IMG006` alt text is set on the image, not in the email** — expected, and usually means the alt
  text is fine. Leaving "override" unticked is the normal way to work: the description then lives on
  the image asset in CMS, which is a separate content item the panel cannot read. It is reported so
  you know it was not verified, rather than being counted as missing.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Panel not listed in the 🧩 menu | Confirm both LWC bundles deployed (Setup → Lightning Components). `preflightEngine` will be listed but never appears in the menu — it is `isExposed` false by design. |
| "Could not read the editor content" | The editor's content API returned nothing. Close and reopen the content item. |
| Panel says the content type is unsupported | Expected on SMS, landing pages and anything other than Email, Email Template or Reusable Content Block. |
| **Built from** shows content keys but no names | The name lookup could not answer. Most likely your user lacks read access to CMS content, or the GraphQL wire is unavailable in the builder frame. Nothing else is affected — no finding depends on the names. |
| Panel does not appear when you open a **template** | The component targets `lightning__CmsEditorExtension` with no content-type restriction, so nothing on our side blocks it — but whether MCN offers editor extensions in the template builder is platform behaviour. If the panel is absent there, no code change here fixes it. |
| A block you embedded still shows as missing its unsubscribe link | Expected. The email stores only a pointer to the block, so its contents are not readable from the email — `BLK001` prints the block's content key; open that block and run the panel on it there. |
| "This editor won't let the panel use the clipboard" | The builder's frame does not grant clipboard access. The report text appears below the message — select and copy it manually. Nothing is wrong with the scan. |
| Results look wrong for your content shape | The storage-shape assumptions need confirming against a real content body — see the Status note in `README.md`. Report which rule and what the body actually looks like. |

## Extending it

Add a rule by writing one pure function in `preflightEngine.js` that takes the prepared context and
returns findings, then appending it to the `CHECKS` array. The context gives you `body`, `title`,
`strings`, `locatedStrings`, `links`, `anchors`, `images`, `embeddedBlocks`, `isEmail`, `isRcb`,
`isTemplate` and the other collected views built at the top of `runPreflight`. Use `contentNoun(ctx)`
rather than writing "email" into a finding, so it reads correctly whichever of the three is open. Add Jest cases alongside; the engine
has no org dependencies, so tests run locally in seconds.

## Running the tests

```bash
npm install
npm run test:unit
```

557 tests across three suites. `preflightEngine` and `qaCompare` are pure modules tested directly.
The `emailPreflight` suite is deliberately thin — it exists mainly to compile the template, since a
broken binding there is otherwise only discoverable at deploy time. It relies on the stub at
`force-app/test/jest-mocks/experience/cmsEditorApi.js`, wired up through `moduleNameMapper`, because
the real module only exists inside the builder.
