import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { applyNaiParameterPreset, captureNaiParameters, naiParametersMatch, newNaiParameterPreset } from '@/backends/naiParameterPresets';
import { buildNaiParameters } from '@/backends/nai';

const mocks = vi.hoisted(() => ({ context: null as Record<string, any> | null }));
vi.mock('@/st/context', () => ({ getContext: () => mocks.context }));

async function hydrate(nai: Record<string, unknown> = {}) {
  mocks.context = {
    extensionSettings: { baibai_image: { nai } },
    saveSettingsDebounced: vi.fn(),
  };
  const mod = await import('@/state/settings');
  await mod.hydrateSettings();
  return mod.settings;
}

describe('NAI 默认参数方案与设置持久化', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('window', { addEventListener: vi.fn(), dispatchEvent: vi.fn() });
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() });
  });

  it('旧配置升级不改当前参数，也不虚构参数方案', async () => {
    const s = await hydrate({ model: 'nai-diffusion-4-5-full', steps: 28, scale: 7.4, cfgRescale: 0.76 });
    expect(s.nai.parameterPresets).toEqual([]);
    expect(s.nai.activeParameterPresetId).toBe('');
    expect(s.nai).toMatchObject({ model: 'nai-diffusion-4-5-full', steps: 28, scale: 7.4, cfgRescale: 0.76 });
  });

  it('快照只有参数，不复制密钥、画师串或引用库', async () => {
    const s = await hydrate({ key: 'fixture-only-key', activeArtistId: 'bi_default', qualityTags: 'fixture quality' });
    const p = newNaiParameterPreset('  A  ', s.nai);
    expect(p.name).toBe('A');
    expect(p.parameters).not.toHaveProperty('key');
    expect(p.parameters).not.toHaveProperty('endpoints');
    expect(p.parameters).not.toHaveProperty('activeArtistId');
    expect(p.parameters).not.toHaveProperty('qualityTags');
    expect(p.parameters).not.toHaveProperty('vibes');
    const oldSteps = p.parameters.steps;
    s.nai.steps = 37;
    expect(p.parameters.steps).toBe(oldSteps);
    expect(naiParametersMatch(s.nai, p)).toBe(false);
  });

  it('A/B 切换更新真实出图请求参数，提示词和接入点保留', async () => {
    const s = await hydrate({ model: 'nai-diffusion-4-5-full', steps: 28, scale: 7.4, cfgRescale: 0.76, seed: 42, sampler: 'k_dpmpp_sde', activeArtistId: 'bi_default' });
    const a = newNaiParameterPreset('A', s.nai);
    Object.assign(s.nai, { model: 'nai-diffusion-5-full', steps: 35, scale: 5.5, cfgRescale: 0.1, seed: 87, sampler: 'k_euler', portraitSize: '1024×1536', naturalLanguage: false, concurrency: 2, varietyBoost: false });
    const b = newNaiParameterPreset('B', s.nai);
    const before = { endpoint: s.nai.activeEndpointId, artist: s.nai.activeArtistId };
    for (const preset of [a, b, a]) {
      applyNaiParameterPreset(s.nai, preset);
      const request = buildNaiParameters(s.nai, { prompt: 'test subject', size: 'portrait' });
      expect(request).toMatchObject({ steps: preset.parameters.steps, scale: preset.parameters.scale, cfg_rescale: preset.parameters.cfgRescale, sampler: preset.parameters.sampler, seed: preset.parameters.seed });
      expect(captureNaiParameters(s.nai)).toEqual(preset.parameters);
      expect(s.nai.activeParameterPresetId).toBe(preset.id);
      expect(naiParametersMatch(s.nai, preset)).toBe(true);
      expect({ endpoint: s.nai.activeEndpointId, artist: s.nai.activeArtistId }).toEqual(before);
    }
  });

  it('保存经宿主回调写回，刷新后保留方案及未覆盖的当前调整', async () => {
    const s = await hydrate({ steps: 28 });
    const a = newNaiParameterPreset('A', s.nai);
    s.nai.parameterPresets.push(a);
    applyNaiParameterPreset(s.nai, a);
    s.nai.steps = 39;
    await nextTick();
    expect(mocks.context!.saveSettingsDebounced).toHaveBeenCalled();
    const saved = JSON.parse(JSON.stringify(mocks.context!.extensionSettings.baibai_image.nai));
    vi.resetModules();
    const restored = await hydrate(saved);
    expect(restored.nai.steps).toBe(39);
    expect(restored.nai.parameterPresets[0].parameters.steps).toBe(28);
    expect(restored.nai.activeParameterPresetId).toBe(a.id);
    expect(naiParametersMatch(restored.nai, restored.nai.parameterPresets[0])).toBe(false);
  });

  it('坏数据被规整；白名单外字段不会被应用', async () => {
    const s = await hydrate({ parameterPresets: [null, { id: 'p', name: 'P', parameters: { model: 'retired', steps: 900, scale: -10, cfgRescale: 4, seed: -1, concurrency: 100, orientationLock: 'bad', key: 'must-not-copy' } }], activeParameterPresetId: 'p' });
    expect(s.nai.parameterPresets).toHaveLength(1);
    expect(s.nai.parameterPresets[0].parameters).toMatchObject({ steps: 50, scale: 0, cfgRescale: 1, seed: 0, concurrency: 4, orientationLock: 'auto', model: 'nai-diffusion-5-full' });
    expect(s.nai.parameterPresets[0].parameters).not.toHaveProperty('key');
    expect(s.nai.steps).toBe(28); // hydrate 不偷偷应用方案
  });

  it('重复 id 得到唯一值，悬空选中项清空且不改当前参数', async () => {
    const s = await hydrate({ steps: 31, parameterPresets: [{ id: 'same' }, { id: 'same' }], activeParameterPresetId: 'gone' });
    expect(new Set(s.nai.parameterPresets.map(p => p.id)).size).toBe(2);
    expect(s.nai.activeParameterPresetId).toBe('');
    expect(s.nai.steps).toBe(31);
  });
});
