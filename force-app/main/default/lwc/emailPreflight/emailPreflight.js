/**
 * emailPreflight — CMS Editor Extension panel for the Email Preflight tool.
 *
 * Runs pre-send checks against the email or reusable content block open in the builder and reports
 * what it finds. All rules live in c/preflightEngine; this component is the panel UI plus the
 * editor read bridge.
 *
 * READ-ONLY: `updateContent` is deliberately NOT imported. There is no code path here that can
 * modify a customer's content — the worst case is a wrong report, never a damaged email.
 *
 * Interim tool: MCE had a pre-send validation step; MCN surfaces these failures only afterwards,
 * as EngagementActionReasonText rows in the Email Engagement DMO.
 */
import { LightningElement, track, wire } from 'lwc';
import { getContent, getContext } from 'experience/cmsEditorApi';
import {
    runPreflight,
    buildTextReport,
    buildSheetReport,
    buildComponentTree,
    BLOCK_ROLES,
    SEVERITY
} from 'c/preflightEngine';
import { collectQaTargets, compareValue, QA_FIELDS, QA_GROUPS, runQaField, STATUS } from 'c/qaCompare';

// Content-type fully-qualified names the editor reports through getContext.
const TYPE_EMAIL = 'sfdc_cms__email';
const TYPE_RCB = 'sfdc_cms__emailFragment';
const TYPE_TEMPLATE = 'sfdc_cms__emailTemplate';

const STATE_UNKNOWN = 'unknown';
const STATE_EMAIL = 'email';
const STATE_RCB = 'rcb';
const STATE_TEMPLATE = 'template';
const STATE_UNSUPPORTED = 'unsupported';

/** SLDS theme per severity — errors red, warnings yellow, notes plain. */
const BOX_CLASS = {
    [SEVERITY.ERROR]: 'slds-box slds-box_x-small slds-theme_error slds-m-bottom_x-small',
    [SEVERITY.WARNING]: 'slds-box slds-box_x-small slds-theme_warning slds-m-bottom_x-small',
    [SEVERITY.INFO]: 'slds-box slds-box_x-small slds-theme_shade slds-m-bottom_x-small'
};

const BADGE = {
    [SEVERITY.ERROR]: 'ERROR',
    [SEVERITY.WARNING]: 'WARNING',
    [SEVERITY.INFO]: 'NOTE'
};

/** Sentinel for the unfiltered view. Not a severity, so it can never collide with one. */
const FILTER_ALL = 'all';

/**
 * Sentinel for the "not in any section" row of the tree.
 *
 * Wrapped in angle brackets so it cannot collide with a real position string: describeOne only ever
 * emits `Section 3 of 6` and friends, and none of those contain a bracket.
 */
const SECTION_GLOBAL = '<whole>';

/** Pill styling per worst-severity in a tree row. Empty severity means the row is clean. */
const TREE_PILL = {
    [SEVERITY.ERROR]: 'tree-pill tree-pill_error',
    [SEVERITY.WARNING]: 'tree-pill tree-pill_warning',
    [SEVERITY.INFO]: 'tree-pill tree-pill_info',
    '': 'tree-pill tree-pill_clean'
};

/** Themes for the QA tab. Pass is green, fail is red; nothing here is advisory. */
const QA_BOX = {
    [STATUS.PASS]: 'slds-box slds-box_x-small slds-theme_success slds-m-bottom_x-small',
    [STATUS.FAIL]: 'slds-box slds-box_x-small slds-theme_error slds-m-bottom_x-small'
};
const QA_BADGE = { [STATUS.PASS]: 'MATCHES', [STATUS.FAIL]: 'DOES NOT MATCH' };

/** Built from the engine's field list so a new field cannot arrive without somewhere to type it. */
const EMPTY_SPEC = QA_FIELDS.reduce((acc, f) => ({ ...acc, [f.id]: '' }), {});

const COPY_IDLE = 'idle';
const COPY_DONE = 'done';
const COPY_FAILED = 'failed';
/** How long the button admits to having copied something before returning to its normal label. */
const COPY_FEEDBACK_MS = 2000;

/** What a collapsed QA group says about itself, so it need not be opened to know where it stands. */
function groupStatus(total, checked, failing) {
    if (total === 0) return '';
    if (checked === 0) return `${total} to check`;
    if (failing === 0) return `${checked} of ${total} checked, all match`;
    return `${checked} of ${total} checked, ${failing} failing`;
}

/** Humanize a raw contentTypeFQN (e.g. "sfdc_cms__sms" → "SMS") for friendly messaging. */
function friendlyTypeName(fqn) {
    if (!fqn || typeof fqn !== 'string') return 'this content';
    if (fqn === TYPE_EMAIL) return 'Email';
    if (fqn === TYPE_RCB) return 'Reusable Content Block';
    if (fqn === TYPE_TEMPLATE) return 'Email Template';
    const bare = fqn.includes('__') ? fqn.split('__').pop() : fqn;
    if (/^sms$/i.test(bare)) return 'SMS';
    const spaced = bare.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : 'this content';
}

export default class EmailPreflight extends LightningElement {
    @track detectionState = STATE_UNKNOWN;
    @track detectedType = '';
    @track isLoading = false;
    @track hasRun = false;
    @track errorMessage = '';
    @track result = null;

