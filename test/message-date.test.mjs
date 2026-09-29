import test from 'node:test';
import assert from 'node:assert/strict';
import { formatMessageDate } from '../app/public/message-date.mjs';

test('verified message dates take precedence over relative labels and later exports',()=>{
  const snapshot={referenceDay:'2026-09-29',exportedAt:'2026-09-29T09:00:00.000Z'};
  assert.equal(formatMessageDate({messageDate:'2026-09-24',dateLabel:'Hoy'},snapshot),'24 de septiembre de 2026');
  assert.equal(formatMessageDate({messageDate:'2026-09-24',dateLabel:'Ayer'},snapshot),'24 de septiembre de 2026');
  assert.equal(formatMessageDate({occurredAt:'2026-09-23T22:30:00.000Z',dateLabel:'Hoy'},snapshot),'24 de septiembre de 2026');
});

test('legacy relative labels use the snapshot in Madrid including midnight, DST and year rollover',()=>{
  assert.equal(formatMessageDate({dateLabel:' HOY '},{referenceDay:'2026-09-24',exportedAt:'2026-09-29T09:00:00.000Z'}),'24 de septiembre de 2026');
  assert.equal(formatMessageDate({dateLabel:'Ayer'},{referenceDay:'2026-09-25'}),'24 de septiembre de 2026');
  assert.equal(formatMessageDate({dateLabel:'Hoy'},{referenceAt:'2026-09-23T22:30:00Z',exportedAt:'2026-09-29T09:00:00Z'}),'24 de septiembre de 2026');
  assert.equal(formatMessageDate({dateLabel:'Hoy'},{exportedAt:'2026-09-23T22:30:00Z'}),'24 de septiembre de 2026');
  assert.equal(formatMessageDate({dateLabel:'Ayer'},{referenceAt:'2026-03-29T22:30:00Z'}),'29 de marzo de 2026');
  assert.equal(formatMessageDate({dateLabel:'ayer'},{referenceDay:'2027-01-01'}),'31 de diciembre de 2026');
});

test('missing or invalid dates never turn into the viewing day',()=>{
  for(const snapshot of [{},{referenceDay:'2026-02-30'},{exportedAt:'invalid'},
    {referenceAt:'2026-09-24T24:00:00Z'}]){
    assert.equal(formatMessageDate({messageDate:'2026-02-30',dateLabel:'Hoy'},snapshot),
      'Fecha no determinada (Idealista mostraba «Hoy» al sincronizar)');
  }
  assert.equal(formatMessageDate({dateLabel:'24 septiembre'}),'24 septiembre');
  assert.equal(formatMessageDate({dateLabel:null}),'Fecha no indicada');
});
