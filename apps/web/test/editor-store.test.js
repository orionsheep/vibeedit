import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useEditorStore } from '../src/features/editor/stores/editorStore.js';

function createSampleWords() {
  return [
    {
      text: '你好',
      start_time: 0,
      end_time: 0.4,
      asset_id: 'asset_1',
      word_key: 'w1',
      gap_key_after: 'g1'
    },
    {
      text: '世界',
      start_time: 1.1,
      end_time: 1.5,
      asset_id: 'asset_1',
      word_key: 'w2',
      gap_key_after: 'g2'
    }
  ];
}

test('restoreSelected restores deleted words and gaps with reactive Set replacement', () => {
  setActivePinia(createPinia());
  const editorStore = useEditorStore();

  editorStore.loadExternalWords({
    words: createSampleWords(),
    duration: 1.5
  });

  editorStore.selectSingleWord(0);
  editorStore.deleteSelected();
  assert.equal(editorStore.deletedWords.has(0), true);

  editorStore.selectSingleWord(0);
  editorStore.restoreSelected();
  assert.equal(editorStore.deletedWords.has(0), false);
  assert.equal(editorStore.hasSelection, false);

  editorStore.selectSingleGap(0);
  editorStore.deleteSelected();
  assert.equal(editorStore.deletedGaps.has(0), true);

  editorStore.selectSingleGap(0);
  editorStore.restoreSelected();
  assert.equal(editorStore.deletedGaps.has(0), false);
  assert.equal(editorStore.hasSelection, false);
});
