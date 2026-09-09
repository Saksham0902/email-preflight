# Email Preflight

A **Marketing Cloud Next (MCN) email-builder sidebar extension** (Lightning Web Component) that
checks an email, an email template or a reusable content block **before** it is sent, and reports
what it finds.

> **Read-only.** The component never calls `updateContent`. It cannot modify your content — the
> worst case is a wrong report, never a damaged email.

> **Install: see [`INSTALL.md`](./INSTALL.md).** One deploy command, no Apex, no Named Credential,
> no permission sets.

---

## The gap it closes

MCE had a validation step before send. MCN does not. Its equivalent failures are only discoverable
**after** the send, as `ssot__EngagementActionReasonText__c` rows on the Email Engagement DMO:

- _"Failed to render due to syntax errors"_
- _"Data graph doesn't contain valid personalization information"_
- _"Can't retrieve profile attributes"_

By the time those appear, the send is spent and the audience has had a broken email. A large share
of the causes are visible in the content tree beforehand, which is what this tool reads.

It also flags three documented MCN limitations that fail **silently** — no error, just wrong output:
repeaters and product recommendations inside reusable content blocks, and point-and-click dynamic
content evaluated against a non-Unified-Individual Data Graph.

And it catches the migration cases MCE's validator would have caught and MCN's has no opinion on:
`%%FirstName%%` substitution strings and AMPscript URL helpers that MCN does not evaluate, so they
are delivered to the recipient as literal text (`MIG001`, `MIG002`).

## What it checks

