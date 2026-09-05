import {
    STATUS,
    collectQaTargets,
    compareValue,
    cosmeticNormalize,
    describeTextDifference,
    isSystemLink,
    normalizeUrl,
    runQaField
} from 'c/qaCompare';

// Shapes mirror the preflightEngine suite, which mirrors what the builder actually stores.
const emailBody = (children, extra = {}) => ({ 'sfdc_cms:block': { children }, ...extra });

const htmlNode = (rawHtml) => ({ definition: 'lightning/html', attributes: { rawHtml } });

describe('cosmeticNormalize', () => {
    it('flattens the characters a word processor substitutes', () => {
        expect(cosmeticNormalize('Don\u2019t  wait \u2014 save 40%\u2026')).toBe("Don't wait - save 40%...");
    });

    it('turns a non-breaking space into an ordinary one', () => {
        expect(cosmeticNormalize('Save\u00a040%')).toBe('Save 40%');
    });

    it('strips zero-width characters', () => {
        expect(cosmeticNormalize('Sale\u200b Now')).toBe('Sale Now');
    });

    it('is safe on non-strings', () => {
        expect(cosmeticNormalize(null)).toBe('');
        expect(cosmeticNormalize(undefined)).toBe('');
    });
});

describe('describeTextDifference', () => {
    it('returns nothing when the text matches exactly', () => {
        expect(describeTextDifference('Summer Sale', 'Summer Sale')).toBeNull();
    });

    it('says so plainly when the email field is empty', () => {
        const d = describeTextDifference('Summer Sale', '');
        expect(d.kind).toBe('missing');
    });

    it('names a curly apostrophe rather than reporting a bare mismatch', () => {
        const d = describeTextDifference('Don\u2019t miss out', "Don't miss out");
        expect(d.kind).toBe('cosmetic');
        expect(d.message).toContain('curly vs straight quotes');
    });

    it('names a dash substitution', () => {
        const d = describeTextDifference('Sale \u2013 40% off', 'Sale - 40% off');
        expect(d.kind).toBe('cosmetic');
        expect(d.message).toContain('dash style');
    });

    it('names spacing on its own', () => {
        const d = describeTextDifference('Summer  Sale', 'Summer Sale');
        expect(d.kind).toBe('cosmetic');
        expect(d.message).toContain('spacing');
    });

    it('reports every cosmetic reason at once', () => {
        const d = describeTextDifference('Don\u2019t  wait \u2013 now', "Don't wait - now");
        expect(d.message).toContain('curly vs straight quotes');
        expect(d.message).toContain('dash style');
        expect(d.message).toContain('spacing');
    });

    it('does not blame a step that was not involved', () => {
        const d = describeTextDifference('Summer  Sale', 'Summer Sale');
        expect(d.message).not.toContain('dash style');
        expect(d.message).not.toContain('curly');
    });

    it('separates capitalisation from a wording change', () => {
        const d = describeTextDifference('Summer Sale', 'SUMMER SALE');
        expect(d.kind).toBe('case');
    });

    it('recognises a merge field standing in for an example value', () => {
        const d = describeTextDifference('Hi John, your order shipped', 'Hi {{firstName}}, your order shipped');
        expect(d.kind).toBe('merge');
        expect(d.message).toContain('{{firstName}}');
    });

    it('does not call it a merge difference when the spec has one too', () => {
        const d = describeTextDifference('Hi {{firstName}}, welcome', 'Hi {{lastName}}, welcome');
        expect(d.kind).toBe('different');
    });

    it('is not confused by a second call after a merge-field match', () => {
        describeTextDifference('Hi John', 'Hi {{firstName}}');
        const d = describeTextDifference('Hi Jane', 'Hi {{firstName}}');
        expect(d.kind).toBe('merge');
    });

    it('spots text appended to the end', () => {
        const d = describeTextDifference('Summer Sale', 'Summer Sale is here');
        expect(d.kind).toBe('extra');
        expect(d.message).toContain('is here');
    });

    it('spots text cut off the end', () => {
        const d = describeTextDifference('Summer Sale is here', 'Summer Sale');
        expect(d.kind).toBe('truncated');
        expect(d.message).toContain('is here');
    });

    it('locates a genuine difference', () => {
        const d = describeTextDifference('Save 40% today', 'Save 50% today');
        expect(d.kind).toBe('different');
        expect(d.message).toContain('character 6');
    });
});

