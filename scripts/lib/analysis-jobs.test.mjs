import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisErrorCode, analysisErrorMessage } from '@cet-reading/contracts/analysis-jobs';

test('distinguishes generation timeouts, upstream failures and invalid AI output', () => {
  assert.equal(analysisErrorCode('This operation was aborted'), 'timeout');
  assert.equal(analysisErrorCode('fetch failed'), 'service_unavailable');
  assert.equal(analysisErrorCode('Grammar range must contain source words'), 'invalid_result');
  assert.equal(analysisErrorCode(null), 'generation_failed');
  assert.match(analysisErrorMessage('timeout'), /超时/);
  assert.match(analysisErrorMessage('invalid_result'), /完整性检查/);
});

test('never echoes an unknown error code or technical error to the reader', () => {
  assert.equal(analysisErrorMessage('https://private.example/internal'), '暂时无法生成精读，请重试。');
});
