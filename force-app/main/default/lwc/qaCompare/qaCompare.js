/**
 * qaCompare — "does the email match the spec" comparisons for the Email QA tab.
 *
 * Separate from preflightEngine on purpose. The engine answers "is anything wrong with this email"
 * using rules it carries itself. This module answers a different question — "is this email what
 * somebody wrote down elsewhere" — and has no opinion of its own. It reuses the engine's collectors
 * to read the content, then compares what it finds against text a QA reviewer typed in.
 *
 * The hard part here is not comparison, it is explaining a mismatch. A reviewer pastes a subject
 * line out of Word or Google Docs, which silently substitutes curly quotes, en dashes and
 * non-breaking spaces. A bare `===` then reports a mismatch between two strings that look identical
 * on screen, the reviewer concludes the tool is broken, and they stop using it. So every failure
 * here has to say precisely WHICH characters differ — see describeTextDifference.
 *
 * Pure functions, no imports from the editor, no side effects.
 */
import {
    collectImages,
    collectLocatedLinks,
    findValueByKeys,
    PREHEADER_KEYS,
    SUBJECT_KEYS
} from 'c/preflightEngine';

export const STATUS = { PASS: 'pass', FAIL: 'fail', SKIPPED: 'skipped' };

/**
 * The whole-item fields — the ones that exist exactly once, so there is nothing to enumerate.
 *
 * Everything else (links, button text, alt text) is checked per item against what is actually in the
 * content, via collectQaTargets. Exported so the panel renders its form from this list rather than
 * keeping a second copy in the template.
 *
 * `emailOnly` hides a field when a reusable block is open. A subject line is a property of the
 * email, not of a fragment inside it, so a box asking a reviewer to confirm the subject of a footer
 * block is asking a question with no answer — and one they might answer anyway, from the email they
 * had open a minute ago, producing a pass that means nothing. Both current fields are email-only;
 * the flag exists so that stays a property of the field rather than a rule written into the panel.
 */
export const QA_FIELDS = [
    { id: 'subject', label: 'Subject line', multiline: false, emailOnly: true },
    { id: 'preheader', label: 'Preheader', multiline: false, emailOnly: true }
];

/**
 * The per-item groups, in panel order. `kind` selects the comparison.
 *
 * A component appears in more than one group when there is more than one thing to check about it: a
 * button has both a destination and a label, and an image has both a file and its alt text. One
 * input per row keeps each question single and the sidebar narrow.
 *
 * All four apply to a block as readily as to an email — a footer has links and images like anything
 * else — so `{noun}` in the empty message is filled in by the panel with whatever is open.
 */
export const QA_GROUPS = [
    { id: 'links', title: 'Links', kind: 'url', prompt: 'Expected URL', empty: 'No links in this {noun}.' },
    { id: 'texts', title: 'Button and link text', kind: 'text', prompt: 'Expected text', empty: 'Nothing clickable in this {noun}.' },
    { id: 'imageSources', title: 'Image file', kind: 'src', prompt: 'Expected file or URL', empty: 'No images in this {noun}.' },
    { id: 'images', title: 'Image alt text', kind: 'text', prompt: 'Expected alt text', empty: 'No images in this {noun}.' }
];

// ---- character classes that word processors substitute silently -------------------

const ZERO_WIDTH = /[\u200b-\u200d\ufeff]/g;
const NBSP = /[\u00a0\u2007\u202f]/g;
const CURLY_SINGLE = /[\u2018\u2019\u201a\u201b\u2032]/g;
const CURLY_DOUBLE = /[\u201c\u201d\u201e\u201f\u2033]/g;
const FANCY_DASH = /[\u2010-\u2015\u2212]/g;
const ELLIPSIS = /\u2026/g;

/**
 * Cosmetic normalisation steps, each independently reversible in the reader's head.
 *
 * Order matters only in that whitespace collapsing runs last, after non-breaking spaces have become
 * ordinary ones — otherwise a nbsp would survive the collapse and show up as a real difference.
 */
const STEPS = [
    { key: 'invisible', label: 'invisible characters', fn: (s) => s.replace(ZERO_WIDTH, '') },
    { key: 'nbsp', label: 'non-breaking spaces', fn: (s) => s.replace(NBSP, ' ') },
    {
        key: 'quotes',
        label: 'curly vs straight quotes',
        fn: (s) => s.replace(CURLY_SINGLE, "'").replace(CURLY_DOUBLE, '"')
    },
    { key: 'dashes', label: 'dash style', fn: (s) => s.replace(FANCY_DASH, '-') },
    { key: 'ellipsis', label: 'ellipsis character', fn: (s) => s.replace(ELLIPSIS, '...') },
    { key: 'spacing', label: 'spacing', fn: (s) => s.replace(/\s+/g, ' ').trim() }
];