describe('normalizeUrl', () => {
    it('drops campaign tracking but keeps parameters that identify the page', () => {
        expect(normalizeUrl('https://shop.com/sale?utm_source=email&product=123')).toBe(
            'https://shop.com/sale?product=123'
        );
    });

    it('drops the whole query when it is only tracking', () => {
        expect(normalizeUrl('https://shop.com/sale?utm_source=email&utm_medium=cpc')).toBe('https://shop.com/sale');
    });

    // A query string assembled at send time has nothing in it a reviewer could have listed.
    it('drops a query that is one bare merge field', () => {
        expect(normalizeUrl('https://shop.com/sale?{{varTracking}}')).toBe('https://shop.com/sale');
    });

    it('treats parameter order as irrelevant', () => {
        expect(normalizeUrl('https://a.com/x?b=2&a=1')).toBe(normalizeUrl('https://a.com/x?a=1&b=2'));
    });

    it('lowercases the host but not the path', () => {
        expect(normalizeUrl('HTTPS://Shop.COM/Summer-Sale')).toBe('https://shop.com/Summer-Sale');
    });

    it('ignores a trailing slash and a fragment', () => {
        expect(normalizeUrl('https://shop.com/sale/#top')).toBe('https://shop.com/sale');
    });

    it('keeps http and https apart, since that is a real difference', () => {
        expect(normalizeUrl('http://a.com')).not.toBe(normalizeUrl('https://a.com'));
    });

    it('is safe on rubbish', () => {
        expect(normalizeUrl(null)).toBe('');
        expect(normalizeUrl('   ')).toBe('');
    });
});

describe('isSystemLink', () => {
    it('recognises platform links a reviewer would never list', () => {
        expect(isSystemLink('{!$link.optout}')).toBe(true);
        expect(isSystemLink('https://x.com/unsubscribe')).toBe(true);
        expect(isSystemLink('mailto:help@x.com')).toBe(true);
        expect(isSystemLink('#top')).toBe(true);
    });

    it('leaves an ordinary marketing link alone', () => {
        expect(isSystemLink('https://shop.com/sale')).toBe(false);
    });
});

describe('compareValue', () => {
    it('passes when the same page is linked, tracking aside', () => {
        expect(compareValue('url', 'https://shop.com/sale', 'https://shop.com/sale?utm_source=email').status).toBe(
            STATUS.PASS
        );
    });

    it('skips a row the reviewer has not filled in', () => {
        expect(compareValue('url', '', 'https://shop.com/sale').status).toBe(STATUS.SKIPPED);
        expect(compareValue('text', '   ', 'Shop now').status).toBe(STATUS.SKIPPED);
    });

    it('says plainly when the component has no destination at all', () => {
        const r = compareValue('url', 'https://shop.com/sale', '');
        expect(r.status).toBe(STATUS.FAIL);
        expect(r.detail).toContain('no destination');
    });

    it('separates a scheme difference from a different page', () => {
        const r = compareValue('url', 'https://shop.com/sale', 'http://shop.com/sale');
        expect(r.status).toBe(STATUS.FAIL);
        expect(r.detail).toContain('Same address');
    });

    it('separates a different page on the same site', () => {
        const r = compareValue('url', 'https://shop.com/sale', 'https://shop.com/clearance');
        expect(r.detail).toContain('Same site');
    });

    it('names a different destination outright', () => {
        const r = compareValue('url', 'https://shop.com/sale', 'https://other.com/sale');
        expect(r.detail).toContain('Different destination');
    });

    it('matches text regardless of paste artefacts, and explains when it cannot', () => {
        expect(compareValue('text', 'Shop now', 'Shop now').status).toBe(STATUS.PASS);
        const r = compareValue('text', 'Don\u2019t wait', "Don't wait");
        expect(r.status).toBe(STATUS.FAIL);
        expect(r.detail).toContain('curly vs straight quotes');
    });

    it('reports an empty alt text as a mismatch rather than a pass', () => {
        const r = compareValue('text', 'Hero banner', '');
        expect(r.status).toBe(STATUS.FAIL);
        expect(r.detail).toContain('nothing in this field');
    });

    it('matches an image file by name against the CDN URL serving it', () => {
        expect(compareValue('src', 'hero-banner.jpg', 'https://cdn.example.com/a/b/hero-banner.jpg').status).toBe(
            STATUS.PASS
        );
    });

    it('matches an image URL exactly, tracking aside', () => {
        expect(
            compareValue('src', 'https://cdn.example.com/hero.png', 'https://cdn.example.com/hero.png?v=2&utm_source=e')
                .status
        ).toBe(STATUS.PASS);
    });

    it('fails when the email uses a different picture', () => {
        const r = compareValue('src', 'hero-banner.jpg', 'https://cdn.example.com/old-banner.jpg');
        expect(r.status).toBe(STATUS.FAIL);
        expect(r.detail).toContain('old-banner.jpg');
    });

    it('says plainly when an image has no file at all', () => {
        const r = compareValue('src', 'hero.jpg', '');
        expect(r.status).toBe(STATUS.FAIL);
        expect(r.detail).toBe('This image has no file set.');
    });

    // Two CMS content keys have no extension, so "same last path segment" would be comparing the
    // whole value against itself and passing everything.
    it('does not treat two extensionless keys as matching file names', () => {
        expect(compareValue('src', 'MCPH0100001', 'MCPH0100002').status).toBe(STATUS.FAIL);
    });

    it('matches a CMS content key exactly', () => {
        expect(compareValue('src', 'MCPH0100001', 'MCPH0100001').status).toBe(STATUS.PASS);
    });
});

