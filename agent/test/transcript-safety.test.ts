// AUDIT_FINAL_OFFCHAIN F-04: untrusted inbox / LLM text cannot inject Markdown, HTML or terminal escapes.
import { describe, expect, it } from 'vitest';
import { code, formatCall, formatInboxResult, formatStep, formatVerdict, inline } from '../src/transcript.js';

describe('transcript neutralises untrusted text', () => {
  it('inbox subject/from cannot add links, images, HTML or table cells', () => {
    const md = formatInboxResult([{ id: 'm`1', from: '<img src=x onerror=alert(1)>', subject: '[click](https://evil.example) ![i](https://t.example/p.gif) | x' }], []);
    expect(md).not.toMatch(/(^|[^\\])<img/);
    expect(md).not.toMatch(/(^|[^\\])\[click\]\(/);
    expect(md).toContain('\\<img');
    expect(md).toContain('\\|');
  });
  it('thoughts cannot break out of the quote or emit control sequences', () => {
    const md = formatStep(1, 'ok\n\n# Fake heading\u001b]0;owned\u0007\u001b[2J');
    expect(md.split('\n').length).toBe(3);
    expect(md).not.toMatch(/[\u001b\u0007]/);
  });
  it('tool args and receivers stay inside their code span even with backticks', () => {
    const call = formatCall('pay', { receiver: 'a`b', memo: '``[x](y)``' });
    expect(call).toMatch(/^\*\*tool call:\*\* (`{3,}) .* \1$/);
    const v = formatVerdict({ status: 'refused_locally', reason: 'invalid_receiver', reasons: ['invalid_receiver'], text: 'refused_locally: invalid_receiver' }, '1', 'evil`<script>');
    expect(v).toContain('`` evil`<script> ``');
  });
  it('code() picks a fence longer than any run inside', () => {
    expect(code('plain')).toBe('`plain`');
    expect(code('a``b')).toBe('``` a``b ```');
    expect(inline('a*b_c')).toBe('a\\*b_c');
  });
});
