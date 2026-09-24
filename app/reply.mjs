import { periodMessagePosition, semanticMessageContent } from './arrival.mjs';

/** Whether this owner sent a real chat message during the selected search period. */
export function importedHasReplied(messages,periodStartDate,activityStartsAt,closedAt,historyStatus) {
  if(!Array.isArray(messages)) return null;
  let uncertain=false;
  for(const message of messages){
    const content=semanticMessageContent(message);
    if(content===false) continue;
    const position=periodMessagePosition(message,periodStartDate,activityStartsAt,closedAt);
    if(position==='outside') continue;
    if(message?.direction==='sent'){
      if(content===true && position==='inside') return true;
      uncertain=true;
    }else if(!['received','incoming'].includes(message?.direction)) uncertain=true;
  }
  return uncertain || historyStatus!=='completo' ? null : false;
}

/** Whether the most recent real message in this period came from the applicant. */
export function importedAwaitingReply(messages,periodStartDate,activityStartsAt,closedAt,historyStatus) {
  if(!Array.isArray(messages) || historyStatus!=='completo') return null;
  let last=null, previousSequence=null, previousInstant=null;
  for(const message of messages){
    const content=semanticMessageContent(message);
    if(content===false) continue;
    const position=periodMessagePosition(message,periodStartDate,activityStartsAt,closedAt);
    if(position==='outside') continue;
    if(content!==true || position!=='inside' ||
      !['sent','received','incoming'].includes(message?.direction)) return null;
    if(Number.isInteger(message.sequence)){
      if(previousSequence!==null && message.sequence<=previousSequence) return null;
      previousSequence=message.sequence;
    }
    if(message.occurredAt){
      const instant=Date.parse(message.occurredAt);
      if(previousInstant!==null && instant<previousInstant) return null;
      previousInstant=instant;
    }
    last=message.direction==='sent' ? false : true;
  }
  return last;
}
