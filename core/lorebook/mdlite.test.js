// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 dootaang — 로어북 추출기. Licensed under GNU GPL v3 (see LICENSE).
'use strict';
const assert = require('assert');
const { renderMdLite } = require('./mdlite.js');

let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

ok('제목: ### → h5 캡·인라인', () => {
  assert.equal(renderMdLite('# 큰제목'), '<h3>큰제목</h3>');
  assert.equal(renderMdLite('### 소제목'), '<h5>소제목</h5>');
  assert.equal(renderMdLite('###### 깊음'), '<h5>깊음</h5>');   // h5 캡
});
ok('굵게/기울임/코드', () => {
  assert.equal(renderMdLite('이건 **굵고** *기울고* `코드`다'), '<p>이건 <strong>굵고</strong> <em>기울고</em> <code>코드</code>다</p>');
});
ok('불릿·번호 리스트', () => {
  assert.equal(renderMdLite('- 하나\n- 둘'), '<ul><li>하나</li><li>둘</li></ul>');
  assert.equal(renderMdLite('1. 하나\n2. 둘'), '<ol><li>하나</li><li>둘</li></ol>');
});
ok('문단·줄바꿈·구분선·인용', () => {
  assert.equal(renderMdLite('가\n나\n\n다'), '<p>가<br>나</p>\n<p>다</p>');
  assert.equal(renderMdLite('---'), '<hr>');
  assert.equal(renderMdLite('> 인용문'), '<blockquote>인용문</blockquote>');
});
ok('★XSS: 입력 태그·스크립트는 절대 생존 못 함', () => {
  const bad = renderMdLite('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n**<b>굵</b>**');
  assert.ok(!/<script|<img|<b>/.test(bad));
  assert.ok(bad.includes('&lt;script&gt;'));
});
ok('곱셈 별표 오변환 없음(양끝 비공백 규칙)', () => {
  assert.equal(renderMdLite('2 * 3 = 6'), '<p>2 * 3 = 6</p>');
});
ok('null·빈 입력 안전', () => {
  assert.equal(renderMdLite(null), '');
  assert.equal(renderMdLite(''), '');
});

console.log(`mdlite: 모든 검사 통과 ✓ (${n})`);
