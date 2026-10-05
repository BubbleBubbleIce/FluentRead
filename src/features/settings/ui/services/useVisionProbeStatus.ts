/**
 * @file src/features/settings/ui/services/useVisionProbeStatus.ts
 * 文件职责：为服务设置与圈选设置绑定同一个本地识图测试状态，避免界面与后台能力结论不一致。
 * 主要内容：只在激活界面读取并订阅独立 WXT 本地缓存，拒绝跨激活代际的读取与通知；按过期时间刷新 Vue 状态，隐藏、缓存停用和卸载释放监听及定时器。
 * 模块边界：仅 Vue/storage 接线，不发模型请求或决定能力；优先级、身份及缓存有效性由 core 的纯策略提供。
 */
import {computed, onActivated, onBeforeUnmount, onDeactivated, ref, watch} from 'vue';
import {storage} from '@wxt-dev/storage';
import {resolveVisionCapabilityWithProbe, VISION_PROBE_TTL_MS, type VisionProbeResult} from '@/src/core/config/visionProbe';
import {VISION_PROBE_STORAGE_KEY} from '@/src/platform/storage/visionProbeStorage';
import type {Config} from '@/src/core/config/model';
export function useVisionProbeStatus(getConfig: () => Config, getService: () => string, getModel: () => string, getActive: () => boolean = () => true) {
    const records = ref<unknown>([]);
    const clock = ref(Date.now());
    const viewActive = ref(true);
    const active = computed(() => viewActive.value && getActive());
    let revision = 0, generation = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stop: (() => void) | undefined;
    const result = computed<VisionProbeResult>(() => active.value
        ? resolveVisionCapabilityWithProbe(getConfig(), getService(), getModel(), records.value, clock.value)
        : {capability: 'unknown', source: 'unknown'} as const);
    async function refresh() {
        if (!active.value) return;
        const startedRevision = revision;
        const value = await storage.getItem(VISION_PROBE_STORAGE_KEY);
        if (active.value && revision === startedRevision) {clock.value = Date.now();records.value = value;}
    }
    watch(active, enabled => {
        generation++;revision++;
        clearTimeout(timer);timer = undefined;
        stop?.();stop = undefined;
        if (!enabled) return;
        clock.value = Date.now();
        const subscriptionGeneration = generation;
        stop = storage.watch(VISION_PROBE_STORAGE_KEY, value => {
            if (!active.value || generation !== subscriptionGeneration) return;
            revision++;clock.value = Date.now();records.value = value;
        });
        void refresh().catch(() => undefined);
    }, {immediate: true, flush: 'sync'});
    watch(() => [active.value, result.value.checkedAt] as const, ([enabled, checkedAt]) => {
        clearTimeout(timer);
        timer = undefined;
        if (enabled && checkedAt !== undefined) {
            const timerGeneration = generation;
            timer = setTimeout(() => {
                if (active.value && generation === timerGeneration) clock.value = Date.now();
            }, Math.max(1, checkedAt + VISION_PROBE_TTL_MS - Date.now()));
        }
    }, {immediate: true});
    onActivated(() => {viewActive.value = true;});
    onDeactivated(() => {viewActive.value = false;});
    onBeforeUnmount(() => {viewActive.value = false;});
    return {result, refresh};
}
