const incoming = message => ['received', 'incoming'].includes(message?.direction) &&
  !(message.embeddedProfile && !message.text?.trim() && !message.attachments?.length);
const normalized = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();

function clock(message) {
  const label = String(message.time ?? '');
  const match = label.match(/(?:^|\D)(\d{1,2})[:.](\d{2})(?:\D|$)/);
  return match && Number(match[1]) < 24 && Number(match[2]) < 60 ?
    `${match[1].padStart(2, '0')}:${match[2]}` : normalized(label);
}

function mediaIdentity(message) {
  const attachments = (message.attachments ?? []).map(item =>
    [normalized(item.url),normalized(item.text)].join('\u0000')).sort();
  const media = (message.media ?? []).map(item =>
    [normalized(item.tag),normalized(item.alt)].join('\u0000')).sort();
  return JSON.stringify([attachments,media]);
}

function identity(message) {
  const text = normalized(message.text);
  const hasAssets=Boolean(message.attachments?.length || message.media?.length);
  const body = text || (!hasAssets ? normalized(message.rawText) : '');
  const day = /^\d{4}-\d{2}-\d{2}$/.test(message.messageDate ?? '') ? message.messageDate : null;
  const instant = typeof message.occurredAt === 'string' &&
    Number.isFinite(Date.parse(message.occurredAt)) ? message.occurredAt : null;
  return { body,media:text ? '' : mediaIdentity(message),author:normalized(message.author),
    clock:clock(message),day,instant };
}

function sameMessage(before, after, withAuthor) {
  if (before.body !== after.body || before.media !== after.media ||
      (withAuthor && before.author !== after.author)) return false;
  // Date labels such as HOY and AYER are display text, not a stable message date.
  if (!before.day || !after.day) return before.clock === after.clock;
  if (before.instant && after.instant) return before.instant === after.instant;
  return before.day === after.day && before.clock === after.clock;
}

function olderHistoricalBackfill(message, previous) {
  const exported = Date.parse(previous?.referenceAt ?? previous?.exportedAt ?? '');
  if (!Number.isFinite(exported)) return false;
  // occurredAt identifies the start of a displayed minute, not an exact second.
  if (message.instant) return Date.parse(message.instant) + 60_000 <= exported;
  // A day before the prior snapshot is certainly history; the same day is uncertain.
  return Boolean(message.day && message.day < new Intl.DateTimeFormat('en-CA',
    {timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit'})
    .format(new Date(exported)));
}

/** Count genuinely new received messages in a newer export of the same conversation. */
export function countNewIncomingMessages(previous, next) {
  const oldMessages = (previous?.messages ?? []).filter(incoming).map(identity);
  const freshMessages = (next?.periodMessages ?? next?.messages ?? []).filter(incoming).map(identity);
  const used = new Set();
  const matched = new Set();
  for (const withAuthor of [true,false]) {
    for (const [index,fresh] of freshMessages.entries()) {
      if (matched.has(index)) continue;
      const oldIndex = oldMessages.findIndex((old,i) => !used.has(i) &&
        sameMessage(old,fresh,withAuthor));
      if (oldIndex !== -1) { used.add(oldIndex); matched.add(index); }
    }
  }
  return freshMessages.reduce((count,message,index) => count +
    (matched.has(index) || olderHistoricalBackfill(message,previous) ? 0 : 1),0);
}
