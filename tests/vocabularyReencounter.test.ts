import {parseHTML} from 'linkedom';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {Config, normalizeConfig} from '@/src/core/config/model';
import {createExpressionIndex, matchExpressions, reencounterSentence, reencounterSnapshot, reencounterTerm, type ReencounterEntry} from '@/src/features/vocabulary/domain/reencounter';
import {collectReadingGroups, scanReadingExpressions} from '@/src/features/vocabulary/content/readingText';
import {installReencounterScanner, REENCOUNTER_HIGHLIGHT} from '@/src/features/vocabulary/content/scanner';
import type {VocabularyEntry} from '@/src/features/vocabulary/learningModel';

const saved = (term: string, id = term): ReencounterEntry => ({id, term, sourceLanguage: 'en', reference: '', savedSentence: '', savedTitle: ''});
const find = (text: string, terms: string[]) => matchExpressions(text, createExpressionIndex(terms.map(term => saved(term))));

function dom(html: string) {
  const {document, window} = parseHTML(`<html><head></head><body>${html}</body></html>`);
  Object.assign(window, {innerHeight: 800, CSS: {highlights: new Map()}, Highlight: class extends Set {},
    getComputedStyle: (element: Element) => ({display: element.getAttribute('data-display') || (/^(SPAN|EM|STRONG|B|I|SLOT)$/u.test(element.tagName) ? 'inline' : 'block'), visibility: element.getAttribute('data-visibility') || 'visible'}),
  });
  window.HTMLElement.prototype.getBoundingClientRect = function () {return {top: this.hasAttribute('data-far') ? 3000 : 100, bottom: this.hasAttribute('data-far') ? 3100 : 140, left: 0, right: 100, width: 100, height: 40} as DOMRect;};
  document.createRange = (() => {
    const range = {startContainer: null as unknown as Text, endContainer: null as unknown as Text, startOffset: 0, endOffset: 0,
      setStart(node: Text, offset: number) {range.startContainer = node; range.startOffset = offset;},
      setEnd(node: Text, offset: number) {range.endContainer = node; range.endOffset = offset;},
      getClientRects: () => [{left: 0, right: 100, top: range.startContainer.parentElement?.hasAttribute('data-range-far') ? 3000 : 100, bottom: range.startContainer.parentElement?.hasAttribute('data-range-far') ? 3020 : 120, width: 100, height: 20}],
      toString: () => range.startContainer.data.slice(range.startOffset, range.endOffset),
    };
    return range;
  }) as unknown as typeof document.createRange;
  return {document: document as unknown as Document, window};
}

afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();});

