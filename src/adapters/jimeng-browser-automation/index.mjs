import { JIMENG_TARGET_URL } from '../../automation/jimengFeedPackage.mjs';
import { JIMENG_MODEL_OPTIONS } from '../../automation/jimengModels.mjs';

// 即梦 Web 端没有 API Key 生成通道；这里注册的是浏览器自动化扩展能力。
// 它用于设置页选择“视频/音频模型通道”，真正的上传/提交由 /api/jimeng/feed-package
// 产出的投喂包交给应用托管的浏览器脚本执行器。
export const manifest = {
  contractVersion: '1.0',
  id: 'jimeng-browser-automation',
  displayName: '即梦自动化（Seedance）',
  version: '0.1.0',
  kind: 'builtin',
  entry: 'builtin://jimeng-browser-automation',
  async: false,
  productionMode: 'external',
  // 即梦是外部平台生产路径：drama-creator 负责投喂包和回填入口，不把网页操作伪装成 API。
  execution: {
    type: 'browser_automation',
    targetUrl: JIMENG_TARGET_URL,
    handoffEndpoint: '/api/jimeng/feed-package',
    startEndpoint: '/api/jimeng/automation/start',
    requiresUserConfirmation: true,
    defaultRecommended: true,
    manualBackfill: true,
    automationAvailable: true,
    profileMode: 'app_managed',
    profileDirHint: '~/.drama-creator/browser-profiles/jimeng'
  },
  capabilities: [
    {
      type: 'video',
      models: JIMENG_MODEL_OPTIONS.map((model) => ({
        id: model.id,
        label: model.label,
        metadata: {
          jimengLabel: model.jimengLabel
        },
        params: {
          ratio: { type: 'enum', options: ['9:16', '16:9', '1:1'], default: '9:16', label: '画面比例' },
          // 2026-07 实测即梦视频时长下拉为 4s-15s；验证片默认用最低档，正式片仍由分镜任务写入具体时长。
          duration: { type: 'number', min: 4, max: 15, step: 1, default: 4, label: '时长（秒）' }
        }
      }))
    },
    {
      type: 'audio',
      models: [
        {
          id: 'jimeng-audio',
          label: '即梦音频生成',
          metadata: {
            jimengLabel: '音频生成'
          },
          params: {
            duration: { type: 'number', min: 1, max: 60, step: 1, default: 8, label: '时长（秒）' }
          }
        }
      ]
    }
  ],
  automation: {
    type: 'managed_browser',
    platform: 'jimeng',
    targetUrl: JIMENG_TARGET_URL,
    handoffEndpoint: '/api/jimeng/feed-package',
    startEndpoint: '/api/jimeng/automation/start',
    requiresUserConfirmation: true,
    // 应用自己管理独立 profile，避免读取用户日常 Chrome 登录态；
    // 自动化仍必须在生成按钮前停下，由用户亲自确认是否消耗积分。
    available: true,
    profileMode: 'app_managed',
    profileDirHint: '~/.drama-creator/browser-profiles/jimeng'
  },
  credential: {
    required: false,
    methods: ['browser_session'],
    fields: []
  }
};

// 防止该 manifest 被误用成普通 generate API：即梦浏览器自动化必须走投喂包 + 用户确认。
export async function generate() {
  return {
    status: 'failed',
    outputs: [],
    error: {
      code: 'invalid_params',
      message: '即梦自动化不是 API Key 生成器，请先生成投喂包并启动应用托管的浏览器自动化。'
    }
  };
}
