/**
 * Panel tests.
 *
 * These exist mostly to compile the template. Everything the tool decides lives in preflightEngine
 * and qaCompare, which are tested exhaustively on their own; what is NOT covered anywhere else is
 * whether emailPreflight.html is valid, and a template error there is only discoverable at deploy
 * time. Creating the element parses and renders the template, so a broken binding fails here first.
 */
import { createElement } from 'lwc';
import EmailPreflight from 'c/emailPreflight';
import { getContent, getContext } from 'experience/cmsEditorApi';
import { graphql } from 'lightning/uiGraphQLApi';

const TYPE_EMAIL = 'sfdc_cms__email';
const TYPE_SMS = 'sfdc_cms__sms';
const TYPE_RCB = 'sfdc_cms__emailFragment';
const TYPE_TEMPLATE = 'sfdc_cms__emailTemplate';

function build() {
    const el = createElement('c-email-preflight', { is: EmailPreflight });
    document.body.appendChild(el);
    return el;
}

/**
 * Both wired handlers destructure `{ data, error }`, so emitted values need that envelope —
 * createTestWireAdapter passes whatever it is given straight through as the whole wire value.
 */
const emitContent = (value) => getContent.emit({ data: value, error: undefined });
const emitContext = (contentTypeFQN) => getContext.emit({ data: { contentTypeFQN }, error: undefined });

/** Answer the name lookup with a key → name map, shaped as the GraphQL wire returns it. */
const emitNames = (pairs) =>
    graphql.emit({
        uiapi: {
            query: {
                ManagedContent: {
                    edges: Object.entries(pairs).map(([key, name]) => ({
                        node: { ContentKey: { value: key }, Name: { value: name } }
                    }))
                }
            }
        }
    });

function content(body, title = 'Test email') {
    return { title, contentBody: body };
}

/** Body shape mirrors the engine suite, which mirrors what the builder stores. */
const emailBody = (children, extra = {}) => ({ 'sfdc_cms:block': { children }, ...extra });
const htmlNode = (rawHtml) => ({ definition: 'lightning/html', attributes: { rawHtml } });
const buttonNode = (url, text = 'Shop now') => ({
    definition: 'lightning/actionButton',
    attributes: { text },
    url,
    generatedUrl: url
});

afterEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    jest.clearAllTimers();
});

const flush = () => Promise.resolve();

/** QA groups start folded, so anything that inspects rows has to open the group first. */
async function expandGroup(el, id) {
    el.shadowRoot.querySelector(`button[data-group="${id}"]`).click();
    await flush();
}

const groupHeader = (el, id) => el.shadowRoot.querySelector(`button[data-group="${id}"]`);

/** A severity chip: shows the count for that severity and filters the list to it when clicked. */
const countChip = (el, severity) => el.shadowRoot.querySelector(`.count-chip[data-severity="${severity}"]`);