| Rule | Severity | What it catches |
|------|----------|-----------------|
| `HB001`–`HB004` | Error | Unclosed `{{#if}}`/`{{#each}}`, stray closing tags, mismatched pairs, unterminated `{{` |
| `HB005` | Warning | Empty `{{}}` expression left behind by editing |
| `HB006` | Error | `{{fallback X}}` with no backup value — silently stops being a fallback |
| `CNT001` | Error | No subject line — blank or removed entirely, which are the same thing here |
| `CNT003` | Warning | No preheader — inboxes fall back to "View in browser" |
| `CNT004` | Error | Asset name over the 200-character platform limit |
| `CNT005` | Warning | `<script>`, `<iframe>`, `<form>` or inline `onclick=` — stripped by mail clients |
| `CNT006` | Note | Preheader over 100 characters — cut off in the inbox preview |
| `CNT007` | Note | Preheader short enough that body copy bleeds into the inbox preview behind it |
| `SUB006` | Error | "TEST:", "DRAFT:", "DO NOT SEND" or template boilerplate still in the subject or preheader |
| `SUB001` | Warning / Note | Subject over 100 characters (warning) or over 60 (note — cut off on phones) |
| `SUB002` | Warning | Merge field in the subject with no `fallback` — "Hi ," in the inbox preview |
| `SUB005` | Warning | Preheader repeats the subject — the second line is spent saying nothing new |
| `SUB003` | Note | Subject has spam-filter triggers (shouting, `!!!`, "FREE") |
| `SUB004` | Note | `®`/`™`/`©` in the subject — reported to render inconsistently |
| `CMP001` | Warning | No unsubscribe link in this content item — downgraded to a note when `messagePurpose` is transactional. Recognised four ways: any merge token containing "unsubscribe", a URL containing unsubscribe/opt-out, link wording that says so, or the builder's `{!$link.optout}` |
| `CMP003` | Warning | No postal address in the footer — CAN-SPAM requires one. Satisfied by a literal address or by a merge field that pulls one in, including camelCase tokens like `{!$brand.postalAddress}` |
| `CMP002` | Warning | No preference centre link, recognised the same four ways as `CMP001` — without one the only way out is a full unsubscribe, and every unsubscribe costs sender reputation |
| `BLK001` | Note | Embedded reusable blocks, listed with their location and `contentKey` — their contents were not checked, so compliance findings above may be wrong and the size estimate is low |
| `LNK001` | Error | Placeholder or empty href (`#`, `example.com`, empty) |
| `LNK004` | Error | Button or link component with no destination set at all |
| `LNK006` | Error | Space or line break inside a URL — some clients truncate the link there |
| `LNK007` | Error | Link to a staging, test, local or private-network host — unreachable for the recipient |
| `LNK002` | Warning | Insecure `http://` link |
| `LNK005` | Warning | Second `?` in a URL — two query strings joined, so the later parameters never arrive |
| `LNK008` | Warning | `href="#section"` jump link — does not work in most mail clients |
| `LNK009` | Note | An email with real copy and no links at all |
| `IMG004` | Error | Image component placed but never given a picture — arrives as a broken-image box |
| `IMG001` | Warning | Image with no alt text — read aloud by screen readers, and shown when images are blocked |
| `IMG002` | Warning | Images but almost no live text — blank when images are blocked, and a spam signal |
| `IMG003` | Note | Logo doesn't link anywhere — people try clicking it first |
| `IMG005` | Note | Any other image with no link, so someone can decide whether it needs one |
| `IMG006` | Note | Images whose alt text lives on the CMS asset rather than in the email — the normal setup, and not readable from here, so it is reported instead of being counted as missing |
| `A11001` | Warning | Link text that says nothing ("Click here") — screen readers can list links out of context |
| `A11002` | Warning | Alt text that is a file name or CMS content key rather than a description |
| `A11003` | Warning | Text-on-background contrast below WCAG AA 4.5:1, with the computed ratio |
| `A11004` | Note | Hand-written layout table with no `role="presentation"` |
| `A11005` | Note | A long run of capitals — read letter by letter by some screen readers |
| `SIZ001` | Warning | Content approaching Gmail's ~102 KB clip, which hides everything below the unsubscribe link |
| `SIZ002` | Error | `data:` base64 image embedded in the email — Gmail and Outlook refuse to display it |
| `MIG001` | Error | MCE substitution string (`%%FirstName%%`) — delivered as literal text in MCN |
| `MIG002` | Error | Hardcoded MCE tracking domain or AMPscript URL helper (`RedirectTo`, `CloudPagesURL`) |
| `TXT002` | Error | `[First Name]`, `[Appointment Date]`, `[email address]` — a merge field written as literal text and never wired up |
| `TXT001` | Warning | Placeholder copy still in the content — "Lorem ipsum", "Your text here", "TBD", and the MCN starter-template lines ("Customize this draft…", "Build an Email"). Names whether each hit is the subject line, preheader or body copy |
| `RND001` | Error | Column row does not total the 12-unit grid — gap at one edge, or the last column wraps |
| `RND005` | Error | Text is the same colour as its background — invisible, but still occupies space |
| `RND002` | Warning | Multi-column row with stacking off — columns stay side by side on a phone |
| `RND003` | Warning | Left and right spacing don't match — content sits off-centre |
| `RND006` | Warning | Links are the same colour as body text — only findable by accident |
| `RND008` | Warning | One component mixes spacing units (px and %) — goes lopsided as the viewport changes |
| `RND009` | Warning | Line height under 1.2 — lines collide |
| `RND010` | Warning | Literal font size under 14px — iOS Mail and Gmail may auto-scale it and break the layout |
| `RND011` | Warning | Image width over 100% — overflows its column |
| `RND012` | Warning | An unbreakable run over 45 characters (usually a pasted URL) — forces sideways scroll on a phone |
| `RND004` | Note | Sections use different horizontal padding — content edges won't line up |
| `RND007` | Note | Spacing part brand-token, part hardcoded — the hardcoded parts won't follow a brand update |
| `RND013` | Note | Links are styled different colours in different places — usually an unstyled link falling back to browser blue |
| `RND014` | Note | An unusually large literal gap — worth confirming the whitespace is deliberate |
| `CSS001` | Error | `display:flex`, `display:grid`, `position:absolute`, `transform`, `@keyframes` — web layout that collapses in email |
| `CSS002` | Warning | Downloaded web font (`@font-face`, Google Fonts, Typekit) — Outlook never loads it |
| `CSS004` | Warning | External `<link rel="stylesheet">` — removed by mail clients, so the email arrives unstyled |
| `CSS003` | Note | A non-universal font named with no fallback after it |
| `DRK001` | Warning | Literal background colour set with no text colour — dark mode may flip one and not the other |
| `DRK002` | Note | Pure `#000000` / `#FFFFFF` — the colours dark mode rewrites most aggressively |
| `OL001` | Warning | Background image set — Outlook needs VML, which the builder strips, so it silently won't render |
| `MSO001` | Warning | VML or `mso` conditional comments present — stripped on save, so any Outlook fallback is already gone |
| `OL002` | Warning | Button built as a styled `<a>` in raw HTML — Outlook ignores its padding and rounded corners |
| `MCN001` | Note | A button component is present — Outlook does not reliably apply its spacing. Suggests building it as an image if it has to look identical everywhere |
| `DP001` | Error | Personalization with no data provider attached — nothing for it to resolve against |
| `DP002` | Error | Product recommendations with no Data Graph provider — validation fails at render time |
| `DP003` | Warning | Apex data provider inside a reusable content block — known rendering and deploy bugs |
| `DP004` | Note | More than one Data Graph attached — confirm each expression targets the right one |
| `RCB001` | Error | Repeater inside a reusable content block — unsupported |
| `RCB002` | Error | Product recommendations inside a reusable content block — unsupported |
| `RCB004` | Warning | Block helpers nested 3+ deep in a reusable block — complex Handlebars breaks block functionality |
| `DG001` | Warning | Dynamic content variations, which only evaluate on a Unified Individual Data Graph (names the attached graph) |
| `VAR004` | Error | `{{varRegion}}` used where the content sets `{{varregion}}` — provably a typo, not a missing input |
| `VAR001` | Warning | `{{variable}}` nothing in this content defines — renders blank unless the flow supplies it |
| `VAR002` | Note | Variable set but never used — usually the residue of a rename |
| `VAR003` | Note | Variable set more than once — fine across `{{#if}}` branches, otherwise one is dead |
| `AMP001` | Note | AMPscript present — expected for Marketing Object lookups and Smart Blocks, otherwise likely unconverted MCE content |

