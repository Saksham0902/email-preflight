/**
 * Tests for preflightEngine — the deterministic core of the Email Preflight tool.
 *
 * The engine is pure (content JSON in, findings out), so everything here is a plain function call.
 * Fixtures mimic the shapes the MCN editor is observed to store: structured link fields on button
 * nodes, `attributes.rawHtml` for HTML blocks, and `attributes.imageInfo` for images.
 */
import {
    SEVERITY,
    EMAIL_NAME_MAX,
    CHECKS,
    scanHandlebars,
    findBlockImbalances,
    collectSetVariableNames,
    collectBareVariables,
    collectStrings,
    collectLinks,
    collectLocatedLinks,
    collectLinklessNodes,
    collectAnchors,
    collectImages,
    collectEmbeddedBlocks,
    checkEmbeddedBlocks,
    buildComponentTree,
    blockNameOf,
    checkBlockRole,
    BLOCK_ROLES,
    ROLE_HEADER,
    ROLE_BODY,
    ROLE_FOOTER,
    collectVisibleText,
    contrastRatio,
    describeComponents,
    friendlyType,
    describeShape,
    findValueByKeys,
    checkHandlebars,
    checkCompliance,
    checkLinks,
    checkImages,
    checkContentBasics,
    checkSubjectQuality,
    checkRcbCompatibility,
    checkOutlookRendering,
    checkMcnQuirks,
    checkLayout,
    readSpacing,
    collectLayoutNodes,
    collectColumnGroups,
    checkDataProviders,
    collectDataProviders,
    collectBackgroundImages,
    maxBlockDepth,
    checkDynamicContent,
    checkVariables,
    checkMigration,
    checkPlaceholderCopy,
    checkAmpscript,
    checkAccessibility,
    checkEmailCss,
    checkDarkMode,
    checkSize,
    MIN_CONTRAST,
    SIZE_WARN_KB,
    PREHEADER_MAX_RECOMMENDED,
    runPreflight,
    buildTextReport,
    buildSheetReport,
    collectLocatedStrings
} from 'c/preflightEngine';

/** Build a minimal email body with the given children. */
function emailBody(children) {
    return { 'sfdc_cms:block': { children } };
}

/** An HTML block node. */
function htmlNode(rawHtml) {
    return { definition: 'lightning/html', attributes: { rawHtml } };
}

/** A button node — MCN stores the same URL twice, which the link collector must dedupe. */
function buttonNode(url, buttonText = 'Click me') {
    return {
        definition: 'lightning/actionButton',
        attributes: { buttonText },
        url,
        generatedUrl: url
    };
}

/** An image node. */
function imageNode(contentKey, altText, linkUrl) {
    const node = {
        definition: 'lightning/image',
        attributes: { imageInfo: { source: { ref: { contentKey } }, altText } }
    };
    if (linkUrl) node.linkUrl = linkUrl;
    return node;
}

/** Enough real copy to clear the image-to-text ratio check. */
const BODY_COPY =
    '<p>Our spring sale starts today. Every jacket, every pair of boots and the whole outdoor ' +
    'range is reduced until Sunday, in store and online.</p>';

/** The postal address CAN-SPAM requires, so a fixture can be compliant without CMP003 firing. */
const FOOTER_ADDRESS = '<p>Northwind Outdoors, 415 Beacon Street, Boston, MA 02116</p>';

/**
 * A `lightning/actionButton` exactly as the MCN builder stores one — verified against a real content
 * body. Two details here are the whole reason LNK004 took several attempts to get right: the
 * destination lives under `attributes.uri`, and the node is padded with `{!$brand...}` tokens that
 * are merge-field-shaped but are not links.
 *
 * @param {string|undefined} uri  omit entirely to model a button whose URL was never set
 */
function actionButtonNode(uri, text = 'Button') {
    const attributes = {
        text,
        width: 'auto',
        'lightning:borderRadius': '{!$brand.buttonStyleGroup.primary.lightning:borderRadius}',
        'lightning:colorGroup': {
            backgroundColor: '{!$brand.colorScheme.root}',
            linkColor: '{!$brand.colorScheme.primaryAccent}'
        },
        'lightning:typography': { letterSpacing: 'normal', textTransform: 'none' },
        'sfdc_cms:styleGroup': '{!$brand.buttonStyleGroup.primary}'
    };
    if (uri !== undefined) attributes.uri = uri;
    return { definition: 'lightning/actionButton', type: 'block', id: 'af1c04c6', attributes };
}

const ruleIds = (findings) => findings.map((f) => f.rule);

// ---------------------------------------------------------------------------
// scanHandlebars
// ---------------------------------------------------------------------------

describe('scanHandlebars', () => {
    it('returns nothing for a string with no expressions', () => {
        expect(scanHandlebars('plain text')).toEqual([]);
    });

    it('is safe on non-strings', () => {
        expect(scanHandlebars(null)).toEqual([]);
        expect(scanHandlebars(42)).toEqual([]);
    });

    it('classifies opens, closes and plain expressions', () => {
        const tokens = scanHandlebars('{{#if x}}{{name}}{{/if}}');
        expect(tokens.map((t) => t.kind)).toEqual(['open', 'expr', 'close']);
    });

    it('treats an inverted section as a block open but a bare ^ as an else', () => {
        expect(scanHandlebars('{{^empty}}')[0].kind).toBe('open');
        expect(scanHandlebars('{{^}}')[0].kind).toBe('else');
    });

    it('closes a triple stash on }}} rather than }}', () => {
        const tokens = scanHandlebars('{{{rawHtml}}}');
        expect(tokens).toHaveLength(1);
        expect(tokens[0].inner).toBe('rawHtml');
    });

    it('reports an unterminated open instead of swallowing it', () => {
        const tokens = scanHandlebars('hello {{name');
        expect(tokens[0].kind).toBe('unterminated');
    });

    it('recognises comments and empty expressions', () => {
        expect(scanHandlebars('{{! a note }}')[0].kind).toBe('comment');
        expect(scanHandlebars('{{}}')[0].kind).toBe('empty');
        expect(scanHandlebars('{{   }}')[0].kind).toBe('empty');
    });
});

// ---------------------------------------------------------------------------
// findBlockImbalances
// ---------------------------------------------------------------------------

