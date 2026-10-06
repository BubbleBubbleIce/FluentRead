import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
    getModelRequestLimitPreference,
    getServiceRequestLimitPreference,
    normalizeModelRequestLimits,
    normalizeServiceRequestLimits,
    withModelRequestLimit,
    withServiceRequestLimit,
    withoutModelRequestLimit,
} from '@/src/core/config/requestLimits';
import {
    createTranslationRequestScheduler,
    type TranslationRequestSchedulerConfig,
} from '@/src/services/translation/requestScheduler';

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {resolve = done;});
    return {promise, resolve};
}

async function flush() {
    for (let index = 0; index < 12; index++) await Promise.resolve();
}

const unlimited = {maxConcurrentTranslations: 1, translationRequestsPerSecond: 0, translationRequestsPerMinute: 0};

describe('audit48H live configuration consumers', () => {
    beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(0);});
    afterEach(() => {
        const pendingTimers = vi.getTimerCount();
        vi.useRealTimers();
        expect(pendingTimers).toBe(0);
    });

    it('applies edited model concurrency together with the shared service aggregate', async () => {
        const config: TranslationRequestSchedulerConfig = {
            ...unlimited,
            serviceRequestLimits: withServiceRequestLimit({}, 'openai', {enabled: true, limits: {...unlimited, maxConcurrentTranslations: 2}}),
            modelRequestLimits: withModelRequestLimit(
                withModelRequestLimit({}, 'openai', 'a', {enabled: true, limits: unlimited}),
                'openai', 'b', {enabled: true, limits: {...unlimited, maxConcurrentTranslations: 3}},
            ),
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const gates = Array.from({length: 4}, deferred);
        const started: number[] = [];
        const jobs = ['a', 'b', 'a', 'b'].map((model, index) => scheduler.schedule(async () => {
            started.push(index);
            await gates[index]!.promise;
            return index;
        }, {identity: {service: 'openai', model}}));
        try {
            expect(started).toEqual([0, 1]);
            gates[0]!.resolve(); await flush();
            expect(started).toEqual([0, 1, 2]);
            gates[1]!.resolve(); await flush();
            expect(started).toEqual([0, 1, 2, 3]);
        } finally {
            gates.forEach(gate => gate.resolve()); await Promise.all(jobs); await flush();
        }
    });

    it('retains disabled drafts while global concurrency applies and reuses them on enable', async () => {
        const config: TranslationRequestSchedulerConfig = {
            ...unlimited,
            serviceRequestLimits: withServiceRequestLimit({}, 'openai', {enabled: false, limits: {...unlimited, maxConcurrentTranslations: 3}}),
            modelRequestLimits: withModelRequestLimit({}, 'openai', 'a', {enabled: false, limits: {...unlimited, maxConcurrentTranslations: 2}}),
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const firstGate = deferred();
        const started: string[] = [];
        const first = scheduler.schedule(async () => {started.push('first'); await firstGate.promise;}, {identity: {service: 'openai', model: 'a'}});
        const second = scheduler.schedule(async () => {started.push('second');}, {identity: {service: 'openai', model: 'a'}});
        try {
            expect(started).toEqual(['first']);
            expect(getModelRequestLimitPreference(config.modelRequestLimits, 'openai', 'a')?.limits.maxConcurrentTranslations).toBe(2);
        } finally {
            firstGate.resolve(); await Promise.all([first, second]); await flush();
        }
        expect(started).toEqual(['first', 'second']);
        const draft = getModelRequestLimitPreference(config.modelRequestLimits, 'openai', 'a')!;
        config.modelRequestLimits = withModelRequestLimit(config.modelRequestLimits, 'openai', 'a', {...draft, enabled: true});
        const gates = [deferred(), deferred(), deferred()];
        const enabledStarts: number[] = [];
        const jobs = gates.map((gate, index) => scheduler.schedule(async () => {
            enabledStarts.push(index); await gate.promise;
        }, {identity: {service: 'openai', model: 'a'}}));
        try {
            expect(enabledStarts).toEqual([0, 1]);
            expect(getServiceRequestLimitPreference(config.serviceRequestLimits, 'openai')?.enabled).toBe(false);
            gates[0]!.resolve(); await flush(); expect(enabledStarts).toEqual([0, 1, 2]);
        } finally {
            gates.forEach(gate => gate.resolve()); await Promise.all(jobs); await flush();
        }
    });

    it('uses service rate history after removing a model draft and releases cancelled waiters', async () => {
        const config: TranslationRequestSchedulerConfig = {
            ...unlimited,
            serviceRequestLimits: withServiceRequestLimit({}, 'openai', {enabled: true, limits: {...unlimited, translationRequestsPerSecond: 1}}),
            modelRequestLimits: withModelRequestLimit({}, 'openai', 'a', {enabled: true, limits: {...unlimited, translationRequestsPerSecond: 2}}),
        };
        const scheduler = createTranslationRequestScheduler(() => config);
        const started: number[] = [];
        const run = async () => {started.push(Date.now()); return started.length;};
        await scheduler.schedule(run, {identity: {service: 'openai', model: 'a'}}); await flush();
        const original = config.modelRequestLimits;
        config.modelRequestLimits = withoutModelRequestLimit(original, 'openai', 'a');
        expect(getModelRequestLimitPreference(original, 'openai', 'a')?.enabled).toBe(true);
        expect(getModelRequestLimitPreference(config.modelRequestLimits, 'openai', 'a')).toBeUndefined();
        const controller = new AbortController();
        const cancelled = scheduler.schedule(run, {identity: {service: 'openai', model: 'a'}, signal: controller.signal});
        const cancelledOutcome = cancelled.catch(error => error);
        const next = scheduler.schedule(run, {identity: {service: 'openai', model: 'a'}});
        controller.abort();
        await expect(cancelledOutcome).resolves.toMatchObject({name: 'AbortError'});
        await vi.advanceTimersByTimeAsync(999); expect(started).toEqual([0]);
        await vi.advanceTimersByTimeAsync(1); await expect(next).resolves.toBe(2); await flush();
        expect(started).toEqual([0, 1_000]);
    });

    it('normalizes only own enumerable preferences and rejects malformed outer model maps', () => {
        const models = Object.create({inherited: {enabled: true}});
        Object.defineProperty(models, 'hidden', {value: {enabled: true}, enumerable: false});
        models.a = null;
        const mapping = Object.create({inheritedService: models});
        Object.defineProperty(mapping, 'hiddenService', {value: models, enumerable: false});
        mapping.openai = models;
        mapping.invalid = [];
        mapping.empty = {'': {enabled: true}};
        mapping.constructor = models;
        const normalized = normalizeModelRequestLimits(mapping);
        expect(Object.keys(normalized)).toEqual(['openai']);
        expect(Object.keys(normalized.openai!)).toEqual(['a']);
        expect(getModelRequestLimitPreference(mapping, 'openai', 'a')).toEqual(normalized.openai!.a);
        for (const key of ['inheritedService', 'hiddenService', 'missing', 'constructor']) {
            expect(getModelRequestLimitPreference(mapping, key, 'a')).toBeUndefined();
        }
        for (const value of [null, [], 1, {openai: []}, {openai: null}]) {
            expect(getModelRequestLimitPreference(value, 'openai', 'a')).toBeUndefined();
        }
        expect(normalizeServiceRequestLimits([])).toEqual({});
        expect(withModelRequestLimit(normalized, '__proto__', 'a', {enabled: true})).toEqual(normalized);
    });
});
