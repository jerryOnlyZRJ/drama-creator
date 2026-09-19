import { createServer } from 'node:http';
import { createApp } from './src/server/app.mjs';
import { getDefaultEpisodeRoots } from './src/server/episodeRoots.mjs';

const port = Number(process.env.PORT || 5173);
const host = '127.0.0.1';
// Keep startup thin so tests can exercise API and static routing through createApp().
const allowedEpisodeRoots = getDefaultEpisodeRoots();
// Packaged Tauri apps run the Node server from Contents/Resources but serve static files
// from the bundled dist directory. Dev mode omits the env var and serves the repo root.
const staticRoot = process.env.DRAMA_CREATOR_STATIC_ROOT || process.cwd();
const server = createServer(createApp({ root: staticRoot, allowedEpisodeRoots }));

server.listen(port, host, () => {
  console.log(`drama-creator prototype running at http://localhost:${port}/`);
});