describe('saved expressions match real reading text', () => {
  it('requires opt-in and preserves the independent collection preference', () => {
    expect(new Config().vocabularyReencounterEnabled).toBe(false);
    for (const bad of [undefined, null, 0, 'true', {}]) expect(normalizeConfig({vocabularyBookEnabled: true, vocabularyReencounterEnabled: bad}).vocabularyReencounterEnabled).toBe(false);
    expect(normalizeConfig({vocabularyBookEnabled: false, vocabularyReencounterEnabled: true})).toMatchObject({vocabularyBookEnabled: false, vocabularyReencounterEnabled: true});
  });
  it('matches whole words, keeps original coordinates and treats apostrophes and hyphens as word continuations', () => {
    expect(find("an art article, don't don'ts, state-of-the-art and art.", ['art', "don't", 'state-of-the-art']).map(match => match.entryId)).toEqual(['art', "don't", 'state-of-the-art', 'art']);
    expect(find('cart art2 2art artful', ['art'])).toEqual([]);
  });
  it('matches flexible whitespace, case and typography while preserving all UTF-16 offsets', () => {
    const text = '🙂 TAKE\n  for\tGRANTED; don’t re‑enter CAFÉ cafe\u0301.';
    const hits = find(text, ['take for granted', "don't", 're-enter', 'café']);
    expect(hits.map(hit => text.slice(hit.start, hit.end))).toEqual(['TAKE\n  for\tGRANTED', 'don’t', 're‑enter', 'CAFÉ', 'cafe\u0301']);
  });
  it('keeps the longest overlap, deduplicates equivalent entries, and supports literal punctuation and continuous CJK', () => {
    expect(find('Take for granted. A+B (x). 我喜欢学习中文。', ['take', 'take for granted', 'granted', 'A+B (x)', '学习中文']).map(hit => hit.entryId)).toEqual(['take for granted', 'A+B (x)', '学习中文']);
    const index = createExpressionIndex([saved('Art', 'first'), saved('art', 'second'), saved('   '), saved('!!!')]);
    expect(matchExpressions('art art', index, 1)).toEqual([{entryId: 'first', start: 0, end: 3}]);
    expect(matchExpressions('art', index, 0)).toEqual([]);
  });
  it('uses suffix links for shared prefixes without matching embedded Latin words', () => {
    expect(find('he hers she his. foo bar foo baz.', ['he', 'hers', 'she', 'his', 'foo bar', 'foo baz']).map(hit => hit.entryId)).toEqual(['he', 'hers', 'she', 'his', 'foo bar', 'foo baz']);
    expect(find('ushers', ['he', 'hers', 'she'])).toEqual([]);
    expect(find('abc abde bde', ['abc', 'abde', 'bde']).map(hit => hit.entryId)).toEqual(['abc', 'abde', 'bde']);
  });
  it('supports a full 5000-entry book and bounds only returned occurrences', () => {
    const entries = Array.from({length: 5000}, (_, i) => saved(`expression ${i}`));
    const index = createExpressionIndex(entries);
    expect(matchExpressions('Use expression 4999 and expression 2 today.', index).map(hit => hit.entryId)).toEqual(['expression 4999', 'expression 2']);
  });
  it('extracts the real surrounding sentence and limits long context', () => {
    const text = 'Previous. We take it for granted! Next.';
    const start = text.indexOf('take');
    expect(reencounterSentence(text, start, start + 4)).toBe('We take it for granted!');
    expect(reencounterSentence('plain art here', 6, 9)).toBe('plain art here');
    expect(reencounterSentence('x'.repeat(2000), 1000, 1003)).toHaveLength(803);
    expect(reencounterSentence('art.', 0, 3)).toBe('art.');
  });
  it('keeps saved context and references separate and leaves the original review data intact', () => {
    const entry = {id: 'id', term: 'art', sourceLanguage: 'en', contexts: [{text: 'An art lesson.', pageTitle: 'Old page', capturedAt: 2}, {text: 'unrelated', capturedAt: 3}],
      translations: {zh: {text: '艺术', updatedAt: 1}, en: {text: 'creative work', updatedAt: 2}}, status: 'new', reviewCount: 0} as unknown as VocabularyEntry;
    const before = JSON.stringify(entry);
    expect(reencounterSnapshot(entry)).toEqual({...saved('art', 'id'), reference: 'creative work', savedSentence: 'An art lesson.', savedTitle: 'Old page'});
    expect(reencounterTerm(entry)).toEqual(saved('art', 'id'));
    expect(reencounterSnapshot({...entry, contexts: [], translations: {}})).toEqual(saved('art', 'id'));
    expect(reencounterSnapshot({...entry, contexts: [{text: 'Art matters.', capturedAt: 1}]}).savedTitle).toBe('');
    expect(reencounterSnapshot({...entry, term: '学习中文', contexts: [{text: '我每天学习中文。', capturedAt: 1}]}).savedSentence).toBe('我每天学习中文。');
    expect(JSON.stringify(entry)).toBe(before);
  });
});

