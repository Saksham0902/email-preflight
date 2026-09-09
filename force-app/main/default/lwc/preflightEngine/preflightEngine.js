/**
 * preflightEngine — pure, deterministic pre-send checks for MCN email content.
 *
 * NO LWC / DOM / org dependencies here on purpose: everything is plain functions over the
 * content-body JSON so it can be unit-tested with Jest in isolation.
 *
 * WHY THIS EXISTS: MCE had a validation step before send. MCN has no equivalent — a broken merge
 * field, an unclosed `{{#if}}`, or a missing unsubscribe link is only discoverable AFTER the send,
 * as an `ssot__EngagementActionReasonText__c` row in the Email Engagement DMO ("Failed to render due
 * to syntax errors", "Data graph doesn't contain valid personalization information", ...). By then
 * the send is spent. Most of those causes are visible in the content tree beforehand.
 *
 * READ-ONLY BY DESIGN: nothing here mutates the body. The engine takes content in and returns
 * findings out. There is deliberately no write path, so the tool can never corrupt an email.
 *
 * SCOPE LIMIT (state this to users, don't hide it): we only see the content item that is OPEN in the
 * editor. Reusable content blocks and templates it embeds are SEPARATE content items referenced by
 * id, so their links, images and unsubscribe footer are invisible to us. A "missing unsubscribe"
 * finding therefore means "not in THIS item" — not "not in the sent email". Run the tool on the
 * blocks too.
 *
 * @module preflightEngine
 */

export const SEVERITY = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

/** Order used for sorting/rollup — most severe first. */
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };

/**
 * Link-bearing string fields observed across MCN components.
 *
 * `uri` is what `lightning/actionButton` uses for its destination — confirmed against a real content
 * body, and the field a CTA is most likely to be missing.
 */
const LINK_FIELDS = ['linkUrl', 'linkUrlMergeField', 'url', 'uri', 'generatedUrl', 'mergeFieldUrl'];

/** Node fields that may carry raw HTML with anchors, images or scripting. */
const HTML_FIELDS = ['rawHtml', 'html', 'value', 'text'];

/**
 * Fields that hold copy a RECIPIENT actually reads. Deliberately a whitelist, not "every string":
 * the body is full of ids, definitions and style tokens, and counting those as text would defeat
 * the image-to-text ratio check.
 */
const TEXT_FIELDS = [
    'rawHtml', 'html', 'text', 'value', 'buttonText', 'label',
    'headline', 'subtitle', 'caption', 'paragraph'
];

/**
 * Keys the editor is observed to use for the subject line / preheader, in preference order.
 * Exported so the QA tab reads these fields the same way the rules do — if the builder changes a
 * key, both must move together or they will disagree about what the subject even is.
 */
export const SUBJECT_KEYS = ['subject', 'subjectLine', 'emailSubject'];
export const PREHEADER_KEYS = ['preheader', 'previewText', 'preHeader', 'previewLine'];

/** Set by the builder to `promotional` or `transactional`; decides whether opt-out is required. */
const PURPOSE_KEYS = ['messagePurpose'];

/** MCN asset-name limit, per the MC Next Implementation Guide. */
export const EMAIL_NAME_MAX = 200;

/** How many example locations to attach to a finding before collapsing to "and N more". */
const MAX_LOCATIONS = 10;

/**
 * Handlebars built-ins + the MCN-specific helpers documented in the MCN Handlebars reference.
 * A bare `{{token}}` matching one of these is NOT reported as an undeclared variable.
 */
const KNOWN_HELPERS = new Set([
    'if', 'unless', 'each', 'with', 'else', 'log', 'lookup', 'this',
    'set', 'get', 'fallback', 'concat', 'format', 'formatDate', 'formatNumber',
    'default', 'encodeURI', 'encodeURIComponent', 'json'
]);

/** Hrefs that are placeholders rather than real destinations — a link left like this ships broken. */
const PLACEHOLDER_HREFS = new Set([
    '', '#', 'http://', 'https://', 'about:blank', 'javascript:void(0)', 'javascript:;', '/'
]);

/** Substrings that betray an unfinished href even when the URL is syntactically valid. */
const PLACEHOLDER_PATTERNS = [/example\.com/i, /yourdomain/i, /lorem/i, /\bTODO\b/i, /xxxxx/i];

