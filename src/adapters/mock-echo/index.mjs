import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Built-in mock adapter for tests and offline demos — never calls a real AI platform.
// Contract v1.0, synchronous: writes a placeholder file and returns completed.
export const manifest = {
  contractVersion: '1.0',
  id: 'mock-echo',
  displayName: 'Mock Echo（测试用）',
  version: '0.1.0',
  kind: 'builtin',
  entry: 'builtin://mock-echo',
  async: false,
  productionMode: 'in_app',
  // 本地 mock 仍归入“内置生成”：它由应用进程直接执行，只是不访问真实 AI 平台。
  execution: { type: 'local_mock' },
  capabilities: [
    {
      type: 'video',
      models: [
        { id: 'echo-video', params: { ratio: { type: 'enum', options: ['9:16', '16:9'], default: '9:16', label: '画面比例' } } }
      ]
    }
  ],
  credential: { required: false, methods: [], fields: [] }
};

// Mirrors the CLI contract: returning a valid object == exit 0; throwing == exit != 0.
export async function generate(input) {
  const fileName = `mock_${Date.now()}.txt`;
  const absPath = join(input.outputDir, fileName);
  // Echo the prompt into a placeholder artifact so tests can assert real file output.
  await writeFile(absPath, `mock-echo output\nprompt: ${input.prompt}\n`, 'utf8');
  return {
    status: 'completed',
    outputs: [{ path: fileName, kind: 'video', role: 'primary' }]
  };
}
