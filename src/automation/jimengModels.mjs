// 即梦模型名必须与页面下拉里的可见文案对齐；投喂包和页面自动化都使用这里的同一份清单。
export const JIMENG_MODEL_OPTIONS = [
  // mini 只承担常规镜头的速度优先默认值；音色/精确音轨锁定由投喂包显式升级到普通 2.0。
  {
    id: 'seedance-2.0-mini',
    label: 'Seedance 2.0 mini',
    jimengLabel: 'Seedance 2.0 mini'
  },
  {
    id: 'seedance-2.0',
    label: 'Seedance 2.0',
    jimengLabel: 'Seedance 2.0'
  },
  {
    id: 'seedance-2.0-fast',
    label: 'Seedance 2.0 Fast',
    jimengLabel: 'Seedance 2.0 Fast'
  }
];

export function resolveJimengModel(modelId = '') {
  return JIMENG_MODEL_OPTIONS.find((item) => item.id === modelId) || JIMENG_MODEL_OPTIONS[0];
}
