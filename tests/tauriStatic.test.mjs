// 桌面构建契约直接检查公开脚本与配置；本机 Codex 环境配置不属于发行源码。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('Tauri shell delegates Node server lifecycle to Rust without duplicate dev command', async () => {
  const conf = JSON.parse(await readFile(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const main = await readFile(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
  const cargo = await readFile(join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  const capability = JSON.parse(await readFile(join(root, 'src-tauri', 'capabilities', 'main.json'), 'utf8'));

  assert.equal(conf.build.beforeDevCommand ?? null, null);
  assert.equal(conf.build.devUrl, 'http://127.0.0.1:5173/');
  assert.equal(conf.build.frontendDist, 'http://127.0.0.1:5173/');
  assert.equal(conf.app.windows?.[0]?.label, 'main');
  assert.equal(conf.app.windows?.[0]?.url, 'http://127.0.0.1:5173/');
  assert.equal(conf.app.windows?.[0]?.visible, false);
  assert.equal(conf.app.withGlobalTauri, true);
  assert.ok(conf.bundle.resources.includes('../dist'));
  assert.ok(conf.bundle.externalBin.includes('binaries/drama-creator-server'));

  assert.match(main, /shell\(\)\s*\.sidecar\("drama-creator-server"\)/);
  assert.match(main, /spawn_sidecar_server/);
  assert.match(main, /spawn_dev_node_server/);
  assert.match(main, /DRAMA_CREATOR_STATIC_ROOT/);
  assert.match(main, /DRAMA_CREATOR_SERVER_MODE/);
  assert.match(main, /Contents\).*Resources|join\("Resources"\)/s);
  assert.match(main, /join\("_up_"\)/);
  assert.match(main, /CommandChild/);
  assert.match(main, /Command::new\("node"\)/);
  assert.match(main, /fn ensure_main_window/);
  assert.match(main, /ensure_main_window\(app\.handle\(\)\)/);
  assert.match(main, /RunEvent::Ready\s*=>\s*ensure_main_window/);
  assert.match(main, /RunEvent::Reopen/);
  assert.match(main, /window\.navigate\(url\)/);
  assert.match(main, /ActivationPolicy::Regular/);
  assert.match(main, /app\.show\(\)/);
  assert.match(main, /WebviewWindowBuilder::new/);
  assert.match(main, /WebviewUrl::External/);

  assert.match(cargo, /tauri-plugin-shell\s*=/);
  assert.match(cargo, /rfd\s*=/);
  assert.match(main, /#\[tauri::command\]\s*fn pick_project_directory/);
  assert.match(main, /#\[tauri::command\]\s*fn pick_asset_file/);
  assert.match(main, /#\[tauri::command\][\s\S]*fn open_oauth_authorize_url/);
  assert.match(main, /fn is_allowed_oauth_authorize_url/);
  assert.match(main, /https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  assert.match(main, /rfd::FileDialog/);
  assert.match(main, /generate_handler!\[[\s\S]*pick_project_directory[\s\S]*pick_asset_file[\s\S]*open_oauth_authorize_url[\s\S]*\]/);
  assert.deepEqual(capability.windows, ['main']);
  assert.deepEqual(capability.remote.urls, ['http://127.0.0.1:5173/*']);
  assert.ok(capability.permissions.includes('core:default'));
});

test('desktop run entrypoint builds and launches the Tauri shell', async () => {
  const script = await readFile(join(root, 'script', 'build_and_run.sh'), 'utf8');
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const sidecarScript = await readFile(join(root, 'scripts', 'build-sidecar.mjs'), 'utf8');

  assert.match(pkg.scripts['build:sidecar'], /scripts\/build-sidecar\.mjs/);
  assert.match(pkg.scripts['build:tauri'], /build:sidecar.*tauri build/);
  assert.equal(pkg.scripts['check:tauri-env'], 'node scripts/check-tauri-env.mjs');
  assert.ok(pkg.pkg?.assets?.includes('node_modules/keytar/build/Release/keytar.node'));
  assert.match(script, /npm run build:tauri -- --bundles app/);
  assert.match(script, /drama-creator-tauri/);
  assert.match(script, /Drama Creator\.app/);
  assert.match(script, /open -n/);
  assert.match(script, /APP_EXECUTABLE/);
  assert.match(script, /launch_app_direct/);
  assert.match(script, /nohup "\$APP_EXECUTABLE"/);
  assert.match(script, /lsof -tiTCP:5173/);
  assert.match(script, /--verify\|verify/);
  assert.match(sidecarScript, /rustc.*--print.*host-tuple/s);
  assert.match(sidecarScript, /drama-creator-server-\$\{targetTriple\}/);
  assert.match(sidecarScript, /node22-macos-arm64/);
});
