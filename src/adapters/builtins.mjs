// Static registry of built-in adapters that ship with the platform repo (P2Q4).
// Adding a built-in adapter = add a line here and a sibling directory under src/adapters/.
import * as mockEcho from './mock-echo/index.mjs';
import * as openaiText from './openai-compatible-text/index.mjs';
import * as openaiImage from './openai-compatible-image/index.mjs';
import * as minimaxMedia from './minimax-media/index.mjs';
import * as volcengineArkVideo from './volcengine-ark-video/index.mjs';
import * as jimengBrowserAutomation from './jimeng-browser-automation/index.mjs';
// Phase 3 Task 3：独立的 Codex OAuth 适配器（仅 oauth 凭据，专调 codex/responses 端点）。
import * as openaiCodexOAuth from './openai-codex-oauth/index.mjs';

// Each entry: { module: ESM module exporting manifest + generate (+ optional poll) }.
// id is read from module.manifest.id, no duplication.
export const BUILTIN_ADAPTERS = [
  { module: mockEcho },
  { module: openaiText },
  { module: openaiImage },
  { module: minimaxMedia },
  { module: volcengineArkVideo },
  { module: jimengBrowserAutomation },
  { module: openaiCodexOAuth }
];

// Resolve a builtin by manifest id (bare, e.g. 'mock-echo'). null if unknown.
export function findBuiltinAdapter(manifestId) {
  return BUILTIN_ADAPTERS.find((entry) => entry.module.manifest.id === manifestId) || null;
}