/** Copy left behind from a template or a wireframe. Kept tight — a loose list here is pure noise. */
const PLACEHOLDER_COPY = [
    /lorem ipsum/i,
    /\byour (?:text|copy|headline|content) here\b/i,
    /\badd (?:your )?(?:text|copy|content) here\b/i,
    /\bsample (?:text|copy)\b/i,
    /\binsert (?:text|copy|image|link|name)\b/i,
    /\bplaceholder (?:text|copy)\b/i,
    /\bclick here to edit\b/i,
    /\bTBD\b/,
    /\bFIXME\b/i,
    // Copy the MCN starter template ships with. Reaching a send with these still in place is the
    // most common version of this mistake, because they read as real sentences.
    //
    // "build an email" is ANCHORED to the whole string, unlike the rest. As a standalone subject or
    // paragraph it is template default; mid-sentence it is ordinary English an email-marketing
    // customer would legitimately write, and flagging that would be a false positive.
    /\bcustomize this draft\b/i,
    /^(?:let['’]?s\s+)?build an email[.!]*$/i,
    /\breplace this (?:text|content)\b/i,
    /^untitled\b/i
];

/**
 * Outlook on Windows renders backgrounds through VML, and the MCN builder strips VML on save — so a
 * background image set in the builder simply does not appear there, with no warning.
 */
const OUTLOOK_MARKUP = /<!--\s*\[\s*if\s+[gl]te\s+mso|<!--\s*\[\s*if\s+mso|<\s*v:[a-z]|xmlns:v\s*=/i;

/** Keys that mean a background image is actually SET, rather than just styled. */
const BACKGROUND_SOURCE_KEYS = ['source', 'url', 'imageInfo', 'src', 'contentKey', 'ref'];

/** Trademark and copyright marks — reported to render unreliably in some clients and sender fields. */
const RISKY_SUBJECT_CHARS = /[®™©]/;

/** The builder lays columns out on a 12-unit grid; a row that does not total 12 does not fit. */
export const COLUMN_GRID = 12;

/** Below this, body text is cramped enough to hurt readability at normal sizes. */
export const MIN_LINE_HEIGHT = 1.2;

/** Below this, iOS Mail and Gmail may auto-scale the text, which breaks the layout around it. */
export const MIN_FONT_PX = 14;

/**
 * MCE attribute substitution: `%%FirstName%%`, `%%emailaddr%%`.
 *
 * Excludes `%%[` (AMPscript block) and `%%=` (inline AMPscript) because those are legitimate in the
 * documented MCN cases — Marketing Object lookups and the Smart Block obfuscation pattern. Only the
 * bare substitution form is unambiguously dead syntax in MCN.
 */
const MCE_SUBSTITUTION = /%%(?!\[|=)[A-Za-z_][A-Za-z0-9_ ]*%%/g;

/** Leftovers from an MCE-authored email that no longer resolve or route correctly. */
const MCE_ARTIFACTS = [
    { re: /click\.[a-z0-9.-]*exacttarget\.com/i, what: 'MCE click-tracking domain' },
    { re: /\.exct\.net/i, what: 'MCE tracking domain' },
    { re: /\bRedirectTo\s*\(/i, what: 'AMPscript RedirectTo()' },
    { re: /\bCloudPagesURL\s*\(/i, what: 'AMPscript CloudPagesURL()' },
    { re: /\bmicrositeurl\s*\(/i, what: 'AMPscript MicrositeURL()' }
];

/** Markup mail clients strip, sandbox or refuse to deliver. */
const UNSAFE_HTML = [
    { re: /<\s*script\b/i, what: '<script>' },
    { re: /<\s*iframe\b/i, what: '<iframe>' },
    { re: /<\s*form\b/i, what: '<form>' },
    { re: /<\s*(object|embed|video|audio)\b/i, what: 'embedded media tag' },
    { re: /\son[a-z]+\s*=\s*["']/i, what: 'inline event handler (onclick=, onload=, ...)' }
];

/** Subject longer than this is truncated by most desktop and mobile clients. */
export const SUBJECT_MAX_RECOMMENDED = 100;

/** Past this, a phone starts cutting the subject off. Common QA guidance is to aim for 40–50. */
export const SUBJECT_IDEAL_MAX = 60;

/** Preheader longer than this is cut off in the inbox preview on every major client. */
export const PREHEADER_MAX_RECOMMENDED = 100;

/**
 * Under this, the inbox has space left over after the preheader and fills it by pulling in the
 * opening words of the email body — usually "View in browser" or an image alt.
 */
export const PREHEADER_MIN_RECOMMENDED = 40;

/** Literal padding past this is more likely an accident than a design decision. */
export const MAX_REASONABLE_PADDING = 60;

/**
 * Markers that mean an email was never meant to leave the building. Anchored to the START of the
 * subject or preheader, which is where a tester puts them and where they cannot be ordinary copy.
 */
const TEST_MARKERS = [
    /^\s*\[?\s*(test|testing|tst)\b[\s:.\-\]]/i,
    /^\s*\[?\s*(draft|wip|internal|sample|dummy)\b[\s:.\-\]]/i,
    /^\s*\[?\s*do\s+not\s+send\b/i,
    /\btemplate\s+(subject\s+line|preheader|copy)\b/i,
    /\bxxx+\b/i
];

/** Field words that make a bracketed phrase a merge field somebody forgot to wire up. */
const PLACEHOLDER_FIELD_WORDS =
    /\b(name|date|time|address|email|phone|provider|doctor|md|physician|organi[sz]ation|org|company|brand|city|state|zip|title|headline|topic|subject|preheader|amount|price|discount|offer|promo|code|product|number|location|campus|link|url|first|last|appointment|referring|patient|member|account)\b/i;

/**
 * Words that mark a bracketed phrase as an instruction to whoever builds the email.
 *
 * Needed alongside the field-word list because the starter templates phrase their placeholders as
 * directions rather than field names — `[Your Topic]`, `[Insert Offer Here]` — and none of those
 * words are fields, so a field-word test alone walks straight past the most common case there is.
 *
 * Kept as a second list rather than folded into the first because the two are doing different jobs,
 * and because the alternative — flagging every bracketed phrase — would be wrong: brackets are a
 * real subject-line convention (`[Webinar]`, `[Update]`) and those emails are doing nothing wrong.
 */
const PLACEHOLDER_INSTRUCTION_WORDS = /\b(your|insert|enter|placeholder|here|tbd|xx+)\b/i;

/** A bracketed phrase that reads as a note to the builder rather than as ordinary copy. */
function isPlaceholderPhrase(inner) {
    if (/^\d+$/.test(inner)) return false; // [1], [2] are footnote markers
    return PLACEHOLDER_FIELD_WORDS.test(inner) || PLACEHOLDER_INSTRUCTION_WORDS.test(inner);
}

/** Words that make a logo a logo, whatever the file happens to be called. */
const LOGO_HINT = /\b(logo|wordmark|brandmark|lockup)\b/i;

/**
 * `lightning/section` → "Section". The words here are deliberately the ones the builder's own
 * Component Tree panel prints, because that panel is where somebody goes to act on a finding: a
 * label that reads differently to the tree makes them translate before they can start looking.
 */
const FRIENDLY_TYPE = [
    // First, because a block reference is the one component whose own type matters more than
    // anything it appears to contain — and it must not be mistaken for the section holding it.
    [/(reusablecontentblock|emailfragment)/i, 'Reusable block'],
    [/section/i, 'Section'],
    [/column/i, 'Column'],
    [/(actionButton|button|cta)/i, 'Button'],
    [/image/i, 'Image'],
    [/(heading|title)/i, 'Heading'],
    [/(paragraph|richtext|textblock)/i, 'Paragraph'],
    [/list/i, 'List'],
    [/(divider|horizontalrule)/i, 'Divider'],
    [/spacer/i, 'Spacer'],
    [/html/i, 'HTML block'],
    [/video/i, 'Video'],
    [/social/i, 'Social links'],
    [/recommend/i, 'Recommendations']
];

/** Longest text hint attached to a component label before it stops helping and starts wrapping. */
const LABEL_HINT_MAX = 45;

/**
 * A US postal address, which CAN-SPAM requires in the footer. Two independent shapes so a footer
 * that gives only a city/state/ZIP line still satisfies it.
 */
const POSTAL_ADDRESS = [
    /\b\d{1,6}\s+[A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z.'-]+){0,4}\s+(street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|place|pl|circle|cir|court|ct|parkway|pkwy|highway|hwy|square|sq|terrace|ter)\b\.?/i,
    /\b[A-Z][A-Za-z.'-]+,\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/,
    /\b(suite|ste|floor|fl|po box|p\.o\. box)\s+[\w-]+/i
];

/**
 * An address that arrives as a merge field rather than as typed text.
 *
 * `{!$organization.Address}` pulls the address from Company Information at send time, which is the
 * recommended way to do it — it cannot go stale and it is right in every email at once. But it is
 * not address-SHAPED in the builder, so matching the copy for street names finds nothing and the
 * compliance check accuses a footer that is completely correct.
 *
 * Matched on any merge-field-ish token carrying an address word, rather than on the exact
 * `$organization` token, because orgs also use brand fields, custom labels and their own content
 * variables for this, and each one we fail to recognise reads to the author as the tool being wrong
 * about the law.
 */
const ADDRESS_WORD = /\b(address|street|city|postal|postcode|zip|mailing)\b/i;

/**
 * Whether anything here merges in an address.
 *
 * Word boundaries alone do not work: merge fields are written `postalAddress` and `MailingAddress`
 * as often as `$organization.Address`, and `\baddress\b` matches none of those. Dropping the
 * boundaries instead would make `capacity` contain `city`. So the token is split on camelCase and
 * on the usual separators first, turning `brand.postalAddress` into `brand postal Address`, and
 * only then matched whole-word.
 */
function hasAddressMergeField(corpus) {
    const tokens = corpus.match(/\{[!{#][^{}]*\}/g) || [];
    return tokens.some((token) =>
        ADDRESS_WORD.test(token.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._-]+/g, ' '))
    );
}

/** Below this many characters of live copy, an email reads as image-only to a spam filter. */
export const MIN_LIVE_TEXT = 120;

/**
 * Gmail truncates a message over ~102 KB and hides the rest behind a "View entire message" link —
 * which sits BELOW the unsubscribe footer, so the clipped part effectively does not exist.
 */
export const GMAIL_CLIP_KB = 102;

/** Where we start warning. Deliberately under the real limit — see checkSize for why. */
export const SIZE_WARN_KB = 70;

/** WCAG AA for body text. Below this, text is hard work for anyone with imperfect eyesight. */
export const MIN_CONTRAST = 4.5;

/** A word longer than this cannot wrap on a phone and forces the whole email to scroll sideways. */
export const MAX_UNBROKEN_RUN = 45;

/**
 * Link text that tells a screen-reader user nothing. Most screen readers can list every link in a
 * message on its own; "click here" repeated eight times is a useless list.
 *
 * "Learn more" and "Read more" are deliberately NOT here. They are equally uninformative in theory
 * and completely standard in marketing email in practice, and flagging every CTA in every email is
 * how a tool gets ignored.
 */
const VAGUE_LINK_TEXT = [
    /^click here[.!]?$/i, /^here[.!]?$/i, /^this link[.!]?$/i, /^link[.!]?$/i,
    /^click[.!]?$/i, /^more[.!]?$/i, /^this[.!]?$/i, /^go[.!]?$/i
];

/** Alt text that is a file name or an asset id rather than a description of the picture. */
const NON_DESCRIPTIVE_ALT = [
    /\.(png|jpe?g|gif|webp|svg|bmp)$/i,
    /^[A-Z0-9]{15,}$/,                    // CMS content key, e.g. MCJX4LL4ZSVNHALNTPQEVK3NF77U
    /^(image|img|picture|photo|banner|graphic|untitled|asset)[\s_-]*\d*$/i,
    /^(final|draft|copy|new)[\s_-]*\d*$/i,
    /^[\w-]*\d{6,}[\w-]*$/                // camera/export filename, e.g. IMG_20240517
];

/**
 * Hosts that mean the link points at something only the author can reach. Sending these is the
 * mistake that cannot be walked back, so it is an error rather than a warning.
 */
const NON_PRODUCTION_HOST = [
    /^localhost$/i, /^127\.0\.0\.1$/, /^0\.0\.0\.0$/, /^192\.168\./, /^10\./,
    /^(staging|stage|uat|test|testing|dev|develop|qa|preprod|pre-prod|sandbox|demo)\./i,
    /\.(local|test|internal|invalid|localhost)$/i,
    /\.(staging|uat|dev|qa)\.[a-z]+$/i
];

/** CSS the email clients that matter do not implement. The layout does not degrade, it collapses. */
const UNSUPPORTED_CSS = [
    { re: /display\s*:\s*flex/i, what: 'display: flex' },
    { re: /display\s*:\s*grid/i, what: 'display: grid' },
    { re: /position\s*:\s*(absolute|fixed|sticky)/i, what: 'position: absolute / fixed' },
    // Anchored on a declaration boundary rather than \b, which would also match the `transform` in
    // `text-transform: uppercase` — an ordinary, well-supported property.
    { re: /(^|[\s;{"'])transform\s*:/i, what: 'transform' },
    { re: /\banimation\s*:|@keyframes/i, what: 'animation / @keyframes' }
];

/** Fonts fetched over the network. Outlook on Windows never loads them; Gmail strips the request. */
const WEB_FONT = /@font-face|fonts\.googleapis\.com|fonts\.gstatic\.com|typekit|use\.typekit\.net/i;

// ---------------------------------------------------------------------------
// Tree walking
// ---------------------------------------------------------------------------

/**
 * Recursively visit every object node in the content body. Depth-first, order-stable.
 * A `seen` set guards against the (theoretically impossible in JSON, but cheap to insure against)
 * cyclic reference.
 *
 * @param {*} body
 * @param {(node:object)=>void} visit
 */
export function walkNodes(body, visit) {
    const seen = new Set();
    (function step(node) {
        if (Array.isArray(node)) return node.forEach(step);
        if (node && typeof node === 'object') {
            if (seen.has(node)) return;
            seen.add(node);
            visit(node);
            Object.keys(node).forEach((k) => step(node[k]));
        }
        return undefined;
    })(body);
}

/**
 * Every string value in the tree. This is the corpus the Handlebars/AMPscript scanners run over —
 * scripting can appear in subject lines, link URLs, alt text and raw HTML alike, so we cast wide.
 *
 * @param {*} body
 * @returns {string[]}
 */
export function collectStrings(body) {
    const out = [];
    const seen = new Set();
    (function step(node) {
        if (typeof node === 'string') {
            if (node !== '') out.push(node);
            return;
        }
        if (Array.isArray(node)) return node.forEach(step);
        if (node && typeof node === 'object') {
            if (seen.has(node)) return;
            seen.add(node);
            Object.keys(node).forEach((k) => step(node[k]));
        }
        return undefined;
    })(body);
    return out;
}

/**
 * Every string in the tree, each paired with the component it was found in.
 *
 * The string-scanning rules — placeholder copy, unclosed Handlebars, legacy code, unsafe markup —
 * all used to report the matched fragment on its own. `[Your Company]` tells you what is wrong and
 * nothing about where, which in a twelve-section email means opening every section to find it. That
 * is the same failure the layout rules had before they learned to name their components.
 *
 * The position is deliberately the short form (`Paragraph 2 in Section 6 of 8`) and not the full
 * label, because the full label ends with a sample of the copy — and for these rules the copy is
 * already the thing being printed. Repeating it would make every line say the same thing twice.
 *
 * @param {*} body
 * @returns {Array<{text:string, place:string}>}
 */
export function collectLocatedStrings(body) {
    const out = [];
    const described = describeComponents(body);
    const seen = new Set();
    (function step(node, place) {
        if (typeof node === 'string') {
            if (node !== '') out.push({ text: node, place });
            return undefined;
        }
        if (Array.isArray(node)) {
            node.forEach((c) => step(c, place));
            return undefined;
        }
        if (node && typeof node === 'object') {
            if (seen.has(node)) return undefined;
            seen.add(node);
            const own = described.get(node);
            const next = own ? `${own.place}${own.where}` : place;
            Object.keys(node).forEach((k) => step(node[k], next));
        }
        return undefined;
    })(body, '');
    return out;
}

/** `[Your Company] — Section 6 of 8`, or just the value when we could not place it. */
function at(value, place) {
    return place ? `${value} — ${place}` : String(value);
}

/**
 * Located strings for a rule to scan, falling back to the flat corpus.
 *
 * Every check is callable on a hand-built context, which is how they are unit tested and how a
 * caller can run one rule in isolation. Requiring `locatedStrings` would make each of those callers
 * build a parallel structure to say the same thing twice, so a context that only has `strings` still
 * works and simply reports its findings without a position.
 */
function located(ctx) {
    if (Array.isArray(ctx.locatedStrings)) return ctx.locatedStrings;
    return (ctx.strings || []).map((text) => ({ text, place: '' }));
}

/** Only the strings that look like HTML fragments carrying markup we care about. */
export function collectHtmlStrings(body) {
    const out = [];
    walkNodes(body, (node) => {
        for (const f of HTML_FIELDS) {
            const v = node[f];
            if (typeof v === 'string' && /<\s*(a|img)\b/i.test(v)) out.push(v);
        }
    });
    return out;
}

/**
 * Find the first non-blank string value stored under any of `keys`, anywhere in the tree.
 * Returns `{ found, value }` so callers can tell "present but empty" from "key absent entirely" —
 * an important distinction, because we must not report a hard ERROR for a field whose storage
 * shape we simply failed to recognize.
 *
 * @param {*} body
 * @param {string[]} keys
 * @returns {{found:boolean, value:string}}
 */
export function findValueByKeys(body, keys) {
    let found = false;
    let value = '';
    walkNodes(body, (node) => {
        for (const k of keys) {
            if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
            const v = node[k];
            if (typeof v !== 'string') continue;
            found = true;
            if (v.trim() !== '' && value === '') value = v.trim();
        }
    });
    return { found, value };
}

/**
 * Every link in the content: structured link fields plus anchor hrefs inside HTML.
 * Deduped by URL — a single button stores the same URL in both `generatedUrl` and `url`, and
 * reporting it twice would overstate the link count.
 *
 * @param {*} body
 * @returns {string[]}
 */
export function collectLinks(body) {
    const urls = new Set();
    const seen = new Set();
    // Hand-rolled walk rather than walkNodes so it can refuse to descend into `imageInfo`. An image
    // stores its own SOURCE under `url` (`/cms/media/MCJX...`), which is not a destination — counting
    // it inflates the link total and drags every image through the link checks.
    (function step(node) {
        if (Array.isArray(node)) return node.forEach(step);
        if (!node || typeof node !== 'object') return undefined;
        if (seen.has(node)) return undefined;
        seen.add(node);
        for (const f of LINK_FIELDS) {
            const v = node[f];
            if (typeof v === 'string' && v.trim() !== '') urls.add(v.trim());
        }
        for (const k of Object.keys(node)) {
            if (k === 'imageInfo') continue;
            step(node[k]);
        }
        return undefined;
    })(body);
    for (const html of collectHtmlStrings(body)) {
        const re = /<a\b[^>]*?href\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const href = (m[2] !== undefined ? m[2] : m[3] || '').trim();
            urls.add(href);
        }
    }
    return Array.from(urls);
}

/**
 * Every link paired with its text and the component it sits in.
 *
 * `collectLinks` deliberately dedupes to a flat set of URLs, which is right for the rules — LNK002
 * has nothing useful to say about the same insecure URL twice. The QA tab needs the opposite: a
 * reviewer told that an unlisted link is in the email immediately asks *where*, and "Section 2"
 * is the difference between a finding they can act on and one they have to hunt for.
 *
 * Text comes along because a button's label and its destination live on the same node, so splitting
 * them into two collectors would mean walking the tree twice to reassemble the same pairs.
 *
 * @param {*} body
 * @returns {Array<{url:string, text:string, label:string}>}
 */
export function collectLocatedLinks(body) {
    const described = describeComponents(body);
    const raw = [];
    const seenNodes = new Set();

    const hrefFrom = (attrs) => {
        const m = /\bhref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i.exec(attrs || '');
        return m ? (m[2] !== undefined ? m[2] : m[3] || '') : '';
    };
    const add = (url, text, holder) => {
        const u = String(url || '').trim();
        const t = String(text || '').trim();
        if (u || t) raw.push({ url: u, text: t, holder });
    };

    (function step(node, owner) {
        if (Array.isArray(node)) {
            node.forEach((n) => step(n, owner));
            return;
        }
        if (!node || typeof node !== 'object') return;
        if (seenNodes.has(node)) return;
        seenNodes.add(node);

        // A component owns everything beneath it until a nested component takes over. `attributes`
        // objects carry link fields but are not themselves components, so they inherit the parent.
        const isComponent = typeof node.definition === 'string';
        const holder = isComponent ? node : owner;
        const attrs = node.attributes || {};

        // Button label and destination, read only from the component itself. `attributes` is visited
        // separately by this same walk and holds the label but not always the URL, so reading a
        // label from it too would invent a second, destination-less copy of the same button.
        if (isComponent) {
            const isButton = /button|cta/i.test(node.definition);
            const text = [
                attrs.buttonText, node.buttonText,
                isButton ? attrs.text : null, isButton ? node.text : null
            ].find((v) => typeof v === 'string' && v.trim() !== '');
            if (text) {
                const href = LINK_FIELDS.map((f) => attrs[f] || node[f]).find(
                    (v) => typeof v === 'string' && v.trim() !== ''
                );
                add(href || '', text, node);
            }
        }

        for (const f of LINK_FIELDS) {
            const v = node[f];
            if (typeof v === 'string' && v.trim() !== '') add(v, '', holder);
        }

        for (const f of HTML_FIELDS) {
            const html = node[f];
            if (typeof html !== 'string' || !/<\s*a\b/i.test(html)) continue;
            const covered = [];
            const pairRe = /<a\b([^>]*)>([\s\S]*?)<\s*\/\s*a\s*>/gi;
            let m;
            while ((m = pairRe.exec(html)) !== null) {
                covered.push([m.index, m.index + m[0].length]);
                const text = m[2]
                    .replace(/<[^>]*>/g, ' ')
                    .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
                    .replace(/\s+/g, ' ')
                    .trim();
                add(hrefFrom(m[1]), text, holder);
            }
            // An anchor the paired pattern missed — unclosed, or closed by the next one. Skip any
            // starting inside an already-captured anchor, or every link is recorded twice.
            const hrefRe = /<a\b[^>]*?href\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi;
            while ((m = hrefRe.exec(html)) !== null) {
                if (covered.some(([s, e]) => m.index >= s && m.index < e)) continue;
                add(m[2] !== undefined ? m[2] : m[3] || '', '', holder);
            }
        }

        for (const k of Object.keys(node)) {
            if (k === 'imageInfo') continue; // an image's own source is not a destination
            step(node[k], holder);
        }
    })(body, null);

    // Collapse. The same destination is reached several ways — a button stores it under `url` and
    // `generatedUrl`, and the walk sees both the component and its attributes — so an entry that
    // carries text supersedes a bare one for the same destination in the same place.
    const labelOf = (holder) => {
        const place = holder ? described.get(holder) : null;
        return place ? place.label : '';
    };
    const labelled = new Set();
    for (const e of raw) if (e.text && e.url) labelled.add(`${e.url}\u0000${labelOf(e.holder)}`);

    const out = [];
    const seen = new Set();
    for (const e of raw) {
        const label = labelOf(e.holder);
        if (!e.text && e.url && labelled.has(`${e.url}\u0000${label}`)) continue;
        const key = `${e.url}\u0000${e.text}\u0000${label}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ url: e.url, text: e.text, label });
    }
    return out;
}

/**
 * True if this node is a component that is MEANINGLESS without a destination.
 *
 * Buttons only, and deliberately so. It is tempting to treat "has a link field" as the test, but
 * plenty of components carry an empty link field as their normal resting state — an unlinked image
 * is ordinary content, not a mistake — and flagging those is the false positive that costs the tool
 * its credibility.
 *
 * Nothing is lost by the narrow scope: a text link with an empty href arrives as an empty string in
 * collectLinks and is already reported by LNK001. A button is the one case that reaches neither
 * collector, because an unset URL contributes no string at all.
 */
function isLinkCandidate(node) {
    const attrs = node.attributes || {};
    if (attrs.imageInfo || node.imageInfo) return false; // a linked image styled as a button is still an image

    const def = typeof node.definition === 'string' ? node.definition : '';
    if (/button|cta/i.test(def)) return true;

    // Fallback for a button whose definition we do not recognise: only buttons carry button text,
    // so the field is a reliable tell on its own.
    return typeof attrs.buttonText === 'string' || typeof node.buttonText === 'string';
}

/**
 * Does this key/value pair look like a destination?
 *
 * DELIBERATELY GENEROUS. LINK_FIELDS is the set of fields we know MCN uses, but a button's real URL
 * can sit under a key we have not catalogued (nested action shapes vary by action type). For
 * "is this button broken?" a false NEGATIVE is cheap — we stay quiet — while a false POSITIVE tells
 * a marketer their working button is broken, which destroys trust in the whole tool. So anything
 * url-shaped, under any key, counts as a destination.
 */
function looksLikeDestination(key, value) {
    if (typeof value !== 'string') return false;
    const v = value.trim();
    if (v === '') return false;

    // Brand tokens are merge-field-shaped but are never destinations, and a button carries a couple
    // of dozen of them whether or not anyone set a URL:
    //   lightning:colorGroup.linkColor  =  "{!$brand.colorScheme.primaryAccent}"
    // Accepting those means every button looks linked and the rule can never fire.
    if (/^\{!\s*\$brand\b/i.test(v)) return false;

    // Value-shaped tests: unambiguous whatever the key happens to be called.
    if (/^https?:\/\//i.test(v)) return true;
    if (/^(mailto|tel|sms):/i.test(v)) return true;
    if (/^\/[^/]/.test(v)) return true; // site-relative path
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+\//i.test(v)) return true; // domain.tld/path, no scheme

    // Key-shaped test: a key that names a destination outright — but only when the value could
    // plausibly BE one. Both halves are needed. Matching the key alone means `linkTarget: "_blank"`
    // reads as a destination, and since a button carries that attribute whether or not it has a URL,
    // it silences the rule on exactly the empty buttons it exists to catch.
    const k = key.toLowerCase();
    const namesADestination = /(url|href|uri)$/.test(k) || k === 'link' || k === 'destination';
    if (namesADestination && /[./:{]/.test(v)) return true;

    // An expression under any other key, but only one that names a link or an address — the same
    // reasoning that rules out the brand tokens above.
    return /^\{[!{]/.test(v) && /(link|url|uri)/i.test(v);
}

/** Any plausible destination anywhere beneath (and including) this node. */
function subtreeHasDestination(root) {
    let has = false;
    walkNodes(root, (node) => {
        if (has) return;
        for (const key of Object.keys(node)) {
            if (looksLikeDestination(key, node[key])) has = true;
        }
    });
    return has;
}

/** The word a person would use for this component, from the definition string the builder stores. */
export function friendlyType(definition) {
    if (typeof definition !== 'string' || definition.trim() === '') return 'Component';
    for (const [re, name] of FRIENDLY_TYPE) {
        if (re.test(definition)) return name;
    }
    // Unknown component: turn `lightning/fancyNewThing` into "Fancy new thing" rather than printing
    // the raw definition. New components ship regularly and an unrecognised one should still read
    // like a name.
    const tail = definition.split('/').pop() || definition;
    const spaced = tail.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The first words a reader would see inside this node — the phrase they will use to recognise it.
 *
 * Merge expressions are stripped rather than shown: a hint of `{{fallback FirstName ""}}` identifies
 * nothing, and the literal copy either side of it is what appears on screen.
 */
function firstWordsIn(node) {
    let best = '';
    walkNodes(node, (n) => {
        if (best) return;
        for (const f of TEXT_FIELDS) {
            const v = n[f];
            if (typeof v !== 'string') continue;
            const text = v
                .replace(/<[^>]*>/g, ' ')
                .replace(/\{\{[\s\S]*?\}\}/g, ' ')
                .replace(/\{![^}]*\}/g, ' ')
                .replace(/&(?:nbsp|amp|lt|gt|#\d+);/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (text.length >= 3) {
                best = text;
                return;
            }
        }
    });
    if (best.length <= LABEL_HINT_MAX) return best;
    return `${best.slice(0, LABEL_HINT_MAX).replace(/\s+\S*$/, '')}…`;
}

/** Distinct component types beneath a node, for a section with no copy of its own. */
function childTypesOf(node) {
    const types = [];
    (function step(n) {
        if (types.length >= 3 || !n || !Array.isArray(n.children)) return;
        for (const child of n.children) {
            if (!child || typeof child !== 'object') continue;
            const t = typeof child.definition === 'string' ? friendlyType(child.definition) : '';
            // Columns are structural packaging rather than content, so look straight through them
            // to whatever the author actually placed. A child with no definition is packaging too.
            if (t === '' || t === 'Column') step(child);
            else if (!types.includes(t) && types.length < 3) types.push(t);
        }
    })(node);
    return types;
}

/**
 * A label for every component, matching how the builder's Component Tree panel presents them.
 *
 * The whole point is that a finding has to be actionable. `lightning/section` names a type and
 * leaves the reader to work out which of six sections is meant — so this counts sections in
 * document order (the same order the tree panel lists them) and adds a few words of the component's
 * own copy, which is how a person recognises a block of an email they wrote.
 *
 * @param {*} body
 * @returns {Map<object, {label:string, type:string, place:string, where:string}>} by node identity
 */
export function describeComponents(body) {
    const found = [];
    const seen = new Set();

    (function step(node, ancestors) {
        if (Array.isArray(node)) {
            node.forEach((c) => step(c, ancestors));
            return undefined;
        }
        if (!node || typeof node !== 'object') return undefined;
        if (seen.has(node)) return undefined;
        seen.add(node);

        let next = ancestors;
        const def = typeof node.definition === 'string' ? node.definition : '';
        // Data providers carry a `definition` too, but they are configuration rather than something
        // laid out on the canvas, and numbering them alongside sections would be nonsense.
        if (def && !/dataprovider/i.test(def)) {
            const entry = { node, type: friendlyType(def), ancestors };
            found.push(entry);
            next = ancestors.concat([entry]);
        }
        for (const key of Object.keys(node)) {
            // `attributes` is the style bag and `lightning:*` keys are configuration. Neither is a
            // structural child, and descending into them invents components that are not on the page.
            if (key === 'attributes' || key.startsWith('lightning:')) continue;
            step(node[key], next);
        }
        return undefined;
    })(body, []);

    // Sections are numbered across the whole email, because that is what the tree panel shows.
    // Everything else is numbered WITHIN its section: "the second paragraph in section 3" is how
    // someone navigates, whereas a document-wide paragraph number would mean counting from the top.
    const sections = found.filter((e) => e.type === 'Section');
    sections.forEach((e, i) => {
        e.index = i + 1;
        e.total = sections.length;
    });

    const counted = new Map();
    const keyOf = (e) => `${e.section ? e.section.index : 0}|${e.type}`;
    for (const entry of found) {
        if (entry.type === 'Section') continue;
        entry.section = [...entry.ancestors].reverse().find((a) => a.type === 'Section');
        const n = (counted.get(keyOf(entry)) || 0) + 1;
        counted.set(keyOf(entry), n);
        entry.index = n;
    }
    // Totals are only known once every entry has been counted, and a count is only worth printing
    // when there is more than one of something to tell apart — hence the second pass.
    for (const entry of found) {
        if (entry.type === 'Section') continue;
        entry.total = counted.get(keyOf(entry));
    }

    const out = new Map();
    for (const entry of found) out.set(entry.node, describeOne(entry));
    return out;
}

/**
 * Assemble one description: what it is, where it lives, and how to recognise it.
 *
 * The parts are returned separately as well as joined, because a button already has a strong name
 * of its own — the words printed on it — and reads better as `Button "Learn more" in Section 3 of 6`
 * than as the generic form with the text tacked on the end.
 */
function describeOne(entry) {
    const position = (e) => (e.total > 1 ? `${e.type} ${e.index} of ${e.total}` : e.type);

    const place = position(entry);
    const where = entry.type !== 'Section' && entry.section ? ` in ${position(entry.section)}` : '';

    let label = `${place}${where}`;
    const words = firstWordsIn(entry.node);
    if (words) {
        label = `${label} — "${words}"`;
    } else {
        // No copy anywhere inside. Naming what IS in there still beats naming nothing, and for a
        // picture-only section it is often the more recognisable description of the two.
        const kids = childTypesOf(entry.node);
        if (kids.length) label = `${label} — ${kids.join(', ')}`;
    }
    return { label, type: entry.type, place, where };
}

/** How many different values a set of {value, place} pairs holds. */
function distinctValues(pairs) {
    return new Set(pairs.map((p) => p.value)).size;
}

/**
 * Turn `[{value:'30px', place:'Section 1 of 6'}, ...]` into one line per value naming the components
 * that use it: `30px — Section 1 of 6, Section 2 of 6`.
 *
 * The "you have used two different values for the same thing" rules used to report just the values
 * (`30px`, `100px`), which names the problem and hides the only thing you need to fix it: which
 * section is the odd one out. Grouping the other way round — a line per component — would repeat the
 * shared value on every line and bury the outlier in the middle of the list.
 *
 * @param {Array<{value:string, place:string}>} pairs
 * @returns {string[]}
 */
function groupByValue(pairs) {
    const byValue = new Map();
    for (const { value, place } of pairs) {
        if (!byValue.has(value)) byValue.set(value, []);
        const places = byValue.get(value);
        if (place && !places.includes(place)) places.push(place);
    }
    const out = [];
    for (const [value, places] of byValue) {
        // Past four the list is longer than it is useful, and the count is the part that matters.
        const shown = places.length > 4
            ? `${places.slice(0, 4).join(', ')} and ${places.length - 4} more`
            : places.join(', ');
        out.push(shown ? `${value} — ${shown}` : value);
    }
    return out;
}

/** Best human-readable name for a component, for reporting. */
function labelForNode(node, described) {
    const attrs = node.attributes || {};
    const candidate = [
        attrs.buttonText, node.buttonText, attrs.label, node.label,
        attrs.title, node.title, attrs.text, node.text
    ].find((v) => typeof v === 'string' && v.trim() !== '' && !v.includes('<'));

    const place = described && described.get(node);
    // The words on the button are the strongest identifier a person has, so they lead. The position
    // follows for the case that makes this rule hard to act on: three buttons all saying "Learn more".
    if (candidate && place) {
        return `${place.place} "${candidate.trim().slice(0, 40)}"${place.where}`;
    }
    if (candidate) return candidate.trim().slice(0, 60);
    if (place) return place.label;
    return typeof node.definition === 'string' ? friendlyType(node.definition) : 'link component';
}

/**
 * Components that can be clicked but have nowhere to go — the classic "dropped a CTA button in and
 * never set the URL" mistake.
 *
 * This CANNOT be done by inspecting collectLinks() output: an empty or absent URL contributes no
 * string to collect, so the component is invisible there. We have to find the component itself and
 * observe the absence.
 *
 * Descent stops at the first candidate so a button whose destination lives in a nested action node
 * (`lightning:click.actions[]`) is judged on its whole subtree and reported once, not twice.
 *
 * @param {*} body
 * @returns {string[]} labels of components with no destination
 */
/**
 * Anchors in raw HTML with NO href attribute at all — a CTA built as styled markup rather than as a
 * button component, whose destination was never filled in.
 *
 * Invisible to every other collector: `collectLinks` matches on `href=`, so an anchor without one
 * contributes nothing to match against. An anchor with an EMPTY href is a different case and is
 * already reported by LNK001, so it is skipped here rather than reported twice.
 *
 * @param {*} body
 * @returns {string[]}
 */
function collectLinklessAnchors(body) {
    const out = [];
    for (const html of collectHtmlStrings(body)) {
        const re = /<a\b([^>]*)>([\s\S]*?)<\s*\/\s*a\s*>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const attrs = m[1] || '';
            if (/\bhref\s*=/i.test(attrs)) continue; // has an href, empty or not — LNK001's job
            if (/\b(name|id)\s*=/i.test(attrs)) continue; // in-page anchor target, not a link
            const text = m[2].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
            out.push(text ? text.slice(0, 60) : 'link with no text');
        }
    }
    return out;
}

/**
 * Buttons built with the builder's own button component, labelled by position.
 *
 * Deliberately not the same set as `collectAnchors`. That one reports anything that links, which is
 * the right question for "does this go somewhere". This one asks "was this made with the button
 * component", because the Outlook spacing quirk is a property of how MCN builds that component —
 * a linked image used as a button is unaffected, and reporting it would be telling somebody to
 * apply a workaround they have already applied.
 */
export function collectButtonComponents(body) {
    const out = [];
    const described = describeComponents(body);
    const seen = new Set();
    walkNodes(body, (node) => {
        if (typeof node.definition !== 'string' || !/button|cta/i.test(node.definition)) return;
        if (seen.has(node)) return;
        seen.add(node);
        out.push(labelForNode(node, described));
    });
    return out;
}

export function collectLinklessNodes(body) {
    const out = collectLinklessAnchors(body);
    const seen = new Set();
    const described = describeComponents(body);
    (function step(node) {
        if (Array.isArray(node)) return node.forEach(step);
        if (!node || typeof node !== 'object') return undefined;
        if (seen.has(node)) return undefined;
        seen.add(node);
        if (isLinkCandidate(node)) {
            if (!subtreeHasDestination(node)) out.push(labelForNode(node, described));
            return undefined; // a link component owns its subtree either way
        }
        Object.keys(node).forEach((k) => step(node[k]));
        return undefined;
    })(body);
    return out;
}

/**
 * Images in the content, from BOTH storage shapes: structured image nodes (alt text under
 * `imageInfo`) and `<img>` tags inside raw HTML.
 *
 * `hasAlt` is false for a missing OR blank alt. We can't distinguish "decorative on purpose"
 * (`alt=""`) from "forgotten" in the structured shape, so the finding text covers both readings
 * rather than the engine guessing.
 *
 * @param {*} body
 * @returns {Array<{label:string, hasAlt:boolean, linked:boolean}>}
 */
export function collectImages(body) {
    const out = [];
    const described = describeComponents(body);
    // `imageInfo` is reachable from BOTH the component node (`node.attributes.imageInfo`) and the
    // attributes node itself (`node.imageInfo`), and walkNodes visits both — so dedupe on the info
    // object's identity or every structured image is counted twice. Parent is visited first, which
    // is the one that carries the link fields, so first-seen wins.
    const seenInfo = new Set();
    walkNodes(body, (node) => {
        const attrs = node.attributes || {};
        const info = attrs.imageInfo || node.imageInfo;
        if (!info || typeof info !== 'object') return;
        if (seenInfo.has(info)) return;
        seenInfo.add(info);
        const alt = [info.altText, attrs.altText, node.altText].find(
            (a) => typeof a === 'string' && a.trim() !== ''
        );
        const ref = (info.source && info.source.ref) || {};
        // The builder has two places to keep alt text. Tick "override" and it is typed into the
        // email and lands in `altText` here. Leave it unticked — the default — and the email keeps
        // an EMPTY `altText` while the real description lives on the image asset in CMS, which is a
        // separate content item this panel cannot read.
        //
        // Reading `altText` alone therefore reports every correctly-described image in the org as
        // having none. That is the worst kind of false positive: it fires on the people who did the
        // accessible thing, and it fires on most of them.
        const altFromCms =
            info.overrideAltText === false &&
            !alt &&
            [ref.contentKey, ref.id].some((v) => typeof v === 'string' && v.trim() !== '');
        // `name` is the asset — a file name, or the CMS content key when that is all there is. It
        // feeds the rules that reason about what the file is called (is it a logo? is the alt text
        // just the file name?). `label` is what a human gets shown, and a bare content key is
        // exactly the thing this labelling exists to stop printing.
        const name = String(info.fileName || ref.contentKey || attrs.name || node.name || 'image');
        const place = described.get(node);
        const asset = info.fileName || (alt ? alt.trim() : '');
        const linked = LINK_FIELDS.some(
            (f) => typeof node[f] === 'string' && node[f].trim() !== ''
        );
        // An image component dropped on the canvas and never given a picture keeps its whole
        // `imageInfo` shape — the styling keys are all there, only the reference is missing.
        const hasSource = [ref.contentKey, ref.id, info.url, info.src, info.fileName].some(
            (v) => typeof v === 'string' && v.trim() !== ''
        );
        // Which picture this is, in whatever form the builder has it. Preference order is by how
        // recognisable it is to a person checking the email against a spec: a real URL, then the
        // file name, and only then the CMS content key, which is opaque and identifies nothing to
        // a reader.
        const src = [info.url, info.src, info.fileName, ref.contentKey].find(
            (v) => typeof v === 'string' && v.trim() !== ''
        );
        out.push({
            label: place ? `${place.label}${asset ? ` (${asset})` : ''}` : name,
            name,
            hasAlt: Boolean(alt),
            altFromCms,
            alt: alt ? alt.trim() : '',
            linked,
            hasSource,
            src: src ? src.trim() : ''
        });
    });
    for (const html of collectHtmlStrings(body)) {
        // Where the anchors start and end, so an <img> can be told whether it sits inside one.
        // Without this every correctly linked image in a raw-HTML block reads as unlinked, and
        // IMG005 reports a problem that is not there.
        const linkedRanges = [];
        const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
        let am;
        while ((am = anchorRe.exec(html)) !== null) {
            const href = /\bhref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i.exec(am[1]);
            const value = href ? (href[2] !== undefined ? href[2] : href[3]) : '';
            // An empty href is not a link; collectLinklessAnchors reports those separately.
            if (value.trim() !== '') linkedRanges.push([am.index, am.index + am[0].length]);
        }
        const re = /<img\b[^>]*>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const tag = m[0];
            const altMatch = /\balt\s*=\s*(["'])(.*?)\1/i.exec(tag);
            const srcMatch = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
            const alt = altMatch ? altMatch[2].trim() : '';
            const src = srcMatch ? srcMatch[2].trim() : '';
            const at = m.index;
            // The file name is the recognisable part of a CDN URL, so lead with it and keep the
            // full source out of the label — those run to well over a hundred characters.
            const file = (src.split(/[?#]/)[0].split('/').pop() || '').trim();
            out.push({
                label: `Image in an HTML block${file ? ` (${file})` : ''}`,
                name: file || src || 'image',
                hasAlt: alt !== '',
                // Hand-written HTML has nowhere else to keep alt text: what is in the tag is all
                // there is, so a blank one here really is blank.
                altFromCms: false,
                alt,
                linked: linkedRanges.some(([start, end]) => at >= start && at < end),
                hasSource: src !== '',
                src
            });
        }
    }
    return out;
}

/**
 * Every clickable thing paired with the words a recipient reads on it — anchors from raw HTML and
 * button components alike.
 *
 * Separate from `collectLinks`, which deliberately dedupes on URL and throws the text away. The
 * accessibility checks need the opposite: the same URL linked from four different labels is four
 * findings, not one.
 *
 * @param {*} body
 * @returns {Array<{href:string, text:string}>}
 */
export function collectAnchors(body) {
    const out = [];
    const seen = new Set();
    const add = (href, text) => {
        const key = `${text}\u0000${href}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ href, text });
    };

    for (const html of collectHtmlStrings(body)) {
        const re = /<a\b([^>]*)>([\s\S]*?)<\s*\/\s*a\s*>/gi;
        let m;
        while ((m = re.exec(html)) !== null) {
            const hrefM = /\bhref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/i.exec(m[1] || '');
            const href = hrefM ? (hrefM[2] !== undefined ? hrefM[2] : hrefM[3] || '') : '';
            const text = m[2]
                .replace(/<[^>]*>/g, ' ')
                .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            add(href.trim(), text);
        }
    }

    // Button components store their label and destination as sibling fields rather than as markup.
    //
    // Only nodes carrying a `definition` are considered. walkNodes visits a component AND its
    // `attributes` object as two separate nodes, and the attributes object holds the label but not
    // the URL — reading from both would report every button twice, once linked and once not.
    //
    // `attributes.text` is where a real `lightning/actionButton` keeps its label, but the key is far
    // too generic to trust on its own, so it is only read on a node whose definition says button.
    walkNodes(body, (node) => {
        if (typeof node.definition !== 'string') return;
        const attrs = node.attributes || {};
        const isButton = /button|cta/i.test(node.definition);
        const text = [
            attrs.buttonText, node.buttonText,
            isButton ? attrs.text : null, isButton ? node.text : null
        ].find((v) => typeof v === 'string' && v.trim() !== '');
        if (!text) return;
        const href = LINK_FIELDS.map((f) => attrs[f] || node[f]).find(
            (v) => typeof v === 'string' && v.trim() !== ''
        );
        add(href ? String(href).trim() : '', text.trim());
    });

    return out;
}

/**
 * Hostname of a URL, or '' if there isn't one.
 *
 * Merge expressions are stripped first: a link assembled as `{!$domain}/offers` has no literal host
 * and must not be judged as though it did.
 *
 * @param {string} url
 * @returns {string}
 */
function hostOf(url) {
    const literal = String(url || '')
        .replace(/\{\{[\s\S]*?\}\}/g, '')
        .replace(/\{![^}]*\}/g, '')
        .trim();
    const m = /^(?:https?:)?\/\/([^/?#:\s]+)/i.exec(literal);
    return m ? m[1].toLowerCase() : '';
}

/** `#rgb` / `#rrggbb` to [r,g,b], or null for a brand token or anything else we cannot resolve. */
function parseHexColor(value) {
    if (typeof value !== 'string') return null;
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16)
    ];
}

/** WCAG relative luminance. */
function relativeLuminance([r, g, b]) {
    const [rs, gs, bs] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * WCAG contrast ratio between two colours, 1 (identical) to 21 (black on white).
 *
 * Returns null when either colour is a brand token, because the whole point of a token is that its
 * value lives in brand setup rather than in the content — we cannot resolve it, and guessing would
 * mean reporting contrast failures against a colour nobody chose.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number|null}
 */
export function contrastRatio(a, b) {
    const ca = parseHexColor(a);
    const cb = parseHexColor(b);
    if (!ca || !cb) return null;
    const la = relativeLuminance(ca);
    const lb = relativeLuminance(cb);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The copy a recipient actually reads: text fields with markup, entities and merge tokens removed.
 *
 * Merge tokens are stripped rather than counted because at authoring time we cannot know what they
 * resolve to — `{{FirstName}}` might be 4 characters or 12 — and an email whose only "text" is
 * personalization tokens is still an image-only email as far as a spam filter is concerned.
 *
 * @param {*} body
 * @returns {string}
 */
export function collectVisibleText(body) {
    const parts = [];
    walkNodes(body, (node) => {
        for (const f of TEXT_FIELDS) {
            const v = node[f];
            if (typeof v !== 'string' || v.trim() === '') continue;
            if (/^https?:\/\//i.test(v.trim())) continue;
            const stripped = v
                .replace(/<\s*(script|style)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
                .replace(/<[^>]*>/g, ' ')
                .replace(/\{\{[\s\S]*?\}\}/g, ' ')
                .replace(/\{![^}]*\}/g, ' ')
                .replace(/&(?:nbsp|amp|lt|gt|quot|#\d+);/gi, ' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (stripped) parts.push(stripped);
        }
    });
    return parts.join(' ');
}

/** Every `definition` / `type` string in the tree — the component roster, used by several checks. */
export function collectDefinitions(body) {
    const out = [];
    walkNodes(body, (node) => {
        if (typeof node.definition === 'string') out.push(node.definition);
        if (typeof node.type === 'string') out.push(node.type);
    });
    return out;
}

/**
 * Definitions that mark a node as a POINTER to a separately-stored reusable block rather than
 * content in its own right.
 *
 * `sfdc_cms/reusableContentBlock` and `sfdc_cms__emailFragment` are the two confirmed names — the
 * latter is also the content-type FQN the panel uses to recognise a block opened on its own. The
 * looser alternatives are here because a reference is cheap to over-report (it produces a note
 * saying "go and check this too") and expensive to miss (the email silently ships unchecked
 * content).
 */
/**
 * Definitions that mean "this node points at a separately-stored content item".
 *
 * Deliberately specific. A bare `contentblock` alternative used to be in here and it matched
 * `rootContentBlock` — the canvas container every single email has — so the note fired on every
 * email and pointed at the email itself. A rule whose whole job is to say "there is content here I
 * could not see" is worthless the moment it cries wolf, so the cost of a loose pattern is much
 * higher here than the cost of missing an unknown reference type.
 */
const BLOCK_REFERENCE = /(reusablecontentblock|contentreference|blockreference|fragment)/i;

/** Containers that hold the content rather than reference other content. Never an embedded block. */
const NOT_A_REFERENCE = /root/i;

/**
 * A pointer to another content item, written as `@cms/<ContentKey>`.
 *
 * This is the shape a real embedded block turns out to use, confirmed from an exported body:
 * `attributes.content.definition = "@cms/MCK263AR76UVCFPDIHIXUCFOYMMU"`, with `attributes.content`
 * carrying nothing else but `type: "block"`. There is no sibling `contentKey` field to read, so a
 * resolver that only knew about `contentKey` came away with nothing.
 */
const CMS_POINTER = /^@cms\/([A-Za-z0-9_-]+)$/;

export const ROLE_HEADER = 'header';
export const ROLE_BODY = 'body';
export const ROLE_FOOTER = 'footer';

/**
 * What a reusable block is being used for, which decides which rules make sense for it.
 *
 * A block is not a small email — it is a fragment with a job, and the job determines what "correct"
 * means. A header owes a logo with alt text and a link home; a footer owes the legal furniture; a
 * body block owes neither and would be wrong to be nagged about them. Without this the panel had
 * only two settings, email or not-email, and not-email meant the compliance rules never ran at all —
 * so the one place an unsubscribe link could actually be verified was the one place nobody looked.
 *
 * Roles are additive and multi-select on purpose: plenty of real blocks are a body and a footer in
 * one, and forcing that author to pick the closer of two wrong answers gets the wrong rules either
 * way. Choosing nothing is also allowed and simply leaves the general block rules running.
 */
export const BLOCK_ROLES = [
    {
        id: ROLE_HEADER,
        label: 'Header',
        hint: 'Logo, nav, preheader strip — the part above the content'
    },
    {
        id: ROLE_BODY,
        label: 'Body / content',
        hint: 'Copy, images, buttons — the part that changes per campaign'
    },
    {
        id: ROLE_FOOTER,
        label: 'Footer',
        hint: 'Unsubscribe, preference centre, postal address, social links'
    }
];

/** Where a block reference is observed to keep its content key, in order of specificity. */
export function contentKeyOf(node) {
    const holders = [node, node.attributes, node.ref, node.source && node.source.ref];
    for (const h of holders) {
        if (h && typeof h === 'object' && typeof h.contentKey === 'string' && h.contentKey.trim() !== '') {
            return h.contentKey.trim();
        }
    }
    const inner = node.attributes && node.attributes.content;
    const pointer =
        inner && typeof inner.definition === 'string' ? CMS_POINTER.exec(inner.definition.trim()) : null;
    return pointer ? pointer[1] : '';
}

/**
 * Reusable blocks this content embeds by reference.
 *
 * These are the tool's blind spot made visible. A block is a separate content item and its body is
 * NOT inlined into the email — the node holds a `contentKey` that only a server-side callout can
 * resolve — so every rule here runs on an email with holes in it. Naming the holes, and where they
 * are, turns "some findings may be wrong" into something a reviewer can act on.
 *
 * The key is carried alongside the label because it is the only durable identifier a block has: the
 * export folder for a content item is named after it, so it is what someone would search for.
 *
 * @param {*} body
 * @returns {Array<{label:string, contentKey:string}>}
 */
export function collectEmbeddedBlocks(body) {
    const out = [];
    const described = describeComponents(body);
    walkNodes(body, (node) => {
        if (!isBlockReference(node)) return;
        const place = described.get(node);
        out.push({
            label: place ? place.label : 'Embedded block',
            contentKey: contentKeyOf(node),
            name: blockNameOf(node)
        });
    });
    return out;
}

/** Fields a name could plausibly live under, most specific first. */
const NAME_KEYS = ['sfdc_cms:title', 'title', 'masterLabel', 'label', 'displayName', 'name'];

/**
 * A human name for an embedded block, if the reference happens to carry one.
 *
 * Usually it does not. Every real reference observed so far holds nothing but a `@cms/<key>` pointer
 * and a type, because the name lives on the content item at the other end and resolving it needs a
 * server call. So this checks the places a name could reasonably sit and returns empty rather than
 * inventing one — the caller falls back to the content key, which is at least searchable. Written
 * speculatively on purpose: if a future release starts including the title, the banner picks it up
 * with no further work.
 *
 * @param {object} node
 * @returns {string} the name, or '' when the reference does not carry one
 */
export function blockNameOf(node) {
    const holders = [node, node.attributes, node.attributes && node.attributes.content, node.ref];
    for (const holder of holders) {
        if (!holder || typeof holder !== 'object') continue;
        for (const key of NAME_KEYS) {
            const value = holder[key];
            // Guard against a `name` that is really an internal identifier: a key or a UUID is not a
            // name, and printing one as though it were would be worse than printing nothing.
            if (typeof value === 'string' && value.trim() !== '' && !looksLikeAnIdentifier(value)) {
                return value.trim();
            }
        }
    }
    return '';
}

const CONTENT_KEY_SHAPE = /^MC[A-Z0-9]{20,}$/i;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function looksLikeAnIdentifier(value) {
    const v = value.trim();
    return CONTENT_KEY_SHAPE.test(v) || UUID_SHAPE.test(v) || /^@cms\//i.test(v);
}

/**
 * Data providers attached to the content, from `lightning:dataProviders[]`.
 *
 * These decide whether personalization can resolve at all, and per the implementation guide a
 * Product Recommendation block additionally requires a Data Graph provider on the same profile DG or
 * it fails validation at render time.
 *
 * @param {*} body
 * @returns {Array<{definition:string, dataGraph:string, expressionKey:string}>}
 */
export function collectDataProviders(body) {
    const out = [];
    const seen = new Set();
    walkNodes(body, (node) => {
        const list = node['lightning:dataProviders'];
        if (!Array.isArray(list)) return;
        for (const p of list) {
            if (!p || typeof p !== 'object' || seen.has(p)) continue;
            seen.add(p);
            const attrs = p.attributes || {};
            out.push({
                definition: typeof p.definition === 'string' ? p.definition : '',
                dataGraph: typeof attrs.dataGraphApiName === 'string' ? attrs.dataGraphApiName : '',
                expressionKey: typeof p.sfdcExpressionKey === 'string' ? p.sfdcExpressionKey : ''
            });
        }
    });
    return out;
}

/**
 * Sections and columns with a background image actually set.
 *
 * Styling keys (`position`, `repeat`, `size`) are present on every section whether or not an image
 * was chosen, so presence of `lightning:backgroundImage` proves nothing — a source key must be there
 * too. Deduped on object identity because the value is reachable from both the component node and
 * its attributes node.
 *
 * @param {*} body
 * @returns {string[]} labels of components carrying a background image
 */
export function collectBackgroundImages(body) {
    const out = [];
    const seenBg = new Set();
    const described = describeComponents(body);
    walkNodes(body, (node) => {
        const attrs = node.attributes || {};
        const bg = attrs['lightning:backgroundImage'] || node['lightning:backgroundImage'];
        if (!bg || typeof bg !== 'object' || seenBg.has(bg)) return;
        seenBg.add(bg);
        const hasSource = BACKGROUND_SOURCE_KEYS.some((k) => {
            const v = bg[k];
            if (v === undefined || v === null) return false;
            return typeof v === 'string' ? v.trim() !== '' : true;
        });
        if (!hasSource) return;
        const place = described.get(node);
        out.push(place ? place.label : friendlyType(node.definition));
    });
    return out;
}

/**
 * Read a spacing value, which the builder stores in one of TWO shapes on the same key:
 *
 *   "lightning:padding": "{!$brand.spacing.none}"                    ← brand token
 *   "lightning:padding": { top: {unit:"px", value:32}, left: {...} } ← explicit per-side
 *
 * Which one you get depends on whether the author accepted the brand default or overrode it, so
 * both appear in the same email. Returning a tagged shape rather than normalising to numbers keeps
 * that distinction, which is itself worth reporting (RND007).
 *
 * @param {*} value
 * @returns {{token:string}|{sides:object}|null}
 */
export function readSpacing(value) {
    if (typeof value === 'string') return value.trim() ? { token: value.trim() } : null;
    if (!value || typeof value !== 'object') return null;
    const sides = {};
    for (const side of ['top', 'right', 'bottom', 'left']) {
        const s = value[side];
        if (s && typeof s === 'object' && typeof s.value === 'number') {
            sides[side] = { value: s.value, unit: typeof s.unit === 'string' ? s.unit : '' };
        }
    }
    return Object.keys(sides).length ? { sides } : null;
}

/**
 * The style layer: spacing, colour and typography per component.
 *
 * Deduped on the `attributes` object because walkNodes visits both the component node and its
 * attributes node, and only the component node knows the definition name used for reporting.
 *
 * @param {*} body
 * @returns {Array<object>}
 */
export function collectLayoutNodes(body) {
    const out = [];
    const seen = new Set();
    const described = describeComponents(body);
    walkNodes(body, (node) => {
        const attrs = node.attributes;
        if (!attrs || typeof attrs !== 'object' || seen.has(attrs)) return;
        seen.add(attrs);
        const asObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null);
        const place = described.get(node);
        out.push({
            label: place ? place.label : friendlyType(node.definition),
            // The position WITHOUT the copy hint. Rules that group several components under one
            // value need the short form, or a single finding runs to several hundred characters.
            place: place ? `${place.place}${place.where}` : friendlyType(node.definition),
            type: place ? place.type : friendlyType(node.definition),
            padding: readSpacing(attrs['lightning:padding']),
            margin: readSpacing(attrs['lightning:margin']),
            colors: asObject(attrs['lightning:colorGroup']),
            typography: asObject(attrs['lightning:typography']),
            imageWidth: asObject((asObject(attrs.imageFitConfig) || {}).width)
        });
    });
    return out;
}

/**
 * Rows of columns: any node whose children ALL carry a `columnWidth`.
 *
 * Requiring every child to be a column is what stops an ordinary section of mixed content from
 * being measured against the 12-unit grid it was never on.
 *
 * @param {*} body
 * @returns {Array<{label:string, widths:number[], stacksOnMobile:boolean}>}
 */
export function collectColumnGroups(body) {
    const groups = [];
    const described = describeComponents(body);
    walkNodes(body, (node) => {
        if (!Array.isArray(node.children) || node.children.length === 0) return;
        const children = node.children.filter((c) => c && typeof c === 'object');
        if (children.length !== node.children.length) return;
        const widths = children
            .map((c) => (c.attributes || {}).columnWidth)
            .filter((w) => typeof w === 'number');
        if (widths.length !== children.length) return;
        const attrs = node.attributes || {};
        const place = described.get(node);
        groups.push({
            label: place ? place.label : friendlyType(node.definition),
            widths,
            stacksOnMobile: attrs.stackOnMobile !== false
        });
    });
    return groups;
}

/**
 * A compact outline of the content body: every distinct key PATH, its value type, and a short
 * sample. Diagnostics only — nothing in the checks consumes this.
 *
 * WHY IT EXISTS: every rule in this engine encodes an assumption about where the editor stores a
 * given piece of data (which key holds a button's URL, where alt text lives, ...). Those shapes vary
 * by component and are not publicly documented. When a rule misfires, this outline is what turns
 * "guess again" into a definitive fix, without asking anyone to hand over the whole content body.
 *
 * @param {*} body
 * @param {number} [maxPaths]
 * @param {number} [maxSamples]  distinct values printed per path
 * @returns {string}
 */
export function describeShape(body, maxPaths = 300, maxSamples = 4) {
    // Distinct values per path, not just the first one seen. An email is mostly repetition — a dozen
    // sections, each with the same key paths — so keeping one sample hides exactly the outlier you
    // are looking for. `children[].definition` showing "lightning/section" tells you nothing; showing
    // section, image, button AND the one unfamiliar definition is the whole point.
    const DISTINCT_CAP = 50; // per path, so one free-text field cannot swamp the output
    const paths = new Map();

    (function step(node, path) {
        if (Array.isArray(node)) return node.forEach((n) => step(n, `${path}[]`));
        if (node && typeof node === 'object') {
            for (const k of Object.keys(node)) step(node[k], path ? `${path}.${k}` : k);
            return undefined;
        }
        const type = node === null ? 'null' : typeof node;
        const sample = type === 'string' ? `"${String(node).slice(0, 60)}"` : String(node);
        let entry = paths.get(path);
        if (!entry) {
            entry = { types: new Set(), samples: new Set(), count: 0, capped: false };
            paths.set(path, entry);
        }
        entry.types.add(type);
        entry.count += 1;
        if (entry.samples.size < DISTINCT_CAP) entry.samples.add(sample);
        else if (!entry.samples.has(sample)) entry.capped = true;
        return undefined;
    })(body, '');

    const lines = [];
    for (const [path, entry] of paths) {
        const all = Array.from(entry.samples);
        const shownSamples = all.slice(0, maxSamples);
        const hidden = all.length - shownSamples.length;
        const more = hidden > 0 ? `  (+${hidden}${entry.capped ? '+' : ''} other value(s))` : '';
        const times = entry.count > 1 ? ` x${entry.count}` : '';
        lines.push(`${path}  <${Array.from(entry.types).join('|')}>${times}  ${shownSamples.join('  |  ')}${more}`);
    }

    lines.sort();
    const shown = lines.slice(0, maxPaths);
    if (lines.length > shown.length) shown.push(`...and ${lines.length - shown.length} more paths`);
    return shown.join('\n');
}

// ---------------------------------------------------------------------------
// Handlebars scanning
// ---------------------------------------------------------------------------

/** Classify the inside of a `{{...}}` token. */
function classifyToken(inner) {
    const t = inner.trim();
    if (t === '') return 'empty';
    if (t.startsWith('!')) return 'comment';
    if (t.startsWith('#')) return 'open';
    if (t.startsWith('/')) return 'close';
    if (t === '^') return 'else';
    if (t.startsWith('^')) return 'open'; // inverted section — still opens a block
    if (t === 'else') return 'else';
    if (t.startsWith('>')) return 'partial';
    return 'expr';
}

/**
 * Tokenize the Handlebars expressions in a string.
 *
 * Hand-rolled rather than regex-driven so a triple-stash (`{{{raw}}}`) closes on `}}}` and an
 * UNTERMINATED `{{` is reported rather than silently swallowed — an unterminated open is exactly
 * the "Failed to render due to syntax errors" case we are trying to catch, so it must not be lost.
 *
 * @param {string} str
 * @returns {Array<{raw:string, inner:string, index:number, kind:string}>}
 */
export function scanHandlebars(str) {
    const out = [];
    if (typeof str !== 'string') return out;
    let i = 0;
    while (i < str.length) {
        const start = str.indexOf('{{', i);
        if (start === -1) break;
        const triple = str[start + 2] === '{';
        const openLen = triple ? 3 : 2;
        const closeTok = triple ? '}}}' : '}}';
        const end = str.indexOf(closeTok, start + openLen);
        if (end === -1) {
            out.push({
                raw: str.slice(start, start + 40),
                inner: str.slice(start + openLen),
                index: start,
                kind: 'unterminated'
            });
            break;
        }
        const inner = str.slice(start + openLen, end);
        out.push({
            raw: str.slice(start, end + closeTok.length),
            inner,
            index: start,
            kind: classifyToken(inner)
        });
        i = end + closeTok.length;
    }
    return out;
}

/** Helper name for an open/close token, e.g. `{{#if cond}}` → "if". */
function blockName(token) {
    const t = token.inner.trim();
    if (token.kind === 'open') return t.replace(/^[#^]/, '').trim().split(/\s+/)[0];
    return t.replace(/^\//, '').trim().split(/\s+/)[0];
}

/**
 * Block-balance check over ONE string. Handlebars blocks cannot span two separate content nodes,
 * so balance is evaluated per string — checking the whole tree as one concatenated corpus would
 * produce nonsense pairings between unrelated components.
 *
 * @param {string} str
 * @returns {Array<{type:'unclosed'|'unexpected-close'|'mismatch', name:string, raw:string}>}
 */
export function findBlockImbalances(str) {
    const problems = [];
    const stack = [];
    for (const token of scanHandlebars(str)) {
        if (token.kind === 'open') {
            stack.push({ name: blockName(token), raw: token.raw });
        } else if (token.kind === 'close') {
            const name = blockName(token);
            if (stack.length === 0) {
                problems.push({ type: 'unexpected-close', name, raw: token.raw });
            } else {
                const top = stack.pop();
                if (top.name !== name) {
                    problems.push({ type: 'mismatch', name: `${top.name} closed by ${name}`, raw: token.raw });
                }
            }
        }
    }
    for (const open of stack) {
        problems.push({ type: 'unclosed', name: open.name, raw: open.raw });
    }
    return problems;
}

/**
 * Deepest block-helper nesting in one string. Unbalanced input is tolerated — this is a complexity
 * measure, not a validity check; HB001–HB003 own correctness.
 *
 * @param {string} str
 * @returns {number}
 */
export function maxBlockDepth(str) {
    let depth = 0;
    let deepest = 0;
    for (const token of scanHandlebars(str)) {
        if (token.kind === 'open') {
            depth += 1;
            if (depth > deepest) deepest = depth;
        } else if (token.kind === 'close') {
            depth = Math.max(0, depth - 1);
        }
    }
    return deepest;
}

/** Names defined locally via `{{set "name" ...}}` — these resolve without any flow involvement. */
export function collectSetVariableNames(strings) {
    const names = new Set();
    for (const s of strings) {
        const re = /\{\{\s*set\s+"([^"]+)"/g;
        let m;
        while ((m = re.exec(s)) !== null) names.add(m[1]);
    }
    return names;
}

/**
 * Bare single-token expressions like `{{firstName}}` — no dot path, no helper call, no arguments.
 * These do NOT come from a data provider (those are dotted, e.g. `{{DataGraph.Individual.FirstName}}`);
 * they are Content Variables, which must be supplied by the Flow's Send Email step, or inherited
 * from a parent email's `{{set}}`.
 *
 * @param {string[]} strings
 * @returns {string[]} distinct token names
 */
export function collectBareVariables(strings) {
    const names = new Set();
    for (const s of strings) {
        for (const token of scanHandlebars(s)) {
            if (token.kind !== 'expr') continue;
            const t = token.inner.trim();
            if (t.includes(' ') || t.includes('.') || t.includes('(') || t.includes('[')) continue;
            if (t.startsWith('@') || t.startsWith('$') || t.startsWith('&')) continue;
            if (KNOWN_HELPERS.has(t)) continue;
            if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(t)) continue;
            names.add(t);
        }
    }
    return Array.from(names);
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

/** Build a finding. `locations` is truncated here so every consumer gets a bounded list. */
function finding(rule, severity, title, detail, locations = []) {
    const shown = locations.slice(0, MAX_LOCATIONS).map(String);
    return {
        rule,
        severity,
        title,
        detail,
        locations: shown,
        truncated: Math.max(0, locations.length - shown.length)
    };
}

// ---------------------------------------------------------------------------
// Checks — each takes the gathered context and returns findings
// ---------------------------------------------------------------------------

/** HB — scripting syntax that would fail at render time. */
export function checkHandlebars(ctx) {
    const found = [];
    const unclosed = [];
    const unexpected = [];
    const mismatched = [];
    const unterminated = [];
    const empties = [];

    for (const { text: s, place } of located(ctx)) {
        for (const p of findBlockImbalances(s)) {
            if (p.type === 'unclosed') unclosed.push(at(`${p.raw} (never closed)`, place));
            else if (p.type === 'unexpected-close') unexpected.push(at(p.raw, place));
            else mismatched.push(at(`${p.raw} — ${p.name}`, place));
        }
        for (const token of scanHandlebars(s)) {
            if (token.kind === 'unterminated') unterminated.push(at(token.raw, place));
            if (token.kind === 'empty') empties.push(at(token.raw, place));
        }
    }

    if (unclosed.length) {
        found.push(finding('HB001', SEVERITY.ERROR, 'A code block was never closed',
            'You opened a block like {{#if}} or {{#each}} but never closed it. The send fails with a ' +
            'syntax error and nobody receives the email. Add the matching {{/if}} or {{/each}}.',
            unclosed));
    }
    if (unexpected.length) {
        found.push(finding('HB002', SEVERITY.ERROR, 'A closing tag with nothing to close',
            'There is a closing tag like {{/if}} with no matching opening tag before it. Either delete ' +
            'it or add the opening tag it belongs to.', unexpected));
    }
    if (mismatched.length) {
        found.push(finding('HB003', SEVERITY.ERROR, 'Opening and closing tags do not match',
            'A block was opened with one helper and closed with a different one, for example {{#if}} ' +
            'closed by {{/each}}. Make the pair match.', mismatched));
    }
    if (unterminated.length) {
        found.push(finding('HB004', SEVERITY.ERROR, 'Missing closing }}',
            'Something starts with {{ but never closes. Either the raw text shows up in the delivered ' +
            'email or the send fails.', unterminated));
    }
    if (empties.length) {
        found.push(finding('HB005', SEVERITY.WARNING, 'Empty {{ }} in the content',
            'There is a {{ }} with nothing inside it. Usually left behind while editing. Delete it.',
            empties));
    }

    // `fallback` takes the value AND what to show when the value is missing. Written with one
    // argument it is not a syntax error — it just silently stops being a fallback, which is worse:
    // the author believes they are covered and the gap only appears in the delivered email.
    const halfFallbacks = [];
    for (const { text: str, place } of located(ctx)) {
        for (const token of scanHandlebars(str)) {
            if (token.kind !== 'expr') continue;
            const parts = token.inner.trim().split(/\s+/);
            if (!/^(fallback|default)$/i.test(parts[0])) continue;
            if (parts.length < 3) halfFallbacks.push(at(token.raw, place));
        }
    }
    if (halfFallbacks.length) {
        found.push(finding('HB006', SEVERITY.ERROR, 'Backup value is missing its backup',
            'The fallback helper needs two things: the detail you want, and what to show when that ' +
            'detail is missing. These only have the first, so people with no value on file still get ' +
            'a blank. Write it as {{fallback FirstName "there"}} — use "" if you want nothing shown.',
            halfFallbacks));
    }
    return found;
}

/**
 * CMP — compliance. The highest-value check in the tool, and the one whose scope limit matters most:
 * an unsubscribe link living in an embedded reusable block is invisible from here.
 */
export function checkCompliance(ctx) {
    const found = [];
    // A block is never sent on its own, so by default it owes no unsubscribe link — asking a header
    // block for a postal address is how a tool teaches people to ignore it. But a FOOTER block is
    // precisely where all three of these belong, and the tool cannot see into it from the email that
    // embeds it. So when the author says "this is a footer", these become the most useful checks in
    // the panel rather than the least: this is the one place they can be run at all.
    const isFooter = (ctx.roles || []).includes(ROLE_FOOTER);
    if (!ctx.isEmail && !isFooter) return found;

    const corpus = ctx.strings.join('\n');
    const anchorText = (ctx.anchors || []).map((a) => a.text || '').join('\n');
    const urls = (ctx.links || []).join('\n');

    // Three ways an opt-out can be expressed, and the check used to recognise only the first. An
    // ordinary `<a href="https://site.com/unsubscribe">Unsubscribe</a>` is a perfectly valid opt-out
    // and plenty of orgs use their own page rather than the builder's token — so the rule fired on
    // compliant emails, as a warning, saying the one thing that would most alarm a reviewer. A legal
    // check that is wrong about a legal requirement gets ignored, and then it is worse than absent.
    // Any merge token carrying the word, not only `$link.optout`. Orgs route opt-outs through custom
    // content variables and their own tokens, and requiring the builder's exact one meant the check
    // called those emails non-compliant.
    const hasUnsub =
        /\{[!{#][^{}]*(optout|unsubscribe)/i.test(corpus) ||
        /(unsubscribe|opt[-_]?out)/i.test(urls) ||
        /\b(unsubscribe|opt out|opt-out)\b/i.test(anchorText);

    const hasPrefCentre =
        /\{[!{#][^{}]*(preference)/i.test(corpus) ||
        /(preference|subscription|email[-_]?settings)/i.test(urls) ||
        /\b(preferences?|subscription settings|which emails)\b/i.test(anchorText);

    // Wording shifts with what is open. Told "your unsubscribe link might be in a block we cannot
    // see" while looking AT the footer block, a reader would rightly wonder what the tool thinks it
    // is reading. Checking the footer directly is also the one case where the answer is certain, so
    // it gets the caveat removed rather than repeated.
    const here = isFooter ? 'this footer block' : 'this email';
    const caveat = isFooter
        ? 'You are checking the footer block itself, so this one is definite — there is nowhere else ' +
          'for it to be hiding.'
        : 'Important: this tool only looks at the content you have open. If it sits in a shared footer ' +
          'block or a template, we cannot see it and you can ignore this.';

    if (!hasUnsub) {
        // The builder records whether this is promotional or transactional. Transactional mail does
        // not owe an opt-out link, so warning about it there is noise — the check still runs, but as
        // a note, because a purpose set wrongly is itself worth noticing.
        const purpose = findValueByKeys(ctx.body, PURPOSE_KEYS).value.toLowerCase();
        const transactional = purpose === 'transactional';
        found.push(finding('CMP001',
            transactional ? SEVERITY.INFO : SEVERITY.WARNING,
            'No unsubscribe link found',
            `We could not find an unsubscribe link in ${here}. ` +
            (transactional
                ? 'This email is marked as transactional, and those do not need one — so this only matters ' +
                  'if the setting is wrong and this is really a marketing email. '
                : 'Marketing emails are legally required to have one. ') +
            caveat));
    }
    if (!hasPrefCentre) {
        found.push(finding('CMP002', SEVERITY.WARNING, 'No preference center link found',
            'There is nowhere here for someone to choose fewer emails instead of none. Without that ' +
            'option the only way out is to unsubscribe completely, so you lose people who would have ' +
            'stayed on a lighter schedule — and every unsubscribe counts against your sender ' +
            `reputation. ${caveat}`));
    }

    // The other half of CAN-SPAM, and the half nobody remembers. Matched against the visible copy
    // rather than the whole corpus so a street name inside a URL does not count as an address.
    const copy = ctx.visibleText || '';
    // Merge fields are matched against the raw corpus, not the visible copy: `visibleText` is what a
    // recipient reads, and a token that has not been resolved yet is not that.
    const hasPostal =
        POSTAL_ADDRESS.some((re) => re.test(copy)) || hasAddressMergeField(corpus);
    if (!hasPostal) {
        found.push(finding('CMP003', SEVERITY.WARNING, 'No postal address found',
            'Marketing emails are legally required to show a real postal address, usually in the ' +
            `footer next to the unsubscribe link. We could not find anything address-shaped in ${here}, ` +
            'and no merge field that looks like it fills one in — an address pulled from Company ' +
            'Information with {!$organization.Address} counts and is recognised. Addresses outside ' +
            `the US may not be. ${caveat}`));
    }
    return found;
}

/** LNK — destinations that are broken, unfinished or insecure. */
export function checkLinks(ctx) {
    const found = [];
    const placeholders = [];
    const insecure = [];

    // Reported first because it is the most common authoring slip: a button dropped onto the canvas
    // and never given a URL. It renders as a normal, inviting button and does nothing when clicked.
    const linkless = ctx.linklessNodes || [];
    if (linkless.length) {
        found.push(finding('LNK004', SEVERITY.ERROR, 'Button with no link',
            'These buttons have no web address set. They look completely normal in the email and nothing ' +
            'happens when someone clicks them. Add a link, or delete the button if you do not need it.',
            linkless));
    }

    for (const url of ctx.links) {
        const u = url.trim();
        if (PLACEHOLDER_HREFS.has(u) || PLACEHOLDER_PATTERNS.some((re) => re.test(u))) {
            placeholders.push(u === '' ? '(empty href)' : u);
            continue;
        }
        if (/^http:\/\//i.test(u)) insecure.push(u);
    }

    if (placeholders.length) {
        found.push(finding('LNK001', SEVERITY.ERROR, 'Link that goes nowhere',
            'These are placeholders rather than real web addresses. Anyone who clicks them ends up ' +
            'nowhere. Replace them with the address you actually want people to visit.', placeholders));
    }
    if (insecure.length) {
        found.push(finding('LNK002', SEVERITY.WARNING, 'Link uses http:// instead of https://',
            'Some email apps and browsers block these or show a security warning before opening them. ' +
            'Change them to https:// if the site supports it.', insecure));
    }

    // Both checks below run against the URL with merge fields and Handlebars removed. Those
    // expressions legitimately contain spaces (`{! $link.X }`) and can contain punctuation, and
    // judging them as if they were literal URL text produces false positives on correct links.
    const literal = (u) => u.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\{![^}]*\}/g, '');

    // Two query strings concatenated — what you get by appending tracking parameters to a URL that
    // already had some. A second "?" is technically legal inside a query VALUE, so this is only
    // reported when what follows it looks like parameters (`name=`), and only as a warning.
    const malformed = ctx.links.filter((u) => {
        const parts = literal(u).split('?');
        return parts.length > 2 && /^[A-Za-z0-9_.%-]+=/.test(parts[2]);
    });
    if (malformed.length) {
        found.push(finding('LNK005', SEVERITY.WARNING, 'Link has two question marks',
            'A web address should only have one "?". Everything after a second one gets swallowed up and ' +
            'never reaches the website, so any tracking you added there quietly does nothing. Join the ' +
            'extra parts with "&" instead. Ignore this if the "?" really is part of the address.',
            malformed));
    }

    // Whitespace almost always comes from a copy/paste that wrapped across lines. Clients differ on
    // whether they encode it, truncate the href at the space, or drop the link entirely.
    const whitespace = ctx.links.filter((u) => /\s/.test(literal(u)));
    if (whitespace.length) {
        found.push(finding('LNK006', SEVERITY.ERROR, 'Link contains a space',
            'There is a space or a line break inside this web address, usually from copying and pasting. ' +
            'Some email apps cut the link off at the space and it stops working. Remove it, or write it ' +
            'as %20. The space is shown as ␣ below.',
            whitespace.map((u) => u.replace(/\s+/g, '␣'))));
    }

    // A link nobody outside the office can open. Worth an error rather than a warning: unlike most
    // findings here this one cannot be repaired after the fact, and the recipient sees a hard failure.
    const nonProd = ctx.links.filter((u) => {
        const host = hostOf(u);
        return host !== '' && NON_PRODUCTION_HOST.some((re) => re.test(host));
    });
    if (nonProd.length) {
        found.push(finding('LNK007', SEVERITY.ERROR, 'Link points at a test site',
            'These links go to a staging, test or local address rather than your live site. Anyone ' +
            'outside your network gets an error page. Swap them for the real addresses before you send.',
            nonProd));
    }

    // "#section" jumps work on a web page and almost nowhere in email: Gmail rewrites the ids these
    // rely on, and most webmail renders inside a container the jump cannot reach.
    const anchors = ctx.links.filter((u) => /^#\S/.test(u.trim()));
    if (anchors.length) {
        found.push(finding('LNK008', SEVERITY.WARNING, 'Jump-to-section link',
            'This kind of link jumps to another part of the same page. It works on a website but not ' +
            'in most email apps, where it either does nothing or closes the email. Link to a web page ' +
            'instead.', anchors));
    }

    // An email with nowhere to go is usually a half-finished one. Restricted to emails that have
    // real copy, so a blank canvas does not get told off for being blank.
    if (ctx.isEmail && ctx.links.length === 0 && (ctx.visibleText || '').length > MIN_LIVE_TEXT) {
        found.push(finding('LNK009', SEVERITY.INFO, 'No links anywhere in this email',
            'There is nothing for a recipient to click, and no unsubscribe link either. That is right ' +
            'for a few kinds of email and a mistake in most. Check whether your buttons live in a ' +
            'shared block this tool cannot see.'));
    }
    return found;
}

/** IMG — whether an image carries a description, a picture, and a destination. */
export function checkImages(ctx) {
    const found = [];
    // Images whose alt text is kept on the CMS asset are excluded here and reported separately. We
    // genuinely do not know whether they have alt text — asserting they do not would be a guess, and
    // one that happens to accuse people who set it up the recommended way.
    const missing = ctx.images.filter((i) => !i.hasAlt && !i.altFromCms);
    if (missing.length) {
        const linkedCount = missing.filter((i) => i.linked).length;
        const linkedNote = linkedCount
            ? `, and ${linkedCount === 1 ? '1 of those is a link' : `${linkedCount} of those are links`}`
            : '';
        found.push(finding('IMG001', SEVERITY.WARNING, 'Image with no alt text',
            `${missing.length} image(s) have no alt text${linkedNote}. ` +
            'Alt text is the short description read aloud by screen readers, and the text people see when ' +
            'their email app blocks images — which many do by default. If an image is purely decorative, ' +
            'leaving it empty is the right thing to do and you can ignore this.',
            missing.map((i) => i.label)));
    }

    const fromCms = ctx.images.filter((i) => i.altFromCms);
    if (fromCms.length) {
        found.push(finding('IMG006', SEVERITY.INFO, 'Alt text is set on the image, not in the email',
            `${fromCms.length} image(s) here are using the description stored on the image itself in ` +
            'CMS, rather than one typed into this email. That is the normal way to do it, and usually ' +
            'means the alt text is fine — but the image is a separate item, so we cannot see it from ' +
            'here to confirm. If you want to check, open the image in CMS and look at its alt text, ' +
            'or tick "override" on the image in this email to type one in and have it checked here.',
            fromCms.map((i) => i.label)));
    }

    // An image component that was placed and then never given a picture. Everything about it looks
    // configured — the sizing, the alignment, the alt text — so it reads as finished in the builder
    // and arrives as a broken-image box.
    const sourceless = ctx.images
        .filter((i) => i.hasSource === false)
        .map((i) => i.label);
    if (sourceless.length) {
        found.push(finding('IMG004', SEVERITY.ERROR, 'Image with no picture in it',
            'These image slots have no picture attached, so recipients get an empty box with a broken ' +
            'image icon. Pick an image, or delete the slot.', sourceless));
    }

    // Linking the logo to the homepage is close to universal, and an unlinked one is almost always
    // an oversight rather than a decision — it is the single most repeated finding on manual QA.
    const noLink = ctx.images.filter((i) => !i.linked);
    // Tested against the ASSET name, not the display label. The label now says where the image sits
    // ("Image in Section 1 of 6"), and matching a logo against that would be matching against the
    // wrong string entirely.
    const isLogo = (i) => LOGO_HINT.test(i.alt || '') || LOGO_HINT.test(i.name || '');
    const unlinkedLogos = noLink.filter(isLogo).map((i) => i.label);
    if (unlinkedLogos.length) {
        found.push(finding('IMG003', SEVERITY.INFO, 'Logo does not link anywhere',
            'People expect to be able to click a logo to reach your homepage, and it is usually the ' +
            'first thing they try. Ignore this if the logo is deliberately not a link.', unlinkedLogos));
    }

    // The general case behind IMG003. A note, and it can never be more than that: the engine cannot
    // tell a decorative image from one that was meant to be clickable, so all it can honestly do is
    // put the list in front of the person who knows. Logos are excluded because IMG003 has already
    // named them, with advice this rule cannot give.
    const unlinked = noLink.filter((i) => !isLogo(i)).map((i) => i.label);
    if (unlinked.length) {
        found.push(finding('IMG005', SEVERITY.INFO, 'Image has no link',
            'Nothing happens when someone clicks these. That is right for a decorative image and ' +
            'wrong for a product shot, a banner, or anything that looks like a button — people try ' +
            'clicking those whether or not you linked them. Worth checking whether each one needs a ' +
            'link or is fine as it is.', unlinked));
    }

    // Image-only emails are a long-standing spam signal, and they are blank for the large share of
    // recipients whose client blocks images by default — which is exactly when alt text and live
    // copy are the only thing standing between them and an empty message.
    const textLen = (ctx.visibleText || '').length;
    if (ctx.isEmail && ctx.images.length > 0 && textLen < MIN_LIVE_TEXT) {
        found.push(finding('IMG002', SEVERITY.WARNING, 'Almost all images, hardly any text',
            `This email has ${ctx.images.length} image(s) but only ${textLen} characters of actual text. ` +
            'Lots of people have images turned off by default and would open this to a nearly blank ' +
            'message. Spam filters are also suspicious of emails that are mostly image. Add some real ' +
            'text, or check whether your words live in a shared block that this tool cannot see.'));
    }
    return found;
}

/** CNT — the basics that stop a send or wreck the inbox preview. */
export function checkContentBasics(ctx) {
    const found = [];

    if (ctx.isEmail) {
        // Blank and missing are the same finding on purpose. The builder DELETES the key when you
        // clear the field, so to the person in the editor both are just "I removed it" — reporting
        // one as an error and the other as a note would look arbitrary from where they are sitting.
        if (findValueByKeys(ctx.body, SUBJECT_KEYS).value === '') {
            found.push(finding('CNT001', SEVERITY.ERROR, 'No subject line',
                'This email has no subject line. Add one before you send.'));
        }
        const preheader = findValueByKeys(ctx.body, PREHEADER_KEYS).value;
        if (preheader === '') {
            found.push(finding('CNT003', SEVERITY.WARNING, 'No preheader',
                'The preheader is the short line of text shown next to your subject in most inboxes. ' +
                'Leave it empty and email apps fill the space with the opening words of your email ' +
                'instead, which is usually something like "View in browser".'));
        } else if (preheader.length > PREHEADER_MAX_RECOMMENDED) {
            found.push(finding('CNT006', SEVERITY.INFO, 'Preheader is longer than the inbox will show',
                `Your preheader is ${preheader.length} characters and inboxes show roughly the first ` +
                `${PREHEADER_MAX_RECOMMENDED}. The rest is not wasted exactly, but nobody reads it, so ` +
                'put the part that earns the open at the front.'));
        } else if (preheader.length < PREHEADER_MIN_RECOMMENDED) {
            found.push(finding('CNT007', SEVERITY.INFO, 'Preheader is short enough to let other text through',
                `Your preheader is ${preheader.length} characters. The inbox gives you roughly ` +
                `${PREHEADER_MAX_RECOMMENDED}, and when your preheader runs out it keeps going into the ` +
                'email body to fill the space — so people see your line followed by "View in browser" ' +
                `or an image description. Somewhere around ${PREHEADER_MIN_RECOMMENDED} to ` +
                `${PREHEADER_MAX_RECOMMENDED} characters uses up the space.`));
        }
    }

    if (typeof ctx.title === 'string' && ctx.title.length > EMAIL_NAME_MAX) {
        found.push(finding('CNT004', SEVERITY.ERROR, 'Email name is too long',
            `Email names can be up to ${EMAIL_NAME_MAX} characters. This one is ${ctx.title.length}.`));
    }

    // Deduped on the kind of unsafe markup, not on kind-and-place: there are only a handful of kinds
    // and the advice for each is identical wherever it sits, so naming the first place it appears is
    // enough to start from without turning one problem into a list.
    const unsafe = [];
    const unsafeKinds = new Set();
    for (const { text: html, place } of located(ctx)) {
        for (const rule of UNSAFE_HTML) {
            if (!rule.re.test(html) || unsafeKinds.has(rule.what)) continue;
            unsafeKinds.add(rule.what);
            unsafe.push(at(rule.what, place));
        }
    }
    if (unsafe.length) {
        found.push(finding('CNT005', SEVERITY.WARNING, 'Code that email apps will remove',
            'Email apps strip this kind of code out for security reasons, so whatever it was meant to do ' +
            'will not happen. Having it in there can also push your email towards the spam folder. Put it ' +
            'on a web page and link to that instead.', unsafe));
    }
    return found;
}

/**
 * SUB — the subject line is the single highest-leverage string in the email and the one place where
 * a failed merge field is most visible: "Hi , your order" lands in the inbox preview.
 */
export function checkSubjectQuality(ctx) {
    const found = [];
    if (!ctx.isEmail) return found;

    const subject = findValueByKeys(ctx.body, SUBJECT_KEYS).value;
    if (!subject) return found; // an empty subject is CNT001's job, not ours

    // The preheader is a second headline, and repeating the subject there spends it on nothing. The
    // comparison ignores case and trailing punctuation so a copy-paste with a full stop added still
    // reads as the duplicate it is.
    const tidy = (s) => s.toLowerCase().replace(/[\s.!?,;:]+$/, '').trim();
    const preheader = findValueByKeys(ctx.body, PREHEADER_KEYS).value;
    if (preheader && tidy(preheader) === tidy(subject)) {
        found.push(finding('SUB005', SEVERITY.WARNING, 'Preheader repeats the subject line',
            'Your preheader says the same thing as your subject, so the inbox shows the same sentence ' +
            'twice and you lose the extra line you had to persuade someone to open it. Use it to add ' +
            'something the subject does not say.', [subject.slice(0, 80)]));
    }

    // A tester's prefix that reaches a real send is the most expensive thing on this list, and the
    // one nobody catches by reading the email — it is in the one line you skim past.
    const marked = [];
    if (TEST_MARKERS.some((re) => re.test(subject))) marked.push(`subject line: "${subject.slice(0, 70)}"`);
    if (preheader && TEST_MARKERS.some((re) => re.test(preheader))) {
        marked.push(`preheader: "${preheader.slice(0, 70)}"`);
    }
    if (marked.length) {
        found.push(finding('SUB006', SEVERITY.ERROR, 'Test wording left in the subject or preheader',
            'This still has a tester\'s note on the front of it, or the template\'s own placeholder ' +
            'wording. It is the first thing every recipient reads and the last thing anyone proofreads. ' +
            'Replace it with the real wording before this goes anywhere.', marked));
    }

    // Two thresholds rather than two rules. The lower one is advice, the upper one is a problem, and
    // a marketer wants the same heading either way.
    if (subject.length > SUBJECT_MAX_RECOMMENDED) {
        found.push(finding('SUB001', SEVERITY.WARNING, 'Subject line is very long',
            `Your subject line is ${subject.length} characters. Most inboxes only show about 40 to 60 and ` +
            'cut off the rest, and phones show even less. Put the part that makes someone open it first.'));
    } else if (subject.length > SUBJECT_IDEAL_MAX) {
        found.push(finding('SUB001', SEVERITY.INFO, 'Subject line will be cut off on phones',
            `Your subject line is ${subject.length} characters. Phones show roughly the first 40 and ` +
            `desktop about ${SUBJECT_IDEAL_MAX}, so the tail end is there for the few who expand it. ` +
            'Nothing is broken — just make sure the first few words can stand on their own.'));
    }

    const tokens = scanHandlebars(subject).filter((t) => t.kind === 'expr');
    const unguarded = tokens.filter((t) => !/\b(fallback|default)\b/.test(t.inner));
    if (unguarded.length) {
        found.push(finding('SUB002', SEVERITY.WARNING, 'Personalization in the subject with no backup',
            'Your subject line pulls in a personal detail, but there is no backup for people whose details ' +
            'are missing. They will see a gap or a stray comma in the most visible line of your email. ' +
            'Add a backup value like {{fallback FirstName "there"}}.',
            unguarded.map((t) => t.raw)));
    }

    if (RISKY_SUBJECT_CHARS.test(subject)) {
        found.push(finding('SUB004', SEVERITY.INFO, 'Trademark or copyright symbol in the subject',
            'The ® ™ and © symbols do not display reliably in every email app. Send yourself a test if ' +
            'the symbol matters here.',
            [subject.slice(0, 80)]));
    }

    if (/[A-Z]{6,}/.test(subject) || /[!?]{2,}/.test(subject) || /\bFREE\b/.test(subject)) {
        found.push(finding('SUB003', SEVERITY.INFO, 'Subject line may trigger spam filters',
            'Long runs of capital letters, repeated exclamation marks and words like FREE all push your ' +
            'email closer to the spam folder. Worth a rethink if this send needs to land.',
            [subject.slice(0, 80)]));
    }
    return found;
}

/**
 * MIG — MCE syntax that survived a migration. This is the gap the whole tool exists for: MCE
 * validated content before send, so these would have been caught there. In MCN they render as
 * literal text in the delivered email.
 */
export function checkMigration(ctx) {
    const found = [];
    const subs = new Set();
    const artifacts = [];

    for (const { text: s, place } of located(ctx)) {
        let m;
        MCE_SUBSTITUTION.lastIndex = 0;
        while ((m = MCE_SUBSTITUTION.exec(s)) !== null) subs.add(at(m[0], place));
        for (const rule of MCE_ARTIFACTS) {
            if (rule.re.test(s) && !artifacts.some((a) => a.startsWith(rule.what))) {
                artifacts.push(at(`${rule.what} — ${s.trim().slice(0, 60)}`, place));
            }
        }
    }

    if (subs.size) {
        found.push(finding('MIG001', SEVERITY.ERROR, 'Old Marketing Cloud code that will not work',
            'This is code from the old Marketing Cloud (ExactTarget). MC Next does not understand it, so ' +
            'it goes out to your recipients as literal text on the page. Replace each one with the MC Next ' +
            'version — for example %%FirstName%% becomes {{fallback FirstName ""}} using your data source.',
            Array.from(subs)));
    }
    if (artifacts.length) {
        found.push(finding('MIG002', SEVERITY.ERROR, 'Links pointing at the old Marketing Cloud',
            'These links point at old Marketing Cloud systems that this email has no connection to. They ' +
            'either break for the recipient or record the click in the wrong place.', artifacts));
    }
    return found;
}

/** A px number if the value is a literal size; null for brand tokens and anything else. */
function literalPx(value) {
    if (typeof value === 'number') return value;
    if (typeof value !== 'string') return null;
    const m = /^(\d+(?:\.\d+)?)\s*px$/i.exec(value.trim());
    return m ? Number(m[1]) : null;
}

/** Horizontal padding, when both sides are set explicitly. */
function horizontalPadding(spacing) {
    if (!spacing || !spacing.sides) return null;
    const { left, right } = spacing.sides;
    if (!left || !right) return null;
    return { left, right };
}

/**
 * RND — layout and rendering. Everything here is derived from the style layer the builder already
 * stores, so it costs nothing to check and is invisible in every other review step: the builder
 * canvas is a desktop-width preview with the brand tokens resolved, which is precisely the one
 * context where none of these problems show up.
 */
export function checkLayout(ctx) {
    const found = [];
    const nodes = ctx.layoutNodes || [];
    const groups = ctx.columnGroups || [];

    // --- structure ---------------------------------------------------------

    const offGrid = groups
        .filter((g) => g.widths.reduce((a, b) => a + b, 0) !== COLUMN_GRID)
        .map((g) => `${g.label}: ${g.widths.join(' + ')} = ${g.widths.reduce((a, b) => a + b, 0)}`);
    if (offGrid.length) {
        found.push(finding('RND001', SEVERITY.ERROR, 'Columns do not add up',
            `Columns sit on a ${COLUMN_GRID}-unit grid, and these rows do not add up to ${COLUMN_GRID}. ` +
            'A row that adds up to less leaves a gap down one side. A row that adds up to more pushes the ' +
            'last column onto its own line. Change the widths so each row totals exactly ' +
            `${COLUMN_GRID}.`, offGrid));
    }

    const noStack = groups.filter((g) => g.widths.length > 1 && !g.stacksOnMobile).map((g) => g.label);
    if (noStack.length) {
        found.push(finding('RND002', SEVERITY.WARNING, 'Columns will not stack on phones',
            'These rows are set not to stack, so the columns stay side by side on a phone screen. Each one ' +
            'ends up only a few centimetres wide, text wraps after a word or two, and images shrink to ' +
            'thumbnails. Turn stacking on unless you meant the row to stay narrow.', noStack));
    }

    // --- spacing -----------------------------------------------------------

    const asymmetric = [];
    const mixedUnits = [];
    for (const n of nodes) {
        for (const [name, spacing] of [['padding', n.padding], ['margin', n.margin]]) {
            const h = horizontalPadding(spacing);
            if (h && h.left.value !== h.right.value) {
                asymmetric.push(`${n.label}: ${name} left ${h.left.value}${h.left.unit}, right ${h.right.value}${h.right.unit}`);
            }
            if (spacing && spacing.sides) {
                const units = new Set(Object.values(spacing.sides).map((s) => s.unit).filter(Boolean));
                if (units.size > 1) {
                    mixedUnits.push(`${n.label}: ${name} mixes ${Array.from(units).join(' and ')}`);
                }
            }
        }
    }
    if (asymmetric.length) {
        found.push(finding('RND003', SEVERITY.WARNING, 'Left and right spacing do not match',
            'The spacing is different on the left and right, so this content sits slightly off-centre ' +
            'compared to everything above and below it. It looks like a mistake even when people cannot ' +
            'say exactly why. Ignore this if you meant to do it.',
            asymmetric));
    }
    if (mixedUnits.length) {
        found.push(finding('RND008', SEVERITY.WARNING, 'Spacing uses two different units in one place',
            'The sides of the same box are measured in different units, so they grow at different rates ' +
            'as the screen size changes and the box goes lopsided. Use the same unit all the way round.',
            mixedUnits));
    }

    // Distinct horizontal padding across sections means their content edges sit at different
    // positions — the "everything is slightly ragged" complaint that is hard to name by eye.
    const sectionPads = [];
    for (const n of nodes) {
        // Matched on the type, not the label: every component inside a section now carries "in
        // Section 3 of 6" in its label, so a substring test would sweep up buttons and paragraphs.
        if (n.type !== 'Section') continue;
        const h = horizontalPadding(n.padding);
        if (h) sectionPads.push({ value: `${h.left.value}${h.left.unit}`, place: n.place });
    }
    if (distinctValues(sectionPads) > 1) {
        found.push(finding('RND004', SEVERITY.INFO, 'Sections use different side spacing',
            'Your sections have different amounts of space on the left and right, so their content will ' +
            'not line up as you scroll down. This is often on purpose — a full-width banner above indented ' +
            'text is a normal design — but worth a look if the email feels untidy.',
            groupByValue(sectionPads)));
    }

    // Padding this large is usually a typo — 300 where 30 was meant — and it reads as an accidental
    // blank screen rather than as spacing, because on a phone it can be taller than the viewport.
    const huge = [];
    for (const n of nodes) {
        for (const which of ['padding', 'margin']) {
            const sides = n[which] && n[which].sides;
            if (!sides) continue;
            for (const side of ['top', 'right', 'bottom', 'left']) {
                const px = sides[side] && sides[side].unit === 'px' ? Number(sides[side].value) : null;
                if (px !== null && px > MAX_REASONABLE_PADDING) {
                    huge.push(`${n.label}: ${which} ${side} ${px}px`);
                }
            }
        }
    }
    if (huge.length) {
        found.push(finding('RND014', SEVERITY.INFO, 'Unusually large gap',
            `These have more than ${MAX_REASONABLE_PADDING}px of empty space on one side, which on a phone ` +
            'can be most of a screen. Sometimes that is the design; often it is an extra digit typed by ' +
            'mistake. Worth a glance in the mobile preview.', huge));
    }

    const usesToken = nodes.some((n) => (n.padding && n.padding.token) || (n.margin && n.margin.token));
    const usesExplicit = nodes.some((n) => (n.padding && n.padding.sides) || (n.margin && n.margin.sides));
    if (usesToken && usesExplicit) {
        found.push(finding('RND007', SEVERITY.INFO, 'Spacing is partly from your brand, partly typed in',
            'Some parts of this email take their spacing from your brand settings, and others have fixed ' +
            'numbers typed in. The fixed ones will not change when your brand does, so this email slowly ' +
            'drifts out of line with the rest of your emails instead of updating with them.'));
    }

    // --- colour ------------------------------------------------------------

    const invisible = [];
    const indistinct = [];
    for (const n of nodes) {
        const c = n.colors;
        if (!c) continue;
        // Comparing tokens works without resolving them: the same token IS the same colour, whatever
        // it evaluates to, so this holds however the brand is configured.
        if (c.textColor && c.backgroundColor && c.textColor === c.backgroundColor) {
            invisible.push(`${n.label}: text and background both ${c.textColor}`);
        }
        if (c.linkColor && c.textColor && c.linkColor === c.textColor) {
            indistinct.push(`${n.label}: links and text both ${c.linkColor}`);
        }
    }
    if (invisible.length) {
        found.push(finding('RND005', SEVERITY.ERROR, 'Text you cannot see',
            'This text is the same color as the background behind it, so nobody can read it. It still ' +
            'takes up space in the email, so the layout will have a gap where it should be. Change either ' +
            'the text color or the background color.', invisible));
    }
    if (indistinct.length) {
        found.push(finding('RND006', SEVERITY.WARNING, 'Links look exactly like normal text',
            'Your links are the same color as the text around them, so people can only find them by ' +
            'accident. Give links a different color, or make sure they are underlined.', indistinct));
    }

    // Only literal colours are compared. Two different brand TOKENS are a deliberate choice, but two
    // different typed-in hex values for the same job is how "the links are blue here and teal there"
    // happens — each block styled on its own day, correct in isolation.
    const linkHexes = nodes
        .filter((n) => n.colors && typeof n.colors.linkColor === 'string' && parseHexColor(n.colors.linkColor))
        .map((n) => ({ value: n.colors.linkColor.trim().toLowerCase(), place: n.place }));
    if (distinctValues(linkHexes) > 1) {
        found.push(finding('RND013', SEVERITY.INFO, 'Links are different colors in different places',
            'This email uses more than one link color, so the same kind of link looks different ' +
            'depending on where it appears. Usually this means one block was styled separately from ' +
            'the rest. Pick one and use it throughout, or better, use your brand\'s link color so it ' +
            'stays right on its own.', groupByValue(linkHexes)));
    }

    // --- typography and images ---------------------------------------------

    const cramped = [];
    const tiny = [];
    for (const n of nodes) {
        const t = n.typography;
        if (!t) continue;
        if (typeof t.lineHeight === 'number' && t.lineHeight < MIN_LINE_HEIGHT) {
            cramped.push(`${n.label}: line height ${t.lineHeight}`);
        }
        const px = literalPx(t.fontSize);
        if (px !== null && px < MIN_FONT_PX) tiny.push(`${n.label}: ${px}px`);
    }
    if (cramped.length) {
        found.push(finding('RND009', SEVERITY.WARNING, 'Lines of text are too close together',
            'The lines are packed tightly enough that they start to run into each other. This is hardest ' +
            'on people reading on a phone, which is most of your list.', cramped));
    }
    if (tiny.length) {
        found.push(finding('RND010', SEVERITY.WARNING, 'Text is too small for phones',
            `Text under ${MIN_FONT_PX}px is hard to read on a phone, and iPhone Mail and Gmail sometimes ` +
            'enlarge it automatically — which makes that one piece of text bigger without moving anything ' +
            'else, so your layout breaks. Only fixed sizes are checked here, not brand settings.', tiny));
    }

    const overflowing = nodes
        .filter((n) => n.imageWidth && n.imageWidth.unit === '%' && Number(n.imageWidth.value) > 100)
        .map((n) => `${n.label}: ${n.imageWidth.value}%`);
    if (overflowing.length) {
        found.push(finding('RND011', SEVERITY.WARNING, 'Image is wider than the space it sits in',
            'This image is set wider than 100%, so it spills out of its column. Some email apps crop it, ' +
            'others stretch the whole email wider than the screen and give people a sideways scrollbar.',
            overflowing));
    }

    // A run of characters with no space in it cannot be broken across lines, so it sets the minimum
    // width of the whole email. Nearly always a URL pasted in as visible text, or an unspaced
    // reference number.
    const unbreakable = ((ctx.visibleText || '').match(/\S+/g) || [])
        .filter((w) => w.length > MAX_UNBROKEN_RUN);
    if (unbreakable.length) {
        found.push(finding('RND012', SEVERITY.WARNING, 'A very long word with no spaces in it',
            'Nothing can break this across two lines, so it sets how wide the email has to be. On a ' +
            'phone that means everything else gets squeezed and people have to scroll sideways to read ' +
            'any of it. Usually a web address pasted in as text — link some ordinary words to it ' +
            'instead of showing the address.',
            unbreakable.map((w) => `${w.slice(0, 50)}${w.length > 50 ? '…' : ''} (${w.length} characters)`)));
    }

    return found;
}

/**
 * OL — Outlook on Windows, which renders through Word and needs VML for anything a background does.
 * The builder strips VML on save, so there is no way to author a fallback from inside MCN. Both
 * findings here exist because the failure is invisible everywhere else: the email looks correct in
 * the builder, in preview, and in every other client.
 */
export function checkOutlookRendering(ctx) {
    const found = [];

    const backgrounds = ctx.backgroundImages || [];
    if (backgrounds.length) {
        found.push(finding('OL001', SEVERITY.WARNING, 'Background image will not show in Outlook',
            'Outlook on Windows cannot display background images the way other email apps do, and the ' +
            'builder removes the special code that would normally work around it. Outlook users see the ' +
            'background color only. Check that any text on top of this image is still readable against ' +
            'that color, and that nothing important is only visible in the image itself.',
            backgrounds));
    }

    const mso = (ctx.strings || []).filter((s) => OUTLOOK_MARKUP.test(s));
    if (mso.length) {
        found.push(finding('MSO001', SEVERITY.WARNING, 'Outlook-only code that gets deleted',
            'This email contains code written specially for Outlook. The builder deletes it when you save, ' +
            'so it is not doing anything. If this email came from the old Marketing Cloud, the Outlook ' +
            'fixes it used to rely on are already gone.',
            mso.map((s) => s.trim().slice(0, 60))));
    }

    // A hand-written <a> dressed up as a button with padding and a background. Every client except
    // Outlook honours it. Outlook ignores the padding on an inline element, so the background shrinks
    // to a tight box around the words and the button looks squashed and off-center.
    const fakeButtons = (ctx.strings || [])
        .filter((s) => /<a\b/i.test(s))
        .filter((s) => {
            const tags = s.match(/<a\b[^>]*>/gi) || [];
            return tags.some(
                (t) => /padding\s*:/i.test(t) && /background(-color)?\s*:/i.test(t)
            );
        })
        .map((s) => (s.match(/<a\b[^>]*>/i) || [''])[0].slice(0, 70));
    if (fakeButtons.length) {
        found.push(finding('OL002', SEVERITY.WARNING, 'Hand-built button may look squashed in Outlook',
            'This is a text link styled to look like a button. Outlook on Windows ignores the spacing ' +
            'around it, so the colored area collapses to fit the words and the button looks cramped ' +
            'next to how it appears everywhere else. Use the builder\'s own button component instead ' +
            'if you can — it already handles Outlook.', fakeButtons));
    }
    return found;
}

/**
 * MCN — quirks of the platform itself, each with a workaround.
 *
 * These are a different species from every other rule here. Everywhere else, a finding means the
 * content is wrong and somebody should change it. These say the content is fine and the platform
 * is not, and the only thing to decide is whether this particular email can live with it.
 *
 * That is why they are all notes and always will be. There is nothing to fix — nobody chose this,
 * and telling somebody in red to stop using the button component would be advice, not a defect.
 * A note says "here is a thing that is known to go wrong, and here is what people do about it",
 * which is the most an automated check can honestly offer about a platform limitation.
 *
 * Add the next one as its own block below. Each should say what goes wrong, where it goes wrong,
 * and what to do instead — a quirk with no workaround is just bad news and does not belong here.
 */
export function checkMcnQuirks(ctx) {
    const found = [];

    const buttons = ctx.buttonComponents || [];
    if (buttons.length) {
        found.push(finding('MCN001', SEVERITY.INFO, 'Button spacing can come out wrong in Outlook',
            'Outlook on Windows draws emails using Word, and it does not reliably apply the spacing ' +
            'set on a button component. The coloured area can end up tight around the words, or the ' +
            'button can sit slightly off-centre. It looks correct in the builder, in preview and in ' +
            'every other inbox, so this is easy to miss until somebody forwards you a screenshot. ' +
            'If the button has to look identical everywhere, the usual workaround is to build it as ' +
            'an image instead and put the link on the image. Otherwise send yourself an Outlook test ' +
            'before this goes out.',
            buttons));
    }

    return found;
}

/**
 * DP — data providers. Personalization that cannot resolve is the single most common cause of the
 * post-send _"Data graph doesn't contain valid personalization information"_ row, and whether a
 * provider is attached at all is visible right here in the body.
 */
export function checkDataProviders(ctx) {
    const found = [];
    const providers = ctx.dataProviders || [];
    const graphs = providers.filter((p) => /datagraph/i.test(p.definition));
    const graphNames = graphs.map((p) => p.dataGraph).filter(Boolean);

    // "Personalized" here means personalization that needs an EXTERNAL source. A variable the content
    // sets itself resolves with no provider attached, and counting it would report a missing Data
    // Graph on every email that uses one.
    const definedLocally = collectSetVariableNames(ctx.strings || []);
    const externalVars = (ctx.bareVariables || []).filter((n) => !definedLocally.has(n));
    const dotted = (ctx.strings || []).some((s) =>
        scanHandlebars(s).some(
            (t) => t.kind === 'expr' && /^[A-Za-z_][A-Za-z0-9_]*\./.test(t.inner.trim())
        )
    );
    const personalized = externalVars.length > 0 || dotted;

    if (personalized && providers.length === 0) {
        found.push(finding('DP001', SEVERITY.ERROR, 'Personalization with no data source',
            'This email pulls in personal details like names, but no data source is connected to it, so ' +
            'there is nothing to pull them from. The send fails with a personalization error. Connect the ' +
            'Data Graph this email is meant to use.'));
    }

    const hasRecommendations = (ctx.definitions || []).some((d) => /recommend/i.test(d));
    if (hasRecommendations && graphNames.length === 0) {
        found.push(finding('DP002', SEVERITY.ERROR, 'Product recommendations with no data source',
            'Product recommendations need a Data Graph connected on the same profile the recommender uses. ' +
            'Without it, the email fails its checks at send time and does not go out at all.'));
    }

    const apex = providers.filter((p) => /apex/i.test(p.definition));
    if (apex.length && ctx.isRcb) {
        found.push(finding('DP003', SEVERITY.WARNING, 'Apex data source inside a reusable block',
            'Apex data providers are known to misbehave inside reusable blocks — content renders ' +
            'inconsistently and deployments can fail. Send yourself a test before relying on this.',
            apex.map((p) => p.definition)));
    }

    if (graphNames.length > 1) {
        found.push(finding('DP004', SEVERITY.INFO, 'More than one data source connected',
            'Worth double-checking that each piece of personalization points at the one you meant. ' +
            'Nothing here is necessarily wrong.', graphNames));
    }
    return found;
}

/**
 * TXT — copy that was never replaced after the template was duplicated.
 *
 * A warning rather than an error: it is embarrassing, not deal-breaking. The send completes and the
 * email renders; it just says the wrong thing. Errors in this tool are reserved for things that
 * break the send or ship visibly broken, and reporting this in red alongside those trains people to
 * discount the red.
 */
export function checkPlaceholderCopy(ctx) {
    const found = [];
    const hits = [];

    // Naming WHERE each hit lives turns the finding from "something is wrong somewhere" into a
    // to-do list. The subject and preheader are the two that matter most and the two a reviewer is
    // least likely to be looking at when they read this panel.
    const subject = findValueByKeys(ctx.body, SUBJECT_KEYS).value;
    const preheader = findValueByKeys(ctx.body, PREHEADER_KEYS).value;

    /**
     * The subject and preheader are named outright rather than by position: they are not on the
     * canvas at all, so "Section 1 of 6" would send someone looking in the wrong place. Shared by
     * both rules below — a placeholder in the subject line has to say so whichever one catches it.
     */
    const whereOf = (raw, place) => {
        const flat = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (subject && flat === String(subject).trim()) return 'subject line';
        if (preheader && flat === String(preheader).trim()) return 'preheader';
        return place;
    };

    for (const { text: s, place } of located(ctx)) {
        // Strip markup BEFORE matching, not just for display: the anchored patterns above have to see
        // the sentence, and `<p>Let's build an email.</p>` is not anchored to anything.
        const text = s
            .replace(/<[^>]*>/g, ' ')
            .replace(/&(?:nbsp|amp|#\d+);/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!text || !PLACEHOLDER_COPY.some((re) => re.test(text))) continue;
        hits.push(`${text.slice(0, 70)} — ${whereOf(s, place) || 'body copy'}`);
    }

    // A different species of unfinished copy: the writer marked where a real detail goes using square
    // brackets, as a note to whoever builds the email. It survives because it reads as deliberate.
    // Only phrases that read as a field name or as an instruction count — [1] and [2] are footnote
    // markers, and [Webinar] or [see below] are ordinary editorial writing.
    //
    // Keyed on placeholder+position rather than on the placeholder alone: the same [Your Company]
    // appearing in three sections is three edits, and collapsing them to one line hides two of them.
    const brackets = new Map();
    for (const { text: s, place } of located(ctx)) {
        const text = s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
        const re = /\[([^\][{}]{2,40})\]/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const inner = m[1].trim();
            if (!isPlaceholderPhrase(inner)) continue;
            const entry = at(`[${inner}]`, whereOf(s, place));
            if (!brackets.has(entry)) brackets.set(entry, true);
        }
    }
    if (brackets.size) {
        found.push(finding('TXT002', SEVERITY.ERROR, 'Square-bracket placeholder in the copy',
            'Copy written as [Provider Name] or [Date] is a note about what should go there — it is not ' +
            'a real merge field and nothing fills it in. It sends exactly as written, square brackets ' +
            'and all. Replace each one with real wording or a proper personalization field.',
            Array.from(brackets.keys())));
    }

    if (hits.length) {
        found.push(finding('TXT001', SEVERITY.WARNING, 'Template text that was never replaced',
            'This is the wording the template came with. It will not stop your email sending and everything ' +
            'renders normally — but your recipients end up reading the template\'s instructions to you. ' +
            'Replace each one below with your own words.',
            hits));
    }
    return found;
}

/**
 * RCB — documented incompatibilities. Per the MC Next Implementation Guide, reusable content blocks
 * do not support repeaters or the Product Recommendation data source, and have known bugs with Apex
 * data providers. These fail quietly, which is what makes them worth flagging.
 */
export function checkRcbCompatibility(ctx) {
    const found = [];
    if (!ctx.isRcb) return found;

    const corpus = (ctx.definitions || collectDefinitions(ctx.body)).join('|').toLowerCase();
    const strings = ctx.strings.join('\n');

    if (/repeater/.test(corpus) || /\{\{\s*#each\b/.test(strings)) {
        found.push(finding('RCB001', SEVERITY.ERROR, 'Repeaters do not work in reusable blocks',
            'Repeaters are not supported inside reusable blocks, so the repeated rows simply will not ' +
            'appear. Move this content into the email itself.'));
    }
    if (/recommend/.test(corpus) || /recommend/i.test(strings)) {
        found.push(finding('RCB002', SEVERITY.ERROR, 'Product recommendations do not work in reusable blocks',
            'Product recommendations are not supported inside reusable blocks. Move this into the email ' +
            'itself.'));
    }
    // Complex Handlebars is reported to break block functionality outright. Nesting depth is the
    // measurable proxy: a single {{#if}} is routine, three levels deep is where reports start.
    const deepest = ctx.strings.reduce((d, s) => Math.max(d, maxBlockDepth(s)), 0);
    if (deepest >= 3) {
        found.push(finding('RCB004', SEVERITY.WARNING, 'Complicated code inside a reusable block',
            `You have code blocks nested ${deepest} levels deep here. Complicated code is known to break ` +
            'reusable blocks. If this block starts behaving oddly, simplifying the logic or moving it into ' +
            'the email itself is the first thing to try.'));
    }
    return found;
}

/**
 * DG — dynamic content only evaluates against a Unified Individual-based Data Graph. On an
 * Individual-based graph or a non-unified Activation provider the variations are skipped silently
 * and the default content ships, which is very hard to spot in review.
 */
export function checkDynamicContent(ctx) {
    const found = [];
    let hasVariations = false;
    walkNodes(ctx.body, (node) => {
        if (Array.isArray(node.variations) && node.variations.length > 0) hasVariations = true;
        if (typeof node.definition === 'string' && /variation|dynamic/i.test(node.definition)) {
            hasVariations = true;
        }
    });
    if (hasVariations) {
        const graphs = (ctx.dataProviders || []).map((p) => p.dataGraph).filter(Boolean);
        found.push(finding('DG001', SEVERITY.WARNING, 'Dynamic content only works on some data sources',
            'Dynamic content variations only work when the email uses a Data Graph built on the Unified ' +
            'Individual. On any other kind, the variations are skipped and everyone gets the default ' +
            'version — with no error, and it still looks right in preview, so this is very easy to miss. ' +
            'Check that the data source below is the right kind, or build the same logic with {{#if}} ' +
            'code, which always works.',
            graphs.length ? graphs : ['no data source connected to this email']));
    }
    return found;
}

/** VAR — bare tokens that nothing in this content defines. */
export function checkVariables(ctx) {
    const found = [];
    const defined = collectSetVariableNames(ctx.strings);
    const bare = ctx.bareVariables || collectBareVariables(ctx.strings);

    // A name that matches a defined one apart from its capitals is not "undefined" in any useful
    // sense — it is a typo, and we can say so with certainty. Splitting it out of VAR001 matters
    // because VAR001's advice ("check it is wired up at send time") is wrong for this case: there is
    // nothing to wire up, the two names just need to match.
    const definedByLower = new Map();
    for (const name of defined) definedByLower.set(name.toLowerCase(), name);
    const miscased = [];
    const undefinedVars = [];
    for (const name of bare) {
        if (defined.has(name)) continue;
        const match = definedByLower.get(name.toLowerCase());
        if (match) miscased.push(`{{${name}}} — this email sets {{${match}}}`);
        else undefinedVars.push(name);
    }

    if (miscased.length) {
        found.push(finding('VAR004', SEVERITY.ERROR, 'Capital letters do not match',
            'These names are spelled the same as one this email sets but with different capital ' +
            'letters, and capitals have to match exactly. As written they come out blank. Change one ' +
            'side so the two match.', miscased));
    }

    if (undefinedVars.length) {
        found.push(finding('VAR001', SEVERITY.WARNING, 'Nothing in this email fills these in',
            'These come out blank unless something supplies them when you send — a Content Variable on the ' +
            "flow's Send Email step, or a {{set}} in the email that includes this block. Check each one is " +
            'actually connected, because a typo here just leaves an empty space in the delivered email and ' +
            'nothing warns you. Also worth knowing: Email Preview strips formatting out of personalized ' +
            'content even when the real send is fine, so test these with an actual send rather than the ' +
            'preview pane.',
            undefinedVars));
    }

    // Referenced-anywhere test runs against a corpus with the `{{set}}` expressions REMOVED, because
    // the declaration itself contains the name and would otherwise count as a use.
    const withoutSets = ctx.strings.join('\n').replace(/\{\{\s*set\s+"[^"]*"[\s\S]*?\}\}/g, ' ');
    const unused = Array.from(defined).filter((n) => !withoutSets.includes(n));
    if (unused.length) {
        found.push(finding('VAR002', SEVERITY.INFO, 'Set up but never used',
            'These are set up and then never used anywhere in this email. Harmless, and usually left over ' +
            'from a rename or a deleted section. Occasionally it means the place you meant to use it has ' +
            'a spelling mistake.',
            unused));
    }

    const setCounts = {};
    for (const s of ctx.strings) {
        const re = /\{\{\s*set\s+"([^"]+)"/g;
        let m;
        while ((m = re.exec(s)) !== null) setCounts[m[1]] = (setCounts[m[1]] || 0) + 1;
    }
    const dupes = Object.keys(setCounts).filter((n) => setCounts[n] > 1);
    if (dupes.length) {
        found.push(finding('VAR003', SEVERITY.INFO, 'Set more than once',
            'Whichever one runs last wins. That is fine if they sit in different {{#if}} branches. If they ' +
            'do not, one of them does nothing and you may not end up with the value you expect.',
            dupes.map((n) => `${n} (set ${setCounts[n]} times)`)));
    }
    return found;
}

/** AMP — AMPscript is MCE syntax; in MCN it only applies in specific places. */
export function checkAmpscript(ctx) {
    const found = [];
    const hits = ctx.strings.filter((s) => /%%\[|%%=/.test(s));
    if (hits.length) {
        found.push(finding('AMP001', SEVERITY.INFO, 'AMPscript found',
            'AMPscript is code from the old Marketing Cloud. It still works in MC Next for a couple of ' +
            'specific things (Marketing Object lookups and Smart Blocks), so this is not necessarily ' +
            'wrong. But if this email was brought over from the old Marketing Cloud, it probably needs ' +
            'converting.',
            hits.map((s) => s.trim().slice(0, 60))));
    }
    return found;
}

/**
 * SIZ — how big the message is.
 *
 * Gmail truncates anything over ~102 KB and puts the remainder behind a "View entire message" link
 * placed BELOW the footer. Everything past the cut — including the unsubscribe link — is effectively
 * not in the email, and open tracking breaks for the clipped portion too.
 */
export function checkSize(ctx) {
    const found = [];

    const kb = Math.round((ctx.sizeBytes || 0) / 1024);
    if (kb >= SIZE_WARN_KB) {
        found.push(finding('SIZ001', SEVERITY.WARNING, 'This email may get cut off in Gmail',
            `We measure roughly ${kb} KB of content here. Gmail cuts a message off at about ` +
            `${GMAIL_CLIP_KB} KB and hides the rest behind a "View entire message" link that most ` +
            'people never click — and your unsubscribe link is below the cut. This is an estimate and ' +
            'the finished email is usually a little larger than what we can measure, so treat it as ' +
            '"getting close" rather than an exact number. Shortening the copy or splitting long ' +
            'emails in two is the usual fix.'));
    }

    // A pasted-in base64 image can be several hundred KB on its own, and Outlook and Gmail both
    // refuse to display them, so it is pure weight for no picture.
    const embedded = (ctx.images || [])
        .filter((i) => /^data:image\//i.test(i.src || ''))
        .map((i) => `${(i.src || '').slice(0, 30)}... (${Math.round((i.src || '').length / 1024)} KB)`);
    if (embedded.length) {
        found.push(finding('SIZ002', SEVERITY.ERROR, 'Image is pasted into the email itself',
            'These images are embedded in the email rather than linked from a server. Gmail and Outlook ' +
            'both refuse to show them, so recipients get a broken image icon — and they add a lot of ' +
            'weight, which pushes you towards the cut-off above. Upload them to the CMS and insert ' +
            'them normally.', embedded));
    }
    return found;
}

/**
 * A11 — the parts of accessibility that are visible in the content body.
 *
 * Worth having beyond the moral argument: everything here also improves the email for people whose
 * client blocks images, who are reading in sunlight, or who are skimming on a phone — which is most
 * of the list.
 */
export function checkAccessibility(ctx) {
    const found = [];
    const anchors = ctx.anchors || [];

    const vague = anchors
        .filter((a) => a.text && VAGUE_LINK_TEXT.some((re) => re.test(a.text)))
        .map((a) => `"${a.text}"${a.href ? ` → ${a.href.slice(0, 40)}` : ''}`);
    if (vague.length) {
        found.push(finding('A11001', SEVERITY.WARNING, 'Link text that does not say where it goes',
            'Screen readers can read out a list of every link in an email on its own, with no ' +
            'surrounding sentence. "Click here" four times is a useless list. Sighted people skimming ' +
            'on a phone get the same problem. Say what is on the other side instead — "See the spring ' +
            'range".', vague));
    }

    // A file name is not a description of anything. It is also the least likely alt text to have
    // been written on purpose, which is what separates this from an image that is deliberately
    // decorative and correctly left empty.
    const filenameAlt = (ctx.images || [])
        .filter((i) => i.hasAlt && typeof i.alt === 'string')
        .filter((i) => NON_DESCRIPTIVE_ALT.some((re) => re.test(i.alt)))
        .map((i) => at(`"${i.alt}"`, i.label));
    if (filenameAlt.length) {
        found.push(finding('A11002', SEVERITY.WARNING, 'Alt text is a file name, not a description',
            'The alt text here is the file name or the id rather than a description of the picture. ' +
            'Someone using a screen reader hears the file name read out letter by letter, and anyone ' +
            'whose email app blocks images sees it on the page. Describe what is in the picture ' +
            'instead.', filenameAlt));
    }

    // Only computable where both colours are written as hex. A brand token could be anything, and
    // inventing a value to test against would produce failures against a colour nobody chose.
    const lowContrast = [];
    for (const n of ctx.layoutNodes || []) {
        const c = n.colors;
        if (!c) continue;
        const ratio = contrastRatio(c.textColor, c.backgroundColor);
        if (ratio !== null && ratio < MIN_CONTRAST && ratio > 1.05) {
            lowContrast.push(`${n.label}: ${c.textColor} on ${c.backgroundColor} (${ratio.toFixed(1)}:1)`);
        }
    }
    if (lowContrast.length) {
        found.push(finding('A11003', SEVERITY.WARNING, 'Text is too faint against its background',
            `The accepted minimum is ${MIN_CONTRAST}:1 and these are below it, so the text is hard work ` +
            'for anyone with less than perfect eyesight and close to unreadable on a phone outdoors. ' +
            'Darken the text or lighten the background. Only colors written as hex codes are checked ' +
            'here — anything coming from your brand settings is left alone.', lowContrast));
    }

    const barelyMarkedTables = (ctx.strings || []).filter(
        (s) => /<\s*table\b/i.test(s) && !/role\s*=\s*["']?presentation/i.test(s)
    );
    if (barelyMarkedTables.length) {
        found.push(finding('A11004', SEVERITY.INFO, 'Layout table not marked as decoration',
            'Emails use tables to arrange things on the page, but a screen reader assumes a table holds ' +
            'data and announces it as "table, 3 columns, 4 rows" before reading any of it. Adding ' +
            'role="presentation" to the tag tells it to skip straight to the content. Only applies to ' +
            'HTML you wrote yourself — tables the builder generates are already handled.',
            [`${barelyMarkedTables.length} block(s) of hand-written HTML containing a table`]));
    }

    const shouting = (ctx.visibleText || '').match(/\b[A-Z][A-Z\s]{18,}[A-Z]\b/g) || [];
    if (shouting.length) {
        found.push(finding('A11005', SEVERITY.INFO, 'A long run of capital letters',
            'Some screen readers read long capitalised text out one letter at a time, and everyone else ' +
            'finds it slower to read because the word shapes disappear. Capitals also nudge up your ' +
            'spam score. Fine for a short label, worth rewriting for a whole sentence.',
            shouting.map((s) => s.trim().slice(0, 50))));
    }

    return found;
}

/**
 * CSS — modern layout techniques that a browser handles and an email client does not.
 *
 * Only reaches content with hand-authored HTML in it: everything the builder generates is already
 * table-based. That makes this check quiet on ordinary emails and loud on exactly the ones — pasted
 * from a web page, or migrated — where it matters.
 */
export function checkEmailCss(ctx) {
    const found = [];
    const corpus = (ctx.strings || []).join('\n');

    const unsupported = UNSUPPORTED_CSS.filter((r) => r.re.test(corpus)).map((r) => r.what);
    if (unsupported.length) {
        found.push(finding('CSS001', SEVERITY.ERROR, 'Layout code email apps do not understand',
            'This is the way websites are laid out, and email apps — Outlook especially — do not ' +
            'support it. It does not degrade gracefully: the pieces fall back to stacking one under ' +
            'the other wherever they happen to be, so the layout collapses rather than just looking a ' +
            'bit different. Email layouts have to be built from tables.', unsupported));
    }

    if (WEB_FONT.test(corpus)) {
        found.push(finding('CSS002', SEVERITY.WARNING, 'Font that has to be downloaded',
            'This email loads a font from the internet. Outlook on Windows never does that and Gmail ' +
            'blocks the request, so a large share of your recipients see a substitute font instead — ' +
            'usually Times New Roman, which will not look like your brand. Make sure the fallback font ' +
            'is one you are happy to be seen in.'));
    }

    if (/<\s*link\b[^>]*stylesheet/i.test(corpus)) {
        found.push(finding('CSS004', SEVERITY.WARNING, 'Styles kept in a separate file',
            'This email links out to a stylesheet. Email apps remove that link, so none of those styles ' +
            'arrive and the email renders unstyled. Styles have to be written directly onto each ' +
            'element in an email.'));
    }

    // A single font name with nothing after it. Only flagged for fonts that are not installed
    // everywhere by default — "font-family: Arial" needs no fallback in practice, and saying it does
    // would put a finding on almost every email.
    const safeFonts = /^(arial|helvetica|verdana|georgia|tahoma|trebuchet ms|times new roman|courier new|sans-serif|serif|monospace|system-ui)$/i;
    const lonely = new Set();
    // Stops at the end of the declaration OR the end of the attribute, so `style="font-family: X"`
    // yields "X" rather than "X">rest of the markup". Braces are excluded so a brand token, whose
    // value we cannot resolve, produces no candidate at all.
    const famRe = /font-family\s*:\s*([^;{}<>]+)/gi;
    let fm;
    while ((fm = famRe.exec(corpus)) !== null) {
        const stack = fm[1].trim();
        if (stack.includes(',')) continue; // already has a fallback named after it
        const name = stack.replace(/["']/g, '').trim();
        if (name && !safeFonts.test(name)) lonely.add(name);
    }
    if (lonely.size) {
        found.push(finding('CSS003', SEVERITY.INFO, 'Font with no backup named',
            'If someone does not have this font, the email falls back to whatever the app picks — ' +
            'usually Times New Roman, and the spacing shifts with it. Name a backup after it, like ' +
            '"Brandon Grotesque, Arial, sans-serif".', Array.from(lonely)));
    }

    return found;
}

/**
 * DRK — dark mode.
 *
 * Roughly a third of people read email in a dark theme, and Outlook and Gmail both rewrite colours
 * to get there. They rewrite what you DID set and leave what you did not, so a half-specified colour
 * pair that looks right in the builder can end up white on white on a phone at night.
 */
export function checkDarkMode(ctx) {
    const found = [];
    const halfSet = [];
    const extremes = [];

    for (const n of ctx.layoutNodes || []) {
        const c = n.colors;
        if (!c) continue;
        const bg = typeof c.backgroundColor === 'string' ? c.backgroundColor.trim() : '';
        const fg = typeof c.textColor === 'string' ? c.textColor.trim() : '';

        // A LITERAL background only. Every button in the builder carries a brand token here whether
        // or not anyone chose a colour, so accepting tokens would put this finding on every email
        // that contains a button — and a brand colour is managed centrally anyway, which is the
        // opposite of the hand-pinned value this rule is about.
        if (parseHexColor(bg) && !fg) {
            halfSet.push(`${n.label}: background ${bg}, text color not set`);
        }

        // The bounds have to leave #FAFAFA and #111111 alone, since those are what the finding
        // recommends switching TO — a rule that flags its own advice is worse than no rule.
        for (const [what, value] of [['text', fg], ['background', bg]]) {
            const rgb = parseHexColor(value);
            if (!rgb) continue;
            if (rgb.every((v) => v >= 252)) extremes.push(`${n.label}: ${what} pure white (${value})`);
            if (rgb.every((v) => v <= 3)) extremes.push(`${n.label}: ${what} pure black (${value})`);
        }
    }

    if (halfSet.length) {
        found.push(finding('DRK001', SEVERITY.WARNING, 'Background color set but text color left alone',
            'In dark mode, email apps change the colors you did not set and keep the ones you did. ' +
            'Here the background is fixed and the text is not, so the app is free to turn your dark ' +
            'text light and leave it on your light background — which is white on white. Set both ' +
            'colors together, or neither.', halfSet));
    }
    if (extremes.length) {
        found.push(finding('DRK002', SEVERITY.INFO, 'Pure black or pure white',
            'These are the colors dark mode changes most aggressively, because they are the ones it ' +
            'assumes were never chosen deliberately. Nudging them slightly — #111111 rather than ' +
            '#000000, #FAFAFA rather than #FFFFFF — usually survives the conversion intact.',
            Array.from(new Set(extremes))));
    }
    return found;
}

// ---------------------------------------------------------------------------
// Component tree
// ---------------------------------------------------------------------------

/** Is this node a pointer to a separately-stored block, rather than content in its own right? */
function isBlockReference(node) {
    return [node.definition, node.type].some(
        (v) => typeof v === 'string' && BLOCK_REFERENCE.test(v) && !NOT_A_REFERENCE.test(v)
    );
}

/**
 * The top row of the structure — sections and embedded blocks, in the order the editor shows them.
 *
 * Descent stops at the first section or block reference. Going deeper would mirror the builder's own
 * tree, and in a sidebar this narrow a full mirror is unreadable: a real email is six sections, a
 * dozen columns and forty components, and the thing a reader wants is "which part of my email is the
 * problem in", which the top row answers on one screen.
 */
function topLevelItems(body) {
    const out = [];
    (function step(node) {
        if (Array.isArray(node)) {
            node.forEach(step);
            return;
        }
        if (!node || typeof node !== 'object') return;
        if (isBlockReference(node)) {
            out.push({ node, kind: 'block' });
            return;
        }
        if (typeof node.definition === 'string' && /section/i.test(node.definition)) {
            out.push({ node, kind: 'section' });
            return;
        }
        for (const key of Object.keys(node)) {
            if (key === 'attributes' || key.startsWith('lightning:')) continue;
            step(node[key]);
        }
    })(body);
    return out;
}

const EMPTY_COUNTS = () => ({ error: 0, warning: 0, info: 0, total: 0 });

/**
 * A section-by-section map of where the findings are.
 *
 * The findings list answers "what is wrong" and sorts by severity, which is right for triage and
 * wrong for repair — nobody fixes an email by severity, they open a section and fix everything in
 * it. This answers the other question: which part of the email to open.
 *
 * Findings are matched to a section by looking for that section's position string inside their
 * locations. That works because every location the engine produces is built by describeOne, which
 * either IS a section (`Section 3 of 6 — "Spring sale"`) or names the one it sits in (`Image 1 of 9
 * in Section 3 of 6`). Matching on the rendered string rather than on node identity keeps this
 * independent of the twenty-odd collectors that build findings, none of which would otherwise agree
 * on how to report a position.
 *
 * A finding that names several sections — sections disagreeing on padding is the common one — counts
 * against each of them, because each is somewhere you might go to fix it. So the row counts can add
 * up to more than the total, and the panel says so rather than pretending otherwise.
 *
 * @param {*} body     the content body
 * @param {Array} findings  as produced by runPreflight
 * @returns {Array<{key:string, kind:'section'|'block'|'global', label:string, place:string,
 *                  counts:object, worst:string, contentKey:string, name:string}>}
 */
export function buildComponentTree(body, findings = []) {
    const described = describeComponents(body);
    const items = topLevelItems(body);

    const rows = items.map((item, i) => {
        const d = described.get(item.node);
        return {
            key: `${item.kind}-${i}`,
            kind: item.kind,
            label: d ? d.label : item.kind === 'block' ? 'Embedded block' : 'Section',
            place: d ? d.place : '',
            counts: EMPTY_COUNTS(),
            worst: '',
            contentKey: item.kind === 'block' ? contentKeyOf(item.node) : '',
            name: item.kind === 'block' ? blockNameOf(item.node) : ''
        };
    });

    // Anything not placed in a section: no subject line, no unsubscribe link, the email is too big.
    // These are properties of the whole item and would be wrong to pin on a section.
    const global = {
        key: 'global',
        kind: 'global',
        label: '',
        place: '',
        counts: EMPTY_COUNTS(),
        worst: '',
        contentKey: '',
        name: ''
    };

    const sections = rows.filter((r) => r.kind === 'section' && r.place);
    for (const f of findings) {
        const locations = f.locations || [];
        const hit = sections.filter((r) => locations.some((l) => String(l).includes(r.place)));
        for (const row of hit.length ? hit : [global]) {
            row.counts[f.severity] += 1;
            row.counts.total += 1;
        }
    }

    for (const row of rows.concat([global])) {
        row.worst = row.counts.error > 0
            ? SEVERITY.ERROR
            : row.counts.warning > 0
              ? SEVERITY.WARNING
              : row.counts.info > 0
                ? SEVERITY.INFO
                : '';
    }

    // The global row is appended rather than sorted in, because it is not a place in the email and
    // listing it among things that are would imply it can be opened.
    return rows.concat(global.counts.total > 0 ? [global] : []);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/** Every check, in report order. Exported so tests can assert the roster hasn't silently shrunk. */
/**
 * Say which reusable blocks were skipped, and where they sit.
 *
 * A note rather than a warning: embedding a block is normal and correct. What is worth stating is
 * that everything inside it — links, images, the unsubscribe footer, the postal address — went
 * unchecked, which is also why a "no unsubscribe link" warning on an email like this is usually the
 * tool's blind spot rather than a real problem.
 */
export function checkEmbeddedBlocks(ctx) {
    const blocks = ctx.embeddedBlocks || collectEmbeddedBlocks(ctx.body);
    if (blocks.length === 0) return [];

    const n = blocks.length;
    const one = n === 1;
    // The content key is the only durable name a block has, so print it when the reference carries
    // one — it is what identifies the item to open next.
    const where = blocks.map((b) => (b.contentKey ? `${b.label} — ${b.contentKey}` : b.label));
    return [
        finding(
            'BLK001',
            SEVERITY.INFO,
            one ? 'A reusable block here was not checked' : `${n} reusable blocks here were not checked`,
            `This ${ctx.isRcb ? 'block' : 'email'} pulls in ${one ? 'a reusable block that is' : `${n} reusable blocks that are`} ` +
                `stored separately, so nothing inside ${one ? 'it' : 'them'} was checked — not the links, images, ` +
                'unsubscribe link or postal address. Open each one and run this tool on it as well. Two things ' +
                `follow from this: any compliance warning above may simply be content living in ${one ? 'this block' : 'these blocks'}, ` +
                'and the size figure is lower than the real email will be.',
            where
        )
    ];
}

export const CHECKS = [
    checkHandlebars,
    checkContentBasics,
    checkSubjectQuality,
    checkCompliance,
    checkLinks,
    checkImages,
    checkAccessibility,
    checkLayout,
    checkDarkMode,
    checkEmailCss,
    checkOutlookRendering,
    checkMcnQuirks,
    checkSize,
    checkRcbCompatibility,
    checkDataProviders,
    checkDynamicContent,
    checkVariables,
    checkMigration,
    checkPlaceholderCopy,
    checkAmpscript,
    checkEmbeddedBlocks,
    checkBlockRole
];

/**
 * BLK — what the chosen block role did and did not switch on.
 *
 * A checking tool has to be legible about its own scope, because a reader cannot tell "checked and
 * clean" from "never checked" by looking at an empty list. That distinction matters most exactly
 * here: the compliance rules are off by default for a block, so a footer with no unsubscribe link
 * reports nothing at all until somebody ticks Footer. Saying so out loud is the difference between a
 * quiet pass and a silent gap.
 */
export function checkBlockRole(ctx) {
    if (!ctx.isRcb) return [];
    const roles = (ctx.roles || []).filter((r) => BLOCK_ROLES.some((b) => b.id === r));

    if (roles.length === 0) {
        return [
            finding('BLK002', SEVERITY.INFO, 'Tell the panel what this block is',
                'Nobody has said whether this is a header, a body block or a footer, so only the ' +
                'checks that apply to any block have run. The unsubscribe, preference centre and ' +
                'postal address checks are switched off — asking a header block for a postal address ' +
                'would be nonsense. If this is the block that carries them, tick Footer above and ' +
                're-check: this is the only place those can be verified at all, because from inside ' +
                'an email the tool cannot see in here.')
        ];
    }

    const labels = roles.map((r) => BLOCK_ROLES.find((b) => b.id === r).label.toLowerCase());
    const named = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} and ${labels.slice(-1)}`;
    const footer = roles.includes(ROLE_FOOTER);

    return [
        finding('BLK003', SEVERITY.INFO, `Checked as a ${named} block`,
            `Rules were scoped to a ${named} block. ` +
            (footer
                ? 'That switched the unsubscribe, preference centre and postal address checks on, and ' +
                  'they are definite here in a way they never are from inside an email. '
                : 'The unsubscribe, preference centre and postal address checks stayed off, since they ' +
                  'belong to a footer. Tick Footer as well if this block carries any of them. ') +
            'Subject line, preheader and subject-quality checks are never run on a block — those ' +
            'belong to the email that includes it.')
    ];
}

/**
 * Run every check against a content item.
 *
 * @param {{title?:string, contentBody:object}} content  as returned by experience/cmsEditorApi getContent
 * @param {{contentType?:'email'|'rcb', blockRoles?:string[]}} [options]
 * @returns {{findings:Array, counts:{error:number,warning:number,info:number,total:number},
 *           stats:{links:number,images:number,expressions:number}, checksRun:number,
 *           embeddedBlocks:Array<{label:string, contentKey:string, name:string}>}}
 */
export function runPreflight(content, options = {}) {
    const body = (content && content.contentBody) || {};
    const strings = collectStrings(body);
    const ctx = {
        body,
        title: (content && content.title) || '',
        strings,
        locatedStrings: collectLocatedStrings(body),
        links: collectLinks(body),
        linklessNodes: collectLinklessNodes(body),
        buttonComponents: collectButtonComponents(body),
        anchors: collectAnchors(body),
        images: collectImages(body),
        visibleText: collectVisibleText(body),
        // A proxy for the size of the built email, not the real thing — the body JSON carries the
        // same copy and the same style values that become inline CSS, but not the table scaffolding
        // wrapped around them. It runs low, which is why SIZE_WARN_KB sits well under Gmail's limit.
        sizeBytes: JSON.stringify(body || {}).length,
        definitions: collectDefinitions(body),
        embeddedBlocks: collectEmbeddedBlocks(body),
        layoutNodes: collectLayoutNodes(body),
        columnGroups: collectColumnGroups(body),
        dataProviders: collectDataProviders(body),
        backgroundImages: collectBackgroundImages(body),
        bareVariables: collectBareVariables(strings),
        isEmail: options.contentType !== 'rcb',
        isRcb: options.contentType === 'rcb',
        roles: Array.isArray(options.blockRoles) ? options.blockRoles : []
    };

    const findings = [];
    for (const check of CHECKS) {
        findings.push(...check(ctx));
    }
    findings.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);

    /*
     * A stable identity per finding, so the panel can remember one the reviewer chose to ignore.
     *
     * The rule ID alone, where a rule fires once — which is nearly always, since checks aggregate
     * their locations into a single finding. That makes the id human-meaningful and, more usefully,
     * stable across a re-check: somebody who ignores CMP002, fixes an unrelated error and re-runs
     * should not have CMP002 come back. A position-based id would break exactly then, which is the
     * moment the memory is worth having. The `#n` suffix only appears if a rule ever fires twice.
     */
    const seen = new Map();
    for (const f of findings) {
        const n = (seen.get(f.rule) || 0) + 1;
        seen.set(f.rule, n);
        f.id = n === 1 ? f.rule : `${f.rule}#${n}`;
    }

    const counts = { error: 0, warning: 0, info: 0, total: findings.length };
    for (const f of findings) counts[f.severity]++;

    return {
        findings,
        counts,
        checksRun: CHECKS.length,
        // Surfaced next to the findings, not only inside BLK001, so the panel can pin the "there is
        // content in here we did not read" message above the results rather than leaving it to sort
        // to the bottom of a long list as the note it is.
        embeddedBlocks: ctx.embeddedBlocks,
        shape: describeShape(body),
        stats: {
            links: ctx.links.length,
            images: ctx.images.length,
            expressions: strings.reduce((n, s) => n + scanHandlebars(s).length, 0),
            textChars: ctx.visibleText.length,
            sizeKb: Math.round(ctx.sizeBytes / 1024)
        }
    };
}

/**
 * Flatten a result into plain text, so a marketer can paste the report into a ticket or a Slack
 * thread without screenshotting the panel.
 *
 * @param {object} result  output of runPreflight
 * @param {string} [label] content name, for the header line
 * @returns {string}
 */
export function buildTextReport(result, label = '') {
    const lines = [];
    lines.push(`Email Preflight${label ? ` — ${label}` : ''}`);
    lines.push(
        `${result.counts.error} error(s), ${result.counts.warning} warning(s), ${result.counts.info} note(s) ` +
        `across ${result.checksRun} checks.`
    );
    lines.push(
        `Scanned: ${result.stats.links} link(s), ${result.stats.images} image(s), ` +
        `${result.stats.expressions} expression(s), ${result.stats.textChars} character(s) of copy, ` +
        `about ${result.stats.sizeKb} KB.`
    );
    // Said before the list, not after it. Someone pasting this into a ticket is handing over what
    // reads as the complete picture, and a curated list that does not admit to being curated is the
    // one way this report could actively mislead.
    if (result.ignored > 0) {
        lines.push(`${result.ignored} finding(s) were ignored by the reviewer and are not listed below.`);
    }
    lines.push('');
    if (result.findings.length === 0) {
        lines.push(result.ignored > 0 ? 'Nothing left after the ignored findings.' : 'No issues found.');
    }
    for (const f of result.findings) {
        lines.push(`[${f.severity.toUpperCase()}] ${f.rule} — ${f.title}`);
        lines.push(`  ${f.detail}`);
        for (const loc of f.locations) lines.push(`    - ${loc}`);
        if (f.truncated > 0) lines.push(`    ...and ${f.truncated} more`);
        lines.push('');
    }
    lines.push('Note: only what was open in the editor got checked. Shared reusable blocks and');
    lines.push('templates are separate items — run the tool on those too.');
    return lines.join('\n');
}

/** Spreadsheet columns, in order. Status is left blank for the reviewer to fill in. */
const SHEET_COLUMNS = ['Email', 'Severity', 'Rule', 'Issue', 'Where', 'Details', 'Status'];

/** The words the panel uses, rather than the internal severity keys. */
const SHEET_SEVERITY = { [SEVERITY.ERROR]: 'Error', [SEVERITY.WARNING]: 'Warning', [SEVERITY.INFO]: 'Note' };

/**
 * Make one value safe to sit in a tab-separated cell.
 *
 * Three separate hazards, each of which silently corrupts the paste rather than failing loudly:
 *
 * - A tab ends the cell and a newline ends the row, so either one inside a value shears the rest of
 *   the row into the wrong columns. Findings carry multi-sentence details, so this is the common
 *   case, not an edge case. Both collapse to spaces.
 * - Excel evaluates a cell that opens with `=`, `+` or `@`, turning a value into a formula or an
 *   error. Content this tool reads is arbitrary — a link, a label, a CSS value — so it can start
 *   with anything. A leading apostrophe marks the cell as text.
 * - A value that opens with a double quote is read as a quoted field, and the parser then swallows
 *   the delimiter looking for the closing quote. Component labels quote the copy they sample
 *   (`Section 2 of 4 — "Everything reduced until Sunday."`), so this happens in practice. Quoting
 *   the whole cell and doubling the inner quotes is the escape both Excel and Sheets expect.
 */
function sheetCell(value) {
    let s = String(value === null || value === undefined ? '' : value)
        .replace(/[\t\r\n]+/g, ' ')
        .replace(/ {2,}/g, ' ')
        .trim();
    if (/^[=+@]/.test(s)) s = `'${s}`;
    return s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Flatten a result into tab-separated rows, so the findings can be pasted straight into a QA
 * tracking sheet as columns instead of retyped.
 *
 * Tabs rather than commas because that is what a spreadsheet reads directly off the clipboard: TSV
 * lands in separate columns on a plain paste, whereas CSV arrives as one column per row and needs
 * Text to Columns run over it by hand.
 *
 * One row per finding, matching the panel — locations are joined into a single cell rather than
 * exploded into a row each. Splitting them would read well for a rule that names five broken links
 * and badly for one whose finding *is* the set, like sections disagreeing on padding, and nothing
 * in a finding says which kind it is.
 *
 * @param {object} result  output of runPreflight
 * @param {string} [label] content name, repeated on every row so several scans can be stacked
 * @returns {string} TSV including a header row
 */
export function buildSheetReport(result, label = '') {
    const rows = [SHEET_COLUMNS.join('\t')];
    for (const f of result.findings) {
        const where = f.locations.slice();
        if (f.truncated > 0) where.push(`…and ${f.truncated} more`);
        rows.push(
            [
                label,
                SHEET_SEVERITY[f.severity] || f.severity,
                f.rule,
                f.title,
                where.join(' | '),
                f.detail,
                ''
            ]
                .map(sheetCell)
                .join('\t')
        );
    }
    // CRLF: what Excel on Windows expects between clipboard rows.
    return rows.join('\r\n');
}