/**
 * Merge expressions in either syntax the platform accepts.
 *
 * Two regexes rather than one reused with `.test()`: a `g` regex carries `lastIndex` between calls,
 * so testing one string then another silently skips the start of the second.
 */
const MERGE_FIELD_ALL = /(\{\{[^}]*\}\}|\{![^}]*\}|%%[^%]+%%)/g;
const HAS_MERGE_FIELD = /(\{\{[^}]*\}\}|\{![^}]*\}|%%[^%]+%%)/;

/** Apply every cosmetic step. Two strings equal after this differ only in ways nobody can see. */
export function cosmeticNormalize(value) {
    if (typeof value !== 'string') return '';
    return STEPS.reduce((acc, step) => step.fn(acc), value);
}

/**
 * Which cosmetic steps are actually doing the work.
 *
 * Determined by leaving each step out in turn: if the strings still match without it, that step was
 * not needed, and naming it would send the reader looking for a difference that is not there.
 */
function stepsResponsible(a, b) {
    const needed = [];
    for (const skip of STEPS) {
        const partial = (s) => STEPS.filter((st) => st !== skip).reduce((acc, st) => st.fn(acc), s);
        if (partial(a) !== partial(b)) needed.push(skip.label);
    }
    return needed;
}

function listPhrase(items) {
    if (items.length === 1) return items[0];
    if (items.length === 2) return `${items[0]} and ${items[1]}`;
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** A short window around a position, so a long subject does not print in full twice. */
function excerptAround(value, index, span = 24) {
    const start = Math.max(0, index - span);
    const end = Math.min(value.length, index + span);
    return `${start > 0 ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}

/**
 * Explain how `actual` differs from `expected`, or return null when they are identical.
 *
 * Returns `{ kind, message }`. The kinds, in the order they are tested:
 *
 * - `cosmetic`  — same visible text, different invisible characters. Almost always a paste artefact
 *                 rather than a real defect, and worth saying so plainly.
 * - `case`      — same letters, different capitals.
 * - `merge`     — the email has a merge field where the spec has literal text. Not a defect: the
 *                 spec was written with an example value filled in. Needs a human, not a verdict.
 * - `extra` /
 *   `truncated` — one is a prefix of the other.
 * - `different` — a genuine difference, located and quoted.
 */
export function describeTextDifference(expected, actual) {
    const exp = typeof expected === 'string' ? expected : '';
    const act = typeof actual === 'string' ? actual : '';
    if (exp === act) return null;

    if (act === '') {
        return { kind: 'missing', message: 'The email has nothing in this field.' };
    }

    const ne = cosmeticNormalize(exp);
    const na = cosmeticNormalize(act);

    if (ne === na) {
        const reasons = stepsResponsible(exp, act);
        const why = reasons.length ? listPhrase(reasons) : 'invisible formatting characters';
        return {
            kind: 'cosmetic',
            message:
                `The text reads the same but the characters differ — ${why}. This is normally what ` +
                'happens when the spec was written in Word or Google Docs, which substitutes these ' +
                'automatically. Worth confirming which version you actually want.'
        };
    }

    if (ne.toLowerCase() === na.toLowerCase()) {
        return {
            kind: 'case',
            message: 'Same wording, different capitalisation.'
        };
    }

    const merges = act.match(MERGE_FIELD_ALL);
    if (merges && !HAS_MERGE_FIELD.test(exp)) {
        return {
            kind: 'merge',
            message:
                `The email personalises this with ${listPhrase(merges.slice(0, 3))}, where your text ` +
                'has a fixed value. That is expected if you wrote the spec with an example filled in — ' +
                'check the merge field is the right one rather than treating this as a mismatch.'
        };
    }

    if (na.startsWith(ne)) {
        return {
            kind: 'extra',
            message: `The email starts with your text but continues: "${act.slice(exp.length).trim()}".`
        };
    }
    if (ne.startsWith(na)) {
        return {
            kind: 'truncated',
            message: `The email stops short of your text. It is missing: "${exp.slice(act.length).trim()}".`
        };
    }

    let i = 0;
    while (i < ne.length && i < na.length && ne[i] === na[i]) i++;
    return {
        kind: 'different',
        message:
            `They differ from character ${i + 1}. You typed "${excerptAround(exp, i)}" and the email ` +
            `has "${excerptAround(act, i)}".`
    };
}

// ---- links -----------------------------------------------------------------------

/**
 * Query parameters that carry campaign tracking rather than identifying the destination.
 *
 * Stripped before comparison because a spec lists the page being linked to, while the email's href
 * has tracking bolted on afterwards. Comparing those literally would fail on every link.
 */
const TRACKING_PARAM = /^(utm_[\w-]+|gclid|fbclid|msclkid|dclid|mc_cid|mc_eid|_ga|_gl|igshid|yclid|ttclid|li_fat_id|s_kwcid|epik|twclid)$/i;

/** Links the platform owns. A reviewer never lists these, so they are not "unexpected". */
const SYSTEM_LINK = /(optout|unsubscribe|preference|view.?in.?browser|forward.?to.?friend|\$link\.)/i;

/**
 * Reduce a URL to the part that identifies the destination.
 *
 * Drops the fragment and all campaign tracking, lowercases the scheme and host (case-insensitive per
 * RFC 3986) while preserving the path (which is not), and removes a trailing slash. Any remaining
 * query parameters are kept and sorted, because `?product=123` is part of the destination and two
 * URLs differing only in parameter order are the same page.
 */
export function normalizeUrl(raw) {
    let s = typeof raw === 'string' ? raw.trim() : '';
    if (!s) return '';

    s = s.split('#')[0];

    const q = s.indexOf('?');
    let query = '';
    if (q !== -1) {
        query = s.slice(q + 1);
        s = s.slice(0, q);
    }

    const parts = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(s);
    if (parts) s = parts[1].toLowerCase() + parts[2].toLowerCase() + parts[3];
    if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);

    if (query) {
        const kept = query
            .split('&')
            .filter((pair) => {
                if (!pair) return false;
                // A bare merge expression standing in for the whole query string is a tracking
                // string assembled at send time, so there is nothing for a reviewer to have listed.
                if (!pair.includes('=')) return !/\{\{|\{!|%%/.test(pair);
                return !TRACKING_PARAM.test(pair.slice(0, pair.indexOf('=')));
            })
            .sort();
        if (kept.length) s += `?${kept.join('&')}`;
    }
    return s;
}

export function isSystemLink(url) {
    const s = typeof url === 'string' ? url : '';
    if (!s.trim()) return false;
    if (/^(mailto:|tel:|sms:)/i.test(s.trim())) return true;
    if (/^#/.test(s.trim())) return true;
    return SYSTEM_LINK.test(s);
}

/**
 * Explain how one URL differs from another, once tracking has already been ruled out.
 *
 * Ordered by how the reader would triage it: no destination at all, then the same page over the
 * wrong scheme, then a different page on the same site, then a different site entirely. Each of
 * those means something different to a reviewer, and "they don't match" means none of them.
 */
function explainUrlDifference(expected, actual) {
    if (!actual || !actual.trim()) return 'This link has no destination set in the email.';

    const e = normalizeUrl(expected);
    const a = normalizeUrl(actual);
    const bare = (u) => u.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
    const hostOf = (u) => bare(u).split('/')[0];

    if (bare(e) === bare(a)) {
        return `Same address, but over ${a.startsWith('http://') ? 'http' : 'a different scheme'} rather than ${
            e.startsWith('https://') ? 'https' : 'what you typed'
        }.`;
    }
    if (hostOf(e) === hostOf(a)) {
        return `Same site, different page. You expected "${e}" and the email links to "${a}".`;
    }
    return `Different destination. You expected "${expected}" and the email links to "${actual}".`;
}

/** The file name at the end of a path or URL, with any query string and fragment removed. */
function fileNameOf(value) {
    const s = typeof value === 'string' ? value.trim() : '';
    if (!s) return '';
    const withoutQuery = s.split(/[?#]/)[0];
    const last = withoutQuery.split('/').pop() || '';
    // Only treat it as a file name if it looks like one. A CMS content key has no extension, and
    // matching two of those on "the last path segment" would be matching on the whole value twice.
    return /\.[a-z0-9]{2,5}$/i.test(last) ? last.toLowerCase() : '';
}

/** Explain a picture that is not the expected one. Same idea as explainUrlDifference, image wording. */
function explainSourceDifference(expected, actual) {
    if (!actual || !actual.trim()) return 'This image has no file set.';
    return `This image uses "${actual}", not "${expected}".`;
}

/**
 * Compare one expected value against what a single component actually has.
 *
 * A blank expectation is SKIPPED, never PASS — a reviewer who has not got to a row yet must not see
 * it reported as verified.
 *
 * @param {'url'|'text'} kind
 */
export function compareValue(kind, expected, actual) {
    const want = typeof expected === 'string' ? expected.trim() : '';
    if (want === '') return { status: STATUS.SKIPPED, detail: '' };

    const have = typeof actual === 'string' ? actual : '';

    if (kind === 'url' || kind === 'src') {
        if (normalizeUrl(want) && normalizeUrl(want) === normalizeUrl(have)) {
            return { status: STATUS.PASS, detail: '' };
        }
        // An image file is often stored as a bare name or a CMS key rather than a full URL, and a
        // reviewer working from a spec will have typed one or the other. Matching on the file name
        // alone stops "hero-banner.jpg" failing against a CDN URL that ends in exactly that.
        if (kind === 'src' && fileNameOf(want) && fileNameOf(want) === fileNameOf(have)) {
            return { status: STATUS.PASS, detail: '' };
        }
        return {
            status: STATUS.FAIL,
            detail: kind === 'src' ? explainSourceDifference(want, have) : explainUrlDifference(want, have)
        };
    }

    const diff = describeTextDifference(want, have);
    return diff ? { status: STATUS.FAIL, detail: diff.message } : { status: STATUS.PASS, detail: '' };
}

/**
 * Everything in the email that can be checked one item at a time, each carrying the component it
 * belongs to.
 *
 * This is the inversion that makes the QA tab usable: rather than asking a reviewer to type a list
 * and guessing which entry means which component, the panel shows what is actually there — "Image 1
 * in Section 3" — and asks what it should be. Nothing has to be matched up by position, and a link
 * nobody expected is visible simply by being in the list.
 *
 * Keys are stable within a run and unique even when two components look identical, so the panel can
 * hold typed values against them.
 */
export function collectQaTargets(content) {
    const body = (content && content.contentBody) || {};
    const located = collectLocatedLinks(body);

    const keyed = (prefix, items) => {
        const used = new Set();
        return items.map((item, i) => {
            let key = `${prefix}|${item.label}|${item.actual}`;
            if (used.has(key)) key = `${key}|${i}`;
            used.add(key);
            return { ...item, key };
        });
    };

    const images = collectImages(body);

    return {
        links: keyed(
            'url',
            located
                .filter((l) => l.url)
                .map((l) => ({ label: l.label || 'Link', actual: l.url, system: isSystemLink(l.url) }))
        ),
        texts: keyed(
            'txt',
            located.filter((l) => l.text).map((l) => ({ label: l.label || 'Link', actual: l.text, system: false }))
        ),
        imageSources: keyed(
            'src',
            images.map((i) => ({ label: i.label, actual: i.src, system: false }))
        ),
        images: keyed(
            'alt',
            images.map((i) => ({ label: i.label, actual: i.alt, system: false }))
        )
    };
}

// ---- top level ---------------------------------------------------------------------

function singleResult(id, label, expected, actual) {
    if (!expected) return { id, label, status: STATUS.SKIPPED, expected: '', actual, detail: '' };
    const diff = describeTextDifference(expected, actual);
    return {
        id,
        label,
        status: diff ? STATUS.FAIL : STATUS.PASS,
        expected,
        actual,
        detail: diff ? diff.message : '',
        kind: diff ? diff.kind : 'exact'
    };
}

/**
 * Run one field's comparison. Returns a SKIPPED result for a field left blank — an untested field
 * must never look like a tested one.
 *
 * Per field rather than all at once because a reviewer works down the list, fixing as they go, and
 * re-running the other comparisons to see one answer buries it.
 *
 * @param {object} content  the editor content object, as handed to runPreflight
 * @param {object} spec     { subject, preheader }
 * @param {string} id       which field to check
 */
export function runQaField(content, spec, id) {
    const body = (content && content.contentBody) || {};
    const s = spec || {};
    const meta = QA_FIELDS.find((f) => f.id === id);
    const label = meta ? meta.label : id;
    const keys = id === 'preheader' ? PREHEADER_KEYS : SUBJECT_KEYS;
    return singleResult(id, label, (s[id] || '').trim(), findValueByKeys(body, keys).value || '');
}
