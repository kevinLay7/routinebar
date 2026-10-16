import { test } from 'node:test';
import assert from 'node:assert/strict';
import { notificationFor, notify } from './notifications.mjs';
const prefs = { desktopNotifications: true, notificationMode: 'attention' };
const run = (items = [], extra = {}) => ({state:'needs_input', items, threads:[], summary:'Check complete', ...extra});
const item = {key:'pr:acme/app#1',kind:'needs_you',attention:'review'};
test('notifies for new reviews and actions, not unchanged or dismissed items', () => {
  assert.match(notificationFor(run([item]), null, 'Reviews', prefs).body, /1 new item needs you/);
  assert.equal(notificationFor(run([item]), run([item]), 'Reviews', prefs), null);
  assert.equal(notificationFor(run([item]), null, 'Reviews', prefs, () => true), null);
  assert.ok(notificationFor(run([item]), run([{...item,attention:'waiting'}]), 'Reviews', prefs));
  assert.equal(notificationFor(run([{...item,attention:'waiting'}]), null, 'Reviews', prefs), null);
});
test('failures, blocked launches and new coding sessions notify without repeating unchanged failures', () => {
  const failed = run([], {state:'failed',error:'No access'});
  assert.ok(notificationFor(failed, null, 'Routine', prefs));
  assert.equal(notificationFor(failed, failed, 'Routine', prefs), null);
  const blocked = run([{...item,kind:'code'}]);
  assert.match(notificationFor(blocked, null, 'Routine', prefs).body, /could not start/);
  assert.equal(notificationFor(blocked, blocked, 'Routine', prefs), null);
  assert.match(notificationFor(run([], {threads:[{key:item.key,reused:false}]}), null, 'Routine', prefs).body, /session started/);
  assert.equal(notificationFor(run([], {state:'done',threads:[{key:item.key,reused:true}]}), null, 'Routine', prefs), null);
});
test('off suppresses every event, all mode includes ordinary completions', () => {
  const done = run([], {state:'done'});
  assert.equal(notificationFor(done,null,'Routine',prefs),null);
  assert.ok(notificationFor(done,null,'Routine',{...prefs,notificationMode:'all'}));
  assert.equal(notificationFor(run([item]),null,'Routine',{...prefs,desktopNotifications:false,notificationMode:'all'}),null);
});
test('notifications pass arbitrary text as argv, and delivery failures propagate', async () => {
  let call;
  await notify('Title "quote"', 'Body $(command)', async (...args) => {call=args;});
  assert.equal(call[0],'/usr/bin/osascript');
  assert.deepEqual(call[1].slice(-2),['Title "quote"','Body $(command)']);
  await assert.rejects(notify('Title','Body',async()=>{throw new Error('Delivery failed');}),/Delivery failed/);
});