describe('findBlockImbalances', () => {
    it('accepts a balanced block', () => {
        expect(findBlockImbalances('{{#if x}}hi{{/if}}')).toEqual([]);
    });

    it('accepts nested balanced blocks', () => {
        expect(findBlockImbalances('{{#each rows}}{{#if a}}x{{/if}}{{/each}}')).toEqual([]);
    });

    it('flags an unclosed block', () => {
        const problems = findBlockImbalances('{{#if x}}hi');
        expect(problems).toHaveLength(1);
        expect(problems[0].type).toBe('unclosed');
        expect(problems[0].name).toBe('if');
    });

    it('flags a close with no open', () => {
        const problems = findBlockImbalances('hi{{/if}}');
        expect(problems[0].type).toBe('unexpected-close');
    });

    it('flags a block closed by the wrong helper', () => {
        const problems = findBlockImbalances('{{#if x}}hi{{/each}}');
        expect(problems[0].type).toBe('mismatch');
    });

    it('ignores an {{else}} between the open and close', () => {
        expect(findBlockImbalances('{{#if x}}a{{else}}b{{/if}}')).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// variable collection
// ---------------------------------------------------------------------------

describe('variable collection', () => {
    it('picks up names defined by {{set}}', () => {
        const names = collectSetVariableNames(['{{set "varRegion" "region=north"}}', '{{set "crmId" "1"}}']);
        expect(Array.from(names).sort()).toEqual(['crmId', 'varRegion']);
    });

    it('collects bare single-token variables', () => {
        expect(collectBareVariables(['Hello {{firstName}}'])).toEqual(['firstName']);
    });

    it('ignores dotted data-provider paths', () => {
        expect(collectBareVariables(['{{DataGraph.Individual.FirstName}}'])).toEqual([]);
    });

    it('ignores helper calls with arguments', () => {
        expect(collectBareVariables(['{{fallback (get a) "x"}}'])).toEqual([]);
    });

    it('ignores known helpers used bare', () => {
        expect(collectBareVariables(['{{else}}', '{{this}}'])).toEqual([]);
    });

    it('dedupes a variable used in several places', () => {
        expect(collectBareVariables(['{{name}}', '{{name}} again'])).toEqual(['name']);
    });
});

// ---------------------------------------------------------------------------
// tree collection
// ---------------------------------------------------------------------------

describe('tree collection', () => {
    it('collects strings from anywhere in the tree', () => {
        const body = emailBody([htmlNode('<p>hi</p>'), buttonNode('https://a.com')]);
        const strings = collectStrings(body);
        expect(strings).toContain('<p>hi</p>');
        expect(strings).toContain('https://a.com');
    });

    it('dedupes a button that stores its URL in two fields', () => {
        expect(collectLinks(emailBody([buttonNode('https://a.com')]))).toEqual(['https://a.com']);
    });

    it('finds anchor hrefs inside raw HTML, quoted or not', () => {
        const body = emailBody([htmlNode('<a href="https://a.com">A</a><a href=https://b.com>B</a>')]);
        expect(collectLinks(body).sort()).toEqual(['https://a.com', 'https://b.com']);
    });

    it('finds images in both the structured and HTML shapes', () => {
        const body = emailBody([
            imageNode('MC_A', 'A vacuum'),
            htmlNode('<img src="https://cdn/x.png" alt="Logo">')
        ]);
        const images = collectImages(body);
        expect(images).toHaveLength(2);
        expect(images.every((i) => i.hasAlt)).toBe(true);
    });

    it('marks an image with no alt text', () => {
        const images = collectImages(emailBody([imageNode('MC_A', '')]));
        expect(images[0].hasAlt).toBe(false);
    });

    // The exact shape the builder writes when "override alt text" is left unticked, which is the
    // default: altText is empty here because the real description lives on the CMS asset.
    it('recognises alt text that is held on the CMS asset instead of the email', () => {
        const body = emailBody([
            {
                definition: 'lightning/image',
                attributes: {
                    imageInfo: {
                        altText: '',
                        overrideAltText: false,
                        source: { type: 'imageReference', ref: { contentKey: 'MCBGZOFEA4WN' } },
                        url: '/cms/media/MCBGZOFEA4WN?fileName=hero.png'
                    }
                }
            }
        ]);
        const [image] = collectImages(body);
        expect(image.hasAlt).toBe(false);
        expect(image.altFromCms).toBe(true);
    });

    // Ticking override means the author typed it into the email, so it is readable and checkable.
    it('does not treat overridden alt text as living in CMS', () => {
        const body = emailBody([
            {
                definition: 'lightning/image',
                attributes: {
                    imageInfo: {
                        altText: 'A doctor talking to a patient',
                        overrideAltText: true,
                        source: { type: 'imageReference', ref: { contentKey: 'MCBGZOFEA4WN' } }
                    }
                }
            }
        ]);
        const [image] = collectImages(body);
        expect(image.hasAlt).toBe(true);
        expect(image.altFromCms).toBe(false);
    });

    // No CMS asset behind it means there is nowhere else for alt text to be, so a blank really is
    // blank and IMG001 should still fire.
    it('does not excuse a blank alt on an image with no CMS reference', () => {
        const body = emailBody([
            {
                definition: 'lightning/image',
                attributes: {
                    imageInfo: { altText: '', overrideAltText: false, url: 'https://cdn/x.png' }
                }
            }
        ]);
        expect(collectImages(body)[0].altFromCms).toBe(false);
    });

    it('treats a blank alt in hand-written HTML as genuinely blank', () => {
        const body = emailBody([htmlNode('<img src="https://cdn/x.png" alt="">')]);
        expect(collectImages(body)[0].altFromCms).toBe(false);
    });

    it('knows whether an image is linked', () => {
        const images = collectImages(emailBody([imageNode('MC_A', '', 'https://a.com')]));
        expect(images[0].linked).toBe(true);
    });

    it('counts an HTML image wrapped in an anchor as linked', () => {
        const body = emailBody([
            htmlNode('<a href="https://a.com"><img src="https://cdn/logo.png" alt="Logo"></a>')
        ]);
        expect(collectImages(body)[0].linked).toBe(true);
    });

    it('counts an HTML image outside any anchor as unlinked', () => {
        const body = emailBody([
            htmlNode('<a href="https://a.com">Read more</a><img src="https://cdn/x.png" alt="Chart">')
        ]);
        const chart = collectImages(body).find((i) => i.alt === 'Chart');
        expect(chart.linked).toBe(false);
    });

    it('does not treat an image inside an empty-href anchor as linked', () => {
        const body = emailBody([htmlNode('<a href=""><img src="https://cdn/x.png" alt="Hero"></a>')]);
        expect(collectImages(body)[0].linked).toBe(false);
    });

    it('ignores a button that has a destination', () => {
        expect(collectLinklessNodes(emailBody([buttonNode('https://a.com')]))).toEqual([]);
    });

    it('finds a button whose url is an empty string', () => {
        const body = emailBody([
            { definition: 'lightning/actionButton', attributes: { buttonText: 'Buy now' }, url: '', generatedUrl: '' }
        ]);
        expect(collectLinklessNodes(body)).toEqual(['Button "Buy now"']);
    });

    it('finds a freshly dropped button that has no url key at all', () => {
        const body = emailBody([
            { definition: 'lightning/actionButton', attributes: { buttonText: 'Shop now' } }
        ]);
        expect(collectLinklessNodes(body)).toEqual(['Button "Shop now"']);
    });

    it('does not flag a button whose destination lives in a nested action', () => {
        const body = emailBody([
            {
                definition: 'lightning/actionButton',
                attributes: { buttonText: 'Go' },
                'lightning:click': { actions: [{ url: 'https://a.com' }] }
            }
        ]);
        expect(collectLinklessNodes(body)).toEqual([]);
    });

    it('reports a linkless button once, not once per nested node', () => {
        const body = emailBody([
            {
                definition: 'lightning/actionButton',
                attributes: { buttonText: 'Go' },
                'lightning:click': { actions: [{ url: '' }] }
            }
        ]);
        expect(collectLinklessNodes(body)).toEqual(['Button "Go"']);
    });

    it('names a button by its type when it has no text on it', () => {
        const body = emailBody([{ definition: 'lightning/actionButton', url: '' }]);
        expect(collectLinklessNodes(body)).toEqual(['Button']);
    });

    it('does not treat ordinary content as a link component', () => {
        expect(collectLinklessNodes(emailBody([htmlNode('<p>hi</p>')]))).toEqual([]);
    });

    it('does not treat an unlinked image as a link component', () => {
        expect(collectLinklessNodes(emailBody([imageNode('MC_A', 'Alt')]))).toEqual([]);
    });

    it('does not flag an image whose link field is present but empty', () => {
        // The builder gives every image a linkUrl field. An image with no link is ordinary content,
        // not a mistake — unlike a button, an image is complete without a destination.
        const node = imageNode('MC_A', 'Alt');
        node.linkUrl = '';
        expect(collectLinklessNodes(emailBody([node]))).toEqual([]);
    });

    it('does not flag a divider or spacer that carries an empty link field', () => {
        const body = emailBody([{ definition: 'lightning/divider', linkUrl: '' }]);
        expect(collectLinklessNodes(body)).toEqual([]);
    });

    it('leaves a text component with an empty link field alone', () => {
        // Only buttons are meaningless without a destination. Everything else can legitimately rest
        // with an empty link field, and an empty anchor href is LNK001's job anyway.
        const body = emailBody([{ definition: 'lightning/text', linkUrl: '', text: 'Read more' }]);
        expect(collectLinklessNodes(body)).toEqual([]);
    });

    it('still surfaces an empty anchor href through the link collector', () => {
        expect(collectLinks(emailBody([htmlNode('<a href="">Read more</a>')]))).toEqual(['']);
    });

    // The destination test is deliberately generous: a working button reported as broken is far
    // more damaging than a broken one we stay quiet about. Each case below is a URL stored under a
    // key we have NOT catalogued in LINK_FIELDS, which must still count as a destination.
    it.each([
        ['a key we do not know by name', { href: 'https://a.com' }],
        ['a nested href in an action', { 'lightning:click': { actions: [{ href: 'https://a.com' }] } }],
        ['a url-shaped value under an odd key', { destinationRef: 'https://a.com' }],
        ['a merge-field destination', { url: '{!$link.EmailAddressOptOutUrl}' }],
        ['a Handlebars destination', { linkUrl: '{{productUrl}}' }],
        ['a mailto destination', { someKey: 'mailto:hi@a.com' }],
        ['a url nested inside attributes', { attributes: { buttonText: 'Go', url: 'https://a.com' } }]
    ])('does not flag a button with %s', (_label, extra) => {
        const node = { definition: 'lightning/actionButton', attributes: { buttonText: 'Go' }, ...extra };
        expect(collectLinklessNodes(emailBody([node]))).toEqual([]);
    });

    it('still flags a button whose only strings are not destinations', () => {
        const node = {
            definition: 'lightning/actionButton',
            attributes: { buttonText: 'Go', backgroundColor: '#fff', alignment: 'center' }
        };
        expect(collectLinklessNodes(emailBody([node]))).toEqual(['Button "Go"']);
    });

    // A button carries these whether or not it has a URL. Reading them as destinations silences the
    // rule on precisely the empty buttons it exists to catch.
    it.each([
        ['linkTarget', { linkTarget: '_blank' }],
        ['target', { target: '_self' }],
        ['a url key holding an enum rather than an address', { linkUrl: 'none' }]
    ])('does not accept %s as a destination', (_label, extra) => {
        const node = {
            definition: 'lightning/actionButton',
            attributes: { buttonText: 'Go', ...extra }
        };
        expect(collectLinklessNodes(emailBody([node]))).toEqual(['Button "Go"']);
    });

    it('recognises a button by its buttonText when the definition is unfamiliar', () => {
        const body = emailBody([{ definition: 'x/somethingElse', attributes: { buttonText: 'Go' } }]);
        expect(collectLinklessNodes(body)).toEqual(['Something else "Go"']);
    });

    // The real-world case, reproduced from an actual content body: two identical buttons where one
    // has a destination and one does not. Every earlier version of this rule got one of them wrong.
    it('flags only the button that has no destination', () => {
        const body = emailBody([
            actionButtonNode('https://www.salesforce.com', 'Shop now'),
            actionButtonNode(undefined, 'Learn more')
        ]);
        expect(collectLinklessNodes(body)).toEqual(['Button 2 of 2 "Learn more"']);
    });

    // Two buttons with the same words on them is the case that makes this rule hard to act on, and
    // the reason the position is carried alongside the text rather than instead of it.
    it('tells two identically labelled buttons apart', () => {
        const body = emailBody([
            actionButtonNode(undefined, 'Learn more'),
            actionButtonNode(undefined, 'Learn more')
        ]);
        expect(collectLinklessNodes(body)).toEqual([
            'Button 1 of 2 "Learn more"',
            'Button 2 of 2 "Learn more"'
        ]);
    });

    it('does not read a button\'s brand tokens as a destination', () => {
        const body = emailBody([actionButtonNode(undefined, 'Get started')]);
        expect(collectLinklessNodes(body)).toEqual(['Button "Get started"']);
    });

    it('collects a button destination stored under attributes.uri', () => {
        const body = emailBody([actionButtonNode('https://www.salesforce.com')]);
        expect(collectLinks(body)).toEqual(['https://www.salesforce.com']);
    });

    it('does not count an image source as a link', () => {
        // An image keeps its own source under imageInfo.url. That is not a destination, and counting
        // it both inflates the link total and drags every image through the link checks.
        const img = {
            definition: 'lightning/image',
            attributes: {
                imageInfo: {
                    altText: '',
                    url: '/cms/media/MCJX4LL4ZSVNHALNTPQEVK3NF77U?fileName=DEFAULT',
                    source: { ref: { contentKey: 'MCJX4LL4ZSVNHALNTPQEVK3NF77U' } }
                }
            }
        };
        expect(collectLinks(emailBody([img]))).toEqual([]);
        expect(collectImages(emailBody([img]))).toHaveLength(1);
    });

    it('finds a CTA built as an anchor with no href attribute', () => {
        const body = emailBody([htmlNode('<a class="btn"><span>Learn more</span></a>')]);
        expect(collectLinklessNodes(body)).toEqual(['Learn more']);
    });

    it('leaves an anchor with an empty href to LNK001 rather than reporting it twice', () => {
        expect(collectLinklessNodes(emailBody([htmlNode('<a href="">Learn more</a>')]))).toEqual([]);
    });

    it('ignores an in-page anchor target', () => {
        expect(collectLinklessNodes(emailBody([htmlNode('<a name="top"></a>')]))).toEqual([]);
    });

    it('accepts a site-relative and a scheme-less destination', () => {
        const rel = { definition: 'lightning/actionButton', attributes: { buttonText: 'Go' }, url: '/sale' };
        const bare = { definition: 'lightning/actionButton', attributes: { buttonText: 'Go' }, url: 'shop.com/sale' };
        expect(collectLinklessNodes(emailBody([rel, bare]))).toEqual([]);
    });
});

describe('collectLocatedLinks', () => {
    const section = (children) => ({ definition: 'lightning/section', children });

    it('pairs a link with the section it sits in', () => {
        const body = emailBody([
            section([htmlNode('<a href="https://a.com">A</a>')]),
            section([htmlNode('<a href="https://b.com">B</a>')])
        ]);
        const found = collectLocatedLinks(body);
        expect(found.find((l) => l.url === 'https://b.com').label).toContain('Section 2 of 2');
    });

    it('keeps the link text alongside the destination', () => {
        const body = emailBody([htmlNode('<a href="https://a.com">Shop now</a>')]);
        expect(collectLocatedLinks(body)[0]).toMatchObject({ url: 'https://a.com', text: 'Shop now' });
    });

    it('reads a button label and destination as one entry', () => {
        const body = emailBody([buttonNode('https://a.com', 'Buy now')]);
        const found = collectLocatedLinks(body);
        expect(found).toHaveLength(1);
        expect(found[0]).toMatchObject({ url: 'https://a.com', text: 'Buy now' });
    });

    it('still reports a button that has a label but no destination', () => {
        const body = emailBody([{ definition: 'lightning/actionButton', attributes: { buttonText: 'Buy now' } }]);
        expect(collectLocatedLinks(body)).toMatchObject([{ url: '', text: 'Buy now' }]);
    });

    it('does not report the same anchor twice', () => {
        const body = emailBody([htmlNode('<a href="https://a.com">A</a>')]);
        expect(collectLocatedLinks(body).filter((l) => l.url === 'https://a.com')).toHaveLength(1);
    });

    it('keeps the same URL apart when it appears in two sections', () => {
        const body = emailBody([
            section([htmlNode('<a href="https://a.com">Top</a>')]),
            section([htmlNode('<a href="https://a.com">Bottom</a>')])
        ]);
        expect(collectLocatedLinks(body).filter((l) => l.url === 'https://a.com')).toHaveLength(2);
    });

    it('does not treat an image source as a link', () => {
        const body = emailBody([imageNode('MC_A', 'Alt')]);
        expect(collectLocatedLinks(body).filter((l) => l.url)).toEqual([]);
    });

    it('catches an anchor with no closing tag', () => {
        const body = emailBody([htmlNode('<a href="https://a.com">A')]);
        expect(collectLocatedLinks(body).map((l) => l.url)).toContain('https://a.com');
    });
});

describe('describeComponents', () => {
    /** A section wrapping its children in a column, which is how the builder nests them. */
    const section = (children) => ({
        definition: 'lightning/section',
        attributes: {},
        children: [{ definition: 'lightning/column', attributes: { columnWidth: 12 }, children }]
    });

    /** The shape of a real email: a logo band, a headline band, then a content band. */
    const sampleBody = () =>
        emailBody([
            section([imageNode('MCLOGOKEY7777777777777777777', 'Logo')]),
            section([{ definition: 'lightning/heading', attributes: { text: 'Spring sale' } }]),
            section([
                imageNode('MCHEROKEY7777777777777777777', 'Hero'),
                htmlNode('<p>Everything reduced until Sunday.</p>'),
                actionButtonNode(undefined, 'Shop now')
            ])
        ]);

    const labelOf = (body, predicate) => {
        for (const [node, described] of describeComponents(body)) {
            if (predicate(node, described)) return described.label;
        }
        return undefined;
    };

    it('numbers sections in the order the Component Tree panel lists them', () => {
        const labels = [...describeComponents(sampleBody()).values()]
            .filter((d) => d.type === 'Section')
            .map((d) => d.label);
        expect(labels).toEqual([
            'Section 1 of 3 — Image',
            'Section 2 of 3 — "Spring sale"',
            'Section 3 of 3 — "Everything reduced until Sunday."'
        ]);
    });

    it('describes a section by its own copy when it has some', () => {
        const label = labelOf(sampleBody(), (n) => n.definition === 'lightning/heading');
        expect(label).toBe('Heading in Section 2 of 3 — "Spring sale"');
    });

    it('falls back to what is inside a section that has no copy', () => {
        // The logo band is a picture and nothing else, and "Image" is how its author thinks of it.
        const labels = [...describeComponents(sampleBody()).values()].map((d) => d.label);
        expect(labels).toContain('Section 1 of 3 — Image');
    });

    it('locates a component by the section it sits in', () => {
        const label = labelOf(sampleBody(), (n) => n.definition === 'lightning/actionButton');
        expect(label).toBe('Button in Section 3 of 3 — "Shop now"');
    });

    it('does not print an "of N" count when there is only one of something', () => {
        const body = emailBody([section([{ definition: 'lightning/heading', attributes: { text: 'Hello' } }])]);
        const labels = [...describeComponents(body).values()].map((d) => d.label);
        expect(labels).toContain('Section — "Hello"');
    });

    it('ignores data providers, which are configuration rather than layout', () => {
        const body = {
            'lightning:dataProviders': [
                { definition: 'sfdc_cms__dataGraphDataProvider', attributes: { dataGraphApiName: 'Demo' } }
            ],
            'sfdc_cms:block': { children: [section([htmlNode('<p>Hi</p>')])] }
        };
        const types = [...describeComponents(body).values()].map((d) => d.type);
        expect(types).not.toContain('Component');
        expect(types).toContain('Section');
    });

    it('turns an unrecognised definition into words rather than printing it raw', () => {
        expect(friendlyType('lightning/fancyNewThing')).toBe('Fancy new thing');
        expect(friendlyType('lightning/section')).toBe('Section');
        expect(friendlyType(undefined)).toBe('Component');
    });

    it('shortens a long piece of copy at a word boundary', () => {
        const long = 'Everything in the spring range is reduced this weekend only, in store and online';
        const body = emailBody([section([htmlNode(`<p>${long}</p>`)])]);
        const label = [...describeComponents(body).values()].find((d) => d.type === 'Section').label;
        expect(label.length).toBeLessThan(long.length);
        expect(label).toMatch(/…"$/);
        expect(label).not.toMatch(/\s…/); // cut at a word boundary, no dangling space
    });

    it('leaves merge fields out of the recognisable copy', () => {
        const body = emailBody([section([htmlNode('<p>{{fallback FirstName "there"}} your order shipped</p>')])]);
        const label = [...describeComponents(body).values()].find((d) => d.type === 'Section').label;
        expect(label).toBe('Section — "your order shipped"');
    });
});

describe('labels reaching the findings', () => {
    const section = (children) => ({
        definition: 'lightning/section',
        attributes: {},
        children: [{ definition: 'lightning/column', attributes: { columnWidth: 12 }, children }]
    });

    it('names the section a background image sits on', () => {
        const body = emailBody([
            {
                definition: 'lightning/section',
                attributes: {
                    'lightning:backgroundImage': { source: { ref: { contentKey: 'MC_BG' } } }
                },
                children: [{ definition: 'lightning/column', children: [htmlNode('<p>Sale starts today</p>')] }]
            }
        ]);
        expect(collectBackgroundImages(body)).toEqual(['Section — "Sale starts today"']);
    });

    it('locates an image instead of printing its CMS key', () => {
        const body = emailBody([section([imageNode('MCJX4LL4ZSVNHALNTPQEVK3NF77U', '')])]);
        const [image] = collectImages(body);
        expect(image.label).toBe('Image in Section');
        expect(image.label).not.toContain('MCJX4LL4ZSVNHALNTPQEVK3NF77U');
    });

    it('keeps the asset name available for the rules that reason about it', () => {
        // The label says where the image is; `name` says what the file is. IMG003 needs the second.
        const body = emailBody([section([imageNode('MC_KEY', 'Our logo')])]);
        const [image] = collectImages(body);
        expect(image.name).toBe('MC_KEY');
        expect(ruleIds(checkImages({ images: [image] }))).toContain('IMG003');
    });

    it('spots a logo by its file name when the alt text does not say so', () => {
        const image = { label: 'Image in Section 1 of 4', name: 'acme-logo.png', hasAlt: true, alt: 'Acme', linked: false };
        expect(ruleIds(checkImages({ images: [image] }))).toContain('IMG003');
    });
});

describe('collectVisibleText', () => {
    it('strips tags, entities and merge tokens down to real copy', () => {
        const body = emailBody([htmlNode('<p>Hello&nbsp;{{firstName}}, <b>welcome</b></p>')]);
        expect(collectVisibleText(body)).toBe('Hello , welcome');
    });

    it('ignores ids, definitions and other machinery', () => {
        const body = emailBody([{ definition: 'lightning/actionButton', id: 'abc-123' }]);
        expect(collectVisibleText(body)).toBe('');
    });

    it('does not count a bare URL as copy', () => {
        expect(collectVisibleText(emailBody([{ text: 'https://a.com' }]))).toBe('');
    });
});

describe('describeShape', () => {
    it('lists every distinct key path with its type', () => {
        const shape = describeShape({ a: { b: 'hi' }, c: [1] });
        expect(shape).toContain('a.b  <string>  "hi"');
        expect(shape).toContain('c[]  <number>  1');
    });

    it('collapses repeated array entries into a single path', () => {
        const shape = describeShape({ rows: [{ x: 1 }, { x: 2 }, { x: 3 }] });
        expect(shape.split('\n').filter((l) => l.startsWith('rows[].x'))).toHaveLength(1);
    });

    it('caps output and says how much was dropped', () => {
        const big = {};
        for (let i = 0; i < 20; i++) big[`k${i}`] = i;
        expect(describeShape(big, 5)).toContain('...and 15 more paths');
    });

    // The point of the diagnostic: an email is mostly repetition, so one sample per path hides the
    // one component you were trying to identify.
    it('shows every distinct value on a repeated path, not just the first', () => {
        const shape = describeShape({
            children: [{ definition: 'lightning/section' }, { definition: 'sfdc_cms:block' }]
        });
        expect(shape).toContain('"lightning/section"');
        expect(shape).toContain('"sfdc_cms:block"');
    });

    it('says how many times a path occurs', () => {
        const shape = describeShape({ rows: [{ x: 1 }, { x: 2 }, { x: 3 }] });
        expect(shape).toContain('rows[].x  <number> x3');
    });

    it('does not repeat a value that is the same everywhere', () => {
        const shape = describeShape({ rows: [{ x: 'same' }, { x: 'same' }] });
        expect(shape).toBe('rows[].x  <string> x2  "same"');
    });

    it('holds back the tail when a path has more values than it prints', () => {
        const rows = [];
        for (let i = 0; i < 7; i++) rows.push({ x: `v${i}` });
        expect(describeShape({ rows }, 300, 2)).toContain('(+5 other value(s))');
    });
});

describe('findValueByKeys', () => {
    it('distinguishes an absent key from a present-but-empty one', () => {
        expect(findValueByKeys({ a: 1 }, ['subject'])).toEqual({ found: false, value: '' });
        expect(findValueByKeys({ subject: '  ' }, ['subject'])).toEqual({ found: true, value: '' });
        expect(findValueByKeys({ subject: 'Hi' }, ['subject'])).toEqual({ found: true, value: 'Hi' });
    });
});

// ---------------------------------------------------------------------------
// individual checks
// ---------------------------------------------------------------------------

describe('checkHandlebars', () => {
    const ctx = (strings) => ({ strings });

    it('is quiet on valid scripting', () => {
        expect(checkHandlebars(ctx(['{{#if a}}x{{/if}}']))).toEqual([]);
    });

    it('reports an unclosed block as an error', () => {
        const found = checkHandlebars(ctx(['{{#if a}}x']));
        expect(ruleIds(found)).toEqual(['HB001']);
        expect(found[0].severity).toBe(SEVERITY.ERROR);
    });

    it('reports an unterminated expression', () => {
        expect(ruleIds(checkHandlebars(ctx(['{{name'])))).toContain('HB004');
    });

    it('reports an empty expression as a warning only', () => {
        const found = checkHandlebars(ctx(['{{}}']));
        expect(found[0].rule).toBe('HB005');
        expect(found[0].severity).toBe(SEVERITY.WARNING);
    });

    it('checks balance per string, not across unrelated components', () => {
        // An open in one component and a close in another must NOT pair up.
        const found = checkHandlebars(ctx(['{{#if a}}', '{{/if}}']));
        expect(ruleIds(found).sort()).toEqual(['HB001', 'HB002']);
    });

    // Not a syntax error — it just quietly stops being a fallback, so the author believes they are
    // covered and the gap only turns up in the delivered email.
    it('errors on a fallback with nothing to fall back to', () => {
        const found = checkHandlebars(ctx(['Hi {{fallback FirstName}}']));
        expect(ruleIds(found)).toContain('HB006');
        expect(found[0].severity).toBe(SEVERITY.ERROR);
    });

    it('accepts a fallback with a backup value, including an empty one', () => {
        expect(ruleIds(checkHandlebars(ctx(['{{fallback FirstName "there"}}'])))).not.toContain('HB006');
        expect(ruleIds(checkHandlebars(ctx(['{{fallback FirstName ""}}'])))).not.toContain('HB006');
    });

    it('does not mistake an ordinary expression for a fallback', () => {
        expect(ruleIds(checkHandlebars(ctx(['{{FirstName}}'])))).not.toContain('HB006');
    });
});

describe('checkCompliance', () => {
    it('warns when an email has no unsubscribe link', () => {
        const found = checkCompliance({ strings: ['<p>hello</p>'], isEmail: true });
        expect(ruleIds(found)).toContain('CMP001');
    });

    it('is satisfied by the standard opt-out merge field', () => {
        const found = checkCompliance({
            strings: ['<a href="{!$link.EmailAddressOptOutUrl}">Unsubscribe</a>'],
            isEmail: true
        });
        expect(ruleIds(found)).not.toContain('CMP001');
    });

    it('says nothing at all for a reusable content block with no role set', () => {
        expect(checkCompliance({ strings: ['<p>hello</p>'], isEmail: false })).toEqual([]);
    });

    // Reported from real use: the recommended way to show a postal address is to merge it in from
    // Company Information, which is not address-shaped text, so the check called a correct footer
    // non-compliant — the most alarming thing it can say, said wrongly.
    it('accepts a postal address merged in from Company Information', () => {
        const found = checkCompliance({
            strings: ['<p>{!$organization.Address}</p>'],
            isEmail: true,
            body: {},
            visibleText: ''
        });
        expect(ruleIds(found)).not.toContain('CMP003');
    });

    it('accepts address merge fields that are not the standard organization one', () => {
        for (const token of [
            '{!$brand.postalAddress}',
            '{{companyStreetAddress}}',
            '{!$organization.City}',
            '{!Sender.MailingAddress}'
        ]) {
            const found = checkCompliance({
                strings: [`<p>${token}</p>`],
                isEmail: true,
                body: {},
                visibleText: ''
            });
            expect(ruleIds(found)).not.toContain('CMP003');
        }
    });

    // The relaxation must not turn into "any merge field counts", or the rule stops meaning anything.
    it('still reports a missing address when the only merge fields are unrelated', () => {
        const found = checkCompliance({
            strings: ['<p>Hello {!$user.FirstName}, see {{productName}}</p>'],
            isEmail: true,
            body: {},
            visibleText: 'Hello , see'
        });
        expect(ruleIds(found)).toContain('CMP003');
    });

    // Splitting camelCase must not go so far that a word merely CONTAINING an address word counts.
    it('does not mistake capacity for city', () => {
        const found = checkCompliance({
            strings: ['<p>Seats left: {!$event.capacity}</p>'],
            isEmail: true,
            body: {},
            visibleText: 'Seats left:'
        });
        expect(ruleIds(found)).toContain('CMP003');
    });

    it('accepts an opt-out routed through a custom token rather than $link', () => {
        const found = checkCompliance({
            strings: ['<a href="{{unsubscribeUrl}}">Manage</a>'],
            isEmail: true,
            body: {},
            visibleText: 'Manage'
        });
        expect(ruleIds(found)).not.toContain('CMP001');
    });

    // The point of the role picker: these three rules are unrunnable from inside an email that
    // embeds the footer, so the block itself is the only place they can ever fire.
    it('runs on a block once it is marked as a footer', () => {
        const found = checkCompliance({
            strings: ['<p>hello</p>'],
            isEmail: false,
            roles: [ROLE_FOOTER],
            body: {},
            visibleText: 'hello'
        });
        expect(ruleIds(found)).toEqual(expect.arrayContaining(['CMP001', 'CMP002', 'CMP003']));
    });

    it('stays quiet on a block marked header or body', () => {
        for (const role of [ROLE_HEADER, ROLE_BODY]) {
            expect(checkCompliance({ strings: ['<p>hello</p>'], isEmail: false, roles: [role] })).toEqual([]);
        }
    });

    it('drops the "it might be in a block we cannot see" caveat when checking the footer itself', () => {
        const found = checkCompliance({
            strings: ['<p>hello</p>'],
            isEmail: false,
            roles: [ROLE_FOOTER],
            body: {},
            visibleText: 'hello'
        });
        const unsub = found.find((f) => f.rule === 'CMP001');
        expect(unsub.detail).toContain('this footer block');
        expect(unsub.detail).not.toContain('we cannot see it');
    });

    it('keeps the caveat for an email, where the footer really could be elsewhere', () => {
        const found = checkCompliance({ strings: ['<p>hello</p>'], isEmail: true, body: {}, visibleText: 'hi' });
        expect(found.find((f) => f.rule === 'CMP001').detail).toContain('we cannot see it');
    });

    it('is satisfied by a real unsubscribe link inside a footer block', () => {
        const found = checkCompliance({
            strings: ['<a href="https://go.acme.com/unsubscribe">Unsubscribe</a>'],
            links: ['https://go.acme.com/unsubscribe'],
            isEmail: false,
            roles: [ROLE_FOOTER],
            body: {},
            visibleText: 'Unsubscribe'
        });
        expect(ruleIds(found)).not.toContain('CMP001');
    });

    // An ordinary URL is a perfectly valid opt-out, and plenty of orgs use their own page instead of
    // the builder's token. Warning that a compliant email breaks the law is the worst thing this
    // rule can do, because it teaches people to ignore the one finding with legal weight.
    describe('recognises an opt-out however it is written', () => {
        const compliance = (over) =>
            ruleIds(checkCompliance({ strings: [], links: [], anchors: [], isEmail: true, ...over }));

        it('accepts an unsubscribe page linked by its URL', () => {
            expect(compliance({ links: ['https://northwind.com/unsubscribe'] })).not.toContain('CMP001');
        });

        it('accepts opt-out spelled with a hyphen or underscore in the URL', () => {
            expect(compliance({ links: ['https://northwind.com/opt-out'] })).not.toContain('CMP001');
            expect(compliance({ links: ['https://northwind.com/opt_out'] })).not.toContain('CMP001');
        });

        it('accepts a link whose wording says unsubscribe even when the URL does not', () => {
            const found = compliance({
                links: ['https://northwind.com/e/12345'],
                anchors: [{ url: 'https://northwind.com/e/12345', text: 'Unsubscribe' }]
            });
            expect(found).not.toContain('CMP001');
        });

        it('still warns when there is genuinely no opt-out anywhere', () => {
            expect(compliance({ links: ['https://northwind.com/spring'] })).toContain('CMP001');
        });

        it('does not accept an ordinary marketing link as an opt-out', () => {
            const found = compliance({
                links: ['https://northwind.com/spring'],
                anchors: [{ url: 'https://northwind.com/spring', text: 'Shop the spring range' }]
            });
            expect(found).toContain('CMP001');
        });
    });

    describe('recognises a preference centre however it is written', () => {
        const compliance = (over) =>
            ruleIds(checkCompliance({ strings: [], links: [], anchors: [], isEmail: true, ...over }));

        it('accepts a preferences page linked by its URL', () => {
            expect(compliance({ links: ['https://northwind.com/preferences'] })).not.toContain('CMP002');
        });

        it('accepts subscription settings and email settings URLs', () => {
            expect(compliance({ links: ['https://northwind.com/subscription'] })).not.toContain('CMP002');
            expect(compliance({ links: ['https://northwind.com/email-settings'] })).not.toContain('CMP002');
        });

        it('accepts a link whose wording offers the choice', () => {
            const found = compliance({
                links: ['https://northwind.com/e/9'],
                anchors: [{ url: 'https://northwind.com/e/9', text: 'Choose which emails you get' }]
            });
            expect(found).not.toContain('CMP002');
        });

        it('still notes when there is no preference centre', () => {
            expect(compliance({ links: ['https://northwind.com/spring'] })).toContain('CMP002');
        });
    });

    // A missing opt-out is a legal problem, so it stays a warning whatever else is going on in the
    // email. An embedded block does not soften it — the answer to "the link is in a block" is to
    // read the block, not to say less about the link.
    it('warns at full strength even when the email embeds an unreadable block', () => {
        const found = checkCompliance({
            strings: [],
            links: [],
            anchors: [],
            isEmail: true,
            embeddedBlocks: [{ label: 'Section 6 of 8', contentKey: 'MCABC' }]
        });
        for (const rule of ['CMP001', 'CMP002', 'CMP003']) {
            expect(found.find((f) => f.rule === rule).severity).toBe(SEVERITY.WARNING);
        }
    });

});

describe('checkLinks', () => {
    it('flags placeholder and empty hrefs as errors', () => {
        const found = checkLinks({ links: ['#', '', 'https://example.com/x'] });
        expect(found[0].rule).toBe('LNK001');
        expect(found[0].severity).toBe(SEVERITY.ERROR);
        expect(found[0].locations).toHaveLength(3);
    });

    it('reports a destination-less component as an error, ahead of other link findings', () => {
        const found = checkLinks({ links: [], linklessNodes: ['Buy now'] });
        expect(found[0].rule).toBe('LNK004');
        expect(found[0].severity).toBe(SEVERITY.ERROR);
        expect(found[0].locations).toEqual(['Buy now']);
    });

    it('tolerates a context with no linklessNodes key', () => {
        expect(() => checkLinks({ links: ['https://a.com'] })).not.toThrow();
    });

    it('flags insecure http links as a warning', () => {
        const found = checkLinks({ links: ['http://shop.com'] });
        expect(ruleIds(found)).toEqual(['LNK002']);
    });

    it('accepts a normal https link silently', () => {
        expect(checkLinks({ links: ['https://shop.com/product'] })).toEqual([]);
    });

    it('warns when two query strings have been joined', () => {
        const found = checkLinks({ links: ['https://a.com/p?source=x?medium=email'] });
        expect(ruleIds(found)).toContain('LNK005');
    });

    it('accepts a single query string with several parameters', () => {
        expect(ruleIds(checkLinks({ links: ['https://a.com/p?a=1&b=2'] }))).not.toContain('LNK005');
    });

    it('accepts a question mark that is genuinely part of a value', () => {
        // Legal per RFC 3986 — only a "name=" after the second "?" suggests a mistaken join.
        expect(ruleIds(checkLinks({ links: ['https://a.com/p?q=why?'] }))).not.toContain('LNK005');
    });

    it('errors on whitespace inside a URL and makes it visible in the report', () => {
        const found = checkLinks({ links: ['https://a.com/my page'] });
        const lnk006 = found.find((f) => f.rule === 'LNK006');
        expect(lnk006.locations[0]).toBe('https://a.com/my␣page');
    });

    it('ignores whitespace that is inside a merge field, not the URL', () => {
        expect(ruleIds(checkLinks({ links: ['{! $link.EmailAddressOptOutUrl }'] }))).not.toContain('LNK006');
    });

    it('errors on a link to a staging or local address', () => {
        const found = checkLinks({
            links: ['https://staging.shop.com/sale', 'http://localhost:3000/x', 'https://shop.com/ok']
        });
        const lnk007 = found.find((f) => f.rule === 'LNK007');
        expect(lnk007.severity).toBe(SEVERITY.ERROR);
        expect(lnk007.locations).toEqual(['https://staging.shop.com/sale', 'http://localhost:3000/x']);
    });

    // "developers." starts with "dev" and is a perfectly ordinary production host — the patterns are
    // anchored on a whole label for exactly this reason.
    it('does not mistake a production host for a test one', () => {
        const links = ['https://shop.com/latest', 'https://news.shop.com/x', 'https://developers.shop.com/x'];
        expect(ruleIds(checkLinks({ links }))).not.toContain('LNK007');
    });

    // A link built out of a merge expression has no literal host to judge, and inventing one would
    // mean reporting a working link as broken.
    it('leaves a merge-built URL alone', () => {
        expect(ruleIds(checkLinks({ links: ['{!$domain}/offers'] }))).not.toContain('LNK007');
    });

    it('warns about a jump-to-section link', () => {
        const found = checkLinks({ links: ['#offers'] });
        expect(ruleIds(found)).toContain('LNK008');
    });

    // A bare "#" is a placeholder that was never filled in, which LNK001 already reports with better
    // advice. Reporting it twice under two different headings helps nobody.
    it('leaves a bare # to LNK001', () => {
        const found = checkLinks({ links: ['#'] });
        expect(ruleIds(found)).toContain('LNK001');
        expect(ruleIds(found)).not.toContain('LNK008');
    });

    it('notes an email with real copy but nothing to click', () => {
        const found = checkLinks({ links: [], isEmail: true, visibleText: 'x'.repeat(400) });
        expect(ruleIds(found)).toContain('LNK009');
    });

    it('does not tell an empty draft off for being empty', () => {
        expect(ruleIds(checkLinks({ links: [], isEmail: true, visibleText: '' }))).not.toContain('LNK009');
    });

    it('does not expect links in a reusable block', () => {
        const found = checkLinks({ links: [], isEmail: false, visibleText: 'x'.repeat(400) });
        expect(ruleIds(found)).not.toContain('LNK009');
    });
});

describe('checkImages', () => {
    it('says nothing about an image that has both alt text and a link', () => {
        expect(checkImages({ images: [{ label: 'a', hasAlt: true, linked: true }] })).toEqual([]);
    });

    // Reported from real use. Leaving "override" unticked is the DEFAULT and the recommended setup,
    // so reading only the email's own altText field accused most correctly-described images in an
    // org of having none.
    it('does not claim an image is missing alt text when CMS holds it', () => {
        const found = checkImages({
            images: [{ label: 'hero.png', hasAlt: false, altFromCms: true, linked: true }]
        });
        expect(ruleIds(found)).not.toContain('IMG001');
        expect(ruleIds(found)).toContain('IMG006');
    });

    it('keeps IMG006 a note, since the alt text is probably fine', () => {
        const found = checkImages({
            images: [{ label: 'hero.png', hasAlt: false, altFromCms: true, linked: true }]
        });
        expect(found.find((f) => f.rule === 'IMG006').severity).toBe(SEVERITY.INFO);
    });

    it('still warns about an image that genuinely has no alt text anywhere', () => {
        const found = checkImages({
            images: [{ label: 'hero.png', hasAlt: false, altFromCms: false, linked: true }]
        });
        expect(ruleIds(found)).toContain('IMG001');
        expect(ruleIds(found)).not.toContain('IMG006');
    });

    it('separates the two cases rather than lumping them into one count', () => {
        const found = checkImages({
            images: [
                { label: 'a.png', hasAlt: false, altFromCms: true, linked: true },
                { label: 'b.png', hasAlt: false, altFromCms: false, linked: true }
            ]
        });
        expect(found.find((f) => f.rule === 'IMG001').locations).toEqual(['b.png']);
        expect(found.find((f) => f.rule === 'IMG006').locations).toEqual(['a.png']);
    });

    it('notes an image with no link so someone can decide whether it needs one', () => {
        const found = checkImages({ images: [{ label: 'hero.png', hasAlt: true, linked: false }] });
        const img005 = found.find((f) => f.rule === 'IMG005');
        expect(img005.severity).toBe(SEVERITY.INFO);
        expect(img005.locations).toEqual(['hero.png']);
    });

    // IMG003 already names the logo and gives advice IMG005 cannot ("link it to your homepage").
    // Listing it under both headings makes one problem look like two.
    it('does not repeat an unlinked logo under the general note', () => {
        const found = checkImages({
            images: [{ label: 'dfci-logo.png', hasAlt: true, alt: 'Logo', linked: false }]
        });
        expect(ruleIds(found)).toContain('IMG003');
        expect(ruleIds(found)).not.toContain('IMG005');
    });

    it('lists only the unlinked images, not every image', () => {
        const found = checkImages({
            images: [
                { label: 'hero.png', hasAlt: true, linked: false },
                { label: 'cta.png', hasAlt: true, linked: true }
            ]
        });
        const img005 = found.find((f) => f.rule === 'IMG005');
        expect(img005.locations).toEqual(['hero.png']);
    });

    it('warns about images with no alt text and counts the linked ones', () => {
        const found = checkImages({
            images: [
                { label: 'hero.png', hasAlt: false, linked: true },
                { label: 'spacer.png', hasAlt: false, linked: false }
            ]
        });
        expect(found[0].rule).toBe('IMG001');
        expect(found[0].detail).toContain('2 image(s) have no alt text, and 1 of those is a link');
        expect(found[0].locations).toEqual(['hero.png', 'spacer.png']);
    });

    it('pluralises the linked-image count', () => {
        const found = checkImages({
            images: [
                { label: 'a.png', hasAlt: false, linked: true },
                { label: 'b.png', hasAlt: false, linked: true }
            ]
        });
        expect(found[0].detail).toContain('and 2 of those are links');
    });

    it('warns when an email is images with almost no copy', () => {
        const found = checkImages({
            images: [{ label: 'hero.png', hasAlt: true, linked: false }],
            visibleText: 'Shop now',
            isEmail: true
        });
        expect(ruleIds(found)).toContain('IMG002');
    });

    it('stays quiet once there is enough copy', () => {
        const found = checkImages({
            images: [{ label: 'hero.png', hasAlt: true, linked: false }],
            visibleText: 'x'.repeat(200),
            isEmail: true
        });
        expect(ruleIds(found)).not.toContain('IMG002');
    });

    it('does not apply the ratio check to a reusable block', () => {
        // A block is a fragment by definition — an image-only block is entirely normal.
        const found = checkImages({
            images: [{ label: 'hero.png', hasAlt: true, linked: false }],
            visibleText: '',
            isEmail: false
        });
        expect(ruleIds(found)).not.toContain('IMG002');
    });
});

describe('checkSubjectQuality', () => {
    const ctx = (subject) => ({ body: { subject }, isEmail: true });

    it('accepts a short, plain subject', () => {
        expect(checkSubjectQuality(ctx('Spring sale starts today'))).toEqual([]);
    });

    it('warns when the subject is far too long', () => {
        expect(ruleIds(checkSubjectQuality(ctx('a '.repeat(60))))).toContain('SUB001');
    });

    it('warns about an unguarded merge field in the subject', () => {
        const found = checkSubjectQuality(ctx('Hi {{FirstName}}, your order shipped'));
        const sub002 = found.find((f) => f.rule === 'SUB002');
        expect(sub002.locations).toEqual(['{{FirstName}}']);
    });

    it('accepts a merge field wrapped in fallback', () => {
        const found = checkSubjectQuality(ctx('Hi {{fallback FirstName "there"}}'));
        expect(ruleIds(found)).not.toContain('SUB002');
    });

    it('notes shouted subjects', () => {
        expect(ruleIds(checkSubjectQuality(ctx('URGENT offer inside!!!')))).toContain('SUB003');
    });

    it('says nothing for a reusable block, which has no subject', () => {
        expect(checkSubjectQuality({ body: { subject: 'x'.repeat(300) }, isEmail: false })).toEqual([]);
    });

    it('leaves an empty subject to checkContentBasics', () => {
        expect(checkSubjectQuality(ctx(''))).toEqual([]);
    });

    it('warns when the preheader just repeats the subject', () => {
        const found = checkSubjectQuality({
            body: { subject: 'Spring sale starts today', preheader: 'Spring sale starts today.' },
            isEmail: true
        });
        expect(ruleIds(found)).toContain('SUB005');
    });

    it('accepts a preheader that adds something', () => {
        const found = checkSubjectQuality({
            body: { subject: 'Spring sale starts today', preheader: 'Up to 40% off until Sunday' },
            isEmail: true
        });
        expect(ruleIds(found)).not.toContain('SUB005');
    });
});

describe('checkMigration', () => {
    it('says nothing for native MCN content', () => {
        expect(checkMigration({ strings: ['Hi {{fallback FirstName "there"}}'] })).toEqual([]);
    });

    it('errors on an MCE substitution string', () => {
        const found = checkMigration({ strings: ['<p>Hi %%FirstName%%</p>'] });
        const mig001 = found.find((f) => f.rule === 'MIG001');
        expect(mig001.severity).toBe(SEVERITY.ERROR);
        expect(mig001.locations).toEqual(['%%FirstName%%']);
    });

    it('dedupes a substitution used repeatedly', () => {
        const found = checkMigration({ strings: ['%%FirstName%%', 'again %%FirstName%%'] });
        expect(found[0].locations).toEqual(['%%FirstName%%']);
    });

    it('leaves AMPscript blocks and inline AMPscript to checkAmpscript', () => {
        // Those forms are legitimate in MCN for Marketing Object lookups and Smart Blocks, so
        // reporting them here as dead syntax would be wrong.
        expect(ruleIds(checkMigration({ strings: ['%%[ IF x ]%%', '%%=v(@a)=%%'] }))).not.toContain('MIG001');
    });

    it('errors on a hardcoded MCE tracking domain', () => {
        const found = checkMigration({ strings: ['<a href="http://click.exacttarget.com/x">Go</a>'] });
        expect(ruleIds(found)).toContain('MIG002');
    });

    it('errors on AMPscript URL helpers', () => {
        expect(ruleIds(checkMigration({ strings: ['%%=RedirectTo(@url)=%%'] }))).toContain('MIG002');
    });
});

describe('checkPlaceholderCopy', () => {
    it('says nothing for finished copy', () => {
        expect(checkPlaceholderCopy({ strings: ['<p>Our spring sale starts today.</p>'] })).toEqual([]);
    });

    it('warns rather than errors — it is embarrassing, not deal-breaking', () => {
        const found = checkPlaceholderCopy({ strings: ['<p>Lorem ipsum dolor sit amet</p>'] });
        expect(found[0].rule).toBe('TXT001');
        expect(found[0].severity).toBe(SEVERITY.WARNING);
        expect(found[0].locations[0]).toBe('Lorem ipsum dolor sit amet — body copy');
    });

    it('catches the editor default prompts', () => {
        expect(ruleIds(checkPlaceholderCopy({ strings: ['Your text here'] }))).toContain('TXT001');
        expect(ruleIds(checkPlaceholderCopy({ strings: ['TBD'] }))).toContain('TXT001');
    });

    it('names where each piece of starter copy lives', () => {
        const found = checkPlaceholderCopy({
            body: {
                subjectLine: 'Build an Email!',
                preheader: 'Customize this draft with your own content.'
            },
            strings: [
                'Customize this draft with your own content.',
                'Build an Email!',
                "<p>Let's build an email.</p>"
            ]
        });
        expect(found[0].locations).toEqual([
            'Customize this draft with your own content. — preheader',
            'Build an Email! — subject line',
            "Let's build an email. — body copy"
        ]);
    });

    it('leaves "build an email" alone when it is part of a real sentence', () => {
        // Anchored on purpose: as a whole subject it is template default, mid-sentence it is
        // ordinary English that an email-marketing customer would legitimately write.
        expect(checkPlaceholderCopy({
            strings: ['<p>In this guide we show you how to build an email in five minutes.</p>']
        })).toEqual([]);
    });

    it('does not fire on ordinary words that merely contain a pattern', () => {
        expect(checkPlaceholderCopy({ strings: ['Our tailored service is here for you'] })).toEqual([]);
    });

    // A bracket in the subject is the worst place for one — it is the first thing the recipient
    // reads and the last place anyone thinks to look, because it is not on the canvas.
    it('names the subject line and the preheader when a bracket sits in one', () => {
        const found = checkPlaceholderCopy({
            body: {
                subjectLine: 'Save on [Product Name] this week',
                preheader: 'Offer ends [Date]'
            },
            strings: ['Save on [Product Name] this week', 'Offer ends [Date]']
        });
        const txt002 = found.find((f) => f.rule === 'TXT002');
        expect(txt002.locations).toEqual([
            '[Product Name] — subject line',
            '[Date] — preheader'
        ]);
    });

    // The starter templates phrase their placeholders as directions, not as field names, so a
    // field-word test alone walks past the single most common case there is.
    it('catches an instruction-style placeholder with no field word in it', () => {
        const found = checkPlaceholderCopy({
            body: { subjectLine: 'Free Guide: [Your Topic]' },
            strings: ['Free Guide: [Your Topic]']
        });
        const txt002 = found.find((f) => f.rule === 'TXT002');
        expect(txt002.locations).toEqual(['[Your Topic] — subject line']);
    });

    it('catches the other ways a placeholder is written as an instruction', () => {
        const ids = (s) => ruleIds(checkPlaceholderCopy({ strings: [s] }));
        expect(ids('Book now — [Insert Offer]')).toContain('TXT002');
        expect(ids('Read more [enter link]')).toContain('TXT002');
        expect(ids('Ships on [TBD]')).toContain('TXT002');
    });

    // Brackets are a real subject-line convention. Flagging every one of them would put a finding
    // on emails doing nothing wrong, which is how a tool loses its reader.
    it('leaves bracketed phrases that are ordinary writing alone', () => {
        const ids = (s) => ruleIds(checkPlaceholderCopy({ strings: [s] }));
        expect(ids('[Webinar] Join us on Tuesday')).not.toContain('TXT002');
        expect(ids('[Update] The venue has changed')).not.toContain('TXT002');
        expect(ids('See the chart [1] for details')).not.toContain('TXT002');
    });
});

describe('checkMcnQuirks', () => {
    it('says nothing when the email has no button components', () => {
        expect(checkMcnQuirks({ buttonComponents: [] })).toEqual([]);
    });

    // A note, and permanently so: the content is correct and the platform is not, so there is
    // nothing here for the author to fix — only something to decide.
    it('notes the Outlook button spacing quirk, with the workaround', () => {
        const found = checkMcnQuirks({ buttonComponents: ["Button 'Shop now' in Section 2 of 4"] });
        expect(found).toHaveLength(1);
        expect(found[0].rule).toBe('MCN001');
        expect(found[0].severity).toBe(SEVERITY.INFO);
        expect(found[0].detail).toContain('image');
        expect(found[0].locations).toEqual(["Button 'Shop now' in Section 2 of 4"]);
    });

    it('finds the button components in a real body and says where they are', () => {
        const body = emailBody([
            { definition: 'lightning/section', children: [htmlNode('<p>Hello</p>')] },
            {
                definition: 'lightning/section',
                children: [{ definition: 'lightning/actionButton', attributes: { text: 'Shop now', uri: 'https://a.com' } }]
            }
        ]);
        const found = runPreflight({ contentBody: body }).findings.find((f) => f.rule === 'MCN001');
        expect(found.locations[0]).toContain('Section 2 of 2');
    });

    // A linked image used as a button is the workaround. Telling somebody to apply it twice is
    // worse than saying nothing.
    it('ignores an image used as a button', () => {
        const body = emailBody([
            {
                definition: 'lightning/image',
                attributes: { linkUrl: 'https://a.com', imageInfo: { url: '/cms/media/X', altText: 'Shop now' } }
            }
        ]);
        expect(ruleIds(runPreflight({ contentBody: body }).findings)).not.toContain('MCN001');
    });
});

describe('checkContentBasics', () => {
    it('errors on a present-but-empty subject', () => {
        const found = checkContentBasics({ body: { subject: '' }, title: 'x', isEmail: true });
        expect(ruleIds(found)).toContain('CNT001');
    });

    it('does not error when the subject is filled in', () => {
        const found = checkContentBasics({ body: { subject: 'Spring sale' }, title: 'x', isEmail: true });
        expect(ruleIds(found)).not.toContain('CNT001');
    });

    // Deleting the field in the builder removes the key outright rather than blanking it, so an
    // absent key has to raise the same error a blank one does. Reporting it as a lesser finding
    // means clearing the subject line produces no error, which is the one case the rule exists for.
    it('errors when the subject key is absent entirely', () => {
        const found = checkContentBasics({ body: { other: 'x' }, title: 'x', isEmail: true });
        const err = found.find((f) => f.rule === 'CNT001');
        expect(err.severity).toBe(SEVERITY.ERROR);
    });

    it('warns on an empty preheader', () => {
        const found = checkContentBasics({
            body: { subject: 'Hi', preheader: '' },
            title: 'x',
            isEmail: true
        });
        expect(ruleIds(found)).toContain('CNT003');
    });

    it('warns when the preheader key is absent entirely', () => {
        const found = checkContentBasics({ body: { subject: 'Hi' }, title: 'x', isEmail: true });
        expect(ruleIds(found)).toContain('CNT003');
    });

    it('says nothing about the preheader once it is filled in', () => {
        const found = checkContentBasics({
            body: { subject: 'Hi', preheader: 'Up to 40% off' },
            title: 'x',
            isEmail: true
        });
        expect(ruleIds(found)).not.toContain('CNT003');
    });

    it('notes a preheader longer than the inbox will show', () => {
        const found = checkContentBasics({
            body: { subject: 'Hi', preheader: 'x'.repeat(PREHEADER_MAX_RECOMMENDED + 1) },
            title: 'x',
            isEmail: true
        });
        const cnt006 = found.find((f) => f.rule === 'CNT006');
        expect(cnt006.severity).toBe(SEVERITY.INFO);
    });

    it('errors when the asset name exceeds the platform limit', () => {
        const found = checkContentBasics({
            body: { subject: 'Hi' },
            title: 'x'.repeat(EMAIL_NAME_MAX + 1),
            isEmail: true
        });
        expect(ruleIds(found)).toContain('CNT004');
    });

    it('skips the email-only checks for a reusable block, which has neither field', () => {
        const found = checkContentBasics({ body: { other: 1 }, title: 'x', isEmail: false });
        expect(ruleIds(found)).not.toContain('CNT001');
        expect(ruleIds(found)).not.toContain('CNT003');
    });

    it('warns about markup mail clients strip, naming each kind once', () => {
        const found = checkContentBasics({
            body: { subject: 'Hi' },
            title: 'x',
            isEmail: true,
            strings: ['<script>go()</script>', '<a href="#" onclick="go()">x</a>', '<script>b()</script>']
        });
        const cnt005 = found.find((f) => f.rule === 'CNT005');
        expect(cnt005.locations).toEqual(['<script>', 'inline event handler (onclick=, onload=, ...)']);
    });

    it('does not mistake an ordinary attribute for an event handler', () => {
        const found = checkContentBasics({
            body: { subject: 'Hi' },
            title: 'x',
            isEmail: true,
            strings: ['<div hidden="hidden" data-tracking-block="true">x</div>']
        });
        expect(ruleIds(found)).not.toContain('CNT005');
    });
});

describe('checkRcbCompatibility', () => {
    it('says nothing for an email', () => {
        expect(checkRcbCompatibility({ body: {}, strings: ['{{#each x}}{{/each}}'], isRcb: false })).toEqual([]);
    });

    it('flags a repeater inside a reusable block', () => {
        const body = emailBody([{ definition: 'lightning/repeater' }]);
        const found = checkRcbCompatibility({ body, strings: [], isRcb: true });
        expect(ruleIds(found)).toContain('RCB001');
    });

    it('flags product recommendations inside a reusable block', () => {
        const body = emailBody([{ definition: 'lightning/productRecommendation' }]);
        const found = checkRcbCompatibility({ body, strings: [], isRcb: true });
        expect(ruleIds(found)).toContain('RCB002');
    });

    it('warns about deeply nested scripting in a reusable block', () => {
        const found = checkRcbCompatibility({
            body: {},
            strings: ['{{#each r}}{{#if a}}{{#unless b}}x{{/unless}}{{/if}}{{/each}}'],
            isRcb: true
        });
        const rcb004 = found.find((f) => f.rule === 'RCB004');
        expect(rcb004.severity).toBe(SEVERITY.WARNING);
    });

    it('accepts ordinary single-level scripting in a reusable block', () => {
        const found = checkRcbCompatibility({ body: {}, strings: ['{{#if a}}x{{/if}}'], isRcb: true });
        expect(ruleIds(found)).not.toContain('RCB004');
    });
});

describe('data provider and background collection', () => {
    it('reads providers from the real lightning:dataProviders shape', () => {
        const body = {
            'lightning:dataProviders': [
                {
                    definition: 'sfdc_cms__dataGraphDataProvider',
                    sfdcExpressionKey: '$dataGraph',
                    attributes: { dataGraphApiName: 'RyanDemoFinal', dataspace: 'default' }
                }
            ]
        };
        expect(collectDataProviders(body)).toEqual([
            { definition: 'sfdc_cms__dataGraphDataProvider', dataGraph: 'RyanDemoFinal', expressionKey: '$dataGraph' }
        ]);
    });

    it('reports no providers for content that has none', () => {
        expect(collectDataProviders(emailBody([htmlNode('<p>hi</p>')]))).toEqual([]);
    });

    it('ignores background styling when no image is actually set', () => {
        // Every section carries these three keys whether or not an image was chosen.
        const body = emailBody([
            {
                definition: 'lightning/section',
                attributes: {
                    'lightning:backgroundImage': { position: 'center center', repeat: 'no-repeat', size: 'cover' }
                }
            }
        ]);
        expect(collectBackgroundImages(body)).toEqual([]);
    });

    it('finds a section that does have a background image', () => {
        const body = emailBody([
            {
                definition: 'lightning/section',
                attributes: {
                    'lightning:backgroundImage': {
                        size: 'cover',
                        source: { ref: { contentKey: 'MCJX4LL4ZSVNHALNTPQEVK3NF77U' } }
                    }
                }
            }
        ]);
        expect(collectBackgroundImages(body)).toEqual(['Section']);
    });
});

describe('maxBlockDepth', () => {
    it('counts nesting rather than total blocks', () => {
        expect(maxBlockDepth('{{#if a}}x{{/if}}{{#if b}}y{{/if}}')).toBe(1);
        expect(maxBlockDepth('{{#each r}}{{#if a}}{{#unless b}}x{{/unless}}{{/if}}{{/each}}')).toBe(3);
    });

    it('is zero for content with no blocks', () => {
        expect(maxBlockDepth('Hello {{name}}')).toBe(0);
    });
});

describe('layout collection', () => {
    it('reads both spacing shapes the builder uses on the same key', () => {
        expect(readSpacing('{!$brand.spacing.none}')).toEqual({ token: '{!$brand.spacing.none}' });
        expect(readSpacing({ top: { unit: 'px', value: 32 }, left: { unit: 'px', value: 16 } })).toEqual({
            sides: { top: { value: 32, unit: 'px' }, left: { value: 16, unit: 'px' } }
        });
    });

    it('returns nothing for an unset or unrecognised spacing value', () => {
        expect(readSpacing(undefined)).toBeNull();
        expect(readSpacing('')).toBeNull();
        expect(readSpacing({ top: 'nonsense' })).toBeNull();
    });

    it('pairs each style bundle with its component name', () => {
        const body = emailBody([
            {
                definition: 'lightning/section',
                attributes: {
                    'lightning:padding': { left: { unit: 'px', value: 16 }, right: { unit: 'px', value: 16 } },
                    'lightning:colorGroup': { textColor: '{!$brand.a}', backgroundColor: '{!$brand.b}' }
                }
            }
        ]);
        const nodes = collectLayoutNodes(body);
        expect(nodes).toHaveLength(1);
        expect(nodes[0].label).toBe('Section');
        expect(nodes[0].type).toBe('Section');
        expect(nodes[0].colors.textColor).toBe('{!$brand.a}');
    });

    it('treats a row as columns only when every child is one', () => {
        const columns = emailBody([
            {
                definition: 'lightning/section',
                attributes: { stackOnMobile: true },
                children: [
                    { attributes: { columnWidth: 6 } },
                    { attributes: { columnWidth: 6 } }
                ]
            }
        ]);
        expect(collectColumnGroups(columns)).toEqual([
            { label: 'Section', widths: [6, 6], stacksOnMobile: true }
        ]);

        // Mixed content is not a column row and must not be measured against the grid.
        const mixed = emailBody([
            { definition: 'lightning/section', children: [{ attributes: { columnWidth: 6 } }, htmlNode('<p>x</p>')] }
        ]);
        expect(collectColumnGroups(mixed)).toEqual([]);
    });
});

describe('checkLayout', () => {
    const layout = (nodes, groups = []) => ({ layoutNodes: nodes, columnGroups: groups });

    it('says nothing about a well-formed layout', () => {
        const nodes = [
            {
                label: 'lightning/section',
                padding: { sides: { left: { value: 16, unit: 'px' }, right: { value: 16, unit: 'px' } } },
                margin: null,
                colors: { textColor: '{!$brand.contrast}', backgroundColor: '{!$brand.root}', linkColor: '{!$brand.accent}' },
                typography: { lineHeight: 1.5, fontSize: '{!$brand.fontSize.medium}' },
                imageWidth: null
            }
        ];
        const groups = [{ label: 'lightning/section', widths: [6, 6], stacksOnMobile: true }];
        expect(checkLayout(layout(nodes, groups))).toEqual([]);
    });

    it('errors when a column row does not total the grid', () => {
        const found = checkLayout(layout([], [{ label: 'row', widths: [6, 4], stacksOnMobile: true }]));
        expect(found[0].rule).toBe('RND001');
        expect(found[0].severity).toBe(SEVERITY.ERROR);
        expect(found[0].locations[0]).toBe('row: 6 + 4 = 10');
    });

    it('accepts a single full-width column', () => {
        expect(ruleIds(checkLayout(layout([], [{ label: 'row', widths: [12], stacksOnMobile: true }]))))
            .not.toContain('RND001');
    });

    it('warns when a multi-column row will not stack on mobile', () => {
        const found = checkLayout(layout([], [{ label: 'row', widths: [6, 6], stacksOnMobile: false }]));
        expect(ruleIds(found)).toContain('RND002');
    });

    it('does not ask a single column to stack', () => {
        const found = checkLayout(layout([], [{ label: 'row', widths: [12], stacksOnMobile: false }]));
        expect(ruleIds(found)).not.toContain('RND002');
    });

    it('warns about uneven horizontal spacing', () => {
        const nodes = [{
            label: 'lightning/column',
            padding: { sides: { left: { value: 32, unit: 'px' }, right: { value: 16, unit: 'px' } } },
            margin: null, colors: null, typography: null, imageWidth: null
        }];
        const found = checkLayout(layout(nodes));
        expect(found[0].rule).toBe('RND003');
        expect(found[0].locations[0]).toBe('lightning/column: padding left 32px, right 16px');
    });

    it('warns when one box mixes spacing units', () => {
        const nodes = [{
            label: 'lightning/section',
            padding: { sides: { left: { value: 5, unit: '%' }, right: { value: 16, unit: 'px' } } },
            margin: null, colors: null, typography: null, imageWidth: null
        }];
        expect(ruleIds(checkLayout(layout(nodes)))).toContain('RND008');
    });

    // `type` is what selects a section here, not the label — every component inside one now carries
    // "in Section 2 of 4" in its label, and a substring match would sweep those up.
    const paddedSection = (n, px, total = 3) => ({
        label: `Section ${n} of ${total} — "some copy"`,
        place: `Section ${n} of ${total}`,
        type: 'Section',
        padding: { sides: { left: { value: px, unit: 'px' }, right: { value: px, unit: 'px' } } },
        margin: null, colors: null, typography: null, imageWidth: null
    });

    it('names the sections on each side of a spacing mismatch', () => {
        const found = checkLayout(layout([paddedSection(1, 0, 2), paddedSection(2, 16, 2)]));
        const rnd004 = found.find((f) => f.rule === 'RND004');
        expect(rnd004.severity).toBe(SEVERITY.INFO);
        expect(rnd004.locations).toEqual(['0px — Section 1 of 2', '16px — Section 2 of 2']);
    });

    it('groups the sections that agree so the odd one out stands alone', () => {
        // The whole point of the finding: three sections at 30px and one at 100px should make the
        // fourth obviously the outlier, rather than listing "30px" and "100px" with no owners.
        const found = checkLayout(layout([
            paddedSection(1, 30, 4), paddedSection(2, 30, 4),
            paddedSection(3, 30, 4), paddedSection(4, 100, 4)
        ]));
        const rnd004 = found.find((f) => f.rule === 'RND004');
        expect(rnd004.locations).toEqual([
            '30px — Section 1 of 4, Section 2 of 4, Section 3 of 4',
            '100px — Section 4 of 4'
        ]);
    });

    it('caps a long list of sections rather than printing all of them', () => {
        const nodes = [1, 2, 3, 4, 5, 6].map((n) => paddedSection(n, 30, 7));
        nodes.push(paddedSection(7, 100, 7));
        const rnd004 = checkLayout(layout(nodes)).find((f) => f.rule === 'RND004');
        expect(rnd004.locations[0]).toBe(
            '30px — Section 1 of 7, Section 2 of 7, Section 3 of 7, Section 4 of 7 and 2 more'
        );
    });

    it('says nothing when every section agrees', () => {
        const found = checkLayout(layout([paddedSection(1, 30, 2), paddedSection(2, 30, 2)]));
        expect(ruleIds(found)).not.toContain('RND004');
    });

    it('does not treat a component inside a section as a section', () => {
        const inSection = (px) => ({
            label: `Button in Section ${px}`,
            place: `Button in Section ${px}`,
            type: 'Button',
            padding: { sides: { left: { value: px, unit: 'px' }, right: { value: px, unit: 'px' } } },
            margin: null, colors: null, typography: null, imageWidth: null
        });
        const found = checkLayout(layout([inSection(0), inSection(16)]));
        expect(ruleIds(found)).not.toContain('RND004');
    });

    it('notes spacing that is part brand-managed and part hardcoded', () => {
        const nodes = [
            { label: 'a', padding: { token: '{!$brand.spacing.none}' }, margin: null, colors: null, typography: null, imageWidth: null },
            { label: 'b', padding: { sides: { top: { value: 32, unit: 'px' } } }, margin: null, colors: null, typography: null, imageWidth: null }
        ];
        expect(ruleIds(checkLayout(layout(nodes)))).toContain('RND007');
    });

    it('stays quiet when every component uses brand tokens', () => {
        const nodes = [
            { label: 'a', padding: { token: '{!$brand.spacing.none}' }, margin: null, colors: null, typography: null, imageWidth: null },
            { label: 'b', padding: { token: '{!$brand.spacing.small}' }, margin: null, colors: null, typography: null, imageWidth: null }
        ];
        expect(ruleIds(checkLayout(layout(nodes)))).not.toContain('RND007');
    });

    it('errors on text the same colour as its background, comparing tokens unresolved', () => {
        const nodes = [{
            label: 'lightning/text', padding: null, margin: null,
            colors: { textColor: '{!$brand.colorScheme.root}', backgroundColor: '{!$brand.colorScheme.root}' },
            typography: null, imageWidth: null
        }];
        const found = checkLayout(layout(nodes));
        const rnd005 = found.find((f) => f.rule === 'RND005');
        expect(rnd005.severity).toBe(SEVERITY.ERROR);
    });

    it('warns when links are the same colour as body text', () => {
        const nodes = [{
            label: 'lightning/text', padding: null, margin: null,
            colors: { textColor: '{!$brand.a}', linkColor: '{!$brand.a}', backgroundColor: '{!$brand.b}' },
            typography: null, imageWidth: null
        }];
        expect(ruleIds(checkLayout(layout(nodes)))).toContain('RND006');
    });

    it('names where each link colour is used', () => {
        const linked = (place, hex) => ({
            label: `${place} — "Read more"`, place, padding: null, margin: null,
            colors: { linkColor: hex }, typography: null, imageWidth: null
        });
        const found = checkLayout(layout([
            linked('Section 1 of 3', '#0176D3'),
            linked('Section 2 of 3', '#0176d3'),
            linked('Button in Section 3 of 3', '#00A1E0')
        ]));
        const rnd013 = found.find((f) => f.rule === 'RND013');
        expect(rnd013.locations).toEqual([
            '#0176d3 — Section 1 of 3, Section 2 of 3',
            '#00a1e0 — Button in Section 3 of 3'
        ]);
    });

    it('leaves brand link colours alone, however many there are', () => {
        // Two different brand TOKENS are a deliberate choice and cannot be compared without
        // resolving them. Only typed-in hex values are the "styled on different days" problem.
        const branded = (place, token) => ({
            label: place, place, padding: null, margin: null,
            colors: { linkColor: token }, typography: null, imageWidth: null
        });
        const found = checkLayout(layout([
            branded('Section 1 of 2', '{!$brand.colorScheme.primaryAccent}'),
            branded('Section 2 of 2', '{!$brand.colorScheme.secondaryAccent}')
        ]));
        expect(ruleIds(found)).not.toContain('RND013');
    });

    it('warns about cramped line height and tiny literal font sizes', () => {
        const nodes = [{
            label: 'lightning/text', padding: null, margin: null, colors: null,
            typography: { lineHeight: 1, fontSize: '11px' }, imageWidth: null
        }];
        expect(ruleIds(checkLayout(layout(nodes))).sort()).toEqual(['RND009', 'RND010']);
    });

    it('does not guess at a font size expressed as a brand token', () => {
        const nodes = [{
            label: 'lightning/text', padding: null, margin: null, colors: null,
            typography: { lineHeight: 1.5, fontSize: '{!$brand.fontSize.xSmall}' }, imageWidth: null
        }];
        expect(ruleIds(checkLayout(layout(nodes)))).not.toContain('RND010');
    });

    it('warns about an image wider than its container', () => {
        const nodes = [{
            label: 'lightning/image', padding: null, margin: null, colors: null, typography: null,
            imageWidth: { unit: '%', value: 120 }
        }];
        expect(ruleIds(checkLayout(layout(nodes)))).toContain('RND011');
    });

    it('accepts an image at or under full width', () => {
        const nodes = [{
            label: 'lightning/image', padding: null, margin: null, colors: null, typography: null,
            imageWidth: { unit: '%', value: 45 }
        }];
        expect(ruleIds(checkLayout(layout(nodes)))).not.toContain('RND011');
    });

    it('warns about a word too long to wrap', () => {
        const found = checkLayout({
            visibleText: 'Read it at https://shop.example.com/spring-sale-2026/womens-outerwear/waterproof'
        });
        const rnd012 = found.find((f) => f.rule === 'RND012');
        expect(rnd012).toBeDefined();
        expect(rnd012.locations[0]).toContain('characters');
    });

    it('accepts ordinary prose', () => {
        const found = checkLayout({ visibleText: 'Our spring sale starts today and runs until Sunday.' });
        expect(ruleIds(found)).not.toContain('RND012');
    });

    it('tolerates a context with no layout data at all', () => {
        expect(checkLayout({})).toEqual([]);
    });
});

describe('checkOutlookRendering', () => {
    it('says nothing for content with no background image or Outlook markup', () => {
        expect(checkOutlookRendering({ backgroundImages: [], strings: ['<p>hi</p>'] })).toEqual([]);
    });

    it('warns that a background image will not render in Outlook', () => {
        const found = checkOutlookRendering({ backgroundImages: ['lightning/section'], strings: [] });
        expect(found[0].rule).toBe('OL001');
        expect(found[0].severity).toBe(SEVERITY.WARNING);
    });

    it.each([
        ['an mso conditional comment', '<!--[if gte mso 9]><v:rect><![endif]-->'],
        ['a VML tag', '<v:fill type="frame" src="hero.png" />'],
        ['a VML namespace declaration', '<html xmlns:v="urn:schemas-microsoft-com:vml">']
    ])('warns that %s will be stripped', (_label, html) => {
        const found = checkOutlookRendering({ backgroundImages: [], strings: [html] });
        expect(ruleIds(found)).toContain('MSO001');
    });

    it('does not mistake ordinary markup for VML', () => {
        const found = checkOutlookRendering({
            backgroundImages: [],
            strings: ['<div class="video-wrapper"><p>Watch</p></div>']
        });
        expect(ruleIds(found)).not.toContain('MSO001');
    });
});

describe('checkDataProviders', () => {
    const graphProvider = {
        definition: 'sfdc_cms__dataGraphDataProvider',
        dataGraph: 'RyanDemoFinal',
        expressionKey: '$dataGraph'
    };

    it('says nothing for plain content with no personalization', () => {
        expect(checkDataProviders({ dataProviders: [], strings: ['<p>hi</p>'], bareVariables: [] })).toEqual([]);
    });

    it('does not demand a provider for a variable the content sets itself', () => {
        // {{varRegion}} resolves from the email's own {{set}} block — no Data Graph involved.
        const found = checkDataProviders({
            dataProviders: [],
            strings: ['{{set "varRegion" "region=north"}}', '<a href="https://a.com?{{varRegion}}">Shop</a>'],
            bareVariables: ['varRegion']
        });
        expect(ruleIds(found)).not.toContain('DP001');
    });

    it('errors when personalization has nothing to resolve against', () => {
        const found = checkDataProviders({
            dataProviders: [],
            strings: ['Hi {{DataGraph.Individual.FirstName}}'],
            bareVariables: []
        });
        expect(found[0].rule).toBe('DP001');
        expect(found[0].severity).toBe(SEVERITY.ERROR);
    });

    it('is satisfied once a provider is attached', () => {
        const found = checkDataProviders({
            dataProviders: [graphProvider],
            strings: ['Hi {{DataGraph.Individual.FirstName}}'],
            bareVariables: []
        });
        expect(ruleIds(found)).not.toContain('DP001');
    });

    it('errors on product recommendations with no Data Graph provider', () => {
        const found = checkDataProviders({
            dataProviders: [],
            strings: [],
            bareVariables: [],
            definitions: ['lightning/productRecommendation']
        });
        expect(ruleIds(found)).toContain('DP002');
    });

    it('accepts product recommendations once a Data Graph is attached', () => {
        const found = checkDataProviders({
            dataProviders: [graphProvider],
            strings: [],
            bareVariables: [],
            definitions: ['lightning/productRecommendation']
        });
        expect(ruleIds(found)).not.toContain('DP002');
    });

    it('warns about an Apex provider only inside a reusable block', () => {
        const apex = { definition: 'sfdc_cms__apexDataProvider', dataGraph: '', expressionKey: '$apex' };
        expect(ruleIds(checkDataProviders({ dataProviders: [apex], strings: [], bareVariables: [], isRcb: true })))
            .toContain('DP003');
        expect(ruleIds(checkDataProviders({ dataProviders: [apex], strings: [], bareVariables: [], isRcb: false })))
            .not.toContain('DP003');
    });

    it('notes more than one attached Data Graph', () => {
        const second = { definition: 'sfdc_cms__dataGraphDataProvider', dataGraph: 'Other', expressionKey: '$b' };
        const found = checkDataProviders({
            dataProviders: [graphProvider, second],
            strings: [],
            bareVariables: []
        });
        const dp004 = found.find((f) => f.rule === 'DP004');
        expect(dp004.locations).toEqual(['RyanDemoFinal', 'Other']);
    });
});

describe('checkDynamicContent', () => {
    it('says nothing when there are no variations', () => {
        expect(checkDynamicContent({ body: emailBody([htmlNode('<p>x</p>')]) })).toEqual([]);
    });

    it('warns when variations are present', () => {
        const body = emailBody([{ definition: 'lightning/text', variations: [{ id: 1 }] }]);
        expect(ruleIds(checkDynamicContent({ body }))).toEqual(['DG001']);
    });

    it('ignores an empty variations array', () => {
        const body = emailBody([{ definition: 'lightning/text', variations: [] }]);
        expect(checkDynamicContent({ body })).toEqual([]);
    });
});

describe('checkVariables', () => {
    it('warns about a variable nothing defines', () => {
        const found = checkVariables({ strings: ['Hello {{firstName}}'] });
        expect(ruleIds(found)).toEqual(['VAR001']);
        expect(found[0].locations).toEqual(['firstName']);
    });

    it('stays quiet when the variable is defined by a local {{set}}', () => {
        expect(checkVariables({ strings: ['{{set "varRegion" "a=b"}}', '{{varRegion}}'] })).toEqual([]);
    });

    it('notes a variable that is set and then never referenced', () => {
        const found = checkVariables({ strings: ['{{set "oldName" "a=b"}}'] });
        const var002 = found.find((f) => f.rule === 'VAR002');
        expect(var002.severity).toBe(SEVERITY.INFO);
        expect(var002.locations).toEqual(['oldName']);
    });

    it('does not treat the {{set}} declaration itself as a use', () => {
        // The declaration contains the name; only a reference OUTSIDE it counts.
        expect(ruleIds(checkVariables({ strings: ['{{set "x" "1"}}'] }))).toContain('VAR002');
    });

    it('counts a percent-encoded reference in a URL as a use', () => {
        const found = checkVariables({
            strings: ['{{set "varRegion" "a=b"}}', 'https://a.com?%7B%7BvarRegion%7D%7D']
        });
        expect(ruleIds(found)).not.toContain('VAR002');
    });

    it('notes a variable set more than once', () => {
        const found = checkVariables({
            strings: ['{{set "varRegion" "a=b"}}', '{{set "varRegion" "c=d"}}', '{{varRegion}}']
        });
        const var003 = found.find((f) => f.rule === 'VAR003');
        expect(var003.locations).toEqual(['varRegion (set 2 times)']);
    });

    it('errors on a reference that differs only in its capitals', () => {
        const found = checkVariables({ strings: ['{{set "varRegion" "a=b"}}', '{{varregion}}'] });
        const var004 = found.find((f) => f.rule === 'VAR004');
        expect(var004.severity).toBe(SEVERITY.ERROR);
        expect(var004.locations[0]).toContain('varregion');
        expect(var004.locations[0]).toContain('varRegion');
    });

    // VAR001's advice is "check it is supplied at send time", which is the wrong instruction for a
    // typo — there is nothing to supply, the two spellings just have to match.
    it('does not also report a miscased name as undefined', () => {
        const found = checkVariables({ strings: ['{{set "varRegion" "a=b"}}', '{{varregion}}'] });
        expect(ruleIds(found)).not.toContain('VAR001');
    });

    it('still reports a genuinely unknown name as undefined', () => {
        const found = checkVariables({ strings: ['{{set "varRegion" "a=b"}}', '{{varRegion}} {{other}}'] });
        expect(ruleIds(found)).toContain('VAR001');
        expect(ruleIds(found)).not.toContain('VAR004');
    });
});

describe('checkAmpscript', () => {
    it('says nothing for pure Handlebars content', () => {
        expect(checkAmpscript({ strings: ['{{firstName}}'] })).toEqual([]);
    });

    it('notes AMPscript without calling it an error', () => {
        const found = checkAmpscript({ strings: ['%%[ IF 0 == 1 THEN ]%%'] });
        expect(found[0].rule).toBe('AMP001');
        expect(found[0].severity).toBe(SEVERITY.INFO);
    });
});

describe('collectEmbeddedBlocks', () => {
    const sectionNode = (children) => ({ definition: 'lightning/section', children });

    it('finds nothing in an email that embeds nothing', () => {
        expect(collectEmbeddedBlocks(emailBody([sectionNode([{ definition: 'lightning/paragraph' }])]))).toEqual([]);
    });

    it('recognises every confirmed reference name', () => {
        const body = emailBody([
            { definition: 'sfdc_cms/reusableContentBlock' },
            { definition: 'sfdc_cms__emailFragment' },
            { definition: 'sfdc_cms__webFragment' }
        ]);
        expect(collectEmbeddedBlocks(body)).toHaveLength(3);
    });

    it('says which component the block sits in', () => {
        const body = emailBody([
            sectionNode([{ definition: 'lightning/paragraph' }]),
            sectionNode([{ definition: 'sfdc_cms/reusableContentBlock' }])
        ]);
        expect(collectEmbeddedBlocks(body)[0].label).toContain('Section 2 of 2');
    });

    it('reads a reference stored under type rather than definition', () => {
        expect(collectEmbeddedBlocks(emailBody([{ type: 'contentReference' }]))).toHaveLength(1);
    });

    // Every email is wrapped in one of these. Matching it made the note fire on every email and
    // point at the email itself, which is worse than not having the rule.
    it('does not mistake the email own root container for an embedded block', () => {
        const body = { 'sfdc_cms:block': { definition: 'sfdc_cms/rootContentBlock', children: [] } };
        expect(collectEmbeddedBlocks(body)).toEqual([]);
    });

    it('still finds a real reference sitting inside that root container', () => {
        const body = {
            'sfdc_cms:block': {
                definition: 'sfdc_cms/rootContentBlock',
                children: [{ definition: 'sfdc_cms__emailFragment', contentKey: 'MCAKK1' }]
            }
        };
        const found = collectEmbeddedBlocks(body);
        expect(found).toHaveLength(1);
        expect(found[0].contentKey).toBe('MCAKK1');
    });

    // The content key is what identifies the block to open next, and what a resolver would look up.
    it('picks up the content key wherever the reference keeps it', () => {
        const shapes = [
            { definition: 'sfdc_cms__emailFragment', contentKey: 'MCAKK1' },
            { definition: 'sfdc_cms__emailFragment', attributes: { contentKey: 'MCAKK2' } },
            { definition: 'sfdc_cms__emailFragment', ref: { contentKey: 'MCAKK3' } },
            { definition: 'sfdc_cms__emailFragment', source: { ref: { contentKey: 'MCAKK4' } } }
        ];
        const keys = collectEmbeddedBlocks(emailBody(shapes)).map((b) => b.contentKey);
        expect(keys).toEqual(['MCAKK1', 'MCAKK2', 'MCAKK3', 'MCAKK4']);
    });

    // The shape a real embedded footer block turns out to use. There is no `contentKey` field on the
    // node at all — the key is the tail of an `@cms/...` pointer — so the resolver came away empty
    // and the note could not tell anyone which block to go and open.
    it('reads the key out of an @cms pointer, the shape the builder really writes', () => {
        const body = emailBody([
            {
                definition: 'sfdc_cms/reusableContentBlock',
                type: 'block',
                attributes: { content: { definition: '@cms/MCK263AR76UVCFPDIHIXUCFOYMMU', type: 'block' } }
            }
        ]);
        const found = collectEmbeddedBlocks(body);
        expect(found).toHaveLength(1);
        expect(found[0].contentKey).toBe('MCK263AR76UVCFPDIHIXUCFOYMMU');
    });

    it('calls the reference a reusable block rather than guessing from its container', () => {
        const body = emailBody([
            {
                definition: 'sfdc_cms/reusableContentBlock',
                attributes: { content: { definition: '@cms/MCK263', type: 'block' } }
            }
        ]);
        expect(collectEmbeddedBlocks(body)[0].label).toContain('Reusable block');
    });

    it('ignores a definition that only looks like a pointer', () => {
        const body = emailBody([
            { definition: 'sfdc_cms__emailFragment', attributes: { content: { definition: 'lightning/section' } } }
        ]);
        expect(collectEmbeddedBlocks(body)[0].contentKey).toBe('');
    });

    it('still reports a reference that carries no key', () => {
        const found = collectEmbeddedBlocks(emailBody([{ definition: 'sfdc_cms__emailFragment' }]));
        expect(found).toHaveLength(1);
        expect(found[0].contentKey).toBe('');
        expect(found[0].label).toBeTruthy();
    });

    // An image carries a CMS content key too, and calling every image an embedded block would make
    // the note meaningless on any email with pictures in it.
    it('does not mistake a CMS image for an embedded block', () => {
        const body = emailBody([
            {
                definition: 'lightning/image',
                attributes: { imageInfo: { altText: 'Hero', source: { ref: { contentKey: 'MC_A' } } } }
            }
        ]);
        expect(collectEmbeddedBlocks(body)).toEqual([]);
    });
});

describe('buildComponentTree', () => {
    const section = (children, extra = {}) => ({ definition: 'lightning/section', children, ...extra });
    const para = (text) => ({ definition: 'lightning/paragraph', attributes: { text } });

    /** Two sections, so describeOne numbers them "Section 1 of 2" and "Section 2 of 2". */
    const twoSections = () =>
        emailBody([section([para('Spring sale is here')]), section([para('Terms and conditions')])]);

    it('lists the top-level sections in document order', () => {
        const rows = buildComponentTree(twoSections(), []);
        expect(rows.map((r) => r.place)).toEqual(['Section 1 of 2', 'Section 2 of 2']);
        expect(rows.every((r) => r.kind === 'section')).toBe(true);
    });

    it('does not descend past a section into its components', () => {
        const rows = buildComponentTree(twoSections(), []);
        expect(rows).toHaveLength(2);
    });

    it('counts a finding against the section its location names', () => {
        const findings = [
            { rule: 'X1', severity: SEVERITY.ERROR, locations: ['Button "Shop" in Section 1 of 2'] },
            { rule: 'X2', severity: SEVERITY.WARNING, locations: ['Section 2 of 2 — "Terms"'] }
        ];
        const rows = buildComponentTree(twoSections(), findings);
        expect(rows[0].counts).toMatchObject({ error: 1, total: 1 });
        expect(rows[0].worst).toBe(SEVERITY.ERROR);
        expect(rows[1].counts).toMatchObject({ warning: 1, total: 1 });
        expect(rows[1].worst).toBe(SEVERITY.WARNING);
    });

    it('reports the worst severity in a section, not the last one seen', () => {
        const findings = [
            { rule: 'X1', severity: SEVERITY.INFO, locations: ['Section 1 of 2'] },
            { rule: 'X2', severity: SEVERITY.ERROR, locations: ['Section 1 of 2'] },
            { rule: 'X3', severity: SEVERITY.WARNING, locations: ['Section 1 of 2'] }
        ];
        expect(buildComponentTree(twoSections(), findings)[0].worst).toBe(SEVERITY.ERROR);
    });

    it('leaves a clean section with no severity at all', () => {
        const rows = buildComponentTree(twoSections(), [
            { rule: 'X1', severity: SEVERITY.ERROR, locations: ['Section 1 of 2'] }
        ]);
        expect(rows[1].counts.total).toBe(0);
        expect(rows[1].worst).toBe('');
    });

    // "No subject line" is a property of the email, and pinning it on a section would send someone
    // looking for it in the wrong place.
    it('collects unplaced findings into a whole-email row', () => {
        const rows = buildComponentTree(twoSections(), [
            { rule: 'CNT001', severity: SEVERITY.ERROR, locations: [] }
        ]);
        const global = rows.find((r) => r.kind === 'global');
        expect(global.counts.total).toBe(1);
    });

    it('omits the whole-email row when everything was placed', () => {
        const rows = buildComponentTree(twoSections(), [
            { rule: 'X1', severity: SEVERITY.ERROR, locations: ['Section 1 of 2'] }
        ]);
        expect(rows.some((r) => r.kind === 'global')).toBe(false);
    });

    // Sections disagreeing on padding is one finding about several places, and each of them is
    // somewhere you might go to fix it.
    it('counts a multi-section finding against every section it names', () => {
        const rows = buildComponentTree(twoSections(), [
            {
                rule: 'RND004',
                severity: SEVERITY.INFO,
                locations: ['30px — Section 1 of 2', '100px — Section 2 of 2']
            }
        ]);
        expect(rows[0].counts.total).toBe(1);
        expect(rows[1].counts.total).toBe(1);
        expect(rows.some((r) => r.kind === 'global')).toBe(false);
    });

    it('lists an embedded block without giving it a count', () => {
        const body = emailBody([
            section([para('Hello')]),
            {
                definition: 'sfdc_cms/reusableContentBlock',
                attributes: { content: { definition: '@cms/MCK263AR76UVCFPDIHIXUCFOYMMU' } }
            }
        ]);
        const block = buildComponentTree(body, []).find((r) => r.kind === 'block');
        expect(block).toBeDefined();
        expect(block.contentKey).toBe('MCK263AR76UVCFPDIHIXUCFOYMMU');
        expect(block.counts.total).toBe(0);
    });

    it('survives content with no sections at all', () => {
        expect(() => buildComponentTree(emailBody([para('hi')]), [])).not.toThrow();
        expect(buildComponentTree({}, [])).toEqual([]);
    });

    it('places findings correctly when there is only one section to place them in', () => {
        // describeOne drops the ordinal when there is nothing to tell apart, so the place is "Section".
        const body = emailBody([section([para('Only one here')])]);
        const rows = buildComponentTree(body, [
            { rule: 'X1', severity: SEVERITY.ERROR, locations: ['Image 1 of 2 in Section'] }
        ]);
        expect(rows[0].place).toBe('Section');
        expect(rows[0].counts.total).toBe(1);
    });
});

describe('blockNameOf', () => {
    it('returns nothing for the reference shape actually seen in the wild', () => {
        // Every real reference observed so far carries a pointer and a type, and no name at all.
        expect(blockNameOf({
            definition: 'sfdc_cms/reusableContentBlock',
            attributes: { content: { definition: '@cms/MCK263AR76UVCFPDIHIXUCFOYMMU', type: 'block' } }
        })).toBe('');
    });

    it('picks up a title if a reference ever carries one', () => {
        expect(blockNameOf({ 'sfdc_cms:title': 'Global Footer' })).toBe('Global Footer');
        expect(blockNameOf({ attributes: { masterLabel: 'Brand Header' } })).toBe('Brand Header');
    });

    it('prefers the most specific name when several are present', () => {
        expect(blockNameOf({ 'sfdc_cms:title': 'Global Footer', name: 'footer-v2' })).toBe('Global Footer');
    });

    // A key or a UUID printed as a name would read like a name and be useless as one.
    it('refuses identifiers that happen to sit under a name field', () => {
        expect(blockNameOf({ name: 'MCK263AR76UVCFPDIHIXUCFOYMMU' })).toBe('');
        expect(blockNameOf({ name: '7db2c26b-10b7-42e2-a5dd-9f152c7c8daa' })).toBe('');
        expect(blockNameOf({ name: '@cms/MCK263AR76UVCFPDIHIXUCFOYMMU' })).toBe('');
    });

    it('falls through an unusable name to a usable one', () => {
        expect(blockNameOf({ title: '  ', label: 'Legal Footer' })).toBe('Legal Footer');
    });
});

describe('checkBlockRole', () => {
    it('says nothing for an email, which is all three roles at once', () => {
        expect(checkBlockRole({ isRcb: false, roles: [] })).toEqual([]);
    });

    it('asks what the block is when nobody has said', () => {
        const found = checkBlockRole({ isRcb: true, roles: [] });
        expect(found[0].rule).toBe('BLK002');
        expect(found[0].severity).toBe(SEVERITY.INFO);
        expect(found[0].detail).toContain('Footer');
    });

    it('confirms that footer switched the compliance checks on', () => {
        const found = checkBlockRole({ isRcb: true, roles: [ROLE_FOOTER] });
        expect(found[0].rule).toBe('BLK003');
        expect(found[0].title).toBe('Checked as a footer block');
        expect(found[0].detail).toContain('switched the unsubscribe');
    });

    it('says the compliance checks stayed off for a header', () => {
        const found = checkBlockRole({ isRcb: true, roles: [ROLE_HEADER] });
        expect(found[0].detail).toContain('stayed off');
    });

    it('reads a combination as a list', () => {
        const found = checkBlockRole({ isRcb: true, roles: [ROLE_BODY, ROLE_FOOTER] });
        expect(found[0].title).toBe('Checked as a body / content and footer block');
    });

    it('ignores a role it does not recognise', () => {
        expect(checkBlockRole({ isRcb: true, roles: ['sidebar'] })[0].rule).toBe('BLK002');
    });

    it('always says the email-only rules are never run here', () => {
        for (const role of BLOCK_ROLES) {
            expect(checkBlockRole({ isRcb: true, roles: [role.id] })[0].detail).toContain('Subject line, preheader');
        }
    });
});

describe('checkEmbeddedBlocks', () => {
    it('says nothing when the email embeds nothing', () => {
        expect(checkEmbeddedBlocks({ body: emailBody([]), embeddedBlocks: [] })).toEqual([]);
    });

    const block = (label, contentKey = '') => ({ label, contentKey });

    it('reports the blocks as a note, not a problem', () => {
        const found = checkEmbeddedBlocks({ body: {}, embeddedBlocks: [block('Section 2 of 4')] });
        expect(found[0].rule).toBe('BLK001');
        expect(found[0].severity).toBe(SEVERITY.INFO);
        expect(found[0].locations).toEqual(['Section 2 of 4']);
    });

    it('prints the content key beside the location when the reference has one', () => {
        const found = checkEmbeddedBlocks({
            body: {},
            embeddedBlocks: [block('Section 2 of 4', 'MCAKK75VEXWZBC7DP4BMCGE2WACA')]
        });
        expect(found[0].locations).toEqual(['Section 2 of 4 — MCAKK75VEXWZBC7DP4BMCGE2WACA']);
    });

    it('reads naturally for one block and for several', () => {
        const one = checkEmbeddedBlocks({ body: {}, embeddedBlocks: [block('Section 1 of 2')] });
        expect(one[0].title).toBe('A reusable block here was not checked');
        const many = checkEmbeddedBlocks({ body: {}, embeddedBlocks: [block('a'), block('b'), block('c')] });
        expect(many[0].title).toBe('3 reusable blocks here were not checked');
    });

    // The two consequences a reviewer would otherwise have to work out for themselves.
    it('explains what the blind spot means for compliance and for size', () => {
        const found = checkEmbeddedBlocks({ body: {}, embeddedBlocks: [block('Section 1 of 1')] });
        expect(found[0].detail).toContain('compliance warning');
        expect(found[0].detail).toContain('size');
    });
});

// ---------------------------------------------------------------------------
// runPreflight
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// collectAnchors
// ---------------------------------------------------------------------------

describe('collectAnchors', () => {
    it('pairs anchor text with its href', () => {
        const body = emailBody([htmlNode('<a href="https://a.com/x">Shop the sale</a>')]);
        expect(collectAnchors(body)).toEqual([{ href: 'https://a.com/x', text: 'Shop the sale' }]);
    });

    it('strips nested markup out of the link text', () => {
        const body = emailBody([htmlNode('<a href="https://a.com"><strong>Buy</strong>&nbsp;now</a>')]);
        expect(collectAnchors(body)[0].text).toBe('Buy now');
    });

    it('reads a button component as an anchor', () => {
        const found = collectAnchors(emailBody([actionButtonNode('https://a.com', 'Click here')]));
        expect(found).toContainEqual({ href: 'https://a.com', text: 'Click here' });
    });

    // walkNodes visits the component and its `attributes` object separately, and the label is on
    // both while the URL is only on the component. Reading from both would give one linked button
    // and one identical-looking unlinked one.
    it('reports a button once, with its URL attached', () => {
        const found = collectAnchors(emailBody([buttonNode('https://a.com', 'Shop')]));
        expect(found.filter((a) => a.text === 'Shop')).toEqual([
            { href: 'https://a.com', text: 'Shop' }
        ]);
    });

    // collectLinks dedupes by URL; this must not, or four differently-labelled links to the same
    // page collapse into one and three of them escape the link-text check.
    it('keeps two different labels pointing at the same URL', () => {
        const body = emailBody([
            htmlNode('<a href="https://a.com">Click here</a><a href="https://a.com">Shop the sale</a>')
        ]);
        expect(collectAnchors(body)).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// contrastRatio
// ---------------------------------------------------------------------------

describe('contrastRatio', () => {
    it('returns 21 for black on white', () => {
        expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 1);
    });

    it('returns 1 for a colour against itself', () => {
        expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
    });

    it('expands three-digit hex', () => {
        expect(contrastRatio('#000', '#fff')).toBeCloseTo(21, 1);
    });

    it('is order independent', () => {
        expect(contrastRatio('#999999', '#FFFFFF')).toBeCloseTo(
            contrastRatio('#FFFFFF', '#999999'), 5
        );
    });

    // A brand token could evaluate to anything. Guessing would mean reporting contrast failures
    // against a colour the author never chose, which is the false positive this tool cannot afford.
    it('gives up on a brand token rather than guessing', () => {
        expect(contrastRatio('{!$brand.colorScheme.root}', '#FFFFFF')).toBeNull();
        expect(contrastRatio('rgb(0,0,0)', '#FFFFFF')).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// checkAccessibility
// ---------------------------------------------------------------------------

describe('checkAccessibility', () => {
    const ctx = (over) => ({ anchors: [], images: [], layoutNodes: [], strings: [], visibleText: '', ...over });

    it('says nothing about an ordinary email', () => {
        expect(checkAccessibility(ctx({
            anchors: [{ href: 'https://a.com', text: 'See the spring range' }],
            images: [{ label: 'hero', hasAlt: true, alt: 'Two people walking in the rain', linked: false }]
        }))).toEqual([]);
    });

    it('flags link text that says nothing', () => {
        const found = checkAccessibility(ctx({
            anchors: [{ href: 'https://a.com/sale', text: 'Click here' }]
        }));
        expect(ruleIds(found)).toContain('A11001');
        expect(found[0].locations[0]).toContain('Click here');
    });

    // "Learn more" is uninformative in theory and completely standard in marketing email. Flagging
    // every CTA in every email is how a tool trains people to close the panel.
    it('leaves the standard marketing CTAs alone', () => {
        for (const text of ['Learn more', 'Read more', 'Shop now', 'Get started']) {
            expect(ruleIds(checkAccessibility(ctx({ anchors: [{ href: 'https://a.com', text }] }))))
                .not.toContain('A11001');
        }
    });

    it('flags alt text that is really a file name', () => {
        const found = checkAccessibility(ctx({
            images: [{ label: 'x', hasAlt: true, alt: 'hero_final_2.png', linked: false }]
        }));
        expect(ruleIds(found)).toContain('A11002');
    });

    it('flags alt text that is really a CMS content key', () => {
        const found = checkAccessibility(ctx({
            images: [{ label: 'x', hasAlt: true, alt: 'MCJX4LL4ZSVNHALNTPQEVK3NF77U', linked: false }]
        }));
        expect(ruleIds(found)).toContain('A11002');
    });

    it('accepts a real description', () => {
        const found = checkAccessibility(ctx({
            images: [{ label: 'x', hasAlt: true, alt: 'A red waterproof jacket on a hook', linked: false }]
        }));
        expect(ruleIds(found)).not.toContain('A11002');
    });

    // A missing alt is IMG001's finding. Reporting both against the same image would double-count it.
    it('leaves images with no alt text to IMG001', () => {
        const found = checkAccessibility(ctx({
            images: [{ label: 'x', hasAlt: false, alt: '', linked: false }]
        }));
        expect(ruleIds(found)).not.toContain('A11002');
    });

    it('flags text too faint to read against its background', () => {
        expect(contrastRatio('#999999', '#FFFFFF')).toBeLessThan(MIN_CONTRAST);
        const found = checkAccessibility(ctx({
            layoutNodes: [{ label: 'body', colors: { textColor: '#999999', backgroundColor: '#FFFFFF' } }]
        }));
        const a11003 = found.find((f) => f.rule === 'A11003');
        expect(a11003).toBeDefined();
        expect(a11003.locations[0]).toMatch(/2\.8:1/);
    });

    it('accepts contrast that clears the threshold', () => {
        const found = checkAccessibility(ctx({
            layoutNodes: [{ label: 'body', colors: { textColor: '#333333', backgroundColor: '#FFFFFF' } }]
        }));
        expect(ruleIds(found)).not.toContain('A11003');
    });

    // Identical colours are RND005 ("text you cannot see"), which is an error and says something
    // more useful. A 1:1 contrast finding on top of it is noise.
    it('leaves identical colours to RND005', () => {
        const found = checkAccessibility(ctx({
            layoutNodes: [{ label: 'body', colors: { textColor: '#FFFFFF', backgroundColor: '#FFFFFF' } }]
        }));
        expect(ruleIds(found)).not.toContain('A11003');
    });

    it('says nothing when the colours are brand tokens it cannot resolve', () => {
        const found = checkAccessibility(ctx({
            layoutNodes: [{
                label: 'body',
                colors: {
                    textColor: '{!$brand.colorScheme.textColor}',
                    backgroundColor: '{!$brand.colorScheme.root}'
                }
            }]
        }));
        expect(ruleIds(found)).not.toContain('A11003');
    });

    it('notes a hand-written table with no presentation role', () => {
        const found = checkAccessibility(ctx({ strings: ['<table><tr><td>x</td></tr></table>'] }));
        expect(ruleIds(found)).toContain('A11004');
    });

    it('accepts a table already marked as decoration', () => {
        const found = checkAccessibility(ctx({
            strings: ['<table role="presentation"><tr><td>x</td></tr></table>']
        }));
        expect(ruleIds(found)).not.toContain('A11004');
    });

    it('notes a long run of capitals', () => {
        const found = checkAccessibility(ctx({
            visibleText: 'LIMITED TIME OFFER ENDS SUNDAY at midnight'
        }));
        expect(ruleIds(found)).toContain('A11005');
    });

    it('leaves a short capitalised label alone', () => {
        expect(ruleIds(checkAccessibility(ctx({ visibleText: 'Shop the SALE now' }))))
            .not.toContain('A11005');
    });
});

// ---------------------------------------------------------------------------
// checkEmailCss
// ---------------------------------------------------------------------------

describe('checkEmailCss', () => {
    it('says nothing about table-based markup', () => {
        expect(checkEmailCss({ strings: ['<table><tr><td>hi</td></tr></table>'] })).toEqual([]);
    });

    it('errors on web-page layout techniques', () => {
        const found = checkEmailCss({ strings: ['<div style="display:flex; gap:8px">x</div>'] });
        expect(found[0].rule).toBe('CSS001');
        expect(found[0].severity).toBe(SEVERITY.ERROR);
        expect(found[0].locations).toContain('display: flex');
    });

    it('names each unsupported property once', () => {
        const found = checkEmailCss({
            strings: ['<div style="display:grid">a</div>', '<div style="display:grid">b</div>']
        });
        expect(found[0].locations).toEqual(['display: grid']);
    });

    // "text-transform" is an ordinary, well-supported property that happens to contain the word.
    it('does not mistake text-transform for transform', () => {
        const found = checkEmailCss({ strings: ['<p style="text-transform: uppercase">x</p>'] });
        expect(ruleIds(found)).not.toContain('CSS001');
    });

    it('warns about a downloaded font', () => {
        const found = checkEmailCss({
            strings: ['<link href="https://fonts.googleapis.com/css?family=Inter">']
        });
        expect(ruleIds(found)).toContain('CSS002');
    });

    it('warns about an external stylesheet', () => {
        const found = checkEmailCss({ strings: ['<link rel="stylesheet" href="/site.css">'] });
        expect(ruleIds(found)).toContain('CSS004');
    });

    it('notes a custom font with no backup named', () => {
        const found = checkEmailCss({ strings: ['<p style="font-family: Brandon Grotesque">x</p>'] });
        const css003 = found.find((f) => f.rule === 'CSS003');
        expect(css003.locations).toEqual(['Brandon Grotesque']);
    });

    // Arial is on every machine that will ever open this email. Saying it "needs a fallback" is
    // technically true and would put a finding on essentially every email ever built.
    it('does not ask for a backup behind a universally available font', () => {
        const found = checkEmailCss({ strings: ['<p style="font-family: Arial">x</p>'] });
        expect(ruleIds(found)).not.toContain('CSS003');
    });

    it('accepts a font stack that already has a backup', () => {
        const found = checkEmailCss({
            strings: ['<p style="font-family: Brandon Grotesque, Arial, sans-serif">x</p>']
        });
        expect(ruleIds(found)).not.toContain('CSS003');
    });

    it('leaves a brand token alone', () => {
        const found = checkEmailCss({
            strings: ['<p style="font-family: {!$brand.typography.fontFamily}">x</p>']
        });
        expect(ruleIds(found)).not.toContain('CSS003');
    });
});

// ---------------------------------------------------------------------------
// checkDarkMode
// ---------------------------------------------------------------------------

describe('checkDarkMode', () => {
    it('says nothing when both colours are set together', () => {
        expect(checkDarkMode({
            layoutNodes: [{ label: 'hero', colors: { textColor: '#222222', backgroundColor: '#EEEEEE' } }]
        })).toEqual([]);
    });

    it('warns when the background is pinned and the text is not', () => {
        const found = checkDarkMode({
            layoutNodes: [{ label: 'hero', colors: { backgroundColor: '#EEEEEE' } }]
        });
        expect(found[0].rule).toBe('DRK001');
        expect(found[0].locations[0]).toContain('hero');
    });

    it('does not complain about text colour set without a background', () => {
        const found = checkDarkMode({
            layoutNodes: [{ label: 'body', colors: { textColor: '#222222' } }]
        });
        expect(ruleIds(found)).not.toContain('DRK001');
    });

    it('notes pure white and pure black', () => {
        const found = checkDarkMode({
            layoutNodes: [{ label: 'body', colors: { textColor: '#000000', backgroundColor: '#FFFFFF' } }]
        });
        const drk002 = found.find((f) => f.rule === 'DRK002');
        expect(drk002.locations).toHaveLength(2);
    });

    it('accepts colours nudged off the extremes', () => {
        const found = checkDarkMode({
            layoutNodes: [{ label: 'body', colors: { textColor: '#111111', backgroundColor: '#FAFAFA' } }]
        });
        expect(ruleIds(found)).not.toContain('DRK002');
    });

    // Every button the builder makes carries a brand token here whether or not anyone picked a
    // colour. Treating that as a pinned background would put this finding on every email with a
    // button in it — and brand colours are managed centrally, which is the opposite of the problem.
    it('does not treat a brand-token background as pinned', () => {
        expect(checkDarkMode({
            layoutNodes: [{
                label: 'lightning/actionButton',
                colors: {
                    backgroundColor: '{!$brand.colorScheme.root}',
                    linkColor: '{!$brand.colorScheme.primaryAccent}'
                }
            }]
        })).toEqual([]);
    });

    it('ignores brand tokens, which it cannot resolve', () => {
        expect(checkDarkMode({
            layoutNodes: [{
                label: 'body',
                colors: {
                    textColor: '{!$brand.colorScheme.textColor}',
                    backgroundColor: '{!$brand.colorScheme.root}'
                }
            }]
        })).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// checkSize
// ---------------------------------------------------------------------------

describe('checkSize', () => {
    it('says nothing about a normal-sized email', () => {
        expect(checkSize({ sizeBytes: 20 * 1024, images: [] })).toEqual([]);
    });

    it('warns as the email approaches the Gmail cut-off', () => {
        const found = checkSize({ sizeBytes: (SIZE_WARN_KB + 5) * 1024, images: [] });
        expect(found[0].rule).toBe('SIZ001');
        expect(found[0].detail).toContain(`${SIZE_WARN_KB + 5} KB`);
    });

    it('errors on an image pasted into the email as data', () => {
        const found = checkSize({
            sizeBytes: 1024,
            images: [{ label: 'x', src: `data:image/png;base64,${'A'.repeat(4000)}` }]
        });
        expect(found[0].rule).toBe('SIZ002');
        expect(found[0].severity).toBe(SEVERITY.ERROR);
    });

    it('accepts an ordinary hosted image', () => {
        const found = checkSize({
            sizeBytes: 1024,
            images: [{ label: 'x', src: 'https://cdn.example.com/hero.png' }]
        });
        expect(ruleIds(found)).not.toContain('SIZ002');
    });

    it('survives a context with no images key', () => {
        expect(() => checkSize({ sizeBytes: 0 })).not.toThrow();
    });
});

describe('runPreflight', () => {
    it('survives an empty or missing body without throwing', () => {
        expect(() => runPreflight({})).not.toThrow();
        expect(() => runPreflight(null)).not.toThrow();
        expect(runPreflight({}).counts.total).toBeGreaterThanOrEqual(0);
    });

    it('runs every registered check', () => {
        expect(runPreflight({ contentBody: {} }).checksRun).toBe(CHECKS.length);
    });

    // The panel pins these above the results rather than reading them out of BLK001, which sorts to
    // the bottom as the note it is.
    it('hands the embedded blocks back beside the findings', () => {
        const body = emailBody([
            {
                definition: 'sfdc_cms/reusableContentBlock',
                attributes: { content: { definition: '@cms/MCK263AR76UVCFPDIHIXUCFOYMMU' } }
            }
        ]);
        const { embeddedBlocks } = runPreflight({ contentBody: body });
        expect(embeddedBlocks).toHaveLength(1);
        expect(embeddedBlocks[0].contentKey).toBe('MCK263AR76UVCFPDIHIXUCFOYMMU');
        expect(embeddedBlocks[0].name).toBe('');
    });

    // The panel remembers dismissals by this id, so it has to survive a re-check of edited content.
    it('gives every finding a stable id', () => {
        const body = emailBody([htmlNode('{{#if a}}oops'), buttonNode('http://shop.com')]);
        const first = runPreflight({ contentBody: body });
        const second = runPreflight({ contentBody: body });
        expect(first.findings.map((f) => f.id)).toEqual(second.findings.map((f) => f.id));
    });

    it('uses the bare rule id where a rule fires once', () => {
        const { findings } = runPreflight({ contentBody: emailBody([htmlNode('{{#if a}}oops')]) });
        const hb = findings.find((f) => f.rule === 'HB001');
        expect(hb.id).toBe('HB001');
    });

    it('keeps ids unique even if a rule ever fires twice', () => {
        const { findings } = runPreflight({ contentBody: emailBody([htmlNode('<p>hi</p>')]) });
        const ids = findings.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('reports an empty list for an email that embeds nothing', () => {
        expect(runPreflight({ contentBody: emailBody([]) }).embeddedBlocks).toEqual([]);
    });

    it('carries the block role through to the compliance rules', () => {
        const body = emailBody([htmlNode('<p>Follow us on social</p>')]);
        const withoutRole = runPreflight({ contentBody: body }, { contentType: 'rcb' });
        const asFooter = runPreflight({ contentBody: body }, { contentType: 'rcb', blockRoles: [ROLE_FOOTER] });

        expect(ruleIds(withoutRole.findings)).not.toContain('CMP001');
        expect(ruleIds(withoutRole.findings)).toContain('BLK002');
        expect(ruleIds(asFooter.findings)).toContain('CMP001');
        expect(ruleIds(asFooter.findings)).toContain('BLK003');
    });

    // Layout is not an email-only concern: a block with columns that do not add up renders just as
    // badly inside whatever email pulls it in.
    it('runs the padding and layout rules on a content block', () => {
        const body = emailBody([
            {
                definition: 'lightning/section',
                attributes: {
                    'lightning:padding': {
                        top: { value: 0, unit: 'px' },
                        right: { value: 100, unit: 'px' },
                        bottom: { value: 0, unit: 'px' },
                        left: { value: 30, unit: 'px' }
                    }
                },
                children: [htmlNode('<p>Footer copy</p>')]
            }
        ]);
        const ids = ruleIds(runPreflight({ contentBody: body }, { contentType: 'rcb' }).findings);
        // RND003 — padding that is not the same on both sides.
        expect(ids).toContain('RND003');
    });

    it('never runs the subject or preheader rules on a block, whatever its role', () => {
        const body = emailBody([htmlNode('<p>Follow us on social</p>')]);
        for (const role of BLOCK_ROLES) {
            const ids = ruleIds(runPreflight({ contentBody: body }, { contentType: 'rcb', blockRoles: [role.id] }).findings);
            expect(ids).not.toContain('CNT001');
            expect(ids).not.toContain('CNT003');
        }
    });

    it('sorts errors above warnings above notes', () => {
        const body = emailBody([
            htmlNode('{{#if a}}oops'), // HB001 error
            buttonNode('http://shop.com') // LNK002 warning
        ]);
        const { findings } = runPreflight({ contentBody: body, title: 'Test' });
        const severities = findings.map((f) => f.severity);
        const firstWarning = severities.indexOf(SEVERITY.WARNING);
        const lastError = severities.lastIndexOf(SEVERITY.ERROR);
        expect(lastError).toBeLessThan(firstWarning);
    });

    it('counts findings by severity', () => {
        const { counts } = runPreflight({ contentBody: emailBody([htmlNode('{{#if a}}oops')]) });
        expect(counts.error).toBeGreaterThan(0);
        expect(counts.total).toBe(counts.error + counts.warning + counts.info);
    });

    it('reports scan statistics', () => {
        const body = emailBody([buttonNode('https://a.com'), imageNode('MC_A', 'Alt')]);
        const { stats } = runPreflight({ contentBody: body });
        expect(stats.links).toBe(1);
        expect(stats.images).toBe(1);
    });

    it('catches an empty CTA button end to end', () => {
        const body = emailBody([
            { definition: 'lightning/actionButton', attributes: { buttonText: 'Learn more' } }
        ]);
        const { findings, counts } = runPreflight({ contentBody: body, title: 'Test' });
        const lnk004 = findings.find((f) => f.rule === 'LNK004');
        expect(lnk004).toBeDefined();
        // Named by type and label. No "of N" suffix, since it is the only button in the email.
        expect(lnk004.locations).toEqual(['Button "Learn more"']);
        expect(counts.error).toBeGreaterThan(0);
    });

    it('applies the email ruleset by default', () => {
        const { findings } = runPreflight({ contentBody: emailBody([htmlNode('<p>hi</p>')]) });
        expect(ruleIds(findings)).toContain('CMP001'); // unsubscribe check is email-only
    });

    it('applies the RCB ruleset when told to', () => {
        const { findings } = runPreflight(
            { contentBody: emailBody([htmlNode('<p>hi</p>')]) },
            { contentType: 'rcb' }
        );
        expect(ruleIds(findings)).not.toContain('CMP001');
    });

    it('gives a clean bill of health to well-formed content', () => {
        const body = emailBody([
            { subject: 'Spring sale', preheader: 'Up to 40% off, in store and online until Sunday' },
            // The hidden {{set}} block is what makes {{varRegion}} a *defined* variable rather than
            // an undeclared one, so VAR001 must stay quiet about it.
            htmlNode('<div hidden="hidden" data-tracking-block="true">{{set "varRegion" "region=north"}}</div>'),
            htmlNode(BODY_COPY),
            htmlNode('<a href="https://shop.com/sale?{{varRegion}}">Shop</a>'),
            htmlNode('<a href="{!$link.EmailAddressOptOutUrl}">Unsubscribe</a>'),
            htmlNode('<a href="{!$link.PreferenceCenterUrl}">Preferences</a>'),
            htmlNode(FOOTER_ADDRESS),
            imageNode('MC_HERO', 'Spring sale hero')
        ]);
        const { counts } = runPreflight({ contentBody: body, title: 'EM_SpringSale_V1' });
        expect(counts.error).toBe(0);
        expect(counts.warning).toBe(0);
    });

    it('truncates very long location lists but records how many were dropped', () => {
        const links = Array.from({ length: 25 }, (_, i) => htmlNode(`<a href="http://x${i}.com">L</a>`));
        const { findings } = runPreflight({ contentBody: emailBody(links) });
        const insecure = findings.find((f) => f.rule === 'LNK002');
        expect(insecure.locations).toHaveLength(10);
        expect(insecure.truncated).toBe(15);
    });
});

// ---------------------------------------------------------------------------
// buildTextReport
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Positions on string-scanned findings
// ---------------------------------------------------------------------------

describe('collectLocatedStrings', () => {
    const sectionNode = (children) => ({ definition: 'lightning/section', children });

    it('pairs each string with the component holding it', () => {
        const body = emailBody([
            sectionNode([htmlNode('<p>first</p>')]),
            sectionNode([htmlNode('<p>second</p>')])
        ]);
        const found = collectLocatedStrings(body).find((s) => s.text.includes('second'));
        expect(found.place).toContain('Section 2 of 2');
    });

    it('names the nested component as well as its section', () => {
        const body = emailBody([
            sectionNode([htmlNode('<p>a</p>')]),
            sectionNode([htmlNode('<p>b</p>'), htmlNode('<p>c</p>')])
        ]);
        const found = collectLocatedStrings(body).find((s) => s.text.includes('c</p>'));
        expect(found.place).toBe('HTML block 2 of 2 in Section 2 of 2');
    });

    // Subject and preheader sit on the body, not inside any component on the canvas.
    it('leaves a string with no component above it unplaced', () => {
        const body = emailBody([{ subject: 'Spring sale' }]);
        const found = collectLocatedStrings(body).find((s) => s.text === 'Spring sale');
        expect(found.place).toBe('');
    });
});

describe('findings say where the text they matched lives', () => {
    const sectionNode = (children) => ({ definition: 'lightning/section', children });
    const locationsFor = (body, rule) => {
        const f = runPreflight({ contentBody: body }).findings.find((x) => x.rule === rule);
        return f ? f.locations : [];
    };

    it('places a square-bracket placeholder in its section', () => {
        const body = emailBody([
            sectionNode([htmlNode('<p>Hello there</p>')]),
            sectionNode([htmlNode('<p>Call [Provider Name] to book</p>')])
        ]);
        expect(locationsFor(body, 'TXT002')[0]).toBe('[Provider Name] — HTML block in Section 2 of 2');
    });

    // The same placeholder in two sections is two separate edits.
    it('lists the same placeholder once per place it appears', () => {
        const body = emailBody([
            sectionNode([htmlNode('<p>[Your Company] is here</p>')]),
            sectionNode([htmlNode('<p>Contact [Your Company]</p>')])
        ]);
        const locs = locationsFor(body, 'TXT002');
        expect(locs).toHaveLength(2);
        expect(locs[0]).toContain('Section 1 of 2');
        expect(locs[1]).toContain('Section 2 of 2');
    });

    it('places an unclosed code block', () => {
        const body = emailBody([
            sectionNode([htmlNode('<p>fine</p>')]),
            sectionNode([htmlNode('<p>{{#if member}}Welcome back</p>')])
        ]);
        expect(locationsFor(body, 'HB001')[0]).toContain('Section 2 of 2');
    });

    it('places legacy code from the old platform', () => {
        const body = emailBody([
            sectionNode([htmlNode('<p>fine</p>')]),
            sectionNode([htmlNode('<p>Hello %%FirstName%%</p>')])
        ]);
        expect(locationsFor(body, 'MIG001')[0]).toContain('Section 2 of 2');
    });

    it('still reports the subject by name rather than by position', () => {
        const body = emailBody([
            { subject: 'Lorem ipsum dolor sit amet' },
            sectionNode([htmlNode('<p>real copy here</p>')])
        ]);
        expect(locationsFor(body, 'TXT001')[0]).toContain('subject line');
    });
});

describe('buildTextReport', () => {
    it('renders a readable report including the content name', () => {
        const result = runPreflight({ contentBody: emailBody([htmlNode('{{#if a}}oops')]) });
        const text = buildTextReport(result, 'EM_Test');
        expect(text).toContain('EM_Test');
        expect(text).toContain('[ERROR] HB001');
    });

    it('says so plainly when nothing was found', () => {
        const text = buildTextReport({
            counts: { error: 0, warning: 0, info: 0, total: 0 },
            findings: [],
            checksRun: CHECKS.length,
            stats: { links: 0, images: 0, expressions: 0, textChars: 0, sizeKb: 0 }
        });
        expect(text).toContain('No issues found.');
    });

    it('always states the embedded-block scope limit', () => {
        const text = buildTextReport(runPreflight({ contentBody: {} }));
        expect(text).toContain('reusable blocks');
    });

    // A curated list that does not admit to being curated is the one way this report could mislead
    // the person it gets pasted to.
    it('admits when findings were left out on purpose', () => {
        const result = runPreflight({ contentBody: emailBody([htmlNode('{{#if a}}oops')]) });
        const text = buildTextReport({ ...result, ignored: 3 }, 'EM_Test');
        expect(text).toContain('3 finding(s) were ignored by the reviewer');
    });

    it('stays quiet about ignoring when nothing was ignored', () => {
        const text = buildTextReport(runPreflight({ contentBody: {} }));
        expect(text).not.toContain('ignored by the reviewer');
    });

    it('does not call an entirely-ignored report clean', () => {
        const text = buildTextReport({
            counts: { error: 0, warning: 0, info: 0, total: 0 },
            findings: [],
            ignored: 4,
            checksRun: CHECKS.length,
            stats: { links: 0, images: 0, expressions: 0, textChars: 0, sizeKb: 0 }
        });
        expect(text).toContain('Nothing left after the ignored findings.');
        expect(text).not.toContain('No issues found.');
    });
});

// ---------------------------------------------------------------------------
// buildSheetReport
// ---------------------------------------------------------------------------

describe('buildSheetReport', () => {
    /** A result carrying exactly the findings given, so cell content can be asserted precisely. */
    const resultOf = (findings) => ({ findings, counts: {}, checksRun: 0, stats: {} });

    const oneFinding = (over = {}) =>
        resultOf([
            {
                rule: 'LNK001',
                severity: SEVERITY.ERROR,
                title: 'A link goes nowhere',
                detail: 'Set a real destination.',
                locations: ['Section 1 of 2'],
                truncated: 0,
                ...over
            }
        ]);

    /** Rows split back apart, as a spreadsheet would read them. */
    const cellsOf = (tsv) => tsv.split('\r\n').map((r) => r.split('\t'));

    it('starts with a header row naming every column', () => {
        const [header] = cellsOf(buildSheetReport(resultOf([])));
        expect(header).toEqual(['Email', 'Severity', 'Rule', 'Issue', 'Where', 'Details', 'Status']);
    });

    it('writes one row per finding, in column order', () => {
        const rows = cellsOf(buildSheetReport(oneFinding(), 'EM_Launch'));
        expect(rows).toHaveLength(2);
        expect(rows[1]).toEqual([
            'EM_Launch',
            'Error',
            'LNK001',
            'A link goes nowhere',
            'Section 1 of 2',
            'Set a real destination.',
            ''
        ]);
    });

    it('uses the words the panel uses for severity', () => {
        const severities = [SEVERITY.ERROR, SEVERITY.WARNING, SEVERITY.INFO].map((severity) =>
            cellsOf(buildSheetReport(oneFinding({ severity })))[1][1]
        );
        expect(severities).toEqual(['Error', 'Warning', 'Note']);
    });

    it('repeats the email name on every row so scans can be stacked', () => {
        const findings = oneFinding().findings;
        const rows = cellsOf(buildSheetReport(resultOf([...findings, ...findings]), 'EM_Launch'));
        expect(rows[1][0]).toBe('EM_Launch');
        expect(rows[2][0]).toBe('EM_Launch');
    });

    it('keeps every location of a finding in the one cell', () => {
        const rows = cellsOf(buildSheetReport(oneFinding({ locations: ['Section 1 of 2', 'Section 2 of 2'] })));
        expect(rows).toHaveLength(2);
        expect(rows[1][4]).toBe('Section 1 of 2 | Section 2 of 2');
    });

    it('carries the truncation note into the locations cell', () => {
        const rows = cellsOf(buildSheetReport(oneFinding({ locations: ['Section 1 of 2'], truncated: 15 })));
        expect(rows[1][4]).toBe('Section 1 of 2 | …and 15 more');
    });

    it('leaves Status empty for the reviewer', () => {
        expect(cellsOf(buildSheetReport(oneFinding()))[1][6]).toBe('');
    });

    it('emits only the header when there is nothing to report', () => {
        expect(buildSheetReport(resultOf([])).split('\r\n')).toHaveLength(1);
    });

    // Each of these silently shifts data into the wrong column rather than failing visibly.
    describe('cell safety', () => {
        it('never lets a newline in a detail split the row', () => {
            const tsv = buildSheetReport(oneFinding({ detail: 'First line.\nSecond line.' }));
            expect(tsv.split('\r\n')).toHaveLength(2);
            expect(cellsOf(tsv)[1][5]).toBe('First line. Second line.');
        });

        it('never lets a tab in a value shift the later columns', () => {
            const rows = cellsOf(buildSheetReport(oneFinding({ title: 'Before\tafter' })));
            expect(rows[1]).toHaveLength(7);
            expect(rows[1][3]).toBe('Before after');
        });

        it('stops Excel reading a value as a formula', () => {
            const starts = ['=SUM(A1)', '+1', '@name'].map(
                (title) => cellsOf(buildSheetReport(oneFinding({ title })))[1][3]
            );
            expect(starts).toEqual(["'=SUM(A1)", "'+1", "'@name"]);
        });

        it('leaves a negative CSS value alone', () => {
            expect(cellsOf(buildSheetReport(oneFinding({ title: '-10px' })))[1][3]).toBe('-10px');
        });

        // Component labels quote the copy they sample, so this is the everyday case.
        it('escapes a value containing quotes', () => {
            const rows = cellsOf(buildSheetReport(oneFinding({ locations: ['Section 2 — "Sale ends"'] })));
            expect(rows[1]).toHaveLength(7);
            expect(rows[1][4]).toBe('"Section 2 — ""Sale ends"""');
        });

        it('does not quote a value that has no quotes in it', () => {
            expect(cellsOf(buildSheetReport(oneFinding()))[1][3]).toBe('A link goes nowhere');
        });

        it('survives a missing name, detail or locations', () => {
            const rows = cellsOf(buildSheetReport(oneFinding({ detail: undefined, locations: [] })));
            expect(rows[1]).toEqual(['', 'Error', 'LNK001', 'A link goes nowhere', '', '', '']);
        });
    });
});