    /**
     * Safety fallback for the rare case where the editor never reports a content type: without it
     * the panel would auto-scan never, and sit blank with no way for the user to proceed.
     */
    @track manualMode = 'email';

    /** Which of header / body / footer this block is. Empty until the author says. */
    @track blockRoles = [];

    /**
     * Findings the reviewer has chosen to ignore, keyed by the engine's finding id.
     *
     * Session-only, and deliberately NOT cleared by a re-check. Ignoring is a judgement about the
     * finding — "we know, it is deliberate, stop telling us" — and the reviewer's next act is nearly
     * always to fix something else and re-run. Having the dismissed finding reappear at exactly that
     * moment would make the button useless. Ids are rule-based for the same reason, so they survive
     * the content changing underneath them.
     */
    @track ignored = {};

    /**
     * Which severities the findings list shows — 'all', or one of SEVERITY.*.
     *
     * Defaults to 'all' rather than hiding notes: findings are already sorted most-severe-first, so
     * errors are at the top either way, and a checking tool that silently withholds findings by
     * default is working against itself. The filter is for narrowing on purpose, not for tidying.
     *
     * Deliberately NOT reset by a re-check. Someone who filtered to errors, fixed them and re-ran
     * wants to see whether any errors came back, not to be dropped into the full list again.
     */
    @track severityFilter = FILTER_ALL;

    /**
     * Which section of the tree the list is narrowed to. Empty means all of them.
     *
     * Holds the section's position string (`Section 3 of 6`) rather than an index, because that is
     * what the findings themselves carry — matching on the same string the reader can see keeps the
     * filter and the labels honest with each other.
     */
    @track sectionFilter = '';

    /**
     * Whether the tree is unfolded. Closed to begin with, and left alone by a re-check.
     *
     * A reader opens it when they want to know where to go, and folds it again while working through
     * a section — having it spring back open on every re-check would undo that each time.
     */
    @track treeOpen = false;

    /**
     * Whether the "built from" card is unfolded. Folded to begin with, because its summary line
     * already answers the question for most readers and the panel lives in a narrow sidebar.
     */
    @track usageOpen = false;

    /** idle → done on a successful copy, or failed when the clipboard is not available to us. */
    @track copyState = COPY_IDLE;
    @track copySheetState = COPY_IDLE;
    @track copyShapeState = COPY_IDLE;

    /** The whole-email expectations. Session-only; never written to the org. */
    @track qaSpec = { ...EMPTY_SPEC };
    /** Per-item expectations, keyed by the target key from collectQaTargets. */
    @track qaRowSpec = {};
    /** Results keyed by field id or row key. Absent means "not validated yet", not "passed". */
    @track qaResults = {};
    @track qaError = '';

    /**
     * Which per-item groups are open, by group id. All closed to begin with.
     *
     * A real email produces something like sixteen rows across the four groups, and every one of
     * them is a label, a current value, an input and a button. Opening on arrival buries the two
     * whole-email fields and makes the tab a single long scroll, which is the thing to avoid — so
     * the reviewer opens the group they are working on and folds it when done.
     */
    @track expandedGroups = {};

    copyResetTimer = null;
    copySheetTimer = null;
    copyShapeTimer = null;

    currentContent;

    @wire(getContent)
    wiredContent({ error, data }) {
        if (data) {
            this.currentContent = data;
            this.maybeAutoScan();
        } else if (error) {
            this.errorMessage = 'Could not read the editor content.';
        }
    }

    @wire(getContext)
    wiredContext({ data }) {
        if (data) {
            this.maybeDetectType(data.contentTypeFQN);
            this.maybeAutoScan();
        }
    }

    maybeDetectType(t) {
        if (!t || this.detectedType) return; // resolve once
        this.detectedType = t;
        if (t === TYPE_EMAIL) this.detectionState = STATE_EMAIL;
        else if (t === TYPE_RCB) this.detectionState = STATE_RCB;
        else if (t === TYPE_TEMPLATE) this.detectionState = STATE_TEMPLATE;
        else this.detectionState = STATE_UNSUPPORTED;
    }

    /**
     * Scan as soon as both wires have delivered. The scan is read-only and purely local, so there is
     * no reason to make the user click a button to see results they can't affect by waiting.
     */
    maybeAutoScan() {
        if (this.hasRun || this.isUnsupported) return;
        if (!this.currentContent || this.detectionState === STATE_UNKNOWN) return;
        this.runScan();
    }

    // ---- derived UI state ------------------------------------------------------