| `BLK002` | Note | A block is open but nobody has said what it is, so the compliance rules stayed off |
| `BLK003` | Note | What the chosen block role switched on, and what stays off regardless |

`SUB*`, `IMG002`, the subject line and the preheader are never checked on a block — those belong to
the email that includes it. RCB compatibility rules only run for blocks. The compliance rules
(`CMP*`) depend on the block role, below.

Everything else runs on a block exactly as it does on an email, layout included: `RND001`–`RND013`
(columns off the grid, rows that will not stack, asymmetric padding, mixed units, sections that
disagree on side spacing, font and line-height inconsistency), plus the accessibility, dark-mode,
Outlook and CSS-support rules. A block with columns that do not add up renders just as badly inside
whatever email pulls it in.

### Three content types

The builder reports what is open through `getContext`, and the panel picks the ruleset to match:

| Open in the builder | Content type | What runs |
|---|---|---|
| Email | `sfdc_cms__email` | Every rule |
| Email template | `sfdc_cms__emailTemplate` | Every rule, unchanged |
| Reusable content block | `sfdc_cms__emailFragment` | Block rules; `SUB*` and `IMG002` dropped; role picker shown |

A template gets the email ruleset with nothing taken out, because a template is an email layout
rather than a different kind of object — every rule about links, images, compliance and rendering
applies to it exactly as it applies to the email it will produce. It is also the cheaper place to
catch a fault: anything wrong in a master template is wrong in **every** email built from it, so one
fix there beats the same fix repeated across a quarter of campaigns.

Run against a real org template, this immediately reported two buttons with no link set, two sections
that will not stack on a phone, and a 94-character URL pasted in as text. Three faults sitting in a
master template, each one inherited by every email anyone built from it.

Findings name what is actually open rather than always saying "email", via `contentNoun`. The rule
copy itself is written out longhand across eighty-odd rules and still says "email" in places — a
wording debt, not a behavioural one.

### What the content is built from

Above the findings sits a folded **Built from** card: the template the email came from, the brand it
inherits, and the CMS images it places. It is not a check and nothing in it is a problem to be fixed.
It answers "what is this actually made of", which is the first thing a reviewer asks and the one
thing the builder never shows in a single place. A finding about the wrong logo means very little
until you can see which logo is in there.

Each item is named, with its **content key** kept beside it. `MCYGXHBGRROJG25GLP4WZDHQWG3Q`
identifies an image exactly and describes it to nobody; `ODFLLogo` is the part a reviewer can check
against a brief. The key stays because it is what CMS search matches on and what the content item's
export folder is named after, so the two do different jobs and neither substitutes for the other.

The names come from a **GraphQL wire** against `ManagedContent`, which is a UI API object — so this
needs no Apex, no Named Credential and no permission set. That distinction is the whole reason it is
allowed: the panel avoided server calls not out of squeamishness about reading, but because every
route to one dragged setup burden along with it, and setup burden is what stops a tool like this
being adopted. This route has none. It is still read-only.

**A failed lookup costs the reader nothing.** If the wire errors — no access to `ManagedContent`, or
the adapter unavailable in the editor frame — every caller falls back to the key, which is exactly
what the card showed before names existed. Nothing is reported about the failure, because an error
banner about a missing nicety would be competing for attention with actual findings about the email.

The card is folded by default with the answer carried in its summary line (`Template and brand`,
`Brand and 9 images`), because the panel lives in a narrow sidebar and most readers only need the
glance.

Three things worth knowing about what appears there:

- **A template row only appears for content built from a saved template.** The out-of-the-box starter
  layouts — Gated Content and friends — copy themselves into the email and keep no link back. So an
  absent template row means "not built from a saved template", never "built from one we could not
  identify". The two would call for opposite reactions, so the distinction is worth being precise
  about.
- **The lock count is reported alongside.** `sfdc_cms:template.attributes.schemaMap` is the template
  stating, per component, whether an author may edit it. A template that locks nothing is a starting
  point rather than a guardrail, and the two are indistinguishable in the builder, so the card says
  so outright: `Nothing locked — all 24 components are editable`.
- **The brand is either a content key or the org default.** `lightning:brandSource` carries
  `contentKey` when a brand content item is attached and `defaultBrandOption` when it is not. Both
  answer "which brand"; only one of them is a thing you can go and open.

### Block roles

A block is not a small email. It is a fragment with a job, and the job decides which rules apply: a
header owes a logo and a link home, a footer owes the legal furniture, a body block owes neither.
Nothing in the content body reveals which it is — a footer is recognisable to a person by what it
means, not by a field — so with a block open the Issues tab asks. Header, body and footer, tick as
many as fit, since plenty of real blocks are a body and a footer at once.

Ticking **Footer** switches on `CMP001`, `CMP002` and `CMP003`. That is the point of the picker. From
inside an email those three rules cannot see into an embedded footer, so they warn with a caveat
attached; run against the footer block itself they are definite, and the caveat is dropped from the
wording. Until this existed, the one place an unsubscribe link could actually be verified was the one
place the rules never ran.