describe('paint-only reading text and lifecycle', () => {
  it('joins inline text, separates blocks and protected regions and leaves native nodes and markup unchanged', () => {
    const {document} = dom('<p id="a">We <em>take for</em> granted. <a href="#">art</a> art.</p><p>take</p><p>for granted</p><p>take<br>for granted</p><pre>art</pre><p hidden>art</p><p translate="no">art</p><div contenteditable>art</div><p data-display="none">art</p><p data-visibility="hidden">art</p><p data-visibility="collapse">art</p><div data-fr-translation-owned="true">art</div><p data-far>art</p><p><span></span>art</p>');
    const before = document.body.innerHTML; const native = document.querySelector('em')!.firstChild;
    const terms = [saved('take for granted'), saved('art')];
    const result = scanReadingExpressions(document, terms, createExpressionIndex(terms));
    expect(result.occurrences.map(item => item.entry.term)).toEqual(['take for granted', 'art', 'art']);
    expect(result.occurrences[0].ranges.map(range => range.toString())).toEqual(['take for', ' granted']);
    expect(document.body.innerHTML).toBe(before); expect(document.querySelector('em')!.firstChild).toBe(native);
    expect(collectReadingGroups(document).groups.some(group => group.text === 'takefor granted')).toBe(false);
  });
  it('collects open shadow roots and ignores plugin roots', () => {
    const {document} = dom('<div id="host"></div><div id="fluent-read-own">art</div><div id="empty"></div>');
    const root = document.getElementById('host')!.attachShadow({mode: 'open'});
    root.innerHTML = '<p>We like art.</p>';
    const terms = [saved('art')];
    const result = scanReadingExpressions(document, terms, createExpressionIndex(terms));
    expect(result.roots).toEqual([document, root]); expect(result.occurrences).toHaveLength(1); expect(result.occurrences[0].root).toBe(root);
  });
  it('handles direct shadow text, slot projection and fallback text without losing native ownership', () => {
    const {document} = dom('<div id="host"><span id="assigned">Art matters.</span></div><p><span data-range-far>art</span></p>');
    document.body.append(document.createTextNode(''), document.createComment('art'));
    const host = document.getElementById('host')!; const root = host.attachShadow({mode: 'open'});
    root.innerHTML = 'Direct art text.<slot></slot><slot id="fallback">Fallback art text.</slot>';
    const assigned = document.getElementById('assigned')!;
    Object.defineProperty(root.querySelector('slot'), 'assignedNodes', {value: () => [assigned]});
    Object.defineProperty(root.querySelector('#fallback'), 'assignedNodes', {value: () => []});
    const terms = [saved('art')]; const result = scanReadingExpressions(document, terms, createExpressionIndex(terms));
    expect(result.occurrences).toHaveLength(3);
    expect(result.occurrences.map(item => item.root)).toEqual([root, document, root]);
  });
  it('returns no ranges without a body, and limits nearby occurrences to 300', () => {
    const {document} = dom('<p>'+ 'art '.repeat(400) +'</p>');
    const terms = [saved('art')];
    expect(scanReadingExpressions(document, terms, createExpressionIndex(terms)).occurrences).toHaveLength(300);
    document.body.remove();
    // linkedom 会补建空 body；这里模拟真实 HTML 尚无 body 或 XML 文档的入口。
    Object.defineProperty(document, 'body', {value: null});
    expect(collectReadingGroups(document).groups).toEqual([]);
  });
  it('adds only owned drawing styles, keeps other highlights and cancels pending work on disposal', async () => {
    vi.useFakeTimers();
    const {document, window} = dom('<p>We take for granted.</p>');
    const foreign = new Set(); window.CSS.highlights.set('site-owned', foreign as unknown as Highlight);
    const changed = vi.fn(); const open = vi.fn();
    const scanner = installReencounterScanner(document, {changed, open});
    scanner.setEntries([saved('take for granted')]);
    scanner.refresh(); scanner.refresh(); await vi.advanceTimersByTimeAsync(180);
    expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)?.size).toBe(1);
    expect(document.querySelectorAll('[data-fr-reencounter-style]')).toHaveLength(1);
    expect(changed.mock.calls.at(-1)?.[0]).toHaveLength(1);
    scanner.refresh(); scanner.dispose(); scanner.dispose(); await vi.runAllTimersAsync();
    expect(document.querySelectorAll('[data-fr-reencounter-style]')).toHaveLength(0);
    expect(window.CSS.highlights.has(REENCOUNTER_HIGHLIGHT)).toBe(false); expect(window.CSS.highlights.get('site-owned')).toBe(foreign);
  });
  it('updates changed text, cleans disconnected shadow roots and cannot mistake its own UI for new reading content', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p>art matters.</p><div id="host"></div>');
    const host = document.getElementById('host')!; const root = host.attachShadow({mode: 'open'}); root.innerHTML = '<p>art again.</p>';
    const changed = vi.fn(); const scanner = installReencounterScanner(document, {changed, open: vi.fn()}); scanner.setEntries([saved('art')]);
    await vi.advanceTimersByTimeAsync(180); expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)?.size).toBe(2);
    const own = document.createElement('div'); own.setAttribute('data-fluent-read-ui', 'test'); own.textContent = 'art'; document.body.appendChild(own);
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(200); expect(changed.mock.calls.at(-1)?.[0]).toHaveLength(2);
    document.querySelector('p')!.textContent = 'Nothing saved.'; host.remove();
    await Promise.resolve(); await vi.advanceTimersByTimeAsync(200);
    expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)?.size).toBe(0); expect(root.querySelector('[data-fr-reencounter-style]')).toBeNull();
    scanner.dispose();
  });
  it('opens only plain-text hits with collapsed selection and never prevents host clicks', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p id="text">art matters.</p><a id="link">art</a><div id="fluent-read-overlay">art</div>');
    let collapsed = true; document.getSelection = (() => ({isCollapsed: collapsed})) as unknown as typeof document.getSelection;
    const open = vi.fn(); const scanner = installReencounterScanner(document, {changed: vi.fn(), open}); scanner.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180);
    const click = (target: EventTarget = document.getElementById('text')!, extra = {}) => {
      const event = new window.Event('click', {bubbles: true, composed: true, cancelable: true});
      Object.assign(event, {button: 0, clientX: 10, clientY: 110, ...extra}); target.dispatchEvent(event); return event;
    };
    expect(click().defaultPrevented).toBe(false); expect(open).toHaveBeenCalledTimes(1);
    for (const extra of [{button: 1}, {ctrlKey: true}, {altKey: true}, {shiftKey: true}, {metaKey: true}, {clientX: 500}, {clientY: 10}]) click(undefined, extra);
    collapsed = false; click(); collapsed = true;
    click(document.getElementById('link')!); click(document.getElementById('fluent-read-overlay')!);
    click(document);
    const cancelled = new window.Event('click', {bubbles: true, cancelable: true}); cancelled.preventDefault(); document.querySelector('p')!.dispatchEvent(cancelled);
    const stale = document.getElementById('text')!.firstChild!;
    document.getElementById('text')!.replaceChildren(document.createTextNode('art matters.'));
    expect(stale.isConnected).toBe(false); click();
    expect(open).toHaveBeenCalledTimes(1); scanner.dispose(); click(); expect(open).toHaveBeenCalledTimes(1);
  });
  it('provides readable occurrences in browsers without native painting and leaves replaced highlights owned by the site', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p>art</p>');
    (window as unknown as {Highlight?: unknown}).Highlight = undefined; const changed = vi.fn(); const scanner = installReencounterScanner(document, {changed, open: vi.fn()});
    scanner.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180); expect(changed.mock.calls.at(-1)?.[0]).toHaveLength(1); expect(document.querySelector('[data-fr-reencounter-style]')).toBeNull(); scanner.dispose();
    (window as unknown as {Highlight?: unknown}).Highlight = class extends Set {}; const second = installReencounterScanner(document, {changed, open: vi.fn()}); second.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180);
    const site = new Set(); window.CSS.highlights.set(REENCOUNTER_HIGHLIGHT, site as unknown as Highlight); second.dispose(); expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)).toBe(site);
  });
  it('supports a document without a head and rejects a queued scan after disposal', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p>art</p>'); document.head.remove();
    const timer = vi.spyOn(window, 'setTimeout'); const changed = vi.fn();
    const scanner = installReencounterScanner(document, {changed, open: vi.fn()}); scanner.setEntries([saved('art')]);
    const queued = timer.mock.calls[0][0] as () => void;
    await vi.advanceTimersByTimeAsync(180); expect(document.documentElement.querySelector('[data-fr-reencounter-style]')).not.toBeNull();
    scanner.dispose(); const calls = changed.mock.calls.length; queued(); expect(changed).toHaveBeenCalledTimes(calls);
    timer.mockRestore();
  });
});