    get isUnsupported() {
        return this.detectionState === STATE_UNSUPPORTED;
    }
    /** Which ruleset to apply — detection normally, the manual radio only when detection failed. */
    get isRcb() {
        if (this.detectionState === STATE_RCB) return true;
        if (this.detectionState === STATE_UNKNOWN) return this.manualMode === 'rcb';
        return false;
    }
    /**
     * A template gets the email ruleset, because a template is an email layout — every rule about
     * links, images, compliance and rendering applies to it just as it does to the email it will
     * produce. Checking it here is also the earlier place to catch a fault: a broken master template
     * is a fault repeated across every email built from it.
     */
    get isTemplate() {
        if (this.detectionState === STATE_TEMPLATE) return true;
        if (this.detectionState === STATE_UNKNOWN) return this.manualMode === 'template';
        return false;
    }
    /** The manual radio appears only in the unresolved-detection fallback. */
    get showModeFallback() {
        return this.detectionState === STATE_UNKNOWN && !this.hasRun;
    }
    get modeOptions() {
        return [
            { label: 'Email', value: 'email' },
            { label: 'Email template', value: 'template' },
            { label: 'Reusable content block', value: 'rcb' }
        ];
    }
    get friendlyType() {
        const name = friendlyTypeName(this.detectedType);
        return /^[aeiou]/i.test(name) ? `an ${name}` : `a ${name}`;
    }
    get unsupportedMessage() {
        return `This tool checks Emails, Email Templates and Reusable Content Blocks. The current content is ${this.friendlyType}, so there's nothing to check here.`;
    }
    get detectedNote() {
        if (this.isRcb) {
            return 'Reusable Content Block — subject line and preheader rules are skipped; block compatibility rules are added.';
        }
        if (this.isTemplate) {
            return 'Email Template — checked as an email would be, so anything wrong here is wrong in every email built from it.';
        }
        if (this.detectionState === STATE_EMAIL) {
            return 'Email — checking scripting, links, images, compliance and content basics.';
        }
        return 'Waiting for the editor to report the content type…';
    }
    get showResults() {
        return this.hasRun && !this.isUnsupported && this.result;
    }

    /*
     * Tab labels follow what is open.
     *
     * "Email Issues" while the reader is looking at a footer block is a small lie that costs real
     * confusion — it invites them to expect subject-line checks, then to conclude the tool is broken
     * when none appear. The label is the cheapest place to say what is being checked.
     */
    get issuesTabLabel() {
        if (this.isRcb) return 'Content Block Issues';
        return this.isTemplate ? 'Template Issues' : 'Email Issues';
    }
    get qaTabLabel() {
        if (this.isRcb) return 'Content Block QA';
        return this.isTemplate ? 'Template QA' : 'Email QA';
    }
    /** The noun the rest of the panel copy uses, so one getter changes all of it. */
    get contentNoun() {
        if (this.isRcb) return 'content block';
        return this.isTemplate ? 'template' : 'email';
    }

    // ---- block role -------------------------------------------------------------

    /**
     * What this block is for — header, body, footer, or several at once.
     *
     * Only asked for a block, because an email is all three. It is genuinely the author's call and
     * nothing in the content body reliably reveals it: a footer is recognisable to a person by what
     * it means, not by a field. Guessing from keywords would be wrong often enough to be worse than
     * asking, and the consequence of guessing wrong is either a nonsense finding or a silent gap in
     * a legal check.
     */
    get blockRoleOptions() {
        return BLOCK_ROLES.map((r) => ({ label: `${r.label} — ${r.hint}`, value: r.id }));
    }
    get hasBlockRole() {
        return this.blockRoles.length > 0;
    }

    handleBlockRoleChange(event) {
        this.blockRoles = [...event.detail.value];
        // Re-scan immediately. The choice only exists to change the findings, so making the user
        // press Re-check afterwards would be asking them to confirm something they just said.
        if (this.hasRun) this.runScan();
    }

    // ---- embedded blocks in an email ---------------------------------------------

    /*
     * The blocks this email pulls in, pinned above the results.
     *
     * BLK001 already carries this, but it is a note, and findings sort errors first — so on a real
     * email the one line explaining why the compliance warnings might be wrong lands under twenty
     * other rows. That is how somebody concludes the tool is broken rather than partial. Nothing new
     * is being said here; it is being said where it will be read.
     */
    get embeddedBlockRows() {
        const blocks = (this.result && this.result.embeddedBlocks) || [];
        return blocks.map((b, i) => ({
            key: `${b.contentKey || 'block'}-${i}`,
            // A name if the reference carried one, otherwise the content key, which is at least
            // searchable. Never both, and never an empty bullet.
            title: b.name || b.contentKey || 'Unnamed block',
            where: b.label,
            // Only shown when it is not already doing duty as the title.
            contentKey: b.name && b.contentKey ? b.contentKey : ''
        }));
    }
    get hasEmbeddedBlocks() {
        return !this.isRcb && this.embeddedBlockRows.length > 0;
    }
    get embeddedBlockHeading() {
        const n = this.embeddedBlockRows.length;
        return n === 1
            ? `This ${this.contentNoun} contains a content block that was not checked`
            : `This ${this.contentNoun} contains ${n} content blocks that were not checked`;
    }
    get contentName() {
        return (this.currentContent && this.currentContent.title) || '';
    }

    // ---- what the email is built from ---------------------------------------------

    /**
     * The template and brand behind this email.
     *
     * Shown as content keys because that is honestly all there is: turning a key into a name needs a
     * server call, and this panel makes none. The key is still the half worth having — it is what
     * CMS search matches on, so it is what somebody would paste in to go and look.
     *
     * A template row appears only for emails built from a saved template. The out-of-the-box starter
     * layouts copy themselves in and leave no reference behind, so their absence here is a fact
     * about how the email was made rather than a gap in what the panel can see.
     */
    get usageRows() {
        const usage = (this.result && this.result.usage) || null;
        if (!usage) return [];
        const rows = [];
        if (usage.template) {
            const { contentKey, locked, components } = usage.template;
            rows.push({
                key: 'template',
                label: 'Template',
                value: contentKey,
                // A template that locks nothing is a starting point, not a guardrail. Worth saying
                // plainly to anyone who assumed theirs was protecting the layout.
                note: components
                    ? locked === 0
                        ? `Nothing locked — all ${components} components are editable`
                        : `${locked} of ${components} components locked`
                    : ''
            });
        }
        if (usage.brand) {
            const { contentKey } = usage.brand;
            rows.push({
                key: 'brand',
                label: 'Brand',
                value: contentKey || 'Salesforce default',
                note: contentKey ? '' : 'No brand content item — the org default is in use'
            });
        }
        return rows;
    }

