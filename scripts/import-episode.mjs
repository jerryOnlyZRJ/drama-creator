import { resolve } from 'node:path';
import { importEpisode } from '../src/import/importEpisode.mjs';

const episodeFlagIndex = process.argv.indexOf('--episode');
const episodePath = episodeFlagIndex >= 0 ? process.argv[episodeFlagIndex + 1] : null;

if (!episodePath) {
  console.error('Usage: npm run import:episode -- --episode <episode-directory>');
  process.exit(1);
}

// Resolve once at the CLI boundary so downstream JSON stores a stable absolute path.
const resolvedEpisodePath = resolve(episodePath);
const doc = await importEpisode({ episodePath: resolvedEpisodePath, write: true });

console.log(`Imported ${doc.episode.id}`);
console.log(`shots=${doc.shots.length} nodes=${doc.nodes.length} edges=${doc.edges.length} tasks=${doc.tasks.length}`);
console.log(`${resolvedEpisodePath}/drama-creator.json`);
