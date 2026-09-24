import { createHash } from 'node:crypto';

const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu,' ').trim();
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/;
const madridParts=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});

/** A comparable digest of the actual, ordered messages in one rental period. */
export function fingerprintMessageHistory(messages) {
  if (!Array.isArray(messages)) return null;
  const semantic=[];
  for (const message of messages) {
    if (!message || typeof message!=='object') return null;
    const text=normalize(message.text);
    const attachments=message.attachments??[];
    const media=message.media??[];
    if (!Array.isArray(attachments)||!Array.isArray(media)) return null;
    // An embedded profile without a message body is account metadata, not a chat turn.
    if (message.embeddedProfile && !text && !attachments.length) continue;
    if (!['sent','received','incoming','outgoing'].includes(message.direction)) return null;
    if (!datePattern.test(message.messageDate??'') || !instantPattern.test(message.occurredAt??'') ||
        !Number.isFinite(Date.parse(message.occurredAt))) return null;
    const time=normalize(message.time);
    const clock=time.match(/^(\d{1,2}):(\d{2})$/);
    if (!clock || Number(clock[1])>23 || Number(clock[2])>59 ||
        message.timePrecision && message.timePrecision!=='minute') return null;
    const parts=Object.fromEntries(madridParts.formatToParts(new Date(message.occurredAt))
      .filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}`!==message.messageDate ||
        `${parts.hour}:${parts.minute}`!==`${clock[1].padStart(2,'0')}:${clock[2]}`) return null;
    const assets=[];
    for (const attachment of attachments) {
      if (!attachment || typeof attachment!=='object') return null;
      const url=normalize(attachment.url), caption=normalize(attachment.text);
      if (!url && !caption) return null;
      assets.push(['attachment',url,caption]);
    }
    for (const item of media) {
      if (!item || typeof item!=='object') return null;
      const tag=normalize(item.tag), alt=normalize(item.alt);
      if (!tag) return null;
      assets.push(['media',tag,alt]);
    }
    if (!text && !assets.length) return null;
    semantic.push([message.direction==='incoming'?'received':message.direction==='outgoing'?'sent':message.direction,
      message.messageDate,message.occurredAt,`${clock[1].padStart(2,'0')}:${clock[2]}`,text,assets]);
  }
  if (!semantic.length) return null;
  return createHash('sha256').update(JSON.stringify(semantic)).digest('hex');
}