    /** CMS images placed in the email, by key, with the file name where the reference carries one. */
    get usageImages() {
        const usage = (this.result && this.result.usage) || null;
        return ((usage && usage.images) || []).map((img) => ({
            key: img.contentKey,
            contentKey: img.contentKey,
            fileName: img.fileName
        }));
    }

    get hasUsage() {
        return this.usageRows.length > 0 || this.usageImages.length > 0;
    }
    get hasUsageImages() {
        return this.usageImages.length > 0;
    }
    get usageImagesHeading() {
        return `Images (${this.usageImages.length})`;
    }

    /**
     * What the card says while folded.
     *
     * Carries the actual answer rather than a row count, so the common question — what is this email
     * made of — is answered without anyone having to open anything.
     */
    get usageSummary() {
        const usage = (this.result && this.result.usage) || {};
        const parts = [];
        if (usage.template) parts.push('template');
        if (usage.brand) parts.push('brand');
        const n = this.usageImages.length;
        if (n > 0) parts.push(`${n} image${n === 1 ? '' : 's'}`);
        const text = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts[0];
        return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
    }

    get usageChevron() {
        return this.usageOpen ? 'utility:chevrondown' : 'utility:chevronright';
    }
    get usageAriaExpanded() {
        return this.usageOpen ? 'true' : 'false';
    }
    handleUsageToggle() {
        this.usageOpen = !this.usageOpen;
    }

    // ---- ignored findings ---------------------------------------------------------

    /**
     * The findings still in play, with anything the reviewer dismissed taken out.
     *
     * Everything downstream reads this rather than `result.findings`: the counts, the severity
     * filter, the list and both copy buttons. Filtering in one place is what makes "ignored" mean
     * the same thing everywhere — a count that still includes a dismissed finding would make the
     * reviewer doubt whether the dismissal took, which is worse than not offering it.
     */
    get keptFindings() {
        if (!this.result) return [];
        return this.result.findings.filter((f) => !this.ignored[f.id]);
    }
    get keptCounts() {
        const counts = { error: 0, warning: 0, info: 0, total: 0 };
        for (const f of this.keptFindings) {
            counts[f.severity] += 1;
            counts.total += 1;
        }
        return counts;
    }
    get ignoredCount() {
        return this.result ? this.result.findings.length - this.keptFindings.length : 0;
    }
    get hasIgnored() {
        return this.ignoredCount > 0;
    }
    get ignoredNote() {
        const n = this.ignoredCount;
        return `${n} ${n === 1 ? 'issue' : 'issues'} ignored — left out of the counts above and out of both copy buttons.`;
    }

    handleIgnore(event) {
        this.ignored = { ...this.ignored, [event.target.dataset.id]: true };
    }
    handleRestoreIgnored() {
        this.ignored = {};
    }

    /** Genuinely nothing found. Distinct from everything having been ignored, which is isAllIgnored. */
    get isClean() {
        return Boolean(this.result) && this.result.counts.total === 0;
    }
    get isAllIgnored() {
        return Boolean(this.result) && this.result.counts.total > 0 && this.keptFindings.length === 0;
    }
    get statsLine() {
        if (!this.result) return '';
        const s = this.result.stats;
        return `${this.result.checksRun} checks over ${s.links} link(s), ${s.images} image(s), ${s.expressions} expression(s) and ${s.textChars} character(s) of copy — about ${s.sizeKb} KB.`;
    }

    /**
     * The severity counts, which are also the severity filter.
     *
     * These used to be two things stacked: a bordered table of three numbers, and a row of four
     * buttons underneath repeating the same three words. The numbers were not clickable and the
     * buttons carried no numbers, so between them they asked the reader to look in two places to
     * answer one question. Merging them costs nothing — the count is the label, and clicking it
     * filters to that severity.
     *
     * A severity with nothing in it is disabled rather than hidden, so the zero still reads as a
     * result and the row does not change width as findings get fixed.
     */
    get countChips() {
        const counts = this.keptCounts;
        const chip = (severity, label, count, hint, tone) => {
            const on = this.severityFilter === severity;
            return {
                key: severity,
                severity,
                label,
                count,
                hint,
                pressed: String(on),
                // The active filter stays enabled even at zero, so fixing the last error doesn't
                // leave a selected-but-dead chip with no obvious way back.
                disabled: count === 0 && severity !== FILTER_ALL && !on,
                chipClass: `count-chip${on ? ' count-chip_on' : ''}`,
                // Colour is earned by having something in it: a red zero would read as a problem.
                numClass: tone && count > 0 ? `count-num count-num_${tone}` : 'count-num'
            };
        };
        return [
            chip(FILTER_ALL, 'All', counts.total, 'Everything found'),
            chip(SEVERITY.ERROR, 'Errors', counts.error, 'Fix these before you send', 'error'),
            chip(SEVERITY.WARNING, 'Warnings', counts.warning, 'Worth a look before you send', 'warning'),
            chip(SEVERITY.INFO, 'Notes', counts.info, 'Optional — read if you have time')
        ];
    }