Choosing nothing is allowed and leaves the general block rules running, but `BLK002` says so rather
than letting an empty compliance section read as a pass. Whatever is chosen, `BLK003` states what ran
and what did not — a reader cannot tell "checked and clean" from "never checked" by looking at an
empty list, and that distinction matters most exactly here.

The QA tab follows the same split. Fields marked `emailOnly` in `QA_FIELDS` — subject line and
preheader, currently all of them — disappear with a block open, and the whole-item section goes with
them. A subject line is a property of the email, not of a fragment inside it, so a box asking a
reviewer to confirm the subject of a footer is a question with no answer, and one they might answer
anyway from the email they had open a minute ago. "Validate all" reads the filtered list too, so a
hidden field cannot count itself into the tally as a checked item that matched. The four per-item
groups are untouched: a footer has links and images like anything else.

Since an embedded block's contents are invisible from the email that uses it (see
[Scope limit](#-scope-limit--embedded-blocks-and-templates)), open the block itself and run the tool
on it as a second pass. The panel pins a notice above the results of any email that embeds one,
naming each block and printing its content key so you know which to open.

### What this does NOT replace

The engine reads the content body. It has no network access, cannot send, and cannot render — so a
whole class of QA is still a person's job. Run this first to clear the mechanical failures, then do
the rest by hand:

| Still needs a human (or Litmus) | Why it can't be automated here |
|---|---|
| From name and from address | Live on the sending profile and the flow, not in the content |
| Do the links actually resolve? | A URL can be perfectly formed and still 404. `LNK001`/`LNK004`/`LNK007` catch *malformed and missing*, never *dead* |
| Do the images actually load? | `IMG004` catches an image slot with nothing in it; a broken CDN URL needs a real request |
| Real client rendering | Outlook/Gmail/Apple Mail quirks. `OL*`, `CSS*` and `RND*` flag the known *causes*; only Litmus shows the effect |
| Dark mode appearance | `DRK*` catches the colour setups that break. A logo that looks wrong on dark still needs eyes on it |
| Does the unsubscribe flow complete? | `CMP001` proves the link is *present*, not that it works |
| Does it match the design comp? | There is no comp in the content body |
| Merge fields against real subscriber data | `VAR*`, `SUB002` and `TXT002` catch tokens that are missing, misspelled or never wired up. Whether the *data* is right needs a seed send |

### How findings name the component they found

A finding is only worth having if the reader can act on it, and `lightning/section` names a type
rather than a component — with six sections in the email, it leaves the reader to guess which. So
every component is labelled the way the builder's own **Component Tree** panel presents it:

| Instead of | The panel now says |
|---|---|
| `lightning/section` | `Section 3 of 6 — "Everything reduced until Sunday"` |
| `lightning/actionButton` | `Button "Learn more" in Section 3 of 6` |
| `MCJX4LL4ZSVNHALNTPQEVK3NF77U` | `Image 2 of 3 in Section 1 of 6 (hero.png)` |

Three deliberate choices behind that:

- **Sections are numbered across the whole email; everything else is numbered inside its section.**
  The tree panel lists sections top to bottom, so "Section 3" is directly checkable against it.
  A document-wide paragraph number would mean counting every paragraph from the top.
- **A few words of the component's own copy are attached**, because that is how someone recognises
  a block they wrote. Merge expressions are stripped out first — a hint of `{{fallback FirstName ""}}`
  identifies nothing. A section with no copy of its own falls back to what is inside it
  (`Section 1 of 6 — Image`), which for a logo band is the more recognisable description anyway.
- **A button leads with the words printed on it**, since that is its strongest identifier, and keeps
  the position for the case that makes the rule hard to act on: three buttons all saying "Learn more".

Image findings carry both a `label` (where it is) and a `name` (what the file is called). The rules
that reason about the asset — is this a logo, is the alt text just a file name — read `name`, so
relabelling for humans cannot change which findings fire.

**Findings that match text carry a position too.** The rules that scan copy rather than components —
placeholder text, unclosed Handlebars, legacy platform code, unsafe markup — used to print only the
fragment they matched. `[Your Company]` says what is wrong and nothing about where, which in a
twelve-section email means opening every section to find it. `collectLocatedStrings` pairs every
string in the tree with the component holding it, so those findings now read:

```
[Your Company] — HTML block 2 of 3 in Section 6 of 8
{{#if member}} (never closed) — Paragraph in Section 2 of 8
```

The position is the short form, without the copy sample the full label ends with, because for these
rules the copy *is* what is being printed and repeating it would make each line say the same thing
twice. The subject line and preheader are named outright rather than positioned, since they are not
on the canvas and "Section 1 of 6" would send someone looking in the wrong place.

One consequence worth knowing: the same placeholder in three sections is now three lines, not one.
It is three separate edits, and collapsing them hid two of them.

**Rules that compare values across the email group the other way round.** RND004 (sections spaced
differently) and RND013 (more than one link colour) are about disagreement between components, so
listing the components one per line would repeat the shared value on most of them and bury the
outlier. They list a line per value instead, naming the sections that use it:

```
30px — Section 1 of 4, Section 2 of 4, Section 3 of 4
100px — Section 4 of 4
```

Which section is the odd one out is then the thing you read first, rather than something you work
out. Beyond four components the list is truncated with a count, since past that the number matters
more than the names.

### Why layout checks work without resolving the brand

Colours and spacing are stored as brand tokens (`{!$brand.colorScheme.root}`), and the engine never
resolves them. It doesn't need to. Two components sharing a token share a colour *whatever the token
evaluates to*, so `RND005` can prove text is invisible against its background without knowing either
colour, and the result holds however the brand is later reconfigured.

Where a check genuinely needs a number — font size, line height, padding — it only fires on literal
values and stays silent on tokens. That means a brand-managed email is checked less thoroughly than
a hardcoded one, which is the right way round: the hardcoded one is the one nobody is maintaining.

### An opt-out is recognised however it is written

`CMP001` originally matched only the builder's `{!$link.optout}` merge token. An ordinary
`<a href="https://site.com/unsubscribe">Unsubscribe</a>` is a perfectly valid opt-out and plenty of
orgs link their own page instead of using the token, so the rule fired on compliant emails — as a
warning, telling the reviewer they were breaking CAN-SPAM.

That is the worst failure available to this particular rule. A check that is wrong about a legal
requirement is the first one people learn to ignore, and an ignored compliance check is worse than
no compliance check, because it occupies the space where a working one would go.

It now accepts any of: **any merge token containing "unsubscribe"**, a link whose URL contains
`unsubscribe` / `opt-out`, or a link whose visible wording says so. Matching on wording as well as
URL matters for tracked links, where the URL is an opaque redirect and the anchor text is the only
readable signal. Matching any token containing the word — rather than the exact `{!$link.optout}`
spelling — matters because orgs write these differently and a rule keyed to one org's spelling is a
rule that fires on everybody else. `CMP002` reads "preference" the same way.

This does nothing for the case where the link is real but sits inside a footer block the tool cannot
open — see [Scope limit](#-scope-limit--embedded-blocks-and-templates).

### Platform quirks are a different species of finding

`MCN*` rules say something different from every other rule here. Everywhere else a finding means the
content is wrong and somebody should change it. These say the content is fine and the **platform** is
not, and the only thing to decide is whether this particular email can live with it.

So they are notes, permanently. There is nothing to fix — nobody chose the behaviour — and telling
someone in red to stop using the button component would be advice, not a defect. A note can honestly
say "this is known to go wrong, here is what people do about it"; a warning cannot.

Each one has to name the workaround. A quirk with no workaround is just bad news, and bad news with
no action attached is what teaches people to skip the notes. They live in `checkMcnQuirks`, one block
each.

### False positives are the expensive failure

A missed problem costs one bad send. A **working** button reported as broken costs the tool its
credibility, and after two of those nobody reads the panel again. So where a rule has to guess, it
guesses towards silence:

- `LNK004` applies to buttons only, and treats *any* url-shaped string, under *any* key, anywhere
  beneath the button as a destination — not just the field names we happen to know. Components that
  can link but are complete without one (images, dividers, text) are never flagged; an empty anchor
  href is already covered by `LNK001`.
- `LNK005`/`LNK006` ignore whitespace and punctuation inside `{{...}}` and `{!...}` expressions,
  which are not literal URL text.
- `LNK005` is a warning, not an error: a second `?` is legal inside a query value.
- `CNT001`/`CNT003` deliberately do **not** distinguish "the key is missing" from "the key is
  blank". Clearing either field in the builder deletes the key rather than emptying it, so treating
  a missing key as unverifiable meant the exact action the rule exists to catch produced no error.
  There was previously a `CNT002` note for the unverifiable case; it never fired usefully and is gone.
- `A11001` deliberately does not flag "Learn more" or "Read more". Both are uninformative in theory
  and completely standard in marketing email in practice; flagging every CTA in every email is how a
  panel gets closed and never reopened. Only text that is *purely* mechanical ("click here", "here",
  "this link") is reported.
- `IMG001` ignores images whose alt text is held on the **CMS asset** rather than in the email.
  Ticking "override" in the builder types the alt text into the email, where it lands in `altText`;
  leaving it unticked — the default — keeps `altText` empty while the real description sits on the
  image asset, a separate content item this panel cannot read. Matching on `altText` alone therefore
  reported every correctly-described image in the org as having none, which is the worst shape a
  false positive can take: it fires on the people who did the accessible thing, and on most of them.
  Those images are reported as `IMG006` instead, which says where the description actually lives
  rather than claiming there isn't one.
- `CMP003` accepts a postal address supplied by a **merge field**, not only a literal one. Plenty of
  orgs pull theirs from Company Information with `{!$organization.Address}` or
  `{!$brand.postalAddress}`, and a `\baddress\b` test never matches a camelCase token — so the rule
  fired on emails that were fully compliant. Tokens are now split on camelCase before being tested,
  and the test still refuses to read "city" out of "capacity".
- `A11003` and `DRK001`/`DRK002` only run on colours written as hex. A brand token could evaluate to
  anything, and a contrast failure reported against a colour nobody chose is unfixable noise.
- `DRK001` further requires the background to be a **literal** colour. Every button the builder makes
  carries a `{!$brand...}` background whether or not anyone chose one, so accepting tokens would put
  the finding on every email containing a button.
- `CSS001` anchors its `transform` pattern on a declaration boundary, because `\btransform` also
  matches the perfectly ordinary `text-transform: uppercase`.
- `CSS003` only asks for a fallback behind fonts that aren't installed everywhere. "font-family:
  Arial" technically has no fallback and needs none.
- `LNK007` matches whole host labels, so `developers.example.com` is not read as a `dev` environment.
  A URL assembled from a merge expression has no literal host and is left alone entirely.
- `SIZ001` measures the content body JSON, which is a **proxy** for the built email rather than the
  thing Gmail measures — it excludes the table scaffolding wrapped around the content at render. It
  therefore runs low, which is why the threshold sits at 70 KB rather than at Gmail's 102 KB, and why
  the finding says "getting close" rather than quoting a number as fact.
- `VAR001` skips any variable the content defines for itself with `{{set}}`, so a locally-assembled
  value is never reported as an input nobody supplies.

### Reporting a wrong finding

Each result has a collapsed **"Content structure"** section listing every field path in the content
item. Every rule encodes an assumption about where the builder stores things, and those shapes are
not documented and vary per component. Send that outline with any bug report and the rule can be
corrected against the real structure instead of another guess.

## ⚠ Scope limit — embedded blocks and templates

**The tool only sees the content item open in the editor.** An embedded reusable content block is a
*separate* content item: the node in the email carries a `contentKey` pointing at it, not a copy of
its body. Its links, images and footer are invisible from here.

Templates used to sit in the same bucket and no longer do. The builder reports one as
`sfdc_cms__emailTemplate` and the panel now checks it directly, so a template is a second pass rather
than a blind spot. What an email still cannot do is check *its own* template in place: the reference
is readable — see [What the content is built from](#what-the-content-is-built-from) — but the body
behind it is not. Open the template and run the panel there.

The footer is where this bites, because the footer is both the likeliest thing to be a shared block
and the place all three compliance rules look. Put your unsubscribe link in a footer block and the
tool cannot see it, so `CMP001` fires on an email that is actually compliant.

`CMP001` stays a **warning** regardless. Softening it would be treating the symptom: the finding is
not too loud, it is uninformed, and the fix is to read the block rather than to say less about the
link. Until the tool can do that, the finding restates the limit in its own text and `BLK001` names
the blocks to go and check — open each one in the builder and run the panel on it there.

Reading them automatically is possible but not free. The delivery-side Apex APIs
(`ConnectApi.ManagedContentDelivery`) only return **published** content for a channel, so a block
edited and not yet published would be read stale — worse than not read at all. The working body is
only reachable through the Connect CMS management REST endpoint
(`/services/data/vXX.0/connect/cms/contents/{id}`), which means Apex, a callout and a Named
Credential. That is the same route `UtmLinkManagerController` takes for image alt text, so the
pattern is known; it is a deliberate deferral, not an oversight.

`BLK001` makes the blind spot concrete rather than leaving it as a general disclaimer. It lists each
embedded block, where it sits, and its `contentKey` — the identifier the content item's export
folder is named after, so it is what you would search for to find the block. Two consequences follow
and the finding states both: any compliance finding above may just be content living inside a block,
and the size estimate is lower than the real email will be.

The panel repeats that list in a notice **above** the counts. Nothing new is said there; it is said
where it will be read. `BLK001` is a note, findings sort errors first, and on a real email the one
line explaining why the compliance warnings might be wrong lands under twenty other rows — which is
how somebody concludes the tool is broken rather than partial.

The notice names each block. The reference itself never carries a name — every one observed holds
nothing but a `@cms/<key>` pointer and a type — so the name is read from `ManagedContent` by the same
GraphQL wire that names the template and the images, and the key is shown beside it. `blockNameOf`
still checks the fields a name could plausibly sit under, so if a future release starts including the
title inline the notice uses that without a lookup. It also refuses a key or a UUID found under a
`name` field: printing one as though it were a name reads like a name and is useless as one.

Together with the role picker this closes most of the practical gap without a callout. The email
says "there is content in here I did not read, go and open it"; the block, opened, knows what it is
and runs the rules that belong to it. Two passes instead of one, but nothing is silently unchecked.

Resolving the block's **body** automatically is a different problem from resolving its name. The name
is a field on `ManagedContent` and the GraphQL wire reads it; the body is not exposed there, and
getting it means a server-side callout to the Connect CMS API, which means Apex and a Named
Credential. So the panel names the blind spot precisely, and still does not read into it.

This is not a shortcut. It is a deliberate consequence of MCN keeping blocks reusable rather than
flattening them into the email that uses them.

## Severity means something

- **Error** — will break the send or ship visibly broken. Fix before sending.
- **Warning** — probably wrong, but there are legitimate reasons it might not be. Review.
- **Note** — informational; no action implied.

The tool never blocks anything. It has no way to.

Each finding sits on a background in its severity's colour — red, amber, grey — with the severity
and rule id spelled out in the first line as well, so the colour is never the only signal.

### The counts are also the filter

The three severities sit at the top of the Issues tab as chips — `4 ERRORS`, `9 WARNINGS`, `3 NOTES`,
plus an `All`. Clicking one narrows the list below to that severity.

They used to be two controls: a bordered table of the three numbers, and a row of four buttons under
it repeating the same three words. Between them they asked the reader to look in two places to answer
one question, and only one of the two was clickable. The count is the label now.

A severity with nothing in it is **disabled rather than hidden**. The zero is a result — it is the
answer to "are there any errors?" — and a row that changes width as findings get fixed is harder to
read than one that doesn't. The one exception is the severity currently selected, which stays
clickable at zero: fixing the last error while filtered to Errors would otherwise leave a chip that
is both highlighted and dead, with no obvious way back to the rest.

## Getting the results out

Two buttons, because the two destinations want different shapes.

**Copy report** gives prose, for a ticket or a Slack thread.

**Copy for Excel** gives the same findings as spreadsheet rows, for a QA tracking sheet. It writes
tab-separated values, which is what a spreadsheet reads directly off the clipboard — a plain paste
lands in columns, whereas CSV arrives as one column per row and needs Text to Columns run over it
by hand. Columns are `Email · Severity · Rule · Issue · Where · Details · Status`. The email name
repeats on every row so several scans can be stacked in one sheet, and `Status` is left blank to be
filled in.

One row per finding, matching the panel. Locations are joined into a single cell rather than
exploded into a row each: splitting would read well for a rule naming five broken links and badly
for one whose finding *is* the set, like sections disagreeing on padding, and nothing in a finding
distinguishes the two cases.

Both buttons ignore the severity filter and copy everything. A subset that looks complete is worse
than no button, and a spreadsheet reads as complete even more readily than prose does. Filtering to
Errors is a way of *looking* — the other findings are still real and the reader of the ticket expects
them.

Both buttons do respect **ignored** findings, which is the opposite case: dismissing a finding is a
decision about the finding, and carrying it into the export is the point of the control. The text
report says how many were left out, above the list, so nobody receives a curated report believing it
is the whole picture. The spreadsheet does not, because a trailing prose row would shear the table it
is pasted into — and there the person ignoring is the person pasting.

### The component tree

Above the findings sits a map of the content: one row per top-level section, in the order the builder
shows them, each with the number of issues inside it. Tapping a row narrows the list below to that
section; tapping it again clears.

It is **folded by default**. It is a navigation aid, and a map you are not currently using should not
cost you the height of eight rows every time you open the panel. The folded header carries a summary
— `3 of 6 sections` — so the tally is readable without opening it, and when a section filter is
active the header says which one instead. Folded, that line is the only sign the list below is being
narrowed, and a filter you cannot see is a filter you cannot undo.

This exists because the findings list sorts by severity, which is right for triage and wrong for
repair. Nobody fixes an email by severity — they open Section 3, fix the four things wrong with it
and move down. Sorted by severity that same work means jumping between sections and back again.

Descent stops at the first section or block reference. Mirroring the builder's full tree would put
six sections, a dozen columns and forty components into a sidebar this narrow, and the question worth
answering is "which part of my email is the problem in", which the top row answers on one screen.

Findings are matched to a section by looking for that section's position string — `Section 3 of 6` —
inside their locations. That works because every location the engine emits comes from `describeOne`,
which either *is* a section or names the one it sits in (`Image 1 of 9 in Section 3 of 6`). Matching
on the rendered string rather than on node identity keeps the tree independent of the twenty-odd
collectors that build findings, none of which would otherwise agree on how to report a position.

Two consequences, both stated in the panel rather than hidden:

- A finding that names several sections — sections disagreeing on padding is the usual one — counts
  against **each** of them, since each is somewhere you might go to fix it. Row counts can therefore
  add up to more than the total, and the hint under the tree says so when it happens.
- Findings with no place in any section (no subject line, no unsubscribe link, the email is too big)
  collect into a final **Everything else** row. They are properties of the whole item, and pinning
  them on a section would send someone looking in the wrong place.

Embedded blocks appear as rows too, without a count, saying to open them separately. Ignored findings
drop out of the tree counts along with everything else — a count that still included one would send
somebody into a section hunting for something they already decided to live with.

The tree is hidden when there is only one row: a single section is not a map, it is the counts again
with extra furniture.

### Ignoring a finding

Every finding carries a `−` at its top right. Clicking it drops that finding from the list, from the
severity chips, from the tree counts and from both exports. A bar appears saying how many are
ignored, with **Restore all** next to it, so the absence is stated rather than silent and a misclick
costs nothing.

Dismissals are session-only and are deliberately **not** cleared by Re-check. Ignoring means "we
know, it is deliberate, stop telling us", and the reviewer's next act is almost always to fix
something else and re-run — having the dismissed finding reappear at exactly that moment would make
the control useless. That is also why `runPreflight` assigns each finding a rule-based `id` rather
than a positional one: the id has to survive the content changing underneath it. A rule that fires
once gets the bare rule ID (`CMP002`), which is nearly always; a second occurrence would get `#2`.

Ignoring everything is not the same as a clean run and never renders as one — the panel says so
explicitly, and so does the text report.

Three things get escaped on the way into a cell, each of which otherwise corrupts the paste quietly
rather than failing visibly: tabs and newlines inside a value (which would shear the row into the
wrong columns), a value opening with `=`, `+` or `@` (which Excel evaluates as a formula), and a
value opening with a double quote (which the parser reads as a quoted field and then swallows the
delimiter looking for the close). That last one is routine, not theoretical — component labels quote
the copy they sample.

If the builder frame withholds clipboard permission, either button falls back to showing the text in
a box to select and copy by hand.

## Architecture

```
LWC emailPreflight   (panel UI + editor read via experience/cmsEditorApi)
        │  getContent / getContext        ← no updateContent, by design
        │  graphql (lightning/uiGraphQLApi) → ManagedContent names, optional
        ▼
LWC preflightEngine  (pure, deterministic JS — all rules; Jest-tested)
        │
        ▼
    findings[]  →  counts, severities, locations, text report, spreadsheet rows
```

- `preflightEngine` has **no LWC/DOM/org dependencies** — plain functions over the content JSON,
  unit tested with Jest. This is where the correctness lives.
- Every check is an exported pure function taking a prepared context and returning findings, so
  adding a rule means writing one function and appending it to the `CHECKS` array.
- **No Apex.** Every *finding* is derivable from the content body alone, which is why this deploys
  with no org setup at all. The one thing read from the org is the display name behind a content key,
  through the GraphQL wire — and no finding depends on it, so a lookup that fails costs presentation
  and nothing else.

### Why no Apex (and what that costs)

An Apex bridge could read the attached Data Graph's schema and verify that every
`{{DataGraph.Individual.FirstName}}` actually resolves — which would directly pre-empt _"Data graph
doesn't contain valid personalization information"_. That is the single biggest thing this version
cannot do.

It was left out on purpose: Apex would bring back a Named Credential, an External Credential, a
permission set and a per-user assignment, and that setup burden is exactly what stops tools like
this from being adopted. Dotted merge-field paths are therefore **not** validated; only bare
`{{variables}}` are, via `VAR001`. If DG validation becomes worth the setup, it is an additive
change — the engine contract does not move.

## Develop / test

```bash
npm install
npm run test:unit
```

557 tests across three suites. The engine is the thing worth testing; the panel is a thin shell over
it, and its suite exists mainly to compile the template — a broken binding there is otherwise only
discoverable at deploy time.

## Status

**Deployed and running; rule set still settling.** The panel works against real content in the MCN
builder, and the Jest suite runs clean — **557 tests across three suites**. (An earlier version of
this file warned that the tests had never been executed. They have, they pass, and the engine has
since been run over real org content as well as fixtures.)

### Confirmed against a real content body

- Subject is `subjectLine`, preheader is `preheader`, asset name is `sfdc_cms:title`.
- A CTA is `lightning/actionButton` with its label at `attributes.text` and its destination at
  **`attributes.uri`** — not `url`, which is the name the field would obviously have been given.
- Button nodes are padded with `{!$brand...}` tokens. These are merge-field-shaped but are never
  destinations, and treating them as such silences `LNK004` on every button.
- An image keeps its own source at `imageInfo.url`. That is not a link and is excluded from
  `collectLinks`.

- An embedded block is a **pointer**, not a copy. The node is
  `definition: "sfdc_cms/reusableContentBlock"` and the key it points at is the tail of
  `attributes.content.definition`, written as `@cms/MCK263AR76UVCFPDIHIXUCFOYMMU`. There is no
  `contentKey` field on the node, which is why an earlier resolver that only knew that name came away
  with nothing.

- The template an email was built from is **`sfdc_cms:template.definition`**, a bare content key
  sitting beside `sfdc_cms:block` rather than inside it. Next to it,
  `sfdc_cms:template.attributes.schemaMap` maps every component id to a `readOnly` flag — the
  template's own statement of what an author may edit.
- The brand is `lightning:brandSource`, carrying either a `contentKey` or
  `defaultBrandOption: "sfdcBrand"` when no brand item is attached.
- A CMS image holds its key at `imageInfo.source.ref.contentKey`; `imageInfo.fileName` is present
  only sometimes. Alt text typed into the email is `imageInfo.altText`, and
  `imageInfo.overrideAltText` is `false` when the description lives on the asset instead.

> **The Connect REST API does not return `sfdc_cms:template`.** Fetching a content item through
> `/services/data/vXX.0/connect/cms/contents/{id}` gives back a body with no template field at all,
> for emails that demonstrably have one. Sampling saved content through the API therefore suggests
> the reference is never kept — which is wrong. The editor's own `getContent` does return it, and
> that is what this panel reads. Recorded here so nobody repeats the experiment and reaches the same
> wrong conclusion.

Shapes not yet confirmed: `variations` (dynamic content), and the full set of node definitions used
for block references, of which `BLOCK_REFERENCE` matches the four observed so far. Report anything
that looks wrong with the "Content structure" outline attached.

---

<sub>Runs as a Content Editor Extension panel in the Marketing Cloud Next email builder.</sub>
