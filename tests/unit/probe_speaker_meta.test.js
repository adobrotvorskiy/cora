// tools/probe_speaker_meta.js: message kinds and the correlation with the tile outline (synthetic events).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, buildSpeakerProbeScript, describePayload, messageKind } from '../../tools/probe_speaker_meta.js';

test('messageKind: JSON type/method, socket.io, nested, binary, plain text', () => {
  assert.equal(messageKind({ text: '{"type":"activeSpeaker","id":"u1"}' }), 'type:activeSpeaker');
  assert.equal(messageKind({ text: '{"jsonrpc":"2.0","method":"participant.update","params":{}}' }), 'method:participant.update');
  assert.equal(messageKind({ text: '42["speaking",{"peer":"u1"}]' }), 'arr:speaking');
  assert.equal(messageKind({ text: '{"notification":{"event":"slot.map"}}' }), 'notification.event:slot.map');
  assert.equal(messageKind({ bin: true, len: 20 }), 'bin:small');
  assert.equal(messageKind({ text: 'ping' }), 'text:ping');
});

test('analyze: finds the kind that follows the speaker, the messages with names, CSRC votes', () => {
  const ev = [];
  const t0 = 1_000_000;
  ev.push({ type: 'dom.participants', t: t0, names: ['Тимур Ткач', 'Глеб Невский'] });
  ev.push({ type: 'ws.open', t: t0, url: 'wss://example/signal' });
  for (let i = 0; i < 60; i++) ev.push({ type: 'ws.in', t: t0 + i * 1000, text: '{"type":"ping"}' }); // background noise
  ev.push({ type: 'ws.in', t: t0 + 50, text: '{"type":"roster","peers":[{"id":"u1","name":"Тимур Ткач"},{"id":"u2","name":"Глеб Невский"}]}' });
  const who = ['Тимур Ткач', 'Глеб Невский'];
  for (let k = 0; k < 6; k++) {
    const t = t0 + 5000 + k * 8000;
    ev.push({ type: 'dom.speaker', t, names: [who[k % 2]] }, { type: 'dom.speaker', t: t + 4000, names: [] });
    ev.push({ type: 'ws.in', t: t - 120, text: `{"type":"speaking","peer":"u${(k % 2) + 1}"}` });
    ev.push({ type: 'rtp.sources', t: t + 100, mid: 'AA', ssrc: [{ s: 111, lvl: 0.4 }], csrc: [{ s: 5000 + (k % 2), lvl: 0.4 }] });
  }
  const a = analyze(ev);
  assert.equal(a.speaking_starts, 6);
  assert.equal(a.correlated[0]?.kind, 'ws type:speaking');
  assert.ok(!a.correlated.some((k) => k.kind === 'ws type:ping'), 'background messages are not correlated');
  assert.equal(a.with_names[0]?.kind, 'ws type:roster');
  assert.deepEqual(a.rtp.csrc_votes, { 'Тимур Ткач': { 5000: 3 }, 'Глеб Невский': { 5001: 3 } });
  assert.equal(a.rtp.csrc_distinct, 2);
  assert.match(buildSpeakerProbeScript(), /__probe_event/);
});

test('network frames win over the in-page copies; binary payloads keep their printable strings', () => {
  const ev = [
    { type: 'ws.in', src: 'page', t: 1, text: '{"type":"a"}' },
    { type: 'ws.in', src: 'net', t: 1, text: '{"type":"a"}' },
    { type: 'ws.in', src: 'net', t: 2, ...describePayload(Buffer.from([0x0a, 0x02, ...Buffer.from('peer-u7 Глеб', 'utf8')])) },
  ];
  const a = analyze(ev);
  assert.equal(a.messages_in, 2);
  const b = describePayload(Buffer.from([0x0a, 0x02, ...Buffer.from('peer-u7 Глеб', 'utf8')]));
  assert.deepEqual(b.strings, ['peer-u7', 'Глеб']);
  assert.equal(describePayload('{"x":1}').text, '{"x":1}');
});