    // ---- component tree ------------------------------------------------------------

    /**
     * Where the findings are, section by section.
     *
     * The findings list sorts by severity, which is right for triage and wrong for repair — nobody
     * fixes an email by severity, they open a section and fix everything wrong with it. This is the
     * other view of the same data, and clicking a row narrows the list to it.
     *
     * Built from the KEPT findings, so ignoring one takes it out of the tree counts too. A count
     * that still included a dismissed finding would send someone into a section to look for
     * something they already decided to live with.
     */
    get tree() {
        const body = this.currentContent && this.currentContent.contentBody;
        if (!body || !this.result) return [];
        return buildComponentTree(body, this.keptFindings);
    }

    get treeRows() {
        return this.tree.map((row) => {
            const n = row.counts.total;
            const selected = this.sectionFilter === this.rowFilterValue(row);
            return {
                key: row.key,
                filterValue: this.rowFilterValue(row),
                label: row.kind === 'global' ? `Everything else in this ${this.contentNoun}` : row.label,
                isBlock: row.kind === 'block',
                // A block is listed so its content is not mistaken for checked, but it holds no
                // count of its own and clicking it would filter to nothing.
                blockNote: row.name || row.contentKey || 'open it to check it',
                countLabel: n === 0 ? 'None' : `${n}`,
                countTitle: n === 1 ? '1 issue' : `${n} issues`,
                pillClass: TREE_PILL[row.worst] || TREE_PILL[''],
                rowClass: selected ? 'tree-row tree-row_selected' : 'tree-row',
                icon: row.kind === 'block' ? 'utility:page' : 'utility:layout',
                isSelected: selected,
                ariaPressed: selected ? 'true' : 'false'
            };
        });
    }

    rowFilterValue(row) {
        return row.kind === 'global' ? SECTION_GLOBAL : row.place;
    }

    /**
     * Shown only when there is something to navigate. One section and nothing else is not a tree,
     * it is a restatement of the counts with extra furniture.
     */
    get showTree() {
        return this.tree.length > 1;
    }

    get treeChevron() {
        return this.treeOpen ? 'utility:chevrondown' : 'utility:chevronright';
    }
    get treeAriaExpanded() {
        return this.treeOpen ? 'true' : 'false';
    }
    handleTreeToggle() {
        this.treeOpen = !this.treeOpen;
    }

    /**
     * What the header says when the tree is folded.
     *
     * An active section filter takes priority over the section tally. Folded, this line is the only
     * place that filter is visible, and a filter you cannot see is a filter you cannot undo — the
     * reader would be looking at four findings out of twenty with nothing on screen explaining why.
     */
    get treeSummary() {
        if (this.hasSectionFilter) return `Showing ${this.sectionFilterLabel}`;
        const sections = this.tree.filter((r) => r.kind === 'section');
        const withIssues = sections.filter((r) => r.counts.total > 0).length;
        if (sections.length === 0) return '';
        return withIssues === 0
            ? 'no issues in any section'
            : `${withIssues} of ${sections.length} sections`;
    }
    get treeSummaryClass() {
        return this.hasSectionFilter ? 'tree-summary tree-summary_active' : 'tree-summary';
    }
    get treeHint() {
        return this.hasMultiSectionFinding
            ? 'Tap a section to see only its issues. A few issues name more than one section and are counted in each, so these can add up to more than the total.'
            : 'Tap a section to see only its issues.';
    }
    get hasMultiSectionFinding() {
        return this.tree.reduce((sum, r) => sum + r.counts.total, 0) > this.keptCounts.total;
    }

    handleTreeSelect(event) {
        const value = event.currentTarget.dataset.place;
        // Clicking the active row clears it, so the way out is the same control as the way in.
        this.sectionFilter = this.sectionFilter === value ? '' : value;
    }
    handleClearFilters() {
        this.sectionFilter = '';
        this.severityFilter = FILTER_ALL;
    }
    get hasSectionFilter() {
        return this.sectionFilter !== '';
    }
    get sectionFilterLabel() {
        const row = this.tree.find((r) => this.rowFilterValue(r) === this.sectionFilter);
        if (!row) return '';
        return row.kind === 'global' ? `everything else in this ${this.contentNoun}` : row.place;
    }

    /** True when this finding is placed in at least one of the tree's sections. */
    inSomeSection(finding) {
        const places = this.tree.filter((r) => r.kind === 'section' && r.place).map((r) => r.place);
        return (finding.locations || []).some((l) => places.some((p) => String(l).includes(p)));
    }

    /** Findings left after ignoring, the section filter and the severity filter, most severe first. */
    get visibleFindings() {
        let out = this.keptFindings;
        if (this.severityFilter !== FILTER_ALL) {
            out = out.filter((f) => f.severity === this.severityFilter);
        }
        if (this.sectionFilter === SECTION_GLOBAL) {
            out = out.filter((f) => !this.inSomeSection(f));
        } else if (this.sectionFilter) {
            out = out.filter((f) => (f.locations || []).some((l) => String(l).includes(this.sectionFilter)));
        }
        return out;
    }