describe('emailPreflight panel', () => {
    it('renders without a template error before any data arrives', () => {
        expect(() => build()).not.toThrow();
    });

    it('waits for the editor rather than guessing a content type', async () => {
        const el = build();
        await flush();
        expect(el.shadowRoot.textContent).toContain('Waiting for the editor');
    });

    it('says there is nothing to check for an unsupported content type', async () => {
        const el = build();
        emitContext(TYPE_SMS);
        await flush();
        expect(el.shadowRoot.textContent).toContain('nothing to check here');
    });

    it('recognises a reusable content block and applies its ruleset', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        await flush();
        expect(el.shadowRoot.textContent).toContain('Reusable Content Block');
        expect(el.shadowRoot.textContent).not.toContain('nothing to check here');
    });

    // ---- content-block mode --------------------------------------------------------

    const tabLabels = (el) =>
        [...el.shadowRoot.querySelectorAll('lightning-tab')].map((t) => t.label);

    it('names the tabs after an email when an email is open', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(tabLabels(el)).toEqual(['Email Issues', 'Email QA']);
    });

    it('names the tabs after a content block when one is open', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(tabLabels(el)).toEqual(['Content Block Issues', 'Content Block QA']);
    });

    // Queried by data attribute, not by `name`: `name` is an @api property on the base component and
    // LWC does not reflect properties to attributes, so a `[name=...]` selector matches nothing.
    const rolePicker = (el) => el.shadowRoot.querySelector('[data-id="block-role"]');

    it('asks what the block is for, and only for a block', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        const group = rolePicker(el);
        expect(group).not.toBeNull();
        expect(group.options.map((o) => o.value)).toEqual(['header', 'body', 'footer']);
    });

    it('does not ask an email what it is', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(rolePicker(el)).toBeNull();
    });

    it('re-checks as soon as the role is chosen, without a second click', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(emailBody([htmlNode('<p>Follow us on social</p>')])));
        await flush();
        expect(el.shadowRoot.textContent).not.toContain('No unsubscribe link found');

        rolePicker(el).dispatchEvent(new CustomEvent('change', { detail: { value: ['footer'] } }));
        await flush();
        expect(el.shadowRoot.textContent).toContain('No unsubscribe link found');
    });

    // ---- component tree --------------------------------------------------------------

    const sectionNode = (children, attributes) => ({
        definition: 'lightning/section',
        attributes,
        children
    });
    const paraNode = (text) => ({ definition: 'lightning/paragraph', attributes: { text } });

    /** Two sections, the first carrying a button with no URL so it owns a real finding. */
    const treeEmail = () =>
        content(
            emailBody(
                [
                    sectionNode([paraNode('Spring sale is here'), buttonNode('')]),
                    sectionNode([paraNode('Terms and conditions apply to everything shown above')])
                ],
                { subject: 'Spring sale' }
            )
        );

    const treeRows = (el) => [...el.shadowRoot.querySelectorAll('.tree-row')];
    const treeLabels = (el) => [...el.shadowRoot.querySelectorAll('.tree-label')].map((s) => s.textContent);
    const treeHead = (el) => el.shadowRoot.querySelector('.tree-head');

    /** The tree is folded on arrival, so anything inspecting its rows has to open it first. */
    async function openTree(el) {
        if (treeHead(el).getAttribute('aria-expanded') === 'false') {
            treeHead(el).click();
            await flush();
        }
        return el;
    }

    it('keeps the tree folded until it is asked for', async () => {
        const el = await scanned(TYPE_EMAIL, treeEmail());
        expect(treeHead(el)).not.toBeNull();
        expect(treeRows(el)).toHaveLength(0);
    });

    it('opens and closes on the header', async () => {
        const el = await scanned(TYPE_EMAIL, treeEmail());
        await openTree(el);
        expect(treeRows(el).length).toBeGreaterThan(0);
        treeHead(el).click();
        await flush();
        expect(treeRows(el)).toHaveLength(0);
    });

    it('says how many sections have issues while folded', async () => {
        const el = await scanned(TYPE_EMAIL, treeEmail());
        expect(treeHead(el).textContent).toMatch(/\d+ of \d+ sections/);
    });

    // Folded, the header is the only sign that the list below is being narrowed.
    it('names the active section filter in the folded header', async () => {
        const el = await scanned(TYPE_EMAIL, treeEmail());
        await openTree(el);
        treeRows(el).find((r) => r.dataset.place === 'Section 1 of 2').click();
        await flush();
        treeHead(el).click();
        await flush();

        expect(treeRows(el)).toHaveLength(0);
        expect(treeHead(el).textContent).toContain('Showing Section 1 of 2');
        expect(el.shadowRoot.querySelector('.tree-summary_active')).not.toBeNull();
    });

    it('maps the email into a tree of sections', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, treeEmail()));
        const labels = treeLabels(el);
        expect(labels.some((l) => l.includes('Section 1 of 2'))).toBe(true);
        expect(labels.some((l) => l.includes('Section 2 of 2'))).toBe(true);
    });

    it('shows a count against each section', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, treeEmail()));
        const pills = [...el.shadowRoot.querySelectorAll('.tree-pill')].map((s) => s.textContent);
        expect(pills.length).toBeGreaterThan(1);
        // The button with no URL lives in section 1, so it cannot be a tree of empty counts.
        expect(pills.some((p) => p !== 'None')).toBe(true);
    });

    it('narrows the findings list to the section that was tapped', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, treeEmail()));
        const before = el.shadowRoot.querySelectorAll('.finding-head').length;
        const first = treeRows(el).find((r) => r.dataset.place === 'Section 1 of 2');
        first.click();
        await flush();
        const after = el.shadowRoot.querySelectorAll('.finding-head').length;
        expect(after).toBeGreaterThan(0);
        expect(after).toBeLessThan(before);
    });

    it('clears the filter when the same row is tapped again', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, treeEmail()));
        const before = el.shadowRoot.querySelectorAll('.finding-head').length;
        const row = () => treeRows(el).find((r) => r.dataset.place === 'Section 1 of 2');
        row().click();
        await flush();
        row().click();
        await flush();
        expect(el.shadowRoot.querySelectorAll('.finding-head')).toHaveLength(before);
    });

    it('marks the selected row', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, treeEmail()));
        treeRows(el).find((r) => r.dataset.place === 'Section 1 of 2').click();
        await flush();
        const selected = treeRows(el).filter((r) => r.className.includes('tree-row_selected'));
        expect(selected).toHaveLength(1);
        expect(selected[0].dataset.place).toBe('Section 1 of 2');
    });

    it('lists an embedded block as somewhere to go rather than a count', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, content(withBlock())));
        const stat = el.shadowRoot.querySelector('.tree-row_static');
        expect(stat).not.toBeNull();
        expect(stat.textContent).toContain('open this block and run the panel there');
        // Not a button: there would be nothing to filter to.
        expect(stat.tagName).not.toBe('BUTTON');
    });

    it('drops an ignored finding out of the tree counts too', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, treeEmail()));
        // A clean row reads "None" rather than 0, so read it back as a number here.
        const pillsFor = (place) => {
            const row = treeRows(el).find((r) => r.dataset.place === place);
            const text = row.querySelector('.tree-pill').textContent;
            return text === 'None' ? 0 : Number(text);
        };
        const before = pillsFor('Section 1 of 2');
        expect(before).toBeGreaterThan(0);

        // Ignore a finding that belongs to section 1 — the button with no URL is the error, and
        // errors sort first.
        ignoreButtons(el)[0].click();
        await flush();
        expect(pillsFor('Section 1 of 2')).toBe(before - 1);
    });

    it('offers a way out when the filters combine into an empty list', async () => {
        const el = await openTree(await scanned(TYPE_EMAIL, treeEmail()));
        treeRows(el).find((r) => r.dataset.place === 'Section 2 of 2').click();
        await flush();
        countChip(el, 'error').click();
        await flush();

        const escape = [...el.shadowRoot.querySelectorAll('lightning-button')]
            .find((b) => b.label === 'Show everything');
        expect(escape).not.toBeNull();
        escape.click();
        await flush();
        expect(el.shadowRoot.querySelectorAll('.finding-head').length).toBeGreaterThan(0);
    });

    it('does not draw a tree for content with nothing to navigate', async () => {
        const el = await scanned(TYPE_EMAIL, content(emailBody([htmlNode('<p>Hello</p>')])));
        expect(el.shadowRoot.querySelector('.tree')).toBeNull();
    });

    // ---- ignoring a finding ----------------------------------------------------------

    /** An email that reliably produces several findings across all three severities. */
    const messyEmail = () =>
        content(emailBody([htmlNode('{{#if a}}oops'), buttonNode('http://shop.com')], { subject: 'Hi' }));

    const ignoreButtons = (el) => [...el.shadowRoot.querySelectorAll('.finding-ignore')];
    const findingTitles = (el) =>
        [...el.shadowRoot.querySelectorAll('.finding-head')].map((d) => d.textContent);

    async function scanned(type = TYPE_EMAIL, item = messyEmail()) {
        const el = build();
        emitContext(type);
        emitContent(item);
        await flush();
        return el;
    }

    it('offers a dismiss control on every finding', async () => {
        const el = await scanned();
        expect(ignoreButtons(el).length).toBe(findingTitles(el).length);
        expect(ignoreButtons(el).length).toBeGreaterThan(1);
    });

    it('removes just the one that was clicked', async () => {
        const el = await scanned();
        const before = findingTitles(el);
        ignoreButtons(el)[0].click();
        await flush();
        const after = findingTitles(el);
        expect(after).toHaveLength(before.length - 1);
        expect(after).not.toContain(before[0]);
        expect(after).toContain(before[1]);
    });

    it('takes the ignored finding out of the counts', async () => {
        const el = await scanned();
        const errorCell = () => countChip(el, 'error').querySelector('.count-num').textContent;
        const before = Number(errorCell());
        expect(before).toBeGreaterThan(0);
        // The list is sorted errors first, so the first dismiss control is on an error.
        ignoreButtons(el)[0].click();
        await flush();
        expect(Number(errorCell())).toBe(before - 1);
    });

    it('says how many were ignored, and offers them back', async () => {
        const el = await scanned();
        expect(el.shadowRoot.querySelector('.ignored-bar')).toBeNull();

        const before = findingTitles(el).length;
        ignoreButtons(el)[0].click();
        await flush();
        expect(el.shadowRoot.querySelector('.ignored-bar').textContent).toContain('1 issue ignored');

        [...el.shadowRoot.querySelectorAll('lightning-button')]
            .find((b) => b.label === 'Restore all')
            .click();
        await flush();
        expect(el.shadowRoot.querySelector('.ignored-bar')).toBeNull();
        expect(findingTitles(el)).toHaveLength(before);
    });

    it('drops the ignored finding from both copy buttons', async () => {
        const el = await scanned();
        // The head reads "ERROR · LNK004 — Title"; the report carries the title, not the prefix.
        const gone = findingTitles(el)[0].split('—').pop().trim();
        ignoreButtons(el)[0].click();
        await flush();

        const text = [...el.shadowRoot.querySelectorAll('lightning-textarea')]
            .find((t) => t.label === 'Preflight report').value;
        expect(text).not.toContain(gone);
        expect(text).toContain('1 finding(s) were ignored by the reviewer');
    });

    // Ignoring says "we know, it is deliberate". Having it come back the moment the reviewer fixes
    // something else and re-runs is exactly when the memory is worth having.
    it('remembers the dismissal across a re-check', async () => {
        const el = await scanned();
        const gone = findingTitles(el)[0];
        ignoreButtons(el)[0].click();
        await flush();

        [...el.shadowRoot.querySelectorAll('lightning-button')]
            .find((b) => b.label === 'Re-check')
            .click();
        await flush();
        expect(findingTitles(el)).not.toContain(gone);
    });

    it('does not call a fully-ignored email clean', async () => {
        const el = await scanned();
        let guard = 0;
        while (ignoreButtons(el).length > 0 && guard < 100) {
            ignoreButtons(el)[0].click();
            await flush();
            guard += 1;
        }
        expect(el.shadowRoot.textContent).toContain('Every finding here has been ignored');
        expect(el.shadowRoot.textContent).not.toContain('passed every check');
    });

    // ---- the built-in documentation --------------------------------------------------

    it('explains itself in the panel, and says who made it', async () => {
        const el = await scanned();
        const about = el.shadowRoot.querySelector('.about');
        expect(about).not.toBeNull();
        expect(about.querySelector('summary').textContent).toBe('About this panel');
        expect(about.textContent).toContain('Created by Saksham Mathur');
        expect(about.textContent).toContain('It only reads');
    });

    // The panel renames itself for a block, and the documentation has to follow — describing the
    // "Email QA" tab to somebody looking at a tab marked "Content Block QA" is worse than nothing.
    it('describes the tabs by whatever they are currently called', async () => {
        const email = await scanned(TYPE_EMAIL, content(emailBody([htmlNode('<p>Hi</p>')])));
        expect(email.shadowRoot.querySelector('.about').textContent).toContain('Email Issues');

        const block = await scanned(TYPE_RCB, content(emailBody([htmlNode('<p>Hi</p>')])));
        const text = block.shadowRoot.querySelector('.about').textContent;
        expect(text).toContain('Content Block Issues');
        expect(text).toContain('content block you have open');
    });

    // ---- the counts are also the filter ----------------------------------------------
    // These were two separate controls, a table of numbers and a row of buttons repeating the same
    // words. They are now one, so the count and the thing that filters by it cannot drift apart.

    const countOn = (el, severity) => Number(countChip(el, severity).querySelector('.count-num').textContent);

    it('shows a count for every severity plus the total', async () => {
        const el = await scanned();
        const total = countOn(el, 'all');
        expect(total).toBe(findingTitles(el).length);
        expect(countOn(el, 'error') + countOn(el, 'warning') + countOn(el, 'info')).toBe(total);
    });

    it('narrows the list to one severity when its count is clicked', async () => {
        const el = await scanned();
        const warnings = countOn(el, 'warning');
        expect(warnings).toBeGreaterThan(0);

        countChip(el, 'warning').click();
        await flush();
        expect(findingTitles(el)).toHaveLength(warnings);
        expect(countChip(el, 'warning').className).toContain('count-chip_on');
    });

    it('goes back to everything from the All chip', async () => {
        const el = await scanned();
        const total = countOn(el, 'all');
        countChip(el, 'error').click();
        await flush();
        countChip(el, 'all').click();
        await flush();
        expect(findingTitles(el)).toHaveLength(total);
    });

    /** Dismiss findings until the given severity is empty. The list sorts most-severe first. */
    async function emptyOut(el, severity) {
        let guard = 0;
        while (countOn(el, severity) > 0 && ignoreButtons(el).length > 0 && guard < 50) {
            ignoreButtons(el)[0].click();
            await flush();
            guard += 1;
        }
        expect(countOn(el, severity)).toBe(0);
    }

    // The zero stays on screen rather than the chip disappearing: it is a result, and a row that
    // changes width as findings get fixed is harder to read than one that doesn't.
    it('disables a severity once nothing is left in it, but still shows the zero', async () => {
        const el = await scanned();
        expect(countChip(el, 'error').disabled).toBe(false);
        await emptyOut(el, 'error');
        expect(countChip(el, 'error').disabled).toBe(true);
    });

    // Fixing the last error while filtered to Errors would otherwise leave a selected chip that is
    // also dead, with no obvious way back to the rest of the findings.
    it('keeps the selected severity clickable even at zero', async () => {
        const el = await scanned();
        countChip(el, 'error').click();
        await flush();
        await emptyOut(el, 'error');
        expect(countChip(el, 'error').disabled).toBe(false);
    });

    // ---- QA fields follow what is open -----------------------------------------------

    const fieldLabels = (el) =>
        [...el.shadowRoot.querySelectorAll('.qa-field lightning-input')].map((i) => i.label);

    it('offers the subject and preheader boxes for an email', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(fieldLabels(el)).toEqual(['Subject line', 'Preheader']);
    });

    // A footer block has no subject line, and a box for one invites a reviewer to paste the subject
    // of the email they had open a minute ago and collect a pass that means nothing.
    it('drops them entirely for a content block', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(fieldLabels(el)).toEqual([]);
        expect(el.shadowRoot.textContent).not.toContain('Subject line');
        expect(el.shadowRoot.textContent).not.toContain('Preheader');
    });

    it('leaves the per-item groups alone for a block', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(emailBody([htmlNode('<a href="https://acme.com/x">Shop</a>')])));
        await flush();
        // All four still listed. An empty group renders as a static header rather than a button, so
        // this reads the titles instead of the toggles.
        const titles = [...el.shadowRoot.querySelectorAll('.qa-group-title')].map((s) => s.textContent);
        expect(titles).toEqual(['Links', 'Button and link text', 'Image file', 'Image alt text']);
        // And the ones with something in them are still expandable.
        expect(groupHeader(el, 'links')).not.toBeNull();
    });

    it('does not validate a hidden field behind the reviewer\'s back', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        [...el.shadowRoot.querySelectorAll('lightning-button')]
            .find((b) => b.label === 'Validate all')
            .click();
        await flush();
        // Every row was skipped and no field ran, so there is nothing to report — an empty subject
        // counting itself in would read as a checked item that matched.
        expect(el.shadowRoot.textContent).not.toContain('checked item(s)');
    });

    it('says "content block" rather than "email" in the empty-group messages', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(el.shadowRoot.textContent).toContain('No links in this content block.');
        expect(el.shadowRoot.textContent).not.toContain('No links in this email.');
    });

    // ---- embedded-block banner ------------------------------------------------------

    const withBlock = () =>
        emailBody([
            {
                definition: 'sfdc_cms/reusableContentBlock',
                attributes: { content: { definition: '@cms/MCK263AR76UVCFPDIHIXUCFOYMMU' } }
            }
        ]);

    it('warns above the results that a block in the email went unchecked', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(withBlock()));
        await flush();
        const banner = el.shadowRoot.querySelector('[data-id="block-banner"]');
        expect(banner).not.toBeNull();
        expect(banner.textContent).toContain('content block that was not checked');
        expect(banner.textContent).toContain('open the content block itself');
    });

    it('identifies the block by key when the reference carries no name', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(withBlock()));
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="block-banner"]').textContent)
            .toContain('MCK263AR76UVCFPDIHIXUCFOYMMU');
    });

    it('shows no banner for an email that embeds nothing', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="block-banner"]')).toBeNull();
    });

    // Inside the block, the message would be telling the reader to go where they already are.
    it('shows no banner while the block itself is open', async () => {
        const el = build();
        emitContext(TYPE_RCB);
        emitContent(content(withBlock()));
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="block-banner"]')).toBeNull();
    });

    // ---- email templates --------------------------------------------------------------

    // A broken master template is a fault repeated across every email built from it, so this is the
    // earliest and cheapest place to catch one. Before this the panel refused the type outright.
    it('checks an email template rather than refusing it', async () => {
        const el = build();
        emitContext(TYPE_TEMPLATE);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')], { subject: 'Hi' })));
        await flush();
        expect(el.shadowRoot.textContent).toContain('Results');
        expect(el.shadowRoot.textContent).not.toContain("there's nothing to check here");
    });

    it('names the type it is checking', async () => {
        const el = build();
        emitContext(TYPE_TEMPLATE);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(el.shadowRoot.textContent).toContain('Email Template — checked as an email would be');
    });

    it('calls the tabs Template Issues and Template QA', async () => {
        const el = build();
        emitContext(TYPE_TEMPLATE);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(el.shadowRoot.textContent).toContain('Template Issues');
        expect(el.shadowRoot.textContent).toContain('Template QA');
        expect(el.shadowRoot.textContent).not.toContain('Email Issues');
    });

    // Subject and preheader belong to a template as much as to an email, which is the whole reason
    // the email ruleset is the right one to apply.
    it('still applies the subject rules a block would skip', async () => {
        const el = build();
        emitContext(TYPE_TEMPLATE);
        emitContent(content(emailBody([htmlNode('<p>Hello there, this is the body copy.</p>')])));
        await flush();
        expect(el.shadowRoot.textContent).toContain('subject');
    });

    it('says "template" when a block inside one went unchecked', async () => {
        const el = build();
        emitContext(TYPE_TEMPLATE);
        emitContent(content(withBlock()));
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="block-banner"]').textContent)
            .toContain('This template contains a content block');
    });

    it('still refuses a type it has no rules for', async () => {
        const el = build();
        emitContext(TYPE_SMS);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(el.shadowRoot.textContent).toContain("there's nothing to check here");
        expect(el.shadowRoot.textContent).toContain('Emails, Email Templates and Reusable Content Blocks');
    });

    // ---- what the email is built from -----------------------------------------------

    const builtFrom = () =>
        emailBody([htmlNode('<p>Hello</p>')], {
            'sfdc_cms:template': {
                definition: 'MCLWKQ6FDLB5B2THFCIQLWZVTNKM',
                attributes: { schemaMap: { a: { readOnly: false }, b: { readOnly: false } } }
            },
            'lightning:brandSource': { contentKey: 'MC7SLITDILTVGOBGU47JAPL64BZM' }
        });

    // Folded, the summary is the whole answer for most readers — so it has to say what is in there
    // rather than how many rows there are.
    it('says what the email is built from without being opened', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(builtFrom()));
        await flush();
        const card = el.shadowRoot.querySelector('[data-id="usage"]');
        expect(card).not.toBeNull();
        expect(card.textContent).toContain('Template and brand');
        expect(card.textContent).not.toContain('MCLWKQ6FDLB5B2THFCIQLWZVTNKM');
    });

    it('shows the template and brand keys once opened', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(builtFrom()));
        await flush();
        el.shadowRoot.querySelector('[data-id="usage"] button').click();
        await flush();
        const card = el.shadowRoot.querySelector('[data-id="usage"]');
        expect(card.textContent).toContain('MCLWKQ6FDLB5B2THFCIQLWZVTNKM');
        expect(card.textContent).toContain('MC7SLITDILTVGOBGU47JAPL64BZM');
    });

    // A template locking nothing is a starting point rather than a guardrail, which is not obvious
    // from the builder and is worth saying to anyone who assumed otherwise.
    it('says plainly when a template locks nothing', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(builtFrom()));
        await flush();
        el.shadowRoot.querySelector('[data-id="usage"] button').click();
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="usage"]').textContent)
            .toContain('Nothing locked — all 2 components are editable');
    });

    // ---- resolving content keys to names ---------------------------------------------

    // A key identifies an item exactly and describes it to nobody. The name is the part a reviewer
    // can check against a brief, which is the whole reason the card is worth reading.
    it('shows the name once the lookup answers, with the key kept beside it', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(builtFrom()));
        await flush();
        emitNames({ MCLWKQ6FDLB5B2THFCIQLWZVTNKM: 'Email Template_20260322_070533' });
        await flush();
        el.shadowRoot.querySelector('[data-id="usage"] button').click();
        await flush();
        const card = el.shadowRoot.querySelector('[data-id="usage"]');
        expect(card.textContent).toContain('Email Template_20260322_070533');
        expect(card.textContent).toContain('MCLWKQ6FDLB5B2THFCIQLWZVTNKM');
    });

    // The two tests either side of this one would pass even if the query asked for the wrong keys,
    // because the test adapter emits whatever it is handed regardless of config. This is the one
    // that checks the panel actually asked for what it found.
    it('asks for every key it found, once each', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(builtFrom()));
        await flush();
        expect(el).toBeTruthy();
        expect(graphql.getLastConfig().variables.keys.sort()).toEqual([
            'MC7SLITDILTVGOBGU47JAPL64BZM',
            'MCLWKQ6FDLB5B2THFCIQLWZVTNKM'
        ]);
    });

    it('does not run a lookup for content that references nothing', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(el).toBeTruthy();
        expect(graphql.getLastConfig().variables).toBeUndefined();
    });

    // The panel worked without names before this existed, and the key is still what CMS search
    // matches on — so a lookup that cannot answer costs the reader nothing.
    it('falls back to the key when the lookup fails', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(builtFrom()));
        await flush();
        graphql.emitErrors([{ message: 'insufficient access' }]);
        await flush();
        el.shadowRoot.querySelector('[data-id="usage"] button').click();
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="usage"]').textContent)
            .toContain('MCLWKQ6FDLB5B2THFCIQLWZVTNKM');
    });

    it('names an embedded block instead of printing its key', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(withBlock()));
        await flush();
        emitNames({ MCK263AR76UVCFPDIHIXUCFOYMMU: 'Footer' });
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="block-banner"]').textContent).toContain('Footer');
    });

    it('shows no card for an email that references nothing', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')])));
        await flush();
        expect(el.shadowRoot.querySelector('[data-id="usage"]')).toBeNull();
    });

    it('scans on its own once both wires have delivered', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')], { subject: 'Hi' })));
        await flush();
        expect(el.shadowRoot.textContent).toContain('Results');
    });

    it('offers both tabs', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')], { subject: 'Hi' })));
        await flush();
        const tabs = el.shadowRoot.querySelectorAll('lightning-tab');
        expect([...tabs].map((t) => t.label)).toEqual(['Email Issues', 'Email QA']);
    });

    it('gives every whole-email field its own validate button', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')], { subject: 'Hi' })));
        await flush();
        const perField = el.shadowRoot.querySelectorAll('lightning-button[data-field]');
        expect([...perField].map((b) => b.dataset.field)).toEqual(['subject', 'preheader']);
    });

    it('gives every link in the email its own box and validate button', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(
            content(
                emailBody([
                    { definition: 'lightning/section', children: [htmlNode('<a href="https://a.com">A</a>')] },
                    { definition: 'lightning/section', children: [htmlNode('<a href="https://b.com">B</a>')] }
                ])
            )
        );
        await flush();
        await expandGroup(el, 'links');

        const rows = el.shadowRoot.querySelectorAll('lightning-input[data-key]');
        const urlRows = [...rows].filter((r) => r.dataset.key.startsWith('url|'));
        expect(urlRows).toHaveLength(2);
        expect(el.shadowRoot.querySelectorAll('lightning-button[data-key]').length).toBe(rows.length);
    });

    it('names the component each row belongs to', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(
            content(
                emailBody([
                    { definition: 'lightning/section', children: [htmlNode('<p>hi</p>')] },
                    { definition: 'lightning/section', children: [htmlNode('<a href="https://b.com">B</a>')] }
                ])
            )
        );
        await flush();
        await expandGroup(el, 'links');
        expect(el.shadowRoot.textContent).toContain('Section 2 of 2');
    });

    it('validates one link row against what that component actually links to', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<a href="https://shop.com/sale">Shop now</a>')])));
        await flush();
        await expandGroup(el, 'links');

        const input = [...el.shadowRoot.querySelectorAll('lightning-input[data-key]')].find((r) =>
            r.dataset.key.startsWith('url|')
        );
        input.value = 'https://shop.com/other';
        input.dispatchEvent(new CustomEvent('change'));
        await flush();

        // Matched by dataset rather than an attribute selector: keys carry quotes and pipes.
        [...el.shadowRoot.querySelectorAll('lightning-button[data-key]')]
            .find((b) => b.dataset.key === input.dataset.key)
            .click();
        await flush();

        expect(el.shadowRoot.textContent).toContain('Same site');
    });

    it('validates one field without touching the others', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent(content(emailBody([htmlNode('<p>Hello</p>')], { subject: 'Real subject' })));
        await flush();

        const input = el.shadowRoot.querySelector('lightning-input[data-field="subject"]');
        input.value = 'Real subject';
        input.dispatchEvent(new CustomEvent('change'));
        await flush();

        el.shadowRoot.querySelector('lightning-button[data-field="subject"]').click();
        await flush();

        expect(el.shadowRoot.textContent).toContain('MATCHES');
        // The others were never run, so nothing claims they passed.
        expect(el.shadowRoot.textContent).toContain('1 checked item(s) match');
    });

    it('reports a problem reading the content instead of failing silently', async () => {
        const el = build();
        emitContext(TYPE_EMAIL);
        emitContent({ title: 'Broken', contentBody: null });
        await flush();
        expect(el.shadowRoot.textContent).toContain('Could not read the editor content');
    });

    describe('QA groups fold', () => {
        const twoLinks = () =>
            content(
                emailBody([
                    { definition: 'lightning/section', children: [htmlNode('<a href="https://a.com">A</a>')] },
                    { definition: 'lightning/section', children: [htmlNode('<a href="https://b.com">B</a>')] }
                ])
            );

        async function openPanel() {
            const el = build();
            emitContext(TYPE_EMAIL);
            emitContent(twoLinks());
            await flush();
            return el;
        }

        it('starts folded, so the tab opens short', async () => {
            const el = await openPanel();
            expect(el.shadowRoot.querySelectorAll('lightning-input[data-key]')).toHaveLength(0);
            expect(groupHeader(el, 'links')).not.toBeNull();
        });

        it('says how much is inside without being opened', async () => {
            const el = await openPanel();
            expect(groupHeader(el, 'links').textContent).toContain('2 to check');
        });

        it('opens and closes on the header', async () => {
            const el = await openPanel();
            await expandGroup(el, 'links');
            expect(el.shadowRoot.querySelectorAll('lightning-input[data-key]').length).toBeGreaterThan(0);
            await expandGroup(el, 'links');
            expect(el.shadowRoot.querySelectorAll('lightning-input[data-key]')).toHaveLength(0);
        });

        it('reports its state in the header once rows have been checked', async () => {
            const el = await openPanel();
            await expandGroup(el, 'links');

            const input = [...el.shadowRoot.querySelectorAll('lightning-input[data-key]')].find((r) =>
                r.dataset.key.startsWith('url|')
            );
            input.value = 'https://wrong.com';
            input.dispatchEvent(new CustomEvent('change'));
            await flush();
            [...el.shadowRoot.querySelectorAll('lightning-button[data-key]')]
                .find((b) => b.dataset.key === input.dataset.key)
                .click();
            await flush();

            expect(groupHeader(el, 'links').textContent).toContain('1 of 2 checked, 1 failing');
        });

        // Validate all can fail a row inside a folded group; leaving it folded would report the
        // failure in the header and hide the row it belongs to.
        it('opens a folded group that Validate all found a failure in', async () => {
            const el = await openPanel();
            await expandGroup(el, 'links');
            const input = [...el.shadowRoot.querySelectorAll('lightning-input[data-key]')].find((r) =>
                r.dataset.key.startsWith('url|')
            );
            input.value = 'https://wrong.com';
            input.dispatchEvent(new CustomEvent('change'));
            await flush();
            await expandGroup(el, 'links'); // fold it back up

            [...el.shadowRoot.querySelectorAll('lightning-button')]
                .find((b) => b.label === 'Validate all')
                .click();
            await flush();

            expect(el.shadowRoot.querySelectorAll('lightning-input[data-key]').length).toBeGreaterThan(0);
        });

        it('names a group the email has nothing for, without offering to open it', async () => {
            const el = await openPanel();
            expect(groupHeader(el, 'images')).toBeNull();
            expect(el.shadowRoot.textContent).toContain('No images in this email.');
        });

        it('folds everything again on Clear', async () => {
            const el = await openPanel();
            await expandGroup(el, 'links');
            [...el.shadowRoot.querySelectorAll('lightning-button')].find((b) => b.label === 'Clear').click();
            await flush();
            expect(el.shadowRoot.querySelectorAll('lightning-input[data-key]')).toHaveLength(0);
        });
    });

    describe('copying the results out', () => {
        /** An email with one certain finding, so there is always a row to copy. */
        const withFinding = () => content(emailBody([htmlNode('<a href="#">Click here</a>')]), 'EM_Launch');

        const buttonLabelled = (el, label) =>
            [...el.shadowRoot.querySelectorAll('lightning-button')].find((b) => b.label === label);

        /**
         * The copy handlers await the clipboard before setting their state, so a single microtask
         * turn lands before the button has relabelled. Drain the queue and let the render run.
         */
        const settle = () => new Promise((r) => setTimeout(r, 0));

        async function openPanel(clipboard) {
            if (clipboard) Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
            const el = build();
            emitContext(TYPE_EMAIL);
            emitContent(withFinding());
            await flush();
            return el;
        }

        it('offers both a text report and a spreadsheet copy', async () => {
            const el = await openPanel();
            expect(buttonLabelled(el, 'Copy report')).toBeDefined();
            expect(buttonLabelled(el, 'Copy for Excel')).toBeDefined();
        });

        it('puts tab-separated rows with a header on the clipboard', async () => {
            const writeText = jest.fn().mockResolvedValue(undefined);
            const el = await openPanel({ writeText });

            buttonLabelled(el, 'Copy for Excel').click();
            await settle();

            const [tsv] = writeText.mock.calls[0];
            const [header, first] = tsv.split('\r\n');
            expect(header.split('\t')).toEqual([
                'Email',
                'Severity',
                'Rule',
                'Issue',
                'Where',
                'Details',
                'Status'
            ]);
            expect(first.split('\t')).toHaveLength(7);
            expect(first).toContain('EM_Launch');
        });

        it('confirms the copy on the button', async () => {
            const el = await openPanel({ writeText: jest.fn().mockResolvedValue(undefined) });
            buttonLabelled(el, 'Copy for Excel').click();
            await settle();
            expect(buttonLabelled(el, 'Copied — paste into Excel')).toBeDefined();
            // The other button must not claim to have copied anything.
            expect(buttonLabelled(el, 'Copy report')).toBeDefined();
        });

        // The builder frame is free to withhold clipboard permission, so the rows have to be
        // reachable by hand rather than the button just doing nothing.
        it('shows the rows to copy by hand when the clipboard is refused', async () => {
            const el = await openPanel({ writeText: jest.fn().mockRejectedValue(new Error('denied')) });
            buttonLabelled(el, 'Copy for Excel').click();
            await settle();

            expect(el.shadowRoot.textContent).toContain('paste into your sheet');
            const boxes = [...el.shadowRoot.querySelectorAll('lightning-textarea')];
            expect(boxes.some((b) => b.value.includes('\t'))).toBe(true);
        });
    });
});