describe('bounded reading ownership and fault cleanup', () => {
  it('reads 20,000 nested inline elements through public collection and matching without changing text identity', () => {
    const {document} = dom('<p id="deep">Before </p><p>Second art.</p>');
    const owner = document.getElementById('deep')!; let leaf = owner;
    for (let i = 0; i < 20_000; i++) {const child = document.createElement('span'); leaf.append(child); leaf = child;}
    const native = document.createTextNode('art'); leaf.append(native); owner.append(document.createTextNode(' after.'));
    expect(() => collectReadingGroups(document)).not.toThrow();
    expect(collectReadingGroups(document).groups.map(group => group.text)).toEqual(['Before art after.', 'Second art.']);
    const terms = [saved('art')];
    expect(scanReadingExpressions(document, terms, createExpressionIndex(terms)).occurrences.map(hit => hit.ranges[0].toString())).toEqual(['art', 'art']);
    expect(leaf.firstChild).toBe(native); expect(native.data).toBe('art');
  });
  it('ends shadow and block groups before later siblings while keeping assigned text in its native root', () => {
    const {document} = dom('<p>Before <span id="host"><i id="assigned">Assigned art.</i></span> After art.</p><p>Last art.</p>');
    const host = document.getElementById('host')!; const root = host.attachShadow({mode: 'open'});
    root.innerHTML = '<em>Shadow art.</em><slot></slot><slot id="fallback">Fallback art.</slot>';
    const assigned = document.getElementById('assigned')!;
    Object.defineProperty(root.querySelector('slot'), 'assignedNodes', {value: () => [assigned]});
    Object.defineProperty(root.querySelector('#fallback'), 'assignedNodes', {value: () => []});
    const result = collectReadingGroups(document);
    expect(result.groups.map(group => group.text)).toEqual(['Before ', 'Shadow art.', 'Assigned art.', 'Fallback art.', ' After art.', 'Last art.']);
    expect(result.groups.map(group => group.root)).toEqual([document, root, document, root, document, document]);
    expect(result.roots).toEqual([document, root]);
  });
  it('skips all page and range work for an empty or unusable expression index', () => {
    const {document, window} = dom('<p>We like art.</p><div id="host"></div>');
    document.getElementById('host')!.attachShadow({mode: 'open'}).innerHTML = '<p>art</p>';
    const style = vi.spyOn(window, 'getComputedStyle'); const geometry = vi.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect');
    const range = vi.spyOn(document, 'createRange');
    for (const entries of [[], [saved('!!!')]]) expect(scanReadingExpressions(document, entries, createExpressionIndex(entries))).toEqual({occurrences: [], roots: [document]});
    expect(style).not.toHaveBeenCalled(); expect(geometry).not.toHaveBeenCalled(); expect(range).not.toHaveBeenCalled();
  });
  it('removes unused drawing styles and observes a later nonempty book without keeping old shadow resources', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p>art</p><div id="host"></div>');
    const root = document.getElementById('host')!.attachShadow({mode: 'open'}); root.innerHTML = '<p>art</p>';
    const scanner = installReencounterScanner(document, {changed: vi.fn(), open: vi.fn()});
    scanner.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180);
    expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)?.size).toBe(2);
    scanner.setEntries([]); await vi.advanceTimersByTimeAsync(180);
    expect(document.querySelector('[data-fr-reencounter-style]')).toBeNull(); expect(root.querySelector('[data-fr-reencounter-style]')).toBeNull();
    expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)?.size).toBe(0);
    scanner.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180);
    expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)?.size).toBe(2); scanner.dispose();
  });
  it('ignores entry updates after disposal without compiling their fields or notifying the closed UI', () => {
    const {document} = dom('<p>art</p>'); const changed = vi.fn();
    const scanner = installReencounterScanner(document, {changed, open: vi.fn()}); scanner.dispose();
    const entries = [saved('art')]; Object.defineProperty(entries[0], 'term', {get: () => {throw new Error('closed book read');}});
    expect(() => scanner.setEntries(entries)).not.toThrow(); expect(changed).toHaveBeenCalledTimes(1);
  });
  it('isolates changed callback failures during entry replacement, painting and complete disposal', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p>art</p>');
    const scanner = installReencounterScanner(document, {changed: () => {throw new Error('closed UI');}, open: vi.fn()});
    expect(() => scanner.setEntries([saved('art')])).not.toThrow(); await vi.advanceTimersByTimeAsync(180);
    expect(window.CSS.highlights.get(REENCOUNTER_HIGHLIGHT)?.size).toBe(1);
    expect(() => scanner.dispose()).not.toThrow(); expect(document.querySelector('[data-fr-reencounter-style]')).toBeNull();
    expect(window.CSS.highlights.has(REENCOUNTER_HIGHLIGHT)).toBe(false); await vi.runAllTimersAsync();
  });
  it('delivers empty entry replacement without recursively echoing the same public callback', async () => {
    vi.useFakeTimers(); const {document} = dom('<p>art</p>'); const terms = [saved('art')];
    let scanner!: ReturnType<typeof installReencounterScanner>; let depth = 0; let maxDepth = 0; let calls = 0;
    scanner = installReencounterScanner(document, {changed: next => {
      depth++; maxDepth = Math.max(maxDepth, depth); calls++;
      if (!next.length && calls < 25) scanner.setEntries(terms);
      depth--;
    }, open: vi.fn()});
    scanner.setEntries(terms); expect(maxDepth).toBe(1); expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(180); expect(calls).toBe(2); scanner.dispose();
  });
  it('queues disposal notification after the active callback and leaves no paint or owned styles', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p>art</p>');
    let scanner!: ReturnType<typeof installReencounterScanner>; let depth = 0; let maxDepth = 0; const counts: number[] = [];
    scanner = installReencounterScanner(document, {changed: next => {
      depth++; maxDepth = Math.max(maxDepth, depth); counts.push(next.length);
      if (next.length) scanner.dispose(); depth--;
    }, open: vi.fn()});
    scanner.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180);
    expect(maxDepth).toBe(1); expect(counts).toEqual([0, 1, 0]);
    expect(window.CSS.highlights.has(REENCOUNTER_HIGHLIGHT)).toBe(false); expect(document.querySelector('[data-fr-reencounter-style]')).toBeNull();
  });
  it('protects private hit records from an observer changing its notification array', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p id="text">art</p>'); const open = vi.fn();
    document.getSelection = (() => ({isCollapsed: true})) as unknown as typeof document.getSelection;
    const scanner = installReencounterScanner(document, {changed: next => {next.length = 0;}, open});
    scanner.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180);
    const event = new window.Event('click', {bubbles: true}); Object.assign(event, {button: 0, clientX: 10, clientY: 110});
    document.getElementById('text')!.dispatchEvent(event); expect(open).toHaveBeenCalledTimes(1); scanner.dispose();
  });
  it('lets later host click handlers run when an optional card callback throws', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p id="text">art</p>');
    document.getSelection = (() => ({isCollapsed: true})) as unknown as typeof document.getSelection;
    const scanner = installReencounterScanner(document, {changed: vi.fn(), open: () => {throw new Error('card failed');}});
    scanner.setEntries([saved('art')]); await vi.advanceTimersByTimeAsync(180);
    const host = vi.fn(); document.addEventListener('click', host);
    const event = new window.Event('click', {bubbles: true, cancelable: true}); Object.assign(event, {button: 0, clientX: 10, clientY: 110});
    expect(() => document.getElementById('text')!.dispatchEvent(event)).not.toThrow(); expect(host).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(false); scanner.dispose();
  });
  it('stops reading geometry after the first visible rectangle for painting and plain-text clicks', async () => {
    vi.useFakeTimers(); const {document, window} = dom('<p id="text">art</p>');
    const create = document.createRange; let reads = 0;
    vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = create();
      range.getClientRects = (() => ({*[Symbol.iterator]() {
        reads++; yield {left: 0, right: 100, top: 100, bottom: 120, width: 100, height: 20};
        throw new Error('unneeded geometry tail');
      }})) as typeof range.getClientRects;
      return range;
    });
    const terms = [saved('art')]; expect(scanReadingExpressions(document, terms, createExpressionIndex(terms)).occurrences).toHaveLength(1);
    expect(reads).toBe(1);
    document.getSelection = (() => ({isCollapsed: true})) as unknown as typeof document.getSelection;
    const open = vi.fn(); const scanner = installReencounterScanner(document, {changed: vi.fn(), open});
    scanner.setEntries(terms); await vi.advanceTimersByTimeAsync(180); expect(reads).toBe(2);
    const event = new window.Event('click', {bubbles: true}); Object.assign(event, {button: 0, clientX: 10, clientY: 110});
    document.getElementById('text')!.dispatchEvent(event); expect(reads).toBe(3); expect(open).toHaveBeenCalledTimes(1); scanner.dispose();
  });
});