    /**
     * True when there are findings to show but the current filter hides all of them — distinct from
     * the clean-run case, and from everything having been ignored. All three need a different
     * message, because all three are "an empty list" for a different reason.
     */
    get isFilteredEmpty() {
        return this.keptFindings.length > 0 && this.visibleFindings.length === 0;
    }

    get filteredEmptyMessage() {
        const label = { [SEVERITY.ERROR]: 'errors', [SEVERITY.WARNING]: 'warnings', [SEVERITY.INFO]: 'notes' }[
            this.severityFilter
        ];
        const total = this.keptCounts.total;
        if (this.hasSectionFilter && label) {
            return `No ${label} in ${this.sectionFilterLabel}. There are ${total} finding(s) elsewhere.`;
        }
        if (this.hasSectionFilter) {
            return `Nothing left in ${this.sectionFilterLabel}. There are ${total} finding(s) elsewhere.`;
        }
        return `No ${label} found. There are ${total} other finding(s) — choose All to see them.`;
    }

    /**
     * Findings as view models. Severity theming and location keys are precomputed here because LWC
     * templates can't call functions with arguments, and raw location strings can repeat (which
     * would collide as for:each keys).
     */
    get findingViews() {
        return this.visibleFindings.map((f, i) => ({
            key: `${f.rule}-${i}`,
            id: f.id,
            rule: f.rule,
            ignoreTitle: `Ignore ${f.rule} — ${f.title}`,
            title: f.title,
            detail: f.detail,
            badge: BADGE[f.severity],
            boxClass: BOX_CLASS[f.severity],
            hasLocations: f.locations.length > 0,
            locations: f.locations.map((text, j) => ({ id: `${f.rule}-${j}`, text })),
            truncatedNote: f.truncated > 0 ? `…and ${f.truncated} more` : '',
            hasTruncated: f.truncated > 0
        }));
    }

    /**
     * What both copy buttons report on: everything except what was ignored.
     *
     * The severity filter is deliberately NOT applied. The two look similar and mean opposite
     * things. Filtering to Errors is a way of looking — the other findings are still there and the
     * reviewer expects the report to contain them, so excluding them would hand over a subset that
     * reads as complete. Ignoring a finding is a decision about the finding itself, and carrying it
     * into the export is the whole point of the button.
     *
     * The count of ignored findings rides along so buildTextReport can say the list was curated.
     */
    get reportResult() {
        const findings = this.keptFindings;
        return { ...this.result, findings, counts: this.keptCounts, ignored: this.ignoredCount };
    }
    get reportText() {
        return this.result ? buildTextReport(this.reportResult, this.contentName) : '';
    }

    get copyButtonLabel() {
        return this.copyState === COPY_DONE ? 'Copied' : 'Copy report';
    }
    get copyButtonIcon() {
        return this.copyState === COPY_DONE ? 'utility:check' : 'utility:copy_to_clipboard';
    }
    get copyFailed() {
        return this.copyState === COPY_FAILED;
    }

    /**
     * The same findings as tab-separated rows, for pasting into a QA tracking sheet.
     *
     * Same set as the text report — ignored findings out, the severity filter irrelevant. No note
     * about the ignored ones here: a trailing prose row would shear the table it is pasted into, and
     * the person doing the ignoring is the person doing the pasting.
     */
    get sheetText() {
        return this.result ? buildSheetReport(this.reportResult, this.contentName) : '';
    }

    get copySheetLabel() {
        return this.copySheetState === COPY_DONE ? 'Copied — paste into Excel' : 'Copy for Excel';
    }
    get copySheetIcon() {
        return this.copySheetState === COPY_DONE ? 'utility:check' : 'utility:table';
    }
    get copySheetFailed() {
        return this.copySheetState === COPY_FAILED;
    }

    // ---- Email QA tab ------------------------------------------------------------

    /**
     * The whole-item fields that apply to what is open.
     *
     * Email-only fields drop out for a block. Both current ones are email-only, so with a block open
     * this list is empty and the section disappears entirely — which is correct: a footer has no
     * subject line, and offering a box for one invites a reviewer to paste the subject of the email
     * they were just looking at and collect a pass that means nothing.
     */
    get qaFieldDefs() {
        return QA_FIELDS.filter((f) => !f.emailOnly || !this.isRcb);
    }
    /**
     * The QA form: one entry per field, each carrying its own input, validate button and result.
     *
     * Driven off the engine's QA_FIELDS rather than written out in the template, so a field can't be
     * added to the comparison logic and silently end up with nowhere to type it.
     */
    get qaFields() {
        return this.qaFieldDefs.map((f) => {
            const result = this.qaResults[f.id];
            return {
                id: f.id,
                label: f.label,
                value: this.qaSpec[f.id],
                isMultiline: f.multiline,
                isSingleLine: !f.multiline,
                hasResult: Boolean(result),
                result: result ? this.qaResultView(result) : null
            };
        });
    }
    get hasQaFields() {
        return this.qaFieldDefs.length > 0;
    }

