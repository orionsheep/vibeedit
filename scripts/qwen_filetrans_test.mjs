import { runAsrPipeline } from '../apps/web/server/services/editor/asr.service.js';

const [, , fileUrl, language = 'Chinese'] = process.argv;

if (!fileUrl) {
  console.error('Usage: node scripts/qwen_filetrans_test.mjs <public-file-url> [language]');
  process.exit(1);
}

try {
  const result = await runAsrPipeline(fileUrl, language);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
