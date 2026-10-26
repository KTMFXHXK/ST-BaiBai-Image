import type { NaiSettings } from '@/state/settings';
import { randomUuid } from '@/randomUuid';

// 显式白名单：方案只保存「默认参数」，不携带接口密钥、提示词、Vibe 或其它设置。
const parameterKeys = [
  'model', 'naturalLanguage', 'portraitSize', 'landscapeSize', 'orientationLock',
  'sampler', 'noiseSchedule', 'steps', 'scale', 'cfgRescale', 'seed',
  'varietyBoost', 'concurrency',
] as const;

export type NaiParameterValues = Pick<NaiSettings, typeof parameterKeys[number]>;
export interface NaiParameterPreset {
  id: string;
  name: string;
  parameters: NaiParameterValues;
}

export function captureNaiParameters(source: NaiParameterValues): NaiParameterValues {
  return Object.fromEntries(parameterKeys.map(key => [key, source[key]])) as NaiParameterValues;
}

export function newNaiParameterPreset(name: string, source: NaiParameterValues): NaiParameterPreset {
  return { id: `np_${randomUuid()}`, name: name.trim(), parameters: captureNaiParameters(source) };
}

export function applyNaiParameterPreset(target: NaiSettings, preset: NaiParameterPreset): void {
  Object.assign(target, captureNaiParameters(preset.parameters));
  target.activeParameterPresetId = preset.id;
}

export function naiParametersMatch(source: NaiParameterValues, preset: NaiParameterPreset): boolean {
  return parameterKeys.every(key => source[key] === preset.parameters[key]);
}

export function normalizeNaiParameterPresets(
  raw: unknown,
  fallback: NaiParameterValues,
  models: readonly string[],
): NaiParameterPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.filter(item => item && typeof item === 'object').map(item => {
    const p = item.parameters && typeof item.parameters === 'object' ? item.parameters : {};
    const values = captureNaiParameters(fallback);
    for (const key of parameterKeys) {
      const value = p[key];
      if (typeof value !== typeof fallback[key]) continue;
      if (typeof value === 'number' && !Number.isFinite(value)) continue;
      // 尺寸和方向留给原有的出图尺寸校验；这里排除空字符串和未知方向。
      if (typeof value === 'string' && !value.trim()) continue;
      if (key === 'model' && !models.includes(value)) continue;
      if (key === 'orientationLock' && !['auto', 'portrait', 'landscape'].includes(value)) continue;
      Object.assign(values, { [key]: value });
    }
    values.steps = Math.round(Math.min(50, Math.max(1, values.steps)));
    values.scale = Math.min(35, Math.max(0, values.scale));
    values.cfgRescale = Math.min(1, Math.max(0, values.cfgRescale));
    values.seed = Math.round(Math.min(4294967295, Math.max(0, values.seed)));
    values.concurrency = Math.round(Math.min(4, Math.max(1, values.concurrency)));
    let id = typeof item.id === 'string' && item.id ? item.id : `np_${randomUuid()}`;
    if (seen.has(id)) id = `np_${randomUuid()}`;
    seen.add(id);
    return {
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : '未命名参数方案',
      parameters: values,
    };
  });
}