    /**
     * The per-item groups: every link, every clickable label and every image the email actually
     * contains, each with its own box to say what it should be.
     *
     * This is the inversion the reviewer asked for. Typing a list into one box means the tool has to
     * guess which entry refers to which component, and the reviewer has to hold the email's
     * structure in their head. Listing what is there — "Image 1 in Section 3" — and asking what it
     * should be removes both problems, and makes an unexpected link visible just by being in the
     * list with nothing typed against it.
     */
    get qaGroups() {
        let targets;
        try {
            targets = collectQaTargets(this.currentContent);
        } catch (e) {
            return [];
        }
        return QA_GROUPS.map((g) => {
            let checked = 0;
            let failing = 0;
            const rows = (targets[g.id] || []).map((t) => {
                const result = this.qaResults[t.key];
                if (result && result.status !== STATUS.SKIPPED) {
                    checked += 1;
                    if (result.status === STATUS.FAIL) failing += 1;
                }
                return {
                    key: t.key,
                    label: t.label,
                    actual: t.actual,
                    hasActual: Boolean(t.actual),
                    isSystem: Boolean(t.system),
                    prompt: g.prompt,
                    value: this.qaRowSpec[t.key] || '',
                    hasResult: Boolean(result),
                    result: result ? this.qaResultView(result) : null
                };
            });
            const expanded = Boolean(this.expandedGroups[g.id]);
            return {
                id: g.id,
                title: g.title,
                empty: g.empty.replace('{noun}', this.contentNoun),
                isEmpty: rows.length === 0,
                // The header carries the group's state so a folded group still reports itself. Being
                // able to fold a finished group and still see it is finished is the point.
                status: groupStatus(rows.length, checked, failing),
                statusClass: failing > 0 ? 'qa-group-status qa-group-status_fail' : 'qa-group-status',
                isExpanded: expanded,
                ariaExpanded: expanded ? 'true' : 'false',
                chevron: expanded ? 'utility:chevrondown' : 'utility:chevronright',
                rows
            };
        });
    }

    handleToggleGroup(event) {
        const id = event.currentTarget.dataset.group;
        this.expandedGroups = { ...this.expandedGroups, [id]: !this.expandedGroups[id] };
    }

    /** One result as a view model. Shared by the whole-email fields and the per-item rows. */
    qaResultView(r) {
        return {
            skipped: r.status === STATUS.SKIPPED,
            badge: QA_BADGE[r.status] || '',
            boxClass: QA_BOX[r.status] || 'slds-box slds-box_x-small slds-theme_shade slds-m-bottom_x-small',
            detail: r.detail || '',
            // Both sides are only worth printing when they actually differ.
            showBoth: r.status === STATUS.FAIL && typeof r.expected === 'string' && r.expected !== '',
            expected: r.expected,
            actual: r.actual
        };
    }

    get qaSummary() {
        const done = Object.keys(this.qaResults)
            .map((k) => this.qaResults[k])
            .filter((r) => r && r.status !== STATUS.SKIPPED);
        if (done.length === 0) return '';
        const failed = done.filter((r) => r.status === STATUS.FAIL).length;
        if (failed === 0) return `${done.length} checked item(s) match the ${this.contentNoun}.`;
        return `${done.length - failed} of ${done.length} checked item(s) match. ${failed} do not.`;
    }

    get hasQaSummary() {
        return this.qaSummary !== '';
    }

    handleQaInput(event) {
        this.qaSpec = { ...this.qaSpec, [event.target.dataset.field]: event.target.value };
    }

    handleRowInput(event) {
        this.qaRowSpec = { ...this.qaRowSpec, [event.target.dataset.key]: event.target.value };
    }

    handleValidateField(event) {
        this.runValidation([event.target.dataset.field], []);
    }

    handleValidateRow(event) {
        this.runValidation([], [event.target.dataset.key]);
    }

    handleValidateAll() {
        const keys = this.qaGroups.reduce((acc, g) => acc.concat(g.rows.map((r) => r.key)), []);
        // qaFieldDefs, not QA_FIELDS: a field with no box on screen must not be validated behind the
        // reviewer's back, or an empty subject would count itself into "3 checked items match".
        this.runValidation(this.qaFieldDefs.map((f) => f.id), keys);
    }

    /**
     * Validate some whole-email fields and some per-item rows.
     *
     * Targets are re-read from the live content rather than from whatever the last render produced,
     * so a row cannot be checked against a component that has since been edited or deleted.
     */
    runValidation(fieldIds, rowKeys) {
        this.qaError = '';
        if (!this.currentContent || !this.currentContent.contentBody) {
            this.qaError = 'Could not read the editor content. Open a valid email or content block.';
            return;
        }
        const next = { ...this.qaResults };
        const openUp = {};
        try {
            for (const id of fieldIds) next[id] = runQaField(this.currentContent, this.qaSpec, id);

            if (rowKeys.length) {
                const targets = collectQaTargets(this.currentContent);
                const byKey = new Map();
                for (const g of QA_GROUPS) {
                    for (const t of targets[g.id] || []) byKey.set(t.key, { ...t, kind: g.kind, group: g.id });
                }
                for (const key of rowKeys) {
                    const t = byKey.get(key);
                    if (!t) continue; // the component is gone; leave any previous result alone
                    next[key] = compareValue(t.kind, this.qaRowSpec[key], t.actual);
                    // Validate all can fail a row inside a folded group. Reporting that only in the
                    // header would leave the reviewer hunting for which row it was.
                    if (next[key].status === STATUS.FAIL) openUp[t.group] = true;
                }
            }
            this.qaResults = next;
            if (Object.keys(openUp).length) this.expandedGroups = { ...this.expandedGroups, ...openUp };
        } catch (e) {
            this.qaError = (e && e.message) || 'An unexpected error occurred while validating.';
        }
    }