describe('collectQaTargets', () => {
    const sectionNode = (children) => ({ definition: 'lightning/section', children });
    const imageNode = (contentKey, altText) => ({
        definition: 'lightning/image',
        attributes: { imageInfo: { altText, source: { ref: { contentKey } } } }
    });

    it('lists every link with the component it belongs to', () => {
        const c = {
            contentBody: emailBody([
                sectionNode([htmlNode('<a href="https://shop.com/a">A</a>')]),
                sectionNode([htmlNode('<a href="https://shop.com/b">B</a>')])
            ])
        };
        const { links } = collectQaTargets(c);
        expect(links.map((l) => l.actual)).toEqual(['https://shop.com/a', 'https://shop.com/b']);
        expect(links[1].label).toContain('Section 2 of 2');
    });

    it('lists every image, including one with no alt text yet', () => {
        const c = {
            contentBody: emailBody([sectionNode([imageNode('MC_A', 'Hero banner'), imageNode('MC_B', '')])])
        };
        const { images } = collectQaTargets(c);
        expect(images).toHaveLength(2);
        expect(images[1].actual).toBe('');
    });

    it('lists clickable text separately from destinations', () => {
        const c = { contentBody: emailBody([htmlNode('<a href="https://shop.com/a">Shop now</a>')]) };
        const { links, texts } = collectQaTargets(c);
        expect(links[0].actual).toBe('https://shop.com/a');
        expect(texts[0].actual).toBe('Shop now');
    });

    it('marks the unsubscribe link as a system link so the panel can say so', () => {
        const c = { contentBody: emailBody([htmlNode('<a href="{!$link.optout}">Unsubscribe</a>')]) };
        expect(collectQaTargets(c).links[0].system).toBe(true);
    });

    it('gives two identical-looking items different keys', () => {
        const c = {
            contentBody: emailBody([
                htmlNode('<a href="https://a.com">Go</a>'),
                htmlNode('<a href="https://a.com">Go</a>')
            ])
        };
        const keys = collectQaTargets(c).links.map((l) => l.key);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('lists each image twice — once for its file, once for its alt text', () => {
        const c = { contentBody: emailBody([sectionNode([imageNode('MC_A', 'Hero banner')])]) };
        const { imageSources, images } = collectQaTargets(c);
        expect(imageSources).toHaveLength(1);
        expect(images).toHaveLength(1);
        expect(imageSources[0].key).not.toBe(images[0].key);
    });

    it('reports the image file for a CMS-referenced picture', () => {
        const c = { contentBody: emailBody([sectionNode([imageNode('MC_A', 'Hero banner')])]) };
        expect(collectQaTargets(c).imageSources[0].actual).toBe('MC_A');
    });

    it('reports the src of an image in raw HTML', () => {
        const c = { contentBody: emailBody([htmlNode('<img src="https://cdn.co/hero.jpg" alt="Hero">')]) };
        expect(collectQaTargets(c).imageSources[0].actual).toBe('https://cdn.co/hero.jpg');
    });

    it('returns empty lists rather than throwing on missing content', () => {
        const empty = { links: [], texts: [], imageSources: [], images: [] };
        expect(collectQaTargets(null)).toEqual(empty);
        expect(collectQaTargets({})).toEqual(empty);
    });
});

describe('runQaField', () => {
    const content = {
        contentBody: emailBody([htmlNode('<p>Everything reduced. <a href="https://shop.com/sale">Shop now</a></p>')], {
            subject: 'Summer Sale is here',
            preheader: 'Up to 40% off everything in store'
        })
    };

    it('skips every field the reviewer left blank', () => {
        expect(runQaField(content, {}, 'subject').status).toBe(STATUS.SKIPPED);
        expect(runQaField(content, {}, 'preheader').status).toBe(STATUS.SKIPPED);
    });

    it('checks only the field it was asked about', () => {
        const r = runQaField(content, { subject: 'Summer Sale is here', preheader: 'wrong' }, 'subject');
        expect(r.id).toBe('subject');
        expect(r.status).toBe(STATUS.PASS);
    });

    it('passes a subject that matches', () => {
        expect(runQaField(content, { subject: 'Summer Sale is here' }, 'subject').status).toBe(STATUS.PASS);
    });

    it('explains a subject that differs only by a curly quote', () => {
        const c = { contentBody: emailBody([], { subject: "Don't wait" }) };
        const r = runQaField(c, { subject: 'Don\u2019t wait' }, 'subject');
        expect(r.status).toBe(STATUS.FAIL);
        expect(r.detail).toContain('curly vs straight quotes');
    });

    it('ignores surrounding whitespace in what the reviewer typed', () => {
        expect(runQaField(content, { subject: '  Summer Sale is here  ' }, 'subject').status).toBe(STATUS.PASS);
    });

    it('checks the preheader against its own field', () => {
        expect(runQaField(content, { preheader: 'Up to 40% off everything in store' }, 'preheader').status).toBe(
            STATUS.PASS
        );
    });

    it('reports a preheader that differs', () => {
        const r = runQaField(content, { preheader: 'Something else entirely' }, 'preheader');
        expect(r.status).toBe(STATUS.FAIL);
    });

    it('survives content with no body at all', () => {
        expect(() => runQaField({}, { subject: 'x' }, 'subject')).not.toThrow();
        expect(() => runQaField(null, { subject: 'x' }, 'subject')).not.toThrow();
    });
});