    handleQaClear() {
        this.qaSpec = { ...EMPTY_SPEC };
        this.qaRowSpec = {};
        this.qaResults = {};
        this.qaError = '';
        this.expandedGroups = {};
    }

    /**
     * Key-path outline of the content body, for when a rule misfires.
     *
     * Every rule encodes an assumption about where the builder stores something — which field holds a
     * button's URL, where alt text lives. Those shapes are not documented and differ per component,
     * so when someone reports a false positive this outline is what makes the fix exact instead of
     * another guess. Collapsed by default; it is developer output, not part of the report.
     */
    get shapeText() {
        return this.result ? this.result.shape : '';
    }

    get copyShapeLabel() {
        if (this.copyShapeState === COPY_DONE) return 'Copied';
        if (this.copyShapeState === COPY_FAILED) return 'Copy blocked — select the text below';
        return 'Copy structure';
    }

    get copyShapeIcon() {
        return this.copyShapeState === COPY_DONE ? 'utility:check' : 'utility:copy_to_clipboard';
    }

    // ---- actions ---------------------------------------------------------------

    handleRescan() {
        this.runScan();
    }

    handleModeChange(event) {
        this.manualMode = event.detail.value;
    }

    /**
     * currentTarget, not target: the chip is a plain button wrapping two spans, so a click usually
     * lands on the number or the label rather than the button that carries the dataset.
     */
    handleFilter(event) {
        this.severityFilter = event.currentTarget.dataset.severity;
    }

    /**
     * Copy the report to the clipboard, and fall back to the textarea when we can't.
     *
     * The failure path is not defensive padding. This panel renders inside the builder's extension
     * frame, and the Clipboard API is gated by both a secure context and a `clipboard-write`
     * permission policy that a host frame is free not to grant. When that happens `writeText`
     * rejects — or `navigator.clipboard` is simply absent, which throws instead. Both land here, and
     * the answer is the same: show the text and let the user copy it by hand.
     */
    async handleCopyReport() {
        this.clearCopyTimer();
        try {
            await navigator.clipboard.writeText(this.reportText);
            this.copyState = COPY_DONE;
            this.copyResetTimer = setTimeout(() => {
                this.copyState = COPY_IDLE;
                this.copyResetTimer = null;
            }, COPY_FEEDBACK_MS);
        } catch (e) {
            this.copyState = COPY_FAILED;
        }
    }

    /**
     * Same as handleCopyReport, for the spreadsheet rows.
     *
     * Its own state so a failure copying one button does not relabel the other.
     */
    async handleCopySheet() {
        this.clearSheetTimer();
        try {
            await navigator.clipboard.writeText(this.sheetText);
            this.copySheetState = COPY_DONE;
            this.copySheetTimer = setTimeout(() => {
                this.copySheetState = COPY_IDLE;
                this.copySheetTimer = null;
            }, COPY_FEEDBACK_MS);
        } catch (e) {
            this.copySheetState = COPY_FAILED;
        }
    }

    /**
     * Same as handleCopyReport, for the structure dump.
     *
     * Separate state so a failure copying one does not mislabel the other button. No inline
     * fallback needed here — the textarea holding the structure is already on screen.
     */
    async handleCopyShape() {
        this.clearShapeTimer();
        try {
            await navigator.clipboard.writeText(this.shapeText);
            this.copyShapeState = COPY_DONE;
            this.copyShapeTimer = setTimeout(() => {
                this.copyShapeState = COPY_IDLE;
                this.copyShapeTimer = null;
            }, COPY_FEEDBACK_MS);
        } catch (e) {
            this.copyShapeState = COPY_FAILED;
        }
    }

    clearCopyTimer() {
        if (this.copyResetTimer) {
            clearTimeout(this.copyResetTimer);
            this.copyResetTimer = null;
        }
    }

    clearSheetTimer() {
        if (this.copySheetTimer) {
            clearTimeout(this.copySheetTimer);
            this.copySheetTimer = null;
        }
    }

    clearShapeTimer() {
        if (this.copyShapeTimer) {
            clearTimeout(this.copyShapeTimer);
            this.copyShapeTimer = null;
        }
    }

    disconnectedCallback() {
        this.clearCopyTimer();
        this.clearSheetTimer();
        this.clearShapeTimer();
    }

    runScan() {
        this.errorMessage = '';
        // A "Copied" badge left over from the previous report would be claiming something untrue
        // about the new one.
        this.clearCopyTimer();
        this.clearSheetTimer();
        this.clearShapeTimer();
        this.copyState = COPY_IDLE;
        this.copySheetState = COPY_IDLE;
        this.copyShapeState = COPY_IDLE;
        if (!this.currentContent || !this.currentContent.contentBody) {
            this.errorMessage = 'Could not read the editor content. Open a valid email or content block.';
            return;
        }
        this.isLoading = true;
        try {
            this.result = runPreflight(this.currentContent, {
                contentType: this.isRcb ? 'rcb' : this.isTemplate ? 'template' : 'email',
                blockRoles: this.blockRoles
            });
            this.hasRun = true;
        } catch (e) {
            this.errorMessage = (e && e.message) || 'An unexpected error occurred while checking this content.';
        } finally {
            this.isLoading = false;
        }
    }
}
